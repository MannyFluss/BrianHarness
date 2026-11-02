// Responsive layout modes. phone: < 768px wide (iPhone portrait ~390x844): sidebar = slide-over
// drawer, HUD = bottom sheet. tablet/desktop (iPad landscape ~1180x820, Mac): 3 columns with a
// collapsible sidebar and HUD.
import { useEffect, useState } from "react";

export type LayoutMode = "phone" | "tablet" | "desktop";
const PHONE = "(max-width: 767px)";
const TABLET = "(min-width: 768px) and (max-width: 1279px)";

const read = (): LayoutMode => (matchMedia(PHONE).matches ? "phone" : matchMedia(TABLET).matches ? "tablet" : "desktop");

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(read);
  useEffect(() => {
    const qs = [matchMedia(PHONE), matchMedia(TABLET)];
    const on = () => setMode(read());
    qs.forEach((q) => q.addEventListener("change", on));
    return () => qs.forEach((q) => q.removeEventListener("change", on));
  }, []);
  return mode;
}

/**
 * Pin the app to the *visual* viewport so the header stays put and the composer stays above the iOS soft
 * keyboard. With Capacitor's default keyboard handling (and Safari) the layout viewport does not shrink: iOS
 * scrolls the page up by visualViewport.offsetTop instead, which slid the header under the status bar.
 * .eeg-app is position:fixed at top = --app-top (offsetTop), height = --app-h (visual height), and the
 * document itself never scrolls (any scroll iOS applies is undone). Works with Keyboard resize "native"/"body"
 * too (offsetTop stays 0, height follows the shrunken webview).
 */
export function viewportVars(vv: { height: number; offsetTop: number }): { "--app-h": string; "--app-top": string } {
  return { "--app-h": `${Math.round(vv.height)}px`, "--app-top": `${Math.max(0, Math.round(vv.offsetTop))}px` };
}

export function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const set = () => {
      for (const [k, v] of Object.entries(viewportVars(vv))) root.style.setProperty(k, v);
    };
    // the layout viewport must not scroll under the fixed app (iOS does it when focusing the composer)
    const unscroll = () => {
      if (window.scrollY !== 0 && vv.offsetTop === 0) window.scrollTo(0, 0);
      set();
    };
    set();
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
    window.addEventListener("scroll", unscroll, { passive: true });
    return () => {
      vv.removeEventListener("resize", set);
      vv.removeEventListener("scroll", set);
      window.removeEventListener("scroll", unscroll);
    };
  }, []);
}
