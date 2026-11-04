/**
 * E3: one Director call. Backends speak "messages in, text out" with the Worker's X-BH-Role header; the Worker's
 * 429 role_cap_<role> (and the device / global caps) become WorkerHttpError -> health budget.<role>_cap.
 * Output handling: strip code fences, parse, validate (note.schema.json); on failure ONE repair retry with the
 * validation errors; a second failure = output null + director.schema_invalid.
 */
import { ROLE_HEADER, WORKER_CAP_TO_HEALTH } from "../ad-contracts/index.js";
import type { BhAdEventBody, HealthCode, Role, Usage, WorkerErrorBody, WorkerErrorCode, DirectorOutput } from "../ad-contracts/index.js";
import type { ChatMessage } from "../types.js";
import { parseDirectorText, validateDirectorOutput } from "./validate.js";

export interface AdChatRequest { role: Role; model: string; messages: ChatMessage[]; maxTokens: number; signal?: AbortSignal }
export interface AdChatResult { text: string; usage: Usage; finishReason: string | null }
export interface AdChatBackend { readonly id: string; complete(req: AdChatRequest): Promise<AdChatResult> }

export class WorkerHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly role: Role | null, readonly body: WorkerErrorBody | null) {
    super(`worker ${status}${code ? " " + code : ""}`);
  }
}
type HealthBody = Extract<BhAdEventBody, { type: "health" }>;
/** a Worker error -> the health line (budget caps by role); null if it is not a cap */
export function workerErrorHealth(err: unknown, requestRole: Role): HealthBody | null {
  if (!(err instanceof WorkerHttpError)) return null;
  const code = err.code as keyof typeof WORKER_CAP_TO_HEALTH | null;
  if (err.status === 429 && code && code in WORKER_CAP_TO_HEALTH) {
    return { type: "health", check: "budget", ok: false, code: WORKER_CAP_TO_HEALTH[code] as HealthCode, http_status: 429, worker_code: code as WorkerErrorCode, role: err.role ?? requestRole };
  }
  return { type: "health", check: "worker.reachable", ok: false, code: "net.worker_unreachable", http_status: err.status, ...(err.code ? { detail: err.code } : {}) };
}
const nullUsage = (): Usage => ({ prompt_tokens: null, completion_tokens: null, reasoning_tokens: null });

/**
 * The Worker's OpenAI-compatible /v1/chat/completions with the role header. Not exercised against the network in
 * Phase 1 (tests use a fake fetch). The device token is sent as a bearer header and never logged.
 */
export class WorkerChatBackend implements AdChatBackend {
  readonly id: string;
  constructor(private cfg: { baseUrl: string; token: () => string | null; fetchImpl?: typeof fetch }) { this.id = "worker"; }
  async complete(req: AdChatRequest): Promise<AdChatResult> {
    const f = this.cfg.fetchImpl ?? fetch;
    const token = this.cfg.token();
    const res = await f(this.cfg.baseUrl.replace(/\/$/, "") + "/v1/chat/completions", {
      method: "POST", signal: req.signal,
      headers: { "content-type": "application/json", [ROLE_HEADER]: req.role, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model: req.model, messages: req.messages, max_tokens: req.maxTokens, stream: false }),
    });
    const text = await res.text();
    let j: unknown = null;
    try { j = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const body = (j && typeof j === "object" && "error" in (j as object) ? (j as WorkerErrorBody) : null);
      throw new WorkerHttpError(res.status, body?.error?.code ?? null, (body?.error?.role as Role | undefined) ?? null, body);
    }
    const r = j as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } };
    return {
      text: r?.choices?.[0]?.message?.content ?? "",
      finishReason: r?.choices?.[0]?.finish_reason ?? null,
      usage: { prompt_tokens: r?.usage?.prompt_tokens ?? null, completion_tokens: r?.usage?.completion_tokens ?? null, reasoning_tokens: r?.usage?.completion_tokens_details?.reasoning_tokens ?? null },
    };
  }
}

