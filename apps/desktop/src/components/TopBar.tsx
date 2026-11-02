import { ActivityIcon, PanelLeftOpenIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib";

export function TopBar({ sidebarOpen, onOpenSidebar, hudOpen, onToggleHud, children }: { sidebarOpen: boolean; onOpenSidebar: () => void; hudOpen: boolean; onToggleHud: () => void; children?: ReactNode }) {
  return (
    <header className={cn("eeg-drag eeg-wco-gutter eeg-safe-top flex h-15 shrink-0 select-none items-center gap-3 border-b border-border px-3", !sidebarOpen && "eeg-lights-gutter")}>
      {!sidebarOpen && (
        <button onClick={onOpenSidebar} aria-label="Open sidebar" className="eeg-tap flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <PanelLeftOpenIcon className="size-4" />
        </button>
      )}
      <div className="min-w-0 flex-1 truncate">{children}</div>
      <button
        onClick={onToggleHud}
        aria-pressed={hudOpen}
        title="Director HUD (Ctrl+H)"
        aria-label="Director HUD"
        className={cn("eeg-tap flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider transition-colors", hudOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
      >
        <ActivityIcon className="size-3.5" /> HUD
      </button>
    </header>
  );
}
