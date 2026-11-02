// Phase D freeze (E): manual reissue + reason, last-rating validity, per-session study extractor budget,
// auto-upload queue (Worker client retry rule), study_start protocol. Fake fetch only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HarnessHost, HarnessSession, LlmInterestExtractor, MemoryHarnessStorage, MemoryKV, MockBackend, StudyController, UploadQueue,
  appTaggerSpec, kvCallCounter, reissuePhrase, STUDY_EXTRACTOR_BUDGET, STUDY_PROTOCOL_VERSION, UPLOAD_BIG_BYTES, type ExportFile,
} from "../src/index.js";

const valid = { userTurns: 8, sessionRated: true };

test("manual reissue: REISSUE N + optional reason; only assigned N in 1..10; next index unchanged; schedule hash unchanged", async () => {
  const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 7 });
  const { scheduleHash } = await study.enable();
  const info = new Map<string, typeof valid>();
  for (let i = 1; i <= 3; i++) { const a = await study.assign(`s${i}`, (p) => info.get(p)!); assert.equal(a!.index, i); info.set(`s${i}`, valid); }
  assert.equal((await study.requestReissue(4, reissuePhrase(4))).ok, false, "4 not assigned yet");
  assert.equal((await study.requestReissue(0, "REISSUE 0")).ok, false);
  assert.equal((await study.requestReissue(11, "REISSUE 11")).ok, false);
  assert.equal((await study.requestReissue(2, "reissue 2")).ok, false, "phrase is exact");
  assert.equal((await study.requestReissue(2, "REISSUE 2", "x".repeat(121))).ok, false, "reason <= 120");
  assert.deepEqual(await study.requestReissue(2, " REISSUE 2 ", "  wifi   dropped mid session "), { ok: true, index: 2 });
  assert.equal((await study.status()).pendingReissue, 2);
  const a = await study.assign("s4", (p) => info.get(p)!);
  assert.equal(a!.index, 2); assert.equal(a!.reissueOf, "manual"); assert.equal(a!.manualReissue, true); assert.equal(a!.reissueReason, "wifi dropped mid session");
  assert.equal((await study.status()).pendingReissue, undefined, "consumed");
  info.set("s4", valid);
  const b = await study.assign("s5", (p) => info.get(p)!);
  assert.equal(b!.index, 4, "the schedule continues where it was"); assert.equal(b!.manualReissue, undefined); assert.equal(b!.reissueReason, undefined);
  assert.equal(await study.hash(), scheduleHash);
  // cancel
  info.set("s5", valid);
  await study.requestReissue(1, "REISSUE 1");
  await study.cancelReissue();
  assert.equal((await study.assign("s6", (p) => info.get(p)!))!.index, 5);
});

test("manual reissue is logged in session_start (reissueOf manual, manualReissue, reissueReason), never the mode", async () => {
  const storage = new MemoryHarnessStorage();
  const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 5 });
  await study.enable();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  await host.newSession();
  for (let i = 0; i < 8; i++) await host.reply({ text: `my garden ${i}` });
  await host.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2 });
  assert.equal((await study.requestReissue(1, "REISSUE 1", "fell asleep")).ok, true);
  const r = await host.newSession();
  const start = storage.readSession(r.sessionId).find((e) => e.type === "session_start") as unknown as Record<string, unknown> & { study: Record<string, unknown> };
  assert.equal(start.study.index, 1); assert.equal(start.reissueOf, "manual"); assert.equal(start.manualReissue, true); assert.equal(start.reissueReason, "fell asleep");
  assert.equal("mode" in start.study, false); assert.equal("adaptation" in start.study, false);
});

