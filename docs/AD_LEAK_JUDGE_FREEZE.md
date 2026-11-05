# Leak judge lj1: freeze candidate (Actor/Director Phase 1)

Owner: Harness Engineer. Status: **freeze candidate**, R4c not yet scored (scored once, by DirectorBot/the Researcher).

## What is frozen
- Predictor files (the CLI refuses unless these are byte-identical to the frozen commit): `packages/core/src/actor-director/`,
  `packages/core/src/ad-contracts/`, `scripts/ad-leak-predict.ts`.
- Prompt: `LEAK_JUDGE_PROMPT_TEXT` (leak-judge.ts), id **`lj1-11631f45`** (sha256[:8], pinned in ad-leak-judge.test.ts).
- Judge model on the judge route: `gemma4:cloud` (must differ from the Actor family; enforced). Deadline 2500 ms.
- Tuning data: R4 dev + test (both now in-sample) and the rule text of R4c/LABELING_R4c.md. No R4c item, input, label or
  score was opened.

## Running at freeze (after the Researcher releases R4c/inputs.jsonl)
```
git worktree add /tmp/lj1-freeze <frozen sha>     # or any later HEAD whose predictor files are unchanged
cd /tmp/lj1-freeze && npm ci && npx tsx scripts/ad-leak-predict.ts \
  --in /workspace/actor-director/research/R4c/inputs.jsonl --out /tmp/r4c-preds.jsonl --commit <frozen sha>
```
Writes `/tmp/r4c-preds.jsonl` (`{id, codes, answer_first, answer_first_violation, answered_first, uncertain, verdict,
status}` per line) and `/tmp/r4c-preds.meta.json` (commit, lj id, judge mode, uncertain policy, input + output sha256).
- `answer_first` is the answer-first **violation** flag (positive class = the reply did not answer first), the same
  value as `answer_first_violation` (R4c's gold field name). Please confirm score.py reads it that way.
- `--uncertain positive` (default) counts regex-uncertain codes the judge could not decide as positive, which is
  what the live gate does (it drops the note). On R4 dev+test no item is uncertain, so the policy changes nothing there.
- `--judge worker` (a live judge through the Worker's judge route) is refused unless `BH_WORKER_URL`,
  `BH_JUDGE_TOKEN` (a separate judge token) and `--approved-token-use` are all present. Never run in Phase 1.

## Honest statement on the gate (mock judge only)
The mock judge is the E2 heuristic layer answering the judge request; it is not an independent model judgment.
- R4 (both splits in-sample now): sensor, provenance, mind_reading, verbatim 1.00/1.00 on dev and test; pivot_first
  dev P .893 R 1.00, test 1.00/1.00; forced_move dev P .926 R 1.00, test P .818 R 1.00; answer_first dev P .930 R .976,
  test P 1.00 R .909.
- The last clean out-of-sample estimate (dev-tuned rules on R4 test, before this round) was: sensor R .667,
  provenance .80, mind_reading .545, pivot_first .692, forced_move .444, answer_first .727.
- Expectation for R4c (independent author, unseen phrasing): verbatim about 1.0 (mechanical). Sensor and provenance
  might reach .90 recall only if R4c's phrasings fall inside the clarified channel lists; mind_reading, pivot_first
  and forced_move at >= .80 recall and >= .80 precision are unlikely with the mock alone. A live judge model behind
  the same route is the expected path to the judge-code gate (needs the judge token approval).
