/**
 * E6: calibration screens shared by the web app and iOS (IOS Dev wires these into I4 unchanged).
 * intro -> dots (5 on iPhone, 3x3 on iPad/Mac, then 4 validation dots) -> result (Use / Recalibrate /
 * Continue on on-screen time only). Saved per orientation in CalibrationStore (ad/meta/cal/<model>/<orientation>);
 * iPad Pro 11 (iPad13,4) landscape is the primary orientation. The result's distance feeds GazeSource's px/deg.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CalibrationRun, accuracyWords, calDeviceOf, primaryOrientation, isLandscape, simLookAt, type CalibrationRecord, type CalibrationStore } from "@brianharness/core/actor-director/browser";
import { nativeSimLookAt } from "./sim-look";
import type { CalibrationTarget, GazeTracker, Orientation, ScreenInfo } from "@brianharness/core/ad-contracts";
import { cn } from "../lib";

/** vite.ad.config.ts define: true for `vite` serve and `AD_SIM_BUILD=1` (iOS simulator) builds; false in a device build */
declare const __BH_AD_SIM__: boolean | undefined;

export type CalibrationStage = "intro" | "dots" | "result";
export interface CalibrationOutcome { record: CalibrationRecord; ok: boolean; words: string; recommend: "use" | "recalibrate_or_onscreen" }

export interface CalibrationDriverOptions {
  tracker: GazeTracker;
  screen: ScreenInfo;
  orientation?: Orientation;
  /** paragraph line-box height in CSS px (the error is reported in paragraphs) */
  paraHeightPx: number;
  /** gaze clock (same as GazeSample.t); default performance.now */
  now?: () => number;
  /** wall clock for the record */
  wall?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timing?: { dotMs?: number; settleMs?: number; gapMs?: number };
  /** the dot being shown (CSS px in the webview) */
  onDot?: (t: CalibrationTarget | null, index: number, total: number) => void;
  /** synthetic tracker / simulator build / tests: where the simulated person looks (never a device plugin call) */
  simLook?: (screenX: number, screenY: number) => void;
  signal?: AbortSignal;
}

/** the calibration pass without UI: the screens and the iOS shell both drive this */
export async function runCalibration(o: CalibrationDriverOptions): Promise<CalibrationOutcome> {
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = new CalibrationRun({ screen: o.screen, ...(o.orientation ? { orientation: o.orientation } : {}), paraHeightPx: o.paraHeightPx, ...(o.timing ? { timing: o.timing } : {}) });
  const sub = await o.tracker.addListener("gaze", (e) => run.push(e.samples));
  try {
    await o.tracker.calibrate({ phase: "begin", orientation: run.orientation, targets: run.sequence });
    const seq = run.sequence;
    for (let i = 0; i < seq.length; i++) {
      if (o.signal?.aborted) { await o.tracker.calibrate({ phase: "cancel" }); throw new Error("calibration cancelled"); }
      const tg = seq[i]!;
      o.onDot?.(tg, i, seq.length);
      o.simLook?.(tg.x + o.screen.webview.x, tg.y + o.screen.webview.y);
      const w = run.show(tg.id, now());
      await sleep(run.timing.dotMs);
      await o.tracker.calibrate({ phase: "target", targetId: tg.id, t0: w.t0, t1: w.t1 });
      await sleep(run.timing.gapMs);
    }
    o.onDot?.(null, seq.length, seq.length);
    const end = await o.tracker.calibrate({ phase: "end" });
    const r = run.finish({ t: now(), at: (o.wall ?? Date.now)() }, end.fit === "native" ? { model: end.model ?? null } : undefined);
    return r;
  } finally { await sub.remove(); }
}

function Dot({ t }: { t: CalibrationTarget }) {
  return (
    <div className="pointer-events-none absolute" style={{ left: t.x, top: t.y }} data-ad-cal-dot={t.id}>
      <span className="ad-dot absolute -left-4 -top-4 size-8 rounded-full border-2 border-signal" />
      <span className="absolute -left-1 -top-1 size-2 rounded-full bg-signal" />
    </div>
  );
}

export interface CalibrationFlowProps {
  screen: ScreenInfo;
  tracker: GazeTracker | null;
  store: CalibrationStore | null;
  orientation?: Orientation;
  paraHeightPx?: number;
  /** "use": the record (mode gaze, or onscreen_only when "continue on on-screen time only") */
  onDone: (rec: CalibrationRecord | null) => void;
  /** screenshots/tests: show a fixed stage */
  stage?: CalibrationStage;
  demo?: { dot?: CalibrationTarget; index?: number; total?: number; outcome?: CalibrationOutcome };
  /** synthetic tracker: simulate looking at the dots */
  simulateLook?: boolean;
  timing?: CalibrationDriverOptions["timing"];
}

