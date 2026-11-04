// E3: the Director loop on mock backends: prompt slots + ids, fence stripping, validation (ajv parity), one repair
// retry, the <= 1.5 s hold, all rails with codes (R3 fixtures), footprint feedback, 429 role caps, leak breaker,
// blinded logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import AjvMod from "ajv";
import {
  ActorDirectorSession, AdStorage, AdSessionLog, ManualClock, MockAdBackend, WorkerChatBackend, WorkerHttpError, callDirector, loadO200k,
  DIRECTOR_SYSTEM_SLOT, DIRECTOR_FORMAT_SLOT, DIRECTOR_EXAMPLES_SLOT, DIRECTOR_PROMPT_ID, DIRECTOR_ASSEMBLED_SHA8, assembleDirectorSystem, slotTokens, sumSlots,
  parseDirectorText, validateDirectorOutput, runRails, renderDirectorInput, footprintLines, R3_SYSTEM_PROMPT_V1, R3_EXAMPLES_BLOCK_V1,
} from "../src/actor-director/index.ts";
import { DIRECTOR_OUTPUT_FORMAT_TEXT, RAIL_CODES, blindedGuard, renderActorText } from "../src/ad-contracts/index.ts";
import { directorOutputNote } from "../src/ad-contracts/examples.ts";
import type { AttentionEvent, BhAdEvent, ReadingDigest } from "../src/ad-contracts/index.ts";
import { MemoryKV } from "../src/platform/kv.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const R3 = join(import.meta.dirname, "fixtures/r3");
const fixtures = () => [...readdirSync(join(R3, "fixtures_invalid")).map((f) => ["fixtures_invalid/" + f]), ...readdirSync(join(R3, "examples")).map((f) => ["examples/" + f])].map(([f]) => ({ f: f!, d: JSON.parse(readFileSync(join(R3, f!), "utf8")) }));
const o200k = loadO200k();

test("E3: prompt slots: each id = sha256[:8] of its text; system slot = R3 system_prompt_v1.txt (dir1-b1d2fd77), byte-exact", () => {
  const vend = join(import.meta.dirname, "..", "vendor", "r3");
  assert.equal(readFileSync(join(vend, "system_prompt_v1.txt"), "utf8"), R3_SYSTEM_PROMPT_V1);
  assert.equal(readFileSync(join(vend, "examples_block_v1.txt"), "utf8"), R3_EXAMPLES_BLOCK_V1);
  assert.equal(DIRECTOR_PROMPT_ID, "dir1-b1d2fd77");
  assert.equal(DIRECTOR_SYSTEM_SLOT.id, "dir1-" + sha(DIRECTOR_SYSTEM_SLOT.text).slice(0, 8));
  assert.equal(DIRECTOR_FORMAT_SLOT.id, "fmt1-" + sha(DIRECTOR_OUTPUT_FORMAT_TEXT).slice(0, 8));
  assert.equal(DIRECTOR_EXAMPLES_SLOT.id, "dex1-" + sha(DIRECTOR_EXAMPLES_SLOT.text).slice(0, 8));
  assert.equal(DIRECTOR_FORMAT_SLOT.text, DIRECTOR_OUTPUT_FORMAT_TEXT);
  const asm = assembleDirectorSystem(true);
  assert.equal(asm, [R3_SYSTEM_PROMPT_V1.trimEnd(), DIRECTOR_OUTPUT_FORMAT_TEXT, R3_EXAMPLES_BLOCK_V1.trimEnd()].join("\n\n"));
  assert.equal(DIRECTOR_ASSEMBLED_SHA8, sha(asm).slice(0, 8));
  const st = slotTokens((t) => o200k.count(t), "digest", true);
  assert.equal(st.system, 649); // R3's count of system_prompt_v1.txt (trailing newline trimmed)
  assert.equal(st.examples, o200k.count("\n\n" + R3_EXAMPLES_BLOCK_V1.trimEnd()));
  assert.equal(st.format, o200k.count("\n\n" + DIRECTOR_OUTPUT_FORMAT_TEXT));
  assert.equal(sumSlots(st), st.system + st.format + st.examples + st.digest);
  assert.equal(slotTokens((t) => o200k.count(t), "x", false).examples, 0);
});

test("E3: code fences stripped, JSON parsed", () => {
  const j = JSON.stringify(directorOutputNote);
  for (const t of [j, "```json\n" + j + "\n```", "```\n" + j + "```", "Here you go:\n" + j + "\nthanks"]) {
    const p = parseDirectorText(t);
    assert.ok(p.ok); assert.deepEqual(p.ok && p.value, directorOutputNote);
  }
  assert.equal(parseDirectorText("not json").ok, false);
});

