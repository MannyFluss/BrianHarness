# BrianHarness on iPhone / iPad: porting notes

Branch `ios-prep`. Target: **Capacitor (WKWebView), distributed via TestFlight internal**, after a quick
PWA test served from the Mac over plain http on the LAN. Bundle id `com.manny.brianharness`. Universal app:
**iPhone portrait only, iPad landscape only** (enforced natively in Info.plist by the iOS project; the web
manifest says `"orientation": "any"`). The `ios/` folder and TestFlight script are owned by IOS Dev and
are intentionally not in this branch.

## TL;DR build

Requires **Node >= 22.19.0** (floor from `@earendil-works/pi-ai` 1.4; electron 45 needs >= 22.12, openai 7 >= 22, Vite 8).

```bash
npm ci
npm run build:web          # builds packages/core, then vite --mode web + bundle check
# output (Capacitor webDir): apps/desktop/dist-web/   (index.html at its root, relative ./assets paths)
npm run dev:web            # dev server on 0.0.0.0:5174 (LAN-reachable)
npm run preview:web -w @brianharness/desktop   # serve the built dist-web on 0.0.0.0:4174
npm run serve:lan          # build:web, then serve dist-web on 0.0.0.0:8090 (PORT=xxxx to override)
PLAYWRIGHT_CORE=/path/to/playwright-core npm run test:web-csp   # in-browser CSP smoke test (optional)
```

Capacitor: `webDir: "apps/desktop/dist-web"` (or a path relative to wherever `capacitor.config.ts` lives).
The bundle is fully static: no SSR, no server routes, no Node at runtime. `scripts/check-web-bundle.mjs`
fails the build on `node:` imports, Node built-in requires, `crypto.subtle`/`randomUUID(`, Electron
APIs, root-absolute asset paths, or a missing manifest/apple-touch-icon.

LAN PWA test: on the Mac run `npm run serve:lan`, then on the phone/iPad open
**`http://192.168.0.114:8090/`** in Safari, Share -> Add to Home Screen.

## Repo layout / what's shared

```
packages/core/            shared TypeScript core (NOT forked)
  src/browser.ts          -> "@brianharness/core/browser": browser/WKWebView-safe entry
  src/index.ts            -> "@brianharness/core": Node entry = browser.ts + Node-only modules
  src/platform/           env.ts (Env, Clock, timeoutSignal, randomId), kv.ts (KeyValueStore + Memory/
                          LocalStorage/IndexedDB), storage.ts (HarnessStorage, KVHarnessStorage),
                          credentials.ts (CredentialStoreLike, KVCredentialStore)
  src/host.ts             HarnessHost: session loop + titles, used by Electron main AND the in-process transport
  src/providers/          browser-safe: mock, ollama, openai-compatible, anthropic-fetch, browser-factory
                          Node-only: pi-ai, claude-code, factory, hub, credential-store
  src/store.ts            Node SessionStore (fs JSONL), implements HarnessStorage
packages/sim/             headless simulator (Node)
apps/desktop/
  src/                    ONE React UI for Electron, web/PWA and iOS
  src/transport/          types.ts (EegBridge), in-process.ts (core in the page)
  src/main.tsx            Electron renderer entry (uses window.eeg from preload = IPC transport)
  src/main.web.tsx        web / iOS entry (setTransport(createInProcessTransport()))
  web/index.html          web entry HTML (viewport-fit=cover, apple-mobile-web-app meta, manifest, CSP)
  public/                 fonts, manifest.webmanifest, apple-touch-icon.png (placeholder), icon-192/512
  electron/               main.mjs (IPC -> HarnessHost), preload.cjs
  dist/  dist-web/        build outputs (Electron / web)
```

Node entry stays a superset, so the desktop app and the sidecar behave exactly as before (Node
`SessionStore` on disk, `safeStorage` credentials, pi-ai providers). Verified: tests pass (42), typecheck,
desktop build, and an xvfb Electron smoke run writing a session log.

## Transport interface (renderer <-> core)

`apps/desktop/src/transport/types.ts`:

