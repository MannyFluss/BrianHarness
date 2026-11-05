/**
 * E7 Mac gaze path: pure feature extraction + ridge calibration for the MediaPipe FaceLandmarker output.
 * Runs in the Web Worker (features) and the renderer (ridge). No DOM, no network, numbers only: no frame,
 * image or mesh ever leaves the worker (contract: gaze-plugin.ts privacy rule).
 *
 * Landmarks (478, refine/iris model), image coords normalized 0..1:
 *   subject's right eye (image left): corners 33 (outer) / 133 (inner), lids 159 / 145, iris centre 468
 *   subject's left eye (image right): corners 362 (inner) / 263 (outer), lids 386 / 374, iris centre 473
 * Iris position per eye = offset of the iris centre from the corner midpoint, in eye widths, along / across the
 * corner axis (left -> right in the image for both eyes, so the signs match).
 */
export interface Pt { x: number; y: number; z?: number }
export interface FrameFeatures {
  /** iris offsets (eye widths): r = subject's right eye, l = left */
  rx: number; ry: number; lx: number; ly: number;
  /** degrees; HeadPose convention (gaze.ts) */
  yaw: number; pitch: number; roll: number;
  /** cm, camera to face (MediaPipe canonical face units are cm) */
  distCm: number;
  /** face centre in the image, normalized -0.5..0.5 */
  fx: number; fy: number;
  /** per-eye closure 0..1 */
  lidL: number; lidR: number;
  blink: boolean;
}

export const LM = { rOuter: 33, rInner: 133, rUp: 159, rLow: 145, rIris: 468, lInner: 362, lOuter: 263, lUp: 386, lLow: 374, lIris: 473 } as const;
/** open-eye lid gap / eye width (single vertical pair) is about 0.28; both eyes under 0.12 = blink */
export const EAR_OPEN = 0.28, EAR_BLINK = 0.12;

function eye(lm: Pt[], a: number, b: number, up: number, low: number, iris: number, W: number, H: number) {
  const A = { x: lm[a]!.x * W, y: lm[a]!.y * H }, B = { x: lm[b]!.x * W, y: lm[b]!.y * H };
  const ux = B.x - A.x, uy = B.y - A.y;
  const w = Math.hypot(ux, uy) || 1;
  const u = { x: ux / w, y: uy / w }, n = { x: -u.y, y: u.x };
  const I = { x: lm[iris]!.x * W - (A.x + B.x) / 2, y: lm[iris]!.y * H - (A.y + B.y) / 2 };
  const gap = Math.hypot((lm[up]!.x - lm[low]!.x) * W, (lm[up]!.y - lm[low]!.y) * H) / w;
  return { gx: (I.x * u.x + I.y * u.y) / w, gy: (I.x * n.x + I.y * n.y) / w, ear: gap };
}

/** Euler angles (deg) + distance from MediaPipe's 4x4 column-major facial transformation matrix */
export function headPose(m: ArrayLike<number>): { yaw: number; pitch: number; roll: number; distCm: number } {
  const r20 = m[2]!, r21 = m[6]!, r22 = m[10]!, r10 = m[1]!, r00 = m[0]!;
  const deg = 180 / Math.PI;
  const yaw = Math.asin(Math.max(-1, Math.min(1, -r20))) * deg;
  const pitch = Math.atan2(r21, r22) * deg;
  const roll = Math.atan2(r10, r00) * deg;
  const distCm = Math.hypot(m[12]!, m[13]!, m[14]!);
  return { yaw, pitch, roll, distCm };
}

export function extractFeatures(lm: Pt[], frame: { width: number; height: number }, matrix?: ArrayLike<number> | null, blend?: { eyeBlinkLeft?: number; eyeBlinkRight?: number } | null): FrameFeatures | null {
  if (!lm || lm.length < 478) return null;
  const W = frame.width, H = frame.height;
  const r = eye(lm, LM.rOuter, LM.rInner, LM.rUp, LM.rLow, LM.rIris, W, H);
  const l = eye(lm, LM.lInner, LM.lOuter, LM.lUp, LM.lLow, LM.lIris, W, H);
  const clos = (ear: number) => Math.max(0, Math.min(1, 1 - ear / EAR_OPEN));
  const lidR = blend?.eyeBlinkRight ?? clos(r.ear), lidL = blend?.eyeBlinkLeft ?? clos(l.ear);
  const blink = blend && blend.eyeBlinkLeft !== undefined && blend.eyeBlinkRight !== undefined ? blend.eyeBlinkLeft > 0.5 && blend.eyeBlinkRight > 0.5 : r.ear < EAR_BLINK && l.ear < EAR_BLINK;
  const pose = matrix && matrix.length >= 16 ? headPose(matrix) : { yaw: 0, pitch: 0, roll: 0, distCm: 0 };
  const cx = (lm[LM.rOuter]!.x + lm[LM.lOuter]!.x) / 2 - 0.5, cy = (lm[LM.rOuter]!.y + lm[LM.lOuter]!.y) / 2 - 0.5;
  return { rx: r.gx, ry: r.gy, lx: l.gx, ly: l.gy, ...pose, fx: cx, fy: cy, lidL, lidR, blink };
}

