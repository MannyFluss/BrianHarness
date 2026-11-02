// Dogfood-app topic tagger selection (desktop / iOS / web; browser-safe).
//
// Director decision (Nov 2 2026): with a real cloud provider selected the app tags with llm-extract
// (prompt v2 by default, rank "lead", keyphrase-idf base), the configuration the Researcher scored in
// phaseC/ext2 (top-1 17 vs 12). Mock provider, no route to the extractor, or an extractor failure ->
// keyphrase-idf (a failed / refused / capped call returns nothing and the keyphrase-idf base keeps tagging).
// The extractor speaks the Ollama chat API with gemma4:cloud only (the scored model): it runs through
// Ollama Cloud (needs an Ollama API key, plus a CORS-free fetch in a WebView), or through a LAN Ollama app
// whose selected model is a :cloud tag (forwarded remotely; never a local model). OpenAI / Anthropic
// selected without an Ollama Cloud key -> keyphrase-idf. Every network call is reserved against ONE
// persisted call cap shared by all sessions (kvCallCounter).
import type { KeyValueStore } from "./platform/kv.js";
import type { ProviderKind } from "./providers/spec.js";
import type { TopicTaggerSpec } from "./tagger.js";
import {
  DEFAULT_EXTRACTOR_PROMPT_VERSION, isCloudModelTag, type ExtractorCache, type ExtractorPromptVersion, type LlmExtractorOptions,
} from "./llm-extractor.js";

/** the extractor model the Researcher scored */
export const APP_EXTRACTOR_MODEL = "gemma4:cloud";
/** default shared cap on extractor network calls (same as the sidecar's BH_LLM_MAX_CALLS default) */
export const APP_EXTRACTOR_MAX_CALLS = 50;
export const APP_EXTRACTOR_CALLS_KEY = "llm-extract/calls";

export interface CallCounter {
  reserve(): Promise<boolean>;
  used(): Promise<number>;
}

/** hard call cap persisted in a KeyValueStore (one counter shared by every session); reservations serialized */
export function kvCallCounter(kv: KeyValueStore, max = APP_EXTRACTOR_MAX_CALLS, key = APP_EXTRACTOR_CALLS_KEY): CallCounter {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async () => {
    const n = Number(JSON.parse((await kv.get(key)) ?? "{}").calls ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    used: read,
    reserve: () => {
      const p = chain.then(async () => {
        const n = await read();
        if (n >= max) return false;
        await kv.set(key, JSON.stringify({ calls: n + 1, max }));
        return true;
      });
      chain = p.catch(() => undefined);
      return p.catch(() => false);
    },
  };
}

export interface AppTaggerInput {
  provider: ProviderKind;
  model?: string;
  /** LAN Ollama base URL (normalized) */
  ollamaUrl?: string;
  /** Ollama Cloud API key (secure store), if any */
  ollamaCloudKey?: string | null;
  /** false in a plain browser: Ollama Cloud sends no CORS headers (default true) */
  canReachOllamaCloud?: boolean;
  ollamaCloudUrl?: string;
  /** settings rollback flag; default DEFAULT_EXTRACTOR_PROMPT_VERSION (v2) */
  promptVersion?: ExtractorPromptVersion;
  counter?: CallCounter;
  cache?: ExtractorCache;
  fetchImpl?: typeof fetch;
  /** extractor cadence (default 6 = every 6th user turn, as in the sim) */
  everyN?: number;
}

export interface AppTaggerChoice {
  spec: TopicTaggerSpec;
  /** set when keyphrase-idf was chosen because llm-extract could not be built */
  fallback?: "no_key" | "mock_or_local";
  /** short human reason (HUD / logs) */
  reason: string;
}

const CLOUD: ProviderKind[] = ["ollama-cloud", "openai", "anthropic"];

export function appTaggerSpec(i: AppTaggerInput): AppTaggerChoice {
  const idf: TopicTaggerSpec = { kind: "keyphrase-idf" };
  if (i.provider === "mock") return { spec: idf, fallback: "mock_or_local", reason: "mock provider: keyphrase-idf" };
  const common: LlmExtractorOptions = {
    model: APP_EXTRACTOR_MODEL, rank: "lead", base: "keyphrase-idf", everyN: i.everyN ?? 6,
    promptVersion: i.promptVersion ?? DEFAULT_EXTRACTOR_PROMPT_VERSION,
    ...(i.counter ? { reserveCall: () => i.counter!.reserve() } : {}),
    ...(i.cache ? { cache: i.cache } : {}),
    ...(i.fetchImpl ? { fetchImpl: i.fetchImpl } : {}),
  };
  if (CLOUD.includes(i.provider) && i.ollamaCloudKey && i.canReachOllamaCloud !== false) {
    return {
      spec: { kind: "llm-extract", ...common, provider: "ollama-cloud", apiKey: i.ollamaCloudKey, ...(i.ollamaCloudUrl ? { baseUrl: i.ollamaCloudUrl } : {}) },
      reason: `llm-extract ${APP_EXTRACTOR_MODEL} via Ollama Cloud (prompt ${common.promptVersion})`,
    };
  }
  if (i.provider === "ollama" && i.model && isCloudModelTag(i.model) && i.ollamaUrl) {
    return {
      spec: { kind: "llm-extract", ...common, provider: "ollama", baseUrl: i.ollamaUrl },
      reason: `llm-extract ${APP_EXTRACTOR_MODEL} via the Ollama app (cloud tag; prompt ${common.promptVersion})`,
    };
  }
  return CLOUD.includes(i.provider)
    ? { spec: idf, fallback: "no_key", reason: "no Ollama Cloud key for the extractor: keyphrase-idf" }
    : { spec: idf, fallback: "mock_or_local", reason: "local provider: keyphrase-idf" };
}
