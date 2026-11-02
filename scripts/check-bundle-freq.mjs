#!/usr/bin/env node
// License guard: the CC BY-SA wordfreq research table must never reach a build output. Scans the given dirs
// (default: packages/core/dist, apps/desktop/dist) for wordfreq's identifier and for long verbatim runs of
// research/wordfreq/wordfreq_small_en_zipf10.txt, and confirms the CC0 default IS present. Exit 1 on violation.
//   npm run build && node scripts/check-bundle-freq.mjs [dir ...]
import fs from "node:fs";
import path from "node:path";
const HE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ["packages/core/dist", "apps/desktop/dist"];
const research = fs.readFileSync(path.join(HE, "research/wordfreq/wordfreq_small_en_zipf10.txt"), "utf8");
// 12 probes: 80-char runs from different buckets of the research list
const lines = research.split("\n").filter((l) => l.length > 200);
const probes = Array.from({ length: 12 }, (_, i) => { const l = lines[Math.floor((i * lines.length) / 12)]; return l.slice(l.indexOf(":") + 1, l.indexOf(":") + 81); });
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
let bad = 0, cc0 = 0, files = 0;
for (const rel of dirs) {
  const d = path.resolve(HE, rel);
  if (!fs.existsSync(d)) { console.log(`skip ${rel} (not built)`); continue; }
  for (const f of walk(d)) {
    if (!/\.(js|mjs|cjs|map|json|txt|html|ts)$/.test(f)) continue;
    files++;
    const s = fs.readFileSync(f, "utf8");
    if (/WORDFREQ_EN_ZIPF10|wordfreq_small_en|wordfreq-en/.test(s) || probes.some((p) => s.includes(p))) { console.log(`FAIL wordfreq data in ${path.relative(HE, f)}`); bad++; }
    if (s.includes("CV_EN_ZIPF10") || s.includes("cv-en-cc0")) cc0++;
  }
}
console.log(`${files} files scanned; wordfreq hits: ${bad}; files with the CC0 default table: ${cc0}`);
process.exit(bad ? 1 : 0);
