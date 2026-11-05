/**
 * contract-v1.3 (ruling B2): the iOS-SIMULATOR calibration aid. Reachable only from a simulator build: Calibration.tsx
 * calls it behind `__BH_AD_SIM__` (true for `vite` serve and `AD_SIM_BUILD=1 vite build`), so a device build strips
 * this module and has no path to a native plugin's lookAt (checked by tools/ad/check_device_build.mjs).
 * Detects with typeof (a Capacitor plugin proxy has no `has` trap, so `"lookAt" in proxy` is false while `get` returns a
 * method wrapper). A rejected call is swallowed: the aid is never a dependency. The JS synthetic tracker goes first.
 */
import { simLookAt } from "@brianharness/core/actor-director/browser";
import type { GazeTracker } from "@brianharness/core/ad-contracts";

export function nativeSimLookAt(tracker: GazeTracker | null | undefined): ((x: number, y: number) => void) | undefined {
  const synthetic = simLookAt(tracker);
  if (synthetic) return synthetic;
  if (!tracker || typeof tracker.lookAt !== "function") return undefined;
  return (x, y) => {
    try { const r = tracker.lookAt!(x, y); if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {}); } catch { /* aid only */ }
  };
}
