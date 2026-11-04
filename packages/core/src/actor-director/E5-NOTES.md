# E5: gaze compression L0-L4 (notes)

- `gaze-ref.ts`: a line-for-line TS port of R1 `reference.py` (sha256 6709334184…3fa0). It reproduces all 56 R1
  cases (tolerance 1e-6, plus each case's hand-derived checks). It keeps Python semantics: round-half-even on the
  exact binary value, and float floor division.
- `gaze-stream.ts`: `GazeStream` carries the L0/L1 state across ~100 ms batches. That state is: L0 lookahead and
  gap filling, the drift anchor hold, the median-3 run, the I-DT buffer, the tentative merge, and the 5 s gaze_l1
  windows. `snapshot()` returns a flushed clone, so the live state is never disturbed. `GazeSource` adds
  closeTurn() (L2-L4 = `turnFromL1`) and summarize(). Streamed output equals batch output for any batch size, as
  long as anchors arrive within `anchor_hold_ms` (300) of the tap. Later anchors still apply going forward and are
  counted in `stats.late_anchors`.
- Features are computed on unmerged fixations. The cap of 20 fixations per 5 s is applied only to the gaze_l1 log
  lines.
- Drift caps are PROVISIONAL config, not constants: `drift_reject_deg` 4 and `drift_max_deg` 3.
  `drift_correction:false` turns correction off.
- px/deg is fixed per stream. The app passes its calibration distance. The R2 replay uses the median head.distCm
  from before open_t (causal), falling back to the layout default.
- `visibility.ts`: per-paragraph visible intervals and complete_t. A paragraph counts as visible when at least 50%
  of its box is on screen, or when it covers at least 50% of the viewport (both configurable). Also has the DOM
  helper for Message.tsx `[data-msg][data-p]` (opt-in `aoi` prop; without it the protocol-4 DOM is unchanged).
- R2 (`scripts/ad-r2-replay.ts`, local only): the stream matches the Python VALIDATION.json result exactly.
  Correction on: 11/18. Correction off: 4/18.

## contract-v2 needs from E5 (not implemented; contract-v1 unchanged)
1. A `drift_anchor` event (composer tap t/x/y plus kind, and whether it was used or rejected, with the bias). Today
   anchors exist only in memory and in the replay sidecar.
2. Keystroke times, or at least the first keystroke t, on the gaze clock. The reading window needs them.
3. `aoi_layout` boxes need `complete_t`, `line_h` and visible intervals. Boxes should be re-logged on scroll, or
   the log should state that they are document coordinates.
4. The paragraph split rule should be written into the contract: `text.split(/\n\s*\n/)`, then trim, dropping
   empty chunks.
5. `signals.ts` SignalSource `kind` union needs `"gaze"`. That union is in a protocol-4 file, which was left
   untouched, so GazeSource matches the shape but does not formally implement the interface.
6. A gaze_quality field for late_samples and late_anchors.
