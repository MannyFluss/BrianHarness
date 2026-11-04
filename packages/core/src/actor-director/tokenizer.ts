/**
 * E4: o200k_base token counting in pure TypeScript (no network, no WASM). A port of tiktoken's encode_ordinary:
 * the o200k pre-tokenizer regex (tiktoken's (?i:...) contraction group spelled out for JS), then byte-pair merges
 * by rank. Browser-safe: construct from the rank file text; tokenizer-node.ts loads the vendored gzip.
 * Parity with python tiktoken 0.14.0 is pinned by test/fixtures/o200k-parity.json.
 */
const C = "(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])";
export const O200K_PAT = new RegExp(
  [
    `[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+${C}?`,
    `[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*${C}?`,
    `\\p{N}{1,3}`,
    ` ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*`,
    `\\s*[\\r\\n]+`,
    `\\s+(?!\\S)`,
    `\\s+`,
  ].join("|"),
  "gu",
);
export const O200K_RANKS_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";
export const O200K_RANK_COUNT = 199998;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64I = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;
/** base64 -> "binary string" (one char per byte), the Map key form */
function b64ToBin(s: string): string {
  let out = "", bits = 0, acc = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64I[s.charCodeAt(i)]!;
    if (v < 0) continue; // '='
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
  }
  return out;
}

export interface TokenCounter { readonly name: string; count(text: string): number }

export class BpeTokenizer implements TokenCounter {
  readonly name = "o200k_base";
  private ranks = new Map<string, number>();
  private cache = new Map<string, number>();
  constructor(rankFileText: string) {
    let start = 0;
    while (start < rankFileText.length) {
      let end = rankFileText.indexOf("\n", start);
      if (end < 0) end = rankFileText.length;
      const sp = rankFileText.indexOf(" ", start);
      if (sp > start && sp < end) this.ranks.set(b64ToBin(rankFileText.slice(start, sp)), Number(rankFileText.slice(sp + 1, end)));
      start = end + 1;
    }
    if (this.ranks.size !== O200K_RANK_COUNT) throw new Error(`o200k_base: expected ${O200K_RANK_COUNT} ranks, got ${this.ranks.size}`);
  }
  get size() { return this.ranks.size; }
  /** token ids of one pre-token (UTF-8 bytes as a binary string) */
  private bpe(piece: string): number[] {
    const direct = this.ranks.get(piece);
    if (direct !== undefined) return [direct];
    // tiktoken byte_pair_merge: boundaries + rank of each adjacent pair, merge the lowest rank first
    const bounds: number[] = [];
    for (let i = 0; i <= piece.length; i++) bounds.push(i);
    const rankAt = (i: number) => (i + 2 < bounds.length ? this.ranks.get(piece.slice(bounds[i]!, bounds[i + 2]!)) ?? Infinity : Infinity);
    const r: number[] = [];
    for (let i = 0; i < bounds.length - 1; i++) r.push(rankAt(i));
    for (;;) {
      let min = Infinity, at = -1;
      for (let i = 0; i < r.length - 1; i++) if (r[i]! < min) { min = r[i]!; at = i; }
      if (at < 0) break;
      bounds.splice(at + 1, 1); r.splice(at + 1, 1);
      r[at] = rankAt(at);
      if (at > 0) r[at - 1] = rankAt(at - 1);
    }
    const out: number[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const id = this.ranks.get(piece.slice(bounds[i]!, bounds[i + 1]!));
      if (id === undefined) throw new Error("o200k_base: byte without a rank");
      out.push(id);
    }
    return out;
  }
  encode(text: string): number[] {
    const out: number[] = [];
    for (const m of text.matchAll(O200K_PAT)) {
      const bin = utf8Bin(m[0]);
      for (const id of this.bpe(bin)) out.push(id);
    }
    return out;
  }
  count(text: string): number {
    let n = 0;
    for (const m of text.matchAll(O200K_PAT)) {
      const p = m[0];
      let c = this.cache.get(p);
      if (c === undefined) { c = this.bpe(utf8Bin(p)).length; if (this.cache.size < 50000) this.cache.set(p, c); }
      n += c;
    }
    return n;
  }
}

const enc = new TextEncoder();
function utf8Bin(s: string): string {
  const b = enc.encode(s);
  let out = "";
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]!);
  return out;
}
