// Shared pieces of the live follow-the-user scripts (plain-follow.ts, researcher-smoke.ts, placement-probe.ts) and
// their offline check (fake-upstream-check.ts). NO inference happens unless a script is run with BH_LIVE_TOKEN set
// and without --dry-run / a localhost upstream.
//
// Safety:
//   - the token comes from the env var BH_LIVE_TOKEN only; it is never printed, logged or written: the app side holds a
//     placeholder credential and guardedFetch swaps in the Authorization header on the way out; every output file is
//     scanned for the token and "bhd_" at the end (hit -> exit 1).
//   - upstream is https://api.strangeriver.org; BH_LIVE_UPSTREAM may only point at http://127.0.0.1 / localhost
//     (the fake upstream of fake-upstream-check.ts).
//   - only POST /v1/chat/completions goes upstream, at most maxLive times (the next one fails the run); GET
//     /v1/models is answered locally; extractor calls (response_format) are answered locally with no interests and
//     never reach upstream (none happen in these short sessions; counted if they do).
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KVCredentialStore, MemoryKV, OPENER_CUE, STUDY_ID, STUDY_PROGRESS_KEY, STUDY_PROTOCOL_VERSION, STUDY_SCHEDULE_KEY } from "@brianharness/core/browser";
import type { TypingEvent } from "@brianharness/core/browser";
import { createInProcessTransport } from "../../src/transport/in-process.ts";

export const LIVE_ORIGIN = "https://api.strangeriver.org";
export const PLACEHOLDER = "placeholder-swapped-by-guarded-fetch";
/** the opener is answered locally (not sent upstream) so the live budget goes to the prompts; its text is fixed */
export const STUB_OPENER = "Hi! What's on your mind today?";

export type Usage = { prompt_tokens: number | null; completion_tokens: number | null };
export type Exchange = { n: number; model: string; roles: string[]; lastUser: string | null; systemCount: number; status: number; content: string; finishReason: string | null; usage: Usage; ms: number; local: boolean; error?: string };

export function upstreamFromEnv(): { origin: string; token: string; fake: boolean } {
  const origin = (process.env.BH_LIVE_UPSTREAM ?? LIVE_ORIGIN).replace(/\/+$/, "");
  const fake = origin !== LIVE_ORIGIN;
  if (fake && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) throw new Error("BH_LIVE_UPSTREAM may only be a localhost fake upstream");
  const token = process.env.BH_LIVE_TOKEN ?? "";
  if (!token) throw new Error("BH_LIVE_TOKEN is not set (the Spider Cloud device token; it is never printed)");
  return { origin, token, fake };
}

