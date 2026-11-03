#!/usr/bin/env node
// Phase D blinding leak check over session JSONL (files or directories, e.g. an unzipped Export logs bundle).
//   node tools/phaseD/check_blinding.mjs <file|dir>...      exit 1 on any leak
//
// NOTE on `mode`: director_turn.plan.mode ("explore" | "exploit" | "relax") is the Director's PACING plan, not the
// study arm. It appears only in NON-study sessions (study sessions log director_turn {sealed:true} with no plan
// and no stateNote). The key is kept as-is for sidecar protocol brianharness-sidecar/1 and Phase C replays. So a
// naive grep for "mode" hits non-study logs; this check instead fails on: any plan / stateNote / mode in a study
// session, any adaptation / studyMode / studyArm / arm / condition / assignment / schedule / order / seed key, and
// any "adaptive" / "baseline" string value outside rating.blindGuess (the participant's own guess, a study output),
// and any non-null director_turn.usage.prompt_tokens (prompt size carries the arm-dependent state note).
// It also lists study sessions without session_start.study.protocol (practice build 1438 -> exclude).
// In-app bug reports (brianharness-feedback/1: a `feedback_report` line, or a report .json file, e.g. an exported
// bh-feedback-*.json) are also checked for absorption-rating leaks, in ANY session (ratings are always redacted):
// no rating / absorption / hooked / blindGuess key, no 1-5 digit as a tap name or radio label, and generic
// "rating option" / "blinding-check option" controls carry no value / checked / pressed / selected / index.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ARM_KEYS = /^(?:adaptation|study[_-]?mode|study[_-]?arm|arm|condition|assignment|schedule|order|seed)$/i;
const ARM_VALUES = /^\s*(?:adaptive|baseline)\s*$/i;
const files = [];
const walk = (p) => { if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f)); else if (p.endsWith(".jsonl") || isReportFile(p)) files.push(p); };
const REPORT_SCHEMA = "brianharness-feedback/1";
function isReportFile(p) { if (!p.endsWith(".json")) return false; try { return JSON.parse(readFileSync(p, "utf8"))?.schema === REPORT_SCHEMA; } catch { return false; } }
const isReport = (e) => e?.type === "feedback_report" || e?.schema === REPORT_SCHEMA;
const RATING_KEYS = /^(?:rating|absorption|hooked|blind[_-]?guess)/i; // by prefix (absorption_value too), as ratingScrubEvent
const GENERIC = new Set(["rating option", "blinding-check option", "rating control", "rating text field"]);
const DIGIT = /^\s*[1-5]\s*$/;
const STATE_KEYS = ["value", "checked", "pressed", "selected", "index", "disabled", "aria-label", "ariaLabel"];
const RATING_SCREENS = new Set(["turn-probe", "session-rating"]);
/** absorption-rating leaks inside one bug report (any session) */
function reportRatingLeaks(report, bad) {
  const visit = (v, path, ctx) => {
    if (Array.isArray(v)) return v.forEach((x, j) => visit(x, `${path}[${j}]`, ctx));
    if (!v || typeof v !== "object") return;
    const onRating = ctx || RATING_SCREENS.has(String(v.screen)) || (Array.isArray(v.overlays) && v.overlays.some((o) => RATING_SCREENS.has(String(o))));
    for (const [k, x] of Object.entries(v)) if (RATING_KEYS.test(k)) bad(`rating key ${path}.${k}`);
    for (const nk of ["name", "label"]) {
      const n = v[nk];
      if (typeof n !== "string") continue;
      if (DIGIT.test(n) && (v.control === "radio" || onRating)) bad(`rating value as ${nk} at ${path}`);
      if (GENERIC.has(n)) for (const k of STATE_KEYS) if (k in v) bad(`rating control state ${path}.${k}`);
    }
    if (onRating && v.control === "radio" && ("checked" in v || "selected" in v)) bad(`checked radio on a rating screen at ${path}`);
    for (const [k, x] of Object.entries(v)) visit(x, `${path}.${k}`, onRating);
  };
  visit(report, "", false);
}
for (const p of process.argv.slice(2)) walk(p);
if (!files.length) { console.error("usage: check_blinding.mjs <session.jsonl|dir>..."); process.exit(2); }

let leaks = 0, study = 0, practice = 0, plain = 0, blindGuessArm = 0, reports = 0;
for (const f of files) {
  const lines = f.endsWith(".json") ? [JSON.parse(readFileSync(f, "utf8"))] : readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const start = lines.find((e) => e.type === "session_start");
  const standalone = f.endsWith(".json");
  // a report .json file: study iff its header says so; arm checks then run on it like on a study session line
  const isStudy = standalone ? lines[0]?.payload?.header?.study?.inStudy === true : !!start?.study;
  lines.forEach((e, i) => { if (isReport(e)) reportRatingLeaks(e, (why) => { leaks++; console.log(`LEAK ${f}:${i + 1}: report: ${why}`); }); });
  if (!isStudy) { plain++; continue; }
  study++;
  if (standalone) { reports++; }
  if (!standalone && typeof start.study.protocol !== "number") { practice++; console.log(`PRACTICE ${f}: study session without protocol (build 1438) -> exclude`); }
  const bad = (line, why) => { leaks++; console.log(`LEAK ${f}:${line}: ${why}`); };
  // plain-chat profile (Nov 3 2026): profile is logged on NON-study session_start only; a study session never has it
  lines.forEach((e, i) => { if (e && typeof e === "object" && "profile" in e) bad(i + 1, `profile field in a study session (${e.type})`); });
  lines.forEach((e, i) => {
    if (e.type === "director_turn" && ("plan" in e || "stateNote" in e || e.sealed !== true)) bad(i + 1, "director_turn not sealed (plan/stateNote in a study session)");
    // the prompt includes the arm-dependent state note, so its token count identifies the arm (Nov 3 2026 blinding check)
    if (e.type === "director_turn" && e.usage && e.usage.prompt_tokens !== null && e.usage.prompt_tokens !== undefined) bad(i + 1, "director_turn.usage.prompt_tokens not null in a study session");
    const visit = (v, path) => {
      if (Array.isArray(v)) return v.forEach((x, j) => visit(x, `${path}[${j}]`));
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
        if (ARM_KEYS.test(k) || k === "mode") bad(i + 1, `key ${path}.${k}`);
        visit(x, `${path}.${k}`);
      }
      else if (typeof v === "string" && ARM_VALUES.test(v)) {
        if (e.type === "rating" && path === ".blindGuess") blindGuessArm++;
        else bad(i + 1, `arm value at ${path}`);
      }
    };
    visit(e, "");
  });
}
console.log(`${files.length} files: ${study} study (${practice} practice, no protocol${reports ? `, ${reports} report .json` : ""}), ${plain} non-study (plan.mode = pacing, allowed); ${blindGuessArm} blindGuess answers naming an arm (participant guess, allowed); ${leaks} leaks`);
process.exit(leaks ? 1 : 0);
