/**
 * Anthropic Messages API over plain fetch, for browsers / WKWebView (no SDK, no Node).
 * Direct browser calls need the `anthropic-dangerous-direct-browser-access: true` header; the key
 * is then visible to the page, so use it only with the user's own key on their own device.
 */
import type { GenerateRequest, GenerateResult, ModelBackend } from "../backends.js";
import { collapseTranscript } from "./transcript.js";

export const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com";

export class AnthropicFetchBackend implements ModelBackend {
  readonly id: string;
  readonly paid = true;
  constructor(private cfg: { apiKey: string; model: string; baseUrl?: string; maxTokens?: number; temperature?: number; fetchImpl?: typeof fetch }) {
    this.id = `anthropic:${cfg.model}`;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const f = this.cfg.fetchImpl ?? fetch;
    const { system, prompt } = collapseTranscript(req.messages);
    const base = (this.cfg.baseUrl ?? ANTHROPIC_DEFAULT_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
    const res = await f(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens ?? 400,
        system,
        messages: [{ role: "user", content: prompt }],
        ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    return { text, usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens } };
  }
}
