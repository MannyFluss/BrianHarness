# research/wordfreq: DEV-ONLY research input (CC BY-SA 4.0), never bundled

`wordfreq_small_en_zipf10.txt` is derived from the `small_en` word list of
[wordfreq](https://github.com/rspeer/wordfreq) 3.1.1 by Robyn Speer and contributors.

- wordfreq's code is Apache-2.0; its **data** is licensed
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). wordfreq credits its sources (Wikipedia,
  SUBTLEX-US/UK, OpenSubtitles 2018, Google Books Ngrams, Reddit, Twitter, NewsCrawl, GlobalVoices, OSCAR web
  text, ...) in its README.
- Changes made here: kept lowercase alphabetic entries only (28,482 words with Zipf >= 3.0), rounded to
  0.1 Zipf, one line per bucket (`<zipf*10>:<words>`). Regenerate with `scripts/gen-wordfreq.py`.
- This derived file is distributed under **CC BY-SA 4.0** (ShareAlike applies to the word list only).

**Not part of any app build.** Nothing in `packages/` or `apps/` imports it; the shipped default is the CC0
Common Voice table (`packages/core/src/wordfreq/cv-en.ts`, see `NOTICE.md`). Select it only for sims/sidecar
research runs: tagger option `{"kind":"keyphrase-idf","freqFile":"research/wordfreq/wordfreq_small_en_zipf10.txt"}`
or env `BH_IDF_FREQ_FILE=<path>` (see docs/SIDECAR.md). In code: `parseZipf10(text)` -> `freqTable` option.
