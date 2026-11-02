# BrianHarness: architecture (v0.2)

The "AI Director" is a chat bot that tries to discover what genuinely draws a person in,
first from **how they type**, later from **EEG**. This doc is the map; the code is small enough to read.

## 1. Stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** (hiddenInset traffic lights, `#141414`, 1440x900) | Same shell as LearnHarness; one codebase for Mac/Win/Linux |
| UI | **React 19 + Tailwind v4 + lucide icons**, built with **Vite** | Same visual system as LearnHarness (its tokens, fonts, radii) |
| Core | **TypeScript, headless, zero runtime deps** (`@brianharness/core`) | Runs in Electron main, the sim CLI, tests, and later a server |
| Models | `ModelBackend` interface: **Mock** (default, offline) + **OpenAI-compatible** (opt-in) | No spend without explicit opt-in; pi-ai can slot in as another backend |
| Storage | **JSONL per session** + **JSON save file per user** | Append-only, greppable, trivially loadable in Python/pandas |

**One deliberate deviation from LearnHarness:** LearnHarness is Electron + **Next.js** (a local
Next server inside Electron, with API routes). We use **Vite + plain React** in the renderer and run
the harness core in Electron's **main process over IPC**. Reasons: no HTTP server to package, no
`.next/standalone` build step, faster builds, and the core is a library, not routes. The look and
feel is identical; if we later want a web build, the same core can sit behind a tiny HTTP layer.

## 2. Repo layout

```
eeg-harness/
  packages/core/     @brianharness/core   headless harness (no UI, no Electron)
    src/types.ts         contracts: TypingEvent, FeatureMap, FrameState, DirectorPlan, LogEvent
    src/signals.ts       SignalSource plugin interface, TypingSignalSource, FakeEegSource
    src/engagement.ts    FeatureMap -> engagement score 0..1 (weights in one table)
    src/topics.ts        topic lexicon + detectTopics() (v0 keyword tagger)
    src/interest-map.ts  per-user save file: topic + question-style scores, hypothesis, UCB
    src/director.ts      the Director policy: explore / exploit / relax
    src/state-note.ts    the [DIRECTOR STATE] note injected before each Director turn
    src/backends.ts      ModelBackend, MockBackend, OpenAICompatibleBackend, createBackendFromEnv
    src/store.ts         SessionStore: sessions/<id>.jsonl + saves/<user>.interest.json
    src/session.ts       HarnessSession: the turn loop that ties it all together
  packages/sim/      @brianharness/sim    simulated-user test runner (CLI + library)
  apps/desktop/      @brianharness/desktop Electron app (electron/ = main+preload, src/ = React UI)
  docs/
```

## 3. The game-dev mental model

- **The Director = Left 4 Dead's AI Director.** L4D reads player stress every frame and paces the
  horde: *build-up, peak, relax*. Ours reads engagement every turn and paces the conversation:
  **EXPLORE** (scout topics we know little about), **EXPLOIT** (lean into the hot topic),
  **RELAX** (after a long streak on one topic with engagement dipping, change scenery).
- **"Director decides, model speaks."** Strategy (which topic, which question style) is a
  deterministic policy in `director.ts`. The language model only *voices* the plan. That keeps
  behaviour testable, reproducible in sims, and model-agnostic. (The mock backend is literally a
  template "voice actor".)
- **Per-turn layer = frame state.** `FrameState` is rebuilt every turn (engagement, baseline,
  lift, features, mentioned topics). It is cheap and in memory, like per-frame game state.
- **Interest map = save game.** `saves/<user>.interest.json` persists across sessions: running
  weighted means of engagement per topic and per question style. Autosaved after every turn with
  an atomic write, so a crash never corrupts it.
- **Session JSONL = replay file.** Every turn is appended to `sessions/<id>.jsonl`; with raw
  typing events on, a session can be fully replayed through a new estimator later.
- **State note = HUD for the model.** A ~100-word briefing injected as a system message right
  before each Director turn. The app also shows a human **Director HUD** panel (Ctrl+H), like a
  dev overlay.
- **Topic choice = multi-armed bandit.** Topics are arms; UCB1 balances "try unknowns" vs
  "pull the best arm". Spontaneous user mentions get bonus credit (the player wandered there).
- **Signal sources = input devices.** Typing today, BrainFlow EEG later, fake EEG for blind
  tests: all plug in the same way, like swapping keyboard for gamepad.

## 4. Data flow (one turn)

```
renderer (React)                         Electron main (Node)                 @brianharness/core
-----------------                        --------------------                 ---------
Director msg rendered -> shownAt
user types: input events  ---------->    (batched with the message)
  {t, kind: insert|delete|paste|nav, len}
Enter -> reply{text, events, sentAt, shownAt} --IPC--> session.markShown(shownAt)
                                                        session.reply(text, events, sentAt)
                                                          1 sources.summarize(window)  -> FeatureMap
                                                          2 textFeatures(text)         -> FeatureMap
                                                          3 estimateEngagement()       -> 0..1
                                                          4 FrameState (+ baseline EMA)
                                                          5 InterestMap credit assignment + autosave
                                                          6 planTurn()                 -> DirectorPlan
                                                          7 buildStateNote()           -> system msg
                                                          8 backend.generate()         -> text
                                                          9 JSONL: user_turn, interest_update, director_turn
<-- {director text, HUD state, engagement} --IPC--
```

