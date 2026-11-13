// Orca follow-up J (#287): `dist/build-info.json` names the commit a build was made from, so that Orca can tell a stale
// installed build from its pin (the lockfile alone says what was asked for, not what dist/ holds).
//
// npm installs a git dependency in one of two ways (npm's pacote, lib/git.js): it clones the repository (a `.git` is
// there), or -- for a hosted repository whose resolved URL it can map to an archive -- it downloads the host's archive
// tarball (codeload.github.com for GitHub), which carries no `.git`. Either way it runs `prepare` (`npm run build`) in
// that directory. So the commit is read from git when the package root is itself a work tree root, and otherwise from
// `scripts/archive-commit.txt`, which `.gitattributes` marks `export-subst`: `git archive` (and an archive built the same
// way) writes the commit into it; in a checkout it holds the unsubstituted placeholder. Neither answering is
// `commit: null` -- the build never fails for want of a commit.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;

/** The commit `root` was built from, or null. `git` is the git executable (tests point it elsewhere). */
export function readBuildCommit(root, git = "git") {
  try {
    const run = (args) => execFileSync(git, ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // Only a work tree rooted at the package itself: a directory inside some other repository is not that repository.
    if (realpathSync(run(["rev-parse", "--show-toplevel"])) === realpathSync(root)) {
      const head = run(["rev-parse", "HEAD"]);
      if (SHA.test(head)) return head;
    }
  } catch {
    // no git, not a work tree, no commit yet
  }
  try {
    const archived = readFileSync(join(root, "scripts", "archive-commit.txt"), "utf8").trim();
    if (SHA.test(archived)) return archived;
  } catch {
    // not there
  }
  return null;
}

export function writeBuildInfo(root, now = new Date()) {
  const info = { commit: readBuildCommit(root), builtAt: now.toISOString() };
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "build-info.json"), `${JSON.stringify(info)}\n`);
  return info;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeBuildInfo(fileURLToPath(new URL("../", import.meta.url)));
}
