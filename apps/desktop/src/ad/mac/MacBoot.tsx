/**
 * E7 / v1.5 Mac: live Actor/Director on the Mac. First Mac pilot = Pointer mode (default): no camera, interactive
 * AOI pointer evidence, choosable Actor/Director cloud models. Gaze/MediaPipe stays available when input_mode=gaze
 * (`?mode=gaze` or the setup picker) but is parked for the Pointer pilot. Mock Actor/Director in-process.
 * Shell: bh-app://app/ad.html?tracker=mediapipe[&calibrate=1][&h1=1][&mode=pointer|gaze|none].
 */
import { useEffect, useRef, useState } from "react";
import { AdStorage, CalibrationStore, loadO200kBrowser, networkIsolationProbe, simActor, simDirector, type CalibrationRecord, type SimReplay } from "@brianharness/core/actor-director/browser";
import { DEFAULT_ACTOR_MODEL, DEFAULT_DIRECTOR_MODEL, DEFAULT_POINTER_CONFIG, type InputMode, type ScreenInfo } from "@brianharness/core/ad-contracts";
import { LocalStorageKV, MemoryKV } from "@brianharness/core/browser";
import { AdApp, type AdLayout } from "../AdApp";
import { AdModelPicker, InputModePicker } from "../AdSessionControls";
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

function modeFromQuery(q: URLSearchParams): InputMode {
  const m = q.get("mode");
  return m === "gaze" || m === "none" || m === "pointer" ? m : "pointer"; // Mac pilot default: Pointer
}

type BootCommon = { screen: ScreenInfo; calStore: CalibrationStore; kv: LocalStorageKV | MemoryKV; replays: SimReplay[]; counter: Awaited<ReturnType<typeof loadO200kBrowser>> };
type Boot = BootCommon & { tracker: MediaPipeGazeTracker | null };

