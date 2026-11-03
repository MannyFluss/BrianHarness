// In-app bug report: flight recorder ring buffer, redaction (Worker-scan safe), size cap, study safety, envelope.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FlightRecorder, FLIGHT_RECORDER_CAPACITY, FEEDBACK_SCHEMA, FEEDBACK_MAX_BYTES, REDACTED, REDACTED_FIELD, UUID_RE,
  buildFeedbackReport, coarseStudy, envelopePlatform, findUploadSecret, isSecretKey, lastErrorSummary, recordPluginRejections,
  recordingBackend, redactDeep, redactString, shortErrorCode, studySafe, STUDY_ERROR_TEXT, uuidV4, type FlightEvent, type ModelBackend,
} from "../src/browser.js";

const req = { messages: [], plan: { mode: "explore", topic: "x", style: "y" } as never, stateNote: "note" };

test("ring buffer keeps the newest 200 events, oldest first; record never throws", () => {
  let t = 0;
  const r = new FlightRecorder({ now: () => ++t });
  for (let i = 0; i < 250; i++) r.record("tap", { i });
  const ev = r.events();
  assert.equal(ev.length, FLIGHT_RECORDER_CAPACITY);
  assert.equal((ev[0]!.data as { i: number }).i, 50);
  assert.equal((ev.at(-1)!.data as { i: number }).i, 249);
  assert.ok(ev.every((e, i) => i === 0 || e.ts > ev[i - 1]!.ts));
  ev.length = 0; assert.equal(r.events().length, 200, "events() is a copy");
  const cyc: Record<string, unknown> = {}; cyc.self = cyc;
  r.onRecord(() => { throw new Error("listener bug"); });
  assert.doesNotThrow(() => r.record("error", cyc));
  assert.equal(r.last("error")!.type, "error");
  const small = new FlightRecorder({ capacity: 3 });
  for (let i = 0; i < 5; i++) small.record("state", { i });
  assert.deepEqual(small.events().map((e) => (e.data as { i: number }).i), [2, 3, 4]);
});

test("redaction: bhd_/bhr_/sk-/Bearer/JWT/Ollama/GitHub/AWS strings and key/token/nonce/identityToken/appleUser fields", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIwMDEyMzQuYWJjIn0.c2lnbmF0dXJlX2hlcmVfMTIz";
  const s = `tok bhd_AbCdEf0123456789xyzQQ read bhr_ZZZZZZZZZZZZZZZZZZZZZZ key sk-proj-abcdefghijklmnop1234 hdr Bearer abc.def-ghi_123456 id ${jwt} ol 0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp gh ghp_abcdefghijklmnopqrstuvwxyz0123456789 aws AKIAABCDEFGHIJKLMNOP`;
  const out = redactString(s);
  for (const leak of ["bhd_AbCd", "bhr_ZZZZ", "sk-proj", "abc.def-ghi", "eyJhbGci", "0123456789abcdef0123456789abcdef.", "ghp_", "AKIA"]) assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  assert.ok(out.includes(`Bearer ${REDACTED}`));
  const d = redactDeep({ apiKey: "anything", identityToken: "x.y.z", appleUser: "000123.abc", nonce: "n-1", authorization: "Basic Zm9v", password: "hunter22",
    session_token: "s", key: "k", max_tokens: 800, prompt_tokens: 12, usage: { completion_tokens: 3 }, nested: [{ refreshToken: "r" }], ok: "plain text", n: NaN, f: () => 1 });
  assert.deepEqual(d, { apiKey: REDACTED_FIELD, identityToken: REDACTED_FIELD, appleUser: REDACTED_FIELD, nonce: REDACTED_FIELD, authorization: REDACTED_FIELD, password: REDACTED_FIELD,
    session_token: REDACTED_FIELD, key: REDACTED_FIELD, max_tokens: 800, prompt_tokens: 12, usage: { completion_tokens: 3 }, nested: [{ refreshToken: REDACTED_FIELD }], ok: "plain text", n: null });
  for (const k of ["max_tokens", "prompt_tokens", "completion_tokens", "reasoning_tokens", "tokens"]) assert.equal(isSecretKey(k), false, k);
  // generic high-entropy runs (the Worker's long_base64 / long_hex rules) and a 64-hex sha256 left alone
  const b64 = "Q2hhcmxpZTEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejk4NzY1NDMyMQ";
  const sha = "a".repeat(32) + "b".repeat(32);
  assert.equal(redactString(`x ${b64} y`), `x ${REDACTED} y`);
  assert.equal(redactString(`h ${"0123456789abcdef".repeat(3)}`), `h ${REDACTED}`);
  assert.equal(redactString(`sha ${sha}`), `sha ${sha}`);
});

