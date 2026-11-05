// Leak-judge FREEZE RUN CLI (Researcher ruling A4). One commit, one prompt id, one judge model, temperature 0.
//   npx tsx scripts/ad-leak-freeze.ts --in inputs.jsonl --out preds.jsonl --checkpoint DIR --commit <sha> \
//       --prompt-id <lj id> --judge-model <model> [--actor-model <model>] [--max-calls 95] [--judge mock|worker]
//       [--uncertain positive|negative] [--retries 1]
// Resumable: rerun the SAME command (e.g. the next day); it continues from DIR and refuses if the commit, the prompt id,
// the judge model, the temperature, the policy or the inputs differ. --max-calls is a hard per-run cap on requests
// (retries included). preds.jsonl ({id, codes, answer_first} per line) and preds.meta.json are written ONLY when every
// item is done. Exit 0 = complete, 3 = paused (run again), 2 = refused.
// --judge worker: the Worker's judge route; REFUSED unless --approved-token-use AND BH_WORKER_URL + BH_JUDGE_TOKEN are
//   set. The token is read from the environment only and never printed or written.
// The predictor files at HEAD and in the working tree must be byte-identical to --commit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { LEAK_JUDGE_MODEL, LEAK_JUDGE_PROMPT_ID, MockJudgeBackend } from "../packages/core/src/actor-director/leak-judge.ts";
import { FreezeRefused, runFreeze } from "../packages/core/src/actor-director/leak-freeze.ts";
import { ACTOR_MODEL } from "../packages/core/src/actor-director/session.ts";
import { WorkerChatBackend } from "../packages/core/src/actor-director/director.ts";
import type { AdChatBackend } from "../packages/core/src/actor-director/director.ts";
import type { PredictInput, UncertainPolicy } from "../packages/core/src/actor-director/leak-predict.ts";

const PREDICTOR_PATHS = ["packages/core/src/actor-director", "packages/core/src/ad-contracts", "scripts/ad-leak-freeze.ts"];
const a = process.argv.slice(2);
const opt = (k: string, d?: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const die = (m: string, code = 2): never => { console.error("ad-leak-freeze: " + m); process.exit(code); };
const inPath = opt("--in") ?? die("--in required"), outPath = opt("--out") ?? die("--out required");
const ckpt = opt("--checkpoint") ?? die("--checkpoint DIR required"), commit = opt("--commit") ?? die("--commit required");
const promptId = opt("--prompt-id") ?? die(`--prompt-id required (this code is ${LEAK_JUDGE_PROMPT_ID})`);
const judgeModel = opt("--judge-model") ?? die(`--judge-model required (suggested ${LEAK_JUDGE_MODEL})`);
const actorModel = opt("--actor-model", ACTOR_MODEL)!;
const maxCalls = Number(opt("--max-calls", "95")), retries = Number(opt("--retries", "1"));
const judge = opt("--judge", "mock")!, policy = opt("--uncertain", "positive") as UncertainPolicy;
if (!["positive", "negative"].includes(policy)) die("--uncertain must be positive|negative");
if (!Number.isInteger(maxCalls) || maxCalls < 1) die("--max-calls must be a positive integer");
if (!Number.isInteger(retries) || retries < 0 || retries > 1) die("--retries must be 0 or 1");
if (promptId !== LEAK_JUDGE_PROMPT_ID) die(`--prompt-id ${promptId} != this code's ${LEAK_JUDGE_PROMPT_ID}`);
const root = new URL("..", import.meta.url).pathname;
const git = (...x: string[]) => execFileSync("git", x, { cwd: root, encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
let frozen = "";
try { frozen = commit.length >= 7 ? git("rev-parse", "--verify", "--quiet", commit + "^{commit}") : ""; } catch { frozen = ""; }
if (!frozen) die(`--commit ${commit} is not a commit in this repo`);
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

const inputsText = readFileSync(inPath, "utf8");
const items = inputsText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as PredictInput);
try {
  const r = await runFreeze({ items, inputsText, backend: backend!, checkpointDir: ckpt, outPath, maxCalls, retries, deadlineMs: judge === "mock" ? 60_000 : 90_000,
    config: { commit: frozen, leak_judge_prompt_id: promptId, judge_model: judgeModel, actor_model: actorModel, temperature: 0, uncertain_policy: policy, backend: judge },
    log: (s) => console.log(s) });
  const u = r.usage;
  // usage only: model tags, request counts, token sums, non-secret rate headers. Never the token.
  console.log(`run: ${r.callsThisRun} requests (cap ${maxCalls}; ok ${u.ok}, errors ${u.errors}); models ${JSON.stringify(u.models)}; tokens prompt ${u.prompt_tokens} completion ${u.completion_tokens} reasoning ${u.reasoning_tokens}; headers ${JSON.stringify(u.headers)}`);
  console.log(`progress: ${r.doneTotal}/${r.total} items; ${LEAK_JUDGE_PROMPT_ID}; judge ${judgeModel} (actor ${actorModel}); commit ${frozen.slice(0, 12)}; temperature 0`);
  if (r.uncertain) console.log(`uncertain per code: ${JSON.stringify(r.uncertain.byCode)}; answer_first uncertain ${r.uncertain.answer_first}/${r.uncertain.items}`);
  process.exit(r.status === "complete" ? 0 : 3);
} catch (e) {
  if (e instanceof FreezeRefused || (e instanceof Error && /judge model/i.test(e.message))) die(e.message);
  throw e;
}
