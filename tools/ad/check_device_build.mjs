#!/usr/bin/env node
// contract-v1.3 (ruling B2): a DEVICE web bundle (vite build --config vite.ad.config.ts, no AD_SIM_BUILD) must have no
// path to a native gaze plugin's lookAt. Scans every .js file under <dir> for a lookAt call or a computed "lookAt"
// access, and for the sim-only module marker. Exit 0 = clean, 1 = found, 2 = usage.
//   node tools/ad/check_device_build.mjs apps/desktop/dist-ad          # device build: must be clean
//   node tools/ad/check_device_build.mjs <dir> --expect-sim             # a simulator build: must contain the aid (self-check)
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const [dir, flag] = process.argv.slice(2);
if (!dir || !existsSync(dir)) { console.error("usage: check_device_build.mjs <bundle dir> [--expect-sim]"); process.exit(2); }
const PATTERNS = [
  ["lookAt call", /\.lookAt\s*(?:\?\.)?\s*\(/g],
  ["computed lookAt", /\[\s*["'`]lookAt["'`]\s*\]/g],
  ["unreplaced __BH_AD_SIM__", /__BH_AD_SIM__/g],
];
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.(m?js)$/.test(n)) files.push(f); } };
walk(dir);
let hits = 0;
for (const f of files) {
  const s = readFileSync(f, "utf8");
  for (const [what, re] of PATTERNS) for (const m of s.matchAll(re)) { hits++; console.log(`${flag === "--expect-sim" ? "SIM" : "DEVICE-LEAK"} ${f}:${m.index}: ${what}: ...${s.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, " ")}...`); }
}
if (flag === "--expect-sim") {
  const calls = hits;
  console.log(calls ? `ok: simulator bundle has the lookAt aid (${calls} site(s), ${files.length} js files)` : "FAIL: simulator bundle has no lookAt aid (the scan would miss it)");
  process.exit(calls ? 0 : 1);
}
console.log(hits ? `FAIL: ${hits} lookAt site(s) in a device bundle (${files.length} js files)` : `ok: no lookAt path in the device bundle (${files.length} js files)`);
process.exit(hits ? 1 : 0);
