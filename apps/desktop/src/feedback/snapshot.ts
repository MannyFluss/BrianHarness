// "Text version of video": what is on screen right now, from the existing aria-* / data-* labels. Used for the
// flight recorder's `screen` events and the snapshot taken when Report opens. Study sessions: the HUD and the
// blinding-check choice are never read; the rating UI (1-5 probe + session rating) is never read beyond a generic
// "rating option" in ANY session; the report builder additionally drops plan/mode/rating fields (flight-recorder.ts).
import { FEEDBACK_TEXT_CAP } from "@brianharness/core/browser";

export type ScreenControl = { label: string; control: string; value?: string; disabled?: true; pressed?: boolean; checked?: boolean };
export type ScreenMessage = { role: "user" | "assistant"; text: string; streaming?: true; cutOff?: true; failed?: true };
export type ScreenSnapshot = { screen: string; overlays: string[]; layout: string | null; busy: boolean; title: string | null; controls: ScreenControl[]; messages: ScreenMessage[]; notices: string[] };

const SECRETISH = /key|token|password|secret|bhd_|sk-/i;
const cap = (s: string, n = FEEDBACK_TEXT_CAP) => (s.length > n ? `${s.slice(0, n)}…` : s);
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** an element counts as visible: laid out, inside the viewport, not under aria-hidden="true" */
export function isVisible(el: Element, win: Window): boolean {
  if (el.closest("[aria-hidden='true']")) return false;
  const r = (el as HTMLElement).getBoundingClientRect?.();
  if (!r || (r.width === 0 && r.height === 0)) return false;
  return r.bottom > 0 && r.top < win.innerHeight && r.right > 0 && r.left < win.innerWidth;
}

/** a control's name: aria-label, title, a data-* marker, or its own short text */
export function controlName(el: Element): string | null {
  const a = clean(el.getAttribute("aria-label")) || clean(el.getAttribute("data-feedback-name")) || clean(el.getAttribute("title"));
  if (a) return cap(a, 80);
  const t = clean((el as HTMLElement).innerText ?? el.textContent);
  if (t && t.length <= 80) return t;
  const ph = clean(el.getAttribute("placeholder"));
  if (ph) return cap(ph, 80);
  const d = [...el.attributes].map((x) => x.name).find((n) => n.startsWith("data-") && !/^data-(state|streaming|busy)/.test(n));
  return d ? d.slice(5) : t ? cap(t, 80) : null;
}

/** the absorption rating UI (per-turn probe, session rating card incl. its 1-5 row, "What hooked you?" and the
 * blinding check): NEVER read beyond a generic label, in study and practice alike (Researcher blinding check) */
export const RATING_SCOPE = "[data-rating-probe], [data-rating-option], [data-blind], [aria-label='Blinding check']";
export const ratingHidden = (el: Element) => !!el.closest(RATING_SCOPE);
/** the generic stand-in for a control inside the rating UI: no value, name, aria-label, checked/selected state or index */
export function ratingControl(el: Element): { label: string; control: string } {
  if (el.closest("[data-blind], [aria-label='Blinding check']")) return { label: "blinding-check option", control: "radio" };
  if (el.closest("[data-rating-option]") || el.getAttribute("role") === "radio") return { label: "rating option", control: "radio" };
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "input") return { label: "rating text field", control: tag };
  // Skip / Done / the backdrop: generic too (Done's label is fixed, but its disabled state says whether a value was picked)
  return { label: "rating control", control: el.getAttribute("role") ?? tag };
}
/** inside a control whose value must never be recorded during a study session (plus the rating UI, always) */
export const studyHidden = (el: Element) => ratingHidden(el) || !!el.closest("[aria-label='Director HUD'], [data-hud]");

export function overlaysOf(doc: Document): string[] {
  const o: string[] = [];
  const open = (sel: string) => { const el = doc.querySelector(sel); return !!el && !el.closest("[aria-hidden='true']") && el.getAttribute("aria-hidden") !== "true"; };
  if (doc.documentElement.dataset.sidebarDrawer === "open") o.push("sidebar");
  if (open("[role='dialog'][aria-label='Director HUD']")) o.push("hud-sheet");
  if (open("[data-model-picker-dialog], [role='dialog'][aria-label*='model' i]")) o.push("model-picker");
  if (open("[data-siwa-screen]")) o.push("sign-in");
  if (open("[data-rating-probe='session']")) o.push("session-rating");
  if (open("[data-rating-probe='turn']")) o.push("turn-probe");
  if (open("[data-feedback-sheet]")) o.push("report");
  return o;
}

export function screenSnapshot(doc: Document, o: { inStudy: boolean; win?: Window }): ScreenSnapshot {
  const win = o.win ?? doc.defaultView!;
  const overlays = overlaysOf(doc);
  const app = doc.querySelector(".eeg-app");
  const controls: ScreenControl[] = [];
  for (const el of doc.querySelectorAll("button, input, textarea, select, [role='radio'], [role='button'], [role='switch'], a[href]")) {
    if (controls.length >= 60) break;
    if (!isVisible(el, win) || (el.classList.contains("fixed") && el.classList.contains("inset-0"))) continue; // backdrops
    if (ratingHidden(el)) { controls.push(ratingControl(el)); continue; } // study and practice
    if (o.inStudy && studyHidden(el)) continue; // the HUD
    const label = controlName(el);
    if (!label) continue;
    const c: ScreenControl = { label, control: el.getAttribute("role") ?? el.tagName.toLowerCase() };
    const input = el as HTMLInputElement;
    if ((el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && /^(text|search|number|url|)$/.test(input.type ?? ""))) && typeof input.value === "string" && input.value) {
      c.value = SECRETISH.test(`${label} ${el.getAttribute("placeholder") ?? ""}`) ? "[hidden]" : cap(input.value, 200);
    }
    if (input.type === "password") c.value = input.value ? "[hidden]" : "";
    if ((el as HTMLButtonElement).disabled) c.disabled = true;
    const pressed = el.getAttribute("aria-pressed"), checked = el.getAttribute("aria-checked");
    if (pressed !== null) c.pressed = pressed === "true";
    if (checked !== null) c.checked = checked === "true";
    controls.push(c);
  }
  const messages: ScreenMessage[] = [];
  for (const el of doc.querySelectorAll("[data-msg-role]")) {
    if (!isVisible(el, win)) continue;
    const wrap = el.parentElement;
    const m: ScreenMessage = { role: el.getAttribute("data-msg-role") === "user" ? "user" : "assistant", text: cap(clean(el.textContent).replace(/▍$/, "")) };
    if (el.getAttribute("data-streaming") === "true") m.streaming = true;
    if (wrap?.querySelector("[data-reply-cutoff]")) m.cutOff = true;
    if (wrap?.querySelector("[data-reply-failed]")) m.failed = true;
    messages.push(m);
  }
  const notices: string[] = [];
  for (const el of doc.querySelectorAll("[role='status'], [role='alert'], [data-reply-cutoff], [data-reply-failed]")) {
    if (notices.length >= 12 || !isVisible(el, win) || ratingHidden(el) || (o.inStudy && studyHidden(el))) continue;
    const t = clean(el.textContent);
    if (t) notices.push(cap(t, 200));
  }
  return {
    screen: overlays.at(-1) ?? "chat", overlays, layout: app?.getAttribute("data-layout") ?? null, busy: app?.getAttribute("data-busy") === "true",
    title: o.inStudy ? null : cap(clean(doc.querySelector("header .font-title")?.textContent), 120) || null,
    controls, messages, notices,
  };
}