```ts
interface EegBridge {
  newSession(): Promise<{ sessionId; director; hud; title }>;
  reply(p: { text; events: TypingEvent[]; sentAt; shownAt }): Promise<{ director; hud; engagement; title }>;
  hud(): Promise<Hud | null>;
  sessions(): Promise<SessionItem[]>;
  info(): Promise<Info>;
  providers: ProvidersBridge;   // list/select/setApiKey/setEndpoint?/login/logout
  platform: string;             // "darwin" | "ios-phone" | "ios-tablet" | "web"
  kind?: "electron" | "in-process";
  credentialNote?: string;      // shown in the API-key dialog
  flush?(): Promise<void>;      // in-process: persist pending writes (pagehide / visibilitychange)
}
```

`bridge()` returns the transport set by `setTransport()` or falls back to `window.eeg` (Electron preload).
Implementations: Electron IPC (`electron/preload.cjs` -> `main.mjs` -> `HarnessHost`) and
`createInProcessTransport({ storageKV?, settingsKV?, credentials?, credentialNote?, userId?, platform? })`.
IOS Dev's Capacitor build passes its own adapters there (see below); nothing else changes.

`fetchImpl?: typeof fetch` is used by every network path: Ollama detection (`/api/tags`), the Ollama,
OpenAI-compatible, OpenAI and Anthropic backends, and an Ollama topic tagger
(`tagger: { kind: "ollama", model }`, which gets fetchImpl and the settings' Ollama URL). It is always
called unbound, so passing `window.fetch` or a CapacitorHttp wrapper is safe.
`apps/desktop/test/in-process-fetch.test.ts` replaces global fetch with a thrower and checks that every
path above goes through fetchImpl.

## Storage interfaces

- `KeyValueStore` (async: `get/set/remove/keys`), the same shape as Capacitor Preferences. Implementations:
  `MemoryKV`, `LocalStorageKV`, `IndexedDbKV` (default for web: DB `brianharness`, store `kv`).
- `HarnessStorage` (sync, what the session loop uses): `newSessionId, append, readSession, listSessions,
  loadMap, saveMap, flush?`. Node: `SessionStore` (files). Browser: `KVHarnessStorage.open(kv)`, which
  hydrates at open, writes through (coalesced) and prunes to 200 sessions. Keys: `sessions/<id>` (JSONL
  text), `saves/<userId>` (JSON interest map). Settings live in `settingsKV` under key `settings`.

Capacitor Preferences adapter (IOS Dev):

```ts
import { Preferences } from "@capacitor/preferences";
const PreferencesKV: KeyValueStore = {
  get: async (k) => (await Preferences.get({ key: k })).value,
  set: (k, v) => Preferences.set({ key: k, value: v }),
  remove: (k) => Preferences.remove({ key: k }),
  keys: async () => (await Preferences.keys()).keys,
};
createInProcessTransport({ storageKV: PreferencesKV, settingsKV: PreferencesKV, credentials: keychainStore });
```

IndexedDB in WKWebView works and is fine for session logs. Preferences (UserDefaults) is better for small
settings; for large logs prefer IndexedDB or a Filesystem-backed KV.

## Credentials on iOS

- Interface: `CredentialStoreLike` (`get/set/delete/list/modify`, same shape pi-ai uses), `readApiKey()`.
- Web test: `KVCredentialStore(new LocalStorageKV())`. **Test only**: localStorage is readable by any script
  on the origin, and the LAN PWA is plain http. The key dialog says so.
- iOS: IOS Dev writes a Keychain adapter (e.g. a `@capacitor-community/secure-storage` / Keychain plugin,
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) implementing `CredentialStoreLike`, and passes
  `credentials` + `credentialNote` to `createInProcessTransport`. Never ship localStorage keys.
- Subscription sign-in (ChatGPT / Claude OAuth) is **not available in the web build**: pi-ai's flows start a
  local `node:http` callback server. On iOS that needs native handling: `ASWebAuthenticationSession` with a
  custom-scheme / universal-link redirect, PKCE in native code, tokens into the Keychain. Until then the
  login button returns "needs the native app"; API keys work.
- API keys are billed to that account; the app never makes paid calls by default (mock is the default).

## Providers on web / iOS

| provider | how | notes |
|---|---|---|
| mock (default) | in-process | fully offline |
| Ollama | `fetch` to the URL from settings | default is not assumed: set the Mac's LAN IP (e.g. `http://192.168.1.20:11434`) via the link button in the model picker. On the Mac: `OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS="http://<mac-ip>:4174,capacitor://localhost,http://localhost" ollama serve` |
| OpenAI-compatible | `fetch` to `<base>/v1/chat/completions` | any LAN server with CORS (LM Studio, vLLM, llama.cpp server) |
| OpenAI | `fetch` api.openai.com with API key | CORS-capable |
| Anthropic | `fetch` api.anthropic.com/v1/messages | sends `anthropic-dangerous-direct-browser-access: true` |

pi-ai is **not** bundled for web/iOS; the browser path uses the small fetch backends above
(`createBrowserBackend`).

### pi-ai audit (`@earendil-works/pi-ai` 1.4.0, MIT): Node assumptions

- `auth/oauth/callback-server.js`, `auth/oauth/openai-chatgpt.js`: `node:http` `createServer().listen()` local
  OAuth callback port; `node:crypto` `randomBytes`. Can't run in WKWebView.
- `providers/openai-codex.js`: dynamic `import("node:crypto")` (`randomBytes`).
- `cli.js`: `node:readline`, `node:fs`, `crypto.randomUUID`. Node CLI only.
- `env-api-keys.js`: lazy `node:fs` / `node:os` / `node:path` (guarded by a `process.versions` check).
- `auth/context.js`: lazy `node:fs/promises` + `os.homedir()` (credential file).
- `auth/oauth/pkce.js`: `crypto.subtle.digest`, **secure-context only** (fails on the plain-http PWA).
- `providers/openrouter.js`, `providers/radius.js`: `crypto.randomUUID()`, secure-context only.
- `utils/uuid.js`: `crypto.getRandomValues`, fine everywhere.
- Deps pulled in: `@aws-sdk/client-bedrock-runtime` + `@smithy/node-http-handler`, `http(s)-proxy-agent`
  (Node), `@google/genai`, `openai` 7 (engines >= 22), `@anthropic-ai/sdk`: heavy, Node-leaning.
- The API-key completion paths do set `dangerouslyAllowBrowser` and the Anthropic direct-browser header,
  so they *could* run in a browser, but the OAuth, env and credential-file parts can't, and the
  bundle weight isn't worth it. Decision: fetch-only backends for web/iOS; pi-ai stays desktop/sidecar.

## Network: CORS / ATS / secure context

- **ATS**: WKWebView calls to `http://<LAN-IP>` (Ollama) are blocked by App Transport Security unless the
  app's Info.plist sets `NSAppTransportSecurity` -> `NSAllowsLocalNetworking = YES` (covers local IPs and
  `.local`). iOS 14+ also shows the Local Network permission prompt: add `NSLocalNetworkUsageDescription`.
