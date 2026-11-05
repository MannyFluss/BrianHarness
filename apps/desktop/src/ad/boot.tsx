// E6: builds the actor-director app element from the URL (demo snapshot or live in-process session).
import { useCallback, useEffect, useRef, useState } from "react";
import { AdStorage, CalibrationStore, SyntheticGazeTracker, loadO200kBrowser, primaryOrientation, simActor, simDirector, type CalibrationRecord, type LiveGaze, type SimReplay } from "@brianharness/core/actor-director/browser";
import type { Arm, BhAdEvent, ScreenInfo, SessionType } from "@brianharness/core/ad-contracts";
import { LocalStorageKV, MemoryKV } from "@brianharness/core/browser";
import { AdApp, type AdLayout } from "./AdApp";
import { CalibrationFlow, type CalibrationOutcome, type CalibrationStage } from "./Calibration";
import { LiveAdController, blindedView, calibrationSummary, staticController, visibleView, type AdChatMsg, type PendingNote } from "./controller";

/** demo snapshot (scripts/ad-demo.mts). Blinded snapshots carry chat only: there are no lines to leak. */
export type AdDemo =
  | { sessionType: "tab_visible"; lines: BhAdEvent[]; chat: AdChatMsg[]; pending: PendingNote | null; live: LiveGaze[]; calibration: CalibrationRecord | null; nowMono: number; injected: string | null; selected: string | null }
  | { sessionType: "blinded"; chat: AdChatMsg[]; calibration: CalibrationRecord | null };

/** iPad Pro 11" (iPad13,4) landscape: the primary target; web CSS px == points */
export function webScreen(w = innerWidth, h = innerHeight): ScreenInfo {
  const phone = w < 768;
  return phone
    ? { deviceModel: "iPhone18,1", platform: "web", orientation: "portrait", widthPt: w, heightPt: h, scale: devicePixelRatio || 3, webview: { x: 0, y: 0, width: w, height: h }, widthMm: 65.9 }
    : { deviceModel: "iPad13,4", platform: "web", orientation: primaryOrientation("iPad13,4"), widthPt: w, heightPt: h, scale: devicePixelRatio || 2, webview: { x: 0, y: 0, width: w, height: h }, widthMm: 229.8 };
}

export async function mountAd(q: URLSearchParams): Promise<React.ReactElement> {
  const layout = (q.get("layout") as AdLayout | null) ?? undefined;
  const reduce = q.get("motion") === "reduce" ? true : undefined;
  const cal = q.get("cal") as CalibrationStage | null;
  const screen = webScreen();
  if (cal) {
    const res = q.get("demo") ? (await (await fetch(`/ad-demo/cal-${q.get("demo")}.json`)).json() as CalibrationOutcome) : undefined;
    const run = new SyntheticGazeTracker({ screen });
    const dots = q.get("dot");
    return <CalibrationFlow screen={screen} tracker={run} store={null} stage={cal} onDone={() => {}} demo={{ ...(res ? { outcome: res } : {}), ...(dots ? { dot: JSON.parse(dots), index: Number(q.get("i") ?? 0), total: Number(q.get("n") ?? 13) } : {}) }} />;
  }
  if (q.get("demo")) {
    const d = (await (await fetch(`/ad-demo/${q.get("demo")}.json`)).json()) as AdDemo;
    const tabOpen = q.get("tab") === "closed" ? false : q.get("tab") === "open" ? true : undefined;
    if (d.sessionType === "blinded") return <AdApp store={staticController(blindedView(d.chat, calibrationSummary(d.calibration)))} {...(layout ? { layout } : {})} />;
    const view = visibleView(d.lines, d.chat, { calibration: calibrationSummary(d.calibration), pending: d.pending });
    return <AdApp store={staticController(view, d.live)} {...(layout ? { layout } : {})} {...(tabOpen !== undefined ? { tabOpen } : {})} {...(reduce !== undefined ? { reduceMotion: reduce } : {})} holdInjection={q.get("inject") === "1" ? d.injected : null} selectedCard={q.get("sel") === "1" ? d.selected : null} now={() => d.nowMono} />;
  }
  return <LiveBoot q={q} screen={screen} {...(layout ? { layout } : {})} {...(reduce !== undefined ? { reduce } : {})} />;
}

/** live: mock backends + synthetic tracker replaying the R2-derived replays, all in-process (no network) */
type Boot = { kv: LocalStorageKV | MemoryKV; calStore: CalibrationStore; replays: SimReplay[]; tracker: SyntheticGazeTracker; counter: Awaited<ReturnType<typeof loadO200kBrowser>> };
function LiveBoot({ q, screen, layout, reduce }: { q: URLSearchParams; screen: ScreenInfo; layout?: AdLayout; reduce?: boolean }) {
  const [b, setB] = useState<Boot | null>(null);
  const [el, setEl] = useState<React.ReactElement | null>(null);
  const [calibrating, setCalibrating] = useState(q.get("calibrate") === "1");
  const started = useRef(false);
  useEffect(() => { void (async () => {
    const kv = typeof localStorage !== "undefined" ? new LocalStorageKV() : new MemoryKV();
    const calStore = new CalibrationStore(await AdStorage.open(kv));
    const replays = (await (await fetch("/ad-demo/replays.json")).json()) as SimReplay[];
    const tracker = new SyntheticGazeTracker({ screen });
    await tracker.start({ mode: "synthetic", synthetic: { samples: replays.flatMap((r) => r.file.samples), loop: true }, webNow: performance.now() } as unknown as Parameters<SyntheticGazeTracker["start"]>[0]);
    tracker.startTimer();
    setB({ kv, calStore, replays, tracker, counter: await loadO200kBrowser() });
  })(); }, [screen]);
  const start = useCallback(async (boot: Boot, rec: CalibrationRecord | null) => {
    const sessionType: SessionType = q.get("type") === "blinded" ? "blinded" : "tab_visible";
    const arm: Arm = "on";
    const c = await LiveAdController.open({ sessionType, arm, sessionId: `web-${Date.now()}`, userId: "local", actor: simActor(boot.replays), director: simDirector(), counter: boot.counter, kv: boot.kv, tracker: boot.tracker, screen, calibration: rec, consent: { camera: true, rawGaze: false } });
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
