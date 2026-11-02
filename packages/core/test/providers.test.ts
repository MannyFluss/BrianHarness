import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, statSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  ClaudeCodeBackend, FileCredentialStore, MockBackend, OpenAICompatibleBackend, backendSpecFromEnv, createBackend,
  detectClaudeCode, detectOllama, isLocalUrl, parseBackendRef, type DirectorPlan,
} from "../src/index.js";

const plan: DirectorPlan = { mode: "explore", topic: "space", style: "open", reason: "t" } as DirectorPlan;
const msgs = [{ role: "system" as const, content: "SYS" }, { role: "user" as const, content: "hi" }, { role: "system" as const, content: "[DIRECTOR STATE] x" }];

function fakeOllama(): Promise<{ server: Server; url: string; bodies: any[] }> {
  const bodies: any[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models: [{ name: "gemma4:cloud" }, { name: "llama3.2:3b", size: 2e9, details: { family: "llama", parameter_size: "3B" } }] }));
        return;
      }
      if (req.url === "/api/chat") {
        n++;
        if (n === 1) { res.statusCode = 503; res.end("busy"); return; } // retried
        bodies.push(JSON.parse(raw));
        res.end(JSON.stringify({ message: { role: "assistant", content: " hello from fake ollama " } }));
        return;
      }
      res.statusCode = 404; res.end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies })));
}

test("detectOllama lists local models first and flags cloud models; down server -> running:false", async () => {
  const { server, url } = await fakeOllama();
  try {
    const d = await detectOllama(url);
    assert.equal(d.running, true);
    assert.deepEqual(d.models.map((m) => [m.name, m.cloud]), [["llama3.2:3b", false], ["gemma4:cloud", true]]);
  } finally { server.close(); }
  const down = await detectOllama("http://127.0.0.1:9", 300);
  assert.equal(down.running, false);
});

test("Ollama backend: local is free, sends seed/temperature, retries 5xx; cloud model is paid", async () => {
  const { server, url, bodies } = await fakeOllama();
  try {
    const b = await createBackend({ provider: "ollama", model: "llama3.2:3b", baseUrl: url, seed: 7, temperature: 0.3 });
    assert.equal(b.paid, false);
    const r = await b.generate({ messages: msgs, plan, stateNote: "" });
    assert.equal(r.text, "hello from fake ollama");
    assert.equal(bodies[0].options.seed, 7);
    assert.equal(bodies[0].options.temperature, 0.3);
    assert.equal(bodies[0].stream, false);
    assert.equal((await createBackend({ provider: "ollama", model: "gemma4:cloud", baseUrl: url })).paid, true);
  } finally { server.close(); }
});

test("OpenAI-compatible: local URL is free without a key, remote is paid", () => {
  assert.equal(new OpenAICompatibleBackend({ baseUrl: "http://localhost:1234/v1", model: "m" }).paid, false);
  assert.equal(new OpenAICompatibleBackend({ baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "k" }).paid, true);
  assert.ok(isLocalUrl("http://127.0.0.1:11434") && !isLocalUrl("https://ollama.com"));
});

test("backend refs and env specs", async () => {
  assert.deepEqual(parseBackendRef("ollama:gemma3:4b"), { provider: "ollama", model: "gemma3:4b" });
  assert.throws(() => parseBackendRef("nope"));
  const s = backendSpecFromEnv({ EEG_BACKEND: "ollama", OLLAMA_HOST: "10.0.0.5:11434", EEG_SEED: "3", EEG_TEMPERATURE: "0.2" });
  assert.deepEqual([s.provider, s.baseUrl, s.seed, s.temperature], ["ollama", "http://10.0.0.5:11434", 3, 0.2]);
  assert.ok((await createBackend({ provider: "mock" })) instanceof MockBackend);
});

test("pi-ai OpenAI/Anthropic backends are paid and use the faux provider in tests", async () => {
  const { createModels } = await import("@earendil-works/pi-ai");
  const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let seen = "";
  faux.setResponses([(ctx: any) => { seen = JSON.stringify(ctx); return fauxAssistantMessage("faux reply"); }]);
  const { PiAiBackend } = await import("../src/index.js");
  const b = new PiAiBackend({ models, provider: faux.provider.id, model: faux.getModel().id });
  assert.equal(b.paid, true);
  const r = await b.generate({ messages: msgs, plan, stateNote: "" });
  assert.equal(r.text, "faux reply");
  assert.ok(seen.includes("SYS") && seen.includes("User: hi") && seen.includes("[DIRECTOR STATE]"));
});

test("Claude Code backend: detection + JSON result via a fake claude binary, API key stripped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fakeclaude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.300 (Claude Code)"); process.exit(0); }
let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
  console.log(JSON.stringify({ result: "claude says hi; key=" + (process.env.ANTHROPIC_API_KEY ? "present" : "absent") + "; tools=" + process.argv[process.argv.indexOf("--tools") + 1] + "|", is_error: false }));
});`);
  chmodSync(bin, 0o755);
  const st = await detectClaudeCode(bin);
  assert.deepEqual([st.installed, st.version], [true, "2.1.300"]);
  assert.equal((await detectClaudeCode(join(dir, "missing"))).installed, false);
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  try {
    const r = await new ClaudeCodeBackend({ bin }).generate({ messages: msgs, plan, stateNote: "" });
    assert.equal(r.text, "claude says hi; key=absent; tools=|");
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test("FileCredentialStore: 0600 file, encrypted when a cipher is given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "creds-"));
  const cipher = { kind: "test-rot", encrypt: (s: string) => Buffer.from(s).toString("base64"), decrypt: (s: string) => Buffer.from(s, "base64").toString() };
  const store = new FileCredentialStore(join(dir, "c", "auth.json"), cipher);
  await store.modify("openai", () => ({ type: "api_key", key: "sk-test" }));
  const file = join(dir, "c", "auth.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, "utf8").includes("sk-test"));
  assert.deepEqual(await store.read("openai"), { type: "api_key", key: "sk-test" });
  assert.deepEqual(await store.list(), [{ providerId: "openai", type: "api_key" }]);
  await store.delete("openai");
  assert.equal(await store.read("openai"), undefined);
});
