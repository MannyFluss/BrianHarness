// E6: builds the actor-director app element from the URL (demo snapshot or live in-process session).
import { useCallback, useEffect, useRef, useState } from "react";
import { AdStorage, CalibrationStore, SyntheticGazeTracker, demoReadingPath, loadO200kBrowser, simActor, simDirector, type CalibrationRecord, type LiveGaze, type SimReplay } from "@brianharness/core/actor-director/browser";
import type { Arm, BhAdEvent, GazeTracker, ScreenInfo, SessionType } from "@brianharness/core/ad-contracts";

declare const __BH_AD_SIM__: boolean | undefined;
import { LocalStorageKV, MemoryKV } from "@brianharness/core/browser";
import { AdApp, type AdLayout } from "./AdApp";
import { CalibrationFlow, type CalibrationOutcome, type CalibrationStage } from "./Calibration";
import { MacBoot, macBridge } from "./mac/MacBoot";
import { browserOrientationEnv, isIosWebView, landscapeName, watchOrientation } from "./orientation";
import { nativeSimLookAt, playSimLook, type SimLookTimers } from "./sim-look";
import { LiveAdController, blindedView, calibrationSummary, staticController, visibleView, type AdChatMsg, type PendingNote } from "./controller";

/** demo snapshot (scripts/ad-demo.mts). Blinded snapshots carry chat only: there are no lines to leak. */
export type AdDemo =
  | { sessionType: "tab_visible"; lines: BhAdEvent[]; chat: AdChatMsg[]; pending: PendingNote | null; live: LiveGaze[]; calibration: CalibrationRecord | null; nowMono: number; injected: string | null; selected: string | null }
  | { sessionType: "blinded"; chat: AdChatMsg[]; calibration: CalibrationRecord | null };

/**
 * iPad Pro 11" (iPad13,4) landscape is the primary target; web CSS px == points. The device class comes from the
 * short side (a rotated phone stays a phone); orientation from the aspect (and screen.orientation.type when the
 * browser has it), so a rotation gives a new orientation and its own calibration key. widthMm follows the side
 * that is horizontal now.
 */
export function webScreen(w = innerWidth, h = innerHeight, orientationType: string | null = typeof screen !== "undefined" && "orientation" in screen ? screen.orientation.type : null, ios: boolean = isIosWebView()): ScreenInfo {
  const phone = Math.min(w, h) < 768;
  const landscape = w > h;
  // I5b: landscape names follow native UIInterfaceOrientation (iOS WKWebView landscape-primary = landscapeRight)
  const orientation: ScreenInfo["orientation"] = landscape ? landscapeName(orientationType, ios) : orientationType === "portrait-secondary" ? "portrait_upside_down" : "portrait";
  const base = { platform: "web" as const, orientation, widthPt: w, heightPt: h, webview: { x: 0, y: 0, width: w, height: h } };
  return phone
    ? { ...base, deviceModel: "iPhone18,1", scale: globalThis.devicePixelRatio || 3, widthMm: landscape ? 143.2 : 65.9 }
    : { ...base, deviceModel: "iPad13,4", scale: globalThis.devicePixelRatio || 2, widthMm: landscape ? 229.8 : 160.0 };
}

/**
 * where the demo JSON lives (IOS Dev I4: the iOS bundle is served from ad-ios/ with no dev server). Default
 * "./ad-demo/" resolved against the document base, so it works at / (dev server), under ad-ios/ (Capacitor bundle,
 * capacitor:// or file://) and in dist-ad. Override with the `demoBase` option or the ?demoBase= query.
 */
export const DEFAULT_DEMO_BASE = "./ad-demo/";
export function demoUrl(name: string, base: string = DEFAULT_DEMO_BASE, docBase: string = typeof document !== "undefined" ? document.baseURI : "http://localhost/"): string {
  return new URL(name, new URL(base.endsWith("/") ? base : base + "/", docBase)).href;
}
export interface MountOptions { demoBase?: string }

