// bhd_ device-token scrub on the web side (report d2bd6006 item 5): maskSecret / scrubSecrets, keychain error
// messages, native migration warnings, the console wrapper, flight-recorder events and the feedback report.
// The token below is a fake test string; no real token exists in this repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FlightRecorder, KVCredentialStore, MemoryKV, buildFeedbackReport, type StoredCredential } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";
import { createKeychainCredentials, nativeTransportOptions } from "../src/transport/native.ts";
import { keychainErrorMessage } from "../src/transport/keychain.ts";
import { installConsoleScrub, maskSecret, scrubDeep, scrubSecrets } from "../src/secrets.ts";
import { scrubRecorder } from "../src/feedback/recorder.ts";
import { chatTurnsOf } from "../src/feedback/report.ts";

const FAKE = "bhd_FAKEtestOnly_0123456789abcdefXYZ";
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

/** capture every console.* call (raw console replaced; the scrub wrapper, when installed, sits on top) */
function spyConsole() {
  const seen: string[] = [];
  const orig = LEVELS.map((l) => [l, console[l]] as const);
  for (const l of LEVELS) console[l] = (...a: unknown[]) => void seen.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack ?? ""}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  return { seen, restore: () => { for (const [l, fn] of orig) console[l] = fn; } };
}
/** a Keychain whose native errors quote the value it was handed (the worst case IOS Dev saw in the console) */
function leakyKeychain() {
  const err = (op: string) => Object.assign(new Error(`SecItem ${op} failed for value ${FAKE}`), { code: "-25308" });
  return { get: async () => { throw err("get"); }, set: async () => { throw err("set"); }, remove: async () => { throw err("remove"); }, keys: async () => { throw err("keys"); } };
}

test("maskSecret / scrubSecrets: prefix + length only, never any character of the secret", () => {
  assert.equal(maskSecret(FAKE), `bhd_…(len ${FAKE.length})`);
  assert.equal(maskSecret(""), "");
  const s = scrubSecrets(`Authorization: Bearer ${FAKE}; again ${FAKE}`);
  assert.doesNotMatch(s, /bhd_[A-Za-z0-9]/);
  assert.ok(!s.includes(FAKE.slice(4)));
  const d = scrubDeep({ a: [FAKE, { b: `x ${FAKE}` }], e: new Error(`boom ${FAKE}`), n: 3 });
  assert.doesNotMatch(JSON.stringify(d) + (d.e as Error).message + ((d.e as Error).stack ?? ""), /bhd_[A-Za-z0-9]/);
  assert.equal(d.n, 3);
});

test("keychainErrorMessage never quotes a bhd_ token", () => {
  const m = keychainErrorMessage("read", Object.assign(new Error(`bad item ${FAKE}`), { code: "-25300" }));
  assert.match(m, /OSStatus -25300/);
  assert.doesNotMatch(m, /bhd_[A-Za-z0-9]/);
});

test("keychain flows (migration, reads, a failed save, chat) put no bhd_ on the console, raw or wrapped", async () => {
  for (const wrapped of [false, true]) {
    const spy = spyConsole();
    const unwrap = wrapped ? installConsoleScrub(console) : () => {};
    try {
      const legacy = new KVCredentialStore(new MemoryKV());
      await legacy.modify("spider", async () => ({ type: "api_key", key: FAKE }) as StoredCredential);
      const kc = createKeychainCredentials(leakyKeychain() as never, legacy, (r) => { if (r.failed.length) console.warn("[test] migration report", r.failed.map((f) => f.providerId).join(",")); });
      await kc.migration;
      await kc.list().catch(() => null);
      await kc.modify("openai", async () => ({ type: "api_key", key: "sk-x" }) as StoredCredential).catch(() => null);
      // the whole app path: native options (BHKeychain fake), legacy spider token, a chat turn
      const rec = new FlightRecorder();
      const win = { Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n: string) => n === "BHKeychain", Plugins: { BHKeychain: leakyKeychain() } }, fetch: (async () => new Response('{"models":[]}')) as typeof fetch };
      const t = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), uploadKV: new MemoryKV(), platform: "test", recorder: rec, uploadAutoSchedule: false, ...nativeTransportOptions(win, { legacyCredentials: legacy }) });
      await t.providers.status();
      await t.providers.setApiKey("spider", FAKE).catch(() => null);
      await t.providers.select("mock");
      await t.newSession();
      await t.reply({ text: "hello", events: [], sentAt: Date.now(), shownAt: Date.now() - 500 });
      assert.ok(spy.seen.length > 0, "the keychain failures were logged");
      for (const line of spy.seen) assert.doesNotMatch(line, /bhd_[A-Za-z0-9]/, `console line leaks a token (wrapped=${wrapped}): ${line.replace(/bhd_\S+/g, "bhd_<…>")}`);
      assert.doesNotMatch(JSON.stringify(rec.events()), /bhd_[A-Za-z0-9]/, "flight recorder events");
    } finally {
      unwrap();
      spy.restore();
    }
  }
});

test("the console wrapper scrubs strings, objects and errors at every level", () => {
  const spy = spyConsole();
  const unwrap = installConsoleScrub(console);
  try {
    for (const l of LEVELS) console[l](`token ${FAKE}`, { auth: FAKE }, new Error(`err ${FAKE}`));
    assert.equal(spy.seen.length, LEVELS.length);
    for (const line of spy.seen) assert.doesNotMatch(line, /bhd_[A-Za-z0-9]/);
    assert.equal(installConsoleScrub(console)(), undefined, "idempotent");
  } finally { unwrap(); spy.restore(); }
});

test("flight recorder + feedback report stay clean even when a token is typed or echoed", () => {
  const rec = scrubRecorder(new FlightRecorder());
  rec.record("error", { source: "native", plugin: "BHKeychain", message: `failed ${FAKE}` });
  rec.record("screen", { screen: "report", controls: [{ label: "note", control: "textarea", value: `my token is ${FAKE}` }] });
  assert.doesNotMatch(JSON.stringify(rec.events()), /bhd_[A-Za-z0-9]/);
  const report = buildFeedbackReport({ events: rec.events(), chatTurns: chatTurnsOf([{ id: "m1", role: "user", text: `here: ${FAKE}` }]), header: { build: "1", appVersion: "1", platform: "ios-tablet", note: `pasted ${FAKE}`, sessionId: null, study: { inStudy: false, index: null }, trigger: "sidebar" } });
  assert.doesNotMatch(JSON.stringify(report), /bhd_[A-Za-z0-9]/);
});
