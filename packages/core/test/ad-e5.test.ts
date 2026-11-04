// E5: gaze compression L0-L4. (1) the TS port of R1 reference.py reproduces all 56 R1 cases (diff tol 1e-6, plus
// the cases' hand-derived checks); (2) the streaming GazeStream/GazeSource, fed ~100 ms batches, gives exactly the
// batch result (turn, fixations, clean, gaze_l1 log); (3) drift caps are config; (4) bodies validate against
// bh-ad/1; (5) paragraph visibility; (6) the R2 replays (local research data; skipped when absent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import AjvMod from "ajv";
import * as R from "../src/actor-director/gaze-ref.ts";
import { GazeSource, GazeStream, replayTurn, ParagraphVisibility, splitParagraphs, aoiId, collectParaBoxes } from "../src/actor-director/index.ts";
import { paragraphs } from "../src/actor-director/digest.ts";
import { BH_AD_SCHEMA } from "../src/ad-contracts/index.ts";

type Case = { id: string; stage: string; input: any; config?: any; expected: any; checks?: any[] };
const CASES = JSON.parse(gunzipSync(readFileSync(join(import.meta.dirname, "fixtures", "r1", "r1-cases.json.gz"))).toString("utf8")) as Case[];

const TOL = 1e-6;
function diff(a: any, b: any, p = "$"): string[] {
  if (typeof a === "boolean" || typeof b === "boolean" || a === null || b === null || typeof a === "string") return a === b ? [] : [`${p}: expected ${JSON.stringify(a)} got ${JSON.stringify(b)}`];
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a)) ? [] : [`${p}: expected ${a} got ${b}`];
  if (Array.isArray(a) && Array.isArray(b)) return a.length !== b.length ? [`${p}: expected ${a.length} items got ${b.length}`] : a.flatMap((x, i) => diff(x, b[i], `${p}[${i}]`));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.join() !== kb.join() ? [`${p}: keys differ ${ka} vs ${kb}`] : ka.flatMap((k) => diff(a[k], b[k], `${p}.${k}`));
  }
  return [`${p}: type ${typeof a} vs ${typeof b}`];
}
// port of R1 tools/check.py run_checks
function get(o: any, path: string) { let cur = o; for (const k of path.split(".")) cur = Array.isArray(cur) ? cur[Number(k)] : cur[k]; return cur; }
function runChecks(c: Case, out: any) {
  for (const chk of c.checks ?? []) {
    const [op, path] = chk, v = get(out, path);
    const ok = op === "eq" ? JSON.stringify(v) === JSON.stringify(chk[2]) : op === "len" ? v.length === chk[2] : op === "approx" ? v !== null && Math.abs(v - chk[2]) <= chk[3]
      : op === "range" ? chk[2] <= v && v <= chk[3] : op === "lt" ? v !== null && v < chk[2] : op === "gt" ? v !== null && v > chk[2] : op === "gte" ? v !== null && v >= chk[2]
      : op === "haskind" ? v.filter((e: any) => e.kind === chk[2]).length === chk[3] : op === "kinds" ? JSON.stringify(v.map((e: any) => e.kind).sort()) === JSON.stringify([...chk[2]].sort()) : (() => { throw new Error(op); })();
    assert.ok(ok, `${c.id}: check ${JSON.stringify(chk)} failed, got ${JSON.stringify(v)}`);
  }
}

test("R1: 56 cases, every stage, TS port == reference.py output (+ hand-derived checks)", () => {
  assert.equal(CASES.length, 56);
  assert.deepEqual([...new Set(CASES.map((c) => c.stage))].sort(), ["baseline", "calib", "clean", "drift", "fixations", "log", "ppd", "quality", "saccades", "turn", "window"]);
  for (const c of CASES) {
    const got = R.runStage(c);
    const d = diff(c.expected, got);
    assert.deepEqual(d, [], `${c.id}\n${d.slice(0, 10).join("\n")}`);
    runChecks(c, got);
  }
});