/** I5: the demo reader's head distance: the calibration's distCm (iPhone ~30 cm); 42 cm only when uncalibrated */
export const DEMO_DIST_CM = 42;
export const demoDistCm = (rec: CalibrationRecord | null | undefined): number => (rec && typeof rec.distCm === "number" && rec.distCm > 0 ? rec.distCm : DEMO_DIST_CM);
/**
 * the live demo's onReadingLayout: a simulated reader over the real paragraph boxes at the CURRENT calibration's
 * distance (so the synthetic head never reads as "distance changed" and prompts a false recalibration). The hold
 * samples between replies use the same distance.
 *
 * I5b: any tracker with the sim lookAt capability (contract-v1.4: `getStatus().mode === "synthetic"`, sim-look.ts):
 *  - the JS SyntheticGazeTracker: the reading path is played as samples (play + setDistCm), as before;
 *  - any other tracker (the iOS-simulator native plugin): ONLY in a simulator build (`__BH_AD_SIM__`, AD_SIM_BUILD=1;
 *    the branch and sim-look.ts are stripped from device bundles), the same reading path is walked as fixations with
 *    `lookAt({x, y})` on a JS timer, then the eyes rest at `hold`. The native synthetic player reports the look point
 *    (cal:true) at its own synthetic head distance, the same one its calibration measured. Capability is re-checked
 *    per reply; a tracker without it (camera mode, a device build) gets nothing.
 * `stop()` cancels a walk in progress (teardown).
 */
export type DemoGazeHandler = ((msg: string, boxes: Array<{ x: number; y: number; w: number; h: number; words: number }>) => void) & { stop(): void };
export function liveDemoGaze(tracker: GazeTracker, calibration: () => CalibrationRecord | null, hold: () => { x: number; y: number }, now: () => number = () => performance.now(), o: { timers?: SimLookTimers } = {}): DemoGazeHandler {
  if (tracker instanceof SyntheticGazeTracker) {
    const fn = (_msg: string, boxes: Array<{ x: number; y: number; w: number; h: number; words: number }>) => {
      const distCm = demoDistCm(calibration());
      tracker.setDistCm(distCm);
      tracker.play(demoReadingPath([...boxes].sort((a, b) => a.y - b.y), { distCm }), now(), { hold: hold() });
    };
    return Object.assign(fn, { stop() {} });
  }
  if (typeof __BH_AD_SIM__ !== "undefined" && __BH_AD_SIM__) {
    let stopWalk: (() => void) | null = null;
    let gen = 0;
    const fn = (_msg: string, boxes: Array<{ x: number; y: number; w: number; h: number; words: number }>) => {
      const path = demoReadingPath([...boxes].sort((a, b) => a.y - b.y), { distCm: demoDistCm(calibration()) });
      const mine = ++gen;
      void nativeSimLookAt(tracker).then((look) => {
        if (mine !== gen) return; // a newer reply's layout arrived meanwhile
        stopWalk?.(); stopWalk = null;
        if (look) stopWalk = playSimLook(look, path, hold(), o.timers);
      });
    };
    return Object.assign(fn, { stop() { gen++; stopWalk?.(); stopWalk = null; } });
  }
  return Object.assign(() => {}, { stop() {} });
}

/** the native shell's launch hints (IOS Dev: -BHADSession blinded -> __BH_AD__.session; the blind schedule position) */
export interface AdLaunchHints { session?: string; blind?: { index: number; total: number; scheduleHash: string } }
const HASH = /^[0-9a-f]{64}$/;
/**
 * I5: a blinded session's position in the sealed schedule, {index, total, scheduleHash} (contract: session_start.blind,
 * blinded only; index 1-based <= total, scheduleHash sha256 hex). From the native hints (__BH_AD__.blind) or the
 * query (?blind=<index>/<total>&scheduleHash=<sha256>). Invalid or absent -> undefined (logged without it, never guessed).
 */