export function MacBoot({ q, replaysUrl, layout, reduce }: { q: URLSearchParams; replaysUrl: string; layout?: AdLayout; reduce?: boolean }) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [mode, setMode] = useState<InputMode>(() => modeFromQuery(q));
  const [actorModel, setActorModel] = useState(DEFAULT_ACTOR_MODEL);
  const [directorModel, setDirectorModel] = useState(DEFAULT_DIRECTOR_MODEL);
  const [ready, setReady] = useState(false); // setup confirmed
  const [rec, setRec] = useState<CalibrationRecord | null | undefined>(undefined);
  const [ctl, setCtl] = useState<LiveAdController | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; once.current = true;
    void (async () => {
      const bridge = macBridge();
      const kv = typeof localStorage !== "undefined" ? new LocalStorageKV() : new MemoryKV();
      const calStore = new CalibrationStore(await AdStorage.open(kv));
      const replays = await fetch(replaysUrl).then((r) => (r.ok ? (r.json() as Promise<SimReplay[]>) : FALLBACK)).catch(() => FALLBACK);
      const counter = await loadO200kBrowser();
      // Pointer / none: no MediaPipe (parked for first pilot). Gaze: start the camera tracker.
      const wantGaze = modeFromQuery(q) === "gaze";
      if (wantGaze) {
        const tracker = new MediaPipeGazeTracker({ bridge });
        const screen = await tracker.getScreenInfo();
        const r = await tracker.start({ mode: "camera", webNow: performance.now() });
        if (r.status.state === "error") setErr(`gaze tracker: ${r.status.code ?? "error"}`);
        const stored = calStore.load(screen.deviceModel, screen.orientation);
        if (stored?.model) await tracker.restoreCalibration({ orientation: screen.orientation, model: stored.model });
        setBoot({ tracker, screen, calStore, kv, replays, counter });
        setRec(q.get("calibrate") === "1" ? undefined : stored ?? null);
      } else {
        const screen: ScreenInfo = {
          deviceModel: "MacBookAir10,1", platform: "mac", orientation: "landscape_right",
          widthPt: typeof window !== "undefined" ? window.innerWidth : 1440,
          heightPt: typeof window !== "undefined" ? window.innerHeight : 900,
          scale: typeof window !== "undefined" ? window.devicePixelRatio || 2 : 2,
          widthMm: 301, webview: { x: 0, y: 0, width: typeof window !== "undefined" ? window.innerWidth : 1440, height: typeof window !== "undefined" ? window.innerHeight : 900 },
        };
        setBoot({ tracker: null, screen, calStore, kv, replays, counter });
        setRec(null);
      }
    })().catch((e) => setErr(String((e as Error).message ?? e)));
  }, [q, replaysUrl]);

  // if user switches setup mode to gaze after pointer boot, they need a refresh with ?mode=gaze — keep it simple

  useEffect(() => {
    if (!boot || !ready || rec === undefined || ctl) return;
    let c: LiveAdController | null = null;
    const useGaze = mode === "gaze" && boot.tracker;
    void LiveAdController.open({
      sessionType: q.get("type") === "blinded" ? "blinded" : "tab_visible",
      arm: "on",
      sessionId: `mac-${Date.now()}`,
      userId: "local",
      actor: simActor(boot.replays),
      director: simDirector(),
      counter: boot.counter,
      kv: boot.kv,
      tracker: useGaze ? boot.tracker : null,
      screen: boot.screen,
      calibration: useGaze ? rec : null,
      calStore: boot.calStore,
      consent: { camera: !!useGaze, rawGaze: false },
      inputMode: mode,
      models: { actor: actorModel, director: directorModel },
      ...(mode === "pointer" ? { pointerConfig: DEFAULT_POINTER_CONFIG } : {}),
      ...(useGaze && boot.tracker ? { preflightProbes: [macNetworkProbe(boot.tracker)] } : {}),
    }).then((x) => { c = x; setCtl(x); });
    return () => { c?.dispose(); };
  }, [boot, ready, rec, ctl, q, mode, actorModel, directorModel]);

  // H1: numbers to the shell every 2 s (gaze path only)
  useEffect(() => {
    const bridge = macBridge();
    if (!boot?.tracker || !bridge?.h1 || q.get("h1") !== "1") return;
    const id = setInterval(() => { void boot.tracker!.getStatus().then((status) => bridge.h1!({ t: performance.now(), status, stats: boot.tracker!.getStats(), health: ctl?.healthSeen() ?? [], pilotFail: ctl?.pilotFail ?? null, calibrated: !!rec?.model })); }, 2000);
    return () => clearInterval(id);
  }, [boot, ctl, q, rec]);

  if (err && !boot) return <div className="p-6 text-red-400">Could not start: {err}</div>;
  if (!boot) return <div className="p-6 text-muted-foreground">{mode === "gaze" ? "Loading the gaze model from the app bundle…" : "Starting Mac Actor/Director…"}</div>;

  if (!ready) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 p-6" data-ad-mac-setup>
        <h1 className="font-title text-2xl">Actor / Director — Mac</h1>
        <p className="text-sm text-muted-foreground">First Mac pilot is <strong>Pointer</strong>: interactive controls only (no eye camera). Changing input mode later starts a new session.</p>
        <InputModePicker value={mode} onChange={setMode} />
        <AdModelPicker role="actor" value={actorModel} onChange={(t) => { setActorModel(t); return null; }} />
        <AdModelPicker role="director" value={directorModel} onChange={(t) => { setDirectorModel(t); return null; }} />
        {mode === "gaze" && !boot.tracker && <div className="text-xs text-amber-300">Gaze needs a reload with <code>?mode=gaze</code> so MediaPipe can start.</div>}
        <button
          type="button"
          disabled={mode === "gaze" && !boot.tracker}
          onClick={() => setReady(true)}
          className="eeg-tap rounded-md bg-primary px-4 py-2 text-sm uppercase tracking-wider text-primary-foreground disabled:opacity-40"
          data-ad-mac-start
        >
          Start {mode} session
        </button>
      </div>
    );
  }

  if (mode === "gaze" && rec === undefined) return <CalibrationFlow screen={boot.screen} tracker={boot.tracker!} store={boot.calStore} onDone={(r) => setRec(r)} />;
  if (!ctl) return <div className="p-6 text-muted-foreground">Starting…</div>;
  return <AdApp store={ctl} {...(layout ? { layout } : {})} {...(reduce !== undefined ? { reduceMotion: reduce } : {})} onCalibrate={mode === "gaze" ? () => { ctl.dispose(); setCtl(null); setRec(undefined); } : undefined} />;
}
