/**
 * Engagement estimator v0: hand-tuned heuristic over the FeatureMap of one turn.
 * Output 0..1. Weights live in one table so they can be calibrated from logs later
 * (or replaced by a learned model) without touching callers.
 */
import type { FeatureMap } from "./types.js";
import { tokenize, topicHits } from "./topics.js";

export const ENGAGEMENT_WEIGHTS = {
  length: 0.32, // more words = more invested
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

export function estimateEngagement(f: FeatureMap): EngagementBreakdown {
  const W = ENGAGEMENT_WEIGHTS;
  const words = f["text.words"] ?? 0;
  const parts: Record<string, number> = {
    length: words / (words + 15),
    latency: f["typing.replyLatencyMs"] === undefined ? 0.5 : Math.exp(-(f["typing.replyLatencyMs"] ?? 0) / 8000),
    fluency: clamp01(1 - (f["typing.pauses"] ?? 0) * 0.2),
    elaboration: clamp01((f["text.topicHits"] ?? 0) / 4),
    curiosity: clamp01(f["text.questions"] ?? 0),
    hesitation: clamp01(((f["typing.deletionRatio"] ?? 0) - 0.15) / 0.35),
  };
  let score =
    W.length * parts.length! +
    W.latency * parts.latency! +
    W.fluency * parts.fluency! +
    W.elaboration * parts.elaboration! +
    W.curiosity * parts.curiosity! -
    W.hesitation * parts.hesitation!;
  // normalise positive weight mass to 1
  score = score / (W.length + W.latency + W.fluency + W.elaboration + W.curiosity);
  if (f["eeg.engagementIndex"] !== undefined) {
    parts.eeg = clamp01((f["eeg.engagementIndex"]! - 0.2) / 1.0);
    score = (1 - W.eeg) * score + W.eeg * parts.eeg;
  }
  return { score: clamp01(score), parts };
}
