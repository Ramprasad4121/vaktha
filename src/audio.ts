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
  if (process.platform === "win32") return "auto"; // resolved to first DirectShow audio device at record time
  return "default";
}

/**
 * Parse the first DirectShow *audio* device name from
 * `ffmpeg -f dshow -list_devices true -i dummy` output.
 * Returns the bare name (without audio= prefix), or null.
 */
export function parseDshowFirstAudioDevice(output: string): string | null {
  const lines = output.split("\n");
  let inAudio = false;
  for (const line of lines) {
    if (/DirectShow audio devices/i.test(line)) { inAudio = true; continue; }
    if (/DirectShow (video|audio and video) devices/i.test(line)) { inAudio = false; continue; }
    if (inAudio) {
      const m = line.match(/"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

/** Run an ffmpeg -list_devices style command; tolerates the non-zero exit ffmpeg uses for listings. */
async function ffmpegDeviceList(args: string[], mustMatch: RegExp): Promise<string> {
  try {
    const { stderr, stdout } = await run("ffmpeg", args, 15000);
    const out = `${stdout}\n${stderr}`.trim();
    return out.slice(0, 2000) || "(no ffmpeg device output)";
  } catch (e) {
    const msg = (e as Error).message;
    const idx = msg.indexOf("failed:");
    const out = (idx >= 0 ? msg.slice(idx + "failed:".length) : msg).trim();
    if (mustMatch.test(out)) return out.slice(0, 2000);
    throw new Error(out.slice(0, 200));
  }
}

/** List microphone devices (best effort, never throws). */
export async function listInputDevices(): Promise<string> {
  // NOTE: ffmpeg prints device lists to stderr and exits non-zero — that is normal.
  if (process.platform === "darwin") {
    try {
      return await ffmpegDeviceList(
        ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
        /AVFoundation|audio devices/i
      );
    } catch (e) {
      return `(ffmpeg device list failed: ${(e as Error).message.slice(0, 200)})`;
    }
  }
  if (process.platform === "win32") {
    try {
      const out = await ffmpegDeviceList(
        ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"],
        /DirectShow|audio devices/i
      );
      const first = parseDshowFirstAudioDevice(out);
      return `${out}\n(vaktha will use "${first ?? "?"}" by default; set VAKTHA_AUDIO_DEVICE to another device name to override)`;
    } catch (e) {
      return `(ffmpeg device list failed: ${(e as Error).message.slice(0, 200)})`;
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

/** Resolve the effective recording device (Windows auto-detects the first DirectShow mic). */
async function resolveDevice(device?: string): Promise<string> {
  const dev = device ?? defaultDevice();
  if (dev !== "auto") return dev;
  const out = await listInputDevices();
  const first = parseDshowFirstAudioDevice(out);
  if (!first) {
    throw new Error(
      "No Windows microphone found via DirectShow. " +
      "Connect a mic, or set VAKTHA_AUDIO_DEVICE to the exact device name " +
      '(see vaktha_status output, e.g. VAKTHA_AUDIO_DEVICE="Microphone (Realtek Audio)").'
    );
  }
  return first;
}

async function buildRecordArgs(outPath: string, durationSec: number, device?: string): Promise<{ args: string[]; dev: string; secs: number }> {
  const secs = Math.min(Math.max(Math.round(durationSec), 1), 180);

  let args: string[];
  let dev: string;
  if (process.platform === "darwin") {
    dev = device ?? defaultDevice();
    args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "avfoundation",
      "-i", `:${dev}`,
      "-t", String(secs),
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      outPath,
    ];
  } else if (process.platform === "linux") {
    dev = device ?? defaultDevice();
    args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "pulse",
      "-i", dev === "default" ? "default" : dev,
      "-t", String(secs),
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      outPath,
    ];
  } else if (process.platform === "win32") {
    dev = await resolveDevice(device);
    args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "dshow",
      "-i", `audio=${dev}`,
      "-t", String(secs),
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      outPath,
    ];
  } else {
    throw new Error(`vaktha recording is not supported on ${process.platform}`);
  }
  return { args, dev, secs };
}

export interface Recording {
  done: Promise<{ device: string; seconds: number }>;
  /** Stop early (ffmpeg finalizes the file, done resolves). */
  stop: () => void;
}

/**
 * Start a mic recording with early-stop support (for push-to-talk).
 * SIGINT lets ffmpeg write a valid WAV trailer before exiting.
 */
export async function startRecording(outPath: string, durationSec: number, device?: string): Promise<Recording> {
  const { args, dev, secs } = await buildRecordArgs(outPath, durationSec, device);
  const child = spawn("ffmpeg", args);
  let stderr = "";
  let settled = false;
  const done = new Promise<{ device: string; seconds: number }>((resolve, reject) => {
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install it: brew install ffmpeg (macOS), apt install ffmpeg (Linux), or winget install ffmpeg (Windows)"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      // exit 0, or SIGINT-stop (255/null): file is valid, resolve with recorded length unknown precisely
      if (code === 0 || signal === "SIGINT" || code === 255) resolve({ device: dev, seconds: secs });
      else reject(new Error(`ffmpeg recording failed (exit ${code}): ${stderr.slice(0, 500) || "no output — check mic permission & VAKTHA_AUDIO_DEVICE"}`));
    });
  });
  return {
    done,
    stop: () => { if (!settled) { try { child.kill("SIGINT"); } catch { /* ignore */ } } },
  };
}

/**
 * Record `durationSec` seconds of mic audio to `outPath` (16kHz mono WAV).
 * macOS: ffmpeg avfoundation `:<device>`. Linux: pulse/alsa via ffmpeg.
 * Windows: ffmpeg DirectShow `audio="<device name>"` (auto-detects first mic).
 */
export async function recordWav(outPath: string, durationSec: number, device?: string): Promise<{ device: string; seconds: number }> {
  return (await startRecording(outPath, durationSec, device)).done;
}
