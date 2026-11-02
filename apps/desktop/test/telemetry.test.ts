import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySource, classifyInput, type SourceState } from "../src/telemetry.ts";

const st = (o: Partial<SourceState> = {}): SourceState => ({ lastKeyAt: 0, lastKeyHardware: false, sawHardwareKeys: false, touchDevice: false, ...o });

test("input source classification (beforeinput inputType + context)", () => {
  const now = 10_000;
  assert.equal(classifySource("insertText", "a", false, now, st({ lastKeyAt: now - 10, lastKeyHardware: true })), "hardware-key");
  assert.equal(classifySource("insertText", "a", false, now, st({ lastKeyAt: now - 10, touchDevice: true })), "soft-keyboard");
  assert.equal(classifySource("insertText", "a", false, now, st({ lastKeyAt: now - 10, touchDevice: true, sawHardwareKeys: true })), "hardware-key");
  assert.equal(classifySource("insertText", "a", false, now, st({ touchDevice: true })), "soft-keyboard");
  assert.equal(classifySource("insertText", "hello ", false, now, st({ touchDevice: true })), "predictive");
  assert.equal(classifySource("insertReplacementText", "their", false, now, st()), "autocorrect");
  assert.equal(classifySource("insertCompositionText", "ni", true, now, st()), "composition");
  assert.equal(classifySource("insertFromPaste", null, false, now, st()), "paste");
  assert.equal(classifySource("insertFromDrop", null, false, now, st()), "drop");
  assert.equal(classifySource("deleteContentBackward", null, false, now, st({ lastKeyAt: now - 5, lastKeyHardware: true })), "hardware-key");
  assert.equal(classifyInput("deleteContentBackward"), "delete");
  assert.equal(classifyInput("insertFromPaste"), "paste");
  assert.equal(classifyInput("insertReplacementText"), "insert");
});
