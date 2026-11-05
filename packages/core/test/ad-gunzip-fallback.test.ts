// E6 follow-up (iOS minimum NOT raised): the o200k rank asset loads through the pure-JS fflate gunzip when
// DecompressionStream is missing (older WKWebView), with the same sha256 check on the decoded text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { loadO200k, loadO200kBrowser, gunzipAsset } from "../src/actor-director/index.ts";
import * as tb from "../src/actor-director/tokenizer-browser.ts";

const VENDOR_GZ = join(import.meta.dirname, "..", "vendor", "o200k_base.tiktoken.gz");
const FIX = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "o200k-parity.json"), "utf8")) as { cases: Array<{ text: string; count: number }> };
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const fileFetch = async () => ({ ok: true, arrayBuffer: async () => ab(readFileSync(VENDOR_GZ)) });

test("gunzip fallback: no DecompressionStream -> fflate path, sha-checked, counts == node on every fixture", async () => {
  const g = globalThis as { DecompressionStream?: unknown };
  const saved = g.DecompressionStream;
  assert.ok(saved, "Node 24 has DecompressionStream (native path is the default)");
  delete g.DecompressionStream;
  try {
    const br = await loadO200kBrowser({ fetchImpl: fileFetch, baseUrl: "capacitor://localhost/ad.html" });
    assert.equal(tb.lastGunzipPath, "fallback");
    const node = loadO200k();
    for (const c of FIX.cases) assert.equal(br.count(c.text), c.count, c.text.slice(0, 40));
    assert.equal(br.count("hello world"), node.count("hello world"));
    // a wrong payload decoded by the fallback still fails the sha check, naming the path
    const bad = async () => ({ ok: true, arrayBuffer: async () => ab(gzipSync(Buffer.from("x 1\n"))) });
    await assert.rejects(loadO200kBrowser({ fetchImpl: bad, baseUrl: "http://localhost/" }), /sha256 mismatch .*fallback gunzip/);
    // a corrupt gzip is an error, never a tokenizer
    const corrupt = async () => ({ ok: true, arrayBuffer: async () => { const b = Buffer.from(readFileSync(VENDOR_GZ).subarray(0, 5000)); b[4000] ^= 0xff; return ab(b); } });
    await assert.rejects(loadO200kBrowser({ fetchImpl: corrupt, baseUrl: "http://localhost/" }));
  } finally { g.DecompressionStream = saved; }
});

test("gunzip: native and fallback decode the bundled asset to identical text; native is used when present", async () => {
  const buf = ab(readFileSync(VENDOR_GZ));
  const a = await gunzipAsset(buf);
  const b = await gunzipAsset(buf, { force: "fallback" });
  assert.equal(a.path, "native");
  assert.equal(b.path, "fallback");
  assert.equal(a.text.length, b.text.length);
  assert.ok(a.text === b.text);
  await loadO200kBrowser({ fetchImpl: fileFetch, baseUrl: "capacitor://localhost/ad.html" });
  assert.equal(tb.lastGunzipPath, "native");
});
