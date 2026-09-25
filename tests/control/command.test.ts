import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentsTableV1 } from "../../src/agents/types.js";
import { runControlCommand } from "../../src/control/command.js";
import {
  atomicReplacePrivateFile,
  ensurePrivateDirectory,
  readPrivateFile,
} from "../../src/control/paths.js";
import { FAKE_CLAUDE_CLI, FAKE_CODEX, claudeInstallation, codexInstallation, writeAgentsTable } from "./agentsFixture.js";

const cliPath = resolve("src/cli.ts");
const tsxPath = resolve("node_modules/.bin/tsx");

async function runCli(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(tsxPath, [cliPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { code, stdout, stderr };
}

// Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): the criteria of the
// boundary describe below run `control <method> --agents <table>` against a two-installation table (fake claude CLI,
// fake codex) instead of `--adapter codex --adapter-config <file>` (spec §4.5).
async function tableFixture(): Promise<{ root: string; path: string; table: AgentsTableV1 }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-command-")));
  const script = join(root, "script.json");
  await writeFile(script, "{}\n", { mode: 0o600 });
  const { path, table } = await writeAgentsTable({
    claude: await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", join(root, "claude-marker"), script]),
    codex: await codexInstallation({
      command: [process.execPath, FAKE_CODEX, "integration", join(root, "codex-marker")],
      sandbox: "workspace-write",
      budgetMode: "soft",
      timeoutMs: 1_000,
      killGraceMs: 100,
    }),
  }, root);
  return { root, path, table };
}

describe("control command boundary", () => {
  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): a relative agents table is
  // refused before dispatch as a named rejection (exit 2, D-W3-2) whose stderr starts with the table's own code, with
  // nothing on stdout.
  it("rejects a relative agents table before dispatch", async () => {
    const result = await runControlCommand(["capabilities", "--agents", "relative.json"], JSON.stringify({ agent: null }));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^agents-table-invalid(: .*)?\n$/);
  });

  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): the retired protocol-1
  // envelope is a named protocol rejection (exit 2) with nothing on stdout.
  it("maps named protocol rejections to exit 2 without contaminating stdout", async () => {
    const { path } = await tableFixture();
    const result = await runControlCommand(["accept", "--agents", path], JSON.stringify({ protocol: 1 }));
    expect(result).toEqual({ code: 2, stdout: "", stderr: "control-protocol-unsupported\n" });
  });

  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): malformed JSON and a
  // handler failure that is no named rejection both exit 1 with nothing on stdout, under the --agents form.
  it("maps malformed JSON and non-protocol failures to exit 1", async () => {
    const { path } = await tableFixture();
    const malformed = await runControlCommand(["capabilities", "--agents", path], "{");
    expect(malformed.code).toBe(1);
    expect(malformed.stdout).toBe("");

    const failed = await runControlCommand(
      ["capabilities", "--agents", path],
      JSON.stringify({ agent: null }),
      { handle: async () => Promise.reject(new Error("boom")) },
    );
    expect(failed).toEqual({ code: 1, stdout: "", stderr: "boom\n" });
  });

  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): nothing is printed unless
  // the handler's answer passes the protocol-3 capabilities schema; the retired v2 eight-field answer is refused as
  // well as an arbitrary one.
  it("does not print until a handler result passes the response schema", async () => {
    const { path } = await tableFixture();
    for (const answer of [
      { protocol: 1, durableAccept: "yes" },
      {
        protocol: 2,
        usageObservation: "phase-end",
        budgetEnforcement: "soft",
        contextObservation: "unavailable",
        handoffControl: "durable",
        handoffExecution: "mechanical-in-run-v1",
        contextWindowTokens: null,
        requestBoundProof: null,
      },
    ]) {
      const result = await runControlCommand(
        ["capabilities", "--agents", path],
        JSON.stringify({ agent: null }),
        { handle: async () => answer },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("control-response-invalid");
    }
  });

  // This criterion was rewritten in place under human authorization (2026-09-24,
  // "task 1 3 5 6 都同意授权") to assert the v2 eight-field capability vocabulary
  // instead of the v1 seven-field one. See ccloop/CLAUDE.md Rule 15 and
  // docs/superpowers/specs/2026-09-24-g1-control-wire-contract-design.md §5.1.
  // Rewritten for agent selection (2026-09-26, human ruling: "同意修改几个仓库的现有test"): the real CLI routes
  // `control capabilities --agents <table>` with `{agent:null}` before legacy parsing and prints exactly one JSON
  // value, the protocol-3 table view: one row per installation, sorted by id, with its kind's descriptor defaults,
  // expressible context windows, and the table's recorded version.
  it("routes the real CLI through control before legacy parsing and emits one JSON value", async () => {
    const { path, table } = await tableFixture();
    const result = await runCli(["control", "capabilities", "--agents", path], `${JSON.stringify({ agent: null })}\n`);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      protocol: 3,
      installations: [
        {
          id: "claude",
          kind: "claude",
          defaults: { model: "claude-opus-5-5", contextWindow: "agent-default" },
          contextOptions: ["agent-default", 1_000_000],
          version: table.installations.claude!.version,
        },
        {
          id: "codex",
          kind: "codex",
          defaults: { model: "gpt-6-sol", contextWindow: "agent-default" },
          contextOptions: ["agent-default"],
          version: table.installations.codex!.version,
        },
      ],
    });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("private control paths", () => {
  it("creates new private directories and atomically replaces private files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-paths-")));
    const nested = join(root, "control", "events");
    const file = join(nested, "event.json");
    await ensurePrivateDirectory(root, nested);
    await atomicReplacePrivateFile(root, file, Buffer.from("first"));
    await atomicReplacePrivateFile(root, file, Buffer.from("second"));
    expect((await lstat(nested)).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await readPrivateFile(root, file)).toString()).toBe("second");
  });

  it("rejects symlink ancestors and leaf symlinks without chmodding existing user paths", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-paths-")));
    await mkdir(join(root, "existing"), { mode: 0o755 });
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-target-")));
    await symlink(outside, join(root, "linked"));
    await expect(ensurePrivateDirectory(root, join(root, "linked", "child"))).rejects.toThrow(
      "control-path-invalid",
    );
    expect((await lstat(join(root, "existing"))).mode & 0o777).toBe(0o755);

    const target = join(root, "target");
    const leaf = join(root, "leaf");
    await writeFile(target, "secret", { mode: 0o600 });
    await symlink(target, leaf);
    await expect(readPrivateFile(root, leaf)).rejects.toThrow("control-path-invalid");

    const descriptor = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    await descriptor.close();
    expect(dirname(target)).toBe(root);
    expect(await readFile(target, "utf8")).toBe("secret");
  });
});
