/**
 * Topic lexicon v0: keyword matching. Deliberately dumb and deterministic so the
 * sim runner is reproducible offline. Swap for an embedding/LLM tagger later behind
 * the same detectTopics() signature.
 */
export const TOPIC_LEXICON: Record<string, { label: string; keywords: string[] }> = {
  games: { label: "video games", keywords: ["game", "games", "gaming", "zelda", "level", "boss", "speedrun", "console", "rpg", "indie", "steam", "controller"] },
  music: { label: "music", keywords: ["music", "song", "songs", "band", "guitar", "album", "concert", "synth", "piano", "melody", "playlist"] },
  cooking: { label: "cooking and food", keywords: ["cook", "cooking", "recipe", "food", "bake", "baking", "kitchen", "spice", "dinner", "ramen", "bread"] },
  sports: { label: "sports", keywords: ["sport", "sports", "soccer", "football", "basketball", "team", "match", "league", "score", "climbing"] },
  space: { label: "space and astronomy", keywords: ["space", "planet", "planets", "star", "stars", "galaxy", "telescope", "rocket", "nasa", "orbit", "astronomy", "mars"] },
  programming: { label: "programming", keywords: ["code", "coding", "programming", "bug", "compiler", "typescript", "python", "engine", "shader", "algorithm"] },
  art: { label: "art and drawing", keywords: ["art", "draw", "drawing", "paint", "painting", "sketch", "color", "illustration", "canvas", "pixel"] },
  travel: { label: "travel", keywords: ["travel", "trip", "country", "city", "flight", "japan", "backpacking", "abroad", "visit", "hostel"] },
  film: { label: "film and TV", keywords: ["movie", "movies", "film", "films", "show", "series", "director", "scene", "cinema", "anime"] },
  nature: { label: "nature and animals", keywords: ["nature", "animal", "animals", "dog", "cat", "bird", "birds", "forest", "hiking", "garden", "plants"] },
  history: { label: "history", keywords: ["history", "ancient", "war", "empire", "medieval", "rome", "century", "historical", "castle"] },
  fitness: { label: "fitness", keywords: ["gym", "workout", "lifting", "run", "running", "marathon", "fitness", "training", "yoga", "cardio"] },
};

export const TOPICS = Object.keys(TOPIC_LEXICON);

/** Labels for open-vocabulary topics discovered at runtime (filled by InterestMap / taggers). */
export const DYNAMIC_TOPIC_LABELS = new Map<string, string>();

export function topicLabel(topic: string): string {
  return TOPIC_LEXICON[topic]?.label ?? DYNAMIC_TOPIC_LABELS.get(topic) ?? topic;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/** Returns topic -> number of keyword hits in the text. */
export function topicHits(text: string): Record<string, number> {
  const words = tokenize(text);
  const out: Record<string, number> = {};
  for (const [topic, { keywords }] of Object.entries(TOPIC_LEXICON)) {
    let hits = 0;
    for (const w of words) if (keywords.includes(w)) hits++;
    if (hits > 0) out[topic] = hits;
  }
  return out;
}

/** Topics mentioned in the text, strongest first. */
export function detectTopics(text: string): string[] {
  return Object.entries(topicHits(text))
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}
