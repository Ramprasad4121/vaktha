import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
}

const DEFAULT_PORT = 4173;

function opencodeBin(): string {
  const env = (process.env.OPENCODE_BIN || "").trim();
  if (env && existsSync(env)) return env;
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
  const s = await http(`${base}/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `vaktha voice ${new Date().toISOString().slice(0, 16).replace("T", " ")}` }),
  }, 20000);
  const id = s?.id as string | undefined;
  if (!id || !/^ses_[A-Za-z0-9]+$/.test(id)) throw new Error("brain refused to create a session");
  return id;
}

function replyText(res: any): string {
  const parts = res?.parts || res?.[0]?.parts || [];
  return (parts as any[]).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
}

/** Best-effort narration: what is the session doing right now (current todo)? */
function narrate(sid: string): string | null {
  try {
    const r = spawnSync("sqlite3", ["-json", "-readonly",
      join(homedir(), ".local", "share", "opencode", "opencode.db"),
      `SELECT content FROM todo WHERE session_id='${sid}' AND status='in_progress' ORDER BY position LIMIT 1`,
    ], { encoding: "utf8", timeout: 8000 });
    if (r.status !== 0) return null;
    const rows = JSON.parse((r.stdout || "").trim() || "[]") as Array<{ content?: string }>;
    return rows[0]?.content?.slice(0, 100) || null;
  } catch { return null; }
}

function sayAsync(text: string, voice?: string): ChildProcess {
  const t = text.slice(0, 1200);
  if (process.platform === "darwin") {
    return spawn("say", voice ? ["-v", voice, t] : [t]);
  }
  if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${t.replace(/'/g, "''")}') | Out-Null`;
    return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  return spawn("espeak", [t]);
}

type Phase = "idle" | "recording" | "thinking" | "speaking";

/** Send one text turn to the brain and speak the reply. Shared by loop + --text mode. */
async function runTurn(base: string, sid: string, text: string, o: VoiceOptions, onNarrate?: (line: string) => void): Promise<string> {
  const res = await http(`${base}/session/${sid}/message`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  }, 600000);
  void onNarrate;
  return replyText(res);
}

/**
 * Persistent voice conversation (Codex-style).
 * SPACE starts recording, SPACE/ENTER sends · SPACE while speaking/thinking = interrupt.
 * Ctrl+C quits. Conversation context lives in one brain session.
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
  console.error("SPACE = talk/send · SPACE while busy = interrupt · ctrl+C quits\n");

  let phase: Phase = "idle";
  let wav = "";
  let rec: Recording | null = null;
  let speaker: ChildProcess | null = null;
  let thinking = false;
  let thinkSid: string | null = null;

  const cleanup = () => {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    try { speaker?.kill("SIGKILL"); } catch { /* ignore */ }
    try { rec?.stop(); } catch { /* ignore */ }
    try { owned?.kill(); } catch { /* ignore */ }
    if (wav) rmSync(wav, { force: true });
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  const stopSpeaking = () => { try { speaker?.kill("SIGKILL"); } catch { /* ignore */ } speaker = null; };

  const startRecording = async () => {
    if (phase === "recording") return;
    if (phase === "speaking") stopSpeaking();
    if (phase === "thinking" && thinkSid) {
      http(`${base}/session/${thinkSid}/abort`, { method: "POST" }, 10000).catch(() => {});
      thinking = false; thinkSid = null;
      process.stdout.write("(interrupted — listening)\n");
    }
    phase = "recording";
    wav = tmpWavPath();
    process.stdout.write("● listening… (space/enter to send)\n");
    try {
      rec = await startMicRecording(wav, o.maxSeconds || 120, o.device);
      await rec.done; // resolves on stop() or timeout; finishTurn is driven by keypress below
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
    phase = "thinking";
    process.stdout.write("…thinking\n");
    try {
      const { text } = await transcribeFile(file, { language: o.lang, model: o.model, backend: o.backend });
      rmSync(file, { force: true });
      if (!text.trim()) { console.error("(heard nothing — press space and speak)"); phase = "idle"; return; }
      console.error(`you: ${text}`);
      thinking = true; thinkSid = sid;
      const narrateTimer = setInterval(() => {
        if (!thinking) { clearInterval(narrateTimer); return; }
        const doing = narrate(sid);
        if (doing) process.stdout.write(`… ${doing}\n`);
      }, 8000);
      let reply = "";
      try {
        reply = await runTurn(base, sid, text, o);
      } finally { clearInterval(narrateTimer); }
      thinking = false; thinkSid = null;
      if (phase !== "thinking") return; // interrupted meanwhile
      if (!reply) { console.error("(empty reply)"); phase = "idle"; return; }
      console.error(`agent: ${reply.slice(0, 500)}`);
      phase = "speaking";
      speaker = sayAsync(reply, o.voice);
      await new Promise<void>((resolve) => { speaker?.on("close", () => resolve()); setTimeout(resolve, 180000); });
      speaker = null;
      if (phase === "speaking") phase = "idle";
      process.stdout.write("\n(space to talk)\n");
    } catch (e) {
      rmSync(file, { force: true });
      thinking = false; thinkSid = null;
      console.error(`turn failed: ${(e as Error).message}`);
      phase = "idle";
    }
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
      else void startRecording(); // interrupt speaking/thinking, listen anew
      return;
    }
    if (key?.name === "return" && phase === "recording") void finishTurn();
  });

  await new Promise(() => {}); // run until ctrl+C
}

/** Single-turn mode for tests and scripts: no mic, no keys. */
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
  try {
    const sid = await createVoiceSession(base);
    const reply = await runTurn(base, sid, o.text, o);
    if (reply) {
      const speaker = sayAsync(reply, o.voice);
      await new Promise<void>((resolve) => { speaker.on("close", () => resolve()); setTimeout(resolve, 120000); });
    }
    return reply;
  } finally {
    try { owned?.kill(); } catch { /* ignore */ }
  }
}
