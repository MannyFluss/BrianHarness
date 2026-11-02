# LLM interest-extractor eval (Phase C track 2)

Runs on Manny's Mac through the **signed-in Ollama app** (`http://127.0.0.1:11434`), which forwards `:cloud` models
to Ollama's cloud, the same way Phases B and C ran. **No API key is needed.** The script is self-contained (`run.mjs` +
`prompts.jsonl`): Node >= 22.19, stdlib only, no npm install, no repo build.

## What it does

For 24 Phase B sessions (3 per persona, picked by a fixed hash order; list in `sessions.json`), it sends the prepared
extractor prompt to `/api/chat` with `stream:false`. The prompt is a system prompt with no hobby examples, plus the
user's messages. Each session is sent twice: after user turn 12 (the whole session) and after user turn 6. The answers
come back to the box, where they are scored offline against the keyphrase-only baseline and keyphrase-idf on the same
sessions.

## Exact commands (Mac)

```bash
cd tools/llm-extractor-eval                              # copy this whole folder to the Mac
node run.mjs --base-url http://127.0.0.1:11434 --status  # 0 calls: shows base, counter, what would be sent
node run.mjs --base-url http://127.0.0.1:11434           # gemma4:cloud, 24 sessions x turns 12 then 6 = 48 calls
```

Optional alternative to the default (still 48 calls, turn 12 only, two models):
`node run.mjs --base-url http://127.0.0.1:11434 --models gemma4:cloud,gpt-oss:120b-cloud --turns 12`.
gpt-oss requests get `num_predict` >= 512 automatically; `gpt-oss:20b-cloud` prompts are prepared too.

## Base URL, auth and the safety check

- **Local** (`localhost` or `127.0.0.1`, any port): no `Authorization` header is ever sent, even if `OLLAMA_API_KEY`
  happens to be set. **Safety:** before any call, it refuses to start if any model in `--models` or in `prompts.jsonl`
  is not a cloud tag (`name:cloud` or `name:<tag>-cloud`), so nothing can run on the Mac itself by accident.
- **Remote** (`https://ollama.com`): needs `OLLAMA_API_KEY` and sends `Authorization: Bearer ...`. The direct API uses
  different names, so request bodies are mapped: `gemma4:cloud -> gemma4:31b`, `gpt-oss:120b-cloud -> gpt-oss:120b`,
  `gpt-oss:20b-cloud -> gpt-oss:20b` (`REMOTE_NAMES` in run.mjs; the map is untested against the live API).
  Cache keys and outputs keep the app names, so scoring is identical.
- **Default** when `--base-url` is omitted: remote if `OLLAMA_API_KEY` is set, otherwise local `http://127.0.0.1:11434`.
  Pass `--base-url` explicitly anyway.
- Any other host is refused unless `--dry-run` is given (fake server tests only).

## Call budget

- **Hard cap: 50 network calls in total**, across all runs and models, persisted in `out/calls.json`. A call counts
  before it is sent, so timeouts and errors count. `--max-calls N` can only lower it.
- The default uses 48. Rerunning is free for anything already answered: OK responses are cached in `out/cache/<key>.json`
  and never requested again. Only failed prompts are re-sent, and only while the cap allows.
- It stops early on 401/403 (bad key, or the app is not signed in), 429 (rate limit), or 3 failures before any success.

## Expected runtime

Requests are serial. gemma4:cloud usually takes about 3–15 s per call, so 48 calls take about **3–12 minutes**
(the timeout is 180 s per call). gpt-oss models are slower (they think first).

## Outputs (copy `out/` back to the box)

- `out/responses.jsonl`: one line per answered prompt, `{key, model, session, persona, turn, status, ok, raw}`. `raw` is the
  full /api/chat response body. The file is rewritten from the cache on every run.
- `out/cache/`: the raw responses. `out/calls.json`: the counter plus a timestamp log. `out/errors.jsonl`: failures, if any.

## Scoring (box)

```bash
# put the returned folder at tools/llm-extractor-eval/out/, then:
python3 tools/llm-extractor-eval/score.py          # -> docs/sweeps/phaseC_tagger_track2.{md,jsonl}
```

The table is built on the matched subset: sessions with an OK turn-12 answer for every model. Rows:
- keyphrase-only (baseline)
- keyphrase-idf
- llm-extract + keyphrase-idf, in session
- llm-extract alone, in session
- the LLM's own top-3 at turn 12, with no session

The replay never calls the network (it strips OLLAMA_API_KEY; the sidecar is offline and reads cache hits only).

## Box-side files

- `prepare.mjs`: regenerates `sessions.json` / `prompts.jsonl` from the sim transcripts (needs the built repo). The prompt
  keys equal the sidecar's cache keys.
- `fake_server.mjs` + `node run.mjs --dry-run --base-url http://127.0.0.1:8765`: the fake-server dry run. State goes to
  `out-dry/`, and the real counter is untouched. Without `--dry-run`, any base URL other than https://ollama.com is refused.
