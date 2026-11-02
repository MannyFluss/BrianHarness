// In-process transport: study sessions + study_start auto-upload to the Spider Cloud Worker (fake fetch);
// practice sessions never upload; "N logs waiting to upload" without a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV, STUDY_PROTOCOL_VERSION } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";

test("in-process: study session + study_start upload once the device token is set; practice sessions never upload", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) { posts.push({ url, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ id: "x" }), { status: 201 }); }
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  }) as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { throw new Error(`global fetch used for ${String(u)}`); }) as typeof fetch;
  try {
    const t = createInProcessTransport({
      storageKV: new MemoryKV(), settingsKV: new MemoryKV(), secretKV: new MemoryKV(), uploadKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()),
      fetchImpl: f, streaming: false, platform: "test", appVersion: "0.4.0", build: 12, uploadAutoSchedule: false, download: () => true,
    });
    await t.newSession(); // practice
    await t.reply({ text: "practice chat", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    assert.deepEqual(await t.study!.enable(), { ok: true });
    await t.newSession(); // ends the practice one; study 1 starts
    await t.reply({ text: "study chat", events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    await t.newSession(); // ends study 1
    await new Promise((r) => setTimeout(r, 20));
    let s = await t.uploads!.status();
    assert.equal(posts.length, 0);
    assert.equal(s.pending, 2, "study_start + 1 study session waiting"); assert.equal(s.blocked, "no-token");
    await t.providers.setApiKey("spider", "bhd_fake_device_token");
    s = await t.uploads!.flush();
    assert.equal(s.pending, 0); assert.equal(s.done, 2);
    assert.ok(posts.every((p) => p.url === "https://api.strangeriver.org/v1/sessions"));
    const start = posts.find((p) => p.body.kind === "study_start")!.body;
    assert.equal(start.protocol, STUDY_PROTOCOL_VERSION); assert.equal(start.nSessions, 10); assert.equal(start.build, 12);
    const sess = posts.filter((p) => p.body.kind === "session");
    assert.equal(sess.length, 1, "practice session not uploaded");
    assert.equal(sess[0]!.body.studyIndex, 1); assert.equal(sess[0]!.body.appVersion, "0.4.0");
  } finally {
    globalThis.fetch = realFetch;
  }
});