Privacy: the composer records only the *class* of each edit (insert/delete/paste/nav), its
timestamp and the resulting length. It never records which key was pressed. Everything is local.

## 5. Signal-source plugin interface

```ts
interface SignalSource {
  id: string;                         // feature-key prefix: "typing", "eeg"
  kind: "typing" | "eeg" | "fake-eeg";
  start?(); stop?();
  push(sample: unknown): void;        // raw samples in
  summarize(w: {from, to}): FeatureMap; // per-turn features out, e.g. "eeg.engagementIndex"
  clear(before: number): void;
}
```

- `TypingSignalSource` (done): reply latency, compose time, keystrokes, deletions, deletion ratio,
  edits (delete-run then retype), pastes, long pauses (>=2s), longest pause, chars/sec, final length.
- `FakeEegSource` (done): emits alpha/beta/theta band power driven by a *hidden* engagement curve,
  summarised as `eeg.engagementIndex = beta/(alpha+theta)`. The estimator blends it in at 25% when
  present. Used for blind tests: the sim knows the truth, the Director doesn't.
- `BrainFlowSource` (next): a small Python sidecar (BrainFlow `SYNTHETIC_BOARD`, later a real
  headset) streaming band powers over stdio/WebSocket into `push()`, emitting the same `eeg.*` keys.
  Nothing downstream changes.

## 6. Data formats

**`sessions/<sessionId>.jsonl`** one event per line:

| type | fields |
|---|---|
| `session_start` | sessionId, userId, backend, sources |
| `director_turn` | turn, plan {mode, topic, altTopic?, style, reason}, stateNote, text, backend, genMs |
| `user_turn` | turn, text, features (FeatureMap), engagement, baseline, mentionedTopics, rawEvents? |
| `interest_update` | turn, topTopics [[topic, mean]], hypothesis |
| `session_end` | turns |

**`saves/<userId>.interest.json`**
```json
{ "version": 1, "userId": "local-user", "sessions": 3, "turns": 41,
  "topics": { "games": { "mean": 0.71, "n": 4.4, "last": 0.78, "updatedAt": "..." } },
  "styles": { "personal-story": { "mean": 0.63, "n": 6, "last": 0.7, "updatedAt": "..." } },
  "updatedAt": "..." }
```
App data lives in Electron `userData/data` (on a Mac: `~/Library/Application Support/BrianHarness/data`; the folder name is `brand.json#dataDirName`),
overridable with `EEG_DATA_DIR`.

## 7. Model backends

```ts
interface ModelBackend { id: string; paid: boolean; generate({messages, plan, stateNote}): Promise<{text}> }
```
- **MockBackend** (default): offline, seeded, template-based; never repeats a recent line.
- **OllamaBackend**: native `/api/chat` (temperature, seed). `detectOllama()` lists models via `/api/tags`.
  Local models are free; `*:cloud` models are marked paid.
- **OpenAICompatibleBackend**: any `/chat/completions` endpoint. A localhost base URL is free;
  a remote one is paid.
- **PiAiBackend** (`openai` / `anthropic`): ChatGPT subscription OAuth, Claude OAuth or API keys via
  pi-ai (MIT, lazily imported).
- **ClaudeCodeBackend**: shells out to the user's `claude -p` (their Claude Pro/Max login) with
  no tools, no MCP, no hooks, no session persistence, an empty temp cwd and `ANTHROPIC_API_KEY` stripped.
- **ProviderHub** (`providers/hub.ts`): status/detection for the picker, `login`/`setApiKey`/`logout`,
  `settings.json` persistence, and `createBackend()`. Credentials go to `FileCredentialStore`
  (`<userData>/credentials.json`, 0600, optionally encrypted by a `CredentialCipher`; the desktop app
  passes Electron safeStorage, which uses the macOS Keychain).
- **Paid rule**: the desktop app uses whatever Manny picks. The sim CLI and sidecar refuse any paid backend
  without `--allow-paid` (the sidecar also needs `options.allowPaid`).
- **HarnessSession.setBackend()** swaps the model mid-chat; the Director state is untouched.

## 8. Simulated-user test runner

`npm run sim -- --turns 12 --seeds 5 [--persona chef] [--fake-eeg] [--logs]`

Personas have a hidden passion, mild likes, dislikes, a hidden favourite question style and a typing
profile. A `SimUser` sees **only the Director's text** (never the plan), infers topic and style,
and replies with text plus synthetic keystrokes whose latency, length, pauses and deletions depend
on its hidden interest. Scored per run: `found` (final hypothesis == passion), `turnsToFind`
(turn after which the hypothesis stayed correct), style hit, engagement on vs off passion. A JSON
report goes to `data/sim/`.

Known limits: the sim user's style detection is tuned to the mock templates; with a real LLM the
sim should get an LLM-driven user (costs money, needs approval). The topic tagger is a keyword
lexicon (12 topics); an embedding tagger can replace `detectTopics()` behind the same signature.

## 9. Licensing note

LearnHarness is **AGPL-3.0**. We copied **no code**. We matched its *design*: palette hexes, type
ladder, radii, layout proportions, fonts. Assets reused: `cmunbx.ttf` (CMU Serif, SIL OFL, licence
file shipped alongside in `apps/desktop/public/fonts/OFL.txt`). JetBrains Mono and Source Sans 3
come from `@fontsource` (OFL). If Manny wants to reuse actual LearnHarness components later, the
app would need to be AGPL too (or get the author's permission).
