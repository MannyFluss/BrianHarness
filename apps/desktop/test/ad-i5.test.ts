// IOS Dev I5 follow-ups (native 9fc02ce): the demo reader at the calibration's distance (no false "distance changed"),
// a robust orientation detector (WKWebView fires no resize on landscape_left <-> landscape_right), and the blind
// schedule position passed through in a blinded LiveBoot session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyntheticGazeTracker, simActor, simDirector, type CalibrationRecord, type SimReplay } from "@brianharness/core/actor-director/browser";
import { loadO200k } from "@brianharness/core/actor-director";
import { blindedGuard, type BhAdEvent, type ScreenInfo } from "@brianharness/core/ad-contracts";
import { MemoryKV } from "@brianharness/core/browser";
import { LiveAdController, type AdView } from "../src/ad/controller.ts";
import { DEMO_DIST_CM, blindFrom, demoDistCm, liveDemoGaze, sessionTypeFrom, webScreen } from "../src/ad/boot.tsx";
import { orientationType, watchOrientation, type OrientationEnv } from "../src/ad/orientation.ts";

const counter = loadO200k();
const IPHONE: ScreenInfo = { deviceModel: "iPhone18,1", platform: "ios", orientation: "portrait", widthPt: 402, heightPt: 874, scale: 3, webview: { x: 0, y: 0, width: 402, height: 874 }, widthMm: 65.9 };
const PARAS = ["Starters need feeding every single day to stay active and sweet.", "Rye flour ferments much faster than wheat because of its wild yeast.", "Most bakers use seventy five percent hydration for a first loaf."];
const FAKE: SimReplay[] = [{ name: "fake", file: { screen: IPHONE, samples: [] }, turn: { aois: PARAS.map((text, i) => ({ id: `a.p${i + 1}`, order: i + 1, text })) } } as unknown as SimReplay];
const boxesFor = (msg: string) => PARAS.map((text, p) => ({ msg, p, x: 20, y: 120 + p * 140, w: 360, h: 96, text, words: text.split(/\s+/).length, line_h: 24 }));
const rec30: CalibrationRecord = { v: 1, deviceModel: "iPhone18,1", orientation: "portrait", fit: "core", affine: [1, 0, 0, 0, 1, 0], model: null, distCm: 30, yaw: 2, errPx: 2, errDeg: 0.1, errParas: 0.05, mode: "gaze", at: 0, t: 0 } as CalibrationRecord;
const linesOf = (c: LiveAdController) => (c as unknown as { log: { lines: BhAdEvent[] } }).log.lines;

async function iphoneSession(demoCal: () => CalibrationRecord | null) {
  let now = 1000;
  const tracker = new SyntheticGazeTracker({ screen: IPHONE, now: () => now });
  await tracker.start({ mode: "synthetic", synthetic: { samples: [] }, webNow: now } as never);
  tracker.setDistCm(demoDistCm(demoCal()));
  const c = await LiveAdController.open({
    sessionType: "tab_visible", arm: "on", sessionId: "i5", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(), tracker, screen: IPHONE, calibration: rec30, consent: { camera: true, rawGaze: false }, now: () => now,
    onReadingLayout: liveDemoGaze(tracker, demoCal, () => ({ x: 201, y: 830 }), () => now),
  });
  try {
    for (let k = 0; k < 40; k++) { now += 100; c.paragraphs(boxesFor("a0"), now, false); tracker.pump(now); await Promise.resolve(); }
  } finally { c.dispose(); }
  return (c as unknown as { build(): AdView }).build().calibration;
}

test("I5.2 the demo reader uses the calibration's distCm (iPhone 30 cm): no false 'distance changed' recalibrate; 42 cm only uncalibrated", async () => {
  assert.equal(demoDistCm(rec30), 30); assert.equal(demoDistCm(null), DEMO_DIST_CM); assert.equal(DEMO_DIST_CM, 42);
  assert.equal(demoDistCm({ ...rec30, distCm: null } as unknown as CalibrationRecord), 42);
  const fixed = await iphoneSession(() => rec30);
  assert.equal(fixed.stale, null, `the calibrated distance must not read as moved: ${fixed.stale}`);
  // the old behaviour (demo reader always at 42 cm) against a 30 cm calibration: 40% -> "Recalibrate (distance changed 40%)"
  const old = await iphoneSession(() => null);
  assert.match(String(old.stale), /distance changed 40%/);
});

function fakeEnv(w: number, h: number, type: string | null, angle?: number) {
  const L = () => { const m = new Map<string, Set<() => void>>(); return { m, addEventListener: (t: string, cb: () => void) => { if (!m.has(t)) m.set(t, new Set()); m.get(t)!.add(cb); }, removeEventListener: (t: string, cb: () => void) => { m.get(t)?.delete(cb); }, fire: (t: string) => { for (const cb of m.get(t) ?? []) cb(); } }; };
  const so = { ...L(), type: type as string | undefined };
  const mq = [L(), L()];
  let qi = 0;
  const win = { ...L(), innerWidth: w, innerHeight: h, orientation: angle, matchMedia: () => ({ ...mq[qi++ % 2]!, matches: false }) };
  let tick: (() => void) | null = null;
  const env: OrientationEnv = { win, screenOrientation: type === null ? null : so, setInterval: (cb) => { tick = cb; return 1; }, clearInterval: () => { tick = null; } };
  return { env, win, so, mq, poll: () => tick?.(), get polling() { return tick !== null; } };
}

