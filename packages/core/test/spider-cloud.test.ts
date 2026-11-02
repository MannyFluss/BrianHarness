// Spider Cloud preset (Manny's Worker, OpenAI-compatible + bhd_ device token): errors, models, chat, extractor.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPIDER_CLOUD_MODELS, SPIDER_CLOUD_URL, SpiderCloudBackend, SpiderCloudError, createBrowserBackend, listSpiderCloudModels, normalizeSpiderUrl, spiderCloudError, spiderFetch,
  LlmInterestExtractor, HarnessSession, MockBackend, MemoryHarnessStorage, appTaggerSpec, buildExtractorPrompt, promptKey, extractorCacheKey, openaiRequestBody, requestBody, parseExtractorResponse,
  parseBackendRef,
} from "../src/index.ts";

const TOKEN = "bhd_test_0123456789abcdef";
const fmt = (d: Date) => d.toISOString();
const cap429 = JSON.stringify({ error: { type: "rate_limit_error", code: "daily_cap_device", message: "device daily cap reached, resets at 2026-11-03T00:00:00.000Z", limit: 200, used: 200, reset_at: "2026-11-03T00:00:00.000Z" } });

test("spider cloud: URL normalization, provider ref", () => {
  assert.equal(normalizeSpiderUrl(undefined), SPIDER_CLOUD_URL);
  assert.equal(normalizeSpiderUrl("https://api.strangeriver.org/v1/"), "https://api.strangeriver.org");
  assert.equal(normalizeSpiderUrl(" http://127.0.0.1:8787 "), "http://127.0.0.1:8787");
  assert.deepEqual(parseBackendRef("spider-cloud:gpt-oss:20b-cloud"), { provider: "spider-cloud", model: "gpt-oss:20b-cloud" });
});

test("spider cloud: 401 -> token invalid or revoked; 429 daily_cap_* -> daily limit + local reset time (reset_at, else Retry-After)", () => {
  assert.equal(spiderCloudError(401, '{"error":{"message":"bad token","code":"invalid_token"}}').message, "Spider Cloud: device token invalid or revoked");
  const e = spiderCloudError(429, cap429, "3600", 0, fmt);
  assert.equal(e.message, "Spider Cloud: daily limit reached, resets at 2026-11-03T00:00:00.000Z");
  assert.ok(e.capped); assert.equal(e.code, "daily_cap_device");
  const g = spiderCloudError(429, JSON.stringify({ error: { code: "daily_cap_global" } }), "60", Date.parse("2026-11-02T22:00:00Z"), fmt);
  assert.equal(g.message, "Spider Cloud: daily limit reached, resets at 2026-11-02T22:01:00.000Z");
  const local = spiderCloudError(429, cap429);
  assert.match(local.message, /^Spider Cloud: daily limit reached, resets at /);
  assert.ok(!local.message.includes("T00:00:00"), "shown in local time, not ISO");
  const other = spiderCloudError(400, JSON.stringify({ error: { code: "model_not_found", message: "unknown model x" } }));
  assert.ok(!other.capped); assert.match(other.message, /400 model_not_found: unknown model x/);
});

