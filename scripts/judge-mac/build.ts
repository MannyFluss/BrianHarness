// Builds the self-contained Mac judge runner: ONE runner.mjs (esbuild, node18 target, no deps) + MANIFEST.json +
// RUN_ON_MAC.md, packed as brianharness-judge-runner.tar.gz with SHA256SUMS.
//   npx tsx scripts/judge-mac/build.ts [--out DIR] [--no-tar] [--allow-dirty]
// Every judging module is resolved from the PINNED worktree at 3b425dd (detached, clean), never from this branch; the
// manifest records, per bundled frozen file, its sha256 on disk and of `git show 3b425dd:<path>` (they must be equal).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { build, type Plugin } from "esbuild";

export const FROZEN_COMMIT = "3b425dda90116f5cda7e0ca0d5f99625688888b5";
export const NODE_MIN = "18.17.0";
const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const PIN = resolve(process.env.BH_FREEZE_WT ?? join(ROOT, "../wt-freeze-3b425dd"));
const VERIFY_DIR = resolve(process.env.BH_R4_LIVE_DIR ?? join(ROOT, "../research-runs/r4-live-check"));
const R4_LABELS = resolve(process.env.BH_R4_LABELS ?? join(ROOT, "../research/R4/labels.jsonl"));
const a = process.argv.slice(2);
const opt = (k: string, d?: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const git = (cwd: string, ...x: string[]) => execFileSync("git", x, { cwd, encoding: "utf8" }).trim();
const die = (m: string): never => { console.error("judge-mac build: " + m); process.exit(2); };

export async function buildBundle(outRoot: string, o: { tar: boolean; allowDirty: boolean }) {
  // 1. the pinned worktree: detached at the frozen commit, nothing tracked modified (node_modules is an untracked symlink)
  const pinHead = git(PIN, "rev-parse", "HEAD");
  if (pinHead !== FROZEN_COMMIT) die(`pinned worktree ${PIN} is at ${pinHead}, not ${FROZEN_COMMIT}`);
  const pinDirty = git(PIN, "status", "--porcelain").split("\n").filter((l) => l.trim() && l.trim() !== "?? node_modules");
  if (pinDirty.length) die(`pinned worktree is not clean:\n${pinDirty.join("\n")}`);
  const wrapperHead = git(ROOT, "rev-parse", "HEAD");
  const wrapperDirty = git(ROOT, "status", "--porcelain", "--", "scripts/judge-mac", "docs/AD_JUDGE_MAC_RUNNER.md");
  if (wrapperDirty && !o.allowDirty) die("scripts/judge-mac or the README is uncommitted: commit first (or --allow-dirty for a test build)\n" + wrapperDirty);
  // 2. the verify data: the 30 R4 live-check items (R4 dev+test; NOT R4c) and their gold from R4 labels
  const inputs = readFileSync(join(VERIFY_DIR, "inputs.jsonl"), "utf8");
  const vm = JSON.parse(readFileSync(join(VERIFY_DIR, "manifest.json"), "utf8")) as { inputs_sha256: string };
  if (sha(inputs) !== vm.inputs_sha256) die("r4-live-check inputs.jsonl does not match its manifest sha256");
  const ids = inputs.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id);
  const labels = new Map(readFileSync(R4_LABELS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; split: string; unit: string; context: string; codes: string[]; answer_first_violation: boolean }).map((x) => [x.id, x]));
  const gold = ids.map((id) => {
    const x = labels.get(id) ?? die(`no R4 label for ${id}`);
    if (x.split !== "dev" && x.split !== "test") die(`${id} is not R4 dev/test`);
    return JSON.stringify({ id, codes: x.codes, answer_first_violation: x.answer_first_violation, af_scored: x.unit === "reply" && !!x.context });
  }).join("\n") + "\n";
  const BUILD = { frozen_commit: FROZEN_COMMIT, wrapper_commit: wrapperHead, verify_inputs_sha256: sha(inputs), verify_gold_sha256: sha(gold), node_min: NODE_MIN };
  // 3. esbuild: frozen:* -> the pinned worktree; bundle:data -> the embedded verify data
  const plugin: Plugin = { name: "bh-frozen", setup(b) {
    b.onResolve({ filter: /^frozen:/ }, (r) => ({ path: join(PIN, "packages/core/src", r.path.slice("frozen:".length) + ".ts") }));
    b.onResolve({ filter: /^bundle:data$/ }, () => ({ path: "bundle:data", namespace: "bh-data" }));
    b.onLoad({ filter: /.*/, namespace: "bh-data" }, () => ({ loader: "js", contents:
      `export const VERIFY_INPUTS = ${JSON.stringify(inputs)};\nexport const VERIFY_GOLD = ${JSON.stringify(gold)};\nexport const BUILD = ${JSON.stringify(BUILD)};\n` }));
  } };
  const dir = join(outRoot, "brianharness-judge-runner");
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const runner = join(dir, "runner.mjs");
  const res = await build({ entryPoints: [join(ROOT, "scripts/judge-mac/runner.ts")], outfile: runner, bundle: true, platform: "node", format: "esm", target: "node18",
    metafile: true, legalComments: "none", plugins: [plugin], logLevel: "warning", absWorkingDir: ROOT,
    banner: { js: `// BrianHarness leak-judge Mac runner. Frozen judging code from ${FROZEN_COMMIT} (see MANIFEST.json). Run: node runner.mjs verify. Node >= ${NODE_MIN}.` } });
  // 4. the manifest: every bundled input; frozen ones checked against git show <frozen>:<path>
  const frozen: Array<{ path: string; sha256: string; sha256_at_frozen_commit: string; git_blob: string; bytes_in_bundle: number }> = [];
  const other: Array<{ path: string; sha256: string | null; bytes_in_bundle: number }> = [];
  const outMeta = Object.values(res.metafile.outputs)[0]!.inputs;
  for (const [p, m] of Object.entries(res.metafile.inputs)) {
    const used = outMeta[p]?.bytesInOutput ?? 0;
    if (p.startsWith("bh-data:")) { other.push({ path: "bundle:data (embedded verify inputs + gold + build info)", sha256: null, bytes_in_bundle: used }); continue; }
    const abs = resolve(ROOT, p);
    const rel = relative(PIN, abs);
    if (!rel.startsWith("..")) {
      const disk = readFileSync(abs);
      const atCommit = execFileSync("git", ["show", `${FROZEN_COMMIT}:${rel}`], { cwd: PIN });
      const blob = git(PIN, "rev-parse", `${FROZEN_COMMIT}:${rel}`);
      if (sha(disk) !== sha(atCommit)) die(`${rel} differs from ${FROZEN_COMMIT}`);
      frozen.push({ path: rel, sha256: sha(disk), sha256_at_frozen_commit: sha(atCommit), git_blob: blob, bytes_in_bundle: used });
    } else other.push({ path: relative(ROOT, abs), sha256: sha(readFileSync(abs)), bytes_in_bundle: used });
    void m;
  }
  frozen.sort((x, y) => x.path.localeCompare(y.path));
  if (other.some((x) => x.path.includes("node_modules"))) die("a node_modules package got bundled: the runner must be the frozen code + the wrapper only");
  const required = ["leak-judge", "leaks", "leak-predict", "leak-freeze", "director"].map((n) => `packages/core/src/actor-director/${n}.ts`);
  for (const r of required) if (!frozen.some((f) => f.path === r)) die(`${r} is not in the bundle`);
  const runnerSha = sha(readFileSync(runner));
  const manifest = { schema: "bh-judge-mac-manifest/1", built_at: new Date().toISOString(), frozen_commit: FROZEN_COMMIT, frozen_worktree_clean: true,
    wrapper_commit: wrapperHead, wrapper_dirty: !!wrapperDirty, node_min: NODE_MIN, esbuild: (await import("esbuild")).version, target: "node18", format: "esm",
    runner_mjs: "runner.mjs", runner_mjs_sha256: runnerSha, runner_mjs_bytes: readFileSync(runner).length,
    judge_model: "gemma4:cloud", model_tags_accepted: "^gemma4(:[a-z0-9._-]+)?$ (gemma4:cloud, gemma4:31b)", temperature: 0,
    caps: { verify_requests_ever: 35, requests_per_pacific_day: 95, r4c_runs_per_day: 1 },
    verify_inputs: { source: "research-runs/r4-live-check/inputs.jsonl (30 R4 dev+test items; NOT R4c)", sha256: BUILD.verify_inputs_sha256, gold_sha256: BUILD.verify_gold_sha256 },
    frozen_modules_digest: sha(frozen.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n"), frozen_modules: frozen, wrapper_modules: other };
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  copyFileSync(join(ROOT, "docs/AD_JUDGE_MAC_RUNNER.md"), join(dir, "RUN_ON_MAC.md"));
  let tarSha: string | null = null, tarPath: string | null = null, tarBytes = 0;
  if (o.tar) {
    tarPath = join(outRoot, "brianharness-judge-runner.tar.gz");
    const raw = tarPath.replace(/\.gz$/, "");
    execFileSync("tar", ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=2026-11-04 00:00Z", "-cf", raw, "-C", outRoot, "brianharness-judge-runner"]);
    rmSync(tarPath, { force: true }); execFileSync("gzip", ["-n", "-9", raw]);
    const tb = readFileSync(tarPath); tarSha = sha(tb); tarBytes = tb.length;
    writeFileSync(join(outRoot, "SHA256SUMS"), `${tarSha}  brianharness-judge-runner.tar.gz\n${runnerSha}  brianharness-judge-runner/runner.mjs\n${sha(readFileSync(join(dir, "MANIFEST.json")))}  brianharness-judge-runner/MANIFEST.json\n`);
  }
  return { dir, runner, runnerSha, manifest, tarPath, tarSha, tarBytes };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const out = resolve(opt("--out", join(ROOT, "../release/judge-mac"))!);
  mkdirSync(dirname(out), { recursive: true });
  const r = await buildBundle(out, { tar: !a.includes("--no-tar"), allowDirty: a.includes("--allow-dirty") });
  console.log(`runner.mjs ${r.runnerSha} (${r.manifest.runner_mjs_bytes} B); ${r.manifest.frozen_modules.length} frozen modules @ ${FROZEN_COMMIT.slice(0, 12)} digest ${r.manifest.frozen_modules_digest}`);
  for (const f of r.manifest.frozen_modules) console.log(`  ${f.sha256}  ${f.path}  (blob ${f.git_blob.slice(0, 12)}, ${f.bytes_in_bundle} B used)`);
  for (const f of r.manifest.wrapper_modules) console.log(`  wrapper: ${f.path} ${f.sha256 ?? ""}`);
  if (r.tarPath) console.log(`${r.tarPath} ${r.tarSha} ${r.tarBytes} B`);
}
