// P0 Nov 2 2026 "reply text stops partway" (build 20261102.2031, gpt-oss:20b-cloud via Spider Cloud): the app sent
// max_tokens 200; gpt-oss spent it on reasoning_content and the reply ended with finish_reason "length", silently.
// Regression: per-model max_tokens table + reasoning floor, finish_reason/usage surfaced, reasoning never rendered,
// a stream with no [DONE]/finish_reason is an error, and director_turn logs the Addendum-4 fields in every arm.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_MAX_TOKENS, DEFAULT_CHAT_MAX_TOKENS, REASONING_MIN_MAX_TOKENS, chatMaxTokens,
  HarnessSession, MemoryHarnessStorage, SpiderCloudBackend, createChatStreamParser, readChatStream, type LogEvent,
} from "../src/browser.ts";

const enc = new TextEncoder();
const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-oss:20b-cloud" };
const ev = (delta: Record<string, unknown>, fin: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
/** the Worker's exact wire format (src/sse.ts): role, reasoning_content*, content*, finish, usage, [DONE] */
function workerSse(o: { reasoning: string[]; content: string[]; finish?: string | null; usage?: boolean; done?: boolean; keepalive?: boolean; crlf?: boolean }) {
  let s = ev({ role: "assistant", content: "" });
  for (const r of o.reasoning) s += ev({ reasoning_content: r });
  if (o.keepalive) s += ": keepalive\n\n";
  for (const c of o.content) s += ev({ content: c });
  if (o.finish !== null) s += ev({}, o.finish ?? "stop");
  if (o.usage) s += `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 300, completion_tokens: o.reasoning.length + o.content.length, total_tokens: 0 } })}\n\n`;
  if (o.done !== false) s += "data: [DONE]\n\n";
  return o.crlf ? s.replace(/\n/g, "\r\n") : s;
}
/** random 1..9-byte splits of the UTF-8 bytes (cuts lines, "data:", JSON and multibyte characters) */
function byteChunks(s: string, seed = 1): Uint8Array[] {
  const b = enc.encode(s), out: Uint8Array[] = [];
  let x = seed;
  for (let i = 0; i < b.length;) { x = (x * 1103515245 + 12345) >>> 0; const n = 1 + (x % 9); out.push(b.subarray(i, i + n)); i += n; }
  return out;
}
const sseResponse = (chunks: Uint8Array[]) => new Response(new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
const REPLY = ["That ", "sounds ", "lovely — ", "café‑style ", "bread 🌊 ", "rewards ", "patience. ", "What ", "clicks ", "for you?"];

test("max_tokens table: gpt-oss 2048, gemma4 1024, unknown 2048, reasoning floor 1500 even when overridden", () => {
  assert.equal(CHAT_MAX_TOKENS["gpt-oss:20b-cloud"], 2048);
  assert.equal(CHAT_MAX_TOKENS["gpt-oss:120b-cloud"], 2048);
  assert.equal(CHAT_MAX_TOKENS["gemma4:cloud"], 1024);
  assert.equal(chatMaxTokens("gemma4:cloud"), 1024);
  assert.equal(chatMaxTokens("gpt-oss:20b-cloud"), 2048);
  assert.equal(chatMaxTokens("some-new-model"), DEFAULT_CHAT_MAX_TOKENS);
  assert.equal(chatMaxTokens("gpt-oss:20b-cloud", 200), REASONING_MIN_MAX_TOKENS, "the old 200 can never reach a reasoning model");
  assert.equal(chatMaxTokens("gpt-oss:future-cloud"), 2048);
  assert.equal(chatMaxTokens("gemma4:cloud", 300), 300, "explicit override on a non-reasoning model is honoured");
});

test("SpiderCloudBackend sends the table's max_tokens + include_usage; returns finish_reason, usage, model, maxTokens", async () => {
  for (const [model, want] of [["gpt-oss:20b-cloud", 2048], ["gpt-oss:120b-cloud", 2048], ["gemma4:cloud", 1024]] as const) {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return sseResponse(byteChunks(workerSse({ reasoning: model.startsWith("gpt-oss") ? ["think", "ing"] : [], content: REPLY, usage: true }))); }) as unknown as typeof fetch;
    const be = new SpiderCloudBackend({ token: "bhd_test_token_000000", model, fetchImpl });
    const deltas: string[] = [];
    const r = await be.generate({ messages: [{ role: "user", content: "hi" }], plan: {} as never, stateNote: "", onToken: (d) => deltas.push(d) });
    assert.equal(sent.max_tokens, want, model);
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.equal(r.finishReason, "stop"); assert.equal(r.maxTokens, want); assert.equal(r.model, model);
    assert.equal(r.usage?.inputTokens, 300);
    assert.equal(deltas.join(""), REPLY.join(""), "reasoning never reaches the reply");
  }
});

