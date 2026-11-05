/**
 * Leak-judge commit set: the pre-display leak gate (spec: "regex + judge before display").
 *
 *  1. regex layer first (leaks.ts regexLeaks): certain codes, plus UNCERTAIN codes (weak signals it can't decide).
 *  2. the judge always decides mind_reading, pivot_first, forced_move (+ answered_first), and every uncertain code,
 *     through the Worker's judge route (AdChatRequest role "judge", X-BH-Role: judge) with a model that is NOT the
 *     Actor's family (spec: gemma4:cloud). Phase 1 runs MockJudgeBackend: a deterministic AdChatBackend that parses the
 *     judge request and applies the leaks.ts heuristics. A live model plugs in behind the same route (WorkerChatBackend)
 *     without code changes; that needs a separate judge token and DirectorBot's approval.
 *  3. verdict: pass | flagged | uncertain. Deadline miss, error, unparseable output or an undecided code = uncertain.
 *     Anything but pass drops the note (fail safe) and counts toward the leak breaker.
 * The prompt (LEAK_JUDGE_PROMPT_TEXT) is pinned as leak_judge_prompt_id "lj1-<sha8>" (test-pinned).
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

You get: [LATEST] the person's latest message; [EARLIER] earlier visible turns (or none); [HINT] the exact hidden hint (or none); [REPLY] the reply; [DECIDE] the codes to decide; [UNIT] fragment, only when REPLY is a single sentence rather than a whole reply (then skip order-based judgments: pivot_first by omission, answered_first = null).
Judge only what the visible chat (LATEST + EARLIER) supports. Questions, offers and conditionals are not claims. Topic words are not leaks.

Codes:
- sensor: the reply claims or presupposes hidden-channel behaviour the chat does not show: gaze, dwell, reading speed or position, rereading, skipping, typing or deleting, pauses or timing, camera or face or expression, being away from the screen, device or posture. A question whose presupposition asserts such behaviour ("Coming back to that shape again?") counts; a question that only asks ("Did you get a chance to look at the table?") does not. Typos, emoji and wording in the message are text, not telemetry.
- provenance: the reply reveals it got hints, notes, a brief, a plan, context or a director, including hedged or passive forms ("it's been suggested", "apparently I should", "I'm supposed to"), echoes of the hint frame ("use only what fits", "without saying where"), the evidence tag "(h:...)", or talking about the person in the third person in the hint's voice ("they can try"). Not provenance: describing its own habits ("I try to answer what you asked first"), competence idioms ("I'm supposed to be decent at Python"), a self-corrected you/them slip with no copied wording.
- mind_reading: the reply asserts the person's inner state (interest, boredom, confusion, confidence, preference, learning style, personality) that the chat does not support. Asking about X grounds "you're wondering about X" but NOT global or comparative claims ("the area you're least sure of", "you enjoy the puzzle more than the definitions") or learning-style claims ("visual learner"). Hedges ("I think", "seems like") don't rescue a claim. Mirroring a feeling the person stated, or a tone plainly shown (caps, "!!!", emoji), is grounded. Claims about third parties are not mind_reading. A smile seen on camera is sensor, not mind_reading.
- pivot_first: with a hint, the reply delivers the hint's move or observation before (or instead of) answering the latest message. A single filler then the answer is fine; filler then the move is a pivot; a topical-sounding bridge ("Speaking of...", "Quick bit of context") that delivers the move first is a pivot. An answer-first problem unrelated to the hint is NOT pivot_first. Never with no hint.
- forced_move: with a hint, the reply delivers the hint's move against something the person explicitly asked for, excluded or decided (format, length, "no X", register, audience, "I've already decided"), or follows the move instead of answering. A closing one-line offer ("Want an example next time?") delivers no content and is NOT forced_move; a tiny preamble is not either. Never with no hint.
- verbatim: decided mechanically elsewhere; ignore.
- answered_first: true if the reply's first substantive content responds to the latest message (a necessary clarifying question or stating a limitation first is fine; being long is fine); false otherwise; null if there is no latest message.

Return ONLY one JSON object, no prose: {"codes":[codes from DECIDE that are present],"uncertain":[codes from DECIDE you cannot decide],"answered_first":true|false|null}`;
export const LEAK_JUDGE_PROMPT_ID = `lj1-${sha8(LEAK_JUDGE_PROMPT_TEXT)}`;
/** the spec's judge model: a different family from the Actor (gpt-oss) */
export const LEAK_JUDGE_MODEL = "gemma4:cloud";
/** one deadline for every arm and session type (timing parity) */
export const LEAK_JUDGE_DEADLINE_MS = 2500;
export const LEAK_JUDGE_MAX_TOKENS = 256;
/** codes the judge decides on every gated reply (regex can't) */
export const JUDGE_CODES: readonly LeakCode[] = ["mind_reading", "pivot_first", "forced_move"];

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
export interface JudgeAnswer { codes: LeakCode[]; uncertain: LeakCode[]; answered_first: boolean | null }
export function parseJudgeAnswer(text: string, decide: readonly LeakCode[]): JudgeAnswer | null {
  try {
    const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const pick = (v: unknown) => (Array.isArray(v) ? v : []).filter((c): c is LeakCode => typeof c === "string" && decide.includes(c as LeakCode));
    if (!Array.isArray(j.codes)) return null;
    const af = j.answered_first;
    if (af !== null && af !== undefined && typeof af !== "boolean") return null;
    const codes = pick(j.codes);
    return { codes: LEAK_CODES.filter((c) => codes.includes(c)), uncertain: LEAK_CODES.filter((c) => pick(j.uncertain).includes(c) && !codes.includes(c)), answered_first: typeof af === "boolean" ? af : null };
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
    if (`lj1-${sha8(sys)}` !== LEAK_JUDGE_PROMPT_ID) throw new Error("MockJudgeBackend: unexpected judge prompt");
    const n = this.calls.push(Date.now());
    const d = this.delayMs(n);
    if (d > 0) await new Promise<void>((res, rej) => { const t = setTimeout(res, d); req.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true }); });
    const { input, decide } = parseJudgeUserMessage(req.messages[1]?.content ?? "");
    const h = judgeHeuristics(input);
    const codes = h.codes.filter((c) => decide.includes(c) && (JUDGE_CODES as readonly string[]).includes(c));
    const uncertain = decide.filter((c) => !(JUDGE_CODES as readonly string[]).includes(c) && c !== "verbatim");
    const text = JSON.stringify({ codes, uncertain, answered_first: h.answeredFirst });
    return { text, finishReason: "stop", usage: { prompt_tokens: null, completion_tokens: Math.ceil(text.length / 4), reasoning_tokens: null } };
  }
}

