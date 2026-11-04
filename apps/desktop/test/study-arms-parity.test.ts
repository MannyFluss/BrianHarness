// Protocol-4 study-arm parity (replaces the protocol-3 byte-identical-to-601300f replay). A study session in each arm
// (adaptive, baseline) is replayed through the real in-process transport (Spider Cloud provider, fake Worker fetch)
// with a fixed clock, fixed schedule and fixed typing events, on 20b and 120b. Every /v1/chat/completions body (the
// exact string sent, opener + extractor calls included) is compared across arms: with the plan-note span masked the
// bodies must be byte-identical, i.e. the arms differ ONLY inside the note, and the note sits in the leading system
// message (shared CHAT_SYSTEM_PROMPT + blank line + note), never after the user turn.
// The 601300f goldens (golden/study-arms-601300f.json, captured on the shipped head) get the same masked comparison
// with their trailing note, so the old and new arm differences can be shown side by side:
//   BH_ARM_DIFF_OUT=/path/arm-diff.md npx tsx --test apps/desktop/test/study-arms-parity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { CHAT_SYSTEM_PROMPT, KVCredentialStore, MemoryKV, STUDY_ID, STUDY_PROTOCOL_VERSION, STUDY_PROGRESS_KEY, STUDY_SCHEDULE_KEY } from "@brianharness/core/browser";
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
type Msg = { role: string; content: string };
const MASK = "<<PLAN-NOTE>>";
/** mask the note span inside the raw body string; returns [masked body, note text] (note null = no note in the body) */
function maskNote(raw: string, placement: "leading" | "trailing"): [string, string | null] {
  const msgs = (JSON.parse(raw) as { messages: Msg[] }).messages;
  let note: string | null = null;
  if (placement === "leading") {
    const c = msgs[0]!.content;
    if (msgs[0]!.role === "system" && c.startsWith(CHAT_SYSTEM_PROMPT + "\n\n[DIRECTOR STATE")) note = c.slice(CHAT_SYSTEM_PROMPT.length + 2);
  } else {
    const last = msgs.at(-1)!, prev = msgs.at(-2);
    const m = last.role === "system" ? last : prev?.role === "system" && msgs.length > 2 ? prev : null; // opener: [sys, note, cue]
    if (m && m.content.startsWith("[DIRECTOR STATE")) note = m.content;
  }
  if (note === null) return [raw, null];
  const span = JSON.stringify(note).slice(1, -1);
  assert.equal(raw.split(span).length, 2, "the note span occurs exactly once in the raw body");
  return [raw.replace(span, MASK), note];
}
function armDiff(a: string[], b: string[], placement: "leading" | "trailing") {
  assert.equal(a.length, b.length, "same number of requests in both arms");
  const rows: Array<{ i: number; identical: boolean; maskedIdentical: boolean; noteA: string | null; noteB: string | null }> = [];
  for (let i = 0; i < a.length; i++) {
    const [ma, na] = maskNote(a[i]!, placement), [mb, nb] = maskNote(b[i]!, placement);
    rows.push({ i, identical: a[i] === b[i], maskedIdentical: ma === mb, noteA: na, noteB: nb });
  }
  return rows;
}

test("protocol 4 study arms: bodies differ only inside the plan-note span, note in the leading system message (20b + 120b)", async () => {
  const got: Record<string, string[]> = {};
  for (const [arm, model] of CASES) got[`${arm}/${model}`] = await replayArm(arm, model);
  // the replay is deterministic (same run twice -> same bytes)
  assert.deepEqual(await replayArm("adaptive", "gpt-oss:20b-cloud"), got["adaptive/gpt-oss:20b-cloud"]);
  const report: string[] = [];
  for (const model of ["gpt-oss:20b-cloud", "gpt-oss:120b-cloud"]) {
    const a = got[`adaptive/${model}`]!, b = got[`baseline/${model}`]!;
    const rows = armDiff(a, b, "leading");
    let chat = 0;
    for (const r of rows) {
      assert.ok(r.maskedIdentical, `${model} request ${r.i}: arms differ outside the plan-note span`);
      const msgs = (JSON.parse(a[r.i]!) as { model: string; messages: Msg[] }).messages;
      if ((JSON.parse(a[r.i]!) as { model: string }).model !== model) { assert.ok(r.identical, `${model} request ${r.i}: extractor body identical`); continue; }
      chat++;
      assert.ok(r.noteA && r.noteB, `${model} request ${r.i}: both arms carry a leading note`);
      assert.equal(msgs.filter((m) => m.role === "system").length, 1, "exactly one system message");
      assert.equal(msgs.at(-1)!.role, "user", "the latest user message (or the opener cue) is last");
      for (const x of [a[r.i]!, b[r.i]!]) assert.equal((JSON.parse(x) as { messages: Msg[] }).messages[0]!.content.slice(0, CHAT_SYSTEM_PROMPT.length), CHAT_SYSTEM_PROMPT);
    }
    assert.equal(chat, 10, `${model}: opener + 9 replies`);
    assert.ok(rows.some((r) => !r.identical), `${model}: the arms really differ (in the note)`);
    report.push(`## protocol 4 (plain-chat HEAD) · ${model}`, ...rows.map((r) => `- req ${r.i}: ${r.identical ? "identical" : "differs only in the note (leading system message)"}`));
  }
  // the shipped 601300f arms: same masked comparison with the trailing note -> they too differed only in the note
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { capturedFrom: string; cases: Record<string, string[]> };
  assert.equal(golden.capturedFrom, "601300f");
  for (const model of ["gpt-oss:20b-cloud", "gpt-oss:120b-cloud"]) {
    const ga = golden.cases[`adaptive/${model}`]!, gb = golden.cases[`baseline/${model}`]!;
    const rows = armDiff(ga, gb, "trailing");
    for (const r of rows) assert.ok(r.maskedIdentical, `601300f ${model} request ${r.i}: masked arms identical`);
    for (const x of ga) { const m = (JSON.parse(x) as { model: string; messages: Msg[] }); if (m.model === model) assert.notEqual(m.messages.at(-1)!.role === "user" && m.messages.length > 3, true, "601300f: note trailed the user turn"); }
    report.push(`## 601300f (shipped) · ${model}`, ...rows.map((r) => `- req ${r.i}: ${r.identical ? "identical" : "differs only in the note (trailing system message after the user turn)"}`));
    // same arm-specific note TEXT then and now (only the placement and the base prompt changed)
    const now = armDiff(got[`adaptive/${model}`]!, got[`baseline/${model}`]!, "leading");
    report.push(`### note text identical to 601300f per request (adaptive / baseline): ` + rows.map((r, i) => `${r.i}:${r.noteA === now[i]!.noteA ? "=" : "≠"}/${r.noteB === now[i]!.noteB ? "=" : "≠"}`).join(" "));
    if (process.env.BH_ARM_DIFF_OUT) {
      const sample = (rs: typeof rows, i: number) => `adaptive note:\n\n    ${(rs[i]!.noteA ?? "").replace(/\n/g, "\n    ")}\n\nbaseline note:\n\n    ${(rs[i]!.noteB ?? "").replace(/\n/g, "\n    ")}`;
      report.push(`### request 3, 601300f\n\n${sample(rows, 3)}\n\n### request 3, protocol 4\n\n${sample(now, 3)}`);
    }
  }
  if (process.env.BH_ARM_DIFF_OUT) writeFileSync(process.env.BH_ARM_DIFF_OUT, `# Study arm differences (masked-note parity)\n\n${report.join("\n")}\n`);
});
