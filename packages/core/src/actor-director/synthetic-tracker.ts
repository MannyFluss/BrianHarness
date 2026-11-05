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
  /** synthetic only: change the raw-point distortion (simulates the head moving mid-calibration) */
  setDistortion(A: [number, number, number, number, number, number]) { this.o = { ...this.o, distortion: A }; }
  /** synthetic only: where the simulated person looks during calibration (screen points) */
  lookAt(x: number, y: number) { this.look = { x, y }; }
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
        if (!s) { if (!this.loop) break; this.replayIdx = 0; this.replayT0 += span / this.speed; continue; }
        const t = this.replayT0 + s.t / this.speed;
        if (t > now) break;
        if (t > this.lastT) out.push({ ...s, t });
        this.replayIdx++;
      }
      this.lastT = now;
    } else this.lastT = now;
    if (out.length) { const e: GazeBatchEvent = { seq: this.seq++, hz: 30, samples: out }; for (const l of this.listeners) l(e); }
    return out;
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
