/**
 * E6: a web-side GazeTracker (contract gaze-plugin.ts) for the browser/Mac dev build, the screenshot harness and
 * the I4 simulator smoke test. It never touches a camera.
 *  - synthetic mode: replays GazeSample[] (e.g. an R2 replay) re-timed to the web clock, in ~100 ms batches.
 *  - calibration: between calibrate({phase:"begin"}) and "end" it emits UNCALIBRATED (cal:false) samples around
 *    the point set with lookAt(x, y) (the screens call it when they show a dot), through a fixed distortion, so
 *    core's fit "core" path is exercised end to end.
 * Drive it with pump(now) (tests) or startTimer() (browser).
 */
import type {
  CalibrateOptions, CalibrateResult, GazeBatchEvent, GazeSample, GazeStatus, GazeTracker, Orientation, ScreenInfo, StartOptions, StartResult,
} from "../ad-contracts/index.js";

export interface SyntheticTrackerOptions {
  screen: ScreenInfo;
  /** raw = A * true + b while calibrating (screen points); default: 6% scale, +24/-30 pt offset */
  distortion?: [number, number, number, number, number, number];
  noisePt?: number;
  distCm?: number;
  seed?: number;
  now?: () => number;
}

export class SyntheticGazeTracker implements GazeTracker {
  private listeners = new Set<(e: GazeBatchEvent) => void>();
  private statusListeners = new Set<(e: GazeStatus) => void>();
  private status: GazeStatus = { supported: true, unsupportedCode: null, permission: "granted", state: "idle", pauseReason: null, tracker: null, mode: null, hz: null, code: null };
  private replay: GazeSample[] = [];
  private replayIdx = 0;
  private replayT0 = 0;
  private loop = true;
  private speed = 1;
  private lastT = 0;
  private seq = 0;
  private calibrating = false;
  private look: { x: number; y: number } | null = null;
  private calSamples = 0;
  private windows: Array<{ t0: number; t1: number }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private hold: { x: number; y: number } | null = null;
  private rnd: () => number;
  constructor(private o: SyntheticTrackerOptions) {
    let s = o.seed ?? 7;
    this.rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  }
  private now() { return (this.o.now ?? (() => performance.now()))(); }
  private setState(p: Partial<GazeStatus>) { this.status = { ...this.status, ...p }; for (const l of this.statusListeners) l(this.status); }
  async getStatus() { return this.status; }
  async requestPermission() { return { permission: "granted" as const }; }
  async getScreenInfo() { return this.o.screen; }
  async start(opts: StartOptions): Promise<StartResult> {
    const src = opts.synthetic;
    this.replay = (src?.samples ?? []).filter((s) => Number.isFinite(s.t));
    const first = this.replay[0]?.t ?? 0;
    this.replay = this.replay.map((s) => ({ ...s, t: s.t - first }));
    this.loop = src?.loop ?? true; this.speed = src?.speed ?? 1;
    this.replayIdx = 0; this.replayT0 = opts.webNow; this.lastT = opts.webNow;
    this.setState({ state: "running", mode: "synthetic", hz: 30, pauseReason: null });
    return { status: this.status, screen: this.o.screen };
  }
  async stop() { this.stopTimer(); this.setState({ state: "stopped", hz: null }); return { status: this.status }; }
  async pause() { this.setState({ state: "paused", pauseReason: "user", hz: null }); return { status: this.status }; }
  async resume() { this.setState({ state: "running", pauseReason: null, hz: 30 }); this.lastT = this.now(); return { status: this.status }; }
  /**
   * synthetic only (demo): replace the replay with `samples` (t relative, first = 0) starting at webNow, played once;
   * afterwards the simulated person rests their eyes at `hold` (e.g. the composer) until the next play().
   */
  play(samples: GazeSample[], webNow: number, opts: { hold?: { x: number; y: number } | null } = {}) {
    const first = samples[0]?.t ?? 0;
    this.replay = samples.map((s) => ({ ...s, t: s.t - first }));
    this.replayIdx = 0; this.replayT0 = webNow; this.loop = false; this.speed = 1;
    this.lastT = Math.max(this.lastT, webNow - 1);
    this.hold = opts.hold ?? null;
  }
  /** synthetic only: change the raw-point distortion (simulates the head moving mid-calibration) */
  setDistortion(A: [number, number, number, number, number, number]) { this.o = { ...this.o, distortion: A }; }
  /** synthetic only: where the simulated person looks during calibration (screen points) */
  simLook(x: number, y: number) { this.look = { x, y }; }
  /** GazeTracker.lookAt (contract-v1.4: one options object) for callers that hold the interface (same as simLook) */
  lookAt(opts: { x: number; y: number }) { this.simLook(opts.x, opts.y); }
  /** synthetic only: the head distance every later sample reports (the demo matches the calibration's distCm) */
  setDistCm(distCm: number) { if (distCm > 0) this.o = { ...this.o, distCm }; }
  async calibrate(opts: CalibrateOptions): Promise<CalibrateResult> {
    const base = { phase: opts.phase, ok: true, fit: null, model: null, samples: this.calSamples, code: null } as CalibrateResult;
    if (opts.phase === "begin") { this.calibrating = true; this.calSamples = 0; this.windows = []; this.setState({ state: "calibrating" }); return { ...base, samples: 0 }; }
    if (opts.phase === "target") { this.windows.push({ t0: opts.t0, t1: opts.t1 }); return base; }
    this.calibrating = false; this.look = null;
    this.setState({ state: "running" });
    return opts.phase === "end" ? { ...base, fit: "core" } : { ...base, ok: true };
  }
  async restoreCalibration(_o: { orientation: Orientation; model: number[] }) { return { ok: true }; }
  async syncClock(_o: { webNow: number }) { return { driftMs: 0 }; }
  addListener(event: "gaze", cb: (e: GazeBatchEvent) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: "status", cb: (e: GazeStatus) => void): Promise<{ remove(): Promise<void> }>;
  async addListener(event: "gaze" | "status", cb: ((e: GazeBatchEvent) => void) | ((e: GazeStatus) => void)) {
    const set = (event === "gaze" ? this.listeners : this.statusListeners) as Set<unknown>;
    set.add(cb);
    return { remove: async () => { set.delete(cb); } };
  }
  startTimer(ms = 100) { this.stopTimer(); this.timer = setInterval(() => this.pump(this.now()), ms); }
  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** emit every sample due in (lastT, now] */
  pump(now: number): GazeSample[] {
    if (this.status.state !== "running" && this.status.state !== "calibrating") { this.lastT = now; return []; }
    const out: GazeSample[] = [];
    if (this.calibrating) {
      for (let t = this.lastT + 1000 / 30; t <= now; t += 1000 / 30) out.push(this.calSample(t));
      if (out.length) this.lastT = out[out.length - 1]!.t;
    } else if (this.replay.length) {
      const span = this.replay[this.replay.length - 1]!.t + 1000 / 30;
      for (;;) {
        const s = this.replay[this.replayIdx];
        if (!s) {
          if (!this.loop) {
            const h = this.hold;
            if (h) { const end = this.replayT0 + span; for (let t = Math.max(this.lastT, end) + 1000 / 30; t <= now; t += 1000 / 30) out.push(this.holdSample(t, h)); }
            break;
          }
          this.replayIdx = 0; this.replayT0 += span / this.speed; continue;
        }
        const t = this.replayT0 + s.t / this.speed;
        if (t > now) break;
        if (t > this.lastT) out.push({ ...s, t });
        this.replayIdx++;
      }
      this.lastT = out.length ? Math.max(now, out[out.length - 1]!.t) : now;
    } else this.lastT = now;
    if (out.length) { const e: GazeBatchEvent = { seq: this.seq++, hz: 30, samples: out }; for (const l of this.listeners) l(e); }
    return out;
  }
  private holdSample(t: number, p: { x: number; y: number }): GazeSample {
    const n = () => (this.rnd() - 0.5) * 4;
    return { t, x: p.x + n(), y: p.y + n(), conf: 0.9, face: true, blink: false, head: { yaw: 2, pitch: 1, roll: 0, distCm: this.o.distCm ?? 42 }, cal: true, src: "synthetic" };
  }
  private calSample(t: number): GazeSample {
    const A = this.o.distortion ?? [1.06, 0, 24, 0, 1.06, -30];
    const noise = this.o.noisePt ?? 6;
    const g = () => (this.rnd() + this.rnd() + this.rnd() - 1.5) * noise;
    const p = this.look;
    if (p && this.windows.some((w) => t >= w.t0 && t <= w.t1)) this.calSamples++;
    const head = { yaw: 2, pitch: 1, roll: 0, distCm: this.o.distCm ?? 42 };
    if (!p) return { t, x: null, y: null, conf: 0, face: true, blink: false, head, cal: false, src: "synthetic" };
    return { t, x: A[0] * p.x + A[1] * p.y + A[2] + g(), y: A[3] * p.x + A[4] * p.y + A[5] + g(), conf: 0.9, face: true, blink: false, head, cal: false, src: "synthetic" };
  }
}