/** fetch for the app transport: rewrites the Worker origin to `origin`, swaps in the token, enforces the budget */
export function guardedFetch(o: { origin: string; token: string; maxLive: number; stubOpener: boolean; log: Exchange[] }) {
  let live = 0;
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.origin !== LIVE_ORIGIN) return json({ error: "blocked origin" }, 403);
    if (u.pathname === "/v1/models") return json({ data: [{ id: "gpt-oss:20b-cloud" }, { id: "gpt-oss:120b-cloud" }, { id: "gemma4:cloud" }] });
    if (u.pathname !== "/v1/chat/completions" || (init?.method ?? "GET") !== "POST") return json({ error: "not forwarded" }, 403);
    const body = String(init?.body ?? "");
    const req = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown };
    const n = o.log.length + 1;
    const roles = req.messages.map((m) => m.role);
    const last = req.messages.at(-1)!;
    const base = { n, model: req.model, roles, lastUser: last.role === "user" ? last.content : null, systemCount: roles.filter((r) => r === "system").length };
    if (req.response_format) { // extractor: never upstream
      o.log.push({ ...base, status: 200, content: '{"interests":[]}', finishReason: "stop", usage: { prompt_tokens: null, completion_tokens: null }, ms: 0, local: true });
      return json({ choices: [{ message: { content: '{"interests":[]}' }, finish_reason: "stop" }] });
    }
    if (o.stubOpener && last.role === "user" && last.content === OPENER_CUE) {
      o.log.push({ ...base, status: 200, content: STUB_OPENER, finishReason: "stop", usage: { prompt_tokens: null, completion_tokens: null }, ms: 0, local: true });
      return json({ choices: [{ message: { content: STUB_OPENER }, finish_reason: "stop" }] });
    }
    if (++live > o.maxLive) throw new Error(`live request budget (${o.maxLive}) exceeded`);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${o.token}`);
    const t0 = Date.now();
    try {
      const r = await fetch(o.origin + u.pathname, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
      const text = await r.text();
      let content = "", finishReason: string | null = null, usage: Usage = { prompt_tokens: null, completion_tokens: null };
      try {
        const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        content = j.choices?.[0]?.message?.content ?? ""; finishReason = j.choices?.[0]?.finish_reason ?? null;
        usage = { prompt_tokens: j.usage?.prompt_tokens ?? null, completion_tokens: j.usage?.completion_tokens ?? null };
      } catch { /* non-JSON error body */ }
      o.log.push({ ...base, status: r.status, content, finishReason, usage, ms: Date.now() - t0, local: false, ...(r.ok ? {} : { error: `HTTP ${r.status}` }) });
      return new Response(text, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
    } catch (e) {
      o.log.push({ ...base, status: 0, content: "", finishReason: null, usage: { prompt_tokens: null, completion_tokens: null }, ms: Date.now() - t0, local: false, error: (e as Error).name });
      throw e;
    }
  }) as typeof fetch;
  return { fetch: f, liveCount: () => live };
}

const events = (from: number, text: string): TypingEvent[] => {
  const ev: TypingEvent[] = [{ t: from + 900, kind: "focus", len: 0 }];
  let t = from + 1200;
  for (let i = 0; i < text.length; i++) { t += 90 + ((i * 37) % 140); ev.push({ t, kind: "insert", len: i + 1 }); }
  ev.push({ t: t + 300, kind: "submit", len: text.length });
  return ev;
};

/**
 * One chat through the NEW head's real request builder (in-process transport, Spider Cloud provider, streaming off).
 * profile "plain" = study off; "adaptive" / "baseline" = study session 1 of a sealed protocol-STUDY_PROTOCOL_VERSION
 * schedule whose first session is that arm.
 */
export async function runChat(profile: "plain" | "adaptive" | "baseline", model: string, prompts: string[], f: typeof fetch): Promise<{ inStudy: boolean }> {
  const kv = { settings: new MemoryKV(), cred: new MemoryKV(), secret: new MemoryKV(), upload: new MemoryKV(), storage: new MemoryKV() };
  await kv.settings.set("llm-extract/calls", JSON.stringify({ calls: 50, max: 50 })); // extractor off
  if (profile !== "plain") {
    const order = Array.from({ length: 10 }, (_, i) => ((i % 2 === 0) === (profile === "adaptive") ? "adaptive" : "baseline"));
    await kv.secret.set(STUDY_SCHEDULE_KEY, JSON.stringify({ study: STUDY_ID, version: 1, seed: 7, order, createdAt: new Date().toISOString(), protocol: STUDY_PROTOCOL_VERSION }));
    await kv.secret.set(STUDY_PROGRESS_KEY, JSON.stringify({ enabled: true, next: 1 }));
  }
  const t = createInProcessTransport({ storageKV: kv.storage, settingsKV: kv.settings, secretKV: kv.secret, uploadKV: kv.upload, credentials: new KVCredentialStore(kv.cred), fetchImpl: f, nativeFetch: true, streaming: false, platform: "test", uploadAutoSchedule: false, download: () => true });
  await t.providers.setApiKey("spider", PLACEHOLDER);
  if (model !== "gpt-oss:20b-cloud") await t.providers.select("spider-cloud", model);
  await t.newSession();
  const inStudy = !!(await t.feedback!.context()).study.inStudy;
  if ((profile !== "plain") !== inStudy) throw new Error(`expected ${profile} session, got inStudy=${inStudy}`);
  let now = Date.now();
  for (const text of prompts) {
    const ev = events(now, text);
    const sentAt = ev.at(-1)!.t + 50;
    await t.reply({ text, events: ev, sentAt, shownAt: now });
    now = sentAt + 1_000;
  }
  return { inStudy };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
/**
 * Heuristic: does the reply do what the user asked IN THIS TURN (not steer to a topic of its own)?
 * Known prompts get specific checks; anything else: non-empty and not just a question.
 */
export function followsUser(prompt: string, reply: string, context: string[] = []): { pass: boolean; why: string } {
  const r = norm(reply);
  if (!r) return { pass: false, why: "empty reply" };
  const declarative = sentences(reply).filter((s) => !s.endsWith("?"));
  const p = norm(prompt);
  if (p.startsWith("repeat this phrase")) {
    const phrase = norm(prompt.replace(/^\s*repeat this phrase:?\s*/i, ""));
    return r.includes(phrase) ? { pass: true, why: `repeats "${phrase}"` } : { pass: false, why: `does not repeat "${phrase}"` };
  }
  if (p === "test") {
    return /\b(test|testing|works|working|hear|read|receiv|loud and clear|got it|here|up and running)/.test(r)
      ? { pass: true, why: "acknowledges the test" } : { pass: false, why: "no acknowledgement of the test" };
  }
  if (p.includes("sourdough starter")) {
    const hits = ["yeast", "bacteria", "lactobacill", "ferment", "flour", "water", "feed", "wild", "acid", "rise", "bubbl", "co2", "carbon dioxide"].filter((k) => r.includes(k));
    return hits.length >= 3 ? { pass: true, why: `explains (${hits.join(", ")})` } : { pass: false, why: `no explanation (${hits.join(", ") || "no key terms"})` };
  }
  if (p.includes("what should i focus on")) {
    const ctx = norm(context.join(" "));
    const nlpCtx = /\bnlp\b|lecture/.test(ctx);
    const onTopic = nlpCtx ? /\bnlp\b|language|token|embedding|model|text|lecture|transformer|syntax|semantic/.test(r) : true;
    if (!declarative.length) return { pass: false, why: "only asks back, gives no answer" };
    return /focus|start|try|priorit|key|first|concept|basics|depends|goal/.test(r) && onTopic ? { pass: true, why: "gives focus advice" } : { pass: false, why: nlpCtx && !onTopic ? "advice ignores the NLP lecture context" : "no focus advice" };
  }
  if (p.includes("nlp")) {
    return /\bnlp\b|natural language|language|lecture|text|token|model|linguist/.test(r) ? { pass: true, why: "engages with NLP / the lecture" } : { pass: false, why: "does not engage with NLP / the lecture" };
  }
  return declarative.length ? { pass: true, why: "non-empty answer" } : { pass: false, why: "only a question" };
}

export function sumUsage(log: Exchange[]) {
  const live = log.filter((e) => !e.local);
  const tot = (k: keyof Usage) => live.reduce((a, e) => a + (e.usage[k] ?? 0), 0);
  return { requests: live.length, prompt_tokens: tot("prompt_tokens"), completion_tokens: tot("completion_tokens"), missing_usage: live.filter((e) => e.usage.prompt_tokens === null).length };
}

export function outDir(name: string, argv: string[]): string {
  const i = argv.indexOf("--out");
  const d = i >= 0 ? argv[i + 1]! : join("/workspace/p0-stream/live", name);
  mkdirSync(d, { recursive: true });
  return d;
}
export const writer = (dir: string) => ({
  md: (file: string, text: string) => appendFileSync(join(dir, file), text),
  json: (file: string, v: unknown) => writeFileSync(join(dir, file), JSON.stringify(v, null, 1) + "\n"),
});

/** last step of every script: no output file may contain the token or a "bhd_" literal */
export function scanOutputs(dir: string, token: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else { const s = readFileSync(p, "utf8"); if ((token && s.includes(token)) || s.includes("bhd_")) hits.push(p); } } };
  walk(dir);
  return hits;
}
