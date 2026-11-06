/**
 * contract-v1.5 Mac Pointer capture: interactive-AOI pointer evidence only.
 *
 * Emits pointer_click | pointer_select | pointer_hover | pointer_dwell with ids p<k>. Dwell ≥ pointer_config.dwell_ms
 * on the same interactive AOI; gaps ≤ merge_gap_ms are merged. Batches as pointer_l1 (≤5 s, ≤20 events). Never emits
 * hover/dwell on non-interactive paragraphs or the composer; never invents coordinates or gaze-style reading labels.
 */
import {
  DEFAULT_POINTER_CONFIG, POINTER_EXCLUDED_AOIS, POINTER_L1_MAX_EVENTS, POINTER_L1_MAX_WINDOW_MS,
  PARAGRAPH_AOI_PATTERN, pointerEventViolation, type PointerConfig, type PointerDigestItem, type PointerEvent, type PointerKind,
} from "../ad-contracts/index.js";

export interface PointerTarget { aoi: string; msg: string; excerpt: string }
const PARA_RE = new RegExp(PARAGRAPH_AOI_PATTERN);

export function isPointerTargetAoi(aoi: string, interactive: ReadonlySet<string>): boolean {
  if (POINTER_EXCLUDED_AOIS.includes(aoi) || PARA_RE.test(aoi)) return false;
  return interactive.has(aoi);
}

/** pure dwell merge: intervals on one AOI with gaps ≤ mergeGapMs collapse; returns merged contiguous ms */
export function mergedDwellMs(spans: ReadonlyArray<[number, number]>, mergeGapMs: number): number {
  if (!spans.length) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let t0 = sorted[0]![0], t1 = sorted[0]![1];
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i]!;
    if (a - t1 <= mergeGapMs) t1 = Math.max(t1, b);
    else { total += t1 - t0; t0 = a; t1 = b; }
  }
  return total + (t1 - t0);
}

interface OpenDwell {
  aoi: string;
  spans: Array<[number, number]>;
  /** null while the pointer is on the AOI; set on leave (gap clock) */
  lastLeave: number | null;
  hovered: boolean;
}

export class PointerCapture {
  readonly cfg: PointerConfig;
  private interactive = new Set<string>();
  private targets = new Map<string, PointerTarget>();
  private nextId = 1;
  private open: OpenDwell | null = null;
  private pending: PointerEvent[] = [];
  private window: PointerEvent[] = [];
  private windowT0: number | null = null;
  private digestBuf: PointerEvent[] = [];
  private emitBatch: ((b: { t0: number; t1: number; events: PointerEvent[] }) => void) | null = null;

  constructor(cfg: PointerConfig = DEFAULT_POINTER_CONFIG, o: { onBatch?: (b: { t0: number; t1: number; events: PointerEvent[] }) => void; firstId?: number } = {}) {
    this.cfg = cfg;
    this.emitBatch = o.onBatch ?? null;
    if (o.firstId && o.firstId > 0) this.nextId = o.firstId;
  }

  setInteractive(targets: readonly PointerTarget[]): void {
    this.interactive = new Set(targets.map((t) => t.aoi));
    this.targets = new Map(targets.map((t) => [t.aoi, t]));
  }
  interactiveSet(): ReadonlySet<string> { return this.interactive; }
  excerptOf(aoi: string): string { return this.targets.get(aoi)?.excerpt ?? aoi; }

  private alloc(kind: PointerKind, aoi: string, t0: number, t1: number, dwell_ms?: number): PointerEvent | null {
    if (!isPointerTargetAoi(aoi, this.interactive)) return null;
    const msg = this.targets.get(aoi)?.msg ?? aoi.split(".")[0]!;
    const e: PointerEvent = { id: `p${this.nextId++}`, kind, aoi, msg, t0, t1, ...(dwell_ms !== undefined ? { dwell_ms } : {}) };
    if (pointerEventViolation(e, this.interactive, this.cfg)) return null;
    this.push(e);
    return e;
  }
  private push(e: PointerEvent): void {
    this.pending.push(e);
    this.digestBuf.push(e);
    if (this.windowT0 === null) this.windowT0 = e.t0;
    this.window.push(e);
    const span = e.t1 - this.windowT0;
    if (this.window.length >= POINTER_L1_MAX_EVENTS || span >= POINTER_L1_MAX_WINDOW_MS) this.flushBatch();
  }
  flushBatch(): { t0: number; t1: number; events: PointerEvent[] } | null {
    if (!this.window.length || this.windowT0 === null) return null;
    const events = this.window.slice(0, POINTER_L1_MAX_EVENTS);
    const t0 = this.windowT0;
    const t1 = Math.max(t0, events[events.length - 1]!.t1);
    this.window = this.window.slice(events.length);
    this.windowT0 = this.window.length ? this.window[0]!.t0 : null;
    const batch = { t0, t1, events };
    this.emitBatch?.(batch);
    return batch;
  }
  flushAllBatches(): Array<{ t0: number; t1: number; events: PointerEvent[] }> {
    const out: Array<{ t0: number; t1: number; events: PointerEvent[] }> = [];
    for (;;) { const b = this.flushBatch(); if (!b) break; out.push(b); }
    return out;
  }

