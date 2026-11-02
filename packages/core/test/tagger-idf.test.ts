// keyphrase-idf: leak-free (no curated list) IDF keyphrase tagger, and the llm-extract tagger option.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HarnessSession, MockBackend, SPECIFIC_TOPICS, createTagger, idfCandidates, IDF_STOPWORDS, IDF_EVALUATIVE, zipfOf, defaultFreqTable, parseZipf10, idf,
  LlmInterestExtractor, EXTRACTOR_SYSTEM_PROMPT, buildExtractorPrompt, promptKey, requestBody, parseExtractorResponse,
  KeyphraseIdfTagger, isLocalOllamaUrl, isCloudModelTag, eegReorder, finalGuesses, InterestMap, LEAD_EEG_Z,
} from "../src/index.ts";

const curatedLabels = Object.values(SPECIFIC_TOPICS).map((t) => t.label.toLowerCase());

// passion keywords + synonyms of the sim personas (personas.json + personas_c.json), hard-coded
const PERSONA_WORDS = "agate agates antenna apiary arcade aroma awl basil beachcomber beachcombing bee beekeeping bees belfry bellringing bells binding binoculars bird birding blocks bookbinding buildings bypass byzantine byzantium cabochon campanology cave caver cavers caves caving cobalt cologne constantinople contest cradle crawl ctwc drawing ebird empire endpapers flipper flippers fragrance fragrances frequency fungi gears gemstones geode geodes grandsire ham handbells headlamp hive honey hypertapping ifpa ink jasper justinian killscreen lapidary lockpicking locksmith locksport log loupe maceration marbling mechanical medieval migration minerals morse movement multiball myxomycete nes nudge nudging oat padlock passages peal perfume perfumer perfumery perfumes physarum picks pinball playfield pollinator potholing queen radio rappel restoring ringers rockhound rockhounding rolling rope scent scents shards shortwave signatures sillage sketch sketchbook smell species speleology spelunker spelunking spores squeeze srt stalactites survey tetris tideline tilt tumbling tweezers underground vintage warbler watch watches watercolor".split(" ");

// persona-style replies with the passions' vocabulary but never the curated label text (as tagger-leak.test.ts)
const CONVOS: string[][] = [
  ["Mostly I sit at the transceiver at night chasing dx on the hf band", "Last weekend was a contest, my contest log had 300 contacts", "Morse is still the best mode for weak signals", "The antenna on my roof is a dipole for shortwave"],
  ["I service an old wristwatch movement most evenings", "The mainspring on that one was shot, so I sourced a new mainspring", "A balance wheel is fiddly to true", "Opening a caseback still makes me nervous"],
  ["Out at dawn with binoculars again, a lifer warbler this morning", "My ebird list is at 412 for the year, life list keeps growing", "The warbler migration is peaking right now", "Twitching a rarity two counties over this weekend"],
  ["Found physarum on a rotting log, bright yellow plasmodium", "I feed the plasmodium oat flakes in a petri dish", "Myxomycetes are not fungi, people always assume", "Photographing fruiting bodies with a macro lens"],
  ["Hypertapping is dying out, everyone rolls now", "Rolling got me past level 29 for the first time", "The killscreen used to be a myth", "Watching the CTWC finals tonight"],
  ["Spent the afternoon with my sketchbook drawing facades", "Ink and wash on location, then watercolor at home", "A fountain pen line looks great under watercolor", "Sketchers meet downtown every Saturday"],
  ["Reading about Justinian and the Nika riots", "Basil II is the most interesting emperor to me", "Constantinople's walls held for almost a thousand years", "The Komnenos dynasty is underrated"],
  ["Did a hive inspection, both hives look healthy", "Treating for varroa before winter", "Harvested honey from the second hive frames", "Caught a swarm in the neighbor's tree"],
];

