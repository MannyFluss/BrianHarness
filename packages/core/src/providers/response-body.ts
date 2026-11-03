/**
 * Chat response reading for every fetch backend (Ollama, Ollama Cloud, OpenAI-compatible,
 * OpenAI, Anthropic). Two paths:
 *
 * BUFFERED (readChatResponse): on iOS without the BHStream plugin, CapacitorHttp patches
 * window.fetch with a native request that BUFFERS the whole response and may expose no usable
 * `response.body`. Backends then request stream:false and read `await res.text()` once,
 * accepting any of:
 *   - one JSON body (the normal non-streamed reply)
 *   - NDJSON (Ollama streaming: {"message":{"content":".."}} per line, all in one chunk)
 *   - SSE (OpenAI `data: {"choices":[{"delta":..}]}` / Anthropic `event: ..` + `data: {..}`), incl. [DONE]
 * in case a server or proxy ignores stream:false.
 *
 * STREAMING (readChatStream): when the fetch really streams (Node / Electron main, browsers,
 * iOS BHStream via nativeStreamFetch) backends request stream:true and feed body bytes through
 * createChatStreamParser, which buffers partial lines (SSE / NDJSON split anywhere, multibyte
 * characters split across chunks via TextDecoder {stream:true}) and emits text deltas. A missing
 * body falls back to text() + parseChatBody, emitted as one delta.
 */
export interface ChatBody {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
  /**
   * Why generation stopped, normalized: "stop" | "length" (token cap hit: the reply is cut off) | other provider
   * values as sent. OpenAI finish_reason, Ollama done_reason, Anthropic stop_reason ("max_tokens" -> "length").
   * Undefined when the response carried none.
   */
  finishReason?: string;
}

type AnyObj = Record<string, any>;
type Acc = { text: string; usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }; finishReason?: string };
const normFinish = (r: unknown): string | undefined => (typeof r === "string" && r ? (r === "max_tokens" ? "length" : r) : undefined);

// Reasoning tokens (gpt-oss delta.reasoning_content / delta.reasoning, Ollama message.thinking, Anthropic thinking
// blocks) are NEVER reply text: only content fields below are read.
function fromObject(o: AnyObj, acc: Acc) {
  if (typeof o.error === "string" || (o.error && typeof o.error === "object" && !o.choices)) {
    const e = o.error as AnyObj | string;
    const msg = typeof e === "string" ? e : typeof e.message === "string" ? `${e.message}${typeof e.code === "string" ? ` (${e.code})` : ""}` : JSON.stringify(e).slice(0, 300);
    throw Object.assign(new Error(`model error: ${msg}`), typeof e === "object" && typeof e.code === "string" ? { code: e.code } : {});
  }
  // Ollama /api/chat (whole or one NDJSON line)
  if (o.message && typeof o.message.content === "string") acc.text += o.message.content;
  if (typeof o.prompt_eval_count === "number") acc.usage.inputTokens = o.prompt_eval_count;
  if (typeof o.eval_count === "number") acc.usage.outputTokens = o.eval_count;
  // OpenAI chat completions (message) or SSE chunk (delta)
  const ch = Array.isArray(o.choices) ? o.choices[0] : undefined;
  if (ch) {
    const c = ch.message?.content ?? ch.delta?.content ?? ch.text;
    if (typeof c === "string") acc.text += c;
    if (normFinish(ch.finish_reason)) acc.finishReason = normFinish(ch.finish_reason);
  }
  if (o.done === true && normFinish(o.done_reason)) acc.finishReason = normFinish(o.done_reason);
  if (o.usage?.prompt_tokens !== undefined) acc.usage.inputTokens = o.usage.prompt_tokens;
  if (o.usage?.completion_tokens !== undefined) acc.usage.outputTokens = o.usage.completion_tokens;
  const rt = o.usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof rt === "number") acc.usage.reasoningTokens = rt;
  // Anthropic Messages (whole) or SSE events
  if (Array.isArray(o.content)) acc.text += o.content.filter((c: AnyObj) => c?.type === "text").map((c: AnyObj) => c.text ?? "").join("");
  if (o.type === "content_block_delta" && o.delta?.type === "text_delta") acc.text += o.delta.text ?? "";
  if (o.type === "content_block_start" && o.content_block?.type === "text") acc.text += o.content_block.text ?? "";
  const u = o.type === "message_start" ? o.message?.usage : o.usage;
  if (u?.input_tokens !== undefined) acc.usage.inputTokens = u.input_tokens;
  if (u?.output_tokens !== undefined) acc.usage.outputTokens = u.output_tokens;
  const sr = o.type === "message_delta" ? o.delta?.stop_reason : o.type === "message" || (o.role === "assistant" && Array.isArray(o.content)) ? o.stop_reason : undefined;
  if (normFinish(sr)) acc.finishReason = normFinish(sr);
}
const bodyOf = (acc: Acc): ChatBody => ({ text: acc.text.trim(), usage: acc.usage, ...(acc.finishReason ? { finishReason: acc.finishReason } : {}) });

