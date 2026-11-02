/**
 * One factory for every provider. Free providers (mock, local Ollama, local OpenAI-compatible
 * servers, and the explicit "ollama-cloud" provider: free tier, API key required) never need --allow-paid; everything else reports paid=true and the sim/sidecar refuse
 * it unless explicitly allowed.
 */
import { MockBackend, OpenAICompatibleBackend, type ModelBackend } from "../backends.js";
import { ClaudeCodeBackend } from "./claude-code.js";
import { DEFAULT_OLLAMA_URL, OLLAMA_CLOUD_DEFAULT_MODEL, OLLAMA_CLOUD_URL, OllamaBackend } from "./ollama.js";
import { DEFAULT_PI_MODELS, PiAiBackend, createPiModels } from "./pi-ai.js";
import { PROVIDER_KINDS, type BackendSpec } from "./spec.js";
export * from "./spec.js";

export async function createBackend(spec: BackendSpec): Promise<ModelBackend> {
  switch (spec.provider) {
    case "mock":
      return new MockBackend(spec.seed ?? 42);
    case "ollama":
      return new OllamaBackend({ model: spec.model ?? "llama3.2", baseUrl: spec.baseUrl ?? DEFAULT_OLLAMA_URL, temperature: spec.temperature, seed: spec.seed });
    case "ollama-cloud":
      return new OllamaBackend({ model: spec.model ?? OLLAMA_CLOUD_DEFAULT_MODEL, baseUrl: spec.baseUrl ?? OLLAMA_CLOUD_URL, apiKey: spec.apiKey, cloudProvider: true, temperature: spec.temperature, seed: spec.seed });
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

