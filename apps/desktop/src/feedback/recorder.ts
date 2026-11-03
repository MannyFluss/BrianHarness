// The app's one flight recorder (ring buffer of 200 events) and its UI-layer hooks: screen snapshots, taps on
// named controls, window errors. The transport adds chat / backend-state / native-plugin events (in-process.ts).
// Hooks only read the DOM: they never change what the user sees, the study, timing or the session log.
import { FlightRecorder } from "@brianharness/core/browser";
import { controlName, screenSnapshot, studyHidden, overlaysOf } from "./snapshot";

export const flightRecorder = new FlightRecorder();

/** study session in progress (set by the App from hud.study): snapshots / taps skip the blinding-check choice */
let inStudy = false;
export const setRecorderStudy = (v: boolean) => { inStudy = v; flightRecorder.study = v; };
export const recorderInStudy = () => inStudy;

export function installErrorHooks(win: Window, rec: FlightRecorder = flightRecorder): () => void {
  const onError = (e: ErrorEvent) => rec.record("error", { source: "window.onerror", message: String(e.message ?? e.error?.message ?? "error").slice(0, 300), where: e.filename ? `${e.filename.split("/").pop()}:${e.lineno}:${e.colno}` : undefined });
  const onRejection = (e: PromiseRejectionEvent) => {
    const r = e.reason as { message?: unknown; code?: unknown } | undefined;
    rec.record("error", { source: "unhandledrejection", message: String(r?.message ?? r ?? "rejection").slice(0, 300), ...(typeof r?.code === "string" ? { code: r.code } : {}) });
  };
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  return () => { win.removeEventListener("error", onError); win.removeEventListener("unhandledrejection", onRejection); };
}

const TAPPABLE = "button, [role='button'], [role='radio'], [role='switch'], a[href], select, input[type='checkbox'], [data-feedback-name]";
/** taps on named controls only (aria-label / data-* / short text); in study the blinding-check choice is anonymized */
export function installTapRecorder(doc: Document, rec: FlightRecorder = flightRecorder): () => void {
  const onClick = (e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.(TAPPABLE);
    if (!el) return;
    if (inStudy && studyHidden(el)) { rec.record("tap", { name: "blinding-check option", control: "radio", screen: overlaysOf(doc).at(-1) ?? "chat" }); return; }
    if (el.closest("[data-blind]")) { rec.record("tap", { name: "blinding-check option", control: "radio", screen: overlaysOf(doc).at(-1) ?? "chat" }); return; }
    const name = controlName(el);
    if (!name) return;
    rec.record("tap", { name, control: el.getAttribute("role") ?? el.tagName.toLowerCase(), screen: overlaysOf(doc).at(-1) ?? "chat" });
  };
  doc.addEventListener("click", onClick, true);
  return () => doc.removeEventListener("click", onClick, true);
}

/** a `screen` event whenever what's on screen settles into something new (debounced; identical snapshots skipped) */
let active: { snapshotNow(): void } | null = null;
/** record the current screen right now (Report: the screen as it was when the sheet opened) */
export const snapshotScreenNow = () => active?.snapshotNow();
export function installScreenRecorder(doc: Document, rec: FlightRecorder = flightRecorder, debounceMs = 600): { stop(): void; snapshotNow(): void } {
  const win = doc.defaultView!;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSig = "";
  const snap = () => {
    timer = null;
    try {
      const s = screenSnapshot(doc, { inStudy, win });
      const sig = JSON.stringify(s);
      if (sig === lastSig) return;
      lastSig = sig;
      rec.record("screen", s as unknown as Record<string, unknown>);
    } catch { /* never break the app */ }
  };
  const kick = () => { if (!timer) timer = setTimeout(snap, debounceMs); };
  const mo = new MutationObserver((muts) => { if (muts.some((m) => !(m.target as Element).closest?.("[data-feedback-sheet]") || m.type === "childList")) kick(); });
  mo.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-hidden", "aria-checked", "aria-pressed", "data-busy", "data-streaming", "data-layout", "disabled"], characterData: true });
  win.addEventListener("resize", kick);
  kick();
  const api = {
    stop() { mo.disconnect(); win.removeEventListener("resize", kick); if (timer) clearTimeout(timer); if (active === api) active = null; },
    snapshotNow() { if (timer) clearTimeout(timer); snap(); },
  };
  active = api;
  return api;
}
