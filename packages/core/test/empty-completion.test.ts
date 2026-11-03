// P0 Nov 3 2026, part (b): an empty completion (finish_reason "stop", no content, 0 completion tokens) is an error:
// retried once in the same turn; empty again -> truncated director_turn {error:"empty_completion"} and the turn fails
// (the app's existing error state). No canned text. Applies to every turn; a failed turn consumes its number like any
// failed turn (schema doc: user_turn k -> director_turn k+1). Also a 200 with an empty body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessSession, MemoryHarnessStorage, SpiderCloudBackend, type LogEvent } from "../src/browser.ts";

/** the live Worker bytes for the empty opener (HAR, Nov 2 11:58 PM PT; id/created as captured) */
const LIVE_EMPTY = 'data: {"id":"chatcmpl-122ab434e1a8da7e","object":"chat.completion.chunk","created":1793692703,"model":"gpt-oss:20b-cloud","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-122ab434e1a8da7e","object":"chat.completion.chunk","created":1793692703,"model":"gpt-oss:20b-cloud","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"id":"chatcmpl-122ab434e1a8da7e","object":"chat.completion.chunk","created":1793692703,"model":"gpt-oss:20b-cloud","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\ndata: [DONE]\n\n';
const ok = (text: string) => {
  const b = { id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-oss:20b-cloud" };
  const e = (d: object, f: string | null = null) => `data: ${JSON.stringify({ ...b, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
  return e({ role: "assistant", content: "" }) + e({ reasoning_content: "think" }) + e({ content: text }) + e({}, "stop") + `data: ${JSON.stringify({ ...b, choices: [], usage: { prompt_tokens: 340, completion_tokens: 40, total_tokens: 380 } })}\n\n` + "data: [DONE]\n\n";
};
const resp = (s: string) => new Response(s, { headers: { "content-type": "text/event-stream" } });
type DT = Extract<LogEvent, { type: "director_turn" }>;
const turns = (st: MemoryHarnessStorage, id: string) => st.readSession(id).filter((e) => e.type === "director_turn") as DT[];
function spider(plan: string[]) {
  const bodies: Array<{ messages: unknown[] }> = [];
  const fetchImpl = (async (_u: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); const p = plan.shift() ?? "Fine, and you?"; return p === "BLANK_SSE" ? resp("") : p === "BLANK_JSON" ? new Response("", { headers: { "content-type": "application/json" } }) : resp(p === "EMPTY" ? LIVE_EMPTY : ok(p)); }) as unknown as typeof fetch;
  return { be: new SpiderCloudBackend({ token: "bhd_test_token_000000", model: "gpt-oss:20b-cloud", fetchImpl }), bodies };
}

test("opener: the live empty completion is retried once with the identical request, then the real reply is used", async () => {
  const { be, bodies } = spider(["EMPTY", "Hi! What have you been into lately?"]);
  const store = new MemoryHarnessStorage();
  const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store });
  const shown: string[] = [];
  const d = await s.start({ onToken: (x) => shown.push(x) });
  assert.equal(d.text, "Hi! What have you been into lately?");
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1], "the retry resends the same request");
  const [t0] = turns(store, s.id);
  assert.equal(t0!.turn, 0); assert.equal(t0!.empty_retries, 1); assert.equal(typeof t0!.empty_retry_ms, "number");
  assert.equal(t0!.error, undefined); assert.equal(t0!.truncated, false);
  assert.ok(t0!.genMs >= t0!.empty_retry_ms!, "genMs includes the empty first attempt");
  const r = await s.reply("I bake bread", [], undefined, { onToken: () => {} });
  assert.equal(r.director.text, "Fine, and you?");
  const t = turns(store, s.id);
  assert.deepEqual(t.map((x) => x.turn), [0, 1]); assert.deepEqual(t.map((x) => x.empty_retries), [1, 0]); assert.equal(t[1]!.empty_retry_ms, null);
});

test("empty twice: truncated director_turn {text:'', error:'empty_completion'}, the turn fails, no canned text", async () => {
  const { be, bodies } = spider(["EMPTY", "EMPTY"]);
  const store = new MemoryHarnessStorage();
  const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store });
  await assert.rejects(s.start({ onToken: () => {} }), (e: Error & { code?: string }) => e.code === "empty_completion");
  assert.equal(bodies.length, 2, "one retry only");
  const t = turns(store, s.id);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.text, ""); assert.equal(t[0]!.truncated, true); assert.equal(t[0]!.error, "empty_completion");
  assert.equal(t[0]!.finish_reason, "stop"); assert.equal(t[0]!.usage!.completion_tokens, 0); assert.equal(t[0]!.empty_retries, 1);
});

test("mid-session empty twice: the turn fails, consumes its number (u0 -> d1 error, u1 -> d2), transcript untouched", async () => {
  const { be, bodies } = spider(["Hello?", "EMPTY", "EMPTY", "Tell me more?"]);
  const store = new MemoryHarnessStorage();
  const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store });
  await s.start({ onToken: () => {} });
  await assert.rejects(s.reply("first", [], undefined, { onToken: () => {} }), /empty/);
  await s.reply("second", [], undefined, { onToken: () => {} });
  const t = turns(store, s.id);
  assert.deepEqual(t.map((x) => [x.turn, x.error ?? null]), [[0, null], [1, "empty_completion"], [2, null]]);
  assert.deepEqual(store.readSession(s.id).filter((e) => e.type === "user_turn").map((e) => (e as { turn: number }).turn), [0, 1]);
  const last = bodies.at(-1)!.messages as Array<{ role: string; content: string }>;
  assert.ok(!last.some((m) => m.role === "assistant" && m.content === ""), "an empty reply never enters the transcript");
});

test("not empty: content, a length cut-off, or completion tokens > 0 are never retried", async () => {
  for (const g of [{ text: "Hi?", finishReason: "stop" }, { text: "", finishReason: "length", usage: { outputTokens: 2048 } }, { text: "", finishReason: "stop", usage: { outputTokens: 5 } }]) {
    let n = 0;
    const s = new HarnessSession({ userId: "u", backend: { id: "x", paid: false, generate: async () => { n++; return g; } }, seed: 1, store: new MemoryHarnessStorage() });
    await s.start();
    assert.equal(n, 1, JSON.stringify(g));
  }
});

test("director_turn keys are identical across arms with and without a retry (parity)", async () => {
  const keys: string[] = [];
  for (const adaptation of ["adaptive", "baseline"] as const) for (const plan of [["Hi?", "Ok?"], ["EMPTY", "Hi?", "Ok?"]]) {
    const { be } = spider([...plan]);
    const store = new MemoryHarnessStorage();
    const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store, adaptation, study: { id: "phaseD", index: 1, total: 10, scheduleHash: "a".repeat(64), protocol: 3 } });
    await s.start({ onToken: () => {} });
    await s.reply("bread", [], undefined, { onToken: () => {} });
    for (const t of turns(store, s.id)) keys.push(Object.keys(t).filter((k) => k !== "firstTokenMs" && k !== "streamed").sort().join(","));
    assert.ok(!/adaptive|baseline/.test(JSON.stringify(turns(store, s.id))));
  }
  assert.equal(new Set(keys).size, 1, [...new Set(keys)].join("\n"));
});

test("a 200 with an empty body (SSE or JSON) is an empty completion: retried once, then error code empty_completion", async () => {
  for (const blank of ["BLANK_SSE", "BLANK_JSON"]) {
    const a = spider([blank, "Hi! What are you up to?"]);
    const s1 = new HarnessSession({ userId: "u", backend: a.be, seed: 1, store: new MemoryHarnessStorage() });
    assert.equal((await s1.start({ onToken: () => {} })).text, "Hi! What are you up to?", blank);
    assert.equal(a.bodies.length, 2, blank);
    const b = spider([blank, blank]);
    const store = new MemoryHarnessStorage();
    const s2 = new HarnessSession({ userId: "u", backend: b.be, seed: 1, store, adaptation: "baseline", study: { id: "phaseD", index: 1, total: 10, scheduleHash: "a".repeat(64), protocol: 3 } });
    await assert.rejects(s2.start({ onToken: () => {} }), (e: Error & { code?: string }) => e.code === "empty_completion");
    const [t] = turns(store, s2.id);
    assert.equal(t!.error, "empty_completion", blank); assert.equal(typeof t!.error, "string");
    assert.equal(t!.text, ""); assert.equal(t!.truncated, true); assert.equal(t!.empty_retries, 1);
    assert.equal(t!.usage!.prompt_tokens, null, "study: prompt_tokens stays null on the error turn too");
  }
});
