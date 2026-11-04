/**
 * E3: DirectorOutput parsing + validation without ajv (ajv is dev-only). Mirrors note.schema.json exactly;
 * a parity test runs ajv and this validator over the R3 fixtures and the contract examples.
 */
import { EVIDENCE_ID_PATTERN, SUGGESTION_MOVES } from "../ad-contracts/index.js";
import type { DirectorOutput } from "../ad-contracts/index.js";

/** strip a ```json ... ``` fence (or stray prose around ONE object) and parse */
export function parseDirectorText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let t = text.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(t);
  if (fence) t = fence[1]!.trim();
  if (!t.startsWith("{")) { const i = t.indexOf("{"), j = t.lastIndexOf("}"); if (i >= 0 && j > i) t = t.slice(i, j + 1); }
  try { return { ok: true, value: JSON.parse(t) }; } catch (e) { return { ok: false, error: "not JSON: " + String((e as Error).message).slice(0, 120) }; }
}

const EVID = new RegExp(EVIDENCE_ID_PATTERN);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
type Errs = string[];
function str(e: Errs, p: string, v: unknown, min: number, max: number) {
  if (typeof v !== "string") return void e.push(`${p}: must be string`);
  const n = [...v].length; // JSON-schema lengths count code points
  if (n < min) e.push(`${p}: shorter than ${min}`); if (n > max) e.push(`${p}: longer than ${max}`);
}
function num01(e: Errs, p: string, v: unknown) { if (typeof v !== "number" || !Number.isFinite(v)) e.push(`${p}: must be number`); else if (v < 0 || v > 1) e.push(`${p}: must be in 0..1`); }
function keys(e: Errs, p: string, o: Record<string, unknown>, allowed: string[], required: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) e.push(`${p}: unknown key ${k}`);
  for (const k of required) if (!(k in o)) e.push(`${p}: missing ${k}`);
}
function idList(e: Errs, p: string, v: unknown, min: number, max: number) {
  if (!Array.isArray(v)) return void e.push(`${p}: must be array`);
  if (v.length < min) e.push(`${p}: fewer than ${min} items`); if (v.length > max) e.push(`${p}: more than ${max} items`);
  v.forEach((x, i) => { str(e, `${p}/${i}`, x, 2, 24); if (typeof x === "string" && !EVID.test(x)) e.push(`${p}/${i}: bad id pattern`); });
}

/** schema errors as "path: message" ("" path = root); [] = valid. allowEmptyEvidence: report note/evidence [] as its own rail (evidence_missing), not schema */
export function validateDirectorOutput(v: unknown, opts: { allowEmptyEvidence?: boolean } = {}): string[] {
  const e: Errs = [];
  if (!isObj(v)) return ["<root>: must be object"];
  keys(e, "<root>", v, ["context_update", "intent", "note", "no_note_reason"], ["context_update", "intent", "note", "no_note_reason"]);
  const cu = v.context_update;
  if (!isObj(cu)) { if ("context_update" in v) e.push("context_update: must be object"); }
  else {
    keys(e, "context_update", cu, ["summary", "hypotheses", "changed"], ["summary", "hypotheses", "changed"]);
    if ("summary" in cu) str(e, "context_update/summary", cu.summary, 1, 400);
    if ("hypotheses" in cu) {
      if (!Array.isArray(cu.hypotheses)) e.push("context_update/hypotheses: must be array");
      else {
        if (cu.hypotheses.length > 5) e.push("context_update/hypotheses: more than 5 items");
        cu.hypotheses.forEach((h, i) => {
          const p = `context_update/hypotheses/${i}`;
          if (!isObj(h)) return void e.push(`${p}: must be object`);
          keys(e, p, h, ["label", "conf", "evidence"], ["label", "conf", "evidence"]);
          if ("label" in h) str(e, p + "/label", h.label, 1, 60);
          if ("conf" in h) num01(e, p + "/conf", h.conf);
          if ("evidence" in h) idList(e, p + "/evidence", h.evidence, 0, 24);
        });
      }
    }
    if ("changed" in cu) {
      if (!Array.isArray(cu.changed)) e.push("context_update/changed: must be array");
      else { if (cu.changed.length > 8) e.push("context_update/changed: more than 8 items"); cu.changed.forEach((c, i) => str(e, `context_update/changed/${i}`, c, 1, 200)); }
    }
  }
  if ("intent" in v) str(e, "intent", v.intent, 1, 240);
  const note = v.note, reason = v.no_note_reason;
  if (note === null) {
    if (typeof reason !== "string") e.push("no_note_reason: must be a non-empty string when note is null"); else str(e, "no_note_reason", reason, 1, 400);
  } else if (isObj(note)) {
    if (reason !== null && "no_note_reason" in v) e.push("no_note_reason: must be null when there is a note");
    const p = "note";
    keys(e, p, note, ["id", "rationale", "observation", "suggestion", "value", "evidence", "confidence", "expires_after_turns"], ["id", "rationale", "value", "evidence", "confidence", "expires_after_turns"]);
    if ("id" in note) { str(e, p + "/id", note.id, 2, 12); if (typeof note.id === "string" && !/^n[0-9]+$/.test(note.id)) e.push(p + "/id: bad pattern"); }
    if ("rationale" in note) str(e, p + "/rationale", note.rationale, 1, 800);
    if ("observation" in note) str(e, p + "/observation", note.observation, 1, 400);
    if ("suggestion" in note) {
      const s = note.suggestion;
      if (!isObj(s)) e.push(p + "/suggestion: must be object");
      else {
        keys(e, p + "/suggestion", s, ["move", "target", "text"], ["move", "text"]);
        if ("move" in s && !(SUGGESTION_MOVES as readonly unknown[]).includes(s.move)) e.push(p + "/suggestion/move: not an allowed move");
        if ("target" in s) str(e, p + "/suggestion/target", s.target, 1, 160);
        if ("text" in s) str(e, p + "/suggestion/text", s.text, 1, 280);
      }
    }
    if (!("observation" in note) && !("suggestion" in note)) e.push(p + ": needs observation or suggestion");
    if ("value" in note) str(e, p + "/value", note.value, 1, 500);
    if ("evidence" in note) {
      if (opts.allowEmptyEvidence && Array.isArray(note.evidence) && note.evidence.length === 0) { /* evidence_missing rail */ }
      else idList(e, p + "/evidence", note.evidence, 1, 24);
    }
    if ("confidence" in note) num01(e, p + "/confidence", note.confidence);
    if ("expires_after_turns" in note && note.expires_after_turns !== 1) e.push(p + "/expires_after_turns: must be 1");
  } else if ("note" in v) e.push("note: must be object or null");
  return e;
}
export const isDirectorOutput = (v: unknown): v is DirectorOutput => validateDirectorOutput(v).length === 0;
