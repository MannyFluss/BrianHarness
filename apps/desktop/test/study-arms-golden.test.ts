// Study arms byte-identical replay (Researcher condition 3 for the plain-chat profile). A study session in each arm
// (adaptive, baseline) is replayed through the real in-process transport (Spider Cloud provider, fake Worker fetch)
// with a fixed clock, fixed schedule and fixed typing events. Every /v1/chat/completions request body (the exact
// string sent, opener + extractor calls included) must equal the golden bodies captured from 601300f code.
// Capture (only on 601300f code): BH_CAPTURE_GOLDEN=1 npx tsx --test apps/desktop/test/study-arms-golden.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { KVCredentialStore, MemoryKV, STUDY_ID, STUDY_PROTOCOL_VERSION, STUDY_PROGRESS_KEY, STUDY_SCHEDULE_KEY } from "@brianharness/core/browser";
import type { TypingEvent } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";

const GOLDEN = new URL("./golden/study-arms-601300f.json", import.meta.url);
const TOKEN = "bhd_fake_golden"; // fake literal
const T0 = 1_762_200_000_000; // fixed clock (session seed = clock % 100000)
// Manny's d2bd6006 turns first (command words included), then enough turns to pass several planner phases
const USER = [
  "I am in lecture learning about NLP", "Test", "Repeat this phrase I am ai", "Test",
  "what should I focus on?", "explain how a sourdough starter works", "I like hiking on weekends but mostly I read sci-fi",
  "honestly music production is what I do every night", "I restore old watches sometimes",
];
const REPLY = (n: number) => `Reply number ${n}. What do you think?`;

const events = (from: number, text: string): TypingEvent[] => {
  const ev: TypingEvent[] = [{ t: from + 900, kind: "focus", len: 0 }];
  let t = from + 1200;
  for (let i = 0; i < text.length; i++) { t += 90 + ((i * 37) % 140); ev.push({ t, kind: "insert", len: i + 1 }); if (i === 5) { t += 60; ev.push({ t, kind: "delete", len: i }); t += 70; ev.push({ t, kind: "insert", len: i + 1 }); } }
  ev.push({ t: t + 300, kind: "submit", len: text.length });
  return ev;
};

async function replayArm(arm: "adaptive" | "baseline", model: string): Promise<string[]> {
  const bodies: string[] = [];
  let n = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/models") return json({ data: [{ id: "gpt-oss:20b-cloud" }, { id: "gpt-oss:120b-cloud" }] });
    if (u.pathname === "/v1/chat/completions") {
      bodies.push(String(init?.body));
      return json({ choices: [{ message: { content: REPLY(++n) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8 } });
    }
    if (u.pathname === "/v1/sessions") return json({ id: "x" }, 201);
    return json({}, 404);
  }) as typeof fetch;
  const kv = { settings: new MemoryKV(), cred: new MemoryKV(), secret: new MemoryKV(), upload: new MemoryKV(), storage: new MemoryKV() };
  // a sealed schedule whose session 1 is `arm` (fixed, so the replay is deterministic), study on, next = 1
  const order = Array.from({ length: 10 }, (_, i) => ((i % 2 === 0) === (arm === "adaptive") ? "adaptive" : "baseline"));
  await kv.secret.set(STUDY_SCHEDULE_KEY, JSON.stringify({ study: STUDY_ID, version: 1, seed: 7, order, createdAt: "2026-11-03T00:00:00.000Z", protocol: STUDY_PROTOCOL_VERSION }));
  await kv.secret.set(STUDY_PROGRESS_KEY, JSON.stringify({ enabled: true, next: 1 }));
  const realNow = Date.now;
  Date.now = () => T0;
  try {
    const t = createInProcessTransport({ storageKV: kv.storage, settingsKV: kv.settings, secretKV: kv.secret, uploadKV: kv.upload, credentials: new KVCredentialStore(kv.cred), fetchImpl: f, nativeFetch: true, streaming: false, platform: "test", uploadAutoSchedule: false, download: () => true });
    await t.providers.setApiKey("spider", TOKEN);
    if (model !== "gpt-oss:20b-cloud") await t.providers.select("spider-cloud", model);
    const s = await t.newSession();
    assert.equal((s.hud as { study?: { index: number } }).study?.index, 1, "study session 1");
    let now = T0 + 5_000;
    for (const text of USER) {
      const shownAt = now;
      const ev = events(shownAt, text);
      now = ev.at(-1)!.t + 50;
      await t.reply({ text, events: ev, sentAt: now, shownAt });
      now += 3_000;
    }
  } finally {
    Date.now = realNow;
  }
  return bodies;
}

const CASES: Array<["adaptive" | "baseline", string]> = [["adaptive", "gpt-oss:20b-cloud"], ["baseline", "gpt-oss:20b-cloud"], ["adaptive", "gpt-oss:120b-cloud"], ["baseline", "gpt-oss:120b-cloud"]];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("study arms: request bodies are byte-identical to 601300f (adaptive + baseline, 20b + 120b)", async () => {
  const got: Record<string, string[]> = {};
  for (const [arm, model] of CASES) got[`${arm}/${model}`] = await replayArm(arm, model);
  // the replay is deterministic (same run twice -> same bytes)
  assert.deepEqual(await replayArm("adaptive", "gpt-oss:20b-cloud"), got["adaptive/gpt-oss:20b-cloud"]);
  if (process.env.BH_CAPTURE_GOLDEN === "1") {
    writeFileSync(GOLDEN, JSON.stringify({ capturedFrom: process.env.BH_GOLDEN_COMMIT ?? "unknown", cases: got }, null, 1) + "\n");
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { capturedFrom: string; cases: Record<string, string[]> };
  assert.equal(golden.capturedFrom, "601300f");
  for (const k of Object.keys(golden.cases)) {
    const g = golden.cases[k]!, b = got[k]!;
    assert.equal(b.length, g.length, `${k}: request count`);
    for (let i = 0; i < g.length; i++) assert.equal(b[i], g[i], `${k}: request ${i} body differs (sha ${sha(b[i]!).slice(0, 12)} vs ${sha(g[i]!).slice(0, 12)})`);
    // sanity: these are study sessions (state note present) and never carry the plain prompt
    assert.ok(g.some((x) => x.includes("[DIRECTOR STATE")), `${k}: state note present`);
  }
  // the two arms really differ (adaptive note vs plan-only note), so identical goldens cannot hide a broken replay
  assert.notDeepEqual(golden.cases["adaptive/gpt-oss:20b-cloud"], golden.cases["baseline/gpt-oss:20b-cloud"]);
});