test("keyphrase-idf never emits a curated label (or x: id) unless the user wrote it; every label word is the user's", async () => {
  for (const convo of CONVOS) {
    const tagger = createTagger({ kind: "keyphrase-idf" });
    let said = "";
    for (const msg of convo) {
      said += " " + msg.toLowerCase();
      for (const t of await tagger.tag(msg)) {
        assert.ok(/^kp:/.test(t.id), `non-keyphrase id ${t.id}`);
        if (curatedLabels.includes(t.label.toLowerCase())) assert.ok(said.includes(t.label.toLowerCase()), `leaked label "${t.label}"`);
        for (const w of t.label.split(" ")) assert.ok(said.includes(w), `label word "${w}" not in user text`);
      }
    }
  }
});

test("Byzantine history never surfaces as a label when only other hobbies are discussed", async () => {
  const tagger = createTagger({ kind: "keyphrase-idf" });
  for (const msg of CONVOS.filter((_, i) => i !== 6).flat()) {
    for (const t of await tagger.tag(msg)) assert.ok(!/byzantin|constantinople|justinian|roman/.test(t.label), t.label);
  }
});

test("the stopword list contains no persona passion keyword", () => {
  const hits = PERSONA_WORDS.filter((w) => IDF_STOPWORDS.has(w));
  assert.deepEqual(hits, []);
});

test("the bundled frequency list (CC0 Common Voice): common words are frequent, rare names are missing / rare", () => {
  assert.equal(defaultFreqTable().name, "cv-en-cc0");
  assert.ok(defaultFreqTable().size > 30000);
  assert.ok((zipfOf("the") ?? 0) > 7);
  assert.ok((zipfOf("house") ?? 0) > 4.5);
  assert.ok((zipfOf("constantinople") ?? 9) < 4.5);
  assert.equal(zipfOf("physarum"), undefined);
});

test("freqTable option: an external zipf10 table replaces the default, per tagger, without leaking", async () => {
  const t = parseZipf10("70:the a\n60:physarum\n", "test-table");
  assert.equal(zipfOf("physarum", t), 6);
  assert.equal(idf("physarum", t), 0);
  assert.ok(idf("physarum") > 3); // default table untouched
  assert.ok(idfCandidates("I grew physarum again", 5.3).some((c) => c.key === "physarum"));
  assert.ok(!idfCandidates("I grew physarum again", 5.3, t).some((c) => c.key === "physarum"));
  const custom = createTagger({ kind: "keyphrase-idf", freqTable: t });
  await custom.tag("I grew physarum on oat flakes");
  assert.ok(idf("physarum") > 3); // active table restored after tag()
  assert.throws(() => parseZipf10("", "empty"));
});

test("candidates keep proper nouns and multiword names, drop fillers and common verbs", () => {
  const c = idfCandidates("Honestly I spent the weekend reading about Basil II, and then I finally visited the Hagia Sophia, you know?");
  const keys = c.map((x) => x.key);
  assert.ok(keys.some((k) => k.includes("basil ii")), keys.join("|"));
  assert.ok(keys.some((k) => k.includes("hagia sophia")), keys.join("|"));
  for (const f of ["honestly", "spent", "weekend", "finally", "know", "visited"]) assert.ok(!keys.includes(f), `filler ${f} kept`);
  // a verbal -ing word may stay a candidate but is down-weighted below the names
  const sc = (k: string) => c.find((x) => x.key.includes(k))?.score ?? 0;
  assert.ok(sc("reading") < sc("hagia sophia") && sc("reading") < sc("basil ii"));
});

test("evidence aggregates across turns: related mentions thread into one topic (no curated list)", async () => {
  const tg = new KeyphraseIdfTagger();
  const ids = new Set<string>();
  for (const m of ["My bees were busy today, the hive is heavy", "I checked the hives again after lunch", "The honeybees found the lavender, the hive smells like it"]) {
    for (const t of await tg.tag(m)) ids.add(t.id);
  }
  assert.equal(ids.size, 1, [...ids].join(","));
});

