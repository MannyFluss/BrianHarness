/**
 * Open-vocabulary topic tagging. Three taggers behind one interface:
 *  - LexiconTagger  (default, offline, deterministic): the 12 broad TOPIC_LEXICON topics PLUS a
 *    curated list of ~45 specific hobbies (ham radio, watch restoration, birding big year, ...),
 *    each with a broad parent. Specific topics are only created when mentioned.
 *    NOTE: this list includes the Researcher's 8 persona passions, so lexicon results on that set
 *    are optimistic; use "keyphrase" or "ollama" to measure true open-vocab behaviour.
 *  - KeyphraseTagger: lexicon + salient recurring phrases ("kp:<phrase>") for anything else.
 *  - OllamaTagger: asks a local Ollama model for 1-3 specific topic labels as JSON (free, local);
 *    falls back to the lexicon on any error. Lexicon hits are always unioned in.
 */
import { TOPIC_LEXICON, TOPICS, tokenize, topicHits } from "./topics.js";
import { normalizeOllamaBaseUrl } from "./providers/ollama.js";
import { KeyphraseIdfTagger, type KeyphraseIdfOptions } from "./tagger-idf.js";
import { LlmInterestExtractor, type LlmExtractorOptions } from "./llm-extractor.js";

export interface TopicTag {
  /** stable id (lexicon key, "x:<slug>" for specific topics, "kp:<phrase>" for keyphrases) */
  id: string;
  label: string;
  /** broad lexicon topic this refines */
  parent?: string;
  /** strength (keyword hits) */
  weight: number;
  /**
   * interest-map evidence weight when the user mentions this topic unprompted (default 0.7).
   * keyphrase-idf scales it by distinctiveness; the LLM extractor by confidence.
   */
  observeWeight?: number;
}

/** A tagger's whole-conversation opinion for the final ranking (see final-guesses.ts FinalGuessOptions.prior). */
export interface RankPrior {
  /** topic ids, best first (e.g. the LLM extractor's latest answer in its own order) */
  ranked: string[];
  /** Infinity = these lead the final guesses in this order (rest filled by the engagement ranking);
   *  finite w = soft prior, adds w * 0.85^rank to the engagement score */
  weight: number;
  /** topic ids never shown as guesses (e.g. keyphrase duplicates of a ranked label) */
  suppress?: string[];
}

export interface TopicTagger {
  readonly kind: string;
  tag(text: string, signal?: AbortSignal): Promise<TopicTag[]>;
  /** optional ranking prior for finalGuesses; taggers without one keep the plain engagement ranking */
  rankPrior?(): RankPrior | null;
}

/**
 * Which curated vocabulary a tagger may use.
 *   full     broad topics + every curated specific hobby (DEFAULT; note: the curated list contains the
 *            8 Phase A sim persona passions verbatim, so with it a "correct" specific guess can be a
 *            leaked label, not discovered vocabulary; see SIM_PERSONA_SPECIFICS)
 *   generic  broad topics + curated specifics MINUS SIM_PERSONA_SPECIFICS
 *   broad    broad topics only (space, cooking, ...), no curated specifics
 *   none     nothing curated: every label comes from the user's own words (keyphrases)
 */
export type LexiconVariant = "full" | "generic" | "broad" | "none";

export type TopicTaggerSpec =
  | { kind: "lexicon"; variant?: LexiconVariant }
  | { kind: "lexicon-generic" }
  | { kind: "keyphrase"; minRepeats?: number; lexicon?: LexiconVariant }
  /** leak-free open vocabulary: keyphrase with lexicon "none" */
  | { kind: "keyphrase-only"; minRepeats?: number }
  /** keyphrase with lexicon "generic" */
  | { kind: "keyphrase-generic"; minRepeats?: number }
  /** leak-free, IDF-weighted distinctive terms + proper nouns, clustered across turns (tagger-idf.ts) */
  | ({ kind: "keyphrase-idf" } & KeyphraseIdfOptions)
  /** LLM interest extractor every N turns on top of keyphrase-idf (llm-extractor.ts) */
  | ({ kind: "llm-extract" } & LlmExtractorOptions)
  | { kind: "ollama"; model: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch };

