// Keystroke telemetry for the composer. Records the CLASS of each edit (insert, delete,
// paste, nav) plus the resulting length and a timestamp. Never records which key was hit.
import { useCallback, useRef } from "react";
import type { TypingEvent } from "./bridge";

export function classifyInput(inputType: string): TypingEvent["kind"] {
  if (inputType.startsWith("delete")) return "delete";
  if (inputType === "insertFromPaste" || inputType === "insertFromDrop") return "paste";
  return "insert";
}

export function useTypingTelemetry() {
  const events = useRef<TypingEvent[]>([]);
  const onInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const ne = e.nativeEvent as InputEvent;
    events.current.push({ t: Date.now(), kind: classifyInput(ne.inputType ?? "insertText"), len: e.currentTarget.value.length });
  }, []);
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
      events.current.push({ t: Date.now(), kind: "nav", len: e.currentTarget.value.length });
    }
  }, []);
  const take = useCallback((finalLen: number) => {
    const out = [...events.current, { t: Date.now(), kind: "submit" as const, len: finalLen }];
    events.current = [];
    return out;
  }, []);
  const inject = useCallback((evs: TypingEvent[]) => {
    events.current.push(...evs);
  }, []);
  return { onInput, onKeyDown, take, inject, events };
}