test("E3: hand validator agrees with ajv / note.schema.json on every R3 fixture and example", () => {
  const Ajv = (AjvMod as unknown as { default?: typeof AjvMod }).default ?? AjvMod;
  const ajv = new (Ajv as unknown as new (o: object) => { compile(s: object): (v: unknown) => boolean })({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
  const v = ajv.compile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "src/ad-contracts/schemas/note.schema.json"), "utf8")));
  let n = 0;
  for (const { f, d } of fixtures()) { assert.equal(validateDirectorOutput(d.output).length === 0, v(d.output), f); n++; }
  assert.equal(validateDirectorOutput(directorOutputNote).length, 0);
  assert.ok(n >= 34);
});

test("E3: rails with codes: all 34 R3 fixtures/examples give exactly the expected codes", () => {
  for (const { f, d } of fixtures()) {
    const r = runRails(d.output, { input: d.input, previousActorTexts: (d.previous_notes ?? []).map((p: never) => renderActorText(p)), directorEnabled: true, cameraConsent: true, leakBreakerTripped: false });
    assert.deepEqual([...r.blocked_by].sort(), [...(d.expect_codes ?? [])].sort(), f);
    assert.equal(r.pass, d.expect === "pass" && d.output.note !== null, f);
  }
});

test("E3: rails: kill_switch, consent, data_validity, leak_breaker, and RAIL_CODES order", () => {
  const ex = fixtures().find((x) => x.f.endsWith("ex2_suggestion.json"))!.d;
  const base = { input: ex.input, previousActorTexts: [], directorEnabled: true, cameraConsent: true, leakBreakerTripped: false };
  assert.deepEqual(runRails(ex.output, base).blocked_by, []);
  assert.deepEqual(runRails(ex.output, { ...base, directorEnabled: false }).blocked_by, ["kill_switch"]);
  assert.deepEqual(runRails(ex.output, { ...base, cameraConsent: false }).blocked_by, ["consent"]);
  assert.deepEqual(runRails(ex.output, { ...base, invalidEventIds: new Set(["e8"]) }).blocked_by, ["data_validity"]);
  const all = runRails(ex.output, { ...base, directorEnabled: false, cameraConsent: false, invalidEventIds: new Set(["e8"]), leakBreakerTripped: true, previousActorTexts: [renderActorText(ex.output.note)] });
  assert.deepEqual(all.blocked_by, ["kill_switch", "consent", "data_validity", "duplicate", "leak_breaker"]);
  assert.deepEqual(all.blocked_by, RAIL_CODES.filter((c) => all.blocked_by.includes(c)));
});

const goodNote = (id: string, ev: string, text: string) => JSON.stringify({ context_update: { summary: "s", hypotheses: [], changed: [] }, intent: "i", note: { id, rationale: "r", suggestion: { move: "give_example", text }, value: "v", evidence: [ev], confidence: 0.6, expires_after_turns: 1 }, no_note_reason: null });

test("E3: one repair retry; second failure = null + director.schema_invalid; 429 role_cap_director -> budget.director_cap", async () => {
  const m = () => 0;
  const ok = await callDirector(new MockAdBackend([{ text: "```json\n" + goodNote("n1", "a1", "give one example") + "\n```" }]), "x", 1024, "SYS", "a1.p1 \"hi\"", m);
  assert.equal(ok.repaired, false); assert.equal(ok.output?.note?.id, "n1");
  const be = new MockAdBackend([{ text: '{"note":1}' }, { text: goodNote("n2", "a1", "give one example") }]);
  const rep = await callDirector(be, "x", 1024, "SYS", "a1", m);
  assert.equal(rep.repaired, true); assert.equal(rep.output?.note?.id, "n2");
  assert.equal(be.calls.length, 2);
  assert.equal(be.calls[1]!.messages.length, 4);
  assert.match(be.calls[1]!.messages[3]!.content, /not valid DirectorOutput/);
  assert.ok(be.calls.every((c) => c.role === "director" && c.maxTokens === 1024));
  const bad = await callDirector(new MockAdBackend([{ text: "nope" }, { text: "{}" }]), "x", 1024, "SYS", "a1", m);
  assert.equal(bad.output, null); assert.equal(bad.error, "director.schema_invalid"); assert.equal(bad.health?.code, "director.schema_invalid");
  const capErr = new WorkerHttpError(429, "role_cap_director", "director", null);
  const cap = await callDirector(new MockAdBackend([{ error: capErr }]), "x", 1024, "SYS", "a1", m);
  assert.deepEqual(cap.health, { type: "health", check: "budget", ok: false, code: "budget.director_cap", http_status: 429, worker_code: "role_cap_director", role: "director" });
});

