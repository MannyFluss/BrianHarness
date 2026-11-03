// Sign in with Apple (web side). Native: IOS Dev's BHAppleAuth Capacitor plugin (brianharness-ios `siwa`).
// Worker contract: brianharness-worker docs/APPLE_AUTH.md (POST /v1/auth/apple, POST /v1/auth/refresh).
//
// The Worker's session token is an ordinary bhd_ device token with an expiry, so it lives in the SAME
// credential slot as a pasted device token (credentials/spider) and every existing reader (chat backend,
// extractor, upload queue, model list) uses it unchanged. The record carries a marker:
//   pasted: {type:"api_key", key}                                     (never expires, never refreshed)
//   Apple:  {type:"api_key", key, source:"apple", expiresAt, appleUser} (one JSON value: token + expiry
//           are written together, as the contract asks)
// Nothing here touches study scheduling, progress, session logs, the upload body or the extractor.
// Tokens, the Apple user id and the identity token are never logged and never leave this module except
// as the Authorization header / auth request bodies.
import type { CredentialStoreLike, StoredCredential } from "@brianharness/core/browser";

export type AppleCredentialState = "authorized" | "revoked" | "notFound" | "transferred";
export interface BHAppleAuthPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  makeNonce(opts?: { length?: number }): Promise<{ nonce: string }>;
  signIn(opts: { nonce: string }): Promise<{ identityToken: string; authorizationCode?: string; user: string; nonce: string }>;
  credentialState(opts: { user: string }): Promise<{ state: AppleCredentialState }>;
}

export const SPIDER_SLOT = "spider";
export const REFRESH_WINDOW_MS = 14 * 24 * 3600_000;
/** reuse a held Apple identity token only while it has at least this long left (Worker skew is 60 s) */
export const IDENTITY_TOKEN_MARGIN_MS = 90_000;
export const NOT_ENABLED_TEXT = "Sign in with Apple isn't enabled for this account yet.";

export type AppleRecord = { type: "api_key"; key: string; source: "apple"; expiresAt: string; appleUser: string };
export const isAppleRecord = (c: StoredCredential | undefined): c is AppleRecord =>
  !!c && c.type === "api_key" && (c as { source?: unknown }).source === "apple" && typeof (c as { key?: unknown }).key === "string";

export type AppleAuthPhase =
  | "unavailable" // no plugin / isAvailable false
  | "signed-out" // nothing stored (or a pasted token: see tokenSource)
  | "signing-in"
  | "signed-in" // an Apple-issued token is stored
  | "not-allowed" // 403 apple_account_not_allowed: message + Try again, never retried automatically
  | "needs-signin" // session_expired / invalid_token / revoked: Apple token cleared, offer sign-in
  | "error"; // a sign-in attempt failed (message), user may try again
export type AppleAuthView = {
  available: boolean;
  phase: AppleAuthPhase;
  /** what is in credentials/spider right now */
  tokenSource: "apple" | "pasted" | null;
  expiresAt?: string;
  /** user-facing text for the current phase (never contains a token or id) */
  message?: string;
  /** true when the launch sign-in screen may be offered (available + no token stored after the launch checks) */
  launchOffer: boolean;
  /** a held Apple credential will be reused by Try again (no Apple sheet) */
  canRetryWithoutSheet?: boolean;
};

export interface AppleAuthOptions {
  plugin: BHAppleAuthPlugin | null;
  credentials: CredentialStoreLike;
  /** RAW fetch (not the token-substituting wrapper) */
  fetchImpl: typeof fetch;
  /** Worker origin, e.g. https://api.strangeriver.org (read each call: settings may change) */
  baseUrl: () => Promise<string>;
  /** called after an Apple token was saved by sign-in (kick the upload queue, like a pasted token) */
  onTokenSaved?: () => void;
  /** Worker deviceLabel (1-40 [A-Za-z0-9_ .@+-]); default "ios" */
  deviceLabel?: string;
  now?: () => number;
}

type Held = { identityToken: string; nonce: string; user: string };
type WorkerError = { status: number; code: string | null; retryAfter?: string | null };

export function deviceLabelFor(platform: string): string {
  return platform === "ios-phone" ? "iPhone" : platform === "ios-tablet" ? "iPad" : "ios";
}

