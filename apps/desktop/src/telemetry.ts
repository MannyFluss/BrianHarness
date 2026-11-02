// Composer telemetry. Records the CLASS of each edit (insert, delete, paste, nav), the resulting
// length, a timestamp and, when known, the INPUT SOURCE. Never records which key was hit or the text.
//
// Uses native `beforeinput` + `input` (inputType works for hardware keys, the iOS soft keyboard,
// autocorrect, predictive text, IME composition and paste) instead of key events, which soft
// keyboards don't deliver reliably. What iOS can't give us:
//   - no per-key timing for autocorrect / predictive-bar picks / dictation: they arrive as ONE
//     multi-character insert (we record chars>1 and source autocorrect|predictive|composition)
//   - dictation is indistinguishable from a predictive pick (both: multi-char insertText, no keydown)
//   - keydown on the soft keyboard often has key "Unidentified"/keyCode 229, so no key identity
//   - whether a hardware keyboard is attached is only inferred (arrow/Tab/Escape/modifier keys seen)
import { useCallback, useRef } from "react";
import type { InputSource, TypingEvent } from "./bridge";

export function classifyInput(inputType: string): TypingEvent["kind"] {
  if (inputType.startsWith("delete")) return "delete";
  if (inputType === "insertFromPaste" || inputType === "insertFromDrop") return "paste";
  return "insert";
}

const HARDWARE_ONLY_KEYS = /^(Arrow|Tab$|Escape$|Meta$|Control$|Alt$|F\d+$|Home$|End$|PageUp$|PageDown$)/;

export interface SourceState {
  lastKeyAt: number;
  lastKeyHardware: boolean;
  sawHardwareKeys: boolean;
  touchDevice: boolean;
}

/** Pure classifier (unit-testable): beforeinput inputType + context -> input source. */
export function classifySource(inputType: string, data: string | null, isComposing: boolean, now: number, st: SourceState): InputSource {
  if (inputType === "insertFromPaste" || inputType === "insertFromPasteAsQuotation") return "paste";
  if (inputType === "insertFromDrop") return "drop";
  if (inputType === "insertReplacementText") return "autocorrect";
  if (isComposing || inputType === "insertCompositionText" || inputType === "deleteCompositionText") return "composition";
  if (inputType === "insertFromDictation") return "dictation";
  const keyed = now - st.lastKeyAt < 150;
  const multi = (data?.length ?? 0) > 1;
  if (keyed && !multi) {
    if (st.lastKeyHardware || (!st.touchDevice && st.lastKeyAt > 0)) return "hardware-key";
    return st.sawHardwareKeys ? "hardware-key" : "soft-keyboard";
  }
  if (multi && inputType === "insertText") return "predictive"; // or dictation; iOS doesn't say which
  if (st.touchDevice) return "soft-keyboard";
  return keyed ? "hardware-key" : "unknown";
}

export function useTypingTelemetry() {
  const events = useRef<TypingEvent[]>([]);
  const st = useRef<SourceState>({ lastKeyAt: 0, lastKeyHardware: false, sawHardwareKeys: false, touchDevice: typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 0 });
  const pending = useRef<{ source: InputSource; chars?: number; prevLen: number } | null>(null);
  const detach = useRef<(() => void) | null>(null);

  /** callback ref for the composer <textarea> */
  const attach = useCallback((el: HTMLTextAreaElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      const s = st.current;
      // soft keyboards report 229 / "Unidentified"; real keys have identities
      const identified = e.key !== "Unidentified" && e.keyCode !== 229;
      if (HARDWARE_ONLY_KEYS.test(e.key) || e.metaKey || e.ctrlKey || e.altKey) s.sawHardwareKeys = true;
      s.lastKeyAt = now;
      s.lastKeyHardware = identified && (!s.touchDevice || s.sawHardwareKeys);
      if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") events.current.push({ t: now, kind: "nav", len: el.value.length, source: "hardware-key" });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") st.current.touchDevice = true;
    };
    const onBeforeInput = (e: InputEvent) => {
      const source = classifySource(e.inputType ?? "insertText", e.data ?? null, e.isComposing, Date.now(), st.current);
      pending.current = { source, chars: e.data ? e.data.length : undefined, prevLen: el.value.length };
    };
    const onInput = (e: Event) => {
      const ie = e as InputEvent;
      const inputType = ie.inputType ?? "insertText";
      const p = pending.current ?? { source: classifySource(inputType, ie.data ?? null, ie.isComposing, Date.now(), st.current), prevLen: el.value.length, chars: undefined };
      pending.current = null;
      const len = el.value.length;
      const kind = classifyInput(inputType);
      const chars = kind === "delete" ? undefined : (p.chars ?? Math.max(1, len - p.prevLen));
      events.current.push({ t: Date.now(), kind, len, source: p.source, ...(chars !== undefined && chars !== 1 ? { chars } : {}) });
    };
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("beforeinput", onBeforeInput as EventListener);
    el.addEventListener("input", onInput);
    detach.current = () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("beforeinput", onBeforeInput as EventListener);
      el.removeEventListener("input", onInput);
    };
  }, []);

  const take = useCallback((finalLen: number) => {
    const out = [...events.current, { t: Date.now(), kind: "submit" as const, len: finalLen }];
    events.current = [];
    return out;
  }, []);
  const inject = useCallback((evs: TypingEvent[]) => {
    events.current.push(...evs.map((e) => ({ source: "programmatic" as const, ...e })));
  }, []);
  return { attach, take, inject, events };
}
