// R4 eval of the E2 leak checks. Tune on dev only:  npx tsx scripts/ad-r4-eval.ts <labels.jsonl> [--errors CODE]
// The test split is scored ONCE, at the end, with --final-test (no retuning afterwards).
import { readFileSync } from "node:fs";
import { LEAK_CODES } from "../packages/core/src/ad-contracts/index.ts";
import { checkLeaksSync } from "../packages/core/src/actor-director/leaks.ts";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".jsonl")) ?? "/workspace/actor-director/research/R4/labels.jsonl";
const split = args.includes("--final-test") ? "test" : "dev";
const errs = args.includes("--errors") ? args[args.indexOf("--errors") + 1] : null;
type Item = { id: string; split: string; unit: string; text: string; codes: string[]; answer_first_violation: boolean; context: string; note: string };
const items = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item).filter((i) => i.split === split);
const cells: Record<string, { tp: number; fp: number; fn: number; pos: number }> = {};
for (const c of [...LEAK_CODES, "answer_first"]) cells[c] = { tp: 0, fp: 0, fn: 0, pos: 0 };
for (const it of items) {
  const r = checkLeaksSync({ text: it.text, context: it.context, note: it.note, fragment: it.unit !== "reply" });
  const gold = new Set(it.codes), pred = new Set<string>(r.codes);
  if (it.unit === "reply" && it.context) { if (it.answer_first_violation) gold.add("answer_first"); if (r.answeredFirst === false) pred.add("answer_first"); }
  for (const c of Object.keys(cells)) {
    const g = gold.has(c), p = pred.has(c), x = cells[c]!;
    if (g) x.pos++;
    if (g && p) x.tp++; else if (p) { x.fp++; if (errs === c) console.log("FP", it.id, it.text.slice(0, 120), "|", r.hits.join("; ")); } else if (g) { x.fn++; if (errs === c) console.log("FN", it.id, it.text.slice(0, 120), "| C:", it.context.slice(0, 80)); }
  }
}
console.log(`== ${split} (n=${items.length})`);
console.log("code           pos   tp   fp   fn      P      R");
const f = (n: number, d: number) => (d ? (n / d).toFixed(3) : "  n/a");
for (const [c, x] of Object.entries(cells)) console.log(`${c.padEnd(14)} ${String(x.pos).padStart(4)} ${String(x.tp).padStart(4)} ${String(x.fp).padStart(4)} ${String(x.fn).padStart(4)}  ${f(x.tp, x.tp + x.fp)}  ${f(x.tp, x.tp + x.fn)}`);
