// Researcher blinding check on 841f900..b413996 (Nov 3 2026):
//  1. usage.prompt_tokens leaks the study arm (the prompt includes the state note: adaptive ~4-7 lines, baseline ~2):
//     study (sealed) director_turns log prompt_tokens: null (key kept); practice keeps the value.
//  2. turn numbering around a failed Director turn: the number is consumed, user_turn k -> director_turn k+1 always.
//  3. a turn that fails before the first token logs director_turn {text:"", truncated:true, finish_reason:null, error}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessSession, MemoryHarnessStorage, SpiderCloudBackend, type LogEvent } from "../src/browser.ts";

type DT = Extract<LogEvent, { type: "director_turn" }>;
const STUDY = { id: "phaseD", index: 1, total: 10, scheduleHash: "a".repeat(64), protocol: 3 };
const dts = (s: MemoryHarnessStorage, id: string) => s.readSession(id).filter((e) => e.type === "director_turn") as DT[];
const enc = new TextEncoder();
const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-oss:20b-cloud" };
const ev = (delta: Record<string, unknown>, fin: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
/** prompt_tokens = the real prompt size (chars / 4), like a provider would report: it differs by arm */
const okSse = (promptChars: number) => ev({ role: "assistant", content: "" }) + ev({ content: "Tell me more?" }) + ev({}, "stop") +
  `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: Math.round(promptChars / 4), completion_tokens: 7, total_tokens: 0 } })}\n\n` + "data: [DONE]\n\n";
const sse = (s: string) => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(s)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
const promptChars = (init: RequestInit) => (JSON.parse(String(init.body)).messages as Array<{ content: string }>).reduce((a, m) => a + m.content.length, 0);

async function run(adaptation: "adaptive" | "baseline", study: boolean) {
  const store = new MemoryHarnessStorage();
  const sizes: number[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => { const n = promptChars(init); sizes.push(n); return sse(okSse(n)); }) as unknown as typeof fetch;
  const s = new HarnessSession({ userId: "u", backend: new SpiderCloudBackend({ token: "bhd_test_token_000000", model: "gpt-oss:20b-cloud", fetchImpl }), seed: 3, store, adaptation, ...(study ? { study: STUDY } : {}) });
  await s.start({ onToken: () => {} });
  for (const t of ["I bake sourdough on weekends.", "Mostly rye.", "The crust is the best part."]) await s.reply(t, [], undefined, { onToken: () => {} });
  return { turns: dts(store, s.id), sizes, raw: store.readSession(s.id) };
}

test("study session: director_turn.usage.prompt_tokens === null in BOTH arms (key kept); completion_tokens kept", async () => {
  const sizes: Record<string, number[]> = {};
  for (const arm of ["adaptive", "baseline"] as const) {
    const r = await run(arm, true);
    sizes[arm] = r.sizes;
    assert.equal(r.turns.length, 4);
    for (const t of r.turns) {
      assert.ok(t.usage && "prompt_tokens" in t.usage, "key kept");
      assert.equal(t.usage!.prompt_tokens, null, `${arm} turn ${t.turn}`);
      assert.equal(t.usage!.completion_tokens, 7);
      assert.equal(t.sealed, true);
    }
    // nothing in the raw study log carries the prompt size (in tokens or chars)
    const raw = JSON.stringify(r.raw);
    for (const n of r.sizes) { assert.ok(!raw.includes(`:${Math.round(n / 4)},`) && !raw.includes(`:${Math.round(n / 4)}}`), `prompt token count ${Math.round(n / 4)} not in the log`); assert.ok(!raw.includes(`:${n},`) && !raw.includes(`:${n}}`)); }
  }
  // sanity: the prompts really differ by arm (this is what the null hides)
  assert.notDeepEqual(sizes.adaptive, sizes.baseline);
});

test("practice (non-study) session keeps the real prompt_tokens", async () => {
  const r = await run("adaptive", false);
  r.turns.forEach((t, i) => assert.equal(t.usage!.prompt_tokens, Math.round(r.sizes[i]! / 4)));
});

test("study: director_turn keys are identical across arms (incl. a failed turn)", async () => {
  const keys: string[] = [];
  for (const arm of ["adaptive", "baseline"] as const) {
    const store = new MemoryHarnessStorage();
    let n = 0;
    const be = { id: "spider-cloud:gpt-oss:20b-cloud", paid: true, generate: async () => { if (n++ === 1) throw Object.assign(new Error("Spider Cloud 502"), { status: 502 }); return { text: "Hi?", finishReason: "stop", maxTokens: 2048, model: "gpt-oss:20b-cloud", usage: { inputTokens: arm === "adaptive" ? 400 : 250, outputTokens: 3 } }; } };
    const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store, adaptation: arm, study: STUDY });
    await s.start();
    await assert.rejects(s.reply("hello"));
    await s.reply("again");
    const t = dts(store, s.id);
    assert.ok(t.every((x) => x.usage!.prompt_tokens === null));
    keys.push(JSON.stringify(t.map((x) => [Object.keys(x).sort(), Object.keys(x.usage!).sort()])));
  }
  assert.equal(keys[0], keys[1]);
});

