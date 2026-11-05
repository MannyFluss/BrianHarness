/**
 * E5: R1's gaze feature reference (research/R1/reference.py), ported line for line to TypeScript.
 * L0 clean / drift / median smooth, L1 I-DT fixations + merge + saccades, L2 AOI dwell, L3 events, L4 digest,
 * and the contract-v1 gaze_l1 log batches. It must reproduce all 56 R1 testcases (ad-e5.test.ts).
 *
 * This file is the BATCH form (one turn of samples at a time). gaze-stream.ts is the streaming L0/L1 port that
 * carries state across ~100 ms sample batches and feeds the same L2-L4 code (turnFromL1) at window close, so a
 * streamed turn equals the batch turn exactly.
 *
 * Python semantics kept on purpose: round() is round-half-even on the exact binary value (pyRound), float
 * floor division follows CPython (pyFloorDiv), sorts are stable with tuple keys, dict defaults match .get().
 * Units: t in ms, positions in CSS px of the viewport, angles in degrees.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GazeConfig {
  hz: number; conf_min: number; gap_fill_max_ms: number; spike_deg_s: number; offscreen_margin_deg: number; contig_factor: number;
  median_window: number; idt_disp_deg: number; idt_min_ms: number; merge_gap_ms: number; merge_deg: number; blink_bridge_ms: number;
  aoi_snap_deg: number; quality_min: number; face_frac_min: number; quality_good: number; recal_yaw_deg: number; recal_dist_frac: number;
  drift_pre_ms: number; drift_alpha: number;
  /** PROVISIONAL (Researcher, Nov 4): composer-tap drift correction caps. Config, not constants: total bias cap (deg) */
  drift_max_deg: number;
  /** PROVISIONAL: an anchor whose offset (vs the current bias) is >= this many degrees is rejected */
  drift_reject_deg: number;
  prior_wpm: number; baseline_min: number; baseline_max: number; baseline_min_words: number; mad_k: number; mad_floor: number;
  deep_z: number; deep_ratio_prebase: number; skip_ratio: number; scan_ratio: number; visible_frac: number; reread_reentries: number;
  lookback_ms: number; offscreen_ms: number; pause_ms: number; idle_close_ms: number; max_events: number; prebase_maturity: number;
  excerpt_words: number; l1_window_ms: number; l1_max_fix: number; l1_max_sacc: number; l1_max_gaps: number;
}

/** R1 DEFAULTS (reference.py), every value cited or flagged as judgment in R1/FEATURES.md */
export const GAZE_DEFAULTS: Readonly<GazeConfig> = Object.freeze({
  hz: 30.0, conf_min: 0.3, gap_fill_max_ms: 150.0, spike_deg_s: 1000.0, offscreen_margin_deg: 2.0, contig_factor: 1.5,
  median_window: 3, idt_disp_deg: 1.5, idt_min_ms: 100.0, merge_gap_ms: 75.0, merge_deg: 1.0, blink_bridge_ms: 500.0,
  aoi_snap_deg: 1.0, quality_min: 0.6, face_frac_min: 0.7, quality_good: 0.8, recal_yaw_deg: 15.0, recal_dist_frac: 0.25,
  drift_pre_ms: 250.0, drift_alpha: 0.5, drift_max_deg: 3.0, drift_reject_deg: 4.0,
  prior_wpm: 238.0, baseline_min: 20, baseline_max: 50, baseline_min_words: 5, mad_k: 1.4826, mad_floor: 0.05,
  deep_z: 1.5, deep_ratio_prebase: 2.0, skip_ratio: 0.15, scan_ratio: 0.40, visible_frac: 0.5, reread_reentries: 2,
  lookback_ms: 1500.0, offscreen_ms: 5000.0, pause_ms: 2000.0, idle_close_ms: 8000.0, max_events: 12, prebase_maturity: 0.5,
  excerpt_words: 8, l1_window_ms: 5000.0, l1_max_fix: 20, l1_max_sacc: 10, l1_max_gaps: 10,
});

export const cfg = (over?: Partial<GazeConfig> | null): GazeConfig => ({ ...GAZE_DEFAULTS, ...(over ?? {}) });

// ---------------------------------------------------------------------------------------------------------------
// Python numeric helpers
// ---------------------------------------------------------------------------------------------------------------
/** Python round(x, nd): correctly rounded, ties to even, decided on the exact binary value. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(100);
  const dot = s.indexOf(".");
  const ip = s.slice(0, dot), fp = s.slice(dot + 1);
  const keep = ip + fp.slice(0, nd);
  const rest = fp.slice(nd);
  let up: boolean;
  if (rest[0]! > "5") up = true;
  else if (rest[0]! < "5") up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = (Number(keep[keep.length - 1]) % 2) === 1;
  let digits = BigInt(keep);
  if (up) digits += 1n;
  let str = digits.toString();
  if (nd > 0) {
    str = str.padStart(nd + 1, "0");
    str = str.slice(0, str.length - nd) + "." + str.slice(str.length - nd);
  }
  const v = Number(str);
  return neg ? -v : v;
}
/** CPython float // */
export function pyFloorDiv(vx: number, wx: number): number {
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod) {
    if ((wx < 0) !== (mod < 0)) { mod += wx; div -= 1.0; }
  }
  let floordiv: number;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else floordiv = Math.sign(vx / wx) < 0 || Object.is(vx / wx, -0) ? -0 : 0;
  return floordiv;
}
const pyInt = (x: number) => Math.trunc(x);

/** reference.r6: round floats to 6 places, NaN/inf -> null, recursively */
export function r6(v: any): any {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return v;
    return pyRound(v, 6) + 0.0;
  }
  if (Array.isArray(v)) return v.map(r6);
  if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = r6(v[k]); return o; }
  return v;
}

export function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) throw new Error("median of empty list");
  const m = Math.floor(n / 2);
  return n % 2 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!);
}
const tupleCmp = (a: Array<number | string>, b: Array<number | string>): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!, y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
};
const sortBy = <T>(xs: T[], key: (x: T) => Array<number | string>): T[] => [...xs].sort((a, b) => tupleCmp(key(a), key(b)));

