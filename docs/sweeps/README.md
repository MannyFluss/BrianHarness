# Sweep outputs

| File | Build | What |
|---|---|---|
| `offline_sweep_before_wip_1936PT.txt` | uncommitted WIP tree, ~7:36 PM PT Nov 1 2026 (not a commit; formerly misnamed `offline_sweep_before_34f22ac.txt`) | baseline before per-user EEG z-scoring + quality weighting |
| `offline_sweep_after_eeg_zscore_quality.txt` | ad28904 | after z-scoring + quality weighting |
| `offline_sweep_final.txt` | de8ade1 | final rerun after open-vocab tagging / sidecar |
| `offline_sweep_v2_keyphrase_before_db609a4.txt` | db609a4 | Researcher's `offline_sweep_v2.mjs --tagger keyphrase`, before the parent roll-up (identical to their `sweep_v2_keyphrase_new.out`) |
| `offline_sweep_v2_keyphrase_after_rollup.txt` | ff69539 | same, after the keyphrase→parent roll-up |
| `offline_sweep_v2_lexicon_after_rollup.txt` | ff69539 | lexicon regression check (±1 pt vs the Researcher's `sweep_v2_lexicon_new.out`) |
| `offline_sweep_v2_keyphrase_only.txt` | the commit that adds `keyphrase-only` (see git log for this file) | leak-free tagger. Scorer matches broad ids only, so `found` ≈1% is a scorer limit (kp: labels never equal `space`/`cooking`). |
| `offline_sweep_v2_keyphrase_generic.txt` | same commit | curated list minus the 8 persona passions; identical to `keyphrase` on the TS personas |
| `phaseC_tagger_track1.{md,jsonl}` | 00c9b5a | Phase C track 1: offline replay of all 144 Phase B sessions (replay_b method, sim rescore.py), keyphrase-only vs keyphrase-idf |
| `phaseC_tagger_leak_check.txt` | 00c9b5a | sim's `phaseC/check_personas_leak.mjs personas_c.json` (curated lists) + `tools/phaseC-tagger-eval/leak_check_idf.mjs` (idf stopwords, extractor prompt, neutral-convo labels) |
| `phaseC_tagger_track2_dryrun.{md,jsonl}` | 00c9b5a | track 2 plumbing test against `fake_server.mjs`; NOT a model result |
| `phaseC_tagger_track2_oracle_ceiling.{md,jsonl}` | 00c9b5a | track 2 ceiling: the persona's own passion injected as the extractor output; NOT a model result |
| `phaseC_tagger_track2.{md,jsonl}` | (pending) | real gemma4:cloud responses from the Mac, scored with `python3 tools/llm-extractor-eval/score.py` |

The Researcher's own `sweep_results.json` (in eeg-harness-sim) is theirs and is not mirrored here.