test("E3: WorkerChatBackend sends X-BH-Role and maps 429 role_cap_<role> (fake fetch, no network)", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url, headers: init.headers, body: init.body });
    if (seen.length === 2) return new Response(JSON.stringify({ error: { message: "cap", type: "rate_limit_error", code: "role_cap_judge", role: "judge", scope: "role", limit: 100, used: 100 } }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const be = new WorkerChatBackend({ baseUrl: "https://worker.invalid/", token: () => "TEST-TOKEN", fetchImpl: fakeFetch });
  const r = await be.complete({ role: "director", model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 1024 });
  assert.equal(r.text, "hello"); assert.equal(r.usage.prompt_tokens, 12);
  assert.equal(seen[0]!.url, "https://worker.invalid/v1/chat/completions");
  assert.equal(seen[0]!.headers["X-BH-Role"], "director");
  assert.equal(JSON.parse(seen[0]!.body).max_tokens, 1024);
  await assert.rejects(be.complete({ role: "judge", model: "m", messages: [], maxTokens: 10 }), (e: unknown) => e instanceof WorkerHttpError && e.status === 429 && e.code === "role_cap_judge" && e.role === "judge");
});

// ---------------------------------------------------------------- session fixtures
function digestFor(turn: number, nParas: number, q = 0.8): { digest: ReadingDigest; events: AttentionEvent[] } {
  const id = `e${turn * 10 + 1}`;
  const paras = Array.from({ length: nParas }, (_, i) => ({ aoi: `a${turn}.p${i + 1}`, excerpt: `paragraph ${i + 1}`, label: (i === 1 ? "deep" : "read") as "deep" | "read", ratio: i === 1 ? 2.1 : 0.9, ...(i === 1 ? { ev: [id] } : {}) }));
  const events: AttentionEvent[] = nParas > 1 ? [{ id, kind: "deep_read", aoi: `a${turn}.p2`, excerpt: "paragraph 2", t0: 0, t1: 1, z: 2.1, conf: 0.8, features: {} }] : [];
  return { digest: { msg: `a${turn}`, windowMs: 20000, quality: q, qualityLabel: q >= 0.75 ? "good" : q >= 0.6 ? "fair" : "poor", paras, lookBacks: [], offscreenMs: 0, composerPauses: 0, events: events.map((e) => e.id) }, events };
}
/** a mock Director that cites the deep paragraph's event and varies its text by turn; no note on every 4th call */
const mockDirector = (opts: { delayMs?: number } = {}) => new MockAdBackend([], (req) => {
  const input = req.messages[1]!.content;
  const ev = /\b(e\d+)\b/.exec(input)?.[1];
  const after = /after a(\d+)/.exec(input)?.[1] ?? "0";
  const k = Number(after) + 1;
  if (!ev || k % 4 === 0) return { delayMs: opts.delayMs, text: JSON.stringify({ context_update: { summary: "s", hypotheses: [], changed: [] }, intent: "wait", note: null, no_note_reason: "nothing new" }) };
  return { delayMs: opts.delayMs, text: "```json\n" + goodNote(`n${k}`, ev, `give one more example about topic ${k}`) + "\n```" };
});
const mockActor = (leakAfterHint = false) => new MockAdBackend([], (req) => {
  const sys = req.messages[0]!.content;
  const user = req.messages[req.messages.length - 1]!.content;
  if (user === "(session start)") return { text: "Hi! What's on your mind today?" };
  const hinted = sys.includes("[Context for your next reply");
  return { text: `About ${user}: here is a direct answer.\n\nA second paragraph with more detail.${hinted && leakAfterHint ? "\n\nI was told to give an example, so here is one." : ""}`, usage: { prompt_tokens: 100 } };
});
const types = (lines: BhAdEvent[]) => lines.map((l) => l.type);