// ---------------------------------------------------------------------------------------------------------------
// types (shapes of R1's dicts)
// ---------------------------------------------------------------------------------------------------------------
export interface RawSample { t: number; x: number | null; y: number | null; conf?: number; face?: boolean; blink?: boolean; head?: { distCm?: number; yaw?: number } | undefined; [k: string]: any }
export interface CleanSample { t: number; x: number; y: number; interp: boolean }
export interface Gap { t0: number; t1: number; kind: "blink" | "noface" | "offscreen" | "lowconf" }
export interface Fix { id?: string; t0: number; t1: number; x: number; y: number; dispPx: number; n: number; _s: CleanSample[]; aoi?: string | null }
export interface Aoi { id: string; msg: string; order: number; x: number; y: number; w: number; h: number; words: number; text?: string; line_h?: number; complete_t?: number; visible?: Array<[number, number]>;
  /** contract-v1.3 (not in the R1 reference; absent = 1): the share of this paragraph's window time that was NOT under a
   * tab_occluded span. The expected reading time uses words x expect_frac, so time under the sheet is
   * not demanded of the reader (skip / skim / visible_frac); deep_read still uses the full expectation. Live controller only. */
  expect_frac?: number }
export interface Anchor { t: number; x: number; y: number; kind?: string }
export interface Viewport { w: number; h: number }
export interface Layout { viewport_w: number; viewport_h: number; css_px_per_cm: number; default_dist_cm: number; min_dist_cm?: number; max_dist_cm?: number; name?: string }
export type Kind = "ok" | "blink" | "noface" | "lowconf" | "offscreen" | "spike";

// ---------------------------------------------------------------------------------------------------------------
// F-GEO-PPD
// ---------------------------------------------------------------------------------------------------------------
export const pxPerDeg = (pxPerCm: number, distCm: number) => 2.0 * distCm * Math.tan((0.5 * Math.PI) / 180) * pxPerCm;
export function layoutPpd(layout: Layout, distCm?: number | null): number {
  let d = distCm ? distCm : layout.default_dist_cm;
  d = Math.min(Math.max(d, layout.min_dist_cm ?? 15.0), layout.max_dist_cm ?? 100.0);
  return pxPerDeg(layout.css_px_per_cm, d);
}
export const period = (c: GazeConfig) => 1000.0 / c.hz;

// ---------------------------------------------------------------------------------------------------------------
// F-L0-VALID + F-L0-GAP
// ---------------------------------------------------------------------------------------------------------------
export function classifySample(s: RawSample, prevValid: RawSample | null, viewport: Viewport, ppd: number, c: GazeConfig, nxt: RawSample | null): Kind {
  if (!(s.face ?? true)) return "noface";
  if (s.blink ?? false) return "blink";
  const x = s.x, y = s.y;
  if ((s.conf ?? 0.0) < c.conf_min || x === null || x === undefined || y === null || y === undefined || !(Number.isFinite(x) && Number.isFinite(y))) return "lowconf";
  if (prevValid !== null && nxt !== null && nxt.x !== null && nxt.x !== undefined) {
    const vel = (a: RawSample, b: RawSample) => {
      const dt = (b.t - a.t) / 1000.0;
      return dt > 0 ? Math.hypot(b.x! - a.x!, b.y! - a.y!) / ppd / dt : 0.0;
    };
    if (vel(prevValid, s) > c.spike_deg_s && vel(s, nxt) > c.spike_deg_s) return "spike";
  }
  const m = c.offscreen_margin_deg * ppd;
  if (x < -m || y < -m || x > viewport.w + m || y > viewport.h + m) return "offscreen";
  return "ok";
}

const GAP_KIND: Record<string, Gap["kind"]> = { blink: "blink", noface: "noface", offscreen: "offscreen", lowconf: "lowconf", spike: "lowconf", hole: "lowconf" };
const GAP_PRIORITY: Gap["kind"][] = ["blink", "noface", "offscreen", "lowconf"];
export function makeGap(t0: number, t1: number, pendingKinds: string[]): Gap {
  const counts: Record<string, number> = { blink: 0, noface: 0, offscreen: 0, lowconf: 0 };
  for (const k of pendingKinds) counts[GAP_KIND[k]!]! += 1;
  let kind: Gap["kind"];
  if (!pendingKinds.length) kind = "lowconf";
  else {
    const best = Math.max(...Object.values(counts));
    kind = GAP_PRIORITY.find((k) => counts[k] === best)!;
  }
  return { t0, t1, kind };
}

export interface CleanStats { n_raw: number; n_valid: number; n_interp: number; n_face: number; n_blink: number; n_noface: number; n_lowconf: number; n_offscreen: number; n_spike: number }

/**
 * The L0 state machine shared by the batch clean() and the streaming pipeline: feed labelled samples in time
 * order; it emits usable samples (valid or interpolated) and gaps exactly as reference.clean does.
 */
export interface CleanCoreState { pending: Array<{ s: RawSample; k: Kind }>; lastOk: RawSample | null }
export class CleanCore {
  constructor(public c: GazeConfig, public emitSample: (s: CleanSample) => void, public emitGap: (g: Gap) => void, public stats: CleanStats,
    public st: CleanCoreState = { pending: [], lastOk: null }) {}
  private closeGap(nextOk: RawSample | null): void {
    const c = this.c, P = period(c), pending = this.st.pending, lastOk = this.st.lastOk;
    if (lastOk === null) {
      if (pending.length) {
        const t0 = pending[0]!.s.t;
        const t1 = nextOk ? nextOk.t : pending[pending.length - 1]!.s.t + P;
        this.emitGap(makeGap(t0, t1, pending.map((p) => p.k)));
      }
      return;
    }
    const hole = nextOk !== null && nextOk.t - lastOk.t > c.contig_factor * P;
    if (!pending.length && !hole) return;
    const t0 = pending.length ? pending[0]!.s.t : lastOk.t + P;
    const t1 = nextOk ? nextOk.t : pending[pending.length - 1]!.s.t + P;
    const kind = makeGap(t0, t1, pending.map((p) => p.k)).kind;
    const fill = nextOk !== null && t1 - t0 <= c.gap_fill_max_ms + 1e-9 && kind !== "offscreen";
    if (fill) {
      let times = pending.map((p) => p.s.t);
      if (!times.length) {
        const n = pyInt(pyRound((nextOk!.t - lastOk.t) / P)) - 1;
        times = Array.from({ length: Math.max(0, n) }, (_, i) => lastOk.t + P * (i + 1));
      }
      for (const t of times) {
        const a = (t - lastOk.t) / (nextOk!.t - lastOk.t);
        this.emitSample({ t, x: lastOk.x! + a * (nextOk!.x! - lastOk.x!), y: lastOk.y! + a * (nextOk!.y! - lastOk.y!), interp: true });
        this.stats.n_interp += 1;
      }
    } else this.emitGap(makeGap(t0, t1, pending.map((p) => p.k)));
  }
  push(s: RawSample, k: Kind): void {
    if (k === "ok") {
      this.closeGap(s);
      this.st.pending = [];
      this.emitSample({ t: s.t, x: Number(s.x), y: Number(s.y), interp: false });
      this.stats.n_valid += 1;
      this.st.lastOk = s;
    } else this.st.pending.push({ s, k });
  }
  finish(): void { if (this.st.pending.length) this.closeGap(null); }
}