test("a report with secrets everywhere passes the client pre-check (findUploadSecret = the Worker's secret rules)", () => {
  const events: FlightEvent[] = [
    { ts: 1, type: "error", data: { source: "native", message: "auth failed for Bearer eyJabcdefghijk.eyJabcdefghijk.abcdefghijk1", identityToken: "eyJ.long.token", password: "correct horse battery" } },
    { ts: 2, type: "screen", data: { controls: [{ label: "API key", value: "sk-ant-abcdefghijklmnop1234567" }], notices: ["token bhd_abcdefghijklmnopqrstuvwxyz"] } },
  ];
  const r = buildFeedbackReport({ events, chatTurns: [{ role: "user", text: "my key is sk-abcdefghijklmnop12345678" }], header: { note: "token bhd_abcdefghijklmnopqrstuvwxyz1 broke", platform: "ios-phone" } });
  const body = JSON.stringify(r);
  assert.equal(findUploadSecret(body), null);
  assert.ok(!/"(?:password|authorization|api[_-]?key|secret)"\s*:\s*"[^"]{8,}"/i.test(body), "no secret_field hit");
  assert.ok(!body.includes("bhd_abc") && !body.includes("sk-ant") && !body.includes("eyJabc"));
  assert.equal(r.summary, `token ${REDACTED} broke`);
});

test("envelope matches the Worker contract (docs/FEEDBACK.md): schema, uuid v4 report_id, kind, app strings, filters", () => {
  for (let i = 0; i < 50; i++) assert.match(uuidV4(), UUID_RE);
  const r = buildFeedbackReport({
    events: [{ ts: 5, type: "chat", data: { model: "m", truncated: true, finish_reason: "length", max_tokens: 800 } }, { ts: 6, type: "error", data: { source: "stream", code: "stream_incomplete", message: "x" } }],
    chatTurns: [], header: { build: 2031, appVersion: "0.4.0", commit: "b413996", bundleId: "com.manny.brianharness", platform: "ios-tablet", note: "a\u0001b\nc\t" + "x".repeat(600) },
  }, { now: Date.parse("2026-11-03T08:00:00Z") });
  assert.equal(r.schema, FEEDBACK_SCHEMA); assert.equal(r.kind, "bug"); assert.match(r.report_id, UUID_RE);
  assert.equal(r.payload.header.report_id, r.report_id); assert.equal(r.created_at, "2026-11-03T08:00:00.000Z");
  assert.deepEqual(r.app, { bundle_id: "com.manny.brianharness", version: "0.4.0", build: "2031", commit: "b413996" });
  assert.deepEqual(r.filters, { inStudy: false, truncated_turns: 1, last_error_code: "stream_incomplete", platform: "ios" });
  assert.equal(r.summary!.length, 500); assert.ok(r.summary!.startsWith("ab\nc\t"), "control chars dropped, newline/tab kept");
  assert.deepEqual(["ios-phone", "electron", "darwin", "web", "test", null].map(envelopePlatform), ["ios", "desktop", "desktop", "web", "web", "web"]);
  const empty = buildFeedbackReport({ events: [], chatTurns: [], header: {} });
  assert.equal("summary" in empty, false); assert.deepEqual(empty.app, {}); assert.equal("last_error_code" in empty.filters, false, "absent, never null");
  assert.ok(new TextEncoder().encode(JSON.stringify(r)).length === r.payload.header.counts.bytes);
});

