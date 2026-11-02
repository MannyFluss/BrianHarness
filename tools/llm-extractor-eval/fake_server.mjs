// Fake Ollama /api/chat for the dry run: answers with the user's most repeated longer word as an
// "interest" (a plumbing test, not a model). node fake_server.mjs [port] [--no-auth]
// --no-auth mimics the local Ollama app: it REJECTS any request carrying an Authorization header (400) and
// logs one line per request: {n, model, auth} so a test can check what was sent.
import http from "node:http";
const port = Number(process.argv[2] ?? 8765);
let n = 0;
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    n++;
    const noAuth = process.argv.includes("--no-auth");
    const auth = req.headers.authorization;
    const ok = req.method === "POST" && req.url === "/api/chat" && (noAuth ? auth === undefined : auth === undefined || /^Bearer .+/.test(auth));
    let j = {};
    try { j = JSON.parse(b); } catch {}
    console.log(JSON.stringify({ n, model: j.model, auth: auth === undefined ? null : "present" }));
    if (!ok || j.stream !== false) { res.writeHead(400); res.end(JSON.stringify({ error: "bad request (need POST /api/chat, stream:false, no Authorization in --no-auth mode, else none or Bearer)" })); return; }
    const words = (j.messages?.at(-1)?.content ?? "").toLowerCase().replace(/\[turn \d+\]/g, " ").match(/[a-z]{7,}/g) ?? [];
    const cnt = {}; for (const w of words) cnt[w] = (cnt[w] ?? 0) + 1;
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => w);
    const content = JSON.stringify({ interests: top.map((w, i) => ({ label: w, confidence: 0.8 - i * 0.2, turns: [11, 12] })) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: j.model, created_at: new Date().toISOString(), message: { role: "assistant", content }, done: true, num_predict: j.options?.num_predict }));
  });
}).listen(port, "127.0.0.1", () => console.log(`fake ollama on http://127.0.0.1:${port}`));
