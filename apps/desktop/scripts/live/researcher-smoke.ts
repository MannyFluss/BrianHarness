#!/usr/bin/env -S npx tsx
// Researcher smoke (protocol 4): report d2bd6006's turns replayed through the NEW head's real request builder on
// gpt-oss:20b-cloud, in a study session of each arm (adaptive, baseline). 3 prompts x 2 arms = 6 live requests
// (the openers are answered locally with a fixed greeting; an empty-completion retry may add requests, budget 9).
// Output: PASS / FAIL per prompt only (pass = the reply does the request in the SAME turn) and the TOTAL Ollama
// usage. No per-arm latency or token numbers. Arms are labelled A / B in the output (key in results.json).
//
//   BH_LIVE_TOKEN=<device token> npx tsx apps/desktop/scripts/live/researcher-smoke.ts [--out <dir>]
//   (default out: /workspace/p0-stream/live/researcher-smoke)
// The token is read from the env only and never printed or written (see lib.ts).
import { followsUser, guardedFetch, outDir, runChat, scanOutputs, sumUsage, upstreamFromEnv, writer, type Exchange } from "./lib.ts";

export const SMOKE_TURNS = ["I am in lecture learning about NLP", "Test", "Repeat this phrase I am ai"];
export const SMOKE_MODEL = "gpt-oss:20b-cloud";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { origin, token, fake } = upstreamFromEnv();
  const dir = outDir("researcher-smoke", argv);
  const w = writer(dir);
  const log: Exchange[] = [];
  const g = guardedFetch({ origin, token, maxLive: 9, stubOpener: true, log });
  const rows: Array<{ arm: string; label: string; prompt: string; pass: boolean; why: string }> = [];
  const labels = { adaptive: "A", baseline: "B" } as const;
  let failed = false;
  w.md("transcript.md", `# Researcher smoke · ${SMOKE_MODEL}${fake ? " · FAKE UPSTREAM" : ""} · ${new Date().toISOString()}\n\n`);
  for (const arm of ["adaptive", "baseline"] as const) {
    const start = log.length;
    try { await runChat(arm, SMOKE_MODEL, SMOKE_TURNS, g.fetch); } catch (e) { failed = true; w.md("transcript.md", `run error (arm ${labels[arm]}): ${(e as Error).message}\n`); }
    const mine = log.slice(start).filter((e) => !e.local);
    const ctx: string[] = [];
    for (const prompt of SMOKE_TURNS) {
      const ex = mine.filter((e) => e.lastUser === prompt).at(-1); // the last attempt (after any empty retry)
      const v = ex ? followsUser(prompt, ex.content, ctx) : { pass: false, why: "no request / reply" };
      rows.push({ arm, label: labels[arm], prompt, ...v });
      w.md("transcript.md", `## ${labels[arm]} · user: ${prompt}\n\n${ex?.content || "(empty)"}\n\n-> ${v.pass ? "PASS" : "FAIL"} (${v.why})\n\n`);
      ctx.push(prompt);
    }
  }
  const usage = sumUsage(log);
  for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  arm ${r.label}  "${r.prompt}"  (${r.why})`);
  console.log(`total Ollama usage: ${usage.requests} requests, prompt_tokens ${usage.prompt_tokens}, completion_tokens ${usage.completion_tokens}${usage.missing_usage ? ` (${usage.missing_usage} without usage)` : ""}`);
  w.json("results.json", { model: SMOKE_MODEL, fake, arms: labels, results: rows.map(({ label, prompt, pass, why }) => ({ arm: label, prompt, pass, why })), total_usage: usage, shapes: log.map((e) => ({ roles: e.roles, systemCount: e.systemCount, lastUserIsPrompt: e.lastUser !== null, local: e.local })) });
  const hits = scanOutputs(dir, token);
  if (hits.length) { console.error(`token-like string in ${hits.join(", ")}`); return 1; }
  console.log(`output: ${dir}`);
  return failed || rows.some((r) => !r.pass) ? 2 : 0;
}
if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c), (e) => { console.error((e as Error).message); process.exit(1); });