test("I5.3 orientation: a same-size landscape_left -> landscape_right rotation is caught without resize (poll, screen.orientation, matchMedia, native push), deduped", () => {
  const f = fakeEnv(1194, 834, "landscape-primary");
  const seen: Array<[string, string]> = [];
  const w = watchOrientation({ env: f.env, initial: webScreen(1194, 834, "landscape-primary"), read: webScreen, onChange: (s, src) => seen.push([s.orientation, src]) });
  f.poll(); assert.equal(seen.length, 0, "no change, nothing reported");
  // WKWebView: the type flips, no resize, no change event -> the 1 s poll catches it
  f.so.type = "landscape-secondary"; f.poll();
  assert.deepEqual(seen, [["landscape_right", "poll"]]);
  // the late change event, matchMedia and the next polls are duplicates
  f.so.fire("change"); f.mq[0]!.fire("change"); f.win.fire("orientationchange"); f.poll();
  assert.equal(seen.length, 1);
  // back, via the screen.orientation event this time
  f.so.type = "landscape-primary"; f.so.fire("change"); f.poll();
  assert.deepEqual(seen.at(-1), ["landscape_left", "screen.orientation"]); assert.equal(seen.length, 2);
  // a native-pushed orientation (plugin status event, v1.4) when the web sources stay stale
  w.native("landscape_right"); f.poll();
  assert.deepEqual(seen.at(-1), ["landscape_right", "native"]); assert.equal(seen.length, 3);
  // a real portrait flip (resize) wins over the older native push
  f.win.innerWidth = 834; f.win.innerHeight = 1194; f.so.type = "portrait-primary"; f.win.fire("resize");
  assert.deepEqual(seen.at(-1), ["portrait", "resize"]);
  w.stop(); assert.equal(f.polling, false); f.so.type = "landscape-primary"; f.so.fire("change"); assert.equal(seen.length, 4, "stopped: no more reports");
  // legacy window.orientation (no screen.orientation): -90 -> landscape-secondary -> landscape_right
  const g = fakeEnv(1194, 834, null, -90);
  assert.equal(orientationType(g.env), "landscape-secondary");
  const seen2: string[] = [];
  watchOrientation({ env: g.env, initial: webScreen(1194, 834, "landscape-primary"), read: webScreen, onChange: (s) => seen2.push(s.orientation) });
  g.poll(); assert.deepEqual(seen2, ["landscape_right"]);
  g.win.orientation = 90; g.poll(); assert.deepEqual(seen2, ["landscape_right", "landscape_left"]);
});

test("I5.4 blinded LiveBoot passes blind {index,total,scheduleHash}: logged in session_start (sealed, no arm), the main log passes the guard and check_blinding", async () => {
  const H = "9f2c4e1a7b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e";
  const q = new URLSearchParams(`type=blinded&blind=3/12&scheduleHash=${H}`);
  assert.equal(sessionTypeFrom(q, null), "blinded");
  assert.equal(sessionTypeFrom(new URLSearchParams(""), { session: "blinded" }), "blinded");
  assert.deepEqual(blindFrom(q, null), { index: 3, total: 12, scheduleHash: H });
  assert.deepEqual(blindFrom(new URLSearchParams(""), { blind: { index: 1, total: 2, scheduleHash: H.toUpperCase() } }), { index: 1, total: 2, scheduleHash: H });
  for (const bad of ["blind=0/12", "blind=13/12", "blind=3/12&scheduleHash=abc", "blind=x/y"]) assert.equal(blindFrom(new URLSearchParams(bad), null), undefined, bad);
  const blind = blindFrom(q, null)!;
  const kv = new MemoryKV();
  const c = await LiveAdController.open({ sessionType: "blinded", arm: "on", blind, sessionId: "i5b", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv, screen: IPHONE, calibration: rec30, consent: { camera: true, rawGaze: false } });
  c.dispose();
  const ss = linesOf(c).find((l) => l.type === "session_start") as Extract<BhAdEvent, { type: "session_start" }>;
  assert.deepEqual(ss.blind, blind); assert.equal(ss.sealed, true); assert.equal(ss.contract, "contract-v1.4");
  const storage = (c as unknown as { log: { storage: { read(ns: string, id: string): string | null }; sessionId: string } }).log;
  const main = storage.storage.read("blinded", storage.sessionId)!;
  assert.match(main, /"blind":\{"index":3,"total":12,"scheduleHash":"9f2c/);
  const mainSs = JSON.parse(main.split("\n")[0]!) as Record<string, unknown>;
  assert.equal(mainSs.type, "session_start"); assert.deepEqual(mainSs.blind, blind);
  assert.equal(mainSs.arm, undefined, "the arm is redacted from the blinded main log"); assert.doesNotMatch(main, /"arm"|p_inject/);
  assert.deepEqual(blindedGuard(storage.sessionId, main), { ok: true });
  const dir = mkdtempSync(join(tmpdir(), "i5b-")), f = join(dir, "blinded-main.jsonl");
  writeFileSync(f, main);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "../../../tools/phaseD/check_blinding.mjs"), f], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
