/**
 * I5: a robust interface-orientation detector. WKWebView fires no `resize` on a landscape_left <-> landscape_right
 * rotation (same width x height), so the web layer listens to every source and dedupes:
 *   - screen.orientation "change"
 *   - matchMedia("(orientation: landscape)") / "(orientation: portrait)" change
 *   - window "orientationchange" and "resize"
 *   - a low-rate poll (default 1 s) of screen.orientation.type, falling back to window.orientation
 *   - a native push: the gaze plugin's `status` event carrying `orientation` (contract-v1.4, optional)
 * onChange gets a ScreenInfo once per distinct (orientation, width x height); repeats from several sources are dropped.
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

export function watchOrientation(o: {
  env: OrientationEnv;
  /** builds the ScreenInfo from (w, h, orientation type): boot.tsx webScreen */
  read: (w: number, h: number, type: string | null) => ScreenInfo;
  onChange: (screen: ScreenInfo, source: string) => void;
  /** the screen the session started with (not reported) */
  initial?: ScreenInfo;
  pollMs?: number;
}): { stop(): void; native(orientation: Orientation): void; check(source?: string): void } {
  const { env } = o;
  let native: Orientation | null = null;
  const key = (s: ScreenInfo) => `${s.orientation}|${s.webview.width}x${s.webview.height}`;
  let last = o.initial ? key(o.initial) : null;
  let lastWeb: Orientation | null = o.initial?.orientation ?? null;
  const check = (source = "check") => {
    let s = o.read(env.win.innerWidth, env.win.innerHeight, orientationType(env));
    // the web sources saw a change of their own: they win over an older native push
    if (lastWeb !== null && s.orientation !== lastWeb) native = null;
    lastWeb = s.orientation;
    // a native-pushed orientation is authoritative while it agrees with the aspect (a stale push after the next
    // portrait/landscape flip is ignored)
    if (native && isLandscape(native) === isLandscape(s.orientation)) s = { ...s, orientation: native };
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
    native(orientation) { native = orientation; check("native"); },
    check,
  };
}
/** the browser's environment (null outside a browser) */
export function browserOrientationEnv(): OrientationEnv | null {
  if (typeof window === "undefined") return null;
  const so = typeof screen !== "undefined" && "orientation" in screen ? (screen.orientation as unknown as OrientationEnv["screenOrientation"]) : null;
  return { win: window as unknown as OrientationEnv["win"], screenOrientation: so, setInterval: (cb, ms) => setInterval(cb, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
}
