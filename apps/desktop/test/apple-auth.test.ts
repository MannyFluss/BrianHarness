// Sign in with Apple, web side (transport/apple-auth.ts + in-process wiring). Plugin and fetch are mocks:
// these tests never reach the live Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV } from "@brianharness/core/browser";
import { createAppleAuth, shouldOfferAtLaunch, jwtExpMs, NOT_ENABLED_TEXT, REFRESH_WINDOW_MS, type BHAppleAuthPlugin, type AppleCredentialState } from "../src/transport/apple-auth.ts";
import { createInProcessTransport } from "../src/transport/in-process.ts";

const BASE = "https://api.test.invalid";
const DAY = 24 * 3600_000;
const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (expMs: number, sub = "001234.apple-user.0042") => `${b64u('{"alg":"RS256","kid":"k"}')}.${b64u(JSON.stringify({ iss: "https://appleid.apple.com", sub, exp: Math.floor(expMs / 1000), nonce: "x" }))}.sig`;

type Call = { url: string; method: string; auth: string | null; body: unknown };
function fakePlugin(o: { available?: boolean; state?: AppleCredentialState | "throw"; signIn?: () => Promise<{ identityToken: string; user: string; nonce: string }>; nonce?: string; now?: () => number } = {}) {
  const calls = { signIn: 0, nonces: [] as string[], state: 0, makeNonce: 0 };
  let n = 0;
  const plugin: BHAppleAuthPlugin = {
    isAvailable: async () => ({ available: o.available ?? true }),
    makeNonce: async () => { calls.makeNonce++; return { nonce: o.nonce ?? `raw-nonce-${String(++n).padStart(2, "0")}-${"a".repeat(30)}` }; },
    signIn: async ({ nonce }) => {
      calls.signIn++;
      calls.nonces.push(nonce);
      if (o.signIn) return o.signIn();
      return { identityToken: jwt((o.now ?? Date.now)() + 600_000), user: "001234.apple-user.0042", nonce };
    },
    credentialState: async () => {
      calls.state++;
      if (o.state === "throw") throw Object.assign(new Error("state"), { code: "ESTATE" });
      return { state: o.state ?? "authorized" };
    },
  };
  return { plugin, calls };
}
type Route = (c: Call) => Response | Promise<Response>;
function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const c: Call = { url: String(input), method: init?.method ?? "GET", auth: h.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    return route(c);
  }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string) => json(status, { error: { message: code, type: "x", code } });
const tokenReply = (token: string, expiresAt = new Date(Date.now() + 90 * DAY).toISOString()) => json(200, { token, expiresAt });
const settle = () => new Promise((r) => setTimeout(r, 30));
const creds = () => new KVCredentialStore(new MemoryKV());
const appleRec = (key: string, expiresAt: string) => ({ type: "api_key", key, source: "apple", expiresAt, appleUser: "001234.apple-user.0042" });

function setup(o: { route: Route; plugin?: ReturnType<typeof fakePlugin>; credentials?: KVCredentialStore; now?: () => number }) {
  const p = o.plugin ?? fakePlugin({ now: o.now });
  const fx = fakeFetch(o.route);
  const credentials = o.credentials ?? creds();
  let saved = 0;
  const auth = createAppleAuth({ plugin: p.plugin, credentials, fetchImpl: fx.f, baseUrl: async () => BASE, deviceLabel: "iPhone", onTokenSaved: () => void saved++, now: o.now });
  return { auth, p, fx, credentials, saved: () => saved };
}

