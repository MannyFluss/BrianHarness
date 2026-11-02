/**
 * LLM interest extractor (track 2): every N user turns, ONE chat call reads the user's messages so far
 * and returns open-vocabulary candidate interests as JSON {label, confidence, turns}. Those labels feed
 * the interest map as "o:<slug>" topics with an evidence weight from confidence x supporting turns.
 * Between calls (and on any failure) the base tagger (keyphrase-idf by default) keeps tagging.
 *
 * Merge (rankPrior): the latest NON-EMPTY extractor answer is a whole-conversation judgment, so by default
 * ("lead") its labels lead the final guesses in the extractor's own order; keyphrase topics only fill the
 * remaining slots (or all of them while the extractor has said nothing, e.g. an empty or failed reply), and
 * keyphrase topics whose words are all inside a ranked label are dropped as duplicates ("peloton" vs
 * "peloton workouts"). Evidence in the interest map is unchanged, so the Director's planning still sees both.
 *
 * Browser/iOS-safe: no fs, no process.env, no crypto.subtle. Node callers (the sidecar) inject the
 * API key, a disk cache and a hard call cap through the options.
 * Leak-free: the prompt contains no example hobbies; tests check it against the sim persona vocabulary.
 */
import type { RankPrior, TopicTag, TopicTagger } from "./tagger.js";
import { KeyphraseIdfTagger, stem, type KeyphraseIdfOptions } from "./tagger-idf.js";
import { normalizeOllamaBaseUrl } from "./providers/ollama.js";

export interface ExtractorCache {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, raw: string): void | Promise<void>;
}

export interface LlmExtractorOptions {
  /** default "ollama-cloud" (https://ollama.com/api/chat, Bearer key); "ollama" = a base URL you give */
  provider?: "ollama-cloud" | "ollama";
  /** default gemma4:cloud */
  model?: string;
  /** default https://ollama.com */
  baseUrl?: string;
  /** Bearer key (the sidecar fills it from OLLAMA_API_KEY) */
  apiKey?: string;
  /** call after every N-th user turn (default 6) */
  everyN?: number;
  /** explicit 1-based user turns to call at (overrides everyN) */
  atTurns?: number[];
  /** how many most recent user messages go into the prompt (default 12) */
  contextTurns?: number;
  /** default 768 (gpt-oss needs >= 512 or it returns empty text after thinking) */
  numPredict?: number;
  timeoutMs?: number;
  /** "keyphrase-idf" (default) or "none": what tags turns without a call */
  base?: "keyphrase-idf" | "none";
  baseOptions?: KeyphraseIdfOptions;
  /** max candidate interests used per call (default 4) */
  maxLabels?: number;
  /**
   * how the extractor's latest answer ranks the final guesses (default "lead"):
   * "lead" = its labels first in its order, keyphrase fill; "soft" = additive prior (priorWeight);
   * "none" = old behaviour (extractor labels compete as ordinary evidence)
   */
  rank?: "lead" | "soft" | "none";
  /** soft prior weight added to the 0..1 final-guess score of the top label (x0.85 per rank) (default 0.5) */
  priorWeight?: number;
  /** drop keyphrase topics whose words all occur in a ranked extractor label (default true) */
  aliasBase?: boolean;
  /** multiplier on the extractor tags' interest-map evidence weight (default 1) */
  observeScale?: number;
  fetchImpl?: typeof fetch;
  /** response cache keyed by promptKey(); a hit spends no call */
  cache?: ExtractorCache;
  /** called before every network request; return false (or throw) to refuse (hard call cap) */
  reserveCall?: () => boolean | Promise<boolean>;
  /** never touch the network: cache hits only (offline scoring of returned outputs) */
  offline?: boolean;
}

export const EXTRACTOR_SYSTEM_PROMPT = [
  "You read one side of a casual chat: only the USER's messages, numbered by turn.",
  "List the user's specific personal interests, hobbies or passions that the messages give evidence for,",
  "including ones the user only hints at through names, places, tools or jargon.",
  "Use the most specific accurate name for each interest, 1-5 words, in plain English, as a person would",
  "name their hobby. Do not list generic categories alone, jobs, chores, moods, or things the user said they dislike.",
  "Merge mentions of the same interest into one item.",
  'Reply with JSON only: {"interests":[{"label":"<interest>","confidence":<0..1>,"turns":[<turn numbers>]}]}',
  "with 0-5 items, most likely first. confidence = how sure you are this is a real, personal interest.",
].join(" ");

export interface ExtractorPrompt {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
}

export function buildExtractorPrompt(userMessages: string[], model = "gemma4:cloud", contextTurns = 12): ExtractorPrompt {
  const from = Math.max(0, userMessages.length - contextTurns);
  const lines = userMessages.slice(from).map((m, i) => `[turn ${from + i + 1}] ${m.replace(/\s+/g, " ").trim().slice(0, 1200)}`);
  return { model, messages: [{ role: "system", content: EXTRACTOR_SYSTEM_PROMPT }, { role: "user", content: lines.join("\n") }] };
}

/** 64-bit FNV-1a over UTF-16 code units, hex. Deterministic, sync, no crypto API needed. */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const P = 0x100000001b3n, M = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) h = ((h ^ BigInt(s.charCodeAt(i))) * P) & M;
  return h.toString(16).padStart(16, "0");
}
/** cache / output key of a prompt: model + messages */
export const promptKey = (p: ExtractorPrompt) => fnv1a64(JSON.stringify([p.model, p.messages]));

export function requestBody(p: ExtractorPrompt, numPredict = 768): Record<string, unknown> {
  const gptOss = /^gpt-oss/.test(p.model);
  return {
    model: p.model, stream: false, messages: p.messages,
    ...(gptOss ? {} : { format: "json" }),
    options: { temperature: 0, seed: 1, num_predict: Math.max(gptOss ? 512 : 64, numPredict) },
  };
}

