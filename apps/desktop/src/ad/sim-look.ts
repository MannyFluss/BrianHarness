/**
 * contract-v1.4: the iOS-SIMULATOR calibration aid. Reachable only from a simulator build: Calibration.tsx calls it
 * behind `__BH_AD_SIM__` (true for `vite` serve and `AD_SIM_BUILD=1 vite build`), so a device build strips this module
 * and has no path to a native plugin's lookAt (tools/ad/check_device_build.mjs looks for the call and SIM_LOOK_AID).
 * Support is an explicit capability: the tracker's status mode is "synthetic". Never `typeof` (a Capacitor plugin
 * proxy returns a function for every property) and never `in` (no `has` trap). The call takes one options object
 * {x, y} (a Capacitor call passes a single options object). A rejected call is swallowed: the aid is never a
 * dependency. The JS synthetic tracker goes first.
 */
import { simLookAt } from "@brianharness/core/actor-director/browser";
import type { GazeTracker } from "@brianharness/core/ad-contracts";

/** marker string kept in a simulator bundle (and absent from a device bundle) */
export const SIM_LOOK_AID = "bh-ad-sim-look/1" as const;
export type SimLook = ((x: number, y: number) => void) & { aid: typeof SIM_LOOK_AID };

export async function nativeSimLookAt(tracker: GazeTracker | null | undefined): Promise<SimLook | undefined> {
  const synthetic = simLookAt(tracker);
  if (synthetic) return Object.assign(synthetic, { aid: SIM_LOOK_AID });
  if (!tracker) return undefined;
  const status = await Promise.resolve().then(() => tracker.getStatus()).catch(() => null);
  if (status?.mode !== "synthetic") return undefined;
  const fn = (x: number, y: number) => {
    try { const r = tracker.lookAt?.({ x, y }); if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {}); } catch { /* aid only */ }
  };
  return Object.assign(fn, { aid: SIM_LOOK_AID });
}

/** I5b: marker kept by the sim-only reading walker (absent from a device bundle; tools/ad/check_device_build.mjs) */
export const SIM_WALK_AID = "bh-ad-sim-walk/1" as const;
/** I5b: the timers playSimLook uses (tests pass fakes) */
export interface SimLookTimers { set(cb: () => void, ms: number): unknown; clear(h: unknown): void }
const realTimers: SimLookTimers = { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * I5b: a sample path (core demoReadingPath, ~30 Hz with a few px of jitter) as fixations: consecutive samples within
 * `radiusPt` of the fixation's first sample are one fixation at their mean, starting at the first sample's t. The
 * native synthetic player adds its own jitter, so one lookAt per fixation (a few per second), not one per sample.
 */
export function simLookFixations(path: Array<{ t: number; x: number | null; y: number | null }>, radiusPt = 10): Array<{ t: number; x: number; y: number; ms: number }> {
  const out: Array<{ t: number; x: number; y: number; ms: number; n: number; x0: number; y0: number }> = [];
  for (const s of path) {
    if (s.x === null || s.y === null) continue;
    const f = out[out.length - 1];
    if (f && Math.abs(s.x - f.x0) <= radiusPt && Math.abs(s.y - f.y0) <= radiusPt) { f.x += (s.x - f.x) / (f.n + 1); f.y += (s.y - f.y) / (f.n + 1); f.n++; f.ms = s.t - f.t + 1000 / 30; continue; }
    out.push({ t: s.t, x: s.x, y: s.y, ms: 1000 / 30, n: 1, x0: s.x, y0: s.y });
  }
  const t0 = out[0]?.t ?? 0;
  return out.map((f) => ({ t: f.t - t0, x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10, ms: f.ms }));
}

/**
 * I5b: walk a reading path on a tracker with the sim lookAt capability: lookAt at each fixation's start time, then
 * the eyes rest at `hold` (as SyntheticGazeTracker.play's hold). Returns stop(), which cancels the rest of the walk.
 */
export function playSimLook(look: SimLook, path: Array<{ t: number; x: number | null; y: number | null }>, hold: { x: number; y: number } | null, timers: SimLookTimers = realTimers): (() => void) & { aid: typeof SIM_WALK_AID } {
  const fix = simLookFixations(path);
  const steps = fix.map((f) => ({ t: f.t, x: f.x, y: f.y }));
  const end = fix.length ? fix[fix.length - 1]!.t + fix[fix.length - 1]!.ms : 0;
  if (hold) steps.push({ t: end, x: hold.x, y: hold.y });
  let i = 0, handle: unknown = null, stopped = false, at = 0;
  const step = () => {
    handle = null;
    while (!stopped && i < steps.length && steps[i]!.t <= at) { const s = steps[i++]!; look(s.x, s.y); }
    if (stopped || i >= steps.length) return;
    const wait = steps[i]!.t - at;
    at = steps[i]!.t;
    handle = timers.set(step, wait);
  };
  step();
  return Object.assign(() => { stopped = true; if (handle !== null) timers.clear(handle); handle = null; }, { aid: SIM_WALK_AID });
}