/** scripted offline backend: each step is a reply text (or an error) after delayMs; `fallback` answers when the script is empty */
export interface MockStep { text?: string; error?: WorkerHttpError | Error; delayMs?: number; usage?: Partial<Usage> }
export class MockAdBackend implements AdChatBackend {
  readonly id = "mock";
  readonly calls: AdChatRequest[] = [];
  constructor(private script: MockStep[] = [], private fallback: (req: AdChatRequest) => MockStep = () => ({ text: "ok" }), private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}
  push(...s: MockStep[]) { this.script.push(...s); }
  async complete(req: AdChatRequest): Promise<AdChatResult> {
    this.calls.push(req);
    const s = this.script.length ? this.script.shift()! : this.fallback(req);
    if (s.delayMs) await this.sleep(s.delayMs);
    if (s.error) throw s.error;
    const text = s.text ?? "";
    return { text, finishReason: "stop", usage: { ...nullUsage(), prompt_tokens: null, completion_tokens: Math.ceil(text.length / 4), ...s.usage } };
  }
}

export interface DirectorCallResult {
  output: DirectorOutput | null;
  repaired: boolean;
  error?: HealthCode;
  usage: Usage;
  genMs: number;
  errors: string[];
  health?: HealthBody;
}
export const REPAIR_PROMPT = (errors: string[]) =>
  `Your reply was not valid DirectorOutput JSON:\n${errors.slice(0, 6).map((e) => "- " + e).join("\n")}\nReply again with ONE corrected JSON object only, no prose, no code fence.`;

const addUsage = (a: Usage, b: Usage): Usage => {
  const s = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return { prompt_tokens: s(a.prompt_tokens, b.prompt_tokens), completion_tokens: s(a.completion_tokens, b.completion_tokens), reasoning_tokens: s(a.reasoning_tokens, b.reasoning_tokens) };
};

export async function callDirector(backend: AdChatBackend, model: string, maxTokens: number, system: string, input: string, mono: () => number): Promise<DirectorCallResult> {
  const t0 = mono();
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: input }];
  let usage = nullUsage();
  const attempt = async (msgs: ChatMessage[]) => {
    const r = await backend.complete({ role: "director", model, messages: msgs, maxTokens });
    usage = addUsage(usage, r.usage);
    if (!r.text.trim()) return { raw: r.text, value: null as unknown, errors: ["empty completion" + (r.finishReason === "length" ? " (length cutoff)" : "")] };
    const p = parseDirectorText(r.text);
    if (!p.ok) return { raw: r.text, value: null as unknown, errors: [p.error] };
    // empty note.evidence is its own rail (evidence_missing), not a schema failure: no repair for it
    return { raw: r.text, value: p.value, errors: validateDirectorOutput(p.value, { allowEmptyEvidence: true }) };
  };
  try {
    const a = await attempt(messages);
    if (!a.errors.length) return { output: a.value as DirectorOutput, repaired: false, usage, genMs: mono() - t0, errors: [] };
    const b = await attempt([...messages, { role: "assistant", content: a.raw }, { role: "user", content: REPAIR_PROMPT(a.errors) }]);
    if (!b.errors.length) return { output: b.value as DirectorOutput, repaired: true, usage, genMs: mono() - t0, errors: a.errors };
    return { output: null, repaired: true, error: "director.schema_invalid", usage, genMs: mono() - t0, errors: [...a.errors, ...b.errors],
      health: { type: "health", check: "upstream.reply_shape", ok: false, code: "director.schema_invalid", detail: b.errors[0]!.slice(0, 160) } };
  } catch (err) {
    const h = workerErrorHealth(err, "director") ?? { type: "health" as const, check: "worker.reachable" as const, ok: false, code: "net.worker_unreachable" as const };
    return { output: null, repaired: false, error: h.code ?? undefined, usage, genMs: mono() - t0, errors: [String((err as Error).message)], health: h };
  }
}
