/**
 * Final-guess API: the Director's top-k answer to "what is this user into?" at the end of a
 * session, WITHOUT an extra LLM call. Anti-drift: a topic that led for several turns is not
 * displaced by a last-turn wobble, and a specific (open-vocab) refinement beats its broad parent.
 */
import type { InterestMap } from "./interest-map.js";
import { isSpecificTopic, type RankPrior } from "./tagger.js";

export interface TurnSnapshot {
  turn: number;
  hypothesis: string | null;
  /** live top-3 [topic, mean, n] after this turn */
  top: Array<[string, number, number]>;
  /** ln EEG engagement index of this user turn (only when the EEG window had usable quality) */
  eegLn?: number;
}

/**
 * Preset threshold of the "lead-eeg" reorder, fixed a priori (NOT tuned on any persona set): a ranked label
 * moves above the one before it only if its mean within-session EEG engagement z over its cited turns beats
 * the other's by more than LEAD_EEG_Z * sqrt(1/k_a + 1/k_b) — a one-sided 5% test (z = 1.645) of "no
 * difference" for k_a, k_b cited turns of unit-variance noise. Pure noise then reorders a given adjacent
 * pair at most ~5% of the time, so near-ties keep the extractor's order.
 */
export const LEAD_EEG_Z = 1.645;
/** fewer usable EEG turns than this in the session: no reorder (z-scores would be meaningless) */
export const LEAD_EEG_MIN_TURNS = 4;

/** reorder `ranked` (best first) by EEG engagement on cited turns; see LEAD_EEG_Z. Returns a new array. */
export function eegReorder(ranked: string[], cites: number[][], history: TurnSnapshot[], z = LEAD_EEG_Z, atThreshold = false): string[] {
  const ln = history.map((h) => h.eegLn).filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (ln.length < LEAD_EEG_MIN_TURNS) return [...ranked];
  const mu = ln.reduce((a, b) => a + b, 0) / ln.length;
  const sd = Math.sqrt(ln.reduce((a, b) => a + (b - mu) ** 2, 0) / (ln.length - 1));
  if (!(sd > 1e-9)) return [...ranked];
  const stat = ranked.map((_, i) => {
    const zs = [...new Set(cites[i] ?? [])].map((t) => history[t - 1]?.eegLn).filter((v): v is number => v !== undefined).map((v) => (v - mu) / sd);
    return zs.length ? { m: zs.reduce((a, b) => a + b, 0) / zs.length, k: zs.length } : null;
  });
  const idx = ranked.map((_, i) => i);
  // insertion pass in the extractor's order: a label climbs only past labels it beats by the margin
  for (let i = 1; i < idx.length; i++) {
    for (let j = i; j > 0; j--) {
      const a = stat[idx[j - 1]!], b = stat[idx[j]!];
      if (!a || !b) break;
      const need = z * Math.sqrt(1 / a.k + 1 / b.k);
      if (atThreshold ? b.m - a.m < need : b.m - a.m <= need) break;
      [idx[j - 1], idx[j]] = [idx[j]!, idx[j - 1]!];
    }
  }
  return idx.map((i) => ranked[i]!);
}

/** one extractor label for rankLeadEeg (as in its JSON answer) */
export interface LeadEegLabel { label: string; confidence?: number; turns?: number[] }
export interface LeadEegOptions {
  /**
   * blend weight. 0 / undefined = pure EEG reorder (eegReorder: the extractor's order, a label climbs only past
   * labels it beats by margin * sqrt(1/k_a + 1/k_b) in mean z). w > 0 = blend: score = confidence + w * mean z
   * over the cited turns (0 if none), sorted by score (the Researcher's prototype rule, PREREG_leadeeg §5).
   */
  w?: number;
  /** exact-tie rule. "extractor" (default) = extractor list order; "eeg" = higher mean z first (blend) / a
   *  margin exactly at the threshold also moves (pure) */
  tie_break?: "extractor" | "eeg";
  /**
   * pure mode: the one-sided z of the reorder test (default LEAD_EEG_Z = 1.645).
   * blend mode: score units; the extractor's #1 keeps #1 unless the new leader beats its score by MORE than
   * margin (default 0), the rest of the blend order unchanged.
   */
  margin?: number;
}

