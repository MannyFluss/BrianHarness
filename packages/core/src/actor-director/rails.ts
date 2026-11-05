/**
 * E3: the safety / validity rails on one Director output (rail_check.blocked_by, codes in RAIL_CODES order).
 * Deterministic; none is a value judgment. The note is blocked if any rail fires.
 */
import { LEGACY_INPUT_MODE, MAX_ACTOR_TEXT_WORDS, RAIL_CODES, actorTextWords, evidenceOutsideMode, renderActorText } from "../ad-contracts/index.js";
import type { DirectorNote, InputMode, RailCode } from "../ad-contracts/index.js";
import { lintNote } from "./lint.js";
import { validateDirectorOutput } from "./validate.js";

// contract-v1.5: p<k> pointer evidence too (a paragraph id a7.p2 is not a pointer id: ".p2" is never matched on its own)
const EVIDENCE_IN_TEXT = /(?<![\w.])(?:e[0-9]+|p[0-9]+|u[0-9]+|a[0-9]+(?:\.p[0-9]+(?:\.s[0-9]+)?)?)(?![\w.])/g;
export const evidenceIdsIn = (input: string): Set<string> => new Set(input.match(EVIDENCE_IN_TEXT) ?? []);

export interface RailContext {
  /** the digest message the Director saw (evidence ids are taken from it) */
  input: string;
  /** actor_text of the last 2 injected or shadowed notes */
  previousActorTexts: string[];
  directorEnabled: boolean;
  cameraConsent: boolean;
  /** gaze event ids from a window below quality 0.6 / face 70 %, or with a z before the 20-paragraph baseline */
  invalidEventIds?: ReadonlySet<string>;
  leakBreakerTripped: boolean;
  /** v1.5: the session's input mode (default "gaze"): e<k> only in gaze, p<k> only in pointer, neither in none */
  inputMode?: InputMode;
}
export interface RailResult { pass: boolean; blocked_by: RailCode[]; hits: string[]; actor_text: string | null; note: DirectorNote | null }

export function runRails(output: unknown, ctx: RailContext): RailResult {
  const codes = new Set<RailCode>(), hits: string[] = [];
  const out = output as { note?: unknown } | null;
  const note = out && typeof out === "object" && out.note && typeof out.note === "object" ? (out.note as DirectorNote) : null;
  if (!ctx.directorEnabled) codes.add("kill_switch");
  const schema = validateDirectorOutput(output, { allowEmptyEvidence: true });
  if (schema.length) { codes.add("schema_invalid"); hits.push(...schema.map((s) => "schema_invalid: " + s)); }
  let actor_text: string | null = null;
  if (note) {
    const ev = Array.isArray(note.evidence) ? note.evidence.filter((x): x is string => typeof x === "string") : [];
    if (Array.isArray(note.evidence) && note.evidence.length === 0) codes.add("evidence_missing");
    if (ev.length) {
      const ids = evidenceIdsIn(ctx.input);
      const outside = new Set(evidenceOutsideMode(ctx.inputMode ?? LEGACY_INPUT_MODE, ev));
      const unknown = ev.filter((x) => !ids.has(x) || outside.has(x));
      if (unknown.length) { codes.add("evidence_unknown"); hits.push("evidence_unknown: " + unknown.join(",")); }
      const gaze = ev.filter((x) => /^e[0-9]+$/.test(x));
      if (gaze.length && !ctx.cameraConsent) { codes.add("consent"); hits.push("consent: cites " + gaze.join(",")); }
      const bad = gaze.filter((x) => ctx.invalidEventIds?.has(x));
      if (bad.length) { codes.add("data_validity"); hits.push("data_validity: " + bad.join(",")); }
    }
    const lint = lintNote({ observation: typeof note.observation === "string" ? note.observation : undefined, suggestion: note.suggestion && typeof note.suggestion === "object" ? note.suggestion : undefined });
    for (const c of lint.codes) codes.add(c);
    hits.push(...lint.hits.map((h) => "lint: " + h));
    if (note.observation || note.suggestion?.text) {
      actor_text = renderActorText({ observation: note.observation, suggestion: note.suggestion, evidence: ev });
      const n = actorTextWords(actor_text);
      if (n > MAX_ACTOR_TEXT_WORDS) { codes.add("length_cap"); hits.push(`length_cap: ${n} words`); }
      if (ctx.previousActorTexts.slice(-2).includes(actor_text)) codes.add("duplicate");
    }
  }
  if (ctx.leakBreakerTripped) codes.add("leak_breaker");
  const blocked_by = RAIL_CODES.filter((c) => codes.has(c));
  return { pass: blocked_by.length === 0 && note !== null, blocked_by, hits, actor_text, note };
}
