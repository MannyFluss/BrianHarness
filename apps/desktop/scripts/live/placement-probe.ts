#!/usr/bin/env -S npx tsx
// Researcher's note-placement probe: does gpt-oss on Ollama Cloud act on a [DIRECTOR STATE] note placed
//   leading  = appended to the leading system message (protocol 4), vs
//   trailing = a separate system message after the user turn (protocol <= 3, 601300f)?
// The note asks for a detectable marker (the reply must start with MARKER). N requests per placement (default 10),
// interleaved, plus 2 no-note controls (prompt_tokens baseline: a trailing note that is dropped upstream would
// leave prompt_tokens at the control level; a hoisted / kept one raises it like the leading note).
// Request bodies match the app's Spider Cloud chat body (max_tokens 2048, temperature 0.8, stream false).
// Reports the marker rate per placement and the Ollama usage (prompt / completion tokens per placement + total).
//
//   BH_LIVE_TOKEN=<device token> npx tsx apps/desktop/scripts/live/placement-probe.ts [--model gpt-oss:20b-cloud] [--n 10] [--out <dir>]
//   (default out: /workspace/p0-stream/live/placement-probe; 2N+2 live requests)
import { CHAT_SYSTEM_PROMPT, leadingSystemMessage } from "@brianharness/core/browser";
import { guardedFetch, LIVE_ORIGIN, outDir, scanOutputs, sumUsage, upstreamFromEnv, writer, type Exchange } from "./lib.ts";

export const MARKER = "KESTREL-42";
export const PROBE_NOTE = `[DIRECTOR STATE · turn 1]\nPlan: answer their message. Begin your reply with the exact text ${MARKER} on its own line (a test marker), then answer normally.`;
export const PROBE_USER = "What's a good way to spend a rainy afternoon?";
type Placement = "leading" | "trailing" | "control";
export const probeMessages = (p: Placement) =>
  p === "leading" ? [{ role: "system", content: leadingSystemMessage(PROBE_NOTE) }, { role: "user", content: PROBE_USER }]
  : p === "trailing" ? [{ role: "system", content: CHAT_SYSTEM_PROMPT }, { role: "user", content: PROBE_USER }, { role: "system", content: PROBE_NOTE }]
  : [{ role: "system", content: CHAT_SYSTEM_PROMPT }, { role: "user", content: PROBE_USER }];

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const arg = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
  const model = arg("--model", "gpt-oss:20b-cloud"), n = Math.max(1, Math.min(20, Number(arg("--n", "10"))));
  const { origin, token, fake } = upstreamFromEnv();
  const dir = outDir("placement-probe", argv);
  const w = writer(dir);
  const log: Exchange[] = [];
  const g = guardedFetch({ origin, token, maxLive: 2 * n + 2, stubOpener: false, log });
  const plan: Placement[] = [];
  for (let i = 0; i < n; i++) plan.push("leading", "trailing");
  plan.push("control", "control");
  const rows: Array<{ placement: Placement; marker: boolean; finishReason: string | null; prompt_tokens: number | null; completion_tokens: number | null; error?: string }> = [];
  w.md("transcript.md", `# Placement probe · ${model}${fake ? " · FAKE UPSTREAM" : ""} · ${new Date().toISOString()}\n\nnote: ${JSON.stringify(PROBE_NOTE)}\n\n`);
  for (const p of plan) {
    const before = log.length;
    try {
      await g.fetch(`${LIVE_ORIGIN}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer placeholder" }, body: JSON.stringify({ model, messages: probeMessages(p), max_tokens: 2048, temperature: 0.8, stream: false }) });
    } catch { /* logged */ }
    const ex = log[before];
    const marker = !!ex && ex.content.trim().toUpperCase().includes(MARKER);
    rows.push({ placement: p, marker, finishReason: ex?.finishReason ?? null, prompt_tokens: ex?.usage.prompt_tokens ?? null, completion_tokens: ex?.usage.completion_tokens ?? null, ...(ex?.error ? { error: ex.error } : {}) });
    w.md("transcript.md", `## ${p} #${rows.filter((r) => r.placement === p).length}\n\n${ex?.content.slice(0, 600) || "(empty)"}\n\n-> marker ${marker ? "YES" : "no"}; usage ${ex?.usage.prompt_tokens}/${ex?.usage.completion_tokens}\n\n`);
  }
  const summary: Record<string, unknown> = {};
  for (const p of ["leading", "trailing", "control"] as const) {
    const r = rows.filter((x) => x.placement === p);
    const pt = r.map((x) => x.prompt_tokens).filter((x): x is number => x !== null), ct = r.map((x) => x.completion_tokens).filter((x): x is number => x !== null);
    const mean = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
    summary[p] = { requests: r.length, marker: `${r.filter((x) => x.marker).length}/${r.length}`, errors: r.filter((x) => x.error).length, prompt_tokens_mean: mean(pt), prompt_tokens_sum: pt.reduce((s, x) => s + x, 0), completion_tokens_mean: mean(ct), completion_tokens_sum: ct.reduce((s, x) => s + x, 0) };
    console.log(`${p.padEnd(8)} marker ${(summary[p] as { marker: string }).marker}  prompt_tokens mean ${(summary[p] as { prompt_tokens_mean: number | null }).prompt_tokens_mean}  completion_tokens mean ${(summary[p] as { completion_tokens_mean: number | null }).completion_tokens_mean}`);
  }
  const usage = sumUsage(log);
  console.log(`total Ollama usage: ${usage.requests} requests, prompt_tokens ${usage.prompt_tokens}, completion_tokens ${usage.completion_tokens}`);
  w.json("results.json", { model, n, fake, note: PROBE_NOTE, user: PROBE_USER, summary, rows, total_usage: usage });
  const hits = scanOutputs(dir, token);
  if (hits.length) { console.error(`token-like string in ${hits.join(", ")}`); return 1; }
  console.log(`output: ${dir}`);
  return rows.some((r) => r.error) ? 2 : 0;
}
if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c), (e) => { console.error((e as Error).message); process.exit(1); });
