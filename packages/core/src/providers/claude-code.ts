/**
 * Claude via the user's own Claude Code CLI login (Claude Pro/Max subscription). We spawn
 * `claude -p` with no tools / MCP / hooks / session persistence in an empty temp dir, prompt on
 * stdin, and strip ANTHROPIC_API_KEY from the child env so the subscription login is used.
 * (Flag set chosen independently from the CLI's documented options.)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, GenerateResult, ModelBackend } from "../backends.js";
import { collapseTranscript } from "./transcript.js";

export const CLAUDE_CODE_MODELS = ["sonnet", "opus", "haiku"] as const;

export interface ClaudeCodeStatus {
  installed: boolean;
  version?: string;
  bin: string;
  error?: string;
}

function run(bin: string, args: string[], opts: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], shell: false, signal: opts.signal });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });
}

export async function detectClaudeCode(bin = process.env.CLAUDE_BIN ?? "claude"): Promise<ClaudeCodeStatus> {
  try {
    const r = await run(bin, ["--version"], { timeoutMs: 5000 });
    if (r.code !== 0) return { installed: false, bin, error: r.stderr.trim().slice(0, 200) || `exit ${r.code}` };
    return { installed: true, bin, version: r.stdout.trim().split(/\s+/)[0] };
  } catch (e) {
    return { installed: false, bin, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? "not installed" : (e as Error).message };
  }
}

export class ClaudeCodeBackend implements ModelBackend {
  readonly id: string;
  /** uses the subscription, but it is still the user's quota: treat as paid for sims */
  readonly paid = true;
  constructor(private cfg: { model?: string; bin?: string; timeoutMs?: number } = {}) {
    this.id = `claude-code:${cfg.model ?? "sonnet"}`;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const { system, prompt } = collapseTranscript(req.messages);
    const dir = mkdtempSync(join(tmpdir(), "bh-claude-"));
    try {
      const sysFile = join(dir, "system.txt");
      writeFileSync(sysFile, system, { mode: 0o600 });
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY; // force the subscription login, never an env API key
      const args = [
        "-p", "--output-format", "json", "--model", this.cfg.model ?? "sonnet",
        "--system-prompt-file", sysFile, "--tools", "", "--strict-mcp-config",
        "--setting-sources", "user", "--settings", JSON.stringify({ disableAllHooks: true }),
        "--disable-slash-commands", "--no-session-persistence",
      ];
      const r = await run(this.cfg.bin ?? process.env.CLAUDE_BIN ?? "claude", args, { input: prompt, cwd: dir, env, timeoutMs: this.cfg.timeoutMs, signal: req.signal });
      let body: { result?: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number } } = {};
      try {
        body = JSON.parse(r.stdout);
      } catch {
        throw new Error(`claude exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      }
      if (r.code !== 0 || body.is_error) throw new Error(`claude: ${(body.result ?? r.stderr).slice(0, 300)}`);
      return { text: (body.result ?? "").trim(), usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