/**
 * contract-v1.3 (ruling B2): the calibration "look here" aid for the JS SyntheticGazeTracker ONLY, or undefined.
 * It never calls a native plugin's lookAt: a device build has no path to it. The iOS-simulator plugin's lookAt is
 * reachable only from a simulator build (apps/desktop/src/ad/sim-look.ts behind __BH_AD_SIM__ / AD_SIM_BUILD=1).
 */
export function simLookAt(tracker: GazeTracker | null | undefined): ((x: number, y: number) => void) | undefined {
  if (!(tracker instanceof SyntheticGazeTracker)) return undefined;
  return (x, y) => tracker.simLook(x, y);
}

export type DemoReadStyle = "deep" | "read" | "skim" | "skip";
/**
 * demo gaze generated from the app's REAL paragraph boxes (IOS Dev I4: R2 replay points do not land on the app's
 * layout, so every paragraph read as skipped). A person reading each box line by line, left to right, ~250 ms
 * fixations at `wpm` (default 238, R1 prior) times the style factor (deep 2.7 with one look-back, read 1, skim 0.25,
 * skip 0). Calibrated (cal:true) screen-point samples at 30 Hz in the boxes' coordinates (viewport CSS px = webview
 * pt on web). Default styles cycle deep, skim, skip, read, so the demo tab shows each label.
 */
