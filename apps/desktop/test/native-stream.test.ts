// iOS native plugins, TS side, against FAKE plugins (no Swift, no network, no paid calls):
//   BHStream   -> nativeStreamFetch: early / out-of-order events, abort, error, SSE split mid-line,
//                 multibyte characters split across chunks, fallback when the plugin is missing
//   BHKeychain -> CredentialStoreLike + one-time localStorage migration (idempotent, never clears
//                 on a failed Keychain write)
//   typing indicator: shown and painted before the transport / network is touched
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV, OpenAICompatibleBackend, type StoredCredential } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";
import { createKeychainCredentials, createNativeStreamFetch, migrateCredentials, nativeTransportOptions, type BHKeychainPlugin, type BHStreamEvent } from "../src/transport/native.ts";
import { runStreamedTurn } from "../src/chat-flow.ts";

type Emit = (e: BHStreamEvent) => void;
class FakeBHStream {
  listeners = new Set<(e: BHStreamEvent) => void>();
  started: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  cancelled: string[] = [];
  n = 0;
  log: string[] = [];
  /** runs inside start() BEFORE it resolves (so events can race the id) */
  script: (id: string, emit: Emit, req: FakeBHStream["started"][number]) => void = () => {};
  startError: unknown = null;
  async addListener(_ev: "bhstream", cb: (e: BHStreamEvent) => void) {
    this.listeners.add(cb);
    return { remove: async () => void this.listeners.delete(cb) };
  }
  async start(o: FakeBHStream["started"][number]) {
    this.log.push("start");
    if (this.startError) throw this.startError;
    const id = `s${++this.n}`;
    this.started.push(o);
    this.script(id, this.emit, o);
    return { id };
  }
  emit: Emit = (e) => {
    for (const l of [...this.listeners]) l(e);
  };
  async cancel({ id }: { id: string }) {
    this.cancelled.push(id);
  }
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const tick = () => new Promise((r) => setTimeout(r, 0));

test("BHStream: events before start() resolves and chunks before head are buffered; other ids ignored", async () => {
  const p = new FakeBHStream();
  p.script = (id, emit) => {
    emit({ id, type: "chunk", data: "Hel" }); // chunk BEFORE head, and before we know our id
    emit({ id: "other", type: "head", status: 500, headers: {} });
    emit({ id, type: "head", status: 200, headers: { "content-type": "text/plain", "x-a": "1" } });
    emit({ id: "other", type: "chunk", data: "XXX" });
    emit({ id, type: "chunk", data: "lo" });
    emit({ id, type: "end" });
  };
  const f = createNativeStreamFetch(p);
  const res = await f("https://h/x", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body: '{"a":1}' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-a"), "1");
  assert.equal(await res.text(), "Hello");
  assert.deepEqual(p.started[0], { url: "https://h/x", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body: '{"a":1}' });
  await tick();
  assert.equal(p.listeners.size, 0, "listener removed after end");
});

test("BHStream: Response resolves on head and the body streams incrementally", async () => {
  const p = new FakeBHStream();
  let emitLater!: Emit, sid = "";
  p.script = (id, emit) => ((emitLater = emit), (sid = id));
  const resP = createNativeStreamFetch(p)("https://h/s");
  await tick();
  let resolved = false;
  void resP.then(() => (resolved = true));
  await tick();
  assert.equal(resolved, false, "no Response before head");
  emitLater({ id: sid, type: "head", status: 201, headers: {} });
  const res = await resP;
  assert.equal(res.status, 201);
  const reader = res.body!.getReader();
  emitLater({ id: sid, type: "chunk", data: "one " });
  assert.equal(new TextDecoder().decode((await reader.read()).value), "one ", "first chunk readable before the stream ends");
  emitLater({ id: sid, type: "chunk", data: "two" });
  emitLater({ id: sid, type: "end" });
  assert.equal(new TextDecoder().decode((await reader.read()).value), "two");
  assert.equal((await reader.read()).done, true);
});

test("BHStream: abort before head rejects with AbortError and cancels; abort mid-body errors the stream", async () => {
  const p = new FakeBHStream();
  let emit!: Emit, sid = "";
  p.script = (id, e) => ((emit = e), (sid = id));
  const ac = new AbortController();
  const resP = createNativeStreamFetch(p)("https://h/a", { signal: ac.signal });
  await tick();
  ac.abort();
  await assert.rejects(resP, (e: Error) => e.name === "AbortError");
  assert.deepEqual(p.cancelled, [sid]);
  await tick();
  assert.equal(p.listeners.size, 0);
  emit({ id: sid, type: "head", status: 200, headers: {} }); // late events are harmless

  const ac2 = new AbortController();
  p.script = (id, e) => {
    e({ id, type: "head", status: 200, headers: {} });
    e({ id, type: "chunk", data: "partial" });
  };
  const res = await createNativeStreamFetch(p)("https://h/b", { signal: ac2.signal });
  const reader = res.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "partial");
  ac2.abort();
  await assert.rejects(reader.read(), (e: Error) => e.name === "AbortError");
  assert.equal(p.cancelled.at(-1), "s2");

  // already-aborted signal: start() is never called
  const before = p.started.length;
  await assert.rejects(createNativeStreamFetch(p)("https://h/c", { signal: AbortSignal.abort() }), (e: Error) => e.name === "AbortError");
  assert.equal(p.started.length, before);
});

test("BHStream: error before head rejects fetch; error after head errors the body", async () => {
  const p = new FakeBHStream();
  p.script = (id, e) => e({ id, type: "error", message: "offline" });
  await assert.rejects(createNativeStreamFetch(p)("https://h/e"), /BHStream: offline/);
  p.script = (id, e) => {
    e({ id, type: "head", status: 200, headers: {} });
    e({ id, type: "chunk", data: "half" });
    e({ id, type: "error", message: "connection lost" });
  };
  const res = await createNativeStreamFetch(p)("https://h/e2");
  await assert.rejects(res.text(), /connection lost/);
  p.script = (id, e) => e({ id, type: "end" });
  await assert.rejects(createNativeStreamFetch(p)("https://h/e3"), /without a head/);
  p.startError = new Error("bad url");
  await assert.rejects(createNativeStreamFetch(p)("https://h/e4"), /bad url/);
});

test("BHStream: multibyte characters split across chunks (b64 raw bytes, and split surrogate pairs in data)", async () => {
  const text = "café 🎻 日本 naïve";
  const bytes = new TextEncoder().encode(text);
  const p = new FakeBHStream();
  p.script = (id, e) => {
    e({ id, type: "head", status: 200, headers: {} });
    for (let i = 0; i < bytes.length; i += 3) e({ id, type: "chunk", b64: b64(bytes.slice(i, i + 3)) }); // cuts é, 🎻, 日 mid-sequence
    e({ id, type: "end" });
  };
  assert.equal(await (await createNativeStreamFetch(p)("https://h/m")).text(), text);

  // text mode: a JS string chunk boundary inside a surrogate pair must not produce U+FFFD
  const units = [...text].join("").split(""); // UTF-16 code units: 🎻 is two
  p.script = (id, e) => {
    e({ id, type: "head", status: 200, headers: {} });
    for (const u of units) e({ id, type: "chunk", data: u });
    e({ id, type: "end" });
  };
  const got = await (await createNativeStreamFetch(p)("https://h/m2")).text();
  assert.equal(got, text);
  assert.ok(!got.includes("\uFFFD"));
});

const SSE = ["Hel", "lo, ", "wörld 🎻", "?"].map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";

test("BHStream end to end: OpenAI-compatible SSE split mid-line streams tokens through nativeStreamFetch", async () => {
  const p = new FakeBHStream();
  const bytes = new TextEncoder().encode(SSE);
  p.script = (id, e, req) => {
    assert.equal(JSON.parse(req.body!).stream, true);
    setTimeout(() => {
      e({ id, type: "head", status: 200, headers: { "content-type": "text/event-stream" } });
      for (let i = 0; i < bytes.length; i += 7) e({ id, type: "chunk", b64: b64(bytes.slice(i, i + 7)) });
      e({ id, type: "end" });
    }, 1);
  };
  const backend = new OpenAICompatibleBackend({ baseUrl: "http://192.168.1.20:1234/v1", model: "m", fetchImpl: createNativeStreamFetch(p) });
  const deltas: string[] = [];
  const r = await backend.generate({ messages: [{ role: "user", content: "hi" }], plan: { turn: 0, mode: "explore", topic: "open", style: "open", reason: "" }, stateNote: "", onToken: (d) => deltas.push(d) });
  assert.equal(r.text, "Hello, wörld 🎻?");
  assert.deepEqual(deltas, ["Hel", "lo, ", "wörld 🎻", "?"]);
});

function fakeKeychain() {
  const data = new Map<string, string>();
  const kc = {
    data,
    failSet: false,
    calls: [] as string[],
    async get({ key }: { key: string }) {
      return { value: data.get(key) ?? null };
    },
    async set({ key, value }: { key: string; value: string }) {
      kc.calls.push(`set ${key}`);
      if (kc.failSet) throw new Error("errSecInteractionNotAllowed");
      data.set(key, value);
    },
    async remove({ key }: { key: string }) {
      data.delete(key);
    },
    async keys() {
      return { keys: [...data.keys()] };
    },
  };
  return kc;
}
const nativeWin = (plugins: Record<string, unknown>, fetchImpl: typeof fetch = (async () => { throw new Error("buffered fetch used"); }) as typeof fetch) => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n: string) => n in plugins, Plugins: plugins },
  fetch: fetchImpl,
});