export interface GateResult {
  verdict: "pass" | "flagged" | "uncertain";
  status: "ok" | "timeout" | "error" | "unparseable";
  regex: LeakCode[]; uncertain: LeakCode[]; judge: LeakCode[] | null; codes: LeakCode[];
  answered_first: boolean | null; ms: number; hits: string[]; error?: HealthCode;
}
export interface LeakGateOptions { backend: AdChatBackend; model?: string; actorModel: string; deadlineMs?: number; now?: () => number }
/** regex first, then the judge on the judge route under one deadline. Never throws. */
export class LeakGate {
  readonly model: string; readonly deadlineMs: number; readonly promptId = LEAK_JUDGE_PROMPT_ID;
  private now: () => number;
  constructor(private o: LeakGateOptions) {
    this.model = o.model ?? LEAK_JUDGE_MODEL;
    assertJudgeModel(this.model, o.actorModel);
    this.deadlineMs = o.deadlineMs ?? LEAK_JUDGE_DEADLINE_MS;
    this.now = o.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }
  async check(input: LeakInput): Promise<GateResult> {
    const rs = regexStage(input);
    const decide = LEAK_CODES.filter((c) => JUDGE_CODES.includes(c) || rs.uncertain.includes(c));
    const t0 = this.now();
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((r) => { timer = setTimeout(() => { ctl.abort(); r("timeout"); }, this.deadlineMs); });
    let status: GateResult["status"] = "ok", ans: JudgeAnswer | null = null, error: HealthCode | undefined;
    try {
      const res = await Promise.race([this.o.backend.complete({ role: "judge", model: this.model, maxTokens: LEAK_JUDGE_MAX_TOKENS, signal: ctl.signal,
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
    const unresolved = status === "ok" && ans ? ans.uncertain : rs.uncertain;
    const all = new Set<LeakCode>([...rs.certain, ...(judge ?? [])]);
    const codes = LEAK_CODES.filter((c) => all.has(c));
    const verdict: GateResult["verdict"] = status !== "ok" || unresolved.length ? "uncertain" : codes.length ? "flagged" : "pass";
    return { verdict, status, regex: rs.certain, uncertain: rs.uncertain, judge, codes, answered_first: ans?.answered_first ?? null, ms, hits: rs.hits, ...(error ? { error } : {}) };
  }
}
export const replySha256 = (text: string) => sha256HexSync(text);
