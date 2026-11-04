// Device-token hygiene on the web side (report d2bd6006 item 5). The web layer never logs a credential value on
// purpose; this is the belt-and-braces: anything that may quote a Spider Cloud device token (bhd_...) on its way
// to the console, the flight recorder or the feedback report is scrubbed first. Never prints any part of the
// secret: a mask keeps only the prefix and the length.
export const BHD_TOKEN_RE = /bhd_[A-Za-z0-9_-]+/g;

/** "bhd_…(len 42)": prefix + length only, no characters of the secret */
export function maskSecret(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^([a-z]{2,4}_|sk-)/i.exec(s);
  return `${m ? m[1] : ""}…(len ${s.length})`;
}

/** every bhd_ token in a string replaced by its mask */
export function scrubSecrets(s: string): string {
  return typeof s === "string" ? s.replace(BHD_TOKEN_RE, (t) => maskSecret(t)) : s;
}

/** deep copy with every string scrubbed (Error -> {name, message, code}); non-plain values pass through */
export function scrubDeep<T>(v: T, depth = 0): T {
  if (depth > 8) return v;
  if (typeof v === "string") return scrubSecrets(v) as T;
  if (v instanceof Error) {
    const e = new Error(scrubSecrets(v.message)) as Error & { code?: unknown };
    e.name = v.name;
    const code = (v as Error & { code?: unknown }).code;
    if (code !== undefined) e.code = typeof code === "string" ? scrubSecrets(code) : code;
    if (v.stack) e.stack = scrubSecrets(v.stack);
    return e as T;
  }
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1)) as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrubDeep(x, depth + 1);
    return out as T;
  }
  return v;
}

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
/** wrap console.* so no bhd_ token reaches the Web Inspector / Xcode console from the web layer (idempotent) */
export function installConsoleScrub(c: Console = console): () => void {
  const tagged = c as Console & { __bhScrub?: boolean };
  if (tagged.__bhScrub) return () => {};
  const orig = LEVELS.map((l) => [l, c[l]] as const);
  for (const [l, fn] of orig) c[l] = (...args: unknown[]) => fn.apply(c, args.map((a) => scrubDeep(a)));
  tagged.__bhScrub = true;
  return () => { for (const [l, fn] of orig) c[l] = fn; tagged.__bhScrub = false; };
}
