/**
 * Per-user interest map. Two layers:
 *  - FrameState (fast, per turn, in memory) lives in session.ts.
 *  - InterestMap (slow, persisted save file) lives here: running weighted means
 *    of engagement per topic and per question style.
 */
import type { InterestMapData, QuestionStyle, ScoreCell } from "./types.js";
import { QUESTION_STYLES } from "./types.js";
import { DYNAMIC_TOPIC_LABELS, TOPICS, topicLabel } from "./topics.js";

/** Unseen cells behave as if observed once at this value (optimistic-ish prior). */
export const PRIOR_MEAN = 0.45;
export const PRIOR_N = 1;

export class InterestMap {
  data: InterestMapData;
  constructor(data: InterestMapData) {
    this.data = data;
    for (const [t, l] of Object.entries(data.labels ?? {})) DYNAMIC_TOPIC_LABELS.set(t, l);
  }
  /** Register an open-vocab topic's label (and optional broader lexicon parent). */
  defineTopic(topic: string, label: string, parent?: string) {
    if (TOPICS.includes(topic)) return;
    (this.data.labels ??= {})[topic] = label;
    if (parent && parent !== topic && this.root(parent) !== topic) (this.data.parents ??= {})[topic] = parent; // may move as evidence accrues
    DYNAMIC_TOPIC_LABELS.set(topic, label);
  }
  label(topic: string): string {
    return this.data.labels?.[topic] ?? topicLabel(topic);
  }
  parent(topic: string): string | undefined {
    return this.data.parents?.[topic];
  }
  /** Top-most ancestor (the topic itself when it has no parent). */
  root(topic: string): string {
    let t = topic;
    for (let i = 0; i < 4; i++) {
      const p = this.parent(t);
      if (!p || p === topic) break;
      t = p;
    }
    return t;
  }
  children(topic: string): string[] {
    return Object.entries(this.data.parents ?? {}).filter(([, p]) => p === topic).map(([c]) => c);
  }
  static fresh(userId: string): InterestMap {
    return new InterestMap({ version: 1, userId, sessions: 0, turns: 0, topics: {}, styles: {}, updatedAt: new Date().toISOString() });
  }
  static fromJSON(json: unknown): InterestMap {
    const d = json as InterestMapData;
    if (!d || d.version !== 1 || typeof d.userId !== "string") throw new Error("not an interest map v1 save file");
    return new InterestMap({ ...d, topics: d.topics ?? {}, styles: d.styles ?? {} });
  }
  toJSON(): InterestMapData {
    return this.data;
  }

  private bump(table: Record<string, ScoreCell>, key: string, value: number, weight: number) {
    const cell = table[key] ?? { mean: PRIOR_MEAN, n: 0, last: value, updatedAt: "" };
    const n = cell.n + weight;
    // incremental weighted mean, prior counts as PRIOR_N observations on first touch
    const effN = cell.n === 0 ? PRIOR_N + weight : n;
    cell.mean = cell.mean + (weight * (value - cell.mean)) / effN;
    cell.n = n;
    cell.last = value;
    cell.updatedAt = new Date().toISOString();
    table[key] = cell;
  }

  observeTopic(topic: string, engagement: number, weight = 1) {
    this.bump(this.data.topics, topic, engagement, weight);
  }
  observeStyle(style: QuestionStyle, engagement: number, weight = 1) {
    this.bump(this.data.styles, style, engagement, weight);
  }

  topic(topic: string): ScoreCell {
    return this.data.topics[topic] ?? { mean: PRIOR_MEAN, n: 0, last: 0, updatedAt: "" };
  }
  style(style: QuestionStyle): ScoreCell {
    return this.data.styles[style] ?? { mean: PRIOR_MEAN, n: 0, last: 0, updatedAt: "" };
  }

