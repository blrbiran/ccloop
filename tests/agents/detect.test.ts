import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAgents, type CandidateV1 } from "../../src/agents/detect.js";

async function root(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "ccloop-agents-detect-")));
}

async function cli(dir: string, name: string, version: string | null, mode = 0o700): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  await writeFile(path, version === null ? "#!/bin/sh\nexit 3\n" : `#!/bin/sh\necho "${version} (fake)"\n`, { mode });
  await chmod(path, mode);
  return path;
}

// The unit criteria inject the probe, so no real CLI on this machine is ever executed; they keep only candidates
// under the fake root, because /usr/local/bin (and /opt/homebrew/bin on darwin) cannot be redirected.
function under(prefix: string, list: CandidateV1[] | undefined): CandidateV1[] {
  return (list ?? []).filter((candidate) => candidate.path.startsWith(prefix));
}

const versions = new Map<string, string>();
const probe = async (command: string[]) => versions.get(command[0]!) ?? null;

describe("detecting installed agents (spec §9 criterion 1)", () => {
  it("lists search directories before PATH, deduplicates by realpath and drafts the PATH default", async () => {
    const r = await root();
    const home = join(r, "home");
    const local = await cli(join(home, ".local", "bin"), "claude", "2.1.282");
    const volta = await cli(join(home, ".volta", "bin"), "claude", "2.1.200");
    const pathA = join(r, "pathA");
    await mkdir(pathA, { mode: 0o700 });
    await symlink(volta, join(pathA, "claude"));
    const pathB = await cli(join(r, "pathB"), "claude", "2.0.0");
    for (const [path, version] of [[local, "2.1.282"], [volta, "2.1.200"], [join(pathA, "claude"), "2.1.200"], [pathB, "2.0.0"]] as const) versions.set(path, version);

    const result = await detectAgents({ home, path: [pathA, join(r, "pathB")].join(delimiter), platform: "linux", probe });
    expect(under(r, result.candidates.claude)).toEqual([
      { path: local, realpath: local, version: "2.1.282", runnable: true, source: "search-dir", isPathDefault: false },
      { path: volta, realpath: volta, version: "2.1.200", runnable: true, source: "search-dir", isPathDefault: true },
      { path: pathB, realpath: pathB, version: "2.0.0", runnable: true, source: "path", isPathDefault: false },
    ]);
    // The draft takes what PATH would run, not the first candidate listed.
    expect(result.table.installations.claude).toEqual({
      kind: "claude", command: [volta], version: "2.1.200", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000,
    });
  });

  it("records a candidate whose --version fails as not runnable and drafts the first runnable one instead", async () => {
    const r = await root();
    const home = join(r, "home");
    const broken = await cli(join(r, "path"), "codex", null);
    const working = await cli(join(home, ".local", "bin"), "codex", "0.155.1");
    versions.set(working, "0.155.1");
    const result = await detectAgents({ home, path: join(r, "path"), platform: "linux", probe });
    expect(under(r, result.candidates.codex)).toEqual([
      { path: working, realpath: working, version: "0.155.1", runnable: true, source: "search-dir", isPathDefault: false },
      { path: broken, realpath: broken, version: null, runnable: false, source: "path", isPathDefault: true, error: "version-probe-failed" },
    ]);
    expect(result.table.installations.codex).toEqual({
      kind: "codex", command: [working], version: "0.155.1", configDir: null, timeoutMs: 1_800_000, killGraceMs: 5_000,
      sandbox: "workspace-write", budgetMode: "soft",
    });
  });

  // Spec §12 I14: a relative PATH entry resolves against whatever the cwd is; a world-writable directory lets anyone plant a binary.
  it("never searches relative PATH entries, world-writable directories or non-executable files", async () => {
    const r = await root();
    const open = await cli(join(r, "open"), "claude", "9.9.9");
    await chmod(join(r, "open"), 0o777);
    const plain = await cli(join(r, "plain"), "claude", "9.9.8", 0o600);
    versions.set(open, "9.9.9");
    versions.set(plain, "9.9.8");
    const relative = await cli(join(r, "rel", "bin"), "claude", "9.9.7");
    versions.set("rel/bin/claude", "9.9.7");
    versions.set(relative, "9.9.7");
    const cwd = process.cwd();
    process.chdir(r);
    try {
      const result = await detectAgents({ home: join(r, "home"), path: ["rel/bin", join(r, "open"), join(r, "plain")].join(delimiter), platform: "linux", probe });
      expect(result.candidates.claude!.filter((candidate) => candidate.path.startsWith(r) || candidate.path.startsWith("rel"))).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("drafts nothing for a kind whose only candidates are not runnable", async () => {
    const r = await root();
    const broken = await cli(join(r, "path"), "codex", null);
    const result = await detectAgents({ home: join(r, "home"), path: join(r, "path"), platform: "linux", probe });
    expect(under(r, result.candidates.codex)).toMatchObject([{ path: broken, runnable: false }]);
    expect(result.table.installations.codex).toBeUndefined();
  });

  it("leaves a kind with no candidate out of the draft and lists it with no candidates", async () => {
    const r = await root();
    const result = await detectAgents({ home: join(r, "home"), path: join(r, "none"), platform: "linux", probe: async () => null });
    expect(result.schema).toBe("ccloop-agents-detect-v1");
    expect(Object.keys(result.candidates)).toEqual(["claude", "codex"]);
    expect(result.candidates.codex!.every((candidate) => !candidate.runnable)).toBe(true);
    expect(result.table.installations).toEqual({});
  });

  it("runs the real --version probe when none is injected", async () => {
    const r = await root();
    const path = await cli(join(r, "bin"), "claude", "2.1.282");
    const result = await detectAgents({ home: join(r, "home"), path: join(r, "bin"), platform: "linux" });
    expect(under(r, result.candidates.claude)).toEqual([
      { path, realpath: path, version: "2.1.282", runnable: true, source: "path", isPathDefault: true },
    ]);
  });
});