test("Python rounding semantics: half-even on the exact binary value, floor division", () => {
  assert.equal(R.pyRound(0.5), 0); assert.equal(R.pyRound(1.5), 2); assert.equal(R.pyRound(2.675, 2), 2.67); assert.equal(R.pyRound(-0.5), -0);
  assert.equal(R.pyFloorDiv(-1, 5000), -1); assert.equal(R.pyFloorDiv(9999, 5000), 1);
});

const sorted = (ss: any[]) => [...ss].sort((a, b) => a.t - b.t);
const fixKeys = (f: any) => ({ id: f.id, t0: f.t0, t1: f.t1, x: f.x, y: f.y, dispPx: f.dispPx, n: f.n });
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function chunks<T>(xs: T[], sizes: () => number): T[][] { const out: T[][] = []; for (let i = 0; i < xs.length;) { const n = Math.max(1, sizes()); out.push(xs.slice(i, i + n)); i += n; } return out; }
const BATCHINGS: Array<[string, () => () => number]> = [["1", () => () => 1], ["3 (~100 ms)", () => () => 3], ["7", () => () => 7], ["random 1-40", () => { const r = rng(7); return () => 1 + Math.floor(r() * 40); }]];

function streamTurn(c: Case, sizes: () => number, anchorsUpfront = true) {
  const i = c.input, l1: any[] = [];
  const src = new GazeSource({ ppd: R.layoutPpd(i.layout, i.dist_cm ?? null), viewport: { w: i.layout.viewport_w, h: i.layout.viewport_h }, config: c.config, onL1: (b) => l1.push(b) });
  src.setAois(i.aois);
  const anchors = sorted(i.anchors ?? []);
  if (anchorsUpfront) for (const a of anchors) src.anchor(a);
  let ai = 0;
  for (const b of chunks(sorted(i.samples), sizes)) {
    src.push(b);
    // realistic: an anchor arrives ~100 ms after its tap (inside anchor_hold_ms)
    while (!anchorsUpfront && ai < anchors.length && anchors[ai].t + 100 <= b[b.length - 1].t) src.anchor(anchors[ai++]);
  }
  while (ai < anchors.length && !anchorsUpfront) src.anchor(anchors[ai++]);
  const out = src.closeTurn({ ...i, anchors: [] });
  src.stream.flush();
  return { out, l1 };
}

test("stream == batch: every R1 turn case, any batching, anchors upfront or delivered late", () => {
  const turns = CASES.filter((c) => c.stage === "turn");
  assert.equal(turns.length, 9);
  for (const c of turns) for (const [name, mk] of BATCHINGS) for (const upfront of [true, false]) {
    // late delivery is exact as long as the anchor arrives within anchor_hold_ms (300) of its tap; big random
    // batches (up to 1.3 s) break that on purpose, see the late_anchors test below
    if (!upfront && name.startsWith("random")) continue;
    const { out } = streamTurn(c, mk(), upfront);
    const d = diff(c.expected, out);
    assert.deepEqual(d, [], `${c.id} batching ${name} anchorsUpfront=${upfront}\n${d.slice(0, 6).join("\n")}`);
  }
});

test("stream == batch: gaze_l1 log windows (fixations/saccades/gaps per 5 s window)", () => {
  for (const c of CASES.filter((c) => c.stage === "turn")) {
    const e = c.expected, ts = c.input.samples.map((s: any) => s.t);
    let end = Math.max(...ts); for (const f of e.fixations) end = Math.max(end, f.t1); for (const g of e.gaps) end = Math.max(end, g.t1);
    const ref = R.gazeL1Batches(e.fixations, e.saccades, e.gaps, Math.min(...ts), end + 1).filter((b: any) => b.fixations.length || b.saccades.length || b.gaps.length);
    const strip = (b: any) => ({ t0: b.t0, f: b.fixations, s: b.saccades, g: b.gaps });
    for (const [name, mk] of BATCHINGS) {
      const { l1 } = streamTurn(c, mk());
      const d = diff(JSON.parse(JSON.stringify(ref.map(strip))), l1.map(strip));
      assert.deepEqual(d, [], `${c.id} ${name}\n${d.slice(0, 6).join("\n")}`);
      for (const b of l1) { assert.ok(b.fixations.length <= 20 && b.saccades.length <= 10 && b.gaps.length <= 10); assert.ok(b.t1 - b.t0 <= 5000); }
    }
  }
});

