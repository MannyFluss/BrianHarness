// BOX-SIDE. Picks the session subset and writes the self-contained inputs for run.mjs:
//   sessions.json  - the chosen Phase B sessions ("<dir>/<run_id>"), 3 per persona (24), deterministic
//   prompts.jsonl  - one line per (model, turn, session), turn-12 prompts first: {key, model, session, turn, body}; body is the exact
//                    /api/chat request (stream:false), key = promptKey() the sidecar uses as cache key
// Reads the sim's runs_b transcripts read-only.   node tools/llm-extractor-eval/prepare.mjs
import fs from "node:fs";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HE = path.resolve(HERE, "../..");
const SIM = process.env.SIM_ROOT ?? "/workspace/eeg-harness-sim";
const { buildExtractorPrompt, promptKey, requestBody, fnv1a64 } = await import(`${HE}/packages/core/dist/index.js`);

const PER_PERSONA = Number(process.env.PER_PERSONA ?? 3);
// two calls per session: after user turn 6 (lets the extractor's label build persistence in the session) and
// after the last user turn 12 (the extractor sees turns 1..12; this one is also scored on its own)
const TURNS = [12, 6];
const MODELS = ["gemma4:cloud", "gpt-oss:120b-cloud", "gpt-oss:20b-cloud"];
const DIRS = ["runs_b/full_w025", "runs_b/w05"];
const load = (p) => fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const all = [];
for (const d of DIRS) {
  const runs = load(path.join(SIM, d, "runs.jsonl"));
  const ut = new Map();
  for (const t of load(path.join(SIM, d, "turns.jsonl"))) if (t.speaker === "user") ut.set(`${t.run_id}#${t.turn}`, t);
  for (const r of runs) {
    const user = [...ut.entries()].filter(([k]) => k.startsWith(`${r.run_id}#`)).sort((a, b) => a[1].turn - b[1].turn).map(([, t]) => t.text);
    all.push({ session: `${d}/${r.run_id}`, persona: r.persona_id, condition: r.condition, user });
  }
}
// stratified: per persona, order by a fixed hash of the session id, take the first PER_PERSONA
const byP = new Map();
for (const s of all) (byP.get(s.persona) ?? byP.set(s.persona, []).get(s.persona)).push(s);
const chosen = [];
for (const [, ss] of [...byP.entries()].sort()) chosen.push(...ss.sort((a, b) => (fnv1a64(a.session) < fnv1a64(b.session) ? -1 : 1)).slice(0, PER_PERSONA));
// interleave personas so a partial run still covers every persona
const order = [];
for (let i = 0; i < PER_PERSONA; i++) for (const [, ss] of [...byP.entries()].sort()) { const s = ss[i]; if (s && chosen.includes(s)) order.push(s); }

fs.writeFileSync(path.join(HERE, "sessions.json"), JSON.stringify({
  note: `Phase B sessions (runs_b), ${PER_PERSONA} per persona by fnv1a64(session) order; extractor called after user turns ${[...TURNS].sort((a, b) => a - b).join(" and ")}`,
  turns: [...TURNS].sort((a, b) => a - b), sessions: order.map((s) => s.session), detail: order.map(({ session, persona, condition }) => ({ session, persona, condition })),
}, null, 1) + "\n");
const lines = [];
for (const model of MODELS) for (const turn of TURNS) for (const s of order) {
  const p = buildExtractorPrompt(s.user.slice(0, turn), model, 12, "v1"); // track 2 = the v1 prompt (core default is v2 since Nov 2 2026)
  lines.push(JSON.stringify({ key: promptKey(p), model, session: s.session, persona: s.persona, turn, body: requestBody(p) }));
}
fs.writeFileSync(path.join(HERE, "prompts.jsonl"), lines.join("\n") + "\n");
console.log(`${order.length} sessions, ${lines.length} prompts (${MODELS.join(", ")}) -> ${HERE}/{sessions.json,prompts.jsonl}`);
