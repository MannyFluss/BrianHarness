/**
 * Leak-judge commit set: the pre-display gate (regex first, then the judge route), its pinned prompt id, the fail-safe
 * drop, timing parity across arms and session types, sealed-only logging, the breaker, and the frozen-predictor path.
 * Mock backends only; no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorDirectorSession, AdStorage, AdSessionLog, ManualClock, MockAdBackend, WorkerChatBackend, WorkerHttpError, loadO200k,
  LEAK_JUDGE_PROMPT_ID, LEAK_JUDGE_PROMPT_TEXT, LEAK_JUDGE_MODEL, LEAK_JUDGE_DEADLINE_MS, JUDGE_CODES, LeakGate, MockJudgeBackend,
  assertJudgeModel, buildTabModel, judgeUserMessage, R4C_ANSWER_FIRST_RULES, decideCodes, tabSafeLines, parseJudgeUserMessage, parseJudgeAnswer, regexStage,
} from "../src/actor-director/index.ts";
import type { AdChatBackend } from "../src/actor-director/index.ts";
import { HINT_HEADER, SEALED_ONLY_TYPES, SUGGESTION_LEAD, blindedGuard } from "../src/ad-contracts/index.ts";
import type { AttentionEvent, BhAdEvent, ReadingDigest } from "../src/ad-contracts/index.ts";
import { MemoryKV } from "../src/platform/kv.ts";

const o200k = loadO200k();
const ACTOR = "gpt-oss:120b-cloud";
const hint = (obs: string, sug: string) => `${HINT_HEADER}\n- ${obs} (h:e1)\n- ${SUGGESTION_LEAD}${sug}`;
const H = hint("They lingered on the hydration table.", "give one concrete example.");

test("leak judge: prompt id pinned lj2-<sha8> over LEAK_JUDGE_PROMPT_TEXT", () => {
  assert.equal(LEAK_JUDGE_PROMPT_ID, "lj2-eeca9847");
  assert.equal(LEAK_JUDGE_PROMPT_ID, "lj2-" + createHash("sha256").update(LEAK_JUDGE_PROMPT_TEXT, "utf8").digest("hex").slice(0, 8));
  // the R4c clarifications are in the prompt
  for (const s of ["Coming back to that shape again?", "it's been suggested", "visual learner", "Speaking of", "closing one-line offer", "unrelated to the hint is NOT pivot_first", "(h:...)"]) assert.ok(LEAK_JUDGE_PROMPT_TEXT.includes(s), s);
});

test("leak judge lj2: R4c A1-A4 are in the prompt VERBATIM; answer_first_violation is the judge's own field", () => {
  assert.equal(R4C_ANSWER_FIRST_RULES.length, 4);
  for (const [i, line] of R4C_ANSWER_FIRST_RULES.entries()) { assert.ok(line.startsWith(`- **A${i + 1}**: `)); assert.ok(LEAK_JUDGE_PROMPT_TEXT.includes(line + "\n"), line); }
  // byte-for-byte against the Researcher's file when it is on this machine (rules A1-A4 only; nothing else read)
  const f = "/workspace/actor-director/research/R4c/LABELING_R4c.md";
  if (existsSync(f)) assert.deepEqual(readFileSync(f, "utf8").split("\n").filter((l) => /^- \*\*A[1-4]\*\*/.test(l)), [...R4C_ANSWER_FIRST_RULES]);
  for (const s of ["a necessary clarifying question, or stating a limitation first, is valid.", "pivot_first implies answer_first_violation = true", '"answer_first_violation":true|false|"uncertain"|null']) assert.ok(LEAK_JUDGE_PROMPT_TEXT.includes(s), s);
  assert.ok(!LEAK_JUDGE_PROMPT_TEXT.includes('"answered_first"'), "the judge no longer returns answered_first");
  // parse: pivot_first forces the violation; "uncertain" is kept; anything else is unparseable
  assert.deepEqual(parseJudgeAnswer('{"codes":["pivot_first"],"uncertain":[],"answer_first_violation":false}', JUDGE_CODES), { codes: ["pivot_first"], uncertain: [], answer_first_violation: true });
  assert.deepEqual(parseJudgeAnswer('{"codes":[],"uncertain":[],"answer_first_violation":"uncertain"}', JUDGE_CODES), { codes: [], uncertain: [], answer_first_violation: "uncertain" });
  assert.equal(parseJudgeAnswer('{"codes":[],"answer_first_violation":"maybe"}', JUDGE_CODES), null);
  // one call decides every judge code + answer_first jointly; pivot_first / forced_move only with a hint
  assert.deepEqual(decideCodes({ text: "x", context: "q", note: H }, []), ["mind_reading", "pivot_first", "forced_move"]);
  assert.deepEqual(decideCodes({ text: "x", context: "q", note: "" }, ["provenance"]), ["provenance", "mind_reading"]);
});

