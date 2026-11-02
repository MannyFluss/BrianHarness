// rankLeadEeg: the PREREG_leadeeg §9 wrapper over eegReorder (pure, w=0) and the prototype blend (w>0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankLeadEeg, eegReorder, LEAD_EEG_Z, type TurnSnapshot } from "../src/index.ts";

const L = (label: string, confidence: number, turns: number[]) => ({ label, confidence, turns });
// 8 turns; turns 5-8 hot, 1-4 cold
const eeg = [0.5, 0.52, 0.48, 0.5, 1.6, 1.7, 1.65, 1.6];

test("rankLeadEeg pure (w undefined / 0) == eegReorder on ln(EI), default z = LEAD_EEG_Z", () => {
  const labels = [L("cold", 0.9, [1, 2, 3]), L("hot", 0.5, [5, 6, 7]), L("none", 0.4, [])];
  const hist: TurnSnapshot[] = eeg.map((v) => ({ turn: 0, hypothesis: null, top: [], eegLn: Math.log(v) }));
  const ref = eegReorder(labels.map((l) => l.label), labels.map((l) => l.turns), hist);
  assert.deepEqual(rankLeadEeg(labels, eeg), ref);
  assert.deepEqual(rankLeadEeg(labels, eeg, { w: 0 }), ref);
  assert.deepEqual(ref, ["hot", "cold", "none"]);
  // a huge margin (z) keeps the extractor order
  assert.deepEqual(rankLeadEeg(labels, eeg, { margin: 50 }), ["cold", "hot", "none"]);
  assert.equal(LEAD_EEG_Z, 1.645);
});

test("rankLeadEeg pure: too few EEG turns / missing EEG / no labels keep extractor order; all labels returned", () => {
  const labels = [L("a", 0.9, [1]), L("b", 0.8, [2]), L("c", 0.7, [3]), L("d", 0.6, [3]), L("e", 0.5, [2])];
  assert.deepEqual(rankLeadEeg(labels, [0.1, 5, 9]), ["a", "b", "c", "d", "e"]); // 3 < LEAD_EEG_MIN_TURNS
  assert.deepEqual(rankLeadEeg(labels, []), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(rankLeadEeg([], eeg), []);
  // null EEG on the cited turns: never moves, never passed
  const nul = [null, null, null, null, 1.6, 1.7, 1.65, 1.6, 0.5, 0.5];
  assert.deepEqual(rankLeadEeg([L("x", 0.9, [1, 2]), L("y", 0.5, [5, 6])], nul), ["x", "y"]);
});

test("rankLeadEeg pure tie_break: 'eeg' moves exactly at the threshold, 'extractor' (default) does not", () => {
  // two labels, one turn each: need zb - za > z*sqrt(2). Put z = (zb - za)/sqrt(2) exactly.
  const e = [1, 2, 3, 4, 5, 6];
  const ln = e.map(Math.log), mu = ln.reduce((a, b) => a + b) / 6;
  const sd = Math.sqrt(ln.reduce((a, b) => a + (b - mu) ** 2, 0) / 5);
  const z = ((ln[5]! - mu) / sd - (ln[0]! - mu) / sd) / Math.sqrt(2);
  const labels = [L("a", 0.9, [1]), L("b", 0.5, [6])];
  assert.deepEqual(rankLeadEeg(labels, e, { margin: z }), ["a", "b"]);
  assert.deepEqual(rankLeadEeg(labels, e, { margin: z, tie_break: "eeg" }), ["b", "a"]);
  assert.deepEqual(eegReorder(["a", "b"], [[1], [6]], ln.map((v) => ({ turn: 0, hypothesis: null, top: [], eegLn: v }))), ["b", "a"]);
});

test("rankLeadEeg blend (w>0) = prototype: conf + w*zbar(pstdev), margin in score units keeps #1", () => {
  const labels = [L("cold", 0.9, [1, 2, 3]), L("hot", 0.7, [5, 6, 7]), L("mid", 0.8, [])];
  // pstdev z: cold ~ -1, hot ~ +1 -> scores cold .65, hot .95, mid .8
  assert.deepEqual(rankLeadEeg(labels, eeg, { w: 0.25 }), ["hot", "mid", "cold"]);
  // new leader beats #1 by ~0.3 score units: margin 0.2 lets it lead, 0.4 keeps cold first, rest in blend order
  assert.deepEqual(rankLeadEeg(labels, eeg, { w: 0.25, margin: 0.2 }), ["hot", "mid", "cold"]);
  assert.deepEqual(rankLeadEeg(labels, eeg, { w: 0.25, margin: 0.4 }), ["cold", "hot", "mid"]);
  // no EEG at all: zbar 0 -> confidence order (stable on ties by list order)
  assert.deepEqual(rankLeadEeg([L("a", 0.5, [1]), L("b", 0.9, [2]), L("c", 0.5, [3])], [], { w: 0.25 }), ["b", "a", "c"]);
});

test("rankLeadEeg blend tie_break: exact score ties go by list order ('extractor') or higher zbar first ('eeg')", () => {
  const e = [1, 1, 1, 1, Math.E, Math.E, Math.E, Math.E]; // ln: 0 x4, 1 x4 -> pstdev z = -1 / +1
  // a: conf .75, z -1 -> .5 ; b: conf .25, z +1 -> .5 (tie)
  const labels = [L("first", 0.9, [1]), L("a", 0.75, [1]), L("b", 0.25, [5])];
  assert.deepEqual(rankLeadEeg(labels, e, { w: 0.25 }), ["first", "a", "b"]);
  assert.deepEqual(rankLeadEeg(labels, e, { w: 0.25, tie_break: "eeg" }), ["first", "b", "a"]);
});

test("rankLeadEeg is pure and deterministic (inputs untouched, same output)", () => {
  const labels = [L("cold", 0.9, [1, 2, 3]), L("hot", 0.7, [5, 6, 7])];
  const snap = JSON.stringify([labels, eeg]);
  const a = rankLeadEeg(labels, eeg, { w: 0.25 }), b = rankLeadEeg(labels, eeg, { w: 0.25 });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify([labels, eeg]), snap);
});
