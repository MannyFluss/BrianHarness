# wordfreq-en.ts: data license

`wordfreq-en.ts` is derived from the `small_en` word list of
[wordfreq](https://github.com/rspeer/wordfreq) 3.1.1 by Robyn Speer and contributors.

- wordfreq's code is Apache-2.0; its **data** is licensed
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). wordfreq credits its sources (Wikipedia,
  SUBTLEX-US/UK, OpenSubtitles 2018, Google Books Ngrams, Reddit, Twitter, NewsCrawl, GlobalVoices, OSCAR web
  text, ...) in its README.
- Changes made here: kept lowercase alphabetic entries only (28,482 words with Zipf >= 3.0), rounded to
  0.1 Zipf, stored as one line per bucket. Regenerate with `scripts/gen-wordfreq.py`.
- This derived file is distributed under **CC BY-SA 4.0** (ShareAlike applies to the word list only, not
  to the rest of the repo, which merely reads it as data).

It is a general-English frequency prior. It is not a hobby list and contains no labels: the
`keyphrase-idf` tagger uses it only to down-weight common words.
