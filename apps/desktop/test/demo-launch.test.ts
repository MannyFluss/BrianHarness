// Demo launch routing (Nov 3 2026): a stored Spider Cloud token in the native app means Spider Cloud with
// gpt-oss:20b-cloud (the live-verified route) on a fresh install (never Mock), the model list never gates it, an explicit picker choice wins,
// signing in mid-launch switches the next chat, plain chat never uploads as a study session, and the
// study_start upload is unchanged. Fake fetch only; the token below is a fake literal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV, STUDY_PROTOCOL_VERSION } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";

const TOKEN = "bhd_fake_device_token_demo";
const enc = new TextEncoder();
const sse = (parts: string[]) => new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });

function worker(models: "ok" | "fail" | "hang" = "ok") {
  const log: Array<{ path: string; model?: string; kind?: string; max_tokens?: number }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) return json({ error: { code: "invalid_token" } }, 401);
    if (u.pathname === "/v1/models") {
      log.push({ path: u.pathname });
      if (models === "fail") return json({ error: { code: "upstream" } }, 502);
      if (models === "hang") return new Promise<Response>(() => {});
      return json({ data: [{ id: "gemma4:cloud" }, { id: "gpt-oss:120b-cloud" }] });
    }
    if (u.pathname === "/v1/chat/completions") {
      const body = JSON.parse(String(init?.body));
      log.push({ path: u.pathname, model: body.model, max_tokens: body.max_tokens });
      return body.stream ? sse(["Hey ", "there, ", "what's up?"]) : json({ choices: [{ message: { content: "Hey there, what's up?" } }] });
    }
    if (u.pathname === "/v1/sessions") { log.push({ path: u.pathname, kind: JSON.parse(String(init?.body)).kind }); return json({ id: "x" }, 201); }
    return json({ error: { code: "not_found" } }, 404);
  }) as typeof fetch;
  return { f, log };
}

function app(opts: { models?: "ok" | "fail" | "hang"; native?: boolean; kv?: { settings: MemoryKV; cred: MemoryKV; secret: MemoryKV; upload: MemoryKV; storage: MemoryKV } } = {}) {
  const w = worker(opts.models);
  const kv = opts.kv ?? { settings: new MemoryKV(), cred: new MemoryKV(), secret: new MemoryKV(), upload: new MemoryKV(), storage: new MemoryKV() };
  const t = createInProcessTransport({
    storageKV: kv.storage, settingsKV: kv.settings, secretKV: kv.secret, uploadKV: kv.upload, credentials: new KVCredentialStore(kv.cred),
    fetchImpl: w.f, nativeFetch: opts.native ?? true, streaming: true, platform: "test", uploadAutoSchedule: false, download: () => true,
  });
  return { t, w, kv };
}

test("demo launch: fresh install with a stored token -> Spider Cloud gpt-oss:20b-cloud, streamed opener, no Mock", async () => {
  const { t: first, kv } = app();
  await first.providers.setApiKey("spider", TOKEN); // e.g. Keychain token carried over a TestFlight update
  const { t, w } = app({ kv });
  const info = await t.info();
  assert.equal(info.backend, "spider-cloud:gpt-oss:20b-cloud");
  const toks: string[] = [];
  const d = await t.newSession((tok) => toks.push(tok));
  assert.equal(d.director.text, "Hey there, what's up?");
  assert.ok(toks.length >= 3, "streamed");
  assert.ok(w.log.some((l) => l.path === "/v1/chat/completions" && l.model === "gpt-oss:20b-cloud"));
  assert.ok(w.log.filter((l) => l.path === "/v1/chat/completions").every((l) => l.max_tokens === 2048), "gpt-oss per-model max_tokens");
  assert.ok(!w.log.some((l) => l.path === "/v1/models"), "the model list is not on the launch path");
});

for (const models of ["fail", "hang"] as const) {
  test(`demo launch: model list ${models} -> chat still on Spider Cloud gpt-oss:20b-cloud`, async () => {
    const { t, w } = app({ models });
    await t.providers.setApiKey("spider", TOKEN);
    const d = await t.newSession();
    assert.equal(d.director.text, "Hey there, what's up?");
    assert.ok(w.log.some((l) => l.path === "/v1/chat/completions" && l.model === "gpt-oss:20b-cloud"));
  });
}

test("demo launch: no token -> Mock (unchanged); a token saved before the first chat (SIWA screen) -> that chat is Spider Cloud", async () => {
  const { t, w } = app();
  assert.match((await t.info()).backend, /^mock/); // App calls info() at boot, before the sign-in screen
  await t.providers.setApiKey("spider", TOKEN); // same reset as BHAppleAuth onTokenSaved
  const d = await t.newSession();
  assert.equal(d.director.text, "Hey there, what's up?");
  assert.equal((await t.info()).backend, "spider-cloud:gpt-oss:20b-cloud");
  assert.ok(w.log.some((l) => l.path === "/v1/chat/completions"));
});

test("demo launch: an explicit picker choice wins (Mock stays Mock with a token); browsers (no native fetch) stay Mock", async () => {
  const { t, kv } = app();
  await t.providers.setApiKey("spider", TOKEN);
  await t.providers.select("mock");
  assert.match((await app({ kv }).t.info()).backend, /^mock/);
  const { t: web } = app({ native: false });
  await web.providers.setApiKey("spider", TOKEN);
  assert.match((await web.info()).backend, /^mock/);
});

test("demo launch: plain chat (study off) never uploads as a study session; enabling the study still uploads study_start", async () => {
  const { t, w } = app();
  await t.providers.setApiKey("spider", TOKEN);
  await t.newSession();
  await t.reply({ text: "just chatting", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
  await t.newSession();
  await t.reply({ text: "more chat", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
  await t.newSession();
  let s = await t.uploads!.flush();
  assert.equal(w.log.filter((l) => l.path === "/v1/sessions").length, 0, "no plain chat uploaded");
  assert.equal(s.pending, 0);
  assert.deepEqual(await t.study!.enable(), { ok: true });
  await t.newSession(); // study 1
  await t.newSession(); // ends study 1
  s = await t.uploads!.flush();
  assert.deepEqual(w.log.filter((l) => l.path === "/v1/sessions").map((l) => l.kind).sort(), ["session", "study_start"]);
  const st = await t.study!.status();
  assert.equal(st.next, 2); assert.equal(st.total, 10);
  assert.equal(STUDY_PROTOCOL_VERSION, 3);
});
