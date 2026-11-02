// Headless Phase D sample: one blinded study session (protocol 2) with 10 user turns, turn probes and a session
// rating, the extractor answering through a FAKE Spider Cloud Worker (no network, no model calls).
//   npx tsx tools/phaseD/make_sample.ts            -> docs/samples/phaseD_sample_export.jsonl + phaseD_sample_upload.json
// The export file is HarnessHost.sessionFile(id).content (the BHExport / Files bytes); the upload body is
// sessionUploadBody(<those bytes>), so upload.jsonl === export byte-for-byte.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessHost, LlmInterestExtractor, MemoryHarnessStorage, MemoryKV, MockBackend, StudyController, sessionUploadBody, spiderFetch, findUploadSecret, type TypingEvent } from "../../packages/core/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TURNS = [
  "honestly mostly my sourdough starter lately",
  "it bubbled right over the jar this morning, total mess",
  "i switched to feeding it rye flour and it went wild",
  "work is fine, nothing exciting there",
  "the crumb on saturday's loaf was really open though",
  "i want to push hydration to like 80 percent next",
  "scoring is the hard part, my ears keep flattening",
  "maybe a sharper lame? i've been using a razor blade",
  "yeah the dutch oven trick helps a lot with oven spring",
  "ok i should go feed it now haha",
];
// the extractor runs at user turn 6 (everyN 6); this canned answer stands in for gemma4:cloud
const ANSWER = { interests: [{ label: "sourdough baking", confidence: 0.86, turns: [1, 2, 3, 5, 6] }, { label: "bread hydration", confidence: 0.41, turns: [6] }] };
const fakeWorker = (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(ANSWER) } }] }), { status: 200 })) as unknown as typeof fetch;

const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 20261102 });
const { scheduleHash } = await study.enable();
const storage = new MemoryHarnessStorage();
const host = new HarnessHost({
  userId: "local-user", storage, backend: async () => new MockBackend(3), study, seed: () => 11,
  tagger: () => ({ spec: new LlmInterestExtractor({ api: "openai", baseUrl: "https://api.strangeriver.org", apiKey: "bhd_sample_only_not_a_token_x", fetchImpl: spiderFetch(fakeWorker) }) }),
});
const r = await host.newSession();
let clock = Date.now();
const typed = (text: string): { events: TypingEvent[]; sentAt: number; shownAt: number } => {
  const shownAt = clock;
  let t = shownAt + 1800 + (text.length % 7) * 150;
  const events: TypingEvent[] = [];
  for (let i = 1; i <= text.length; i++) { events.push({ t, kind: "insert", len: i }); t += 120 + ((i * 37) % 90); if (i % 23 === 0) t += 900; }
  events.push({ t: t + 300, kind: "submit", len: text.length });
  clock = t + 2500;
  return { events, sentAt: t + 300, shownAt };
};
for (let i = 0; i < TURNS.length; i++) {
  await host.reply({ text: TURNS[i]!, ...typed(TURNS[i]!) });
  if (i === 3 || i === 7) await host.rate({ scope: "turn", turn: i + 1, value: i === 3 ? 2 : 5, shownAt: clock - 2000, answeredAt: clock - 800, dismissed: false });
}
await host.rate({ scope: "session", turn: TURNS.length, value: 4, shownAt: clock, answeredAt: clock + 4200, dismissed: false, hooked: "talking through the scoring problem", blindGuess: "no-idea" });
await host.end();

const file = host.sessionFile(r.sessionId)!;
const body = sessionUploadBody(file.content, { appVersion: "0.1.0", platform: "ios", build: 1439 });
const outDir = join(root, "docs/samples");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "phaseD_sample_export.jsonl"), file.content);
writeFileSync(join(outDir, "phaseD_sample_upload.json"), JSON.stringify(body, null, 2) + "\n");
const lines = file.content.trim().split("\n").map((l) => JSON.parse(l));
const users = lines.filter((e) => e.type === "user_turn").length;
console.log(`${file.name}: ${lines.length} lines, ${users} user turns, scheduleHash ${scheduleHash.slice(0, 12)}…, secret scan: ${findUploadSecret(JSON.stringify(body)) ?? "clean"}`);

// optional: validate with the Worker's own guards (local checkout, read-only import)
const scan = process.env.BH_WORKER_DIR ? join(process.env.BH_WORKER_DIR, "src/scan.ts") : "/workspace/brianharness-worker/src/scan.ts";
if (existsSync(scan)) {
  const w = await import(pathToFileURL(scan).href);
  const c = w.checkJsonl(body.jsonl);
  const meta = { ...body, jsonl: undefined };
  console.log(`Worker checkJsonl: ${JSON.stringify(c)}; meta scan: ${w.scanValue(JSON.stringify(meta), meta) ?? "clean"}`);
}
