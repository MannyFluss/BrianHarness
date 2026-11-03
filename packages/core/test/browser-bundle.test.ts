// Core must run in a plain browser / WKWebView: bundle the browser entry for platform=browser
// (any Node built-in fails the build), then execute it in a bare VM with no process/require/Buffer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const entry = fileURLToPath(new URL("../src/browser.ts", import.meta.url));
const NODE_BUILTINS = /^(node:)?(fs|path|os|child_process|crypto|http|https|net|tls|stream|zlib|events|util|url|buffer|process|readline|worker_threads)(\/|$)/;

async function bundle() {
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "BH",
    target: ["safari15"],
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [{ name: "no-node", setup(b) { b.onResolve({ filter: NODE_BUILTINS }, (a) => ({ errors: [{ text: `Node built-in "${a.path}" imported by ${a.importer}` }] })); } }],
  });
  return { code: r.outputFiles[0]!.text, inputs: Object.keys(r.metafile!.inputs) };
}

test("browser entry bundles for platform=browser with no Node built-ins or heavy SDKs", async () => {
  const { code, inputs } = await bundle();
  assert.ok(!inputs.some((i) => /node_modules/.test(i)), `browser core should have no runtime deps, got: ${inputs.filter((i) => /node_modules/.test(i)).join(", ")}`);
  assert.ok(!/\brequire\(/.test(code), "no require()");
  assert.ok(!code.includes("process.env"), "no bare process.env (use defaultEnv())");
  for (const banned of ["crypto.subtle", "randomUUID", "child_process", "safeStorage"]) assert.ok(!code.includes(banned), `bundle mentions ${banned}`);
  // ~320 KB of it is the bundled CC0 word-frequency table (wordfreq/cv-en.ts) that keyphrase-idf needs in the app
  assert.ok(code.length < 600_000, `browser core bundle unexpectedly large: ${code.length}`);
});

test("browser bundle runs a full mock session in a bare VM (no process/require/Buffer)", async () => {
  const { code } = await bundle();
  const ls = new Map<string, string>();
  const localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, String(v)), removeItem: (k: string) => void ls.delete(k), key: (i: number) => [...ls.keys()][i] ?? null, get length() { return ls.size; } };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, AbortController, AbortSignal, localStorage, structuredClone });
  vm.runInContext(code + "\nglobalThis.BH = BH;", ctx);
  assert.equal(vm.runInContext("typeof process + typeof require + typeof Buffer", ctx), "undefinedundefinedundefined");
  const out = await vm.runInContext(`(async () => {
    const kv = new BH.LocalStorageKV("bh/");
    const storage = await BH.KVHarnessStorage.open(kv);
    const creds = new BH.KVCredentialStore(kv);
    await creds.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));
    let t = 1000;
    // a study controller that cannot say why it assigned nothing -> Director profile (plain chat learns nothing)
    const host = new BH.HarnessHost({ userId: "u", storage, backend: async () => BH.createBrowserBackend({ provider: "mock", seed: 3 }), clock: () => t, seed: () => 7, study: { assign: async () => null } });
    const first = await host.newSession();
    for (const text of ["I love the night sky, telescopes and nebulae", "ok", "astronomy clubs and star parties are the best"]) {
      t += 5000;
      const ev = Array.from({ length: text.length }, (_, i) => ({ t: t - 4000 + i * 50, kind: "insert", len: i + 1, source: "soft-keyboard" }));
      await host.reply({ text, events: ev, sentAt: t, shownAt: t - 4500 });
    }
    await host.end();
    const reopened = await BH.KVHarnessStorage.open(kv);
    return { first: first.director.text, top: host.hud().topTopics.map((x) => x[0]), sessions: host.sessions().length, events: reopened.readSession(first.sessionId).length, saved: reopened.loadMap("u").data.turns, key: await BH.readApiKey(creds, "openai"), env: Object.keys(BH.defaultEnv()).length, spec: BH.backendSpecFromEnv().provider };
  })()`, ctx);
  assert.ok(out.first.length > 5);
  assert.ok(out.top.includes("space"), JSON.stringify(out.top));
  assert.equal(out.sessions, 1);
  assert.ok(out.events >= 8, `logged ${out.events} events`);
  assert.equal(out.saved, 3);
  assert.equal(out.key, "sk-test");
  assert.equal(out.env, 0);
  assert.equal(out.spec, "mock");
});

test("AnthropicFetchBackend sends the direct-browser-access header; browser factory refuses keyless paid providers", async () => {
  const { AnthropicFetchBackend, createBrowserBackend, planTurn, InterestMap, makeRng } = await import("../src/browser.js");
  let seen: { url: string; headers: Record<string, string>; body: { system: string; messages: unknown[] } } | null = null;
  const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Hi! What pulls you in lately?" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const b = new AnthropicFetchBackend({ apiKey: "sk-ant-test", model: "claude-x", fetchImpl: fakeFetch });
  const plan = planTurn(0, InterestMap.fresh("u"), null, [], makeRng(1));
  const r = await b.generate({ messages: [{ role: "system", content: "SYS" }, { role: "system", content: "NOTE" }], plan, stateNote: "NOTE" });
  assert.equal(r.text, "Hi! What pulls you in lately?");
  assert.equal(seen!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen!.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(seen!.headers["x-api-key"], "sk-ant-test");
  assert.equal(seen!.body.system, "SYS");
  assert.equal(b.paid, true);
  assert.throws(() => createBrowserBackend({ provider: "anthropic" }), /API key/);
  assert.throws(() => createBrowserBackend({ provider: "openai" }), /API key/);
  assert.throws(() => createBrowserBackend({ provider: "claude-code" }), /not available in the browser/);
  assert.equal(createBrowserBackend({ provider: "mock" }).paid, false);
  assert.equal(createBrowserBackend({ provider: "ollama", baseUrl: "http://192.168.1.20:11434", model: "gemma3:4b" }).paid, false);
});

test("input-source features are additive (absent without sources, present with them)", async () => {
  const { summarizeTyping } = await import("../src/signals.ts");
  const base = [{ t: 1000, kind: "insert" as const, len: 1 }, { t: 1100, kind: "insert" as const, len: 2 }];
  const plain = summarizeTyping(base, { from: 900, to: 1200 });
  assert.ok(!Object.keys(plain).some((k) => k.startsWith("typing.src.")));
  const tagged = summarizeTyping([{ ...base[0]!, source: "soft-keyboard" as const }, { ...base[1]!, len: 7, source: "autocorrect" as const, chars: 5 }], { from: 900, to: 1200 });
  for (const k of Object.keys(plain)) assert.ok(k in tagged, k);
  assert.equal(tagged["typing.src.autocorrect"], 1);
  assert.equal(tagged["typing.src.soft"], 0.5);
  assert.ok(Math.abs(tagged["typing.src.timedShare"]! - 1 / 6) < 1e-9);
});
