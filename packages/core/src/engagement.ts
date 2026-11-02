/**
 * Engagement estimator v0: hand-tuned heuristic over the FeatureMap of one turn.
 * Output 0..1. Weights live in one table so they can be calibrated from logs later
 * (or replaced by a learned model) without touching callers.
 */
import type { FeatureMap } from "./types.js";
import { tokenize, topicHits } from "./topics.js";

export const ENGAGEMENT_WEIGHTS = {
  length: 0.22, // more words = more invested
  relLength: 0.14, // longer than THIS user's own norm (log ratio to their running median)
  latency: 0.18, // starting to type quickly
  fluency: 0.12, // few long thinking pauses
  elaboration: 0.2, // concrete topic vocabulary
  curiosity: 0.08, // user asks something back
  hesitation: 0.1, // heavy deleting reads as reluctance (subtracted)
  eeg: 0.25, // only applied when eeg.* features exist
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface EngagementBreakdown {
  score: number;
  parts: Record<string, number>;
}

export function textFeatures(text: string): FeatureMap {
  const words = tokenize(text).length;
  const hits = Object.values(topicHits(text)).reduce((a, b) => a + b, 0);
  return {
    "text.words": words,
    "text.chars": text.length,
    "text.questions": (text.match(/\?/g) ?? []).length,
    "text.exclaims": (text.match(/!/g) ?? []).length,
    "text.topicHits": hits,
  };
}

/** How EEG is blended in. Every field is optional; defaults keep the old 0.25 blend but z-scored and quality-weighted. */
export interface EegBlendOptions {
  /** base blend weight (default: ENGAGEMENT_WEIGHTS.eeg, read at call time) */
  weight?: number;
  /** z-score ln(engagementIndex) against THIS user's own history (default true) */
  zScore?: boolean;
  /** good windows needed before z-scoring kicks in (absolute mapping before that) */
  minHistory?: number;
  /** scale the weight by measured signal quality: eeg.quality, window length, EMG, blinks (default true) */
  qualityWeighting?: boolean;
  /**
   * reliability gate: once typing is clearly informative for this user (its scores vary), EEG must
   * agree with it to keep full weight; junk EEG then can't drag down readable users (default true)
   */
  agreementWeighting?: boolean;
  /** reference window for SNR scaling, seconds (default 20) */
  refWindowSec?: number;
  /**
   * "Readability" of this user's typing = SD of their typing-only scores, mapped 0..1 between
   * typingSdLow and typingSdHigh (defaults .06/.12). Readable users (1) get the agreement gate;
   * flat users (0) get EEG weight x flatBoost (default 1.6; 1 disables), capped at maxWeight.
   */
  flatBoost?: number;
  typingSdLow?: number;
  typingSdHigh?: number;
  maxWeight?: number;
}

/** Process-wide defaults for EegBlendOptions (mutable, like ENGAGEMENT_WEIGHTS, so sweeps can ablate). */
export const EEG_BLEND_DEFAULTS: Required<Omit<EegBlendOptions, "weight">> = {
  zScore: true,
  minHistory: 3,
  qualityWeighting: true,
  agreementWeighting: true,
  refWindowSec: 20,
  flatBoost: 1.6,
  typingSdLow: 0.06,
  typingSdHigh: 0.12,
  maxWeight: 0.6,
};

/** Per-session memory the estimator needs for per-user normalisation (HarnessSession owns it). */
export interface EngagementContext {
  /** ln(engagementIndex) of earlier usable EEG windows */
  eegLnHistory?: number[];
  /** earlier typing/text-only scores */
  typingHistory?: number[];
  /** earlier EEG parts (0..1), aligned with typingHistory where EEG existed */
  eegPartHistory?: number[];
  /** typing scores aligned with eegPartHistory */
  typingAtEeg?: number[];
  options?: EegBlendOptions;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * Signal-quality factor 0..1 for one EEG window. 0 = reject (bad contact). Uses whatever the source
 * reports: eeg.quality (0..1), eeg.windowSec (short windows are noisier, SNR ~ sqrt(T)),
 * eeg.emg vs eeg.beta (muscle power masquerading as beta), eeg.blinks (theta contamination).
 */
export function eegQuality(f: FeatureMap, refWindowSec = 20): { quality: number; reasons: string[] } {
  const reasons: string[] = [];
  let q = clamp01(f["eeg.quality"] ?? 1);
  if (q === 0) return { quality: 0, reasons: ["bad contact (eeg.quality=0)"] };
  if (q < 1) reasons.push(`reported quality ${q.toFixed(2)}`);
  const T = f["eeg.windowSec"];
  if (T !== undefined && T > 0) {
    const w = Math.max(0.4, Math.min(1, Math.sqrt(T / refWindowSec)));
    if (w < 1) reasons.push(`short window ${T.toFixed(0)}s`);
    q *= w;
  }
  const emg = f["eeg.emg"], beta = f["eeg.beta"];
  if (emg !== undefined && emg > 0) {
    const frac = beta ? emg / beta : emg;
    const w = Math.max(0.2, 1 - 1.5 * frac);
    if (w < 0.95) reasons.push(`EMG ${(frac * 100).toFixed(0)}% of beta`);
    q *= w;
  }
  const blinks = f["eeg.blinks"];
  if (blinks !== undefined && T !== undefined && T > 0) {
    const perMin = (blinks * 60) / T;
    const w = 1 / (1 + Math.max(0, perMin - 20) / 30);
    if (w < 0.95) reasons.push(`${perMin.toFixed(0)} blinks/min`);
    q *= w;
  }
  return { quality: clamp01(q), reasons };
}

export function estimateEngagement(f: FeatureMap, ctx: EngagementContext = {}): EngagementBreakdown {
  const W = ENGAGEMENT_WEIGHTS;
  const words = f["text.words"] ?? 0;
  const parts: Record<string, number> = {
    length: words / (words + 15),
    // only present once the session knows the user's median; 0.5 = "typical for them"
    relLength: f["text.relWords"] === undefined ? 0.5 : clamp01(0.5 + 0.5 * Math.tanh(f["text.relWords"]!)),
    latency: f["typing.replyLatencyMs"] === undefined ? 0.5 : Math.exp(-(f["typing.replyLatencyMs"] ?? 0) / 8000),
    fluency: clamp01(1 - (f["typing.pauses"] ?? 0) * 0.2),
    elaboration: clamp01((f["text.topicHits"] ?? 0) / 4),
    curiosity: clamp01(f["text.questions"] ?? 0),
    hesitation: clamp01(((f["typing.deletionRatio"] ?? 0) - 0.15) / 0.35),
  };
  let score =
    W.length * parts.length! +
    W.relLength * parts.relLength! +
    W.latency * parts.latency! +
    W.fluency * parts.fluency! +
    W.elaboration * parts.elaboration! +
    W.curiosity * parts.curiosity! -
    W.hesitation * parts.hesitation!;
  // normalise positive weight mass to 1
  score = score / (W.length + W.relLength + W.latency + W.fluency + W.elaboration + W.curiosity);
  score = clamp01(score);
  parts.typingScore = score;
  if (f["eeg.engagementIndex"] !== undefined) {
    const o = { ...EEG_BLEND_DEFAULTS, ...(ctx.options ?? {}) };
    const ei = Math.max(1e-6, f["eeg.engagementIndex"]!);
    const hist = ctx.eegLnHistory ?? [];
    const useZ = o.zScore && hist.length >= o.minHistory;
    if (useZ) {
      const z = Math.max(-2, Math.min(2, (Math.log(ei) - mean(hist)) / Math.max(0.05, sd(hist))));
      parts.eegZ = z;
      parts.eeg = clamp01(0.5 + 0.25 * z);
    } else {
      parts.eeg = clamp01((ei - 0.2) / 1.0); // absolute mapping until we know this user's baseline
    }
    const quality = o.qualityWeighting ? eegQuality(f, o.refWindowSec).quality : 1;
    const th = ctx.typingHistory ?? [];
    const readable = th.length >= 4 ? clamp01((sd(th) - o.typingSdLow) / Math.max(1e-6, o.typingSdHigh - o.typingSdLow)) : 0.5;
    parts.typingReadability = readable;
    let agreement = 1;
    const tA = ctx.typingAtEeg ?? [], eA = ctx.eegPartHistory ?? [];
    if (o.agreementWeighting && tA.length >= 5) {
      const r = pearson(eA, tA);
      parts.eegAgreementR = r;
      agreement = 1 - readable * (1 - Math.max(0.3, Math.min(1, (r + 0.25) / 0.4)));
    }
    const flat = th.length >= 6 ? 1 + (o.flatBoost - 1) * (1 - readable) : 1;
    parts.eegFlatBoost = flat;
    const w = Math.min(o.maxWeight, (o.weight ?? W.eeg) * quality * agreement * flat);
    parts.eegQuality = quality;
    parts.eegAgreement = agreement;
    parts.eegWeight = w;
    score = (1 - w) * score + w * parts.eeg;
  }
  return { score: clamp01(score), parts };
}