/**
 * Pure, deterministic, no I/O. labels in extractor order; eeg[i] = eeg.engagementIndex of user turn i+1 (null /
 * NaN = no usable EEG that turn). Returns every label, reordered. Within-session z of ln(EI) over the turns given:
 * pure mode = sample SD and >= LEAD_EEG_MIN_TURNS EEG turns (exactly eegReorder); blend mode = population SD
 * (1 if 0) and duplicate cited turns counted as given (exactly the prototype rank_proto).
 */
export function rankLeadEeg(labels: LeadEegLabel[], eeg: Array<number | null | undefined>, opts: LeadEegOptions = {}): string[] {
  const names = labels.map((l) => l.label);
  const tb = opts.tie_break ?? "extractor";
  const lnAt = eeg.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.log(Math.max(1e-6, v)) : undefined));
  if (!opts.w) {
    const history: TurnSnapshot[] = lnAt.map((v) => ({ turn: 0, hypothesis: null, top: [], ...(v !== undefined ? { eegLn: v } : {}) }));
    return eegReorder(names, labels.map((l) => l.turns ?? []), history, opts.margin ?? LEAD_EEG_Z, tb === "eeg");
  }
  if (!labels.length) return [];
  const w = opts.w, mg = opts.margin ?? 0;
  const ln = lnAt.filter((v): v is number => v !== undefined);
  const mu = ln.length ? ln.reduce((a, b) => a + b, 0) / ln.length : 0;
  const sd = ln.length ? Math.sqrt(ln.reduce((a, b) => a + (b - mu) ** 2, 0) / ln.length) || 1 : 1;
  const zbar = labels.map((l) => {
    const zz = (l.turns ?? []).filter((t) => t >= 1 && t <= lnAt.length && lnAt[t - 1] !== undefined).map((t) => (lnAt[t - 1]! - mu) / sd);
    return zz.length ? zz.reduce((a, b) => a + b, 0) / zz.length : 0;
  });
  const sc = labels.map((l, i) => (l.confidence ?? 0) + w * zbar[i]!);
  const r9 = (x: number) => Math.round(x * 1e9) / 1e9;
  let order = labels.map((_, i) => i).sort((a, b) => r9(sc[b]!) - r9(sc[a]!) || (tb === "eeg" ? zbar[b]! - zbar[a]! : 0) || a - b);
  if (order[0] !== 0 && sc[order[0]!]! - sc[0]! <= mg) order = [0, ...order.filter((i) => i !== 0)];
  return order.map((i) => names[i]!);
}

/** "Alright" / "alright" / "kp:alright-2": one final guess per shown label */
const labelKey = (g: FinalGuess) => g.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || g.topic;
function uniqueLabels(gs: FinalGuess[], k: number): FinalGuess[] {
  const seen = new Set<string>(), out: FinalGuess[] = [];
  for (const g of gs) { const key = labelKey(g); if (seen.has(key)) continue; seen.add(key); out.push(g); if (out.length >= k) break; }
  return out;
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
  /** a tagger's whole-conversation ranking (LlmInterestExtractor); none = plain engagement ranking */
  prior?: RankPrior | null;
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
  const pr = opts.prior;
  if (!pr || !pr.ranked.length) return uniqueLabels(scored.sort((a, b) => b.score - a.score || b.mean - a.mean), k);
  const drop = new Set(pr.suppress ?? []);
  const rank = new Map<string, number>();
  const order = pr.weight === Infinity && pr.reorderZ !== undefined && pr.cites ? eegReorder(pr.ranked, pr.cites, history, pr.reorderZ) : pr.ranked;
  order.forEach((t, i) => { if (!rank.has(t)) rank.set(t, i); });
  const kept = scored.filter((g) => !drop.has(g.topic) || rank.has(g.topic));
  if (pr.weight === Infinity) {
    // lead mode: the ranked topics first, in their order; the engagement ranking only fills the rest
    const lead = kept.filter((g) => rank.has(g.topic)).sort((a, b) => rank.get(a.topic)! - rank.get(b.topic)!);
    const fill = kept.filter((g) => !rank.has(g.topic)).sort((a, b) => b.score - a.score || b.mean - a.mean);
    return uniqueLabels([...lead, ...fill], k);
  }
  const adj = (g: FinalGuess) => g.score + (rank.has(g.topic) ? pr.weight * 0.85 ** rank.get(g.topic)! : 0);
  return uniqueLabels(kept.sort((a, b) => adj(b) - adj(a) || b.mean - a.mean), k);
}
