/**
 * E7: offline replay harness (spec "Offline replay harness"). Reruns the pipeline, the Director and the rails over
 *  - a logged session (bh-ad/1 lines: the logged reading digests + user turns + timings), or
 *  - R2 synthetic gaze files (bh-gaze-replay/1: the gaze pipeline itself reruns from the samples),
 * in mode "off" (no Director), "shadow" (the Director runs, nothing is injected) or "on" (every rail-passing note
 * that passes the leak gate is injected; pInject 1 unless given), with the frozen or a candidate Director prompt.
 * Counterfactual: every rail-passing note produces both Actor replies (plain and as-if-injected; the session's leak
 * gate already asks for both), and a sample of those turns is compared pairwise by the judge.
 *
 * Phase 1 is mock only: the default Actor for a logged session returns the LOGGED reply for that turn (plain
 * request) and the logged reply plus one mock follow sentence for an as-if-injected request; the pairwise judge is
 * MockPairwiseJudge (heuristics: answers first, no leak codes, no hint echo). It is NOT a model judgment; a live
 * judge plugs in through `pairwise` (needs the judge-token approval). Browser-safe: no fs, no network.
 */
import type { Arm, AttentionEvent, BhAdEvent, HealthCode, ReadingDigest } from "../ad-contracts/index.js";
import { HINT_HEADER } from "../ad-contracts/index.js";
import { OPENER_CUE } from "../backends.js";
import { GAZE_DEFAULTS } from "./gaze-ref.js";
import { MockAdBackend, type AdChatBackend, type AdChatRequest, type AdChatResult } from "./director.js";
import { ActorDirectorSession } from "./session.js";
import { AdSessionLog, ManualClock } from "./log.js";
import { AdStorage } from "./storage.js";
import { checkLeaksSync } from "./leaks.js";
import { runSimSession, simDirector, simActor, type SimReplay } from "./sim-session.js";
import { sha8 } from "./director-prompt.js";
import type { TokenCounter } from "./tokenizer.js";
import type { KeyValueStore } from "../platform/kv.js";

export type ReplayMode = "off" | "shadow" | "on";
export const REPLAY_MODES: readonly ReplayMode[] = ["off", "shadow", "on"];
const ARM: Record<ReplayMode, Arm> = { off: "off", shadow: "shadow", on: "on" };

export interface PairwiseVerdict { winner: "injected" | "plain" | "tie"; why: string }
export interface PairwiseJudge { readonly id: string; compare(x: { user: string; plain: string; injected: string; hint: string }): Promise<PairwiseVerdict> | PairwiseVerdict }

/** heuristic stand-in for the judge's pairwise call (spec eval 3): fewer leak codes > answers first > tie */
export class MockPairwiseJudge implements PairwiseJudge {
  readonly id = "mock-pairwise-heuristic";
  compare(x: { user: string; plain: string; injected: string; hint: string }): PairwiseVerdict {
    const li = checkLeaksSync({ text: x.injected, context: x.user, note: x.hint });
    const lp = checkLeaksSync({ text: x.plain, context: x.user, note: "" });
    if (li.codes.length !== lp.codes.length) return li.codes.length < lp.codes.length ? { winner: "injected", why: "fewer leak codes" } : { winner: "plain", why: `injected leaks: ${li.codes.join(", ")}` };
    if (li.answeredFirst === false && lp.answeredFirst !== false) return { winner: "plain", why: "injected did not answer first" };
    if (x.injected.trim() === x.plain.trim()) return { winner: "tie", why: "identical" };
    return { winner: "tie", why: "no heuristic difference (a model judge is needed to separate them)" };
  }
}

