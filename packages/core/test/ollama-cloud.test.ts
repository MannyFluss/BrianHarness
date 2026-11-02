// Ollama Cloud provider against a FAKE local server (no real ollama.com call, no key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OllamaBackend, ProviderHub, createBackend, createBrowserBackend, detectOllamaCloud, parseBackendRef } from "../src/index.js";

const KEY = "fake-ollama-key";
export async function fakeOllamaCloud() {
  const seen: Array<{ method: string; url: string; auth?: string; body?: any }> = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    if (req.method === "OPTIONS") return res.writeHead(405).end(); // what ollama.com does: no ACAO
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    const json = (b: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (req.url === "/api/tags") return json({ models: [{ name: "gemma4:cloud" }, { name: "gpt-oss:120b" }] });
    if (req.url === "/api/chat") return json({ message: { content: "cloud says hi?" } });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("OllamaBackend cloudProvider: Bearer header, ollama-cloud id, not paid; key required", async () => {
  const f = await fakeOllamaCloud();
  try {
    const b = new OllamaBackend({ model: "gemma4:cloud", baseUrl: f.url, apiKey: KEY, cloudProvider: true });
    assert.equal(b.id, "ollama-cloud:gemma4:cloud");
    assert.equal(b.paid, false);
    assert.equal((await b.generate({ messages: [{ role: "user", content: "hi" }] } as never)).text, "cloud says hi?");
    const chat = f.seen.find((s) => s.url === "/api/chat")!;
    assert.equal(chat.auth, `Bearer ${KEY}`);
    assert.equal(chat.body.model, "gemma4:cloud");
    assert.throws(() => new OllamaBackend({ model: "gemma4:cloud", cloudProvider: true }), /API key/);
    // a *:cloud model through the LOCAL ollama provider is still paid (unchanged)
    assert.equal(new OllamaBackend({ model: "gemma4:cloud" }).paid, true);
    // bad key -> 401, surfaced (no retry loop on 4xx)
    await assert.rejects(new OllamaBackend({ model: "x", baseUrl: f.url, apiKey: "wrong", cloudProvider: true }).generate({ messages: [] } as never), /401/);
  } finally {
    await f.close();
  }
});

test("factories + model listing via /api/tags with the key", async () => {
  const f = await fakeOllamaCloud();
  try {
    assert.deepEqual(parseBackendRef("ollama-cloud:gemma4:cloud"), { provider: "ollama-cloud", model: "gemma4:cloud" });
    const nb = await createBackend({ provider: "ollama-cloud", apiKey: KEY, baseUrl: f.url });
    assert.equal(nb.id, "ollama-cloud:gemma4:cloud");
    assert.equal(nb.paid, false);
    await assert.rejects(createBackend({ provider: "ollama-cloud" }), /API key/);
    assert.throws(() => createBrowserBackend({ provider: "ollama-cloud" }), /API key/);
    const d = await detectOllamaCloud(KEY, fetch, 2000, f.url);
    assert.equal(d.running, true);
    assert.deepEqual(d.models.map((m) => [m.name, m.cloud]), [["gemma4:cloud", true], ["gpt-oss:120b", true]]);
    assert.equal(f.seen.find((s) => s.url === "/api/tags")?.auth, `Bearer ${KEY}`);
    const bad = await detectOllamaCloud("wrong", fetch, 2000, f.url);
    assert.equal(bad.running, false);
    assert.match(bad.error!, /401.*rejected/);
    assert.equal((await detectOllamaCloud(undefined, fetch, 2000, f.url)).error, "no API key");
  } finally {
    await f.close();
  }
});

test("ProviderHub: key in the user-data credentials file, status lists models, backend builds", async () => {
  const f = await fakeOllamaCloud();
  try {
    const dir = mkdtempSync(join(tmpdir(), "bh-hub-cloud-"));
    const hub = new ProviderHub({ dataDir: dir, ollamaCloudUrl: f.url, claudeBin: "/nonexistent/claude", piModels: { checkAuth: async () => undefined, getModels: () => [], getAvailable: async () => [], login: async () => {}, logout: async () => {} } as never });
    let st = (await hub.status()).find((p) => p.id === "ollama-cloud")!;
    assert.equal(st.signedIn, false);
    await assert.rejects(hub.createBackend({ provider: "ollama-cloud" }), /API key/);
    await hub.setApiKey("ollama-cloud", KEY);
    st = (await hub.status()).find((p) => p.id === "ollama-cloud")!;
    assert.equal(st.signedIn, true);
    assert.deepEqual(st.models.map((m) => [m.id, m.paid]), [["gemma4:cloud", false], ["gpt-oss:120b", false]]);
    const b = await hub.createBackend({ provider: "ollama-cloud", model: "gpt-oss:120b" });
    assert.equal(b.id, "ollama-cloud:gpt-oss:120b");
    assert.equal((await b.generate({ messages: [{ role: "user", content: "hi" }] } as never)).text, "cloud says hi?");
    await hub.logout("ollama-cloud");
    assert.equal((await hub.status()).find((p) => p.id === "ollama-cloud")!.signedIn, false);
  } finally {
    await f.close();
  }
});
