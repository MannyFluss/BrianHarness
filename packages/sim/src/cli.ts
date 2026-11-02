#!/usr/bin/env node
/**
 * eeg-sim: run simulated personas against the Director.
 *   npm run sim -- [--turns 12] [--seeds 5] [--persona chef] [--fake-eeg] [--out data/sim] [--logs]
 * Uses the offline mock backend unless EEG_BACKEND=openai and a key are set (then it costs money,
 * so it also requires --allow-paid).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBackendFromEnv } from "@eeg/core";
import { PERSONAS } from "./personas.js";
import { runPersona, summarize, type RunResult } from "./runner.js";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}

const turns = Number(arg("turns", "12"));
const seeds = Number(arg("seeds", "5"));
const which = arg("persona", "all")!;
const out = arg("out", "data/sim")!;
const fakeEeg = arg("fake-eeg") === "true";
const writeLogs = arg("logs") === "true";

const personas = which === "all" ? PERSONAS : PERSONAS.filter((p) => p.id === which);
if (!personas.length) {
  console.error(`unknown persona ${which}; have: ${PERSONAS.map((p) => p.id).join(", ")}`);
  process.exit(1);
}
const envBackend = createBackendFromEnv();
if (envBackend.paid && arg("allow-paid") !== "true") {
  console.error(`backend ${envBackend.id} is paid; re-run with --allow-paid to spend money, or unset EEG_BACKEND`);
  process.exit(2);
}

const results: RunResult[] = [];
for (const p of personas) {
  for (let s = 1; s <= seeds; s++) {
    const r = await runPersona(p, { turns, seed: s, fakeEeg, backend: envBackend.paid ? envBackend : undefined, dataDir: writeLogs ? join(out, "logs") : undefined });
    results.push(r);
    const trail = r.hypothesisByTurn.map((h) => (h === p.passion ? "#" : h ? "x" : ".")).join("");
    console.log(`${p.id.padEnd(10)} seed ${s}  ${trail}  found=${r.found ? "yes" : "no "} turnsToFind=${r.turnsToFind ?? "-"}  final=${r.finalHypothesis ?? "none"}  topStyle=${r.topStyle}`);
  }
}
console.log("\n# = hypothesis is the hidden passion, x = wrong guess, . = no hypothesis yet\n");
console.log("persona     runs  found  avg turns-to-find  style-hit");
for (const s of summarize(results)) {
  console.log(`${s.persona.padEnd(10)}  ${String(s.runs).padEnd(4)}  ${(s.foundRate * 100).toFixed(0).padStart(4)}%  ${(s.meanTurnsToFind?.toFixed(1) ?? "-").padStart(17)}  ${(s.styleHitRate * 100).toFixed(0).padStart(8)}%`);
}
mkdirSync(out, { recursive: true });
const file = join(out, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ turns, seeds, fakeEeg, backend: envBackend.paid ? envBackend.id : "mock", summary: summarize(results), results }, null, 2));
console.log(`\nreport: ${file}`);
