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
- iOS: the **BHKeychain** Capacitor plugin (Swift, service `com.manny.brianharness.credentials`). When it is
  installed, `nativeTransportOptions()` selects `createKeychainCredentials()` (`transport/keychain.ts`):
  `KVCredentialStore` over `keychainKV(plugin)`, same `credentials/<provider>` JSON records as the web build.
  See "BHKeychain" below for the contract and the localStorage migration. Never ship localStorage keys.
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
| Ollama Cloud | `fetchImpl` (CapacitorHttp) to `https://ollama.com/api/chat` + `/api/tags`, `Authorization: Bearer <key>` | the free real-model path (no inference on the Mac). Key via the credentials interface (Keychain on iOS). ollama.com answers the CORS preflight with 405 and no ACAO, so it **only works with a native fetch**: `createInProcessTransport({ fetchImpl })` turns it on (override with `nativeFetch`); a plain PWA shows "needs the native app (no CORS)". Not paid for --allow-paid when chosen explicitly as `ollama-cloud` (key still required); `*:cloud` models through the local `ollama` provider stay paid. |
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
  `connect-src 'self' http://*:11434 https://*:11434 http://*:1234 https://api.anthropic.com https://api.openai.com https://openrouter.ai https://ollama.com`.
  (`https://ollama.com` is listed for completeness; the browser still can't call it because of CORS.) This covers Ollama on any LAN host at :11434, LM Studio on any LAN host at :1234 (http), and the hosted APIs.
  - Any **other OpenAI-compatible server** (llama.cpp :8080, vLLM, a non-11434 Ollama) must be
    added at build time:
    `BH_CONNECT_SRC="http://192.168.0.114:8080 https://llm.example.com" npm run build:web`
    (space or comma separated; each entry is validated as `scheme://host[:port]`). Without it, the fetch is
    CSP-blocked and the provider shows as unreachable.
  - `check-web-bundle.mjs` fails the build if connect-src is missing, any default origin is missing, any
    BH_CONNECT_SRC origin is missing, or dev-only `ws:` leaks in.
  - `scripts/csp-smoke.mjs` (`npm run test:web-csp`) loads dist-web in headless Chromium and checks three
    things: a LAN Ollama chat is not CSP-blocked, LM Studio :1234 and OpenAI/Anthropic/OpenRouter fetches are
    not blocked, and `:9999` IS blocked. Every host is answered by request interception, so it makes no real network calls.
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
  Since Phase D the estimator down-weights them: see "Keystroke audit" below.

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

## Native fetch and buffered responses (CapacitorHttp)

- `main.web.tsx` calls `nativeTransportOptions(window)` (`transport/native.ts`): when
  `window.Capacitor?.isNativePlatform?.()` is true it passes `{ nativeFetch: true, fetchImpl: (i, n) => window.fetch(i, n) }`
  (late-bound, so it always hits CapacitorHttp's patched fetch). That enables Ollama Cloud. In a plain browser/PWA
  nothing is passed, and Ollama Cloud shows "needs the native app (no CORS)".
- CapacitorHttp buffers the whole response and may not expose `response.body`. Every fetch backend (Ollama,
  Ollama Cloud, OpenAI-compatible, OpenAI, Anthropic, and the Ollama tagger) sends `stream: false`, reads the
  response only with `res.text()`, and parses it with `parseChatBody` (`providers/response-body.ts`).
  That accepts one JSON body, NDJSON, or SSE (`data:` lines, `[DONE]`, Anthropic events) arriving as one chunk,
  so a server that ignores stream:false still works. This buffered path is what runs when the BHStream plugin
  is missing (see "Streaming" below).
- OpenAI-compatible and Anthropic now default to a 120 s timeout (Ollama already had one), so a stuck native
  request surfaces as an error instead of hanging the UI.

## Streaming (BHStream), typing indicator, latency telemetry

### Who streams
| Runtime | fetch | backends use | tokens reach the UI |
|---|---|---|---|
| iOS with BHStream | `nativeStreamFetch` over BHStream | `stream: true` | incrementally |
| iOS without BHStream | CapacitorHttp (buffered) | `stream: false` | whole reply as one delta |
| browser / PWA | page fetch (streams natively) | `stream: true` | incrementally |
| Electron | Node fetch in main, IPC `harness:token` events | `stream: true` | incrementally |
| sim / sidecar | n/a (no `onToken`) | `stream: false` | unchanged |

- `GenerateRequest.onToken` is the only switch: without it every backend uses its buffered `stream:false`
  path (the sim never passes it). With it, Ollama / Ollama Cloud read NDJSON, OpenAI-compatible / OpenAI and
  Anthropic read SSE through `readChatStream` / `createChatStreamParser` (`providers/response-body.ts`): body
  reader + `TextDecoder({stream:true})`, partial lines buffered, so a chunk may split a line, a `data:` prefix,
  or a UTF-8 sequence. A missing `response.body` falls back to `text()`. Backends built with `streaming: false`
  (the in-process transport sets it when the fetch buffers) keep `stream:false` even with `onToken`.
- Backends that can't stream (pi-ai subscription providers, Claude Code) ignore `onToken`; `HarnessSession` then
  sends the whole text as one delta, so the UI flow is identical.
- The mock streams word by word with an 18 ms delay (`MockBackend(seed, { tokenDelayMs })`, same text as the
  buffered path), so the UI can be exercised offline: `npm run test:web-stream` (dist-web, headless Chrome).
- Transport API: `newSession(onToken?)`, `reply(payload, onToken?)`. Electron: the preload adds a request id;
  main forwards deltas as `harness:token {rid, delta}`. The final `director.text` replaces the streamed text
  (backends trim it).

### Typing indicator
`App.tsx` runs every turn through `runStreamedTurn` (`chat-flow.ts`): the user bubble and indicator are committed
with `flushSync` and a frame is painted (`nextPaint`) **before** the transport is called, so no tagger, core or
network work can delay it, on every backend. The first delta replaces the indicator with the streaming message
(blinking caret); stream end marks it complete.

### Reply-latency telemetry (completeAt, not first token)
- The renderer stamps each Director message twice: `firstTokenAt` (first token rendered) and `completeAt`
  (the commit that shows it complete = stream end). The next `reply()` sends `shownAt = completeAt` and
  `firstTokenAt`.
- `HarnessSession.markShown(completeAt, firstTokenAt)`. The typing window and every typing feature
  (`typing.replyLatencyMs`, `typing.totalMs`, ...) start at **completeAt**, exactly as before streaming existed
  (then the message appeared all at once). That keeps sim (no streaming) and desktop/iOS numbers comparable;
  reading while tokens arrive is not counted as reply latency.
- Turn log: `user_turn.prompt = { firstTokenAt?, completeAt }` (epoch ms, renderer clock);
  `director_turn.firstTokenMs` + `streamed: true` when the backend streamed (`genMs` stays request -> whole reply).
  The sim logs `prompt.completeAt` only.

### BHStream contract (Swift plugin, IOS Dev)
```
start({ url, method, headers, body? }) -> { id }
cancel({ id })
addListener("bhstream", ev):  per id, in order
  { id, type: "head", status, headers }
  0..n { id, type: "chunk", data?: string, b64?: string }
  { id, type: "end" }  |  { id, type: "error", message }
```
- TS side: `createNativeStreamFetch(plugin)` (`transport/native-stream.ts`) returns a real `Response` (resolved on
  `head`) whose body is a `ReadableStream`. The listener is added **before** `start()`; events that arrive before
  `start()` resolves are buffered and replayed by id; chunks before `head` are queued; other ids are ignored.
  `AbortSignal` calls `cancel({id})` (before head: rejects with AbortError; after: errors the body). `error`
  before head rejects like fetch (TypeError); after head it errors the body. `end` without `head` is an error.
- **Bytes:** prefer `b64` (base64 of the raw bytes, any split). `data` must be a valid string; if Swift decodes
  each URLSession chunk on its own, a multibyte character split across chunks turns into U+FFFD before JS sees it
  and cannot be repaired. Either send `b64`, or carry incomplete trailing UTF-8 bytes into the next chunk before
  decoding. (JS also holds a trailing lone high surrogate in `data` until the next chunk.)
- Headers: Swift sends lowercased names; JS reads them only through `Headers` (case-insensitive). Values are
  coerced to strings (arrays joined with ", "); names/values `Headers` rejects (e.g. HTTP/2 `:status`, control
  characters) are skipped instead of failing the fetch.
- Chunking: any split works, including byte-by-byte base64 SSE, many events per chunk, the whole response in one
  chunk, and base64 with line breaks. A small JSON body that URLSession coalesces into one chunk (even labelled
  `text/plain` or pretty-printed) is parsed as one JSON document.
- Feature detection via `window.Capacitor` (no `@capacitor/core` import): `isPluginAvailable("BHStream")`, else
  `Capacitor.Plugins.BHStream`. Missing -> the buffered CapacitorHttp path. A plugin that rejects `start()` with
  `UNIMPLEMENTED` makes that and later requests fall back to the buffered fetch.

### BHKeychain contract (Swift plugin, IOS Dev)
```
get({ key }) -> { value: string | null }   set({ key, value })   remove({ key })   keys() -> { keys: string[] }
```
- Keys are `credentials/<provider>` (e.g. `credentials/openai`), values the JSON records `KVCredentialStore` writes.
  `keys()` should return all keys under the service (JS filters by prefix).
- One-time migration (`migrateCredentials`), run before the first credential access each launch: for each key in
  the old localStorage store (`brianharness/credentials/*`), write it to the Keychain, read it back, and only then
  delete the local copy. A failed write keeps the local copy (reads fall back to it; the next launch retries).
  If the Keychain already has that provider, the Keychain value wins and the local copy is dropped. Idempotent.
- **-34018 (errSecMissingEntitlement, unsigned simulator builds):** detected from the rejection's `code`,
  `data.status` or a `-34018` in the message. The store then degrades instead of throwing: existing
  localStorage keys stay (never cleared) and keep working, keys added this launch live **in memory only** (not
  written to localStorage), logout removes both, and the key dialog says "iOS Keychain unavailable on this build
  (OSStatus -34018 ...)". Logged once. Other Keychain errors: reads fall back the same way for that call; a failed
  save throws "iOS Keychain save failed (OSStatus N): ...". Please reject with `code` = the OSStatus as a string
  (or `data.status`) so JS can tell them apart.

## Phase D: absorption ratings, keystroke audit, blinded study, export

Protocol: the Researcher's `eeg-harness-sim/phaseD/PREREG_dogfood.md` (governs). Device checklist and
plugin contracts for IOS Dev: [IOS_DEV_NOTE_phaseD.md](IOS_DEV_NOTE_phaseD.md).

### Ratings (ground truth, evaluation only)

- **Turn probe** "How absorbed are you right now?" 1-5, inline under the Director's message
  (`components/Rating.tsx`). Schedule (`src/rating.ts`): seeded per session id (mulberry32), p = 1/3 per
  eligible turn with a minimum gap of 3 turns (long-run rate 1/5), never on reply 1. Typing, sending or
  New chat dismisses it; a dismissed probe is still logged (`value:null, dismissed:true, reason`).
- **Session card** "Overall, how absorbed were you?" 1-5 + optional "What hooked you?" + in study
  sessions the blinding check (adaptive / baseline / no idea). Shown on New chat (logged first, then the
  new session starts) and when the app returns after 20+ minutes hidden; closing the app while it is open
  logs it with `reason:"closed"` (a tapped value is kept: one tap logs it).
- Record: `{type:"rating", t, scope:"turn"|"session", turn, value:1..5|null, shownAt, answeredAt|null,
  dismissed, reason?, hooked?, blindGuess?}`. `turn` = 1-based reply number (= `user_turn.turn + 1`).
  `HarnessSession.logRating` only appends to the log: engagement, the Director and the interest map never
  read ratings (tested).
- Screenshots: `screenshot-rating-{probe,session}-{desktop,iphone}.png` (`apps/desktop/scripts/rating-shots.mjs`).

### Keystroke audit

`summarizeTyping` and the composer telemetry log edit classes, lengths, times and sources only (events are
whitelisted by `sanitizeTypingEvent`: `{t, kind, len, source, chars}`; no text, no key identities).
New per-turn features (window starts at the Director message's completeAt):

| feature | meaning |
|---|---|
| `typing.latencyToFirstKeyMs` | completeAt -> first edit |
| `typing.latencyToSubmitMs` | completeAt -> send |
| `typing.gapCount/gapMeanMs/gapMedianMs/gapP90Ms` | inter-key gaps between keyed inserts; raw list in `user_turn.keyGaps` |
| `typing.dictated`, `typing.pasted` | 0/1 flags |
| `typing.autocorrections`, `typing.predictive` | counts |
| `typing.timingReliability` (r) | share of inserted chars that were keyed (1 = all keyed) |

Down-weighting: fluency and hesitation weights are multiplied by r and the score renormalised; latency and
text features keep full weight. r = 1 (or absent: sim, desktop hardware keys) runs the exact old code path,
so sim/replay results are bit-identical. Composition rewrites (`deleteCompositionText`, IME) are not counted
as deletions. Dictation: `insertFromDictation` if WebKit sends it, else an unkeyed multi-word insertText
(heuristic, to be confirmed on device). HUD "This turn" shows latency to first key / submit, key gap
median, timing reliability and the flags.

### Blinded study (5 adaptive + 5 baseline)

- `StudyController` (core `study.ts`): on "Start study" a seeded 5/5 order is generated once and stored
  ONLY in the secure store (iOS: BHKeychain key `study/phaseD/schedule`; Electron: the safeStorage-encrypted
  credentials file; web test build: localStorage, not secure). Progress (enabled, next index) is in settings.
  A session with 0 replies gives its index back.
- Baseline = interest ledger + adaptation off (fixed seeded topic rotation, same opener and open-question
  cadence; the map is a shadow clone that is never saved). Adaptive stays the default everywhere else
  (sim, sidecar, non-study sessions).
- Logged: `session_start.study = {id, index, total, scheduleHash}`. Never logged or shown: the mode
  (not in JSONL, exports, CSV, UI or HUD). Study `director_turn`s are `sealed:true` without plan/stateNote;
  the HUD hides the interest map, hypothesis, styles and plan and shows "Study session i/10".
- Dev only: schedule sha256 via `window.__bhStudy.hash()` (dev build or `localStorage bh.debug=1`) or
  `BH_STUDY_HASH=1` (Electron). Unseal after session 10: `__bhStudy.unseal("UNSEAL phaseD")`, Electron IPC
  `study:unseal` (dev / `BH_STUDY_DEBUG=1` only). If the secure store fails (e.g. -34018) the study does
  not start and sessions run unblinded without study fields.

### Interest extractor in the app (Nov 2 2026: llm-extract, prompt v2 default)

`packages/core/src/app-tagger.ts` (`appTaggerSpec`) picks the tagger per new session (HarnessHost now accepts a
tagger factory): a real cloud provider (Ollama Cloud, OpenAI, Anthropic) plus an Ollama Cloud key -> llm-extract
(`gemma4:cloud`, rank `lead`, base keyphrase-idf, every 6th user turn, prompt `DEFAULT_EXTRACTOR_PROMPT_VERSION` = v2);
a LAN Ollama whose selected model is a `:cloud` tag -> llm-extract through that app; anything else (mock, local models,
no key, a plain browser that cannot reach ollama.com) -> keyphrase-idf. Extractor failures and refusals return no
labels, so keyphrase-idf keeps tagging. Every network call is reserved against one persisted cap (`kvCallCounter`, 50 by
default; iOS/web: settings KV `llm-extract/calls`; desktop: `<userData>/llm-extract-calls.json`, `BH_LLM_MAX_CALLS`).
Rollback: settings `extractorPromptVersion: "v1"` (model picker toggle, `providers.setExtractorPrompt`), desktop also
`BH_LLM_PROMPT_VERSION=v1`. Session logs gain `{type:"final", top1, top3, top3Ids, tagger, extractorPromptVersion?, model?}`
and `interest_update.top1`; the exporter CSV has `top1_running, final_top1, final_top3, extractor_prompt_version,
extractor_model`. None carries the study mode. Tests: `apps/desktop/test/app-extractor.test.ts` (fake fetch only).

### Export

- Sidebar "Export logs": iOS `BHExport.share` (all session JSONL + interest map); Electron native save
  dialog (one zip); web: zip download. Session end on iOS: `BHExport.saveToDocuments` with that session.
- File names: `bh-session-<idx>-<startISO-compact>.jsonl` (study) / `bh-session-<startISO-compact>.jsonl`,
  sanitized + de-duplicated in JS (`plainFiles`).
- Analysis CSV: `npm run export-ratings -- <files|dirs> [-o out.csv] [--schedule unsealed.json] [--no-hooked]`
  (`packages/sim/src/export-ratings.ts`): one row per user turn, typing features + the turn rating + the
  session rating / hooked / blindGuess. No mode column; `--schedule` (the unsealed JSON) adds `mode` by
  study index and refuses a schedule whose hash differs from the sessions'.
