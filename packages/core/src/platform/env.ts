/**
 * Platform seams: Env and Clock. Core never touches `process`, `Date.now` timers or Node APIs
 * directly on its critical path, so it runs unchanged in Node (sidecar, desktop main), a browser,
 * or an iOS WKWebView served over plain http (no secure-context-only APIs).
 */
export type Env = Record<string, string | undefined>;

/** `process.env` in Node, `{}` in a browser/WebView (never throws when `process` is missing). */
export function defaultEnv(): Env {
  const p = (globalThis as { process?: { env?: Env } }).process;
  return p?.env ?? {};
}

/** Milliseconds since epoch. Injected into HarnessSession as `clock`. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

/** AbortSignal.timeout with a fallback for older WebKit (iOS < 16). */
export function timeoutSignal(ms: number): AbortSignal {
  const A = AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal };
  if (typeof A.timeout === "function") return A.timeout(ms);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error(`timed out after ${ms}ms`)), ms);
  return ac.signal;
}

/**
 * Short random id WITHOUT crypto.randomUUID / crypto.subtle (both are secure-context-only and
 * missing on a PWA served over http://192.168.x.x). Not for secrets: ids only.
 */
export function randomId(len = 8): string {
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const bytes = new Uint8Array(len);
  if (g?.getRandomValues) g.getRandomValues(bytes); // available in insecure contexts too
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  const abc = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (const b of bytes) s += abc[b % 36];
  return s;
}