export const emptyStats = (): CleanStats => ({ n_raw: 0, n_valid: 0, n_interp: 0, n_face: 0, n_blink: 0, n_noface: 0, n_lowconf: 0, n_offscreen: 0, n_spike: 0 });

export function clean(samples: RawSample[], viewport: Viewport, ppd: number, cIn?: Partial<GazeConfig>): { samples: CleanSample[]; gaps: Gap[]; stats: CleanStats } {
  const c = cfg(cIn);
  const ss = sortBy(samples, (s) => [s.t]);
  const labelled: Array<{ s: RawSample; k: Kind }> = [];
  let prevValid: RawSample | null = null;
  ss.forEach((s, idx) => {
    const nxt = idx + 1 < ss.length ? ss[idx + 1]! : null;
    const k = classifySample(s, prevValid, viewport, ppd, c, nxt);
    labelled.push({ s, k });
    if (k === "ok") prevValid = s;
  });
  const out: CleanSample[] = [], gaps: Gap[] = [];
  const stats = emptyStats();
  stats.n_raw = ss.length;
  stats.n_face = ss.filter((s) => s.face ?? true).length;
  for (const key of ["blink", "noface", "lowconf", "offscreen", "spike"] as const) (stats as any)["n_" + key] = labelled.filter((l) => l.k === key).length;
  const core = new CleanCore(c, (s) => out.push(s), (g) => gaps.push(g), stats);
  for (const { s, k } of labelled) core.push(s, k);
  core.finish();
  return { samples: out, gaps, stats };
}

// ---------------------------------------------------------------------------------------------------------------
// F-B-DRIFT
// ---------------------------------------------------------------------------------------------------------------
export interface BiasStep { t: number; bx: number; by: number; used: boolean }
/** one anchor update (shared by batch and stream): returns the new bias */
export function driftUpdate(bias: { bx: number; by: number }, a: Anchor, win: Array<{ x: number; y: number }>, ppd: number, c: GazeConfig): BiasStep {
  let { bx, by } = bias;
  let used = false;
  if (win.length) {
    const ox = median(win.map((s) => s.x)) - a.x;
    const oy = median(win.map((s) => s.y)) - a.y;
    if (Math.hypot(ox - bx, oy - by) / ppd < c.drift_reject_deg) {
      bx = (1 - c.drift_alpha) * bx + c.drift_alpha * ox;
      by = (1 - c.drift_alpha) * by + c.drift_alpha * oy;
      const mag = Math.hypot(bx, by);
      const cap = c.drift_max_deg * ppd;
      if (mag > cap) { bx = (bx * cap) / mag; by = (by * cap) / mag; }
      used = true;
    }
  }
  return { t: a.t, bx, by, used };
}
export function driftCorrect<S extends { t: number; x: number; y: number }>(samples: S[], anchors: Anchor[], ppd: number, cIn?: Partial<GazeConfig>): { samples: S[]; bias: BiasStep[] } {
  const c = cfg(cIn);
  let b = { bx: 0.0, by: 0.0 };
  const trace: BiasStep[] = [];
  for (const a of sortBy(anchors, (a) => [a.t])) {
    const win = samples.filter((s) => a.t - c.drift_pre_ms <= s.t && s.t <= a.t);
    const st = driftUpdate(b, a, win, ppd, c);
    b = { bx: st.bx, by: st.by };
    trace.push(st);
  }
  const out: S[] = [];
  let j = -1;
  for (const s of samples) {
    while (j + 1 < trace.length && trace[j + 1]!.t < s.t) j += 1;
    const [cx, cy] = j >= 0 ? [trace[j]!.bx, trace[j]!.by] : [0.0, 0.0];
    out.push({ ...s, x: s.x - cx, y: s.y - cy });
  }
  return { samples: out, bias: trace };
}

