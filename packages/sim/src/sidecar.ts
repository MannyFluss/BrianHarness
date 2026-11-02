#!/usr/bin/env node
/**
 * BrianHarness stdio sidecar: drive one HarnessSession over JSON lines (one JSON object per line
 * on stdin, one per line on stdout; logs go to stderr). Protocol: docs/SIDECAR.md.
 *
 *   node packages/sim/dist/sidecar.js [--allow-paid]
 *   -> {"cmd":"start","options":{"provider":"mock","seed":1}}
 *   <- {"ok":true,"cmd":"start","sessionId":"...","director":{"text":"...","plan":{...}}}
 *   -> {"cmd":"reply","text":"I restore old watches","features":{"eeg.engagementIndex":0.8,"eeg.quality":1}}
 *   <- {"ok":true,"cmd":"reply","user":{...},"director":{...},"top3":[...]}
 *   -> {"cmd":"final_guesses","k":3}   -> {"cmd":"hud"}   -> {"cmd":"end"}
 */
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import {
  HarnessSession, PreparedFeatureSource, SessionStore, createBackend, detectOllama, parseBackendRef,
  synthesizeTypingFromText, type BackendSpec, type EegBlendOptions, type FeatureMap, type ProviderKind, type TypingEvent,
  type HarnessSession as HS, type TopicTaggerSpec, type LlmExtractorOptions, type ExtractorCache,
} from "@brianharness/core";

/** Sidecar-only (Node) options for {"kind":"llm-extract"} on top of the core LlmExtractorOptions. */
export interface SidecarLlmExtractOptions extends LlmExtractorOptions {
  /** JSONL of {"key","raw"} responses (e.g. tools/llm-extractor-eval/out/responses.jsonl); used as a read-only cache */
  responsesFile?: string;
  /** directory for a read-write disk cache (<key>.json) + calls.json counter */
  cacheDir?: string;
  /** hard cap on network calls, persisted in <cacheDir>/calls.json (default 50) */
  maxCalls?: number;
}

/** Build the llm-extract tagger spec: key from OLLAMA_API_KEY, disk cache, persisted hard call cap. */
export function llmExtractSpec(o: SidecarLlmExtractOptions, allowNetwork: boolean): LlmExtractorOptions & { kind: "llm-extract" } {
  const mem = new Map<string, string>();
  if (o.responsesFile && fs.existsSync(o.responsesFile)) {
    for (const l of fs.readFileSync(o.responsesFile, "utf8").split("\n")) {
      if (!l.trim()) continue;
      const r = JSON.parse(l) as { key?: string; raw?: string; ok?: boolean };
      if (r.key && typeof r.raw === "string" && r.ok !== false) mem.set(r.key, r.raw);
    }
  }
  const dir = o.cacheDir;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const cache: ExtractorCache = {
    get: (k) => mem.get(k) ?? (dir && fs.existsSync(path.join(dir, `${k}.json`)) ? fs.readFileSync(path.join(dir, `${k}.json`), "utf8") : undefined),
    set: (k, raw) => { mem.set(k, raw); if (dir) fs.writeFileSync(path.join(dir, `${k}.json`), raw); },
  };
  const apiKey = o.apiKey ?? process.env.OLLAMA_API_KEY;
  const max = o.maxCalls ?? 50;
  const counter = dir ? path.join(dir, "calls.json") : null;
  let used = counter && fs.existsSync(counter) ? (JSON.parse(fs.readFileSync(counter, "utf8")) as { calls: number }).calls : 0;
  const { responsesFile: _r, cacheDir: _c, maxCalls: _m, ...core } = o;
  return {
    ...core, kind: "llm-extract", cache, apiKey,
    offline: core.offline || !allowNetwork || !apiKey,
    reserveCall: () => {
      if (used >= max) return false;
      used++;
      if (counter) fs.writeFileSync(counter, JSON.stringify({ calls: used, max }));
      return true;
    },
  };
}

export const SIDECAR_PROTOCOL = "brianharness-sidecar/1";

