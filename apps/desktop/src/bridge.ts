// The renderer talks to the harness ONLY through bridge(). Which transport is behind it is
// decided at startup: main.tsx (Electron) uses window.eeg; main.web.tsx installs the in-process one.
import type { EegBridge } from "./transport/types";
export * from "./transport/types";

declare global {
  interface Window {
    eeg?: EegBridge;
    __eegDemo?: { type(text: string): Promise<void>; draft(text: string): void; openPicker(): void; probe?(): void; endSession?(): void };
    /** dev/debug builds only (import.meta.env.DEV or localStorage bh.debug=1) */
    __bhStudy?: { hash(): Promise<string | null>; unseal(confirm: string): Promise<unknown> };
  }
}

let current: EegBridge | null = null;
export function setTransport(t: EegBridge) {
  current = t;
}
export const bridge = (): EegBridge => {
  const t = current ?? window.eeg;
  if (!t) throw new Error("No harness transport: run inside Electron (npm run desktop) or the web build (npm run dev:web)");
  return t;
};
