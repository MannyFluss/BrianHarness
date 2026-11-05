/**
 * E7 Mac gaze path: the GazeTracker (contract gaze-plugin.ts) for Electron on the Mac. MediaPipe FaceLandmarker
 * runs in a Web Worker (gaze.worker.ts) on frames from the built-in camera; this side turns the worker's iris /
 * head-pose numbers into GazeSamples (src "mediapipe") and fits its own ridge calibration (fit "native").
 * No LLM on the Mac, no network: model + wasm are bundled and verified (protocol.ts pins).
 *
 * Calibration (shared screens, E6): the fit dots are c1..c9, validation v1..v4. The tracker fits the ridge as soon
 * as the last fit dot's window arrives, so the validation dots already see calibrated (cal:true) samples and core
 * reports the validation error in paragraphs. Before a fit, samples carry a rough geometric guess (cal:false).
 * Coordinates: cal:true = web CSS px (the targets' space, like the synthetic tracker); cal:false = screen pt.
 */
import type { CalibrateOptions, CalibrateResult, CameraPermission, GazeBatchEvent, GazeSample, GazeStatus, GazeStatusEvent, GazeTracker, HealthCode, Orientation, ScreenInfo, StartOptions, StartResult } from "@brianharness/core/ad-contracts";
import { FEATURES, featureVector, fitRidge, modelFromNumbers, modelToNumbers, predict, rawGuess, type FrameFeatures, type RidgeModel } from "./features";
import { FACE_MODEL, GAZE_BASE, type FromWorker, type ToWorker } from "./protocol";

/** what the Electron preload exposes as window.bhAdMac (ad-preload.cjs) */
export interface MacBridge {
  cameraPermission(): Promise<CameraPermission>;
  requestCamera(): Promise<CameraPermission>;
  screen(): Promise<ScreenInfo>;
  h1?(report: Record<string, unknown>): void;
  /** v1.3: requests that got past the gaze Worker's block (the shell cancelled them) */
  network?(): Promise<Array<{ url: string }>>;
}
export interface WorkerLike { postMessage(m: ToWorker, transfer?: Transferable[]): void; onmessage: ((e: { data: FromWorker }) => void) | null; terminate(): void }
export interface CameraLike {
  width: number; height: number;
  /** resolves with the next frame as a transferable bitmap, or null when the camera ended */
  next(): Promise<{ t: number; bitmap: ImageBitmap } | null>;
  stop(): void;
  onended?: (() => void) | null;
}
export interface MediaPipeTrackerDeps {
  bridge?: MacBridge | null;
  createWorker?: () => WorkerLike;
  openCamera?: () => Promise<CameraLike>;
  now?: () => number;
  /** bundle base, default GAZE_BASE resolved against the document */
  base?: string;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  initTimeoutMs?: number;
}
/** H1 numbers the tracker measures itself */
export interface TrackerStats { frames: number; faces: number; fps: number; fpsWindows: number[]; inferMsMean: number | null; modelMs: number | null; delegate: string | null; modelSha256: string | null; blocked: string[]; codes: HealthCode[]; errors: string[] }

type Feat = { t: number; f: FrameFeatures };
const RIDGE_LAMBDA = 1;

