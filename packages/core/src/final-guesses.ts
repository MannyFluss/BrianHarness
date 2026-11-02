/**
 * Final-guess API: the Director's top-k answer to "what is this user into?" at the end of a
 * session, WITHOUT an extra LLM call. Anti-drift: a topic that led for several turns is not
 * displaced by a last-turn wobble, and a specific (open-vocab) refinement beats its broad parent.
 */
import type { InterestMap } from "./interest-map.js";
import { isSpecificTopic } from "./tagger.js";

export interface TurnSnapshot {
  turn: number;
  hypothesis: string | null;
  /** live top-3 [topic, mean, n] after this turn */
  top: Array<[string, number, number]>;
}

export interface FinalGuess {
  topic: string;
  label: string;
  /** 0..1 ranking score (not a probability) */
  score: number;
  mean: number;
  n: number;
  /** recency-weighted share of turns this topic was the hypothesis / in the live top-3 */
  persistence: number;
  /** broader lexicon topic this refines, if any */
  parent?: string;
}

export interface FinalGuessOptions {
  /** per-turn decay of older snapshots (default 0.85) */
  decay?: number;
  /** bonus for specific open-vocab topics (x:/o:/kp:) over broad lexicon ones (default 0.08) */
  specificityBonus?: number;
}

const RANK_CREDIT = [0.6, 0.4, 0.25];

export function finalGuesses(map: InterestMap, history: TurnSnapshot[], k = 3, opts: FinalGuessOptions = {}): FinalGuess[] {
  const decay = opts.decay ?? 0.85;
  const spec = opts.specificityBonus ?? 0.08;
  const T = history.length;
  const pers = new Map<string, number>();
  let wsum = 0;
  history.forEach((h, i) => {
    const w = decay ** (T - 1 - i);
    wsum += w;
    h.top.forEach(([t], r) => pers.set(t, (pers.get(t) ?? 0) + w * (t === h.hypothesis ? 1 : RANK_CREDIT[r] ?? 0)));
    if (h.hypothesis && !h.top.some(([t]) => t === h.hypothesis)) pers.set(h.hypothesis, (pers.get(h.hypothesis) ?? 0) + w);
  });
  const base = map.userBaseline() ?? 0.45;
  const cands = Object.entries(map.data.topics).filter(([, c]) => c.n > 0);
  const scored: FinalGuess[] = cands.map(([t, c]) => {
    let p = wsum > 0 ? (pers.get(t) ?? 0) / wsum : 0;
    const parent = map.parent(t);
    if (parent) p = Math.max(p, 0.5 * (wsum > 0 ? (pers.get(parent) ?? 0) / wsum : 0)); // inherit the parent's lead
    const nconf = Math.min(1, c.n / 3);
    const cur = Math.max(0, Math.min(1, 0.5 + 2 * (c.mean - base)));
    const score = 0.45 * p + 0.4 * cur * nconf + 0.15 * nconf + (parent || isSpecificTopic(t) ? spec : 0);
    return { topic: t, label: map.label(t), score: Math.round(score * 1000) / 1000, mean: c.mean, n: c.n, persistence: Math.round(p * 1000) / 1000, ...(parent ? { parent } : {}) };
  });
  return scored.sort((a, b) => b.score - a.score || b.mean - a.mean).slice(0, k);
}