test("a session with keyphrase-idf recovers Justinian/Constantinople as a final guess", async () => {
  const s = new HarnessSession({ userId: "idf", backend: new MockBackend(3), store: null, tagger: { kind: "keyphrase-idf" }, seed: 3 });
  await s.start();
  for (const m of ["not much, work has been busy", "I read a lot in the evenings", "lately it's Justinian and the building of the Hagia Sophia",
    "Constantinople under Justinian is endlessly interesting to me", "the plague of Justinian too, and the Nika riots in Constantinople", "yeah, that era is my thing"]) {
    await s.reply(m);
  }
  const labels = s.finalGuesses(3).map((g) => g.label.toLowerCase());
  assert.ok(labels.some((l) => /justinian|constantinople|hagia sophia|nika/.test(l)), labels.join("|"));
});

// ---------- llm-extract ----------
function fakeFetch(content: string, log: { url: string; init: RequestInit }[]) {
  return (async (url: string, init: RequestInit) => {
    log.push({ url, init });
    return new Response(JSON.stringify({ model: "gemma4:cloud", message: { role: "assistant", content }, done: true }), { status: 200 });
  }) as unknown as typeof fetch;
}
const REPLY = JSON.stringify({ interests: [{ label: "Byzantine history", confidence: 0.9, turns: [1, 2] }] });

test("llm-extract: calls https://ollama.com/api/chat with Bearer key, stream:false, only on due turns", async () => {
  const log: { url: string; init: RequestInit }[] = [];
  const tg = new LlmInterestExtractor({ apiKey: "k-test", everyN: 2, base: "none", fetchImpl: fakeFetch(REPLY, log) });
  assert.deepEqual(await tg.tag("I like Justinian"), []);
  const out = await tg.tag("and Constantinople");
  assert.equal(log.length, 1);
  assert.equal(log[0]!.url, "https://ollama.com/api/chat");
  assert.equal((log[0]!.init.headers as Record<string, string>).authorization, "Bearer k-test");
  const body = JSON.parse(log[0]!.init.body as string);
  assert.equal(body.stream, false);
  assert.equal(body.model, "gemma4:cloud");
  assert.equal(out[0]!.label.toLowerCase(), "byzantine history");
  assert.ok(out[0]!.id.startsWith("o:"));
  assert.ok((out[0]!.observeWeight ?? 0) > 0.7);
});

test("llm-extract: cache hit spends no call, cap refuses, offline never fetches", async () => {
  const log: { url: string; init: RequestInit }[] = [];
  const store = new Map<string, string>();
  const cache = { get: (k: string) => store.get(k), set: (k: string, v: string) => void store.set(k, v) };
  let budget = 1;
  const mk = () => new LlmInterestExtractor({ everyN: 1, base: "none", fetchImpl: fakeFetch(REPLY, log), cache, reserveCall: () => budget-- > 0 });
  const a = mk();
  await a.tag("I like Justinian");
  assert.deepEqual(a.calls, { network: 1, cached: 0, refused: 0, failed: 0, retried: 0, http: { 200: 1 }, lastError: null });
  const b = mk();
  await b.tag("I like Justinian"); // same prompt: cached
  await b.tag("something new"); // over the cap: refused
  assert.deepEqual({ ...b.calls, lastError: undefined }, { network: 0, cached: 1, refused: 1, failed: 0, retried: 0, http: {}, lastError: undefined });
  const c = new LlmInterestExtractor({ everyN: 1, base: "none", offline: true, fetchImpl: fakeFetch(REPLY, log) });
  await c.tag("brand new prompt");
  assert.equal(c.calls.refused, 1);
  assert.equal(log.length, 1);
});

test("llm-extract: gpt-oss gets num_predict >= 512 and no json format; parser is tolerant", () => {
  const p = buildExtractorPrompt(["hello"], "gpt-oss:20b-cloud");
  const b = requestBody(p, 100) as { options: { num_predict: number }; format?: unknown; stream: boolean };
  assert.ok(b.options.num_predict >= 512);
  assert.equal(b.format, undefined);
  assert.equal(b.stream, false);
  assert.notEqual(promptKey(p), promptKey(buildExtractorPrompt(["hello"], "gemma4:cloud")));
  const fenced = JSON.stringify({ message: { content: "Sure!\n```json\n" + REPLY + "\n```" } });
  assert.equal(parseExtractorResponse(fenced)[0]!.label.toLowerCase(), "byzantine history");
  assert.deepEqual(parseExtractorResponse("garbage"), []);
});

