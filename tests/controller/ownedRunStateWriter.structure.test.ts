import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runLoopSourcePath = fileURLToPath(new URL("../../src/controller/runLoop.ts", import.meta.url));

// Collects the IMPORTED names of every static import in a TypeScript source, i.e. the names as the
// exporting module spells them, NOT the local bindings. `import { writeRunState as w }` therefore
// yields "writeRunState" — checking local bindings instead is the hole that makes an aliased import
// walk straight past this test, which is precisely one of the seven rewrites that defeated the old
// `grep -c 'await writeRunState('` acceptance probe.
//
// A regex, not a parser: the repository's devDependencies are exactly @types/node, tsx, typescript
// and vitest, and pulling in a parser to serve one test is the kind of tooling growth Rule 2
// refuses. The cost of the choice is stated where it bites, in the "what this does NOT catch" note
// on the assertion below, rather than hidden.
function importedNames(source: string): string[] {
  const names: string[] = [];
  const importClause = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["'][^"']+["']/g;

  for (const match of source.matchAll(importClause)) {
    const braces = /\{([\s\S]*?)\}/.exec(match[1] ?? "");

    if (braces === null) {
      continue;
    }

    for (const specifier of (braces[1] ?? "").split(",")) {
      const imported = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();

      if (imported !== undefined && imported.length > 0) {
        names.push(imported);
      }
    }
  }

  return names;
}

// The other way to get every export of a module into scope without ever writing the name of one:
// `import * as fileStore from "…/fileStore.js"` followed by `fileStore.writeRunState(…)`. That
// walked straight past the named-import check above when it was tried, so it is checked separately
// rather than assumed away.
function namespaceImportedModules(source: string): string[] {
  const modules: string[] = [];
  const namespaceImport = /import\s+\*\s+as\s+\w+\s+from\s+["']([^"']+)["']/g;

  for (const match of source.matchAll(namespaceImport)) {
    if (match[1] !== undefined) {
      modules.push(match[1]);
    }
  }

  return modules;
}

// Package 2 / debt D-1, task S4. WHY this test exists rather than a comment saying the same thing:
// the ownership guard's completeness rested on the claim "runLoop.ts writes loop-state.json only
// through the guarded writer", and that claim had no enforcement mechanism at all — its acceptance
// probe was `grep -c 'await writeRunState(' src/controller/runLoop.ts`, which a scoped re-reviewer
// defeated in 7 of 7 attempts with ordinary rewrites, and nothing in the repository ever ran it.
// An unenforced completeness claim is the exact shape of Critical finding F-1, where a false
// "X is the only writer" claim let a terminal status land in a run this process did not own.
//
// So the structure that makes the claim true is now itself the thing under test: the writer lives
// in src/controller/ownedRunStateWriter.ts, and runLoop.ts cannot call writeRunState — however it
// spells the call — without first importing the name. This test fails when that import comes back.
describe("runLoop.ts run-state write chokepoint", () => {
  it("does not import writeRunState, so no rewrite of a call site inside runLoop.ts can reach it", async () => {
    const source = await readFile(runLoopSourcePath, "utf8");
    const imported = importedNames(source);

    // Anti-vacuity, and load-bearing: a regex that silently stopped matching would make the real
    // assertion below pass forever while proving nothing — the failure mode this repository keeps
    // hitting, where a broken probe is mistaken for evidence of absence. These two anchors are the
    // in-test equivalent of a must-hit probe and a must-miss probe. `appendEvent` is imported from
    // the same fileStore module the moved writer used to draw writeRunState from, so if the parse
    // can see it, the parse can see writeRunState.
    expect(imported).toContain("appendEvent");
    expect(imported).not.toContain("thisNameIsNotImportedAnywhere");

    // The requirement. Stated on the imported-name list rather than on the raw text, so that
    // `writeRunState` appearing in prose or in a comment cannot fail it and an aliased import
    // cannot pass it.
    //
    // What this does NOT catch, stated because overstating it would recreate the very defect the
    // test exists to fix: a direct `writeFile(join(runDir, "loop-state.json"), …)` from runLoop.ts
    // writes the file without ever naming writeRunState, and is STILL not blocked; neither is a
    // dynamic `await import(…)`, which is not a static import clause at all. Only the type-level
    // invariant (option (c)) closes those, and it changes existing expectations in
    // tests/persistence/fileStore.test.ts, which task S4 was not authorised to do.
    expect(imported).not.toContain("writeRunState");

    // Same requirement, second spelling. Anti-vacuity first, on a literal the regex must match:
    // there is no namespace import in runLoop.ts to anchor on, so without this a regex that had
    // stopped matching anything would look exactly like a module that imports no namespaces.
    expect(namespaceImportedModules('import * as anything from "some/module.js";')).toEqual(["some/module.js"]);
    expect(namespaceImportedModules(source).filter((module) => module.includes("fileStore"))).toEqual([]);
  });
});
