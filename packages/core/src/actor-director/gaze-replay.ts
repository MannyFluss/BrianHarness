/**
 * E5: replay a contract-v1 GazeReplayFile (bh-gaze-replay/1, LOCAL ONLY: raw samples never go into an upload)
 * through the streaming GazeSource the way the app would see it: ~100 ms batches, composer-tap anchors delivered
 * shortly after they happen, one closeTurn() at the end. No ground truth is read here; R2's *.truth.json
 * sidecars are only for scoring (scripts/ad-r2-replay.ts).
 */
import { layoutPpd, median, type Anchor, type Aoi, type Layout, type RawSample, type TurnSpec, type GazeConfig } from "./gaze-ref.js";
import { GazeSource, type StreamConfig } from "./gaze-stream.js";

export interface ReplayOptions {
  /** samples per delivery batch, as the plugin sends them (~100 ms at 30 Hz = 3) */
  batchMs?: number;
  /** composer-tap drift correction on/off */
  driftCorrection?: boolean;
  /** delay between a tap and its anchor reaching core (ms, < anchor_hold_ms) */
  anchorLatencyMs?: number;
  config?: Partial<StreamConfig & GazeConfig>;
  onL1?: (body: Record<string, unknown>) => void;
}
/**
 * px/deg must be known before the stream starts. Use turn.dist_cm if the app has it (calibration), else the median
 * head distance of the samples before the reading window opens (causal), else the layout default (R1 A-9).
 */
export function streamPpd(layout: Layout, samples: RawSample[], spec: { dist_cm?: number | null; open_t: number }): number {
  if (spec.dist_cm) return layoutPpd(layout, spec.dist_cm);
  const pre = samples.filter((s) => s.t < spec.open_t && s.head?.distCm).map((s) => s.head!.distCm!);
  return layoutPpd(layout, pre.length ? median(pre) : null);
}
export function replayTurn(samples: RawSample[], spec: TurnSpec & { aois: Aoi[]; anchors?: Anchor[] }, o: ReplayOptions = {}) {
  const ppd = streamPpd(spec.layout, samples, spec);
  const src = new GazeSource({ ppd, viewport: { w: spec.layout.viewport_w, h: spec.layout.viewport_h },
    config: { ...(o.config ?? {}), drift_correction: o.driftCorrection ?? true }, ...(o.onL1 ? { onL1: o.onL1 } : {}) });
  src.setAois(spec.aois);
  const ss = [...samples].sort((a, b) => a.t - b.t);
  const anchors = [...(spec.anchors ?? [])].sort((a, b) => a.t - b.t);
  const lat = o.anchorLatencyMs ?? 100, step = o.batchMs ?? 100;
  let i = 0, ai = 0;
  const t0 = ss.length ? ss[0]!.t : 0;
  for (let w = t0 + step; i < ss.length; w += step) {
    const batch: RawSample[] = [];
    while (i < ss.length && ss[i]!.t < w) batch.push(ss[i++]!);
    if (batch.length) src.push(batch);
    while (ai < anchors.length && anchors[ai]!.t + lat <= w) src.anchor(anchors[ai++]!);
  }
  while (ai < anchors.length) src.anchor(anchors[ai++]!);
  const out = src.closeTurn({ ...spec, anchors: [] });
  src.stream.flush();
  return { out, ppd, stats: src.stream.stats };
}
