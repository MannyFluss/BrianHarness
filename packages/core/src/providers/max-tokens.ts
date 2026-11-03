/**
 * Director chat reply budget (max_tokens) per model: THE one table to edit. Researcher spec (P0 "reply text stops
 * partway", Nov 2 2026): the app used to send max_tokens 200 for every model, and gpt-oss spends its reasoning
 * tokens out of that same budget (Ollama num_predict counts thinking + content), so replies ended mid-sentence or
 * empty with finish_reason "length".
 *   - listed models: the value below
 *   - reasoning models (REASONING_MODEL_RE): never below REASONING_MIN_MAX_TOKENS, whatever the table/override says
 *   - anything else: DEFAULT_CHAT_MAX_TOKENS
 * The Spider Cloud Worker clamps to its MAX_TOKENS var (2048 in wrangler.toml), so values above 2048 have no effect
 * there. Used ONLY by the Director chat path (SpiderCloudBackend); the interest extractor keeps its own budget.
 */
export const CHAT_MAX_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  "gpt-oss:20b-cloud": 2048,
  "gpt-oss:120b-cloud": 2048,
  "gemma4:cloud": 1024,
});
export const DEFAULT_CHAT_MAX_TOKENS = 2048;
export const REASONING_MIN_MAX_TOKENS = 1500;
/** models that stream reasoning tokens before the reply (they eat the same budget) */
export const REASONING_MODEL_RE = /^(gpt-oss|deepseek-r1|qwq|o[134](-|$))/i;

export function chatMaxTokens(model: string, override?: number): number {
  const fromTable = Object.hasOwn(CHAT_MAX_TOKENS, model) ? CHAT_MAX_TOKENS[model]! : DEFAULT_CHAT_MAX_TOKENS;
  const v = typeof override === "number" && Number.isFinite(override) && override > 0 ? Math.floor(override) : fromTable;
  return REASONING_MODEL_RE.test(model) ? Math.max(v, REASONING_MIN_MAX_TOKENS) : v;
}