test("parser: Worker wire format under random byte splits, CRLF, keepalive; reasoning never rendered", async () => {
  for (const crlf of [false, true]) for (let seed = 1; seed <= 25; seed++) {
    const deltas: string[] = [];
    const r = await readChatStream(sseResponse(byteChunks(workerSse({ reasoning: Array(50).fill("hmm "), content: REPLY, keepalive: true, crlf, usage: true }), seed)), "t", (d) => deltas.push(d));
    assert.equal(deltas.join(""), REPLY.join(""), `seed ${seed} crlf ${crlf}`);
    assert.ok(!deltas.some((d) => d.includes("hmm")));
    assert.equal(r.finishReason, "stop");
  }
});

test("parser: the P0 stream (reasoning eats max_tokens) -> finish_reason length, partial or empty text", async () => {
  const cut = await readChatStream(sseResponse(byteChunks(workerSse({ reasoning: Array(180).fill("x "), content: REPLY.slice(0, 3), finish: "length" }))), "t", () => {});
  assert.equal(cut.finishReason, "length"); assert.equal(cut.text, REPLY.slice(0, 3).join("").trim());
  const none = await readChatStream(sseResponse(byteChunks(workerSse({ reasoning: Array(200).fill("x "), content: [], finish: "length" }))), "t", () => {});
  assert.equal(none.finishReason, "length"); assert.equal(none.text, "");
});

test("parser: finish_reason without [DONE] is complete; neither [DONE] nor finish_reason is an error", async () => {
  const ok = await readChatStream(sseResponse(byteChunks(workerSse({ reasoning: [], content: REPLY, done: false }))), "t", () => {});
  assert.equal(ok.finishReason, "stop");
  const seen: string[] = [];
  await assert.rejects(readChatStream(sseResponse(byteChunks(workerSse({ reasoning: [], content: REPLY.slice(0, 4), finish: null, done: false }))), "t", (d) => seen.push(d)), (e: Error & { code?: string }) => e.code === "stream_incomplete");
  assert.equal(seen.join(""), REPLY.slice(0, 4).join(""), "text that arrived was still delivered");
  // [DONE] without finish_reason (some servers) is complete too
  const p = createChatStreamParser(() => {}, "text/event-stream");
  p.push(workerSse({ reasoning: [], content: REPLY, finish: null }));
  assert.equal(p.finish().text, REPLY.join("").trim());
});

test("parser: Anthropic stop_reason max_tokens and Ollama done_reason length normalize to 'length'", () => {
  const a = createChatStreamParser(() => {}, "text/event-stream");
  a.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}\n\n');
  a.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n');
  assert.equal(a.finish().finishReason, "length");
  const o = createChatStreamParser(() => {}, "application/x-ndjson");
  o.push('{"message":{"content":"Hi","thinking":"no"},"done":false}\n{"message":{"content":""},"done":true,"done_reason":"length"}\n');
  const ob = o.finish();
  assert.equal(ob.finishReason, "length"); assert.equal(ob.text, "Hi");
});

type DT = Extract<LogEvent, { type: "director_turn" }>;
const turns = (s: MemoryHarnessStorage, id: string) => s.readSession(id).filter((e) => e.type === "director_turn") as DT[];

test("director_turn logs model, max_tokens, finish_reason, usage, truncated; same keys in both arms", async () => {
  const keysets: string[][] = [];
  for (const adaptation of ["adaptive", "baseline"] as const) {
    const store = new MemoryHarnessStorage();
    let n = 0;
    const be = { id: "spider-cloud:gpt-oss:20b-cloud", paid: true, generate: async () => (n++ === 0
      ? { text: "Hello there, what do you", finishReason: "length", maxTokens: 2048, model: "gpt-oss:20b-cloud", usage: { inputTokens: 300, outputTokens: 2048 } }
      : { text: "Tell me more?", finishReason: "stop", maxTokens: 2048, model: "gpt-oss:20b-cloud", usage: { inputTokens: 320, outputTokens: 90, reasoningTokens: 60 } }) };
    const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store, adaptation, study: { id: "phaseD", index: 1, total: 10, scheduleHash: "a".repeat(64), protocol: 2 } });
    const d0 = await s.start();
    assert.equal(d0.truncated, true);
    const r = await s.reply("I like bread");
    assert.equal(r.director.truncated, undefined);
    const [t0, t1] = turns(store, s.id);
    assert.equal(t0!.model, "gpt-oss:20b-cloud"); assert.equal(t0!.max_tokens, 2048); assert.equal(t0!.finish_reason, "length"); assert.equal(t0!.truncated, true);
    assert.deepEqual(t0!.usage, { prompt_tokens: 300, completion_tokens: 2048, reasoning_tokens: null });
    assert.equal(t1!.truncated, false); assert.deepEqual(t1!.usage, { prompt_tokens: 320, completion_tokens: 90, reasoning_tokens: 60 });
    keysets.push(Object.keys(t0!).sort(), Object.keys(t1!).sort());
    assert.ok(!/adaptive|baseline/.test(JSON.stringify(turns(store, s.id))), "no arm value in director_turn");
  }
  assert.ok(keysets.every((k) => JSON.stringify(k) === JSON.stringify(keysets[0])), "identical keys across arms");
});

