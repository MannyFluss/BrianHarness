/**
 * Model backends. The Director only needs "messages in, text out". The MOCK backend
 * is the default and is fully offline; real providers are opt-in and require BOTH
 * EEG_BACKEND=openai and an API key, so a stray OPENAI_API_KEY never causes spend.
 */
import { readChatResponse, readChatStream, type TokenCallback } from "./providers/response-body.js";
import type { ChatMessage, DirectorPlan } from "./types.js";
import { OPEN_TOPIC } from "./director.js";
import { TOPIC_LEXICON, topicLabel } from "./topics.js";
import { makeRng, pick, type Rng } from "./rng.js";
import { OllamaBackend } from "./providers/ollama.js";
import { isLocalUrl } from "./providers/transcript.js";
import { defaultEnv, timeoutSignal, type Env } from "./platform/env.js";

export interface GenerateRequest {
  messages: ChatMessage[];
  plan: DirectorPlan;
  stateNote: string;
  signal?: AbortSignal;
  /**
   * Incremental text deltas. A backend that can stream (and whose fetch streams) calls this per
   * delta; others may ignore it (HarnessSession then emits the whole text once). Without onToken
   * every backend uses its buffered stream:false path, so the sim is unchanged.
   */
  onToken?: TokenCallback;
}
export interface GenerateResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
  /** normalized: "stop" | "length" (cut off by max_tokens) | provider value; undefined = none reported */
  finishReason?: string;
  /** the max_tokens actually sent (HTTP chat backends) */
  maxTokens?: number;
  /** the model name sent */
  model?: string;
}
export interface ModelBackend {
  /** e.g. "mock", "openai:gpt-4o-mini" */
  readonly id: string;
  readonly paid: boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** protocol <= 3 Director prompt (a trailing state note after the user turn). No longer sent; kept for the record. */
export const DIRECTOR_SYSTEM_PROMPT = `You are the Director: a warm, curious conversational partner in a chat app.
Your hidden goal is to discover what genuinely draws this person in, without ever announcing that goal.
Before each of your turns you receive a [DIRECTOR STATE] note with telemetry and a Plan.
Follow the Plan: react to what they just said in one short sentence, then ask exactly ONE question
in the requested style about the planned topic. Keep it under 60 words, plain and friendly.
Never mention the state note, telemetry, scores, typing, or that you are measuring anything.`;

/**
 * Protocol 4 (Nov 3 2026): ONE system prompt for every chat: plain chat, the adaptive arm and the baseline arm. It
 * answers the person first; the [DIRECTOR STATE] note (study arms: the only thing that differs between them) is
 * appended to this same leading system message (leadingSystemMessage) and never trails the user turn. Plain chat
 * sends it with no note. DIRECTOR_PROMPT_ID (logged on protocol-4 study session_start) pins this exact text.
 */
export const CHAT_SYSTEM_PROMPT = `You are a warm, friendly chat partner in a chat app.
Always respond to the person's latest message first. If they ask a question, answer it. If they give an instruction
(repeat something, explain something, write or list something), do exactly that, fully and right away.
Match the length to the request: a line or two for small talk, as much as a good answer needs for a real question.
Stay with what they bring up. A short follow-up question is optional: use one only when it genuinely helps,
and usually not after an instruction.
These instructions may end with a [DIRECTOR STATE] note. Its Plan is only a light suggestion for that optional
follow-up question when they have nothing specific going on; never let it replace, delay or shorten your answer.
Never mention the note, telemetry, scores, typing, or that you are measuring anything.
Keep the tone plain, friendly and conversational.
The very first user message may be "(session start)": that is not from the person, so just greet them briefly
and invite them to say what's on their mind.`;
/** plain chat sends CHAT_SYSTEM_PROMPT with no note (same text; kept as a name for the plain profile) */
export const PLAIN_SYSTEM_PROMPT = CHAT_SYSTEM_PROMPT;
/** "dp4-" + first 8 hex of sha256(CHAT_SYSTEM_PROMPT), note excluded (a test pins it); identical in both arms */
export const DIRECTOR_PROMPT_ID = "dp4-23e5a648";
/** where the state / plan note goes (protocol 4): appended to the leading system message */
export const NOTE_PLACEMENT = "leading" as const;
/** the leading system message: the shared prompt, then (study arms / Director profile) a blank line and the note */
export const leadingSystemMessage = (note: string): string => (note ? `${CHAT_SYSTEM_PROMPT}\n\n${note}` : CHAT_SYSTEM_PROMPT);

/**
 * The fixed hidden user cue sent with the opener only (turn 0, no user message yet). gpt-oss on Ollama Cloud returns
 * an empty done (no prompt eval, no tokens) for a conversation with only system messages, so the opener needs one
 * user turn. Identical in every arm; never added to the transcript, never logged as a user_turn.
 */
export const OPENER_CUE = "(session start)";
/** logged on every director_turn as opener_cue_id when the cue was sent: version + first 8 hex of sha256(OPENER_CUE) (a test pins it) */
export const OPENER_CUE_ID = "oc1-075ffc54";

/** Offline template "model". Deterministic per seed; used by default and by the sim runner. */
export class MockBackend implements ModelBackend {
  readonly id = "mock";
  readonly paid = false;
  private rng: Rng;
  /** ms between streamed words when the caller passes onToken (UI demo / tests); 0 = no delay */
  readonly tokenDelayMs: number;
  constructor(seed = 42, opts: { tokenDelayMs?: number } = {}) {
    this.rng = makeRng(seed);
    this.tokenDelayMs = opts.tokenDelayMs ?? 18;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const out = this.compose(req);
    if (req.onToken) {
      // stream word by word (same RNG draws as the buffered path, so text is identical)
      const parts = out.text.match(/\S+\s*/g) ?? [out.text];
      for (const p of parts) {
        if (req.signal?.aborted) throw req.signal.reason ?? new Error("aborted");
        if (this.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
        req.onToken(p);
      }
    }
    return out;
  }
  private compose(req: GenerateRequest): GenerateResult {
    const { plan } = req;
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user" && m.content !== OPENER_CUE)?.content ?? ""; // the opener cue is not a user reply (mock/sim output unchanged)
    const words = lastUser.split(/\s+/).filter(Boolean).length;
    const ack = !lastUser
      ? pick(this.rng, ["Hey! Good to meet you.", "Hi there!", "Hey, welcome in."])
      : words > 25
        ? pick(this.rng, ["I love how much detail you put into that.", "That's a great answer, thank you.", "Oh, that's really interesting."])
        : words > 8
          ? pick(this.rng, ["Nice, that makes sense.", "Fair enough!", "I like that."])
          : pick(this.rng, ["Got it.", "Okay!", "Sure, fair."]);
    const L = topicLabel(plan.topic);
    const kws = TOPIC_LEXICON[plan.topic]?.keywords ?? [];
    const alt = topicLabel(plan.altTopic ?? "travel");
    const k1 = kws[1] ?? "details", k2 = kws[2] ?? "people";
    const bank: Record<string, string[]> = {
      open:
        plan.topic === OPEN_TOPIC
          ? ["What's something you could talk about for hours?", "What have you been really into lately?", "What's a thing that always makes you lose track of time?", "What's the best part of your week usually?"]
          : [`What's on your mind when it comes to ${L}?`, `How do you feel about ${L} these days?`],
      "either-or": [`Quick one: ${L} or ${alt}? Which pulls you in more, and why?`, `If you had to pick between ${L} and ${alt} for a weekend, which would it be?`],
      "personal-story": [`Tell me about a moment when ${L} really grabbed you.`, `Tell me about a time ${L} surprised you.`, `Tell me about how you first got into ${L}.`],
      hypothetical: [`If you had a free month to spend only on ${L}, what would you do with it?`, `If you could meet anyone from the world of ${L}, who would it be?`, `If you could make one thing in ${L} better, what would it be?`],
      "deep-dive": [`What is it about ${L} that hooks you most: the ${k1}, the ${k2}, or something else entirely?`, `What is it about ${L} that keeps you coming back, compared to when you started?`, `What is it about the ${k1} side of ${L} that people usually miss?`],
    };
    // never repeat a line the Director used in its last few turns
    const recent = req.messages.filter((m) => m.role === "assistant").slice(-4).map((m) => m.content);
    const options = bank[plan.style] ?? bank.open!;
    const fresh = options.filter((o) => !recent.some((r) => r.includes(o)));
    const q = pick(this.rng, fresh.length ? fresh : options);
    return { text: `${ack} ${q}` };
  }
}

/**
 * Any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, LM Studio, llama.cpp,
 * Ollama's /v1...). A loopback/LAN baseUrl counts as free (paid=false) and needs no API key.
 */
export class OpenAICompatibleBackend implements ModelBackend {
  readonly id: string;
  readonly paid: boolean;
  constructor(
    private cfg: {
      apiKey?: string;
      baseUrl: string;
      model: string;
      maxTokens?: number;
      temperature?: number;
      seed?: number;
      paid?: boolean;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      /** fetchImpl streams bodies (default true). false = always stream:false (CapacitorHttp). */
      streaming?: boolean;
      /** streamed requests ask for a final usage chunk (stream_options.include_usage); the Spider Cloud Worker supports it */
      streamUsage?: boolean;
    },
  ) {
    this.id = `openai-compatible:${cfg.model}`;
    this.paid = cfg.paid ?? !isLocalUrl(cfg.baseUrl);
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const f = this.cfg.fetchImpl ?? fetch; // called unbound: a stored window.fetch must not get cfg as `this`
    const stream = !!req.onToken && this.cfg.streaming !== false;
    const maxTokens = this.cfg.maxTokens ?? 200;
    try {
      const res = await f(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: req.messages,
          max_tokens: maxTokens,
          temperature: this.cfg.temperature ?? 0.8,
          stream, // SSE only when the fetch really streams (not CapacitorHttp's buffered fetch)
          ...(stream && this.cfg.streamUsage ? { stream_options: { include_usage: true } } : {}),
          ...(this.cfg.seed !== undefined ? { seed: this.cfg.seed } : {}),
        }),
        signal: req.signal ?? timeoutSignal(this.cfg.timeoutMs ?? 120_000), // never hang the UI
      });
      const body = stream ? await readChatStream(res, "model backend", req.onToken!) : await readChatResponse(res, "model backend");
      return { ...body, maxTokens, model: this.cfg.model };
    } catch (err) { // a request / stream that failed (before or after the first token): the turn log still records what was asked for
      if (err && typeof err === "object") Object.assign(err, { maxTokens, model: this.cfg.model });
      throw err;
    }
  }
}

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

