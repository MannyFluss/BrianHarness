/**
 * Gaze plugin API: the native iOS Capacitor plugin (jsName "BHGaze", BHGazePlugin.swift) and the Mac
 * MediaPipe tracker (Electron renderer Web Worker) both implement GazeTracker, so core, the sim and the
 * Director tab never know which tracker is running.
 *
 * Privacy: every method resolves to numbers, booleans and short enum strings only. No method, event or
 * error ever carries an image, a frame, a pixel buffer, a mesh or a file path to one. The JSON Schemas
 * set additionalProperties:false on every result and event so an extra field fails validation.
 */
import type { GazeHz, GazeSample, GazeSrc } from "./gaze.js";
import type { HealthCode } from "./health.js";

/** iOS AVAuthorizationStatus mapped; Mac: systemPreferences.getMediaAccessStatus("camera") mapped */
export type CameraPermission = "prompt" | "granted" | "denied" | "restricted";
export type Orientation = "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";
export type TrackerKind = "arkit" | "mediapipe";
export type TrackerState = "idle" | "starting" | "running" | "calibrating" | "paused" | "stopped" | "error";
/** why a running tracker paused; it resumes on its own when the cause clears, except "user" (call resume()) */
export type PauseReason = "background" | "user" | "interrupted" | "permission_revoked";

export interface ScreenInfo {
  /** iOS: "iPad13,4", "iPhone18,1"... (utsname machine id); Mac: "Mac" + process.arch; Simulator: SIMULATOR_MODEL_IDENTIFIER */
  deviceModel: string;
  platform: "ios" | "mac" | "web";
  orientation: Orientation;
  /** screen size in points in the current orientation */
  widthPt: number;
  heightPt: number;
  /** points -> device pixels (UIScreen.scale / devicePixelRatio); for px-per-degree only */
  scale: number;
  /** webview frame in screen points: web CSS px = screen pt - origin */
  webview: { x: number; y: number; width: number; height: number };
  /** physical screen width in mm when the model is known (geometry table), else null */
  widthMm: number | null;
}

export interface GazeStatus {
  supported: boolean;
  /** why not supported: gaze.arkit_unsupported | gaze.model_missing; null when supported */
  unsupportedCode: HealthCode | null;
  permission: CameraPermission;
  state: TrackerState;
  pauseReason: PauseReason | null;
  tracker: TrackerKind | null;
  /** mode of the current or last start() */
  mode: "camera" | "synthetic" | null;
  /** current output rate; null unless running */
  hz: GazeHz | null;
  /** most recent health code raised by the tracker itself, null when healthy */
  code: HealthCode | null;
}

export interface SyntheticSource {
  /** a replay file bundled with the web assets, path relative to the web root, e.g. "gaze-replays/iphone17pro-portrait-01.json" */
  file?: string;
  /** or the samples inline (t relative to the first sample) */
  samples?: GazeSample[];
  /** replay the file from the start when it ends (default true) */
  loop?: boolean;
  /** playback speed multiplier (default 1) */
  speed?: number;
}

export interface StartOptions {
  mode: "camera" | "synthetic";
  /** required when mode is "synthetic" */
  synthetic?: SyntheticSource;
  /** performance.now() in the web layer at call time; native anchors its monotonic clock to this */
  webNow: number;
  /** default 30; a tracker never exceeds it and drops to 15 when hot */
  maxHz?: GazeHz;
}
export interface StartResult { status: GazeStatus; screen: ScreenInfo }

export interface CalibrationTarget { id: string; x: number; y: number }
/**
 * Calibration is driven by the shared web screens (E6): 5 dots on iPhone, 9 on iPad and Mac, then 4
 * validation dots. calibrate() is called once per phase:
 *   begin  {orientation, targets}         tracker holds the full rate (no thermal step-down) until end/cancel
 *   target {targetId, t0, t1}             the settled window [t0,t1] (web clock) the person looked at the dot
 *   end    {}                             tracker fits if it fits natively, returns the result
 *   cancel {}                             discard
 * fit "core": the tracker emits uncalibrated samples (cal:false) and core L0 fits/applies the affine
 *   (the iOS plugin does this: no fitting in Swift).
 * fit "native": the tracker fitted its own model (the Mac ridge regression on iris features) and now emits cal:true.
 * Calibrations are saved per orientation by core (actor-director storage), not by the tracker.
 */
export type CalibrateOptions =
  | { phase: "begin"; orientation: Orientation; targets: CalibrationTarget[] }
  | { phase: "target"; targetId: string; t0: number; t1: number }
  | { phase: "end" }
  | { phase: "cancel" };
export interface CalibrateResult {
  phase: "begin" | "target" | "end" | "cancel";
  ok: boolean;
  /** end only: who fitted the model */
  fit: "core" | "native" | null;
  /** end + native fit: opaque model numbers core stores per orientation and hands back via restoreCalibration */
  model: number[] | null;
  /** samples with a face inside target windows so far */
  samples: number;
  code: HealthCode | null;
}

/** one batch of samples, emitted about every 100 ms (3 samples at 30 Hz, 1-2 at 15 Hz) */
export interface GazeBatchEvent {
  seq: number;
  hz: GazeHz;
  samples: GazeSample[];
}
export type GazeStatusEvent = GazeStatus;

export interface GazeTracker {
  getStatus(): Promise<GazeStatus>;
  /** shows the OS prompt only when permission is "prompt" */
  requestPermission(): Promise<{ permission: CameraPermission }>;
  getScreenInfo(): Promise<ScreenInfo>;
  start(opts: StartOptions): Promise<StartResult>;
  /** stops the camera / replay; idempotent */
  stop(): Promise<{ status: GazeStatus }>;
  /** the one-tap pause in the tab (pauseReason "user") */
  pause(): Promise<{ status: GazeStatus }>;
  resume(): Promise<{ status: GazeStatus }>;
  calibrate(opts: CalibrateOptions): Promise<CalibrateResult>;
  /** hands back a stored native-fit model for this orientation (no-op ok:true for fit "core" trackers) */
  restoreCalibration(opts: { orientation: Orientation; model: number[] }): Promise<{ ok: boolean }>;
  /** re-anchor the sample clock (call on foreground and every 60 s); returns the measured drift in ms */
  syncClock(opts: { webNow: number }): Promise<{ driftMs: number }>;
  addListener(event: "gaze", cb: (e: GazeBatchEvent) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: "status", cb: (e: GazeStatusEvent) => void): Promise<{ remove(): Promise<void> }>;
  /**
   * v1.2, optional, SIMULATOR / SYNTHETIC ONLY: sets the simulated gaze point (screen pt) the synthetic tracker
   * reports next (the calibration screens call it when they show a dot). Absent on device trackers (ARKit, MediaPipe)
   * or a no-op there. Detect it with `typeof tracker.lookAt === "function"`, never `"lookAt" in tracker` (a Capacitor
   * plugin proxy has no `has` trap, so `in` is false even when the native method exists).
   */
  lookAt?(x: number, y: number): void | Promise<void>;
}

/** gaze replay file: synthetic mode, the replay CLI and the R2 generator */
export interface GazeReplayFile {
  schema: "bh-gaze-replay/1";
  /** "iphone17pro-portrait" | "ipadpro-m1-landscape" | "macbook" | other layout id */
  layout: string;
  src: Extract<GazeSrc, "synthetic" | "replay">;
  hz: GazeHz;
  screen: ScreenInfo;
  /** t relative to the first sample (first t = 0); trackers rebase t to the live clock on playback */
  samples: GazeSample[];
}