test("stream == batch: every R1 fixations and clean case", () => {
  for (const c of CASES.filter((c) => c.stage === "fixations" || c.stage === "clean")) for (const [name, mk] of BATCHINGS) {
    const i = c.input, g = new GazeStream({ ppd: i.ppd, viewport: i.viewport, config: { ...c.config, drift_correction: false } });
    for (const b of chunks(sorted(i.samples), mk())) g.push(b);
    const snap = g.snapshot();
    const cl = R.clean(i.samples, i.viewport, i.ppd, c.config);
    if (c.stage === "fixations") {
      const fx = R.mergeFixations(R.idt(R.smoothMedian(cl.samples, c.config), i.ppd, c.config), cl.gaps, i.ppd, c.config);
      assert.deepEqual(diff(R.r6({ f: fx.map(fixKeys), g: cl.gaps }), R.r6({ f: snap.fixations.map(fixKeys), g: snap.gaps })), [], `${c.id} ${name}`);
    } else {
      assert.deepEqual(snap.cleanedTimes.map((s) => s.t), cl.samples.map((s) => s.t), `${c.id} ${name}`);
      assert.deepEqual(diff(R.r6(cl.gaps), R.r6(snap.gaps)), [], `${c.id} ${name} gaps`);
      g.flush();
      const { late_samples, late_anchors, ...st } = g.stats;
      assert.deepEqual([late_samples, late_anchors], [0, 0]);
      assert.deepEqual(st, cl.stats, `${c.id} ${name} stats`);
    }
  }
});

test("snapshot() does not disturb the live stream; late samples are dropped and counted", () => {
  const c = CASES.find((c) => c.stage === "turn" && (c.input.anchors ?? []).length)!;
  const i = c.input, ss = sorted(i.samples);
  const mk = () => { const s = new GazeSource({ ppd: R.layoutPpd(i.layout, i.dist_cm ?? null), viewport: { w: i.layout.viewport_w, h: i.layout.viewport_h }, config: c.config }); s.setAois(i.aois); for (const a of i.anchors) s.anchor(a); return s; };
  const a = mk(), b = mk();
  for (const [k, batch] of chunks(ss, () => 3).entries()) { a.push(batch); b.push(batch); if (k % 5 === 0) a.closeTurn({ ...i, anchors: [] }); }
  assert.deepEqual(a.closeTurn({ ...i, anchors: [] }), b.closeTurn({ ...i, anchors: [] }));
  const before = a.stream.stats.late_samples;
  a.push([{ ...ss[0], t: ss[0].t }]);
  assert.equal(a.stream.stats.late_samples, before + 1);
  const f = a.summarize({ from: ss[0].t, to: ss[ss.length - 1].t + 1 });
  for (const k of ["gaze.quality", "gaze.faceFrac", "gaze.fixations", "gaze.meanFixMs", "gaze.awayMs"]) assert.equal(typeof f[k], "number", k);
  assert.ok(f["gaze.fixations"]! > 0);
});

test("an anchor that arrives after anchor_hold_ms is still applied going forward and counted in late_anchors", () => {
  const c = CASES.find((c) => c.stage === "turn" && (c.input.anchors ?? []).length)!;
  const i = c.input, ss = sorted(i.samples);
  const s = new GazeSource({ ppd: R.layoutPpd(i.layout, i.dist_cm ?? null), viewport: { w: i.layout.viewport_w, h: i.layout.viewport_h }, config: c.config });
  s.setAois(i.aois);
  s.push(ss);
  for (const a of i.anchors) s.anchor(a);
  assert.equal(s.stream.stats.late_anchors, i.anchors.length);
  s.closeTurn({ ...i, anchors: [] });
});