- **CORS**: the Capacitor origin is `capacitor://localhost`; the LAN PWA origin is `http://<mac-ip>:4174`.
  Both must be in `OLLAMA_ORIGINS`. OpenAI and Anthropic APIs allow browser CORS (Anthropic with the header above).
  Alternative: CapacitorHttp (native HTTP, no CORS), which can be added later behind `fetchImpl`.
- **CSP**. The Electron renderer (`apps/desktop/index.html`) stays at `default-src 'self'` with no network,
  because it only talks over IPC. The web/PWA build (`web/index.html`, filled in by `vite.config.ts`) has:
  `connect-src 'self' http://*:11434 https://*:11434 https://api.anthropic.com https://api.openai.com https://openrouter.ai`.
  This covers Ollama on any LAN host at :11434 and the hosted APIs.
  - A **custom OpenAI-compatible server** (LM Studio :1234, llama.cpp, vLLM, a non-11434 Ollama) must be
    added at build time:
    `BH_CONNECT_SRC="http://192.168.0.114:1234 https://llm.example.com" npm run build:web`
    (space or comma separated; each entry is validated as `scheme://host[:port]`). Without it, the fetch is
    CSP-blocked and the provider shows as unreachable.
  - `check-web-bundle.mjs` fails the build if connect-src is missing, any default origin is missing, any
    BH_CONNECT_SRC origin is missing, or dev-only `ws:` leaks in.
  - `scripts/csp-smoke.mjs` (`npm run test:web-csp`) loads dist-web in headless Chromium and checks three
    things: a LAN Ollama chat is not CSP-blocked, OpenAI/Anthropic/OpenRouter fetches are not blocked, and
    `:1234` IS blocked. Every host is answered by request interception, so it makes no real network calls.
  - On iOS, CapacitorHttp (passed as `fetchImpl`) makes native requests, so neither the WebView CSP nor CORS
    applies to them. Keep the CSP anyway for the PWA.
