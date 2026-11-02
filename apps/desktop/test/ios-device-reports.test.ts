// Regression tests for IOS Dev's TestFlight 20261102.0005 reports (fake plugins only, no network):
//   1. header names arrive lowercased from Swift (and odd headers must not hang the fetch)
//   2. URLSession: small text/plain bodies coalesced into ONE chunk, SSE byte by byte (base64)
//   3. Keychain -34018 (errSecMissingEntitlement) in unsigned simulator builds
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicFetchBackend, KVCredentialStore, MemoryKV, OllamaBackend, OpenAICompatibleBackend, readApiKey, readChatStream, type StoredCredential } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";
import { createKeychainCredentials, createNativeStreamFetch, keychainStatus, nativeTransportOptions, type BHStreamEvent } from "../src/transport/native.ts";

type Ev = Omit<BHStreamEvent, "id">;
/** Fake BHStream that replays a scripted event list for each start() */
function fakeStream(events: (req: { url: string; body?: string }) => Ev[], async = true) {
  const listeners = new Set<(e: BHStreamEvent) => void>();
  let n = 0;
  return {
    async addListener(_e: "bhstream", cb: (e: BHStreamEvent) => void) {
      listeners.add(cb);
      return { remove: () => void listeners.delete(cb) };
    },
    async start(req: { url: string; method: string; headers: Record<string, string>; body?: string }) {
      const id = `s${++n}`;
      const run = () => {
        for (const e of events(req)) for (const l of [...listeners]) l({ ...e, id } as BHStreamEvent);
      };
      if (async) setTimeout(run, 1);
      else run();
      return { id };
    },
    async cancel() {},
  };
}
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
/** URLSession SSE: one base64 chunk per BYTE (splits every multibyte character) */
const byteByByte = (s: string): Ev[] => Array.from(enc.encode(s), (b) => ({ type: "chunk", b64: b64(new Uint8Array([b])) }) as Ev);
const head = (headers: Record<string, unknown>, status = 200): Ev => ({ type: "head", status, headers } as Ev);
const req = (onToken?: (d: string) => void) => ({ messages: [{ role: "user" as const, content: "hi" }], plan: { turn: 0, mode: "explore" as const, topic: "open", style: "open", reason: "" }, stateNote: "", onToken });

test("1. lowercased (and odd) header names from Swift: case-insensitive lookups, never a hung fetch", async () => {
  const f = createNativeStreamFetch(
    fakeStream(() => [
      head({ "content-type": "Text/Event-Stream; charset=UTF-8", "x-request-id": "abc", "set-cookie": ["a=1", "b=2"], "content-length": 42, ":status": "200", "x-bad": "line\nbreak" }),
      { type: "chunk", data: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' },
      { type: "end" },
    ]),
  );
  const res = await Promise.race([f("https://h/"), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("fetch hung on an invalid header")), 500))]);
  assert.equal(res.headers.get("Content-Type"), "Text/Event-Stream; charset=UTF-8");
  assert.equal(res.headers.get("X-Request-ID"), "abc");
  assert.equal(res.headers.get("content-length"), "42");
  assert.equal(res.headers.get("x-bad"), null, "invalid value skipped, not fatal");
  const d: string[] = [];
  assert.equal((await readChatStream(res, "t", (x) => d.push(x))).text, "ok");

  // a lowercase "application/json" header selects whole-JSON parsing (server ignored stream:true)
  const pretty = JSON.stringify({ choices: [{ message: { content: "whole" } }] }, null, 2);
  const j = createNativeStreamFetch(fakeStream(() => [head({ "content-type": "application/json" }), { type: "chunk", data: pretty }, { type: "end" }]));
  assert.equal((await readChatStream(await j("https://h/"), "t", () => {})).text, "whole");

  // request headers reach Swift as a plain lowercased record
  let seen: Record<string, string> = {};
  const r = createNativeStreamFetch({ ...fakeStream(() => [head({}), { type: "end" }]), start: async (o: { headers: Record<string, string> }) => ((seen = o.headers), { id: "x" }) } as never);
  void r("https://h/", { headers: { "Content-Type": "application/json", Authorization: "Bearer k" } }).catch(() => {});
  await new Promise((res2) => setTimeout(res2, 5));
  assert.deepEqual(seen, { "content-type": "application/json", authorization: "Bearer k" });
});

const OPENAI_SSE = ["Hé", "llo 🎻", " 日本", "?"].map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ça "}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"va 🎻?"}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n") + "\n\n";
const OLLAMA_NDJSON = ['{"message":{"content":"Naïve "},"done":false}', '{"message":{"content":"🎻?"},"done":false}', '{"done":true}'].join("\n") + "\n";