test("drift correction caps are config (PROVISIONAL), not constants", () => {
  assert.equal(R.GAZE_DEFAULTS.drift_reject_deg, 4); assert.equal(R.GAZE_DEFAULTS.drift_max_deg, 3);
  const ppd = 40, win = Array.from({ length: 8 }, () => ({ x: 100, y: 100 }));
  const off3_5 = { t: 1000, x: 100 + 3.5 * ppd, y: 100 }; // a 3.5 deg offset
  assert.equal(R.driftUpdate({ bx: 0, by: 0 }, off3_5, win, ppd, R.cfg()).used, true);
  assert.equal(R.driftUpdate({ bx: 0, by: 0 }, off3_5, win, ppd, R.cfg({ drift_reject_deg: 3 })).used, false);
  // total cap: repeated 3.9 deg anchors converge to drift_max_deg
  for (const cap of [3, 1.5]) {
    let b = { bx: 0, by: 0 };
    for (let k = 0; k < 10; k++) { const s = R.driftUpdate(b, { t: k, x: 100 + 3.9 * ppd + b.bx, y: 100 }, win, ppd, R.cfg({ drift_max_deg: cap, drift_reject_deg: 100 })); b = { bx: s.bx, by: s.by }; }
    assert.ok(Math.hypot(b.bx, b.by) / ppd <= cap + 1e-9, `cap ${cap}`);
  }
  // the stream honours the same config, and drift_correction:false ignores anchors
  const c = CASES.find((c) => c.stage === "turn" && (c.input.anchors ?? []).length)!;
  const run = (config: any) => { const i = c.input, s = new GazeSource({ ppd: R.layoutPpd(i.layout, i.dist_cm ?? null), viewport: { w: i.layout.viewport_w, h: i.layout.viewport_h }, config: { ...c.config, ...config } }); s.setAois(i.aois); for (const a of i.anchors) s.anchor(a); s.push(sorted(i.samples)); return s.closeTurn({ ...i, anchors: [] }); };
  assert.deepEqual(run({ drift_correction: false }), R.turn({ ...c.input, anchors: [] }, c.config));
  assert.deepEqual(run({ drift_reject_deg: 0 }), R.turn({ ...c.input, anchors: [] }, c.config));
});

// bh-ad/1 schema validity of what the stream logs
const SCHEMAS = join(import.meta.dirname, "..", "src", "ad-contracts", "schemas");
const Ajv = (AjvMod as unknown as { default?: typeof AjvMod }).default ?? AjvMod;
const ajv = new (Ajv as unknown as new (o: object) => { addSchema(s: object): void; getSchema(r: string): ((v: unknown) => boolean) & { errors?: unknown } | undefined })({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
for (const f of ["gaze-sample.schema.json", "gaze-plugin.schema.json", "note.schema.json", "bh-ad-events.schema.json", "worker.schema.json"]) ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS, f), "utf8")));
let seq = 0;
const env = (body: any) => ({ schema: BH_AD_SCHEMA, t: "2026-11-04T23:00:00.000Z", mono: 1, sessionId: "s-e5", seq: seq++, ...body });
function assertValid(body: any) {
  const v = ajv.getSchema(`https://brianharness.app/contracts/v1/bh-ad-events.schema.json#/definitions/ev_${body.type}`)!;
  assert.ok(v, body.type);
  assert.ok(v(env(body)), `${body.type}: ${JSON.stringify(v.errors)}`);
}
test("bh-ad/1: streamed gaze_l1 and per-turn bodies validate", () => {
  let n = 0;
  for (const c of CASES.filter((c) => c.stage === "turn")) {
    const { out, l1 } = streamTurn(c, () => 3);
    for (const b of l1) { assertValid(b); n++; }
    for (const k of ["aoi_layout", "gaze_quality", "aoi_dwell", "attention_digest"]) { assertValid(out[k]); n++; }
  }
  assert.ok(n > 40);
});

