// (1) Capacitor detection in the web entry; (2) every browser backend works with a CapacitorHttp-style
// BUFFERED fetch: whole body at once, no response.body stream, maybe SSE/NDJSON in one chunk.
// Fake fetch only: no network, no paid calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV, createBrowserBackend } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";
import { isNativeCapacitor, nativeTransportOptions } from "../src/transport/native.ts";

/** CapacitorHttp-like Response: buffered text only, body === null (no reader). */
function bufferedResponse(raw: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    text: async () => raw,
    json: async () => JSON.parse(raw),
  } as unknown as Response;
}

const transport = (extra: object) =>
  createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()), platform: "test", ...extra });

test("web entry: native Capacitor enables Ollama Cloud, plain PWA / Capacitor-web keep it off", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { throw new Error(`page fetch used for ${String(u)}`); }) as typeof fetch;
  try {
    const seen: string[] = [];
    const nativeWin = {
      Capacitor: { isNativePlatform: () => true },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (String(input).endsWith("/api/tags")) return bufferedResponse('{"models":[{"name":"gemma4:cloud"}]}');
        return bufferedResponse('{"message":{"content":"native cloud hi?"}}');
      }) as typeof fetch,
    };
    assert.equal(isNativeCapacitor(nativeWin), true);
    assert.equal(isNativeCapacitor({ fetch }), false);
    assert.equal(isNativeCapacitor({ Capacitor: { isNativePlatform: () => false }, fetch }), false);
    assert.deepEqual(nativeTransportOptions({ fetch }), {});

    const pwa = transport(nativeTransportOptions({ fetch: globalThis.fetch }));
    const p = (await pwa.providers.status()).providers.find((x) => x.id === "ollama-cloud")!;
    assert.equal(p.available, false);
    assert.match(p.detail!, /no CORS/);

    const app = transport(nativeTransportOptions(nativeWin));
    await app.providers.setApiKey("ollama-cloud", "fake-key");
    const a = (await app.providers.status()).providers.find((x) => x.id === "ollama-cloud")!;
    assert.equal(a.available, true);
    assert.equal(a.signedIn, true);
    await app.providers.select("ollama-cloud", "gemma4:cloud");
    await app.newSession();
    const r = await app.reply({ text: "i like ham radio", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    assert.match(r.director.text, /native cloud hi/, r.director.text);
    assert.ok(seen.includes("POST https://ollama.com/api/chat"), seen.join("\n"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// bodies per provider: [normal JSON, the same reply streamed but delivered as ONE buffered chunk]
const BODIES: Record<string, string[]> = {
  ollama: [
    '{"model":"m","message":{"role":"assistant","content":"Hello there, what got you into it?"},"done":true}',
    ['{"message":{"content":"Hello there, "},"done":false}', '{"message":{"content":"what got you into it?"},"done":false}', '{"message":{"content":""},"done":true,"eval_count":9}'].join("\n"),
  ],
  openai: [
    '{"choices":[{"message":{"role":"assistant","content":"Hello there, what got you into it?"}}],"usage":{"prompt_tokens":5,"completion_tokens":9}}',
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hello there, "}}]}\n\ndata: {"choices":[{"delta":{"content":"what got you into it?"}}]}\n\ndata: [DONE]\n\n',
  ],
  anthropic: [
    '{"content":[{"type":"text","text":"Hello there, what got you into it?"}],"usage":{"input_tokens":5,"output_tokens":9}}',
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello there, "}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"what got you into it?"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  ],
};
const SPECS = [
  { provider: "ollama", baseUrl: "http://192.168.0.114:11434", model: "m", shape: "ollama" },
  { provider: "ollama-cloud", apiKey: "k", model: "gemma4:cloud", shape: "ollama" },
  { provider: "openai-compatible", baseUrl: "http://192.168.0.114:1234/v1", model: "local", shape: "openai" },
  { provider: "openai", apiKey: "sk-fake", model: "gpt-4o-mini", shape: "openai" },
  { provider: "anthropic", apiKey: "sk-ant-fake", model: "claude-haiku-4-5", shape: "anthropic" },
] as const;

test("every browser backend reads a buffered reply (JSON or one-chunk stream) and asks for stream:false", async () => {
  for (const spec of SPECS) {
    for (const [i, raw] of BODIES[spec.shape]!.entries()) {
      const sent: any[] = [];
      const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return bufferedResponse(raw);
      }) as typeof fetch;
      const b = createBrowserBackend({ ...spec, fetchImpl } as never);
      const out = await b.generate({ messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] } as never);
      assert.equal(out.text, "Hello there, what got you into it?", `${spec.provider} body#${i}`);
      assert.equal(sent[0].stream, false, `${spec.provider} must request stream:false`);
    }
  }
});

test("buffered errors surface instead of hanging; the UI still gets a Director reply", async () => {
  const fail = (async () => bufferedResponse('{"error":{"message":"bad key"}}', 401)) as typeof fetch;
  await assert.rejects(createBrowserBackend({ provider: "openai", apiKey: "x", fetchImpl: fail }).generate({ messages: [] } as never), /401/);
  const err200 = (async () => bufferedResponse('{"error":"model not found"}')) as typeof fetch;
  await assert.rejects(createBrowserBackend({ provider: "ollama", baseUrl: "http://h:11434", model: "m", fetchImpl: err200 }).generate({ messages: [] } as never), /model not found/);

  // end to end through the transport with a buffered SSE body from an OpenAI-compatible server
  const fetchImpl = (async (u: RequestInfo | URL) =>
    String(u).endsWith("/api/tags") ? bufferedResponse('{"models":[]}') : bufferedResponse(BODIES.openai![1]!)) as typeof fetch;
  const t = transport({ fetchImpl, nativeFetch: true });
  await t.providers.setEndpoint!("openai-compatible", "http://192.168.0.114:1234/v1");
  await t.providers.select("openai-compatible", "local");
  await t.newSession();
  const r = await t.reply({ text: "i like ham radio", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
  assert.match(r.director.text, /what got you into it/, r.director.text);
  assert.equal((await t.info()).backend, "openai-compatible:local");
});
