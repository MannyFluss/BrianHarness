// nativeStreamFetch: a fetch() over IOS Dev's BHStream Capacitor plugin (Swift, URLSession), so the
// iOS app gets real token streaming. CapacitorHttp's patched window.fetch buffers whole responses.
//
// Plugin contract (Swift side, see docs/IOS_PORTING.md "BHStream"):
//   start({ url, method, headers, body? }) -> { id }
//   cancel({ id })
//   addListener("bhstream", ev) with, per id and in order:
//     { id, type: "head", status, headers }
//     0..n { id, type: "chunk", data?: string, b64?: string }   (b64 = raw bytes, preferred)
//     { id, type: "end" } | { id, type: "error", message }
// Events can arrive before start() resolves (we don't know our id yet), so the listener is added
// BEFORE start and early events are buffered, then replayed filtered by id.

export type BHStreamEvent =
  | { id: string; type: "head"; status: number; headers?: Record<string, string> }
  | { id: string; type: "chunk"; data?: string; b64?: string }
  | { id: string; type: "end" }
  | { id: string; type: "error"; message?: string };

export interface ListenerHandle {
  remove(): Promise<void> | void;
}
export interface BHStreamPlugin {
  start(o: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<{ id: string }>;
  cancel(o: { id: string }): Promise<void> | void;
  addListener(event: "bhstream", cb: (ev: BHStreamEvent) => void): Promise<ListenerHandle> | ListenerHandle;
}

type CapGlobal = {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  registerPlugin?: <T>(name: string) => T;
  Plugins?: Record<string, unknown>;
};

/** The named plugin from window.Capacitor (no @capacitor/core import), or null if not installed. */
export function capacitorPlugin<T>(win: unknown, name: string): T | null {
  try {
    const cap = (win as { Capacitor?: CapGlobal }).Capacitor;
    if (!cap?.isNativePlatform?.()) return null;
    // registerPlugin() returns a proxy even for plugins that don't exist, so ask first
    const available = cap.isPluginAvailable ? cap.isPluginAvailable(name) : !!cap.Plugins?.[name];
    if (!available) return null;
    const existing = cap.Plugins?.[name] as T | undefined;
    return existing ?? cap.registerPlugin?.<T>(name) ?? null;
  } catch {
    return null;
  }
}

/** b64 -> bytes without Buffer (WKWebView has atob). */
function b64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const abortError = (signal?: AbortSignal) => (signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));

/**
 * Response headers from Swift (names arrive lowercased; lookups go through Headers, which is
 * case-insensitive anyway). Never throws: values are coerced to strings (arrays joined), and
 * entries a Headers object rejects (HTTP/2 ":status", control characters) are skipped, so one odd
 * header can't stop the Response from resolving.
 */
export function responseHeaders(raw: unknown): Headers {
  const out = new Headers();
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    try {
      out.append(String(k).toLowerCase(), Array.isArray(v) ? v.map(String).join(", ") : String(v));
    } catch {
      /* invalid name/value: skip */
    }
  }
  return out;
}

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
}

/**
 * A fetch() whose Response body is a ReadableStream fed by BHStream events. Resolves on "head";
 * an "error" before head rejects (TypeError, like fetch), after head errors the body stream;
 * AbortSignal -> cancel({id}). Text chunks are re-encoded as UTF-8 (a trailing lone high
 * surrogate is held for the next chunk); b64 chunks are raw bytes, so multibyte characters split
 * across chunks decode correctly downstream (TextDecoder {stream:true}).
 */