// ---------------------------------------------------------------------------------------------------------------
// F-L0-SMOOTH
// ---------------------------------------------------------------------------------------------------------------
export function runs<S extends { t: number }>(samples: S[], c: GazeConfig): S[][] {
  const P = period(c);
  const out: S[][] = [];
  let cur: S[] = [];
  for (const s of samples) {
    if (cur.length && s.t - cur[cur.length - 1]!.t > c.contig_factor * P) { out.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out;
}
export function smoothMedian<S extends { t: number; x: number; y: number }>(samples: S[], cIn?: Partial<GazeConfig>): S[] {
  const c = cfg(cIn);
  const w = pyInt(c.median_window);
  if (w <= 1) return samples.map((s) => ({ ...s }));
  const h = Math.floor(w / 2);
  const res: S[] = [];
  for (const run of runs(samples, c)) {
    const n = run.length;
    run.forEach((s, i) => {
      const lo = Math.max(0, i - h), hi = Math.min(n, i + h + 1);
      const k = Math.min(i - lo, hi - 1 - i);
      const seg = run.slice(i - k, i + k + 1);
      res.push({ ...s, x: median(seg.map((q) => q.x)), y: median(seg.map((q) => q.y)) });
    });
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------
// F-L1-FIX + F-L1-MERGE
// ---------------------------------------------------------------------------------------------------------------
export function disp(seg: Array<{ x: number; y: number }>): number {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of seg) { if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x; if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y; }
  return (x1 - x0) + (y1 - y0);
}
export function makeFix(seg: CleanSample[], P: number): Fix {
  const n = seg.length;
  let sx = 0, sy = 0;
  for (const s of seg) sx += s.x;
  for (const s of seg) sy += s.y;
  return { t0: seg[0]!.t, t1: seg[n - 1]!.t + P, x: sx / n, y: sy / n, dispPx: disp(seg), n, _s: seg };
}
export function idt(samples: CleanSample[], ppd: number, cIn?: Partial<GazeConfig>): Fix[] {
  const c = cfg(cIn);
  const P = period(c), D = c.idt_disp_deg * ppd;
  const fixes: Fix[] = [];
  for (const run of runs(samples, c)) {
    let i = 0;
    const n = run.length;
    while (i < n) {
      let j = i;
      while (j < n && run[j]!.t - run[i]!.t + P < c.idt_min_ms - 1e-6) j += 1;
      if (j >= n) break;
      if (disp(run.slice(i, j + 1)) <= D + 1e-9) {
        while (j + 1 < n && disp(run.slice(i, j + 2)) <= D + 1e-9) j += 1;
        fixes.push(makeFix(run.slice(i, j + 1), P));
        i = j + 1;
      } else i += 1;
    }
  }
  return fixes;
}
/** would f merge into p (reference.merge_fixations); `gaps` = every gap known so far */
export function shouldMerge(p: Fix, f: Fix, gaps: Gap[], ppd: number, c: GazeConfig): boolean {
  const P = period(c);
  const sep = f.t0 - p.t1;
  const dist = Math.hypot(f.x - p.x, f.y - p.y) / ppd;
  const between = gaps.filter((g) => g.t0 >= p.t1 - P - 1e-6 && g.t1 <= f.t0 + 1e-6);
  const blinkOnly = between.length === 1 && between[0]!.kind === "blink" && sep <= c.blink_bridge_ms + 1e-6;
  return dist <= c.merge_deg + 1e-9 && (sep <= c.merge_gap_ms + 1e-6 || blinkOnly);
}
export function mergePair(p: Fix, f: Fix, c: GazeConfig): Fix {
  const m = makeFix([...p._s, ...f._s], period(c));
  m.t0 = p.t0; m.t1 = f.t1;
  return m;
}
export function mergeFixations(fixes: Fix[], gaps: Gap[], ppd: number, cIn?: Partial<GazeConfig>, firstId = 1): Fix[] {
  const c = cfg(cIn);
  const out: Fix[] = [];
  for (const f of fixes) {
    if (out.length && shouldMerge(out[out.length - 1]!, f, gaps, ppd, c)) { out[out.length - 1] = mergePair(out[out.length - 1]!, f, c); continue; }
    out.push(f);
  }
  out.forEach((f, k) => { f.id = "f" + (k + firstId); });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// F-L2-ASSIGN, F-L1-SACC
// ---------------------------------------------------------------------------------------------------------------
export function aoisAt(aois: Aoi[], t: number): Aoi[] {
  return aois.filter((a) => a.visible === undefined || a.visible === null || a.visible.some(([v0, v1]) => v0 <= t && t < v1));
}
const rectDist = (a: Aoi, x: number, y: number) => Math.hypot(Math.max(a.x - x, 0.0, x - (a.x + a.w)), Math.max(a.y - y, 0.0, y - (a.y + a.h)));
export function assign(fix: { t0: number; t1: number; x: number; y: number }, aois: Aoi[], ppd: number, cIn?: Partial<GazeConfig>): [string | null, boolean] {
  const c = cfg(cIn);
  const tMid = 0.5 * (fix.t0 + fix.t1);
  let best: { key: [number, number]; a: Aoi } | null = null;
  for (const a of aoisAt(aois, tMid)) {
    const key: [number, number] = [rectDist(a, fix.x, fix.y), a.order];
    if (best === null || tupleCmp(key, best.key) < 0) best = { key, a };
  }
  if (best === null) return [null, false];
  const d = best.key[0];
  if (d === 0.0) return [best.a.id, true];
  if (d <= c.aoi_snap_deg * ppd + 1e-9) return [best.a.id, false];
  return [null, false];
}
const lineH = (a: Aoi) => a.line_h ?? 24.0;
function textpos(a: Aoi, x: number, y: number): number {
  const lh = lineH(a);
  const line = Math.max(0, Math.min(pyInt(pyFloorDiv(y - a.y, lh)), Math.max(0, pyInt(pyRound(a.h / lh)) - 1)));
  return line * a.w + (x - a.x);
}
export interface Sacc { t0: number; t1: number; from: string; to: string; dir: "fwd" | "back" | "jump"; ampDeg: number }
export function saccadeBetween(f0: { id?: string; t1: number; x: number; y: number }, f1: { id?: string; t0: number; x: number; y: number }, a0: string | null, a1: string | null, byId: Map<string, Aoi>, ppd: number): Sacc {
  let d: Sacc["dir"];
  if (a0 === null || a1 === null) d = "jump";
  else if (a0 !== a1) {
    const o0 = byId.get(a0)!.order, o1 = byId.get(a1)!.order;
    d = o1 === o0 + 1 ? "fwd" : o1 > o0 ? "jump" : "back";
  } else {
    const a = byId.get(a0)!;
    d = textpos(a, f1.x, f1.y) >= textpos(a, f0.x, f0.y) ? "fwd" : "back";
  }
  return { t0: f0.t1, t1: f1.t0, from: f0.id!, to: f1.id!, dir: d, ampDeg: Math.hypot(f1.x - f0.x, f1.y - f0.y) / ppd };
}
export function saccades(fixes: Array<{ id?: string; t0: number; t1: number; x: number; y: number }>, aoiIds: Array<string | null>, aois: Aoi[], ppd: number): Sacc[] {
  const byId = new Map(aois.map((a) => [a.id, a] as const));
  const out: Sacc[] = [];
  for (let k = 1; k < fixes.length; k++) out.push(saccadeBetween(fixes[k - 1]!, fixes[k]!, aoiIds[k - 1]!, aoiIds[k]!, byId, ppd));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// F-Q-WINDOW, F-Q-CALIB
// ---------------------------------------------------------------------------------------------------------------
export function windowQuality(raw: Array<{ t: number; face?: boolean }>, cleaned: Array<{ t: number }>, w0: number, w1: number, cIn?: Partial<GazeConfig>) {
  const c = cfg(cIn);
  const expected = Math.max(1, pyInt(pyRound(((w1 - w0) * c.hz) / 1000.0)));
  let usable = 0;
  for (const s of cleaned) if (w0 <= s.t && s.t < w1) usable++;
  let nraw = 0, face = 0;
  for (const s of raw) if (w0 <= s.t && s.t < w1) { nraw++; if (s.face ?? true) face++; }
  const q = Math.min(1.0, usable / expected);
  const ff = nraw ? face / nraw : 0.0;
  const label = q >= c.quality_good ? "good" : q >= c.quality_min ? "fair" : "poor";
  const hz = w1 > w0 ? nraw / ((w1 - w0) / 1000.0) : 0.0;
  const gate = q >= c.quality_min - 1e-9 && ff >= c.face_frac_min - 1e-9;
  return { quality: q, faceFrac: ff, qualityLabel: label as "good" | "fair" | "poor", hz, gate, expected, usable };
}
export function calibCheck(validation: Array<{ target: { x: number; y: number }; samples: Array<{ x: number; y: number }> }>, ppd: number, paraHPx: number,
  calib: { yaw: number; distCm: number; orientation: string; t: number }, now: { yaw: number; distCm: number; orientation: string; t: number }, cIn?: Partial<GazeConfig>) {
  const c = cfg(cIn);
  const errs: number[] = [];
  for (const v of validation) {
    if (!v.samples.length) continue;
    errs.push(Math.hypot(median(v.samples.map((s) => s.x)) - v.target.x, median(v.samples.map((s) => s.y)) - v.target.y));
  }
  const errPx = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  const reasons: string[] = [];
  if (Math.abs(now.yaw - calib.yaw) > c.recal_yaw_deg) reasons.push("yaw");
  if (calib.distCm > 0 && Math.abs(now.distCm - calib.distCm) / calib.distCm > c.recal_dist_frac) reasons.push("distance");
  if (now.orientation !== calib.orientation) reasons.push("orientation");
  if (errPx === null) reasons.push("no_validation_data");
  return { errDeg: errPx === null ? null : errPx / ppd, errParas: errPx === null ? null : errPx / paraHPx, ageS: (now.t - calib.t) / 1000.0,
    orientation: now.orientation, needsRecal: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------------------------------------------
// F-B-SPEED
// ---------------------------------------------------------------------------------------------------------------
export interface Baseline { n: number; mature: boolean; typical_mpw: number; med: number | null; scale: number | null }
export function baselineStats(history: number[], cIn?: Partial<GazeConfig>): Baseline {
  const c = cfg(cIn);
  const h = history.slice(-pyInt(c.baseline_max));
  const prior = 60000.0 / c.prior_wpm;
  if (h.length < c.baseline_min) return { n: h.length, mature: false, typical_mpw: prior, med: null, scale: null };
  const med = median(h);
  const mad = median(h.map((v) => Math.abs(v - med)));
  return { n: h.length, mature: true, typical_mpw: Math.exp(med), med, scale: Math.max(c.mad_k * mad, c.mad_floor) };
}
export function paraSpeed(gazeMs: number, words: number, base: Baseline) {
  const expected = words * base.typical_mpw;
  const ratio = expected > 0 ? gazeMs / expected : 0.0;
  let z: number | null = null;
  if (base.mature && gazeMs > 0 && words > 0) z = (Math.log(gazeMs / words) - base.med!) / base.scale!;
  return { expectedMs: expected, ratio, z };
}
export function baselineUpdate(history: number[], paras: Array<{ gazeMs: number; words: number }>, cIn?: Partial<GazeConfig>): number[] {
  const c = cfg(cIn);
  const h = [...history];
  for (const p of paras) if (p.gazeMs > 0 && p.words >= c.baseline_min_words) h.push(Math.log(p.gazeMs / p.words));
  return h.slice(-pyInt(c.baseline_max));
}
/**
 * contract-v1.3 (not in the R1 reference): a paragraph's uncovered share of a reading window with tab_occluded spans:
 * visible ms / (visible ms + occluded ms), both clipped to [w0, w1]. The visibility tracker closes every interval while
 * the sheet covers the chat, so the two never overlap. 1 when nothing was occluded; floored at 0.05.
 * Used for the skip / skim expectation only (see turnFromL1); the controller also leaves such a window out of the baseline.
 */
export function occlusionExpectFrac(visible: Array<[number, number]>, occluded: Array<[number, number]>, w0: number, w1: number): number {
  const clip = (xs: Array<[number, number]>) => xs.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, w1) - Math.max(a, w0)), 0);
  const occ = clip(occluded);
  if (occ <= 0) return 1;
  const vis = clip(visible);
  return Math.min(1, Math.max(0.05, vis / (vis + occ)));
}

// ---------------------------------------------------------------------------------------------------------------
// F-W-WINDOW
// ---------------------------------------------------------------------------------------------------------------
export function readingWindow(openT: number, streamDoneT: number, keystrokes: number[], replyFix: Array<{ t0: number; t1: number }>, endT: number, cIn?: Partial<GazeConfig>) {
  const c = cfg(cIn);
  const ks = [...keystrokes].sort((a, b) => a - b).filter((k) => k >= openT);
  const cands: Array<[number, "end" | "keystroke" | "idle"]> = [[endT, "end"]];
  if (ks.length) cands.push([ks[0]!, "keystroke"]);
  let last = streamDoneT;
  for (const f of sortBy(replyFix, (f) => [f.t0])) {
    if (f.t1 <= streamDoneT) continue;
    if (f.t0 - Math.max(last, streamDoneT) >= c.idle_close_ms) break;
    last = Math.max(last, f.t1);
  }
  cands.push([Math.max(last, streamDoneT) + c.idle_close_ms, "idle"]);
  let best = cands[0]!;
  for (const x of cands) if (x[0] < best[0]) best = x;
  return { t0: openT, t1: best[0], reason: best[1] };
}

// ---------------------------------------------------------------------------------------------------------------
// L2 dwell + L3 events + L4 digest
// ---------------------------------------------------------------------------------------------------------------
export const excerptWords = (text: string, n: number) => (text || "").split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const overlap = (intervals: Array<[number, number]>, w0: number, w1: number) => {
  let tot = 0.0;
  for (const [v0, v1] of intervals) tot += Math.max(0.0, Math.min(v1, w1) - Math.max(v0, w0));
  return tot;
};

/** the per-turn inputs the app knows (R1 "Pipeline case input" minus the samples) */
export interface TurnSpec {
  layout: Layout; dist_cm?: number | null; aois: Aoi[]; msg: string; open_t: number; stream_done_t: number; end_t: number;
  send_t?: number; keystrokes?: number[]; anchors?: Anchor[]; history?: number[]; turn?: number; first_event_id?: number;
  calib?: { errDeg: number | null; errParas: number | null; ageS: number | null; orientation: string }; orientation?: string; config?: Partial<GazeConfig>;
}
/** what L0/L1 hand to L2-L4 */
export interface L1Result { ppd: number; fixations: Fix[]; gaps: Gap[]; cleanedTimes: Array<{ t: number }>; raw: Array<{ t: number; face?: boolean }> }

export function turn(inp: TurnSpec & { samples: RawSample[] }, cIn?: Partial<GazeConfig>): any {
  const c = cfg({ ...(inp.config ?? {}), ...(cIn ?? {}) });
  const lay = inp.layout;
  let dist = inp.dist_cm ?? null;
  if (dist === null) {
    const ds = inp.samples.filter((s) => s.head && s.head.distCm).map((s) => s.head!.distCm!);
    dist = ds.length ? median(ds) : null;
  }
  const ppd = layoutPpd(lay, dist);
  const vp = { w: lay.viewport_w, h: lay.viewport_h };
  const cl = clean(inp.samples, vp, ppd, c);
  const dc = driftCorrect(cl.samples, inp.anchors ?? [], ppd, c);
  const sm = smoothMedian(dc.samples, c);
  const fx = mergeFixations(idt(sm, ppd, c), cl.gaps, ppd, c);
  return turnFromL1(inp, { ppd, fixations: fx, gaps: cl.gaps, cleanedTimes: cl.samples, raw: inp.samples }, c);
}

export function turnFromL1(inp: TurnSpec, l1: L1Result, cIn?: Partial<GazeConfig>): any {
  const c = cfg({ ...(inp.config ?? {}), ...(cIn ?? {}) });
  const { ppd, fixations: fx } = l1;
  const aois = inp.aois;
  const byId = new Map(aois.map((a) => [a.id, a] as const));
  const ids: Array<string | null> = [], inside: boolean[] = [];
  for (const f of fx) { const [a, ins] = assign(f, aois, ppd, c); ids.push(a); inside.push(ins); }
  const sac = saccades(fx, ids, aois, ppd);
  const msg = inp.msg;
  const replyFix = fx.filter((_, k) => ids[k] && byId.get(ids[k]!)!.msg === msg);
  const win = readingWindow(inp.open_t, inp.stream_done_t, inp.keystrokes ?? [], replyFix, inp.end_t, c);
  const w0 = win.t0, w1 = win.t1;
  const wq = windowQuality(l1.raw, l1.cleanedTimes, w0, w1, c);
  const base = baselineStats(inp.history ?? [], c);
  const maturity = base.mature ? 1.0 : c.prebase_maturity;

  const dwell = new Map<string, any>();
  for (const a of aois) dwell.set(a.id, { aoi: a.id, words: a.words, visibleMs: overlap(a.visible ?? [[w0, w1]], w0, w1), gazeMs: 0.0, msPerWordZ: null,
    fixations: 0, reentries: 0, regressionsIn: 0, firstFixLatencyMs: null, coverage: 0.0, conf: 1.0, _in: 0.0, _lines: new Set<number>() });
  let prev: string | null = null;
  const visits = new Map<string, number>();
  fx.forEach((f, k) => {
    const a = ids[k]!;
    const ms = Math.max(0.0, Math.min(f.t1, w1) - Math.max(f.t0, w0));
    if (ms <= 0) return;
    if (a === null) return;
    const d = dwell.get(a)!;
    d.gazeMs += ms;
    d.fixations += 1;
    if (inside[k]) d._in += ms;
    const A = byId.get(a)!;
    const lh = lineH(A);
    const nl = Math.max(1, pyInt(pyRound(A.h / lh)));
    d._lines.add(Math.max(0, Math.min(nl - 1, pyInt(pyFloorDiv(f.y - A.y, lh)))));
    if (d.firstFixLatencyMs === null) d.firstFixLatencyMs = Math.max(0.0, f.t0 - (A.complete_t ?? w0));
    if (prev !== a) {
      visits.set(a, (visits.get(a) ?? 0) + 1);
      if (prev !== null && byId.get(prev)!.order > A.order) d.regressionsIn += 1;
    }
    prev = a;
  });
  for (const [a, d] of dwell) {
    const A = byId.get(a)!;
    d.reentries = Math.max(0, (visits.get(a) ?? 0) - 1);
    const nl = Math.max(1, pyInt(pyRound(A.h / lineH(A))));
    d.coverage = d._lines.size / nl;
    d.conf = d.gazeMs > 0 ? d._in / d.gazeMs : 1.0;
  }

  const events: any[] = [];
  const ev = (kind: string, aoi: string, t0: number, t1: number, z: number | null, conf: number, feats: Record<string, number>) => {
    const e = { kind, aoi, excerpt: excerptWords(byId.has(aoi) ? byId.get(aoi)!.text ?? "" : "", c.excerpt_words), t0, t1, z, conf, features: feats } as any;
    events.push(e);
    return e;
  };
  const paras: any[] = [];
  const lookbacks: any[] = [];
  if (wq.gate) {
    for (const A of sortBy(aois.filter((a) => a.msg === msg), (a) => [a.order])) {
      const d = dwell.get(A.id)!;
      const full = paraSpeed(d.gazeMs, A.words, base);
      // contract-v1.3: time under a tab_occluded span is not demanded (skip / skim / visibility use the uncovered
      // expectation); deep still needs the full one, so occlusion can never create a deep_read. Absent = R1 exactly.
      const sp = A.expect_frac === undefined ? full : paraSpeed(d.gazeMs, A.words * A.expect_frac, base);
      d.msPerWordZ = full.z;
      const r = sp.ratio, z = full.z;
      const conf = wq.quality * d.conf * maturity;
      const visibleOk = d.visibleMs >= c.visible_frac * sp.expectedMs - 1e-6;
      let label: "skipped" | "skim" | "deep" | "read";
      if (r < c.skip_ratio) label = "skipped";
      else if (r < c.scan_ratio) label = "skim";
      else if ((z !== null && z >= c.deep_z) || (z === null && full.ratio >= c.deep_ratio_prebase)) label = "deep";
      else label = "read";
      const feats = { gazeMs: d.gazeMs, visibleMs: d.visibleMs, expectedMs: sp.expectedMs, ratio: r, words: A.words };
      const mine: any[] = [];
      if (label === "deep") mine.push(ev("deep_read", A.id, w0, w1, z, conf, feats));
      if (label === "skipped" && visibleOk) mine.push(ev("skip", A.id, w0, w1, z, conf, feats));
      if (label === "skim" && visibleOk) mine.push(ev("fast_scan", A.id, w0, w1, z, conf, feats));
      if (d.reentries >= c.reread_reentries) mine.push(ev("reread", A.id, w0, w1, z, conf, { ...feats, reentries: d.reentries, regressionsIn: d.regressionsIn }));
      paras.push({ aoi: A.id, excerpt: excerptWords(A.text ?? "", c.excerpt_words), label, ratio: r, _ev: mine });
    }
    for (const A of sortBy(aois.filter((a) => a.msg !== msg), (a) => [a.order])) {
      const d = dwell.get(A.id)!;
      if (d.gazeMs > c.lookback_ms) {
        const sp = paraSpeed(d.gazeMs, A.words, base);
        const e = ev("look_back", A.id, w0, w1, null, wq.quality * d.conf, { gazeMs: d.gazeMs, ratio: sp.ratio, words: A.words });
        lookbacks.push({ aoi: A.id, excerpt: e.excerpt, ms: d.gazeMs, _ev: e });
      }
    }
  }
  const replyVis: Array<[number, number]> = [];
  for (const a of aois) if (a.msg === msg) for (const v of a.visible ?? [[w0, w1] as [number, number]]) replyVis.push(v);
  const away = l1.gaps.filter((g) => g.kind === "offscreen" || g.kind === "noface");
  let offMs = 0;
  for (const g of away) offMs += Math.max(0.0, Math.min(g.t1, w1) - Math.max(g.t0, w0));
  for (const g of away) {
    const g0 = Math.max(g.t0, w0), g1 = Math.min(g.t1, w1);
    const vis = g1 > g0 ? overlap(replyVis, g0, g1) : 0.0;
    if (g1 - g0 > c.offscreen_ms && vis > 0) events.push({ kind: "offscreen", aoi: msg, excerpt: "", t0: g0, t1: g1, z: null, conf: 1.0, features: { ms: g1 - g0, ["kind_" + g.kind]: 1 } });
  }
  const sendT = inp.send_t ?? inp.end_t;
  const ks = (inp.keystrokes ?? []).filter((k) => inp.open_t <= k && k <= sendT).sort((a, b) => a - b);
  let npause = 0;
  for (let i = 1; i < ks.length; i++) {
    const k0 = ks[i - 1]!, k1 = ks[i]!;
    if (k1 - k0 >= c.pause_ms) {
      npause += 1;
      events.push({ kind: "composer_hesitation", aoi: "composer", excerpt: "", t0: k0, t1: k1, z: null, conf: 1.0, features: { pauseMs: k1 - k0 } });
    }
  }
  const sorted = sortBy(events, (e) => [e.t0, e.kind, e.aoi]);
  events.length = 0;
  events.push(...sorted);
  const start = pyInt(inp.first_event_id ?? 1);
  events.forEach((e, i) => { e.id = "e" + (start + i); });
  const score = (e: any) => {
    let m: number;
    if (e.z !== null) m = Math.abs(e.z);
    else if ("ratio" in e.features && e.features.ratio > 0) m = Math.abs(Math.log(e.features.ratio));
    else m = 1.0;
    return m * e.conf;
  };
  const ranked = sortBy(events, (e) => [-score(e), Number(e.id.slice(1))]).slice(0, c.max_events);
  for (const p of paras) {
    p.ev = p._ev.map((e: any) => e.id);
    delete p._ev;
    if (!p.ev.length) delete p.ev;
  }
  const lb = lookbacks.map((l) => ({ aoi: l.aoi, excerpt: l.excerpt, ms: l.ms, ev: l._ev.id }));
  const digest = { msg, windowMs: w1 - w0, quality: wq.quality, qualityLabel: wq.qualityLabel, paras, lookBacks: lb, offscreenMs: offMs, composerPauses: npause, events: ranked.map((e) => e.id) };
  const nominal = c.hz === 30.0 || c.hz === 15.0 ? c.hz : null;
  const gq = { type: "gaze_quality", turn: inp.turn ?? 0, calib: inp.calib ?? { errDeg: null, errParas: null, ageS: null, orientation: inp.orientation ?? "portrait" },
    quality: wq.quality, faceFrac: wq.faceFrac, hz: nominal ? pyInt(nominal) : null };
  for (const d of dwell.values()) { delete d._in; delete d._lines; }
  const ordered = sortBy(aois, (a) => [a.order]);
  return r6({
    window: win, ppd, gate: wq.gate, gaps: l1.gaps,
    fixations: fx.map((f, k) => ({ id: f.id, t0: f.t0, t1: f.t1, x: f.x, y: f.y, dispPx: f.dispPx, n: f.n, aoi: ids[k] })),
    saccades: sac,
    dwell: ordered.map((a) => dwell.get(a.id)),
    events, digest, gaze_quality: gq,
    attention_digest: { type: "attention_digest", turn: inp.turn ?? 0, msg, digest, events },
    aoi_dwell: { type: "aoi_dwell", turn: inp.turn ?? 0, msg, dwell: ordered.filter((a) => a.msg === msg).map((a) => dwell.get(a.id)) },
    aoi_layout: { type: "aoi_layout", turn: inp.turn ?? 0, msg, orientation: inp.calib?.orientation ?? "portrait",
      boxes: ordered.filter((a) => a.msg === msg).map((a) => ({ aoi: a.id, words: a.words, x: a.x, y: a.y, w: a.w, h: a.h })) },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// F-LOG-L1: contract-v1 gaze_l1 bodies (log only; features use the unmerged fixations)
// ---------------------------------------------------------------------------------------------------------------
interface LFix { id: string; t0: number; t1: number; x: number; y: number; dispPx: number; n: number; aoi?: string | null; _ms?: number }
function lMergePair(a: LFix, b: LFix): LFix {
  const n = a.n + b.n;
  return { id: a.id, t0: a.t0, t1: Math.max(a.t1, b.t1), x: (a.x * a.n + b.x * b.n) / n, y: (a.y * a.n + b.y * b.n) / n,
    dispPx: Math.max(a.dispPx, b.dispPx, Math.abs(a.x - b.x) + Math.abs(a.y - b.y)), n, aoi: a.aoi === b.aoi ? a.aoi : a.aoi,
    _ms: (a._ms ?? a.t1 - a.t0) + (b._ms ?? b.t1 - b.t0) };
}
export function capFixations(fixes: LFix[], cap: number): [LFix[], Map<string, string>] {
  const fx = sortBy(fixes, (f) => [f.t0]).map((f) => ({ ...f }));
  const alias = new Map<string, string>();
  while (fx.length > cap) {
    let best: { key: [number, number]; i: number } | null = null;
    for (const same of [true, false]) {
      for (let i = 0; i < fx.length - 1; i++) {
        const a = fx[i]!, b = fx[i + 1]!;
        if (same && (a.aoi === null || a.aoi === undefined || a.aoi !== b.aoi)) continue;
        const key: [number, number] = [Math.hypot(a.x - b.x, a.y - b.y), b.t0 - a.t1];
        if (best === null || tupleCmp(key, best.key) < 0) best = { key, i };
      }
      if (best !== null) break;
    }
    const i = best!.i;
    alias.set(fx[i + 1]!.id, fx[i]!.id);
    fx.splice(i, 2, lMergePair(fx[i]!, fx[i + 1]!));
  }
  return [fx, alias];
}
export function gazeL1Batches(fixes: LFix[], sacc: Sacc[], gaps: Gap[], tStart: number, tEnd: number, cIn?: Partial<GazeConfig>): any[] {
  const c = cfg(cIn);
  const W = c.l1_window_ms;
  const out: any[] = [];
  let k = 0;
  while (tStart + k * W < tEnd) {
    const w0 = tStart + k * W, w1 = Math.min(tEnd, tStart + (k + 1) * W);
    k += 1;
    const b = l1Batch(fixes, sacc, gaps, w0, w1, c);
    if (b) out.push(b);
  }
  return out;
}
/** one gaze_l1 body for [w0, w1) or null when the window is empty (A-10) */
export function l1Batch(fixes: LFix[], sacc: Sacc[], gaps: Gap[], w0: number, w1: number, c: GazeConfig): any | null {
  const fin = fixes.filter((f) => w0 <= f.t0 && f.t0 < w1);
  const [fx, alias] = capFixations(fin, c.l1_max_fix);
  const res = (i: string) => { while (alias.has(i)) i = alias.get(i)!; return i; };
  let sc: Sacc[] = [];
  for (const s of sacc) {
    if (w0 <= s.t0 && s.t0 < w1 && (s.dir === "back" || s.dir === "jump")) {
      const a = res(s.from), b = res(s.to);
      if (a !== b) sc.push({ ...s, from: a, to: b });
    }
  }
  if (sc.length > c.l1_max_sacc) sc = sortBy(sortBy(sc, (s) => [-s.ampDeg, s.t0]).slice(0, c.l1_max_sacc), (s) => [s.t0]);
  let gp = gaps.filter((g) => w0 <= g.t0 && g.t0 < w1);
  if (gp.length > c.l1_max_gaps) gp = sortBy(sortBy(gp, (g) => [-(g.t1 - g.t0), g.t0]).slice(0, c.l1_max_gaps), (g) => [g.t0]);
  if (!(fx.length || sc.length || gp.length)) return null;
  const r1 = (v: number) => pyRound(v, 1);
  const ms = (v: number) => pyInt(pyRound(v));
  return { type: "gaze_l1", t0: ms(w0), t1: ms(w1),
    fixations: fx.map((f) => ({ id: f.id, t0: ms(f.t0), t1: ms(f.t1), x: r1(f.x), y: r1(f.y), dispPx: r1(f.dispPx), n: pyInt(f.n) })),
    saccades: sc.map((s) => ({ t0: ms(s.t0), t1: ms(s.t1), from: s.from, to: s.to, dir: s.dir, ampDeg: pyRound(s.ampDeg, 2) })),
    gaps: gp.map((g) => ({ t0: ms(g.t0), t1: ms(g.t1), kind: g.kind })) };
}
export const maxFixPerWindow = (batches: any[]) => Math.max(0, ...batches.map((b) => b.fixations.length));

// ---------------------------------------------------------------------------------------------------------------
// stage dispatch (the R1 test runner's run_stage)
// ---------------------------------------------------------------------------------------------------------------
export function runStage(caseObj: { stage: string; input: any; config?: Partial<GazeConfig> }): any {
  const st = caseObj.stage, i = caseObj.input;
  const c = cfg(caseObj.config);
  const fixOut = (f: Fix) => ({ id: f.id, t0: f.t0, t1: f.t1, x: f.x, y: f.y, dispPx: f.dispPx, n: f.n });
  switch (st) {
    case "ppd": return r6({ ppd: layoutPpd(i.layout, i.dist_cm) });
    case "clean": { const o = clean(i.samples, i.viewport, i.ppd, c); return r6({ samples: o.samples, gaps: o.gaps, stats: o.stats }); }
    case "fixations": {
      const cl = clean(i.samples, i.viewport, i.ppd, c);
      const sm = smoothMedian(cl.samples, c);
      const fx = mergeFixations(idt(sm, i.ppd, c), cl.gaps, i.ppd, c);
      return r6({ fixations: fx.map(fixOut), gaps: cl.gaps });
    }
    case "saccades": {
      const fx = i.fixations;
      const ids = fx.map((f: any) => assign(f, i.aois, i.ppd, c)[0]);
      return r6({ aoi: ids, saccades: saccades(fx, ids, i.aois, i.ppd) });
    }
    case "quality": { const cl = clean(i.samples, i.viewport, i.ppd, c); return r6(windowQuality(i.samples, cl.samples, i.w0, i.w1, c)); }
    case "calib": return r6(calibCheck(i.validation, i.ppd, i.para_h_px, i.calib, i.now, c));
    case "drift": { const o = driftCorrect(i.samples, i.anchors, i.ppd, c); return r6({ bias: o.bias, samples: o.samples }); }
    case "baseline": {
      const b = baselineStats(i.history, c);
      return r6({ baseline: b, paras: i.paras.map((p: any) => paraSpeed(p.gazeMs, p.words, b)), history_after: baselineUpdate(i.history, i.paras, c) });
    }
    case "window": return r6(readingWindow(i.open_t, i.stream_done_t, i.keystrokes, i.reply_fix, i.end_t, c));
    case "turn": return turn(i, c);
    case "log": {
      const b = gazeL1Batches(i.fixations, i.saccades ?? [], i.gaps ?? [], i.t_start, i.t_end, c);
      return { batches: b, max_fix: maxFixPerWindow(b), n_fix: b.reduce((s, x) => s + x.fixations.length, 0) };
    }
  }
  throw new Error("unknown stage " + st);
}
