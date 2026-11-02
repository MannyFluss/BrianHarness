/**
 * Model backends. The Director only needs "messages in, text out". The MOCK backend
 * is the default and is fully offline; real providers are opt-in and require BOTH
 * EEG_BACKEND=openai and an API key, so a stray OPENAI_API_KEY never causes spend.
 */
import type { ChatMessage, DirectorPlan } from "./types.js";
import { OPEN_TOPIC } from "./director.js";
import { TOPIC_LEXICON, topicLabel } from "./topics.js";
import { makeRng, pick, type Rng } from "./rng.js";

export interface GenerateRequest {
  messages: ChatMessage[];
  plan: DirectorPlan;
  stateNote: string;
  signal?: AbortSignal;
}
export interface GenerateResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}
export interface ModelBackend {
  /** e.g. "mock", "openai:gpt-4o-mini" */
  readonly id: string;
  readonly paid: boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export const DIRECTOR_SYSTEM_PROMPT = `You are the Director: a warm, curious conversational partner in a chat app.
Your hidden goal is to discover what genuinely draws this person in, without ever announcing that goal.
Before each of your turns you receive a [DIRECTOR STATE] note with telemetry and a Plan.
Follow the Plan: react to what they just said in one short sentence, then ask exactly ONE question
in the requested style about the planned topic. Keep it under 60 words, plain and friendly.
Never mention the state note, telemetry, scores, typing, or that you are measuring anything.`;

/** Offline template "model". Deterministic per seed; used by default and by the sim runner. */
export class MockBackend implements ModelBackend {
  readonly id = "mock";
  readonly paid = false;
  private rng: Rng;
  constructor(seed = 42) {
    this.rng = makeRng(seed);
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const { plan } = req;
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
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

/** Any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, local LM Studio, Ollama...). */
export class OpenAICompatibleBackend implements ModelBackend {
  readonly id: string;
  readonly paid = true;
  constructor(private cfg: { apiKey: string; baseUrl: string; model: string; maxTokens?: number }) {
    this.id = `openai:${cfg.model}`;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model: this.cfg.model, messages: req.messages, max_tokens: this.cfg.maxTokens ?? 200, temperature: 0.8 }),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`model backend ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = body.choices?.[0]?.message?.content?.trim() ?? "";
    return { text, usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens } };
  }
}

/**
 * Pick a backend from env. Default: mock. Real calls need EEG_BACKEND=openai AND
 * EEG_API_KEY (or OPENAI_API_KEY). EEG_BASE_URL / EEG_MODEL are optional.
 */
export function createBackendFromEnv(env: Record<string, string | undefined> = process.env): ModelBackend {
  const kind = (env.EEG_BACKEND ?? "mock").toLowerCase();
  if (kind === "openai") {
    const apiKey = env.EEG_API_KEY ?? env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("[eeg-harness] EEG_BACKEND=openai but no EEG_API_KEY/OPENAI_API_KEY set; using mock backend");
      return new MockBackend();
    }
    return new OpenAICompatibleBackend({ apiKey, baseUrl: env.EEG_BASE_URL ?? "https://api.openai.com/v1", model: env.EEG_MODEL ?? "gpt-4o-mini" });
  }
  return new MockBackend(env.EEG_MOCK_SEED ? Number(env.EEG_MOCK_SEED) : 42);
}
