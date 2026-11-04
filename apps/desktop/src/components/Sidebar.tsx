import { BugIcon, PanelLeftCloseIcon, PlusIcon, XIcon } from "lucide-react";
import type { Info, SessionItem } from "../bridge";
import { cn } from "../lib";
import { Mark } from "./Mark";
import { ModelPicker } from "./ModelPicker";
import { StudyData } from "./StudyData";
import { AppleSignInRow } from "./AppleSignIn";
import { BRAND_NAME } from "../brand";

function when(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// column: collapsible left column (iPad landscape / Mac). drawer: slide-over with a backdrop (iPhone).
/** a row's accessible name: date + turns only (never the title, which is the user's own text: it would reach the
 * flight recorder's tap / screen events, and a study session's title is never recorded) */
export function sessionRowLabel(s: Pick<SessionItem, "startedAt" | "turns" | "active">, viewing: boolean): string {
  const meta = `${when(s.startedAt) || "undated"}, ${s.turns} ${s.turns === 1 ? "turn" : "turns"}`;
  return s.active ? `Current chat, ${meta}` : `${viewing ? "Viewing past chat" : "Open past chat"}, ${meta}`;
}

// onOpenSession: tap a row = open that past session read-only (the current row = back to the live chat).
// openLocked: a study session is in progress (or a reply / rating step is showing): past rows are disabled.
export function Sidebar({ open, sessions, info, onNew, onClose, onInfo, pickerRef, onReport, variant = "column", onOpenSession, viewingId = null, openLocked = null }: { open: boolean; sessions: SessionItem[]; info: Info | null; onNew: () => void; onClose: () => void; onInfo: (i: Info) => void; pickerRef?: React.MutableRefObject<(() => void) | null>; onReport?: () => void; variant?: "column" | "drawer"; onOpenSession?: (s: SessionItem) => void; viewingId?: string | null; openLocked?: string | null }) {
  const drawer = variant === "drawer";
  return (
    <>
    {drawer && <button aria-label="Close sidebar" tabIndex={open ? 0 : -1} onClick={onClose} className={cn("fixed inset-0 z-40 bg-black/50 transition-opacity", open ? "opacity-100" : "pointer-events-none opacity-0")} />}
    <aside
      aria-hidden={drawer && !open}
      className={cn(
        drawer
          ? cn("fixed inset-y-0 left-0 z-50 w-[min(20rem,85vw)] shadow-2xl shadow-black/70 transition-transform duration-200", open ? "translate-x-0" : "pointer-events-none -translate-x-full")
          : cn("shrink-0 overflow-hidden transition-[width] duration-200", open ? "w-72" : "w-0"),
      )}
    >
      <div className={cn("flex h-full flex-col border-r bg-background", drawer ? "w-full pl-[env(safe-area-inset-left)]" : "w-72")}>
        <div className="eeg-drag eeg-lights-gutter eeg-safe-top flex h-15 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-md text-foreground"><Mark className="size-6" /></span>
            <span className="font-title text-xl tracking-tight">{BRAND_NAME}</span>
          </div>
          <button onClick={onClose} aria-label="Close sidebar" className="eeg-tap flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            {drawer ? <XIcon className="size-4" /> : <PanelLeftCloseIcon className="size-4" />}
          </button>
        </div>
        <div className="mx-3 mb-2 mt-3 flex flex-col gap-1.5">
          <button onClick={onNew} className="eeg-tap-row flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <PlusIcon className="size-3" /> New chat
          </button>
        </div>
        <div className="mx-3 mb-2 flex items-center gap-2">
          <span className="text-xs uppercase tracking-widest text-muted-foreground/70">Sessions</span>
          <span className="h-px flex-1 bg-border/60" />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 && <div className="px-2 py-4 text-xs text-muted-foreground">No sessions yet.</div>}
          {openLocked && sessions.some((s) => !s.active) && <div role="note" data-sessions-locked className="px-2 pb-2 text-xs text-muted-foreground">{openLocked}</div>}
          {sessions.map((s) => {
            const body = (
              <>
                <span className="block truncate font-prose text-[16px] text-foreground">{s.title}</span>
                <span className="block text-xs text-muted-foreground">{when(s.startedAt)} · {s.turns} {s.turns === 1 ? "turn" : "turns"}</span>
              </>
            );
            const viewing = viewingId === s.id;
            const selected = viewingId ? viewing : s.active;
            if (!onOpenSession) return <div key={s.id} className={cn("mb-0.5 flex w-full flex-col justify-center rounded-lg px-3 py-2", s.active && "bg-accent")}>{body}</div>;
            const locked = !!openLocked && !s.active;
            return (
              <button key={s.id} type="button" data-session-row={s.active ? "current" : "past"} aria-label={sessionRowLabel(s, viewing)} aria-current={selected ? "true" : undefined}
                disabled={locked} onClick={() => onOpenSession(s)}
                className={cn("eeg-tap-row mb-0.5 flex w-full flex-col items-stretch justify-center rounded-lg px-3 py-2 text-left transition-colors", selected ? "bg-accent" : "hover:bg-accent/60", locked && "cursor-not-allowed opacity-50 hover:bg-transparent")}>
                {body}
              </button>
            );
          })}
        </div>
        <div className="border-t border-border/60 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
          <StudyData />
          <AppleSignInRow />
          {onReport && (
            <button onClick={onReport} data-feedback-row aria-label="Report a problem" className="eeg-tap-row flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <BugIcon className="size-3" /> Report
            </button>
          )}
          <ModelPicker info={info} onChanged={onInfo} openRef={pickerRef} />
        </div>
      </div>
    </aside>
    </>
  );
}