type Mk = (f: typeof fetch) => { generate: OpenAICompatibleBackend["generate"] };
const backends: Array<{ name: string; mk: Mk; sse: string; ct: string; text: string; deltas: string[]; whole: string }> = [
  { name: "openai-compatible", mk: (f) => new OpenAICompatibleBackend({ baseUrl: "http://192.168.1.2:1234/v1", model: "m", fetchImpl: f }), sse: OPENAI_SSE, ct: "text/event-stream", text: "Héllo 🎻 日本?", deltas: ["Hé", "llo 🎻", " 日本", "?"], whole: JSON.stringify({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: "Whole 🎻 body" } }] }, null, 2) },
  { name: "anthropic", mk: (f) => new AnthropicFetchBackend({ apiKey: "k", model: "c", baseUrl: "http://127.0.0.1:1", fetchImpl: f }), sse: ANTHROPIC_SSE, ct: "text/event-stream", text: "Ça va 🎻?", deltas: ["Ça ", "va 🎻?"], whole: JSON.stringify({ id: "m", type: "message", content: [{ type: "text", text: "Whole 🎻 body" }], usage: { input_tokens: 1 } }, null, 2) },
  { name: "ollama", mk: (f) => new OllamaBackend({ model: "m", baseUrl: "http://192.168.1.2:11434", fetchImpl: f }), sse: OLLAMA_NDJSON, ct: "application/x-ndjson", text: "Naïve 🎻?", deltas: ["Naïve ", "🎻?"], whole: JSON.stringify({ model: "m", message: { role: "assistant", content: "Whole 🎻 body" }, done: true }, null, 2) },
];

test("2a. SSE / NDJSON byte by byte as base64 (lines and multibyte characters split): every backend", async () => {
  for (const b of backends) {
    const f = createNativeStreamFetch(fakeStream(() => [head({ "content-type": b.ct }), ...byteByByte(b.sse), { type: "end" }]));
    const d: string[] = [];
    const r = await b.mk(f).generate(req((x) => d.push(x)));
    assert.equal(r.text, b.text, b.name);
    assert.deepEqual(d, b.deltas, b.name);
    assert.ok(!d.join("").includes("\uFFFD"), `${b.name}: no replacement characters`);
  }
});

test("2b. many events in one chunk, and the entire response in a single chunk (SSE, NDJSON, coalesced text/plain JSON)", async () => {
  for (const b of backends) {
    // all events in ONE chunk, events delivered synchronously inside start()
    for (const async of [true, false]) {
      const one = createNativeStreamFetch(fakeStream(() => [head({ "content-type": b.ct }), { type: "chunk", b64: b64(enc.encode(b.sse)) }, { type: "end" }], async));
      const d: string[] = [];
      assert.equal((await b.mk(one).generate(req((x) => d.push(x)))).text, b.text, `${b.name} one chunk`);
      assert.deepEqual(d, b.deltas, `${b.name}: still one delta per event`);
    }
    // server ignored stream:true: a small pretty-printed JSON body coalesced into one text/plain chunk
    for (const ct of ["text/plain", "application/json", ""]) {
      const whole = createNativeStreamFetch(fakeStream(() => [head(ct ? { "content-type": ct } : {}), { type: "chunk", data: b.whole }, { type: "end" }]));
      const d: string[] = [];
      assert.equal((await b.mk(whole).generate(req((x) => d.push(x)))).text, "Whole 🎻 body", `${b.name} whole body as ${ct || "no content-type"}`);
      assert.equal(d.join(""), "Whole 🎻 body");
    }
  }
  // hand-formatted JSON whose inner objects sit on their own lines (llama.cpp / proxies): the
  // line parser must not mistake {"type":"text",..} for the reply and return ""
  const handPretty = '{\n  "id": "m",\n  "content": [\n    {"type":"text","text":"Whole 🎻 body"}\n  ],\n  "usage": {"input_tokens": 1}\n}';
  for (const ct of ["text/plain", ""]) {
    const hp = createNativeStreamFetch(fakeStream(() => [head(ct ? { "content-type": ct } : {}), { type: "chunk", data: handPretty }, { type: "end" }]));
    assert.equal((await backends[1]!.mk(hp).generate(req(() => {}))).text, "Whole 🎻 body", `anthropic hand-pretty ${ct || "no content-type"}`);
  }
  const ollamaPretty = '{\n  "model": "m",\n  "message": {"role":"assistant","content":"Whole 🎻 body"},\n  "done": true\n}';
  const op = createNativeStreamFetch(fakeStream(() => [head({ "content-type": "text/plain" }), { type: "chunk", data: ollamaPretty }, { type: "end" }]));
  assert.equal((await backends[2]!.mk(op).generate(req(() => {}))).text, "Whole 🎻 body");

  // base64 with line breaks (NSData.base64EncodedString(options: .lineLength76Characters)) still decodes
  const long = enc.encode(OPENAI_SSE.repeat(3));
  const wrapped = b64(long).replace(/(.{76})/g, "$1\r\n");
  const f = createNativeStreamFetch(fakeStream(() => [head({ "content-type": "text/event-stream" }), { type: "chunk", b64: wrapped }, { type: "end" }]));
  assert.equal((await backends[0]!.mk(f).generate(req(() => {}))).text, "Héllo 🎻 日本?".repeat(3));
});

