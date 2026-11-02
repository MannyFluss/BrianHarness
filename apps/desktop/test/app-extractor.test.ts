// Dogfood app tagger selection (Director, Nov 2 2026): llm-extract (prompt v2, rank lead) with a real cloud
// provider + an Ollama Cloud key; keyphrase-idf with mock or when the extractor fails; one persisted call
// cap; {type:'final'} at session end. Fake fetch only (global fetch replaced by a thrower): no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXTRACTOR_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT_V2, KVCredentialStore, MemoryKV, APP_EXTRACTOR_CALLS_KEY, appTaggerSpec, kvCallCounter,
  type ExportFile,
} from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";

const CLOUD = "https://fake-ollama-cloud.test";
const TURNS = ["my sourdough starter bubbled over again", "the crumb on this loaf is so open", "i fed it rye flour this time",
  "work was fine i guess", "anyway the oven spring was wild", "i want to try a 80 percent hydration dough"];

function fakeCloud(extractor: "ok" | "fail") {
  const sys: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/tags")) return json({ models: [{ name: "gpt-oss:120b" }] });
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const s0 = body.messages?.[0]?.content ?? "";
      if (s0 === EXTRACTOR_SYSTEM_PROMPT || s0 === EXTRACTOR_SYSTEM_PROMPT_V2) {
        sys.push(s0 === EXTRACTOR_SYSTEM_PROMPT_V2 ? "v2" : "v1");
        if (extractor === "fail") return json({ error: "boom" }, 400);
        return json({ message: { content: JSON.stringify({ interests: [{ label: "sourdough bread baking", confidence: 0.9, turns: [1, 2, 3] }] }) } });
      }
      return json({ message: { content: "nice, tell me more?" }, done: true });
    }
    if (url.endsWith("/chat/completions")) return json({ choices: [{ message: { content: "oai says hi?" } }] });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { f, sys };
}

async function run(opts: { provider: "mock" | "ollama-cloud" | "openai"; extractor?: "ok" | "fail"; key?: boolean; version?: "v1" | "v2"; settingsKV?: MemoryKV }) {
  const { f, sys } = fakeCloud(opts.extractor ?? "ok");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { throw new Error(`global fetch used for ${String(u)}`); }) as typeof fetch;
  try {
    let exported: ExportFile[] = [];
    const settingsKV = opts.settingsKV ?? new MemoryKV();
    const t = createInProcessTransport({
      storageKV: new MemoryKV(), settingsKV, credentials: new KVCredentialStore(new MemoryKV()), fetchImpl: f, streaming: false,
      ollamaCloudUrl: CLOUD, platform: "test", download: (files) => ((exported = files), true),
    });
    if (opts.key !== false) await t.providers.setApiKey("ollama-cloud", "fake-ollama-key");
    if (opts.provider === "openai") await t.providers.setApiKey("openai", "sk-fake");
    if (opts.provider !== "mock") await t.providers.select(opts.provider, opts.provider === "openai" ? "gpt-4o-mini" : "gpt-oss:120b");
    if (opts.version) await t.providers.setExtractorPrompt!(opts.version);
    const info = await t.info();
    await t.newSession();
    for (const text of TURNS) await t.reply({ text, events: [], sentAt: Date.now(), shownAt: Date.now() - 1000 });
    await t.newSession(); // ends the first session (final + session_end)
    await t.exportLogs();
    const first = exported.filter((x) => x.name.endsWith(".jsonl")).map((x) => x.content.trim().split("\n").map((l) => JSON.parse(l)))
      .find((ls) => ls.some((l) => l.type === "final"))!;
    return { info, sys, lines: first, final: first.find((l) => l.type === "final"), settingsKV };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("app tagger: real cloud provider + Ollama Cloud key -> llm-extract v2 (rank lead); final record logged", async () => {
  const r = await run({ provider: "ollama-cloud" });
  assert.match(r.info.tagger!, /llm-extract gemma4:cloud via Ollama Cloud \(prompt v2\)/);
  assert.equal(r.info.extractorPromptVersion, "v2");
  assert.deepEqual(r.sys, ["v2"], "one extractor call at user turn 6, v2 prompt");
  assert.equal(r.final.top1, "sourdough bread baking");
  assert.equal(r.final.extractorPromptVersion, "v2"); assert.equal(r.final.model, "gemma4:cloud"); assert.equal(r.final.tagger, "llm-extract");
  assert.ok(Array.isArray(r.final.top3) && r.final.top3.length >= 1);
  assert.ok(r.lines.filter((l) => l.type === "interest_update").every((l) => "top1" in l), "running top1 per turn");
  assert.equal(JSON.parse((await r.settingsKV.get(APP_EXTRACTOR_CALLS_KEY))!).calls, 1, "persisted shared call cap counter");
});

test("app tagger: v1 rollback flag in settings sends the v1 prompt", async () => {
  const r = await run({ provider: "ollama-cloud", version: "v1" });
  assert.equal(r.info.extractorPromptVersion, "v1");
  assert.deepEqual(r.sys, ["v1"]);
  assert.equal(r.final.extractorPromptVersion, "v1");
});

test("app tagger: mock -> keyphrase-idf, no extractor call; OpenAI without an Ollama Cloud key -> keyphrase-idf", async () => {
  const m = await run({ provider: "mock" });
  assert.match(m.info.tagger!, /mock provider: keyphrase-idf/);
  assert.deepEqual(m.sys, []);
  assert.equal(m.final.tagger, "keyphrase-idf"); assert.ok(!("extractorPromptVersion" in m.final));
  const o = await run({ provider: "openai", key: false });
  assert.match(o.info.tagger!, /no Ollama Cloud key/);
  assert.deepEqual(o.sys, []);
});

test("app tagger: extractor failure falls back to keyphrase-idf labels (session keeps going)", async () => {
  const r = await run({ provider: "ollama-cloud", extractor: "fail" });
  assert.deepEqual(r.sys, ["v2"]);
  assert.equal(r.final.tagger, "llm-extract");
  assert.ok(r.final.top1 && r.final.top1 !== "sourdough bread baking", `keyphrase-idf top1, got ${r.final.top1}`);
});

test("app tagger: shared call cap refuses once spent (no fetch)", async () => {
  const kv = new MemoryKV();
  const c = kvCallCounter(kv, 1);
  assert.deepEqual(await Promise.all([c.reserve(), c.reserve(), c.reserve()]), [true, false, false]);
  await kv.set(APP_EXTRACTOR_CALLS_KEY, JSON.stringify({ calls: 50 }));
  const r = await run({ provider: "ollama-cloud", settingsKV: kv });
  assert.deepEqual(r.sys, [], "cap reached: no network call");
  assert.equal(appTaggerSpec({ provider: "ollama", model: "llama3.2:3b", ollamaUrl: "http://127.0.0.1:11434" }).spec.kind, "keyphrase-idf");
  assert.equal(appTaggerSpec({ provider: "ollama", model: "gpt-oss:120b-cloud", ollamaUrl: "http://127.0.0.1:11434" }).spec.kind, "llm-extract");
  assert.equal(appTaggerSpec({ provider: "ollama-cloud", ollamaCloudKey: "k", canReachOllamaCloud: false }).spec.kind, "keyphrase-idf");
});
