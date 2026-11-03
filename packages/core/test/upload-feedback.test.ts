// UploadQueue kind "feedback" (POST /v1/feedback, brianharness-worker docs/FEEDBACK.md). Session / study_start
// uploads are unchanged: same URL, same body bytes, same pause rules, same summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, UploadQueue, buildFeedbackReport, FEEDBACK_UPLOAD_MAX_BYTES, type ExportFile, type FeedbackReport } from "../src/browser.js";

const meta = { appVersion: "0.4.0", platform: "test", build: "7" };
const errBody = (code: string, extra: Record<string, unknown> = {}) => ({ error: { type: "invalid_request_error", code, message: code, permanent: true, ...extra } });
type Reply = [number, unknown?, Record<string, string>?];
function server(route: (url: string, n: number) => Reply) {
  const seen: Array<{ url: string; auth: string; body: string }> = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), auth: String((init.headers as Record<string, string>).authorization), body: String(init.body) });
    const [status, json, headers] = route(String(url), seen.length);
    return new Response(JSON.stringify(json ?? (status === 201 ? { id: "x", received_at: "2026-11-03T08:00:00Z" } : errBody("e"))), { status, headers });
  }) as unknown as typeof fetch;
  return { f, seen };
}
function queue(f: typeof fetch, clock = { t: 1_000_000 }) {
  return { q: new UploadQueue(new MemoryKV(), { meta, fetchImpl: f, autoSchedule: false, now: () => clock.t, target: async () => ({ url: "http://w/v1/sessions", token: "bhd_test" }) }), clock };
}
const report = (note = "it broke"): FeedbackReport => buildFeedbackReport({ events: [{ ts: 1, type: "tap", data: { name: "Send" } }], chatTurns: [], header: { note, platform: "ios-phone" } });
const sessionFile: ExportFile = { name: "bh-session-1-x.jsonl", content: `${JSON.stringify({ type: "session_start", t: "2026-11-03T00:00:00Z", sessionId: "s1", study: { index: 1, total: 10 } })}\n` };

test("feedback: POST /v1/feedback with the device token, body = the report bytes; 201 done; counted apart from logs", async () => {
  const { f, seen } = server(() => [201]);
  const { q } = queue(f);
  const r = report();
  const it = await q.enqueueFeedback(r, "bh-feedback-x.json");
  assert.equal(it!.kind, "feedback"); assert.equal(it!.id, r.report_id); assert.equal(it!.state, "pending");
  const s = await q.flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "http://w/v1/feedback"); assert.equal(seen[0]!.auth, "Bearer bhd_test");
  assert.equal(seen[0]!.body, JSON.stringify(r), "exact bytes; no queue fields added");
  assert.equal((await q.item(r.report_id))!.state, "done");
  assert.deepEqual([s.pending, s.needsExport, s.done, s.items.length], [0, 0, 0, 0], "study-log counts exclude feedback");
  assert.deepEqual(s.feedback, { pending: 0, needsExport: 0, done: 1 });
  assert.equal(await q.enqueueFeedback(r), null, "same report_id: not queued twice");
});

test("feedback: an explicit feedbackUrl is used; 409 report_exists (with received_at, same_content) = done", async () => {
  const { f, seen } = server(() => [409, { ...errBody("report_exists"), id: "x", received_at: "t", same_content: true }]);
  const q = new UploadQueue(new MemoryKV(), { meta, fetchImpl: f, autoSchedule: false, target: async () => ({ url: "http://w/v1/sessions", feedbackUrl: "http://fb/v1/feedback", token: "bhd_test" }) });
  const r = report();
  await q.enqueueFeedback(r);
  await q.flush();
  assert.equal(seen[0]!.url, "http://fb/v1/feedback");
  assert.equal((await q.item(r.report_id))!.state, "done");
});

