import { CornerDownLeftIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../lib";

// Rounded dock shell (rounded-2xl card) with a growing textarea and the square-ish send button,
// concentric radii like LearnHarness: 16px shell - 6px padding = 10px button.
export function Composer({
  value, onChange, onSend, busy, onInput, onKeyDown, placeholder = "Say anything…",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  onInput: (e: React.FormEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = !busy && value.trim().length > 0;
  useEffect(() => { if (!busy) ref.current?.focus(); }, [busy]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(192, el.scrollHeight)}px`;
  }, [value]);
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-lg">
      <form className="flex items-end gap-1.5 p-1.5" onSubmit={(e) => { e.preventDefault(); if (canSend) onSend(); }}>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onInput={onInput}
          onKeyDown={(e) => {
            onKeyDown(e);
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          className="eeg-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
        />
        <button type="submit" aria-label="Send" disabled={!canSend} className={cn("flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40")}>
          <CornerDownLeftIcon className="size-5" />
        </button>
      </form>
    </div>
  );
}
