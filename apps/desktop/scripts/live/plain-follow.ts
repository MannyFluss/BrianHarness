#!/usr/bin/env -S npx tsx
// Plain chat follow-the-user check: four messages in one plain chat (study off) through the NEW head's real request
// builder, on gpt-oss:20b-cloud and gpt-oss:120b-cloud. 4 prompts x 2 models = 8 live requests (openers answered
// locally; budget 12 for empty-completion retries). Prints a transcript and PASS / FAIL per reply (heuristic: the
// reply does what the latest user message asked).
//
//   BH_LIVE_TOKEN=<device token> npx tsx apps/desktop/scripts/live/plain-follow.ts [--out <dir>] [--models a,b]
//   (default out: /workspace/p0-stream/live/plain-follow)
import { followsUser, guardedFetch, outDir, runChat, scanOutputs, sumUsage, upstreamFromEnv, writer, type Exchange } from "./lib.ts";

export const PLAIN_PROMPTS = ["Repeat this phrase I am ai", "what should I focus on?", "explain how a sourdough starter works", "Test"];

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { origin, token, fake } = upstreamFromEnv();
  const dir = outDir("plain-follow", argv);
  const mi = argv.indexOf("--models");
  const models = mi >= 0 ? argv[mi + 1]!.split(",") : ["gpt-oss:20b-cloud", "gpt-oss:120b-cloud"];
  const w = writer(dir);
  const log: Exchange[] = [];
  const g = guardedFetch({ origin, token, maxLive: models.length * 6, stubOpener: true, log });
  const rows: Array<{ model: string; prompt: string; pass: boolean; why: string; finishReason: string | null; shapeOk: boolean }> = [];
  let failed = false;
  w.md("transcript.md", `# Plain chat follow-the-user${fake ? " · FAKE UPSTREAM" : ""} · ${new Date().toISOString()}\n\n`);
  for (const model of models) {
    const start = log.length;
    try { await runChat("plain", model, PLAIN_PROMPTS, g.fetch); } catch (e) { failed = true; w.md("transcript.md", `run error (${model}): ${(e as Error).message}\n`); }
    const mine = log.slice(start).filter((e) => !e.local);
    w.md("transcript.md", `## ${model}\n\n`);
    const ctx: string[] = [];
    for (const prompt of PLAIN_PROMPTS) {
      const ex = mine.filter((e) => e.lastUser === prompt).at(-1);
      const v = ex ? followsUser(prompt, ex.content, ctx) : { pass: false, why: "no request / reply" };
      const shapeOk = !!ex && ex.systemCount === 1 && ex.roles[0] === "system" && ex.roles.at(-1) === "user";
      rows.push({ model, prompt, ...v, finishReason: ex?.finishReason ?? null, shapeOk });
      w.md("transcript.md", `**user:** ${prompt}\n\n**assistant:** ${ex?.content || "(empty)"}\n\n-> ${v.pass ? "PASS" : "FAIL"} (${v.why}; finish ${ex?.finishReason ?? "-"}; usage ${ex ? `${ex.usage.prompt_tokens}/${ex.usage.completion_tokens}` : "-"})\n\n`);
      ctx.push(prompt);
    }
  }
  const usage = sumUsage(log);
  for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.model}  "${r.prompt}"  (${r.why})${r.shapeOk ? "" : "  [request shape!]"}`);
  console.log(`total Ollama usage: ${usage.requests} requests, prompt_tokens ${usage.prompt_tokens}, completion_tokens ${usage.completion_tokens}`);
  w.json("results.json", { fake, results: rows, total_usage: usage });
  const hits = scanOutputs(dir, token);
  if (hits.length) { console.error(`token-like string in ${hits.join(", ")}`); return 1; }
  console.log(`output: ${dir}`);
  return failed || rows.some((r) => !r.pass || !r.shapeOk) ? 2 : 0;
}
if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c), (e) => { console.error((e as Error).message); process.exit(1); });
