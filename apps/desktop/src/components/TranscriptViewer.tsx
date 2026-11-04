import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import type { SessionTranscript } from "../transport/types";
import { Message } from "./Message";

function when(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A past session, read-only: no composer, nothing sent or logged. "Back to current chat" returns to the live
 * session exactly as it was; "New chat" ends the live session the usual way (rating card first) and starts one. */
export function TranscriptViewer({ t, onBack, onNew }: { t: SessionTranscript; onBack: () => void; onNew: () => void }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-transcript-viewer>
      <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-secondary/40 px-4 py-2 text-xs text-muted-foreground">
        <span className="uppercase tracking-wider">Past chat · read-only{t.startedAt ? ` · ${when(t.startedAt)}` : ""}</span>
        <span className="flex-1" />
        <button type="button" onClick={onBack} aria-label="Back to current chat" className="eeg-tap flex items-center gap-1 rounded-md px-2 py-1.5 uppercase tracking-wider transition-colors hover:bg-accent hover:text-foreground">
          <ArrowLeftIcon className="size-3" /> Current chat
        </button>
        <button type="button" onClick={onNew} aria-label="New chat" className="eeg-tap flex items-center gap-1 rounded-md bg-accent px-2 py-1.5 uppercase tracking-wider text-foreground transition-colors hover:bg-accent/80">
          <PlusIcon className="size-3" /> New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-4 pb-16 pt-6 md:px-6 md:pt-8" data-transcript-past>
          {t.turns.length === 0 && <div className="text-sm text-muted-foreground">Nothing was said in this chat.</div>}
          {t.turns.map((m, i) => <Message key={i} msg={{ id: `past${i}`, role: m.role, text: m.text, ...(m.cutOff ? { cutOff: true } : {}) }} />)}
        </div>
      </div>
    </div>
  );
}
