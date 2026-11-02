/**
 * Buffer-safe chat response reading for every fetch backend (Ollama, Ollama Cloud,
 * OpenAI-compatible, OpenAI, Anthropic).
 *
 * Why: on iOS, CapacitorHttp patches window.fetch with a native request that BUFFERS the whole
 * response; there may be no usable `response.body` stream. So we never use body readers or
 * incremental tokens: we always request stream:false and read `await res.text()` once, then
 * accept any of:
 *   - one JSON body (the normal non-streamed reply)
 *   - NDJSON (Ollama streaming: {"message":{"content":".."}} per line, all in one chunk)
 *   - SSE (OpenAI `data: {"choices":[{"delta":..}]}` / Anthropic `event: ..` + `data: {..}`), incl. [DONE]
 * in case a server or proxy ignores stream:false.
 */
export interface ChatBody {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

type AnyObj = Record<string, any>;

function fromObject(o: AnyObj, acc: { text: string; usage: { inputTokens?: number; outputTokens?: number } }) {
  if (typeof o.error === "string" || (o.error && typeof o.error === "object" && !o.choices)) {
    throw new Error(`model error: ${typeof o.error === "string" ? o.error : JSON.stringify(o.error).slice(0, 300)}`);
  }
  // Ollama /api/chat (whole or one NDJSON line)
  if (o.message && typeof o.message.content === "string") acc.text += o.message.content;
  if (typeof o.prompt_eval_count === "number") acc.usage.inputTokens = o.prompt_eval_count;
  if (typeof o.eval_count === "number") acc.usage.outputTokens = o.eval_count;
  // OpenAI chat completions (message) or SSE chunk (delta)
  const ch = Array.isArray(o.choices) ? o.choices[0] : undefined;
  if (ch) acc.text += ch.message?.content ?? ch.delta?.content ?? ch.text ?? "";
  if (o.usage?.prompt_tokens !== undefined) acc.usage.inputTokens = o.usage.prompt_tokens;
  if (o.usage?.completion_tokens !== undefined) acc.usage.outputTokens = o.usage.completion_tokens;
  // Anthropic Messages (whole) or SSE events
  if (Array.isArray(o.content)) acc.text += o.content.filter((c: AnyObj) => c?.type === "text").map((c: AnyObj) => c.text ?? "").join("");
  if (o.type === "content_block_delta" && o.delta?.type === "text_delta") acc.text += o.delta.text ?? "";
  if (o.type === "content_block_start" && o.content_block?.type === "text") acc.text += o.content_block.text ?? "";
  const u = o.type === "message_start" ? o.message?.usage : o.usage;
  if (u?.input_tokens !== undefined) acc.usage.inputTokens = u.input_tokens;
  if (u?.output_tokens !== undefined) acc.usage.outputTokens = u.output_tokens;
}

/** Parse a fully buffered chat response body (JSON, NDJSON or SSE). */
export function parseChatBody(raw: string): ChatBody {
  const acc = { text: "", usage: {} as { inputTokens?: number; outputTokens?: number } };
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s) return { text: "" };
  try {
    const whole = JSON.parse(s);
    if (whole && typeof whole === "object") {
      fromObject(whole as AnyObj, acc);
      return { text: acc.text.trim(), usage: acc.usage };
    }
  } catch (e) {
    if ((e as Error).message.startsWith("model error")) throw e;
  }
  let parsedAny = false;
  for (let line of s.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("event:") || line.startsWith(":") || line.startsWith("id:") || line.startsWith("retry:")) continue;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (line === "[DONE]") continue;
    try {
      fromObject(JSON.parse(line) as AnyObj, acc);
      parsedAny = true;
    } catch (e) {
      if ((e as Error).message.startsWith("model error")) throw e;
    }
  }
  if (!parsedAny) throw new Error(`unreadable model response: ${s.slice(0, 200)}`);
  return { text: acc.text.trim(), usage: acc.usage };
}

/** Read a Response with text() only (no body stream), throwing a short error on HTTP failure. */
export async function readChatResponse(res: Response, label: string): Promise<ChatBody> {
  const raw = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${label} ${res.status}: ${raw.slice(0, 300)}`), { status: res.status });
  return parseChatBody(raw);
}
