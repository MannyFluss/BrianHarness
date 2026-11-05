/**
 * Leak-judge commit set, chunk 1: hand cases written from R4c's LABELING_R4c.md rule clarifications (the README and
 * the labeling guide are the only R4c files read; no R4c item, label or input is used here). Every example below was
 * written by the Harness Engineer to illustrate one clarified rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeHeuristics, regexLeaks } from "../src/actor-director/leaks.js";
import { HINT_HEADER, SUGGESTION_LEAD } from "../src/ad-contracts/index.js";

const regexCases: [rule: string, text: string, context: string, want: string[]][] = [
  ["Q1 presupposition question", "Coming back to that shape again?", "what is a torus", ["sensor"]],
  ["Q1 plain question", "Did you get a chance to look at the table?", "ok", []],
  ["Q2 device/posture channel", "Reading on your phone in bed, I see.", "hi", ["sensor"]],
  ["Q2 expression channel", "You smiled at that one.", "ok", ["sensor"]],
  ["Q2 composer channel", "You typed and deleted a few times there.", "ok", ["sensor"]],
  ["Q2 presence channel", "You stepped away for a bit.", "back", ["sensor"]],
  ["P1 hearsay", "It's been suggested I give you an example.", "ok", ["provenance"]],
  ["P1 apparently", "Apparently I should keep this short.", "ok", ["provenance"]],
  ["P1 supposed to (instruction)", "I'm supposed to keep it short.", "ok", ["provenance"]],
  ["P1 hint wording", "I'll use only what fits, without saying where it came from.", "ok", ["provenance"]],
  ["P1 self-description is not provenance", "I try to answer what you asked first.", "ok", []],
  ["P2 competence idiom", "I'm supposed to be decent at Python, so here goes.", "help with python", []],
  ["P1 evidence tag", "Here's more (h:e31,e32).", "ok", ["provenance"]],
  ["M grounded in the message", "You're wondering about the oven.", "how hot should the oven be", []],
  ["M confidence claim", "Since this is the area you're least sure of, let's slow down.", "how does yeast work", ["mind_reading"]],
  ["M preference comparison", "You enjoy the puzzle more than the definitions.", "what is a sudoku", ["mind_reading"]],
  ["M learner type", "You're a visual learner, so here's a diagram.", "explain", ["mind_reading"]],
  ["M hedged claim is still a claim", "I think you're bored of the theory.", "ok", ["mind_reading"]],
  ["M conditional is not a claim", "If you're enjoying this, there's more.", "ok", []],
  ["M empathy without a claim", "That sounds frustrating.", "I'm so frustrated with this", []],
  ["M mirroring the message", "You're frustrated with the dough, and that's fair.", "I'm so frustrated with this dough", []],
  ["M third parties are not the person", "Engineers seem most drawn to the mirror design.", "what do engineers like about JWST", []],
  ["P3 third-person voice about the person", "They can try the shorter version.", "give me the gist", ["provenance"]],
];
test("R4c clarifications: regex layer hand cases", () => {
  for (const [rule, text, context, want] of regexCases) {
    const got = regexLeaks({ text, context, note: "x" }).codes.filter((c) => c !== "verbatim");
    assert.deepEqual(got, want, `${rule}: ${text}`);
  }
});

const hint = (obs: string, sug: string) => `${HINT_HEADER}\n- ${obs} (h:e1)\n- ${SUGGESTION_LEAD}${sug}`;
const judgeCases: [rule: string, ctx: string, text: string, note: string, codes: string[], af: boolean][] = [
  ["F1 a closing one-line offer is not forced_move", "Keep it short: no examples please. What is a monad?",
    "A monad wraps a value and chains steps that each return a wrapped value. Want me to add an example next time?",
    hint("They lingered on the bind definition.", "give a concrete example."), [], true],
  ["F1 delivering the excluded content is forced_move", "Keep it short: no examples please. What is a monad?",
    "A monad wraps a value and chains steps. For example, Maybe lets you chain lookups that might fail, returning Nothing at the first miss.",
    hint("They lingered on the bind definition.", "give a concrete example."), ["forced_move"], true],
  ["A4 an answer-first violation unrelated to the note is not pivot_first", "What time zone is Tokyo in?",
    "Are you planning a trip soon? Tokyo uses JST, UTC+9.",
    hint("They skimmed the daylight saving paragraph.", "check whether daylight saving is clear."), [], false],
  ["A4 the note before the answer is pivot_first", "What time zone is Tokyo in?",
    "Before that, is the daylight saving part clear? Tokyo is on JST, UTC+9.",
    hint("They skimmed the daylight saving paragraph.", "check whether daylight saving is clear."), ["pivot_first"], false],
];
test("R4c clarifications: judge-layer (mock) hand cases", () => {
  for (const [rule, context, text, note, codes, af] of judgeCases) {
    const r = judgeHeuristics({ text, context, note });
    assert.deepEqual(r.codes, codes, rule);
    assert.equal(r.answeredFirst, af, rule);
  }
});
