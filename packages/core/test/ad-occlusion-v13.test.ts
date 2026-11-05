/** contract-v1.3 (ruling B1): tab_occluded time is excluded from the expected-reading-time denominator. R1-style turn() case. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/actor-director/gaze-ref.ts";

const layout = { viewport_w: 1194, viewport_h: 834, css_px_per_cm: 52, default_dist_cm: 44, name: "ipad" };
const words2 = 40;
// R1 prior 238 wpm -> 252 ms/word; p1 (12 words) read at the prior speed in 3.0 s; p2 (40 words, 10.1 s at the prior)
// read for 3.0 s, then the Director tab sheet covers the chat for 7 s (the reader looks at the sheet); then the key.
function samples(): R.RawSample[] {
  const s: R.RawSample[] = [];
  const read = (t0: number, t1: number, y: number) => { for (let t = t0; t < t1; t += 33) { const k = Math.floor((t - t0) / 250); s.push({ t, x: 120 + (k % 8) * 100, y: y + (Math.floor(k / 8) % 2) * 24, conf: 0.9, face: true }); } };
  read(0, 3000, 132); read(3000, 6000, 252);
  for (let t = 6000; t < 13000; t += 33) s.push({ t, x: 597, y: 790, conf: 0.9, face: true }); // on the sheet, not a paragraph
  return s;
}
const aois = (frac?: number): R.Aoi[] => [
  { id: "a1.p1", msg: "a1", order: 1, x: 60, y: 120, w: 900, h: 48, words: 12, line_h: 24, visible: [[0, 6000]], ...(frac === undefined ? {} : { expect_frac: frac }) },
  { id: "a1.p2", msg: "a1", order: 2, x: 60, y: 240, w: 900, h: 96, words: words2, line_h: 24, visible: [[0, 6000]], ...(frac === undefined ? {} : { expect_frac: frac }) },
];
const run = (frac?: number) => R.turn({ layout, aois: aois(frac), msg: "a1", open_t: 0, stream_done_t: 0, end_t: 13000, keystrokes: [13000], samples: samples(), history: [] });
const label = (o: any, id: string) => o.digest.paras.find((p: any) => p.aoi === id)?.label;

test("B1: a paragraph partly read before the sheet covered the chat does not look skimmed once the covered time is excluded", () => {
  const frac = R.occlusionExpectFrac([[0, 6000]], [[6000, 13000]], 0, 13000);
  assert.ok(Math.abs(frac - 6000 / 13000) < 1e-9);
  const before = run(); // R1 behaviour (no expect_frac): the uncovered 3 s of a 10 s paragraph reads as a skim
  assert.equal(label(before, "a1.p2"), "skim", JSON.stringify(before.digest.paras));
  const after = run(frac);
  assert.equal(label(after, "a1.p2"), "read", JSON.stringify(after.digest.paras));
  assert.ok(!after.events.some((e: any) => e.aoi === "a1.p2" && (e.kind === "fast_scan" || e.kind === "skip")));
  const f2 = after.events.find((e: any) => e.aoi === "a1.p2");
  if (f2) assert.ok(f2.features.expectedMs < words2 * (60000 / 238));
  // occlusion never creates a deep read: p1 (read at the prior speed) keeps its R1 label
  assert.equal(label(after, "a1.p1"), label(before, "a1.p1"));
  assert.notEqual(label(after, "a1.p1"), "deep");
  // nothing occluded -> 1 (R1 exactly)
  assert.equal(R.occlusionExpectFrac([[0, 5000]], [], 0, 5000), 1);
  assert.deepEqual(R.turn({ layout, aois: aois(1), msg: "a1", open_t: 0, stream_done_t: 0, end_t: 13000, keystrokes: [13000], samples: samples(), history: [] }).digest, before.digest);
});
