/**
 * Spider Cloud: Manny's Cloudflare Worker (brianharness-worker) at https://api.strangeriver.org, an
 * OpenAI-compatible proxy to Ollama Cloud, authenticated with a per-device token (bhd_...). Browser-safe.
 *   GET  /v1/models            -> {data:[{id}]}   (static fallback SPIDER_CLOUD_MODELS)
 *   POST /v1/chat/completions  -> OpenAI chat, SSE when stream:true
 *   401                        -> "device token invalid or revoked"
 *   429 daily_cap_device|daily_cap_global -> "daily limit reached, resets at <local time>" (reset_at / Retry-After)
 * The Worker sends no CORS for the app: iOS uses the native fetch (BHStream / CapacitorHttp), desktop Node fetch.
 */
import { OpenAICompatibleBackend, type GenerateRequest, type GenerateResult, type ModelBackend } from "../backends.js";

export const SPIDER_CLOUD_URL = "https://api.strangeriver.org";
export const SPIDER_CLOUD_MODELS = ["gemma4:cloud", "gpt-oss:120b-cloud", "gpt-oss:20b-cloud"];
export const SPIDER_CLOUD_DEFAULT_MODEL = "gemma4:cloud";
/** credential id: BHKeychain key credentials/spider (desktop: safeStorage-encrypted credentials.json) */
export const SPIDER_CREDENTIAL_ID = "spider";
export const SPIDER_TOKEN_RE = /^bhd_[A-Za-z0-9_-]{8,}$/;

/** "https://api.strangeriver.org/v1/" -> "https://api.strangeriver.org" (the origin the app stores) */
export function normalizeSpiderUrl(u?: string | null): string {
  const s = (u ?? "").trim() || SPIDER_CLOUD_URL;
  return s.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export class SpiderCloudError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly resetAt?: string) {
    super(message);
    this.name = "SpiderCloudError";
  }
  /** a Worker-side daily cap (the extractor counts it as cap_reached) */
  get capped(): boolean { return this.status === 429 && /^daily_cap/.test(this.code ?? ""); }
}

const defaultTimeFmt = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** friendly message for a non-2xx Worker response */
export function spiderCloudError(status: number, body: string, retryAfter?: string | null, now = Date.now(), fmt: (d: Date) => string = defaultTimeFmt): SpiderCloudError {
  let e: { message?: string; code?: string; reset_at?: string } = {};
  try { e = (JSON.parse(body) as { error?: typeof e }).error ?? {}; } catch { /* not JSON */ }
  if (status === 401) return new SpiderCloudError("Spider Cloud: device token invalid or revoked", 401, e.code);
  if (status === 429 && /^daily_cap/.test(e.code ?? "")) {
    let reset = e.reset_at && !Number.isNaN(Date.parse(e.reset_at)) ? new Date(e.reset_at) : null;
    const ra = Number(retryAfter);
    if (!reset && Number.isFinite(ra) && ra > 0) reset = new Date(now + ra * 1000);
    return new SpiderCloudError(`Spider Cloud: daily limit reached${reset ? `, resets at ${fmt(reset)}` : ""}`, 429, e.code, reset?.toISOString());
  }
  const msg = e.message ?? body.slice(0, 200);
  return new SpiderCloudError(`Spider Cloud ${status}${e.code ? ` ${e.code}` : ""}: ${msg}`, status, e.code);
}

/** fetch that turns every non-2xx Worker response into a thrown SpiderCloudError */
export function spiderFetch(fetchImpl: typeof fetch = (i, n) => fetch(i, n), opts: { now?: () => number; fmt?: (d: Date) => string } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetchImpl(input, init);
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    throw spiderCloudError(res.status, body, res.headers?.get?.("retry-after"), opts.now?.() ?? Date.now(), opts.fmt);
  }) as typeof fetch;
}

/** GET /v1/models; any failure -> the static list (plus the error, for the picker's detail line) */
export async function listSpiderCloudModels(base: string, token: string, fetchImpl?: typeof fetch, timeoutMs = 4000): Promise<{ models: string[]; live: boolean; error?: string }> {
  try {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await spiderFetch(fetchImpl)(`${normalizeSpiderUrl(base)}/v1/models`, { headers: { authorization: `Bearer ${token}` }, ...(ctl ? { signal: ctl.signal } : {}) });
      const j = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string" && !!x);
      return ids.length ? { models: ids, live: true } : { models: SPIDER_CLOUD_MODELS.slice(), live: false, error: "empty model list" };
    } finally {
      if (t) clearTimeout(t);
    }
  } catch (err) {
    return { models: SPIDER_CLOUD_MODELS.slice(), live: false, error: (err as Error).message };
  }
}

/** chat backend: OpenAICompatibleBackend at <base>/v1 with the device token, friendly 401 / 429 errors */
export class SpiderCloudBackend implements ModelBackend {
  readonly id: string;
  /** spends Manny's Ollama Cloud quota through the Worker: the sim / sidecar need --allow-paid */
  readonly paid = true;
  private inner: OpenAICompatibleBackend;
  constructor(cfg: { token?: string; baseUrl?: string; model?: string; temperature?: number; seed?: number; maxTokens?: number; fetchImpl?: typeof fetch; streaming?: boolean; timeoutMs?: number }) {
    if (!cfg.token) throw new Error("add a Spider Cloud device token first (Settings -> Spider Cloud, bhd_...)");
    const model = cfg.model ?? SPIDER_CLOUD_DEFAULT_MODEL;
    this.id = `spider-cloud:${model}`;
    this.inner = new OpenAICompatibleBackend({
      baseUrl: `${normalizeSpiderUrl(cfg.baseUrl)}/v1`, apiKey: cfg.token, model, temperature: cfg.temperature, seed: cfg.seed, maxTokens: cfg.maxTokens,
      paid: true, fetchImpl: spiderFetch(cfg.fetchImpl), streaming: cfg.streaming, timeoutMs: cfg.timeoutMs,
    });
  }
  generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.inner.generate(req);
  }
}
