// Per-contract tool rules on codex (ccloop spec 2026-10-22 §3.2.2(b); plan Task 3, "Controller calls"): ccloop must not
// switch codex's sandbox network on when the person's own config.toml explicitly turned it off -- that would be ccloop
// widening a restriction the person set. No TOML parser is in ccloop's dependencies, so a narrow reader answers only
// for the three spellings codex 0.163.0 was measured to honour (measure-codex.md Q3 S1-S3) and fails closed on anything
// else that mentions the key: a misread "absent" here would turn into a widening there.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexConfigTomlPath, readCodexNetworkAccess } from "../../src/agents/codexNetworkConfig.js";
import type { InstallationV1 } from "../../src/agents/types.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { await chmod(dir, 0o700).catch(() => undefined); await rm(dir, { recursive: true, force: true }); } });
async function config(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-net-")); dirs.push(dir);
  const path = join(dir, "config.toml");
  await writeFile(path, text);
  return path;
}

describe("readCodexNetworkAccess (narrow, fail-closed)", () => {
  for (const value of [true, false]) {
    it(`[sandbox_workspace_write] table, network_access = ${value}`, async () => {
      expect(await readCodexNetworkAccess(await config(`model = "x"\n\n[sandbox_workspace_write]\nnetwork_access = ${value}\n\n[tui]\nx = 1\n`))).toEqual({ kind: "value", value });
      // Review round 1 (Orca session b37f7ce9, M4): the quoted key moved to the refusal test below; the quoted header stays.
      expect(await readCodexNetworkAccess(await config(`["sandbox_workspace_write"]\nnetwork_access = ${value} # the person's choice\n`))).toEqual({ kind: "value", value });
    });
    it(`top-level dotted key, ${value}`, async () => {
      expect(await readCodexNetworkAccess(await config(`sandbox_workspace_write.network_access = ${value}\n[tui]\n`))).toEqual({ kind: "value", value });
    });
    it(`inline table, ${value}`, async () => {
      expect(await readCodexNetworkAccess(await config(`sandbox_workspace_write = { network_access = ${value} }\n`))).toEqual({ kind: "value", value });
    });
  }

  it("a comment that mentions the key is not a setting: absent", async () => {
    expect(await readCodexNetworkAccess(await config(`# sandbox_workspace_write.network_access = false\n  # [sandbox_workspace_write]\nmodel = "x"\n`))).toEqual({ kind: "absent" });
  });

  it("no file: absent (codex's default is off, but that is not the person's restriction)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-net-")); dirs.push(dir);
    expect(await readCodexNetworkAccess(join(dir, "config.toml"))).toEqual({ kind: "absent" });
  });

  it("network_access under another table (a profile) is not read as the effective value: unparseable", async () => {
    expect((await readCodexNetworkAccess(await config(`[profiles.x.sandbox_workspace_write]\nnetwork_access = false\n`))).kind).toBe("unparseable");
    expect((await readCodexNetworkAccess(await config(`[other]\nnetwork_access = true\n`))).kind).toBe("unparseable");
  });

  it("a non-boolean value, a duplicate and an unknown shape are unparseable", async () => {
    expect((await readCodexNetworkAccess(await config(`[sandbox_workspace_write]\nnetwork_access = "no"\n`))).kind).toBe("unparseable");
    expect((await readCodexNetworkAccess(await config(`sandbox_workspace_write = { network_access = "no" }\n`))).kind).toBe("unparseable");
    expect((await readCodexNetworkAccess(await config(`sandbox_workspace_write.network_access = true\n[sandbox_workspace_write]\nnetwork_access = false\n`))).kind).toBe("unparseable");
    expect((await readCodexNetworkAccess(await config(`sandbox_workspace_write = {\n  network_access = false\n}\n`))).kind).toBe("unparseable");
  });

  // Review round 1 (Orca session b37f7ce9, M4): a quoted key can carry an escape that spells network_access without the
  // bytes "network_access" (codex's TOML parser unescapes it, this reader does not) -- a missed `= false` would let
  // network:true widen. So any quoted spelling of the key, and any quoted key holding a backslash, is refused.
  it("a quoted network_access key, or a quoted key with an escape, is unparseable (with the line)", async () => {
    for (const text of [
      `[sandbox_workspace_write]\n"network_access" = false\n`,
      `[sandbox_workspace_write]\n'network_access' = false\n`,
      `[sandbox_workspace_write]\n"network\\u005Faccess" = false\n`,
      `sandbox_workspace_write."network\\u005Faccess" = false\n`,
      `"sandbox_workspace\\u005Fwrite".network_access = false\n`,
      `sandbox_workspace_write = { "network\\u005Faccess" = false }\n`,
    ]) {
      const setting = await readCodexNetworkAccess(await config(`model = "x"\n${text}`));
      expect(setting, text).toEqual({ kind: "unparseable", reason: expect.stringContaining("line ") });
    }
    // Positive control: an escape in a value (not a key) is not a key spelling.
    expect(await readCodexNetworkAccess(await config(`model = "a\\tb"\n[sandbox_workspace_write]\nnetwork_access = false\n`))).toEqual({ kind: "value", value: false });
  });

  it("an unreadable file (EACCES) is unparseable, with a reason", async () => {
    const path = await config(`[sandbox_workspace_write]\nnetwork_access = true\n`);
    await chmod(path, 0o000);
    const setting = await readCodexNetworkAccess(path);
    expect(setting.kind).toBe("unparseable");
    expect(setting.kind === "unparseable" && setting.reason.length > 0).toBe(true);
  });
});

describe("codexConfigTomlPath: the config.toml the phase's codex reads", () => {
  const env = { HOME: "/home/p", CODEX_HOME: "/inherited/codex" };
  it("an installation: its configDir, else the inherited CODEX_HOME (effectiveCodexHome)", () => {
    expect(codexConfigTomlPath({ configDir: "/cfg" } as InstallationV1, undefined, env)).toBe("/cfg/config.toml");
    expect(codexConfigTomlPath({ configDir: null } as InstallationV1, undefined, env)).toBe("/inherited/codex/config.toml");
  });
  it("the legacy path: the CODEX_HOME the adapter hands codex, else the inherited one, else <HOME>/.codex", () => {
    expect(codexConfigTomlPath(undefined, { CODEX_HOME: "/extra" }, env)).toBe("/extra/config.toml");
    expect(codexConfigTomlPath(undefined, undefined, env)).toBe("/inherited/codex/config.toml");
    expect(codexConfigTomlPath(undefined, undefined, { HOME: "/home/p" })).toBe("/home/p/.codex/config.toml");
  });
});