export function createNativeStreamFetch(plugin: BHStreamPlugin): typeof fetch {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = typeof input === "object" && "url" in input && !(input instanceof URL) ? (input as Request) : null;
    const url = req ? req.url : String(input);
    const method = (init.method ?? req?.method ?? "GET").toUpperCase();
    const headers = headerRecord(init.headers ?? req?.headers);
    const signal = init.signal ?? req?.signal ?? undefined;
    let body: string | undefined;
    if (init.body != null) body = typeof init.body === "string" ? init.body : await new Response(init.body).text();
    else if (req && method !== "GET" && method !== "HEAD") body = await req.text();
    if (signal?.aborted) throw abortError(signal);

    return new Promise<Response>((resolve, reject) => {
      let id: string | null = null;
      let settled = false; // promise resolved/rejected
      let finished = false; // stream ended/errored/cancelled
      let held = ""; // trailing high surrogate from a text chunk
      const early: BHStreamEvent[] = [];
      const enc = new TextEncoder();
      let handle: ListenerHandle | null = null;
      let removeWanted = false;
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => void (ctrl = c),
        cancel: () => {
          // consumer stopped reading: stop the native request too
          if (!finished && id) void Promise.resolve(plugin.cancel({ id })).catch(() => undefined);
          finish();
        },
      });

      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        if (handle) void Promise.resolve(handle.remove()).catch(() => undefined);
        else removeWanted = true;
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
      };
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        if (!finished) {
          try {
            ctrl.error(err);
          } catch {
            /* already closed */
          }
        }
        finish();
      };
      function onAbort() {
        if (finished) return;
        if (id) void Promise.resolve(plugin.cancel({ id })).catch(() => undefined);
        fail(abortError(signal));
      }
      const textBytes = (s: string): Uint8Array => {
        let t = held + s;
        held = "";
        const last = t.charCodeAt(t.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          held = t.slice(-1);
          t = t.slice(0, -1);
        }
        return enc.encode(t);
      };
      const process = (ev: BHStreamEvent) => {
        if (finished) return;
        switch (ev.type) {
          case "head": {
            if (settled) return;
            settled = true;
            const status = Number(ev.status) || 200;
            const init: ResponseInit = { status: status >= 200 && status <= 599 ? status : 502, headers: responseHeaders(ev.headers) };
            resolve(new Response(NULL_BODY.has(status) ? null : stream, init));
            return;
          }
          case "chunk": {
            const bytes = typeof ev.b64 === "string" ? b64Bytes(ev.b64) : typeof ev.data === "string" ? textBytes(ev.data) : null;
            if (bytes && bytes.length) ctrl.enqueue(bytes); // queued even before head; the Response reads it later
            return;
          }
          case "end": {
            if (held) ctrl.enqueue(enc.encode(held)); // lone surrogate at the very end: encoder writes U+FFFD
            held = "";
            if (!settled) return fail(new TypeError("BHStream: stream ended without a head event"));
            ctrl.close();
            finish();
            return;
          }
          case "error":
            return fail(new TypeError(`BHStream: ${ev.message ?? "network error"}`));
        }
      };
      const safeProcess = (ev: BHStreamEvent) => {
        try {
          process(ev);
        } catch (err) {
          fail(err instanceof Error ? err : new TypeError(String(err))); // never leave the fetch hanging
        }
      };
      const onEvent = (ev: BHStreamEvent) => {
        if (!ev || typeof ev !== "object") return;
        if (id === null) early.push(ev);
        else if (String(ev.id) === id) safeProcess(ev);
      };

      signal?.addEventListener("abort", onAbort);
      (async () => {
        const h = await plugin.addListener("bhstream", onEvent); // BEFORE start: no event can be missed
        handle = h;
        if (removeWanted || finished) void Promise.resolve(h.remove()).catch(() => undefined);
        if (finished) return;
        const started = await plugin.start({ url, method, headers, ...(body !== undefined ? { body } : {}) });
        id = String(started.id);
        if (finished) {
          // aborted while start() was in flight
          void Promise.resolve(plugin.cancel({ id })).catch(() => undefined);
          return;
        }
        const replay = early.splice(0);
        for (const ev of replay) if (String(ev.id) === id) safeProcess(ev);
      })().catch((err) => fail(err instanceof Error ? err : new TypeError(String(err))));
    });
  };
}
