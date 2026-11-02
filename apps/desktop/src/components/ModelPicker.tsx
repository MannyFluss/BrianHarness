import { CheckIcon, ChevronUpIcon, KeyRoundIcon, LinkIcon, LogInIcon, LogOutIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bridge, type AuthEvent, type AuthPrompt, type Info, type KeyProvider, type ProviderId, type ProviderStatus } from "../bridge";
import { cn } from "../lib";

const SHORT: Record<ProviderId, string> = { mock: "Mock", ollama: "Ollama", "ollama-cloud": "Ollama Cloud", "openai-compatible": "OpenAI-compatible", openai: "ChatGPT", "claude-code": "Claude Code", anthropic: "Claude", "spider-cloud": "Spider Cloud" };
const isKeyProvider = (id: ProviderId) => id === "openai" || id === "anthropic" || id === "openai-compatible" || id === "ollama-cloud" || id === "spider-cloud";
/** credential id for a provider row (Spider Cloud's device token lives at credentials/spider) */
const keyId = (id: ProviderId): KeyProvider => (id === "spider-cloud" ? "spider" : (id as KeyProvider));

export function pickerLabel(info: Info | null) {
  if (!info) return "…";
  const p = (info.provider as ProviderId) in SHORT ? SHORT[info.provider as ProviderId] : info.provider;
  const model = info.backend.startsWith("mock") ? "" : info.backend.replace(/^[a-z-]+:/, "");
  return model ? `${p} · ${model}` : p;
}