export interface ExtractedInterest { label: string; confidence: number; turns: number[] }

/** Parse an Ollama /api/chat response body (string) into interests; tolerant of prose around the JSON. */
export function parseExtractorResponse(raw: string): ExtractedInterest[] {
  let content = raw;
  try {
    const body = JSON.parse(raw) as { message?: { content?: string } };
    if (body && typeof body === "object" && body.message) content = body.message.content ?? "";
  } catch { /* raw content */ }
  const tryParse = (s: string) => { try { return JSON.parse(s) as { interests?: unknown }; } catch { return null; } };
  let j = tryParse(content);
  if (!j) {
    const a = content.indexOf("{"), b = content.lastIndexOf("}");
    if (a >= 0 && b > a) j = tryParse(content.slice(a, b + 1));
  }
  const arr = Array.isArray(j?.interests) ? (j!.interests as unknown[]) : [];
  const out: ExtractedInterest[] = [];
  for (const x of arr) {
    const o = x as { label?: unknown; confidence?: unknown; turns?: unknown };
    const label = String(o.label ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!label || label.length > 60) continue;
    const c = Number(o.confidence);
    const turns = Array.isArray(o.turns) ? o.turns.map(Number).filter((n) => Number.isFinite(n)) : [];
    out.push({ label, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5, turns });
  }
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

export class LlmInterestExtractor implements TopicTagger {
  readonly kind = "llm-extract";
  readonly calls = { network: 0, cached: 0, refused: 0, failed: 0 };
  private base: TopicTagger | null;
  private user: string[] = [];
  private known = new Map<string, string>();
  /** latest non-empty answer: [topic id, label] in the extractor's order */
  private latest: Array<[string, string]> = [];
  /** keyphrase (base) topics seen: id -> label */
  private baseTopics = new Map<string, string>();
  constructor(private o: LlmExtractorOptions = {}) {
    this.base = (o.base ?? "keyphrase-idf") === "none" ? null : new KeyphraseIdfTagger(o.baseOptions);
  }
  get model() { return this.o.model ?? "gemma4:cloud"; }
  private due(turn: number): boolean {
    if (this.o.atTurns?.length) return this.o.atTurns.includes(turn);
    const n = this.o.everyN ?? 6;
    return n > 0 && turn % n === 0;
  }

  /** the prompt that WOULD be sent after this many user messages (for preparing offline runs) */
  promptFor(userMessages: string[]): ExtractorPrompt {
    return buildExtractorPrompt(userMessages, this.model, this.o.contextTurns);
  }

  async tag(text: string, signal?: AbortSignal): Promise<TopicTag[]> {
    this.user.push(text);
    const out = this.base ? await this.base.tag(text, signal) : [];
    for (const t of out) this.baseTopics.set(t.id, t.label);
    if (!this.due(this.user.length)) return out;
    const interests = await this.extract(signal);
    const answer: Array<[string, string]> = [];
    for (const it of interests.slice(0, this.o.maxLabels ?? 4)) {
      const s = slug(it.label);
      if (!s) continue;
      let id = this.known.get(s);
      if (!id) for (const [k, v] of this.known) if (k.includes(s) || s.includes(k)) id = v;
      id ??= `o:${s}`;
      this.known.set(s, id);
      if (!answer.some(([a]) => a === id)) answer.push([id, it.label]);
      if (out.some((x) => x.id === id)) continue;
      const support = Math.max(1, Math.min(3, new Set(it.turns.filter((t) => t >= 1 && t <= this.user.length)).size));
      const w = 0.7 * it.confidence * support * (this.o.observeScale ?? 1);
      out.push({ id, label: it.label, weight: it.confidence, observeWeight: Math.round(w * 1000) / 1000 });
    }
    if (answer.length) this.latest = answer; // an empty / failed reply keeps the previous answer
    return out;
  }

  /** final-guess ranking prior from the latest non-empty answer (null before one, or with rank "none") */
  rankPrior(): RankPrior | null {
    const mode = this.o.rank ?? "lead";
    if (mode === "none" || !this.latest.length) return null;
    const words = (l: string) => l.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
    const ranked = this.latest.map(([id]) => id);
    const suppress: string[] = [];
    if (this.o.aliasBase ?? true) {
      const labelWords = this.latest.map(([, l]) => new Set(words(l)));
      for (const [id, label] of this.baseTopics) {
        const w = words(label);
        if (w.length && labelWords.some((L) => w.every((x) => L.has(x)))) suppress.push(id);
      }
    }
    return { ranked, weight: mode === "lead" ? Infinity : this.o.priorWeight ?? 0.5, suppress };
  }

  private async extract(signal?: AbortSignal): Promise<ExtractedInterest[]> {
    const p = this.promptFor(this.user);
    const key = promptKey(p);
    const hit = await this.o.cache?.get(key);
    if (hit !== undefined) { this.calls.cached++; return parseExtractorResponse(hit); }
    if (this.o.offline) { this.calls.refused++; return []; }
    if (this.o.reserveCall && !(await this.o.reserveCall())) { this.calls.refused++; return []; }
    try {
      const f = this.o.fetchImpl ?? fetch;
      const url = `${normalizeOllamaBaseUrl(this.o.baseUrl ?? "https://ollama.com")}/api/chat`;
      this.calls.network++;
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify(requestBody(p, this.o.numPredict)),
        signal: signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 90_000),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`extractor HTTP ${res.status}`);
      await this.o.cache?.set(key, raw);
      return parseExtractorResponse(raw);
    } catch {
      this.calls.failed++;
      return [];
    }
  }
}
