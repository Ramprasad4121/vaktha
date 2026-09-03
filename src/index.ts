#!/usr/bin/env node
/**
 * Vaktha — voice dictation MCP for OpenCode.
 * Tools: vaktha_listen (record mic + transcribe), vaktha_transcribe (file),
 *        vaktha_status (env check), vaktha_speak (TTS).
 */
import { rmSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { commandExists, defaultDevice, listInputDevices, recordWav, tmpWavPath } from "./audio.js";
import { detectBackends, transcribeFile } from "./transcribe.js";
import { speak } from "./speak.js";

const VERSION = "0.1.0";

const server = new McpServer({ name: "vaktha", version: VERSION });

server.registerTool(
  "vaktha_listen",
  {
    description:
      "Dictate instead of typing: record N seconds of microphone audio and return the transcription as text. " +
      "Call this when the user says dictate/listen/voice input/speak. After transcription, treat the returned text as the user's message and act on it.",
    inputSchema: {
      durationSec: z.number().min(1).max(180).optional().describe("Seconds to record (default 15, max 180)."),
      language: z.string().optional().describe("BCP-47-ish code, e.g. en (default), hi, kn. honour VAKTHA_LANG if omitted."),
      model: z.string().optional().describe("Backend model override (openai: whisper-1; mlx-whisper: mlx-community/whisper-base-mlx; whisper CLI: base/small/medium)."),
      backend: z.enum(["openai", "mlx-whisper", "whisper", "whisper.cpp"]).optional().describe("Force a transcription backend (default: auto)."),
      device: z.string().optional().describe("Mic device (macOS: avfoundation index, default 0; Windows: DirectShow name, auto-detected; Linux: pulse source). Override via VAKTHA_AUDIO_DEVICE."),
    },
  },
  async (args) => {
    const started = Date.now();
    const wav = tmpWavPath();
    try {
      const rec = await recordWav(wav, args.durationSec ?? 15, args.device);
      const { text, backend } = await transcribeFile(wav, {
        language: args.language,
        model: args.model,
        backend: args.backend,
      });
      const ms = Date.now() - started;
      return {
        content: [{
          type: "text" as const,
          text: [
            `TRANSCRIPT (${backend}, ${rec.seconds}s audio, ${(ms / 1000).toFixed(1)}s total):`,
            text,
            "",
            "---",
            "Treat the transcript above as the user's dictated message and act on it.",
          ].join("\n"),
        }],
      };
    } catch (e) {
      const hint = (e as Error).message.includes("ffmpeg not found")
        ? "\nInstall: brew install ffmpeg"
        : "";
      return {
        content: [{ type: "text" as const, text: `Vaktha listen failed: ${(e as Error).message}${hint}` }],
        isError: true,
      };
    } finally {
      rmSync(wav, { force: true });
    }
  }
);

server.registerTool(
  "vaktha_transcribe",
  {
    description: "Transcribe an existing audio file (wav/mp3/m4a) to text. Use for voice notes or re-transcribing a recording.",
    inputSchema: {
      file: z.string().describe("Absolute path to the audio file."),
      language: z.string().optional().describe("Language code, e.g. en (default)."),
      model: z.string().optional().describe("Backend model override."),
      backend: z.enum(["openai", "mlx-whisper", "whisper", "whisper.cpp"]).optional().describe("Force a transcription backend (default: auto)."),
    },
  },
  async (args) => {
    try {
      const { text, backend } = await transcribeFile(args.file, {
        language: args.language,
        model: args.model,
        backend: args.backend,
      });
      return { content: [{ type: "text" as const, text: `TRANSCRIPT (${backend}):\n${text}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Vaktha transcribe failed: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "vaktha_status",
  {
    description: "Check Vaktha readiness: platform, ffmpeg, mic devices, transcription backends, API key presence. Call before first listen if unsure about setup.",
    inputSchema: {},
  },
  async () => {
    const { available, openaiKey, ffmpeg } = await detectBackends();
    const devices = await listInputDevices();
    const lines = [
      `vaktha v${VERSION} — platform=${process.platform} node=${process.version}`,
      `ffmpeg: ${ffmpeg ? "ok" : "MISSING (brew install ffmpeg)"}`,
      `default mic device: ${defaultDevice()}${process.env.VAKTHA_AUDIO_DEVICE ? " (from VAKTHA_AUDIO_DEVICE)" : " (default)"}`,
      `OPENAI_API_KEY: ${openaiKey ? "set (backend=openai available)" : "unset"}`,
      `transcription backends available: ${available.join(", ") || "(none — see fix below)"}`,
      `VAKTHA_BACKEND=${process.env.VAKTHA_BACKEND || "(auto)"} VAKTHA_LANG=${process.env.VAKTHA_LANG || "en"} VAKTHA_MODEL=${process.env.VAKTHA_MODEL || "(backend default)"}`,
      "",
      "Mic devices:",
      devices,
    ];
    if (available.length === 0) {
      lines.push(
        "",
        "No transcription backend found. Pick one:",
        "  1. export OPENAI_API_KEY=sk-...   (easiest)",
        "  2. pip install mlx-whisper       (local, Apple Silicon)",
        "  3. pip install openai-whisper    (local, any platform)"
      );
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.registerTool(
  "vaktha_speak",
  {
    description: "Speak text aloud with system TTS (macOS say / Linux espeak / Windows System.Speech). Use to read results back when the user is in voice mode.",
    inputSchema: {
      text: z.string().min(1).max(2000).describe("Text to speak (max 2000 chars)."),
      voice: z.string().optional().describe("Voice name (macOS: see say -v '?'; default system voice)."),
      rate: z.number().min(50).max(500).optional().describe("Speech rate in words per minute (macOS say style, default ~175)."),
    },
  },
  async (args) => {
    try {
      const { engine } = await speak(args.text, args.voice, args.rate);
      return { content: [{ type: "text" as const, text: `Spoke ${args.text.length} chars via ${engine}.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Vaktha speak failed: ${(e as Error).message}` }], isError: true };
    }
  }
);

async function main(): Promise<void> {
  if (!(await commandExists("ffmpeg")) && process.argv.includes("--strict-ffmpeg")) {
    console.error("vaktha: ffmpeg not found (brew install ffmpeg)");
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(`vaktha fatal: ${(e as Error).message}`);
  process.exit(1);
});