test("nativeTransportOptions: BHStream -> streaming fetch; missing/unimplemented -> buffered CapacitorHttp path", async () => {
  const p = new FakeBHStream();
  p.script = (id, e) => {
    e({ id, type: "head", status: 200, headers: {} });
    e({ id, type: "chunk", data: "streamed" });
    e({ id, type: "end" });
  };
  const withStream = nativeTransportOptions(nativeWin({ BHStream: p }));
  assert.equal(withStream.streaming, true);
  assert.equal(withStream.nativeFetch, true);
  assert.equal(await (await withStream.fetchImpl!("https://h/")).text(), "streamed");

  let buffered = 0;
  const bufferedFetch = (async () => (buffered++, new Response("buffered"))) as typeof fetch;
  const none = nativeTransportOptions(nativeWin({}, bufferedFetch));
  assert.equal(none.streaming, false);
  assert.equal(none.credentials, undefined, "no BHKeychain -> the transport keeps its default store");
  assert.equal(await (await none.fetchImpl!("https://h/")).text(), "buffered");

  // the plugin is registered but the native side is missing: fall back for this and later calls
  const broken = new FakeBHStream();
  broken.startError = Object.assign(new Error("BHStream plugin is not implemented on ios"), { code: "UNIMPLEMENTED" });
  const o = nativeTransportOptions(nativeWin({ BHStream: broken }, bufferedFetch));
  assert.equal(await (await o.fetchImpl!("https://h/")).text(), "buffered");
  assert.equal(await (await o.fetchImpl!("https://h/")).text(), "buffered");
  assert.equal(buffered, 3);
  assert.deepEqual(nativeTransportOptions({ fetch }), {}, "plain PWA: unchanged");
});

