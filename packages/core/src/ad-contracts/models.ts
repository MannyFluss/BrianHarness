/**
 * contract-v1.5: choosable Actor / Director models (Mac model picker).
 *
 * The person picks the Actor and the Director model per session and may change either mid-session. A change is
 * logged as a model_change event and does NOT start a new session (unlike input_mode). Every model is an Ollama Cloud
 * tag the Worker allowlists; anything that is not a cloud tag, and any local / private endpoint, is hard-refused
 * (the judge runner's policy: no local inference, no fallback). The leak judge is NOT in the picker: it stays
 * LEAK_JUDGE_MODEL, pinned by leak_judge.judge_prompt_id (an advanced / ops control may exist separately).
 * Model names may be shown to Manny (he chose them) in every session type, blinded included; they are never put in
 * Actor-visible context (Actor system prompt, history or hint text).
 */
export const MODEL_ROLES = ["actor", "director"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
/** UI defaults (suggestions, not locks) */
export const DEFAULT_ACTOR_MODEL = "gpt-oss:20b-cloud";
export const DEFAULT_DIRECTOR_MODEL = "gpt-oss:120b-cloud";
/** fixed judge model; not user-choosable in the session picker */
export const LEAK_JUDGE_MODEL = "gemma4:cloud";
/** an Ollama Cloud tag: "<name>:cloud" or "<name>:<size>-cloud" (same rule as isCloudModelTag in llm-extractor.ts) */
export const CLOUD_MODEL_TAG_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]*:(?:cloud|[A-Za-z0-9._]*-cloud)$";
const CLOUD_RE = new RegExp(CLOUD_MODEL_TAG_PATTERN);
export const isCloudModel = (tag: string): boolean => CLOUD_RE.test(tag);

/** null = allowed; else why the tag is refused (no request is sent) */
export function modelRefusal(tag: string, workerAllowlist?: readonly string[]): string | null {
  if (!isCloudModel(tag)) return `${JSON.stringify(tag)} is not a :cloud model tag (no local inference)`;
  if (workerAllowlist && !workerAllowlist.includes(tag)) return `${tag} is not on the Worker's model allowlist`;
  return null;
}

/** hosts model traffic must never go to (copied from the judge runner, scripts/judge-mac/runner.ts): null = OK */
export function localEndpointReason(u: URL): string | null {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "0.0.0.0" || h === "::") return "a localhost / .local host";
  if (/ollama/.test(h) && !/(^|\.)ollama\.com$/.test(h)) return "a local Ollama host";
  if (u.port === "11434") return "port 11434 (Ollama)";
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h.replace(/^::ffff:/, ""));
  if (v4) { const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "a loopback / private / link-local IPv4 address"; }
  if (h.includes(":")) { if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith("::ffff:")) return "a loopback / private / link-local IPv6 address"; }
  return null;
}

/**
 * session_start model fields. Canonical for analysis: top-level actor_model / director_model (full tags). The nested
 * models {actor, director} (contract-v1) stays required and MUST equal them (older readers use it). Both describe the
 * models at session start; later changes are model_change lines. null = consistent.
 */
export function sessionModelsViolation(s: { models: { actor: string; director: string }; actor_model?: string; director_model?: string }): string | null {
  if (s.actor_model !== undefined && s.actor_model !== s.models.actor) return "actor_model != models.actor";
  if (s.director_model !== undefined && s.director_model !== s.models.director) return "director_model != models.director";
  return null;
}
