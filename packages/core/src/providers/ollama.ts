/**
 * Ollama: auto-detected local models. Detection = GET {base}/api/tags with a short timeout;
 * chat = POST {base}/api/chat (stream:false, options.seed/temperature), the same request shape
 * the Harness Researcher's sim.py uses, so both can share one local Ollama.
 * Local models are free; "*:cloud" models run on Ollama's cloud and count as paid.
 */
import type { GenerateRequest, GenerateResult, ModelBackend } from "../backends.js";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

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

export async function detectOllama(baseUrl = DEFAULT_OLLAMA_URL, timeoutMs = 1200, fetchImpl: typeof fetch = fetch): Promise<OllamaDetection> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { running: false, baseUrl: base, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string; size?: number; details?: { family?: string; parameter_size?: string } }> };
    const models = (body.models ?? [])
      .map((m) => ({ name: m.name ?? m.model ?? "", sizeBytes: m.size, family: m.details?.family, parameterSize: m.details?.parameter_size, cloud: isOllamaCloudModel(m.name ?? m.model ?? "") }))
      .filter((m) => m.name)
      .sort((a, b) => Number(a.cloud) - Number(b.cloud) || a.name.localeCompare(b.name));
    return { running: true, baseUrl: base, models };
  } catch (err) {
    return { running: false, baseUrl: base, models: [], error: (err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message };
  }
}

export class OllamaBackend implements ModelBackend {
  readonly id: string;
  readonly paid: boolean;
  constructor(private cfg: { model: string; baseUrl?: string; temperature?: number; seed?: number; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.id = `ollama:${cfg.model}`;
    this.paid = isOllamaCloudModel(cfg.model);
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return { text: await this.chat(req.messages, { signal: req.signal }) };
  }
  /** Raw chat call (also used by the adapter's topic tagger with json=true). */
  async chat(messages: Array<{ role: string; content: string }>, opts: { json?: boolean; signal?: AbortSignal; temperature?: number } = {}): Promise<string> {
    const base = (this.cfg.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
    const f = this.cfg.fetchImpl ?? fetch;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await f(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          stream: false,
          ...(opts.json ? { format: "json" } : {}),
          options: { temperature: opts.temperature ?? this.cfg.temperature ?? 0.8, seed: this.cfg.seed ?? 42 },
        }),
        signal: opts.signal ?? AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { message?: { content?: string } };
        return (body.message?.content ?? "").trim();
      }
      lastErr = new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status < 500) break;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    throw lastErr ?? new Error("ollama request failed");
  }
}
