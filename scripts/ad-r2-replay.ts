// E5: replay the six R2 gaze files through the streaming GazeSource and score paragraph labels against the
// *.truth.json sidecars (scoring only: the pipeline never sees `truth`). Local only; no network.
//   npx tsx scripts/ad-r2-replay.ts [R2 dir]     (default /workspace/actor-director/research/R2)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayTurn } from "../packages/core/src/actor-director/gaze-replay.ts";
import { turn } from "../packages/core/src/actor-director/gaze-ref.ts";

export const R2_FILES = ["iphone17pro-portrait-01", "iphone17pro-portrait-02", "ipadpro11-m1-landscape-01", "ipadpro11-m1-landscape-02", "macbookair-m1-1440x900-01", "macbookair-m1-1440x900-02"];
const LABEL: Record<string, string> = { read: "read", deep: "deep", skim: "skim", skip: "skipped" };

/** the app-side inputs only: the replay samples + the sidecar's `turn` scaffolding (AOIs, taps, window times) */
export function loadReplay(dir: string, name: string) {
  const rep = JSON.parse(readFileSync(join(dir, "gaze-replays", name + ".json"), "utf8"));
  const side = JSON.parse(readFileSync(join(dir, "gaze-replays", name + ".truth.json"), "utf8"));
  return { rep, spec: side.turn, truthFile: join(dir, "gaze-replays", name + ".truth.json") };
}
/** scoring only */
export function score(out: any, truthFile: string) {
  const truth = JSON.parse(readFileSync(truthFile, "utf8")).truth;
  const labels: Record<string, string> = Object.fromEntries(out.digest.paras.map((p: any) => [p.aoi, p.label]));
  const want: Record<string, string> = Object.fromEntries(Object.entries(truth.intents as Record<string, string>).map(([a, i]) => [a, LABEL[i]!]));
  const agree = Object.entries(want).filter(([a, w]) => labels[a] === w).length;
  const tf = truth.fixations.filter((f: any) => f.aoi);
  let hit = 0;
  for (const f of tf) if (out.fixations.some((d: any) => Math.min(f.t1, d.t1) - Math.max(f.t0, d.t0) >= 0.5 * (f.t1 - f.t0))) hit++;
  return { agree, total: Object.keys(want).length, labels, want, recall: tf.length ? hit / tf.length : null, gate: out.gate };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? "/workspace/actor-director/research/R2";
  const tot = { on: [0, 0], off: [0, 0], refOn: [0, 0], refOff: [0, 0] } as Record<string, [number, number]>;
  console.log("file                        corr  stream labels  (batch ref)  recall  gate  ppd");
  for (const name of R2_FILES) {
    const { rep, spec, truthFile } = loadReplay(dir, name);
    for (const corr of [true, false]) {
      const { out, ppd } = replayTurn(rep.samples, spec, { driftCorrection: corr });
      const s = score(out, truthFile);
      const ref = score(turn({ ...spec, samples: rep.samples, anchors: corr ? spec.anchors : [] }), truthFile);
      const k = corr ? "on" : "off";
      tot[k]![0] += s.agree; tot[k]![1] += s.total;
      tot[corr ? "refOn" : "refOff"]![0] += ref.agree; tot[corr ? "refOn" : "refOff"]![1] += ref.total;
      console.log(`${name.padEnd(27)} ${k.padEnd(4)}  ${s.agree}/${s.total} ${JSON.stringify(Object.values(s.labels))}  (${ref.agree}/${ref.total})  ${s.recall?.toFixed(3)}  ${s.gate}  ${ppd.toFixed(2)}`);
    }
  }
  for (const k of ["on", "off"]) console.log(`TOTAL correction ${k}: stream ${tot[k]![0]}/${tot[k]![1]} (${((100 * tot[k]![0]) / tot[k]![1]).toFixed(0)}%), batch reference ${tot[k === "on" ? "refOn" : "refOff"]![0]}/${tot[k === "on" ? "refOn" : "refOff"]![1]}`);
}
