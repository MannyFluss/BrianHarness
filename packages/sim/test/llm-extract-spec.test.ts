import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { llmExtractSpec } from "../src/sidecar.ts";

test("llmExtractSpec: offline unless allowed + keyed; persisted call cap; responses file is a read-only cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmx-"));
  const resp = path.join(dir, "responses.jsonl");
  fs.writeFileSync(resp, JSON.stringify({ key: "abc", raw: "{}", ok: true }) + "\n" + JSON.stringify({ key: "bad", raw: "x", ok: false }) + "\n");
  const off = llmExtractSpec({ responsesFile: resp, apiKey: "k" }, false);
  assert.equal(off.offline, true);
  assert.equal(await off.cache!.get("abc"), "{}");
  assert.equal(await off.cache!.get("bad"), undefined);
  assert.equal(llmExtractSpec({ apiKey: undefined }, true).offline, process.env.OLLAMA_API_KEY ? false : true);
  const cacheDir = path.join(dir, "cache");
  const on = llmExtractSpec({ apiKey: "k", cacheDir, maxCalls: 2 }, true);
  assert.equal(on.offline, false);
  assert.equal(on.reserveCall!(), true);
  assert.equal(on.reserveCall!(), true);
  assert.equal(on.reserveCall!(), false);
  // the counter persists across instances (across runs)
  const again = llmExtractSpec({ apiKey: "k", cacheDir, maxCalls: 2 }, true);
  assert.equal(again.reserveCall!(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, "calls.json"), "utf8")).calls, 2);
});

test("llmExtractSpec: concurrent reservations on one cacheDir are counted exactly (atomic counter); local URL keyless", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmx-c-"));
  // three cases sharing one cacheDir, each making several calls in parallel (the sim's parallel runner)
  const specs = [0, 1, 2].map(() => llmExtractSpec({ apiKey: "k", cacheDir, maxCalls: 100 }, true));
  const res = await Promise.all(specs.flatMap((s) => Array.from({ length: 7 }, async () => { await new Promise((r) => setTimeout(r, Math.random() * 5)); return s.reserveCall!(); })));
  assert.equal(res.filter(Boolean).length, 21);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, "calls.json"), "utf8")).calls, 21);
  // cap across instances: 21 used of 23 -> exactly 2 more, whoever asks
  const a = llmExtractSpec({ apiKey: "k", cacheDir, maxCalls: 23 }, true), b = llmExtractSpec({ apiKey: "k", cacheDir, maxCalls: 23 }, true);
  assert.deepEqual([a.reserveCall!(), b.reserveCall!(), a.reserveCall!(), b.reserveCall!()], [true, true, false, false]);
  // separate processes too
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "llmx-p-"));
  const url = new URL("../src/sidecar.ts", import.meta.url).href;
  const script = `const { llmExtractSpec } = await import(${JSON.stringify(url)}); const s = llmExtractSpec({ apiKey: "k", cacheDir: ${JSON.stringify(dir2)}, maxCalls: 1000 }, true); for (let i = 0; i < 25; i++) s.reserveCall();`;
  const { spawn } = await import("node:child_process");
  await Promise.all([0, 1, 2, 3].map(() => new Promise<void>((ok, bad) => {
    const p = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", script], { stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? ok() : bad(new Error("child " + c))));
  })));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir2, "calls.json"), "utf8")).calls, 100);
  // a local Ollama app needs no key: online when network is allowed, and no key is passed on
  const loc = llmExtractSpec({ baseUrl: "http://127.0.0.1:11434", apiKey: "k" }, true);
  assert.equal(loc.offline, false); assert.equal(loc.apiKey, undefined);
  assert.equal(llmExtractSpec({ baseUrl: "http://127.0.0.1:11434" }, false).offline, true);
});
