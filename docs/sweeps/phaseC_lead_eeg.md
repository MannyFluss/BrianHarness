# rank "lead-eeg" (opt-in; "lead" stays the default)

Code: b54e193 (`rank: "lead-eeg"`, `eegReorder`, preset `LEAD_EEG_Z = 1.645`, `LEAD_EEG_MIN_TURNS = 4`),
1474a83 (`rankLeadEeg` wrapper, PREREG_leadeeg §9). No LLM calls anywhere below (cached answers only).

## Rule (one preset constant, not tuned)
Base order = the extractor's own list order. Per label: mean within-session z of ln(engagementIndex) over the user
turns it cites (sample SD, >= 4 EEG turns in the session, else no reorder). One insertion pass in list order: label b
climbs past a only if `zbar_b - zbar_a > LEAD_EEG_Z * sqrt(1/k_a + 1/k_b)` (k = cited EEG turns). 1.645 = one-sided 5%
test of "no EEG difference", chosen a priori (it was never fitted on the gate personas or on Track 2). Under null EEG
the swap rate is < 8% per pair (unit test, 2000 sims); near-ties never flip on noise alone; labels with no EEG on
their turns never move and are never passed. Without EEG, lead-eeg == lead.

## Track 2, logged Phase B EEG (24 matched sessions, score.py, network 0)
| tagger | top-1 | top-3 |
|---|---|---|
| llm-extract + keyphrase-idf, lead (default) | 9/24 | 14/24 |
| llm-extract + keyphrase-idf, lead-eeg (z 1.645) | 11/24 | 14/24 |

By condition, top-1 lead -> lead-eeg: bh_eeg_d1 1->1 (n=3), bh_eeg_d2 3->4 (n=8), bh_typing 0->0 (n=4),
bh_yoked_d2 (sham EEG) 5->6 (n=9). Changed sessions: p03_priya eeg_d2 s11 (-> correct), p03_priya yoked s22
(-> correct), p01_dana yoked s11 (reordered, still correct), p06_tomas yoked s22 (reordered, still wrong).
**The sham arm gained as much as the real-EEG arm, so this +2 is not evidence of an EEG effect.** Full table:
`phaseC_tagger_track2_stoplist_leadeeg.md`.

## Track 2, synthetic EEG (Researcher's setup, consumer d=1.25, 50 reps) vs the prototype
`phaseC_lead_eeg_synth.txt` (`tools/phaseC-tagger-eval/lead_eeg_synth.py`):

| ranker | eeg | yoked | shuffle | noise | eeg - yoked |
|---|---|---|---|---|---|
| typing (lead) | 0.375 | | | | |
| HE lead-eeg (pure, z 1.645) | 0.383 | 0.338 | 0.353 | 0.357 | +0.044 |
| prototype blend w=0.25 (margin 0) | 0.275 | 0.138 | | | +0.137 |

The prototype gains more over sham but is far below typing (it lets confidence-0.6 labels jump on EEG); HE's rule is
near typing (+0.008) and moves #1 in only ~6% of reps (7% under pure noise). The Researcher's own port preview
(z 1.645, d 1.25): typing .375, eeg .383, yoked .350 - consistent.

## rankLeadEeg wrapper (PREREG §9) and the design-fit note
`rankLeadEeg(labels, eeg, {w, tie_break, margin})`, exported from packages/core (dist/final-guesses.js):
- `w` 0/undefined: exactly `eegReorder` on ln(EI); `margin` = its z (default 1.645); `tie_break: "eeg"` also moves a
  label sitting exactly at the threshold (measure-zero with real data). eegReorder's default is unchanged.
- `w` > 0: exactly the prototype `rank_proto` (score = confidence + w*zbar, population SD, zbar 0 if no cited EEG;
  ties by list order or by zbar; `margin` in **score units**, default 0, #1 kept unless beaten by more than margin).
- Parity: 0 / 338,400 rankings differ (Track 2 answers at turns 6 and 12 x all 9,600 synth_cache rows; blend vs
  `rank_proto` over the §6 grid, pure vs the Researcher's port): `phaseC_lead_eeg_parity.txt`.

Fit issue: the prereg's primary (w=0.25 blend, margin in score units) is a different ranker from what
`rank: "lead-eeg"` ships (pure reorder, margin = z). "margin maps to z" is true only in pure mode, so the units of
`margin` depend on `w`. The session option still runs the pure rule; a blend config confirmed on the gate would need
a (small) session option to ship. Not added, so as not to pre-empt the tuned_config.

## Port review (phaseC/leadeeg/preview_he_wip_port.{md,py})
Logic matches eegReorder (sample SD, min 4 turns, 1e-6 floor, deduped cites, t in [1, len]). Two deltas vs the
live session:
1. The session uses only the first `maxLabels` = 4 extractor labels, merges labels by slug containment (unioning their
   cites), and reorders those; the port and the wrapper reorder all labels (up to 5) as given.
2. Live, a turn with EEG quality 0 has no eegLn (excluded, index alignment kept); the port assumes every turn has EEG.
   The wrapper takes null/NaN for such turns.

## Held-out exposure (disclosure)
The 50-rep synth run above (and a 2-rep preview) was launched with the gate's 8 sessions included, reproducing
rerank_eeg_proto.py, before PREREG §8's "previews on Track 2 only" was applied here. So HE's pure rule at z 1.645,
d 1.25 has been scored once on the gate in synthetic EEG. Those rows are withheld from this repo and the script now
loads Track 2 only. The Researcher should record this as prior exposure (the tuned (tie_break, margin) config and
every other d remain blind). `gate_unique_check.py` reads the gate but compares label strings only, never scoring.
