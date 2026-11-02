/**
 * Fetch-only backend factory for browsers / WKWebView (the web target and the iOS app).
 *   mock               offline, default, always works
 *   ollama             Ollama at a configurable base URL (e.g. http://192.168.1.20:11434 on the LAN)
 *   ollama-cloud       https://ollama.com direct API with an Ollama API key (Bearer). Native fetch
 *                      only (iOS CapacitorHttp): ollama.com has no CORS for browsers
 *   openai-compatible  any /v1/chat/completions server (LM Studio, llama.cpp, OpenRouter, ...)
 *   openai             api.openai.com with the user's API key (CORS-enabled)
 *   anthropic          api.anthropic.com with the user's API key + direct-browser-access header
 * Every network path takes `spec.fetchImpl` (iOS: CapacitorHttp-backed fetch); default is global fetch.
 * Not here (need native code): ChatGPT / Claude subscription sign-in (OAuth local callback
 * servers in pi-ai) and Claude Code (spawns a CLI). See docs/IOS_PORTING.md.
 */
import { MockBackend, OpenAICompatibleBackend, type ModelBackend } from "../backends.js";
import { AnthropicFetchBackend } from "./anthropic-fetch.js";
import { DEFAULT_OLLAMA_URL, OLLAMA_CLOUD_DEFAULT_MODEL, OLLAMA_CLOUD_URL, OllamaBackend } from "./ollama.js";
import type { BackendSpec, ProviderKind } from "./spec.js";

export const BROWSER_PROVIDER_KINDS: ProviderKind[] = ["mock", "ollama", "ollama-cloud", "openai-compatible", "openai", "anthropic"];
export const BROWSER_DEFAULT_MODELS: Partial<Record<ProviderKind, string>> = { openai: "gpt-4o-mini", anthropic: "claude-sonnet-4-5" };

export function createBrowserBackend(spec: BackendSpec & { fetchImpl?: typeof fetch }): ModelBackend {
  switch (spec.provider) {
    case "mock":
      return new MockBackend(spec.seed ?? 42);
    case "ollama":
      return new OllamaBackend({ model: spec.model ?? "llama3.2", baseUrl: spec.baseUrl ?? DEFAULT_OLLAMA_URL, temperature: spec.temperature, seed: spec.seed, fetchImpl: spec.fetchImpl });
    case "ollama-cloud":
      return new OllamaBackend({ model: spec.model ?? OLLAMA_CLOUD_DEFAULT_MODEL, baseUrl: spec.baseUrl ?? OLLAMA_CLOUD_URL, apiKey: spec.apiKey, cloudProvider: true, temperature: spec.temperature, seed: spec.seed, fetchImpl: spec.fetchImpl });
    case "openai-compatible":
      if (!spec.baseUrl) throw new Error("set the server URL first (e.g. http://192.168.1.20:1234/v1)");
      return new OpenAICompatibleBackend({ baseUrl: spec.baseUrl, apiKey: spec.apiKey, model: spec.model ?? "local-model", temperature: spec.temperature, seed: spec.seed, maxTokens: spec.maxTokens, fetchImpl: spec.fetchImpl });
    case "openai":
      if (!spec.apiKey) throw new Error("add an OpenAI API key first (ChatGPT sign-in needs the native app)");
      return new OpenAICompatibleBackend({ baseUrl: spec.baseUrl ?? "https://api.openai.com/v1", apiKey: spec.apiKey, model: spec.model ?? BROWSER_DEFAULT_MODELS.openai!, temperature: spec.temperature, maxTokens: spec.maxTokens, paid: true, fetchImpl: spec.fetchImpl });
    case "anthropic":
      if (!spec.apiKey) throw new Error("add an Anthropic API key first (Claude sign-in needs the native app)");
      return new AnthropicFetchBackend({ apiKey: spec.apiKey, model: spec.model ?? BROWSER_DEFAULT_MODELS.anthropic!, baseUrl: spec.baseUrl, temperature: spec.temperature, maxTokens: spec.maxTokens, fetchImpl: spec.fetchImpl });
    default:
      throw new Error(`provider "${spec.provider}" is not available in the browser build; have ${BROWSER_PROVIDER_KINDS.join(", ")}`);
  }
}
