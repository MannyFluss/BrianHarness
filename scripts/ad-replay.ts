// E7: offline replay CLI. Reruns the pipeline, Director and rails over a logged session or the R2 synthetic gaze
// files, in mode off | shadow | on (or all), with the frozen or a candidate Director prompt. Mock backends only
// (Phase 1); any fetch during the run throws and is counted (the summary reports network_calls, expected 0).
//
//   npx tsx scripts/ad-replay.ts --r2 [/workspace/actor-director/research/R2] [--layout iphone|ipad|mac|all] [--turns 20]
//   npx tsx scripts/ad-replay.ts --log session.jsonl
//   common: [--mode off|shadow|on|all] [--out /workspace/ad-scratch/replay] [--director-prompt prompt.txt]
//           [--pair-sample 1] [--p-inject 1] [--seed 7]
// Writes <out>/<name>.<mode>.jsonl (the replayed log), <out>/<name>.<mode>.pairs.json and <out>/summary.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { candidateDirectorPrompt, loadO200k, replayLog, replayR2, REPLAY_MODES, type ReplayMode, type ReplayRun, type SimReplay } from "../packages/core/src/actor-director/index.ts";
import type { BhAdEvent } from "../packages/core/src/ad-contracts/index.ts";
import { MemoryKV } from "../packages/core/src/platform/kv.ts";

export const R2_LAYOUTS: Record<string, string[]> = {
  iphone: ["iphone17pro-portrait-01", "iphone17pro-portrait-02"],
  ipad: ["ipadpro11-m1-landscape-01", "ipadpro11-m1-landscape-02"],
  mac: ["macbookair-m1-1440x900-01", "macbookair-m1-1440x900-02"],
};
export function loadR2(dir: string, names: string[]): SimReplay[] {
  return names.map((name) => ({
    name,
    file: JSON.parse(readFileSync(join(dir, "gaze-replays", name + ".json"), "utf8")),
    // layout + AOIs + timing only; the sidecar's labels (`truth`) are never read by the replay
    turn: JSON.parse(readFileSync(join(dir, "gaze-replays", name + ".truth.json"), "utf8")).turn,
  }));
}
export function readLog(file: string): BhAdEvent[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as BhAdEvent);
}
export function guardNetwork() {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("ad-replay: network is not allowed in a replay"); }) as typeof fetch;
  return { calls: () => calls, restore: () => { globalThis.fetch = orig; } };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

async function main() {
  const net = guardNetwork();
  const counter = loadO200k();
  const out = arg("out") || "/workspace/ad-scratch/replay";
  const modeArg = (arg("mode") || "all") as ReplayMode | "all";
  const modes = modeArg === "all" ? REPLAY_MODES : [modeArg];
  if (!modes.every((m) => REPLAY_MODES.includes(m))) throw new Error(`--mode must be off|shadow|on|all`);
  const dp = arg("director-prompt");
  const directorPrompt = dp ? candidateDirectorPrompt(readFileSync(dp, "utf8")) : undefined;
  const common = { counter, pairSample: Number(arg("pair-sample") || 1), seed: Number(arg("seed") || 7), ...(arg("p-inject") ? { pInject: Number(arg("p-inject")) } : {}), ...(directorPrompt ? { directorPrompt } : {}), networkCalls: net.calls };
  mkdirSync(out, { recursive: true });
  const jobs: Array<{ name: string; run: (m: ReplayMode) => Promise<ReplayRun> }> = [];
  const logFile = arg("log");
  if (logFile) {
    const lines = readLog(logFile);
    jobs.push({ name: logFile.replace(/^.*\//, "").replace(/\.jsonl$/, ""), run: (mode) => replayLog(lines, { ...common, mode, kv: new MemoryKV() }) });
  } else {
    const dir = arg("r2") || "/workspace/actor-director/research/R2";
    const lay = arg("layout") || "all";
    for (const [k, names] of Object.entries(R2_LAYOUTS)) {
      if (lay !== "all" && lay !== k) continue;
      const reps = loadR2(dir, names);
      jobs.push({ name: `r2-${k}`, run: (mode) => replayR2(reps, { ...common, mode, kv: new MemoryKV(), turns: Number(arg("turns") || 20), name: k }) });
    }
  }
  const summary: unknown[] = [];
  console.log("source            mode    turns dir_calls notes rails_ok inj shadow blocked judge(pass/flag/unc) share   pairwise(i/p/t) health  net");
  for (const j of jobs) for (const m of modes) {
    const r = await j.run(m);
    writeFileSync(join(out, `${j.name}.${m}.jsonl`), r.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(out, `${j.name}.${m}.pairs.json`), JSON.stringify(r.pairs, null, 1));
    const s = r.summary;
    summary.push(s);
    const lj = `${s.leak_judge.pass ?? 0}/${s.leak_judge.flagged ?? 0}/${s.leak_judge.uncertain ?? 0}`;
    console.log(`${j.name.padEnd(17)} ${m.padEnd(7)} ${String(s.turns).padStart(5)} ${String(s.director_calls).padStart(9)} ${String(s.notes).padStart(5)} ${String(s.rails_passed).padStart(8)} ${String(s.injected).padStart(3)} ${String(s.shadow).padStart(6)} ${String(s.blocked).padStart(7)} ${lj.padStart(20)} ${(s.session_share ?? 0).toFixed(3).padStart(6)} ${`${s.pairwise.injected}/${s.pairwise.plain}/${s.pairwise.tie}`.padStart(15)} ${(s.health.join(",") || "-").padEnd(7)} ${s.network_calls}`);
  }
  writeFileSync(join(out, "summary.json"), JSON.stringify({ director_prompt_id: directorPrompt?.id ?? "frozen", pairwise_judge: "mock-pairwise-heuristic (not a model judgment)", network_calls: net.calls(), runs: summary }, null, 1));
  console.log(`wrote ${out}/summary.json; network calls: ${net.calls()}`);
  net.restore();
  if (net.calls() > 0) process.exit(2);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
