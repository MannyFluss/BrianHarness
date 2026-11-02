// Spider Cloud in the in-process app (web / iOS WKWebView): picker row, token at credentials/spider, model list,
// streaming chat through the native fetch, the extractor through the Worker, friendly 401 / 429. Fake fetch only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXTRACTOR_SYSTEM_PROMPT_V2, KVCredentialStore, MemoryKV, type ExportFile } from "@brianharness/core/browser";
import { createInProcessTransport, SPIDER_NO_CORS } from "../src/transport/in-process.ts";

const TOKEN = "bhd_fake_device_token_1234";
const TURNS = ["my sourdough starter bubbled over again", "the crumb on this loaf is so open", "i fed it rye flour this time",
  "work was fine i guess", "anyway the oven spring was wild", "i want to try a 80 percent hydration dough"];
const enc = new TextEncoder();
const sse = (parts: string[]) => new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });

function fakeWorker(mode: "ok" | "401" | "429" = "ok") {
  const log: Array<{ path: string; auth: string | null; extractor: boolean; stream?: boolean }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const json = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...h } });
    if (u.origin !== "https://api.strangeriver.org") return new Response("nope", { status: 404 });
    if (auth !== `Bearer ${TOKEN}` || mode === "401") { log.push({ path: u.pathname, auth, extractor: false }); return json({ error: { message: "invalid device token", type: "authentication_error", code: "invalid_token" } }, 401); }
    if (u.pathname === "/v1/models") { log.push({ path: u.pathname, auth, extractor: false }); return json({ data: [{ id: "gemma4:cloud" }, { id: "gpt-oss:120b-cloud" }, { id: "gpt-oss:20b-cloud" }] }); }
    if (u.pathname === "/v1/chat/completions") {
      const body = JSON.parse(String(init?.body));
      const extractor = body.messages?.[0]?.content === EXTRACTOR_SYSTEM_PROMPT_V2;
      log.push({ path: u.pathname, auth, extractor, stream: body.stream });
      if (mode === "429") return json({ error: { type: "rate_limit_error", code: "daily_cap_device", message: "cap", limit: 4, used: 4, reset_at: "2026-11-03T00:00:00.000Z" } }, 429, { "retry-after": "3600" });
      if (extractor) return json({ choices: [{ message: { content: JSON.stringify({ interests: [{ label: "sourdough bread baking", confidence: 0.9, turns: [1, 2, 3] }] }) } }] });
      return body.stream ? sse(["Hello ", "from ", "spider?"]) : json({ choices: [{ message: { content: "Hello from spider?" } }] });
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as typeof fetch;
  return { f, log };
}

async function app(mode: "ok" | "401" | "429" = "ok", native = true) {
  const w = fakeWorker(mode);
  const credKV = new MemoryKV();
  let exported: ExportFile[] = [];
  const t = createInProcessTransport({
    storageKV: new MemoryKV(), settingsKV: new MemoryKV(), credentials: new KVCredentialStore(credKV), fetchImpl: w.f, nativeFetch: native, streaming: true,
    platform: "test", download: (files) => ((exported = files), true),
  });
  return { t, w, credKV, exported: () => exported };
}

test("spider cloud app: token stored at credentials/spider, picker lists /v1/models, chat streams through the native fetch", async () => {
  const { t, w, credKV } = await app();
  let row = (await t.providers.status()).providers.find((p) => p.id === "spider-cloud")!;
  assert.equal(row.signedIn, false); assert.match(row.detail!, /device token/); assert.equal(row.endpoint, "https://api.strangeriver.org");
  await t.providers.setApiKey("spider", TOKEN);
  assert.deepEqual(await credKV.keys(""), ["credentials/spider"]);
  row = (await t.providers.status()).providers.find((p) => p.id === "spider-cloud")!;
  assert.equal(row.signedIn, true);
  assert.deepEqual(row.models.map((m) => m.id), ["gemma4:cloud", "gpt-oss:120b-cloud", "gpt-oss:20b-cloud"]);
  const info = await t.providers.select("spider-cloud", "gemma4:cloud");
  assert.equal(info.backend, "spider-cloud:gemma4:cloud");
  assert.match(info.tagger!, /via Spider Cloud \(prompt v2\)/);
  const toks: string[] = [];
  const d = await t.newSession((tok) => toks.push(tok));
  assert.equal(d.director.text, "Hello from spider?");
  assert.ok(toks.length >= 3, "streamed tokens");
  assert.ok(w.log.some((l) => l.path === "/v1/chat/completions" && l.stream === true && !l.extractor));
});

test("spider cloud app: extractor calls gemma4:cloud through the Worker at turn 6; final says llm-extract", async () => {
  const { t, w, exported } = await app();
  await t.providers.setApiKey("spider", TOKEN);
  await t.providers.select("spider-cloud", "gpt-oss:20b-cloud");
  await t.newSession();
  for (const text of TURNS) await t.reply({ text, events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
  await t.newSession();
  await t.exportLogs();
  assert.equal(w.log.filter((l) => l.extractor).length, 1);
  const lines = exported().filter((x) => x.name.endsWith(".jsonl")).map((x) => x.content.trim().split("\n").map((l) => JSON.parse(l))).find((ls) => ls.some((l) => l.type === "final"))!;
  const fin = lines.find((l) => l.type === "final");
  assert.equal(fin.top1, "sourdough bread baking"); assert.equal(fin.effectiveTagger, "llm-extract"); assert.equal(fin.model, "gemma4:cloud");
  assert.ok(!JSON.stringify(lines).includes(TOKEN), "token never logged");
});

test("spider cloud app: 401 -> token invalid or revoked; 429 -> daily limit with reset; no native fetch -> needs the native app", async () => {
  const a = await app("401");
  await a.t.providers.setApiKey("spider", TOKEN);
  await a.t.providers.select("spider-cloud", "gemma4:cloud");
  await assert.rejects(a.t.newSession(), /Spider Cloud: device token invalid or revoked/);
  const row = (await a.t.providers.status()).providers.find((p) => p.id === "spider-cloud")!;
  assert.match(row.detail!, /device token invalid or revoked/);
  const b = await app("429");
  await b.t.providers.setApiKey("spider", TOKEN);
  await b.t.providers.select("spider-cloud", "gemma4:cloud");
  await assert.rejects(b.t.newSession(), /daily limit reached, resets at/);
  const c = await app("ok", false);
  await c.t.providers.setApiKey("spider", TOKEN);
  await assert.rejects(c.t.providers.select("spider-cloud", "gemma4:cloud"), new RegExp(SPIDER_NO_CORS.slice(0, 30)));
});
