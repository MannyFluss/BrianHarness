import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SIDECAR = fileURLToPath(new URL("../dist/sidecar.js", import.meta.url));

function open(args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const p = spawn(process.execPath, [SIDECAR, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
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

test("sidecar: ollama-cloud takes OLLAMA_API_KEY from env, is free for the paid gate (fake server)", async () => {
  const { createServer } = await import("node:http");
  const auths: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    auths.push(`${req.url} ${req.headers.authorization ?? ""}`);
    if (req.headers.authorization !== "Bearer fake-key") return res.writeHead(401).end("{}");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message: { content: "what do you like about that?" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const { OLLAMA_API_KEY: _drop, ...noKey } = process.env;
    const a = open([], noKey);
    const e = await a.call({ cmd: "start", options: { provider: "ollama-cloud:gemma4:cloud", baseUrl } });
    assert.equal(e.ok, false);
    assert.match(e.error, /OLLAMA_API_KEY/);
    await a.close();
    const b = open([], { ...noKey, OLLAMA_API_KEY: "fake-key" }); // no --allow-paid
    const s = await b.call({ cmd: "start", options: { provider: "ollama-cloud", model: "gemma4:cloud", baseUrl } });
    assert.equal(s.ok, true, s.error);
    assert.equal(s.backend, "ollama-cloud:gemma4:cloud");
    assert.equal(s.paid, false);
    const r = await b.call({ cmd: "reply", text: "I like ham radio" });
    assert.equal(r.ok, true, r.error);
    assert.ok(auths.some((x) => x === "/api/chat Bearer fake-key"), auths.join(","));
    await b.close();
  } finally {
    server.close();
  }
});
