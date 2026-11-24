#!/usr/bin/env node
// `npm test`: runs the tests a change touches, chosen by code, and says what it chose and why (human ruling 2026-11-24,
// Orca spec docs/superpowers/specs/2026-11-24-test-time-analysis.md §2.3: "ccloop gets a test-affected"). Everything is
// `npm run test:full`, at release or when the human asks.
//
//   node scripts/test-affected.mjs [--base <ref>] [--dry-run] [--full] [-- <vitest args>]
//   node scripts/test-affected.mjs <path or filter> ...      runs exactly `vitest run <args>`
//
// Changed files = `git diff <base>...HEAD` + staged + unstaged + untracked; <base> defaults to main on a branch, else
// origin/main. Rules, each printed as the reason beside the file it selected:
//   - a changed test file selects itself;
//   - src/<dir>/... selects its mirror directory tests/<dir>/ (above MIRROR_MAX test files, only the tests whose file name
//     starts with the module's name) and the tests that import it directly; top-level src/*.ts mirrors to tests/cli/;
//   - any other file under src/, tests/ or scripts/ (a helper, a fixture, a spawned script) selects the tests that import
//     it directly or name its file name in quotes or after a slash; if none does, the whole suite, said out loud;
//   - package.json, package-lock.json, vitest.config.ts, tsconfig*.json and tests/setup/** select the whole suite.
// A test that reaches a change only transitively, or through a spawned dist/ build, is not selected: test:full runs it.
// The typecheck always runs. Zero selected files is printed as zero, never run as green. When vitest fails,
// scripts/check-known-reds.mjs reads its JSON report and says whether every red is on the known roster; the exit status
// stays vitest's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const TEST = /^tests\/.+\.test\.ts$/;
const CODE = /\.[cm]?[jt]sx?$/;
const MIRROR_MAX = 60;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'`](\.{1,2}\/[^"'`]+)["'`]/g;
const TYPE_ONLY = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s*from\s*["'`][^"'`]+["'`]/g;

function fail(message) {
  console.error(`test-affected: ${message}`);
  process.exit(1);
}
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (top.status !== 0) fail(`not inside a git repository: ${top.stderr.trim()}`);
const root = top.stdout.trim();
function git(args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

let base;
let dryRun = false;
let full = false;
const vitestArgs = [];
const passThrough = [];
{
  const argv = process.argv.slice(2);
  let forwarded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (forwarded) vitestArgs.push(a);
    else if (a === "--") forwarded = true;
    else if (a === "--base" || a.startsWith("--base=")) {
      base = a === "--base" ? argv[++i] : a.slice("--base=".length);
      if (!base) fail("--base needs a ref");
    } else if (a === "--dry-run") dryRun = true;
    else if (a === "--full") full = true;
    else if (a.startsWith("-")) vitestArgs.push(a);
    else passThrough.push(a);
  }
}
const vitestBin = join(root, "node_modules", ".bin", "vitest");
// `npm test -- tests/x.test.ts` keeps meaning "run only this".
if (passThrough.length) {
  console.log(`test-affected: the arguments name a path or filter; running exactly: vitest run ${[...passThrough, ...vitestArgs].join(" ")}`);
  const r = spawnSync(vitestBin, ["run", ...passThrough, ...vitestArgs], { cwd: root, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const hasRef = (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root }).status === 0;
const branch = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
if (base === undefined) {
  if (branch !== "main" && hasRef("refs/heads/main")) base = "main";
  else if (hasRef("refs/remotes/origin/main")) base = "origin/main";
  else if (hasRef("refs/heads/main")) base = "main";
  else fail("neither origin/main nor main exists; pass --base <ref>");
}
function nameStatusPaths(out) {
  const tokens = out.split("\0");
  const paths = [];
  for (let i = 0; i < tokens.length - 1; ) {
    const status = tokens[i++];
    paths.push(tokens[i++]);
    if (status.startsWith("R") || status.startsWith("C")) paths.push(tokens[i++]);
  }
  return paths;
}
const changed = [...new Set([
  ...nameStatusPaths(git(["diff", "--name-status", "-z", "-M", `${base}...HEAD`])),
  ...nameStatusPaths(git(["diff", "--name-status", "-z", "-M", "--cached"])),
  ...nameStatusPaths(git(["diff", "--name-status", "-z", "-M"])),
  ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean),
])].sort();

function listFiles(rel, pattern) {
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .filter((f) => pattern.test(f));
}
const allTests = listFiles("tests", TEST).sort();
// Every code file under tests/: its text, and the repo paths its relative value imports may name.
const testCode = listFiles("tests", CODE).map((f) => {
  const text = readFileSync(join(root, f), "utf8");
  const imports = new Set();
  for (const [, spec] of text.replace(TYPE_ONLY, "").matchAll(RELATIVE_IMPORT)) {
    const target = relative(root, join(root, f, "..", spec));
    for (const t of [target, target.replace(/\.[cm]?js$/, ".ts"), `${target}.ts`, `${target}/index.ts`]) imports.add(t);
  }
  return { f, text, imports };
});

const selection = new Map();
const selecting = new Set();
function select(files, reason, path) {
  for (const file of files) {
    if (!selection.has(file)) selection.set(file, []);
    selection.get(file).push(reason);
    selecting.add(path);
  }
}
const isConfig = (p) => ["package.json", "package-lock.json", "vitest.config.ts"].includes(p) || /^tsconfig[^/]*\.json$/.test(p) || p.startsWith("tests/setup/");
// A helper under tests/ that imports the changed path stands for it: the tests that import that helper are selected.
function importers(p) {
  const direct = testCode.filter((t) => t.imports.has(p));
  return {
    tests: direct.filter((t) => TEST.test(t.f)).map((t) => t.f),
    viaHelper: direct.filter((t) => !TEST.test(t.f)).flatMap((h) => testCode.filter((t) => TEST.test(t.f) && t.imports.has(h.f)).map((t) => [t.f, h.f])),
  };
}
function namedBy(p) {
  const name = p.slice(p.lastIndexOf("/") + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`["'\`/]${name}["'\`]`);
  return testCode.filter((t) => t.f !== p && TEST.test(t.f) && token.test(t.text)).map((t) => t.f);
}

if (full) select(allTests, "test:full (every test file)", "--full");
else {
  for (const p of changed) {
    if (isConfig(p)) { select(allTests, `${p} (config: whole suite)`, p); continue; }
    if (TEST.test(p)) { if (existsSync(join(root, p))) select([p], `${p} (changed test)`, p); continue; }
    if (!/^(src|tests|scripts)\//.test(p)) continue;
    const { tests, viaHelper } = importers(p);
    select(tests, `${p} (imported directly)`, p);
    for (const [t, h] of viaHelper) select([t], `${p} (imported by ${h})`, p);
    const parts = p.split("/");
    if (parts[0] === "src") {
      const dir = parts.length === 2 ? "tests/cli/" : `tests/${parts[1]}/`;
      const mirror = listFiles(dir, TEST);
      if (mirror.length <= MIRROR_MAX) select(mirror, `${p} (mirror ${dir})`, p);
      else {
        const stem = parts[parts.length - 1].replace(/\.[^.]+$/, "");
        select(mirror.filter((f) => f.slice(f.lastIndexOf("/") + 1).startsWith(stem)), `${p} (name match in ${dir}: ${mirror.length} tests > ${MIRROR_MAX})`, p);
      }
      continue;
    }
    const named = namedBy(p);
    select(named, `${p} (named by the test)`, p);
    if (!selecting.has(p)) {
      console.log(`test-affected: nothing imports or names ${p}; selecting the whole suite`);
      select(allTests, `${p} (nothing imports or names it: whole suite)`, p);
    }
  }
}

const files = [...selection.keys()].sort();
console.log(full
  ? "test-affected: npm run test:full: every test file (at release or when the human asks)"
  : "test-affected: npm test: the changed part; npm run test:full runs everything, at release or when the human asks");
console.log(`test-affected: ${changed.length} changed paths against ${base} (committed since the merge base, staged, unstaged, untracked)`);
for (const f of files) console.log(`  ${f} <- ${selection.get(f).join("; ")}`);
const idle = changed.filter((p) => !selecting.has(p));
if (idle.length && !full) console.log(`test-affected: changed paths that select no test: ${idle.join(", ")}`);
console.log(files.length ? `test-affected: ${files.length} test files selected` : `test-affected: 0 test files selected (no changes against ${base} select any)`);
console.log("test-affected: typecheck: npm run typecheck");
if (dryRun) process.exit(0);

const uptime = (when) => console.log(`test-affected: load at ${when}: ${spawnSync("uptime", { encoding: "utf8" }).stdout?.trim() ?? "unavailable"}`);
uptime("start");
const typecheck = spawnSync("npm", ["run", "typecheck"], { cwd: root, stdio: "inherit" });
let status = typecheck.status ?? 1;
if (files.length) {
  const report = join(mkdtempSync(join(tmpdir(), "ccloop-test-")), "vitest.json");
  const r = spawnSync(vitestBin, ["run", ...files, ...vitestArgs, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], { cwd: root, stdio: "inherit" });
  const vitestStatus = r.status ?? 1;
  if (vitestStatus !== 0 && existsSync(report)) {
    console.log(`test-affected: vitest failed; the known-reds roster says (report ${report}):`);
    spawnSync(process.execPath, [join(root, "scripts", "check-known-reds.mjs"), report], { cwd: root, stdio: "inherit" });
  }
  if (status === 0) status = vitestStatus;
}
uptime("end");
process.exit(status);