/** Parse a fully buffered chat response body (JSON, NDJSON or SSE). */
export function parseChatBody(raw: string): ChatBody {
  const acc: Acc = { text: "", usage: {} };
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s) return { text: "" };
  try {
    const whole = JSON.parse(s);
    if (whole && typeof whole === "object") {
      fromObject(whole as AnyObj, acc);
      return bodyOf(acc);
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
  return bodyOf(acc);
}

/** Read a Response with text() only (no body stream), throwing a short error on HTTP failure. */
export async function readChatResponse(res: Response, label: string): Promise<ChatBody> {
  const raw = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${label} ${res.status}: ${raw.slice(0, 300)}`), { status: res.status });
  return parseChatBody(raw);
}

export type TokenCallback = (delta: string) => void;

/** raw is ONE JSON object spanning more than one line (single-line NDJSON/JSON parse fine as lines). */
function isWholeJsonObject(raw: string): boolean {
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s.startsWith("{") || !s.includes("\n")) return false;
  try {
    const v = JSON.parse(s);
    return !!v && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * Incremental parser for a streamed chat body. push() takes decoded TEXT (any split, even
 * mid-line); every complete NDJSON line / SSE `data:` line is parsed and its new text delta is
 * passed to onDelta. finish() parses the trailing partial line and returns the whole result.
 * A plain JSON content type (server ignored stream:true) is buffered and parsed once at the end.
 */
export function createChatStreamParser(onDelta: TokenCallback, contentType = "") {
  const acc: Acc = { text: "", usage: {} };
  let sawDone = false; // SSE "data: [DONE]"
  let sawChoices = false; // OpenAI chat.completion.chunk stream (the Spider Cloud Worker's wire format)
  let buf = "";
  let raw = "";
  let parsedAny = false;
  const wholeJson = /application\/json/i.test(contentType) && !/ndjson|event-stream/i.test(contentType);
  let emitted = false;
  const emit = (d: string) => {
    if (!d) return;
    emitted = true;
    try {
      onDelta(d);
    } catch {
      /* a UI callback must never break the stream */
    }
  };
  const handle = (lineIn: string) => {
    let line = lineIn.trim();
    if (!line || line.startsWith("event:") || line.startsWith(":") || line.startsWith("id:") || line.startsWith("retry:")) return;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (line === "[DONE]") { sawDone = true; return; }
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // not a complete JSON line (e.g. pretty-printed JSON); finish() reparses the whole body
    }
    if (!obj || typeof obj !== "object") return;
    const before = acc.text.length;
    if (Array.isArray((obj as AnyObj).choices) && (obj as AnyObj).object === "chat.completion.chunk") sawChoices = true;
    fromObject(obj as AnyObj, acc); // throws "model error: .." on error events
    parsedAny = true;
    emit(acc.text.slice(before));
  };
  return {
    push(chunk: string) {
      raw += chunk;
      if (wholeJson) return;
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handle(line);
      }
    },
    finish(): ChatBody {
      if (!wholeJson && buf) handle(buf);
      buf = "";
      // A whole JSON document (server ignored stream:true; URLSession delivered a small body in one
      // chunk, possibly pretty-printed or labelled text/plain) is authoritative: line parsing may
      // have matched an inner object like {"type":"text","text":".."} and missed the reply.
      if (!wholeJson && parsedAny && isWholeJsonObject(raw)) {
        const b = parseChatBody(raw);
        if (!emitted) emit(b.text);
        return b;
      }
      if (!parsedAny) {
        const b = parseChatBody(raw);
        emit(b.text);
        return b;
      }
      // An OpenAI-style stream that just stops (no [DONE], no finish_reason) was cut by the network / server:
      // an error, never a silently complete reply. The text shown so far stays on screen.
      if (sawChoices && !sawDone && !acc.finishReason) {
        throw Object.assign(new Error("the reply stream ended before it finished (connection dropped)"), { code: "stream_incomplete" });
      }
      return bodyOf(acc);
    },
  };
}

/**
 * Read a streamed Response incrementally (body reader + TextDecoder {stream:true}), calling
 * onDelta per text delta. No usable body (CapacitorHttp) -> text() + parseChatBody, one delta.
 */
export async function readChatStream(res: Response, label: string, onDelta: TokenCallback): Promise<ChatBody> {
  if (!res.ok) {
    const raw = await res.text();
    throw Object.assign(new Error(`${label} ${res.status}: ${raw.slice(0, 300)}`), { status: res.status });
  }
  const parser = createChatStreamParser(onDelta, res.headers?.get?.("content-type") ?? "");
  const reader = (res.body as ReadableStream<Uint8Array> | null | undefined)?.getReader?.();
  if (!reader) {
    parser.push(await res.text());
    return parser.finish();
  }
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(typeof value === "string" ? value : dec.decode(value, { stream: true }));
    }
    parser.push(dec.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return parser.finish();
}
