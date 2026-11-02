/**
 * ProviderHub: everything the desktop picker needs. Detects what's usable, runs sign-in flows,
 * stores credentials in the user-data dir (encrypted with the OS keychain when a cipher is given),
 * persists the chosen {provider, model}, and builds the backend.
 *
 *   mock         offline templates, always available
 *   ollama       auto-detected local server (GET /api/tags); local models free, *:cloud paid
 *   ollama-cloud https://ollama.com direct API with an Ollama API key (stored like the other keys);
 *                free tier, so not paid for --allow-paid, but it does need the key
 *   openai       ChatGPT subscription sign-in (pi-ai OAuth) or an OpenAI API key
 *   claude-code  your Claude Pro/Max login via the official Claude Code CLI (recommended Claude path)
 *   anthropic    Claude Pro/Max sign-in via pi-ai OAuth (see warning) or an Anthropic API key
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelBackend } from "../backends.js";
import { CLAUDE_CODE_MODELS, detectClaudeCode } from "./claude-code.js";
import { FileCredentialStore, type CredentialCipher } from "./credential-store.js";
import { createBackend, type ProviderKind } from "./factory.js";
import { DEFAULT_OLLAMA_URL, OLLAMA_CLOUD_DEFAULT_MODEL, detectOllama, detectOllamaCloud } from "./ollama.js";
import { readApiKey, type CredentialStoreLike } from "../platform/credentials.js";
import { DEFAULT_PI_MODELS, createPiModels, type PiModels } from "./pi-ai.js";
import { SPIDER_CLOUD_DEFAULT_MODEL, SPIDER_CREDENTIAL_ID, listSpiderCloudModels, normalizeSpiderUrl } from "./spider-cloud.js";

export interface ProviderChoice {
  provider: ProviderKind;
  model?: string;
}
export interface HubSettings extends ProviderChoice {
  ollamaUrl?: string;
  /** llm-extract prompt rollback flag (absent = DEFAULT_EXTRACTOR_PROMPT_VERSION, v2) */
  extractorPromptVersion?: "v1" | "v2";
  /** Spider Cloud Worker origin (advanced; default SPIDER_CLOUD_URL) */
  spiderCloudUrl?: string;
}
export type HubKeyProvider = "openai" | "anthropic" | "ollama-cloud" | "spider";
export interface ModelOption {
  id: string;
  label: string;
  paid: boolean;
}
export interface ProviderStatus {
  id: ProviderKind;
  label: string;
  available: boolean;
  signedIn: boolean;
  /** how you can authenticate from the app */
  auth: Array<"none" | "oauth" | "api_key" | "cli">;
  /** what the current credential is (e.g. "ChatGPT subscription", "API key", "env OPENAI_API_KEY") */
  authSource?: string;
  models: ModelOption[];
  detail?: string;
  warning?: string;
  /** configurable server URL (Ollama) */
  endpoint?: string;
}
export interface AuthInteractionLike {
  prompt(p: { type: string; message: string; placeholder?: string; options?: readonly { id: string; label: string }[] }): Promise<string>;
  notify(e: { type: string; [k: string]: unknown }): void;
  signal?: AbortSignal;
}

const PI_LABEL: Record<"openai" | "anthropic", string> = { openai: "OpenAI (ChatGPT)", anthropic: "Claude (sign-in / API key)" };
const PREFERRED: Record<"openai" | "anthropic", string[]> = {
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-4.1-mini", "gpt-4o-mini"],
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-4-6", "claude-haiku-4-5"],
};

export class ProviderHub {
  readonly credentials: FileCredentialStore;
  private settingsPath: string;
  private pi: Promise<PiModels> | null = null;
  constructor(private cfg: { dataDir: string; cipher?: CredentialCipher; claudeBin?: string; fetchImpl?: typeof fetch; piModels?: PiModels; ollamaCloudUrl?: string }) {
    mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    this.credentials = new FileCredentialStore(join(cfg.dataDir, "credentials.json"), cfg.cipher);
    this.settingsPath = join(cfg.dataDir, "settings.json");
  }

  private piModels(): Promise<PiModels> {
    if (this.cfg.piModels) return Promise.resolve(this.cfg.piModels);
    return (this.pi ??= createPiModels(this.credentials as unknown as Parameters<typeof createPiModels>[0]));
  }

