// Nov 3 2026 (Addendum 4, composer lock): keystrokes that landed before the Director's message was complete
// (t < prompt.completeAt) are counted on the user_turn (they are outside every typing.* window), same keys in
// every turn and arm; 0/null in normal use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessSession, MemoryHarnessStorage, MockBackend, type LogEvent, type TypingEvent } from "../src/browser.ts";

type UT = Extract<LogEvent, { type: "user_turn" }>;
async function turn(events: (completeAt: number) => TypingEvent[], adaptation?: "adaptive" | "baseline") {
  const store = new MemoryHarnessStorage();
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(), seed: 1, store, ...(adaptation ? { adaptation, study: { id: "phaseD", index: 1, total: 10, scheduleHash: "a".repeat(64), protocol: 3 } } : {}) });
  await s.start();
  const completeAt = 1_000_000;
  s.markShown(completeAt);
  await s.reply("hi there", events(completeAt), completeAt + 5000);
  return store.readSession(s.id).find((e) => e.type === "user_turn") as UT;
}

test("keys typed before completeAt are counted and timed; typing.* features ignore them", async () => {
  const u = await turn((c) => [
    { t: c - 1200, kind: "insert", len: 1 }, { t: c - 300, kind: "paste", len: 4, chars: 3 },
    { t: c + 800, kind: "insert", len: 5 }, { t: c + 900, kind: "insert", len: 6 }, { t: c + 5000, kind: "submit", len: 8 },
  ]);
  assert.equal(u.keys_before_complete, 2);
  assert.equal(u.first_key_before_complete_ms, 1200);
  assert.equal(u.features["typing.latencyToFirstKeyMs"], 800, "the feature window starts at completeAt");
});

test("normal turn: 0 and null (keys present on every user_turn)", async () => {
  const u = await turn((c) => [{ t: c + 700, kind: "insert", len: 1 }, { t: c + 5000, kind: "submit", len: 1 }]);
  assert.equal(u.keys_before_complete, 0);
  assert.equal(u.first_key_before_complete_ms, null);
});

test("nav keys and the submit marker never count", async () => {
  const u = await turn((c) => [{ t: c - 50, kind: "nav", len: 0 } as TypingEvent, { t: c + 10, kind: "insert", len: 1 }, { t: c + 5000, kind: "submit", len: 1 }]);
  assert.equal(u.keys_before_complete, 0);
});

test("parity: user_turn keys identical across arms", async () => {
  const keys = new Set<string>();
  for (const arm of ["adaptive", "baseline"] as const) for (const early of [false, true]) {
    const u = await turn((c) => [...(early ? [{ t: c - 10, kind: "insert" as const, len: 1 }] : []), { t: c + 5000, kind: "submit", len: 1 }], arm);
    keys.add(Object.keys(u).sort().join(","));
  }
  assert.equal(keys.size, 1, [...keys].join("\n"));
});
