/**
 * E5: the streaming L0/L1 port of R1 (R1/FEATURES.md wishlist 9). Samples arrive in ~100 ms batches; gap filling,
 * spike checks (1-sample lookahead), drift anchors, the median-3 smoother, I-DT and the fixation merge all carry
 * their state across batches, so a fixation can span any number of batches. At a reading-window close,
 * snapshot() flushes a CLONE of the state (the live pipeline keeps running) and hands the result to the same
 * L2-L4 code as the batch reference (gaze-ref.turnFromL1). Fed the samples of one R1 turn case, the streamed
 * turn equals reference.turn() exactly, for any batch size (ad-e5.test.ts).
 *
 * Features (dwell, events, digest) use the UNMERGED fixations. The "20 fixations per 5 s" merge is applied only
 * to the gaze_l1 log bodies (onL1), never to features.
 *
 * Drift anchors (composer taps) may arrive a little after the samples around them: a cleaned sample is held for
 * anchor_hold_ms behind the newest raw sample so a tap at t can still correct the samples after t. An anchor older
 * than the last released sample is applied from that point on and counted in stats.late_anchors.
 */
import type { FeatureMap } from "../types.js";
import type { TimeWindow } from "../signals.js";
import {
  CleanCore, classifySample, cfg, driftUpdate, emptyStats, makeFix, disp, mergePair, period, shouldMerge, median, turnFromL1, assign,
  saccadeBetween, l1Batch,
  type Anchor, type Aoi, type BiasStep, type CleanCoreState, type CleanSample, type CleanStats, type Fix, type Gap, type GazeConfig,
  type L1Result, type RawSample, type Sacc, type TurnSpec, type Viewport,
} from "./gaze-ref.js";

export interface StreamConfig extends GazeConfig {
  /** how long a cleaned sample waits for a late drift anchor before the bias is applied (ms) */
  anchor_hold_ms: number;
  /** composer-tap drift correction on/off (anchors are ignored when false) */
  drift_correction: boolean;
}
export const STREAM_DEFAULTS = { anchor_hold_ms: 300, drift_correction: true } as const;

interface State {
  lastRawT: number;
  held: RawSample | null;
  prevValid: RawSample | null;
  core: CleanCoreState;
  stats: CleanStats & { late_samples: number; late_anchors: number };
  raw: Array<{ t: number; face: boolean }>;
  cleaned: Array<{ t: number }>;
  gaps: Gap[];
  /** drift */
  anchors: Anchor[];
  bias: { bx: number; by: number };
  trace: BiasStep[];
  traceIdx: number;
  pre: CleanSample[];
  hold: CleanSample[];
  lastReleasedT: number;
  /** smoother: current run, emitted index */
  sRun: CleanSample[];
  sEmit: number;
  /** I-DT: current run from the window start */
  iBuf: CleanSample[];
  iLastT: number | null;
  /** merge */
  tentative: Fix | null;
  fixations: Fix[];
  nextId: number;
  /** gaze_l1 log */
  l1Epoch: number | null;
  l1K: number;
}

export interface GazeStreamOptions {
  ppd: number;
  viewport: Viewport;
  config?: Partial<StreamConfig>;
  /** gaze_l1 window origin (default: the first sample's t) */
  l1Epoch?: number;
  /** a contract-v1 gaze_l1 body (<= 5 s window, <= 20 fixations) is ready */
  onL1?: (body: Record<string, unknown>) => void;
}

export class GazeStream {
  readonly c: StreamConfig;
  ppd: number;
  readonly viewport: Viewport;
  aois: Aoi[] = [];
  onL1?: (body: Record<string, unknown>) => void;
  private s: State;
  private core!: CleanCore;

