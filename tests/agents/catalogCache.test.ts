import { chmod, mkdir, mkdtemp, readdir, realpath, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_LIFETIME_MS, catalogCacheDir, catalogKey, entryFileName, readCatalogEntry, writeCatalogEntry, type CatalogEntryV1 } from "../../src/agents/catalogCache.js";
import type { InstallationV1 } from "../../src/agents/types.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §4.1-§4.2, R4): one file per key under a redirectable dir, 0700/0600
// set explicitly, a 30-minute lifetime, and any change of a key field is a miss. Each key-field test is the one the
// mutation "drop that field from catalogKey" turns red.
const T0 = Date.parse("2026-10-15T00:00:00.000Z");
const root = async () => realpath(await mkdtemp(join(tmpdir(), "ccloop-cache-")));
async function world(kind: "omp" | "codex" = "omp") {
  const dir = await root();
  const binary = join(dir, kind); await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
  const home = join(dir, "home"); await mkdir(join(home, ".omp", "agent"), { recursive: true }); await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".omp", "agent", "config.yml"), "a: 1\n"); await writeFile(join(home, ".codex", "config.toml"), "model = \"x\"\n");
  const installation: InstallationV1 = kind === "omp"
    ? { kind, command: [binary], version: "18.10.1", configDir: null, timeoutMs: 1000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null }
    : { kind, command: [binary], version: "9.9.9-fake", configDir: null, timeoutMs: 1000, killGraceMs: 50, sandbox: "read-only", budgetMode: "soft" };
  const env = { HOME: home, CCLOOP_CACHE_DIR: join(dir, "cache") } as NodeJS.ProcessEnv;
  return { dir, binary, home, installation, env, cache: join(dir, "cache") };
}
const entry = (key: CatalogEntryV1["key"], at = T0): CatalogEntryV1 => ({ schema: "ccloop-agent-catalog-v1", key, observedAt: new Date(at).toISOString(), version: "18.10.1",
  rows: [{ selector: "gateway/model-a", provider: "gateway", contextWindow: 200000, maxTokens: 8192 }], codexFeatures: null });

describe("cache dir (spec §4.2)", () => {
  it("prefers CCLOOP_CACHE_DIR, then XDG_CACHE_HOME, then HOME, and refuses a relative or absent root", () => {
    expect(catalogCacheDir({ CCLOOP_CACHE_DIR: "/a", XDG_CACHE_HOME: "/b", HOME: "/c" })).toBe("/a");
    expect(catalogCacheDir({ XDG_CACHE_HOME: "/b", HOME: "/c" })).toBe("/b/ccloop/agent-catalog");
    expect(catalogCacheDir({ HOME: "/c" })).toBe("/c/.cache/ccloop/agent-catalog");
    expect(catalogCacheDir({ CCLOOP_CACHE_DIR: "rel", HOME: "/c" })).toBeNull();   // RF3
    expect(catalogCacheDir({ XDG_CACHE_HOME: "rel", HOME: "/c" })).toBe("/c/.cache/ccloop/agent-catalog");   // RF3: never cwd-relative
    expect(catalogCacheDir({ HOME: "rel" })).toBeNull();                            // RF3: never cwd-relative
    expect(catalogCacheDir({})).toBeNull();                                         // RF3
  });
});