test("paragraph split: same paragraphs as digest.ts, separators kept (text rebuilds exactly)", () => {
  for (const t of ["one", "a\n\nb", "a\n \n\n  b\n\n\nc  ", "\n\nlead\n\n", "x\ny\n\nz", "", "  \n\n  "]) {
    const ch = splitParagraphs(t);
    assert.equal(ch.map((c) => c.text).join(""), t);
    assert.deepEqual(ch.filter((c) => c.p !== null).map((c) => c.text.trim()), paragraphs(t), JSON.stringify(t));
    assert.deepEqual(ch.filter((c) => c.p !== null).map((c) => c.p), paragraphs(t).map((_, k) => k));
  }
});

test("ParagraphVisibility: visible intervals, >=50% rules, complete_t, gaze-ref AOIs", () => {
  const v = new ParagraphVisibility({ w: 400, h: 800 });
  const box = (p: number, y: number, h = 100) => ({ msg: "m1", p, x: 0, y, w: 400, h, text: "w ".repeat(10 + p) });
  v.update(1000, [box(0, 100)], true);                    // p0 streaming
  v.update(1500, [box(0, 100), box(1, 300)], true);       // p1 appears: p0 complete
  v.update(2000, [box(0, -60), box(1, 140)], true);       // p0 40% visible: hidden
  v.streamDone(2500);
  v.update(3000, [box(0, -60), box(1, 140), box(2, 760, 1000)], false); // p2 tall, 40 px inside: hidden
  v.update(3500, [box(0, -60), box(1, -500), box(2, 100, 1000)], false); // p2 covers 700/800 of the viewport: visible
  const a = Object.fromEntries(v.aois(4000).map((x) => [x.id, x]));
  assert.deepEqual(a[aoiId("m1", 0)].visible, [[1000, 2000]]);
  assert.equal(a[aoiId("m1", 0)].complete_t, 1500);
  assert.deepEqual(a[aoiId("m1", 1)].visible, [[1500, 3500]]);
  assert.equal(a[aoiId("m1", 1)].complete_t, 2500);
  assert.deepEqual(a[aoiId("m1", 2)].visible, [[3500, 4000]]);
  assert.equal(a[aoiId("m1", 2)].words, 12);
  assert.equal(v.visibleMs(aoiId("m1", 1)), 2000);
  assert.equal(v.layoutBoxes("m1").length, 3);
  // configurable thresholds
  const loose = new ParagraphVisibility({ w: 400, h: 800 }, { minVisibleFrac: 0.3 });
  assert.equal(loose.isVisible({ y: -60, h: 100 }), true);
  // DOM helper
  const fake = { querySelectorAll: () => [{ getAttribute: (n: string) => (n === "data-msg" ? "m9" : "2"), getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }), textContent: "two words" }] };
  assert.deepEqual(collectParaBoxes(fake), [{ msg: "m9", p: 2, x: 1, y: 2, w: 3, h: 4, text: "two words", words: 2 }]);
});

// R2: six local replays (bh-gaze-replay/1). Research data, not committed: skipped when absent.
const R2 = "/workspace/actor-director/research/R2";
const R2_EXPECTED = { // VALIDATION.json label agreement at seed 1 (Python reference), cited (off) / anchored (on)
  "iphone17pro-portrait-01": [1, 3], "iphone17pro-portrait-02": [0, 3], "ipadpro11-m1-landscape-01": [1, 3],
  "ipadpro11-m1-landscape-02": [1, 1], "macbookair-m1-1440x900-01": [1, 1], "macbookair-m1-1440x900-02": [0, 0],
} as Record<string, [number, number]>;
test("R2: streamed replays in 100 ms batches match the Python validation, correction off and on", { skip: !existsSync(join(R2, "gaze-replays")) && "R2 research data not present" }, async () => {
  const { loadReplay, score } = await import("../../../scripts/ad-r2-replay.ts");
  for (const [name, [off, on]] of Object.entries(R2_EXPECTED)) {
    const { rep, spec, truthFile } = loadReplay(R2, name);
    for (const [corr, want] of [[false, off], [true, on]] as const) {
      const l1: any[] = [];
      const { out } = replayTurn(rep.samples, spec, { driftCorrection: corr, onL1: (b) => l1.push(b) });
      assert.equal(score(out, truthFile).agree, want, `${name} correction ${corr}`);
      for (const b of l1) assertValid(b);
    }
  }
});
