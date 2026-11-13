import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without types
import { readBuildCommit, writeBuildInfo } from "../../scripts/build-info.mjs";

/**
 * Orca follow-up J (#287, tester ledger issue-20261023 "Issue 287"; human, Orca session c8b75eac: 「本会话建议的顺序 => 同意」):
 * Orca's status could not tell an installed ccloop build older than its pin -- the lockfile named the pin, dist/ held an
 * older build, and nothing in the package said which commit dist/ was built from. `npm run build` (and so npm's `prepare`
 * for a git dependency) now writes dist/build-info.json { commit, builtAt }. npm builds a git dependency either in a clone
 * or in the host's archive tarball, which has no `.git` (npm's pacote, lib/git.js); both are answered below.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[]; scripts?: Record<string, string> };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

/** A repository laid out as ccloop is for this purpose: the archive placeholder and its export-subst attribute. */
function repository(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ccloop-build-info-")));
  git(dir, "init", "-q");
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(root, "scripts", "archive-commit.txt"), join(dir, "scripts", "archive-commit.txt"));
  copyFileSync(join(root, ".gitattributes"), join(dir, ".gitattributes"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}

describe("dist/build-info.json names the commit a build was made from (Orca follow-up J, #287)", () => {
  it("is written by the build, last, and shipped", () => {
    // mutation: drop `&& node scripts/build-info.mjs` from the build script -> red
    expect(manifest.scripts?.build).toMatch(/ && node scripts\/build-info\.mjs$/);
    // mutation: drop "dist/build-info.json" from `files` -> a git install packs a build without it, red
    expect(manifest.files).toContain("dist/build-info.json");
  });

  it("reads HEAD in a checkout rooted at the package", () => {
    const dir = repository();
    // mutation: skip the git step -> the checkout's placeholder is unsubstituted, null, red
    expect(readBuildCommit(dir)).toBe(git(dir, "rev-parse", "HEAD"));
    const info = writeBuildInfo(dir, new Date("2026-11-13T00:00:00.000Z"));
    expect(JSON.parse(readFileSync(join(dir, "dist", "build-info.json"), "utf8"))).toEqual(info);
    expect(info).toEqual({ commit: git(dir, "rev-parse", "HEAD"), builtAt: "2026-11-13T00:00:00.000Z" });
  });

  it("reads the commit git archive substitutes into an archive, never the HEAD of a repository around it", () => {
    const source = repository();
    const head = git(source, "rev-parse", "HEAD");
    // The archive is unpacked inside another repository (whose HEAD differs), as npm's cache directory could be.
    const outer = repository();
    git(outer, "commit", "-q", "--allow-empty", "-m", "two");
    const unpacked = join(outer, "unpacked");
    mkdirSync(unpacked);
    execFileSync("/bin/sh", ["-c", `git -C '${source}' archive HEAD | tar -x -C '${unpacked}'`]);
    expect(readFileSync(join(unpacked, "scripts", "archive-commit.txt"), "utf8").trim()).toBe(head);
    // mutation: drop the work-tree-root check -> the outer repository's HEAD, red
    // mutation: skip the archive step -> null, red
    expect(readBuildCommit(unpacked)).toBe(head);
  });

  it("answers null, without failing, where neither git nor an archive says", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ccloop-build-info-")));
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(root, "scripts", "archive-commit.txt"), join(dir, "scripts", "archive-commit.txt"));
    expect(readBuildCommit(dir)).toBeNull();
    // A checkout read without a usable git executable.
    const checkout = repository();
    // mutation: no try around the git step -> ENOENT thrown out of the build, red
    expect(readBuildCommit(checkout, join(dir, "no-such-git"))).toBeNull();
    writeFileSync(join(dir, "scripts", "archive-commit.txt"), "not a sha\n");
    expect(writeBuildInfo(dir).commit).toBeNull();
  });
});
