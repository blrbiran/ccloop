import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SubprocessClaudeAdapter } from "../../../src/runtime/claude/subprocessClaudeAdapter.js";
import { codexFixture } from "../codex/fixture.js";

// Orca backlog #12(a) (2026-09-29; Orca handoff §4.0 and ccloop handoff "挂着的": the runner's stderr was decoded chunk
// by chunk with toString, the same fault ruling 26 closed on stdin). A failure message is what a person reads to learn
// why a phase died, so a non-ASCII line on claude's stderr must reach it whole even when the pipe delivers it in two
// pieces. The stand-in cuts the line inside its first character and writes the halves 200 ms apart, so the reader
// is handed two chunks.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const MESSAGE = "認証に失敗しました";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function splitStderrStandIn(): Promise<{ dir: string; script: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-stderr-"))); dirs.push(dir);
  const bytes = Buffer.from(`${MESSAGE}\n`, "utf8");
  // One byte into a three-byte character: neither half decodes on its own.
  const pieces = [bytes.subarray(0, 1), bytes.subarray(1)].map((piece) => piece.toString("base64"));
  const script = join(dir, "stand-in-claude.mjs");
  await writeFile(script, [
    `const pieces = ${JSON.stringify(pieces)};`,
    "for (const piece of pieces) {",
    "  await new Promise((resolve) => process.stderr.write(Buffer.from(piece, 'base64'), resolve));",
    "  await new Promise((resolve) => setTimeout(resolve, 200));",
    "}",
    "process.exitCode = 3;",
  ].join("\n"));
  return { dir, script };
}

describe("stderr decoding across chunks (Orca backlog #12(a))", () => {
  it("the claude phase runner's failure message carries a character claude's stderr split across two chunks", async () => {
    const { dir, script } = await splitStderrStandIn();
    const worktree = join(dir, "worktree");
    await mkdir(worktree);
    const env: NodeJS.ProcessEnv = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, script]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
    delete env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH;
    const child = spawn(process.execPath, [runner], { cwd: worktree, env, stdio: ["pipe", "pipe", "pipe"] });
    const err: Buffer[] = [];
    child.stderr.on("data", (bytes: Buffer) => err.push(bytes));
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: dir, worktreePath: worktree }));
    });
    // Decoded here from the whole byte sequence, so this criterion cannot introduce the fault it measures.
    const stderr = Buffer.concat(err).toString("utf8");
    expect(code).toBe(1);
    expect(stderr).toContain(`stderr: ${MESSAGE}`);
    expect(stderr).not.toContain("�");
  }, 20_000);

  it("SubprocessClaudeAdapter's error carries a character its command's stderr split across two chunks", async () => {
    const { script } = await splitStderrStandIn();
    const f = await codexFixture("unused");
    dirs.push(f.dir);
    const error = await new SubprocessClaudeAdapter({ command: [process.execPath, script] }).plan(f.context).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(MESSAGE);
    expect((error as Error).message).not.toContain("�");
  }, 20_000);
});
