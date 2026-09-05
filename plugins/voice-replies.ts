// Vaktha voice replies — global OpenCode hooks plugin.
// When any agent finishes (session.idle), speak the GIST of its reply
// (2 sentences max — like a person, not a screen reader).
// Skips turns the TUI conversation loop already speaks (voice marker).
// Mute anytime: VAKTHA_VOICE_REPLIES=0. Source of truth: vaktha repo,
// plugins/voice-replies.ts — this copy loads from ~/.config/opencode/plugins/.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB = join(homedir(), ".local", "share", "opencode", "opencode.db");
const MARKER = join(homedir(), ".local", "share", "opencode-stt", "voice", "last-voice-turn.json");
const SAY_PID = join(homedir(), ".local", "share", "opencode-stt", "voice", "say.pid");
const MARKER_FRESH_MS = 5 * 60 * 1000;
const MAX_CHARS = 600;

function sidOf(ev: unknown): string | null {
  try {
    const m = JSON.stringify(ev).match(/ses_[A-Za-z0-9]+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function sqlRows(sql: string): any[] {
  const r = spawnSync("sqlite3", ["-json", "-readonly", DB, sql], { encoding: "utf8", timeout: 8000 });
  if (r.status !== 0) return [];
  try { return JSON.parse((r.stdout || "").trim() || "[]"); } catch { return []; }
}

/** Humanized speech: the gist (2 sentences), never the wall of text. */
export function condenseForSpeech(text: string, cap = 280): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " code omitted ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
  return sentences.slice(0, 2).join(" ").trim().slice(0, cap);
}

/** True when the TUI conversation loop owns this turn (it speaks it itself). */
function voiceLoopOwnsTurn(sid: string): boolean {
  try {
    if (!existsSync(MARKER)) return false;
    const marker = JSON.parse(readFileSync(MARKER, "utf8")) as { at?: number; snippet?: string };
    if (!marker.at || Date.now() - marker.at > MARKER_FRESH_MS || !marker.snippet) return false;
    const rows = sqlRows(
      `SELECT data FROM message WHERE session_id='${sid}' ` +
      `AND json_extract(data,'$.role')='user' ORDER BY time_created DESC LIMIT 1`
    );
    if (!rows.length) return false;
    return JSON.stringify(rows[0]).includes(marker.snippet.slice(0, 40));
  } catch {
    return false;
  }
}

function lastAssistantText(sid: string): string {
  const msgs = sqlRows(
    `SELECT id FROM message WHERE session_id='${sid}' ` +
    `AND json_extract(data,'$.role')='assistant' ORDER BY time_created DESC LIMIT 1`
  );
  if (!msgs.length) return "";
  const parts = sqlRows(`SELECT data FROM part WHERE message_id='${msgs[0].id}' ORDER BY time_created`);
  const text = parts
    .map((p) => { try { const d = JSON.parse(p.data); return d.type === "text" ? d.text : ""; } catch { return ""; } })
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, MAX_CHARS);
}

export const VakthaVoiceReplies = async () => ({
  event: async ({ event }: any) => {
    try {
      if (process.env.VAKTHA_VOICE_REPLIES === "0") return;
      if ((event as any)?.type !== "session.idle") return;
      const sid = sidOf(event);
      if (!sid) return;
      if (voiceLoopOwnsTurn(sid)) return; // conversation loop speaks it (with barge-in)
      const text = lastAssistantText(sid);
      if (!text) return;
      // barge-in: a fresh turn kills stale speech first (same pidfile protocol as the loop)
      try {
        if (existsSync(SAY_PID)) {
          const pid = Number(readFileSync(SAY_PID, "utf8").trim());
          if (pid > 0) process.kill(pid, "SIGKILL");
        }
      } catch { /* nothing speaking */ }
      const line = condenseForSpeech(text);
      if (!line) return;
      const child = spawn("say", [line], { stdio: "ignore" });
      try { writeFileSync(SAY_PID, String(child.pid)); } catch { /* ignore */ }
      await new Promise<void>((resolve) => { child.on("close", () => resolve()); });
      try { rmSync(SAY_PID, { force: true }); } catch { /* ignore */ }
    } catch {
      /* never break the session */
    }
  },
});
