// Capacitor detection for the web entry. In the native iOS app (Capacitor 8, CapacitorHttp enabled
// globally) window.fetch is a native request: no WebView CORS, so Ollama Cloud can be enabled.
// In a plain browser / PWA there is no Capacitor object and nothing changes.
import type { InProcessOptions } from "./in-process";

type CapWindow = { Capacitor?: { isNativePlatform?: () => boolean }; fetch: typeof fetch };

export function isNativeCapacitor(win: unknown = globalThis): boolean {
  try {
    return !!(win as CapWindow).Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

/**
 * Options for createInProcessTransport from the current window. Native: nativeFetch on, and a
 * late-bound fetchImpl (always calls the CURRENT window.fetch, i.e. CapacitorHttp's patch).
 */
export function nativeTransportOptions(win: unknown = globalThis): Pick<InProcessOptions, "nativeFetch" | "fetchImpl"> {
  if (!isNativeCapacitor(win)) return {};
  const w = win as CapWindow;
  return { nativeFetch: true, fetchImpl: (input, init) => w.fetch(input, init) };
}
