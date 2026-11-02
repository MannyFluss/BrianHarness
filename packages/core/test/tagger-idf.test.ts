// keyphrase-idf: leak-free (no curated list) IDF keyphrase tagger, and the llm-extract tagger option.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HarnessSession, MockBackend, SPECIFIC_TOPICS, createTagger, idfCandidates, IDF_STOPWORDS, zipfOf,
  LlmInterestExtractor, EXTRACTOR_SYSTEM_PROMPT, buildExtractorPrompt, promptKey, requestBody, parseExtractorResponse,
  KeyphraseIdfTagger,
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

test("the bundled frequency list: common words are frequent, rare names are missing / rare", () => {
  assert.ok((zipfOf("the") ?? 0) > 7);
  assert.ok((zipfOf("house") ?? 0) > 4.5);
  assert.ok((zipfOf("constantinople") ?? 9) < 4);
  assert.equal(zipfOf("physarum"), undefined);
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
  assert.deepEqual(a.calls, { network: 1, cached: 0, refused: 0, failed: 0 });
  const b = mk();
  await b.tag("I like Justinian"); // same prompt: cached
  await b.tag("something new"); // over the cap: refused
  assert.deepEqual(b.calls, { network: 0, cached: 1, refused: 1, failed: 0 });
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