export function blindFrom(q: URLSearchParams, hints: AdLaunchHints | null | undefined = (globalThis as { __BH_AD__?: AdLaunchHints }).__BH_AD__): { index: number; total: number; scheduleHash: string } | undefined {
  const fromQ = q.get("blind")?.match(/^(\d+)\/(\d+)$/);
  const b = hints?.blind ?? (fromQ ? { index: Number(fromQ[1]), total: Number(fromQ[2]), scheduleHash: q.get("scheduleHash") ?? "" } : undefined);
  if (!b) return undefined;
  const ok = Number.isInteger(b.index) && Number.isInteger(b.total) && b.index >= 1 && b.total >= 1 && b.index <= b.total && HASH.test(String(b.scheduleHash).toLowerCase());
  return ok ? { index: b.index, total: b.total, scheduleHash: String(b.scheduleHash).toLowerCase() } : undefined;
}
export function sessionTypeFrom(q: URLSearchParams, hints: AdLaunchHints | null | undefined = (globalThis as { __BH_AD__?: AdLaunchHints }).__BH_AD__): SessionType {
  return (q.get("type") ?? hints?.session) === "blinded" ? "blinded" : "tab_visible";
}

export async function mountAd(q: URLSearchParams, opts: MountOptions = {}): Promise<React.ReactElement> {
  const demoBase = opts.demoBase ?? q.get("demoBase") ?? DEFAULT_DEMO_BASE;
  const url = (name: string) => demoUrl(name, demoBase);
  const layout = (q.get("layout") as AdLayout | null) ?? undefined;
  const reduce = q.get("motion") === "reduce" ? true : undefined;
  const cal = q.get("cal") as CalibrationStage | null;
  const screen = webScreen();
  if (cal) {
    const res = q.get("demo") ? (await (await fetch(url(`cal-${q.get("demo")}.json`))).json() as CalibrationOutcome) : undefined;
    const run = new SyntheticGazeTracker({ screen });
    const dots = q.get("dot");
    return <CalibrationFlow screen={screen} tracker={run} store={null} stage={cal} onDone={() => {}} demo={{ ...(res ? { outcome: res } : {}), ...(dots ? { dot: JSON.parse(dots), index: Number(q.get("i") ?? 0), total: Number(q.get("n") ?? 13) } : {}) }} />;
  }
  if (q.get("demo")) {
    const d = (await (await fetch(url(`${q.get("demo")}.json`))).json()) as AdDemo;
    const tabOpen = q.get("tab") === "closed" ? false : q.get("tab") === "open" ? true : undefined;
    if (d.sessionType === "blinded") return <AdApp store={staticController(blindedView(d.chat, calibrationSummary(d.calibration)))} {...(layout ? { layout } : {})} />;
    const view = visibleView(d.lines, d.chat, { calibration: calibrationSummary(d.calibration), pending: d.pending });
    return <AdApp store={staticController(view, d.live)} {...(layout ? { layout } : {})} {...(tabOpen !== undefined ? { tabOpen } : {})} {...(reduce !== undefined ? { reduceMotion: reduce } : {})} holdInjection={q.get("inject") === "1" ? d.injected : null} selectedCard={q.get("sel") === "1" ? d.selected : null} now={() => d.nowMono} />;
  }
  if (q.get("tracker") === "mediapipe" || macBridge()) return <MacBoot q={q} replaysUrl={url("replays.json")} {...(layout ? { layout } : {})} {...(reduce !== undefined ? { reduce } : {})} />;
  return <LiveBoot q={q} screen={screen} replaysUrl={url("replays.json")} {...(layout ? { layout } : {})} {...(reduce !== undefined ? { reduce } : {})} />;
}

