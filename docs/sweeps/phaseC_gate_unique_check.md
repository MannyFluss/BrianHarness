# uniqueLabels on the 8 gate sessions (typing-only, no scoring)

OLD = 9ba666a, NEW = 1474a83 (b54e193 + rankLeadEeg); `python3 tools/phaseC-tagger-eval/gate_unique_check.py /tmp/he_old /tmp/he_new`

| session | OLD == NEW | NEW == live final_top3 | dup keys in OLD | NEW calls (network/cached) |
|---|---|---|---|---|
| c02_dev__bh_typing__s11 | True | True | 0 | 0/2 |
| c01_rosa__bh_typing__s11 | True | True | 0 | 0/2 |
| c03_june__bh_typing__s11 | True | True | 0 | 0/2 |
| c04_harold__bh_typing__s11 | True | True | 0 | 0/2 |
| c05_zane__bh_typing__s11 | True | True | 0 | 0/2 |
| c06_mei__bh_typing__s11 | True | True | 0 | 0/2 |
| c07_ines__bh_typing__s11 | True | True | 0 | 0/2 |
| c08_bev__bh_typing__s11 | True | True | 0 | 0/2 |

OLD == NEW finals: 8/8; NEW == live recorded: 8/8; network calls: 0