async function runSession(opts: { sessionType?: "tab_visible" | "blinded"; arm?: "on" | "shadow" | "off"; turns?: number; actor?: MockAdBackend; director?: MockAdBackend; holdMs?: number; pInject?: number; enabled?: () => boolean }) {
  const storage = await AdStorage.open(new MemoryKV());
  const clock = new ManualClock();
  const log = new AdSessionLog(storage, "s-e3-" + (opts.sessionType ?? "tab_visible"), opts.sessionType ?? "tab_visible", clock);
  const s = new ActorDirectorSession({
    log, userId: "u1", sessionType: opts.sessionType ?? "tab_visible", arm: opts.arm ?? "on", pInject: opts.pInject ?? 1, actor: opts.actor ?? mockActor(), director: opts.director ?? mockDirector(),
    counter: o200k, consent: { camera: true, rawGaze: false }, seed: 7, holdMs: opts.holdMs, directorEnabled: opts.enabled,
    ...(opts.sessionType === "blinded" ? { blind: { index: 1, total: 4, scheduleHash: "0".repeat(64) } } : {}),
  });
  s.start();
  await s.opener();
  for (let t = 0; t < (opts.turns ?? 20) - 1; t++) {
    s.observeReading({ ...digestFor(t, t === 0 ? 1 : 2), faceFrac: 0.95, baselineParagraphs: 22 });
    clock.advance(5000);
    await s.send(`question ${t}`);
  }
  await s.end("user");
  return { s, log, storage };
}

test("E3: a 20-turn mock session end to end (tab_visible, arm on): events, rails, injections, shares, footprint", async () => {
  const { s, log } = await runSession({});
  const L = log.lines;
  assert.equal(L[0]!.type, "session_start");
  const ss = L[0] as Extract<BhAdEvent, { type: "session_start" }>;
  assert.equal(ss.director_prompt_id, "dir1-b1d2fd77"); assert.equal(ss.director_format_id, DIRECTOR_FORMAT_SLOT.id); assert.equal(ss.director_assembled_sha8, DIRECTOR_ASSEMBLED_SHA8);
  assert.equal(L.filter((l) => l.type === "actor_turn").length, 20);
  assert.equal(L.filter((l) => l.type === "context_share").length, 20);
  const calls = L.filter((l) => l.type === "director_call") as Array<Extract<BhAdEvent, { type: "director_call" }>>;
  assert.equal(calls.length, 19); // once per Actor turn after the opener
  for (const c of calls) {
    assert.equal(c.input_tokens, c.input_tokens_by_slot!.system + c.input_tokens_by_slot!.format + c.input_tokens_by_slot!.examples + c.input_tokens_by_slot!.digest);
    assert.ok(c.input_tokens <= 4000);
    assert.equal(c.assembled_prompt_sha8, DIRECTOR_ASSEMBLED_SHA8);
    assert.equal(c.deadline_missed, false);
  }
  const inj = L.filter((l) => l.type === "injection") as Array<Extract<BhAdEvent, { type: "injection" }>>;
  assert.ok(inj.length >= 10);
  assert.ok(inj.every((i) => i.decision === "inject"));
  // every injected note reached exactly the next Actor request, and only that one (TTL 1)
  const cs = L.filter((l) => l.type === "context_share") as Array<Extract<BhAdEvent, { type: "context_share" }>>;
  for (const i of inj) assert.equal(cs.find((c) => c.turn === i.turn)!.note_id, i.note_id);
  assert.equal(cs.filter((c) => c.director > 0).length, inj.length);
  // footprint feedback: the Director sees its notes, and the last call's footprint matches the running totals
  const last = calls[calls.length - 1]!;
  assert.equal(last.footprint.notes_injected, inj.filter((i) => i.turn < last.turn).length);
  assert.ok(last.footprint.recent.length === 3 && last.footprint.recent.every((r) => r.decision === "inject"));
  assert.ok(last.footprint.session_share > 0);
  assert.match(footprintLines(last.footprint)[0]!, /^\[YOUR FOOTPRINT\] notes \d+ of 19 Actor turns · session share \d+\.\d% \(dynamic \d+\.\d%\)$/);
  assert.ok(last.footprint.recent.some((r) => r.next_dwell_ratio !== null));
  // outcomes and the session summary
  const outc = L.filter((l) => l.type === "note_outcome");
  assert.equal(outc.length, inj.length);
  const sum = L.filter((l) => l.type === "session_share")[0] as Extract<BhAdEvent, { type: "session_share" }>;
  assert.equal(sum.notes, inj.length);
  assert.equal(sum.session_share, s.tracker.sessionShare);
  assert.equal(sum.session_share, cs.reduce((a, c) => a + c.director, 0) / cs.reduce((a, c) => a + c.total, 0));
  assert.equal(L[L.length - 1]!.type, "session_end");
  assert.ok(L.some((l) => l.type === "rail_check" && l.pass));
  // the user_turn hold never exceeds 1.5 s
  for (const u of L.filter((l) => l.type === "user_turn") as Array<Extract<BhAdEvent, { type: "user_turn" }>>) assert.ok(u.hold_ms <= 1500);
  assert.deepEqual([...new Set(L.map((l) => l.seq))].length, L.length);
});

