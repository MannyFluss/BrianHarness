// Every browser network path goes through createInProcessTransport({ fetchImpl }) (IOS Dev: CapacitorHttp).
// Fake fetch only: no real network, no paid calls. Global fetch is replaced with a thrower to prove it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";

test("fetchImpl reaches detection, all backends and the Ollama tagger", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/tags")) return json({ models: [{ name: "fake:1b" }] });
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return json({ message: { content: body.format === "json" ? '{"topics":[{"label":"ham radio","parent":"none"}]}' : "ollama says hi?" } });
    }
    if (url.endsWith("/chat/completions")) return json({ choices: [{ message: { content: "oai says hi?" } }] });
    if (url.endsWith("/v1/messages")) return json({ content: [{ type: "text", text: "claude says hi?" }] });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { throw new Error(`global fetch used for ${String(u)}`); }) as typeof fetch;
  try {
    const kv = new MemoryKV();
    const t = createInProcessTransport({
      storageKV: new MemoryKV(), settingsKV: kv, credentials: new KVCredentialStore(new MemoryKV()),
      fetchImpl: fakeFetch, tagger: { kind: "ollama", model: "fake:1b" }, platform: "test",
    });
    await t.providers.setEndpoint!("ollama", "http://192.168.0.114:11434");
    const st = await t.providers.status();
    assert.equal(st.providers.find((p) => p.id === "ollama")?.available, true);
    await t.newSession();

    await t.providers.select("ollama", "fake:1b");
    await t.reply({ text: "i love ham radio", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    assert.ok(calls.some((c) => c === "POST http://192.168.0.114:11434/api/chat"), "ollama chat + tagger via fetchImpl");

    await t.providers.setEndpoint!("openai-compatible", "http://192.168.0.114:1234/v1");
    await t.providers.select("openai-compatible", "local");
    await t.reply({ text: "yes", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    assert.ok(calls.includes("POST http://192.168.0.114:1234/v1/chat/completions"));

    await t.providers.setApiKey("openai", "sk-test-fake");
    await t.providers.select("openai", "gpt-4o-mini");
    await t.reply({ text: "ok", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    assert.ok(calls.includes("POST https://api.openai.com/v1/chat/completions"));

    await t.providers.setApiKey("anthropic", "sk-ant-fake");
    await t.providers.select("anthropic", "claude-haiku-4-5");
    await t.reply({ text: "ok", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    assert.ok(calls.includes("POST https://api.anthropic.com/v1/messages"));

    // the tagger's JSON call went through fetchImpl too (format=json request seen as an extra /api/chat)
    assert.ok(calls.filter((c) => c.endsWith("/api/chat")).length >= 2, calls.join("\n"));
    assert.ok(calls.some((c) => c === "GET http://192.168.0.114:11434/api/tags"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