function brokenKeychain(err: unknown) {
  const calls: string[] = [];
  const fail = async (op: string) => {
    calls.push(op);
    throw err;
  };
  return { calls, get: () => fail("get"), set: () => fail("set"), remove: () => fail("remove"), keys: () => fail("keys") } as never as {
    calls: string[];
    get(o: { key: string }): Promise<{ value: string | null }>;
    set(o: { key: string; value: string }): Promise<void>;
    remove(o: { key: string }): Promise<void>;
    keys(): Promise<{ keys: string[] }>;
  };
}

test("3. Keychain -34018 (unsigned simulator): no crash, clear message, legacy keys kept + readable, new keys in memory", async () => {
  assert.equal(keychainStatus({ code: "-34018" }), -34018);
  assert.equal(keychainStatus({ data: { status: -34018 } }), -34018);
  assert.equal(keychainStatus(new Error("SecItemCopyMatching failed: OSStatus -34018")), -34018);

  for (const err of [Object.assign(new Error("Keychain error"), { code: "-34018" }), new Error("The operation couldn't be completed. (OSStatus error -34018.)"), Object.assign(new Error("errSecMissingEntitlement"), { data: { status: -34018 } })]) {
    const legacyKV = new MemoryKV();
    const legacy = new KVCredentialStore(legacyKV);
    await legacy.modify("openai", async () => ({ type: "api_key", key: "sk-old" }) as StoredCredential);
    const warns: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try {
      const plugin = brokenKeychain(err);
      const win = { Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n: string) => n === "BHKeychain", Plugins: { BHKeychain: plugin } }, fetch: (async () => new Response('{"models":[]}')) as typeof fetch };
      const t = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), platform: "test", ...nativeTransportOptions(win, { legacyCredentials: legacy }) });
      // nothing throws: status (reads every key), info, sessions, a chat turn
      const st = await t.providers.status();
      assert.ok(st.providers.find((p) => p.id === "openai")!.signedIn, "the existing localStorage key still works");
      assert.match(t.credentialNote ?? "", /-34018.*errSecMissingEntitlement/);
      assert.match(t.credentialNote ?? "", /memory for this launch/);
      await t.newSession();
      // adding a key works (memory only) and is used; it is NOT written to localStorage
      assert.deepEqual(await t.providers.setApiKey("anthropic", "ant-key"), { ok: true });
      assert.ok((await t.providers.status()).providers.find((p) => p.id === "anthropic")!.signedIn);
      assert.ok(![...legacyKV.data.keys()].some((k) => k.includes("anthropic")), "degraded writes stay out of localStorage");
      assert.equal(legacyKV.data.size, 1, "legacy copy not cleared after the failed migration");
      // logout removes both the memory and the legacy copy
      await t.providers.logout("openai");
      assert.equal(legacyKV.data.size, 0);
      assert.ok(!(await t.providers.status()).providers.find((p) => p.id === "openai")!.signedIn);
      assert.ok(warns.some((w) => /-34018/.test(w)), "logged with the OSStatus");
      assert.ok(warns.length <= 2, `logged once, not per call (${warns.length})`);
    } finally {
      console.warn = warn;
    }
  }
});

test("3b. other Keychain errors: reads fall back without throwing; a failed save gives a clear error", async () => {
  const legacy = new KVCredentialStore(new MemoryKV());
  await legacy.modify("openai", async () => ({ type: "api_key", key: "sk-old" }) as StoredCredential);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const s = createKeychainCredentials(brokenKeychain(Object.assign(new Error("User interaction is not allowed."), { code: "-25308" })), legacy);
    await s.migration;
    assert.equal(s.unavailable, null, "not the entitlement case");
    assert.equal(await readApiKey(s, "openai"), "sk-old");
    assert.deepEqual((await s.list()).map((c) => c.providerId), ["openai"]);
    await assert.rejects(s.modify("anthropic", async () => ({ type: "api_key", key: "x" }) as StoredCredential), /iOS Keychain save failed \(OSStatus -25308\): User interaction is not allowed/);
  } finally {
    console.warn = warn;
  }
});
