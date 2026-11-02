// Real token streaming in core: incremental SSE/NDJSON parsing (split anywhere, multibyte split
// across chunks), stream:true only with onToken + a streaming fetch, mock streaming, and the
// firstTokenAt / completeAt telemetry. Fake fetch only: no network, no paid calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicFetchBackend,
  HarnessHost,
  HarnessSession,
  MemoryHarnessStorage,
  MockBackend,
  OllamaBackend,
  OpenAICompatibleBackend,
  createChatStreamParser,
  readChatStream,
  type LogEvent,
} from "../src/browser.ts";

const enc = new TextEncoder();

/** A streaming Response whose body yields exactly these byte chunks. */
function streamResponse(chunks: Array<string | Uint8Array>, contentType = "text/event-stream", status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": contentType } });
}
/** split a string into n-char pieces (cuts lines, JSON and "data:" prefixes anywhere) */
const pieces = (s: string, n: number) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, i * n + n));

const OPENAI_SSE =
  ['{"choices":[{"delta":{"role":"assistant"}}]}', '{"choices":[{"delta":{"content":"Hel"}}]}', '{"choices":[{"delta":{"content":"lo the"}}]}', '{"choices":[{"delta":{"content":"re?"}}]}']
    .map((d) => `data: ${d}\n\n`)
    .join("") + "data: [DONE]\n\n";
const ANTHROPIC_SSE = [
  ["message_start", '{"type":"message_start","message":{"usage":{"input_tokens":12}}}'],
  ["content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'],
  ["content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Watch "}}'],
  ["content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"springs?"}}'],
  ["message_delta", '{"type":"message_delta","usage":{"output_tokens":5}}'],
  ["message_stop", '{"type":"message_stop"}'],
]
  .map(([e, d]) => `event: ${e}\ndata: ${d}\n\n`)
  .join("");
const OLLAMA_NDJSON = ['{"message":{"content":"Tell "},"done":false}', '{"message":{"content":"me "},"done":false}', '{"message":{"content":"more."},"done":false}', '{"message":{"content":""},"done":true,"eval_count":3}']
  .map((l) => l + "\n")
  .join("");

test("stream parser: multi-chunk SSE split mid-line (every split size) emits each delta once", () => {
  for (const n of [1, 2, 3, 7, 13, 50, 10_000]) {
    const deltas: string[] = [];
    const p = createChatStreamParser((d) => deltas.push(d), "text/event-stream");
    for (const c of pieces(OPENAI_SSE, n)) p.push(c);
    const out = p.finish();
    assert.equal(out.text, "Hello there?", `split ${n}`);
    assert.deepEqual(deltas, ["Hel", "lo the", "re?"], `split ${n}`);

    const ad: string[] = [];
    const pa = createChatStreamParser((d) => ad.push(d), "text/event-stream");
    for (const c of pieces(ANTHROPIC_SSE, n)) pa.push(c);
    const a = pa.finish();
    assert.equal(a.text, "Watch springs?");
    assert.deepEqual(ad, ["Watch ", "springs?"]);
    assert.deepEqual(a.usage, { inputTokens: 12, outputTokens: 5 });

    const od: string[] = [];
    const po = createChatStreamParser((d) => od.push(d), "application/x-ndjson");
    for (const c of pieces(OLLAMA_NDJSON, n)) po.push(c);
    assert.equal(po.finish().text, "Tell me more.");
    assert.deepEqual(od, ["Tell ", "me ", "more."]);
  }
});

test("stream parser: CRLF, no trailing newline, error events, plain JSON fallback", () => {
  const d: string[] = [];
  const p = createChatStreamParser((x) => d.push(x));
  p.push('data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"b"}}]}');
  assert.equal(p.finish().text, "ab");
  assert.deepEqual(d, ["a", "b"]);

  const e = createChatStreamParser(() => {});
  assert.throws(() => e.push('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n'), /model error/);

  // server ignored stream:true and sent pretty-printed JSON
  const j: string[] = [];
  const pj = createChatStreamParser((x) => j.push(x), "application/json");
  for (const c of pieces('{\n  "choices": [\n    {"message": {"content": "whole reply"}}\n  ]\n}\n', 5)) pj.push(c);
  assert.equal(pj.finish().text, "whole reply");
  assert.deepEqual(j, ["whole reply"]);
});

test("readChatStream: multibyte characters split across byte chunks decode correctly", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"café 🎻 naïve"}}]}\n\ndata: {"choices":[{"delta":{"content":" 日本"}}]}\n\n';
  const bytes = enc.encode(sse);
  // 1-byte chunks: every multibyte sequence (é = 2 bytes, 🎻 = 4, 日 = 3) is split
  const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
  const deltas: string[] = [];
  const out = await readChatStream(streamResponse(chunks), "t", (x) => deltas.push(x));
  assert.equal(out.text, "café 🎻 naïve 日本");
  assert.deepEqual(deltas, ["café 🎻 naïve", " 日本"]);
  assert.ok(!out.text.includes("\uFFFD"));
});

