import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSONAS, inferStyle, runPersona, summarize } from "../src/index.js";

test("sim runs are deterministic per seed", async () => {
  const a = await runPersona(PERSONAS[0]!, { seed: 3, turns: 8 });
  const b = await runPersona(PERSONAS[0]!, { seed: 3, turns: 8 });
  assert.deepEqual(a.hypothesisByTurn, b.hypothesisByTurn);
});

test("Director finds the hidden passion in most runs (mock backend, typing only)", async () => {
  const results = [];
  for (const p of PERSONAS) for (let s = 1; s <= 5; s++) results.push(await runPersona(p, { seed: s, turns: 12 }));
  const found = results.filter((r) => r.found).length / results.length;
  assert.ok(found >= 0.6, `found rate ${found}`);
  for (const sum of summarize(results)) assert.ok(sum.foundRate > 0, `${sum.persona} never found`);
});

test("passion replies score higher engagement than other replies", async () => {
  const r = await runPersona(PERSONAS[1]!, { seed: 1, turns: 12 });
  assert.ok((r.meanEngagementOnPassion ?? 0) > (r.meanEngagementElsewhere ?? 1));
});

test("fake EEG blind run still works", async () => {
  const r = await runPersona(PERSONAS[2]!, { seed: 2, turns: 12, fakeEeg: true });
  assert.equal(r.turns, 12);
});

test("inferStyle reads the mock templates", () => {
  assert.equal(inferStyle("Tell me about a moment when music really grabbed you."), "personal-story");
  assert.equal(inferStyle("If you had a free month to spend only on art, what would you do?"), "hypothetical");
});
