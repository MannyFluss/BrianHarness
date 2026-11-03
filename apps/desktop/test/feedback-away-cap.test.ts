// Researcher fix (Nov 3 2026): the Report sheet's away-time credit is capped per hidden span at
// FEEDBACK_AWAY_CREDIT_MAX_MS (10 min, below AWAY_MS 20 min), so a sheet left open in the background can't keep a
// session alive forever. App.tsx: away = feedbackBracket.awayMs(hiddenAt, now) >= AWAY_MS -> new session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FEEDBACK_AWAY_CREDIT_MAX_MS, FeedbackBracket } from "../src/feedback/away.ts";
import { AWAY_MS } from "../src/rating.ts";

const MIN = 60_000, t0 = 5_000_000;
const sheetOpen = () => { const b = new FeedbackBracket(); b.open(t0); return b; }; // left open (never closed)

test("the cap is a fixed 10 min, below AWAY_MS", () => {
  assert.equal(FEEDBACK_AWAY_CREDIT_MAX_MS, 600_000);
  assert.ok(FEEDBACK_AWAY_CREDIT_MAX_MS < AWAY_MS);
});

test("short span with the sheet open: fully subtracted (0 away)", () => {
  const b = sheetOpen();
  assert.equal(b.awayMs(t0 + MIN, t0 + 4 * MIN), 0); // 3 min share sheet
  assert.equal(b.awayMs(t0 + MIN, t0 + MIN + FEEDBACK_AWAY_CREDIT_MAX_MS), 0); // exactly the cap
  assert.ok(b.isOpen(), "the sheet stays open");
});

test("long span with the sheet open: capped, the session ends (3 h hidden -> 2 h 50 min away)", () => {
  const b = sheetOpen();
  const away = b.awayMs(t0 + MIN, t0 + MIN + 180 * MIN);
  assert.equal(away, 170 * MIN);
  assert.ok(away >= AWAY_MS);
  assert.ok(b.isOpen(), "not auto-closed");
});

test("boundary: hidden AWAY_MS + cap ends the session, 1 ms less does not", () => {
  const b = sheetOpen();
  const h = t0 + MIN;
  assert.equal(b.awayMs(h, h + AWAY_MS + FEEDBACK_AWAY_CREDIT_MAX_MS), AWAY_MS);
  assert.ok(b.awayMs(h, h + AWAY_MS + FEEDBACK_AWAY_CREDIT_MAX_MS) >= AWAY_MS);
  assert.ok(b.awayMs(h, h + AWAY_MS + FEEDBACK_AWAY_CREDIT_MAX_MS - 1) < AWAY_MS);
  // partial overlap under the cap is still fully credited: sheet closed 4 min into a 25 min hidden span -> 21 min away
  const c = new FeedbackBracket(); c.open(t0); c.close(t0 + 5 * MIN);
  assert.equal(c.awayMs(t0 + MIN, t0 + 26 * MIN), 21 * MIN);
});
