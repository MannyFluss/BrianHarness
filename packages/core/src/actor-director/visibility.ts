/**
 * E5: paragraph AOIs and per-paragraph on-screen time (spec: Message.tsx tags `[data-msg][data-p]`).
 *
 * The app calls `update(t, boxes)` on every layout change it observes (scroll, resize, a streamed token that adds
 * or grows a paragraph; throttled to animation frames) with each tagged paragraph's box in viewport CSS px. The
 * tracker keeps, per paragraph, the visible intervals [t0,t1] and its complete_t, which is what gaze-ref's
 * assign()/dwell use. A paragraph counts as visible when at least `minVisibleFrac` of its box height is inside the
 * viewport, OR it covers at least `minViewportFrac` of the viewport height (a tall paragraph never fits; judgment
 * call, configurable). complete_t: while streaming, every paragraph but the last is complete when the next one
 * appears; the last one completes when the stream finishes.
 * Paragraph split rule: digest.ts paragraphs(), i.e. text.split(/\n\s*\n/).map(trim).filter(Boolean).
 */
import type { Aoi } from "./gaze-ref.js";

export interface ParaBox { msg: string; p: number; x: number; y: number; w: number; h: number; words?: number; text?: string; line_h?: number }
/** an interactive control / selectable span (data-interactive + data-aoi); never a whole paragraph */
export interface InteractiveAoiBox { msg: string; aoi: string; x: number; y: number; w: number; h: number; words: number; excerpt: string }
export interface VisibilityConfig { minVisibleFrac: number; minViewportFrac: number }
export const VISIBILITY_DEFAULTS: VisibilityConfig = { minVisibleFrac: 0.5, minViewportFrac: 0.5 };

/** the same split as digest.ts paragraphs(), but keeping the separators so a renderer can rebuild the text exactly */
export function splitParagraphs(text: string): Array<{ p: number | null; text: string }> {
  const out: Array<{ p: number | null; text: string }> = [];
  let p = 0;
  for (const chunk of text.split(/(\n\s*\n)/)) {
    if (!chunk) continue;
    if (/^\n\s*\n$/.test(chunk) || !chunk.trim()) out.push({ p: null, text: chunk });
    else out.push({ p: p++, text: chunk });
  }
  return out;
}
export const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;
/** DOM paragraph index (data-p, 0-based) -> the AOI / evidence id the digest and the Director use ("a7.p1", 1-based) */
export const aoiId = (msg: string, p: number) => `${msg}.p${p + 1}`;

interface Track { box: ParaBox; visible: Array<[number, number]>; open: number | null; complete_t?: number; first: number }
export class ParagraphVisibility {
  readonly c: VisibilityConfig;
  private tracks = new Map<string, Track>();
  private lastT = 0;
  constructor(readonly viewport: { w: number; h: number }, config: Partial<VisibilityConfig> = {}) { this.c = { ...VISIBILITY_DEFAULTS, ...config }; }

