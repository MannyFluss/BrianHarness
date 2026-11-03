// Writes Export-logs JSONL for: a plain chat, then 10 study sessions (5 adaptive + 5 baseline, each valid: 8 turns +
// a session rating), then a plain chat after the study finished, through the real in-process transport with a fake
// Worker (no network, fake token). For check_blinding: npx tsx tools/phaseD/sample-logs.ts <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KVCredentialStore, MemoryKV, StudyController } from "@brianharness/core/browser";
import { createInProcessTransport } from "../../apps/desktop/src/transport/in-process.ts";

const out = process.argv[2] ?? "/tmp/bh-sample-logs";
const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (u.pathname === "/v1/models") return json({ data: [{ id: "gpt-oss:20b-cloud" }] });
  if (u.pathname === "/v1/chat/completions") { void init; return json({ choices: [{ message: { content: "Sure. What else is on your mind?" }, finish_reason: "stop" }], usage: { prompt_tokens: 321, completion_tokens: 9 } }); }
  if (u.pathname === "/v1/sessions") return json({ id: "x" }, 201);
  return json({}, 404);
}) as typeof fetch;
const secret = new MemoryKV();
const kv = { settings: new MemoryKV(), cred: new MemoryKV(), upload: new MemoryKV(), storage: new MemoryKV() };
let files: Array<{ name: string; content: string }> = [];
const t = createInProcessTransport({ storageKV: kv.storage, settingsKV: kv.settings, secretKV: secret, uploadKV: kv.upload, credentials: new KVCredentialStore(kv.cred), fetchImpl: f, nativeFetch: true, streaming: false, platform: "test", uploadAutoSchedule: false, download: (fs) => ((files = fs as typeof files), true) });
await t.providers.setApiKey("spider", "bhd_fake_sample");
const chat = async (n: number) => { let now = Date.now(); for (let i = 0; i < n; i++) { now += 7000; await t.reply({ text: `Repeat this phrase I am ai, then tell me about sourdough ${i}`, events: [{ t: now - 3000, kind: "insert", len: 1 }], sentAt: now, shownAt: now - 5000 }); } };
await t.newSession(); await chat(3); // plain (study off)
await new StudyController(secret, kv.settings, { randomSeed: () => 1234 }).enable();
for (let s = 0; s < 10; s++) { await t.newSession(); await chat(8); await t.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2, blindGuess: "no-idea" }); }
await t.newSession(); await chat(2); // plain (study finished)
await t.newSession();
await t.exportLogs();
mkdirSync(out, { recursive: true });
for (const x of files) { const p = join(out, x.name.replace(/\//g, "__")); writeFileSync(p, x.content); }
console.log(`${files.length} files -> ${out}`);