/** the Actor reply turn a request is for: 0 for the opener cue, else the number of user messages (reply to u(T-1) is aT) */
export function replyTurnOf(req: AdChatRequest): number {
  const users = req.messages.filter((m) => m.role === "user");
  return users[users.length - 1]?.content === OPENER_CUE ? 0 : users.length;
}
/** records every Actor request/reply by the reply's turn */
export class RecordingActor implements AdChatBackend {
  readonly id: string;
  readonly byTurn = new Map<number, { plain?: string; injected?: string; hint?: string; user: string }>();
  constructor(private inner: AdChatBackend) { this.id = inner.id; }
  async complete(req: AdChatRequest): Promise<AdChatResult> {
    const r = await this.inner.complete(req);
    const users = req.messages.filter((m) => m.role === "user");
    const k = replyTurnOf(req);
    const sys = req.messages[0]?.content ?? "";
    const at = sys.indexOf(HINT_HEADER);
    const e = this.byTurn.get(k) ?? { user: users[users.length - 1]?.content ?? "" };
    if (at >= 0) { e.injected = r.text; e.hint = sys.slice(at); } else e.plain = r.text;
    this.byTurn.set(k, e);
    return r;
  }
}

/** a logged session reduced to what the replay drives: per turn the digest that closed a(T) and the user's text */
export interface LoggedSession {
  sessionId: string;
  sourceArm: Arm | null;
  opener: string | null;
  turns: Array<{ turn: number; user: string; digest: ReadingDigest | null; events: AttentionEvent[]; actorText: string | null; holdGapMs: number; baselineParagraphs: number }>;
  directorInputs: Map<number, string>;
}
export function parseLoggedSession(lines: readonly BhAdEvent[]): LoggedSession {
  const start = lines.find((l) => l.type === "session_start") as Extract<BhAdEvent, { type: "session_start" }> | undefined;
  const actor = new Map<number, string>(), digest = new Map<number, Extract<BhAdEvent, { type: "attention_digest" }>>(), dirIn = new Map<number, string>();
  const users: Array<Extract<BhAdEvent, { type: "user_turn" }>> = [];
  let lastMono = 0;
  for (const l of lines) {
    if (l.type === "actor_turn") actor.set(l.turn, l.text);
    else if (l.type === "attention_digest") digest.set(l.turn, l);
    else if (l.type === "user_turn") users.push(l);
    else if (l.type === "director_call") dirIn.set(l.turn, l.input_sha256);
  }
  // the reading-speed baseline size is not logged; rebuild it as the live session does (F-BASELINE): every paragraph
  // read so far (ratio > 0, >= baseline_min_words words in the logged reply's paragraph), capped at baseline_max
  const c = GAZE_DEFAULTS;
  let base = 0;
  const turns = users.sort((a, b) => a.turn - b.turn).map((u) => {
    const d = digest.get(u.turn) ?? null;
    const gap = Math.max(0, u.mono - lastMono); lastMono = u.mono;
    if (d) {
      const paras = (actor.get(d.turn) ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      for (const p of d.digest.paras) {
        const idx = Number(/\.p(\d+)$/.exec(p.aoi)?.[1] ?? 0) - 1;
        const words = (paras[idx] ?? p.excerpt).split(/\s+/).filter(Boolean).length;
        if (p.ratio > 0 && words >= c.baseline_min_words) base = Math.min(base + 1, c.baseline_max);
      }
    }
    return { turn: u.turn, user: u.text, digest: d?.digest ?? null, events: d?.events ?? [], actorText: actor.get(u.turn + 1) ?? null, holdGapMs: gap, baselineParagraphs: base };
  });
  return { sessionId: start?.sessionId ?? "unknown", sourceArm: start?.arm ?? null, opener: actor.get(0) ?? null, turns, directorInputs: dirIn };
}

/** mock counterfactual: when the Actor request carries a hint, append the hint's suggestion as a marked line so the
 *  injected reply differs from the plain one (mock Actors ignore hints; a real Actor would weave it in) */
export function counterfactualText(req: AdChatRequest, base: string): string {
  const sys = req.messages[0]!.content;
  const sug = sys.includes(HINT_HEADER) ? /If it fits after answering them: (.*?)\.?(?: \(h:|$)/m.exec(sys)?.[1] : undefined;
  return sug ? `${base}\n\n(mock counterfactual) ${sug.charAt(0).toUpperCase()}${sug.slice(1)}.` : base;
}
export function withCounterfactual(inner: AdChatBackend): AdChatBackend {
  return { id: inner.id, complete: async (req) => { const r = await inner.complete(req); return { ...r, text: counterfactualText(req, r.text) }; } };
}
export function loggedActor(s: LoggedSession): MockAdBackend {
  return new MockAdBackend([], (req) => {
    const k = replyTurnOf(req);
    const base = k === 0 ? s.opener ?? "Hi! What's on your mind?" : s.turns[k - 1]?.actorText ?? "Here is a direct answer.";
    return { text: counterfactualText(req, base) };
  });
}

export interface ReplaySummary {
  mode: ReplayMode; source: string; turns: number; director_prompt_id: string; director_calls: number; notes: number; rails_passed: number;
  injected: number; shadow: number; blocked: number; leak_judge: Record<string, number>; session_share: number | null; health: HealthCode[];
  pairwise: { judge: string; sampled: number; injected: number; plain: number; tie: number };
  director_inputs_matching_source: number | null; network_calls: number;
}
export interface ReplayRun { summary: ReplaySummary; lines: BhAdEvent[]; pairs: Array<{ turn: number; note_id: string | null } & PairwiseVerdict> }

export interface ReplayCommon {
  mode: ReplayMode; counter: TokenCounter; kv: KeyValueStore; seed?: number; pInject?: number;
  director?: AdChatBackend; actor?: AdChatBackend; judgeBackend?: AdChatBackend;
  directorPrompt?: { id: string; assemble: (withExamples: boolean) => string };
  pairwise?: PairwiseJudge; pairSample?: number;
  /** counts fetch calls made during the run (the CLI and tests install a throwing fetch); reported in the summary */
  networkCalls?: () => number;
}

function summarize(o: ReplayCommon, source: string, lines: BhAdEvent[], pairs: ReplayRun["pairs"], pjId: string, matching: number | null): ReplaySummary {
  const start = lines.find((l) => l.type === "session_start") as Extract<BhAdEvent, { type: "session_start" }> | undefined;
  const of = <T extends BhAdEvent["type"]>(t: T) => lines.filter((l) => l.type === t) as Array<Extract<BhAdEvent, { type: T }>>;
  const share = of("session_share")[0];
  const lj: Record<string, number> = {};
  for (const l of of("leak_judge")) lj[l.verdict] = (lj[l.verdict] ?? 0) + 1;
  const ljDropped = new Set(of("note_dropped").filter((d) => d.reason === "leak_judge").map((d) => d.note_id));
  const rails = of("rail_check");
  return {
    mode: o.mode, source, turns: of("session_end")[0]?.turns ?? share?.turns ?? 0, director_prompt_id: start?.director_prompt_id ?? "unknown",
    director_calls: of("director_call").length, notes: rails.length, rails_passed: rails.filter((r) => r.pass).length,
    injected: of("injection").filter((i) => i.decision === "inject" && !ljDropped.has(i.note_id)).length,
    shadow: of("injection").filter((i) => i.decision === "shadow" && !ljDropped.has(i.note_id)).length,
    blocked: rails.filter((r) => !r.pass).length + ljDropped.size,
    leak_judge: lj, session_share: share?.session_share ?? null,
    health: [...new Set(of("health").filter((h) => !h.ok && h.code).map((h) => h.code as HealthCode))],
    pairwise: { judge: pjId, sampled: pairs.length, injected: pairs.filter((p) => p.winner === "injected").length, plain: pairs.filter((p) => p.winner === "plain").length, tie: pairs.filter((p) => p.winner === "tie").length },
    director_inputs_matching_source: matching, network_calls: o.networkCalls?.() ?? 0,
  };
}

async function pairwiseFor(o: ReplayCommon, rec: RecordingActor, lines: BhAdEvent[]): Promise<ReplayRun["pairs"]> {
  const pj = o.pairwise ?? new MockPairwiseJudge();
  const rate = Math.max(0, Math.min(1, o.pairSample ?? 1));
  if (rate === 0) return [];
  const injections = lines.filter((l): l is Extract<BhAdEvent, { type: "injection" }> => l.type === "injection");
  const out: ReplayRun["pairs"] = [];
  let i = 0;
  for (const inj of injections) {
    const e = rec.byTurn.get(inj.turn);
    if (!e?.plain || !e.injected || !e.hint) continue;
    // deterministic systematic sample: every round(1/rate)-th counterfactual pair
    if (rate < 1 && i++ % Math.max(1, Math.round(1 / rate)) !== 0) continue;
    out.push({ turn: inj.turn, note_id: inj.note_id, ...(await pj.compare({ user: e.user, plain: e.plain, injected: e.injected, hint: e.hint })) });
  }
  return out;
}

/** replay a logged session (the gaze pipeline does not rerun: the logged digests drive the Director) in one mode */
export async function replayLog(lines: readonly BhAdEvent[], o: ReplayCommon): Promise<ReplayRun> {
  const src = parseLoggedSession(lines);
  const storage = await AdStorage.open(o.kv);
  const clock = new ManualClock();
  const log = new AdSessionLog(storage, `replay-${src.sessionId}-${o.mode}`, "tab_visible", clock);
  const rec = new RecordingActor(o.actor ?? loggedActor(src));
  const s = new ActorDirectorSession({
    log, userId: "replay", sessionType: "tab_visible", arm: ARM[o.mode], pInject: o.pInject ?? (o.mode === "on" ? 1 : 0),
    actor: rec, director: o.director ?? simDirector(), counter: o.counter, consent: { camera: true, rawGaze: false }, seed: o.seed ?? 7,
    directorEnabled: () => o.mode !== "off", sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
    ...(o.judgeBackend ? { judgeBackend: o.judgeBackend } : {}), ...(o.directorPrompt ? { directorPrompt: o.directorPrompt } : {}),
  });
  s.start();
  await s.opener();
  for (const t of src.turns) {
    if (t.digest) s.observeReading({ digest: t.digest, events: t.events, faceFrac: 0.95, baselineParagraphs: t.baselineParagraphs });
    clock.advance(Math.max(800, t.holdGapMs));
    await s.send(t.user);
  }
  await s.end("replay_end");
  const out = log.lines.slice();
  const pairs = await pairwiseFor(o, rec, out);
  let matching = 0;
  for (const d of out) if (d.type === "director_call" && src.directorInputs.get(d.turn) === d.input_sha256) matching++;
  return { summary: summarize(o, `log:${src.sessionId}`, out, pairs, (o.pairwise ?? new MockPairwiseJudge()).id, matching), lines: out, pairs };
}

/** replay R2 synthetic gaze files (the gaze pipeline reruns from the samples) in one mode */
export async function replayR2(replays: SimReplay[], o: ReplayCommon & { turns?: number; name?: string }): Promise<ReplayRun> {
  const rec = new RecordingActor(o.actor ?? withCounterfactual(simActor(replays)));
  const sim = await runSimSession({
    turns: o.turns ?? 20, sessionType: "tab_visible", arm: ARM[o.mode], pInject: o.pInject ?? (o.mode === "on" ? 1 : 0), counter: o.counter, replays, kv: o.kv,
    sessionId: `replay-${o.name ?? replays[0]?.name ?? "r2"}-${o.mode}`, seed: o.seed ?? 7, actor: rec, director: o.director ?? simDirector(),
    directorEnabled: () => o.mode !== "off", ...(o.judgeBackend ? { judgeBackend: o.judgeBackend } : {}), ...(o.directorPrompt ? { directorPrompt: o.directorPrompt } : {}),
  });
  const pairs = await pairwiseFor(o, rec, sim.lines);
  return { summary: summarize(o, `r2:${o.name ?? replays.map((r) => r.name).join("+")}`, sim.lines, pairs, (o.pairwise ?? new MockPairwiseJudge()).id, null), lines: sim.lines, pairs };
}

/** a candidate Director prompt from text: id "dir0-<sha8>" (dir0 = unversioned candidate; the frozen one is dir1-...) */
export function candidateDirectorPrompt(text: string): { id: string; assemble: (withExamples: boolean) => string } {
  return { id: `dir0-${sha8(text)}`, assemble: () => text };
}
