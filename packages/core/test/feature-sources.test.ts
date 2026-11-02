import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessSession, MockBackend, PreparedFeatureSource, ReplayFeatureSource } from "../src/index.js";

test("PreparedFeatureSource feeds exactly the prepared features into the next turn only", async () => {
  const src = new PreparedFeatureSource();
  let clock = 0;
  const s = new HarnessSession({ userId: "p", backend: new MockBackend(1), store: null, sources: [src], clock: () => clock });
  await s.start();
  src.prepare({ "eeg.engagementIndex": 0.9, "eeg.quality": 1 });
  clock = 5000;
  const a = await s.reply("i love telescopes and stars");
  assert.equal(a.user.frame.features["eeg.engagementIndex"], 0.9);
  clock = 9000;
  const b = await s.reply("ok");
  assert.equal(b.user.frame.features["eeg.engagementIndex"], undefined);
});

test("ReplayFeatureSource replays rows in order and filters by prefix", () => {
  const jsonl = [
    JSON.stringify({ type: "director_turn" }),
    JSON.stringify({ type: "user_turn", features: { "eeg.engagementIndex": 0.5, "typing.latencyMs": 3 } }),
    JSON.stringify({ type: "user_turn", features: { "eeg.engagementIndex": 0.7 } }),
  ].join("\n");
  const r = ReplayFeatureSource.fromJsonl(jsonl);
  assert.deepEqual(r.summarize({ from: 0, to: 1 }), { "eeg.engagementIndex": 0.5 });
  assert.deepEqual(r.summarize({ from: 0, to: 1 }), { "eeg.engagementIndex": 0.7 });
  assert.deepEqual(r.summarize({ from: 0, to: 1 }), {});
});