test("validity uses the LAST session-scope rating: a later dismissal (null) makes the session unrated -> auto reissue", async () => {
  // live session (HarnessSession.sessionRated)
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: new MemoryHarnessStorage(), seed: 3 });
  await s.start();
  s.logRating({ scope: "session", value: 5, shownAt: 1, answeredAt: 2 });
  assert.equal(s.sessionRated, true);
  s.logRating({ scope: "session", value: null, shownAt: 3, answeredAt: 4 });
  assert.equal(s.sessionRated, false, "last rating null");
  s.logRating({ scope: "session", value: 3, shownAt: 5, answeredAt: 6 });
  assert.equal(s.sessionRated, true);
  // host: a previous (stored) session rated 4 then dismissed is reissued
  const storage = new MemoryHarnessStorage();
  const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 5 });
  await study.enable();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  const first = await host.newSession();
  for (let i = 0; i < 8; i++) await host.reply({ text: `my garden ${i}` });
  await host.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2 });
  await host.rate({ scope: "session", value: null, shownAt: 3, answeredAt: 4 });
  const r = await host.newSession();
  const start = storage.readSession(r.sessionId).find((e) => e.type === "session_start") as unknown as Record<string, unknown> & { study: Record<string, unknown> };
  assert.equal(start.study.index, 1); assert.equal(start.reissueOf, first.sessionId);
  // and a fresh host reading the stored log agrees (sessionInfo from events)
  const host2 = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  assert.equal((host2 as unknown as { sessionInfo(id: string): { sessionRated: boolean } }).sessionInfo(first.sessionId).sessionRated, false);
});

// ---- extractor budget ----
const okBody = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ interests: [{ label: "sourdough", confidence: 0.9, turns: [1] }] }) } }] });
function fakeFetch(plan: number[] = []) {
  let n = 0;
  const f = (async () => { const st = plan[n++] ?? 200; return new Response(st === 200 ? okBody : "err", { status: st }); }) as unknown as typeof fetch;
  return { f, calls: () => n };
}
const extract = (x: LlmInterestExtractor) => (x as unknown as { extract(): Promise<unknown[]> }).extract();

test("study budget: 10 logical calls per session; the 11th is capped; retries don't consume budget; 1 retry max", async () => {
  const { f, calls } = fakeFetch([503, 200, 503, 503]);
  const x = new LlmInterestExtractor({ api: "openai", baseUrl: "http://w", apiKey: "k", fetchImpl: f, retryDelayMs: 1, budget: 10, retries: 1, httpCeiling: 20 });
  await extract(x); // 503 then 200: 1 logical, 2 HTTP
  assert.equal(x.logicalNetwork, 1); assert.equal(calls(), 2); assert.equal(x.outcome.ok, 1);
  await extract(x); // 503, 503: one retry only -> failed
  assert.equal(x.logicalNetwork, 2); assert.equal(calls(), 4); assert.equal(x.outcome.failed, 1);
  for (let i = 0; i < 8; i++) await extract(x);
  assert.equal(x.logicalNetwork, 10); assert.equal(x.outcome.capped, 0);
  await extract(x);
  assert.equal(x.outcome.capped, 1, "budget exhausted = cap_reached"); assert.equal(calls(), 12, "no HTTP for the capped call");
});

test("study HTTP ceiling: 20 attempts per session even if every call needs its retry", async () => {
  const { f, calls } = fakeFetch(Array(40).fill(503));
  const x = new LlmInterestExtractor({ api: "openai", baseUrl: "http://w", apiKey: "k", fetchImpl: f, retryDelayMs: 1, budget: 15, retries: 1, httpCeiling: 20 });
  for (let i = 0; i < 15; i++) await extract(x);
  assert.equal(calls(), 20);
});

test("a practice-heavy device (device counter exhausted) starts a study session with its full budget", async () => {
  const kv = new MemoryKV();
  const counter = kvCallCounter(kv, 50);
  for (let i = 0; i < 50; i++) assert.equal(await counter.reserve(), true);
  assert.equal(await counter.reserve(), false, "practice cap used up");
  const base = { provider: "ollama-cloud" as const, model: "gpt-oss:120b", ollamaUrl: "https://ollama.com", ollamaCloudKey: "fake", counter };
  const practice = appTaggerSpec(base).spec as unknown as Record<string, unknown>;
  const studySpec = appTaggerSpec({ ...base, study: true }).spec as unknown as Record<string, unknown>;
  assert.equal(typeof practice.reserveCall, "function");
  assert.equal(studySpec.reserveCall, undefined, "study sessions never touch the device counter");
  assert.equal(studySpec.budget, STUDY_EXTRACTOR_BUDGET); assert.equal(studySpec.retries, 1); assert.equal(studySpec.httpCeiling, 20);
  // and the study session's extractor really runs 10 calls
  const { f, calls } = fakeFetch();
  const x = new LlmInterestExtractor({ ...(studySpec as object), api: "openai", baseUrl: "http://w", fetchImpl: f, retryDelayMs: 1 } as never);
  for (let i = 0; i < 12; i++) await extract(x);
  assert.equal(calls(), 10); assert.equal(x.outcome.capped, 2);
  assert.equal(await counter.reserve(), false, "study didn't touch the practice counter either");
});