export function demoReadingPath(boxes: Array<{ x: number; y: number; w: number; h: number; words: number; line_h?: number }>, o: { styles?: DemoReadStyle[]; wpm?: number; seed?: number; distCm?: number } = {}): GazeSample[] {
  const styles = o.styles ?? ["deep", "skim", "skip", "read"];
  const factor: Record<DemoReadStyle, number> = { deep: 2.7, read: 1, skim: 0.25, skip: 0 };
  const wpm = o.wpm ?? 238;
  let s = o.seed ?? 11;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  const head = { yaw: 2, pitch: 1, roll: 0, distCm: o.distCm ?? 42 };
  const out: GazeSample[] = [];
  let t = 0;
  const fix = (x: number, y: number, ms: number) => {
    for (const end = t + ms; t < end; t += 1000 / 30) out.push({ t, x: x + rnd() * 6, y: y + rnd() * 6, conf: 0.9, face: true, blink: false, head, cal: true, src: "synthetic" });
  };
  const readBox = (b: (typeof boxes)[number], ms: number) => {
    const lh = b.line_h ?? Math.max(16, Math.min(32, b.h / Math.max(1, Math.ceil(b.words / 9))));
    const lines = Math.max(1, Math.round(b.h / lh));
    const perLine = ms / lines;
    for (let l = 0; l < lines; l++) {
      const n = Math.max(1, Math.round(perLine / 250));
      for (let k = 0; k < n; k++) fix(b.x + b.w * (0.08 + 0.84 * (n === 1 ? 0.5 : k / (n - 1))), b.y + (l + 0.5) * (b.h / lines), perLine / n);
    }
  };
  boxes.forEach((b, i) => {
    const st = styles[i % styles.length]!;
    const ms = (b.words / wpm) * 60000 * factor[st];
    if (ms <= 0) return;
    if (st === "deep") {
      readBox(b, ms * 0.6);
      if (i > 0) fix(boxes[i - 1]!.x + boxes[i - 1]!.w / 2, boxes[i - 1]!.y + boxes[i - 1]!.h / 2, 300); // a look outside, then back
      readBox(b, ms * 0.25);
      if (i > 0) fix(boxes[i - 1]!.x + boxes[i - 1]!.w / 2, boxes[i - 1]!.y + boxes[i - 1]!.h / 2, 300);
      readBox(b, ms * 0.15);
    } else readBox(b, ms);
  });
  return out;
}
