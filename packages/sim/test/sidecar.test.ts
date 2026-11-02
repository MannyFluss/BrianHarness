import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SIDECAR = fileURLToPath(new URL("../dist/sidecar.js", import.meta.url));

function open(args: string[] = []) {
  const p = spawn(process.execPath, [SIDECAR, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = createInterface({ input: p.stdout });
  const queue: Array<(v: any) => void> = [];
  rl.on("line", (l) => queue.shift()?.(JSON.parse(l)));
  const call = (m: unknown) => new Promise<any>((r) => { queue.push(r); p.stdin.write(JSON.stringify(m) + "\n"); });
  return { call, close: () => { p.stdin.end(); return new Promise((r) => p.on("close", r)); } };
}

test("sidecar: start / reply (synth typing + EEG features) / hud / final_guesses / end over JSON lines", async () => {
  const sc = open();
  const hello = await sc.call({ cmd: "hello" });
  assert.equal(hello.protocol, "brianharness-sidecar/1");
  const bad = await sc.call({ cmd: "reply", text: "x" });
  assert.equal(bad.ok, false);
  const s = await sc.call({ cmd: "start", id: 1, options: { provider: "mock", seed: 2, eegWeight: 0.4 } });
  assert.equal(s.ok, true);
  assert.equal(s.id, 1);
  assert.equal(s.backend, "mock");
  assert.ok(s.director.text.length > 0);
  let r: any;
  for (const t of ["I restore vintage wristwatches, servicing the movement and mainspring", "a 1960s watch movement with a broken balance wheel, so fun!", "ok"]) {
    r = await sc.call({ cmd: "reply", text: t, features: { "eeg.engagementIndex": 0.9, "eeg.quality": 1, "eeg.windowSec": 25 } });
    assert.equal(r.ok, true, r.error);
  }
  assert.equal(r.top3[0].topic, "x:watch-restoration");
  assert.ok(r.user.eeg["engagement.eegWeight"] > 0);
  const hud = await sc.call({ cmd: "hud" });
  assert.ok(hud.ledger["x:watch-restoration"].label.includes("watch"));
  const g = await sc.call({ cmd: "final_guesses", k: 2 });
  assert.equal(g.guesses.length, 2);
  const end = await sc.call({ cmd: "end" });
  assert.equal(end.ok, true);
  await sc.close();
});

test("sidecar refuses paid backends without --allow-paid", async () => {
  const sc = open();
  const r = await sc.call({ cmd: "start", options: { provider: "ollama", model: "gemma4:cloud", allowPaid: true, ollamaUrl: "http://127.0.0.1:9" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /paid/);
  await sc.close();
});
