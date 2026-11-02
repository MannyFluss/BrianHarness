/**
 * A rule-based simulated user. It only sees the Director's TEXT (never the plan),
 * infers what is being asked, and replies with text plus synthetic keystroke events
 * whose speed, length, pauses, and deletions depend on its hidden interest.
 */
import { TOPIC_LEXICON, detectTopics, makeRng, pick, type QuestionStyle, type Rng, type TypingEvent } from "@eeg/core";
import type { Persona } from "./personas.js";

const FILLER = ["honestly", "i guess", "kind of", "sometimes", "like", "you know", "it depends", "for sure", "a bit", "mostly", "really", "actually"];

export function inferStyle(text: string): QuestionStyle {
  if (/tell me about a (moment|time)/i.test(text)) return "personal-story";
  if (/^.*\bif you (had|could)\b/i.test(text)) return "hypothetical";
  if (/which pulls you|\bor\b.*\?\s*which/i.test(text)) return "either-or";
  if (/what is it about/i.test(text)) return "deep-dive";
  return "open";
}

export interface SimReply {
  text: string;
  events: TypingEvent[];
  sentAt: number;
  /** hidden ground truth interest 0..1 for this reply (used by fake EEG + diagnostics) */
  truth: number;
  topic: string | null;
}

export class SimUser {
  private rng: Rng;
  constructor(readonly persona: Persona, seed = 1) {
    this.rng = makeRng(seed);
  }
  interest(topic: string | null): number {
    const p = this.persona;
    if (!topic) return 0.3;
    if (topic === p.passion) return 0.95;
    if (p.likes.includes(topic)) return 0.55;
    if (p.dislikes.includes(topic)) return 0.08;
    return 0.25;
  }
  private noise(a: number) {
    return (this.rng() - 0.5) * 2 * a;
  }

  respond(directorText: string, shownAt: number): SimReply {
    const p = this.persona;
    const style = inferStyle(directorText);
    const asked = detectTopics(directorText);
    let topic: string | null;
    if (asked.length === 0) {
      topic = this.rng() < p.openDrift ? p.passion : this.rng() < 0.5 ? pick(this.rng, p.likes) : null;
    } else {
      topic = [...asked].sort((a, b) => this.interest(b) - this.interest(a))[0]!;
    }
    let v = this.interest(topic) + (style === p.favoriteStyle ? 0.12 : 0) + this.noise(0.08);
    v = Math.min(1, Math.max(0, v));

    const kws = topic ? TOPIC_LEXICON[topic]!.keywords : [];
    const targetWords = Math.max(2, Math.round(3 + v * 38 + this.noise(4)));
    const words: string[] = [];
    const kwCount = Math.round(v * 4);
    for (let i = 0; i < targetWords; i++) {
      words.push(i % Math.max(2, Math.floor(targetWords / Math.max(1, kwCount))) === 1 && kws.length ? pick(this.rng, kws) : pick(this.rng, FILLER));
    }
    // occasionally a bored user steers toward what they actually care about
    if (v < 0.35 && this.rng() < 0.12) words.push("but", "honestly", "i'd", "rather", "talk", "about", TOPIC_LEXICON[p.passion]!.keywords[0]!);
    let text = words.join(" ");
    if (v > 0.7 && this.rng() < 0.4) text += ". what about you?";
    text = text.charAt(0).toUpperCase() + text.slice(1);

    // synthetic keystrokes
    const events: TypingEvent[] = [];
    let t = shownAt + Math.max(400, p.typing.baseLatencyMs * (1.6 - v) + this.noise(800));
    const msPerChar = 1000 / (p.typing.charsPerSec * (0.7 + 0.5 * v));
    const pauseChance = (1 - v) * 0.04;
    const delRate = p.typing.deleteRate * (1.5 - v);
    let len = 0;
    for (const ch of text) {
      if (this.rng() < pauseChance) t += 2000 + this.rng() * 4000;
      if (this.rng() < delRate * 0.15) {
        const n = 1 + Math.floor(this.rng() * 5);
        for (let k = 0; k < n; k++) {
          len += 1;
          t += msPerChar;
          events.push({ t, kind: "insert", len });
        }
        for (let k = 0; k < n; k++) {
          len -= 1;
          t += msPerChar * 0.6;
          events.push({ t, kind: "delete", len });
        }
      }
      len += 1;
      t += msPerChar * (0.6 + this.rng() * 0.8);
      events.push({ t, kind: ch === " " ? "insert" : "insert", len });
    }
    const sentAt = t + 300;
    events.push({ t: sentAt, kind: "submit", len });
    return { text, events, sentAt, truth: v, topic };
  }
}