test("llm-extract: the system prompt names no persona passion (no examples that could leak)", () => {
  const sp = EXTRACTOR_SYSTEM_PROMPT.toLowerCase();
  for (const w of PERSONA_WORDS) assert.ok(!new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(sp), `prompt mentions "${w}"`);
  for (const l of curatedLabels) assert.ok(!sp.includes(l), `prompt mentions curated "${l}"`);
});

// ---------- llm-extract merge: the extractor's latest answer leads the final guesses ----------
function seqFetch(contents: string[]) {
  let i = 0;
  return (async () => new Response(JSON.stringify({ message: { role: "assistant", content: contents[Math.min(i++, contents.length - 1)] }, done: true }), { status: 200 })) as unknown as typeof fetch;
}
const RANKED = JSON.stringify({ interests: [
  { label: "peloton workouts", confidence: 0.6, turns: [5] },
  { label: "craft beer", confidence: 0.9, turns: [1, 2, 3, 4] },
  { label: "fantasy football", confidence: 0.8, turns: [2, 3] },
] });
const MSGS = ["I did a Peloton ride this morning", "then a craft beer at the brewery", "fantasy football draft tonight",
  "the Peloton instructor was intense", "more Peloton tomorrow, the climb ride", "and a hazy IPA after"];
async function mergeSession(opts: Record<string, unknown>, contents = [RANKED]) {
  const s = new HarnessSession({ userId: "m", backend: new MockBackend(3), store: null, seed: 3,
    tagger: new LlmInterestExtractor({ everyN: 3, fetchImpl: seqFetch(contents), ...opts }) });
  await s.start();
  for (const m of MSGS) await s.reply(m);
  return s;
}

test("llm-extract merge (default lead): final guesses follow the extractor's own order; kp duplicates dropped", async () => {
  const s = await mergeSession({});
  const g = s.finalGuesses(3).map((x) => x.label.toLowerCase());
  assert.deepEqual(g, ["peloton workouts", "craft beer", "fantasy football"]);
  const prior = s.tagger.rankPrior!()!;
  assert.equal(prior.weight, Infinity);
  assert.ok(prior.suppress!.some((t) => t.startsWith("kp:") && /peloton/.test(t)), JSON.stringify(prior.suppress));
  assert.ok(!s.finalGuesses(5).some((x) => x.topic.startsWith("kp:") && /^peloton$/.test(x.label.toLowerCase())));
});

test("llm-extract merge: an empty reply keeps the previous answer; no answer yet = keyphrase ranking; rank none = no prior", async () => {
  const empty = JSON.stringify({ interests: [] });
  const keep = await mergeSession({}, [RANKED, empty]);
  assert.equal(keep.finalGuesses(1)[0]!.label.toLowerCase(), "peloton workouts");
  const none = await mergeSession({}, [empty]);
  assert.equal(none.tagger.rankPrior!(), null);
  assert.ok(none.finalGuesses(3).length > 0); // keyphrase-idf fills everything
  const old = await mergeSession({ rank: "none" });
  assert.equal(old.tagger.rankPrior!(), null);
  assert.equal(createTagger({ kind: "keyphrase-idf" }).rankPrior, undefined); // non-LLM taggers: ranking unchanged
});

// ---------- provider path: local URL, HTTP status, bounded 5xx retry ----------
function statusFetch(statuses: number[], log: Array<{ url: string; init: RequestInit }>) {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    log.push({ url, init });
    const st = statuses[Math.min(i++, statuses.length - 1)]!;
    return st === 200
      ? new Response(JSON.stringify({ message: { role: "assistant", content: REPLY }, done: true }), { status: 200 })
      : new Response("upstream says no", { status: st });
  }) as unknown as typeof fetch;
}

