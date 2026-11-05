// E7 / IOS Dev I4 feedback (native c687996): sim-only lookAt detected with typeof; the session_start tracker label
// from the real start mode; demo URLs relative to the document base; rotation swaps the calibration and re-logs
// aoi_layout; the phone sheet over the chat logs tab_occluded and is excluded from paragraph features; demo gaze is
// generated from the app's real paragraph boxes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CalibrationStore, AdStorage, SyntheticGazeTracker, demoReadingPath, simActor, simDirector, simLookAt, type CalibrationRecord, type SimReplay } from "@brianharness/core/actor-director/browser";
import { loadO200k } from "@brianharness/core/actor-director";
import type { BhAdEvent, GazeTracker, ScreenInfo } from "@brianharness/core/ad-contracts";
import { MemoryKV } from "@brianharness/core/browser";
import { LiveAdController, trackerLabel } from "../src/ad/controller.ts";
import { demoUrl, webScreen } from "../src/ad/boot.tsx";
import { nativeSimLookAt } from "../src/ad/sim-look.ts";

const counter = loadO200k();
const IPAD: ScreenInfo = { deviceModel: "iPad13,4", platform: "ios", orientation: "landscape_left", widthPt: 1194, heightPt: 834, scale: 2, webview: { x: 0, y: 0, width: 1194, height: 834 }, widthMm: 229.8 };
const IPAD_PORTRAIT: ScreenInfo = { ...IPAD, orientation: "portrait", widthPt: 834, heightPt: 1194, webview: { x: 0, y: 0, width: 834, height: 1194 }, widthMm: 160 };
const PARAS = ["Starters need feeding every single day to stay active and sweet.", "Rye flour ferments much faster than wheat because of its wild yeast.", "Most bakers use seventy five percent hydration for a first loaf."];
const FAKE: SimReplay[] = [{ name: "fake", file: { screen: IPAD, samples: [] }, turn: { aois: PARAS.map((text, i) => ({ id: `a.p${i + 1}`, order: i + 1, text })) } } as unknown as SimReplay];
const linesOf = (c: LiveAdController) => (c as unknown as { log: { lines: BhAdEvent[] } }).log.lines;
const of = <T extends BhAdEvent["type"]>(ls: BhAdEvent[], t: T) => ls.filter((l) => l.type === t) as Array<Extract<BhAdEvent, { type: T }>>;
const boxesFor = (msg: string, x0 = 60, w = 900) => PARAS.map((text, p) => ({ msg, p, x: x0, y: 120 + p * 110, w, h: 72, text, words: text.split(/\s+/).length, line_h: 24 }));
const rec = (orientation: CalibrationRecord["orientation"]): CalibrationRecord => ({ v: 1, deviceModel: "iPad13,4", orientation, fit: "core", affine: [1, 0, 0, 0, 1, 0], model: null, distCm: 44, yaw: 2, errPx: 10, errDeg: 0.3, errParas: 0.1, mode: "gaze", at: 0, t: 0 } as CalibrationRecord);

test("I4.1 lookAt (simulator builds only, v1.3): typeof detection works through a Capacitor-style proxy; absent -> undefined; a rejected call is swallowed", async () => {
  const calls: Array<[number, number]> = [];
  // Capacitor's plugin proxy: get returns a wrapper for any name, no `has` trap
  const proxy = new Proxy({}, { get: (_t, prop) => (prop === "lookAt" ? (x: number, y: number) => { calls.push([x, y]); return Promise.resolve(); } : undefined) }) as unknown as GazeTracker;
  assert.equal("lookAt" in proxy, false, "the old `in` check would miss it");
  nativeSimLookAt(proxy)!(10, 20);
  assert.deepEqual(calls, [[10, 20]]);
  // v1.3: the core (device-reachable) aid never touches a native plugin, only the JS synthetic tracker
  assert.equal(simLookAt(proxy), undefined);
  assert.equal(typeof simLookAt(new SyntheticGazeTracker({ screen: IPAD, now: () => 0 })), "function");
  const device = { getStatus: async () => ({}) } as unknown as GazeTracker;
  assert.equal(nativeSimLookAt(device), undefined);
  assert.equal(nativeSimLookAt(null), undefined);
  const rejecting = { lookAt: () => Promise.reject(new Error("UNIMPLEMENTED")) } as unknown as GazeTracker;
  nativeSimLookAt(rejecting)!(1, 1);
  const throwing = { lookAt: () => { throw new Error("x"); } } as unknown as GazeTracker;
  assert.doesNotThrow(() => nativeSimLookAt(throwing)!(1, 1));
  await new Promise((r) => setTimeout(r, 5));
});