test("leak judge lj2: answer_first_violation 'uncertain' -> verdict uncertain (fail safe); per-code uncertain counts", async () => {
  const say = (o: object) => new MockAdBackend([{ text: JSON.stringify(o) }]);
  const g1 = new LeakGate({ backend: say({ codes: [], uncertain: [], answer_first_violation: "uncertain" }), actorModel: ACTOR });
  const r1 = await g1.check({ text: "Use 75% water.", context: "how much water?", note: H });
  assert.equal(r1.verdict, "uncertain"); assert.equal(r1.answer_first_violation, "uncertain"); assert.equal(r1.answered_first, null);
  assert.equal(g1.stats.answerFirstUncertain, 1); assert.equal(g1.stats.verdicts.uncertain, 1);
  // a judge that omits the field on a scored reply is uncertain too
  const r2 = await new LeakGate({ backend: say({ codes: [], uncertain: [] }), actorModel: ACTOR }).check({ text: "Use 75% water.", context: "how much water?", note: H });
  assert.equal(r2.verdict, "uncertain");
  // a fragment / no latest message: not scored (null), so the verdict rests on the codes
  const r3 = await new LeakGate({ backend: say({ codes: [], uncertain: [], answer_first_violation: null }), actorModel: ACTOR }).check({ text: "Use 75% water.", context: "", note: H });
  assert.equal(r3.answer_first_violation, null); assert.equal(r3.verdict, "pass");
  // pivot_first => violation, flagged
  const r4 = await new LeakGate({ backend: say({ codes: ["pivot_first"], uncertain: [], answer_first_violation: false }), actorModel: ACTOR }).check({ text: "Speaking of tables: water 75%.", context: "how much water?", note: H });
  assert.equal(r4.answer_first_violation, true); assert.equal(r4.verdict, "flagged");
  // per-code uncertain counts (the uncertain rate per code = count / checks)
  const g5 = new LeakGate({ backend: new MockAdBackend([{ text: JSON.stringify({ codes: [], uncertain: ["mind_reading"], answer_first_violation: false }) }, { error: new Error("down") }]), actorModel: ACTOR });
  await g5.check({ text: "Use 75% water.", context: "how much water?", note: H });
  await g5.check({ text: "Use 75% water.", context: "how much water?", note: H });
  assert.equal(g5.stats.checks, 2); assert.equal(g5.stats.uncertainByCode.mind_reading, 2); assert.equal(g5.stats.uncertainByCode.pivot_first, 1); assert.equal(g5.stats.answerFirstUncertain, 1);
  assert.equal(g5.stats.status.error, 1);
});

