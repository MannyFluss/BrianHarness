/**
 * E3: the Director's user-role input message (R3 / spec format):
 *   [CHAT] u3 "..." · a3.p1 "..."            older pairs, one line each (user message, then the Actor's paragraphs)
 *   u4 "..."                                  the latest user message
 *   a4.p1 "..." · a4.p2 "..."                 the latest Actor message, by paragraph
 *   [ATTENTION DIGEST · after a4 · window 29 s · tracking good (0.77) · baseline: 22 paragraphs]
 *   a4.p1 read 0.9x · a4.p2 DEEP 2.6x, reread 2x e8 (z 2.7, conf .79) · a4.p3 skim 0.5x e9 (z -1.5, conf .70)
 *   look-back to a2.p1 "..." 1.2 s e10
 *   off-screen 0 s · composer pauses >2 s: 1
 *   Session ledger: ...                       (optional)
 *   [YOUR FOOTPRINT] notes 0 of 4 Actor turns · session share 0.0%   (+ " (dynamic x%)" once a note was injected)
 *     n3 turn 7 suggestion:give_example -> followed, next dwell 1.4x  (last <= 3 notes)
 * Gaze events from an invalid window (quality < 0.6 or face < 70 %) are withheld, and z is not shown before the
 * 20-paragraph baseline; the data_validity rail still blocks a note that cites one (invalidEventIds).
 */
import type { AttentionEvent, DirectorFootprint, ReadingDigest } from "../ad-contracts/index.js";

export const BASELINE_PARAGRAPHS = 20;
export const MIN_QUALITY = 0.6;
export const MIN_FACE = 0.7;
export interface ChatTurn { id: string; role: "user" | "assistant"; text: string }
export interface DigestInput {
  /** visible chat so far, oldest first, ids "uT" / "aT" */
  chat: ChatTurn[];
  digest: ReadingDigest | null;
  events: AttentionEvent[];
  faceFrac: number | null;
  baselineParagraphs: number;
  ledger?: string[];
  footprint: DirectorFootprint;
}

export const paragraphs = (text: string): string[] => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
export function excerpt(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : max) + "...";
}
const q = (s: string) => `"${excerpt(s)}"`;
const pct = (x: number) => (x * 100).toFixed(1) + "%";
const c2 = (x: number) => x.toFixed(2).replace(/^0\./, ".").replace(/^-0\./, "-.");

function actorLine(t: ChatTurn): string { return paragraphs(t.text).map((p, i) => `${t.id}.p${i + 1} ${q(p)}`).join(" · "); }

export function invalidEventIds(d: DigestInput): Set<string> {
  const bad = new Set<string>();
  const windowBad = !d.digest || d.digest.quality < MIN_QUALITY || (d.faceFrac !== null && d.faceFrac < MIN_FACE);
  for (const e of d.events) if (windowBad || (e.z !== null && d.baselineParagraphs < BASELINE_PARAGRAPHS)) bad.add(e.id);
  return bad;
}

export function footprintLines(f: DirectorFootprint): string[] {
  let head = `[YOUR FOOTPRINT] notes ${f.notes_injected} of ${f.actor_turns} Actor turns · session share ${pct(f.session_share)}`;
  if (f.notes_injected > 0) head += ` (dynamic ${pct(f.session_dynamic_share)})`;
  if (f.notes_shadowed || f.notes_blocked) head += ` · held back ${f.notes_shadowed + f.notes_blocked}`;
  const lines = [head];
  for (const r of f.recent.slice(-3)) {
    const kind = r.kind === "observation" ? "observation" : `${r.kind}${r.move ? ":" + r.move : ""}`;
    const what = r.decision === "blocked" ? "blocked" : r.decision === "shadow" ? "not sent" : r.followed === true ? "followed" : r.followed === false ? "not followed" : "sent";
    lines.push(`  ${r.note_id} turn ${r.turn} ${kind} -> ${what}${r.next_dwell_ratio !== null ? `, next dwell ${r.next_dwell_ratio.toFixed(1)}x` : ""}`);
  }
  return lines;
}

