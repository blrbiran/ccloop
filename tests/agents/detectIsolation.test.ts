import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgents } from "../../src/agents/detect.js";
import { probeVersion } from "../../src/agents/materialize.js";

// Orca paid claude round (2026-09-27), human ruling on its findings ("B1–B3 按你推荐"): the claude installation that
// `agents detect` drafts isolates the call from the person's Claude Code setup, as the paid round's table did. The fake
// claude never checks its arguments, so this criterion reads the argv the phase runner actually hands the binary that
// detect found, and that the drift probe still reads a version through the same command.
const ISOLATION = [
  "--permission-mode", "acceptEdits",
  "--no-session-persistence",
  "--setting-sources", "project,local",
  "--strict-mcp-config",
  "--disable-slash-commands",
  // Rewritten for the human ruling of 2026-09-27 on B4 and the budget cap ("同意改判据"): auto memory off (no
  // ~/.claude/projects/<cwd>/memory/), and claude's own cap of 100 USD for each call.
  "--settings", '{"autoMemoryEnabled":false}',
  "--max-budget-usd", "100",
];
const runner = fileURLToPath(new URL("../../scripts/claude-phase-runner.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A `claude` on PATH that answers --version, and otherwise records its argv and answers a plan envelope. */
async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-detect-isolation-")));
  dirs.push(root);
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const seen = join(root, "argv.json");
  const claude = join(bin, "claude");
  await writeFile(claude, [
    `#!${process.execPath}`,
    'const { writeFileSync } = require("node:fs");',
    "const args = process.argv.slice(2);",
    'if (args.includes("--version")) { process.stdout.write("2.1.283 (Claude Code)\\n"); process.exit(0); }',
    `writeFileSync(${JSON.stringify(seen)}, JSON.stringify(args));`,
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { summary: "s", primaryTargetPaths: ["a.txt"] }, usage: { input_tokens: 1, output_tokens: 1 } }));',
  ].join("\n"), { mode: 0o700 });
  await chmod(claude, 0o700);
  return { root, bin, seen, claude };
}

function runPlan(cwd: string, command: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify(command), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
    const child = spawn(process.execPath, [runner], { cwd, env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Run the plan phase for task t.", attempt: 1, runDir: cwd, worktreePath: cwd, partialOutcomeRecoveryWindowMs: 100 }));
  });
}

describe("the claude installation agents detect drafts (Orca paid claude round)", { timeout: 30_000 }, () => {
  it("hands the detected claude the isolation arguments ahead of -p, and still reads its version through them", async () => {
    const w = await world();
    const result = await detectAgents({ home: join(w.root, "home"), path: w.bin, platform: "linux" });
    const drafted = result.table.installations.claude!;
    expect(drafted.command).toEqual([w.claude, ...ISOLATION]);
    expect(drafted.version).toBe("2.1.283");
    expect(await probeVersion(drafted.command)).toBe("2.1.283");

    const run = await runPlan(w.root, drafted.command);
    expect(run.code, run.stderr).toBe(0);
    const argv = JSON.parse(await readFile(w.seen, "utf8")) as string[];
    expect(argv.slice(0, ISOLATION.length + 1)).toEqual([...ISOLATION, "-p"]);
  });

  it("drafts no extra arguments for codex", async () => {
    const w = await world();
    const codex = join(w.bin, "codex");
    await writeFile(codex, "#!/bin/sh\necho \"codex-cli 0.155.1\"\n", { mode: 0o700 });
    await chmod(codex, 0o700);
    const result = await detectAgents({ home: join(w.root, "home"), path: w.bin, platform: "linux" });
    expect(result.table.installations.codex!.command).toEqual([codex]);
  });
});
