/**
 * E7 Mac: the live app on the Mac with the real camera tracker (MediaPipe in a Web Worker). Mock Actor/Director
 * in-process (no LLM on the Mac, no network). Started by the Director Mac shell (electron/ad-main.mjs) as
 * bh-app://app/ad.html?tracker=mediapipe[&calibrate=1][&h1=1]; window.bhAdMac is its preload bridge.
 * With h1=1 the tracker numbers + every health code are sent to the shell every 2 s for the H1 report.
 */
import { useEffect, useRef, useState } from "react";
import { AdStorage, CalibrationStore, loadO200kBrowser, networkIsolationProbe, simActor, simDirector, type CalibrationRecord, type SimReplay } from "@brianharness/core/actor-director/browser";
import type { ScreenInfo } from "@brianharness/core/ad-contracts";
import { LocalStorageKV, MemoryKV } from "@brianharness/core/browser";
import { AdApp, type AdLayout } from "../AdApp";
import { CalibrationFlow } from "../Calibration";
import { LiveAdController } from "../controller";
import { MediaPipeGazeTracker, type MacBridge } from "./mediapipe-tracker";

/** a built-in reply set when the demo replays are not bundled */
const FALLBACK: SimReplay[] = [{ name: "mac-fallback", file: { screen: null, samples: [] }, turn: { aois: [
  { id: "a.p1", order: 1, text: "A sourdough starter is flour and water that wild yeast and bacteria have colonised. Feed it every day at room temperature and it stays active." },
  { id: "a.p2", order: 2, text: "Rye flour ferments faster than wheat because it carries more wild yeast and enzymes, so a rye starter rises sooner and smells sourer." },
  { id: "a.p3", order: 3, text: "For a first loaf, seventy five percent hydration is forgiving: the dough holds its shape and still opens up in the oven." },
] } } as unknown as SimReplay];

export const macBridge = (): MacBridge | null => (globalThis as { bhAdMac?: MacBridge }).bhAdMac ?? null;
/** v1.3: the Mac shell's network.isolation probe (skips without the shell's network bridge) */
export const macNetworkProbe = (tracker: { getStats(): { blocked: string[] } }, bridge: () => MacBridge | null = macBridge) =>
  networkIsolationProbe(async () => {
    const b = bridge();
    if (!b?.network) return null;
    return { workerBlocked: tracker.getStats().blocked, requests: await b.network() };
  });

export function MacBoot({ q, replaysUrl, layout, reduce }: { q: URLSearchParams; replaysUrl: string; layout?: AdLayout; reduce?: boolean }) {
  const [boot, setBoot] = useState<{ tracker: MediaPipeGazeTracker; screen: ScreenInfo; calStore: CalibrationStore; kv: LocalStorageKV | MemoryKV; replays: SimReplay[]; counter: Awaited<ReturnType<typeof loadO200kBrowser>> } | null>(null);
  const [rec, setRec] = useState<CalibrationRecord | null | undefined>(undefined);
  const [ctl, setCtl] = useState<LiveAdController | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return; once.current = true;
    void (async () => {
      const bridge = macBridge();
      const tracker = new MediaPipeGazeTracker({ bridge });
      const screen = await tracker.getScreenInfo();
      const kv = typeof localStorage !== "undefined" ? new LocalStorageKV() : new MemoryKV();
      const calStore = new CalibrationStore(await AdStorage.open(kv));
      const replays = await fetch(replaysUrl).then((r) => (r.ok ? (r.json() as Promise<SimReplay[]>) : FALLBACK)).catch(() => FALLBACK);
      const r = await tracker.start({ mode: "camera", webNow: performance.now() });
      if (r.status.state === "error") setErr(`gaze tracker: ${r.status.code ?? "error"}`);
      const stored = calStore.load(screen.deviceModel, screen.orientation);
      if (stored?.model) await tracker.restoreCalibration({ orientation: screen.orientation, model: stored.model });
      setBoot({ tracker, screen, calStore, kv, replays, counter: await loadO200kBrowser() });
      setRec(q.get("calibrate") === "1" ? undefined : stored ?? null);
    })().catch((e) => setErr(String((e as Error).message ?? e)));
  }, [q, replaysUrl]);
  useEffect(() => {
    if (!boot || rec === undefined || ctl) return;
    let c: LiveAdController | null = null;
    void LiveAdController.open({ sessionType: q.get("type") === "blinded" ? "blinded" : "tab_visible", arm: "on", sessionId: `mac-${Date.now()}`, userId: "local", actor: simActor(boot.replays), director: simDirector(), counter: boot.counter, kv: boot.kv, tracker: boot.tracker, screen: boot.screen, calibration: rec, calStore: boot.calStore, consent: { camera: true, rawGaze: false },
      // v1.3 network.isolation: Worker-blocked URLs (informational) + requests that got past the block (pilot FAILS)
      preflightProbes: [macNetworkProbe(boot.tracker)] }).then((x) => { c = x; setCtl(x); });
    return () => { c?.dispose(); };
  }, [boot, rec, ctl, q]);
  // H1: numbers to the shell every 2 s
  useEffect(() => {
    const bridge = macBridge();
    if (!boot || !bridge?.h1 || q.get("h1") !== "1") return;
    const id = setInterval(() => { void boot.tracker.getStatus().then((status) => bridge.h1!({ t: performance.now(), status, stats: boot.tracker.getStats(), health: ctl?.healthSeen() ?? [], pilotFail: ctl?.pilotFail ?? null, calibrated: !!rec?.model })); }, 2000);
    return () => clearInterval(id);
  }, [boot, ctl, q, rec]);
  if (err && !boot) return <div className="p-6 text-red-400">Could not start: {err}</div>;
  if (!boot) return <div className="p-6 text-muted-foreground">Loading the gaze model from the app bundle…</div>;
  if (rec === undefined) return <CalibrationFlow screen={boot.screen} tracker={boot.tracker} store={boot.calStore} onDone={(r) => setRec(r)} />;
  if (!ctl) return <div className="p-6 text-muted-foreground">Starting…</div>;
  return <AdApp store={ctl} {...(layout ? { layout } : {})} {...(reduce !== undefined ? { reduceMotion: reduce } : {})} onCalibrate={() => { ctl.dispose(); setCtl(null); setRec(undefined); }} />;
}
