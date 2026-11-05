#!/usr/bin/env node
// E7 Mac gaze path: stage the bundled MediaPipe assets into apps/desktop/resources/gaze/ (git-ignored), verified
// against the pins in src/ad/mac/protocol.ts. The Mac build ships this folder as extraResources (Resources/gaze);
// the app never fetches a model or wasm at runtime.
//   node scripts/ad-gaze-assets.mjs --model /path/face_landmarker.task     (verify + copy)
//   node scripts/ad-gaze-assets.mjs --download                             (dev box only: fetch the pinned model)
//   node scripts/ad-gaze-assets.mjs --check                                (verify an existing folder, exit 1 if not)
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "resources", "gaze");
const proto = readFileSync(join(here, "..", "src", "ad", "mac", "protocol.ts"), "utf8");
const pin = (k) => proto.match(new RegExp(`${k}: "([^"]+)"`))[1];
const MODEL = { file: pin("file"), sha256: pin("sha256"), bytes: Number(proto.match(/bytes: (\d+)/)[1]) };
const WASM = { loader: pin("loader"), binary: pin("binary"), version: pin("version") };
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

// the package's exports map hides package.json: resolve the entry and walk up to the package root
const require = createRequire(import.meta.url);
let pkgDir = dirname(require.resolve("@mediapipe/tasks-vision"));
while (!existsSync(join(pkgDir, "package.json"))) pkgDir = dirname(pkgDir);
const pkgVersion = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;

function manifest() {
  const files = [MODEL.file, WASM.loader, WASM.binary].map((name) => { const b = readFileSync(join(OUT, name)); return { name, bytes: b.length, sha256: sha(b) }; });
  return { schema: "bh-gaze-bundle/1", tasksVision: WASM.version, files };
}
function check() {
  const errs = [];
  for (const f of [MODEL.file, WASM.loader, WASM.binary]) if (!existsSync(join(OUT, f))) errs.push(`missing ${f}`);
  if (!errs.length) {
    const m = readFileSync(join(OUT, MODEL.file));
    if (sha(m) !== MODEL.sha256) errs.push(`model sha256 ${sha(m)} != pin ${MODEL.sha256}`);
    for (const f of [WASM.loader, WASM.binary]) if (sha(readFileSync(join(OUT, f))) !== sha(readFileSync(join(pkgDir, "wasm", f)))) errs.push(`${f} differs from @mediapipe/tasks-vision ${pkgVersion}`);
  }
  return errs;
}

if (pkgVersion !== WASM.version) { console.error(`@mediapipe/tasks-vision is ${pkgVersion}, pinned ${WASM.version}`); process.exit(1); }
if (args.includes("--check")) {
  const e = check();
  if (e.length) { console.error(e.join("\n")); process.exit(1); }
  console.log(JSON.stringify(manifest(), null, 1));
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
let model;
if (arg("--model")) model = readFileSync(arg("--model"));
else if (args.includes("--download")) model = Buffer.from(await (await fetch(MODEL_URL)).arrayBuffer());
else if (existsSync(join(OUT, MODEL.file))) model = readFileSync(join(OUT, MODEL.file));
else { console.error("no model: pass --model <face_landmarker.task> or --download"); process.exit(1); }
if (sha(model) !== MODEL.sha256 || model.length !== MODEL.bytes) { console.error(`model sha256 ${sha(model)} (${model.length} B) != pin ${MODEL.sha256} (${MODEL.bytes} B)`); process.exit(1); }
writeFileSync(join(OUT, MODEL.file), model);
for (const f of [WASM.loader, WASM.binary]) copyFileSync(join(pkgDir, "wasm", f), join(OUT, f));
const m = manifest();
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(m, null, 1) + "\n");
console.log(`staged ${OUT}\n` + m.files.map((f) => `  ${f.name}  ${f.bytes} B  ${f.sha256}`).join("\n"));