describe("entries (spec §4.1)", () => {
  // 0o000 would widen a mode left to the umask; 0o277 would narrow one below the owner's read/write (so the explicit chmod
  // after mkdir/writeFile is what keeps 0700/0600 there).
  it.each([["0o000", 0o000], ["0o277", 0o277]] as const)("round-trips an entry, creating the dir 0700 and the file 0600 whatever the umask (umask %s)", async (_label, umask) => {
    const w = await world(); const key = await catalogKey(w.installation, w.env);
    const old = process.umask(umask);
    try { await writeCatalogEntry(w.cache, entry(key)); } finally { process.umask(old); }
    expect(await readCatalogEntry(w.cache, key, T0 + 1)).toEqual(entry(key));
    expect((await stat(w.cache)).mode & 0o777).toBe(0o700);
    expect((await stat(join(w.cache, entryFileName(key)))).mode & 0o777).toBe(0o600);
    expect(await readdir(w.cache)).toEqual([entryFileName(key)]);
  });

  it("leaves an existing dir's mode alone", async () => {
    const w = await world(); await mkdir(w.cache, { mode: 0o755 }); await chmod(w.cache, 0o755);
    await writeCatalogEntry(w.cache, entry(await catalogKey(w.installation, w.env)));
    expect((await stat(w.cache)).mode & 0o777).toBe(0o755);
  });

  it("is a miss at exactly 30 minutes, and for an entry from the future (RF4)", async () => {
    const w = await world(); const key = await catalogKey(w.installation, w.env);
    await writeCatalogEntry(w.cache, entry(key));
    expect(await readCatalogEntry(w.cache, key, T0 + CATALOG_LIFETIME_MS - 1)).not.toBeNull();
    expect(await readCatalogEntry(w.cache, key, T0 + 1_800_000)).toBeNull();
    expect(await readCatalogEntry(w.cache, key, T0 - 1)).toBeNull();
  });

  it("treats a corrupt entry and an entry whose stored key differs as a miss (RF4)", async () => {
    const w = await world(); const key = await catalogKey(w.installation, w.env);
    await mkdir(w.cache, { recursive: true });
    await writeFile(join(w.cache, entryFileName(key)), "{not json");
    expect(await readCatalogEntry(w.cache, key, T0)).toBeNull();
    await writeFile(join(w.cache, entryFileName(key)), JSON.stringify(entry({ ...key, kind: "codex" })));
    expect(await readCatalogEntry(w.cache, key, T0)).toBeNull();
  });

  it("never throws when the dir cannot be written, and leaves no temp file (RF2)", async () => {
    const w = await world(); const key = await catalogKey(w.installation, w.env);
    await writeFile(w.cache, "a file where the dir should be");
    await expect(writeCatalogEntry(w.cache, entry(key))).resolves.toBeUndefined();
    const locked = join(w.dir, "locked"); await mkdir(locked, { mode: 0o500 }); await chmod(locked, 0o500);
    await expect(writeCatalogEntry(locked, entry(key))).resolves.toBeUndefined();
    expect(await readdir(locked)).toEqual([]);
  });

  it("keeps one file when two writers race on a cold key (RF1)", async () => {
    const w = await world(); const key = await catalogKey(w.installation, w.env);
    await Promise.all([writeCatalogEntry(w.cache, entry(key)), writeCatalogEntry(w.cache, entry(key, T0 + 5))]);
    expect(await readdir(w.cache)).toEqual([entryFileName(key)]);
  });
});

/** The leaf paths (e.g. `files.0.size`) at which two keys differ; lets a test measure that ONLY its field changed. */
function changedLeaves(a: unknown, b: unknown, at = ""): string[] {
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return names.flatMap((name) => changedLeaves((a as Record<string, unknown>)[name], (b as Record<string, unknown>)[name], at === "" ? name : `${at}.${name}`));
  }
  return Object.is(a, b) ? [] : [at];
}

