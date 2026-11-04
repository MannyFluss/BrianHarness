/** Node loader for the vendored o200k_base rank file (sha256-checked). Not browser-safe; iOS ships the same file as an asset. */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BpeTokenizer, O200K_RANKS_SHA256 } from "./tokenizer.js";

export const O200K_VENDOR_PATH = fileURLToPath(new URL("../../vendor/o200k_base.tiktoken.gz", import.meta.url));
let cached: BpeTokenizer | null = null;
export function loadO200k(): BpeTokenizer {
  if (cached) return cached;
  const raw = gunzipSync(readFileSync(O200K_VENDOR_PATH));
  const sha = createHash("sha256").update(raw).digest("hex");
  if (sha !== O200K_RANKS_SHA256) throw new Error(`o200k_base rank file sha256 mismatch (${sha.slice(0, 12)})`);
  cached = new BpeTokenizer(raw.toString("latin1"));
  return cached;
}
