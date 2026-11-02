/**
 * Ollama: auto-detected local models. Detection = GET {base}/api/tags with a short timeout;
 * chat = POST {base}/api/chat (stream:false, options.seed/temperature), the same request shape
 * the Harness Researcher's sim.py uses, so both can share one local Ollama.
 * Local models are free; "*:cloud" models run on Ollama's cloud and count as paid.
 *
 * Ollama Cloud direct API (provider "ollama-cloud"): same /api/chat + /api/tags shapes at
 * https://ollama.com with `Authorization: Bearer <key>`. Only usable from native fetch (Node,
 * Electron main, CapacitorHttp): ollama.com answers the CORS preflight with 405 and no
 * Access-Control-Allow-Origin, so a plain browser/PWA can't call it. Treated as free for the
 * --allow-paid gate ONLY when chosen explicitly as "ollama-cloud" (free tier, key required).
 */
import { timeoutSignal } from "../platform/env.js";
import type { GenerateRequest, GenerateResult, ModelBackend } from "../backends.js";
import { parseChatBody } from "./response-body.js";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const OLLAMA_CLOUD_URL = "https://ollama.com";
export const OLLAMA_CLOUD_DEFAULT_MODEL = "gemma4:cloud";
/** Shown when a plain browser/PWA (no native fetch) tries Ollama Cloud. */
export const OLLAMA_CLOUD_NO_CORS = "Ollama Cloud needs the native app (no CORS): ollama.com doesn't allow browser requests.";

/**
 * Accept either a base URL or a full endpoint: strips trailing slashes and a trailing
 * /api/chat, /api/generate, /api/tags, /api, /v1/chat/completions or /v1 (repeatedly), so
 * "http://h:11434/api/chat", "http://h:11434/v1/" and "http://h:11434" all give "http://h:11434".
 */
export function normalizeOllamaBaseUrl(url: string | undefined | null): string {
  let u = (url ?? "").trim() || DEFAULT_OLLAMA_URL;
  for (;;) {
    const next = u.replace(/\/+$/, "").replace(/\/(api\/(chat|generate|tags)|api|v1\/chat\/completions|v1)$/i, "");
    if (next === u) return u;
    u = next;
  }
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  /** runs on ollama.com, not this machine */
  cloud: boolean;
}
export interface OllamaDetection {
  running: boolean;
  baseUrl: string;
  models: OllamaModelInfo[];
  error?: string;
}

export const isOllamaCloudModel = (name: string) => /(:|-)cloud$/.test(name);

const authHeaders = (apiKey?: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});

export async function detectOllama(baseUrl = DEFAULT_OLLAMA_URL, timeoutMs = 1200, fetchImpl: typeof fetch = fetch, apiKey?: string): Promise<OllamaDetection> {
  const base = normalizeOllamaBaseUrl(baseUrl);
  try {
    const res = await fetchImpl(`${base}/api/tags`, { headers: authHeaders(apiKey), signal: timeoutSignal(timeoutMs) });
    if (!res.ok) return { running: false, baseUrl: base, models: [], error: res.status === 401 || res.status === 403 ? `HTTP ${res.status} (API key rejected)` : `HTTP ${res.status}` };
    const body = JSON.parse((await res.text()) || "{}") as { models?: Array<{ name?: string; model?: string; size?: number; details?: { family?: string; parameter_size?: string } }> };
    const models = (body.models ?? [])
      .map((m) => ({ name: m.name ?? m.model ?? "", sizeBytes: m.size, family: m.details?.family, parameterSize: m.details?.parameter_size, cloud: isOllamaCloudModel(m.name ?? m.model ?? "") }))
      .filter((m) => m.name)
      .sort((a, b) => Number(a.cloud) - Number(b.cloud) || a.name.localeCompare(b.name));
    return { running: true, baseUrl: base, models };
  } catch (err) {
    return { running: false, baseUrl: base, models: [], error: (err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message };
  }
}

/**
 * Ollama Cloud model list: GET https://ollama.com/api/tags with the key. Every model there runs on
 * Ollama's cloud (cloud=true); when listing fails the default model is still offered.
 */
export async function detectOllamaCloud(apiKey: string | undefined, fetchImpl: typeof fetch = fetch, timeoutMs = 4000, baseUrl = OLLAMA_CLOUD_URL): Promise<OllamaDetection> {
  if (!apiKey) return { running: false, baseUrl: normalizeOllamaBaseUrl(baseUrl), models: [], error: "no API key" };
  const d = await detectOllama(baseUrl, timeoutMs, fetchImpl, apiKey);
  const rank = (n: string) => (n === OLLAMA_CLOUD_DEFAULT_MODEL ? 0 : 1);
  return { ...d, models: d.models.map((m) => ({ ...m, cloud: true })).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)) };
}

export class OllamaBackend implements ModelBackend {
  readonly id: string;
  readonly paid: boolean;
  constructor(
    private cfg: {
      model: string;
      baseUrl?: string;
      temperature?: number;
      seed?: number;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
      /** Bearer key (Ollama Cloud direct API) */
      apiKey?: string;
      /** explicit "ollama-cloud" provider: id prefix ollama-cloud:, paid=false (free tier; key required) */
      cloudProvider?: boolean;
    },
  ) {
    if (cfg.cloudProvider && !cfg.apiKey) throw new Error("add an Ollama API key first (ollama.com -> Settings -> Keys)");
    this.id = `${cfg.cloudProvider ? "ollama-cloud" : "ollama"}:${cfg.model}`;
    this.paid = cfg.cloudProvider ? false : isOllamaCloudModel(cfg.model);
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return { text: await this.chat(req.messages, { signal: req.signal }) };
  }
  /** Raw chat call (also used by the adapter's topic tagger with json=true). */
  async chat(messages: Array<{ role: string; content: string }>, opts: { json?: boolean; signal?: AbortSignal; temperature?: number } = {}): Promise<string> {
    const base = normalizeOllamaBaseUrl(this.cfg.baseUrl);
    const f = this.cfg.fetchImpl ?? fetch;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await f(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(this.cfg.apiKey) },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          stream: false,
          ...(opts.json ? { format: "json" } : {}),
          options: { temperature: opts.temperature ?? this.cfg.temperature ?? 0.8, seed: this.cfg.seed ?? 42 },
        }),
        signal: opts.signal ?? timeoutSignal(this.cfg.timeoutMs ?? 120_000),
      });
      const raw = await res.text(); // text() only: CapacitorHttp may not expose a body stream
      if (res.ok) return parseChatBody(raw).text;
      lastErr = new Error(`ollama ${res.status}: ${raw.slice(0, 200)}`);
      if (res.status < 500) break;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    throw lastErr ?? new Error("ollama request failed");
  }
}
