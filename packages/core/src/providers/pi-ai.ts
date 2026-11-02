/**
 * Subscription / API-key providers through pi-ai (@earendil-works/pi-ai, MIT):
 *  - "openai":    ChatGPT subscription sign-in (OAuth) or OPENAI API key
 *  - "anthropic": Claude Pro/Max sign-in (OAuth) or Anthropic API key
 * pi-ai is imported lazily, so the core (and the sidecar with mock/ollama) has no runtime cost
 * from it unless one of these providers is actually used.
 */
import type { GenerateRequest, GenerateResult, ModelBackend } from "../backends.js";
import { collapseTranscript } from "./transcript.js";

export type PiProviderId = "openai" | "anthropic";
export const PI_PROVIDERS: PiProviderId[] = ["openai", "anthropic"];

// Loose structural types so core's public d.ts doesn't depend on pi-ai's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PiModels = any;
export interface PiCredentialStore {
  read(providerId: string): Promise<unknown>;
  list(): Promise<string[]>;
  modify(providerId: string, fn: (cur: unknown) => unknown | Promise<unknown>): Promise<unknown>;
  delete(providerId: string): Promise<void>;
}

/** Build a pi-ai Models collection with the OpenAI + Anthropic providers registered. */
export async function createPiModels(credentials?: PiCredentialStore): Promise<PiModels> {
  const { createModels } = await import("@earendil-works/pi-ai");
  const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
  const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const models = createModels(credentials ? { credentials: credentials as any } : {});
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  return models;
}

export const DEFAULT_PI_MODELS: Record<PiProviderId, string> = { openai: "gpt-5.4-mini", anthropic: "claude-sonnet-4-6" };

export class PiAiBackend implements ModelBackend {
  readonly id: string;
  readonly paid = true;
  constructor(private cfg: { models: PiModels; provider: string; model: string; temperature?: number; maxTokens?: number }) {
    this.id = `${cfg.provider}:${cfg.model}`;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = this.cfg.models.getModel(this.cfg.provider, this.cfg.model);
    if (!model) throw new Error(`unknown ${this.cfg.provider} model ${this.cfg.model}`);
    const { system, prompt } = collapseTranscript(req.messages);
    const msg = await this.cfg.models.completeSimple(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { maxTokens: this.cfg.maxTokens ?? 400, reasoning: "low", signal: req.signal, ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}) },
    );
    if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage ?? `${this.id} ${msg.stopReason}`);
    const text = (msg.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
    return { text, usage: { inputTokens: msg.usage?.input, outputTokens: msg.usage?.output } };
  }
}
