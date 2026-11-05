/**
 * E6: the injection animation. When a waiting note goes out with Send, a line runs from its card
 * ([data-ad-card]) to the composer ([data-ad-composer]) and the composer edge pulses. Under Reduce Motion the
 * line doesn't travel: it fades in and out in place ("ad-fade"). Only rendered in tab_visible sessions.
 */
import { useEffect, useLayoutEffect, useState } from "react";

export function usePrefersReducedMotion(override?: boolean): boolean {
  const q = "(prefers-reduced-motion: reduce)";
  const [r, setR] = useState(() => override ?? (typeof matchMedia === "function" ? matchMedia(q).matches : false));
  useEffect(() => {
    if (override !== undefined) { setR(override); return; }
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(q); const on = () => setR(m.matches);
    m.addEventListener("change", on); return () => m.removeEventListener("change", on);
  }, [override]);
  return r;
}

const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function InjectionLine({ from, active, reduceMotion, hold }: { from: string | null; active: boolean; reduceMotion: boolean; /** screenshots: keep the line on screen */ hold?: boolean }) {
  const [geo, setGeo] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  useIsoLayout(() => {
    if (!active || !from || typeof document === "undefined") { setGeo(null); return; }
    const a = document.querySelector(`[data-ad-card="${from}"]`)?.getBoundingClientRect();
    const b = document.querySelector("[data-ad-composer]")?.getBoundingClientRect();
    if (!a || !b) { setGeo(null); return; }
    setGeo({ x1: a.left, y1: a.top + a.height / 2, x2: b.left + b.width / 2, y2: b.top });
  }, [from, active]);
  const cls = reduceMotion ? "ad-fade" : "ad-travel";
  return (
    <svg className="pointer-events-none fixed inset-0 z-30 size-full" aria-hidden data-ad-injection={active ? cls : "idle"} data-ad-motion={reduceMotion ? "reduce" : "full"}>
      {active && geo && (
        <g className={hold ? `${cls} ad-hold` : cls}>
          <path d={`M ${geo.x1} ${geo.y1} C ${geo.x1 - 80} ${geo.y1}, ${geo.x2} ${geo.y2 - 120}, ${geo.x2} ${geo.y2}`} fill="none" stroke="var(--signal)" strokeWidth="2" pathLength={1} className="ad-path" />
          {!reduceMotion && <circle r="4" fill="var(--signal)" className="ad-runner" style={{ offsetPath: `path("M ${geo.x1} ${geo.y1} C ${geo.x1 - 80} ${geo.y1}, ${geo.x2} ${geo.y2 - 120}, ${geo.x2} ${geo.y2}")` } as React.CSSProperties} />}
        </g>
      )}
    </svg>
  );
}
