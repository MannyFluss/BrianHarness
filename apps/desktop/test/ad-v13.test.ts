// contract-v1.3 (ruling B1, desktop): a reading window with tab_occluded time does not update the baseline wpm, and its
// kept paragraphs carry the uncovered expectation share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SyntheticGazeTracker, demoReadingPath, simActor, simDirector, type SimReplay } from "@brianharness/core/actor-director/browser";
import { loadO200k } from "@brianharness/core/actor-director";
import type { ScreenInfo } from "@brianharness/core/ad-contracts";
import { MemoryKV } from "@brianharness/core/browser";
import { LiveAdController } from "../src/ad/controller.ts";

const counter = loadO200k();
const IPAD: ScreenInfo = { deviceModel: "iPad13,4", platform: "ios", orientation: "landscape_left", widthPt: 1194, heightPt: 834, scale: 2, webview: { x: 0, y: 0, width: 1194, height: 834 }, widthMm: 229.8 };
const PARAS = ["Starters need feeding every single day to stay active and sweet.", "Rye flour ferments much faster than wheat because of its wild yeast.", "Most bakers use seventy five percent hydration for a first loaf."];
const FAKE: SimReplay[] = [{ name: "fake", file: { screen: IPAD, samples: [] }, turn: { aois: PARAS.map((text, i) => ({ id: `a.p${i + 1}`, order: i + 1, text })) } } as unknown as SimReplay];
const boxesFor = (msg: string) => PARAS.map((text, p) => ({ msg, p, x: 60, y: 120 + p * 110, w: 900, h: 72, text, words: text.split(/\s+/).length, line_h: 24 }));

async function session(occlude: boolean) {
  let now = 1000;
  const syn = new SyntheticGazeTracker({ screen: IPAD, now: () => now });
  await syn.start({ mode: "synthetic", synthetic: { samples: [] }, webNow: now } as never);
  const c = await LiveAdController.open({
    sessionType: "tab_visible", arm: "on", sessionId: "v13", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(), tracker: syn, screen: IPAD, calibration: null, consent: { camera: true, rawGaze: false }, now: () => now,
    onReadingLayout: (_m, boxes) => syn.play(demoReadingPath([...boxes].sort((a, b) => a.y - b.y), { styles: ["read", "read", "read"] }), now, { hold: { x: 597, y: 790 } }),
  });
  try {
    const end = now + 14000;
    while (now < end) {
      now += 100;
      const covered = occlude && now > 1000 + 2000 && now < 1000 + 9000;
      c.occlusion(covered, now);
      c.paragraphs(covered ? [] : boxesFor("a0"), now, false);
      syn.pump(now);
    }
    c.composerKey(now);
    await new Promise((r) => setTimeout(r, 5));
  } finally { c.dispose(); }
  return (c as unknown as { history: number[] }).history;
}

test("B1 desktop: an occluded reading window leaves the baseline wpm history untouched; an uncovered one updates it", async () => {
  const open = await session(false);
  assert.ok(open.length > 0, "an uncovered window feeds the baseline");
  const covered = await session(true);
  assert.equal(covered.length, 0, "tab_occluded time must not reach the baseline-wpm update");
});