test("in-process transport over BHStream: tokens reach onToken incrementally; the page fetch is never used", async () => {
  const p = new FakeBHStream();
  const bytes = new TextEncoder().encode(SSE);
  p.script = (id, e) =>
    void setTimeout(() => {
      e({ id, type: "head", status: 200, headers: { "content-type": "text/event-stream" } });
      for (let i = 0; i < bytes.length; i += 5) e({ id, type: "chunk", b64: b64(bytes.slice(i, i + 5)) });
      e({ id, type: "end" });
    }, 1);
  const legacy = new KVCredentialStore(new MemoryKV());
  const t = createInProcessTransport({
    storageKV: new MemoryKV(),
    settingsKV: new MemoryKV(),
    platform: "test",
    ...nativeTransportOptions(nativeWin({ BHStream: p, BHKeychain: fakeKeychain() }), { legacyCredentials: legacy }),
  });
  assert.match(t.credentialNote ?? "", /Keychain/);
  await t.providers.setEndpoint!("openai-compatible", "http://192.168.1.20:1234/v1");
  await t.providers.select("openai-compatible", "local-model");
  const opener: string[] = [];
  const s = await t.newSession((d) => opener.push(d));
  assert.equal(s.director.text, "Hello, wörld 🎻?");
  assert.deepEqual(opener, ["Hel", "lo, ", "wörld 🎻", "?"]);
  const tokens: string[] = [];
  const r = await t.reply({ text: "I restore watches", events: [], sentAt: Date.now(), shownAt: Date.now() - 500, firstTokenAt: Date.now() - 900 }, (d) => tokens.push(d));
  assert.equal(r.director.text, "Hello, wörld 🎻?");
  assert.equal(tokens.length, 4);
  assert.ok(p.started.every((x) => JSON.parse(x.body!).stream === true));
});

