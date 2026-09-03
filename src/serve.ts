import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createWriteStream } from "node:fs";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import Busboy from "busboy";
import { detectBackends, transcribeFile, type Backend } from "./transcribe.js";

function tmpUploadPath(filename: string): string {
  const ext = extname(filename || "").toLowerCase();
  const safe = [".wav", ".mp3", ".m4a", ".ogg", ".flac", ".webm", ".mp4"].includes(ext) ? ext : ".wav";
  return join(process.env.VAKTHA_TMPDIR || tmpdir(), `vaktha-up-${Date.now()}-${randomUUID().slice(0, 8)}${safe}`);
}

/** Pick a transcription backend for the server: local-only unless explicitly overridden. */
async function resolveServeBackend(): Promise<Backend> {
  const forced = (process.env.VAKTHA_BACKEND || "").toLowerCase().trim();
  if (forced === "openai" || forced === "mlx-whisper" || forced === "whisper" || forced === "whisper.cpp") {
    return forced as Backend;
  }
  const { available } = await detectBackends();
  const local = available.filter((b) => b !== "openai");
  if (local.length === 0) {
    throw new Error(
      "No local transcription backend found for vaktha serve. " +
      "Install one (pip install mlx-whisper) or set VAKTHA_BACKEND=openai with OPENAI_API_KEY."
    );
  }
  return local[0];
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleTranscribe(req: IncomingMessage, res: ServerResponse, backend: Backend): Promise<void> {
  const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  let filePath: string | null = null;
  let language = (process.env.VAKTHA_LANG || "en").trim() || "en";
  let fileError: Error | null = null;
  let responded = false;

  const fail = (code: number, msg: string) => {
    if (responded) return;
    responded = true;
    if (filePath) rmSync(filePath, { force: true });
    json(res, code, { error: { message: `vaktha: ${msg}`, type: " transcription_error" } });
  };

  bb.on("file", (_name, file, info) => {
    filePath = tmpUploadPath(info.filename || "audio.wav");
    const out = createWriteStream(filePath);
    file.pipe(out);
    file.on("limit", () => { fileError = new Error("audio file exceeds 25MB limit"); file.resume(); });
  });
  bb.on("field", (name, value) => {
    if (name === "language" && value.trim()) language = value.trim().slice(0, 16);
    // "model" and "response_format" accepted but ignored (server uses VAKTHA_MODEL / backend default)
  });
  bb.on("error", (e) => fail(400, `could not parse upload: ${(e as Error).message.slice(0, 200)}`));
  bb.on("finish", async () => {
    if (responded) return;
    if (fileError) { fail(413, fileError.message); return; }
    if (!filePath) { fail(400, "no audio file in upload (expected multipart field 'file')"); return; }
    const fp: string = filePath;
    try {
      const started = Date.now();
      const { text } = await transcribeFile(fp, { language, backend });
      responded = true;
      json(res, 200, { text, _vaktha: { backend, ms: Date.now() - started } });
    } catch (e) {
      fail(500, (e as Error).message.slice(0, 400));
    } finally {
      rmSync(fp, { force: true });
    }
  });
  req.pipe(bb);
}

/** Start the OpenAI-compatible STT server. Resolves with the bound port. */
export function startServer(port: number): Promise<{ port: number; backend: Backend }> {
  return new Promise(async (resolve, reject) => {
    let backend: Backend;
    try {
      backend = await resolveServeBackend();
    } catch (e) {
      reject(e);
      return;
    }
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/models")) {
        if (url.pathname === "/health") return json(res, 200, { ok: true, backend });
        return json(res, 200, { object: "list", data: [{ id: "whisper-1", object: "model", owned_by: "vaktha" }] });
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
        handleTranscribe(req, res, backend).catch((e) => json(res, 500, { error: { message: String(e).slice(0, 200) } }));
        return;
      }
      json(res, 404, { error: { message: "vaktha: only POST /v1/audio/transcriptions (+ GET /health, /v1/models)" } });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ port, backend }));
  });
}
