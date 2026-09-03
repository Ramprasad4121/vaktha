import { execFile } from "node:child_process";
import { commandExists } from "./audio.js";

function run(cmd: string, args: string[], timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr ?? err.message).slice(0, 400)}`));
      else resolve(String(stdout ?? ""));
    });
  });
}

/** Speak text aloud (agent voice replies). macOS `say`, Linux espeak/spd-say. */
export async function speak(text: string, voice?: string, rate?: number): Promise<{ engine: string }> {
  const t = text.slice(0, 2000);
  if (!t.trim()) throw new Error("speak: text is empty.");
  if (process.platform === "darwin") {
    const args: string[] = [];
    if (voice) args.push("-v", voice);
    if (rate) args.push("-r", String(Math.round(rate)));
    args.push(t);
    await run("say", args, 120000);
    return { engine: "say" };
  }
  if (await commandExists("spd-say")) {
    await run("spd-say", ["-r", String(rate ? Math.round(rate / 4) : 0), t].filter(Boolean), 120000);
    return { engine: "spd-say" };
  }
  if (await commandExists("espeak")) {
    const args = voice ? ["-v", voice, t] : [t];
    await run("espeak", args, 120000);
    return { engine: "espeak" };
  }
  throw new Error("No TTS engine found (macOS: say is built-in; Linux: install espeak or speech-dispatcher).");
}
