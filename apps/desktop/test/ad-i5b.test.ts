// IOS Dev I5b (native 2d66504): (1) iOS orientation names follow native UIInterfaceOrientation (WKWebView
// landscape-primary = landscapeRight) and a native-pushed orientation is the truth whenever present; (2) liveDemoGaze
// drives any tracker with the sim lookAt capability (contract-v1.4), not only the JS SyntheticGazeTracker, in
// simulator builds only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SyntheticGazeTracker, demoReadingPath, type CalibrationRecord } from "@brianharness/core/actor-director/browser";
import type { GazeStatus, GazeTracker, ScreenInfo } from "@brianharness/core/ad-contracts";
import { liveDemoGaze, webScreen } from "../src/ad/boot.tsx";
import { isIosWebView, landscapeName, orientationType, watchOrientation, type OrientationEnv } from "../src/ad/orientation.ts";
import { SIM_WALK_AID, playSimLook, simLookFixations } from "../src/ad/sim-look.ts";

function fakeEnv(w: number, h: number, type: string | null, angle?: number) {
  const L = () => { const m = new Map<string, Set<() => void>>(); return { addEventListener: (t: string, cb: () => void) => { if (!m.has(t)) m.set(t, new Set()); m.get(t)!.add(cb); }, removeEventListener: (t: string, cb: () => void) => { m.get(t)?.delete(cb); }, fire: (t: string) => { for (const cb of m.get(t) ?? []) cb(); } }; };
  const so = { ...L(), type: type as string | undefined };
  const win = { ...L(), innerWidth: w, innerHeight: h, orientation: angle, matchMedia: () => ({ ...L(), matches: false }) };
  let tick: (() => void) | null = null;
  const env: OrientationEnv = { win, screenOrientation: type === null ? null : so, setInterval: (cb) => { tick = cb; return 1; }, clearInterval: () => { tick = null; } };
  return { env, win, so, poll: () => tick?.() };
}

test("I5b.1a iOS (Capacitor platform / BHGaze plugin, no UA): landscape-primary -> landscape_right, secondary -> landscape_left", () => {
  assert.equal(isIosWebView({}), false);
  assert.equal(isIosWebView({ Capacitor: { getPlatform: () => "ios" } }), true);
  assert.equal(isIosWebView({ Capacitor: { getPlatform: () => "android", isPluginAvailable: () => true } }), false, "the platform wins over plugin presence");
  assert.equal(isIosWebView({ Capacitor: { isPluginAvailable: (n: string) => n === "BHGaze" } }), true, "no platform: the iOS-only BHGaze plugin");
  assert.equal(isIosWebView({ Capacitor: { getPlatform: () => { throw new Error("x"); }, isPluginAvailable: () => false } }), false);
  assert.equal(isIosWebView(globalThis), false, "node / browser dev server: not iOS");
  assert.equal(landscapeName("landscape-primary", true), "landscape_right"); assert.equal(landscapeName("landscape-secondary", true), "landscape_left");
  assert.equal(landscapeName("landscape-primary", false), "landscape_left"); assert.equal(landscapeName("landscape-secondary", false), "landscape_right");
  assert.equal(landscapeName(null, true), "landscape_right");
  assert.equal(webScreen(1194, 834, "landscape-primary", true).orientation, "landscape_right");
  assert.equal(webScreen(1194, 834, "landscape-secondary", true).orientation, "landscape_left");
  assert.equal(webScreen(1194, 834, "landscape-primary", false).orientation, "landscape_left", "non-iOS mapping unchanged");
  assert.equal(webScreen(834, 1194, "portrait-primary", true).orientation, "portrait");
  // legacy window.orientation on iOS: 90 (landscape-primary) is UIInterfaceOrientation.landscapeRight
  const g = fakeEnv(1194, 834, null, 90);
  assert.equal(webScreen(1194, 834, orientationType(g.env), true).orientation, "landscape_right");
  g.win.orientation = -90;
  assert.equal(webScreen(1194, 834, orientationType(g.env), true).orientation, "landscape_left");
  // the default reads the platform: a Capacitor iOS global flips it
  const cap = (globalThis as { Capacitor?: unknown });
  cap.Capacitor = { getPlatform: () => "ios" };
  try { assert.equal(webScreen(1194, 834, "landscape-primary").orientation, "landscape_right"); } finally { delete cap.Capacitor; }
});