test("BHKeychain: localStorage keys migrate once, are cleared only after a verified Keychain write", async () => {
  const legacyKV = new MemoryKV();
  const legacy = new KVCredentialStore(legacyKV);
  const openai: StoredCredential = { type: "api_key", key: "sk-local" } as StoredCredential;
  await legacy.modify("openai", async () => openai);
  await legacy.modify("ollama-cloud", async () => ({ type: "api_key", key: "ol-local" }) as StoredCredential);

  // 1) Keychain write fails: NOTHING is cleared, reads still find the key
  const kc = fakeKeychain();
  kc.failSet = true;
  const s1 = createKeychainCredentials(kc as BHKeychainPlugin, legacy);
  const r1 = await s1.migration;
  assert.deepEqual(r1.migrated, []);
  assert.equal(r1.failed.length, 2);
  assert.equal(legacyKV.data.size, 2, "local copies kept");
  assert.equal(((await s1.read("openai")) as { key: string }).key, "sk-local", "falls back to the legacy copy");
  assert.equal((await s1.list()).length, 2);

  // 2) next launch, Keychain works: migrate + clear
  kc.failSet = false;
  const s2 = createKeychainCredentials(kc as BHKeychainPlugin, legacy);
  const r2 = await s2.migration;
  assert.deepEqual(r2.migrated.sort(), ["ollama-cloud", "openai"]);
  assert.equal(legacyKV.data.size, 0, "local copies cleared");
  assert.equal(kc.data.get("credentials/openai"), JSON.stringify(openai));
  assert.equal(((await s2.read("openai")) as { key: string }).key, "sk-local");

  // 3) idempotent: nothing left to move, no writes
  const writes = kc.calls.length;
  const r3 = await createKeychainCredentials(kc as BHKeychainPlugin, legacy).migration;
  assert.deepEqual(r3, { migrated: [], alreadyInKeychain: [], failed: [] });
  assert.equal(kc.calls.length, writes);

  // 4) a stale local copy never overwrites a newer Keychain value; the local copy is dropped
  await legacy.modify("openai", async () => ({ type: "api_key", key: "sk-stale" }) as StoredCredential);
  const r4 = await migrateCredentials(legacy, new KVCredentialStore({ get: async (k) => (await kc.get({ key: k })).value, set: (k, v) => kc.set({ key: k, value: v }), remove: (k) => kc.remove({ key: k }), keys: async (pre = "") => (await kc.keys()).keys.filter((k) => k.startsWith(pre)) }));
  assert.deepEqual(r4.alreadyInKeychain, ["openai"]);
  assert.equal(((await s2.read("openai")) as { key: string }).key, "sk-local");
  assert.equal(legacyKV.data.size, 0);

  // 5) normal use goes to the Keychain
  await s2.modify("anthropic", async () => ({ type: "api_key", key: "ant" }) as StoredCredential);
  assert.ok(kc.data.has("credentials/anthropic"));
  await s2.delete("anthropic");
  assert.ok(!kc.data.has("credentials/anthropic"));
});

