// Starting the study needs two deliberate taps: a double tap (second tap < STUDY_CONFIRM_MIN_MS) is ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDY_CONFIRM_MIN_MS, studyTapAction } from "../src/components/StudyData.tsx";

test("study start: one tap only asks to confirm; a double tap is ignored; a later confirming tap starts; stop stays one tap", () => {
  assert.equal(studyTapAction(false, false, 0), "ask");
  assert.equal(studyTapAction(false, true, 120), "ignore");
  assert.equal(studyTapAction(false, true, STUDY_CONFIRM_MIN_MS - 1), "ignore");
  assert.equal(studyTapAction(false, true, STUDY_CONFIRM_MIN_MS), "toggle");
  assert.equal(studyTapAction(true, false, 0), "toggle");
});