test("size cap: oldest events go first, then message text; always <= 100 KB", () => {
  const big = "lorem ipsum dolor ".repeat(40);
  const events: FlightEvent[] = Array.from({ length: 200 }, (_, i) => ({ ts: i, type: "screen", data: { i, messages: [{ role: "assistant", text: big }, { role: "user", text: big }], notices: [big] } }));
  const r = buildFeedbackReport({ events, chatTurns: Array.from({ length: 10 }, () => ({ role: "assistant" as const, text: big })), header: { note: "n" } });
  const bytes = new TextEncoder().encode(JSON.stringify(r)).length;
  assert.ok(bytes <= FEEDBACK_MAX_BYTES, `${bytes}`);
  assert.equal(r.payload.chat_turns.length, 6, "last 6 turns");
  assert.ok(r.payload.events.length < 200 && r.payload.events.length > 0);
  assert.equal((r.payload.events.at(-1)!.data as { i: number }).i, 199, "newest kept");
  assert.equal(r.payload.header.counts.events_dropped, 200 - r.payload.events.length);
  // only events trimmed when that is enough: text untouched
  const mid = buildFeedbackReport({ events, chatTurns: [], header: {} }, { maxBytes: 60_000 });
  assert.equal(mid.payload.header.counts.text_cap, 500);
  assert.ok(mid.payload.events.length >= 20);
  // a tiny budget: text capped too
  const tiny = buildFeedbackReport({ events, chatTurns: [{ role: "user", text: big }], header: {} }, { maxBytes: 8_000 });
  assert.ok(new TextEncoder().encode(JSON.stringify(tiny)).length <= 8_000);
  assert.ok(tiny.payload.header.counts.text_cap < 500);
});

test("study safety: no plan / stateNote / mode / arm values; study state {inStudy,index}; prompt sizes nulled", () => {
  const events: FlightEvent[] = [
    { ts: 1, type: "chat", data: { model: "m", usage: { prompt_tokens: 1234, completion_tokens: 50, reasoning_tokens: 0 }, plan: { mode: "explore" }, stateNote: "focus garden", mode: "adaptive", prompt_chars: 999, state_note_len: 80 } },
    { ts: 2, type: "state", data: { event: "x", study: { index: 3, total: 10, mode: "baseline", arm: "adaptive" }, label: "baseline", hypothesis: "h", topTopics: [["a", 1, 1]] } },
  ];
  const r = buildFeedbackReport({ events, chatTurns: [{ role: "assistant", text: "hello" }], header: { study: { inStudy: true, index: 3 }, appState: { mode: "adaptive", hudOpen: true } } });
  const body = JSON.stringify(r);
  for (const bad of ["adaptive", "baseline", "explore", "focus garden", "1234", "999", "hypothesis", "topTopics", "stateNote", "\"mode\""]) assert.ok(!body.includes(bad), `${bad} in study report`);
  const chat = r.payload.events[0]!.data as Record<string, any>;
  assert.deepEqual(chat.usage, { prompt_tokens: null, completion_tokens: 50, reasoning_tokens: 0 });
  assert.equal(chat.prompt_chars, null); assert.equal(chat.state_note_len, null);
  assert.deepEqual((r.payload.events[1]!.data as Record<string, unknown>).study, { inStudy: true, index: 3 });
  assert.deepEqual(r.payload.header.study, { inStudy: true, index: 3 });
  assert.equal(r.filters.inStudy, true);
  // outside a study the same data is kept (it's a debugging report)
  const p = buildFeedbackReport({ events, chatTurns: [], header: {} });
  assert.equal((p.payload.events[0]!.data as any).usage.prompt_tokens, 1234);
  assert.deepEqual(coarseStudy({ index: 4, total: 10 } as never), { inStudy: true, index: 4 });
  assert.deepEqual(coarseStudy(null), { inStudy: false, index: null });
  assert.equal(studySafe("relax"), "[omitted]");
});

