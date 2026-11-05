// Ruling A6: MOCK baseline of the lj2 leak-judge path (regex layer + MockJudgeBackend = the offline heuristic judge,
// one joint call per item, temperature 0) on R4 dev + test (both tuning data now). P/R per code + answer_first and the
// uncertain rate per code. No network. Never reads R4c.
//   npx tsx scripts/ad-r4-baseline.ts [/workspace/actor-director/research/R4/labels.jsonl] [--uncertain positive|negative]
import { readFileSync } from "node:fs";
import { LEAK_CODES } from "../packages/core/src/ad-contracts/index.ts";
import { LEAK_JUDGE_MODEL, LEAK_JUDGE_PROMPT_ID, LeakGate, MockJudgeBackend } from "../packages/core/src/actor-director/leak-judge.ts";
import { predictAll, type UncertainPolicy } from "../packages/core/src/actor-director/leak-predict.ts";
import { uncertainSummary } from "../packages/core/src/actor-director/leak-freeze.ts";
import { ACTOR_MODEL } from "../packages/core/src/actor-director/session.ts";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".jsonl")) ?? "/workspace/actor-director/research/R4/labels.jsonl";
if (/R4c/i.test(file)) { console.error("ad-r4-baseline: R4c is scored once, at freeze, by the Researcher"); process.exit(2); }
const policy = (args.includes("--uncertain") ? args[args.indexOf("--uncertain") + 1] : "positive") as UncertainPolicy;
type Item = { id: string; split: string; unit: string; text: string; codes: string[]; answer_first_violation: boolean; context: string; note: string };
const all = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item).filter((i) => i.split === "dev" || i.split === "test");
const f = (n: number, d: number) => (d ? (n / d).toFixed(3) : "  n/a");
console.log(`mock baseline: ${LEAK_JUDGE_PROMPT_ID}, judge ${LEAK_JUDGE_MODEL} route mocked (MockJudgeBackend), actor ${ACTOR_MODEL}, uncertain=${policy}`);
for (const split of ["dev", "test", "dev+test"]) {
  const items = all.filter((i) => split === "dev+test" || i.split === split);
  const backend = new MockJudgeBackend();
  const gate = new LeakGate({ backend, actorModel: ACTOR_MODEL, deadlineMs: 60_000 });
  const preds = await predictAll(items.map((i) => ({ id: i.id, unit: i.unit, context: i.context, note: i.note || null, text: i.text })), gate, policy);
  const cells: Record<string, { tp: number; fp: number; fn: number; pos: number }> = {};
  for (const c of [...LEAK_CODES, "answer_first"]) cells[c] = { tp: 0, fp: 0, fn: 0, pos: 0 };
  items.forEach((it, k) => {
    const p = preds[k]!, gold = new Set(it.codes), pred = new Set<string>(p.codes);
    if (it.unit === "reply" && it.context) { if (it.answer_first_violation) gold.add("answer_first"); if (p.answer_first) pred.add("answer_first"); }
    for (const c of Object.keys(cells)) { const g = gold.has(c), q = pred.has(c), x = cells[c]!; if (g) x.pos++; if (g && q) x.tp++; else if (q) x.fp++; else if (g) x.fn++; }
  });
  const u = uncertainSummary(preds), n = items.length;
  console.log(`\n== ${split} (n=${n}; judge calls ${backend.calls.length}; verdicts ${JSON.stringify(gate.stats.verdicts)})`);
  console.log("code           pos   tp   fp   fn      P      R   uncertain");
  for (const [c, x] of Object.entries(cells)) {
    const un = c === "answer_first" ? u.answer_first : u.byCode[c as keyof typeof u.byCode];
    console.log(`${c.padEnd(14)} ${String(x.pos).padStart(4)} ${String(x.tp).padStart(4)} ${String(x.fp).padStart(4)} ${String(x.fn).padStart(4)}  ${f(x.tp, x.tp + x.fp)}  ${f(x.tp, x.tp + x.fn)}   ${un}/${n} (${(100 * un / n).toFixed(1)}%)`);
  }
  console.log(`any-uncertain items: ${u.any}/${n} (${(100 * u.any / n).toFixed(1)}%); regex-uncertain by code ${JSON.stringify(gate.stats.regexUncertainByCode)}`);
}