test("readChatStream: no body (buffered fetch) -> text() fallback as one delta; HTTP error throws", async () => {
  const buffered = { ok: true, status: 200, headers: new Headers(), body: null, text: async () => OPENAI_SSE } as unknown as Response;
  const d: string[] = [];
  assert.equal((await readChatStream(buffered, "t", (x) => d.push(x))).text, "Hello there?");
  assert.deepEqual(d, ["Hel", "lo the", "re?"]);
  await assert.rejects(readChatStream(new Response("nope", { status: 401 }), "openai", () => {}), /openai 401: nope/);
});

const req = (onToken?: (d: string) => void) => ({
  messages: [{ role: "user" as const, content: "hi" }],
  plan: { turn: 0, mode: "explore" as const, topic: "open", style: "open", reason: "" },
  stateNote: "",
  onToken,
});

test("every fetch backend streams with onToken (stream:true) and stays buffered without it", async () => {
  const cases: Array<{ name: string; make: (f: typeof fetch, streaming?: boolean) => { generate: OpenAICompatibleBackend["generate"] }; body: string; ct: string; want: string; deltas: string[] }> = [
    { name: "ollama", make: (f, s) => new OllamaBackend({ model: "m", baseUrl: "http://127.0.0.1:1", fetchImpl: f, streaming: s }), body: OLLAMA_NDJSON, ct: "application/x-ndjson", want: "Tell me more.", deltas: ["Tell ", "me ", "more."] },
    { name: "ollama-cloud", make: (f, s) => new OllamaBackend({ model: "gemma4:cloud", baseUrl: "http://127.0.0.1:1", apiKey: "k", cloudProvider: true, fetchImpl: f, streaming: s }), body: OLLAMA_NDJSON, ct: "application/x-ndjson", want: "Tell me more.", deltas: ["Tell ", "me ", "more."] },
    { name: "openai-compatible", make: (f, s) => new OpenAICompatibleBackend({ baseUrl: "http://127.0.0.1:1/v1", model: "m", fetchImpl: f, streaming: s }), body: OPENAI_SSE, ct: "text/event-stream", want: "Hello there?", deltas: ["Hel", "lo the", "re?"] },
    { name: "openai", make: (f, s) => new OpenAICompatibleBackend({ baseUrl: "http://127.0.0.1:1/v1", model: "gpt", apiKey: "k", paid: true, fetchImpl: f, streaming: s }), body: OPENAI_SSE, ct: "text/event-stream", want: "Hello there?", deltas: ["Hel", "lo the", "re?"] },
    { name: "anthropic", make: (f, s) => new AnthropicFetchBackend({ apiKey: "k", model: "c", baseUrl: "http://127.0.0.1:1", fetchImpl: f, streaming: s }), body: ANTHROPIC_SSE, ct: "text/event-stream", want: "Watch springs?", deltas: ["Watch ", "springs?"] },
  ];
  for (const c of cases) {
    const sent: Array<{ stream: unknown }> = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      sent.push(b);
      return b.stream ? streamResponse(pieces(c.body, 9), c.ct) : new Response(c.body, { headers: { "content-type": c.ct } });
    }) as typeof fetch;
    const deltas: string[] = [];
    assert.equal((await c.make(f).generate(req((d) => deltas.push(d)))).text, c.want, c.name);
    assert.deepEqual(deltas, c.deltas, c.name);
    assert.equal(sent.at(-1)!.stream, true, `${c.name} streams with onToken`);

    assert.equal((await c.make(f).generate(req())).text, c.want, `${c.name} buffered`);
    assert.equal(sent.at(-1)!.stream, false, `${c.name} stream:false without onToken`);

    const none: string[] = [];
    assert.equal((await c.make(f, false).generate(req((d) => none.push(d)))).text, c.want, `${c.name} streaming:false`);
    assert.equal(sent.at(-1)!.stream, false, `${c.name}: non-streaming fetch keeps stream:false even with onToken`);
    assert.deepEqual(none, [], "the backend itself emits nothing; HarnessSession sends the whole text once");
  }
});

