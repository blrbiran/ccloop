import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runControlCommand } from "../../src/control/command.js";
import {
  atomicReplacePrivateFile,
  ensurePrivateDirectory,
  readPrivateFile,
} from "../../src/control/paths.js";

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

async function configFixture(): Promise<{ root: string; config: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-control-command-")));
  const config = join(root, "codex.json");
  await writeFile(
    config,
    `${JSON.stringify({
      executable: "/usr/bin/false",
      model: "fixture",
      budgetMode: "soft",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    })}\n`,
    { mode: 0o600 },
  );
  return { root, config };
}

describe("control command boundary", () => {
  it("rejects a relative adapter config before dispatch", async () => {
    const result = await runControlCommand(
      ["capabilities", "--adapter", "codex", "--adapter-config", "relative.json"],
      "{}",
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("control-adapter-config-invalid");
  });

  it("maps named protocol rejections to exit 2 without contaminating stdout", async () => {
    const { config } = await configFixture();
    const result = await runControlCommand(
      ["accept", "--adapter", "codex", "--adapter-config", config],
      JSON.stringify({ protocol: 2 }),
    );
    expect(result).toEqual({ code: 2, stdout: "", stderr: "control-protocol-unsupported\n" });
  });

  it("maps malformed JSON and non-protocol failures to exit 1", async () => {
    const { config } = await configFixture();
    const malformed = await runControlCommand(
      ["capabilities", "--adapter", "codex", "--adapter-config", config],
      "{",
    );
    expect(malformed.code).toBe(1);
    expect(malformed.stdout).toBe("");

    const failed = await runControlCommand(
      ["capabilities", "--adapter", "codex", "--adapter-config", config],
      "{}",
      { handle: async () => Promise.reject(new Error("boom")) },
    );
    expect(failed).toEqual({ code: 1, stdout: "", stderr: "boom\n" });
  });

  it("does not print until a handler result passes the response schema", async () => {
    const { config } = await configFixture();
    const result = await runControlCommand(
      ["capabilities", "--adapter", "codex", "--adapter-config", config],
      "{}",
      { handle: async () => ({ protocol: 1, durableAccept: "yes" }) },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("control-response-invalid");
  });

  // This criterion was rewritten in place under human authorization (2026-09-24,
  // "task 1 3 5 6 都同意授权") to assert the v2 eight-field capability vocabulary
  // instead of the v1 seven-field one. See ccloop/CLAUDE.md Rule 15 and
  // docs/superpowers/specs/2026-09-24-g1-control-wire-contract-design.md §5.1.
  it("routes the real CLI through control before legacy parsing and emits one JSON value", async () => {
    const { config } = await configFixture();
    const result = await runCli(
      ["control", "capabilities", "--adapter", "codex", "--adapter-config", config],
      "{}\n",
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      protocol: 2,
      usageObservation: "phase-end",
      budgetEnforcement: "soft",
      contextObservation: "unavailable",
      handoffControl: "durable",
      handoffExecution: "mechanical-in-run-v1",
      contextWindowTokens: null,
      requestBoundProof: null,
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
