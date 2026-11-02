# cv-en.ts: data source and license (CC0 1.0)

`cv-en.ts` is the DEFAULT, bundled word-frequency table of the `keyphrase-idf` tagger. It was computed in this
repo by `scripts/gen-freq-cv.py` from the English sentence text of
[Mozilla Common Voice](https://github.com/common-voice/common-voice), files `server/data/en/*.txt` at commit
`b24381ce7136f2524a1128cb605b49111f79dbea` (1,586,676 sentences, 16,344,324 word tokens).

License of the source, verified from the primary source:
- `server/data/en/LICENSE` (https://github.com/common-voice/common-voice/blob/main/server/data/en/LICENSE) is the
  full text of **CC0 1.0 Universal**, beginning "CC0 1.0 Universal ... Statement of Purpose".
- The repository README (https://github.com/common-voice/common-voice#readme) states: "The majority of our
  sentence text in `/server/data` comes directly from user submissions in our Sentence Collector ... or they
  are scraped from Wikipedia using our extractor tool, and are released under a CC0 public domain Creative
  Commons license".
- (The Common Voice *code* is MPL-2.0; we use none of it, only the CC0 sentence data.)

What we derived: lowercase word counts -> Zipf = log10(count / total * 1e9), words with Zipf >= 3.0 (37,563),
rounded to 0.1. No sentences are redistributed. The derived table is likewise dedicated to the public domain
(CC0 1.0). Attribution is not legally required; we credit Mozilla Common Voice and its contributors anyway.
The generator asserts the downloaded LICENSE still starts with "CC0 1.0 Universal".

It is a general-English frequency prior, not a hobby list: the tagger uses it only to down-weight common words.
