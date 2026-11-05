/**
 * E6: the Director tab's view model, a pure fold over the FULL lines of a tab_visible session log
 * (AdSessionLog.lines). Three layers (spec "Director tab"):
 *   top    conversational context: summary, hypotheses with confidence bars, intent; changes highlighted for 5 s
 *   middle insights: share bar for the last Actor request + session line + sparkline; note cards
 *          considered -> no_note (Director's reason) / blocked (rail code) / injected | shadow (exact hint, kind,
 *          move, evidence) / dropped -> outcome (followed? answered first? leaks?)
 *   bottom live data: paragraph mini-map shaded by dwell + event ticker (the 10 Hz part comes from GazeSource.live())
 * Blinded sessions: buildTabModel refuses (throws BlindedTabError). The tab does not exist there; the app never
 * calls this for a blinded session and the desktop test proves no tab DOM / no tab-only field is rendered.
 * v1.3: leak_judge verdicts never reach the tab. Callers pass AdSessionLog.tabLines; the fold re-applies the same
 * projection (tabSafeLines) to whatever it is given, so a leak_judge line or reason is never rendered: a gate drop shows
 * only the generic "note dropped".
 */
import { tabSafeLines } from "./log.js";
import type { AttentionEvent, BhAdEvent, DirectorOutput, EvidenceId, Hypothesis, LeakCode, NoteKind, RailCode, ReadingDigest, SuggestionMove } from "../ad-contracts/index.js";

type Ev<T extends BhAdEvent["type"]> = Extract<BhAdEvent, { type: T }>;

export class BlindedTabError extends Error {
  constructor() { super("the Director tab does not exist in blinded sessions"); this.name = "BlindedTabError"; }
}

export const HIGHLIGHT_MS = 5000;

export interface TabTop {
  turn: number; mono: number; summary: string; intent: string;
  hypotheses: Array<Hypothesis & { isNew: boolean }>;
  changed: string[];
}
export interface ShareBar {
  turn: number; noteId: string | null;
  parts: { system: number; history: number; user: number; director: number };
  total: number; share: number;
  /** "Director 41 tok · 2.3% of 1,751" (or "No Director hint · 1,751 tok") */
  words: string;
}
export interface SessionLine { turns: number; notes: number; actorShare: number; indirect: number; words: string; spark: number[] }

