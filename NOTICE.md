# Third-party notices

## Bundled in app builds (packages/core -> apps/desktop)

- **Word-frequency table** `packages/core/src/wordfreq/cv-en.ts` (keyphrase-idf IDF prior): derived from the
  [Mozilla Common Voice](https://github.com/common-voice/common-voice) English sentence corpus
  (`server/data/en`), **CC0 1.0 Universal** (public domain dedication). Thanks to Mozilla and the Common
  Voice contributors. Details and the primary-source citations: `packages/core/src/wordfreq/FREQ_LICENSE.md`.

## Dev/research only (NOT bundled, not imported by any package)

- `research/wordfreq/wordfreq_small_en_zipf10.txt`: derived from [wordfreq](https://github.com/rspeer/wordfreq)
  3.1.1 `small_en` (Robyn Speer et al.), **CC BY-SA 4.0**. Loaded only from a file path for sims/sidecar
  runs (`freqFile` / `BH_IDF_FREQ_FILE`). See `research/wordfreq/LICENSE.md`.