  constructor(o: GazeStreamOptions, state?: State) {
    this.c = { ...cfg(o.config), ...STREAM_DEFAULTS, ...(o.config ?? {}) } as StreamConfig;
    this.ppd = o.ppd;
    this.viewport = o.viewport;
    if (o.onL1) this.onL1 = o.onL1;
    this.s = state ?? {
      lastRawT: -Infinity, held: null, prevValid: null, core: { pending: [], lastOk: null },
      stats: { ...emptyStats(), late_samples: 0, late_anchors: 0 }, raw: [], cleaned: [], gaps: [],
      anchors: [], bias: { bx: 0, by: 0 }, trace: [], traceIdx: -1, pre: [], hold: [], lastReleasedT: -Infinity,
      sRun: [], sEmit: 0, iBuf: [], iLastT: null, tentative: null, fixations: [], nextId: 1, l1Epoch: o.l1Epoch ?? null, l1K: 0,
    };
    this.bindCore();
  }
  private bindCore(): void {
    this.core = new CleanCore(this.c, (cs) => this.onClean(cs), (g) => this.s.gaps.push(g), this.s.stats, this.s.core);
  }
  get stats() { return this.s.stats; }
  get finalized(): readonly Fix[] { return this.s.fixations; }
  get bias(): readonly BiasStep[] { return this.s.trace; }

  /** one tracker batch (any size); samples must not go back in time across batches (late ones are dropped and counted) */
  push(batch: RawSample[]): void {
    const st = this.s;
    for (const smp of [...batch].sort((a, b) => a.t - b.t)) {
      if (smp.t < st.lastRawT) { st.stats.late_samples++; continue; }
      if (st.l1Epoch === null) st.l1Epoch = smp.t;
      st.lastRawT = smp.t;
      st.stats.n_raw++;
      const face = smp.face ?? true;
      if (face) st.stats.n_face++;
      st.raw.push({ t: smp.t, face });
      if (st.held) this.classify(st.held, smp);
      st.held = smp;
    }
    this.release(st.lastRawT - this.c.anchor_hold_ms, false);
    this.emitL1(false);
  }
  /** a known-gaze moment (composer tap) in the same screen/CSS px and clock as the samples */
  anchor(a: Anchor): void {
    if (!this.c.drift_correction) return;
    const st = this.s;
    if (a.t < st.lastReleasedT) st.stats.late_anchors++;
    st.anchors.push({ ...a });
    st.anchors.sort((x, y) => x.t - y.t);
    this.release(st.lastRawT - this.c.anchor_hold_ms, false);
  }
  setAois(aois: Aoi[]): void { this.aois = aois; }

