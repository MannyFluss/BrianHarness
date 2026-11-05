// E6: builds the actor-director app element from the URL (demo snapshot or live in-process session).
import { useCallback, useEffect, useRef, useState } from "react";
import { AdStorage, CalibrationStore, SyntheticGazeTracker, demoReadingPath, loadO200kBrowser, simActor, simDirector, type CalibrationRecord, type LiveGaze, type SimReplay } from "@brianharness/core/actor-director/browser";
import type { Arm, BhAdEvent, ScreenInfo, SessionType } from "@brianharness/core/ad-contracts";
import { LocalStorageKV, MemoryKV } from "@brianharness/core/browser";
import { AdApp, type AdLayout } from "./AdApp";
import { CalibrationFlow, type CalibrationOutcome, type CalibrationStage } from "./Calibration";
import { MacBoot, macBridge } from "./mac/MacBoot";
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
export function webScreen(w = innerWidth, h = innerHeight, orientationType: string | null = typeof screen !== "undefined" && "orientation" in screen ? screen.orientation.type : null): ScreenInfo {
  const phone = Math.min(w, h) < 768;
  const landscape = w > h;
  const orientation: ScreenInfo["orientation"] = landscape ? (orientationType === "landscape-secondary" ? "landscape_right" : "landscape_left") : orientationType === "portrait-secondary" ? "portrait_upside_down" : "portrait";
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
function screenOrientation(): EventTarget | null { return typeof screen !== "undefined" && "orientation" in screen ? (screen.orientation as unknown as EventTarget) : null; }
export interface MountOptions { demoBase?: string }

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
    const sessionType: SessionType = q.get("type") === "blinded" ? "blinded" : "tab_visible";
    const arm: Arm = "on";
    const c = await LiveAdController.open({ sessionType, arm, sessionId: `web-${Date.now()}`, userId: "local", actor: simActor(boot.replays), director: simDirector(), counter: boot.counter, kv: boot.kv, tracker: boot.tracker, screen, calibration: rec, calStore: boot.calStore,
      // demo gaze from the REAL paragraph boxes (I4): each new reply's layout gets a simulated reader; ?gaze=r2 keeps the raw R2 loop
      ...(q.get("gaze") === "r2" ? {} : { onReadingLayout: (_msg: string, boxes: Array<{ x: number; y: number; w: number; h: number; words: number }>) => boot.tracker.play(demoReadingPath([...boxes].sort((a, b) => a.y - b.y)), performance.now(), { hold: { x: innerWidth / 2, y: innerHeight - 40 } }) }), consent: { camera: true, rawGaze: false } });
    // rotation / resize: new screen info, the stored calibration for the new orientation, aoi_layout re-logged
    const onResize = () => { void c.orientationChanged(webScreen()); };
    teardown.current?.();
    addEventListener("resize", onResize);
    screenOrientation()?.addEventListener("change", onResize);
    teardown.current = () => { removeEventListener("resize", onResize); screenOrientation()?.removeEventListener("change", onResize); c.dispose(); };
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
