import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderHub } from "../src/index.js";

const fakeFetch = (async (url: string) => {
  if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "gemma4:cloud" }, { name: "gemma3:4b", details: { parameter_size: "4B" } }] }));
  throw new Error("unexpected " + url);
}) as unknown as typeof fetch;

test("ProviderHub: detects providers, stores API keys 0600 in the data dir, persists the picker choice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bh-hub-"));
  const env = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const hub = new ProviderHub({ dataDir: dir, fetchImpl: fakeFetch, claudeBin: join(dir, "no-claude") });
    let st = await hub.status();
    const by = (id: string) => st.find((p) => p.id === id)!;
    assert.deepEqual(st.map((p) => p.id), ["mock", "ollama", "spider-cloud", "ollama-cloud", "openai", "claude-code", "anthropic"]);
    assert.equal(by("ollama").available, true);
    assert.deepEqual(by("ollama").models.map((m) => [m.id, m.paid]), [["gemma3:4b", false], ["gemma4:cloud", true]]);
    assert.equal(by("claude-code").available, false);
    assert.equal(by("openai").signedIn, false);
    assert.ok(by("anthropic").warning);

    await hub.setApiKey("openai", "  sk-test-123 ");
    assert.equal((statSync(join(dir, "credentials.json")).mode & 0o777), 0o600);
    assert.match(readFileSync(join(dir, "credentials.json"), "utf8"), /sk-test-123/);
    st = await hub.status();
    assert.equal(by("openai").signedIn, true);
    assert.match(by("openai").authSource!, /API key/);
    await hub.logout("openai");
    st = await hub.status();
    assert.equal(by("openai").signedIn, false);

    assert.equal(hub.settings().provider, "mock");
    hub.saveSettings({ provider: "ollama" });
    const again = new ProviderHub({ dataDir: dir, fetchImpl: fakeFetch });
    assert.equal(again.settings().provider, "ollama");
    const b = await again.createBackend();
    assert.equal(b.id, "ollama:gemma3:4b"); // auto-picks the first LOCAL model
    assert.equal(b.paid, false);
    assert.equal((await again.createBackend({ provider: "mock" })).paid, false);
  } finally {
    Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));
  }
});
