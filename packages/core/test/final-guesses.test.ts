import { test } from "node:test";
import assert from "node:assert/strict";
import { InterestMap, finalGuesses, type TurnSnapshot } from "../src/index.js";

test("finalGuesses resists a last-turn wobble and prefers the specific refinement", () => {
  const map = InterestMap.fresh("u");
  map.defineTopic("big-year-birding", "competitive birdwatching (Big Year)", "nature");
  for (let i = 0; i < 4; i++) map.observeTopic("big-year-birding", 0.8);
  for (let i = 0; i < 3; i++) map.observeTopic("nature", 0.7);
  map.observeTopic("cooking", 0.84); // one spike on the last turn
  map.observeTopic("travel", 0.3, 2);
  const snaps: TurnSnapshot[] = [];
  for (let t = 1; t <= 9; t++) snaps.push({ turn: t, hypothesis: t >= 4 ? "big-year-birding" : null, top: [["big-year-birding", 0.8, 4], ["nature", 0.7, 3], ["travel", 0.3, 2]] });
  snaps.push({ turn: 10, hypothesis: "cooking", top: [["cooking", 0.84, 1], ["big-year-birding", 0.8, 4], ["nature", 0.7, 3]] });
  const g = finalGuesses(map, snaps, 3);
  assert.equal(g.length, 3);
  assert.equal(g[0]!.topic, "big-year-birding");
  assert.equal(g[0]!.label, "competitive birdwatching (Big Year)");
  assert.equal(g[0]!.parent, "nature");
  assert.ok(g.findIndex((x) => x.topic === "cooking") !== 0);
});
