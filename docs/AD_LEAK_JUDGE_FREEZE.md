# Leak judge lj2: freeze candidate (Actor/Director Phase 1)

Owner: Harness Engineer. Status: **freeze candidate**, R4c not yet scored (scored once, by DirectorBot/the Researcher).
Supersedes lj1-11631f45 (Researcher rulings 5:33 PM, 2026-11-04).

## What is frozen
- Predictor files (the CLIs refuse unless these are byte-identical to the frozen commit): `packages/core/src/actor-director/`,
  `packages/core/src/ad-contracts/`, and the CLI itself (`scripts/ad-leak-freeze.ts`; the older `scripts/ad-leak-predict.ts`).
- Prompt: `LEAK_JUDGE_PROMPT_TEXT` (leak-judge.ts), id **`lj2-eeca9847`** (sha256[:8], pinned in ad-leak-judge.test.ts).
  It quotes LABELING_R4c.md rules A1-A4 verbatim; the judge returns `answer_first_violation` true | false | "uncertain".
  pivot_first forces answer_first_violation = true. "uncertain" or a missing field -> the verdict is uncertain -> the note is dropped.
- Judge model: suggested `gemma4:cloud` (different family from the Actor `gpt-oss:120b-cloud`; enforced). NOTE: every
  Worker MODEL_ROUTES entry, gemma4:cloud included, is `verified:false` in the Worker config; it must be verified first.
- Temperature 0 on every judge request (the Worker passes temperature through to Ollama).
- Tuning data: R4 dev + test (both in-sample) and the rule text of R4c/LABELING_R4c.md. No R4c item, input, label or score was opened.

## Freeze run (ruling A4) after the Researcher releases R4c/inputs.jsonl
```
git worktree add /tmp/lj2-freeze <frozen sha> && cd /tmp/lj2-freeze
npx tsx scripts/ad-leak-freeze.ts --in /workspace/actor-director/research/R4c/inputs.jsonl \
  --out /tmp/r4c-preds.jsonl --checkpoint /tmp/r4c-ckpt --commit <frozen sha> \
  --prompt-id lj2-eeca9847 --judge-model gemma4:cloud --max-calls 95 \
  --judge worker --approved-token-use          # with BH_WORKER_URL + BH_JUDGE_TOKEN in the env; mock is the default
```
- Rerun the identical command on the next day to resume. It refuses if the commit, prompt id, judge or actor model,
  temperature, uncertain policy or inputs sha differ. Exit 0 = complete, 3 = paused, 2 = refused.
- `--max-calls` is a hard per-run request cap (one retry per item max, counted). A Worker 429 stops the run.
- Only when every item is done: `/tmp/r4c-preds.jsonl` = `{id, codes, answer_first}` per line (answer_first = the
  answer-first VIOLATION, R4c's answer_first_violation) + `.meta.json` (config, runs, request count, token usage, model tags,
  per-code uncertain counts, predictions sha256). The checkpoint dir (0600) is private, not a deliverable.
- Logged per run: request count vs cap, model tags the responses name, prompt/completion token sums, non-secret
  rate headers (the Worker currently forwards none; usage comes from the body). The token is never printed.

## Call estimates (from R4c/README.md item counts only)
- R4c labels set: 282 items. One joint call per item (mind_reading and answer_first apply to every item) ->
  **expected 282** (+ retries for transient errors), **worst case 564** (one retry each).
  At `--max-calls 95`: 3 runs expected, up to 6 worst case. The Worker judge role cap is 100/day, so a **two-day split
  is not feasible** (needs >= 141/day): either 3+ days, or a temporary judge cap raise (InfrastructureBot).
- R4b (64 items, followed/pushback): 0 judge calls with the current offline predictor; if judged one call per item,
  expected 64, worst case 128. Counted separately; not covered by ad-leak-freeze.ts.

## Mock baseline (ruling A6): `npx tsx scripts/ad-r4-baseline.ts`
The mock judge is the E2 heuristic layer answering the lj2 judge request; it is not an independent model judgment,
and it was tuned on these items. Uncertain policy positive. Full output: `docs/AD_R4_MOCK_BASELINE_lj2.txt`.

| code (dev+test, n=333) | pos | P | R | uncertain |
|---|---|---|---|---|
| sensor | 37 | 1.000 | 1.000 | 0 |
| provenance | 39 | 1.000 | 1.000 | 0 |
| mind_reading | 39 | 1.000 | 1.000 | 0 |
| pivot_first | 38 | 0.927 | 1.000 | 0 |
| verbatim | 27 | 1.000 | 1.000 | 0 |
| forced_move | 34 | 0.895 | 1.000 | 0 |
| answer_first | 63 | 0.938 | 0.952 | 1 (0.3%) |

Dev (n=229): pivot_first P .893, forced_move P .926, answer_first P .930 R .976, others 1.00/1.00, 0 uncertain.
Test (n=104): forced_move P .818, answer_first P .952 R .909 (1 uncertain answer_first, counted positive), others 1.00/1.00.
- The last clean out-of-sample estimate (dev-tuned rules on R4 test, before the lj rounds) was: sensor R .667,
  provenance .80, mind_reading .545, pivot_first .692, forced_move .444, answer_first .727. Expect R4c with the mock to look
  like that, not like the table. A live judge model behind the same route is the expected path to the judge-code gate.
