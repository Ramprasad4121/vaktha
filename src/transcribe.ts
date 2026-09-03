import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { commandExists } from "./audio.js";

export type Backend = "openai" | "mlx-whisper" | "whisper" | "whisper.cpp";

function run(cmd: string, args: string[], timeoutMs = 300000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} failed: ${String(stderr ?? err.message).slice(0, 600)}`));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function whichFirst(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await commandExists(c)) return c;
  }
  return null;
}

/** Detect available transcription backends (ordered by preference). */
export async function detectBackends(): Promise<{ available: Backend[]; openaiKey: boolean; ffmpeg: boolean }> {
  const available: Backend[] = [];
  const openaiKey = Boolean(process.env.OPENAI_API_KEY);
  if (openaiKey) available.push("openai");
  if (await whichFirst(["mlx_whisper", "mlx-whisper"])) available.push("mlx-whisper");
  if (await whichFirst(["whisper"])) available.push("whisper");
  if (await whichFirst(["whisper-cpp", "whisper.cpp", "main"])) available.push("whisper.cpp");
  // faster-whisper via python module counts as "whisper" fallback path
  if (!available.includes("whisper")) {
    try {
      await run("python3", ["-c", "import faster_whisper"], 15000);
      available.push("whisper");
    } catch { /* not installed */ }
  }
  return { available, openaiKey, ffmpeg: await commandExists("ffmpeg") };
}

export function resolveBackend(requested?: string, detected?: Backend[]): Backend {
  const want = (requested || process.env.VAKTHA_BACKEND || "").toLowerCase().trim();
  if (want === "openai" || want === "mlx-whisper" || want === "whisper" || want === "whisper.cpp") {
    return want as Backend;
  }
  if (process.env.OPENAI_API_KEY) return "openai";
  if (detected && detected.length > 0) return detected[0];
  return "openai"; // default; will raise a helpful error if unusable
}

export interface TranscribeOptions {
  language?: string; // e.g. "en"
  model?: string;    // backend-specific model id
  backend?: string;  // Backend name or ""
}

async function transcribeOpenAI(file: string, language: string, model: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set (required for backend=openai).");
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(file);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), basename(file));
  form.append("model", model || "whisper-1");
  if (language) form.append("language", language);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI transcription failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
  const json = (await res.json()) as { text?: string };
  const text = (json.text || "").trim();
  if (!text) throw new Error("OpenAI returned empty transcription.");
  return text;
}

async function transcribeMlxWhisper(file: string, language: string, model: string): Promise<string> {
  const bin = await whichFirst(["mlx_whisper", "mlx-whisper"]);
  if (!bin) throw new Error("mlx-whisper not found. Install: pip install mlx-whisper  (Apple Silicon recommended)");
  const dir = mkdtempSync(join(tmpdir(), "vaktha-mlx-"));
  try {
    const args = ["--model", model || process.env.VAKTHA_MODEL || "mlx-community/whisper-base-mlx", "--output-dir", dir, "--output-format", "txt"];
    if (language) args.push("--language", language);
    args.push(file);
    await run(bin, args, 300000);
    // mlx-whisper writes <basename>.txt into output dir
    const base = basename(file).replace(/\.[^.]+$/, "");
    const outFile = join(dir, `${base}.txt`);
    if (!existsSync(outFile)) {
      // some versions print transcript to stdout instead
      const retry = await run(bin, ["--model", model || "mlx-community/whisper-base-mlx", file], 300000).catch(() => null);
      const guess = (retry?.stdout || "").trim();
      if (guess) return guess;
      throw new Error(`mlx-whisper produced no output file (${outFile}).`);
    }
    return readFileSync(outFile, "utf8").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function transcribeWhisperCli(file: string, language: string, model: string): Promise<string> {
  const bin = await whichFirst(["whisper"]);
  const dir = mkdtempSync(join(tmpdir(), "vaktha-whisper-"));
  try {
    if (bin) {
      const args = [file, "--model", model || process.env.VAKTHA_MODEL || "base", "--output_format", "txt", "--output_dir", dir, "--fp16", "False"];
      if (language) args.push("--language", language);
      await run(bin, args, 600000);
      const base = basename(file).replace(/\.[^.]+$/, "");
      const outFile = join(dir, `${base}.txt`);
      if (!existsSync(outFile)) throw new Error("whisper CLI produced no transcript file.");
      const text = readFileSync(outFile, "utf8").trim();
      if (!text) throw new Error("whisper CLI returned empty transcription.");
      return text;
    }
    // fallback: faster-whisper python one-liner
    const script = `from faster_whisper import WhisperModel; import sys; m=WhisperModel("${model || "base"}"); segs,_=m.transcribe(sys.argv[1], language="${language || "en"}"); print("".join(s.text for s in segs).strip())`;
    const { stdout } = await run("python3", ["-c", script, file], 600000);
    const text = stdout.trim();
    if (!text) throw new Error("faster-whisper returned empty transcription.");
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function transcribeWhisperCpp(file: string, language: string, modelPath: string): Promise<string> {
  const bin = await whichFirst(["whisper-cpp", "whisper.cpp", "main"]);
  if (!bin) throw new Error("whisper.cpp binary not found (looked for whisper-cpp, whisper.cpp, main).");
  const model = modelPath || process.env.VAKTHA_MODEL_PATH || "";
  if (!model) throw new Error("whisper.cpp needs a model file: set VAKTHA_MODEL_PATH=/path/to/ggml-base.en.bin or pass model=.");
  const dir = mkdtempSync(join(tmpdir(), "vaktha-cpp-"));
  try {
    const prefix = join(dir, "out");
    await run(bin, ["-m", model, "-f", file, "-l", language || "en", "-otxt", "-of", prefix], 600000);
    const text = readFileSync(`${prefix}.txt`, "utf8").trim();
    if (!text) throw new Error("whisper.cpp returned empty transcription.");
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Transcribe an audio file with the chosen backend. Throws with install hints when backend is missing. */
export async function transcribeFile(file: string, opts: TranscribeOptions = {}): Promise<{ text: string; backend: Backend }> {
  if (!existsSync(file)) throw new Error(`Audio file not found: ${file}`);
  const language = (opts.language || process.env.VAKTHA_LANG || "en").trim() || "en";
  const model = (opts.model || process.env.VAKTHA_MODEL || "").trim();
  const { available } = await detectBackends();
  const backend = resolveBackend(opts.backend, available);

  if (backend === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        `No transcription backend available. Tried openai but OPENAI_API_KEY is unset.\n` +
        `Fix (pick one):\n` +
        `  1. export OPENAI_API_KEY=sk-...   (easiest, uses whisper-1)\n` +
        `  2. pip install mlx-whisper       (local, Apple Silicon, no API key)\n` +
        `  3. pip install openai-whisper    (local, any platform)\n` +
        `Detected backends: ${available.join(", ") || "(none)"}`
      );
    }
    return { text: await transcribeOpenAI(file, language, model || "whisper-1"), backend };
  }
  if (backend === "mlx-whisper") return { text: await transcribeMlxWhisper(file, language, model), backend };
  if (backend === "whisper") return { text: await transcribeWhisperCli(file, language, model || "base"), backend };
  return { text: await transcribeWhisperCpp(file, language, model), backend };
}
