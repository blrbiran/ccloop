import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertAgentsTablePath, parseAgentsTable, readAgentsTable } from "../../src/agents/table.js";

const claude = { kind: "claude", command: ["/usr/local/bin/claude"], version: "2.1.282", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000 };
const codex = { kind: "codex", command: ["/usr/local/bin/codex", "--flag"], version: "0.155.1", configDir: "/Users/me/.codex", timeoutMs: 1_800_000, killGraceMs: 5_000, sandbox: "workspace-write", budgetMode: "soft" };
const table = { schema: "ccloop-agents-table-v1", installations: { claude, codex } };
const invalid = expect.objectContaining({ code: "agents-table-invalid" });

async function privateDir(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "ccloop-agents-table-")));
}

async function writeTable(dir: string, value: unknown = table, mode = 0o600): Promise<string> {
  const path = join(dir, "agents.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode });
  await chmod(path, mode);
  return path;
}

describe("agents table schema", () => {
  it("accepts the spec §4.2 example with a kind-specific extra per codex record", () => {
    expect(parseAgentsTable(table)).toEqual(table);
  });

  it("accepts an empty table (detect found nothing)", () => {
    expect(parseAgentsTable({ schema: "ccloop-agents-table-v1", installations: {} }).installations).toEqual({});
  });

  // Spec §3: env/secretEnv are reserved for the provider slice and must be refused until then, not ignored.
  it.each([
    ["env on claude", { claude: { ...claude, env: { ANTHROPIC_BASE_URL: "http://x" } } }],
    ["secretEnv on codex", { codex: { ...codex, secretEnv: ["TOKEN"] } }],
    ["a codex extra on claude", { claude: { ...claude, sandbox: "workspace-write" } }],
    ["codex without sandbox", { codex: { ...codex, sandbox: undefined } }],
    ["codex with a strict budget", { codex: { ...codex, budgetMode: "strict" } }],
    ["an unknown kind", { other: { ...claude, kind: "opencode" } }],
    ["a record without kind", { claude: { ...claude, kind: undefined } }],
    ["a relative command", { claude: { ...claude, command: ["claude"] } }],
    ["an empty command", { claude: { ...claude, command: [] } }],
    ["a relative configDir", { claude: { ...claude, configDir: ".claude" } }],
    ["an empty version", { claude: { ...claude, version: "" } }],
    ["timeoutMs above the timer ceiling", { claude: { ...claude, timeoutMs: 2_147_483_648 } }],
    ["killGraceMs above 60s", { claude: { ...claude, killGraceMs: 60_001 } }],
    ["an id that is not an idSchema id", { "-claude": claude }],
  ])("refuses %s", (_name, installations) => {
    expect(() => parseAgentsTable({ schema: "ccloop-agents-table-v1", installations })).toThrow(invalid);
  });

  it("refuses another schema name and extra top-level keys", () => {
    expect(() => parseAgentsTable({ ...table, schema: "ccloop-agents-table-v2" })).toThrow(invalid);
    expect(() => parseAgentsTable({ ...table, defaults: {} })).toThrow(invalid);
  });
});

describe("reading the agents table", () => {
  it("reads a private regular file in a private directory", async () => {
    const path = await writeTable(await privateDir());
    expect(await readAgentsTable(path)).toEqual(table);
  });

  it("refuses a symlink even when it points at a valid table", async () => {
    const dir = await privateDir();
    const target = await writeTable(dir);
    const link = join(dir, "link.json");
    await symlink(target, link);
    // ELOOP comes from the no-follow open itself, before any later check could run.
    await expect(readAgentsTable(link)).rejects.toMatchObject({ code: "agents-table-invalid", detail: expect.stringContaining("ELOOP") });
  });

  it("refuses a directory, a relative path and a missing file", async () => {
    const dir = await privateDir();
    await mkdir(join(dir, "agents.json"), { mode: 0o700 });
    await expect(readAgentsTable(join(dir, "agents.json"))).rejects.toMatchObject({ code: "agents-table-invalid", detail: "table is not a regular file" });
    await expect(readAgentsTable("agents.json")).rejects.toThrow(invalid);
    await expect(readAgentsTable(join(dir, "missing.json"))).rejects.toThrow(invalid);
  });

  // O_NOFOLLOW guards only the last component; a symlinked directory on the way is caught by the realpath check.
  it("refuses a path that reaches the table through a symlinked directory", async () => {
    const dir = await privateDir();
    await mkdir(join(dir, "real"), { mode: 0o700 });
    const path = await writeTable(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "alias"));
    await expect(readAgentsTable(join(dir, "alias", "agents.json"))).rejects.toMatchObject({ code: "agents-table-invalid", detail: "table path is not its own realpath" });
    expect(await readAgentsTable(path)).toEqual(table);
  });

  // Spec §12 I14: whoever can write the table chooses the binary every run executes.
  it("refuses a group- or world-writable table", async () => {
    for (const mode of [0o620, 0o602]) {
      const path = await writeTable(await privateDir(), table, mode);
      await expect(readAgentsTable(path)).rejects.toThrow(invalid);
    }
  });

  it("refuses a table whose directory is group- or world-writable", async () => {
    for (const mode of [0o770, 0o707]) {
      const dir = await privateDir();
      const path = await writeTable(dir);
      await chmod(dir, mode);
      await expect(readAgentsTable(path)).rejects.toThrow(invalid);
    }
  });

  it("refuses a table owned by another user", async () => {
    const path = await writeTable(await privateDir());
    await expect(readAgentsTable(path, { euid: process.geteuid!() + 1 })).rejects.toThrow(invalid);
  });

  it("refuses bytes that are not JSON and JSON that is not a table", async () => {
    await expect(readAgentsTable(await writeTable(await privateDir(), "{not json"))).rejects.toThrow(invalid);
    await expect(readAgentsTable(await writeTable(await privateDir(), { schema: "ccloop-agents-table-v1" }))).rejects.toThrow(invalid);
  });
});

// Spec §12 I4: a broken table must not stand in the way of collecting runs already in flight.
describe("checking only the table path's shape", () => {
  it("accepts a canonical regular file whatever its content or mode", async () => {
    await expect(assertAgentsTablePath(await writeTable(await privateDir(), "{not json", 0o666))).resolves.toBeUndefined();
  });

  it("refuses a symlink, a directory and a relative path", async () => {
    const dir = await privateDir();
    const target = await writeTable(dir);
    await symlink(target, join(dir, "link.json"));
    await expect(assertAgentsTablePath(join(dir, "link.json"))).rejects.toThrow(invalid);
    await expect(assertAgentsTablePath(dir)).rejects.toThrow(invalid);
    await expect(assertAgentsTablePath("agents.json")).rejects.toThrow(invalid);
  });

  it("refuses a path that reaches the table through a symlinked directory", async () => {
    const dir = await privateDir();
    await mkdir(join(dir, "real"), { mode: 0o700 });
    const path = await writeTable(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "alias"));
    await expect(assertAgentsTablePath(join(dir, "alias", "agents.json"))).rejects.toThrow(invalid);
    await expect(assertAgentsTablePath(path)).resolves.toBeUndefined();
  });
});
