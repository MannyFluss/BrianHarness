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

export interface TopicTag {
  /** stable id (lexicon key, "x:<slug>" for specific topics, "kp:<phrase>" for keyphrases) */
  id: string;
  label: string;
  /** broad lexicon topic this refines */
  parent?: string;
  /** strength (keyword hits) */
  weight: number;
}

export interface TopicTagger {
  readonly kind: string;
  tag(text: string, signal?: AbortSignal): Promise<TopicTag[]>;
}

export type TopicTaggerSpec =
  | { kind: "lexicon" }
  | { kind: "keyphrase"; minRepeats?: number }
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

const STOP = new Set("a about after again all also am an and any are as at be because been before being but by can could did do does doing done dont down each even ever every few for from get gets getting go going got had has have having he her here hers him his how i id if im in into is it its ive just kind know like lot lots love make me more most much my never no not now of off oh ok okay on one only or other our out over pretty probably quite really right same say see she should since so some something still such sure than that thats the their them then there these they thing things think this those though through time to too try up us very want was way we well were what when where which while who why will with would yeah yes yet you your youre actually always maybe usually stuff guess mean bit day days week weekend lately year years people started start".split(" "));

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

/** Broad lexicon + curated specific topics. Specific topics need 1 strong phrase (2+ words) or 2 hits. */
export function lexiconTags(text: string): TopicTag[] {
  let rest = text.toLowerCase();
  const specific: TopicTag[] = [];
  for (const [id, t] of Object.entries(SPECIFIC_TOPICS)) {
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
  readonly kind = "lexicon";
  async tag(text: string) {
    return lexiconTags(text);
  }
}

/** Lexicon + recurring salient phrases for interests nobody listed. */
export class KeyphraseTagger implements TopicTagger {
  readonly kind = "keyphrase";
  private seen = new Map<string, number>();
  constructor(private minRepeats = 2) {}
  async tag(text: string) {
    const tags = lexiconTags(text);
    if (tags.some((t) => t.id.startsWith("x:"))) return tags;
    const words = tokenize(text).map((w) => w.replace(/'s$/, "")).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
    const toks = tokenize(text);
    const grams = new Set<string>(words);
    for (let i = 0; i + 1 < toks.length; i++) if (!STOP.has(toks[i]!) && !STOP.has(toks[i + 1]!) && toks[i]!.length > 2 && toks[i + 1]!.length > 2) grams.add(`${toks[i]} ${toks[i + 1]}`);
    for (const g of grams) this.seen.set(g, (this.seen.get(g) ?? 0) + 1);
    const recurring = [...grams].filter((g) => (this.seen.get(g) ?? 0) >= this.minRepeats).sort((a, b) => b.split(" ").length - a.split(" ").length || (this.seen.get(b)! - this.seen.get(a)!));
    const best = recurring[0];
    if (best) tags.push({ id: `kp:${best.replace(/\s+/g, "-")}`, label: best, parent: tags[0]?.id, weight: this.seen.get(best)! });
    return tags;
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
      const res = await f(`${(this.cfg.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/api/chat`, {
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
      return new LexiconTagger();
    case "keyphrase":
      return new KeyphraseTagger((spec as { minRepeats?: number }).minRepeats);
    case "ollama":
      return new OllamaTagger(spec as { model: string; baseUrl?: string });
    default:
      throw new Error(`unknown tagger ${spec?.kind}`);
  }
}
