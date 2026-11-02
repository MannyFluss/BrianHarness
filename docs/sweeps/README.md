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
| `phaseC_tagger_track2.{md,jsonl}` | 8aaf3f4 | real gemma4:cloud responses from the Mac (via the local Ollama app), scored with `python3 tools/llm-extractor-eval/score.py` |
| `phaseC_tagger_idf_cc0_vs_wordfreq.{md,jsonl}` | 00901fb | license swap: keyphrase-idf with the bundled CC0 Common Voice table vs the dev-only wordfreq table (`--idf-freq-file`), all 144; NOTE the sim personas.json changed after track1, so compare within this file |
| `phaseC_tagger_idf_cc0_leak_check.txt` | 00901fb | both leak checks re-run with the CC0 table: PASS |
| `phaseC_tagger_track2_merge.{md,jsonl}` | this commit | llm-extract merge variants (old / evidence x3 / soft prior / lead=default) on the 24 matched sessions, cached answers only, + top-1 diagnosis; `python3 tools/llm-extractor-eval/score.py --tag track2_merge` |
| `phaseC_tagger_track2_merge_leak_check.txt` | this commit | both leak checks after the merge change: PASS |
| `phaseC_lead_eeg.md` | this commit | rank lead-eeg (opt-in, preset z 1.645): Track 2 logged EEG + synthetic EEG vs the prototype, rankLeadEeg design note, port review, held-out exposure disclosure |
| `phaseC_lead_eeg_synth.txt` | this commit | `tools/phaseC-tagger-eval/lead_eeg_synth.py`, 50 reps, Track 2 rows only |
| `phaseC_lead_eeg_parity.txt` | 1474a83 | rankLeadEeg vs rank_proto (blend) and the Researcher's port (pure): 0/338400 mismatches |
| `phaseC_gate_unique_check.md` | 870fccd | uniqueLabels: 8/8 gate typing finals unchanged vs 9ba666a, unscored |
| `phaseC_tagger_keyphrase_stoplist.{md,jsonl}` | this commit | keyphrase-idf evaluative-adjective/superlative stoplist + intensifier down-weight, all 144: top-1/top-3 keyphrase-only 2/3 -> 2/3, CC0 11/21 -> 12/22, wordfreq 11/23 -> 11/24 |
| `phaseC_tagger_track2_stoplist_leadeeg.{md,jsonl}` | this commit | Track 2 (24, cached answers, network 0) with the stoplist, incl. the lead-eeg column (lead 9/24 -> lead-eeg 11/24 top-1, 14/24 top-3 both) |
| `phaseC_tagger_keyphrase_stoplist_leak_check.txt` | this commit | both leak checks with the stoplist (evaluative list included): PASS |
| `phaseC_extractor_prompt_v2_leak_check.txt` | this commit | both leak checks with extractor prompts v1 + v2: PASS. v2 itself is UNSCORED (would need new calls; none made) |

The Researcher's own `sweep_results.json` (in eeg-harness-sim) is theirs and is not mirrored here.
