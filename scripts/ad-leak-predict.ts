// Frozen-predictor CLI (leak-judge set). Writes R4c-style predictions JSONL at a given commit.
//   npx tsx scripts/ad-leak-predict.ts --in inputs.jsonl --out preds.jsonl --commit <sha> [--judge mock|worker] [--uncertain positive|negative]
// --judge mock (default): deterministic, no network: regex layer + MockJudgeBackend on the judge route.
// --judge worker: a live judge model behind the Worker's judge route (X-BH-Role: judge, model gemma4:cloud). REFUSED
//   unless BH_JUDGE_TOKEN and BH_WORKER_URL are set AND --approved-token-use is passed (needs DirectorBot/Manny approval).
//   The token is read from the environment only and never printed.
// Refuses to run unless the predictor files at HEAD (and in the working tree) are byte-identical to --commit, so the
// predictions come from the frozen code. Later commits that don't touch the predictor files are fine.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { LEAK_JUDGE_DEADLINE_MS, LEAK_JUDGE_MODEL, LEAK_JUDGE_PROMPT_ID, LeakGate, MockJudgeBackend } from "../packages/core/src/actor-director/leak-judge.ts";
import { predictAll, type PredictInput, type UncertainPolicy } from "../packages/core/src/actor-director/leak-predict.ts";
import { WorkerChatBackend } from "../packages/core/src/actor-director/director.ts";
import type { AdChatBackend } from "../packages/core/src/actor-director/director.ts";

const PREDICTOR_PATHS = ["packages/core/src/actor-director", "packages/core/src/ad-contracts", "scripts/ad-leak-predict.ts"];
import { ACTOR_MODEL } from "../packages/core/src/actor-director/session.ts";
const a = process.argv.slice(2);
const opt = (k: string, d?: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const die = (m: string, code = 2): never => { console.error("ad-leak-predict: " + m); process.exit(code); };
const inPath = opt("--in") ?? die("--in required"), outPath = opt("--out") ?? die("--out required"), commit = opt("--commit") ?? die("--commit required");
const judge = opt("--judge", "mock")!, policy = opt("--uncertain", "positive") as UncertainPolicy;
if (!["positive", "negative"].includes(policy)) die("--uncertain must be positive|negative");
const root = new URL("..", import.meta.url).pathname;
const git = (...x: string[]) => execFileSync("git", x, { cwd: root, encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
let frozen = "";
try { frozen = commit.length >= 7 ? git("rev-parse", "--verify", "--quiet", commit + "^{commit}") : ""; } catch { frozen = ""; }
if (!frozen) die(`--commit ${commit} is not a commit in this repo`);
// HEAD may be later than the frozen commit only if every predictor file is byte-identical to it
const changed = frozen === head ? "" : git("diff", "--name-only", frozen, head, "--", ...PREDICTOR_PATHS);
if (changed) die(`HEAD ${head.slice(0, 12)} != --commit ${commit}: predictor files differ:\n${changed}\n(run in a worktree at the frozen commit)`);
const dirty = git("status", "--porcelain", "--", ...PREDICTOR_PATHS);
if (dirty) die("predictor files are not clean at the frozen commit:\n" + dirty);

let backend: AdChatBackend;
if (judge === "mock") backend = new MockJudgeBackend();
else if (judge === "worker") {
  if (!a.includes("--approved-token-use")) die("--judge worker needs --approved-token-use (a live judge run needs token approval)");
  const url = process.env.BH_WORKER_URL, tokenSet = !!process.env.BH_JUDGE_TOKEN;
  if (!url || !tokenSet) die("--judge worker needs BH_WORKER_URL and BH_JUDGE_TOKEN in the environment");
  backend = new WorkerChatBackend({ baseUrl: url!, token: () => process.env.BH_JUDGE_TOKEN ?? null });
} else die("--judge must be mock|worker");

const inputText = readFileSync(inPath, "utf8");
const items = inputText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as PredictInput);
const gate = new LeakGate({ backend: backend!, model: LEAK_JUDGE_MODEL, actorModel: ACTOR_MODEL, deadlineMs: judge === "mock" ? 60_000 : LEAK_JUDGE_DEADLINE_MS * 4 });
const preds = await predictAll(items, gate, policy);
const out = preds.map((p) => JSON.stringify(p)).join("\n") + "\n";
writeFileSync(outPath, out);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const meta = { commit: frozen, head, leak_judge_prompt_id: LEAK_JUDGE_PROMPT_ID, judge, judge_model: LEAK_JUDGE_MODEL, uncertain_policy: policy, n: preds.length,
  inputs_sha256: sha(inputText), predictions_sha256: sha(out), answer_first_field: "answer_first = answer-first VIOLATION (same as answer_first_violation)", written_at: new Date().toISOString() };
writeFileSync(outPath.replace(/\.jsonl$/, "") + ".meta.json", JSON.stringify(meta, null, 2) + "\n");
const st = preds.reduce<Record<string, number>>((m, p) => ((m[p.verdict] = (m[p.verdict] ?? 0) + 1), m), {});
console.log(`wrote ${preds.length} predictions -> ${outPath} (frozen ${frozen.slice(0, 12)}, HEAD ${head.slice(0, 12)}, ${LEAK_JUDGE_PROMPT_ID}, judge=${judge}, uncertain=${policy}) verdicts ${JSON.stringify(st)}`);
