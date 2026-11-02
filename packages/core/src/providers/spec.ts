/**
 * Provider specs, shared by every platform (no Node, no SDK imports). createBackend() in
 * factory.ts (Node: adds pi-ai + Claude Code) and createBrowserBackend() in browser-factory.ts
 * (fetch-only) both take a BackendSpec.
 */
import { ollamaHostUrl } from "../backends.js";
import { defaultEnv, type Env } from "../platform/env.js";
import type { PiCredentialStore, PiModels } from "./pi-ai.js";

export type ProviderKind = "mock" | "ollama" | "ollama-cloud" | "openai-compatible" | "openai" | "anthropic" | "claude-code";
export const PROVIDER_KINDS: ProviderKind[] = ["mock", "ollama", "ollama-cloud", "openai-compatible", "openai", "anthropic", "claude-code"];

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

/** Parse "ollama:gemma3:4b" / "openai:gpt-5.4-mini" / "mock" into provider + model. */
export function parseBackendRef(ref: string): { provider: ProviderKind; model?: string } {
  const i = ref.indexOf(":");
  const provider = (i < 0 ? ref : ref.slice(0, i)) as ProviderKind;
  if (!PROVIDER_KINDS.includes(provider)) throw new Error(`unknown provider "${provider}"; have ${PROVIDER_KINDS.join(", ")}`);
  return { provider, model: i < 0 ? undefined : ref.slice(i + 1) || undefined };
}

export function backendSpecFromEnv(env: Env = defaultEnv()): BackendSpec {
  const raw = (env.BH_PROVIDER ?? env.EEG_BACKEND ?? "mock").toLowerCase();
  let provider = raw as ProviderKind;
  // legacy: EEG_BACKEND=openai + an explicit key/base URL meant the raw HTTP backend
  if (raw === "openai" && !env.BH_PROVIDER && (env.EEG_API_KEY || env.EEG_BASE_URL)) provider = "openai-compatible";
  const n = (v?: string) => (v === undefined || v === "" ? undefined : Number(v));
  return {
    provider,
    model: env.EEG_MODEL ?? env.BH_MODEL,
    baseUrl: provider === "ollama" ? env.EEG_OLLAMA_URL ?? ollamaHostUrl(env.OLLAMA_HOST) : env.EEG_BASE_URL,
    apiKey: env.EEG_API_KEY ?? (provider === "openai-compatible" ? env.OPENAI_API_KEY : provider === "ollama-cloud" ? env.OLLAMA_API_KEY : undefined),
    temperature: n(env.EEG_TEMPERATURE),
    seed: n(env.EEG_SEED),
  };
}