test("E3: arm shadow: the Director runs every turn, nothing is injected, D = 0 everywhere", async () => {
  const { log } = await runSession({ arm: "shadow", turns: 8 });
  const L = log.lines;
  assert.equal(L.filter((l) => l.type === "director_call").length, 7);
  assert.ok(L.filter((l) => l.type === "injection").every((i) => (i as { decision: string }).decision === "shadow"));
  assert.ok(L.filter((l) => l.type === "context_share").every((c) => (c as { director: number }).director === 0));
});

test("E3: a Director slower than the hold: the note is dropped (late), director.timeout, Actor not delayed past the hold", async () => {
  const { log } = await runSession({ turns: 3, director: mockDirector({ delayMs: 150 }), holdMs: 30 });
  await new Promise((r) => setTimeout(r, 400));
  const L = log.lines;
  assert.ok(L.some((l) => l.type === "health" && l.code === "director.timeout"));
  assert.ok(L.some((l) => l.type === "note_dropped" && l.reason === "late"));
  assert.ok(L.filter((l) => l.type === "director_call").every((c) => (c as { deadline_missed: boolean }).deadline_missed));
  assert.ok(L.filter((l) => l.type === "context_share").every((c) => (c as { director: number }).director === 0));
});

test("E3: leak breaker: 2 safety leaks after injected notes -> director.leak_breaker, later notes blocked by leak_breaker", async () => {
  const { log } = await runSession({ turns: 10, actor: mockActor(true) });
  const L = log.lines;
  const outs = L.filter((l) => l.type === "note_outcome") as Array<Extract<BhAdEvent, { type: "note_outcome" }>>;
  assert.ok(outs[0]!.leaks.includes("provenance"));
  const hIdx = L.findIndex((l) => l.type === "health" && l.code === "director.leak_breaker");
  assert.ok(hIdx > 0);
  assert.equal(L.filter((l) => l.type === "health" && l.code === "director.leak_breaker").length, 1);
  const later = L.slice(hIdx).filter((l) => l.type === "rail_check") as Array<Extract<BhAdEvent, { type: "rail_check" }>>;
  assert.ok(later.length > 0 && later.every((r) => !r.pass && r.blocked_by.includes("leak_breaker")));
  assert.equal(L.slice(hIdx).filter((l) => l.type === "injection").length, 0);
});

test("E3: 429 role_cap_director mid-session -> budget.director_cap (worker_code, role), no more Director calls", async () => {
  const d = mockDirector();
  d.push({ text: goodNote("n1", "a0", "give one example") }, { error: new WorkerHttpError(429, "role_cap_director", "director", null) });
  const { log } = await runSession({ turns: 6, director: d });
  const h = log.lines.filter((l) => l.type === "health" && l.code === "budget.director_cap") as Array<Extract<BhAdEvent, { type: "health" }>>;
  assert.equal(h.length, 1); assert.equal(h[0]!.worker_code, "role_cap_director"); assert.equal(h[0]!.role, "director");
  assert.equal(d.calls.length, 2);
  const a = mockActor();
  a.push({ text: "hi" }, { error: new WorkerHttpError(429, "role_cap_actor", "actor", null) });
  const r2 = await runSession({ turns: 2, actor: a });
  assert.ok(r2.log.lines.some((l) => l.type === "health" && l.code === "budget.actor_cap" && l.role === "actor"));
  assert.ok(r2.log.lines.some((l) => l.type === "actor_turn" && l.error === "budget.actor_cap"));
});

test("E3: kill switch: no Director calls, health director.kill_switch", async () => {
  const { log } = await runSession({ turns: 4, enabled: () => false });
  assert.equal(log.lines.filter((l) => l.type === "director_call").length, 0);
  assert.ok(log.lines.some((l) => l.type === "health" && l.code === "director.kill_switch"));
});

