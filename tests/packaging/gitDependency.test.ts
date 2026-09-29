import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeRunnerPath } from "../../src/runtime/claude/claudeAgentAdapter.js";

/**
 * Orca ruling (2026-09-29): Orca depends on ccloop by a git URL pinned to a commit. npm installs such a dependency by
 * cloning it, installing its devDependencies, running `prepare`, and packing only what `files` names. Whatever ccloop
 * reads from its own package root at run time therefore has to be in `files`, or the install succeeds and the first
 * claude phase dies on ENOENT far from here. `npm pack` against a scratch clone is the end-to-end proof (Orca plan
 * 2026-09-29-ccloop-git-dependency, Task 4); this file is the part code can answer on every run.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  files?: string[];
  scripts?: Record<string, string>;
  bin?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** npm's `files` for plain entries: a path ships when an entry names it or a directory above it. */
function ships(path: string): boolean {
  return (manifest.files ?? []).some((entry) => {
    const name = entry.replace(/\/$/, "");
    return path === name || path.startsWith(`${name}/`);
  });
}

/** The `scripts/` files a script imports by a relative specifier. */
function localImports(path: string): string[] {
  return [...readFileSync(join(root, path), "utf8").matchAll(/from "\.\/([^"]+)"/g)].map((match) => `scripts/${match[1]}`);
}

describe("ccloop installed as a git dependency", () => {
  it("builds dist/ itself on install, with a compiler it declares", () => {
    // dist/ is gitignored, so a git install has no build unless `prepare` makes one.
    expect(manifest.scripts?.prepare).toBe("npm run build");
    expect(manifest.scripts?.build).toMatch(/^tsc -p tsconfig\.json /);
    expect(manifest.devDependencies?.typescript).toBeDefined();
  });

  it("ships its bin, the compiled runtime and the worker accept spawns", () => {
    expect(manifest.bin?.ccloop).toBe("dist/cli.js");
    // dist/src/control/worker.js: accept.ts's default worker, resolved relative to its own module.
    for (const path of ["dist/cli.js", "dist/src/cli.js", "dist/src/control/worker.js"]) expect(ships(path), path).toBe(true);
  });

  it("ships the claude phase runner and every script it imports", () => {
    // Derived, not listed: a new relative import in the runner changes the closure and turns this red until
    // `files` names it too.
    const runner = relative(root, claudeRunnerPath());
    const closure = [runner];
    for (let index = 0; index < closure.length; index += 1) {
      for (const next of localImports(closure[index]!)) if (!closure.includes(next)) closure.push(next);
    }
    expect(closure).toEqual(["scripts/claude-phase-runner.mjs", "scripts/claude-stream.mjs"]);
    for (const path of closure) expect(ships(path), path).toBe(true);
  });
});