test("spider cloud: model list from GET /v1/models with the token; static fallback on 401 / network error", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const ok = (async (u: string, init?: RequestInit) => {
    seen.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ data: [{ id: "gemma4:cloud" }, { id: "gpt-oss:20b-cloud" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await listSpiderCloudModels("http://w/v1", TOKEN, ok), { models: ["gemma4:cloud", "gpt-oss:20b-cloud"], live: true });
  assert.deepEqual(seen, [{ url: "http://w/v1/models", auth: `Bearer ${TOKEN}` }]);
  const bad = (async () => new Response('{"error":{"code":"invalid_token"}}', { status: 401 })) as unknown as typeof fetch;
  const r = await listSpiderCloudModels("http://w", TOKEN, bad);
  assert.deepEqual(r.models, SPIDER_CLOUD_MODELS); assert.equal(r.live, false); assert.match(r.error!, /invalid or revoked/);
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.deepEqual((await listSpiderCloudModels("http://w", TOKEN, down)).models, ["gemma4:cloud", "gpt-oss:120b-cloud", "gpt-oss:20b-cloud"]);
});

const sse = (chunks: string[]) => new Response(new ReadableStream({ start(c) { for (const t of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)); c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });

test("spider cloud backend: <base>/v1/chat/completions + Bearer token, streams SSE, buffered when not streaming; friendly errors", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const f = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: u, body, auth: new Headers(init.headers).get("authorization") });
    return body.stream ? sse(["Hello ", "from ", "spider"]) : new Response(JSON.stringify({ choices: [{ message: { content: "buffered hi" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const b = createBrowserBackend({ provider: "spider-cloud", apiKey: TOKEN, baseUrl: "http://127.0.0.1:8787/", fetchImpl: f, streaming: true });
  assert.equal(b.id, "spider-cloud:gemma4:cloud"); assert.equal(b.paid, true);
  const toks: string[] = [];
  const r = await b.generate({ messages: [{ role: "user", content: "hi" }], onToken: (t) => toks.push(t) });
  assert.equal(r.text, "Hello from spider"); assert.ok(toks.length >= 3, "tokens streamed");
  assert.equal(calls[0]!.url, "http://127.0.0.1:8787/v1/chat/completions"); assert.equal(calls[0]!.auth, `Bearer ${TOKEN}`); assert.equal(calls[0]!.body.stream, true);
  const buffered = new SpiderCloudBackend({ token: TOKEN, baseUrl: "http://127.0.0.1:8787", fetchImpl: f, streaming: false });
  assert.equal((await buffered.generate({ messages: [{ role: "user", content: "hi" }], onToken: () => {} })).text, "buffered hi");
  assert.equal(calls[1]!.body.stream, false);
  const capped = new SpiderCloudBackend({ token: TOKEN, fetchImpl: (async () => new Response(cap429, { status: 429, headers: { "retry-after": "10" } })) as unknown as typeof fetch });
  await assert.rejects(capped.generate({ messages: [{ role: "user", content: "x" }] }), (e: unknown) => e instanceof SpiderCloudError && /daily limit reached, resets at/.test(e.message));
  const revoked = new SpiderCloudBackend({ token: TOKEN, fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch });
  await assert.rejects(revoked.generate({ messages: [{ role: "user", content: "x" }] }), /device token invalid or revoked/);
  assert.throws(() => new SpiderCloudBackend({}), /device token/);
});

const ANSWER_OA = JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ interests: [{ label: "sourdough baking", confidence: 0.9, turns: [1, 2] }] }) } }] });
test("extractor over the OpenAI wire: same prompt, response_format json, max_tokens, oa:-prefixed cache key; Ollama keys unchanged", async () => {
  const p = buildExtractorPrompt(["my starter bubbled over"], "gemma4:cloud", 12, "v2");
  assert.equal(extractorCacheKey(p), promptKey(p), "Ollama path: key unchanged");
  assert.equal(extractorCacheKey(p, "openai"), `oa:${promptKey(p)}`);
  const ob = openaiRequestBody(p, 768);
  assert.deepEqual(ob, { model: "gemma4:cloud", stream: false, messages: p.messages, response_format: { type: "json_object" }, temperature: 0, seed: 1, max_tokens: 768 });
  assert.deepEqual((requestBody(p) as { messages: unknown }).messages, ob.messages, "identical messages");
  assert.ok(!("response_format" in openaiRequestBody({ ...p, model: "gpt-oss:20b-cloud" })));
  assert.deepEqual(parseExtractorResponse(ANSWER_OA).map((x) => x.label), ["sourdough baking"]);

  const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const f = (async (u: string, init: RequestInit) => { seen.push({ url: u, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") }); return new Response(ANSWER_OA, { status: 200 }); }) as unknown as typeof fetch;
  const cache = new Map<string, string>();
  const ex = new LlmInterestExtractor({ api: "openai", baseUrl: "http://127.0.0.1:8787/v1", apiKey: TOKEN, everyN: 2, fetchImpl: spiderFetch(f), cache: { get: (k) => cache.get(k), set: (k, v) => void cache.set(k, v) } });
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: null, seed: 3, tagger: ex });
  await s.start();
  for (const t of ["my starter bubbled over again", "the crumb on this loaf is so open"]) await s.reply(t);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "http://127.0.0.1:8787/v1/chat/completions"); assert.equal(seen[0]!.auth, `Bearer ${TOKEN}`, "token sent even to a loopback Worker");
  assert.equal(seen[0]!.body.max_tokens, 768); assert.deepEqual(seen[0]!.body.response_format, { type: "json_object" });
  assert.ok([...cache.keys()].every((k) => k.startsWith("oa:")));
  assert.equal(s.finalGuesses(1)[0]!.label, "sourdough baking");
  assert.deepEqual(s.extractorOutcome(), { extractorCalls: { attempted: 1, ok: 1, failed: 0, capped: 0 }, effectiveTagger: "llm-extract", fallback: false });
});

test("extractor via Spider Cloud: Worker 429 daily cap -> cap_reached (no retry); 401 -> call_failed", async () => {
  for (const [status, body, reason, net] of [[429, cap429, "cap_reached", 1], [401, "{}", "call_failed", 1]] as const) {
    let n = 0;
    const f = (async () => { n++; return new Response(body, { status }); }) as unknown as typeof fetch;
    const ex = new LlmInterestExtractor({ api: "openai", baseUrl: "http://w", apiKey: TOKEN, everyN: 2, fetchImpl: spiderFetch(f), retryDelayMs: 1 });
    const s = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: new MemoryHarnessStorage(), seed: 3, tagger: ex });
    await s.start();
    for (const t of ["a", "b"]) await s.reply(t);
    assert.equal(s.extractorOutcome().fallbackReason, reason); assert.equal(n, net);
  }
});