test("leak judge: the judge model must differ from the Actor's family (spec: gemma4:cloud)", () => {
  assert.equal(LEAK_JUDGE_MODEL, "gemma4:cloud");
  assert.doesNotThrow(() => assertJudgeModel("gemma4:cloud", ACTOR));
  for (const bad of [ACTOR, "gpt-oss:20b-cloud", "gpt-oss:120b"]) assert.throws(() => assertJudgeModel(bad, ACTOR), /different model family/);
  assert.throws(() => new LeakGate({ backend: new MockJudgeBackend(), model: "gpt-oss:20b-cloud", actorModel: ACTOR }));
  assert.throws(() => new ActorDirectorSession({ ...baseOpts(), leakGate: undefined, models: { actor: "gemma4:cloud", director: "gpt-oss:120b-cloud" } } as never));
});

class Recording implements AdChatBackend {
  readonly id = "rec";
  reqs: Array<{ role: string; model: string; system: string; user: string; at: number }> = [];
  constructor(private inner: AdChatBackend) {}
  async complete(req: Parameters<AdChatBackend["complete"]>[0]) {
    this.reqs.push({ role: req.role, model: req.model, system: req.messages[0]!.content, user: req.messages[1]!.content, at: performance.now() });
    return this.inner.complete(req);
  }
}

test("leak judge: regex first; the judge decides mind_reading/pivot_first/forced_move + regex-uncertain codes on the judge route", async () => {
  const rec = new Recording(new MockJudgeBackend());
  const gate = new LeakGate({ backend: rec, actorModel: ACTOR });
  // certain regex code: no judge needed for it, but the judge still runs for its own codes
  const r1 = await gate.check({ text: "I saw you reread the hydration table, so here's an example.", context: "how much water?", note: H });
  assert.ok(r1.regex.includes("sensor")); assert.equal(r1.verdict, "flagged"); assert.equal(r1.status, "ok");
  assert.equal(rec.reqs.length, 1);
  assert.equal(rec.reqs[0]!.role, "judge"); assert.equal(rec.reqs[0]!.model, "gemma4:cloud"); assert.equal(rec.reqs[0]!.system, LEAK_JUDGE_PROMPT_TEXT);
  assert.deepEqual(parseJudgeUserMessage(rec.reqs[0]!.user).decide, [...JUDGE_CODES].sort((a, b) => ["sensor", "provenance", "mind_reading", "pivot_first", "verbatim", "forced_move"].indexOf(a) - ["sensor", "provenance", "mind_reading", "pivot_first", "verbatim", "forced_move"].indexOf(b)));
  // a clean answer passes
  const r2 = await gate.check({ text: "Use about 75% of the flour weight in water. For example, 500 g flour takes 375 g water.", context: "how much water?", note: H });
  assert.equal(r2.verdict, "pass"); assert.deepEqual(r2.codes, []); assert.equal(r2.answered_first, true);
  // judge code (pivot) found by the judge layer, not the regex
  const r3 = await gate.check({ text: "Before that, here's an example of a hydration table. Use about 75% water.", context: "how much water?", note: H });
  assert.ok(r3.judge!.includes("pivot_first") && !r3.regex.includes("pivot_first")); assert.equal(r3.verdict, "flagged");
  // a weak provenance signal the regex can't decide -> sent to the judge; the mock can't decide it either -> uncertain
  const rs = regexStage({ text: "I got a little nudge to add an example, so here's one.", context: "how much water?", note: H });
  assert.deepEqual(rs.uncertain, ["provenance"]);
  const r4 = await gate.check({ text: "I got a little nudge to add an example, so here's one.", context: "how much water?", note: H });
  assert.ok(parseJudgeUserMessage(rec.reqs.at(-1)!.user).decide.includes("provenance"));
  assert.equal(r4.verdict, "uncertain");
  // the mock judge serves the judge route only
  await assert.rejects(new MockJudgeBackend().complete({ role: "actor", model: "gemma4:cloud", messages: [], maxTokens: 1 }));
});

