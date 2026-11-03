// Session-log bracket around the Report sheet (Director-approved): feedback_open -> feedback_sent -> feedback_closed.
// The lines are logged only; features, engagement, timing, ratings and the study schedule never read them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KVCredentialStore, MemoryKV, type ExportFile } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";

const repo = new URL("../../../", import.meta.url).pathname;
const RID = "3f0c1e9a-6b1d-4c4e-9a53-2b7d8f1e0c11";

function app() {
  const downloads: ExportFile[][] = [];
  const t = createInProcessTransport({
    storageKV: new MemoryKV(), settingsKV: new MemoryKV(), secretKV: new MemoryKV(), uploadKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()),
    fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch, streaming: false, platform: "ios-phone", uploadAutoSchedule: false,
    download: (files) => (downloads.push(files), true),
  });
  return { t, downloads };
}
const lines = async (t: ReturnType<typeof app>["t"], downloads: ExportFile[][], sessionId: string) => {
  await t.exportLogs!();
  const files = downloads.pop()!;
  const f = files.find((x) => x.name.endsWith(".jsonl") && String(x.content).includes(sessionId))!;
  return String(f.content).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
};
const reply = (t: ReturnType<typeof app>["t"], i: number) => t.reply({ text: `tide pools and old maps ${i}`, events: [], sentAt: 1_000_000 + i * 10_000, shownAt: 1_000_000 + i * 10_000 - 4000 });

test("open -> closed {sent:false} and open -> sent {report_id} -> closed {sent:true}, in order, in the current session", async () => {
  const { t, downloads } = app();
  const s = await t.newSession();
  await reply(t, 0);
  assert.deepEqual(await t.feedback!.log!({ type: "feedback_open", ts: 1000, trigger: "sidebar" }), { ok: true });
  await t.feedback!.log!({ type: "feedback_closed", ts: 2000, sent: false });
  await reply(t, 1);
  void t.feedback!.log!({ type: "feedback_open", ts: 3000, trigger: "shortcut" }); // not awaited: order still holds
  void t.feedback!.log!({ type: "feedback_sent", ts: 4000, report_id: RID.toUpperCase() });
  await t.feedback!.log!({ type: "feedback_closed", ts: 5000, sent: true });
  const fb = (await lines(t, downloads, s.sessionId)).filter((e) => String(e.type).startsWith("feedback_"));
  const strip = fb.map(({ t: iso, ...e }) => (assert.match(iso, /^\d{4}-\d\d-\d\dT/), e));
  assert.deepEqual(strip, [
    { type: "feedback_open", ts: 1000, sessionId: s.sessionId, trigger: "sidebar" },
    { type: "feedback_closed", ts: 2000, sessionId: s.sessionId, sent: false },
    { type: "feedback_open", ts: 3000, sessionId: s.sessionId, trigger: "shortcut" },
    { type: "feedback_sent", ts: 4000, sessionId: s.sessionId, report_id: RID },
    { type: "feedback_closed", ts: 5000, sessionId: s.sessionId, sent: true },
  ]);
  // every open is followed by sent and/or closed before the next open
  for (let i = 0; i < strip.length; i++) if (strip[i]!.type === "feedback_open") assert.ok(["feedback_sent", "feedback_closed"].includes(strip[i + 1]?.type));
});

test("bad input is sanitized or dropped; no session -> nothing written and no session started", async () => {
  const { t, downloads } = app();
  assert.deepEqual(await t.feedback!.log!({ type: "feedback_open", ts: 1 }), { ok: false }, "no host yet");
  assert.equal((await t.sessions?.())?.length ?? 0, 0);
  const s = await t.newSession();
  assert.deepEqual(await t.feedback!.log!({ type: "feedback_sent", ts: 1, report_id: "not-a-uuid" }), { ok: false });
  await t.feedback!.log!({ type: "feedback_open", ts: 2, trigger: "Bearer bhd_xxx" });
  await t.feedback!.log!({ type: "feedback_closed", ts: 3, sent: "yes" as unknown as boolean });
  const fb = (await lines(t, downloads, s.sessionId)).filter((e) => String(e.type).startsWith("feedback_"));
  assert.deepEqual(fb.map((e) => [e.type, e.trigger ?? e.sent]), [["feedback_open", "other"], ["feedback_closed", false]]);
});

test("features, engagement, frames and turn numbering are identical with and without the feedback lines", async () => {
  const run = async (withFeedback: boolean) => {
    const { t, downloads } = app();
    const s = await t.newSession();
    for (let i = 0; i < 5; i++) {
      if (withFeedback && i === 2) { await t.feedback!.log!({ type: "feedback_open", ts: 1, trigger: "sidebar" }); await t.feedback!.log!({ type: "feedback_sent", ts: 2, report_id: RID }); await t.feedback!.log!({ type: "feedback_closed", ts: 3, sent: true }); }
      await reply(t, i);
    }
    const all = await lines(t, downloads, s.sessionId);
    // the Director's topic pick is random per run, so compare what the feedback lines could disturb: line order,
    // turn numbers, and every user_turn's features / engagement / baseline / prompt window
    return all.filter((e) => !String(e.type).startsWith("feedback_")).map((e) => e.type === "user_turn"
      ? { type: e.type, turn: e.turn, features: e.features, engagement: e.engagement, baseline: e.baseline, prompt: e.prompt, keyGaps: e.keyGaps }
      : { type: e.type, turn: e.turn });
  };
  const [a, b] = [await run(false), await run(true)];
  assert.deepEqual(b, a);
});

test("study session: feedback lines pass check_blinding (both arms) and carry no arm or report content", async () => {
  const { t, downloads } = app();
  await t.study!.enable();
  const dir = mkdtempSync(join(tmpdir(), "bh-fb-log-blind-"));
  for (let n = 0; n < 2; n++) {
    const s = await t.newSession();
    await reply(t, 0);
    await t.feedback!.log!({ type: "feedback_open", ts: 10, trigger: "sidebar" });
    if (n === 0) await t.feedback!.log!({ type: "feedback_sent", ts: 20, report_id: RID });
    await t.feedback!.log!({ type: "feedback_closed", ts: 30, sent: n === 0 });
    await reply(t, 1);
    const l = await lines(t, downloads, s.sessionId);
    assert.ok(l[0]!.study, "a study session");
    for (const e of l.filter((x) => String(x.type).startsWith("feedback_"))) assert.deepEqual(Object.keys(e).sort(), ["sessionId", "t", "ts", "type", ...(e.type === "feedback_open" ? ["trigger"] : e.type === "feedback_sent" ? ["report_id"] : ["sent"])].sort());
    writeFileSync(join(dir, `s${n}.jsonl`), l.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await t.rate!({ scope: "session", turn: 2, value: 3, shownAt: 1, answeredAt: 2, dismissed: false, blindGuess: "no-idea" });
  }
  const out = execFileSync("node", [join(repo, "tools/phaseD/check_blinding.mjs"), dir], { encoding: "utf8" });
  assert.match(out, /2 files: 2 study/); assert.match(out, /; 0 leaks/);
});
