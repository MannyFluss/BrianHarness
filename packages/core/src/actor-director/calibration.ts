/**
 * E6: calibration, shared by the web screens (apps/desktop/src/ad/Calibration.tsx) and the iOS shell (I4).
 *
 * Spec: about 20 s; 5 dots on iPhone, 9 on iPad and Mac, then 4 validation dots. The result is reported in
 * paragraphs ("accurate to about 1 paragraph"). If the validation error is more than one paragraph height, offer to
 * recalibrate or to continue on on-screen time only. Saved per orientation (iPad Pro portrait and landscape keep
 * separate calibrations; iPad Pro 11 "iPad13,4" landscape is the primary). Recalibration is prompted when the head
 * turns more than 15° or the distance changes more than 25% (R1 calibCheck).
 *
 * fit "core" (iOS): the tracker emits uncalibrated screen points; core fits a 2-D affine here and applies it in L0
 * (`calibrateBatch`). fit "native" (Mac ridge): the tracker fits; core only stores its model numbers per
 * orientation and hands them back with restoreCalibration().
 * The calibration's median head distance becomes the stream's px/deg (ruling 3: `layoutFromScreen` + layoutPpd).
 */
import type { CalibrationTarget, Orientation, ScreenInfo } from "../ad-contracts/index.js";
import type { HealthCode } from "../ad-contracts/index.js";
import { calibCheck, layoutPpd, median, type Layout, type RawSample } from "./gaze-ref.js";
import type { AdStorage } from "./storage.js";

export type CalDevice = "phone" | "tablet" | "mac";
export function calDeviceOf(screen: Pick<ScreenInfo, "deviceModel" | "platform" | "widthPt">): CalDevice {
  if (/^iPhone/.test(screen.deviceModel)) return "phone";
  if (/^iPad/.test(screen.deviceModel)) return "tablet";
  if (screen.platform === "mac" || /^Mac/.test(screen.deviceModel)) return "mac";
  return screen.widthPt < 768 ? "phone" : "tablet";
}
export const isLandscape = (o: Orientation) => o === "landscape_left" || o === "landscape_right";
/** the orientation a device calibrates first: iPad landscape (primary for iPad13,4), iPhone portrait, Mac landscape */
export function primaryOrientation(deviceModel: string): Orientation {
  return /^iPhone/.test(deviceModel) ? "portrait" : "landscape_left";
}
/** the storage key groups landscape_left/right and portrait/upside-down? No: each orientation is its own geometry. */
export const calibrationKey = (deviceModel: string, orientation: Orientation) => `${deviceModel}/${orientation}`;

export const CAL_TIMING = Object.freeze({ dotMs: 1500, settleMs: 500, gapMs: 250 });

/** dot positions in web CSS px. Phone: center + 4 corners; tablet/Mac: 3x3 grid. Validation: 4 inner points. */
export function calibrationTargets(device: CalDevice, vp: { w: number; h: number }, inset = 0.1): { fit: CalibrationTarget[]; validate: CalibrationTarget[] } {
  const X = (f: number) => Math.round(vp.w * f), Y = (f: number) => Math.round(vp.h * f);
  const lo = inset, hi = 1 - inset;
  const fit: CalibrationTarget[] = device === "phone"
    ? [[0.5, 0.5], [lo, lo], [hi, lo], [lo, hi], [hi, hi]].map(([fx, fy], i) => ({ id: `c${i + 1}`, x: X(fx!), y: Y(fy!) }))
    : [lo, 0.5, hi].flatMap((fy) => [lo, 0.5, hi].map((fx) => [fx, fy])).map(([fx, fy], i) => ({ id: `c${i + 1}`, x: X(fx!), y: Y(fy!) }));
  const validate = [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]].map(([fx, fy], i) => ({ id: `v${i + 1}`, x: X(fx!), y: Y(fy!) }));
  return { fit, validate };
}

