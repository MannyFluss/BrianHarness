import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib";
import { BLIND_CHOICES } from "../rating";

// LearnHarness-style 1-5 tap row: square-ish keys, concentric radii, muted end labels.
// [data-rating-option] / [data-rating-probe]: the bug-report flight recorder never reads these controls' value,
// label, checked state or position (feedback/snapshot.ts ratingHidden), in study and practice alike.
export function ScaleRow({ value, onPick, size = "md" }: { value: number | null; onPick: (v: number) => void; size?: "sm" | "md" }) {
  return (
    <div className="flex flex-col gap-1">
      <div role="radiogroup" aria-label="Absorption, 1 to 5" className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={value === v}
            data-rating-option
            onClick={() => onPick(v)}
            className={cn(
              "eeg-tap flex items-center justify-center rounded-[10px] border font-ui tabular-nums transition-colors",
              size === "sm" ? "h-9 min-w-9 flex-1 text-sm md:h-8 md:min-w-8" : "h-11 min-w-11 flex-1 text-base",
              value === v ? "border-signal bg-signal/15 text-foreground" : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="flex justify-between px-0.5 text-[11px] text-muted-foreground/70"><span>not at all</span><span>completely</span></div>
    </div>
  );
}

/** Inline per-turn probe under the Director's message. One tap logs; typing dismisses it. */
export function TurnProbe({ onRate, onSkip }: { onRate: (v: number) => void; onSkip: () => void }) {
  return (
    <div data-rating-probe="turn" className="eeg-enter w-full max-w-[22rem] rounded-2xl border border-border/70 bg-card/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm text-foreground">How absorbed are you right now?</span>
        <button onClick={onSkip} aria-label="Skip" className="eeg-tap flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-3.5" /></button>
      </div>
      <ScaleRow size="sm" value={null} onPick={onRate} />
    </div>
  );
}

export type SessionRatingResult = { value: number | null; answeredAt: number | null; hooked: string; blindGuess: "adaptive" | "baseline" | "no-idea" | null };

/**
 * End-of-session card: "Overall, how absorbed were you?" (1-5), optional "What hooked you?" and,
 * in Phase D study sessions only, the blinding check. Centered card on desktop/iPad, bottom sheet
 * on iPhone. Closing it any way (Done, Skip, backdrop) reports what was filled in.
 */
export function SessionRatingCard({ open, study, phone, onClose, stateRef }: { open: boolean; study: boolean; phone: boolean; onClose: (r: SessionRatingResult, how: "done" | "skip") => void; stateRef?: React.MutableRefObject<SessionRatingResult | null> }) {
  const [value, setValue] = useState<number | null>(null);
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
  const [hooked, setHooked] = useState("");
  const [blind, setBlind] = useState<SessionRatingResult["blindGuess"]>(null);
  const latest = useRef<SessionRatingResult>({ value: null, answeredAt: null, hooked: "", blindGuess: null });
  latest.current = { value, answeredAt, hooked, blindGuess: blind };
  if (stateRef) stateRef.current = open ? latest.current : null; // read by the pagehide logger
  useEffect(() => {
    if (open) { setValue(null); setAnsweredAt(null); setHooked(""); setBlind(null); }
  }, [open]);
  if (!open) return null;
  const close = (how: "done" | "skip") => onClose(latest.current, how);
  return (
    <>
      <button aria-label="Skip rating" onClick={() => close("skip")} className="fixed inset-0 z-[60] bg-black/55" />
      <div
        role="dialog"
        aria-label="Rate this session"
        data-rating-probe="session"
        className={cn(
          "fixed z-[61] flex flex-col gap-4 border bg-background p-5 shadow-2xl shadow-black/70",
          phone
            ? "inset-x-0 bottom-0 rounded-t-2xl border-t pb-[max(1.25rem,env(safe-area-inset-bottom))]"
            : "left-1/2 top-1/2 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl",
        )}
      >
        {phone && <span className="mx-auto -mt-2 h-1 w-10 rounded-full bg-border" />}
        <div className="flex items-start justify-between gap-3">
          <span className="font-title text-2xl tracking-tight">Overall, how absorbed were you?</span>
          <button onClick={() => close("skip")} aria-label="Skip" className="eeg-tap -mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-4" /></button>
        </div>
        <ScaleRow value={value} onPick={(v) => { setValue(v); setAnsweredAt(Date.now()); }} />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-widest text-muted-foreground/70">What hooked you? <span className="normal-case tracking-normal">(optional)</span></span>
          <textarea value={hooked} onChange={(e) => setHooked(e.target.value)} rows={2} maxLength={2000} className="eeg-prose resize-none rounded-[10px] border border-border bg-card px-3 py-2 text-[15px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-signal" placeholder="A topic, a question, nothing…" />
        </label>
        {study && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs uppercase tracking-widest text-muted-foreground/70">Which session do you think this was?</span>
            <div role="radiogroup" aria-label="Blinding check" className="flex gap-1.5">
              {BLIND_CHOICES.map((c) => (
                <button key={c.id} role="radio" aria-checked={blind === c.id} data-blind={c.id} onClick={() => setBlind(c.id)} className={cn("eeg-tap h-10 flex-1 rounded-[10px] border text-sm transition-colors", blind === c.id ? "border-signal bg-signal/15 text-foreground" : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground")}>{c.label}</button>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={() => close("skip")} className="eeg-tap h-10 rounded-[10px] px-4 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">Skip</button>
          <button onClick={() => close("done")} data-rating-done className="eeg-tap h-10 rounded-[10px] bg-foreground px-5 text-sm font-medium text-background disabled:opacity-40" disabled={value === null && !hooked.trim() && !blind}>Done</button>
        </div>
      </div>
    </>
  );
}
