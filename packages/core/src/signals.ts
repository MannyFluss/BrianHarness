/**
 * Signal sources: the "input devices" of the harness. Each source turns raw samples
 * into a FeatureMap for a time window (one user turn). The engagement estimator only
 * ever sees FeatureMaps, so typing, BrainFlow EEG, and fake EEG are swappable plugins.
 */
import type { FeatureMap, TypingEvent } from "./types.js";
import type { Rng } from "./rng.js";
import { makeRng } from "./rng.js";

export interface TimeWindow {
  /** when the Director's message was shown (ms epoch) */
  from: number;
  /** when the user hit send (ms epoch) */
  to: number;
}

export interface SignalSource {
  /** stable id, also the feature-key prefix, e.g. "typing", "eeg" */
  readonly id: string;
  readonly kind: "typing" | "eeg" | "fake-eeg" | "prepared" | "replay";
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** Push one raw sample. Typing events arrive from the renderer over IPC. */
  push(sample: unknown): void;
  /** Summarise samples inside the window into numeric features (keys prefixed with id). */
  summarize(window: TimeWindow): FeatureMap;
  /** Drop samples older than t (called after each turn). */
  clear(before: number): void;
}

/** Gap between key events that counts as a "thinking pause". */
export const PAUSE_MS = 2000;

const KINDS = new Set(["insert", "delete", "paste", "nav", "submit", "focus", "blur"]);
const SOURCES = new Set(["hardware-key", "soft-keyboard", "autocorrect", "predictive", "composition", "dictation", "paste", "drop", "programmatic", "unknown"]);

/**
 * Privacy whitelist: a TypingEvent is {t, kind, len, source?, chars?} and nothing else. Anything
 * else a renderer (or a buggy plugin) attaches, e.g. `data`, the key or the text, is dropped here,
 * before features, logs (rawEvents) or the replay file ever see it.
 */
export function sanitizeTypingEvent(raw: unknown): TypingEvent | null {
  const e = raw as Partial<TypingEvent> | null;
  if (!e || typeof e.t !== "number" || !Number.isFinite(e.t) || typeof e.kind !== "string" || !KINDS.has(e.kind)) return null;
  const out: TypingEvent = { t: e.t, kind: e.kind, len: typeof e.len === "number" && Number.isFinite(e.len) ? e.len : 0 };
  if (typeof e.source === "string" && SOURCES.has(e.source)) out.source = e.source;
  if (typeof e.chars === "number" && Number.isFinite(e.chars) && e.chars >= 0) out.chars = e.chars;
  return out;
}
export function sanitizeTypingEvents(events: unknown): TypingEvent[] {
  if (!Array.isArray(events)) return [];
  const out: TypingEvent[] = [];
  for (const e of events) {
    const s = sanitizeTypingEvent(e);
    if (s) out.push(s);
  }
  return out;
}

/** Edits that arrive without per-key timing: their speed / deletion features are not keystroke behaviour. */
const UNTIMED_SOURCES = new Set(["paste", "drop", "dictation", "autocorrect", "predictive"]);
const isKey = (e: TypingEvent) => e.kind === "insert" || e.kind === "delete" || e.kind === "paste";
/**
 * IME composition rewrites its own provisional text (deleteCompositionText / replaced marked text):
 * that is not the user deleting, so it is not a deletion.
 */
const isCompositionDelete = (e: TypingEvent) => e.kind === "delete" && e.source === "composition";

/** Inter-key gaps (ms, rounded) between consecutive edit events inside the window. Timings only. */
export function keyGaps(events: TypingEvent[], window: TimeWindow): number[] {
  const keys = events.filter((e) => e.t >= window.from && e.t <= window.to && isKey(e) && !isCompositionDelete(e)).sort((a, b) => a.t - b.t);
  const gaps: number[] = [];
  for (let i = 1; i < keys.length; i++) gaps.push(Math.round(keys[i]!.t - keys[i - 1]!.t));
  return gaps;
}

const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