- **Secure context**: the LAN PWA is plain http, so `crypto.subtle`, `crypto.randomUUID`, service workers and
  clipboard APIs are unavailable. The core uses `randomId()` (`getRandomValues` -> `Math.random` fallback)
  and `timeoutSignal()` (AbortSignal.timeout fallback); the bundle check enforces this. No service worker is
  registered (no offline caching for the PWA test; Capacitor ships the files locally anyway).
- Safari target: `safari15`. Removed regex lookbehind (Safari < 16.4).

## Responsive UI

Screenshots (web target, headless Chromium, mock backend):
`docs/screenshot-iphone-portrait.png` (390x844 @3x), `docs/screenshot-iphone-drawer.png`,
`docs/screenshot-iphone-hud-sheet.png`, `docs/screenshot-ipad-landscape.png` (1180x820 @2x),
`docs/screenshot-ipad-hud-collapsed.png`.

- phone (< 768px): sidebar = slide-over drawer with backdrop (closed by default, closes on New chat); HUD =
  bottom sheet (max 72dvh, handle, backdrop); composer pinned at the bottom with
  `env(safe-area-inset-bottom)`; bars pad `env(safe-area-inset-top)`; `--app-h` follows `visualViewport`
  so the composer stays above the soft keyboard.
- tablet (768-1279px, iPad landscape) / desktop: 3 columns, collapsible sidebar and HUD (HUD 18rem, 20rem at >= 1280).
- touch: `pointer: coarse` -> >= 44px targets (`.eeg-tap`, `.eeg-tap-row`, `.eeg-tap-chip`), 16px inputs (no
  focus zoom), `touch-action: manipulation`, no auto-focus of the composer (keyboard doesn't pop every turn).
  Checked: no visible button/textarea < 44px at either size.
- Enter sends (the iOS return key is labelled "send" via `enterKeyHint`); Shift+Enter = newline (hardware keyboard).

## Telemetry with soft keyboards

`apps/desktop/src/telemetry.ts` listens to native `beforeinput` + `input` (not key events) and records,
per edit: kind, resulting length, time, and `source` + `chars` when known. Never the text or key identity.

- source: `hardware-key | soft-keyboard | autocorrect (insertReplacementText) | predictive (multi-char
  insertText, no keydown) | composition (IME / isComposing) | paste | drop | programmatic | unknown`.
- Hardware keyboard on iPad is inferred (arrow/Tab/Esc/modifier keys seen, identified keydown).
- What iOS can't provide: no per-key timing for autocorrect, predictive-bar picks or dictation (one
  multi-char insert); dictation is indistinguishable from a predictive pick; soft-keyboard keydown is
  often `Unidentified`/229.
- Core features: existing `typing.*` unchanged (desktop/sim parity). New, additive, only when sources are
  present: `typing.src.soft`, `.hardware`, `.autocorrect`, `.predictive`, `.dictation`, `.composition`,
  `.timedShare` (share of inserted chars with real per-key timing; shown in the HUD as "key-timed").
  The engagement estimator does not read them yet. Consider down-weighting chars/sec when timedShare is low.

## Shell options (tradeoffs)

| | Capacitor (WKWebView) **chosen** | PWA (Safari / Home Screen) | React Native |
|---|---|---|---|
| code reuse | same React UI + core | same | rewrite UI; core reusable but RN lacks DOM `beforeinput` telemetry |
| Keychain / OAuth | plugins + native code | none (localStorage only) | native modules |
| LAN Ollama over http | ATS `NSAllowsLocalNetworking` | works from an http page; mixed content if the page is https | ATS same |
| distribution | TestFlight / App Store | URL, no review | TestFlight |
| orientation lock | Info.plist per device | can't lock | native |
| effort | low | lowest (used for the first test) | high |

Capacitor checklist for IOS Dev: `appId: "com.manny.brianharness"`, `webDir` -> `apps/desktop/dist-web`;
Info.plist: `UISupportedInterfaceOrientations` = portrait (iPhone), `UISupportedInterfaceOrientations~ipad` =
landscape left/right, `UIRequiresFullScreen`, `NSAppTransportSecurity/NSAllowsLocalNetworking`,
`NSLocalNetworkUsageDescription`; Keychain `CredentialStoreLike` adapter; optional Preferences KV;
`contentInset: "never"` (the CSS handles safe areas via `viewport-fit=cover`).

## Licenses

pi-ai is MIT. No LearnHarness (AGPL) code was copied for this work.
