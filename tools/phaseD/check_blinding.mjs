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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ARM_KEYS = /^(?:adaptation|study[_-]?mode|study[_-]?arm|arm|condition|assignment|schedule|order|seed)$/i;
const ARM_VALUES = /^\s*(?:adaptive|baseline)\s*$/i;
const files = [];
const walk = (p) => { if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f)); else if (p.endsWith(".jsonl")) files.push(p); };
for (const p of process.argv.slice(2)) walk(p);
if (!files.length) { console.error("usage: check_blinding.mjs <session.jsonl|dir>..."); process.exit(2); }

let leaks = 0, study = 0, practice = 0, plain = 0, blindGuessArm = 0;
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const start = lines.find((e) => e.type === "session_start");
  const isStudy = !!start?.study;
  if (!isStudy) { plain++; continue; }
  study++;
  if (typeof start.study.protocol !== "number") { practice++; console.log(`PRACTICE ${f}: study session without protocol (build 1438) -> exclude`); }
  const bad = (line, why) => { leaks++; console.log(`LEAK ${f}:${line}: ${why}`); };
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
console.log(`${files.length} files: ${study} study (${practice} practice, no protocol), ${plain} non-study (plan.mode = pacing, allowed); ${blindGuessArm} blindGuess answers naming an arm (participant guess, allowed); ${leaks} leaks`);
process.exit(leaks ? 1 : 0);