/** Pure function so the sim runner and tests can use it without a source instance. */
export function summarizeTyping(events: TypingEvent[], window: TimeWindow): FeatureMap {
  const ev = events.filter((e) => e.t >= window.from && e.t <= window.to).sort((a, b) => a.t - b.t);
  const keys = ev.filter((e) => isKey(e) && !isCompositionDelete(e));
  const first = keys[0];
  const firstKeyAt = first ? first.t : window.to;
  let inserts = 0, deletions = 0, pastes = 0, edits = 0, pauses = 0, longestPause = 0, pauseTotal = 0;
  let inDeleteRun = false;
  for (let i = 0; i < keys.length; i++) {
    const e = keys[i]!;
    if (e.kind === "insert") inserts++;
    if (e.kind === "paste") pastes++;
    if (e.kind === "delete") {
      deletions++;
      inDeleteRun = true;
    } else if (inDeleteRun) {
      // a deletion run followed by new text = one revision ("edit")
      edits++;
      inDeleteRun = false;
    }
    if (i > 0) {
      const gap = e.t - keys[i - 1]!.t;
      if (gap >= PAUSE_MS) {
        pauses++;
        pauseTotal += gap;
        longestPause = Math.max(longestPause, gap);
      }
    }
  }
  const finalLen = ev.length ? ev[ev.length - 1]!.len : 0;
  const composeMs = Math.max(0, window.to - firstKeyAt);
  const activeMs = Math.max(1, composeMs - pauseTotal);
  const strokes = inserts + deletions;
  // Input-source features: only emitted when the renderer reported sources, so desktop/sim
  // feature maps (and the engagement estimator, which doesn't read these) are unchanged.
  const src: FeatureMap = {};
  const withSrc = keys.filter((e) => e.source);
  if (withSrc.length) {
    const count = (s: string) => withSrc.filter((e) => e.source === s).length;
    src["typing.src.soft"] = count("soft-keyboard") / withSrc.length;
    src["typing.src.hardware"] = count("hardware-key") / withSrc.length;
    src["typing.src.autocorrect"] = count("autocorrect");
    src["typing.src.predictive"] = count("predictive");
    src["typing.src.dictation"] = count("dictation");
    src["typing.src.composition"] = count("composition");
    // share of inserted characters that came with per-key timing (1 = keystroke timing is meaningful)
    const chars = (e: TypingEvent) => e.chars ?? 1;
    const ins = withSrc.filter((e) => e.kind === "insert");
    const total = ins.reduce((a, e) => a + chars(e), 0);
    const timed = ins.filter((e) => e.source === "hardware-key" || e.source === "soft-keyboard").reduce((a, e) => a + Math.min(1, chars(e)), 0);
    src["typing.src.timedShare"] = total ? timed / total : 1;
  }
  // Explicit reply latencies (window.from = completeAt: the reply fully shown) and the flags that
  // mark turns whose speed / deletion features are not keystroke behaviour (see engagement.ts).
  const charsOf = (e: TypingEvent) => e.chars ?? 1;
  let totalChars = 0, untimedChars = 0, dictated = 0, autocorrections = 0;
  for (const e of keys) {
    if (e.source === "dictation") dictated = 1;
    if (e.source === "autocorrect") autocorrections++;
    if (e.kind === "delete") continue;
    totalChars += charsOf(e);
    if (e.kind === "paste" || (e.source !== undefined && UNTIMED_SOURCES.has(e.source))) untimedChars += charsOf(e);
  }
  const gaps: number[] = [];
  for (let i = 1; i < keys.length; i++) gaps.push(keys[i]!.t - keys[i - 1]!.t);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const audit: FeatureMap = {
    "typing.latencyToFirstKeyMs": Math.max(0, firstKeyAt - window.from),
    "typing.latencyToSubmitMs": Math.max(0, window.to - window.from),
    "typing.gapCount": gaps.length,
    "typing.gapMeanMs": gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0,
    "typing.gapMedianMs": quantile(sortedGaps, 0.5),
    "typing.gapP90Ms": quantile(sortedGaps, 0.9),
    "typing.dictated": dictated,
    "typing.pasted": pastes > 0 || keys.some((e) => e.source === "paste" || e.source === "drop") ? 1 : 0,
    "typing.autocorrections": autocorrections,
    "typing.predictive": keys.filter((e) => e.source === "predictive").length,
    // share of inserted characters that WERE typed key by key (1 = all of them; 1 when nothing typed)
    "typing.timingReliability": totalChars ? 1 - untimedChars / totalChars : 1,
  };
  return {
    ...src,
    ...audit,
    "typing.replyLatencyMs": Math.max(0, firstKeyAt - window.from),
    "typing.composeMs": composeMs,
    "typing.totalMs": Math.max(0, window.to - window.from),
    "typing.keystrokes": strokes,
    "typing.inserts": inserts,
    "typing.deletions": deletions,
    "typing.deletionRatio": strokes ? deletions / strokes : 0,
    "typing.edits": edits,
    "typing.pastes": pastes,
    "typing.pauses": pauses,
    "typing.longestPauseMs": longestPause,
    "typing.charsPerSec": (inserts / activeMs) * 1000,
    "typing.finalLength": finalLen,
  };
}