test("leak judge: judge request/answer round trip; a live model plugs in via WorkerChatBackend (X-BH-Role: judge, fake fetch)", async () => {
  const msg = judgeUserMessage({ text: "Reply.", context: "latest q (earlier user turn: 'old')", note: H, fragment: true }, JUDGE_CODES);
  const back = parseJudgeUserMessage(msg);
  assert.equal(back.input.text, "Reply."); assert.equal(back.input.note, H); assert.equal(back.input.fragment, true);
  assert.match(back.input.context, /latest q/); assert.match(back.input.context, /earlier user turn/);
  assert.deepEqual(parseJudgeAnswer('```json\n{"codes":["pivot_first","sensor"],"uncertain":["mind_reading"],"answer_first_violation":true}\n```', JUDGE_CODES), { codes: ["pivot_first"], uncertain: ["mind_reading"], answer_first_violation: true });
  assert.equal(parseJudgeAnswer("no json here", JUDGE_CODES), null);
  assert.equal(parseJudgeAnswer('{"answer_first_violation":"yes","codes":[]}', JUDGE_CODES), null);
  const seen: Array<Record<string, string>> = [], bodies: string[] = [];
  const fetchImpl = (async (_u: string, init: { headers: Record<string, string>; body: string }) => { seen.push(init.headers); bodies.push(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{"codes":[],"uncertain":[],"answer_first_violation":false}' }, finish_reason: "stop" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const gate = new LeakGate({ backend: new WorkerChatBackend({ baseUrl: "https://worker.invalid", token: () => "TEST", fetchImpl }), actorModel: ACTOR });
  const r = await gate.check({ text: "Use 75% water.", context: "how much water?", note: H });
  assert.equal(r.verdict, "pass"); assert.equal(seen[0]!["X-BH-Role"], "judge");
  assert.equal(JSON.parse(bodies[0]!).temperature, 0, "the gate asks for temperature 0");
});

test("leak judge: fail safe: timeout, error, 429 role_cap_judge and unparseable output are all 'uncertain'", async () => {
  const slow = new LeakGate({ backend: new MockJudgeBackend(() => 400), actorModel: ACTOR, deadlineMs: 60 });
  const t0 = performance.now();
  const r = await slow.check({ text: "Use 75% water.", context: "how much water?", note: H });
  const el = performance.now() - t0;
  assert.equal(r.status, "timeout"); assert.equal(r.verdict, "uncertain"); assert.equal(r.judge, null);
  assert.ok(el >= 55 && el < 300, "returns at the deadline, not when the judge finishes: " + el);
  const err = await new LeakGate({ backend: new MockAdBackend([{ error: new Error("boom") }]), actorModel: ACTOR }).check({ text: "x.", context: "q", note: H });
  assert.equal(err.status, "error"); assert.equal(err.verdict, "uncertain");
  const cap = await new LeakGate({ backend: new MockAdBackend([{ error: new WorkerHttpError(429, "role_cap_judge", "judge", null) }]), actorModel: ACTOR }).check({ text: "x.", context: "q", note: H });
  assert.equal(cap.verdict, "uncertain"); assert.equal(cap.error, "budget.judge_cap");
  const junk = await new LeakGate({ backend: new MockAdBackend([{ text: "sure, looks fine" }]), actorModel: ACTOR }).check({ text: "x.", context: "q", note: H });
  assert.equal(junk.status, "unparseable"); assert.equal(junk.verdict, "uncertain");
  assert.ok(LEAK_JUDGE_DEADLINE_MS > 0 && LEAK_JUDGE_DEADLINE_MS <= 3000);
});

// ---------------------------------------------------------------- session fixtures (same shape as ad-e3)
const goodNote = (id: string, ev: string, text: string) => JSON.stringify({ context_update: { summary: "s", hypotheses: [], changed: [] }, intent: "i", note: { id, rationale: "r", suggestion: { move: "give_example", text }, value: "v", evidence: [ev], confidence: 0.6, expires_after_turns: 1 }, no_note_reason: null });
function digestFor(turn: number, nParas: number): { digest: ReadingDigest; events: AttentionEvent[] } {
  const id = `e${turn * 10 + 1}`;
  const paras = Array.from({ length: nParas }, (_, i) => ({ aoi: `a${turn}.p${i + 1}`, excerpt: `paragraph ${i + 1}`, label: (i === 1 ? "deep" : "read") as "deep" | "read", ratio: i === 1 ? 2.1 : 0.9, ...(i === 1 ? { ev: [id] } : {}) }));
  const events: AttentionEvent[] = nParas > 1 ? [{ id, kind: "deep_read", aoi: `a${turn}.p2`, excerpt: "paragraph 2", t0: 0, t1: 1, z: 2.1, conf: 0.8, features: {} }] : [];
  return { digest: { msg: `a${turn}`, windowMs: 20000, quality: 0.8, qualityLabel: "good", paras, lookBacks: [], offscreenMs: 0, composerPauses: 0, events: events.map((e) => e.id) }, events };
}
const mockDirector = () => new MockAdBackend([], (req) => {
  const input = req.messages[1]!.content;
  const ev = /\b(e\d+)\b/.exec(input)?.[1];
  const k = Number(/after a(\d+)/.exec(input)?.[1] ?? "0") + 1;
  if (!ev || k % 4 === 0) return { text: JSON.stringify({ context_update: { summary: "s", hypotheses: [], changed: [] }, intent: "wait", note: null, no_note_reason: "nothing new" }) };
  return { text: goodNote(`n${k}`, ev, `give one more example about topic ${k}`) };
});
const mockActor = (o: { leak?: boolean; delayMs?: number } = {}) => new MockAdBackend([], (req) => {
  const sys = req.messages[0]!.content, user = req.messages[req.messages.length - 1]!.content;
  if (user === "(session start)") return { text: "Hi! What's on your mind today?" };
  const hinted = sys.includes("[Context for your next reply");
  return { delayMs: o.delayMs, text: `About ${user}: here is a direct answer.\n\nA second paragraph with more detail.${hinted ? (o.leak ? "\n\nI was told to give an example, so here is one." : "\n\nFor example, here is one more case.") : ""}` };
});
function baseOpts() {
  return { userId: "u1", counter: o200k, consent: { camera: true, rawGaze: false }, seed: 7, director: mockDirector(), actor: mockActor() };
}
async function run(o: { sessionType?: "tab_visible" | "blinded"; arm?: "on" | "shadow" | "off"; turns?: number; actor?: MockAdBackend; judge?: AdChatBackend; deadline?: number; pInject?: number }) {
  const storage = await AdStorage.open(new MemoryKV());
  const clock = new ManualClock();
  const st = o.sessionType ?? "tab_visible";
  const log = new AdSessionLog(storage, `s-lj-${st}-${o.arm ?? "on"}`, st, clock);
  const actor = o.actor ?? mockActor();
  const judge = new Recording(o.judge ?? new MockJudgeBackend());
  const s = new ActorDirectorSession({
    ...baseOpts(), log, sessionType: st, arm: o.arm ?? "on", pInject: o.pInject ?? 1, actor, judgeBackend: judge, judgeDeadlineMs: o.deadline,
    ...(st === "blinded" ? { blind: { index: 1, total: 4, scheduleHash: "0".repeat(64) } } : {}),
  });
  s.start(); await s.opener();
  const turnMs: number[] = [];
  for (let t = 0; t < (o.turns ?? 8) - 1; t++) {
    s.observeReading({ ...digestFor(t, t === 0 ? 1 : 2), faceFrac: 0.95, baselineParagraphs: 22 });
    clock.advance(5000);
    const t0 = performance.now(); await s.send(`question ${t}`); turnMs.push(performance.now() - t0);
  }
  await s.end();
  return { s, log, storage, actor, judge, turnMs };
}
type Ev<T extends BhAdEvent["type"]> = Extract<BhAdEvent, { type: T }>;
const of = <T extends BhAdEvent["type"]>(L: BhAdEvent[], t: T) => L.filter((l) => l.type === t) as Ev<T>[];

test("leak judge in the session: on+pass shows the as-if-injected reply; shadow shows the plain one; both are judged", async () => {
  for (const arm of ["on", "shadow"] as const) {
    const { log, actor, judge } = await run({ arm });
    const L = log.lines;
    const inj = of(L, "injection"), lj = of(L, "leak_judge"), at = of(L, "actor_turn");
    assert.ok(inj.length >= 3, arm);
    assert.equal(lj.length, inj.length, `${arm}: every rail-passing note is judged`);
    assert.equal(judge.reqs.length, inj.length);
    assert.ok(lj.every((x) => x.verdict === "pass" && x.model === "gemma4:cloud" && x.judge_prompt_id === LEAK_JUDGE_PROMPT_ID && x.deadline_ms === LEAK_JUDGE_DEADLINE_MS));
    assert.equal(actor.calls.length, at.length + inj.length, `${arm}: one extra Actor request per judged note`);
    for (const x of lj) {
      const shown = at.find((a) => a.turn === x.turn)!;
      if (arm === "on") { assert.equal(shown.note_id, x.note_id); assert.match(shown.text, /For example/); assert.equal(x.reply_sha256, createHash("sha256").update(shown.text).digest("hex")); }
      else { assert.equal(shown.note_id, null); assert.doesNotMatch(shown.text, /For example/); assert.ok(!L.some((l) => JSON.stringify(l).includes("For example"))); }
    }
    // event order on a judged turn: injection -> leak_judge -> context_share -> actor_turn
    const k = L.findIndex((l) => l.type === "leak_judge");
    assert.deepEqual(L.slice(k - 1, k + 3).map((l) => l.type), ["injection", "leak_judge", "context_share", "actor_turn"]);
    assert.equal(of(L, "note_outcome").length, inj.length);
  }
});

test("leak judge: timing parity: same calls, same deadline, same waits in on / shadow, tab_visible / blinded", async () => {
  const runs = [];
  for (const sessionType of ["tab_visible", "blinded"] as const) for (const arm of ["on", "shadow"] as const) {
    const r = await run({ sessionType, arm, actor: mockActor({ delayMs: 15 }), judge: new MockJudgeBackend(() => 25) });
    runs.push({ sessionType, arm, ...r });
  }
  const shape = (r: (typeof runs)[number]) => ({
    actor: r.actor.calls.length, judge: r.judge.reqs.length,
    lj: of(r.log.lines, "leak_judge").map((x) => [x.turn, x.deadline_ms, x.status]),
  });
  const ref = shape(runs[0]!);
  assert.ok(ref.judge >= 3);
  for (const r of runs) assert.deepEqual(shape(r), ref, `${r.sessionType}/${r.arm}`);
  // judged turns wait actor (parallel, once) + judge in every arm: compare per-turn wall time across arms
  const judged = of(runs[0]!.log.lines, "leak_judge").map((x) => x.turn - 1); // send index = request turn - 1
  for (const r of runs) for (const i of judged) {
    assert.ok(r.turnMs[i]! >= 15 + 25 - 3, `${r.sessionType}/${r.arm} turn ${i}: ${r.turnMs[i]}`);
    assert.ok(Math.abs(r.turnMs[i]! - runs[0]!.turnMs[i]!) < 50, `${r.sessionType}/${r.arm} turn ${i} parity: ${r.turnMs[i]} vs ${runs[0]!.turnMs[i]}`);
  }
  // the judge input in a shadow arm is the as-if-injected reply (the hint was in the Actor request)
  const sh = runs.find((r) => r.arm === "shadow")!;
  assert.ok(sh.judge.reqs.every((q) => /For example/.test(parseJudgeUserMessage(q.user).input.text)));
  // a judge slower than the deadline: every note dropped in every arm, each turn returns at actor + deadline
  for (const arm of ["on", "shadow"] as const) {
    const r = await run({ arm, sessionType: "blinded", actor: mockActor({ delayMs: 5 }), judge: new MockJudgeBackend(() => 500), deadline: 40, turns: 5 });
    const lj = of(r.log.lines, "leak_judge");
    assert.ok(lj.length >= 2 && lj.every((x) => x.status === "timeout" && x.verdict === "uncertain" && x.dropped && x.deadline_ms === 40));
    for (const x of lj) assert.ok(r.turnMs[x.turn - 1]! < 300, `${arm}: turn waits for the deadline, not the judge`);
  }
});

test("leak judge: sealed-only: the blinded main log has no leak_judge / note_dropped and passes the guard; the sealed log has them", async () => {
  assert.ok(SEALED_ONLY_TYPES.includes("leak_judge"));
  const blinding = JSON.parse(readFileSync(join(import.meta.dirname, "../src/ad-contracts/blinding.json"), "utf8"));
  assert.ok(blinding.sealedOnlyTypes.includes("leak_judge"));
  const { log, storage } = await run({ sessionType: "blinded", arm: "on", actor: mockActor({ leak: true }) });
  const main = storage.read("blinded", log.sessionId), sealed = storage.read("sealed", log.sessionId);
  assert.deepEqual(blindedGuard(log.sessionId, main), { ok: true });
  assert.deepEqual(blindedGuard(log.sessionId + ".sealed", sealed, main), { ok: true });
  assert.ok(!main.includes("leak_judge") && !main.includes("note_dropped") && !main.includes("leak_breaker"));
  assert.ok(sealed.includes('"type":"leak_judge"') && sealed.includes('"reason":"leak_judge"'));
  // check_blinding.mjs flags a leak_judge line in a blinded main log
  const dir = mkdtempSync(join(tmpdir(), "lj-")), f = join(dir, "main.jsonl");
  const lj = sealed.split("\n").find((l) => l.includes('"type":"leak_judge"'))!;
  writeFileSync(f, main.split("\n").filter(Boolean).slice(0, 1).concat([lj]).join("\n") + "\n");
  const root = join(import.meta.dirname, "../../..");
  const chk = (file: string) => spawnSync(process.execPath, [join(root, "tools/phaseD/check_blinding.mjs"), file], { encoding: "utf8" });
  const g = join(dir, "clean.jsonl"); writeFileSync(g, main);
  assert.equal(chk(g).status, 0, "the real blinded main log passes check_blinding");
  const bad = chk(f);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /:2: bh-ad\/1 blinded main log: sealed_type/);
});

test("leak judge: a flagged as-if-injected reply is dropped (never shown), counts toward the breaker in every arm", async () => {
  for (const arm of ["on", "shadow"] as const) {
    const { log } = await run({ arm, turns: 10, actor: mockActor({ leak: true }) });
    const L = log.lines;
    const lj = of(L, "leak_judge");
    assert.ok(lj[0]!.verdict === "flagged" && lj[0]!.codes.includes("provenance") && lj[0]!.dropped, arm);
    assert.ok(of(L, "note_dropped").some((d) => d.reason === "leak_judge" && d.note_id === lj[0]!.note_id));
    assert.ok(of(L, "actor_turn").every((a) => !/I was told/.test(a.text)), `${arm}: the leaking reply is never displayed`);
    assert.ok(of(L, "actor_turn").every((a) => a.note_id === null), "nothing injected");
    assert.ok(!of(L, "note_outcome").some((o) => o.note_id === lj[0]!.note_id), "a dropped note has no outcome");
    const h = L.findIndex((l) => l.type === "health" && l.code === "director.leak_breaker");
    assert.ok(h > 0 && lj.length === 2, `${arm}: breaker after 2 drops`);
    const later = of(L.slice(h), "rail_check");
    assert.ok(later.length > 0 && later.every((r) => !r.pass && r.blocked_by.includes("leak_breaker")));
    assert.equal(of(L.slice(h), "injection").length, 0);
    // v1.3: the tab (tab_visible) shows only a generic "note dropped", from full lines or from the visible log alike
    for (const lines of [L, log.tabLines]) {
      const card = buildTabModel(lines).cards.find((c) => c.noteId === lj[0]!.note_id)!;
      assert.equal(card.state, "dropped"); assert.equal(card.reason, "note dropped");
    }
  }
});

test("leak judge v1.3: verdicts are sealed-only in EVERY session type (tab_visible too), through one projection", async () => {
  const blinding = JSON.parse(readFileSync(join(import.meta.dirname, "../src/ad-contracts/blinding.json"), "utf8"));
  assert.deepEqual(blinding.sealedEverywhereTypes, ["leak_judge"]);
  for (const sessionType of ["tab_visible", "blinded"] as const) {
    const { log, storage } = await run({ sessionType, arm: "on", turns: 10, actor: mockActor({ leak: true }) });
    const ns = sessionType === "blinded" ? "blinded" : "visible";
    const main = storage.read(ns, log.sessionId)!, sealed = storage.read("sealed", log.sessionId)!;
    assert.ok(sealed.includes('"type":"leak_judge"') && sealed.includes('"reason":"leak_judge"'), `${sessionType}: the sealed log keeps the verdicts`);
    assert.ok(!main.includes('"type":"leak_judge"') && !main.includes('"reason":"leak_judge"') && !main.includes("judge_prompt_id"), `${sessionType}: no verdict in the main log`);
    assert.ok(!log.tabLines.some((l) => l.type === "leak_judge" || (l.type === "note_dropped" && l.reason === "leak_judge")));
    assert.deepEqual(blindedGuard(log.sessionId, main), { ok: true });
    assert.deepEqual(blindedGuard(log.sessionId + ".sealed", sealed, main), { ok: true });
    assert.equal(log.guardDrops, 0);
    if (sessionType === "tab_visible") {
      assert.ok(main.includes('"reason":"withheld"'), "tab_visible: the drop itself is visible, generically");
      assert.ok(main.includes('"arm":"on"'), "tab_visible still carries the arm openly");
      // the guard refuses a tab_visible main log with a verdict line or the leak_judge reason
      const lj = sealed.split("\n").find((l) => l.includes('"type":"leak_judge"'))!;
      const nd = sealed.split("\n").find((l) => l.includes('"reason":"leak_judge"'))!;
      assert.equal((blindedGuard(log.sessionId, main + lj + "\n") as { code: string }).code, "sealed_everywhere");
      assert.equal((blindedGuard(log.sessionId, main + nd + "\n") as { code: string }).code, "sealed_everywhere");
      // check_blinding.mjs flags both in a tab_visible log too
      const dir = mkdtempSync(join(tmpdir(), "ljv-"));
      const root = join(import.meta.dirname, "../../..");
      const chk = (file: string) => spawnSync(process.execPath, [join(root, "tools/phaseD/check_blinding.mjs"), file], { encoding: "utf8" });
      const clean = join(dir, "vis.jsonl"); writeFileSync(clean, main);
      assert.equal(chk(clean).status, 0, chk(clean).stdout);
      const bad = join(dir, "vis-bad.jsonl"); writeFileSync(bad, main + lj + "\n" + nd + "\n");
      const b = chk(bad);
      assert.equal(b.status, 1, b.stdout + b.stderr);
      assert.match(b.stdout, /tab_visible log: sealed_everywhere \(leak_judge\)/);
      assert.match(b.stdout, /tab_visible log: sealed_everywhere \(note_dropped reason leak_judge\)/);
    }
    // the tab fold re-applies the same projection to whatever it is given
    assert.deepEqual(tabSafeLines(log.lines).filter((l) => l.type === "leak_judge"), []);
  }
});