export interface StartOptions {
  userId?: string;
  sessionId?: string;
  seed?: number;
  /** "mock" | "ollama" | "ollama:<model>" | "openai-compatible" | "openai" | "anthropic" | "claude-code" */
  provider?: string;
  model?: string;
  ollamaUrl?: string;
  baseUrl?: string;
  temperature?: number;
  /** backend sampling seed (default: seed) */
  backendSeed?: number;
  allowPaid?: boolean;
  /** shortcut for engagement.weight */
  eegWeight?: number;
  engagement?: EegBlendOptions;
  /**
   * topic tagger: {"kind":"lexicon"} (default) | {"kind":"keyphrase"} | {"kind":"keyphrase-only"} (leak-free:
   * no curated hobby list) | {"kind":"keyphrase-generic"} | {"kind":"lexicon-generic"} |
   * {"kind":"keyphrase","lexicon":"full|generic|broad|none"} | {"kind":"keyphrase-idf"} (leak-free, IDF-weighted) |
   * {"kind":"llm-extract", ...SidecarLlmExtractOptions} | {"kind":"ollama","model":"...","baseUrl":"..."}
   */
  tagger?: TopicTaggerSpec | ({ kind: "llm-extract" } & SidecarLlmExtractOptions);
  /** write JSONL logs / interest-map save files here */
  dataDir?: string;
  /** typing synthesis when a reply has no events: chars/sec (default 5) */
  charsPerSec?: number;
}

type Msg = { cmd: string; id?: unknown; [k: string]: unknown };

export class Sidecar {
  session: HS | null = null;
  private src = new PreparedFeatureSource("eeg");
  private clock = Date.UTC(2026, 0, 1);
  private opts: StartOptions = {};
  constructor(private globalAllowPaid = false) {}

  async handle(m: Msg): Promise<Record<string, unknown>> {
    switch (m.cmd) {
      case "hello":
        return { protocol: SIDECAR_PROTOCOL };
      case "start":
        return this.start((m.options ?? {}) as StartOptions);
      case "reply":
        return this.reply(m);
      case "hud":
        return { hud: this.need().hud(), ledger: this.ledger(), tagger: { kind: this.need().tagger.kind, ...("calls" in this.need().tagger ? { calls: (this.need().tagger as unknown as { calls: unknown }).calls } : {}) } };
      case "final_guesses":
        return { guesses: this.need().finalGuesses(Number(m.k ?? 3)) };
      case "end": {
        const s = this.need();
        await s.end();
        const out = { guesses: s.finalGuesses(Number(m.k ?? 3)), ledger: this.ledger(), turns: s.turn };
        this.session = null;
        return out;
      }
      default:
        throw new Error(`unknown cmd "${m.cmd}"`);
    }
  }

  private need(): HS {
    if (!this.session) throw new Error("no session: send {\"cmd\":\"start\"} first");
    return this.session;
  }

  private ledger(): Record<string, { label: string; mean: number; n: number }> {
    const s = this.need();
    return Object.fromEntries(Object.entries(s.map.data.topics).filter(([, c]) => c.n > 0).map(([t, c]) => [t, { label: s.map.label(t), mean: c.mean, n: c.n }]));
  }