test("typing indicator: shown and painted before the transport or any network call; first token replaces it", async () => {
  const log: string[] = [];
  const p = new FakeBHStream();
  const origStart = p.start.bind(p);
  p.start = async (o) => (log.push("network:start"), origStart(o));
  p.script = (id, e) =>
    void setTimeout(() => {
      e({ id, type: "head", status: 200, headers: { "content-type": "text/event-stream" } });
      e({ id, type: "chunk", data: SSE });
      e({ id, type: "end" });
    }, 5);
  const t = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), platform: "test", ...nativeTransportOptions(nativeWin({ BHStream: p })) });
  await t.providers.setEndpoint!("openai-compatible", "http://192.168.1.20:1234/v1");
  await t.providers.select("openai-compatible", null);
  await t.newSession();
  log.length = 0;
  let indicator = false;
  const out = await runStreamedTurn({
    showPending: () => ((indicator = true), log.push("indicator:on")),
    paint: async () => void log.push("painted"),
    call: (onToken) => (log.push("transport:reply"), t.reply({ text: "hi", events: [], sentAt: Date.now(), shownAt: Date.now() }, onToken)),
    onFirstToken: (text) => ((indicator = false), log.push(`first:${text}`)),
    onText: () => log.push("token"),
  });
  assert.deepEqual(log.slice(0, 4), ["indicator:on", "painted", "transport:reply", "network:start"]);
  assert.equal(log[4], "first:Hel");
  assert.equal(indicator, false);
  assert.equal(out.text, "Hello, wörld 🎻?");
  assert.equal(typeof out.firstTokenAt, "number");

  // every backend: the mock (in-process, streaming words with a delay) behaves the same
  const mock = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), platform: "test", mockTokenDelayMs: 2 });
  await mock.newSession();
  const order: string[] = [];
  const m = await runStreamedTurn({
    showPending: () => order.push("indicator"),
    paint: async () => void order.push("painted"),
    call: (onToken) => (order.push("call"), mock.reply({ text: "I fix old radios", events: [], sentAt: Date.now(), shownAt: Date.now() }, onToken)),
    onFirstToken: () => order.push("first"),
    onText: () => order.push("token"),
  });
  assert.deepEqual(order.slice(0, 4), ["indicator", "painted", "call", "first"]);
  assert.ok(order.filter((x) => x === "token").length >= 2, "mock streams several tokens");
  assert.equal(m.text, m.result.director.text);

  // non-streaming path (CapacitorHttp without BHStream): one delta with the whole text
  const buf = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), platform: "test", ...nativeTransportOptions(nativeWin({}, (async () => new Response('{"choices":[{"message":{"content":"Buffered reply?"}}]}')) as typeof fetch)) });
  await buf.providers.setEndpoint!("openai-compatible", "http://192.168.1.20:1234/v1");
  await buf.providers.select("openai-compatible", null);
  await buf.newSession();
  const deltas: string[] = [];
  await runStreamedTurn({ showPending() {}, paint: async () => {}, call: (onToken) => buf.reply({ text: "x", events: [], sentAt: Date.now(), shownAt: Date.now() }, onToken), onFirstToken: (x) => deltas.push(x), onText: (x) => deltas.push(x) });
  assert.deepEqual(deltas, ["Buffered reply?"]);
});
