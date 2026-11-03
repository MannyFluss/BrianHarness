// Every browser network path goes through createInProcessTransport({ fetchImpl }) (IOS Dev: CapacitorHttp).
// Fake fetch only: no real network, no paid calls. Global fetch is replaced with a thrower to prove it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";

// Plain chat (Nov 3 2026) builds no tagger: the tagger check exercises the Director-profile path, which a non-study
// session only takes when the study assignment errors (secure store unreadable). Keychain reads throw there on purpose.
const brokenSecret = { get: async () => { throw new Error("secure store unavailable (test)"); }, set: async () => { throw new Error("secure store unavailable (test)"); }, remove: async () => {}, keys: async () => [] };

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
      storageKV: new MemoryKV(), settingsKV: kv, secretKV: brokenSecret, credentials: new KVCredentialStore(new MemoryKV()),
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

test("Ollama Cloud: plain PWA (no native fetch) says no-CORS; native fetchImpl sends the Bearer key", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { throw new Error(`global fetch used for ${String(u)}`); }) as typeof fetch;
  try {
    // plain PWA: no fetchImpl
    const pwa = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()), platform: "test" });
    await pwa.providers.setApiKey("ollama-cloud", "fake-key");
    const ps = (await pwa.providers.status()).providers.find((p) => p.id === "ollama-cloud")!;
    assert.equal(ps.available, false);
    assert.match(ps.detail!, /needs the native app \(no CORS\)/);
    await assert.rejects(pwa.providers.select("ollama-cloud", "gemma4:cloud"), /needs the native app \(no CORS\)/);

    // native (CapacitorHttp-style) fetch
    const seen: string[] = [];
    const nativeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      seen.push(`${init?.method ?? "GET"} ${url} ${auth}`);
      if (auth !== "Bearer fake-key") return new Response("{}", { status: 401 });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://ollama.com/api/tags") return json({ models: [{ name: "gpt-oss:120b" }, { name: "gemma4:cloud" }] });
      if (url === "https://ollama.com/api/chat") return json({ message: { content: "cloud says hi?" } });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const app = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()), fetchImpl: nativeFetch, platform: "ios-phone" });
    let st = (await app.providers.status()).providers.find((p) => p.id === "ollama-cloud")!;
    assert.equal(st.available, true);
    assert.equal(st.signedIn, false);
    await assert.rejects(app.providers.select("ollama-cloud", "gemma4:cloud"), /API key/);
    await app.providers.setApiKey("ollama-cloud", "fake-key");
    st = (await app.providers.status()).providers.find((p) => p.id === "ollama-cloud")!;
    assert.equal(st.signedIn, true);
    assert.deepEqual(st.models.map((m) => [m.id, m.paid]), [["gemma4:cloud", false], ["gpt-oss:120b", false]]);
    const info = await app.providers.select("ollama-cloud", "gemma4:cloud");
    assert.equal(info.backend, "ollama-cloud:gemma4:cloud");
    assert.equal(info.paid, false);
    await app.newSession();
    const r = await app.reply({ text: "i like ham radio", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    assert.ok(r.director.text.length > 0);
    assert.ok(seen.includes("POST https://ollama.com/api/chat Bearer fake-key"), seen.join("\n"));
    assert.ok(seen.includes("GET https://ollama.com/api/tags Bearer fake-key"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