/** affine [a,b,c,d,e,f]: x' = a x + b y + c, y' = d x + e y + f */
export type Affine = [number, number, number, number, number, number];
export const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];
export const applyAffine = (A: Affine, x: number, y: number) => ({ x: A[0] * x + A[1] * y + A[2], y: A[3] * x + A[4] * y + A[5] });
function solve3(M: number[][], v: number[]): number[] | null {
  const m = M.map((r, i) => [...r, v[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-9) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < 3; r++) if (r !== c) { const k = m[r]![c]! / m[c]![c]!; for (let j = c; j < 4; j++) m[r]![j]! -= k * m[c]![j]!; }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}
/** least-squares affine raw -> target over per-target medians; translation-only when the points are degenerate */
export function fitAffine(pairs: Array<{ raw: { x: number; y: number }; target: { x: number; y: number } }>): Affine | null {
  if (!pairs.length) return null;
  if (pairs.length >= 3) {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    for (const { raw, target } of pairs) {
      const r = [raw.x, raw.y, 1];
      for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) S[i]![j]! += r[i]! * r[j]!; bx[i]! += r[i]! * target.x; by[i]! += r[i]! * target.y; }
    }
    const px = solve3(S, bx), py = solve3(S, by);
    if (px && py) return [px[0]!, px[1]!, px[2]!, py[0]!, py[1]!, py[2]!];
  }
  const dx = median(pairs.map((p) => p.target.x - p.raw.x)), dy = median(pairs.map((p) => p.target.y - p.raw.y));
  return [1, 0, dx, 0, 1, dy];
}

/** layout for px/deg from the plugin's ScreenInfo (CSS px = points in the webview) */
export function layoutFromScreen(screen: ScreenInfo): Layout {
  const dev = calDeviceOf(screen);
  const fallbackPpcm = dev === "phone" ? 60.37 : dev === "tablet" ? 51.97 : 44.0;
  return {
    name: `${screen.deviceModel}-${screen.orientation}`, viewport_w: screen.webview.width, viewport_h: screen.webview.height,
    css_px_per_cm: screen.widthMm ? screen.widthPt / (screen.widthMm / 10) : fallbackPpcm,
    default_dist_cm: dev === "phone" ? 30 : dev === "tablet" ? 50 : 55,
  };
}

export interface CalibrationRecord {
  v: 1;
  deviceModel: string;
  orientation: Orientation;
  fit: "core" | "native";
  /** fit core: raw screen pt -> web CSS px */
  affine: Affine | null;
  /** fit native: the tracker's opaque model numbers for restoreCalibration */
  model: number[] | null;
  /** median head distance during calibration (cm); drives px/deg */
  distCm: number | null;
  yaw: number | null;
  errPx: number | null;
  errDeg: number | null;
  errParas: number | null;
  /** gaze = paragraph-level claims allowed; onscreen_only = the person chose to continue without gaze (or error > 1 paragraph) */
  mode: "gaze" | "onscreen_only";
  /** wall clock ms (Date.now()) and gaze-clock ms at the end */
  at: number;
  t: number;
}

/** words for the result screen and the tab's status line */
export function accuracyWords(errParas: number | null): string {
  if (errParas === null) return "accuracy unknown (no validation data)";
  if (errParas <= 0.5) return "accurate to under half a paragraph";
  if (errParas <= 1.25) return "accurate to about 1 paragraph";
  return `accurate to about ${Math.round(errParas * 2) / 2} paragraphs`;
}

/** samples with a face, inside a window */
type Win = { t0: number; t1: number };
const inWin = (s: RawSample, w: Win) => s.t >= w.t0 && s.t <= w.t1 && s.face !== false && s.x !== null && s.y !== null && !s.blink;

/**
 * One calibration pass. The screens call show(target, t) for each dot (the settled window is
 * [t + settleMs, t + dotMs]) and push every gaze batch they receive; finish() fits on the fit dots and
 * validates on the validation dots.
 */