export function CalibrationFlow({ screen, tracker, store, orientation, paraHeightPx = 72, onDone, stage: forced, demo, simulateLook, timing }: CalibrationFlowProps) {
  const [stage, setStage] = useState<CalibrationStage>(forced ?? "intro");
  const [dot, setDot] = useState<{ t: CalibrationTarget | null; i: number; n: number }>({ t: demo?.dot ?? null, i: demo?.index ?? 0, n: demo?.total ?? 0 });
  const [out, setOut] = useState<CalibrationOutcome | null>(demo?.outcome ?? null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const o = orientation ?? screen.orientation;
  const device = calDeviceOf(screen);
  const primary = primaryOrientation(screen.deviceModel);
  const start = useCallback(async () => {
    if (!tracker) { setErr("No gaze tracker on this device."); return; }
    setErr(null); setStage("dots");
    abort.current = new AbortController();
    try {
      // contract-v1.3: the JS synthetic tracker anywhere; a native plugin's lookAt ONLY in a simulator build
      // (__BH_AD_SIM__ is false in a device build, so this branch and sim-look.ts are stripped; tools/ad/check_device_build.mjs)
      const look = !simulateLook ? undefined : (typeof __BH_AD_SIM__ !== "undefined" && __BH_AD_SIM__) ? nativeSimLookAt(tracker) : simLookAt(tracker);
      const r = await runCalibration({ tracker, screen, orientation: o, paraHeightPx, signal: abort.current.signal, onDot: (t, i, n) => setDot({ t, i, n }), ...(look ? { simLook: look } : {}), ...(timing ? { timing } : {}) });
      setOut(r); setStage("result");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setStage("intro"); }
  }, [tracker, screen, o, paraHeightPx, simulateLook, timing]);
  const use = (mode: "gaze" | "onscreen_only") => {
    if (!out) { onDone(null); return; }
    const rec: CalibrationRecord = { ...out.record, mode: mode === "gaze" && out.recommend === "use" ? "gaze" : "onscreen_only" };
    store?.save(rec);
    onDone(rec);
  };

  return (
    <div className="eeg-app fixed inset-0 z-[60] flex flex-col bg-background text-foreground" data-ad-calibration-flow={stage}>
      {stage === "intro" && (
        <div className="m-auto flex max-w-md flex-col gap-4 p-6">
          <h1 className="font-title text-2xl">Calibrate gaze</h1>
          <p className="text-muted-foreground">Hold the {device === "phone" ? "iPhone" : device === "tablet" ? "iPad" : "Mac"} the way you'll read, about an arm's length away. Look at each dot until it moves: {device === "phone" ? 5 : 9} dots, then 4 to check the result. About {device === "phone" ? 15 : 25} seconds.</p>
          <p className="text-xs text-muted-foreground">Saved for {o.replace("_", " ")}{o === primary ? " (main orientation)" : isLandscape(o) !== isLandscape(primary) ? `; ${primary.replace("_", " ")} is calibrated separately` : ""}. The camera image never leaves the device.</p>
          {err && <p className="text-amber-400">{err}</p>}
          <div className="flex gap-2">
            <button className="eeg-tap rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={start} data-ad-cal-start>Start</button>
            <button className="eeg-tap rounded-md border px-4 py-2" onClick={() => onDone(null)} data-ad-cal-skip>Skip: on-screen time only</button>
          </div>
        </div>
      )}
      {stage === "dots" && (
        <div className="relative flex-1" aria-live="polite">
          {dot.t && <Dot t={dot.t} />}
          <p className="absolute inset-x-0 bottom-6 text-center text-xs text-muted-foreground">{dot.i < (dot.n || 1) ? `Dot ${dot.i + 1} of ${dot.n}${dot.t?.id.startsWith("v") ? " (checking)" : ""}` : "Fitting…"}</p>
          <button className="eeg-tap absolute right-4 top-4 rounded-md border px-3 py-1 text-xs" onClick={() => abort.current?.abort()}>Cancel</button>
        </div>
      )}
      {stage === "result" && out && (
        <div className="m-auto flex max-w-md flex-col gap-4 p-6" data-ad-cal-result={out.recommend}>
          <h1 className="font-title text-2xl">{out.recommend === "use" ? "Calibrated" : "Not accurate enough"}</h1>
          <p>Accuracy: <span className={out.recommend === "use" ? "text-signal" : "text-amber-400"}>{out.words}</span></p>
          <p className="text-xs text-muted-foreground">
            {out.record.errDeg !== null ? `${out.record.errDeg.toFixed(1)}° · ${out.record.errPx?.toFixed(0)} px · ` : ""}{out.record.distCm !== null ? `${Math.round(out.record.distCm)} cm from the screen` : "distance unknown"} · {o.replace("_", " ")}
          </p>
          {out.recommend !== "use" && <p className="text-muted-foreground">An error above one paragraph can't tell paragraphs apart. Recalibrate, or continue with on-screen time only (which paragraphs were visible, how long).</p>}
          <div className="flex flex-wrap gap-2">
            {out.recommend === "use" && <button className="eeg-tap rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={() => use("gaze")} data-ad-cal-use>Use</button>}
            <button className={cn("eeg-tap rounded-md px-4 py-2", out.recommend === "use" ? "border" : "bg-primary text-primary-foreground")} onClick={start} data-ad-cal-again>Recalibrate</button>
            <button className="eeg-tap rounded-md border px-4 py-2" onClick={() => use("onscreen_only")} data-ad-cal-onscreen>Continue on on-screen time only</button>
          </div>
        </div>
      )}
    </div>
  );
}
export { accuracyWords };