test("siwa: success stores the bhd_ token in credentials/spider with expiresAt, Apple user id and the apple marker; kicks uploads", async () => {
  const s = setup({ route: (c) => (c.url === `${BASE}/v1/auth/apple` ? tokenReply("bhd_apple_session_1", "2027-02-01T00:00:00.000Z") : err(404, "nf")) });
  const v0 = await s.auth.launch();
  assert.equal(v0.available, true); assert.equal(v0.launchOffer, true); assert.equal(v0.tokenSource, null);
  const v = await s.auth.signIn();
  assert.equal(v.phase, "signed-in"); assert.equal(v.tokenSource, "apple"); assert.equal(v.launchOffer, false);
  assert.equal(s.fx.calls.length, 1);
  const body = s.fx.calls[0]!.body as { identityToken: string; nonce: string; deviceLabel: string };
  assert.equal(s.fx.calls[0]!.method, "POST");
  assert.equal(body.nonce, s.p.calls.nonces[0], "RAW nonce sent to the Worker = the one given to signIn");
  assert.ok(body.nonce.length >= 16 && body.nonce.length <= 256);
  assert.equal(body.deviceLabel, "iPhone");
  assert.ok(body.identityToken.split(".").length === 3);
  assert.deepEqual(await s.credentials.read("spider"), appleRec("bhd_apple_session_1", "2027-02-01T00:00:00.000Z"));
  assert.equal(s.saved(), 1, "upload queue kicked once");
});

test("siwa: launch offer rules (skip, never over a study session, never mid-session, once per launch)", async () => {
  const s = setup({ route: () => err(500, "x") });
  const v = await s.auth.launch();
  const base = { sessionReady: true, study: false, userTurns: 0, drafting: false, ratingOpen: false, alreadyOffered: false };
  assert.equal(shouldOfferAtLaunch(v, base), true);
  assert.equal(shouldOfferAtLaunch(v, { ...base, study: true }), false, "not over a study session");
  assert.equal(shouldOfferAtLaunch(v, { ...base, userTurns: 1 }), false, "never mid-session");
  assert.equal(shouldOfferAtLaunch(v, { ...base, drafting: true }), false);
  assert.equal(shouldOfferAtLaunch(v, { ...base, ratingOpen: true }), false);
  assert.equal(shouldOfferAtLaunch(v, { ...base, alreadyOffered: true }), false);
  assert.equal(shouldOfferAtLaunch(v, { ...base, sessionReady: false }), false);
  assert.equal(shouldOfferAtLaunch(null, base), false);
  // Skip: nothing is called, nothing stored
  s.auth.skip();
  await settle();
  assert.equal(s.fx.calls.length, 0); assert.equal(s.p.calls.signIn, 0);
  assert.equal(await s.credentials.read("spider"), undefined);
  // unavailable plugin -> no offer, no sidebar row
  const u = setup({ route: () => err(500, "x"), plugin: fakePlugin({ available: false }) });
  const uv = await u.auth.launch();
  assert.equal(uv.available, false); assert.equal(uv.launchOffer, false); assert.equal(shouldOfferAtLaunch(uv, base), false);
  // a stored (pasted) token -> no offer
  const c = creds(); await c.modify("spider", async () => ({ type: "api_key", key: "bhd_pasted" }));
  const pv = await setup({ route: () => err(500, "x"), credentials: c }).auth.launch();
  assert.equal(pv.tokenSource, "pasted"); assert.equal(shouldOfferAtLaunch(pv, base), false);
});

test("siwa: offline: sign-in fails quietly (no store, no retry loop); refresh keeps the token for the next launch", async () => {
  const offline: Route = () => { throw new TypeError("Load failed"); };
  const s = setup({ route: offline });
  await s.auth.launch();
  const v = await s.auth.signIn();
  assert.equal(v.phase, "error"); assert.match(v.message!, /online/);
  assert.equal(await s.credentials.read("spider"), undefined);
  await settle();
  assert.equal(s.fx.calls.length, 1, "no automatic retry");
  // launch with an Apple token close to expiry, offline: refresh attempted once, token kept, credentialState still runs
  const c = creds(); const rec = appleRec("bhd_old", new Date(Date.now() + 3 * DAY).toISOString());
  await c.modify("spider", async () => rec);
  const r = setup({ route: offline, credentials: c });
  const lv = await r.auth.launch();
  assert.equal(r.fx.calls.length, 1); assert.equal(r.fx.calls[0]!.url, `${BASE}/v1/auth/refresh`);
  assert.deepEqual(await c.read("spider"), rec);
  assert.equal(lv.tokenSource, "apple"); assert.equal(r.p.calls.state, 1);
  await r.auth.launch(); // once per launch
  assert.equal(r.fx.calls.length, 1);
});

