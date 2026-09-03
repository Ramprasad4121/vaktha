// Vaktha smoke tests: MCP handshake + expected tools. No mic/audio needed.
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");

function rpc(requests, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP smoke test timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      } catch (e) { reject(new Error(`unparsable server output: ${out.slice(0, 300)}`)); }
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    child.stdin.end();
  });
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vaktha-test", version: "0" } } };
const inited = { jsonrpc: "2.0", method: "notifications/initialized" };

test("handshake exposes the 4 vaktha tools", async () => {
  const res = await rpc([init, inited, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
  const tools = res.find((m) => m.id === 2)?.result?.tools ?? [];
  assert.deepStrictEqual(tools.map((t) => t.name).sort(),
    ["vaktha_listen", "vaktha_speak", "vaktha_status", "vaktha_transcribe"]);
});

test("vaktha_status reports environment without throwing", async () => {
  const res = await rpc([init, inited, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vaktha_status", arguments: {} } }]);
  const text = res.find((m) => m.id === 3)?.result?.content?.[0]?.text ?? "";
  assert.match(text, /vaktha v\d+\.\d+\.\d+/);
  assert.match(text, /ffmpeg:/);
  assert.match(text, /transcription backends available:/);
});

test("vaktha_transcribe on a missing file returns an error (not a crash)", async () => {
  const res = await rpc([init, inited, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "vaktha_transcribe", arguments: { file: "/tmp/vaktha-does-not-exist.wav" } } }]);
  const msg = res.find((m) => m.id === 4);
  assert.ok(msg?.result?.isError === true || /not found|failed/i.test(msg?.result?.content?.[0]?.text ?? ""));
});