/** Specific (open-vocab) topics: id -> label, parent, phrases (lowercase, matched on word boundaries). */
export const SPECIFIC_TOPICS: Record<string, { label: string; parent?: string; phrases: string[] }> = {
  "x:ham-radio": { label: "amateur (ham) radio", phrases: ["ham radio", "amateur radio", "morse", "morse code", "qso", "call sign", "callsign", "dx", "antenna", "shortwave", "hf band", "contest log", "transceiver"] },
  "x:watch-restoration": { label: "restoring vintage mechanical watches", parent: "art", phrases: ["watch", "watches", "wristwatch", "wristwatches", "movement", "movements", "mainspring", "balance wheel", "horology", "watchmaking", "escapement", "caseback", "crystal", "dial"] },
  "x:birding-big-year": { label: "competitive birding (big year)", parent: "nature", phrases: ["big year", "life list", "lifer", "lifers", "ebird", "twitching", "twitcher", "warbler", "warblers", "species count", "birding", "birder", "birders", "birdwatching", "binoculars"] },
  "x:slime-molds": { label: "slime molds (myxomycetes)", parent: "nature", phrases: ["slime mold", "slime molds", "slime mould", "physarum", "myxomycete", "myxomycetes", "plasmodium", "oat flakes", "fruiting bodies"] },
  "x:mycology": { label: "mushrooms and foraging", parent: "nature", phrases: ["mushroom", "mushrooms", "fungi", "fungus", "foraging", "mycology", "spore", "spores", "mycelium", "chanterelle", "morel"] },
  "x:nes-tetris": { label: "classic NES Tetris", parent: "games", phrases: ["tetris", "nes", "rolling", "hypertapping", "ctwc", "level 29", "killscreen", "kill screen", "tetromino", "line clears"] },
  "x:urban-sketching": { label: "urban sketching", parent: "art", phrases: ["urban sketching", "sketchbook", "watercolor", "watercolour", "ink and wash", "on location", "plein air", "fountain pen", "sketchers", "facades"] },
  "x:byzantine-history": { label: "Byzantine Empire history", parent: "history", phrases: ["byzantine", "byzantium", "constantinople", "justinian", "basil ii", "theodora", "hagia sophia", "komnenos", "macedonian dynasty", "eastern roman"] },
  "x:beekeeping": { label: "beekeeping", parent: "nature", phrases: ["beekeeping", "beekeeper", "hive", "hives", "bees", "honey", "queen bee", "brood", "varroa", "apiary", "swarm", "frames", "smoker"] },
  "x:sourdough": { label: "sourdough baking", parent: "cooking", phrases: ["sourdough", "starter", "levain", "crumb", "proofing", "banneton", "hydration"] },
  "x:fermentation": { label: "fermentation", parent: "cooking", phrases: ["ferment", "fermenting", "fermentation", "kimchi", "kombucha", "miso", "koji", "sauerkraut"] },
  "x:coffee": { label: "specialty coffee", parent: "cooking", phrases: ["espresso", "pour over", "roast", "roasting", "grinder", "latte art", "single origin"] },
  "x:astrophotography": { label: "astrophotography", parent: "space", phrases: ["astrophotography", "astrophoto", "nebula", "stacking", "long exposure", "star tracker", "deep sky"] },
  "x:rocketry": { label: "model rocketry", parent: "space", phrases: ["model rocket", "rocketry", "estes", "solid motor", "launch pad"] },
  "x:speedrunning": { label: "speedrunning", parent: "games", phrases: ["speedrun", "speedrunning", "any%", "glitch", "world record", "splits"] },
  "x:board-games": { label: "board games", parent: "games", phrases: ["board game", "board games", "boardgame", "catan", "meeple", "tabletop", "dnd", "d&d", "dungeon master", "dungeons"] },
  "x:chess": { label: "chess", parent: "games", phrases: ["chess", "opening", "endgame", "gambit", "lichess", "grandmaster", "elo"] },
  "x:retro-computing": { label: "retro computing", parent: "programming", phrases: ["commodore", "c64", "amiga", "retro computer", "vintage computer", "6502", "z80", "crt"] },
  "x:electronics": { label: "electronics tinkering", parent: "programming", phrases: ["arduino", "raspberry pi", "soldering", "circuit", "breadboard", "pcb", "oscilloscope"] },
  "x:mechanical-keyboards": { label: "mechanical keyboards", parent: "programming", phrases: ["mechanical keyboard", "keycaps", "keyboard switches", "lubing", "keebs"] },
  "x:3d-printing": { label: "3D printing", parent: "programming", phrases: ["3d printing", "3d printer", "filament", "slicer", "resin printer"] },
  "x:woodworking": { label: "woodworking", parent: "art", phrases: ["woodworking", "lathe", "chisel", "dovetail", "joinery", "hand plane", "workbench"] },
  "x:knitting": { label: "knitting and fiber arts", parent: "art", phrases: ["knit", "knitting", "crochet", "yarn", "spinning wheel", "weaving"] },
  "x:pottery": { label: "pottery", parent: "art", phrases: ["pottery", "ceramics", "kiln", "glaze", "wheel throwing", "clay"] },
  "x:calligraphy": { label: "calligraphy", parent: "art", phrases: ["calligraphy", "lettering", "nib", "copperplate", "brush pen"] },
  "x:photography": { label: "photography", parent: "art", phrases: ["photography", "camera", "lens", "aperture", "film camera", "darkroom"] },
  "x:origami": { label: "origami", parent: "art", phrases: ["origami", "paper folding", "crease pattern"] },
  "x:aquariums": { label: "aquariums and fishkeeping", parent: "nature", phrases: ["aquarium", "aquascaping", "fishkeeping", "cichlid", "reef tank", "shrimp tank"] },
  "x:gardening": { label: "gardening", parent: "nature", phrases: ["vegetable garden", "seedlings", "compost", "raised beds", "tomatoes", "pruning"] },
  "x:bonsai": { label: "bonsai", parent: "nature", phrases: ["bonsai", "juniper", "nebari", "repotting"] },
  "x:herpetology": { label: "reptiles and amphibians", parent: "nature", phrases: ["reptile", "reptiles", "gecko", "snake", "snakes", "frogs", "salamander", "herping"] },
  "x:fossils": { label: "fossil hunting", parent: "history", phrases: ["fossil", "fossils", "trilobite", "ammonite", "paleontology", "dinosaur"] },
  "x:genealogy": { label: "genealogy", parent: "history", phrases: ["genealogy", "family tree", "ancestry", "ancestors", "census records"] },
  "x:military-history": { label: "military history", parent: "history", phrases: ["battle", "battles", "napoleon", "ww2", "wwii", "regiment", "tactics"] },
  "x:trains": { label: "trains and railways", parent: "travel", phrases: ["train", "trains", "railway", "railroad", "locomotive", "model railway", "steam engine"] },
  "x:aviation": { label: "aviation", parent: "travel", phrases: ["aviation", "pilot", "cockpit", "aircraft", "plane spotting", "cessna"] },
  "x:sailing": { label: "sailing", parent: "sports", phrases: ["sailing", "sailboat", "regatta", "tacking", "dinghy"] },
  "x:climbing": { label: "rock climbing", parent: "sports", phrases: ["bouldering", "climbing", "crag", "belay", "send", "crimps"] },
  "x:cycling": { label: "cycling", parent: "fitness", phrases: ["cycling", "bike", "bikes", "peloton", "gravel ride", "century ride"] },
  "x:running": { label: "distance running", parent: "fitness", phrases: ["marathon", "ultramarathon", "trail running", "5k", "10k", "personal best"] },
  "x:jazz": { label: "jazz", parent: "music", phrases: ["jazz", "bebop", "improvisation", "coltrane", "standards", "big band"] },
  "x:vinyl": { label: "vinyl record collecting", parent: "music", phrases: ["vinyl", "record collection", "turntable", "pressing", "crate digging"] },
  "x:modular-synths": { label: "modular synthesizers", parent: "music", phrases: ["modular synth", "eurorack", "oscillator", "patch cables", "sequencer"] },
  "x:language-learning": { label: "learning languages", parent: "travel", phrases: ["language learning", "duolingo", "vocabulary", "fluent", "conjugation", "grammar"] },
  "x:puzzles": { label: "puzzles", parent: "games", phrases: ["crossword", "crosswords", "sudoku", "jigsaw", "cryptic"] },
  "x:magic": { label: "stage magic and card tricks", parent: "art", phrases: ["card trick", "card tricks", "sleight of hand", "magician", "close-up magic"] },
};