export class MediaPipeGazeTracker implements GazeTracker {
  private st: GazeStatus = { supported: true, unsupportedCode: null, permission: "prompt", state: "idle", pauseReason: null, tracker: "mediapipe", mode: null, hz: null, code: null };
  private gazeCbs = new Set<(e: GazeBatchEvent) => void>();
  private statusCbs = new Set<(e: GazeStatusEvent) => void>();
  private worker: WorkerLike | null = null;
  private cam: CameraLike | null = null;
  private model: RidgeModel | null = null;
  private feats: Feat[] = [];
  private batch: GazeSample[] = [];
  private seq = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private loopOn = false;
  private screenInfo: ScreenInfo | null = null;
  private cal: { orientation: Orientation; targets: Map<string, { x: number; y: number }>; fitIds: string[]; got: Map<string, number[][]> } | null = null;
  private stats: TrackerStats = { frames: 0, faces: 0, fps: 0, fpsWindows: [], inferMsMean: null, modelMs: null, delegate: null, modelSha256: null, blocked: [], codes: [], errors: [] };
  private fpsT0 = 0; private fpsN = 0; private inferSum = 0;
  constructor(private d: MediaPipeTrackerDeps = {}) {}
  private now() { return (this.d.now ?? (() => performance.now()))(); }
  private setStatus(p: Partial<GazeStatus>) {
    this.st = { ...this.st, ...p };
    if (p.code && !this.stats.codes.includes(p.code)) this.stats.codes.push(p.code);
    for (const cb of this.statusCbs) cb({ ...this.st });
  }
  getStats(): TrackerStats { return { ...this.stats, fpsWindows: [...this.stats.fpsWindows], blocked: [...this.stats.blocked], codes: [...this.stats.codes], errors: [...this.stats.errors] }; }
  async getStatus() { return { ...this.st }; }
  async requestPermission() {
    const p = this.d.bridge ? (this.st.permission === "prompt" ? await this.d.bridge.requestCamera() : await this.d.bridge.cameraPermission()) : "granted";
    this.setStatus({ permission: p });
    return { permission: p };
  }
  async getScreenInfo(): Promise<ScreenInfo> {
    if (this.d.bridge) this.screenInfo = await this.d.bridge.screen();
    return this.screenInfo ?? { deviceModel: "Mac", platform: "mac", orientation: "landscape_left", widthPt: globalThis.innerWidth ?? 1440, heightPt: globalThis.innerHeight ?? 900, scale: globalThis.devicePixelRatio ?? 2, webview: { x: 0, y: 0, width: globalThis.innerWidth ?? 1440, height: globalThis.innerHeight ?? 900 }, widthMm: null };
  }
  async start(opts: StartOptions): Promise<StartResult> {
    const screen = await this.getScreenInfo();
    if (opts.mode !== "camera") { this.setStatus({ state: "error", mode: opts.mode, code: "gaze.tracker_interrupted" }); throw new Error("MediaPipeGazeTracker: camera mode only (use SyntheticGazeTracker for synthetic)"); }
    this.setStatus({ state: "starting", mode: "camera", pauseReason: null, code: null });
    const perm = this.d.bridge ? await this.d.bridge.cameraPermission() : "granted";
    this.setStatus({ permission: perm });
    let p = perm;
    if (p === "prompt") p = (await this.requestPermission()).permission;
    if (p !== "granted") { this.setStatus({ state: "error", code: "gaze.camera_denied" }); return { status: { ...this.st }, screen }; }
    const ready = await this.initWorker();
    if (!ready) return { status: { ...this.st }, screen };
    try { this.cam = await (this.d.openCamera ?? openWebcam)(); }
    catch (e) {
      const denied = (e as { name?: string }).name === "NotAllowedError";
      this.noteError(`camera: ${(e as Error).name ?? ""} ${(e as Error).message ?? e}`);
      this.setStatus({ state: "error", code: denied ? "gaze.camera_denied" : "gaze.tracker_interrupted", ...(denied ? { permission: "denied" as const } : {}) });
      return { status: { ...this.st }, screen };
    }
    this.cam.onended = () => { this.loopOn = false; this.setStatus({ state: "paused", pauseReason: "interrupted", code: "gaze.tracker_interrupted", hz: null }); };
    this.fpsT0 = this.now(); this.fpsN = 0;
    this.setStatus({ state: "running", hz: Math.min(opts.maxHz ?? 30, 30) as 30 | 15 });
    this.flushTimer = (this.d.setInterval ?? setInterval)(() => this.flush(), 100);
    this.loopOn = true; void this.loop();
    return { status: { ...this.st }, screen };
  }
  private initWorker(): Promise<boolean> {
    if (this.worker && this.stats.modelSha256) return Promise.resolve(true);
    const w = (this.worker = (this.d.createWorker ?? defaultWorker)());
    const base = this.d.base ?? new URL(GAZE_BASE, globalThis.document?.baseURI ?? "http://localhost/").href;
    return new Promise<boolean>((resolve) => {
      const to = setTimeout(() => { fail("gaze.model_missing", "model load timed out"); }, this.d.initTimeoutMs ?? 30000);
      const fail = (code: HealthCode, detail: string) => { clearTimeout(to); this.noteError(`${code}: ${detail}`); this.setStatus({ state: "error", supported: code !== "gaze.model_missing" ? this.st.supported : false, unsupportedCode: code === "gaze.model_missing" ? code : this.st.unsupportedCode, code }); resolve(false); };
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") { clearTimeout(to); this.stats.modelMs = m.ms; this.stats.delegate = m.delegate; this.stats.modelSha256 = m.sha256; w.onmessage = (ev) => this.onWorker(ev.data); resolve(true); }
        else if (m.type === "error") fail(m.code, m.detail);
        else if (m.type === "blocked") this.noteBlocked(m.url);
      };
      w.postMessage({ type: "init", base, sha256: FACE_MODEL.sha256 });
    });
  }
  private noteError(e: string) { if (this.stats.errors.length < 20) this.stats.errors.push(e.slice(0, 300)); }
  private noteBlocked(url: string) { if (this.stats.blocked.length < 50) this.stats.blocked.push(url); }
  private onWorker(m: FromWorker) {
    if (m.type === "blocked") { this.noteBlocked(m.url); return; }
    if (m.type === "error") { this.inFlight = false; this.noteError(`${m.code}: ${m.detail}`); this.setStatus({ code: m.code }); return; }
    if (m.type !== "result") return;
    this.inFlight = false;
    this.stats.frames++; this.fpsN++; this.inferSum += m.ms;
    this.stats.inferMsMean = this.inferSum / this.stats.frames;
    const t = this.now();
    if (t - this.fpsT0 >= 1000) { this.stats.fps = (this.fpsN * 1000) / (t - this.fpsT0); this.stats.fpsWindows.push(Math.round(this.stats.fps * 10) / 10); if (this.stats.fpsWindows.length > 600) this.stats.fpsWindows.shift(); this.fpsT0 = t; this.fpsN = 0; }
    if (this.st.state === "paused") return;
    this.batch.push(this.sample(m.t, m.f));
    if (m.f) {
      this.stats.faces++;
      this.feats.push({ t: m.t, f: m.f });
      const cut = m.t - 15000; while (this.feats.length && this.feats[0]!.t < cut) this.feats.shift();
    }
  }
  private sample(t: number, f: FrameFeatures | null): GazeSample {
    if (!f) return { t, x: null, y: null, conf: 0, face: false, blink: false, cal: !!this.model, src: "mediapipe" };
    const head = { yaw: f.yaw, pitch: f.pitch, roll: f.roll, distCm: f.distCm };
    const base = { t, face: true, blink: f.blink, lids: { l: f.lidL, r: f.lidR }, head, src: "mediapipe" as const };
    if (f.blink) return { ...base, x: null, y: null, conf: 0, cal: !!this.model };
    const vp = this.screenInfo?.webview ?? { x: 0, y: 0, width: 1440, height: 900 };
    if (this.model) { const p = predict(this.model, featureVector(f)); return { ...base, x: p.x, y: p.y, conf: 0.8, cal: true }; }
    const g = rawGuess(f, { w: vp.width, h: vp.height });
    return { ...base, x: g.x + vp.x, y: g.y + vp.y, conf: 0.3, cal: false };
  }
  private async loop() {
    while (this.loopOn && this.cam) {
      const fr = await this.cam.next();
      if (!fr) break;
      if (!this.loopOn || this.inFlight || this.st.state === "paused") { fr.bitmap.close(); continue; }
      this.inFlight = true;
      this.worker!.postMessage({ type: "frame", t: fr.t, bitmap: fr.bitmap, width: this.cam.width, height: this.cam.height }, [fr.bitmap]);
    }
  }
  private flush() {
    if (!this.batch.length) return;
    const e: GazeBatchEvent = { seq: this.seq++, hz: this.st.hz ?? 30, samples: this.batch };
    this.batch = [];
    for (const cb of this.gazeCbs) cb(e);
  }
  /** test / H1 hook: deliver pending samples now */
  flushNow() { this.flush(); }
  async stop() {
    this.loopOn = false;
    this.cam?.stop(); this.cam = null;
    if (this.flushTimer) (this.d.clearInterval ?? clearInterval)(this.flushTimer);
    this.flushTimer = null;
    this.flush();
    this.worker?.postMessage({ type: "close" }); this.worker?.terminate(); this.worker = null; this.stats.modelSha256 = null;
    this.setStatus({ state: "stopped", hz: null });
    return { status: { ...this.st } };
  }
  async pause() { this.setStatus({ state: "paused", pauseReason: "user", hz: null }); return { status: { ...this.st } }; }
  async resume() { if (this.st.state === "paused" && this.cam) this.setStatus({ state: "running", pauseReason: null, hz: 30 }); return { status: { ...this.st } }; }
  async calibrate(o: CalibrateOptions): Promise<CalibrateResult> {
    const res = (p: CalibrateResult["phase"], ok: boolean, extra: Partial<CalibrateResult> = {}): CalibrateResult => ({ phase: p, ok, fit: null, model: null, samples: this.cal ? [...this.cal.got.values()].reduce((s, v) => s + v.length, 0) : 0, code: null, ...extra });
    if (o.phase === "begin") {
      this.cal = { orientation: o.orientation, targets: new Map(o.targets.map((t) => [t.id, { x: t.x, y: t.y }])), fitIds: o.targets.filter((t) => !t.id.startsWith("v")).map((t) => t.id), got: new Map() };
      this.model = null;
      if (this.st.state === "running") this.setStatus({ state: "calibrating" });
      return res("begin", true);
    }
    if (!this.cal) return res(o.phase, false, { code: "gaze.calibration_stale" });
    if (o.phase === "cancel") { this.cal = null; if (this.st.state === "calibrating") this.setStatus({ state: "running" }); return res("cancel", true); }
    if (o.phase === "target") {
      const fs = this.feats.filter((x) => x.t >= o.t0 && x.t <= o.t1 && !x.f.blink).map((x) => featureVector(x.f));
      if (this.cal.targets.has(o.targetId)) this.cal.got.set(o.targetId, fs);
      if (o.targetId === this.cal.fitIds[this.cal.fitIds.length - 1]) this.fit();
      return res("target", fs.length > 0);
    }
    // end
    const n = [...this.cal.got.values()].reduce((s, v) => s + v.length, 0);
    if (!this.model) this.fit();
    const out = this.model ? res("end", true, { fit: "native", model: modelToNumbers(this.model), samples: n }) : res("end", false, { fit: "native", samples: n, code: "gaze.low_quality" });
    this.cal = null;
    if (this.st.state === "calibrating") this.setStatus({ state: "running" });
    return out;
  }
  private fit() {
    if (!this.cal) return;
    const X: number[][] = [], tx: number[] = [], ty: number[] = [];
    let dots = 0;
    for (const id of this.cal.fitIds) {
      const fs = this.cal.got.get(id) ?? [];
      const tg = this.cal.targets.get(id)!;
      if (fs.length >= 3) dots++;
      for (const f of fs) { X.push(f); tx.push(tg.x); ty.push(tg.y); }
    }
    this.model = dots >= Math.min(4, this.cal.fitIds.length) ? fitRidge(X, tx, ty, RIDGE_LAMBDA) : null;
  }
  async restoreCalibration(o: { orientation: Orientation; model: number[] }) {
    const m = modelFromNumbers(o.model);
    if (!m || m.k !== FEATURES) return { ok: false };
    this.model = m;
    return { ok: true };
  }
  async syncClock(_o: { webNow: number }) { return { driftMs: 0 }; }
  addListener(event: "gaze", cb: (e: GazeBatchEvent) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: "status", cb: (e: GazeStatusEvent) => void): Promise<{ remove(): Promise<void> }>;
  async addListener(event: "gaze" | "status", cb: ((e: GazeBatchEvent) => void) | ((e: GazeStatusEvent) => void)) {
    const set = (event === "gaze" ? this.gazeCbs : this.statusCbs) as Set<typeof cb>;
    set.add(cb);
    return { remove: async () => { set.delete(cb); } };
  }
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("./gaze.worker.ts", import.meta.url), { type: "module", name: "bh-gaze" }) as unknown as WorkerLike;
}

/** the built-in camera at 640x480 / 30 fps; frames as ImageBitmaps (pixels stay in the renderer + worker) */
async function openWebcam(): Promise<CameraLike> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 }, facingMode: "user" } });
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  await video.play();
  const track = stream.getVideoTracks()[0]!;
  const cam: CameraLike = {
    width: video.videoWidth || 640, height: video.videoHeight || 480,
    next: () => new Promise((resolve) => {
      if (track.readyState === "ended") { resolve(null); return; }
      const grab = async () => { try { resolve({ t: performance.now(), bitmap: await createImageBitmap(video) }); } catch { resolve(null); } };
      if ("requestVideoFrameCallback" in video) (video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number }).requestVideoFrameCallback(() => void grab());
      else requestAnimationFrame(() => void grab());
    }),
    stop: () => { for (const t of stream.getTracks()) t.stop(); video.srcObject = null; },
    onended: null,
  };
  track.addEventListener("ended", () => cam.onended?.());
  return cam;
}