test("recordingBackend: one chat event per generate with the P0 fields; errors -> chat + error events, rethrown", async () => {
  const rec = new FlightRecorder();
  const ok: ModelBackend = { id: "spider-cloud:gpt-oss", paid: true, generate: async (q) => { q.onToken?.("Hel"); q.onToken?.("lo"); return { text: "Hello", finishReason: "length", maxTokens: 800, model: "gpt-oss:20b", usage: { inputTokens: 900, outputTokens: 800, reasoningTokens: 120 } }; } };
  const wrapped = recordingBackend(ok, rec);
  assert.equal(wrapped.id, ok.id); assert.equal(wrapped.paid, true);
  const toks: string[] = [];
  const g = await wrapped.generate({ ...req, onToken: (d) => toks.push(d) });
  assert.equal(g.text, "Hello"); assert.deepEqual(toks, ["Hel", "lo"], "reply untouched");
  const c = rec.last("chat")!.data as Record<string, any>;
  assert.equal(c.model, "gpt-oss:20b"); assert.equal(c.max_tokens, 800); assert.equal(c.status, 200); assert.equal(c.finish_reason, "length");
  assert.deepEqual(c.usage, { prompt_tokens: 900, completion_tokens: 800, reasoning_tokens: 120 }); assert.equal(c.truncated, true); assert.equal(c.error, null);
  assert.equal(typeof c.ms, "number");
  const bad: ModelBackend = { id: "spider-cloud:m", paid: true, generate: async (q) => { q.onToken?.("part"); throw Object.assign(new Error("stream ended early (Bearer abcdefghijklmnop)"), { code: "stream_incomplete", maxTokens: 800, model: "m", status: 200 }); } };
  await assert.rejects(recordingBackend(bad, rec).generate({ ...req, onToken: () => {} }), /stream ended early/);
  const ce = rec.last("chat")!.data as Record<string, any>;
  assert.equal(ce.error.code, "stream_incomplete"); assert.equal(ce.truncated, true, "part of it streamed"); assert.equal(ce.max_tokens, 800);
  assert.ok(!ce.error.message.includes("abcdefghijklmnop"), "redacted");
  const ee = rec.last("error")!.data as Record<string, any>;
  assert.equal(ee.source, "stream");
  assert.match(lastErrorSummary(rec.events())!, /stream_incomplete/);
  assert.equal(recordingBackend(ok, null), ok, "no recorder: the backend itself");
});

test("recordPluginRejections: native plugin rejections become error events; results and errors unchanged", async () => {
  const rec = new FlightRecorder();
  const plugin = { share: async () => { throw Object.assign(new Error("share failed"), { code: "EXPORT_ERR" }); }, ok: async (x: number) => x + 1 };
  const p = recordPluginRejections("BHExport", plugin, rec);
  assert.equal(await p.ok(1), 2);
  await assert.rejects(p.share(), /share failed/);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(rec.last("error")!.data, { source: "native", plugin: "BHExport", method: "share", code: "EXPORT_ERR", message: "share failed" });
  assert.equal(rec.events().length, 1);
});

