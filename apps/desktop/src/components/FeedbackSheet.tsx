import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { cn } from "../lib";
import type { FeedbackSendResult } from "../transport/types";

export type FeedbackSheetPhase = { kind: "idle" } | { kind: "sending" } | { kind: "done"; result: FeedbackSendResult };

export function resultText(r: FeedbackSendResult): string {
  if (r.state === "sent") return "Report sent. Thank you!";
  const why = r.status === 404 ? "the report server isn't live yet" : r.queued ? "it couldn't be sent right now" : "the server didn't accept it";
  if (r.state === "exported") return `Saved as a file instead (${why})${r.queued ? "; it will also upload later" : ""}.`;
  if (r.state === "queued") return "Couldn't send yet; it will upload automatically later.";
  return `Couldn't send or save the report (${why}).`;
}

// The Report sheet: optional note + Send. Opening it doesn't pause, end or start anything (no session, timing or
// study change); the app only logs that it was open (feedback_open / feedback_sent / feedback_closed).
export function FeedbackSheet({ open, phone, phase, onSend, onClose }: { open: boolean; phone: boolean; phase: FeedbackSheetPhase; onSend: (note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setNote(""); setTimeout(() => ref.current?.focus({ preventScroll: true }), 0); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const sending = phase.kind === "sending";
  const done = phase.kind === "done" ? phase.result : null;
  return (
    <>
      <button aria-label="Close report" data-feedback-backdrop onClick={() => !sending && onClose()} className="fixed inset-0 z-[70] bg-black/55" />
      <div
        role="dialog"
        aria-label="Report a problem"
        data-feedback-sheet
        className={cn(
          "fixed z-[71] flex flex-col gap-3 border bg-background p-5 shadow-2xl shadow-black/70",
          phone ? "inset-x-0 bottom-0 rounded-t-2xl border-t pb-[max(1.25rem,env(safe-area-inset-bottom))]" : "left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="font-title text-2xl tracking-tight">Report a problem</span>
          <button onClick={onClose} disabled={sending} aria-label="Cancel report" data-feedback-cancel className="eeg-tap -mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-4" /></button>
        </div>
        {!done && (
          <>
            <span className="text-sm text-muted-foreground">Sends the app's recent activity log (what was on screen, taps, reply status and errors; no keys or tokens) and the last few messages.</span>
            <textarea ref={ref} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} data-feedback-note disabled={sending}
              aria-label="What went wrong? (optional)" placeholder="What went wrong? (optional)"
              className="resize-none rounded-[10px] border border-border bg-card px-3 py-2 text-[16px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-signal" />
          </>
        )}
        {done && <div role="status" data-feedback-status data-state={done.state} data-http-status={done.status ?? ""} className={cn("rounded-md px-3 py-2 text-sm", done.state === "sent" ? "bg-signal/10 text-foreground" : "bg-amber-400/10 text-amber-200")}>{resultText(done)}</div>}
        {sending && <div role="status" data-feedback-status data-state="sending" className="text-sm text-muted-foreground">Sending…</div>}
        <div className="flex justify-end gap-2">
          {!done && <button onClick={onClose} disabled={sending} className="eeg-tap h-10 rounded-[10px] px-4 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">Cancel</button>}
          {!done && <button onClick={() => onSend(note)} disabled={sending} data-feedback-send className="eeg-tap h-10 rounded-[10px] bg-foreground px-5 text-sm font-medium text-background disabled:opacity-40">Send</button>}
          {done && <button onClick={onClose} data-feedback-done className="eeg-tap h-10 rounded-[10px] bg-foreground px-5 text-sm font-medium text-background">Done</button>}
        </div>
      </div>
    </>
  );
}
