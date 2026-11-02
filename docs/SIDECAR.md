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
| `tagger` | `{"kind":"lexicon"}` (default) \| `{"kind":"keyphrase"}` \| `{"kind":"keyphrase-only"}` (leak-free) \| `{"kind":"keyphrase-idf"}` (leak-free, IDF) \| `{"kind":"llm-extract","model":"gemma4:cloud","everyN":6,"cacheDir":"...","maxCalls":50,"rank":"lead"}` (paid; `rank` `lead`\|`lead-eeg`\|`soft`\|`none`; `promptVersion` `v1` (default) \| `v2`) \| `{"kind":"keyphrase-generic"}` \| `{"kind":"lexicon-generic"}` \| `{"kind":"keyphrase","lexicon":"full\|generic\|broad\|none"}` \| `{"kind":"ollama","model":"gemma3:4b","baseUrl":"..."}` |
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
- `--bh-tagger lexicon|lexicon-generic|keyphrase|keyphrase-generic|keyphrase-only|keyphrase-idf|llm-extract|ollama`.

It also logs `director_impl: "brianharness"` and the same row schema:

```bash
python3 sim.py --mock --smoke --conditions typing,brianharness                               # offline check
python3 sim.py --conditions baseline,typing,brianharness --bh-allow-paid --bh-tagger ollama   # gemma4:cloud = paid
```

**Label leak (defaults unchanged on purpose).** The curated specific-hobby list (`SPECIFIC_TOPICS` in
`packages/core/src/tagger.ts`) contains the 8 Phase-A persona passions verbatim (`SIM_PERSONA_SPECIFICS`:
big-year birding, watch restoration, slime molds, ham radio, NES Tetris, urban sketching, Byzantine
history, beekeeping). `lexicon` (default) **and `keyphrase`** both merge that list, so a "correct"
specific guess on those personas can be a leaked label rather than discovered vocabulary.

| tagger | curated specifics | broad topics (space, cooking, ...) | labels |
|---|---|---|---|
| `lexicon` (default), `keyphrase` | all | yes | can leak persona passions |
| `lexicon-generic`, `keyphrase-generic` | all except the 8 persona passions | yes | no persona leak; other curated hobbies stay |
| `{"kind":"keyphrase","lexicon":"broad"}` | none | yes | broad categories + user's phrases |
| `keyphrase-only` | none | none | **only the user's own words** (`kp:` phrases) |
| `keyphrase-idf` | none | none | **only the user's own words**, IDF-weighted (`kp:` topics) |
| `llm-extract` | none | none | keyphrase-idf + labels a cloud LLM names from the transcript (`o:`), no examples in its prompt |

For honest open-vocab numbers on the Phase-A personas use `--bh-tagger keyphrase-only` (or
`keyphrase-generic` to keep non-persona curated hobbies). `keyphrase-only` rolls a phrase up to its
phrase cluster (the recurring word it most often shares messages with, e.g. `kp:ham-radio` -> `kp:radio`),
or keeps the phrase as its own root. A test asserts it never emits a curated label that isn't in the
user's text. Note that the Director's own question topics are still broad categories, so broad topics
can enter the interest map through the questions it asks, not through tagging.

### `keyphrase-idf` (leak-free, IDF-weighted)

