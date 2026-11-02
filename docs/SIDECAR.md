# BrianHarness sidecar + Python adapter

The real Director (`HarnessSession` from `@brianharness/core`) behind a **JSON-lines stdio
protocol**, so any language (the Researcher's Python `sim.py`) can drive it.

## Setup (Mac or Linux)

```bash
# Node >= 22.19 (same floor as README / engines), in the repo root
npm install          # pi-ai is a dependency but loaded lazily: mock/ollama sessions never import it
npm run build        # builds packages/core/dist + packages/sim/dist (sidecar = packages/sim/dist/sidecar.js)
node packages/sim/dist/sidecar.js            # free backends only (mock, local Ollama)
node packages/sim/dist/sidecar.js --allow-paid   # also lets a session opt in to paid backends
```

## Protocol `brianharness-sidecar/1`

One JSON object per line on stdin; exactly one JSON response line per request on stdout (stderr is
free-form logs). Requests are processed in order. Any request may carry `"id"`, which is echoed
back. Every response has `"ok": true|false`, `"cmd"`, and on failure `"error"`.
One session at a time; after `end` you can `start` again.

| cmd | request fields | response fields |
|---|---|---|
| `hello` | — | `protocol` |
| `start` | `options` (below) | `sessionId`, `backend`, `paid`, `director: {text, plan}` (the opening) |
| `reply` | `text`, optional `features` (FeatureMap), `events` (TypingEvent[]), `sentAt`, `shownAt` (ms) | `turn`, `user: {engagement, baseline, lift, hypothesis, hypothesisLabel, mentionedTopics, words, eeg}`, `director: {text, plan}`, `top3` (FinalGuess[]) |
| `hud` | — | `hud` (HudState), `ledger: {topicId: {label, mean, n}}` |
| `final_guesses` | `k` (default 3) | `guesses` (FinalGuess[]) |
| `end` | `k` | `guesses`, `ledger`, `turns` |

`start.options` (all optional):

| field | meaning |
|---|---|
| `provider` | `mock` (default) \| `ollama` \| `ollama:<model>` \| `openai-compatible` \| `openai` \| `anthropic` \| `claude-code` |
| `model`, `ollamaUrl`, `baseUrl` | model id; Ollama base URL (default `http://127.0.0.1:11434`); OpenAI-compatible base URL. `ollama` without a model auto-detects the first local model via `/api/tags`. |
| `temperature`, `seed`, `backendSeed` | sampling temperature; session seed (Director RNG, typing synthesis, and backend seed unless `backendSeed` is set) |
| `allowPaid` | must be `true` **and** the process started with `--allow-paid` for paid backends (`*:cloud` Ollama models, remote APIs, subscriptions). Local Ollama / mock never need it. |
| `eegWeight` | base EEG blend weight (default 0.25) |
| `engagement` | `EegBlendOptions`: `{weight, zScore, minHistory, qualityWeighting, agreementWeighting, refWindowSec, flatBoost, typingSdLow, typingSdHigh, maxWeight}` |
| `tagger` | `{"kind":"lexicon"}` (default) \| `{"kind":"keyphrase"}` \| `{"kind":"ollama","model":"gemma3:4b","baseUrl":"..."}` |
| `userId`, `sessionId`, `dataDir` | ids; `dataDir` writes the session JSONL + interest-map save file there |
| `charsPerSec` | speed for synthesized typing (default 5) |

**Typing:** if a `reply` has no `events`, typing events are **synthesized from the text only**
(deterministic per seed, `synthesizeTypingFromText`), so they carry nothing but length.
**EEG / other features:** pass per-turn `features`, e.g. the output of `eegsynth.mjs`
(`eeg.engagementIndex`, `eeg.quality`, `eeg.windowSec`, `eeg.emg`, `eeg.beta`, `eeg.blinks`, ...).
They go through the official `PreparedFeatureSource` and apply to that turn only.
`user.eeg` echoes the blend diagnostics (`engagement.eegWeight`, `engagement.eegQuality`,
`engagement.eegZ`, `engagement.typingReadability`, `engagement.eegAgreement`, ...).

**FinalGuess:** `{topic, label, score, mean, n, persistence, parent?}`. It is ranked by recency-weighted persistence
in the live top-3 plus lift over this user's baseline, with a bonus for specific (open-vocab) topics. No LLM call.
A topic that led mid-session is not displaced by a one-turn spike.

### Example

```
> {"cmd":"start","options":{"provider":"ollama","model":"gemma3:4b","seed":11,"temperature":0.7}}
< {"ok":true,"cmd":"start","protocol":"brianharness-sidecar/1","sessionId":"...","backend":"ollama:gemma3:4b","paid":false,"director":{"text":"Hey! ...","plan":{...}}}
> {"cmd":"reply","text":"did a ham radio contest all weekend","features":{"eeg.engagementIndex":0.82,"eeg.quality":1,"eeg.windowSec":24}}
< {"ok":true,"cmd":"reply","turn":1,"user":{"engagement":0.47,"hypothesis":null,...},"director":{"text":"..."},"top3":[{"topic":"x:ham-radio","label":"amateur (ham) radio",...}]}
> {"cmd":"final_guesses","k":3}
< {"ok":true,"cmd":"final_guesses","guesses":[...]}
> {"cmd":"end"}
```

## Python adapter (for `sim.py`)

`adapters/python/brianharness_director.py` uses only the stdlib. `BrianHarnessDirector` is a drop-in for
`StandInDirector`:

- `opening()` returns the opening message.
- `respond(user_text, features=None)` returns `(reply, top3_labels, signals)`. `signals` has the
  `words, questions, exclaims, warmth_hits, engagement, user_median_words, ledger_top3` keys,
  plus `hypothesis` and `eeg`.
- `final_guesses()` returns 3 labels from the anti-drift API.
- `.ledger` is `{label: mean}`.
- `.director_impl` is `"brianharness"`.
- `close()` shuts the sidecar down.

```python
import sys; sys.path.insert(0, "/path/to/brianharness/adapters/python")
from brianharness_director import BrianHarnessDirector
d = BrianHarnessDirector(provider="ollama", model="gemma3:4b", ollama_url="http://127.0.0.1:11434", seed=11, temperature=0.7)
```

`adapters/python/sim.py.brianharness.patch` adds a third condition, `brianharness`, to the Researcher's sim.py. Apply it with
`cd eeg-harness-sim && patch -p0 < .../sim.py.brianharness.patch`. It adds these flags:

- `--bh-adapter-dir`;
- `--bh-provider`: default mock with `--mock`, else ollama with `--director-model` and `--url`;
- `--bh-allow-paid`: needed for `*:cloud`;
- `--bh-eeg-weight`;
- `--bh-tagger lexicon|keyphrase|ollama`.

It also logs `director_impl: "brianharness"` and the same row schema:

```bash
python3 sim.py --mock --smoke --conditions typing,brianharness                               # offline check
python3 sim.py --conditions baseline,typing,brianharness --bh-allow-paid --bh-tagger ollama   # gemma4:cloud = paid
```

Caveat: the default lexicon tagger's curated hobby list includes the 8 Phase-A passions, so lexicon
runs on those personas are optimistic. Report `--bh-tagger keyphrase` or `ollama` for honest open-vocab numbers.