// SDD ruling (Orca session a852f96a, Task 2 mutations): each test changes ONE key field, measured by `fields`, so dropping
// that field from the key is a stale hit this test sees (`renamed` false, `fields` empty).
describe("key fields (spec §4.1; each is a stale-hit guard)", () => {
  type World = Awaited<ReturnType<typeof world>>;
  const delta = async (w: World, installation: InstallationV1, act: () => Promise<InstallationV1 | void>) => {
    const before = await catalogKey(installation, w.env);
    const after = await catalogKey((await act()) ?? installation, w.env);
    return { renamed: entryFileName(after) !== entryFileName(before), fields: changedLeaves(before, after) };
  };
  it("the binary's mtime", async () => {
    const w = await world();
    expect(await delta(w, w.installation, async () => { await utimes(w.binary, new Date(T0), new Date(T0)); })).toEqual({ renamed: true, fields: ["files.0.mtimeMs"] });
  });
  it("the binary's size, mtime held", async () => {
    const w = await world(); await utimes(w.binary, new Date(T0), new Date(T0));
    expect(await delta(w, w.installation, async () => { await writeFile(w.binary, "#!/bin/sh\n# longer\n"); await utimes(w.binary, new Date(T0), new Date(T0)); }))
      .toEqual({ renamed: true, fields: ["files.0.size"] });
  });
  it("the binary's realpath, argv, mtime and size held", async () => {
    const w = await world(); const a = join(w.dir, "a"); const b = join(w.dir, "b"); const link = join(w.dir, "agent");
    for (const file of [a, b]) { await writeFile(file, "#!/bin/sh\n", { mode: 0o700 }); await utimes(file, new Date(T0), new Date(T0)); }
    await symlink(a, link);
    expect(await delta(w, { ...w.installation, command: [link] }, async () => { await unlink(link); await symlink(b, link); }))
      .toEqual({ renamed: true, fields: ["files.0.path"] });
  });
  it("an argv file's mtime (a wrapper's version file, spec issue 8)", async () => {
    const w = await world(); const file = join(w.dir, "version.txt"); await writeFile(file, "1.0.0\n");
    const installation: InstallationV1 = { ...w.installation, command: [w.binary, file] };
    expect(await delta(w, installation, async () => { await utimes(file, new Date(T0 + 9_000), new Date(T0 + 9_000)); })).toEqual({ renamed: true, fields: ["files.1.mtimeMs"] });
  });
  it("an argv word that names no file", async () => {
    const w = await world();
    expect(await delta(w, w.installation, async () => ({ ...w.installation, command: [w.binary, "--no-such-file-word"] }))).toEqual({ renamed: true, fields: ["command.1"] });
  });
  it("the profile, with no HOME so neither profile has config files", async () => {
    const w = await world(); delete w.env.HOME;
    expect(await delta(w, w.installation, async () => ({ ...w.installation, profile: "work" }))).toEqual({ renamed: true, fields: ["profile"] });
  });
  it("the configDir, naming the default agent dir", async () => {
    const w = await world();
    expect(await delta(w, w.installation, async () => ({ ...w.installation, configDir: join(w.home, ".omp", "agent") }))).toEqual({ renamed: true, fields: ["configDir"] });
  });
  it("the inherited config dir variable, naming the default agent dir", async () => {
    const w = await world();
    expect(await delta(w, w.installation, async () => { w.env.PI_CODING_AGENT_DIR = join(w.home, ".omp", "agent"); })).toEqual({ renamed: true, fields: ["inheritedConfigDir"] });
  });
  it("omp's config.yml mtime", async () => {
    const w = await world();
    expect(await delta(w, w.installation, async () => { await utimes(join(w.home, ".omp", "agent", "config.yml"), new Date(T0), new Date(T0)); }))
      .toEqual({ renamed: true, fields: ["configFiles.0.mtimeMs"] });
  });
  it("omp's models.yaml mtime", async () => {
    const w = await world(); const models = join(w.home, ".omp", "agent", "models.yaml"); await writeFile(models, "providers: {}\n");
    expect(await delta(w, w.installation, async () => { await utimes(models, new Date(T0), new Date(T0)); })).toEqual({ renamed: true, fields: ["configFiles.1.mtimeMs"] });
  });
  it("codex's config.toml mtime", async () => {
    const w = await world("codex");
    expect(await delta(w, w.installation, async () => { await utimes(join(w.home, ".codex", "config.toml"), new Date(T0), new Date(T0)); }))
      .toEqual({ renamed: true, fields: ["configFiles.0.mtimeMs"] });
  });
  it("the kind, with no HOME so neither kind has config files", async () => {
    const w = await world(); delete w.env.HOME;
    expect(await delta(w, w.installation, async () => ({ ...w.installation, kind: "claude" }))).toEqual({ renamed: true, fields: ["kind"] });
  });
  it("not the cache dir or the clock", async () => {
    const w = await world();
    expect(await delta(w, w.installation, async () => { w.env.CCLOOP_CACHE_DIR = join(w.dir, "elsewhere"); })).toEqual({ renamed: false, fields: [] });
  });
});

// omp 18.10.1 `pi-utils/src/dirs.ts` (DirResolver constructor, resolveActiveAgentDirOverride, normalizeProfileName): the
// files stamped must be the ones the CLI reads, or an edit to them is a stale hit.
describe("which config files are stamped (spec issue 7(d))", () => {
  const paths = async (installation: InstallationV1, env: NodeJS.ProcessEnv) => (await catalogKey(installation, env)).configFiles.map((file) => file.path);
  it("a named omp profile reads its own agent dir, whatever configDir or PI_CODING_AGENT_DIR say; \"default\" honours them", async () => {
    const w = await world(); const custom = join(w.dir, "custom");
    const profileDir = join(w.home, ".omp", "profiles", "work", "agent");
    expect(await paths({ ...w.installation, profile: "work", configDir: custom }, w.env)).toEqual([join(profileDir, "config.yml"), join(profileDir, "models.yaml")]);
    expect(await paths({ ...w.installation, profile: "work" }, { ...w.env, PI_CODING_AGENT_DIR: custom })).toEqual([join(profileDir, "config.yml"), join(profileDir, "models.yaml")]);
    expect(await paths({ ...w.installation, profile: "default", configDir: custom }, w.env)).toEqual([join(custom, "config.yml"), join(custom, "models.yaml")]);
    expect(await paths({ ...w.installation, profile: "default" }, { ...w.env, PI_CODING_AGENT_DIR: custom })).toEqual([join(custom, "config.yml"), join(custom, "models.yaml")]);
  });
  it("an empty or relative inherited config dir is unset, never a cwd-relative path", async () => {
    const omp = await world(); const agent = join(omp.home, ".omp", "agent");
    for (const value of ["", "rel"]) {
      expect(await paths(omp.installation, { ...omp.env, PI_CODING_AGENT_DIR: value })).toEqual([join(agent, "config.yml"), join(agent, "models.yaml")]);
    }
    const codex = await world("codex");
    for (const value of ["", "rel"]) {
      expect(await paths(codex.installation, { ...codex.env, CODEX_HOME: value })).toEqual([join(codex.home, ".codex", "config.toml")]);
    }
  });
});
