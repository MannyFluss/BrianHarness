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