// ---- upload queue ----
async function studyFile(): Promise<ExportFile> {
  const storage = new MemoryHarnessStorage();
  const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 5 });
  await study.enable();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  const r = await host.newSession();
  for (let i = 0; i < 4; i++) await host.reply({ text: `my baseline garden ${i} — adaptive café 🌱` });
  await host.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2, blindGuess: "adaptive" });
  await host.end();
  return host.sessionFile(r.sessionId)!;
}
function server(script: Array<number | [number, Record<string, string>?, unknown?]>) {
  const seen: Array<{ url: string; auth: string; body: string }> = [];
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: String((init.headers as Record<string, string>).authorization), body: String(init.body) });
    const s = script[Math.min(i++, script.length - 1)]!;
    const [status, headers, json] = Array.isArray(s) ? s : [s];
    const body = json ?? (status === 409 ? { error: { type: "invalid_request_error", code: "session_exists", message: "dup", permanent: true } } : status === 201 ? { id: "x" } : { error: { code: "e" } });
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { f, seen };
}
const meta = { appVersion: "0.1.0", platform: "test", build: "7" };
function queue(f: typeof fetch, kv = new MemoryKV(), clock = { t: 1_000_000 }, token = { v: "bhd_test" as string | null }) {
  return { q: new UploadQueue(kv, { meta, fetchImpl: f, autoSchedule: false, now: () => clock.t, target: async () => (token.v ? { url: "http://w/v1/sessions", token: token.v } : null) }), kv, clock, token };
}

test("upload: body jsonl is byte-identical to the export file; allowlisted keys only; no secrets; no arm leak", async () => {
  const file = await studyFile();
  const { f, seen } = server([201]);
  const { q } = queue(f);
  await q.enqueueSession(file);
  const s = await q.flush();
  assert.equal(s.done, 1); assert.equal(s.pending, 0);
  const body = JSON.parse(seen[0]!.body);
  assert.equal(body.jsonl, file.content, "byte-identical");
  assert.deepEqual(Buffer.from(body.jsonl, "utf8"), Buffer.from(file.content, "utf8"));
  assert.deepEqual(Object.keys(body).sort(), ["appVersion", "build", "jsonl", "kind", "platform", "scheduleHash", "sessionId", "studyIndex"].sort());
  assert.equal(seen[0]!.auth, "Bearer bhd_test");
  // leak scan (same structured rules as the Worker / check_blinding): no adaptation key, no study.mode, no arm value under a structured key
  const free = new Set(["text", "content", "reply", "label", "labels", "title", "blindGuess", "prompt", "system", "reason", "reissueReason", "lastError", "error"]);
  const walk = (v: unknown, k = "", parent = ""): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, k, parent));
    if (v && typeof v === "object") return Object.entries(v).forEach(([kk, vv]) => { assert.notEqual(kk.toLowerCase(), "adaptation", `adaptation key in ${parent}`); if (parent === "study") assert.notEqual(kk, "mode"); walk(vv, kk, kk); });
    if (typeof v === "string" && !free.has(k)) assert.ok(!/^(adaptive|baseline)$/i.test(v), `arm value under ${k}`);
  };
  for (const line of body.jsonl.trim().split("\n")) walk(JSON.parse(line));
  assert.ok(!/bhd_|sk-[A-Za-z0-9]/.test(seen[0]!.body), "no token in the body");
});

test("upload: 409 session_exists = done; other 4xx = needs-export (no retry, body dropped); 422 kept for export", async () => {
  const file = await studyFile();
  for (const [st, want] of [[409, "done"], [400, "needs-export"], [413, "needs-export"], [422, "needs-export"], [403, "needs-export"]] as const) {
    const { f, seen } = server([[st, {}, st === 409 ? { error: { code: "session_exists", type: "invalid_request_error" } } : { error: { code: "upload_rejected", reason: "secret:x", permanent: true } }]]);
    const { q } = queue(f);
    await q.enqueueSession(file);
    const s = await q.flush();
    await q.flush({ force: true });
    assert.equal(seen.length, 1, `${st}: sent once`);
    assert.equal(want === "done" ? s.done : s.needsExport, 1, `${st}`);
  }
});