/** Sidebar-footer model/provider picker (where "model: mock" used to be). */
export function ModelPicker({ info, onChanged, openRef }: { info: Info | null; onChanged: (i: Info) => void; openRef?: React.MutableRefObject<(() => void) | null> }) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<KeyProvider | null>(null);
  const [urlFor, setUrlFor] = useState<{ provider: "ollama" | "openai-compatible" | "spider-cloud"; url: string } | null>(null);
  const [auth, setAuth] = useState<{ provider: string; events: AuthEvent[]; prompt: AuthPrompt | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const r = await bridge().providers.status();
    setProviders(r.providers);
    onChanged(r.current);
  }, [onChanged]);

  useEffect(() => {
    if (openRef) openRef.current = () => { setOpen(true); void refresh(); };
  }, [openRef, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!auth && !keyFor && !urlFor && root.current && !root.current.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, auth, keyFor, urlFor]);

  useEffect(() => {
    const p = bridge().providers;
    const offs = [
      p.onAuthEvent((e) => setAuth((a) => (a ? { ...a, events: [...a.events, e] } : a))),
      p.onAuthPrompt((pr) => setAuth((a) => (a ? { ...a, prompt: pr } : a))),
      p.onAuthPromptDone(({ id }) => setAuth((a) => (a && a.prompt?.id === id ? { ...a, prompt: null } : a))),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  const select = async (provider: ProviderId, model?: string) => {
    setBusy(`${provider}:${model ?? ""}`);
    setError(null);
    try {
      onChanged(await bridge().providers.select(provider, model ?? null));
      setOpen(false);
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setBusy(null);
    }
  };
  const login = async (provider: "openai" | "anthropic") => {
    setAuth({ provider, events: [], prompt: null });
    const r = await bridge().providers.login(provider);
    setAuth(null);
    if (!r.ok) setError(r.error ?? "Sign-in failed");
    await refresh();
  };
  const logout = async (provider: KeyProvider) => {
    await bridge().providers.logout(provider);
    await refresh();
  };

  const current = info?.provider;
  return (
    <div ref={root} className="relative">
      {open && createPortal(
        <div ref={pop} className="fixed bottom-[calc(3rem+env(safe-area-inset-bottom))] left-3 z-[60] max-h-[78dvh] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-border bg-card p-1.5 shadow-2xl shadow-black/60">
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
            <span className="text-xs uppercase tracking-widest text-muted-foreground/70">Model</span>
            <button onClick={() => void refresh()} title="Detect again" aria-label="Detect again" className="eeg-tap flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <RefreshCwIcon className="size-3" />
            </button>
          </div>
          {!providers && <div className="px-2 py-3 text-xs text-muted-foreground">Detecting providers…</div>}
          {providers?.map((p) => (
            <div key={p.id} className="mb-1 rounded-md px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className={cn("size-1.5 shrink-0 rounded-full", p.available && p.signedIn ? "bg-[var(--signal)]" : p.available ? "bg-amber-400/80" : "bg-muted-foreground/40")} />
                <span className="flex-1 truncate text-sm text-foreground">{p.label}</span>
                {p.endpoint !== undefined && bridge().providers.setEndpoint && (p.id === "ollama" || p.id === "openai-compatible" || p.id === "spider-cloud") && (
                  <button onClick={() => setUrlFor({ provider: p.id as "ollama" | "openai-compatible" | "spider-cloud", url: p.endpoint ?? "" })} className="eeg-tap-chip flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground">
                    <LinkIcon className="size-3" /> url
                  </button>
                )}
                {isKeyProvider(p.id) && p.signedIn && p.authSource && (
                  <button onClick={() => void logout(keyId(p.id))} className="eeg-tap-chip flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground">
                    <LogOutIcon className="size-3" /> {p.auth.includes("oauth") ? "sign out" : "forget key"}
                  </button>
                )}
                {isKeyProvider(p.id) && !p.authSource && p.auth.includes("oauth") && (
                  <button onClick={() => void login(p.id as "openai" | "anthropic")} className="eeg-tap-chip flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-foreground hover:bg-accent">
                    <LogInIcon className="size-3" /> sign in
                  </button>
                )}
                {isKeyProvider(p.id) && !p.authSource && p.auth.includes("api_key") && (p.available || (p.id !== "ollama-cloud" && p.id !== "spider-cloud")) && (
                  <button onClick={() => setKeyFor(keyId(p.id))} className="eeg-tap-chip flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground">
                    <KeyRoundIcon className="size-3" /> key
                  </button>
                )}
              </div>
              {(p.authSource || p.detail) && <div className="mt-0.5 pl-3.5 text-[11px] leading-snug text-muted-foreground">{p.authSource ? `signed in · ${p.authSource}` : p.detail}</div>}
              {p.warning && !p.signedIn && <div className="mt-0.5 pl-3.5 text-[10.5px] leading-snug text-amber-300/70">{p.warning}</div>}
              {p.available && (p.signedIn || p.id === "claude-code" || p.id === "openai-compatible") && p.models.length > 0 && (
                <div className="mt-1 flex flex-col pl-2">
                  {p.models.slice(0, p.id === "openai" || p.id === "anthropic" ? 6 : 8).map((m) => {
                    const active = current === p.id && (info?.backend.endsWith(`:${m.id}`) || (p.id === "mock" && info?.backend.startsWith("mock")));
                    return (
                      <button key={m.id} disabled={!!busy} onClick={() => void select(p.id, p.id === "mock" ? undefined : m.id)} className={cn("eeg-tap-row flex items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
                        <span className="w-3">{active && <CheckIcon className="size-3" />}</span>
                        <span className="flex-1 truncate">{m.label}</span>
                        {m.paid && <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{p.id === "ollama" ? "cloud" : p.authSource?.includes("subscription") || p.id === "claude-code" ? "plan" : "paid"}</span>}
                        {busy === `${p.id}:${p.id === "mock" ? "" : m.id}` && <RefreshCwIcon className="size-3 animate-spin" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {info?.extractorPromptVersion && bridge().providers.setExtractorPrompt && (
            <div className="mx-2 mb-1 mt-1 border-t border-border/60 pt-1.5 text-[10.5px] text-muted-foreground" data-testid="extractor-setting">
              <div className="flex items-center gap-1.5">
                <span className="flex-1 uppercase tracking-wider">interest extractor prompt</span>
                {(["v2", "v1"] as const).map((v) => (
                  <button key={v} disabled={!!busy} onClick={() => void bridge().providers.setExtractorPrompt!(v).then(onChanged, (e: Error) => setError(e.message))} className={cn("eeg-tap-chip rounded px-1.5 py-0.5 uppercase tracking-wider", info.extractorPromptVersion === v ? "bg-accent text-foreground" : "hover:bg-accent/60")}>
                    {v}{v === "v1" ? " (rollback)" : ""}
                  </button>
                ))}
              </div>
              {info.tagger && <div className="mt-0.5 truncate text-muted-foreground/70" title={info.tagger}>next session: {info.tagger}</div>}
            </div>
          )}
          {error && <div className="mx-2 mb-1 rounded bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">{error}</div>}
        </div>,
        document.body,
      )}
      <button onClick={() => { const n = !open; setOpen(n); if (n) void refresh(); }} className="eeg-tap-row flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <span className={cn("size-1.5 rounded-full", info?.paid ? "bg-amber-400/80" : "bg-[var(--signal)]")} />
        <span className="flex-1 truncate text-left">model: {pickerLabel(info)}</span>
        <ChevronUpIcon className={cn("size-3 transition-transform", !open && "rotate-180")} />
      </button>
      {urlFor && createPortal(<EndpointDialog state={urlFor} onClose={() => setUrlFor(null)} onSaved={() => { setUrlFor(null); void refresh(); }} />, document.body)}
      {keyFor && createPortal(<ApiKeyDialog provider={keyFor} onClose={() => setKeyFor(null)} onSaved={() => { setKeyFor(null); void refresh(); }} />, document.body)}
      {auth && createPortal(<AuthDialog state={auth} />, document.body)}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="w-[min(28rem,100%)] rounded-xl border border-border bg-card p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-title text-xl">{title}</span>
          <button onClick={onClose} aria-label="Close" className="eeg-tap flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EndpointDialog({ state, onClose, onSaved }: { state: { provider: "ollama" | "openai-compatible" | "spider-cloud"; url: string }; onClose: () => void; onSaved: () => void }) {
  const [url, setUrl] = useState(state.url);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await bridge().providers.setEndpoint!(state.provider, url);
      onSaved();
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  const ollama = state.provider === "ollama";
  const spider = state.provider === "spider-cloud";
  return (
    <Modal title={ollama ? "Ollama server URL" : spider ? "Spider Cloud URL (advanced)" : "OpenAI-compatible server URL"} onClose={onClose}>
      <p className="mb-2 text-xs text-muted-foreground">
        {spider
          ? "Worker origin, default https://api.strangeriver.org. Leave empty for the default."
          : ollama
          ? "Base URL of Ollama, e.g. http://192.168.1.20:11434 (your Mac's LAN IP when on a phone). Run Ollama with OLLAMA_HOST=0.0.0.0 and OLLAMA_ORIGINS allowing this app's origin."
          : "Base URL ending in /v1, e.g. http://192.168.1.20:1234/v1 (LM Studio). The server must send CORS headers."}
      </p>
      <input autoFocus inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} placeholder={ollama ? "http://192.168.1.20:11434" : spider ? "https://api.strangeriver.org" : "http://192.168.1.20:1234/v1"} className="w-full rounded-md border border-border bg-background px-3 py-2 text-[16px]" />
      {err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="eeg-tap rounded-md px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:bg-accent">Cancel</button>
        <button onClick={() => void save()} className="eeg-tap rounded-md bg-primary px-3 py-1.5 text-xs uppercase tracking-wider text-primary-foreground">Save</button>
      </div>
    </Modal>
  );
}

const KEY_TITLE: Record<KeyProvider, string> = { openai: "OpenAI API key", anthropic: "Anthropic API key", "openai-compatible": "Server API key (optional)", "ollama-cloud": "Ollama API key", spider: "Spider Cloud device token (bhd_…)" };
function ApiKeyDialog({ provider, onClose, onSaved }: { provider: KeyProvider; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await bridge().providers.setApiKey(provider, key);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title={KEY_TITLE[provider]} onClose={onClose}>
      <p className="mb-2 text-xs text-muted-foreground">{bridge().credentialNote ?? "Stored only on this device."} {provider === "ollama-cloud" ? "Requests run on Ollama's servers under that account's plan limits." : provider === "spider" ? "Set it once; it's used for chat, the interest extractor and log upload. Works after Manny's deploy." : "Usage is billed to that API account."}</p>
      <input autoFocus type="password" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} placeholder={provider === "anthropic" ? "sk-ant-..." : provider === "ollama-cloud" ? "Ollama API key" : provider === "spider" ? "bhd_..." : "sk-..."} className="w-full rounded-md border border-border bg-background px-3 py-2 text-[16px]" />
      {err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="eeg-tap rounded-md px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:bg-accent">Cancel</button>
        <button onClick={() => void save()} disabled={!key.trim()} className="eeg-tap rounded-md bg-primary px-3 py-1.5 text-xs uppercase tracking-wider text-primary-foreground disabled:opacity-40">Save</button>
      </div>
    </Modal>
  );
}

function AuthDialog({ state }: { state: { provider: string; events: AuthEvent[]; prompt: AuthPrompt | null } }) {
  const [value, setValue] = useState("");
  const p = state.prompt;
  const answer = (v: string) => { if (p) { void bridge().providers.answer(p.id, v); setValue(""); } };
  const lastUrl = [...state.events].reverse().find((e) => e.type === "auth_url") as Extract<AuthEvent, { type: "auth_url" }> | undefined;
  return (
    <Modal title={state.provider === "openai" ? "Sign in with ChatGPT" : "Sign in with Claude"} onClose={() => void bridge().providers.cancelLogin()}>
      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        {state.events.length === 0 && <div>Starting sign-in…</div>}
        {state.events.map((e, i) => (
          <div key={i}>
            {e.type === "auth_url" && <>Your browser opened to sign in. {e.instructions ?? ""}</>}
            {e.type === "device_code" && <>Enter code <span className="font-mono text-foreground">{e.userCode}</span> at {e.verificationUri}</>}
            {(e.type === "info" || e.type === "progress") && e.message}
          </div>
        ))}
        {lastUrl && <a href={lastUrl.url} target="_blank" rel="noreferrer" className="text-foreground underline">Open the sign-in page again</a>}
      </div>
      {p && (
        <div className="mt-3">
          <div className="mb-1.5 text-xs text-foreground">{p.message}</div>
          {p.type === "select" ? (
            <div className="flex flex-col gap-1">{p.options?.map((o) => <button key={o.id} onClick={() => answer(o.id)} className="rounded-md border border-border px-3 py-1.5 text-left text-xs hover:bg-accent">{o.label}</button>)}</div>
          ) : (
            <div className="flex gap-2">
              <input autoFocus type={p.type === "secret" ? "password" : "text"} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && answer(value)} placeholder={p.placeholder} className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" />
              <button onClick={() => answer(value)} className="rounded-md bg-primary px-3 py-1.5 text-xs uppercase tracking-wider text-primary-foreground">OK</button>
            </div>
          )}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button onClick={() => void bridge().providers.cancelLogin()} className="rounded-md px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:bg-accent">Cancel</button>
      </div>
    </Modal>
  );
}