/** render; dropOldest drops that many of the oldest chat lines (input-cap trimming), keepLedger false drops the ledger */
export function renderDirectorInput(d: DigestInput, dropOldest = 0, keepLedger = true): string {
  const lines: string[] = [];
  // chat: pair lines, then the latest user message and the latest Actor message on their own lines
  const chat = d.chat;
  const lastA = chat.length - 1 >= 0 && chat[chat.length - 1]!.role === "assistant" ? chat.length - 1 : -1;
  const lastU = lastA > 0 && chat[lastA - 1]!.role === "user" ? lastA - 1 : -1;
  const older: string[] = [];
  let pair: string[] = [];
  const end = lastU >= 0 ? lastU : lastA >= 0 ? lastA : chat.length;
  for (let i = 0; i < end; i++) {
    const t = chat[i]!;
    if (t.role === "user") { if (pair.length) older.push(pair.join(" · ")); pair = [`${t.id} ${q(t.text)}`]; }
    else { pair.push(actorLine(t)); older.push(pair.join(" · ")); pair = []; }
  }
  if (pair.length) older.push(pair.join(" · "));
  const recent = [...(lastU >= 0 ? [`${chat[lastU]!.id} ${q(chat[lastU]!.text)}`] : []), ...(lastA >= 0 ? [actorLine(chat[lastA]!)] : [])];
  const chatLines = [...older.slice(Math.min(dropOldest, older.length)), ...recent];
  if (chatLines.length) lines.push("[CHAT] " + chatLines.join("\n"));
  const g = d.digest;
  if (g) {
    const bad = invalidEventIds(d);
    const windowBad = g.quality < MIN_QUALITY || (d.faceFrac !== null && d.faceFrac < MIN_FACE);
    const base = d.baselineParagraphs >= BASELINE_PARAGRAPHS ? `baseline: ${d.baselineParagraphs} paragraphs` : `baseline: ${d.baselineParagraphs} of ${BASELINE_PARAGRAPHS} paragraphs, no z yet`;
    lines.push(`[ATTENTION DIGEST · after ${g.msg} · window ${Math.round(g.windowMs / 1000)} s · tracking ${windowBad ? "poor" : g.qualityLabel} (${g.quality.toFixed(2)}) · ${base}]`);
    if (windowBad) lines.push("gaze events withheld (tracking below threshold); on-screen time only");
    const byId = new Map(d.events.map((e) => [e.id, e]));
    const evText = (id: string, label: string) => {
      const e = byId.get(id);
      if (!e || bad.has(id) && windowBad) return "";
      const kind = e.kind === "reread" ? `reread ${e.features.count ?? 1}x ` : e.kind === "skip" && label === "skipped" ? "" : e.kind === "deep_read" || (e.kind === "skip" && label === "skim") || e.kind === "fast_scan" && label === "skim" ? "" : e.kind.replace(/_/g, "-") + " ";
      const z = e.z !== null && d.baselineParagraphs >= BASELINE_PARAGRAPHS ? `z ${e.z.toFixed(1)}, ` : "";
      return `${kind}${id} (${z}conf ${c2(e.conf)})`;
    };
    const paras = g.paras.map((p) => {
      const label = p.label === "deep" ? "DEEP" : p.label;
      const ev = (p.ev ?? []).map((id) => evText(id, p.label)).filter(Boolean);
      return `${p.aoi} ${label} ${p.ratio.toFixed(1)}x${ev.length ? (p.label === "deep" ? ", " : " ") + ev.join(", ") : ""}`;
    });
    if (paras.length) lines.push(paras.join(" · "));
    for (const lb of g.lookBacks) if (!(windowBad && bad.has(lb.ev))) lines.push(`look-back to ${lb.aoi} ${q(lb.excerpt)} ${(lb.ms / 1000).toFixed(1)} s ${lb.ev}`);
    lines.push(`off-screen ${Math.round(g.offscreenMs / 1000)} s · composer pauses >2 s: ${g.composerPauses}`);
  }
  if (keepLedger && d.ledger?.length) lines.push("Session ledger: " + d.ledger.join(" · "));
  lines.push(...footprintLines(d.footprint));
  return lines.join("\n");
}
