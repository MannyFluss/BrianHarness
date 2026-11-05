/**
 * E6: browser / WKWebView loader for the o200k_base rank file. Same pure-TS BpeTokenizer as Node (tokenizer.ts),
 * so counts are identical by construction (test/ad-e6.test.ts checks them against tokenizer-node on the E4 fixtures).
 *
 * The rank file is a STATIC ASSET of the web bundle (apps/desktop/public/ad/o200k_base.tiktoken.gz, 1.69 MB), loaded
 * lazily the first time actor-director mode needs a token count. In the iOS app Capacitor serves it from the app
 * bundle (capacitor://localhost/...), in Electron from file://: no network fetch at runtime. The text is
 * sha256-checked (pure JS, no crypto.subtle so it also works outside a secure context).
 * Why not js-tiktoken: it ships its own 2.2 MB JS rank table inside the bundle (not lazy) and would need a second
 * parity proof; this loader reuses the tokenizer that E4 already pinned against python tiktoken.
 */
import { sha256HexSync } from "../study.js";
import { BpeTokenizer, O200K_RANKS_SHA256 } from "./tokenizer.js";

/** path relative to the web root (Vite base "./") */
export const O200K_ASSET_PATH = "ad/o200k_base.tiktoken.gz";
export const O200K_ASSET_BYTES = 1692666;

export type AssetFetch = (path: string) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer>; body?: unknown }>;

async function gunzip(buf: ArrayBuffer): Promise<string> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => unknown }).DecompressionStream;
  if (!DS) throw new Error("o200k_base: DecompressionStream unavailable (needs Safari 16.4+ / Chrome 80+)");
  const stream = new Blob([buf]).stream().pipeThrough(new DS("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Response(stream).text();
}

let pending: Promise<BpeTokenizer> | null = null;
/**
 * Lazily load and verify the rank file. `fetchImpl` defaults to the global fetch of a same-origin relative path
 * (the bundled asset); `baseUrl` defaults to document.baseURI.
 */
export function loadO200kBrowser(opts: { fetchImpl?: AssetFetch; baseUrl?: string; path?: string } = {}): Promise<BpeTokenizer> {
  if (pending && !opts.fetchImpl) return pending;
  const run = (async () => {
    const f: AssetFetch = opts.fetchImpl ?? ((p) => fetch(p));
    const base = opts.baseUrl ?? (typeof document !== "undefined" ? document.baseURI : "");
    const path = opts.path ?? O200K_ASSET_PATH;
    const url = base ? new URL(path, base).href : path;
    if (base && !isBundledAssetUrl(url, base)) throw new Error("o200k_base: the rank asset must come from the app bundle");
    const res = await f(url);
    if (!res.ok) throw new Error(`o200k_base asset missing (${res.status ?? "?"})`);
    const text = await gunzip(await res.arrayBuffer());
    const sha = sha256HexSync(text);
    if (sha !== O200K_RANKS_SHA256) throw new Error(`o200k_base rank asset sha256 mismatch (${sha.slice(0, 12)})`);
    return new BpeTokenizer(text);
  })();
  if (!opts.fetchImpl) { pending = run; run.catch(() => { pending = null; }); }
  return run;
}

/** same-origin check helper for the app: the asset URL must never point off-device */
export function isBundledAssetUrl(url: string, pageOrigin: string): boolean {
  try { const u = new URL(url, pageOrigin); return u.origin === new URL(pageOrigin).origin || u.protocol === "capacitor:" || u.protocol === "file:"; } catch { return false; }
}