export class CalibrationRun {
  readonly device: CalDevice;
  readonly targets: { fit: CalibrationTarget[]; validate: CalibrationTarget[] };
  private samples: RawSample[] = [];
  private windows = new Map<string, Win>();
  constructor(readonly o: { screen: ScreenInfo; orientation?: Orientation; fit?: "core" | "native"; paraHeightPx: number; timing?: Partial<typeof CAL_TIMING> }) {
    this.device = calDeviceOf(o.screen);
    this.targets = calibrationTargets(this.device, { w: o.screen.webview.width, h: o.screen.webview.height });
  }
  get timing() { return { ...CAL_TIMING, ...(this.o.timing ?? {}) }; }
  get orientation(): Orientation { return this.o.orientation ?? this.o.screen.orientation; }
  /** every dot in order: fit dots, then validation dots */
  get sequence(): CalibrationTarget[] { return [...this.targets.fit, ...this.targets.validate]; }
  /** the dot appeared at t (gaze clock); returns the settled window to hand to calibrate({phase:"target"}) */
  show(targetId: string, t: number): Win {
    const w = { t0: t + this.timing.settleMs, t1: t + this.timing.dotMs };
    this.windows.set(targetId, w);
    return w;
  }
  push(batch: RawSample[]): void { for (const s of batch) this.samples.push(s); }
  samplesIn(targetId: string): RawSample[] { const w = this.windows.get(targetId); return w ? this.samples.filter((s) => inWin(s, w)) : []; }
  /** screen points -> web CSS px (the webview origin) */
  private toCss(s: { x: number; y: number }) { return { x: s.x - this.o.screen.webview.x, y: s.y - this.o.screen.webview.y }; }

  finish(now: { t: number; at: number }, native?: { model: number[] | null }): { record: CalibrationRecord; ok: boolean; words: string; recommend: "use" | "recalibrate_or_onscreen"; code: HealthCode | null } {
    const fitBy = this.o.fit ?? "core";
    const pairs = this.targets.fit.map((tg) => {
      const ss = this.samplesIn(tg.id);
      return ss.length ? { raw: this.toCss({ x: median(ss.map((s) => s.x!)), y: median(ss.map((s) => s.y!)) }), target: tg } : null;
    }).filter((p): p is NonNullable<typeof p> => p !== null);
    const affine = fitBy === "core" ? fitAffine(pairs) : null;
    const used = [...this.windows.keys()].flatMap((id) => this.samplesIn(id));
    const dists = used.map((s) => s.head?.distCm).filter((d): d is number => typeof d === "number" && d > 0);
    const yaws = used.map((s) => s.head?.yaw).filter((d): d is number => typeof d === "number");
    const distCm = dists.length ? median(dists) : null;
    const layout = layoutFromScreen(this.o.screen);
    const ppd = layoutPpd(layout, distCm);
    const map = (s: RawSample) => { const p = this.toCss({ x: s.x!, y: s.y! }); return affine ? applyAffine(affine, p.x, p.y) : p; };
    const validation = this.targets.validate.map((tg) => ({ target: tg, samples: this.samplesIn(tg.id).map(map) }));
    const cc = calibCheck(validation, ppd, this.o.paraHeightPx, { yaw: 0, distCm: distCm ?? 0, orientation: this.orientation, t: now.t }, { yaw: 0, distCm: distCm ?? 0, orientation: this.orientation, t: now.t });
    const errPx = cc.errDeg === null ? null : cc.errDeg * ppd;
    const enough = pairs.length >= Math.min(3, this.targets.fit.length) && (fitBy === "native" || affine !== null);
    const good = enough && cc.errParas !== null && cc.errParas <= 1;
    const record: CalibrationRecord = {
      v: 1, deviceModel: this.o.screen.deviceModel, orientation: this.orientation, fit: fitBy, affine, model: native?.model ?? null,
      distCm, yaw: yaws.length ? median(yaws) : null, errPx, errDeg: cc.errDeg, errParas: cc.errParas, mode: good ? "gaze" : "onscreen_only", at: now.at, t: now.t,
    };
    return { record, ok: enough, words: enough ? accuracyWords(cc.errParas) : "not enough gaze data at the dots", recommend: good ? "use" : "recalibrate_or_onscreen", code: enough ? null : "gaze.low_quality" };
  }
}

