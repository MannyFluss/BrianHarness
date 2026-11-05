/**
 * Leak-judge set: the frozen predictor's batch path (used by scripts/ad-leak-predict.ts at freeze).
 * One input line {id, unit, context, note, text} -> {id, codes, answer_first, ...} through the SAME LeakGate the
 * session uses (regex first, then the judge route). No deadline in batch mode unless given (a live judge would set one).
 */
import { LEAK_CODES } from "../ad-contracts/index.js";
import type { LeakCode } from "../ad-contracts/index.js";
import type { AnswerFirst, LeakGate } from "./leak-judge.js";

export interface PredictInput { id: string; unit?: string; context?: string | null; note?: string | null; text: string }
export interface Prediction {
  id: string;
  /** final codes (uncertain codes included when policy = "positive", the gate's own fail-safe reading) */
  codes: LeakCode[];
  /** answer-first VIOLATION (true = the reply did not answer first); the positive class R4/R4c score as answer_first */
  answer_first: boolean;
  /** the same value under the R4c gold field name */
  answer_first_violation: boolean;
  /** the judge's answered_first (contract semantics; null when not judged / no latest message) */
  answered_first: boolean | null;
  /** lj2: the judge's own answer_first_violation (true | false | "uncertain" | null) */
  answer_first_judge: AnswerFirst;
  /** codes the judge left undecided (counted into the uncertain rate) */
  uncertain: LeakCode[];
  verdict: "pass" | "flagged" | "uncertain";
  status: string;
}
export type UncertainPolicy = "positive" | "negative";
export async function predictOne(it: PredictInput, gate: LeakGate, policy: UncertainPolicy = "positive"): Promise<Prediction> {
  const context = it.context ?? "", note = it.note ?? "";
  const fragment = (it.unit ?? "reply") !== "reply";
  const r = await gate.check({ text: it.text, context, note, fragment });
  const unresolved = r.undecided.filter((c) => !r.codes.includes(c));
  const set = new Set<LeakCode>([...r.codes, ...(policy === "positive" ? unresolved : [])]);
  // "uncertain" follows the same policy as an undecided code (positive = the gate's fail-safe reading)
  const afv = r.answer_first_violation === true || (r.answer_first_violation === "uncertain" && policy === "positive");
  return { id: it.id, codes: LEAK_CODES.filter((c) => set.has(c)), answer_first: afv, answer_first_violation: afv, answered_first: r.answered_first,
    answer_first_judge: r.answer_first_violation, uncertain: unresolved, verdict: r.verdict, status: r.status };
}
export async function predictAll(items: PredictInput[], gate: LeakGate, policy: UncertainPolicy = "positive"): Promise<Prediction[]> {
  const out: Prediction[] = [];
  for (const it of items) out.push(await predictOne(it, gate, policy));
  return out;
}