test("app tagger: Spider Cloud + token -> llm-extract gemma4:cloud over the Worker (openai wire); no token / no native fetch -> keyphrase-idf no_key", () => {
  const c = appTaggerSpec({ provider: "spider-cloud", spiderToken: TOKEN, spiderUrl: "https://api.strangeriver.org/v1" });
  assert.equal(c.spec.kind, "llm-extract");
  const sp = c.spec as { api?: string; baseUrl?: string; model?: string; apiKey?: string; promptVersion?: string };
  assert.equal(sp.api, "openai"); assert.equal(sp.baseUrl, "https://api.strangeriver.org"); assert.equal(sp.model, "gemma4:cloud"); assert.equal(sp.apiKey, TOKEN); assert.equal(sp.promptVersion, "v2");
  assert.match(c.reason, /via Spider Cloud \(prompt v2\)/);
  assert.deepEqual([appTaggerSpec({ provider: "spider-cloud" }).fallback, appTaggerSpec({ provider: "spider-cloud", spiderToken: TOKEN, canReachSpider: false }).fallback], ["no_key", "no_key"]);
});

test("ProviderHub (desktop): Spider Cloud token in the encrypted credentials file, models listed, URL setting, backend builds", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ProviderHub } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "bh-spider-"));
  const f = (async (u: string) => {
    if (String(u).endsWith("/api/tags")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ data: [{ id: "gemma4:cloud" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const cipher = { kind: "test-b64", encrypt: (s: string) => Buffer.from(s).toString("base64"), decrypt: (s: string) => Buffer.from(s, "base64").toString() };
  const hub = new ProviderHub({ dataDir: dir, fetchImpl: f, claudeBin: "/nonexistent", cipher: cipher as never });
  await assert.rejects(hub.createBackend({ provider: "spider-cloud" }), /device token/);
  await hub.setApiKey("spider", TOKEN);
  assert.ok(!readFileSync(join(dir, "credentials.json"), "utf8").includes(TOKEN), "token not stored in plain text");
  hub.saveSettings({ spiderCloudUrl: "http://127.0.0.1:8787/v1" });
  const row = (await hub.status()).find((p) => p.id === "spider-cloud")!;
  assert.equal(row.signedIn, true); assert.equal(row.endpoint, "http://127.0.0.1:8787"); assert.deepEqual(row.models.map((m) => m.id), ["gemma4:cloud"]);
  const b = await hub.createBackend({ provider: "spider-cloud", model: "gpt-oss:20b-cloud" });
  assert.equal(b.id, "spider-cloud:gpt-oss:20b-cloud"); assert.equal(b.paid, true);
});