test("study: raw error text, prompt sizes and prompt_tokens are never recorded; only the short error code (session-log rule)", async () => {
  const quoted = 'HTTP 502: {"error":{"message":"upstream body quoting the adaptive state note (7 lines, 2210 tokens)"}}';
  const rec = new FlightRecorder();
  let study = false;
  rec.setStudyProbe(() => study);
  const failing: ModelBackend = { id: "spider-cloud:m", paid: false, async generate() { throw Object.assign(new Error(quoted), { status: 502, maxTokens: 4096, model: "m" }); } };
  const ok: ModelBackend = { id: "spider-cloud:m", paid: false, async generate() { return { text: "hi", finishReason: "stop", maxTokens: 4096, model: "m", usage: { inputTokens: 2210, outputTokens: 1 } }; } };
  // practice (not study): the message is kept (redacted), prompt_tokens kept
  await assert.rejects(recordingBackend(failing, rec).generate(req));
  assert.match(JSON.stringify(rec.events()), /upstream body/);
  rec.clear();
  study = true;
  await assert.rejects(recordingBackend(failing, rec).generate(req));
  await recordingBackend(ok, rec).generate(req);
  rec.record("error", { source: "unhandledrejection", message: quoted, code: "E_X" });
  rec.record("error", { source: "window.onerror", message: quoted, where: "index.js:1:2" });
  rec.record("screen", { messages: [{ role: "user", text: "hello" }, { role: "assistant", text: `⚠ ${quoted}` }], notices: [quoted, "Reply cut off at the length limit"] });
  const stored = rec.events();
  const raw = JSON.stringify(stored);
  assert.ok(!raw.includes("upstream body") && !raw.includes("2210") && !raw.includes("adaptive"), raw);
  const [chatErr, errEv, chatOk] = stored;
  assert.deepEqual((chatErr!.data as any).error, { code: "http_502" }, "http_<status> fallback, like director_turn.error");
  assert.deepEqual(errEv!.data, { source: "stream", code: "http_502", status: 502, partial: false });
  assert.equal((chatOk!.data as any).usage.prompt_tokens, null);
  assert.equal((chatOk!.data as any).usage.completion_tokens, 1);
  assert.deepEqual(stored[3]!.data, { source: "unhandledrejection", code: "E_X" });
  assert.deepEqual(stored[4]!.data, { source: "window.onerror", code: "stream_error", where: "index.js:1:2" });
  assert.deepEqual((stored[5]!.data as any).messages, [{ role: "user", text: "hello" }, { role: "assistant", text: STUDY_ERROR_TEXT }]);
  assert.deepEqual((stored[5]!.data as any).notices, ["[notice omitted]", "Reply cut off at the length limit"]);
  assert.equal(shortErrorCode({ name: "AbortError" }), "aborted");
  assert.equal(shortErrorCode({ code: "stream_incomplete", status: 500 }), "stream_incomplete");
  assert.equal(shortErrorCode(new Error("x")), "stream_error");

  // a study report built from RAW events (recorded before the flag was set) is scrubbed the same way
  const t0 = 1_793_700_000_000;
  const rawEvents: FlightEvent[] = [
    { ts: t0, type: "chat", data: { model: "m", status: 502, usage: { prompt_tokens: 2210, completion_tokens: null, reasoning_tokens: null }, state_note_chars: 812, truncated: true, error: { code: "http_502", message: quoted } } },
    { ts: t0 + 1, type: "error", data: { source: "stream", code: "http_502", message: quoted, status: 502 } },
  ];
  const r = buildFeedbackReport({ events: rawEvents, chatTurns: [{ role: "assistant", text: `⚠ ${quoted}`, error: true }], header: { note: "broke", study: { inStudy: true, index: 4 }, platform: "ios" } }, { now: t0 + 5000 });
  const body = JSON.stringify(r);
  assert.ok(!body.includes("upstream body") && !body.includes("2210") && !body.includes("812"), body);
  assert.equal(r.payload.header.last_error_summary, "error[stream] http_502 (5s ago)");
  assert.equal(r.filters.last_error_code, "http_502");
  assert.equal(r.payload.chat_turns[0]!.text, STUDY_ERROR_TEXT);
  // the same raw events outside a study keep the (redacted) message: it's the useful part of a bug report
  const p = buildFeedbackReport({ events: rawEvents, chatTurns: [], header: { study: { inStudy: false } } }, { now: t0 + 5000 });
  assert.match(JSON.stringify(p), /upstream body/);
});