  /** finalize the open dwell if any (emit when ≥ threshold); clears open */
  private finalize(t: number): PointerEvent | null {
    const o = this.open;
    if (!o) return null;
    if (o.lastLeave === null) {
      const last = o.spans[o.spans.length - 1];
      if (last) last[1] = Math.max(last[1], t);
    }
    const ms = mergedDwellMs(o.spans, this.cfg.merge_gap_ms);
    this.open = null;
    if (ms < this.cfg.dwell_ms) return null;
    const t0 = o.spans[0]![0];
    return this.alloc("pointer_dwell", o.aoi, t0, t0 + ms, Math.round(ms));
  }

  enter(aoi: string, t: number): PointerEvent | null {
    if (!isPointerTargetAoi(aoi, this.interactive)) {
      this.finalize(t);
      return null;
    }
    // resume same AOI within merge gap (no new hover)
    if (this.open && this.open.aoi === aoi && this.open.lastLeave !== null && t - this.open.lastLeave <= this.cfg.merge_gap_ms) {
      this.open.lastLeave = null;
      this.open.spans.push([t, t]);
      return null;
    }
    // different AOI, or gap too long: close previous
    if (this.open) this.finalize(t);
    this.open = { aoi, spans: [[t, t]], lastLeave: null, hovered: true };
    return this.alloc("pointer_hover", aoi, t, t);
  }

  leave(aoi: string, t: number): PointerEvent | null {
    if (!this.open || this.open.aoi !== aoi) return null;
    const last = this.open.spans[this.open.spans.length - 1];
    if (last && this.open.lastLeave === null) last[1] = Math.max(last[1], t);
    this.open.lastLeave = t;
    // dwell is emitted only when the gap expires (enter elsewhere / finalize) or at closeWindow —
    // so a brief leave-and-return within merge_gap can still merge. For leave-without-return past the
    // threshold we emit on the next finalize; call sites that need an immediate dwell after a long
    // stay should call tick then finalize via closeWindow / enter(other).
    return null;
  }

  /** keep the open span's end at `t` while the pointer stays on the AOI */
  tick(t: number): void {
    if (!this.open || this.open.lastLeave !== null) return;
    const last = this.open.spans[this.open.spans.length - 1];
    if (last) last[1] = Math.max(last[1], t);
  }

  click(aoi: string, t: number): PointerEvent | null {
    if (!this.open || this.open.aoi !== aoi || this.open.lastLeave !== null) this.enter(aoi, t);
    return this.alloc("pointer_click", aoi, t, t);
  }
  select(aoi: string, t: number): PointerEvent | null {
    return this.alloc("pointer_select", aoi, t, t);
  }

  /** end of reading window: close open dwell, flush batches, return digest items (≤24, newest last) */
  closeWindow(t: number): { batches: Array<{ t0: number; t1: number; events: PointerEvent[] }>; pointer: PointerDigestItem[] } {
    this.finalize(t);
    const batches = this.flushAllBatches();
    const items = this.digestBuf.slice(-24).map((e) => ({
      id: e.id, kind: e.kind, aoi: e.aoi, excerpt: this.excerptOf(e.aoi),
      ...(e.kind === "pointer_dwell" && e.dwell_ms !== undefined ? { dwell_ms: e.dwell_ms } : {}),
    }));
    this.digestBuf = [];
    return { batches, pointer: items };
  }
  takePending(): PointerEvent[] { const p = this.pending; this.pending = []; return p; }
}

/** empty attention digest for pointer / none modes (no gaze reading labels) */
export function emptyModeDigest(msg: string, windowMs: number, mode: "pointer" | "none", pointer: PointerDigestItem[] = []) {
  return {
    msg, windowMs: Math.max(0, Math.round(windowMs)), quality: 1, qualityLabel: "good" as const,
    paras: [], lookBacks: [], offscreenMs: 0, composerPauses: 0, events: [] as string[],
    input_mode: mode, ...(mode === "pointer" ? { pointer: pointer.slice(-24) } : { pointer: [] as PointerDigestItem[] }),
  };
}
