# Leak-judge runs on Manny's Mac (for Hermes Bridge): RUN_ON_MAC

One self-contained Node script, `runner.mjs`. It holds the FROZEN judging code from commit
`3b425dda90116f5cda7e0ca0d5f99625688888b5` (leak-judge, leaks, leak-predict, leak-freeze, the Worker client),
unmodified. `MANIFEST.json` gives the sha256 of every bundled frozen file and of the same file at 3b425dd; they are
equal. Around that code is a small wrapper that adds the token file, the local hard caps and the stop rules.

- Inference stays in the cloud. The only network traffic is HTTPS POSTs to the Worker (`/v1/chat/completions`, role
  `judge`, model `gemma4:cloud`, temperature 0). There is no npm install, no native code and no other downloads.
- **Node ≥ 18.17** (tested with v24). Nothing else is needed.
- The token is read from `~/.config/brianharness/judge-cal-token` (the plain `judge-cal` device token from
  InfrastructureBot), or from the file named by `BH_JUDGE_TOKEN_FILE`. It is never printed, logged or written
  anywhere, and it must not go in a command line.

## 0. Transfer (same method as the E7b app zip)

The bot copies these two files from the box into `~/Downloads` on the Mac:
`/workspace/actor-director/release/judge-mac/brianharness-judge-runner.tar.gz` and `.../judge-mac/SHA256SUMS`.
The expected sha256 of the tarball is also in the Engineer's message.

## 1. Install (Terminal, once)

```sh
mkdir -p ~/BH-judge && mv ~/Downloads/brianharness-judge-runner.tar.gz ~/Downloads/SHA256SUMS ~/BH-judge/
cd ~/BH-judge
shasum -a 256 brianharness-judge-runner.tar.gz      # must equal line 1 of SHA256SUMS and the Engineer's message
tar -xzf brianharness-judge-runner.tar.gz
shasum -a 256 -c SHA256SUMS                         # 3 lines, all OK
node --version                                      # v18.17 or newer
ls -l ~/.config/brianharness/judge-cal-token        # must be -rw------- ; otherwise: chmod 600 ~/.config/brianharness/judge-cal-token
cd ~/BH-judge/brianharness-judge-runner && node runner.mjs manifest | head -4   # prints runner.mjs sha256 + frozen_commit 3b425dd...
```

## 2. Verify run (30 R4 items shipped in the bundle; NOT R4c)

```sh
cd ~/BH-judge/brianharness-judge-runner
export BH_WORKER_URL="https://<the Worker URL from the Engineer>"
node runner.mjs verify --judge-model gemma4:cloud; echo "exit $?"
```

The run uses at most 30 requests, plus at most 5 retries: the verify stage is capped at 35 requests ever. Output goes
to `~/BrianHarness/judge-runs/verify/`. At the end the runner prints a summary: the exit code; requests this run;
today's count against 95; the verify total against 35; prompt and completion token sums; the model tags seen; and
P/R per code for the judge vs the mock on the same items.

**After verify: STOP.** Send the outputs back (section 4). Do not start R4c.

## 3. R4c run (ONLY on the Engineer's go, after the Researcher releases the R4c inputs)

The R4c inputs are NOT in the bundle. They arrive separately. Put them at `~/BH-judge/r4c-inputs.jsonl` and check their
sha256 against the one you were given (`shasum -a 256 ~/BH-judge/r4c-inputs.jsonl`). Then:

```sh
cd ~/BH-judge/brianharness-judge-runner
export BH_WORKER_URL="https://<the Worker URL from the Engineer>"
node runner.mjs r4c --in ~/BH-judge/r4c-inputs.jsonl --judge-model gemma4:cloud; echo "exit $?"
```

- **Same bundle as the verify.** R4c refuses (exit 2) unless `~/BrianHarness/judge-runs/verify/summary.json` is a
  completed verify (exit 0) whose `runner_mjs_sha256` and `wrapper_sha256` equal this runner's. Don't re-copy or rebuild
  the bundle between verify and R4c. (`--verify-summary PATH` points elsewhere.)
- **Cloud only, no fallback.** `--judge-model` must end in `:cloud` and be `gemma4:cloud`. The Worker URL must be
  https and is refused (exit 2, nothing sent) if its host is localhost, loopback, private or link-local (10/8, 172.16/12,
  192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10), `*.local`, port 11434, or a local `ollama` host.
- **Run header.** `predictions.jsonl` is the frozen one-line-per-item format, so the header goes in the sidecar
  `predictions.header.json`. It is also embedded as `run_header` in `predictions.meta.json` and as `header` in
  `summary.json`. It holds the frozen commit and digest, runner.mjs sha256 (stands in for the bundle; the tarball sha
  can't be known from inside it, and is in SHA256SUMS), wrapper sha256 and commit, prompt id, model, temperature 0,
  retries 1, deadline 90 s, and the endpoint host only. It never holds the token.
- **One R4c run per day.** The runner refuses a second R4c run on the same Pacific day. If it pauses (exit 3), run
  the SAME command the next day: it resumes from `~/BrianHarness/judge-runs/r4c/ckpt/`. It refuses to resume if the
  inputs, prompt, model or commit changed.
- Do not open, edit or share the R4c inputs or the outputs, other than sending them back to the Engineer.

## 4. What to send back

Send `summary.json` and the output files, but **NOT `ckpt/`**. Also send the ledger (it holds counts only):

```sh
cd ~/BrianHarness/judge-runs
tar -czf ~/BH-judge/verify-results.tgz --exclude ckpt verify -C ~/.config/brianharness judge-cal-ledger.json   # for R4c: r4c-results.tgz ... r4c
```

The bot pulls the `.tgz` back to the box (CopyToBox), the same way the bundle came over. The files are `summary.json`,
`predictions.jsonl`, `predictions.meta.json`, `requests.jsonl` (per request: status, model tag, tokens and latency;
no content) and, for verify, `report.txt` and `mock-predictions.jsonl`. None of these files contains the token.

## 5. Exit codes and stop rules

| exit | meaning | what to do |
|---|---|---|
| 0 | complete | send the outputs back; STOP |
| 2 | refused, nothing sent (token file missing, empty, or not mode 600; wrong `--judge-model`; no URL; R4c already ran today; a resume with drifted config; the bundle was altered) | fix what it says (e.g. `chmod 600 …`); for a drift or alteration refusal, ask the Engineer |
| 3 | paused at a local cap (95 requests per Pacific day, all stages together, or 35 verify requests ever) | rerun the same command on another day (verify only if the Engineer says so) |
| 4 | stopped: Worker 429, or 3 consecutive (6 total) 5xx, network or timeout failures | send `summary.json` back; rerun only on the Engineer's go |
| 5 | stopped: a response named a model outside the gemma4 family (`gemma4:cloud`, `gemma4:31b`), or no model at all | do NOT rerun; send `summary.json` and `requests.jsonl` back |
| 1 | unexpected error | send the terminal output back |

- Every request is counted in `~/.config/brianharness/judge-cal-ledger.json` BEFORE it is sent, retries included,
  and each ledger write is crash-safe. Never edit or delete the ledger.
- Only one run at a time; a lock file next to the ledger enforces this.
- Only `--judge-model gemma4:cloud` is accepted, and the temperature is fixed at 0.