const STOP = new Set("a about after again all also am an and any are as at be because been before being but by can could did do does doing done dont down each even ever every few for from get gets getting go going got had has have having he her here hers him his how i id if im in into is it its ive just kind know like lot lots love make me more most much my never no not now of off oh ok okay on one only or other our out over pretty probably quite really right same say see she should since so some something still such sure than that thats the their them then there these they thing things think this those though through time to too try up us very want was way we well were what when where which while who why will with would yeah yes yet you your youre actually always maybe usually stuff guess mean bit day days week weekend lately year years people started start honestly mostly sometimes often definitely totally basically literally super cool nice good great fun enjoy kinda sorta little recently anyway whatever else around back last first next many feel felt tell told talk talking cause sounds sound thanks haha lol hmm already ago lately favorite favourite especially usually depends rather prefer either neither probably i'd i'll i've that's it's don't didn't can't won't".split(" "));
/** -ly adverbs ("honestly", "mostly") are style, not topics; keep the few -ly nouns. */
const LY_NOUNS = new Set(["family", "italy", "assembly", "butterfly", "dragonfly", "firefly", "anomaly", "supply", "ally", "rally", "jelly", "belly", "bully", "lily", "july", "holly", "polly", "monopoly"]);
const isFillerWord = (w: string) => STOP.has(w) || (w.length >= 5 && w.endsWith("ly") && !LY_NOUNS.has(w));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phraseRe = new Map<string, RegExp>();
function countPhrase(text: string, phrase: string): number {
  let re = phraseRe.get(phrase);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${esc(phrase)}(?=$|[^a-z0-9])`, "g");
    phraseRe.set(phrase, re);
  }
  return (text.match(re) ?? []).length;
}

/**
 * Curated specific topics that are, verbatim, the hidden passions of the 8 Phase A sim personas
 * (eeg-harness-sim/personas.json p01..p08). Dropped by the "generic" lexicon variant.
 */
export const SIM_PERSONA_SPECIFICS: readonly string[] = [
  "x:birding-big-year", "x:watch-restoration", "x:slime-molds", "x:ham-radio",
  "x:nes-tetris", "x:urban-sketching", "x:byzantine-history", "x:beekeeping",
];

/**
 * Broad lexicon + curated specific topics. Specific topics need 1 strong phrase (2+ words) or 2 hits.
 * variant: see LexiconVariant ("full" = historical behaviour).
 */
export function lexiconTags(text: string, variant: LexiconVariant = "full"): TopicTag[] {
  if (variant === "none") return [];
  let rest = text.toLowerCase();
  const specific: TopicTag[] = [];
  const curated = variant === "broad" ? [] : Object.entries(SPECIFIC_TOPICS).filter(([id]) => variant === "full" || !SIM_PERSONA_SPECIFICS.includes(id));
  for (const [id, t] of curated) {
    let hits = 0, strong = false;
    const matched: string[] = [];
    for (const p of t.phrases) {
      const c = countPhrase(rest, p);
      if (c) {
        hits += c;
        matched.push(p);
        if (p.includes(" ") || p.length >= 9) strong = true;
      }
    }
    if (hits >= 2 || strong) {
      specific.push({ id, label: t.label, ...(t.parent ? { parent: t.parent } : {}), weight: hits + (strong ? 1 : 0) });
      // multi-word phrases are consumed so "morse code" doesn't also count as programming's "code"
      for (const p of matched) if (p.includes(" ")) rest = rest.split(p).join(" ");
    }
  }
  const broad: TopicTag[] = Object.entries(topicHits(rest)).map(([id, w]) => ({ id, label: TOPIC_LEXICON[id]!.label, weight: w }));
  return [...specific, ...broad].sort((a, b) => b.weight - a.weight);
}

/** open-vocab (specific) topic ids: lexicon specifics, Ollama labels, keyphrases */
export const isSpecificTopic = (id: string) => /^(x|o|kp):/.test(id);

export class LexiconTagger implements TopicTagger {
  readonly kind: string;
  constructor(private variant: LexiconVariant = "full") {
    this.kind = variant === "full" ? "lexicon" : `lexicon-${variant}`;
  }
  async tag(text: string) {
    return lexiconTags(text, this.variant);
  }
}

/** Lexicon + recurring salient phrases for interests nobody listed. */
export class KeyphraseTagger implements TopicTagger {
  readonly kind: string;
  private seen = new Map<string, number>();
  /** phrase -> broad topic -> co-occurrence count; the phrase's parent is the argmax */
  private cooc = new Map<string, Map<string, number>>();
  /** lexicon "none": word -> word -> messages they shared (phrase clusters for the parent roll-up) */
  private wordCooc = new Map<string, Map<string, number>>();
  constructor(private minRepeats = 2, private lexicon: LexiconVariant = "full") {
    this.kind = lexicon === "full" ? "keyphrase" : lexicon === "none" ? "keyphrase-only" : `keyphrase-${lexicon}`;
  }
  async tag(text: string) {
    const tags = lexiconTags(text, this.lexicon);
    if (tags.some((t) => t.id.startsWith("x:"))) return tags;
    const broad = tags.filter((t) => !t.id.includes(":")).map((t) => t.id);
    const toks = tokenize(text).map((w) => w.replace(/'s$/, ""));
    const words = toks.filter((w) => w.length >= 4 && !isFillerWord(w) && !/^\d+$/.test(w));
    const grams = new Set<string>(words);
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = toks[i]!, b = toks[i + 1]!;
      if (!isFillerWord(a) && !isFillerWord(b) && a.length > 2 && b.length > 2 && !/^\d+$/.test(a) && !/^\d+$/.test(b)) grams.add(`${a} ${b}`);
    }
    const uniq = [...new Set(words)];
    if (this.lexicon === "none") {
      for (const a of uniq) {
        const m = this.wordCooc.get(a) ?? new Map<string, number>();
        for (const b of uniq) if (b !== a) m.set(b, (m.get(b) ?? 0) + 1);
        this.wordCooc.set(a, m);
      }
    }
    for (const g of grams) {
      this.seen.set(g, (this.seen.get(g) ?? 0) + 1);
      if (broad.length) {
        const m = this.cooc.get(g) ?? new Map<string, number>();
        for (const t of broad) m.set(t, (m.get(t) ?? 0) + 1 / broad.length);
        this.cooc.set(g, m);
      }
    }
    // A phrase that shows up alongside many different topics ("depends", "i guess so") is how
    // this user talks, not what they talk about: drop it.
    const generic = (g: string) => {
      const m = this.cooc.get(g);
      if (!m || m.size < 3) return false;
      let tot = 0, top = 0;
      for (const c of m.values()) { tot += c; top = Math.max(top, c); }
      return top / tot < 0.5;
    };
    const recurring = [...grams].filter((g) => (this.seen.get(g) ?? 0) >= this.minRepeats && !generic(g)).sort((a, b) => b.split(" ").length - a.split(" ").length || (this.seen.get(b)! - this.seen.get(a)!));
    const best = recurring[0];
    if (best) {
      // Roll up to the broad topic this phrase keeps appearing with; a phrase that never
      // co-occurs with a known topic stays an orphan (an open-vocab passion, e.g. "lockpicking").
      let parent: string | undefined;
      let top = 0;
      for (const [t, c] of this.cooc.get(best) ?? []) if (c > top) { top = c; parent = t; }
      if (!parent && this.lexicon === "none") {
        // No lexicon to roll up into: the parent is the phrase cluster, i.e. the recurring word in
        // this message that has shared the most messages with the phrase's words (or the phrase
        // itself when nothing clusters with it). Lets "ham radio", "radio contest", "radio" consolidate.
        const cluster = this.clusterHead(best, uniq);
        if (cluster && cluster !== best) {
          const cid = `kp:${cluster}`;
          if (!tags.some((t) => t.id === cid)) tags.push({ id: cid, label: cluster, weight: this.seen.get(cluster) ?? 1 });
          parent = cid;
        }
      }
      tags.push({ id: `kp:${best.replace(/\s+/g, "-")}`, label: best, parent, weight: this.seen.get(best)! });
    }
    return tags;
  }
  private clusterHead(phrase: string, inMessage: string[]): string | undefined {
    const parts = phrase.split(" ");
    let best: string | undefined, bestScore = 0;
    for (const w of inMessage) {
      if ((this.seen.get(w) ?? 0) < this.minRepeats) continue;
      // a word of the phrase itself counts with its own frequency; others by shared messages
      const score = parts.includes(w) ? (this.seen.get(w) ?? 0) : Math.min(...parts.map((p) => this.wordCooc.get(p)?.get(w) ?? 0));
      if (score >= this.minRepeats && (score > bestScore || (score === bestScore && best !== undefined && (this.seen.get(w) ?? 0) > (this.seen.get(best) ?? 0)))) { bestScore = score; best = w; }
    }
    return best;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** Local Ollama model as a tagger (free). Falls back to the lexicon on any failure. */
export class OllamaTagger implements TopicTagger {
  readonly kind = "ollama";
  private known = new Map<string, string>(); // slug -> id, merges near-duplicates across turns
  constructor(private cfg: { model: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {}
  async tag(text: string, signal?: AbortSignal): Promise<TopicTag[]> {
    const lex = lexiconTags(text);
    try {
      const f = this.cfg.fetchImpl ?? fetch;
      const res = await f(`${normalizeOllamaBaseUrl(this.cfg.baseUrl)}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.cfg.model,
          stream: false,
          format: "json",
          options: { temperature: 0, seed: 1 },
          messages: [
            { role: "system", content: `Extract the specific hobbies or interests a chat message talks about. Reply JSON {"topics":[{"label":"...","parent":"..."}]} with 0-3 items. label: specific, 1-5 words, lowercase (e.g. "ham radio", "vintage watch restoration"), not generic ("hobbies", "work"). parent: the closest of ${TOPICS.join(", ")}, or "none".` },
            { role: "user", content: text.slice(0, 2000) },
          ],
        }),
        signal: signal ?? AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const body = (await res.json()) as { message?: { content?: string } };
      const parsed = JSON.parse(body.message?.content ?? "{}") as { topics?: Array<{ label?: string; parent?: string }> };
      const out = [...lex];
      for (const t of (parsed.topics ?? []).slice(0, 3)) {
        const label = (t.label ?? "").trim().toLowerCase();
        if (!label || label.length > 60) continue;
        const s = slug(label);
        if (!s) continue;
        // merge with a lexicon specific topic or an earlier label when one contains the other
        const lexSpecific = out.find((x) => x.id.startsWith("x:") && (x.label.toLowerCase().includes(label) || label.includes(x.id.slice(2).replace(/-/g, " "))));
        if (lexSpecific) continue;
        let id = this.known.get(s);
        if (!id) for (const [k, v] of this.known) if (k.includes(s) || s.includes(k)) id = v;
        id ??= `o:${s}`;
        this.known.set(s, id);
        const parent = t.parent && TOPICS.includes(t.parent) ? t.parent : undefined;
        if (!out.some((x) => x.id === id)) out.push({ id, label, parent, weight: 2 });
      }
      return out;
    } catch {
      return lex;
    }
  }
}

export function createTagger(spec?: TopicTaggerSpec): TopicTagger {
  switch (spec?.kind ?? "lexicon") {
    case "lexicon":
      return new LexiconTagger((spec as { variant?: LexiconVariant } | undefined)?.variant);
    case "lexicon-generic":
      return new LexiconTagger("generic");
    case "keyphrase":
      return new KeyphraseTagger((spec as { minRepeats?: number }).minRepeats, (spec as { lexicon?: LexiconVariant }).lexicon);
    case "keyphrase-only":
      return new KeyphraseTagger((spec as { minRepeats?: number }).minRepeats, "none");
    case "keyphrase-generic":
      return new KeyphraseTagger((spec as { minRepeats?: number }).minRepeats, "generic");
    case "keyphrase-idf":
      return new KeyphraseIdfTagger(spec as KeyphraseIdfOptions);
    case "llm-extract":
      return new LlmInterestExtractor(spec as LlmExtractorOptions);
    case "ollama":
      return new OllamaTagger(spec as { model: string; baseUrl?: string });
    default:
      throw new Error(`unknown tagger ${spec?.kind}`);
  }
}