  private classify(s: RawSample, nxt: RawSample | null): void {
    const st = this.s;
    const k = classifySample(s, st.prevValid, this.viewport, this.ppd, this.c, nxt);
    if (k !== "ok") (st.stats as unknown as Record<string, number>)["n_" + k]!++;
    else st.prevValid = s;
    this.core.push(s, k);
  }
  private onClean(cs: CleanSample): void {
    const st = this.s;
    st.cleaned.push({ t: cs.t });
    st.pre.push(cs);
    st.hold.push(cs);
  }
  /** cleaned watermark: every cleaned sample with t <= this has been emitted */
  private cleanedUpTo(): number {
    const st = this.s;
    return st.cleaned.length ? st.cleaned[st.cleaned.length - 1]!.t : -Infinity;
  }
  private processAnchors(final: boolean): void {
    const st = this.s;
    while (st.anchors.length) {
      const a = st.anchors[0]!;
      if (!final && !(this.cleanedUpTo() > a.t)) break;
      st.anchors.shift();
      const win = st.pre.filter((p) => a.t - this.c.drift_pre_ms <= p.t && p.t <= a.t);
      const step = driftUpdate(st.bias, a, win, this.ppd, this.c);
      st.bias = { bx: step.bx, by: step.by };
      // a late anchor takes effect from the last released sample on (it cannot rewrite released samples)
      st.trace.push(a.t < st.lastReleasedT ? { ...step, t: st.lastReleasedT } : step);
    }
    const keep = (st.anchors.length ? Math.min(st.anchors[0]!.t, this.cleanedUpTo()) : this.cleanedUpTo()) - this.c.drift_pre_ms - this.c.anchor_hold_ms - 1000;
    let i = 0;
    while (i < st.pre.length && st.pre[i]!.t < keep) i++;
    if (i) st.pre.splice(0, i);
  }
  private release(upTo: number, final: boolean): void {
    const st = this.s;
    this.processAnchors(final);
    while (st.hold.length) {
      const h = st.hold[0]!;
      if (!final && h.t > upTo) break;
      if (!final && st.anchors.length && st.anchors[0]!.t < h.t) break; // an unprocessed earlier anchor blocks
      st.hold.shift();
      while (st.traceIdx + 1 < st.trace.length && st.trace[st.traceIdx + 1]!.t < h.t) st.traceIdx++;
      const b = st.traceIdx >= 0 ? st.trace[st.traceIdx]! : { bx: 0, by: 0 };
      st.lastReleasedT = h.t;
      this.onDrift({ ...h, x: h.x - b.bx, y: h.y - b.by });
    }
  }
  // ---- median smoother (centred, shrinking at run edges) ----
  private onDrift(s: CleanSample): void {
    const st = this.s, P = period(this.c);
    const last = st.sRun.length ? st.sRun[st.sRun.length - 1]! : null;
    if (last && s.t - last.t > this.c.contig_factor * P) this.smoothFinish();
    st.sRun.push(s);
    this.smoothEmit(false);
  }
  private smoothEmit(final: boolean): void {
    const st = this.s;
    const w = Math.trunc(this.c.median_window);
    if (w <= 1) { for (; st.sEmit < st.sRun.length; st.sEmit++) this.onSmooth({ ...st.sRun[st.sEmit]! }); this.smoothPrune(0); return; }
    const h = Math.floor(w / 2);
    const n = st.sRun.length;
    // sRun holds the run from some offset; indexes are relative, edge handling needs the true run index, kept in sBase
    for (; st.sEmit < n; st.sEmit++) {
      const i = st.sEmit;
      if (!final && i + h >= n) break;
      const ri = i + this.sBase;
      const lo = Math.max(0, ri - h), hi = final ? Math.min(n + this.sBase, ri + h + 1) : ri + h + 1;
      const k = Math.min(ri - lo, hi - 1 - ri);
      const seg = st.sRun.slice(i - k, i + k + 1);
      this.onSmooth({ ...st.sRun[i]!, x: median(seg.map((q) => q.x)), y: median(seg.map((q) => q.y)) });
    }
    this.smoothPrune(h);
  }
  private sBase = 0;
  private smoothPrune(h: number): void {
    const st = this.s;
    const drop = Math.max(0, st.sEmit - h);
    if (drop > 64) { st.sRun.splice(0, drop); st.sEmit -= drop; this.sBase += drop; }
  }
  private smoothFinish(): void {
    const st = this.s;
    this.smoothEmit(true);
    st.sRun = []; st.sEmit = 0; this.sBase = 0;
  }
  // ---- I-DT ----
  private onSmooth(s: CleanSample): void {
    const st = this.s, P = period(this.c);
    if (st.iLastT !== null && s.t - st.iLastT > this.c.contig_factor * P) { this.idtStep(true); st.iBuf = []; }
    st.iLastT = s.t;
    st.iBuf.push(s);
    this.idtStep(false);
  }
  private idtStep(final: boolean): void {
    const st = this.s, c = this.c, P = period(c), D = c.idt_disp_deg * this.ppd;
    for (;;) {
      const buf = st.iBuf, n = buf.length;
      if (!n) return;
      let j = 0;
      while (j < n && buf[j]!.t - buf[0]!.t + P < c.idt_min_ms - 1e-6) j++;
      if (j >= n) { if (final) st.iBuf = []; return; }
      if (disp(buf.slice(0, j + 1)) <= D + 1e-9) {
        while (j + 1 < n && disp(buf.slice(0, j + 2)) <= D + 1e-9) j++;
        if (j + 1 >= n && !final) return; // the fixation may still grow
        this.onFix(makeFix(buf.slice(0, j + 1), P));
        st.iBuf = buf.slice(j + 1);
      } else st.iBuf = buf.slice(1);
    }
  }
  // ---- merge ----
  private onFix(f: Fix): void {
    const st = this.s;
    if (st.tentative && shouldMerge(st.tentative, f, st.gaps, this.ppd, this.c)) { st.tentative = mergePair(st.tentative, f, this.c); return; }
    if (st.tentative) this.finalize(st.tentative);
    st.tentative = f;
  }
  private finalize(f: Fix): void {
    const st = this.s;
    f.id = "f" + st.nextId++;
    f._s = []; // the samples are only needed while a fixation can still merge
    st.fixations.push(f);
  }

