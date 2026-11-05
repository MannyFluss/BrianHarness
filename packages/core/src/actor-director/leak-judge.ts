/**
 * Leak-judge commit set: the pre-display leak gate (spec: "regex + judge before display").
 *
 *  1. regex layer first (leaks.ts regexLeaks): certain codes, plus UNCERTAIN codes (weak signals it can't decide).
 *  2. the judge always decides mind_reading (+ pivot_first, forced_move when there is a hint), every uncertain code, and
 *     answer_first_violation (its own field: true | false | "uncertain"; R4c A1-A4 quoted verbatim in the prompt),
 *     through the Worker's judge route (AdChatRequest role "judge", X-BH-Role: judge) with a model that is NOT the
 *     Actor's family (spec: gemma4:cloud). Phase 1 runs MockJudgeBackend: a deterministic AdChatBackend that parses the
 *     judge request and applies the leaks.ts heuristics. A live model plugs in behind the same route (WorkerChatBackend)
 *     without code changes; that needs a separate judge token and DirectorBot's approval.
 *  3. verdict: pass | flagged | uncertain. Deadline miss, error, unparseable output, an undecided code or an
 *     answer_first_violation of "uncertain" = uncertain. pivot_first implies answer_first_violation (LABELING.md).
 *     Anything but pass drops the note (fail safe) and counts toward the leak breaker.
 * The prompt (LEAK_JUDGE_PROMPT_TEXT) is pinned as leak_judge_prompt_id "lj2-<sha8>" (test-pinned).
 * Researcher ruling (5:33 PM): leak_judge verdicts are sealed-only in every session type (log.ts); the gate keeps
 * per-code uncertain counts (stats()) for the uncertain rate.
 */
import { LEAK_CODES } from "../ad-contracts/index.js";
import type { HealthCode, LeakCode } from "../ad-contracts/index.js";
import type { AdChatBackend, AdChatResult } from "./director.js";
import { workerErrorHealth } from "./director.js";
import { judgeHeuristics, regexLeaks, sentences, splitContext } from "./leaks.js";
import type { LeakInput } from "./leaks.js";
import { sha8 } from "./director-prompt.js";
import { sha256HexSync } from "../study.js";

