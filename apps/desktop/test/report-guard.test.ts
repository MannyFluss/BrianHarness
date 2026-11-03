// The Report sheet never opens over a rating step (Researcher, bc25214): the gate every trigger goes through.
// The three real triggers in the built app are checked headless by scripts/report-guard-verify.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportAllowed } from "../src/feedback/report.ts";

const base = { canReport: true, reportOpen: false, ratingCardOpen: false, turnProbeOpen: false };
test("report gate: blocked while the session rating card or the turn probe shows; allowed again after", () => {
  assert.equal(reportAllowed(base), true);
  assert.equal(reportAllowed({ ...base, ratingCardOpen: true }), false);
  assert.equal(reportAllowed({ ...base, turnProbeOpen: true }), false);
  assert.equal(reportAllowed({ ...base, ratingCardOpen: true, turnProbeOpen: true }), false);
  assert.equal(reportAllowed({ ...base, reportOpen: true }), false, "already open (unchanged)");
  assert.equal(reportAllowed({ ...base, canReport: false }), false, "no feedback bridge (unchanged)");
});