  async start(o: StartOptions) {
    this.opts = o;
    const seed = o.seed ?? 1;
    const spec: BackendSpec = { provider: "mock", seed: o.backendSeed ?? seed };
    if (o.provider) Object.assign(spec, parseBackendRef(o.provider));
    if (o.model) spec.model = o.model;
    if (o.temperature !== undefined) spec.temperature = o.temperature;
    spec.baseUrl = spec.provider === "ollama" ? o.ollamaUrl ?? o.baseUrl : o.baseUrl;
    if (spec.provider === "ollama" && !spec.model) {
      const det = await detectOllama(spec.baseUrl);
      const local = det.models.find((x) => !x.cloud);
      if (!local) throw new Error(`ollama: no local model found at ${det.baseUrl} (${det.error ?? "empty"}); pass options.model`);
      spec.model = local.name;
    }
    const backend = await createBackend(spec);
    if (backend.paid && !(o.allowPaid && this.globalAllowPaid)) {
      throw new Error(`backend ${backend.id} is paid / uses subscription quota: needs options.allowPaid AND the --allow-paid flag`);
    }
    let tagger = o.tagger as TopicTaggerSpec | undefined;
    if (tagger?.kind === "llm-extract") {
      // network calls spend Ollama-cloud quota: same double opt-in as paid backends; otherwise cache-only
      tagger = llmExtractSpec(tagger as SidecarLlmExtractOptions, !!(o.allowPaid && this.globalAllowPaid));
    }
    const engagement: EegBlendOptions = { ...(o.engagement ?? {}), ...(o.eegWeight !== undefined ? { weight: o.eegWeight } : {}) };
    this.src = new PreparedFeatureSource("eeg");
    this.session = new HarnessSession({
      userId: o.userId ?? `sidecar-${seed}`,
      sessionId: o.sessionId,
      backend,
      store: o.dataDir ? new SessionStore(o.dataDir) : null,
      sources: [this.src],
      clock: () => this.clock,
      seed,
      engagement,
      tagger,
    });
    const d = await this.session.start();
    return { protocol: SIDECAR_PROTOCOL, sessionId: this.session.id, backend: backend.id, paid: backend.paid, director: { text: d.text, plan: d.plan } };
  }

  async reply(m: Msg) {
    const s = this.need();
    const text = String(m.text ?? "");
    const shownAt = typeof m.shownAt === "number" ? m.shownAt : s.promptShownAt || this.clock;
    let events = Array.isArray(m.events) ? (m.events as TypingEvent[]) : null;
    let sentAt = typeof m.sentAt === "number" ? m.sentAt : null;
    if (!events) {
      const syn = synthesizeTypingFromText(text, shownAt, { seed: (this.opts.seed ?? 1) * 1000 + s.turn, charsPerSec: this.opts.charsPerSec });
      events = syn.events;
      sentAt ??= syn.sentAt;
    }
    sentAt ??= events.length ? events[events.length - 1]!.t : shownAt + 5000;
    s.markShown(shownAt);
    if (m.features && typeof m.features === "object") this.src.prepare(m.features as FeatureMap);
    this.clock = sentAt;
    const out = await s.reply(text, events, sentAt);
    this.clock = sentAt + 1500;
    s.markShown(this.clock);
    const f = out.user.frame;
    return {
      turn: s.turn,
      user: {
        engagement: f.engagement,
        baseline: f.baseline,
        lift: f.lift,
        hypothesis: out.user.hypothesis,
        hypothesisLabel: out.user.hypothesis ? s.map.label(out.user.hypothesis) : null,
        mentionedTopics: f.mentionedTopics,
        eeg: pick(f.features, "engagement.eeg"),
        words: f.features["text.words"] ?? 0,
      },
      director: { text: out.director.text, plan: out.director.plan },
      top3: s.finalGuesses(3),
    };
  }
}

function pick(f: FeatureMap, prefix: string) {
  return Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith(prefix)));
}

export async function runSidecar(input = process.stdin, output = process.stdout, allowPaid = process.argv.includes("--allow-paid")) {
  const sc = new Sidecar(allowPaid);
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    chain = chain.then(async () => {
      if (!line.trim()) return;
      let m: Msg;
      try {
        m = JSON.parse(line);
      } catch (e) {
        output.write(JSON.stringify({ ok: false, error: `bad JSON: ${(e as Error).message}` }) + "\n");
        return;
      }
      try {
        const res = await sc.handle(m);
        output.write(JSON.stringify({ ok: true, cmd: m.cmd, ...(m.id !== undefined ? { id: m.id } : {}), ...res }) + "\n");
      } catch (e) {
        output.write(JSON.stringify({ ok: false, cmd: m.cmd, ...(m.id !== undefined ? { id: m.id } : {}), error: (e as Error).message }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => rl.on("close", () => chain.then(() => r())));
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/sidecar.js");
if (isMain) await runSidecar();