test("siwa: 403 apple_account_not_allowed: 'not enabled' + Try again reusing the held credential, never auto-retried", async () => {
  let t = Date.now();
  const s = setup({ route: () => err(403, "apple_account_not_allowed"), now: () => t });
  await s.auth.launch();
  const v = await s.auth.signIn();
  assert.equal(v.phase, "not-allowed"); assert.equal(v.message, NOT_ENABLED_TEXT); assert.equal(v.canRetryWithoutSheet, true);
  assert.equal(await s.credentials.read("spider"), undefined);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.fx.calls.length, 1, "no automatic retry"); assert.equal(s.p.calls.signIn, 1);
  // Try again within the identity token's lifetime: same credential, no Apple sheet
  const v2 = await s.auth.signIn();
  assert.equal(v2.phase, "not-allowed");
  assert.equal(s.p.calls.signIn, 1, "no second Apple sheet");
  assert.equal(s.fx.calls.length, 2);
  assert.deepEqual(s.fx.calls[1]!.body, s.fx.calls[0]!.body, "same identityToken + raw nonce re-posted");
  // after the identity token expired (~10 min), Try again asks Apple again with a fresh nonce
  t += 20 * 60_000;
  await s.auth.signIn();
  assert.equal(s.p.calls.signIn, 2);
  assert.notEqual((s.fx.calls[2]!.body as { nonce: string }).nonce, (s.fx.calls[0]!.body as { nonce: string }).nonce);
  // allowlisted meanwhile: Try again succeeds
  const s2 = setup({ route: (() => { let n = 0; return () => (++n === 1 ? err(403, "apple_account_not_allowed") : tokenReply("bhd_now_allowed")); })() });
  await s2.auth.launch();
  assert.equal((await s2.auth.signIn()).phase, "not-allowed");
  const ok = await s2.auth.signIn();
  assert.equal(ok.phase, "signed-in"); assert.equal(s2.p.calls.signIn, 1); assert.equal(s2.saved(), 1);
});

test("siwa: apple_token_expired on a reused credential gets one fresh Apple credential in the same tap", async () => {
  let n = 0;
  const s = setup({ route: () => (++n === 1 ? err(403, "apple_account_not_allowed") : n === 2 ? err(401, "apple_token_expired") : tokenReply("bhd_fresh")) });
  await s.auth.launch();
  await s.auth.signIn();
  const v = await s.auth.signIn();
  assert.equal(v.phase, "signed-in"); assert.equal(s.p.calls.signIn, 2); assert.equal(s.fx.calls.length, 3);
});

test("siwa: user cancel is silent; EBUSY ignored; EUNKNOWN points to the pasted token; bad nonce never reaches signIn", async () => {
  const cancel = fakePlugin({ signIn: async () => { throw Object.assign(new Error("canceled"), { code: "ECANCELED" }); } });
  const s = setup({ route: () => err(500, "x"), plugin: cancel });
  await s.auth.launch();
  const v = await s.auth.signIn();
  assert.equal(v.phase, "signed-out"); assert.equal(v.message, undefined); assert.equal(s.fx.calls.length, 0);
  const unk = setup({ route: () => err(500, "x"), plugin: fakePlugin({ signIn: async () => { throw Object.assign(new Error("x"), { code: "EUNKNOWN" }); } }) });
  await unk.auth.launch();
  assert.match((await unk.auth.signIn()).message!, /device token/);
  const short = setup({ route: () => err(500, "x"), plugin: fakePlugin({ nonce: "tooshort" }) });
  await short.auth.launch();
  const sv = await short.auth.signIn();
  assert.equal(sv.phase, "error"); assert.equal(short.p.calls.signIn, 0, "nonce outside 16-256 is never sent");
  // double tap: one sheet, one request
  const d = setup({ route: () => tokenReply("bhd_once") });
  await d.auth.launch();
  const [a, b] = await Promise.all([d.auth.signIn(), d.auth.signIn()]);
  assert.equal(a.phase, "signed-in"); assert.equal(b.phase, "signed-in"); assert.equal(d.p.calls.signIn, 1); assert.equal(d.fx.calls.length, 1);
  // 503 apple_signin_disabled -> pasted-token hint
  const off = setup({ route: () => err(503, "apple_signin_disabled") });
  await off.auth.launch();
  assert.match((await off.auth.signIn()).message!, /device token/);
});

