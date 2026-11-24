import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * scripts/test-affected.mjs (human ruling 2026-11-24, Orca spec 2026-11-24-test-time-analysis.md §2.3): `npm test` runs
 * the tests a change touches instead of all ~300 files, and `npm run test:full` runs everything. A selection that
 * misses a row ships untested code; one that selects nothing while saying it ran looks green. Each criterion runs the
 * real script, in dry-run, in a throwaway git repository shaped like ccloop.
 */
const script = resolve("scripts/test-affected.mjs");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function write(repo: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}
const T = (body = "") => `import { it } from "vitest";\n${body}\nit("t", () => {});\n`;
const FILLERS = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`tests/big/filler${i}.test.ts`, T()]));
const BASE: Record<string, string> = {
  "package.json": `{ "name": "ccloop-like", "type": "module" }\n`,
  "src/a/util.ts": "export const a = 1;\n",
  "src/b/user.ts": `import { a } from "../a/util.js";\nexport const b = a;\n`,
  "src/cli.ts": "export const main = 1;\n",
  "src/big/fooBar.ts": "export const f = 1;\n",
  "scripts/runner.mjs": "export {};\n",
  "tests/a/util.test.ts": T(`import { a } from "../../src/a/util.js";\nvoid a;`),
  "tests/a/other.test.ts": T(),
  "tests/b/user.test.ts": T(`import { b } from "../../src/b/user.js";\nvoid b;`),
  "tests/c/typeOnly.test.ts": T(`import type { a } from "../../src/a/util.js";`),
  "tests/c/viaHelper.test.ts": T(`import { h } from "../helpers/h.js";\nvoid h;`),
  "tests/c/spawns.test.ts": T(`const runner = ["scripts", "runner.mjs"].join("/");\nvoid runner;`),
  "tests/c/decoy.test.ts": T(`const other = "scripts/x-runner.mjs";\nvoid other;`),
  "tests/c/fixtureUser.test.ts": T(`const f = "fixtures/golden.json";\nvoid f;`),
  "tests/helpers/h.ts": `import { a } from "../../src/a/util.js";\nexport const h = a;\n`,
  "tests/fixtures/golden.json": "{}\n",
  "tests/fixtures/orphan.txt": "x\n",
  "tests/cli/main.test.ts": T(),
  "tests/big/fooBarEdge.test.ts": T(),
  "tests/setup/env.ts": "export {};\n",
  ...FILLERS,
};
const ALL = Object.keys(BASE).filter((p) => /^tests\/.+\.test\.ts$/.test(p)).sort();

function repoWith(change: Record<string, string>): string {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "ccloop-affected-"))), "repo");
  roots.push(dirname(repo));
  for (const [rel, text] of Object.entries(BASE)) write(repo, rel, text);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "work");
  for (const [rel, text] of Object.entries(change)) write(repo, rel, text);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  return repo;
}
function dry(change: Record<string, string>, args: string[] = []) {
  const repo = repoWith(change);
  const r = spawnSync(process.execPath, [script, "--dry-run", ...args], { cwd: repo, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  expect(r.status, out).toBe(0);
  const files = out.split("\n").filter((l) => /^ {2}tests\/\S+ <- /.test(l)).map((l) => l.trim().split(" <- ")[0]).sort();
  return { out, files };
}

describe("npm test selects the changed part", () => {
  it("a changed test selects itself", () => {
    expect(dry({ "tests/a/other.test.ts": T("// changed") }).files).toEqual(["tests/a/other.test.ts"]);
  });

  it("a src module selects its mirror directory, its direct importers and the tests of a helper importing it -- not transitive or type-only ones", () => {
    const r = dry({ "src/a/util.ts": "export const a = 2;\n" });
    // mutation: follow imports transitively -> tests/b/user.test.ts (via src/b/user.ts) is a row.
    // mutation: keep type-only imports -> tests/c/typeOnly.test.ts is a row.
    // mutation: drop the helper rule -> tests/c/viaHelper.test.ts is missing.
    expect(r.files).toEqual(["tests/a/other.test.ts", "tests/a/util.test.ts", "tests/c/viaHelper.test.ts"]);
    expect(r.out).toContain("  tests/c/viaHelper.test.ts <- src/a/util.ts (imported by tests/helpers/h.ts)\n");
  });

  it("a top-level src file mirrors to tests/cli", () => {
    expect(dry({ "src/cli.ts": "export const main = 2;\n" }).files).toEqual(["tests/cli/main.test.ts"]);
  });

  it("a mirror directory above 60 tests selects only the tests named after the module", () => {
    const r = dry({ "src/big/fooBar.ts": "export const f = 2;\n" });
    // mutation: select the whole large mirror -> the 61 fillers are rows.
    expect(r.files).toEqual(["tests/big/fooBarEdge.test.ts"]);
  });

  it("a spawned script or a fixture selects the tests that name it as a whole file name, not a longer one", () => {
    // mutation: match the bare substring -> tests/c/decoy.test.ts (it names only "x-runner.mjs") is a row.
    expect(dry({ "scripts/runner.mjs": "export const v = 2;\n" }).files).toEqual(["tests/c/spawns.test.ts"]);
    expect(dry({ "tests/fixtures/golden.json": "{ \"v\": 2 }\n" }).files).toEqual(["tests/c/fixtureUser.test.ts"]);
  });

  it("a file nothing imports or names selects the whole suite, loudly, never nothing", () => {
    const r = dry({ "tests/fixtures/orphan.txt": "y\n" });
    // mutation: drop the fallback -> zero files selected.
    expect(r.files).toEqual(ALL);
    expect(r.out).toContain("test-affected: nothing imports or names tests/fixtures/orphan.txt; selecting the whole suite\n");
  });

  it("config and tests/setup select the whole suite", () => {
    expect(dry({ "tests/setup/env.ts": "export const x = 1;\n" }).files).toEqual(ALL);
    expect(dry({ "package.json": `{ "name": "ccloop-like", "type": "module", "version": "2.0.0" }\n` }).files).toEqual(ALL);
  });

  it("a docs-only change selects zero and says so", () => {
    const r = dry({ "docs/x.md": "# x\n" });
    expect(r.files).toEqual([]);
    expect(r.out).toContain("test-affected: 0 test files selected (no changes against main select any)\n");
    expect(r.out).toContain("changed paths that select no test: docs/x.md\n");
  });
});

describe("npm run test:full and package.json", () => {
  it("--full selects every test file whatever changed", () => {
    // mutation: ignore --full -> only the docs change's zero selection.
    expect(dry({ "docs/x.md": "# x\n" }, ["--full"]).files).toEqual(ALL);
  });

  it("npm test is this script; test:full is this script with --full", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toBe("node scripts/test-affected.mjs");
    expect(pkg.scripts["test:full"]).toBe("node scripts/test-affected.mjs --full");
  });
});
