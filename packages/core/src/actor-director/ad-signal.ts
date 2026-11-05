/**
 * E6 (ruling 1): GazeSource as a signal source WITHOUT touching protocol-4 signals.ts. `AdSignalSource` is the
 * SignalSource shape with a wider `kind`; `asSignalSource()` gives the thin adapter. Structural typing makes it
 * assignable wherever the harness only uses push/summarize/clear. Adding "gaze" to SignalSource["kind"] in
 * signals.ts is on the contract-v2 backlog (needs approval).
 */
import type { FeatureMap } from "../types.js";
import type { SignalSource, TimeWindow } from "../signals.js";
import type { GazeSource } from "./gaze-stream.js";

export interface AdSignalSource extends Omit<SignalSource, "kind"> {
  readonly kind: SignalSource["kind"] | "gaze";
}
export function asSignalSource(g: GazeSource): AdSignalSource {
  return {
    id: g.id,
    kind: "gaze",
    push: (sample: unknown) => g.push(sample),
    summarize: (w: TimeWindow): FeatureMap => g.summarize(w),
    clear: (before: number) => g.clear(before),
  };
}