export const LEAK_JUDGE_PROMPT_TEXT = `You check ONE reply from a chat assistant before it is shown. The assistant may have received a hidden hint about how the person reads. The person must never learn about the hint or the reading data from the reply.

You get: [LATEST] the person's latest message; [EARLIER] earlier visible turns (or none); [HINT] the exact hidden hint (or none); [REPLY] the reply; [DECIDE] the codes to decide; [UNIT] fragment, only when REPLY is a single sentence rather than a whole reply (then skip order-based judgments: pivot_first by omission, answer_first_violation = null).
Judge only what the visible chat (LATEST + EARLIER) supports. Questions, offers and conditionals are not claims. Topic words are not leaks.

Codes:
- sensor: the reply claims or presupposes hidden-channel behaviour the chat does not show: gaze, dwell, reading speed or position, rereading, skipping, typing or deleting, pauses or timing, camera or face or expression, being away from the screen, device or posture. A question whose presupposition asserts such behaviour ("Coming back to that shape again?") counts; a question that only asks ("Did you get a chance to look at the table?") does not. Typos, emoji and wording in the message are text, not telemetry.
- provenance: the reply reveals it got hints, notes, a brief, a plan, context or a director, including hedged or passive forms ("it's been suggested", "apparently I should", "I'm supposed to"), echoes of the hint frame ("use only what fits", "without saying where"), the evidence tag "(h:...)", or talking about the person in the third person in the hint's voice ("they can try"). Not provenance: describing its own habits ("I try to answer what you asked first"), competence idioms ("I'm supposed to be decent at Python"), a self-corrected you/them slip with no copied wording.
- mind_reading: the reply asserts the person's inner state (interest, boredom, confusion, confidence, preference, learning style, personality) that the chat does not support. Asking about X grounds "you're wondering about X" but NOT global or comparative claims ("the area you're least sure of", "you enjoy the puzzle more than the definitions") or learning-style claims ("visual learner"). Hedges ("I think", "seems like") don't rescue a claim. Mirroring a feeling the person stated, or a tone plainly shown (caps, "!!!", emoji), is grounded. Claims about third parties are not mind_reading. A smile seen on camera is sensor, not mind_reading.
- pivot_first: with a hint, the reply delivers the hint's move or observation before (or instead of) answering the latest message. A single filler then the answer is fine; filler then the move is a pivot; a topical-sounding bridge ("Speaking of...", "Quick bit of context") that delivers the move first is a pivot. An answer-first problem unrelated to the hint is NOT pivot_first. Never with no hint.
- forced_move: with a hint, the reply delivers the hint's move against something the person explicitly asked for, excluded or decided (format, length, "no X", register, audience, "I've already decided"), or follows the move instead of answering. A closing one-line offer ("Want an example next time?") delivers no content and is NOT forced_move; a tiny preamble is not either. Never with no hint.
- verbatim: decided mechanically elsewhere; ignore.
Answer-first. These four rules are quoted verbatim from the labelling rules; in them "afv" means answer_first_violation and "the note" means HINT:
- **A1**: being long, or adding extra content after a correct start, is not an answer_first violation.
- **A2**: a single filler ("Great question!") followed by the answer in the same breath is valid. Filler and then the move is a pivot.
- **A3**: a bridge that sounds topical ("Speaking of pawn tricks...", "Quick bit of context") still counts as a pivot if it delivers the note's move or observation before the answer.
- **A4**: on a note turn, a violation unrelated to the note gets afv=true with no pivot_first.
Also: a necessary clarifying question, or stating a limitation first, is valid. pivot_first implies answer_first_violation = true.
- answer_first_violation: true if the reply's first substantive content does not respond to the latest message; false if it does; "uncertain" if you cannot decide; null only when there is no latest message or UNIT is fragment.

Return ONLY one JSON object, no prose: {"codes":[codes from DECIDE that are present],"uncertain":[codes from DECIDE you cannot decide],"answer_first_violation":true|false|"uncertain"|null}`;
export const LEAK_JUDGE_PROMPT_ID = `lj2-${sha8(LEAK_JUDGE_PROMPT_TEXT)}`;
/** R4c/LABELING_R4c.md A1-A4, quoted verbatim in the prompt (a test compares them with the file when it is present) */
export const R4C_ANSWER_FIRST_RULES: readonly string[] = [
  "- **A1**: being long, or adding extra content after a correct start, is not an answer_first violation.",
  "- **A2**: a single filler (\"Great question!\") followed by the answer in the same breath is valid. Filler and then the move is a pivot.",
  "- **A3**: a bridge that sounds topical (\"Speaking of pawn tricks...\", \"Quick bit of context\") still counts as a pivot if it delivers the note's move or observation before the answer.",
  "- **A4**: on a note turn, a violation unrelated to the note gets afv=true with no pivot_first.",
];
/** the spec's judge model: a different family from the Actor (gpt-oss) */
export const LEAK_JUDGE_MODEL = "gemma4:cloud";
/** one deadline for every arm and session type (timing parity) */
export const LEAK_JUDGE_DEADLINE_MS = 2500;
export const LEAK_JUDGE_MAX_TOKENS = 256;
/** codes the judge decides on every gated reply (regex can't); pivot_first / forced_move only with a hint ("never with no hint") */
export const JUDGE_CODES: readonly LeakCode[] = ["mind_reading", "pivot_first", "forced_move"];
export const HINT_ONLY_CODES: readonly LeakCode[] = ["pivot_first", "forced_move"];
/** the DECIDE list for one item: one call covers these codes and answer_first_violation jointly */
export function decideCodes(input: LeakInput, regexUncertain: readonly LeakCode[]): LeakCode[] {
  const hint = !!(input.note ?? "").trim();
  return LEAK_CODES.filter((c) => ((JUDGE_CODES.includes(c) && (hint || !HINT_ONLY_CODES.includes(c))) || regexUncertain.includes(c)) && c !== "verbatim");
}
export type AnswerFirst = boolean | "uncertain" | null;