test("I4.2 tracker label from the real start mode (not 'synthetic' whenever a tracker exists)", async () => {
  assert.equal(trackerLabel({ mode: "synthetic", tracker: null }), "synthetic");
  assert.equal(trackerLabel({ mode: "camera", tracker: "arkit" }), "arkit");
  assert.equal(trackerLabel({ mode: "camera", tracker: "mediapipe" }), "mediapipe");
  assert.equal(trackerLabel({ mode: null, tracker: null }), "none");
  assert.equal(trackerLabel({ mode: null, tracker: null }, "replay"), "replay");
  const cam = { getStatus: async () => ({ mode: "camera", tracker: "arkit" }), addListener: async () => ({ remove: async () => {} }) } as unknown as GazeTracker;
  const c = await LiveAdController.open({ sessionType: "tab_visible", arm: "on", sessionId: "lbl", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(), tracker: cam, screen: IPAD, calibration: null, consent: { camera: true, rawGaze: false } });
  c.dispose();
  assert.equal(of(linesOf(c), "session_start")[0]!.gaze.tracker, "arkit");
  const syn = new SyntheticGazeTracker({ screen: IPAD });
  await syn.start({ mode: "synthetic", synthetic: { samples: [] }, webNow: 0 } as never);
  const c2 = await LiveAdController.open({ sessionType: "tab_visible", arm: "on", sessionId: "lbl2", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(), tracker: syn, screen: IPAD, calibration: null, consent: { camera: true, rawGaze: false } });
  c2.dispose();
  assert.equal(of(linesOf(c2), "session_start")[0]!.gaze.tracker, "synthetic");
});

test("I4.3 demo URLs resolve against the document base (iOS bundle at ad-ios/, no dev server)", () => {
  assert.equal(demoUrl("replays.json", undefined, "capacitor://localhost/ad-ios/ad.html"), "capacitor://localhost/ad-ios/ad-demo/replays.json");
  assert.equal(demoUrl("replays.json", undefined, "file:///var/app/ad-ios/index.html"), "file:///var/app/ad-ios/ad-demo/replays.json");
  assert.equal(demoUrl("ipad-full.json", undefined, "http://localhost:5175/ad.html?demo=x"), "http://localhost:5175/ad-demo/ipad-full.json");
  assert.equal(demoUrl("replays.json", "https://cdn.example/demo", "capacitor://localhost/ad-ios/ad.html"), "https://cdn.example/demo/replays.json");
  assert.equal(demoUrl("replays.json", "../shared/", "capacitor://localhost/ad-ios/ad.html"), "capacitor://localhost/shared/replays.json");
});

test("I4.4 webScreen: a rotation changes the orientation (and its calibration key); a rotated phone stays a phone", () => {
  assert.equal(webScreen(1194, 834, null).orientation, "landscape_left");
  assert.equal(webScreen(834, 1194, null).orientation, "portrait");
  assert.equal(webScreen(1194, 834, "landscape-secondary").orientation, "landscape_right");
  assert.equal(webScreen(874, 402, null).deviceModel, "iPhone18,1");
  assert.equal(webScreen(874, 402, null).orientation, "landscape_left");
});

test("I4.4 orientation change: screen info updated, stored calibration swapped in (or uncalibrated + health code), aoi_layout re-logged", async () => {
  const kv = new MemoryKV();
  const store = new CalibrationStore(await AdStorage.open(kv));
  store.save(rec("landscape_left"));
  const restored: string[] = [];
  const syn = new SyntheticGazeTracker({ screen: IPAD });
  (syn as unknown as { restoreCalibration: (o: { orientation: string }) => Promise<{ ok: boolean }> }).restoreCalibration = async (o) => { restored.push(o.orientation); return { ok: true }; };
  await syn.start({ mode: "synthetic", synthetic: { samples: [] }, webNow: 0 } as never);
  let now = 1000;
  const c = await LiveAdController.open({ sessionType: "tab_visible", arm: "on", sessionId: "rot", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv, tracker: syn, screen: IPAD, calibration: store.load("iPad13,4", "landscape_left"), calStore: store, consent: { camera: true, rawGaze: false }, now: () => now });
  try {
    c.paragraphs(boxesFor("a0"), now, false);
    assert.equal(of(linesOf(c), "aoi_layout").length, 1, "first layout of a0 logged");
    assert.equal(c.getSnapshot().calibration.mode, "gaze");
    // rotate to portrait: nothing stored -> uncalibrated, health code, layout re-logged with the new orientation
    now += 500;
    await c.orientationChanged(IPAD_PORTRAIT, boxesFor("a0", 40, 700));
    const ls = linesOf(c);
    const h = of(ls, "health").filter((x) => x.check === "calibration.valid");
    assert.equal(h.length, 1);
    assert.equal(h[0]!.code, "gaze.calibration_stale");
    assert.match(h[0]!.detail ?? "", /no stored calibration for portrait/);
    assert.equal(c.getSnapshot().calibration.mode, "none");
    const lay = of(ls, "aoi_layout");
    assert.equal(lay.length, 2);
    assert.equal(lay[1]!.orientation, "portrait");
    assert.equal(lay[1]!.boxes[0]!.w, 700);
    // a native-fit record for portrait -> restored into the tracker
    store.save({ ...rec("landscape_right"), fit: "native", model: [1, 2, 3] } as CalibrationRecord);
    now += 500;
    await c.orientationChanged({ ...IPAD, orientation: "landscape_right" });
    assert.deepEqual(restored, ["landscape_right"]);
    assert.equal(c.getSnapshot().calibration.mode, "gaze");
    assert.equal(of(linesOf(c), "aoi_layout").length, 2, "no boxes given: re-logged on the next paragraphs() call");
    c.paragraphs(boxesFor("a0"), now, false);
    const lay3 = of(linesOf(c), "aoi_layout");
    assert.equal(lay3.length, 3);
    assert.equal(lay3[2]!.orientation, "landscape_right");
    // same orientation and size: no-op
    await c.orientationChanged({ ...IPAD, orientation: "landscape_right" });
    assert.equal(of(linesOf(c), "health").filter((x) => x.check === "calibration.valid").length, 1);
  } finally { c.dispose(); }
});