/** the regression inputs (no bias); averaging the eyes would lose vergence, so both are kept */
export const featureVector = (f: FrameFeatures): number[] => [f.rx, f.ry, f.lx, f.ly, f.yaw, f.pitch, f.fx, f.fy];
export const FEATURES = 8;

/**
 * Ridge regression feature -> web CSS px (the calibration targets' space). Inputs standardized, bias unpenalized.
 * Model numbers (opaque to core, stored per orientation): [1, k, mean(k), sd(k), wx(k+1), wy(k+1)].
 */
export interface RidgeModel { k: number; mean: number[]; sd: number[]; wx: number[]; wy: number[] }
export function fitRidge(X: number[][], tx: number[], ty: number[], lambda = 1): RidgeModel | null {
  const n = X.length, k = X[0]?.length ?? 0;
  if (n < k + 2 || k === 0) return null;
  const mean = Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[j]!, 0) / n);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j]! - mean[j]!) ** 2, 0) / n) || 1);
  const Z = X.map((r) => [1, ...r.map((v, j) => (v - mean[j]!) / sd[j]!)]);
  const d = k + 1;
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => Z.reduce((s, r) => s + r[i]! * r[j]!, 0) + (i === j && i > 0 ? lambda : 0)));
  const solve = (t: number[]) => gauss(A.map((r) => [...r]), Array.from({ length: d }, (_, i) => Z.reduce((s, r, m) => s + r[i]! * t[m]!, 0)));
  const wx = solve(tx), wy = solve(ty);
  return wx && wy ? { k, mean, sd, wx, wy } : null;
}
function gauss(M: number[][], v: number[]): number[] | null {
  const n = v.length;
  const m = M.map((r, i) => [...r, v[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) if (r !== c) { const q = m[r]![c]! / m[c]![c]!; for (let j = c; j <= n; j++) m[r]![j]! -= q * m[c]![j]!; }
  }
  return m.map((r, i) => r[n]! / r[i]!);
}
export function predict(M: RidgeModel, x: number[]): { x: number; y: number } {
  const z = [1, ...x.map((v, j) => (v - M.mean[j]!) / M.sd[j]!)];
  return { x: z.reduce((s, v, i) => s + v * M.wx[i]!, 0), y: z.reduce((s, v, i) => s + v * M.wy[i]!, 0) };
}
export const modelToNumbers = (M: RidgeModel): number[] => [1, M.k, ...M.mean, ...M.sd, ...M.wx, ...M.wy];
export function modelFromNumbers(a: readonly number[]): RidgeModel | null {
  if (a[0] !== 1) return null;
  const k = a[1]!;
  if (!Number.isInteger(k) || k < 1 || a.length !== 2 + 2 * k + 2 * (k + 1) || a.some((v) => !Number.isFinite(v))) return null;
  let o = 2;
  const take = (len: number) => { const s = a.slice(o, o + len) as number[]; o += len; return s; };
  return { k, mean: take(k), sd: take(k), wx: take(k + 1), wy: take(k + 1) };
}
/**
 * before a fit: a rough geometric guess (iris offset ~ +-0.12 eye widths across the screen) so the calibration
 * screens have points at the dots (cal:false); never used for reading features once a model exists.
 */
export function rawGuess(f: FrameFeatures, vp: { w: number; h: number }): { x: number; y: number } {
  const gx = (f.rx + f.lx) / 2, gy = (f.ry + f.ly) / 2;
  return { x: vp.w / 2 - (gx / 0.12) * (vp.w / 2) - f.yaw * 12, y: vp.h / 2 + (gy / 0.08) * (vp.h / 2) - f.pitch * 12 };
}