export class TypingSignalSource implements SignalSource {
  readonly id = "typing";
  readonly kind = "typing" as const;
  private events: TypingEvent[] = [];
  push(sample: unknown): void {
    const e = sanitizeTypingEvent(sample);
    if (e) this.events.push(e);
  }
  pushMany(events: TypingEvent[]): void {
    for (const e of events) this.push(e);
  }
  summarize(window: TimeWindow): FeatureMap {
    return summarizeTyping(this.events, window);
  }
  clear(before: number): void {
    this.events = this.events.filter((e) => e.t >= before);
  }
  snapshot(window: TimeWindow): TypingEvent[] {
    return this.events.filter((e) => e.t >= window.from && e.t <= window.to);
  }
}

/**
 * Fake EEG for blind tests: generates band-power-like samples from a HIDDEN engagement
 * curve the estimator never sees directly. Later a BrainFlowSource (synthetic board,
 * then real headset) implements the same interface and emits the same feature keys.
 */
export class FakeEegSource implements SignalSource {
  readonly id = "eeg";
  readonly kind = "fake-eeg" as const;
  private samples: Array<{ t: number; alpha: number; beta: number; theta: number }> = [];
  private rng: Rng;
  constructor(
    private truth: (t: number) => number,
    opts: { seed?: number; noise?: number } = {},
  ) {
    this.rng = makeRng(opts.seed ?? 7);
    this.noise = opts.noise ?? 0.15;
  }
  private noise: number;
  push(sample: unknown): void {
    const s = sample as { t: number; alpha: number; beta: number; theta: number };
    if (typeof s?.t === "number") this.samples.push(s);
  }
  /** Simulate `hz` samples per second over a window (call from sim / test loops). */
  generate(window: TimeWindow, hz = 4): void {
    const step = 1000 / hz;
    for (let t = window.from; t <= window.to; t += step) {
      const e = Math.min(1, Math.max(0, this.truth(t)));
      const n = () => (this.rng() - 0.5) * 2 * this.noise;
      this.samples.push({ t, beta: 0.3 + 0.5 * e + n(), alpha: 0.7 - 0.4 * e + n(), theta: 0.6 - 0.3 * e + n() });
    }
  }
  summarize(window: TimeWindow): FeatureMap {
    const s = this.samples.filter((x) => x.t >= window.from && x.t <= window.to);
    if (!s.length) return {};
    const avg = (f: (x: (typeof s)[number]) => number) => s.reduce((a, x) => a + f(x), 0) / s.length;
    const alpha = avg((x) => x.alpha), beta = avg((x) => x.beta), theta = avg((x) => x.theta);
    // classic engagement index beta / (alpha + theta), roughly 0.2..1.2 here
    return { "eeg.alpha": alpha, "eeg.beta": beta, "eeg.theta": theta, "eeg.engagementIndex": beta / Math.max(0.05, alpha + theta), "eeg.samples": s.length };
  }
  clear(before: number): void {
    this.samples = this.samples.filter((x) => x.t >= before);
  }
}