/** apply a fit-core record to a tracker batch (screen pt -> web CSS px, cal:true); native/cal samples pass through */
export function calibrateBatch<S extends { x: number | null; y: number | null; cal?: boolean }>(batch: S[], rec: CalibrationRecord | null, webview: { x: number; y: number }): S[] {
  return batch.map((s) => {
    if (s.x === null || s.y === null || s.cal) return s;
    const p = { x: s.x - webview.x, y: s.y - webview.y };
    const q = rec?.affine ? applyAffine(rec.affine, p.x, p.y) : p;
    return { ...s, x: q.x, y: q.y, cal: !!rec?.affine };
  });
}

/** recalibration prompt: head turned > 15°, distance changed > 25%, or a different orientation (R1 calibCheck) */
export function calibrationStatus(rec: CalibrationRecord | null, now: { yaw: number; distCm: number; orientation: Orientation; t: number }): { stale: boolean; code: HealthCode | null; words: string; reasons: string[] } {
  if (!rec) return { stale: true, code: "gaze.calibration_stale", words: "Not calibrated for this orientation yet", reasons: ["none"] };
  const cc = calibCheck([{ target: { x: 0, y: 0 }, samples: [{ x: 0, y: 0 }] }], 1, 1, { yaw: rec.yaw ?? now.yaw, distCm: rec.distCm ?? 0, orientation: rec.orientation, t: rec.t }, now);
  const reasons = cc.reasons;
  if (!reasons.length) return { stale: false, code: null, words: accuracyWords(rec.errParas), reasons };
  const words = reasons.includes("orientation") ? "Recalibrate (different orientation)"
    : reasons.includes("yaw") ? `Recalibrate (head moved ${Math.round(Math.abs(now.yaw - (rec.yaw ?? 0)))}° since calibration)`
    : `Recalibrate (distance changed ${Math.round((Math.abs(now.distCm - (rec.distCm ?? 0)) / (rec.distCm || 1)) * 100)}%)`;
  return { stale: true, code: "gaze.calibration_stale", words, reasons };
}

/** per-orientation store in the actor-director storage (key ad/cal/<deviceModel>/<orientation>) */
export class CalibrationStore {
  constructor(private storage: AdStorage) {}
  save(rec: CalibrationRecord): void { this.storage.setMeta(`cal/${calibrationKey(rec.deviceModel, rec.orientation)}`, JSON.stringify(rec)); }
  load(deviceModel: string, orientation: Orientation): CalibrationRecord | null {
    const v = this.storage.getMeta(`cal/${calibrationKey(deviceModel, orientation)}`);
    if (!v) return null;
    try { const r = JSON.parse(v) as CalibrationRecord; return r.v === 1 ? r : null; } catch { return null; }
  }
  orientations(deviceModel: string): Orientation[] {
    return this.storage.metaKeys(`cal/${deviceModel}/`).map((k) => k.split("/").pop() as Orientation);
  }
  clear(deviceModel: string, orientation: Orientation): void { this.storage.removeMeta(`cal/${calibrationKey(deviceModel, orientation)}`); }
}

/** GazeSource/GazeStream options from the screen and this orientation's calibration (distance -> px/deg) */
export function gazeOptionsFromCalibration(screen: ScreenInfo, rec: CalibrationRecord | null): { ppd: number; viewport: { w: number; h: number }; distCm: number | null } {
  const layout = layoutFromScreen(screen);
  const distCm = rec && rec.orientation === screen.orientation ? rec.distCm : null;
  return { ppd: layoutPpd(layout, distCm), viewport: { w: screen.webview.width, h: screen.webview.height }, distCm };
}