test("upload: 401 keeps the queue until the token changes; 429 honors Retry-After", async () => {
  const file = await studyFile();
  const { f, seen } = server([401, 201]);
  const { q, token } = queue(f);
  await q.enqueueSession(file);
  let s = await q.flush();
  assert.equal(s.pending, 1); assert.equal(s.blocked, "auth");
  s = await q.flush({ force: true });
  assert.equal(seen.length, 1, "same token: not resent");
  token.v = "bhd_new";
  s = await q.flush();
  assert.equal(s.done, 1); assert.equal(seen[1]!.auth, "Bearer bhd_new");

  const r = server([[429, { "retry-after": "120" }, { error: "upload_cap_device", permanent: false }], 201]);
  const z = queue(r.f);
  await z.q.enqueueSession(file);
  s = await z.q.flush();
  assert.equal(s.blocked, "rate-limited"); assert.equal(s.pending, 1);
  z.clock.t += 60_000; await z.q.flush();
  assert.equal(r.seen.length, 1, "still paused at 60 s");
  z.clock.t += 61_000; s = await z.q.flush();
  assert.equal(r.seen.length, 2); assert.equal(s.done, 1);
});

test("upload: 5xx backs off; 5 consecutive 5xx on a >500 KB log -> needs-export; small logs keep retrying", async () => {
  const small = await studyFile();
  const { f, seen } = server([503]);
  const { q, clock } = queue(f);
  await q.enqueueSession(small);
  for (let i = 0; i < 7; i++) { await q.flush(); clock.t += 31 * 60_000; }
  assert.equal(seen.length, 7); assert.equal((await q.summary()).pending, 1, "small log never gives up");
  const big: ExportFile = { ...small, content: small.content + `{"type":"note","text":"${"a b ".repeat(Math.ceil(UPLOAD_BIG_BYTES / 4) + 10)}"}\n` };
  const b = server([503]);
  const z = queue(b.f);
  await z.q.enqueueSession(big);
  await z.q.flush(); await z.q.flush();
  assert.equal(b.seen.length, 1, "backoff: not resent immediately");
  for (let i = 0; i < 6; i++) { z.clock.t += 31 * 60_000; await z.q.flush(); }
  const s = await z.q.summary();
  assert.equal(b.seen.length, 5); assert.equal(s.needsExport, 1); assert.equal(s.pending, 0);
});

test("upload: no token -> waits (N logs waiting); network error -> stays queued; study_start carries protocol", async () => {
  const file = await studyFile();
  const { f, seen } = server([201]);
  const { q, token } = queue(f, new MemoryKV(), { t: 1 }, { v: null });
  await q.enqueueSession(file);
  assert.equal((await q.enqueueSession(file)), null, "idempotent per sessionId");
  await q.enqueueStudyStart({ scheduleHash: "a".repeat(64), nSessions: 10, createdAt: "2026-11-02T22:00:00.000Z", protocol: STUDY_PROTOCOL_VERSION });
  let s = await q.flush();
  assert.equal(s.pending, 2); assert.equal(s.blocked, "no-token"); assert.equal(seen.length, 0);
  token.v = "bhd_x";
  s = await q.flush();
  assert.equal(s.done, 2);
  const ss = JSON.parse(seen.find((x) => x.body.includes('"study_start"'))!.body);
  assert.deepEqual(ss, { kind: "study_start", id: `phaseD-${"a".repeat(16)}`, scheduleHash: "a".repeat(64), nSessions: 10, appVersion: "0.1.0", build: "7", platform: "test", createdAt: "2026-11-02T22:00:00.000Z", protocol: STUDY_PROTOCOL_VERSION });
  const off = queue((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch);
  await off.q.enqueueSession(file);
  s = await off.q.flush();
  assert.equal(s.pending, 1); assert.equal(s.blocked, "offline");
});
