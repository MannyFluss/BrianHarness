/**
 * I5: a robust interface-orientation detector. WKWebView fires no `resize` on a landscape_left <-> landscape_right
 * rotation (same width x height), so the web layer listens to every source and dedupes:
 *   - screen.orientation "change"
 *   - matchMedia("(orientation: landscape)") / "(orientation: portrait)" change
 *   - window "orientationchange" and "resize"
 *   - a low-rate poll (default 1 s) of screen.orientation.type, falling back to window.orientation
 *   - a native push: the gaze plugin's `status` event carrying `orientation` (contract-v1.4, optional)
 * onChange gets a ScreenInfo once per distinct (orientation, width x height); repeats from several sources are dropped.
 *
 * I5b (IOS Dev, native 2d66504), contract-v1.4.1 clarification:
 *   - names follow NATIVE UIInterfaceOrientation. In iOS WKWebView `landscape-primary` (window.orientation 90) is
 *     landscapeRight, so on iOS primary -> landscape_right and secondary -> landscape_left (landscapeName).
 *   - a native-pushed orientation is the source of truth whenever present: a differing web reading never overrides
 *     it. The web sources still report size changes and are the orientation fallback only while there is no native
 *     orientation. If the aspect contradicts the native orientation (portrait vs landscape: a rotation whose native
 *     push is still in flight), nothing is reported for up to `nativeGraceMs` (default 2 s); only if native stays
 *     silent that long does the web reading take over, until the next native push.
 */
import type { Orientation, ScreenInfo } from "@brianharness/core/ad-contracts";

type Listenable = { addEventListener(t: string, cb: () => void): void; removeEventListener(t: string, cb: () => void): void };
type MediaList = Listenable & { matches: boolean };
export interface OrientationEnv {
  win: Listenable & { innerWidth: number; innerHeight: number; orientation?: number; matchMedia?: (q: string) => MediaList };
  /** screen.orientation when the browser has it */
  screenOrientation: (Listenable & { type?: string }) | null;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}
/** screen.orientation.type, else the legacy window.orientation angle mapped to the same names (iOS WKWebView) */
export function orientationType(env: Pick<OrientationEnv, "win" | "screenOrientation">): string | null {
  const t = env.screenOrientation?.type;
  if (t) return t;
  const a = env.win.orientation;
  if (typeof a !== "number") return null;
  return a === 90 ? "landscape-primary" : a === -90 || a === 270 ? "landscape-secondary" : a === 180 ? "portrait-secondary" : "portrait-primary";
}
const isLandscape = (o: Orientation) => o === "landscape_left" || o === "landscape_right";

/**
 * iOS WKWebView under Capacitor: the Capacitor platform ("ios"), else the iOS-only BHGaze plugin being available.
 * No user-agent guessing. Outside Capacitor (browser dev server, Electron, node tests) -> false.
 */
export function isIosWebView(g: unknown = globalThis): boolean {
  const cap = (g as { Capacitor?: { getPlatform?: () => string; isPluginAvailable?: (name: string) => boolean } } | null)?.Capacitor;
  if (!cap) return false;
  try { const p = cap.getPlatform?.(); if (typeof p === "string" && p) return p === "ios"; } catch { /* fall through */ }
  try { return cap.isPluginAvailable?.("BHGaze") === true; } catch { return false; }
}
/** the landscape contract name for a screen.orientation type (native naming: on iOS primary = landscapeRight) */
export function landscapeName(type: string | null, ios: boolean): "landscape_left" | "landscape_right" {
  const secondary = type === "landscape-secondary";
  return ios ? (secondary ? "landscape_left" : "landscape_right") : secondary ? "landscape_right" : "landscape_left";
}

export function watchOrientation(o: {
  env: OrientationEnv;
  /** builds the ScreenInfo from (w, h, orientation type): boot.tsx webScreen */
  read: (w: number, h: number, type: string | null) => ScreenInfo;
  onChange: (screen: ScreenInfo, source: string) => void;
  /** the screen the session started with (not reported) */
  initial?: ScreenInfo;
  /** the native orientation at start (e.g. getStatus().orientation or the plugin's ScreenInfo), when known */
  initialNative?: Orientation | null;
  pollMs?: number;
  /** how long an aspect that contradicts the native orientation waits for the native push (default 2000 ms) */
  nativeGraceMs?: number;
  now?: () => number;
}): { stop(): void; native(orientation: Orientation): void; check(source?: string): void; nativeOrientation(): Orientation | null } {
  const { env } = o;
  const now = o.now ?? (() => Date.now());
  const grace = o.nativeGraceMs ?? 2000;
  let native: { o: Orientation; at: number } | null = o.initialNative ? { o: o.initialNative, at: now() } : null;
  let contra: number | null = null;
  const key = (s: ScreenInfo) => `${s.orientation}|${s.webview.width}x${s.webview.height}`;
  let last = o.initial ? key(o.initial) : null;
  const check = (source = "check") => {
    const web = o.read(env.win.innerWidth, env.win.innerHeight, orientationType(env));
    let s = web;
    if (native) {
      if (isLandscape(native.o) === isLandscape(web.orientation)) { contra = null; s = { ...web, orientation: native.o }; }
      else {
        // the aspect says the device turned portrait <-> landscape but native has not pushed yet: wait for it
        const t = now();
        contra ??= t;
        if (t - Math.max(contra, native.at) < grace) return;
        native = null; contra = null; // native stayed silent: the web reading is the fallback until the next push
      }
    }
    const k = key(s);
    if (k === last) return;
    last = k;
    o.onChange(s, source);
  };
  const handlers: Array<[Listenable, string, () => void]> = [];
  const on = (t: Listenable | null | undefined, ev: string, source: string) => { if (!t) return; const cb = () => check(source); t.addEventListener(ev, cb); handlers.push([t, ev, cb]); };
  on(env.screenOrientation, "change", "screen.orientation");
  for (const q of ["(orientation: landscape)", "(orientation: portrait)"]) { try { on(env.win.matchMedia?.(q), "change", "matchMedia"); } catch { /* old engines */ } }
  on(env.win, "orientationchange", "orientationchange");
  on(env.win, "resize", "resize");
  const timer = env.setInterval(() => check("poll"), o.pollMs ?? 1000);
  return {
    stop() { env.clearInterval(timer); for (const [t, ev, cb] of handlers) t.removeEventListener(ev, cb); handlers.length = 0; },
    native(orientation) { native = { o: orientation, at: now() }; contra = null; check("native"); },
    check,
    nativeOrientation: () => native?.o ?? null,
  };
}
/** the browser's environment (null outside a browser) */
export function browserOrientationEnv(): OrientationEnv | null {
  if (typeof window === "undefined") return null;
  const so = typeof screen !== "undefined" && "orientation" in screen ? (screen.orientation as unknown as OrientationEnv["screenOrientation"]) : null;
  return { win: window as unknown as OrientationEnv["win"], screenOrientation: so, setInterval: (cb, ms) => setInterval(cb, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
}