/**
 * Official source for features computed elsewhere (an offline EEG pipeline, a synthetic generator,
 * a Python sim). Call prepare(features) right before session.reply(); the next summarize() returns
 * exactly those features (keys used as-is, e.g. "eeg.engagementIndex", "eeg.quality") and then
 * forgets them, so a turn without prepare() contributes nothing. Pass several prepare() calls in a
 * turn and they merge (later keys win).
 */
export class PreparedFeatureSource implements SignalSource {
  readonly kind = "prepared" as const;
  private next: FeatureMap | null = null;
  constructor(readonly id = "eeg") {}
  prepare(features: FeatureMap) {
    this.next = { ...(this.next ?? {}), ...features };
  }
  push(sample: unknown) {
    if (sample && typeof sample === "object") this.prepare(sample as FeatureMap);
  }
  summarize(): FeatureMap {
    const f = this.next ?? {};
    this.next = null;
    return f;
  }
  clear() {}
}

/**
 * Replays recorded per-turn feature rows in order (e.g. the "features" of user_turn lines from a
 * session JSONL, filtered to one prefix). Turn i's summarize() returns rows[i]; past the end -> {}.
 * Use it for yoked/sham controls: replay another session's EEG against this one.
 */
export class ReplayFeatureSource implements SignalSource {
  readonly kind = "replay" as const;
  private i = 0;
  constructor(private rows: FeatureMap[], readonly id = "eeg", private prefix: string | null = "eeg.") {}
  /** Rows from a session JSONL text (user_turn lines), keeping keys under `prefix`. */
  static fromJsonl(jsonl: string, prefix = "eeg.", id = "eeg"): ReplayFeatureSource {
    const rows: FeatureMap[] = [];
    for (const line of jsonl.split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.type === "user_turn") rows.push(e.features ?? {});
    }
    return new ReplayFeatureSource(rows, id, prefix);
  }
  push() {}
  summarize(): FeatureMap {
    const row = this.rows[this.i++] ?? {};
    if (!this.prefix) return { ...row };
    return Object.fromEntries(Object.entries(row).filter(([k]) => k.startsWith(this.prefix!)));
  }
  clear() {}
  get remaining() {
    return Math.max(0, this.rows.length - this.i);
  }
}

/**
 * Typing events synthesized from the reply TEXT ONLY (for LLM personas / Python sims that have
 * no keystrokes). Deterministic per seed; carries no information beyond the text itself (length,
 * words), so it cannot leak a persona's hidden interest. Typing starts after a think delay that
 * grows with reply length, at ~charsPerSec with jitter, with an occasional 1-char correction.
 */
export function synthesizeTypingFromText(text: string, shownAt: number, opts: { seed?: number; charsPerSec?: number; thinkMs?: number } = {}): { events: TypingEvent[]; sentAt: number } {
  let x = (opts.seed ?? 1) * 2654435761 + text.length * 40503;
  const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const cps = opts.charsPerSec ?? 5;
  const words = text.split(/\s+/).filter(Boolean).length;
  let t = shownAt + (opts.thinkMs ?? 2500) + 120 * Math.min(words, 40) + 1500 * rnd();
  const events: TypingEvent[] = [];
  let len = 0;
  for (let i = 0; i < text.length; i++) {
    t += (1000 / cps) * (0.5 + rnd());
    if (text[i] === " " && rnd() < 0.04) t += 1200 + 1500 * rnd(); // occasional thinking pause
    len++;
    events.push({ t: Math.round(t), kind: "insert", len });
    if (rnd() < 0.02 && len > 1) {
      t += 180;
      len--;
      events.push({ t: Math.round(t), kind: "delete", len });
      t += 150;
      len++;
      events.push({ t: Math.round(t), kind: "insert", len });
    }
  }
  const sentAt = Math.round(t + 300 + 400 * rnd());
  events.push({ t: sentAt, kind: "submit", len });
  return { events, sentAt };
}