/** exp (ms) from a JWT payload WITHOUT verifying it (the Worker verifies); null if unreadable */
export function jwtExpMs(jwt: string): number | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
    const exp = (JSON.parse(atob(b64)) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export const validRawNonce = (n: unknown): n is string => typeof n === "string" && n.length >= 16 && n.length <= 256;

const validLabel = (l: string) => /^[A-Za-z0-9_ .@+-]{1,40}$/.test(l);

async function workerError(res: Response): Promise<WorkerError> {
  let code: string | null = null;
  try {
    const j = (await res.json()) as { error?: { code?: unknown } };
    code = typeof j?.error?.code === "string" ? j.error.code : null;
  } catch { /* non-JSON */ }
  return { status: res.status, code, retryAfter: res.headers.get("retry-after") };
}

/** plugin rejection -> {silent} or a user-facing message (contract table) */
function pluginErrorText(err: unknown): { silent?: true; ignore?: true; text?: string } {
  const code = (err as { code?: unknown })?.code;
  switch (code) {
    case "ECANCELED": return { silent: true };
    case "EBUSY": return { ignore: true };
    case "EFAILED": case "EINVALIDRESPONSE": case "ENOTHANDLED": case "ENOTOKEN": return { text: "Sign in failed, try again." };
    case "ENOTINTERACTIVE": case "EPRESENT": return { text: "Couldn't show Sign in with Apple. Try again." };
    case "EUNKNOWN": return { text: "Sign in with Apple is unavailable on this device. You can paste a device token instead (Spider Cloud · KEY)." };
    case "EINVAL": return { text: "Sign in failed (app error EINVAL)." };
    default: return { text: "Sign in failed, try again." };
  }
}

export type AppleAuth = ReturnType<typeof createAppleAuth>;

export function createAppleAuth(o: AppleAuthOptions) {
  const now = o.now ?? Date.now;
  const label = o.deviceLabel && validLabel(o.deviceLabel) ? o.deviceLabel : "ios";
  let available = false;
  let phase: AppleAuthPhase = o.plugin ? "signed-out" : "unavailable";
  let message: string | undefined;
  let held: Held | null = null; // in memory only, never persisted or logged
  let launched: Promise<AppleAuthView> | null = null;
  let signing: Promise<AppleAuthView> | null = null;
  /** Apple tokens rotated away by a refresh in this process -> the current one (see wrapFetch) */
  const rotated = new Map<string, string>();
  /** Apple-issued tokens seen in this process (current + rotated): 401s on these clear the slot */
  const appleTokens = new Set<string>();
  const listeners = new Set<(v: AppleAuthView) => void>();

  const read = () => o.credentials.read(SPIDER_SLOT).catch(() => undefined);
  const view = async (): Promise<AppleAuthView> => {
    const c = await read();
    const key = c && c.type === "api_key" && typeof (c as { key?: unknown }).key === "string" ? (c as { key: string }).key : null;
    const tokenSource = isAppleRecord(c) ? "apple" : key ? "pasted" : null;
    if (isAppleRecord(c)) appleTokens.add(c.key);
    const p: AppleAuthPhase = !available ? "unavailable" : tokenSource === "apple" && phase !== "signing-in" ? "signed-in" : phase === "signed-in" ? "signed-out" : phase;
    return {
      available,
      phase: p,
      tokenSource,
      ...(isAppleRecord(c) ? { expiresAt: c.expiresAt } : {}),
      ...(message && p !== "signed-in" ? { message } : {}),
      launchOffer: available && !tokenSource,
      ...(held ? { canRetryWithoutSheet: true } : {}),
    };
  };
  const emit = async () => {
    const v = await view();
    for (const l of listeners) { try { l(v); } catch { /* listener bug */ } }
    return v;
  };
  const set = (p: AppleAuthPhase, m?: string) => { phase = p; message = m; };

  /** delete credentials/spider ONLY if it still holds this Apple-issued token (never a pasted one) */
  const clearApple = async (token?: string) => {
    const c = await read();
    if (!isAppleRecord(c)) return false;
    if (token && c.key !== token && rotated.get(token) !== c.key) return false;
    await o.credentials.delete(SPIDER_SLOT);
    rotated.clear();
    return true;
  };

  const postJson = async (path: string, init: RequestInit) => o.fetchImpl(`${(await o.baseUrl()).replace(/\/+$/, "")}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

  const saveAppleToken = async (token: string, expiresAt: string, appleUser: string) => {
    const rec: AppleRecord = { type: "api_key", key: token, source: "apple", expiresAt, appleUser };
    await o.credentials.modify(SPIDER_SLOT, async () => rec);
    appleTokens.add(token);
  };
  const tokenBody = async (res: Response): Promise<{ token: string; expiresAt: string } | null> => {
    try {
      const j = (await res.json()) as { token?: unknown; expiresAt?: unknown };
      if (typeof j.token === "string" && j.token.startsWith("bhd_") && typeof j.expiresAt === "string" && Number.isFinite(Date.parse(j.expiresAt))) return { token: j.token, expiresAt: j.expiresAt };
    } catch { /* fallthrough */ }
    return null;
  };

  /** POST /v1/auth/refresh with the stored Apple token. Network errors keep the token (next launch retries). */
  const refresh = async (rec: AppleRecord): Promise<void> => {
    let res: Response;
    try {
      res = await postJson("/v1/auth/refresh", { method: "POST", headers: { authorization: `Bearer ${rec.key}` }, body: "{}" });
    } catch {
      return; // offline: keep using the current token
    }
    if (res.ok) {
      const t = await tokenBody(res);
      if (!t) return;
      // the slot may have changed meanwhile (user pasted a token): only replace our own record
      const cur = await read();
      if (!isAppleRecord(cur) || cur.key !== rec.key) return;
      await saveAppleToken(t.token, t.expiresAt, rec.appleUser);
      rotated.set(rec.key, t.token);
      return;
    }
    const e = await workerError(res);
    if (e.status === 401 && (e.code === "session_expired" || e.code === "invalid_token")) {
      if (await clearApple(rec.key)) set("needs-signin", e.code === "session_expired" ? "Your Sign in with Apple session expired. Sign in again." : "Signed out by the server. Sign in again.");
    }
    // 400 not_refreshable / 429 / 5xx: keep the token, nothing else
  };

  /** launch checks, once per process: isAvailable, refresh (< 14 days), credentialState */
  const launch = (): Promise<AppleAuthView> => {
    if (launched) return launched;
    launched = (async () => {
      if (!o.plugin) return emit();
      try {
        available = !!(await o.plugin.isAvailable())?.available;
      } catch {
        available = false;
      }
      if (!available) return emit();
      let rec = await read();
      if (isAppleRecord(rec)) {
        appleTokens.add(rec.key);
        const exp = Date.parse(rec.expiresAt);
        if (!Number.isFinite(exp) || exp - now() < REFRESH_WINDOW_MS) await refresh(rec);
        rec = await read();
      }
      if (isAppleRecord(rec) && rec.appleUser) {
        try {
          const { state } = await o.plugin.credentialState({ user: rec.appleUser });
          if (state === "revoked" || state === "notFound") {
            if (await clearApple(rec.key)) set("needs-signin", "Your Apple ID no longer authorizes this app. Sign in again.");
          }
        } catch {
          // ESTATE etc.: keep the current token, don't sign out
        }
      }
      return emit();
    })();
    return launched;
  };

  const getCredential = async (): Promise<Held> => {
    const { nonce } = await o.plugin!.makeNonce({}); // default 32 bytes -> 43 chars
    if (!validRawNonce(nonce)) throw Object.assign(new Error("bad nonce"), { code: "EINVAL" });
    const c = await o.plugin!.signIn({ nonce });
    if (!c || typeof c.identityToken !== "string" || !c.identityToken) throw Object.assign(new Error("no identity token"), { code: "ENOTOKEN" });
    return { identityToken: c.identityToken, nonce, user: String(c.user ?? "") };
  };
  const heldUsable = (h: Held | null): h is Held => {
    if (!h) return false;
    const exp = jwtExpMs(h.identityToken);
    return exp !== null && exp - now() > IDENTITY_TOKEN_MARGIN_MS;
  };

  /**
   * One user-initiated sign-in (button / Try again). Reuses a held Apple credential while its identity
   * token is still valid (no Apple sheet; the Worker has no single-use nonce rule), else shows the sheet.
   */
  const signIn = (): Promise<AppleAuthView> => {
    if (signing) return signing; // second tap while in flight (EBUSY semantics)
    signing = (async () => {
      if (!o.plugin || !available) return emit();
      const prev = { phase: phase === "signing-in" ? "signed-out" as AppleAuthPhase : phase, message };
      set("signing-in");
      void emit();
      let attempt = 0;
      for (;;) {
        attempt++;
        const reused = heldUsable(held);
        if (!reused) held = null;
        let cred: Held;
        try {
          cred = reused ? held! : await getCredential();
        } catch (err) {
          const r = pluginErrorText(err);
          if (r.silent || r.ignore) set(prev.phase, prev.message); // cancel is silent; a second sheet is ignored
          else set("error", r.text);
          return emit();
        }
        held = cred;
        let res: Response;
        try {
          res = await postJson("/v1/auth/apple", { method: "POST", body: JSON.stringify({ identityToken: cred.identityToken, nonce: cred.nonce, deviceLabel: label }) });
        } catch {
          set("error", "Couldn't reach the server. Try again when you're online.");
          return emit();
        }
        if (res.ok) {
          const t = await tokenBody(res);
          if (!t) { set("error", "Sign in failed (unexpected server reply)."); return emit(); }
          await saveAppleToken(t.token, t.expiresAt, cred.user);
          held = null;
          set("signed-in");
          try { o.onTokenSaved?.(); } catch { /* ignore */ }
          return emit();
        }
        const e = await workerError(res);
        if (e.status === 403 && e.code === "apple_account_not_allowed") {
          set("not-allowed", NOT_ENABLED_TEXT); // keep `held`: Try again re-posts it without the sheet
          return emit();
        }
        if (e.status === 401 && e.code === "apple_token_expired" && reused && attempt === 1) {
          held = null; // the held Apple token aged out: one fresh credential for this same tap
          continue;
        }
        held = e.status === 429 || e.status === 502 ? held : null;
        set("error",
          e.status === 429 ? "Too many sign-ins today. Try again later."
          : e.status === 502 ? "Apple's sign-in keys are unreachable right now. Try again shortly."
          : e.status === 503 ? "Sign in with Apple isn't set up on the server. Paste a device token instead (Spider Cloud · KEY)."
          : e.code === "apple_token_not_yet_valid" ? "Sign in failed: check the device's date and time."
          : `Sign in failed${e.code ? ` (${e.code})` : ` (HTTP ${e.status})`}. Try again.`);
        return emit();
      }
    })().finally(() => { signing = null; });
    return signing;
  };

  /** 401 session_expired / invalid_token on an authed route using an Apple token: clear it, offer sign-in once */
  const onAuthedFailure = async (token: string, code: string) => {
    if (!appleTokens.has(token)) return; // pasted tokens are never cleared here
    if (await clearApple(token)) {
      set("needs-signin", code === "session_expired" ? "Your Sign in with Apple session expired. Sign in again." : "Signed out by the server. Sign in again.");
      await emit();
    }
  };

  /**
   * fetch wrapper for every network path: (1) a request still carrying an Apple token that this process
   * rotated (refresh) gets the current one, so a session that started before the refresh keeps working;
   * (2) a 401 session_expired / invalid_token answered to an Apple token clears it. Responses and bodies
   * are passed through untouched; pasted tokens are never rewritten or cleared.
   */
  const wrapFetch = (inner: typeof fetch): typeof fetch => async (input, init) => {
    let bearer: string | null = null;
    let nextInit = init;
    try {
      const h = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
      const a = h.get("authorization");
      if (a && /^Bearer /i.test(a)) bearer = a.slice(7).trim();
      if (bearer && appleTokens.has(bearer)) {
        let cur = bearer;
        for (let i = 0; i < 10 && rotated.has(cur); i++) cur = rotated.get(cur)!;
        if (cur !== bearer && init) {
          h.set("authorization", `Bearer ${cur}`);
          nextInit = { ...init, headers: Object.fromEntries(h.entries()) };
          bearer = cur;
        }
      }
    } catch { /* leave the request as is */ }
    const res = await inner(input, nextInit);
    if (res.status === 401 && bearer && appleTokens.has(bearer)) {
      const tok = bearer;
      try {
        void res.clone().json().then((j: { error?: { code?: unknown } }) => {
          const code = j?.error?.code;
          if (code === "session_expired" || code === "invalid_token") void onAuthedFailure(tok, code);
        }, () => {});
      } catch { /* body not cloneable */ }
    }
    return res;
  };

  return {
    launch,
    signIn,
    /** Skip / dismiss: no state change beyond clearing a stale message */
    skip: () => { if (phase === "error") set("signed-out"); void emit(); },
    status: () => view(),
    onChange(cb: (v: AppleAuthView) => void) { listeners.add(cb); return () => void listeners.delete(cb); },
    wrapFetch,
    /** the slot was replaced (pasted token) or cleared (FORGET KEY): forget this process's Apple-token bookkeeping */
    noteSlotChanged() { rotated.clear(); held = null; if (phase !== "signing-in") set("signed-out"); void emit(); },
  };
}

/**
 * The launch screen may show only: sign-in available, nothing stored, before the user's first turn, no
 * rating card, nothing typed, and NOT over a study session (it would sit inside the study session's
 * first-turn reply latency). Offered at most once per launch; never mid-session.
 */
export function shouldOfferAtLaunch(v: AppleAuthView | null, s: { sessionReady: boolean; study: boolean; userTurns: number; drafting: boolean; ratingOpen: boolean; alreadyOffered: boolean }): boolean {
  return !!v && v.launchOffer && s.sessionReady && !s.study && s.userTurns === 0 && !s.drafting && !s.ratingOpen && !s.alreadyOffered;
}
