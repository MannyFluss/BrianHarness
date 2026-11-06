/**
 * Step 3 dogfood: Pointer overlay — outlines active interactive AOIs and lists recent p* evidence.
 * Never rendered for blinded sessions (caller must pass show=false); toggle is dogfood-only.
 */
import type { PointerDebug } from "./controller";

const KIND_SHORT: Record<string, string> = {
  pointer_hover: "hover",
  pointer_dwell: "dwell",
  pointer_click: "click",
  pointer_select: "select",
};

export function PointerOverlay({
  show, debug, jsonlHint,
}: {
  show: boolean;
  debug: PointerDebug | null;
  /** absolute or relative path shown in the footer when mirroring H1 JSONL */
  jsonlHint?: string | null;
}) {
  if (!show || !debug) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[45]" data-ad-pointer-overlay="on" aria-hidden>
      {debug.interactive.map((b) => (
        <div
          key={b.aoi}
          data-ad-pointer-aoi={b.aoi}
          className="ad-pointer-aoi absolute box-border border-2 border-signal/80 bg-signal/10"
          style={{ left: b.x, top: b.y, width: Math.max(2, b.w), height: Math.max(2, b.h) }}
          title={b.excerpt || b.aoi}
        >
          <span className="absolute -top-4 left-0 whitespace-nowrap rounded bg-background/90 px-1 font-mono text-[9px] text-signal">{b.aoi}</span>
        </div>
      ))}
      <div
        className="pointer-events-none absolute bottom-3 left-3 max-h-40 max-w-sm overflow-hidden rounded-md border border-border/80 bg-background/90 p-2 font-mono text-[10px] text-muted-foreground shadow-lg backdrop-blur-sm"
        data-ad-pointer-recent
      >
        <div className="mb-1 text-[9px] uppercase tracking-widest text-signal/80">Pointer evidence (p*)</div>
        {debug.recent.length === 0
          ? <div className="opacity-60">No p* yet — hover/click a chip</div>
          : [...debug.recent].reverse().slice(0, 12).map((e) => (
            <div key={`${e.id}-${e.t0}`} data-ad-pointer-ev={e.id} className="truncate">
              <span className="text-signal">{e.id}</span>{" "}
              {KIND_SHORT[e.kind] ?? e.kind}{" "}
              <span className="opacity-80">{e.aoi}</span>
              {e.dwell_ms !== undefined ? ` ${e.dwell_ms}ms` : ""}
            </div>
          ))}
        {jsonlHint && (
          <div className="mt-1 truncate border-t border-border/50 pt-1 text-[9px] opacity-70" data-ad-pointer-jsonl-path title={jsonlHint}>
            JSONL: {jsonlHint}
          </div>
        )}
      </div>
    </div>
  );
}

/** TopBar dogfood toggle — only mount for tab_visible + pointer */
export function PointerOverlayToggle({ on, setOn }: { on: boolean; setOn: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => setOn(!on)}
      aria-pressed={on}
      className={`eeg-tap rounded-sm px-2 py-1 text-[10px] uppercase tracking-wider ${on ? "bg-signal/20 text-signal" : "text-muted-foreground hover:bg-accent"}`}
      data-ad-pointer-overlay-toggle={on ? "on" : "off"}
      title="Dogfood: outline interactive AOIs and recent p* evidence"
    >
      Overlay {on ? "on" : "off"}
    </button>
  );
}
