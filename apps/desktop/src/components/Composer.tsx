import { CornerDownLeftIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "../lib";

// Rounded dock shell (rounded-2xl card) with a growing textarea and the square-ish send button,
// concentric radii like LearnHarness: 16px shell - 6px padding = 10px button.
export function Composer({
  value, onChange, onSend, busy, telemetryRef, placeholder = "Say anything…",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  /** native beforeinput/input listeners (telemetry.ts) */
  telemetryRef?: (el: HTMLTextAreaElement | null) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = !busy && value.trim().length > 0;
  // don't auto-focus on touch devices: it would pop the soft keyboard over the chat on every turn
  useEffect(() => { if (!busy && !matchMedia("(pointer: coarse)").matches) ref.current?.focus(); }, [busy]);
  const setRef = useCallback((el: HTMLTextAreaElement | null) => {
    ref.current = el;
    telemetryRef?.(el);
  }, [telemetryRef]);
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
          ref={setRef}
          rows={1}
          enterKeyHint="send"
          value={value}
          // locked while the Director is busy (request start -> reply complete or error, incl. the thinking phase and an
          // empty-completion retry): no typing, paste, IME or drop can land before completeAt (typing.* start there).
          // readOnly, not disabled: the field keeps focus and the soft keyboard stays up between turns
          readOnly={busy}
          aria-busy={busy || undefined}
          data-composer-locked={busy ? "true" : undefined}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends (the iOS return key is labelled "send" via enterKeyHint); Shift+Enter = newline
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          className="eeg-input max-h-48 min-h-10 flex-1 pointer-coarse:min-h-11 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
        />
        <button type="submit" aria-label="Send" disabled={!canSend} className={cn("flex size-10 pointer-coarse:size-11 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40")}>
          <CornerDownLeftIcon className="size-5" />
        </button>
      </form>
    </div>
  );
}