test("mock backend: the same director_turn keys with nulls", async () => {
  const store = new MemoryHarnessStorage();
  const s = new HarnessSession({ userId: "u", backend: { id: "mock", paid: false, generate: async () => ({ text: "Hi?" }) }, seed: 1, store });
  await s.start();
  const [t] = turns(store, s.id);
  assert.equal(t!.model, "mock"); assert.equal(t!.max_tokens, null); assert.equal(t!.finish_reason, null); assert.equal(t!.truncated, false);
  assert.deepEqual(t!.usage, { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null });
});

test("stream error after partial text: director_turn {truncated:true, error} logged, turn still fails, transcript unchanged", async () => {
  const store = new MemoryHarnessStorage();
  let call = 0;
  const be = { id: "spider-cloud:gemma4:cloud", paid: true, generate: async (req: { onToken?: (d: string) => void }) => {
    if (call++ === 1) { req.onToken?.("Half a "); req.onToken?.("reply"); throw Object.assign(new Error("dropped"), { code: "stream_incomplete" }); }
    req.onToken?.("Hi there?"); return { text: "Hi there?", finishReason: "stop", maxTokens: 1024, model: "gemma4:cloud" };
  } };
  const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store });
  await s.start({ onToken: () => {} });
  await assert.rejects(s.reply("ok", [], undefined, { onToken: () => {} }), /dropped/);
  const t = turns(store, s.id);
  assert.equal(t.length, 2);
  assert.equal(t[1]!.text, "Half a reply"); assert.equal(t[1]!.truncated, true); assert.equal(t[1]!.error, "stream_incomplete");
  assert.equal(t[1]!.finish_reason, null); assert.equal(t[1]!.model, "gemma4:cloud");
  // no partial text -> nothing logged (unchanged behaviour)
  const s2 = new HarnessSession({ userId: "u", backend: { id: "x", paid: false, generate: async () => { throw new Error("offline"); } }, seed: 1, store });
  await assert.rejects(s2.start({ onToken: () => {} }));
  assert.equal(turns(store, s2.id).length, 0);
});

test("Worker error event mid-stream (upstream dropped): readable message + code, partial text was delivered", async () => {
  const seen: string[] = [];
  const sse = ev({ role: "assistant", content: "" }) + ev({ content: "Half a " }) + ev({ content: "reply" }) +
    `data: ${JSON.stringify({ error: { message: "upstream connection dropped mid-stream", type: "upstream_error", code: "upstream_incomplete" } })}\n\n` + "data: [DONE]\n\n";
  await assert.rejects(readChatStream(sseResponse(byteChunks(sse)), "t", (d) => seen.push(d)),
    (e: Error & { code?: string }) => e.code === "upstream_incomplete" && e.message === "model error: upstream connection dropped mid-stream (upstream_incomplete)");
  assert.equal(seen.join(""), "Half a reply");
});

test("Spider Cloud stream dropped by the Worker: director_turn logs the partial text with model + max_tokens, truncated, error", async () => {
  const sse = ev({ role: "assistant", content: "" }) + ev({ content: "Half a " }) + ev({ content: "reply" }) +
    `data: ${JSON.stringify({ error: { message: "upstream connection dropped mid-stream", type: "upstream_error", code: "upstream_incomplete" } })}\n\n` + "data: [DONE]\n\n";
  let call = 0;
  const fetchImpl = (async () => sseResponse(byteChunks(call++ === 0 ? workerSse({ reasoning: ["x"], content: "Hi there?", usage: true }) : sse))) as unknown as typeof fetch;
  const store = new MemoryHarnessStorage();
  const s = new HarnessSession({ userId: "u", backend: new SpiderCloudBackend({ token: "bhd_test_token_000000", model: "gpt-oss:20b-cloud", fetchImpl }), seed: 1, store });
  await s.start({ onToken: () => {} });
  await assert.rejects(s.reply("ok", [], undefined, { onToken: () => {} }), /upstream_incomplete/);
  const t = turns(store, s.id);
  assert.equal(t.length, 2);
  assert.deepEqual([t[1]!.text, t[1]!.model, t[1]!.max_tokens, t[1]!.finish_reason, t[1]!.truncated, t[1]!.error], ["Half a reply", "gpt-oss:20b-cloud", 2048, null, true, "upstream_incomplete"]);
});
