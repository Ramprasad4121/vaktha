import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { startRecording as startMicRecording, tmpWavPath, type Recording } from "./audio.js";
import { transcribeFile } from "./transcribe.js";

export interface VoiceOptions {
  url?: string;       // existing brain server (default: spawn on 127.0.0.1:4173)
  port?: number;      // port for a brain we spawn ourselves
  lang?: string;
  model?: string;     // STT model override
  backend?: string;   // STT backend override
  device?: string;    // mic device override
  voice?: string;     // TTS voice
  text?: string;      // single-turn mode (no mic): send this, speak reply, exit
  maxSeconds?: number;
  noAutoListen?: boolean;
}

const DEFAULT_PORT = 4173;
const DB = join(homedir(), ".local", "share", "opencode", "opencode.db");
const LOCAL_MODEL = process.env.VAKTHA_LOCAL_MODEL || "gemma3:4b";
const OLLAMA_URL = process.env.VAKTHA_OLLAMA_URL || "http://127.0.0.1:11434";
const SILENCE_SKIP_BYTES = 30000; // wav smaller than this = nobody spoke, skip STT
const MAX_EMPTY_TURNS = 3;

function opencodeBin(): string {
  const fromEnv = (process.env.OPENCODE_BIN || "").trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(homedir(), ".opencode", "bin", "opencode");
  if (existsSync(local)) return local;
  return "opencode"; // PATH fallback
}

async function http(url: string, opts: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...(opts as RequestInit), signal: c.signal });
    if (!r.ok) throw new Error(`${(opts as RequestInit).method || "GET"} ${url} -> ${r.status}`);
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  } finally { clearTimeout(t); }
}

async function serverHealthy(base: string): Promise<boolean> {
  try {
    const h = await http(`${base}/global/health`, {}, 8000);
    return !!h?.healthy;
  } catch { return false; }
}

/** Ensure a headless brain server. Returns base URL; owned child (if spawned) dies on exit. */
export async function ensureBrain(port: number): Promise<{ base: string; owned: ChildProcess | null }> {
  const base = `http://127.0.0.1:${port}`;
  if (await serverHealthy(base)) return { base, owned: null };
  const bin = opencodeBin();
  const child = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { stdio: "ignore" });
  child.on("error", () => {});
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await serverHealthy(base)) return { base, owned: child };
    if (child.exitCode !== null) break;
  }
  try { child.kill(); } catch { /* ignore */ }
  throw new Error(
    `could not start a brain server (tried \`${bin} serve\`). ` +
    `Fix: run \`opencode --port ${port}\` in any project, then rerun with --url http://127.0.0.1:${port}`
  );
}

export async function createVoiceSession(base: string): Promise<string> {
  // first request to a fresh server can be slow (cold start under load): generous timeout + one retry
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const s = await http(`${base}/session`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `vaktha voice ${new Date().toISOString().slice(0, 16).replace("T", " ")}` }),
      }, 60000);
      const id = s?.id as string | undefined;
      if (!id || !/^ses_[A-Za-z0-9]+$/.test(id)) throw new Error("brain refused to create a session");
      return id;
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error("brain refused to create a session");
}

function replyText(res: any): string {
  const parts = res?.parts || res?.[0]?.parts || [];
  return (parts as any[]).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
}

function sqlRows(jsonSql: string): Array<Record<string, any>> {
  const r = spawnSync("sqlite3", ["-json", "-readonly", DB, jsonSql],
    { encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("sqlite3 unavailable");
  const out = (r.stdout || "").trim();
  return out ? JSON.parse(out) : [];
}

/** Fast local acknowledgment via Ollama. Null = fall back to canned. */
async function localAck(userText: string): Promise<string | null> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    try {
      const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: c.signal,
        body: JSON.stringify({
          model: LOCAL_MODEL, stream: false,
          options: { num_predict: 12, temperature: 0.4 },
          prompt: `You are a voice assistant's instant acknowledgment layer. Reply with at most 5 casual words (no quotes, no emoji) to: "${userText.slice(0, 200)}"`,
        }),
      });
      if (!r.ok) return null;
      const j = await r.json() as { response?: string };
      const s = (j.response || "").replace(/["'*_#]/g, "").trim().split("\n")[0].slice(0, 60);
      return s || null;
    } finally { clearTimeout(t); }
  } catch { return null; }
}