  settings(): HubSettings {
    try {
      if (existsSync(this.settingsPath)) return { provider: "mock", ...JSON.parse(readFileSync(this.settingsPath, "utf8")) };
    } catch {
      /* fall through */
    }
    return { provider: "mock" };
  }
  saveSettings(s: Partial<HubSettings>): HubSettings {
    const next = { ...this.settings(), ...s };
    const tmp = `${this.settingsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.settingsPath);
    return next;
  }

  async status(): Promise<ProviderStatus[]> {
    const s = this.settings();
    const [ollama, claude, openai, anthropic, ollamaCloud, spider] = await Promise.all([
      detectOllama(s.ollamaUrl ?? DEFAULT_OLLAMA_URL, 1200, this.cfg.fetchImpl),
      detectClaudeCode(this.cfg.claudeBin),
      this.piStatus("openai"),
      this.piStatus("anthropic"),
      this.ollamaCloudStatus(),
      this.spiderStatus(),
    ]);
    return [
      { id: "mock", label: "Mock (offline)", available: true, signedIn: true, auth: ["none"], models: [{ id: "mock", label: "Template Director", paid: false }], detail: "No model, no network. Good for trying the Director." },
      {
        id: "ollama",
        label: "Ollama",
        available: ollama.running && ollama.models.length > 0,
        signedIn: ollama.running,
        auth: ["none"],
        endpoint: ollama.baseUrl,
        models: ollama.models.map((m) => ({ id: m.name, label: `${m.name}${m.parameterSize ? ` · ${m.parameterSize}` : ""}${m.cloud ? " · cloud" : ""}`, paid: m.cloud })),
        detail: ollama.running ? `${ollama.models.length} model(s) at ${ollama.baseUrl}` : `Not running at ${ollama.baseUrl}. Start the Ollama app, then refresh.`,
      },
      spider,
      ollamaCloud,
      openai,
      {
        id: "claude-code",
        label: "Claude (Claude Code login)",
        available: claude.installed,
        signedIn: claude.installed,
        auth: ["cli"],
        models: CLAUDE_CODE_MODELS.map((m) => ({ id: m, label: `Claude ${m[0]!.toUpperCase()}${m.slice(1)}`, paid: true })),
        detail: claude.installed ? `Claude Code ${claude.version}. Uses the account you signed into with \`claude\`.` : "Install Claude Code (npm i -g @anthropic-ai/claude-code), run `claude` once in Terminal and log in, then refresh.",
      },
      anthropic,
    ];
  }

  private async ollamaCloudStatus(): Promise<ProviderStatus> {
    const key = await readApiKey(this.credentials as unknown as CredentialStoreLike, "ollama-cloud");
    const d = key ? await detectOllamaCloud(key, this.cfg.fetchImpl, 4000, this.cfg.ollamaCloudUrl) : null;
    const names = d?.models.length ? d.models.map((m) => m.name) : [OLLAMA_CLOUD_DEFAULT_MODEL];
    return {
      id: "ollama-cloud",
      label: "Ollama Cloud (API key)",
      available: true,
      signedIn: !!key,
      auth: ["api_key"],
      authSource: key ? "API key" : undefined,
      models: names.map((m) => ({ id: m, label: `${m} · cloud`, paid: false })),
      detail: !key
        ? "Paste an Ollama API key (ollama.com -> Settings -> Keys). Runs on Ollama's servers, nothing on this Mac."
        : d?.running
          ? `${d.models.length} model(s) on ollama.com`
          : `Couldn't list models (${d?.error ?? "?"}); ${OLLAMA_CLOUD_DEFAULT_MODEL} is offered anyway.`,
    };
  }

  private async spiderStatus(): Promise<ProviderStatus> {
    const base = normalizeSpiderUrl(this.settings().spiderCloudUrl);
    const token = await readApiKey(this.credentials as unknown as CredentialStoreLike, SPIDER_CREDENTIAL_ID);
    const d = token ? await listSpiderCloudModels(base, token, this.cfg.fetchImpl) : null;
    const names = d?.models ?? [SPIDER_CLOUD_DEFAULT_MODEL];
    return {
      id: "spider-cloud",
      label: "Spider Cloud",
      available: true,
      signedIn: !!token,
      auth: ["api_key"],
      authSource: token ? "device token" : undefined,
      endpoint: base,
      models: names.map((m) => ({ id: m, label: `${m} · Spider Cloud`, paid: false })),
      detail: !token
        ? "Paste your Spider Cloud device token (bhd_…) once. Works after Manny's Worker deploy."
        : d?.live
          ? `${names.length} model(s) at ${base}`
          : `Couldn't list models (${d?.error ?? "?"}); offering the default list.`,
    };
  }

  private async piStatus(id: "openai" | "anthropic"): Promise<ProviderStatus> {
    try {
      const models = await this.piModels();
      const check = await models.checkAuth(id).catch(() => undefined);
      const catalog = (models.getModels(id) as Array<{ id: string; name?: string }>).map((m) => m.id);
      const avail = check ? ((await models.getAvailable(id).catch(() => [])) as Array<{ id: string }>).map((m) => m.id) : [];
      const ids = (avail.length ? avail : catalog).slice();
      const pref = PREFERRED[id];
      ids.sort((a, b) => (pref.indexOf(a) + 1 || 99) - (pref.indexOf(b) + 1 || 99) || a.localeCompare(b));
      return {
        id,
        label: PI_LABEL[id],
        available: true,
        signedIn: !!check,
        auth: ["oauth", "api_key"],
        authSource: check ? `${check.type === "oauth" ? (id === "openai" ? "ChatGPT subscription" : "Claude subscription") : "API key"}${check.source ? ` (${check.source})` : ""}` : undefined,
        models: ids.slice(0, 30).map((m) => ({ id: m, label: m, paid: true })),
        detail: check ? undefined : id === "openai" ? "Sign in with ChatGPT (Plus/Pro) in your browser, or paste an API key." : "Paste an Anthropic API key, or sign in with Claude Pro/Max.",
        warning: id === "anthropic" ? "Anthropic's terms may not allow subscription sign-in from third-party apps; prefer the Claude Code login option or an API key." : undefined,
      };
    } catch (e) {
      return { id, label: PI_LABEL[id], available: false, signedIn: false, auth: ["oauth", "api_key"], models: [], detail: `pi-ai unavailable: ${(e as Error).message}` };
    }
  }

  /** Browser sign-in (ChatGPT / Claude). The interaction surfaces auth_url / prompts to the UI. */
  async login(id: "openai" | "anthropic", interaction: AuthInteractionLike): Promise<void> {
    const models = await this.piModels();
    await models.login(id, "oauth", interaction);
  }
  async setApiKey(id: HubKeyProvider, key: string): Promise<void> {
    const k = key.trim();
    if (!k) throw new Error("empty API key");
    await this.credentials.modify(id, async () => ({ type: "api_key", key: k }) as never);
  }
  async logout(id: HubKeyProvider): Promise<void> {
    if (id === "ollama-cloud" || id === "spider") return void (await this.credentials.delete(id));
    const models = await this.piModels();
    await models.logout(id).catch(() => this.credentials.delete(id));
  }

  async createBackend(choice: Partial<HubSettings> = this.settings(), extra: { temperature?: number; seed?: number } = {}): Promise<ModelBackend> {
    const s = { ...this.settings(), ...choice };
    const provider = s.provider ?? "mock";
    const model = s.model ?? (provider === "openai" || provider === "anthropic" ? DEFAULT_PI_MODELS[provider] : undefined);
    if (provider === "openai" || provider === "anthropic") return createBackend({ provider, model, piModels: await this.piModels(), ...extra });
    if (provider === "ollama") {
      const baseUrl = s.ollamaUrl ?? DEFAULT_OLLAMA_URL;
      let m = model;
      if (!m) {
        const d = await detectOllama(baseUrl, 1200, this.cfg.fetchImpl);
        m = (d.models.find((x) => !x.cloud) ?? d.models[0])?.name;
        if (!m) throw new Error(`Ollama has no models at ${baseUrl} (try: ollama pull gemma3:4b)`);
      }
      return createBackend({ provider, model: m, baseUrl, ...extra });
    }
    if (provider === "ollama-cloud") {
      const apiKey = await readApiKey(this.credentials as unknown as CredentialStoreLike, "ollama-cloud");
      if (!apiKey) throw new Error("add an Ollama API key first (ollama.com -> Settings -> Keys)");
      return createBackend({ provider, model: model ?? OLLAMA_CLOUD_DEFAULT_MODEL, apiKey, baseUrl: this.cfg.ollamaCloudUrl, ...extra });
    }
    if (provider === "spider-cloud") {
      const apiKey = await readApiKey(this.credentials as unknown as CredentialStoreLike, SPIDER_CREDENTIAL_ID);
      if (!apiKey) throw new Error("add a Spider Cloud device token first (Settings -> Spider Cloud, bhd_...)");
      return createBackend({ provider, model: model ?? SPIDER_CLOUD_DEFAULT_MODEL, apiKey, baseUrl: normalizeSpiderUrl(s.spiderCloudUrl), ...extra });
    }
    if (provider === "claude-code") return createBackend({ provider, model, claudeBin: this.cfg.claudeBin });
    return createBackend({ provider: "mock", seed: extra.seed });
  }
}