/** live: mock backends + synthetic tracker replaying the R2-derived replays, all in-process (no network) */
type Boot = { kv: LocalStorageKV | MemoryKV; calStore: CalibrationStore; replays: SimReplay[]; tracker: SyntheticGazeTracker; counter: Awaited<ReturnType<typeof loadO200kBrowser>> };
function LiveBoot({ q, screen, layout, reduce, replaysUrl }: { q: URLSearchParams; screen: ScreenInfo; layout?: AdLayout; reduce?: boolean; replaysUrl: string }) {
  const [b, setB] = useState<Boot | null>(null);
  const [el, setEl] = useState<React.ReactElement | null>(null);
  const [calibrating, setCalibrating] = useState(q.get("calibrate") === "1");
  const started = useRef(false);
  const teardown = useRef<(() => void) | null>(null);
  useEffect(() => () => { teardown.current?.(); teardown.current = null; }, []);
  useEffect(() => { void (async () => {
    const kv = typeof localStorage !== "undefined" ? new LocalStorageKV() : new MemoryKV();
    const calStore = new CalibrationStore(await AdStorage.open(kv));
    const replays = (await (await fetch(replaysUrl)).json()) as SimReplay[];
    const tracker = new SyntheticGazeTracker({ screen });
    await tracker.start({ mode: "synthetic", synthetic: { samples: q.get("gaze") === "r2" ? replays.flatMap((r) => r.file.samples) : [], loop: true }, webNow: performance.now() } as unknown as Parameters<SyntheticGazeTracker["start"]>[0]);
    tracker.startTimer();
    setB({ kv, calStore, replays, tracker, counter: await loadO200kBrowser() });
  })(); }, [screen, replaysUrl]);
  const start = useCallback(async (boot: Boot, rec: CalibrationRecord | null) => {
    const sessionType = sessionTypeFrom(q);
    const arm: Arm = "on";
    // I5: a blinded session logs its schedule position (session_start.blind; the arm is never logged in blinded)
    const blind = sessionType === "blinded" ? blindFrom(q) : undefined;
    if (sessionType === "blinded" && !blind) console.warn("[ad] blinded session without a valid blind {index,total,scheduleHash}: logged without it");
    let ctl: LiveAdController | null = null;
    boot.tracker.setDistCm(demoDistCm(rec));
    const demoGaze = q.get("gaze") === "r2" ? null : liveDemoGaze(boot.tracker, () => ctl?.calibrationRecord ?? rec, () => ({ x: innerWidth / 2, y: innerHeight - 40 }));
    const c = await LiveAdController.open({ sessionType, arm, sessionId: `web-${Date.now()}`, userId: "local", actor: simActor(boot.replays), director: simDirector(), counter: boot.counter, kv: boot.kv, tracker: boot.tracker, screen, calibration: rec, calStore: boot.calStore,
      ...(blind ? { blind } : {}),
      // demo gaze from the REAL paragraph boxes (I4) at the calibration's distance (I5); ?gaze=r2 keeps the raw R2 loop
      ...(demoGaze ? { onReadingLayout: demoGaze } : {}), consent: { camera: true, rawGaze: false } });
    ctl = c;
    // rotation / resize (I5: WKWebView fires no resize on landscape_left <-> landscape_right): every source, deduped
    teardown.current?.();
    const env = browserOrientationEnv();
    // I5b: a native-pushed orientation is the truth whenever present (seeded from the tracker's status, if it has one)
    const st0 = await boot.tracker.getStatus().catch(() => null);
    const w = env ? watchOrientation({ env, initial: screen, ...(st0?.orientation ? { initialNative: st0.orientation } : {}), read: (wd, h, t) => webScreen(wd, h, t), onChange: (s) => { void c.orientationChanged(s).then(() => boot.tracker.setDistCm(demoDistCm(c.calibrationRecord))); } }) : null;
    const sub = await boot.tracker.addListener("status", (st) => { if (st.orientation) w?.native(st.orientation); });
    teardown.current = () => { w?.stop(); demoGaze?.stop(); void sub.remove(); c.dispose(); };
    setEl(<AdApp store={c} {...(layout ? { layout } : {})} {...(reduce !== undefined ? { reduceMotion: reduce } : {})} onCalibrate={() => setCalibrating(true)} />);
  }, [q, screen, layout, reduce]);
  useEffect(() => {
    if (!b || calibrating || started.current) return;
    started.current = true;
    void start(b, b.calStore.load(screen.deviceModel, screen.orientation));
  }, [b, calibrating, start, screen]);
  if (!b) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (calibrating) return <CalibrationFlow screen={screen} tracker={b.tracker} store={b.calStore} simulateLook onDone={(r) => { setCalibrating(false); started.current = true; void start(b, r); }} />;
  return el ?? <div className="p-6 text-muted-foreground">Starting…</div>;
}
