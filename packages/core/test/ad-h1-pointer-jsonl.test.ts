// Step 3: H1 pointer local JSONL parse + required pointer session fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/ad-contracts/index.ts";
import {
  ActorDirectorSession, AdStorage, AdSessionLog, ManualClock, MockAdBackend, loadO200k, PointerCapture, emptyModeDigest,
  assertPointerH1SessionFields, h1PointerJsonlRelPath, h1PointerPreamble, parsePointerH1Jsonl, H1_POINTER_SESSION_SCHEMA,
} from "../src/actor-director/index.ts";
import { MemoryKV } from "../src/platform/kv.ts";

test("h1-pointer: preamble + path helpers", () => {
  const pre = h1PointerPreamble({ sessionId: "mac-1", input_mode: "pointer", actor_model: C.DEFAULT_ACTOR_MODEL, director_model: C.DEFAULT_DIRECTOR_MODEL, t: "2026-11-05T20:00:00.000Z" });
  assert.equal(pre.schema, H1_POINTER_SESSION_SCHEMA);
  assert.equal(pre.fps, null);
  assert.equal(pre.camera, "n/a");
  assert.equal(pre.input_mode, "pointer");
  assert.equal(h1PointerJsonlRelPath("mac-1730845"), "h1-pointer/mac-1730845.jsonl");
  assert.equal(h1PointerJsonlRelPath("../evil"), "h1-pointer/.._evil.jsonl");
});

test("h1-pointer: JSONL lines parse and include required pointer session fields", async () => {
  const o200k = loadO200k();
  const storage = await AdStorage.open(new MemoryKV());
  const clock = new ManualClock();
  const log = new AdSessionLog(storage, "s-h1-ptr", "tab_visible", clock);
  const main: string[] = [];
  log.onMainLine = (ev) => main.push(JSON.stringify(ev));
  const mock = new MockAdBackend([], () => ({ text: "hi" }));
  const s = new ActorDirectorSession({
    log, userId: "u", sessionType: "tab_visible", arm: "on", actor: mock, director: mock, counter: o200k,
    consent: { camera: false, rawGaze: false }, inputMode: "pointer",
    models: { actor: C.DEFAULT_ACTOR_MODEL, director: C.DEFAULT_DIRECTOR_MODEL },
  });
  s.start();
  // interactive layout + pointer batch + digest (chip pass)
  s.logGaze({
    type: "aoi_layout", turn: 0, msg: "a0", orientation: "landscape_right",
    boxes: [{ aoi: "a0.c1", words: 3, x: 10, y: 20, w: 80, h: 24, interactive: true }],
  });
  const cap = new PointerCapture(C.DEFAULT_POINTER_CONFIG);
  cap.setInteractive([{ aoi: "a0.c1", msg: "a0", excerpt: "Show the math" }]);
  cap.enter("a0.c1", 100);
  cap.click("a0.c1", 150);
  cap.tick(700);
  const { pointer, batches } = cap.closeWindow(720);
  for (const b of batches) s.logPointer({ type: "pointer_l1", t0: b.t0, t1: b.t1, events: b.events });
  s.observeReading({ digest: emptyModeDigest("a0", 620, "pointer", pointer), events: [], faceFrac: null, baselineParagraphs: 0 });

  const text = [JSON.stringify(h1PointerPreamble({ sessionId: "s-h1-ptr", input_mode: "pointer", actor_model: C.DEFAULT_ACTOR_MODEL, director_model: C.DEFAULT_DIRECTOR_MODEL })), ...main].join("\n") + "\n";
  const parsed = parsePointerH1Jsonl(text);
  assert.equal(parsed.preamble.schema, H1_POINTER_SESSION_SCHEMA);
  assert.equal(parsed.preamble.fps, null);
  assert.equal(parsed.preamble.camera, "n/a");
  const miss = assertPointerH1SessionFields(parsed);
  assert.deepEqual(miss, [], miss.join(", "));
  assert.ok(parsed.events.some((e) => e.type === "pointer_l1"));
  assert.ok(parsed.events.some((e) => e.type === "attention_digest" && e.digest.input_mode === "pointer"));
  // also still in AdStorage (existing local log path)
  const stored = storage.read("visible", "s-h1-ptr");
  assert.ok(stored && stored.includes('"type":"session_start"') && stored.includes('"input_mode":"pointer"'));
});

test("h1-pointer: parse rejects bad preamble", () => {
  assert.throws(() => parsePointerH1Jsonl('{"schema":"nope"}\n'), /bad schema/);
  assert.throws(() => parsePointerH1Jsonl(JSON.stringify({ schema: H1_POINTER_SESSION_SCHEMA, sessionId: "x", input_mode: "pointer", fps: 30, camera: "n/a", t: "t", note: "n" }) + "\n"), /fps must be null/);
});