export type CardState = "considering" | "no_note" | "blocked" | "injected" | "shadow" | "dropped" | "error";
export interface NoteCard {
  key: string;
  /** the Actor request this call was for (a<turn>) */
  turn: number;
  /** the Actor message the Director read */
  readMsg: string;
  mono: number;
  state: CardState;
  noteId: string | null;
  reason: string | null;
  railCodes: RailCode[];
  hint: string | null;
  kind: NoteKind | null;
  move: SuggestionMove | null;
  evidence: EvidenceId[];
  confidence: number | null;
  observation: string | null;
  suggestion: string | null;
  rationale: string | null;
  /** the Actor reply that used the note (margin mark) */
  replyMsg: string | null;
  outcome: { followed: boolean | null; answeredFirst: boolean | null; leaks: LeakCode[]; nextDwellRatio: number | null; pushback: boolean | null } | null;
  genMs: number | null;
  repaired: boolean;
}
export interface MiniMapPara { aoi: string; excerpt: string; label: "deep" | "read" | "skim" | "skipped"; ratio: number; shade: number; words: string }
export interface TabBottom { msg: string | null; quality: number | null; qualityLabel: string | null; paras: MiniMapPara[]; ticker: Array<{ id: string; aoi: string; words: string }> }
export interface TabModel {
  sessionId: string;
  arm: "on" | "shadow" | "off" | null;
  pInject: number | null;
  directorEnabled: boolean;
  turns: number;
  top: TabTop | null;
  share: ShareBar | null;
  session: SessionLine;
  cards: NoteCard[];
  /** reply msg id -> note id: margin marks */
  marks: Record<string, string>;
  bottom: TabBottom;
  health: Array<{ code: string; mono: number }>;
  ended: boolean;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const n = (x: number) => x.toLocaleString("en-US");

/** numbers with words: a dwell ratio against the person's usual reading time */
export function ratioWords(r: number): string {
  if (r <= 0) return "not looked at";
  if (r < 0.6) return `skimmed (${r.toFixed(1)}× your usual reading time)`;
  if (r < 1.5) return "read at your usual pace";
  return `${r.toFixed(1)}× your usual reading time`;
}
const KIND_WORDS: Record<AttentionEvent["kind"], string> = {
  deep_read: "read slowly", reread: "re-read", skip: "skipped", look_back: "looked back at", fast_scan: "scanned quickly",
  offscreen: "looked away", composer_hesitation: "paused in the composer", eeg_spike: "EEG spike",
};
export function eventWords(e: Pick<AttentionEvent, "kind" | "aoi" | "features" | "z">): string {
  const ratio = e.features?.["ratio"] ?? e.features?.["msPerWordRatio"];
  const base = `${KIND_WORDS[e.kind] ?? e.kind} ${e.aoi}`;
  return typeof ratio === "number" && ratio > 0 ? `${base} (${ratio.toFixed(1)}× usual)` : base;
}
export function shareWords(c: { director: number; total: number }): string {
  return c.director > 0 ? `Director ${n(c.director)} tok · ${pct(c.director / c.total)} of ${n(c.total)}` : `No Director hint · ${n(c.total)} tok`;
}

export const GENERIC_DROP = "note dropped";
export function buildTabModel(input: readonly BhAdEvent[]): TabModel {
  const lines = tabSafeLines(input);
  const ss = lines.find((l): l is Ev<"session_start"> => l.type === "session_start");
  if (!ss || ss.session_type === "blinded" || ss.tab !== "visible") throw new BlindedTabError();
  const m: TabModel = {
    sessionId: ss.sessionId, arm: ss.arm ?? null, pInject: ss.p_inject ?? null, directorEnabled: ss.director_enabled, turns: 0,
    top: null, share: null, session: { turns: 0, notes: 0, actorShare: 0, indirect: 0, words: "", spark: [] }, cards: [], marks: {},
    bottom: { msg: null, quality: null, qualityLabel: null, paras: [], ticker: [] }, health: [], ended: false,
  };
  let prevHyp = new Set<string>();
  const rows: Ev<"context_share">[] = [];
  const byNote = new Map<string, NoteCard>();
  const byTurn = new Map<number, NoteCard>();
  for (const l of lines) {
    switch (l.type) {
      case "director_call": {
        const o: DirectorOutput | null = l.output;
        if (o) {
          const labels = o.context_update.hypotheses.map((h) => h.label);
          m.top = { turn: l.turn, mono: l.mono, summary: o.context_update.summary, intent: o.intent, changed: o.context_update.changed,
            hypotheses: o.context_update.hypotheses.map((h) => ({ ...h, isNew: !prevHyp.has(h.label) })) };
          prevHyp = new Set(labels);
        }
        const note = o?.note ?? null;
        const card: NoteCard = {
          key: `t${l.turn}`, turn: l.turn, readMsg: l.msg, mono: l.mono,
          state: !o ? "error" : note ? "considering" : "no_note",
          noteId: note?.id ?? null,
          reason: !o ? (l.deadline_missed ? "late: answered after the 1.5 s hold" : `no valid output (${l.error ?? "error"})`) : o.note ? null : o.no_note_reason,
          railCodes: [], hint: null, kind: null, move: note?.suggestion?.move ?? null, evidence: note?.evidence ?? [], confidence: note?.confidence ?? null,
          observation: note?.observation ?? null, suggestion: note?.suggestion?.text ?? null, rationale: note?.rationale ?? null,
          replyMsg: null, outcome: null, genMs: l.genMs, repaired: l.repaired,
        };
        if (l.deadline_missed && note) { card.state = "dropped"; card.reason = "late: answered after the 1.5 s hold"; }
        m.cards.push(card); byTurn.set(l.turn, card);
        if (note) byNote.set(note.id, card);
        break;
      }
      case "rail_check": {
        const c = byNote.get(l.note_id);
        if (c && !l.pass) { c.state = "blocked"; c.railCodes = l.blocked_by; c.reason = `blocked by rail: ${l.blocked_by.join(", ")}`; }
        break;
      }
      case "injection": {
        const c = byNote.get(l.note_id);
        if (c) { c.state = l.decision === "inject" ? "injected" : "shadow"; c.hint = l.actor_text; c.kind = l.kind; c.move = l.move ?? null; c.evidence = l.evidence; c.confidence = l.confidence;
          if (l.decision === "shadow") c.reason = "held back: shadow control (not sent to the Actor)"; }
        break;
      }
      case "note_dropped": {
        const c = byNote.get(l.note_id);
        if (c) { c.state = "dropped"; c.reason = l.reason === "late" ? "late: answered after the 1.5 s hold" : l.reason === "session_end" ? "session ended" : l.reason === "superseded" ? "superseded" : GENERIC_DROP; }
        break;
      }
      case "actor_turn": {
        m.turns = Math.max(m.turns, l.turn + 1);
        if (l.note_id) { m.marks[l.msg] = l.note_id; const c = byNote.get(l.note_id); if (c) c.replyMsg = l.msg; }
        break;
      }
      case "note_outcome": {
        const c = byNote.get(l.note_id);
        if (c) c.outcome = { followed: l.followed, answeredFirst: l.answered_first, leaks: l.leaks, nextDwellRatio: l.next_dwell_ratio, pushback: l.pushback };
        break;
      }
      case "context_share": {
        rows.push(l);
        m.share = { turn: l.turn, noteId: l.note_id, parts: { system: l.system, history: l.history, user: l.user, director: l.director }, total: l.total, share: l.share, words: shareWords(l) };
        break;
      }
      case "attention_digest": {
        const d: ReadingDigest = l.digest;
        const maxR = Math.max(1, ...d.paras.map((p) => p.ratio));
        m.bottom = {
          msg: d.msg, quality: d.quality, qualityLabel: d.qualityLabel,
          paras: d.paras.map((p) => ({ aoi: p.aoi, excerpt: p.excerpt, label: p.label, ratio: p.ratio, shade: Math.min(1, p.ratio / maxR), words: ratioWords(p.ratio) })),
          ticker: l.events.slice(-6).map((e) => ({ id: e.id, aoi: e.aoi, words: eventWords(e) })),
        };
        break;
      }
      case "health": if (!l.ok && l.code) m.health.push({ code: l.code, mono: l.mono }); break;
      case "session_end": m.ended = true; break;
      default: break;
    }
  }
  void byTurn;
  const sum = (f: (r: Ev<"context_share">) => number) => rows.reduce((s, r) => s + f(r), 0);
  const T = sum((r) => r.total), D = sum((r) => r.director), H = sum((r) => r.history), E = sum((r) => r.history_echo);
  const notes = m.cards.filter((c) => c.state === "injected").length;
  const actorShare = T ? D / T : 0, indirect = H ? E / H : 0;
  m.session = {
    turns: m.turns, notes, actorShare, indirect, spark: rows.map((r) => r.share),
    words: `Session: ${notes} note${notes === 1 ? "" : "s"} in ${m.turns} turn${m.turns === 1 ? "" : "s"} · ${pct(actorShare)} of Actor input · indirect ${pct0(indirect)}`,
  };
  m.cards.reverse();
  return m;
}

/** is a highlight (changed hypothesis / new card) still within its 5 s window */
export const highlighted = (atMono: number, nowMono: number) => nowMono - atMono < HIGHLIGHT_MS;

/** evidence ids -> paragraph AOIs to highlight in the chat ("a7.p2.s1" -> "a7.p2"; "e31" via the digest events) */
export function evidenceParagraphs(evidence: readonly string[], events: ReadonlyArray<Pick<AttentionEvent, "id" | "aoi">>): string[] {
  const out = new Set<string>();
  for (const id of evidence) {
    const p = /^(a\d+\.p\d+)/.exec(id);
    if (p) out.add(p[1]!);
    else if (/^e\d+$/.test(id)) { const e = events.find((x) => x.id === id); if (e) out.add(e.aoi); }
  }
  return [...out];
}
