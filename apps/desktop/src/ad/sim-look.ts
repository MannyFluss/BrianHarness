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