test("mock backend streams word by word with a delay; text identical to the buffered path", async () => {
  const buffered = await new MockBackend(7).generate(req());
  const deltas: Array<[string, number]> = [];
  const t0 = Date.now();
  const streamed = await new MockBackend(7, { tokenDelayMs: 5 }).generate(req((d) => deltas.push([d, Date.now() - t0])));
  assert.equal(streamed.text, buffered.text);
  assert.equal(deltas.map(([d]) => d).join(""), buffered.text);
  assert.ok(deltas.length >= 3);
  assert.ok(deltas.at(-1)![1] >= 5 * (deltas.length - 1), "delayed between words");
});

test("telemetry: firstTokenAt + completeAt in the turn log; features start at completeAt", async () => {
  const store = new MemoryHarnessStorage();
  const host = new HarnessHost({ userId: "u", backend: async () => new MockBackend(3, { tokenDelayMs: 1 }), storage: store, seed: () => 1 });
  const opener: string[] = [];
  const s0 = await host.newSession({ onToken: (d) => opener.push(d) });
  assert.equal(opener.join(""), s0.director.text);
  assert.ok(opener.length > 1, "opener streamed");
  assert.equal(typeof s0.director.firstTokenMs, "number");

  // renderer: first token on screen at 1000, message complete at 1600, first key at 2100
  const first = 1_000, complete = 1_600;
  const events = [
    { t: 2_100, kind: "insert" as const, len: 1 },
    { t: 2_300, kind: "insert" as const, len: 2 },
  ];
  const tokens: string[] = [];
  const r = await host.reply({ text: "ok", events, sentAt: 2_500, shownAt: complete, firstTokenAt: first }, { onToken: (d) => tokens.push(d) });
  assert.equal(tokens.join(""), r.director.text);
  const log = store.readSession(s0.sessionId);
  const turn = log.find((e) => e.type === "user_turn") as Extract<LogEvent, { type: "user_turn" }>;
  assert.deepEqual(turn.prompt, { firstTokenAt: first, completeAt: complete });
  assert.equal(turn.features["typing.replyLatencyMs"], 2_100 - complete, "latency clock starts at completeAt, not the first token");
  const d = log.filter((e) => e.type === "director_turn") as Array<Extract<LogEvent, { type: "director_turn" }>>;
  assert.ok(d.every((x) => x.streamed === true && typeof x.firstTokenMs === "number" && x.firstTokenMs <= x.genMs));
});

test("session without onToken (sim path) is unchanged; non-streaming backend sends the whole text once", async () => {
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(5), seed: 1, clock: () => 42 });
  const d = await s.start();
  assert.equal(d.firstTokenMs, undefined);
  const once: string[] = [];
  const plain = { id: "plain", paid: false, generate: async () => ({ text: "Whole reply?" }) };
  const s2 = new HarnessSession({ userId: "u", backend: plain, seed: 1 });
  await s2.start({ onToken: (x) => once.push(x) });
  assert.deepEqual(once, ["Whole reply?"]);
});
