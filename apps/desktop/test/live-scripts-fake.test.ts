// Fake-upstream conversation check for the live scripts (apps/desktop/scripts/live/*): a local Worker-shaped
// OpenAI-compatible server stands in for https://api.strangeriver.org (BH_LIVE_UPSTREAM=http://127.0.0.1:<port>), with a
// fake token (no real token, no inference). Checks the request shapes the NEW head sends (one leading system
// message, the user's message last), the live budgets, the Authorization swap, the PASS / FAIL heuristic on an
// answering vs a steering upstream, the usage totals, and that no output file contains the token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_SYSTEM_PROMPT, OPENER_CUE } from "@brianharness/core/browser";

const FAKE_TOKEN = "fake-live-token-0123456789"; // fake literal
type Msg = { role: string; content: string };
type Seen = { auth: string | undefined; model: string; messages: Msg[] };

function answer(last: string, all: Msg[], mode: "answer" | "steer"): string {
  const marker = all.some((m) => m.content.includes("KESTREL-42")) ? "KESTREL-42\n" : "";
  if (mode === "steer") return marker + "That's interesting! By the way, what kind of music do you like?";
  const l = last.toLowerCase();
  if (l.startsWith("repeat this phrase")) return "I am ai";
  if (l === "test") return "Test received, I can read you loud and clear.";
  if (l.includes("sourdough")) return "A starter is flour and water where wild yeast and lactic acid bacteria ferment; feeding it keeps it bubbly and it makes CO2 that helps bread rise.";
  if (l.includes("focus")) return "Start with the key concepts from the lecture: tokenization, embeddings and how a language model predicts text.";
  if (l.includes("nlp")) return "Nice, NLP is a fun lecture topic! Natural language processing covers how models handle text.";
  return marker + "Read a book with tea.";
}

async function withUpstream(mode: "answer" | "steer", fn: (seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url !== "/v1/chat/completions" || req.method !== "POST") { res.writeHead(404).end(); return; }
      const j = JSON.parse(body) as { model: string; messages: Msg[] };
      seen.push({ auth: req.headers.authorization, model: j.model, messages: j.messages });
      const lastUser = [...j.messages].reverse().find((m) => m.role === "user")!.content;
      const content = answer(lastUser, j.messages, mode);
      const promptTokens = j.messages.reduce((a, m) => a + Math.ceil(m.content.length / 4), 0);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const env = { u: process.env.BH_LIVE_UPSTREAM, t: process.env.BH_LIVE_TOKEN };
  process.env.BH_LIVE_UPSTREAM = `http://127.0.0.1:${port}`;
  process.env.BH_LIVE_TOKEN = FAKE_TOKEN;
  const log = console.log; console.log = () => {};
  try { await fn(seen); } finally {
    console.log = log;
    server.close();
    if (env.u === undefined) delete process.env.BH_LIVE_UPSTREAM; else process.env.BH_LIVE_UPSTREAM = env.u;
    if (env.t === undefined) delete process.env.BH_LIVE_TOKEN; else process.env.BH_LIVE_TOKEN = env.t;
  }
}
const noToken = (dir: string) => { for (const f of ["transcript.md", "results.json"]) assert.ok(!readFileSync(join(dir, f), "utf8").includes(FAKE_TOKEN), f); };
const shapeOk = (s: Seen) => s.messages.filter((m) => m.role === "system").length === 1 && s.messages[0]!.role === "system" && s.messages.at(-1)!.role === "user" && s.messages[0]!.content.startsWith(CHAT_SYSTEM_PROMPT);