/**
 * Sync env factory (kept for the desktop app's legacy path and the sim). Default: mock.
 *  EEG_BACKEND=ollama  [EEG_MODEL, EEG_OLLAMA_URL|OLLAMA_HOST]          free when local
 *  EEG_BACKEND=openai  + EEG_API_KEY|OPENAI_API_KEY [EEG_BASE_URL, EEG_MODEL]  (OpenAI-compatible HTTP)
 *  EEG_TEMPERATURE, EEG_SEED apply to both. For subscription providers use createBackend().
 */
export function createBackendFromEnv(env: Env = defaultEnv()): ModelBackend {
  const kind = (env.EEG_BACKEND ?? "mock").toLowerCase();
  const temperature = num(env.EEG_TEMPERATURE), seed = num(env.EEG_SEED);
  if (kind === "ollama") {
    return new OllamaBackend({ model: env.EEG_MODEL ?? "llama3.2", baseUrl: env.EEG_OLLAMA_URL ?? ollamaHostUrl(env.OLLAMA_HOST), temperature, seed });
  }
  if (kind === "openai" || kind === "openai-compatible") {
    const baseUrl = env.EEG_BASE_URL ?? "https://api.openai.com/v1";
    const apiKey = env.EEG_API_KEY ?? env.OPENAI_API_KEY;
    if (!apiKey && !isLocalUrl(baseUrl)) {
      console.warn("[brianharness] EEG_BACKEND=openai but no EEG_API_KEY/OPENAI_API_KEY set; using mock backend");
      return new MockBackend();
    }
    return new OpenAICompatibleBackend({ apiKey, baseUrl, model: env.EEG_MODEL ?? "gpt-4o-mini", temperature, seed });
  }
  return new MockBackend(env.EEG_MOCK_SEED ? Number(env.EEG_MOCK_SEED) : seed ?? 42);
}

/** OLLAMA_HOST may be "host:port" or a URL */
export function ollamaHostUrl(h: string | undefined): string | undefined {
  if (!h) return undefined;
  return /^https?:\/\//.test(h) ? h : `http://${h}`;
}