  /**
   * Topics ranked by mean (only observed ones). One entry per topic family: children are rolled
   * into their root, which is shown under its dominant specific child's id when there is one
   * (so "watch restoration" shows instead of "art", but keyphrase fragments never take a slot).
   * Pass {flat:true} for the raw per-cell ranking.
   */
  topTopics(k = 5, opts: { flat?: boolean } = {}): Array<[string, number, number]> {
    const cells = Object.entries(this.data.topics).filter(([, c]) => c.n > 0);
    if (opts.flat) return cells.sort((a, b) => b[1].mean - a[1].mean).slice(0, k).map(([t, c]) => [t, c.mean, c.n]);
    const fam = new Map<string, ScoreCell>();
    for (const [t, c] of cells) {
      const r = this.root(t);
      const rc = this.data.topics[r];
      fam.set(r, rc && rc.n > 0 ? rc : !fam.has(r) || c.n > fam.get(r)!.n ? c : fam.get(r)!);
    }
    return [...fam.entries()]
      .sort((a, b) => b[1].mean - a[1].mean)
      .slice(0, k)
      .map(([r, c]) => [this.refine(r, c, 1.5), c.mean, c.n]);
  }
  topStyles(k = 3): Array<[string, number, number]> {
    return Object.entries(this.data.styles)
      .filter(([, c]) => c.n > 0)
      .sort((a, b) => b[1].mean - a[1].mean)
      .slice(0, k)
      .map(([t, c]) => [t, c.mean, c.n]);
  }

  /** Engagement level this user typically gives, from all observed topics (n-weighted). */
  userBaseline(): number | null {
    let w = 0, m = 0;
    for (const [t, c] of Object.entries(this.data.topics)) {
      if (c.n <= 0 || this.parent(t)) continue; // children are already rolled into their parent
      w += c.n;
      m += c.n * c.mean;
    }
    return w > 0 ? m / w : null;
  }

  /**
   * The Director's current best guess at the user's passion, or null if not confident:
   * top topic needs n >= minN, a margin over the runner-up, and a mean that is either
   * >= minMean in absolute terms OR clearly above THIS user's own baseline (relLift).
   * The relative path is what lets terse users (short replies, low absolute scores)
   * still produce a confident guess; floor stops it firing on uniformly flat users.
   */
  hypothesis(opts: { minMean?: number; minN?: number; margin?: number; relLift?: number; floor?: number } = {}): string | null {
    const { minMean = 0.55, minN = 1.5, margin = 0.08, relLift = 0.1, floor = 0.3 } = opts;
    // Children (specific hobbies, keyphrases) don't compete with their parent: their evidence is
    // rolled up into the parent cell (session.ts), so the hypothesis consolidates instead of
    // fragmenting across phrases. Orphans (e.g. ham radio, an unknown keyphrase) compete as roots.
    const ranked = Object.entries(this.data.topics).filter(([t, c]) => c.n > 0 && !this.parent(t)).sort((a, b) => b[1].mean - a[1].mean);
    const top = ranked[0];
    if (!top) return null;
    const second = ranked[1]?.[1].mean ?? PRIOR_MEAN;
    const base = this.userBaseline() ?? top[1].mean;
    const strongEnough = top[1].mean >= minMean || (top[1].mean >= floor && top[1].mean - base >= relLift);
    const relMargin = top[1].mean >= minMean ? margin : Math.min(margin, 0.06);
    if (!(strongEnough && top[1].n >= minN && top[1].mean - second >= relMargin)) return null;
    return this.refine(top[0], top[1], minN);
  }

  /**
   * Name the specific hobby (x:/o:) when it carries most of its parent's evidence and is as hot;
   * keyphrases (kp:) are evidence only and never replace a named parent.
   */
  private refine(topic: string, cell: ScoreCell, minN: number): string {
    let best: [string, ScoreCell] | null = null;
    for (const c of this.children(topic)) {
      if (c.startsWith("kp:")) continue;
      const cc = this.data.topics[c];
      if (!cc || cc.n < minN || cc.n < 0.5 * cell.n || cc.mean < cell.mean - 0.03) continue;
      if (!best || cc.n > best[1].n) best = [c, cc];
    }
    return best ? this.refine(best[0], best[1], minN) : topic;
  }

  /** UCB1-style value: exploit mean + exploration bonus for little-seen cells. */
  ucb(kind: "topic" | "style", key: string, c = 0.35): number {
    const cell = kind === "topic" ? this.topic(key) : this.style(key as QuestionStyle);
    const total = Math.max(1, this.data.turns);
    return cell.mean + c * Math.sqrt(Math.log(total + 1) / (cell.n + PRIOR_N));
  }

  allTopics(): string[] {
    return Array.from(new Set([...TOPICS, ...Object.keys(this.data.topics)]));
  }
  allStyles(): QuestionStyle[] {
    return QUESTION_STYLES;
  }
}
