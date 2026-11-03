// Upgrade reset of a saved pick (Nov 3 2026): settings saved by an earlier install (no pickMigration marker, e.g. the
// protocol-2 TestFlight builds) with Mock or a Spider Cloud model drop that pick once in the native app, so a token
// launch lands on Spider Cloud gpt-oss:20b-cloud; a pick made after the upgrade persists; a fresh install is
// unchanged. Fake fetch only; the token below is a fake literal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV } from "@brianharness/core/browser";
import { createInProcessTransport, PICK_MIGRATION } from "../src/transport/in-process.ts";

const TOKEN = "bhd_fake_device_token_upgrade";
type KVs = { settings: MemoryKV; cred: MemoryKV; secret: MemoryKV; upload: MemoryKV; storage: MemoryKV };
const fresh = (): KVs => ({ settings: new MemoryKV(), cred: new MemoryKV(), secret: new MemoryKV(), upload: new MemoryKV(), storage: new MemoryKV() });

function launch(kv: KVs, native = true) {
  const chats: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) return json({ error: { code: "invalid_token" } }, 401);
    if (u.pathname === "/v1/models") return json({ data: [{ id: "gemma4:cloud" }, { id: "gpt-oss:20b-cloud" }] });
    if (u.pathname === "/v1/chat/completions") { chats.push(JSON.parse(String(init?.body)).model); return json({ choices: [{ message: { content: "Hey there, what's up?" } }] }); }
    return json({ error: { code: "not_found" } }, 404);
  }) as typeof fetch;
  const t = createInProcessTransport({
    storageKV: kv.storage, settingsKV: kv.settings, secretKV: kv.secret, uploadKV: kv.upload, credentials: new KVCredentialStore(kv.cred),
    fetchImpl: f, nativeFetch: native, streaming: false, platform: "test", uploadAutoSchedule: false, download: () => true,
  });
  return { t, chats };
}
/** what the protocol-2 builds left: the token in credentials, the picker's pick in settings (no providerChosen, no marker) */
async function v2Install(saved: Record<string, unknown>, token = true): Promise<KVs> {
  const kv = fresh();
  if (token) await launch(kv).t.providers.setApiKey("spider", TOKEN);
  await kv.settings.set("settings", JSON.stringify(saved));
  return kv;
}
const stored = async (kv: KVs) => JSON.parse((await kv.settings.get("settings")) ?? "null");

for (const [name, saved] of [
  ["Mock picked", { provider: "mock" }],
  ["gemma4:cloud picked in the Spider Cloud picker", { provider: "spider-cloud", model: "gemma4:cloud" }],
] as const) {
  test(`upgrade: v2 install with ${name} + token -> lands on Spider Cloud gpt-oss:20b-cloud`, async () => {
    const kv = await v2Install({ ...saved, spiderCloudUrl: "https://api.strangeriver.org" });
    const { t, chats } = launch(kv);
    assert.equal((await t.info()).backend, "spider-cloud:gpt-oss:20b-cloud");
    await t.newSession();
    assert.deepEqual(chats, ["gpt-oss:20b-cloud"]);
    assert.deepEqual(await stored(kv), { spiderCloudUrl: "https://api.strangeriver.org", pickMigration: PICK_MIGRATION }, "pick dropped once, the Worker URL kept");
    assert.equal((await launch(kv).t.info()).backend, "spider-cloud:gpt-oss:20b-cloud", "relaunch: same");
  });
}

test("upgrade: a pick made after the migration persists across relaunch (Spider model and Mock)", async () => {
  const kv = await v2Install({ provider: "spider-cloud", model: "gemma4:cloud" });
  const a = launch(kv);
  assert.equal((await a.t.info()).backend, "spider-cloud:gpt-oss:20b-cloud");
  await a.t.providers.select("spider-cloud", "gemma4:cloud");
  const b = launch(kv);
  assert.equal((await b.t.info()).backend, "spider-cloud:gemma4:cloud");
  await b.t.newSession();
  assert.deepEqual(b.chats, ["gemma4:cloud"]);
  await b.t.providers.select("mock");
  assert.match((await launch(kv).t.info()).backend, /^mock/);
  assert.match((await launch(kv).t.info()).backend, /^mock/, "and again");
});

test("upgrade: fresh install unchanged (token -> gpt-oss, nothing written at launch; no token -> Mock)", async () => {
  const kv = fresh();
  const { t } = launch(kv);
  assert.match((await t.info()).backend, /^mock/);
  assert.equal(await kv.settings.get("settings"), null, "no settings written by the migration");
  await t.providers.setApiKey("spider", TOKEN);
  assert.equal((await launch(kv).t.info()).backend, "spider-cloud:gpt-oss:20b-cloud");
  assert.equal(await kv.settings.get("settings"), null);
});

test("upgrade: v2 gemma4 pick, no token -> Mock until sign-in (SIWA path unchanged), then gpt-oss", async () => {
  const kv = await v2Install({ provider: "spider-cloud", model: "gemma4:cloud" }, false);
  const { t } = launch(kv);
  assert.match((await t.info()).backend, /^mock/);
  // (the App's SIWA gate reads BHAppleAuth status().tokenSource, not settings: demo/upgrade-launch.mjs checks the screen)
  await t.providers.setApiKey("spider", TOKEN); // same reset as BHAppleAuth onTokenSaved
  await t.newSession();
  assert.equal((await t.info()).backend, "spider-cloud:gpt-oss:20b-cloud");
});

test("upgrade: other providers and browsers keep their saved pick", async () => {
  const kv = await v2Install({ provider: "ollama", model: "llama3:8b", ollamaUrl: "http://127.0.0.1:11434" });
  launch(kv); await launch(kv).t.info();
  assert.deepEqual(await stored(kv), { provider: "ollama", model: "llama3:8b", ollamaUrl: "http://127.0.0.1:11434", pickMigration: PICK_MIGRATION });
  const web = await v2Install({ provider: "spider-cloud", model: "gemma4:cloud" });
  await launch(web, false).t.info();
  assert.deepEqual(await stored(web), { provider: "spider-cloud", model: "gemma4:cloud" }, "web build: no native default, nothing reset");
});