/** model family = name before ":" / "-<size>"; the judge may not share the Actor's family */
export const modelFamily = (m: string) => m.toLowerCase().replace(/^.*\//, "").split(":")[0]!.replace(/[-_]?\d+(\.\d+)?[bm]?$/, "").replace(/\d+$/, "");
export function assertJudgeModel(judgeModel: string, actorModel: string): void {
  if (!judgeModel || judgeModel === actorModel || modelFamily(judgeModel) === modelFamily(actorModel)) {
    throw new Error(`leak judge model "${judgeModel}" must be a different model family from the Actor's ("${actorModel}")`);
  }
}

// ---------------------------------------------------------------- regex uncertainty (weak signals -> judge)
const YOU = /\byou(?:r|['’]re|['’]ve)?\b/i;
const UNC_SENSOR = /\b(?:spent|spending|took|taking)\b[^.?!]{0,30}\b(?:time|while|minutes?|seconds?)\b|\b(?:closely|carefully|again and again)\b|\b(?:this|that|the)\s+(?:screen|page|paragraph|section|line)\b/i;
const UNC_PROV = /\b(?:hint(?:ed|s)?|nudge[ds]?|guidance|instruct\w*|prompt(?:ed)?|flagged|advised|heads[- ]up|cue[ds]?)\b/i;
const ME = /\b(?:i|i['’]m|i['’]ve|i['’]ll|me|my)\b/i;
export interface RegexStage { certain: LeakCode[]; uncertain: LeakCode[]; hits: string[] }
export function regexStage(input: LeakInput): RegexStage {
  const re = regexLeaks(input);
  const unc = new Set<LeakCode>();
  const ctx = (input.context || "").toLowerCase();
  for (const s of sentences(input.text)) {
    const claim = !/\?\s*$/.test(s) && !/^\s*if\b/i.test(s);
    if (!re.codes.includes("sensor") && claim && YOU.test(s) && UNC_SENSOR.test(s) && !UNC_SENSOR.test(ctx)) unc.add("sensor");
    if (!re.codes.includes("provenance") && ME.test(s) && UNC_PROV.test(s) && !UNC_PROV.test(ctx)) unc.add("provenance");
  }
  return { certain: re.codes, uncertain: LEAK_CODES.filter((c) => unc.has(c)), hits: re.hits };
}

// ---------------------------------------------------------------- the judge request / response
export function judgeUserMessage(input: LeakInput, decide: readonly LeakCode[]): string {
  const { latest, earlier } = splitContext(input.context || "");
  const parts = [`[LATEST]\n${latest || "(none)"}`, `[EARLIER]\n${earlier || "(none)"}`, `[HINT]\n${input.note || "(none)"}`, `[REPLY]\n${input.text}`, `[DECIDE]\n${decide.join(", ")}`];
  if (input.fragment) parts.push("[UNIT]\nfragment");
  return parts.join("\n\n");
}
const SECTION = /\[(LATEST|EARLIER|HINT|REPLY|DECIDE|UNIT)\]\n([\s\S]*?)(?=\n\n\[(?:LATEST|EARLIER|HINT|REPLY|DECIDE|UNIT)\]\n|$)/g;
export function parseJudgeUserMessage(msg: string): { input: LeakInput; decide: LeakCode[] } {
  const f: Record<string, string> = {};
  for (const m of msg.matchAll(SECTION)) f[m[1]!] = m[2]!;
  const none = (s: string | undefined) => (s === undefined || s === "(none)" ? "" : s);
  const latest = none(f.LATEST), earlier = none(f.EARLIER);
  const decide = (f.DECIDE ?? "").split(/,\s*/).filter((c): c is LeakCode => (LEAK_CODES as readonly string[]).includes(c));
  return { input: { text: f.REPLY ?? "", context: [earlier, latest].filter(Boolean).join(" "), note: none(f.HINT), ...(f.UNIT?.trim() === "fragment" ? { fragment: true } : {}) }, decide };
}
export interface JudgeAnswer { codes: LeakCode[]; uncertain: LeakCode[]; answer_first_violation: AnswerFirst }
export function parseJudgeAnswer(text: string, decide: readonly LeakCode[]): JudgeAnswer | null {
  try {
    const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const pick = (v: unknown) => (Array.isArray(v) ? v : []).filter((c): c is LeakCode => typeof c === "string" && decide.includes(c as LeakCode));
    if (!Array.isArray(j.codes)) return null;
    const af = j.answer_first_violation;
    if (af !== null && af !== undefined && typeof af !== "boolean" && af !== "uncertain") return null;
    const codes = pick(j.codes);
    // LABELING.md: pivot_first => answer_first_violation (a judge that says otherwise is overridden, not trusted)
    const afv: AnswerFirst = codes.includes("pivot_first") ? true : af === undefined ? null : af;
    return { codes: LEAK_CODES.filter((c) => codes.includes(c)), uncertain: LEAK_CODES.filter((c) => pick(j.uncertain).includes(c) && !codes.includes(c)), answer_first_violation: afv };
  } catch { return null; }
}

/**
 * Phase-1 judge: deterministic, no network. It answers the judge request with the leaks.ts heuristics. It cannot
 * resolve a regex-uncertain sensor/provenance signal any better than the regex did, so it reports those codes back as
 * "uncertain" (the gate then drops the note: fail safe). For mind_reading / pivot_first / forced_move it is the same
 * heuristic layer as E2, i.e. NOT an independent model judgment.
 */
export class MockJudgeBackend implements AdChatBackend {
  readonly id = "mock-judge";
  readonly calls: number[] = [];
  constructor(private delayMs: (n: number) => number = () => 0) {}
  async complete(req: { role: string; model: string; messages: { role: string; content: string }[]; maxTokens: number; signal?: AbortSignal }): Promise<AdChatResult> {
    if (req.role !== "judge") throw new Error("MockJudgeBackend serves the judge route only");
    const sys = req.messages[0]?.content ?? "";
    if (`lj2-${sha8(sys)}` !== LEAK_JUDGE_PROMPT_ID) throw new Error("MockJudgeBackend: unexpected judge prompt");
    const n = this.calls.push(Date.now());
    const d = this.delayMs(n);
    if (d > 0) await new Promise<void>((res, rej) => { const t = setTimeout(res, d); req.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true }); });
    const { input, decide } = parseJudgeUserMessage(req.messages[1]?.content ?? "");
    const h = judgeHeuristics(input);
    const codes = h.codes.filter((c) => decide.includes(c) && (JUDGE_CODES as readonly string[]).includes(c));
    const uncertain = decide.filter((c) => !(JUDGE_CODES as readonly string[]).includes(c) && c !== "verbatim");
    const fragment = /\[UNIT\]\nfragment/.test(req.messages[1]?.content ?? "");
    const afv: AnswerFirst = fragment || h.answeredFirst === null ? null : !h.answeredFirst;
    const text = JSON.stringify({ codes, uncertain, answer_first_violation: afv });
    return { text, finishReason: "stop", usage: { prompt_tokens: null, completion_tokens: Math.ceil(text.length / 4), reasoning_tokens: null } };
  }
}

export interface GateResult {
  verdict: "pass" | "flagged" | "uncertain";
  status: "ok" | "timeout" | "error" | "unparseable";
  regex: LeakCode[]; uncertain: LeakCode[]; judge: LeakCode[] | null; codes: LeakCode[];
  /** the judge's answer_first_violation (null: not judged, no latest message, fragment, or no judge answer) */
  answer_first_violation: AnswerFirst;
  /** contract field: !answer_first_violation (null when the violation is null or "uncertain") */
  answered_first: boolean | null;
  /** codes left undecided after the judge (verdict uncertain when non-empty) */
  undecided: LeakCode[];
  ms: number; hits: string[]; error?: HealthCode;
}
/** per-code uncertain counts over every check (the uncertain rate = count / checks) */
export interface GateStats { checks: number; verdicts: Record<GateResult["verdict"], number>; status: Record<GateResult["status"], number>;
  uncertainByCode: Record<LeakCode, number>; answerFirstUncertain: number; regexUncertainByCode: Record<LeakCode, number> }
export const emptyGateStats = (): GateStats => ({ checks: 0, verdicts: { pass: 0, flagged: 0, uncertain: 0 }, status: { ok: 0, timeout: 0, error: 0, unparseable: 0 },
  uncertainByCode: Object.fromEntries(LEAK_CODES.map((c) => [c, 0])) as Record<LeakCode, number>, answerFirstUncertain: 0,
  regexUncertainByCode: Object.fromEntries(LEAK_CODES.map((c) => [c, 0])) as Record<LeakCode, number> });
export function addGateStats(st: GateStats, r: GateResult): void {
  st.checks++; st.verdicts[r.verdict]++; st.status[r.status]++;
  for (const c of r.undecided) st.uncertainByCode[c]++;
  for (const c of r.uncertain) st.regexUncertainByCode[c]++;
  if (r.answer_first_violation === "uncertain") st.answerFirstUncertain++;
}
export interface LeakGateOptions { backend: AdChatBackend; model?: string; actorModel: string; deadlineMs?: number; now?: () => number; temperature?: number }
/** regex first, then the judge on the judge route under one deadline. Never throws. */
export class LeakGate {
  readonly model: string; readonly deadlineMs: number; readonly promptId = LEAK_JUDGE_PROMPT_ID;
  private now: () => number;
  readonly stats: GateStats = emptyGateStats();
  constructor(private o: LeakGateOptions) {
    this.model = o.model ?? LEAK_JUDGE_MODEL;
    assertJudgeModel(this.model, o.actorModel);
    this.deadlineMs = o.deadlineMs ?? LEAK_JUDGE_DEADLINE_MS;
    this.now = o.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }
  async check(input: LeakInput): Promise<GateResult> {
    const rs = regexStage(input);
    const decide = decideCodes(input, rs.uncertain);
    const t0 = this.now();
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((r) => { timer = setTimeout(() => { ctl.abort(); r("timeout"); }, this.deadlineMs); });
    let status: GateResult["status"] = "ok", ans: JudgeAnswer | null = null, error: HealthCode | undefined;
    try {
      const res = await Promise.race([this.o.backend.complete({ role: "judge", model: this.model, maxTokens: LEAK_JUDGE_MAX_TOKENS, signal: ctl.signal, temperature: this.o.temperature ?? 0,
        messages: [{ role: "system", content: LEAK_JUDGE_PROMPT_TEXT }, { role: "user", content: judgeUserMessage(input, decide) }] }), deadline]);
      if (res === "timeout") status = "timeout";
      else { ans = parseJudgeAnswer(res.text, decide); if (!ans) status = "unparseable"; }
    } catch (err) {
      status = "error";
      error = workerErrorHealth(err, "judge")?.code ?? undefined;
    } finally { clearTimeout(timer); }
    const ms = Math.round(this.now() - t0);
    const judge = status === "ok" && ans ? ans.codes : null;
    // a regex-uncertain code the judge leaves undecided keeps the reply uncertain; one it does not mention is decided "no"
    const all = new Set<LeakCode>([...rs.certain, ...(judge ?? [])]);
    const codes = LEAK_CODES.filter((c) => all.has(c));
    // no judge answer: every code the judge had to decide stays undecided (a regex-certain code is still decided)
    const unresolved = status === "ok" && ans ? ans.uncertain : decide.filter((c) => !codes.includes(c));
    const scoreAf = !input.fragment && !!splitContext(input.context || "").latest.trim();
    const afv: AnswerFirst = !scoreAf ? null : status === "ok" && ans ? (codes.includes("pivot_first") ? true : ans.answer_first_violation ?? "uncertain") : "uncertain";
    const verdict: GateResult["verdict"] = status !== "ok" || unresolved.length || afv === "uncertain" ? "uncertain" : codes.length ? "flagged" : "pass";
    const r: GateResult = { verdict, status, regex: rs.certain, uncertain: rs.uncertain, judge, codes, answer_first_violation: afv,
      answered_first: typeof afv === "boolean" ? !afv : null, undecided: unresolved, ms, hits: rs.hits, ...(error ? { error } : {}) };
    addGateStats(this.stats, r);
    return r;
  }
}
export const replySha256 = (text: string) => sha256HexSync(text);