  /** flush everything (end of the stream or a clone for snapshot()) */
  flush(): this {
    const st = this.s;
    if (st.held) { this.classify(st.held, null); st.held = null; }
    this.core.finish();
    this.release(Infinity, true);
    this.smoothFinish();
    this.idtStep(true);
    st.iBuf = []; st.iLastT = null;
    if (st.tentative) { this.finalize(st.tentative); st.tentative = null; }
    this.emitL1(true);
    return this;
  }
  /** a flushed copy of the current state; the live stream is not changed */
  clone(): GazeStream {
    const g = new GazeStream({ ppd: this.ppd, viewport: this.viewport, config: this.c }, structuredClone(this.s));
    g.sBase = this.sBase;
    g.aois = this.aois;
    return g;
  }
  snapshot(): L1Result {
    const g = this.clone().flush();
    const st = g.s;
    return { ppd: this.ppd, fixations: st.fixations, gaps: st.gaps, cleanedTimes: st.cleaned, raw: st.raw };
  }

  // ---- gaze_l1 log (contract-v1: <= 20 fixations per <= 5 s window; log-only merge) ----
  /** earliest t0 a not-yet-final fixation can still have */
  private fixWatermark(): number {
    const st = this.s;
    const ts = [st.lastRawT + 1];
    if (st.tentative) ts.push(st.tentative.t0);
    if (st.iBuf.length) ts.push(st.iBuf[0]!.t);
    if (st.sEmit < st.sRun.length) ts.push(st.sRun[st.sEmit]!.t);
    if (st.hold.length) ts.push(st.hold[0]!.t);
    if (st.core.pending.length) ts.push(st.core.pending[0]!.s.t);
    if (st.core.lastOk) ts.push(st.core.lastOk.t);
    if (st.held) ts.push(st.held.t);
    return Math.min(...ts);
  }
  private emitL1(final: boolean): void {
    const st = this.s;
    if (!this.onL1 || st.l1Epoch === null) return;
    const W = this.c.l1_window_ms;
    const wm = final ? Infinity : this.fixWatermark();
    let end = Infinity;
    if (final) {
      end = st.lastRawT;
      for (const f of st.fixations) end = Math.max(end, f.t1);
      for (const g of st.gaps) end = Math.max(end, g.t1);
      end += 1;
    }
    for (;;) {
      const w0 = st.l1Epoch + st.l1K * W, w1 = w0 + W;
      if (final ? w0 >= end : wm < w1) return;
      // the saccade leaving the window's last fixation needs that fixation's successor
      const inWin = st.fixations.filter((f) => f.t0 < w1);
      const lastIn = inWin[inWin.length - 1];
      if (!final && lastIn && lastIn.t1 < w1 && st.fixations.indexOf(lastIn) === st.fixations.length - 1) return;
      st.l1K++;
      const body = this.l1Body(w0, final ? Math.min(w1, end) : w1);
      if (body) this.onL1(body);
    }
  }
  private l1Body(w0: number, w1: number): Record<string, unknown> | null {
    const st = this.s;
    const fx = st.fixations.filter((f) => f.t0 >= w0 - 2 * this.c.l1_window_ms && f.t0 < w1 + this.c.l1_window_ms);
    const ids = fx.map((f) => assign(f, this.aois, this.ppd, this.c)[0]);
    const byId = new Map(this.aois.map((a) => [a.id, a] as const));
    const sac: Sacc[] = [];
    for (let k = 1; k < fx.length; k++) sac.push(saccadeBetween(fx[k - 1]!, fx[k]!, ids[k - 1]!, ids[k]!, byId, this.ppd));
    const lf = fx.map((f, k) => ({ id: f.id!, t0: f.t0, t1: f.t1, x: f.x, y: f.y, dispPx: f.dispPx, n: f.n, aoi: ids[k] ?? null }));
    return l1Batch(lf, sac, st.gaps, w0, w1, this.c);
  }

