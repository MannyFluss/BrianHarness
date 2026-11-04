/**
 * E2: wording rails on the Director's note text (observation, suggestion.text, suggestion.target; never rationale).
 * Whole-word matching with explicit inflections, never substring ("bread", "already" don't trip "read").
 * The spec's word list is split by contract decision 12: sensor/measurement words (gaze, eye, look, read, skim, dwell,
 * attention, EEG, brain, sensor, camera, track, measure, noticed, ms, seconds, %) -> lint_sensor; told, note,
 * Director, model -> lint_provenance. Answer-first phrases in suggestion.text -> lint_answer_first.
 * Same lexicon as R3's validate.py (byte-for-byte regex port; R3's fixtures are run in the tests).
 */
import type { DirectorNote, RailCode } from "../ad-contracts/index.js";

export const LINT_SENSOR = /(\bgaz\w*|\beyes?\b|\beye\w*|\blook\w*|\b(?:re)?read(?:s|ing|er|ers)?\b|\breread\w*|\bskim\w*|\bdwell\w*|\battenti\w*|\beeg\b|\bbrains?\b|\bsensors?\b|\bsensing\b|\bcameras?\b|\btrack\w*|\bmeasur\w*|\bnoticed\b|\bms\b|\bseconds?\b|%)/gi;
export const LINT_PROVENANCE = /(\btold\b|\bnotes?\b|\bdirector\b|\bmodels?\b)/gi;
export const LINT_ANSWER_FIRST = /\b(instead of|don'?t answer|ignore|change the subject|stop)\b/gi;

export interface LintResult { codes: RailCode[]; hits: string[] }

export function lintNote(n: Pick<DirectorNote, "observation" | "suggestion">): LintResult {
  const fields = [n.observation ?? "", n.suggestion?.text ?? "", n.suggestion?.target ?? ""];
  const codes: RailCode[] = [];
  const hits: string[] = [];
  for (const [code, rx] of [["lint_sensor", LINT_SENSOR], ["lint_provenance", LINT_PROVENANCE]] as const) {
    const h = new Set<string>();
    for (const f of fields) for (const m of f.matchAll(rx)) h.add(m[0].toLowerCase());
    if (h.size) { codes.push(code); hits.push(...[...h].sort()); }
  }
  const af = [...(n.suggestion?.text ?? "").matchAll(LINT_ANSWER_FIRST)].map((m) => m[0].toLowerCase());
  if (af.length) { codes.push("lint_answer_first"); hits.push(...af); }
  return { codes, hits };
}
