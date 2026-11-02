# Sweep outputs

| File | Build | What |
|---|---|---|
| `offline_sweep_before_wip_1936PT.txt` | uncommitted WIP tree, ~7:36 PM PT Nov 1 2026 (not a commit; formerly misnamed `offline_sweep_before_34f22ac.txt`) | baseline before per-user EEG z-scoring + quality weighting |
| `offline_sweep_after_eeg_zscore_quality.txt` | ad28904 | after z-scoring + quality weighting |
| `offline_sweep_final.txt` | de8ade1 | final rerun after open-vocab tagging / sidecar |
| `offline_sweep_v2_keyphrase_before_db609a4.txt` | db609a4 | Researcher's `offline_sweep_v2.mjs --tagger keyphrase`, before the parent roll-up (identical to their `sweep_v2_keyphrase_new.out`) |
| `offline_sweep_v2_keyphrase_after_rollup.txt` | ff69539 | same, after the keyphrase→parent roll-up |
| `offline_sweep_v2_lexicon_after_rollup.txt` | ff69539 | lexicon regression check (±1 pt vs the Researcher's `sweep_v2_lexicon_new.out`) |

The Researcher's own `sweep_results.json` (in eeg-harness-sim) is theirs and is not mirrored here.