test("llm-extract: local Ollama URL needs no key and sends no Authorization; non-cloud model refused locally", async () => {
  assert.ok(isLocalOllamaUrl("http://127.0.0.1:11434") && isLocalOllamaUrl("http://localhost:11434/") && !isLocalOllamaUrl("https://ollama.com"));
  assert.ok(isCloudModelTag("gemma4:cloud") && isCloudModelTag("gpt-oss:120b-cloud") && !isCloudModelTag("gemma3:4b"));
  const log: Array<{ url: string; init: RequestInit }> = [];
  const tg = new LlmInterestExtractor({ baseUrl: "http://localhost:11434", apiKey: "should-not-be-sent", everyN: 1, base: "none", fetchImpl: statusFetch([200], log) });
  const out = await tg.tag("I like Justinian");
  assert.equal(log[0]!.url, "http://localhost:11434/api/chat");
  assert.equal((log[0]!.init.headers as Record<string, string>).authorization, undefined);
  assert.equal(out[0]!.label.toLowerCase(), "byzantine history");
  const loc = new LlmInterestExtractor({ baseUrl: "http://127.0.0.1:11434", model: "gemma3:4b", everyN: 1, base: "none", fetchImpl: statusFetch([200], log) });
  assert.deepEqual(await loc.tag("x"), []);
  assert.equal(log.length, 1); // no request
  assert.equal(loc.calls.refused, 1);
  assert.match(loc.calls.lastError!, /not a :cloud tag/);
});

test("llm-extract: 5xx retried twice (each reserved against the cap), 4xx not retried, status surfaced", async () => {
  let reserved = 0;
  const log: Array<{ url: string; init: RequestInit }> = [];
  const ok = new LlmInterestExtractor({ apiKey: "k", everyN: 1, base: "none", retryDelayMs: 1, reserveCall: () => (reserved++, true), fetchImpl: statusFetch([503, 502, 200], log) });
  assert.equal((await ok.tag("Justinian"))[0]!.label.toLowerCase(), "byzantine history");
  assert.equal(log.length, 3); assert.equal(reserved, 3);
  assert.deepEqual({ n: ok.calls.network, r: ok.calls.retried, f: ok.calls.failed, h: ok.calls.http }, { n: 3, r: 2, f: 0, h: { 503: 1, 502: 1, 200: 1 } });
  // bounded: 3 attempts max, then failed with the status in lastError
  const bad = new LlmInterestExtractor({ apiKey: "k", everyN: 1, base: "none", retryDelayMs: 1, fetchImpl: statusFetch([500], []) });
  assert.deepEqual(await bad.tag("x"), []);
  assert.equal(bad.calls.network, 3); assert.equal(bad.calls.failed, 1);
  assert.match(bad.calls.lastError!, /extractor HTTP 500/);
  // 4xx: one attempt only
  const four = new LlmInterestExtractor({ apiKey: "k", everyN: 1, base: "none", retryDelayMs: 1, fetchImpl: statusFetch([401], []) });
  await four.tag("x");
  assert.equal(four.calls.network, 1); assert.equal(four.calls.retried, 0);
  assert.match(four.calls.lastError!, /HTTP 401/);
  assert.ok(!/Bearer|\bk\b/.test(four.calls.lastError!));
  // the cap stops retries: 2 calls allowed -> first try + 1 retry, then refused
  let cap = 2;
  const capped = new LlmInterestExtractor({ apiKey: "k", everyN: 1, base: "none", retryDelayMs: 1, reserveCall: () => cap-- > 0, fetchImpl: statusFetch([503], []) });
  await capped.tag("x");
  assert.equal(capped.calls.network, 2); assert.equal(capped.calls.refused, 1);
  assert.match(capped.calls.lastError!, /call cap reached before retry 2 .*HTTP 503/);
});

// ---------- final labels unique; rank "lead-eeg" ----------
test("final guesses: one guess per label (no 'alright' + 'alright' from kp:alright and kp:alright-2)", () => {
  const map = InterestMap.fresh("u");
  for (const [id, m] of [["kp:alright", 0.9], ["kp:alright-2", 0.8], ["kp:pinball", 0.7]] as const) { map.defineTopic(id, "alright"); map.observeTopic(id, m, 1); }
  map.defineTopic("kp:pinball", "pinball");
  const g = finalGuesses(map, [], 3).map((x) => x.label);
  assert.deepEqual(g, ["alright", "pinball"]);
});