  isVisible(b: { y: number; h: number }): boolean {
    if (b.h <= 0) return false;
    const inside = Math.max(0, Math.min(b.y + b.h, this.viewport.h) - Math.max(b.y, 0));
    return inside >= this.c.minVisibleFrac * b.h || inside >= this.c.minViewportFrac * this.viewport.h;
  }
  /** a full snapshot of the tagged paragraphs on screen-or-in-DOM at time t (ms, the gaze clock) */
  update(t: number, boxes: ParaBox[], streaming = false): void {
    this.lastT = Math.max(this.lastT, t);
    const seen = new Set<string>();
    const byMsg = new Map<string, number>();
    for (const b of boxes) byMsg.set(b.msg, Math.max(byMsg.get(b.msg) ?? -1, b.p));
    for (const b of boxes) {
      const id = aoiId(b.msg, b.p);
      seen.add(id);
      let tr = this.tracks.get(id);
      if (!tr) { tr = { box: b, visible: [], open: null, first: t }; this.tracks.set(id, tr); }
      tr.box = b;
      const vis = this.isVisible(b);
      if (vis && tr.open === null) tr.open = t;
      else if (!vis && tr.open !== null) { tr.visible.push([tr.open, t]); tr.open = null; }
      // an earlier paragraph is complete once a later one exists; the last one when the stream is done
      if (tr.complete_t === undefined && (b.p < byMsg.get(b.msg)! || !streaming)) tr.complete_t = t;
    }
    for (const [id, tr] of this.tracks) if (!seen.has(id) && tr.open !== null) { tr.visible.push([tr.open, t]); tr.open = null; }
  }
  /** the stream finished at t: the last paragraph of every message is complete */
  streamDone(t: number): void { for (const tr of this.tracks.values()) if (tr.complete_t === undefined) tr.complete_t = t; }
  visibleMs(id: string, until = this.lastT): number {
    const tr = this.tracks.get(id);
    if (!tr) return 0;
    return tr.visible.reduce((a, [x, y]) => a + (y - x), 0) + (tr.open !== null ? Math.max(0, until - tr.open) : 0);
  }
  /** AOIs in gaze-ref form (boxes at their latest position; open intervals closed at `until`) */
  aois(until = this.lastT): Aoi[] {
    return [...this.tracks.entries()].map(([id, tr]) => {
      const v: Array<[number, number]> = [...tr.visible];
      if (tr.open !== null) v.push([tr.open, until]);
      const b = tr.box;
      return { id, msg: b.msg, order: b.p + 1, x: b.x, y: b.y, w: b.w, h: b.h, words: b.words ?? wordCount(b.text ?? ""),
        ...(b.text !== undefined ? { text: b.text } : {}), ...(b.line_h !== undefined ? { line_h: b.line_h } : {}),
        ...(tr.complete_t !== undefined ? { complete_t: tr.complete_t } : {}), visible: v };
    });
  }
  /** contract aoi_layout boxes; paragraphs are never interactive; pass interactive controls separately */
  layoutBoxes(msg: string, interactive: readonly InteractiveAoiBox[] = []) {
    const paras = [...this.tracks.entries()].filter(([, tr]) => tr.box.msg === msg).map(([id, tr]) => ({ aoi: id, words: tr.box.words ?? wordCount(tr.box.text ?? ""), x: tr.box.x, y: tr.box.y, w: tr.box.w, h: tr.box.h }));
    const ctrls = interactive.filter((b) => b.msg === msg).map((b) => ({ aoi: b.aoi, words: b.words, x: b.x, y: b.y, w: b.w, h: b.h, interactive: true as const }));
    return [...paras, ...ctrls];
  }
}

/** browser helper: interactive controls tagged [data-msg][data-aoi][data-interactive] (viewport CSS px). Paragraphs are excluded. */
export function collectInteractiveBoxes(root: { querySelectorAll(sel: string): ArrayLike<unknown> }): InteractiveAoiBox[] {
  const out: InteractiveAoiBox[] = [];
  const els = root.querySelectorAll("[data-msg][data-aoi][data-interactive]");
  const para = /^a[0-9]+\.p[0-9]+$/;
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as { getAttribute(n: string): string | null; getBoundingClientRect(): { x: number; y: number; width: number; height: number }; textContent: string | null };
    const aoi = el.getAttribute("data-aoi") ?? "";
    if (!aoi || para.test(aoi) || aoi === "composer") continue;
    const r = el.getBoundingClientRect();
    const excerpt = (el.getAttribute("data-excerpt") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
    out.push({ msg: el.getAttribute("data-msg") ?? "", aoi, x: r.x, y: r.y, w: r.width, h: r.height, words: wordCount(excerpt), excerpt });
  }
  return out;
}

/** browser helper: read the tagged paragraph boxes out of the DOM (viewport CSS px). */
export function collectParaBoxes(root: { querySelectorAll(sel: string): ArrayLike<unknown> }): ParaBox[] {
  const out: ParaBox[] = [];
  const els = root.querySelectorAll("[data-msg][data-p]");
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as { getAttribute(n: string): string | null; getBoundingClientRect(): { x: number; y: number; width: number; height: number }; textContent: string | null };
    const r = el.getBoundingClientRect();
    const text = el.textContent ?? "";
    out.push({ msg: el.getAttribute("data-msg") ?? "", p: Number(el.getAttribute("data-p")), x: r.x, y: r.y, w: r.width, h: r.height, text, words: wordCount(text) });
  }
  return out;
}