for (const [status, code] of [[404, "not_found"], [400, "invalid_feedback"], [413, "feedback_too_large"], [422, "invalid_feedback_envelope"], [422, "upload_rejected"], [403, "insufficient_scope"], [409, "session_exists"]] as const) {
  test(`feedback: ${status} ${code} is permanent -> needs-export, body dropped, never retried`, async () => {
    const { f, seen } = server(() => [status, errBody(code, code === "invalid_feedback_envelope" ? { field: "report_id" } : code === "upload_rejected" ? { reason: "secret:bhd_token" } : {})]);
    const { q, clock } = queue(f);
    const r = report();
    await q.enqueueFeedback(r);
    await q.flush();
    const it = await q.item(r.report_id);
    assert.equal(it!.state, "needs-export"); assert.equal(it!.lastStatus, status);
    clock.t += 86_400_000;
    await q.flush(); await q.flush({ force: true });
    assert.equal(seen.length, 1, "no loop");
    const s = await q.summary();
    assert.equal(s.needsExport, 0, "the study logs' Export prompt is not raised by a report"); assert.deepEqual(s.feedback, { pending: 0, needsExport: 1, done: 0 });
  });
}

test("feedback: 429 waits Retry-After (next UTC midnight) for that report only; session uploads keep going", async () => {
  const midnight = 9 * 3600; // seconds
  const { f, seen } = server((url) => (url.endsWith("/v1/feedback") ? [429, { error: { code: "feedback_daily_cap_device", permanent: false, limit: 20, used: 20, reset_at: "2026-11-04T00:00:00Z" } }, { "retry-after": String(midnight) }] : [201]));
  const { q, clock } = queue(f);
  const r = report();
  await q.enqueueFeedback(r);
  await q.flush();
  assert.equal((await q.item(r.report_id))!.state, "pending");
  await q.enqueueSession(sessionFile);
  const s = await q.flush();
  assert.equal(s.pausedUntil, undefined, "no global pause"); assert.equal(s.done, 1, "the session uploaded");
  assert.equal(seen.filter((x) => x.url.endsWith("/v1/feedback")).length, 1, "the report waited");
  clock.t += midnight * 1000 - 1000;
  await q.flush();
  assert.equal(seen.filter((x) => x.url.endsWith("/v1/feedback")).length, 1, "not before Retry-After");
  clock.t += 2000;
  await q.flush();
  assert.equal(seen.filter((x) => x.url.endsWith("/v1/feedback")).length, 2, "retried after Retry-After");
});

test("feedback: 5xx / offline stay pending with backoff (retry later, same report_id)", async () => {
  let n = 0;
  const f = (async () => { if (++n === 1) throw new TypeError("offline"); return new Response("{}", { status: 503 }); }) as unknown as typeof fetch;
  const { q } = queue(f);
  const r = report();
  await q.enqueueFeedback(r);
  await q.flush();
  assert.equal((await q.item(r.report_id))!.state, "pending");
  await q.flush({ force: true });
  assert.equal((await q.item(r.report_id))!.state, "pending");
});

test("feedback: > 256 KB or a secret in the body -> needs-export without a request", async () => {
  const { f, seen } = server(() => [201]);
  const { q } = queue(f);
  const big = { ...report(), payload: { pad: "x".repeat(FEEDBACK_UPLOAD_MAX_BYTES) } } as unknown as FeedbackReport;
  assert.equal((await q.enqueueFeedback(big))!.state, "needs-export");
  const leaky = { ...report(), report_id: "3f0c1e9a-6b1d-4c4e-9a53-2b7d8f1e0c11", payload: { t: "bhd_abcdefghijklmnopqrstuvwxyz" } } as unknown as FeedbackReport;
  assert.equal((await q.enqueueFeedback(leaky))!.state, "needs-export");
  await q.flush();
  assert.equal(seen.length, 0);
});

test("session / study_start uploads are byte-identical with feedback in the queue (URL, body, summary)", async () => {
  const run = async (withFeedback: boolean) => {
    const { f, seen } = server(() => [201]);
    const { q } = queue(f);
    await q.enqueueStudyStart({ scheduleHash: "a".repeat(64), nSessions: 10, createdAt: "2026-11-03T00:00:00Z", protocol: 3 });
    if (withFeedback) await q.enqueueFeedback(report());
    await q.enqueueSession(sessionFile);
    const s = await q.flush();
    const { feedback: _fb, ...rest } = s;
    return { posts: seen.filter((x) => x.url.endsWith("/v1/sessions")), summary: rest };
  };
  const a = await run(false), b = await run(true);
  assert.deepEqual(b.posts, a.posts);
  assert.deepEqual(b.summary, a.summary);
  assert.deepEqual(a.posts.map((p) => JSON.parse(p.body).kind), ["study_start", "session"]);
});