test("lead-eeg reorder: only a margin beyond LEAD_EEG_Z*sqrt(1/ka+1/kb) moves a label; noise / missing EEG keep the order", () => {
  const snap = (eeg?: number) => ({ turn: 0, hypothesis: null, top: [], ...(eeg !== undefined ? { eegLn: eeg } : {}) });
  // turns 1..8: label B cites turns 7,8 (very high EEG), label A cites 1,2 (low)
  const H = [-1, -1, 0, 0, 0, 0, 3, 3].map((v) => snap(v * 0.1));
  assert.deepEqual(eegReorder(["A", "B"], [[1, 2], [7, 8]], H), ["B", "A"]);
  // a near-tie (A and B both mid) keeps the extractor's order
  assert.deepEqual(eegReorder(["A", "B"], [[3, 4], [5, 7]], H), ["A", "B"]);
  // a label without usable EEG on its turns never moves and is never passed
  assert.deepEqual(eegReorder(["A", "B", "C"], [[1], [], [7, 8]], H), ["A", "B", "C"]);
  // too few EEG turns in the session: unchanged
  assert.deepEqual(eegReorder(["A", "B"], [[1], [2]], [snap(-5), snap(5), snap(), snap()]), ["A", "B"]);
  assert.equal(LEAD_EEG_Z, 1.645);
  // null calibration: i.i.d. noise swaps an adjacent pair (2 vs 2 cited turns) in <= ~6% of sessions
  let swaps = 0, seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  for (let r = 0; r < 2000; r++) {
    const h = Array.from({ length: 11 }, () => snap(gauss()));
    if (eegReorder(["A", "B"], [[2, 3], [8, 9]], h)[0] === "B") swaps++;
  }
  assert.ok(swaps / 2000 < 0.08, String(swaps / 2000));
});

test("llm-extract rank lead-eeg: equals lead without EEG; prior carries cites + preset z", async () => {
  const lead = await mergeSession({});
  const le = await mergeSession({ rank: "lead-eeg" });
  assert.deepEqual(le.finalGuesses(3).map((g) => g.label), lead.finalGuesses(3).map((g) => g.label));
  const pr = le.tagger.rankPrior!()!;
  assert.equal(pr.weight, Infinity); assert.equal(pr.reorderZ, LEAD_EEG_Z);
  assert.deepEqual(pr.cites, [[5], [1, 2, 3, 4], [2, 3]]);
});

// ---------- keyphrase fill junk: evaluative adjectives / intensifiers ----------
test("keyphrase-idf: evaluative adjectives, superlatives and intensified words are not topics; nouns are", () => {
  assert.deepEqual(PERSONA_WORDS.filter((w) => IDF_EVALUATIVE.has(w)), []);
  const keys = (t: string) => idfCandidates(t).map((c) => c.key);
  const k = keys("something dark. i'd make the wizard mode insane and add a few hidden ramps for high scores.");
  assert.ok(!k.some((x) => x.split(" ").includes("insane")), k.join("|"));
  assert.ok(k.includes("wizard") && k.includes("ramp"), k.join("|"));
  assert.ok(!keys("nah just whatever place is closest.").includes("closest"));
  assert.ok(keys("we hiked through the forest").includes("forest")); // not a superlative
  assert.ok(keys("a perfect cradle separation").includes("cradle"));
  const alright = idfCandidates("alright, the flippers were alright");
  assert.ok(!alright.some((c) => c.key === "alright") && alright.some((c) => c.key === "flipper"));
  // after an intensifier a word is graded (adjective-like): kept but halved
  const find = (t: string) => idfCandidates(t).find((c) => c.key === "snazzy");
  const plain = find("that shop is snazzy"), graded = find("that shop is so snazzy");
  assert.ok(plain && graded && graded.key === "snazzy" && Math.abs(graded.score - plain.score / 2) < 1e-9, JSON.stringify([plain, graded]));
});
