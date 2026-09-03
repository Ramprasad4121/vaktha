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

/** Speak text aloud (agent voice replies). macOS `say`, Linux espeak/spd-say, Windows System.Speech. */
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
  if (process.platform === "win32") {
    // System.Speech rate is -10..10; map ~50..500 wpm onto it.
    const mapped = rate === undefined
      ? "0"
      : String(Math.max(-10, Math.min(10, Math.round((rate - 175) / 32.5))));
    const escaped = t.replace(/'/g, "''");
    const voiceCmd = voice ? `$s.SelectVoice('${voice.replace(/'/g, "''")}'); ` : "";
    const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceCmd}$s.Rate=${mapped}; $s.Speak('${escaped}') | Out-Null`;
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 120000);
    return { engine: "System.Speech" };
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
  throw new Error("No TTS engine found (macOS: say is built-in; Linux: install espeak or speech-dispatcher; Windows: System.Speech via powershell.exe).");
}
