import { PanelLeftCloseIcon, PlusIcon } from "lucide-react";
import type { Info, SessionItem } from "../bridge";
import { cn } from "../lib";
import { Mark } from "./Mark";
import { ModelPicker } from "./ModelPicker";
import { BRAND_NAME } from "../brand";

function when(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function Sidebar({ open, sessions, info, onNew, onClose, onInfo, pickerRef }: { open: boolean; sessions: SessionItem[]; info: Info | null; onNew: () => void; onClose: () => void; onInfo: (i: Info) => void; pickerRef?: React.MutableRefObject<(() => void) | null> }) {
  return (
    <aside className={cn("shrink-0 overflow-hidden transition-[width] duration-200", open ? "w-72" : "w-0")}>
      <div className="flex h-full w-72 flex-col border-r bg-background">
        <div className="eeg-drag eeg-lights-gutter flex h-15 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-md text-foreground"><Mark className="size-6" /></span>
            <span className="font-title text-xl tracking-tight">{BRAND_NAME}</span>
          </div>
          <button onClick={onClose} aria-label="Close sidebar" className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <PanelLeftCloseIcon className="size-4" />
          </button>
        </div>
        <div className="mx-3 mb-2 mt-3 flex flex-col gap-1.5">
          <button onClick={onNew} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <PlusIcon className="size-3" /> New chat
          </button>
        </div>
        <div className="mx-3 mb-2 flex items-center gap-2">
          <span className="text-xs uppercase tracking-widest text-muted-foreground/70">Sessions</span>
          <span className="h-px flex-1 bg-border/60" />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 && <div className="px-2 py-4 text-xs text-muted-foreground">No sessions yet.</div>}
          {sessions.map((s) => (
            <div key={s.id} className={cn("mb-0.5 flex w-full flex-col rounded-lg px-3 py-2 transition-colors", s.active ? "bg-accent" : "hover:bg-accent/60")}>
              <span className="block truncate font-prose text-[16px] text-foreground">{s.title}</span>
              <span className="block text-xs text-muted-foreground">{when(s.startedAt)} · {s.turns} {s.turns === 1 ? "turn" : "turns"}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-border/60 px-3 pb-3 pt-2">
          <ModelPicker info={info} onChanged={onInfo} openRef={pickerRef} />
        </div>
      </div>
    </aside>
  );
}
