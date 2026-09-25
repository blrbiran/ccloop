import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Orca agent selection (2026-09-26), spec §4.7 and §12 I14: the phase runner takes the claude command and
// extra arguments from CCLOOP_CLAUDE_COMMAND / CCLOOP_CLAUDE_EXTRA_ARGS as JSON arrays. Unset, it must run
// `claude` from PATH with exactly the arguments it always used — the older SubprocessClaudeAdapter still
// depends on that.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function world() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-runner-env-")));
  dirs.push(dir);
  const pathMarker = join(dir, "path-claude.json");
  // A `claude` on PATH that forwards to the CLI-layer fake, so its argv lands in <pathMarker>.argv.
  await writeFile(join(dir, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCli)} ok ${JSON.stringify(pathMarker)} "$@"\n`);
  await chmod(join(dir, "claude"), 0o755);
  return { dir, pathMarker };
}

function runRunner(cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: cwd, worktreePath: cwd }));
  });
}

const argvOf = async (marker: string) => (await readFile(`${marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);

describe("claude phase runner command and extra arguments (Orca agent selection)", () => {
  it("runs `claude` from PATH with its original arguments when neither variable is set", async () => {
    const w = await world();
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${w.dir}:${process.env.PATH ?? ""}` };
    delete env.CCLOOP_CLAUDE_COMMAND; delete env.CCLOOP_CLAUDE_EXTRA_ARGS;
    const result = await runRunner(w.dir, env);
    expect(result.code).toBe(0);
    const [argv] = await argvOf(w.pathMarker);
    expect(argv).toHaveLength(6);
    expect(argv!.slice(0, 4)).toEqual(["-p", "--output-format", "json", "--json-schema"]);
    expect(argv![5]).toBe("Plan one isolated L2 attempt for task t.");
    expect(JSON.parse(result.stdout)).toMatchObject({ summary: "fixture", tokenUsage: 15 });
  });

  it("runs the named argv tuple with the extra arguments before the prompt, never splitting on whitespace", async () => {
    const w = await world();
    const marker = join(w.dir, "named-claude.json");
    const result = await runRunner(w.dir, {
      ...process.env,
      PATH: `${w.dir}:${process.env.PATH ?? ""}`,
      CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, fakeCli, "ok", marker]),
      CCLOOP_CLAUDE_EXTRA_ARGS: JSON.stringify(["--model", "model with spaces[1m]"]),
    });
    expect(result.code).toBe(0);
    const [argv] = await argvOf(marker);
    expect(argv).toHaveLength(8);
    expect(argv!.slice(5)).toEqual(["--model", "model with spaces[1m]", "Plan one isolated L2 attempt for task t."]);
    expect(existsSync(`${w.pathMarker}.argv`)).toBe(false);
  });

  it.each([
    ["CCLOOP_CLAUDE_COMMAND", "claude --flag"],
    ["CCLOOP_CLAUDE_COMMAND", "[]"],
    ["CCLOOP_CLAUDE_COMMAND", "[\"\"]"],
    ["CCLOOP_CLAUDE_EXTRA_ARGS", "\"--model x\""],
    ["CCLOOP_CLAUDE_EXTRA_ARGS", "[\"--model\", 1]"],
  ])("refuses %s=%s by name and launches nothing", async (name, value) => {
    const w = await world();
    const result = await runRunner(w.dir, { ...process.env, PATH: `${w.dir}:${process.env.PATH ?? ""}`, [name]: value });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`claude-runner-env-invalid: ${name}`);
    expect(existsSync(`${w.pathMarker}.argv`)).toBe(false);
  });
});
