/**
 * One factory for every provider. Free providers (mock, local Ollama, local OpenAI-compatible
 * servers) never need --allow-paid; everything else reports paid=true and the sim/sidecar refuse
 * it unless explicitly allowed.
 */
import { MockBackend, OpenAICompatibleBackend, ollamaHostUrl, type ModelBackend } from "../backends.js";
import { ClaudeCodeBackend } from "./claude-code.js";
import { DEFAULT_OLLAMA_URL, OllamaBackend } from "./ollama.js";
import { DEFAULT_PI_MODELS, PiAiBackend, createPiModels, type PiCredentialStore, type PiModels } from "./pi-ai.js";

export type ProviderKind = "mock" | "ollama" | "openai-compatible" | "openai" | "anthropic" | "claude-code";
export const PROVIDER_KINDS: ProviderKind[] = ["mock", "ollama", "openai-compatible", "openai", "anthropic", "claude-code"];

export interface BackendSpec {
  provider: ProviderKind;
  model?: string;
  /** Ollama / OpenAI-compatible base URL */
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  /** pi-ai credential store (OpenAI / Anthropic sign-in) */
  credentials?: PiCredentialStore;
  piModels?: PiModels;
  claudeBin?: string;
}

export async function createBackend(spec: BackendSpec): Promise<ModelBackend> {
  switch (spec.provider) {
    case "mock":
      return new MockBackend(spec.seed ?? 42);
    case "ollama":
      return new OllamaBackend({ model: spec.model ?? "llama3.2", baseUrl: spec.baseUrl ?? DEFAULT_OLLAMA_URL, temperature: spec.temperature, seed: spec.seed });
    case "openai-compatible":
      return new OpenAICompatibleBackend({ baseUrl: spec.baseUrl ?? "https://api.openai.com/v1", apiKey: spec.apiKey, model: spec.model ?? "gpt-4o-mini", temperature: spec.temperature, seed: spec.seed, maxTokens: spec.maxTokens });
    case "openai":
    case "anthropic": {
      const models = spec.piModels ?? (await createPiModels(spec.credentials));
      return new PiAiBackend({ models, provider: spec.provider, model: spec.model ?? DEFAULT_PI_MODELS[spec.provider], temperature: spec.temperature, maxTokens: spec.maxTokens });
    }
    case "claude-code":
      return new ClaudeCodeBackend({ model: spec.model ?? "sonnet", bin: spec.claudeBin });
    default:
      throw new Error(`unknown provider ${(spec as BackendSpec).provider}; have ${PROVIDER_KINDS.join(", ")}`);
  }
}

/** Parse "ollama:gemma3:4b" / "openai:gpt-5.4-mini" / "mock" into provider + model. */
export function parseBackendRef(ref: string): { provider: ProviderKind; model?: string } {
  const i = ref.indexOf(":");
  const provider = (i < 0 ? ref : ref.slice(0, i)) as ProviderKind;
  if (!PROVIDER_KINDS.includes(provider)) throw new Error(`unknown provider "${provider}"; have ${PROVIDER_KINDS.join(", ")}`);
  return { provider, model: i < 0 ? undefined : ref.slice(i + 1) || undefined };
}

export function backendSpecFromEnv(env: Record<string, string | undefined> = process.env): BackendSpec {
  const raw = (env.BH_PROVIDER ?? env.EEG_BACKEND ?? "mock").toLowerCase();
  let provider = raw as ProviderKind;
  // legacy: EEG_BACKEND=openai + an explicit key/base URL meant the raw HTTP backend
  if (raw === "openai" && !env.BH_PROVIDER && (env.EEG_API_KEY || env.EEG_BASE_URL)) provider = "openai-compatible";
  const n = (v?: string) => (v === undefined || v === "" ? undefined : Number(v));
  return {
    provider,
    model: env.EEG_MODEL ?? env.BH_MODEL,
    baseUrl: provider === "ollama" ? env.EEG_OLLAMA_URL ?? ollamaHostUrl(env.OLLAMA_HOST) : env.EEG_BASE_URL,
    apiKey: env.EEG_API_KEY ?? (provider === "openai-compatible" ? env.OPENAI_API_KEY : undefined),
    temperature: n(env.EEG_TEMPERATURE),
    seed: n(env.EEG_SEED),
  };
}