async function demoSession(occlude: boolean) {
  let now = 1000;
  const syn = new SyntheticGazeTracker({ screen: IPAD, now: () => now });
  await syn.start({ mode: "synthetic", synthetic: { samples: [] }, webNow: now } as never);
  const c = await LiveAdController.open({
    sessionType: "tab_visible", arm: "on", sessionId: "demo", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(), tracker: syn, screen: IPAD, calibration: null, consent: { camera: true, rawGaze: false }, now: () => now,
    onReadingLayout: (_m, boxes) => syn.play(demoReadingPath([...boxes].sort((a, b) => a.y - b.y)), now, { hold: { x: 597, y: 790 } }),
  });
  const targets = new Set<string>();
  try {
    const end = now + 14000;
    while (now < end) {
      now += 100;
      const covered = occlude && now > 1000 + 2000 && now < 1000 + 9000;
      c.occlusion(covered, now);
      c.paragraphs(covered ? [] : boxesFor("a0"), now, false);
      syn.pump(now);
      const t = c.live()?.target; if (t) targets.add(t);
    }
    c.composerKey(now);
    await new Promise((r) => setTimeout(r, 5));
  } finally { c.dispose(); }
  return { c, lines: linesOf(c), targets };
}

test("I4.6 demo gaze is generated from the real paragraph boxes: targets hit a0.p1-p3, labels are not all 'skipped'", async () => {
  const { lines, targets } = await demoSession(false);
  assert.ok(targets.has("a0.p1") && targets.has("a0.p2"), `live targets: ${[...targets]}`);
  const d = of(lines, "attention_digest").find((x) => x.msg === "a0")!;
  assert.ok(d, "digest for a0");
  const labels = d.digest.paras.map((p) => p.label);
  assert.equal(labels.length, 3);
  assert.ok(labels.some((l) => l !== "skipped"), `labels ${labels}`);
  assert.ok(["deep", "read"].includes(labels[0]!), `p1 read deeply: ${labels}`);
  assert.equal(labels[2], "skipped", "p3's demo style is skip");
  assert.equal(of(lines, "tab_occluded").length, 0);
});

test("I4.6 phone sheet over the chat: tab_occluded logged; covered time not attributed; only-covered paragraphs left out, not 'skipped'", async () => {
  const { c, lines } = await demoSession(true);
  const occ = of(lines, "tab_occluded");
  assert.equal(occ.length, 1);
  assert.equal(occ[0]!.msg, "a0");
  assert.ok(Math.abs(occ[0]!.ms - 6900) <= 200, `ms ${occ[0]!.ms}`);
  const d = of(lines, "attention_digest").find((x) => x.msg === "a0")!;
  // the reader got through p1 before the sheet opened; p2/p3 were read under the sheet: no gaze credited to them
  assert.ok(d.digest.paras.length >= 1 && d.digest.paras.length < 3, `paras ${d.digest.paras.map((p) => p.aoi)}`);
  for (const p of d.digest.paras) assert.notEqual(p.label, "skipped", `${p.aoi} labelled skipped`);
  assert.equal(c.getSnapshot().sessionType, "tab_visible");
});

test("I4.6 occlusion view state: live target null and the tab says the chat is covered", async () => {
  let now = 1000;
  const c = await LiveAdController.open({ sessionType: "tab_visible", arm: "on", sessionId: "occ", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(), tracker: null, screen: IPAD, calibration: null, consent: { camera: true, rawGaze: false }, now: () => now });
  try {
    c.occlusion(true, now);
    const v = c.getSnapshot();
    assert.equal(v.sessionType === "tab_visible" && v.occluded, true);
    now += 1000; c.occlusion(false, now);
    assert.equal((c.getSnapshot() as { occluded?: boolean }).occluded, false);
    assert.equal(of(linesOf(c), "tab_occluded")[0]!.ms, 1000);
  } finally { c.dispose(); }
});
