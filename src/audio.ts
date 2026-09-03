import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed: ${(e.stderr ?? stderr ?? "").toString().slice(0, 500) || e.message}`
          )
        );
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await run("where", [cmd], 5000);
    } else {
      await run("which", [cmd], 5000);
    }
    return true;
  } catch {
    return false;
  }
}

export function tmpWavPath(): string {
  return join(process.env.VAKTHA_TMPDIR || tmpdir(), `vaktha-${Date.now()}-${randomUUID().slice(0, 8)}.wav`);
}

export function defaultDevice(): string {
  if (process.env.VAKTHA_AUDIO_DEVICE) return process.env.VAKTHA_AUDIO_DEVICE;
  if (process.platform === "darwin") return "0"; // avfoundation audio index; override with VAKTHA_AUDIO_DEVICE
  return "default";
}

/** List microphone / avfoundation devices (best effort, never throws). */
export async function listInputDevices(): Promise<string> {
  if (process.platform === "darwin") {
    // NOTE: ffmpeg prints the device list to stderr and exits non-zero — that is normal.
    try {
      const { stderr, stdout } = await run("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], 15000);
      const out = `${stdout}\n${stderr}`.trim();
      return out.slice(0, 2000) || "(no ffmpeg device output)";
    } catch (e) {
      const msg = (e as Error).message;
      const idx = msg.indexOf("failed:");
      const out = (idx >= 0 ? msg.slice(idx + "failed:".length) : msg).trim();
      if (/AVFoundation|audio devices/i.test(out)) return out.slice(0, 2000);
      return `(ffmpeg device list failed: ${msg.slice(0, 200)})`;
    }
  }
  try {
    if (await commandExists("arecord")) {
      const { stdout } = await run("arecord", ["-l"], 10000);
      return stdout.slice(0, 2000) || "(no ALSA devices)";
    }
  } catch { /* fall through */ }
  return "(device listing not supported on this platform; set VAKTHA_AUDIO_DEVICE explicitly)";
}

/**
 * Record `durationSec` seconds of mic audio to `outPath` (16kHz mono WAV).
 * macOS: ffmpeg avfoundation `:<device>`. Linux: alsa/pulse via ffmpeg.
 */
export function recordWav(outPath: string, durationSec: number, device?: string): Promise<{ device: string; seconds: number }> {
  const dev = device ?? defaultDevice();
  const secs = Math.min(Math.max(Math.round(durationSec), 1), 180);

  let args: string[];
  if (process.platform === "darwin") {
    args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "avfoundation",
      "-i", `:${dev}`,
      "-t", String(secs),
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      outPath,
    ];
  } else if (process.platform === "linux") {
    args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "pulse",
      "-i", dev === "default" ? "default" : dev,
      "-t", String(secs),
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      outPath,
    ];
  } else {
    return Promise.reject(new Error("vaktha_listen recording is supported on macOS and Linux only in v0.1.0"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install it: brew install ffmpeg  (or apt install ffmpeg)"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ device: dev, seconds: secs });
      else reject(new Error(`ffmpeg recording failed (exit ${code}): ${stderr.slice(0, 500) || "no output — check mic permission & VAKTHA_AUDIO_DEVICE"}`));
    });
  });
}