No curated hobby list. Words are weighted by IDF against a bundled general-English frequency list
(`packages/core/src/wordfreq/cv-en.ts`, computed from the [Mozilla Common Voice](https://github.com/common-voice/common-voice)
English sentences, **CC0 1.0**, see `FREQ_LICENSE.md` and `NOTICE.md`; regenerate with `scripts/gen-freq-cv.py`):
`idf = max(0, 6 - zipf)`, words missing from the list (zipf < 3) count as rare.

Research-only alternative table (never bundled): wordfreq `small_en` (CC BY-SA 4.0) at
`research/wordfreq/wordfreq_small_en_zipf10.txt`. Select it per session with
`{"kind":"keyphrase-idf","freqFile":"research/wordfreq/wordfreq_small_en_zipf10.txt"}` (for llm-extract:
`"baseOptions":{"freqFile":...}`), or for every session with env `BH_IDF_FREQ_FILE=<path>`. Any file in the same
`<zipf*10>:<words>` line format works. `hud.tagger.freq` names the table in use. In code (core stays fs-free):
`createTagger({ kind: "keyphrase-idf", freqTable: parseZipf10(text, "name") })`.

It keeps proper-noun spans and multiword names ("Basil II",
"Hagia Sophia"), drops stopwords / common verbs / fillers / mood words, and down-weights -ing verbs and
-ed/-ous/-ful/... modifiers. Each message gets at most one `kp:` tag: its distinctive terms are threaded into
a running cluster (shared words, sub-word matches like bees/honeybees/hive/hives, continuity with the last
message), so evidence aggregates across turns without a list. The label is the cluster's heaviest member.
`observeWeight` scales how much an unprompted mention counts by how distinctive the message is relative to
the user's own usual message. Options: `minScore` 1.6, `minRepeats` 2, `maxZipf` 5.3, `link` 3.

### `llm-extract` (paid, cloud)

`keyphrase-idf` tags every turn; every `everyN` user turns (or at `atTurns`) the last `contextTurns` user
messages go to `model` (default `gemma4:cloud`) at `https://ollama.com/api/chat` (`stream:false`,
`Authorization: Bearer $OLLAMA_API_KEY`), and the named interests become `o:` tags. The sidecar only goes to
the network with `allowPaid` + `--allow-paid` + `OLLAMA_API_KEY`; otherwise it is offline (cache hits only).
`cacheDir` caches every response (`<key>.json`) and enforces a hard `maxCalls` cap (default 50) persisted in
`<cacheDir>/calls.json`; `responsesFile` (JSONL `{key, raw}`) is a read-only cache for scoring responses
gathered elsewhere (`tools/llm-extractor-eval/`). `hud` reports `tagger.calls`
(`{network, cached, refused, failed, retried, http: {<status>: n}, lastError}`, per session/case instance).

- **Call cap is atomic.** Every reservation re-reads `<cacheDir>/calls.json` under an exclusive lock file
  (`calls.json.lock`, `O_EXCL`) and writes via rename. Parallel cases and separate processes that share one
  `cacheDir` therefore count exactly and share the cap. The old counter read the file once per instance and
  lost updates (mock: 1 recorded for 3 made). For a per-case cap, give each case its own `cacheDir`.
- **Local Ollama app.** A `baseUrl` on `localhost` / `127.0.0.1` / `[::1]` needs no key. No `Authorization`
  header is sent, and the sidecar treats it as online whenever paid network is allowed. Only cloud tags
  (`:cloud`, `-cloud`) are forwarded, so nothing runs on the local machine (the same rule as
  `tools/llm-extractor-eval/run.mjs`). Any other model is refused, counted under `calls.refused`, and the reason
  goes into `lastError`. `allowLocalModels: true` lifts the refusal.
- **Errors and retries.** A non-2xx reply fails with `extractor HTTP <status>: <start of body>` in
  `calls.lastError` (the key is never included). A 5xx is retried at most `retries` (default 2) times with
  backoff `retryDelayMs` (default 500 ms, doubled each time). Every retry is reserved against the cap like a
  first try, so a full cap stops retrying. A 4xx or a network error is not retried. Once the attempts are used
  up, the tagger falls back to the base tagger for that call.
- **Live sim cadence.** The live sim (`sim.py`) never sends the persona's last message (turn 12), because
  there is no Director turn after it. The last extractor call therefore lands at user turn 11, which is why the
  gate preset uses `--bh-extract-turns 6,11`. The offline replays here (`tools/llm-extractor-eval`, cadence 6,12)
  see all 12 turns. To make a live run match, use the sim's `--bh-feed-last`, which sends turn 12 and discards
  one extra Director call per case. HE needs no change for this.

Final-guess merge (`rank`, default `"lead"`): the latest non-empty extractor answer leads `final_guesses` /
`top3` in the extractor's own order, keyphrase-idf topics fill the remaining slots (all of them before the
first non-empty answer, so an empty or failed reply falls back to keyphrases), and keyphrase topics whose words
all occur in a ranked label are dropped as duplicates (`aliasBase`, default true). `"soft"` adds
`priorWeight` (default 0.5) x 0.85^rank to the engagement score instead; `"none"` is the pre-merge behaviour.

`"lead-eeg"` (opt-in) works like `"lead"`, but EEG may reorder the extractor's own labels. Under plain
`"lead"`, EEG reaches only the keyphrase fill slots, so EEG minus sham on the extractor's labels is exactly 0.

- **Base order.** The extractor's list order. Its confidences are not re-sorted, so ties in confidence keep
  list order.
- **Signal.** For each label: the mean within-session z of ln(`eeg.engagementIndex`) over the user turns it
  cites. Only turns with usable EEG quality count, and the session needs at least `LEAD_EEG_MIN_TURNS` = 4
  such turns.
- **Move rule.** A label moves above an earlier one only if it beats it by more than
  `LEAD_EEG_Z * sqrt(1/k_a + 1/k_b)` (k = cited turns with EEG).
- **The constant.** `LEAD_EEG_Z` = 1.645 is a one-sided 5% test of "no difference" for unit-variance noise.
  It was fixed a priori, not tuned on any persona set. Pure noise therefore swaps a given adjacent pair in
  at most about 5% of sessions, and near-ties keep the extractor's order.
- **No EEG.** A label with no EEG on its turns never moves and is never passed. Without EEG, `"lead-eeg"`
  equals `"lead"`.
- **Override.** `leadEegZ` overrides the constant (research only).

Sweep: `docs/sweeps/phaseC_lead_eeg.md`.

Final labels are unique. A label shown once is not shown again (case and punctuation ignored), so the
keyphrase clusters `kp:alright` and `kp:alright-2` no longer both appear as "alright".
Interest-map evidence is unchanged by `rank` (`observeScale` multiplies the extractor tags' evidence weight).
Taggers without an extractor have no prior, so their ranking is unchanged. Sweep: `docs/sweeps/phaseC_tagger_track2_merge.md`.

### Extractor prompt versions

`promptVersion` picks the extractor system prompt; it is part of the cache key (`promptKey` hashes model + messages).
- `v1` (default): the prompt every cached answer was made with, so all cached replays (Track 2, gate) still hit.
- `v2`: ranks interests by the enthusiasm the user shows (not by how often a word appears) and excludes routines,
  chores, errands, work tasks and logistics (meal prep, commuting, cleaning, paying bills). Still no examples, so it names no passion; both
  leak checks cover both versions.
- v2 is **unscored**: no v2 answers are cached, and scoring it needs new extractor calls (none were made). Offline, a
  v2 extractor refuses instead of falling back to a v1 answer.