test("failure before the first token: director_turn {text:'', truncated:true, finish_reason:null, error} with model + max_tokens", async () => {
  // HTTP failure from the Worker (thrown by spiderFetch before any body is read)
  let call = 0;
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    if (call++ === 1) return new Response(JSON.stringify({ error: { code: "upstream_unavailable", message: "upstream 503" } }), { status: 503, headers: { "content-type": "application/json" } });
    return sse(okSse(promptChars(init)));
  }) as unknown as typeof fetch;
  for (const study of [false, true]) {
    call = 0;
    const store = new MemoryHarnessStorage();
    const s = new HarnessSession({ userId: "u", backend: new SpiderCloudBackend({ token: "bhd_test_token_000000", model: "gpt-oss:20b-cloud", fetchImpl }), seed: 1, store, ...(study ? { study: STUDY } : {}) });
    await s.start({ onToken: () => {} });
    await assert.rejects(s.reply("ok", [], undefined, { onToken: () => {} }));
    const t = dts(store, s.id);
    assert.equal(t.length, 2);
    const f = t[1]!;
    assert.deepEqual([f.turn, f.text, f.truncated, f.finish_reason, f.model, f.max_tokens], [1, "", true, null, "gpt-oss:20b-cloud", 2048]);
    assert.equal(f.error, "upstream_unavailable");
    assert.deepEqual(f.usage, { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null });
    assert.ok(!("firstTokenMs" in f) && !("streamed" in f), "nothing was shown");
    assert.equal(typeof f.genMs, "number");
    assert.equal(study, "sealed" in f && !("plan" in f) && !("stateNote" in f));
    assert.ok(!JSON.stringify(f).includes("upstream 503"), "the error message is never logged, only the code");
    // same key set as the mid-stream error turn shape (minus firstTokenMs / streamed) and as a normal turn (+ error)
    assert.deepEqual(Object.keys(f).filter((k) => k !== "error").sort(), Object.keys(t[0]!).filter((k) => k !== "firstTokenMs" && k !== "streamed").sort());
  }
});

test("failure before the first token: error code fallbacks (aborted, http_<status>, stream_error); a 200 stream cut after the role chunk = stream_incomplete", async () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error("x"), { name: "AbortError" }), "aborted"],
    [Object.assign(new Error("bad gateway: <html>"), { status: 502 }), "http_502"],
    [new Error("fetch failed"), "stream_error"],
  ];
  for (const [err, code] of cases) {
    const store = new MemoryHarnessStorage();
    const s = new HarnessSession({ userId: "u", backend: { id: "x", paid: false, generate: async () => { throw err; } }, seed: 1, store });
    await assert.rejects(s.start({ onToken: () => {} }));
    const [t] = dts(store, s.id);
    assert.deepEqual([t!.turn, t!.text, t!.truncated, t!.finish_reason, t!.error], [0, "", true, null, code]);
  }
  const store = new MemoryHarnessStorage();
  const fetchImpl = (async () => sse(ev({ role: "assistant", content: "" }))) as unknown as typeof fetch;
  const s = new HarnessSession({ userId: "u", backend: new SpiderCloudBackend({ token: "bhd_test_token_000000", model: "gpt-oss:20b-cloud", fetchImpl }), seed: 1, store });
  await assert.rejects(s.start({ onToken: () => {} }));
  assert.deepEqual([dts(store, s.id)[0]!.error, dts(store, s.id)[0]!.text, dts(store, s.id)[0]!.max_tokens], ["stream_incomplete", "", 2048]);
});

test("turn numbering: a failed director_turn's number is consumed; user_turn k is always followed by director_turn k+1", async () => {
  for (const when of ["pre-token", "mid-stream"] as const) {
    const store = new MemoryHarnessStorage();
    let n = 0;
    const be = { id: "x", paid: false, generate: async (req: { onToken?: (d: string) => void }) => {
      if (n++ === 2) { if (when === "mid-stream") req.onToken?.("Half a "); throw Object.assign(new Error("dropped"), { code: "stream_incomplete" }); }
      req.onToken?.("Hi?"); return { text: "Hi?", finishReason: "stop" };
    } };
    const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store, study: STUDY });
    await s.start({ onToken: () => {} });
    await s.reply("one", [], undefined, { onToken: () => {} });
    await assert.rejects(s.reply("two", [], undefined, { onToken: () => {} })); // director_turn 2 fails
    await s.reply("three", [], undefined, { onToken: () => {} });
    await s.reply("four", [], undefined, { onToken: () => {} });
    const seq = store.readSession(s.id).filter((e) => e.type === "director_turn" || e.type === "user_turn").map((e) => `${e.type === "user_turn" ? "u" : "d"}${(e as { turn: number }).turn}${"error" in e ? "!" : ""}`);
    assert.deepEqual(seq, ["d0", "u0", "d1", "u1", "d2!", "u2", "d3", "u3", "d4"], when);
    // 1:1 pairing: every user_turn k is immediately followed (among turn records) by director_turn k+1
    const ev = store.readSession(s.id).filter((e) => e.type === "director_turn" || e.type === "user_turn") as Array<{ type: string; turn: number }>;
    ev.forEach((e, i) => { if (e.type === "user_turn") assert.deepEqual([ev[i + 1]!.type, ev[i + 1]!.turn], ["director_turn", e.turn + 1]); });
    const d = dts(store, s.id);
    assert.equal(new Set(d.map((x) => x.turn)).size, d.length, "director_turn numbers unique");
    assert.equal(d[2]!.text, when === "mid-stream" ? "Half a" : "");
  }
});