  /** drop everything older than t (SignalSource.clear): raw/cleaned times, gaps and final fixations */
  clear(before: number): void {
    const st = this.s;
    st.raw = st.raw.filter((r) => r.t >= before);
    st.cleaned = st.cleaned.filter((r) => r.t >= before);
    st.gaps = st.gaps.filter((g) => g.t1 >= before);
    st.fixations = st.fixations.filter((f) => f.t1 >= before);
  }
}

/** the per-turn bodies the app logs (bh-ad/1): aoi_layout, gaze_quality, aoi_dwell, attention_digest */
export interface TurnBodies { aoi_layout: Record<string, unknown>; gaze_quality: Record<string, unknown>; aoi_dwell: Record<string, unknown>; attention_digest: Record<string, unknown> }

/**
 * GazeSource: the gaze "input device" (spec: plugs into the SignalSource pattern next to ReplayFeatureSource and
 * FakeEegSource). push() takes a GazeBatchEvent's samples; closeTurn() runs L2-L4 over a snapshot.
 * Windows for summarize() are on the gaze clock (GazeSample.t, performance.now()).
 */
export class GazeSource {
  readonly id = "gaze";
  readonly kind = "gaze" as const;
  readonly stream: GazeStream;
  constructor(o: GazeStreamOptions) { this.stream = new GazeStream(o); }
  push(sample: unknown): void {
    const batch = Array.isArray(sample) ? sample : (sample as { samples?: unknown[] })?.samples ?? [sample];
    this.stream.push(batch as RawSample[]);
  }
  anchor(a: Anchor): void { this.stream.anchor(a); }
  setAois(aois: Aoi[]): void { this.stream.setAois(aois); }
  /** L2-L4 for one Actor message: the R1 turn() output (window, fixations, dwell, events, digest, log bodies) */
  closeTurn(spec: TurnSpec): ReturnType<typeof turnFromL1> {
    return turnFromL1(spec, this.stream.snapshot(), { ...this.stream.c, ...(spec.config ?? {}) });
  }
  summarize(window: TimeWindow): FeatureMap {
    const l1 = this.stream.snapshot();
    const inW = <T extends { t: number }>(xs: T[]) => xs.filter((x) => x.t >= window.from && x.t < window.to);
    const raw = inW(l1.raw), cl = inW(l1.cleanedTimes);
    const expected = Math.max(1, Math.round(((window.to - window.from) * this.stream.c.hz) / 1000));
    const fx = l1.fixations.filter((f) => f.t0 >= window.from && f.t0 < window.to);
    let away = 0;
    for (const g of l1.gaps) if (g.kind === "offscreen" || g.kind === "noface") away += Math.max(0, Math.min(g.t1, window.to) - Math.max(g.t0, window.from));
    return {
      "gaze.quality": Math.min(1, cl.length / expected),
      "gaze.faceFrac": raw.length ? raw.filter((r) => r.face).length / raw.length : 0,
      "gaze.fixations": fx.length,
      "gaze.meanFixMs": fx.length ? fx.reduce((s, f) => s + (f.t1 - f.t0), 0) / fx.length : 0,
      "gaze.awayMs": away,
    };
  }
  clear(before: number): void { this.stream.clear(before); }
}