test("E3: blinded session: the main log passes the blinded guard (no arm, no Director events), the sealed log has them", async () => {
  const { log, storage } = await runSession({ sessionType: "blinded", turns: 8 });
  assert.equal(log.guardDrops, 0);
  const main = storage.read("blinded", log.sessionId);
  const sealed = storage.read("sealed", log.sessionId);
  assert.deepEqual(blindedGuard(log.sessionId, main), { ok: true });
  assert.deepEqual(blindedGuard(log.sessionId + ".sealed", sealed, main), { ok: true });
  const mt = main.split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
  for (const t of ["director_call", "rail_check", "injection", "context_share", "note_outcome", "session_share"]) assert.ok(!mt.includes(t), t);
  assert.ok(types(log.lines).includes("injection"));
  assert.ok(sealed.includes('"arm":"on"') && !main.includes('"arm"'));
});

test("E3: input cap 4000: the examples slot is dropped first (assembled sha changes)", async () => {
  const storage = await AdStorage.open(new MemoryKV());
  const clock = new ManualClock();
  const log = new AdSessionLog(storage, "s-cap", "tab_visible", clock);
  const long = Array.from({ length: 12 }, (_, i) => "Paragraph " + i + " " + "words that keep going and going about bread ".repeat(6)).join("\n\n");
  const actor = new MockAdBackend([], () => ({ text: long }));
  const s = new ActorDirectorSession({ log, userId: "u", sessionType: "tab_visible", arm: "on", actor, director: mockDirector(), counter: o200k, consent: { camera: true, rawGaze: false } });
  s.start(); await s.opener();
  for (let t = 0; t < 14; t++) { s.observeReading({ ...digestFor(t, 2), faceFrac: 0.9, baselineParagraphs: 22 }); await s.send("more " + t); }
  await s.end();
  const calls = log.lines.filter((l) => l.type === "director_call") as Array<Extract<BhAdEvent, { type: "director_call" }>>;
  assert.ok(calls.every((c) => c.input_tokens <= 4000));
  const dropped = calls.filter((c) => c.input_tokens_by_slot!.examples === 0);
  assert.ok(dropped.length > 0);
  assert.ok(dropped.every((c) => c.assembled_prompt_sha8 === createHash("sha256").update(assembleDirectorSystem(false)).digest("hex").slice(0, 8)));
});

test("E3: Director input: low-quality windows withhold events; z only after the baseline", () => {
  const fp = { actor_turns: 2, notes_injected: 0, notes_shadowed: 0, notes_blocked: 0, session_share: 0, session_dynamic_share: 0, recent: [] };
  const chat = [{ id: "a0", role: "assistant" as const, text: "Hi!" }, { id: "u0", role: "user" as const, text: "tell me" }, { id: "a1", role: "assistant" as const, text: "One.\n\nTwo." }];
  const good = renderDirectorInput({ chat, ...digestFor(1, 2), faceFrac: 0.9, baselineParagraphs: 22, footprint: fp });
  assert.equal(good, [
    '[CHAT] a0.p1 "Hi!"', 'u0 "tell me"', 'a1.p1 "One." · a1.p2 "Two."',
    "[ATTENTION DIGEST · after a1 · window 20 s · tracking good (0.80) · baseline: 22 paragraphs]",
    "a1.p1 read 0.9x · a1.p2 DEEP 2.1x, e11 (z 2.1, conf .80)",
    "off-screen 0 s · composer pauses >2 s: 0",
    "[YOUR FOOTPRINT] notes 0 of 2 Actor turns · session share 0.0%",
  ].join("\n"));
  const poor = renderDirectorInput({ chat, ...digestFor(1, 2, 0.4), faceFrac: 0.9, baselineParagraphs: 22, footprint: fp });
  assert.ok(!poor.includes("e11") && poor.includes("tracking poor"));
  const early = renderDirectorInput({ chat, ...digestFor(1, 2), faceFrac: 0.9, baselineParagraphs: 5, footprint: fp });
  assert.ok(early.includes("e11 (conf .80)") && early.includes("5 of 20 paragraphs"));
  const ex = fixtures().find((x) => x.f.endsWith("ex2_suggestion.json"))!.d.input as string;
  assert.match(ex.split("\n")[3]!, /^\[ATTENTION DIGEST · after a\d+ · window \d+ s · tracking \w+ \(\d\.\d\d\) · baseline: \d+ paragraphs\]$/);
  assert.match(good.split("\n")[3]!, /^\[ATTENTION DIGEST · after a\d+ · window \d+ s · tracking \w+ \(\d\.\d\d\) · baseline: \d+ paragraphs\]$/);
});
