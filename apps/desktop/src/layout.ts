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

/** Track the visual viewport so the composer stays above the iOS soft keyboard (sets --app-h). */
export function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => document.documentElement.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    set();
    vv.addEventListener("resize", set);
    return () => vv.removeEventListener("resize", set);
  }, []);
}