test("I5b.1b a native-pushed orientation is the truth: a differing (mirrored / stale) web reading never overrides it", () => {
  let clock = 0;
  const read = (w: number, h: number, t: string | null) => webScreen(w, h, t, false); // the OLD mirrored mapping: worst case
  const f = fakeEnv(1194, 834, "landscape-primary");
  const seen: Array<[string, string, string]> = [];
  const native0 = webScreen(1194, 834, "landscape-secondary", false); // native says landscape_right at launch
  const w = watchOrientation({ env: f.env, initial: native0, initialNative: native0.orientation, read, onChange: (s, src) => seen.push([s.orientation, `${s.webview.width}x${s.webview.height}`, src]), now: () => clock, nativeGraceMs: 2000 });
  assert.equal(w.nativeOrientation(), "landscape_right");
  // the I5b iPad launch: the web reading says landscape_left (mirrored); native is the truth -> nothing reported
  f.poll(); f.so.fire("change"); assert.deepEqual(seen, [], "the mirrored startup reading is ignored");
  // the OVERRIDE case: native pushes landscape_left, then the web flips to a reading that differs from it
  w.native("landscape_left");
  assert.deepEqual(seen.at(-1), ["landscape_left", "1194x834", "native"]);
  f.so.type = "landscape-secondary"; f.so.fire("change"); f.poll(); clock += 60_000; f.poll();
  assert.equal(seen.length, 1, "a differing web reading never overrides the native push, however long it lasts");
  assert.equal(w.nativeOrientation(), "landscape_left");
  // a size change is still reported (from the web), under the native orientation
  f.win.innerWidth = 1000; f.win.fire("resize");
  assert.deepEqual(seen.at(-1), ["landscape_left", "1000x834", "resize"]);
  // a portrait rotation: resize first, the native push a moment later -> reported once, as native says
  f.win.innerWidth = 834; f.win.innerHeight = 1194; f.so.type = "portrait-primary"; f.win.fire("resize");
  clock += 300; f.poll();
  assert.equal(seen.length, 2, "aspect contradicts native: wait for the push (grace)");
  w.native("portrait");
  assert.deepEqual(seen.at(-1), ["portrait", "834x1194", "native"]); assert.equal(seen.length, 3);
  // native went silent across a real flip: after the grace period the web reading is the fallback ...
  f.win.innerWidth = 1194; f.win.innerHeight = 834; f.so.type = "landscape-primary"; f.win.fire("resize");
  assert.equal(seen.length, 3);
  clock += 2001; f.poll();
  assert.deepEqual(seen.at(-1), ["landscape_left", "1194x834", "poll"]); assert.equal(w.nativeOrientation(), null);
  // ... and web readings rule only while there is no native orientation
  f.so.type = "landscape-secondary"; f.poll();
  assert.deepEqual(seen.at(-1), ["landscape_right", "1194x834", "poll"]);
  w.native("landscape_left");
  assert.deepEqual(seen.at(-1), ["landscape_left", "1194x834", "native"]);
  f.poll(); assert.equal(seen.length, 6, "the native push holds again");
  w.stop();
});

/** a Capacitor-like plugin proxy: every property is a function (typeof is useless), lookAt records its one options object */
function capacitorProxy(mode: GazeStatus["mode"]) {
  const looks: unknown[] = [];
  const status = { supported: true, unsupportedCode: null, permission: "granted", state: "running", pauseReason: null, tracker: null, mode, hz: 30, code: null } as GazeStatus;
  const impl: Record<string, (...a: unknown[]) => unknown> = { getStatus: async () => status, lookAt: (o: unknown) => { looks.push(o); return Promise.resolve(); } };
  const tracker = new Proxy({}, { get: (_t, k) => impl[String(k)] ?? (() => Promise.resolve()) }) as unknown as GazeTracker;
  return { tracker, looks };
}
function fakeTimers() {
  const q: Array<{ cb: () => void; ms: number; id: number }> = [];
  let id = 0, elapsed = 0;
  return { timers: { set: (cb: () => void, ms: number) => { q.push({ cb, ms, id: ++id }); return id; }, clear: (h: unknown) => { const i = q.findIndex((x) => x.id === h); if (i >= 0) q.splice(i, 1); } },
    pending: () => q.length, run(max = 10_000) { let n = 0; while (q.length && n++ < max) { const x = q.shift()!; elapsed += x.ms; x.cb(); } return elapsed; } };
}
const flush = () => new Promise((r) => setImmediate(r));
const BOXES = [0, 1, 2].map((p) => ({ x: 20, y: 120 + p * 140, w: 360, h: 96, words: 11 }));
const IPAD: ScreenInfo = { deviceModel: "iPad13,4", platform: "ios", orientation: "landscape_left", widthPt: 1194, heightPt: 834, scale: 2, webview: { x: 0, y: 0, width: 1194, height: 834 }, widthMm: 229.8 };

