import { test } from "node:test";
import assert from "node:assert/strict";
import { eegQuality, estimateEngagement } from "../src/index.js";

const base = { "typing.latencyMs": 2000, "text.words": 12 };

test("EEG weight is configurable per call/session", () => {
  const f = { ...base, "eeg.engagementIndex": 1.2 };
  const off = estimateEngagement(f, { options: { weight: 0 } });
  const hi = estimateEngagement(f, { options: { weight: 0.5, qualityWeighting: false } });
  assert.equal(off.score, off.parts.typingScore);
  assert.ok(hi.score > off.score);
  assert.equal(hi.parts.eegWeight, 0.5);
});

test("EEG is z-scored against the user's own history once there are 3 windows", () => {
  const hist = [Math.log(3), Math.log(3.2), Math.log(2.8)]; // this user's EI runs high
  const f = { ...base, "eeg.engagementIndex": 3.0 }; // ordinary for them
  const z = estimateEngagement(f, { eegLnHistory: hist });
  const abs = estimateEngagement(f, { eegLnHistory: hist, options: { zScore: false } });
  assert.ok(Math.abs(z.parts.eeg! - 0.5) < 0.1, `z part ${z.parts.eeg}`);
  assert.equal(abs.parts.eeg, 1); // absolute mapping saturates
});

test("bad-contact windows get zero EEG weight; EMG / short windows are down-weighted", () => {
  assert.equal(eegQuality({ "eeg.quality": 0 }).quality, 0);
  const r = estimateEngagement({ ...base, "eeg.engagementIndex": 5, "eeg.quality": 0 });
  assert.equal(r.parts.eegWeight, 0);
  assert.equal(r.score, r.parts.typingScore);
  const clean = eegQuality({ "eeg.quality": 1, "eeg.windowSec": 30, "eeg.beta": 1, "eeg.emg": 0 }).quality;
  const emg = eegQuality({ "eeg.quality": 1, "eeg.windowSec": 30, "eeg.beta": 1, "eeg.emg": 0.4 }).quality;
  const short = eegQuality({ "eeg.quality": 1, "eeg.windowSec": 5 }).quality;
  assert.equal(clean, 1);
  assert.ok(emg < 0.5 && short < 0.6);
});

test("readable typers: EEG that disagrees with typing loses weight; flat typers get a boost", () => {
  const typing = [0.2, 0.8, 0.3, 0.9, 0.25, 0.85]; // clearly readable
  const eegDisagree = [0.8, 0.2, 0.7, 0.1, 0.75, 0.2];
  const f = { ...base, "eeg.engagementIndex": 1 };
  const r = estimateEngagement(f, { typingHistory: typing, typingAtEeg: typing, eegPartHistory: eegDisagree, options: { qualityWeighting: false } });
  assert.ok(r.parts.eegWeight! < 0.1, `weight ${r.parts.eegWeight}`);
  const flat = [0.5, 0.52, 0.49, 0.51, 0.5, 0.5];
  const r2 = estimateEngagement(f, { typingHistory: flat, typingAtEeg: flat, eegPartHistory: eegDisagree, options: { qualityWeighting: false } });
  assert.ok(r2.parts.eegWeight! > 0.25, `weight ${r2.parts.eegWeight}`);
});