test("researcher smoke: 6 upstream requests on 20b (3 per arm), leading note, user last; answer -> all PASS, steer -> FAIL", async () => {
  const { main } = await import("../scripts/live/researcher-smoke.ts");
  for (const mode of ["answer", "steer"] as const) {
    await withUpstream(mode, async (seen) => {
      const dir = mkdtempSync(join(tmpdir(), "smoke-"));
      const code = await main(["--out", dir]);
      assert.equal(code, mode === "answer" ? 0 : 2);
      assert.equal(seen.length, 6, "6 live requests (openers local)");
      assert.ok(seen.every((s) => s.model === "gpt-oss:20b-cloud" && s.auth === `Bearer ${FAKE_TOKEN}`));
      assert.ok(seen.every(shapeOk), "one leading system message, user last");
      assert.ok(seen.every((s) => s.messages[0]!.content.includes("\n\n[DIRECTOR STATE ·")), "study arms: note inside the leading system message");
      assert.ok(seen.every((s) => !s.messages.some((m) => m.content === OPENER_CUE)), "the opener never went upstream");
      const r = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as { results: Array<{ pass: boolean }>; total_usage: { requests: number; prompt_tokens: number; completion_tokens: number } };
      assert.equal(r.results.length, 6);
      assert.ok(r.results.every((x) => x.pass === (mode === "answer")));
      assert.equal(r.total_usage.requests, 6); assert.equal(r.total_usage.completion_tokens, 120); assert.ok(r.total_usage.prompt_tokens > 0);
      assert.doesNotMatch(readFileSync(join(dir, "transcript.md"), "utf8"), /adaptive|baseline|ms\b|latency/i, "no arm names / latency in the transcript");
      noToken(dir);
    });
  }
});

test("plain follow: 4 prompts x 20b + 120b, no note, user last; answer -> PASS, steer -> FAIL", async () => {
  const { main } = await import("../scripts/live/plain-follow.ts");
  for (const mode of ["answer", "steer"] as const) {
    await withUpstream(mode, async (seen) => {
      const dir = mkdtempSync(join(tmpdir(), "plain-"));
      assert.equal(await main(["--out", dir]), mode === "answer" ? 0 : 2);
      assert.equal(seen.length, 8);
      assert.deepEqual([...new Set(seen.map((s) => s.model))], ["gpt-oss:20b-cloud", "gpt-oss:120b-cloud"]);
      assert.ok(seen.every(shapeOk));
      assert.ok(seen.every((s) => s.messages[0]!.content === CHAT_SYSTEM_PROMPT), "plain: the shared prompt, no note");
      noToken(dir);
    });
  }
});

test("placement probe: 2N+2 requests, leading vs trailing vs control shapes, marker rate + usage", async () => {
  const { main, MARKER } = await import("../scripts/live/placement-probe.ts");
  await withUpstream("answer", async (seen) => {
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    assert.equal(await main(["--out", dir, "--n", "3"]), 0);
    assert.equal(seen.length, 8);
    const kinds = seen.map((s) => s.messages.map((m) => m.role).join(","));
    assert.equal(kinds.filter((k) => k === "system,user").length, 5, "3 leading + 2 control");
    assert.equal(kinds.filter((k) => k === "system,user,system").length, 3, "3 trailing");
    const r = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as { summary: Record<string, { marker: string; prompt_tokens_mean: number }> };
    assert.equal(r.summary.leading!.marker, "3/3"); assert.equal(r.summary.trailing!.marker, "3/3"); assert.equal(r.summary.control!.marker, "0/2");
    assert.ok(r.summary.leading!.prompt_tokens_mean > r.summary.control!.prompt_tokens_mean);
    assert.ok(MARKER.length > 0);
    noToken(dir);
  });
});

test("live scripts refuse a non-localhost override and a missing token", async () => {
  const { upstreamFromEnv } = await import("../scripts/live/lib.ts");
  const env = { u: process.env.BH_LIVE_UPSTREAM, t: process.env.BH_LIVE_TOKEN };
  try {
    process.env.BH_LIVE_TOKEN = FAKE_TOKEN; process.env.BH_LIVE_UPSTREAM = "https://evil.example";
    assert.throws(() => upstreamFromEnv(), /localhost/);
    delete process.env.BH_LIVE_UPSTREAM; delete process.env.BH_LIVE_TOKEN;
    assert.throws(() => upstreamFromEnv(), /BH_LIVE_TOKEN/);
  } finally {
    if (env.u !== undefined) process.env.BH_LIVE_UPSTREAM = env.u;
    if (env.t !== undefined) process.env.BH_LIVE_TOKEN = env.t;
  }
});