test("I5b.2 liveDemoGaze drives any tracker with the sim lookAt capability (simulator builds only); camera mode and device builds get nothing", async () => {
  const g = globalThis as { __BH_AD_SIM__?: boolean };
  const HOLD = { x: 597, y: 794 };
  // device build (__BH_AD_SIM__ false/absent): a native tracker gets no lookAt, even in synthetic mode
  const dev = capacitorProxy("synthetic"), devT = fakeTimers();
  const hDev = liveDemoGaze(dev.tracker, () => null, () => HOLD, undefined, { timers: devT.timers });
  hDev("a0", BOXES); await flush(); devT.run();
  assert.equal(dev.looks.length, 0, "device build: no path to lookAt");
  g.__BH_AD_SIM__ = true;
  try {
    // simulator build, native plugin in synthetic mode: the reading path is walked with lookAt({x, y}), then the hold
    const sim = capacitorProxy("synthetic"), t = fakeTimers();
    const h = liveDemoGaze(sim.tracker, () => ({ distCm: 30 } as CalibrationRecord), () => HOLD, undefined, { timers: t.timers });
    h("a0", BOXES); await flush();
    assert.ok(sim.looks.length >= 1, "the first fixation is immediate");
    const ms = t.run();
    const looks = sim.looks as Array<{ x: number; y: number }>;
    assert.ok(looks.length > 10, `one lookAt per fixation (${looks.length})`);
    for (const l of looks) assert.deepEqual(Object.keys(l).sort(), ["x", "y"], "contract-v1.4: one {x, y} options object");
    assert.deepEqual(looks.at(-1), HOLD, "then the eyes rest at the hold point");
    const inBox = (l: { x: number; y: number }) => BOXES.some((b) => l.x >= b.x && l.x <= b.x + b.w && l.y >= b.y && l.y <= b.y + b.h);
    assert.ok(looks.slice(0, -1).every(inBox), "every reading fixation lands on a real paragraph box");
    const path = demoReadingPath([...BOXES], { distCm: 30 });
    assert.ok(Math.abs(ms - (path.at(-1)!.t + 1000 / 30)) < 50, `the walk takes the path's time (${Math.round(ms)} ms)`);
    assert.ok(looks.length < path.length / 5, "fixations, not every 30 Hz sample");
    // a new reply's layout replaces a walk in progress; stop() cancels
    const sim2 = capacitorProxy("synthetic"), t2 = fakeTimers();
    const h2 = liveDemoGaze(sim2.tracker, () => null, () => HOLD, undefined, { timers: t2.timers });
    h2("a0", BOXES); await flush(); h2("a1", BOXES.slice(0, 1)); await flush();
    assert.equal(t2.pending(), 1, "one walk at a time");
    h2.stop(); assert.equal(t2.pending(), 0); const n = sim2.looks.length; t2.run(); assert.equal(sim2.looks.length, n, "stopped");
    // camera mode (a real device tracker): no capability -> nothing, though typeof lookAt is "function" on the proxy
    const cam = capacitorProxy("camera"), t3 = fakeTimers();
    assert.equal(typeof (cam.tracker as { lookAt?: unknown }).lookAt, "function");
    const h3 = liveDemoGaze(cam.tracker, () => null, () => HOLD, undefined, { timers: t3.timers });
    h3("a0", BOXES); await flush(); t3.run();
    assert.equal(cam.looks.length, 0, "camera mode: no lookAt");
    // the JS SyntheticGazeTracker keeps its sample path (play + setDistCm), no timers
    let now = 1000;
    const js = new SyntheticGazeTracker({ screen: IPAD, now: () => now });
    await js.start({ mode: "synthetic", synthetic: { samples: [] }, webNow: now } as never);
    const t4 = fakeTimers();
    liveDemoGaze(js, () => ({ distCm: 44 } as CalibrationRecord), () => HOLD, () => now, { timers: t4.timers })("a0", BOXES);
    assert.equal(t4.pending(), 0);
    now += 2000; const out = js.pump(now);
    assert.ok(out.length > 30 && out.every((s) => s.head?.distCm === 44 && s.cal === true));
  } finally { delete g.__BH_AD_SIM__; }
});

test("I5b.2b the walker: fixations from the 30 Hz path, lookAt at each start, stop() and the SIM_WALK_AID marker", () => {
  const path = [0, 1, 2, 3].flatMap((k) => Array.from({ length: 6 }, (_, i) => ({ t: (k * 6 + i) * (1000 / 30), x: 100 + k * 50 + (i % 2 ? 2 : -2), y: 200 + (i % 3) })));
  const fx = simLookFixations(path);
  assert.equal(fx.length, 4); assert.deepEqual(fx.map((f) => Math.round(f.x)), [100, 150, 200, 250]); assert.equal(fx[0]!.t, 0);
  assert.ok(Math.abs(fx[1]!.t - 200) < 1);
  const calls: Array<[number, number]> = [];
  const look = Object.assign((x: number, y: number) => { calls.push([x, y]); }, { aid: "bh-ad-sim-look/1" as const });
  const t = fakeTimers();
  const stop = playSimLook(look, path, { x: 1, y: 2 }, t.timers);
  assert.equal(stop.aid, SIM_WALK_AID); assert.equal(SIM_WALK_AID, "bh-ad-sim-walk/1");
  assert.equal(calls.length, 1); t.run();
  assert.equal(calls.length, 5); assert.deepEqual(calls.at(-1), [1, 2]);
  const calls2: unknown[] = [];
  const t2 = fakeTimers();
  const s2 = playSimLook(Object.assign((x: number, y: number) => { calls2.push([x, y]); }, { aid: "bh-ad-sim-look/1" as const }), path, null, t2.timers);
  s2(); t2.run(); assert.equal(calls2.length, 1, "stop() cancels the rest");
});
