#!/usr/bin/env node
/**
 * eeg-sim: run simulated personas against the Director.
 *   npm run sim -- [--turns 12] [--seeds 5] [--persona chef] [--fake-eeg] [--out data/sim] [--logs]
 *                  [--provider mock|ollama|openai-compatible|openai|anthropic|claude-code] [--model M]
 *                  [--ollama-url http://127.0.0.1:11434] [--base-url URL] [--temperature T]
 *                  [--backend-seed N] [--allow-paid]
 * Default: offline mock. Local Ollama / local OpenAI-compatible servers are free and run without
 * --allow-paid; Ollama "*:cloud" models, remote APIs and subscriptions need --allow-paid.
 * Env fallbacks: BH_PROVIDER/EEG_BACKEND, EEG_MODEL, EEG_OLLAMA_URL/OLLAMA_HOST, EEG_TEMPERATURE, EEG_SEED.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendSpecFromEnv, createBackend, detectOllama, parseBackendRef, type BackendSpec, type ProviderKind } from "@brianharness/core";
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
const spec: BackendSpec = backendSpecFromEnv();
if (arg("provider")) Object.assign(spec, parseBackendRef(arg("provider")!));
if (arg("model")) spec.model = arg("model");
if (arg("ollama-url")) spec.baseUrl = arg("ollama-url");
if (arg("base-url")) spec.baseUrl = arg("base-url");
if (arg("temperature")) spec.temperature = Number(arg("temperature"));
const fixedBackendSeed = arg("backend-seed") ? Number(arg("backend-seed")) : spec.seed;
if (spec.provider === "ollama" && !spec.model) {
  const det = await detectOllama(spec.baseUrl);
  const local = det.models.find((m) => !m.cloud);
  if (!det.running || !local) {
    console.error(`ollama: ${det.running ? "no local models" : `not reachable at ${det.baseUrl} (${det.error})`}; pass --model to skip detection`);
    process.exit(1);
  }
  spec.model = local.name;
  console.log(`ollama: detected ${det.models.length} model(s) at ${det.baseUrl}; using ${spec.model}`);
}
const probe = await createBackend({ ...spec, seed: fixedBackendSeed ?? 1 });
if (probe.paid && arg("allow-paid") !== "true") {
  console.error(`backend ${probe.id} is paid (or uses your subscription quota); re-run with --allow-paid, or use --provider mock / a local ollama model`);
  process.exit(2);
}
const useLlm = (spec.provider as ProviderKind) !== "mock";
console.log(`backend: ${probe.id}${useLlm ? ` temperature=${spec.temperature ?? "default"} seed=${fixedBackendSeed ?? "per-run"}` : ""}`);

const results: RunResult[] = [];
for (const p of personas) {
  for (let s = 1; s <= seeds; s++) {
    const backend = useLlm ? await createBackend({ ...spec, seed: fixedBackendSeed ?? s }) : undefined;
    const r = await runPersona(p, { turns, seed: s, fakeEeg, backend, dataDir: writeLogs ? join(out, "logs") : undefined });
    results.push(r);
    const trail = r.hypothesisByTurn.map((h) => (h === p.passion ? "#" : h ? "x" : ".")).join("");
    console.log(`${p.id.padEnd(10)} seed ${s}  ${trail}  found=${r.found ? "yes" : "no "} turnsToFind=${r.turnsToFind ?? "-"}  final=${r.finalHypothesis ?? "none"}  topStyle=${r.topStyle}`);
  }
}
console.log("\n# = hypothesis is the hidden passion, x = wrong guess, . = no hypothesis yet\n");
console.log("persona     runs  found  avg turns-to-find  style-hit  wrong-final  no-hyp  lock-ins(>=6 wrong turns)  final@1  final@3");
for (const s of summarize(results)) {
  console.log(`${s.persona.padEnd(10)}  ${String(s.runs).padEnd(4)}  ${(s.foundRate * 100).toFixed(0).padStart(4)}%  ${(s.meanTurnsToFind?.toFixed(1) ?? "-").padStart(17)}  ${(s.styleHitRate * 100).toFixed(0).padStart(8)}%  ${String(s.wrongFinal).padStart(11)}  ${String(s.noHypothesis).padStart(6)}  ${String(s.lockIns).padStart(6)}  ${(s.final1 * 100).toFixed(0).padStart(26)}%  ${(s.final3 * 100).toFixed(0).padStart(6)}%`);
}
mkdirSync(out, { recursive: true });
const file = join(out, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ turns, seeds, fakeEeg, backend: probe.id, temperature: spec.temperature,  summary: summarize(results), results }, null, 2));
console.log(`\nreport: ${file}`);
