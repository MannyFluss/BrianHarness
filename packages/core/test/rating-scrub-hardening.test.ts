// Researcher hardening (Nov 3 2026) of the core rating backstop (ratingScrubEvent): rating keys are dropped by prefix,
// case-insensitive (absorption_value too), and any 1-5 digit label on a rating screen is generic whatever the control
// type, with its state stripped ({label:'4', control:'button', pressed:true} used to survive).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ratingScrubEvent } from "../src/browser.ts";

test("rating keys dropped by prefix, case-insensitive, at any depth", () => {
  const e = ratingScrubEvent({ ts: 1, type: "tap", data: { name: "Send", absorption_value: 4, Absorption: 3, ratingValue: 2, RATING_X: 1, hooked_score: 5, blind_guess: "a", BlindGuessArm: "b", nested: { absorptionScore: 4, keep: 1 }, keep: "ok" } } as any);
  assert.deepEqual(e.data, { name: "Send", nested: { keep: 1 }, keep: "ok" });
});

test("digit label on a rating screen -> generic, state stripped, any control type", () => {
  const scr = ratingScrubEvent({ ts: 1, type: "screen", data: { screen: "session-rating", controls: [
    { label: "4", control: "button", pressed: true }, { label: " 2 ", control: "radio", checked: true, index: 1 }, { label: "3", control: "link", selected: true, value: "3" }, { label: "Done", control: "button" },
  ] } } as any);
  const cs = (scr.data as any).controls;
  assert.deepEqual(cs.slice(0, 3), [{ label: "rating option", control: "button" }, { label: "rating option", control: "radio" }, { label: "rating option", control: "link" }]);
  assert.deepEqual(cs[3], { label: "Done", control: "button" });
  const tap = ratingScrubEvent({ ts: 2, type: "tap", data: { name: "5", control: "button", pressed: true, screen: "turn-probe" } } as any);
  assert.deepEqual(tap.data, { name: "rating option", control: "button", screen: "turn-probe" });
  // a rating overlay over the chat screen counts as a rating screen too
  const ov = ratingScrubEvent({ ts: 3, type: "tap", data: { name: "1", control: "button", screen: "chat", overlays: ["session-rating"] } } as any);
  assert.equal((ov.data as any).name, "rating option");
  // off rating screens a digit button is left alone
  const off = ratingScrubEvent({ ts: 4, type: "tap", data: { name: "4", control: "button", screen: "chat" } } as any);
  assert.equal((off.data as any).name, "4");
});