const CANNED_ACKS = ["on it", "checking now", "looking into it", "one moment", "got it, working on that"];

/** Serialized, killable speech. One voice at a time — interruptions cut it off. */
class Speaker {
  private current: ChildProcess | null = null;
  private chain: Promise<void> = Promise.resolve();

  say(text: string, voice?: string): Promise<void> {
    const t = text.slice(0, 600);
    if (!t.trim()) return Promise.resolve();
    const run = this.chain.then(() => new Promise<void>((resolve) => {
      const child = process.platform === "darwin"
        ? spawn("say", voice ? ["-v", voice, t] : [t], { stdio: "ignore" })
        : process.platform === "win32"
          ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${t.replace(/'/g, "''")}') | Out-Null`], { stdio: "ignore" })
          : spawn("espeak", [t], { stdio: "ignore" });
      this.current = child;
      const done = () => { if (this.current === child) this.current = null; resolve(); };
      child.on("close", done);
      child.on("error", done);
      setTimeout(done, 120000);
    }));
    this.chain = run.catch(() => {});
    return this.chain;
  }

  kill(): void {
    try { this.current?.kill("SIGKILL"); } catch { /* ignore */ }
    this.current = null;
  }
}

/** Split freshly arrived text into complete sentences, keeping the tail. */
function pullSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const re = /[^.!?]+[.!?]+["”']?/g;
  let m: RegExpExecArray | null;
  let last = 0;
  for (;;) {
    m = re.exec(buffer);
    if (!m) break;
    const s = m[0].trim();
    last = m.index + m[0].length;
    if (s.length > 1) sentences.push(s);
  }
  return { sentences, rest: buffer.slice(last) };
}

export interface TurnCtx {
  voice?: string;
  stale?: () => boolean;            // true when this turn was interrupted
  onLine?: (line: string) => void;  // transcript + spoken lines (logging/UI)
}

export interface LiveTurn {
  done: Promise<void>;
  speaker: Speaker;
  abort: () => void;
}

/**
 * One pipelined turn shared by the loop and --text mode:
 * ack instantly -> submit async -> speak sentences as they generate ->
 * narrate gaps -> flush tail. Killable mid-flight via abort().
 */
export function startPipelinedTurn(base: string, sid: string, text: string, ctx: TurnCtx = {}): LiveTurn {
  const speaker = new Speaker();
  const aborter = new AbortController();
  const stale = () => ctx.stale?.() || aborter.signal.aborted;
  const say = (line: string) => {
    ctx.onLine?.(`agent: ${line.slice(0, 300)}`);
    return speaker.say(line, ctx.voice);
  };

  const done = (async () => {
    const t0 = Date.now();
    // baseline BEFORE submit: anything newer in this session is ours
    // (snapshot after submit races fast runs — the reply can land first)
    let sqliteOk = true;
    let maxRowid = 0;
    try {
      const cur = sqlRows(`SELECT max(rowid) AS m FROM part WHERE session_id='${sid}'`);
      maxRowid = Number(cur[0]?.m || 0);
    } catch { sqliteOk = false; }
    // 1. submit without waiting — the reply streams into the store
    http(`${base}/session/${sid}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
      signal: aborter.signal,
    }, 600000).catch(() => {});
    // 2. instant acknowledgment (local model ~1s) — never dead air
    const ack = (await localAck(text)) || CANNED_ACKS[Math.floor(Math.random() * CANNED_ACKS.length)];
    if (stale()) return;
    ctx.onLine?.(`agent: ${ack}… [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    await speaker.say(ack, ctx.voice);
    if (stale()) return;
    // 3. stream sentences as parts land in the store
    if (!sqliteOk) {
      // degraded: blocking wait for the full reply, then speak it whole
      try {
        const res = await http(`${base}/session/${sid}/message`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: `Summarize in two sentences: ${text}` }] }),
          signal: aborter.signal,
        }, 600000);
        const full = replyText(res);
        if (full && !stale()) await say(full);
      } catch { /* aborted or failed */ }
      return;
    }
    let buffer = "";
    let lastSpeechAt = Date.now();
    let lastNarrateAt = 0;
    let finished = false;
    for (;;) {
      if (stale()) return;
      if (Date.now() - t0 > 600000) break;
      await new Promise((rr) => setTimeout(rr, 1500));
      if (stale()) return;
      let rows: Array<Record<string, any>> = [];
      try {
        rows = sqlRows(`SELECT rowid AS r, data FROM part WHERE session_id='${sid}' AND rowid>${maxRowid} ORDER BY rowid LIMIT 60`);
      } catch { continue; }
      for (const row of rows) {
        maxRowid = Math.max(maxRowid, Number(row.r || 0));
        let d: any = null;
        try { d = JSON.parse(row.data); } catch { continue; }
        if (d.type === "step-finish") { finished = true; continue; }
        if (d.type === "text" && d.text) {
          buffer += (buffer && !buffer.endsWith(" ") ? " " : "") + String(d.text);
          lastSpeechAt = Date.now();
        }
      }
      const { sentences, rest } = pullSentences(buffer);
      buffer = rest;
      for (const s of sentences) {
        if (stale()) return;
        await say(s);
        lastSpeechAt = Date.now();
      }
      if (stale()) return;
      if (finished) break;
      if (Date.now() - lastSpeechAt > 20000 && Date.now() - lastNarrateAt > 20000) {
        lastNarrateAt = Date.now();
        let doing: string | null = null;
        try {
          const td = sqlRows(`SELECT content FROM todo WHERE session_id='${sid}' AND status='in_progress' ORDER BY position LIMIT 1`);
          doing = (td[0]?.content as string | undefined)?.slice(0, 90) || null;
        } catch { /* ignore */ }
        await say(doing || "still working on it");
      }
    }
    if (stale()) return;
    if (buffer.trim()) await say(buffer.trim());
  })().catch(() => {});

  return {
    done,
    speaker,
    abort: () => {
      try { aborter.abort(); } catch { /* ignore */ }
      speaker.kill();
      http(`${base}/session/${sid}/abort`, { method: "POST" }, 10000).catch(() => {});
    },
  };
}

type Phase = "idle" | "recording" | "thinking" | "speaking";

/**
 * Persistent voice conversation (human cadence).
 * SPACE = talk · SPACE anytime = interrupt · ctrl+C quits.
 * Turns pipeline: instant ack, sentences spoken as they generate, auto-listen.
 */
export async function voiceLoop(o: VoiceOptions): Promise<void> {
  const port = Math.round(o.port || DEFAULT_PORT);
  let owned: ChildProcess | null = null;
  let base: string;
  if (o.url) {
    base = o.url;
  } else {
    const r = await ensureBrain(port);
    owned = r.owned;
    base = r.base;
  }
  const sid = await createVoiceSession(base);
  console.error(`vaktha voice — session ${sid.slice(0, 14)}… on ${base}`);
  console.error("SPACE = talk · SPACE anytime = interrupt · ctrl+C quits\n");

  let phase: Phase = "idle";
  let wav = "";
  let rec: Recording | null = null;
  let live: LiveTurn | null = null;
  let emptyStreak = 0;

  const cleanup = () => {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    try { live?.abort(); } catch { /* ignore */ }
    try { rec?.stop(); } catch { /* ignore */ }
    try { owned?.kill(); } catch { /* ignore */ }
    if (wav) rmSync(wav, { force: true });
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  const startRecording = async () => {
    if (phase === "recording") return;
    if (live) { live.abort(); live = null; process.stdout.write("(interrupted — listening)\n"); }
    phase = "recording";
    wav = tmpWavPath();
    process.stdout.write("● listening… (space to send)\n");
    try {
      rec = await startMicRecording(wav, o.maxSeconds || 120, o.device);
      await rec.done;
    } catch (e) {
      console.error(`record failed: ${(e as Error).message}`);
      phase = "idle"; rec = null;
    }
  };

  const finishTurn = async () => {
    if (phase !== "recording" || !rec) return;
    const r = rec; rec = null;
    r.stop();
    try { await r.done; } catch (e) {
      console.error(`record failed: ${(e as Error).message}`);
      phase = "idle"; return;
    }
    const file = wav; wav = "";
    try {
      if (statSync(file).size < SILENCE_SKIP_BYTES) {
        rmSync(file, { force: true });
        return void autoResume(true);
      }
    } catch { /* fall through to transcribe */ }
    phase = "thinking";
    let text = "";
    try {
      const res = await transcribeFile(file, { language: o.lang, model: o.model, backend: o.backend });
      text = res.text.trim();
    } catch (e) {
      console.error(`transcribe failed: ${(e as Error).message}`);
      phase = "idle"; return;
    } finally {
      rmSync(file, { force: true });
    }
    if (!text) return void autoResume(true);
    console.error(`you: ${text}`);
    emptyStreak = 0;
    phase = "speaking";
    live = startPipelinedTurn(base, sid, text, {
      voice: o.voice,
      stale: () => live === null,
      onLine: (line) => console.error(line),
    });
    const turn = live;
    await turn.done;
    if (live !== turn) return; // interrupted; new turn owns the floor
    live = null;
    phase = "idle";
    autoResume(false);
  };

  const autoResume = (wasEmpty: boolean) => {
    if (o.noAutoListen) { phase = "idle"; process.stdout.write("\n(space to talk)\n"); return; }
    if (wasEmpty) {
      emptyStreak += 1;
      if (emptyStreak >= MAX_EMPTY_TURNS) {
        emptyStreak = 0;
        phase = "idle";
        process.stdout.write("\n(quiet — space to talk)\n");
        return;
      }
    }
    void startRecording();
  };

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", (_ch, key) => {
    if (key?.ctrl && key?.name === "c") { cleanup(); process.exit(0); }
    if (key?.repeat) return;
    const isSpace = key?.name === "space" || key?.sequence === " ";
    if (isSpace) {
      if (phase === "idle") void startRecording();
      else if (phase === "recording") void finishTurn();
      else void startRecording(); // interrupt thinking/speaking, listen anew
      return;
    }
    if (key?.name === "return" && phase === "recording") void finishTurn();
  });

  // greet + open the floor (spoken directly — no brain turn wasted)
  await new Promise<void>((resolve) => {
    const g = process.platform === "darwin"
      ? spawn("say", o.voice ? ["-v", o.voice, "Hey Ram, I am listening."] : ["Hey Ram, I am listening."], { stdio: "ignore" })
      : spawn("true", [], { stdio: "ignore" });
    const done = () => resolve();
    g.on("close", done);
    g.on("error", done);
    setTimeout(done, 15000);
  });
  await startRecording();
  await new Promise(() => {}); // run until ctrl+C
}

/** Single-turn mode for tests and scripts: no mic, no keys. Runs the real pipeline. */
export async function voiceOnce(o: VoiceOptions & { text: string }): Promise<string> {
  const port = Math.round(o.port || DEFAULT_PORT);
  let owned: ChildProcess | null = null;
  let base: string;
  if (o.url) {
    base = o.url;
  } else {
    const r = await ensureBrain(port);
    owned = r.owned;
    base = r.base;
  }
  const lines: string[] = [];
  try {
    const sid = await createVoiceSession(base);
    const t0 = Date.now();
    const turn = startPipelinedTurn(base, sid, o.text, {
      voice: o.voice,
      onLine: (line) => { lines.push(line); console.error(line); },
    });
    await turn.done;
    console.error(`[turn ${(Date.now() - t0) / 1000}s]`);
    return lines.join("\n");
  } finally {
    try { owned?.kill(); } catch { /* ignore */ }
  }
}