test("siwa: makeNonce default (32 bytes -> 43 chars) is accepted", async () => {
  const p = fakePlugin({ nonce: "A".repeat(43) });
  const s = setup({ route: () => tokenReply("bhd_x"), plugin: p });
  await s.auth.launch();
  assert.equal((await s.auth.signIn()).phase, "signed-in");
  assert.equal(p.calls.nonces[0]!.length, 43);
});

test("siwa: refresh under 14 days rotates token + expiresAt together; old bearer is swapped on later requests; >14 days no refresh", async () => {
  const c = creds();
  await c.modify("spider", async () => appleRec("bhd_old", new Date(Date.now() + 10 * DAY).toISOString()));
  const s = setup({ credentials: c, route: (x) => (x.url.endsWith("/v1/auth/refresh") ? tokenReply("bhd_new", "2027-03-01T00:00:00.000Z") : json(200, { ok: true })) });
  const v = await s.auth.launch();
  assert.equal(s.fx.calls[0]!.auth, "Bearer bhd_old");
  assert.deepEqual(await c.read("spider"), appleRec("bhd_new", "2027-03-01T00:00:00.000Z"));
  assert.equal(v.expiresAt, "2027-03-01T00:00:00.000Z"); assert.equal(s.p.calls.state, 1, "credentialState after refresh");
  assert.equal(s.saved(), 0, "refresh is not a new sign-in");
  // a backend built before the refresh still carries bhd_old: the wrapper sends bhd_new
  const wrapped = s.auth.wrapFetch(s.fx.f);
  await wrapped(`${BASE}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer bhd_old", "content-type": "application/json" }, body: "{}" });
  assert.equal(s.fx.calls.at(-1)!.auth, "Bearer bhd_new");
  // other bearers are untouched
  await wrapped("https://ollama.com/api/chat", { method: "POST", headers: { authorization: "Bearer ollama-key" }, body: "{}" });
  assert.equal(s.fx.calls.at(-1)!.auth, "Bearer ollama-key");
  // far from expiry: no refresh
  const c2 = creds();
  await c2.modify("spider", async () => appleRec("bhd_fresh", new Date(Date.now() + REFRESH_WINDOW_MS + DAY).toISOString()));
  const s2 = setup({ credentials: c2, route: () => err(500, "x") });
  await s2.auth.launch();
  assert.equal(s2.fx.calls.length, 0);
});

test("siwa: session_expired / invalid_token clear the Apple token and offer sign-in again (refresh and any authed route)", async () => {
  for (const code of ["session_expired", "invalid_token"]) {
    const c = creds();
    await c.modify("spider", async () => appleRec("bhd_dead", new Date(Date.now() - DAY).toISOString()));
    const s = setup({ credentials: c, route: () => err(401, code) });
    const v = await s.auth.launch();
    assert.equal(await c.read("spider"), undefined, `${code}: cleared`);
    assert.equal(v.phase, "needs-signin"); assert.equal(v.launchOffer, true); assert.ok(v.message);
    assert.equal(s.p.calls.signIn, 0, "sign-in is offered, not forced");
  }
  // 401 on an authed route (e.g. the upload or chat) with the Apple token
  const c = creds();
  await c.modify("spider", async () => appleRec("bhd_live", new Date(Date.now() + 60 * DAY).toISOString()));
  const s = setup({ credentials: c, route: (x) => (x.url.endsWith("/v1/sessions") ? err(401, "session_expired") : json(200, {})) });
  await s.auth.launch();
  const changes: string[] = [];
  s.auth.onChange((v) => changes.push(v.phase));
  const res = await s.auth.wrapFetch(s.fx.f)(`${BASE}/v1/sessions`, { method: "POST", headers: { authorization: "Bearer bhd_live" }, body: "{}" });
  assert.equal(res.status, 401, "response passed through");
  assert.equal((await res.json() as { error: { code: string } }).error.code, "session_expired", "caller can still read the body");
  await settle();
  assert.equal(await c.read("spider"), undefined);
  assert.ok(changes.includes("needs-signin"));
});

test("siwa: credentialState revoked/notFound clears an Apple token; ESTATE/authorized keep it", async () => {
  for (const [state, cleared] of [["revoked", true], ["notFound", true], ["authorized", false], ["transferred", false], ["throw", false]] as const) {
    const c = creds();
    await c.modify("spider", async () => appleRec("bhd_tok", new Date(Date.now() + 60 * DAY).toISOString()));
    const s = setup({ credentials: c, route: () => err(500, "x"), plugin: fakePlugin({ state }) });
    const v = await s.auth.launch();
    assert.equal(!(await c.read("spider")), cleared, state);
    assert.equal(v.phase, cleared ? "needs-signin" : "signed-in", state);
  }
});

test("siwa: a pasted device token is never refreshed, never cleared by credentialState or a 401", async () => {
  const c = creds();
  const pasted = { type: "api_key", key: "bhd_pasted_device" };
  await c.modify("spider", async () => pasted);
  const p = fakePlugin({ state: "revoked" });
  const s = setup({ credentials: c, plugin: p, route: () => err(401, "invalid_token") });
  const v = await s.auth.launch();
  assert.equal(s.fx.calls.length, 0, "no refresh for pasted tokens");
  assert.equal(p.calls.state, 0, "no credentialState without an Apple user");
  assert.equal(v.tokenSource, "pasted");
  await s.auth.wrapFetch(s.fx.f)(`${BASE}/v1/sessions`, { method: "POST", headers: { authorization: "Bearer bhd_pasted_device" }, body: "{}" });
  await settle();
  assert.deepEqual(await c.read("spider"), pasted);
  // an Apple 401 arriving after the user pasted a token over the Apple one leaves the pasted token alone
  const c2 = creds();
  await c2.modify("spider", async () => appleRec("bhd_apple", new Date(Date.now() + 60 * DAY).toISOString()));
  const s2 = setup({ credentials: c2, route: () => err(401, "invalid_token") });
  await s2.auth.launch();
  await c2.modify("spider", async () => pasted);
  s2.auth.noteSlotChanged();
  await s2.auth.wrapFetch(s2.fx.f)(`${BASE}/v1/models`, { headers: { authorization: "Bearer bhd_apple" } });
  await settle();
  assert.deepEqual(await c2.read("spider"), pasted);
});

test("siwa: jwtExpMs reads exp without verifying; garbage -> null", () => {
  assert.equal(jwtExpMs(jwt(1_900_000_000_000)), 1_900_000_000_000);
  assert.equal(jwtExpMs("nope"), null);
  assert.equal(jwtExpMs("a.b.c"), null);
});

test("siwa in-process: sign-in flushes queued study uploads with the Apple token; tokens/ids never in logs, bodies or console", async () => {
  const IDT = jwt(Date.now() + 600_000, "001234.secret-apple-sub.9999");
  const USER = "001234.secret-apple-sub.9999";
  const TOKEN = "bhd_APPLE_SESSION_TOKEN_SECRET_0123456789abcdefghijklmnopq";
  const posts: Array<{ url: string; auth: string | null; body: string }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/v1/auth/apple")) return tokenReply(TOKEN);
    if (url.endsWith("/v1/sessions")) { posts.push({ url, auth, body: String(init?.body) }); return json(201, { id: "x" }); }
    return json(200, { models: [] });
  }) as typeof fetch;
  const plugin: BHAppleAuthPlugin = {
    isAvailable: async () => ({ available: true }),
    makeNonce: async () => ({ nonce: "N".repeat(43) }),
    signIn: async ({ nonce }) => ({ identityToken: IDT, user: USER, nonce }),
    credentialState: async () => ({ state: "authorized" }),
  };
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { throw new Error(`global fetch used for ${String(u)}`); }) as typeof fetch;
  try {
    const credentials = new KVCredentialStore(new MemoryKV());
    const t = createInProcessTransport({
      storageKV: new MemoryKV(), settingsKV: new MemoryKV(), secretKV: new MemoryKV(), uploadKV: new MemoryKV(), credentials,
      fetchImpl: f, streaming: false, platform: "ios-phone", appVersion: "0.5.0", build: 20, uploadAutoSchedule: false, download: () => true, appleAuth: plugin,
    });
    assert.ok(t.appleAuth, "bridge exposes appleAuth when the plugin is present");
    const lv = await t.appleAuth!.launch();
    assert.equal(lv.launchOffer, true);
    assert.deepEqual(await t.study!.enable(), { ok: true });
    await t.newSession(); // study 1
    for (let i = 0; i < 3; i++) await t.reply({ text: `study chat ${i}`, events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    await t.newSession(); // ends study 1
    await settle();
    assert.equal((await t.uploads!.status()).blocked, "no-token");
    const v = await t.appleAuth!.signIn();
    assert.equal(v.phase, "signed-in");
    await settle(); await settle();
    const s = await t.uploads!.status();
    assert.equal(s.pending, 0, "queue flushed after the Apple token was saved"); assert.equal(s.done, 2);
    assert.ok(posts.length === 2 && posts.every((p) => p.auth === `Bearer ${TOKEN}`));
    const st = await t.providers.status();
    assert.equal(st.providers.find((p) => p.id === "spider-cloud")!.authSource, "Sign in with Apple (this device)");
    // leak checks: session logs, upload bodies, console
    const secrets = [TOKEN, USER, IDT, IDT.split(".")[1]!, "N".repeat(43)];
    const haystacks = [...posts.map((p) => p.body), ...logged];
    for (const sec of secrets) for (const h of haystacks) assert.ok(!h.includes(sec), "secret leaked into an upload body or console line");
  } finally {
    Object.assign(console, orig);
    globalThis.fetch = realFetch;
  }
});

test("siwa in-process: session log files never contain Apple tokens or ids", async () => {
  const USER = "001234.another-secret-sub.0001";
  const TOKEN = "bhd_ANOTHER_APPLE_TOKEN_0123456789abcdefghijklmnopqrstuv";
  const files: Array<{ name: string; content: string }> = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/apple")) return tokenReply(TOKEN);
    return json(201, { id: "x" });
  }) as typeof fetch;
  const t = createInProcessTransport({
    storageKV: new MemoryKV(), settingsKV: new MemoryKV(), secretKV: new MemoryKV(), uploadKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()),
    fetchImpl: f, streaming: false, platform: "ios-phone", uploadAutoSchedule: false,
    download: (fs) => { files.push(...fs); return true; },
    appleAuth: { isAvailable: async () => ({ available: true }), makeNonce: async () => ({ nonce: "M".repeat(43) }), signIn: async ({ nonce }) => ({ identityToken: jwt(Date.now() + 600_000, USER), user: USER, nonce }), credentialState: async () => ({ state: "authorized" }) },
  });
  await t.providers.select("mock"); // chat on Mock; a stored token alone now means Spider Cloud (c114b0a)
  await t.appleAuth!.launch();
  await t.newSession();
  await t.appleAuth!.signIn(); // mid-session via the sidebar
  await t.reply({ text: "hello there", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
  await t.newSession();
  const r = await t.exportLogs!();
  assert.ok(r.ok && files.length >= 1);
  for (const file of files) for (const sec of [TOKEN, USER, "M".repeat(43)]) assert.ok(!file.content.includes(sec), `${file.name} leaks`);
});

test("siwa in-process: no plugin -> no appleAuth on the bridge (frozen behaviour)", () => {
  const t = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), secretKV: new MemoryKV(), uploadKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()), uploadAutoSchedule: false });
  assert.equal(t.appleAuth, undefined);
});
