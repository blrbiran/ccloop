import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const runLoopSourcePath = fileURLToPath(new URL("../../src/controller/runLoop.ts", import.meta.url));

// Parsed with the TypeScript compiler, NOT matched with a regex. That is a correction, and the
// reason is the whole point of this file: the first version of these two helpers matched
// /import\s+…/, and JS/TS makes the whitespace after `import` optional before `{` and before `*`.
// So `import{writeRunState as W}from"…"` — one deleted space — was invisible to the check, which
// stayed green while the guard was bypassed and `tsc` stayed at 0. That is the SAME defect the old
// `grep -c 'await writeRunState('` acceptance probe had (a double space beat it), moved from the
// call site to the import statement, and it would have made the completeness sentence in
// ownedRunStateWriter.ts false as written. An independent reviewer measured it; see the erratum
// there.
//
// No new toolchain: `typescript` is already a devDependency (the four are @types/node, tsx,
// typescript, vitest) and tsconfig.json already compiles this directory, so parsing costs nothing
// that is not already installed. A parser is also the only honest way to make the claim
// formatting-insensitive — a second regex would only move the bar again.
function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("runLoop.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// The IMPORTED names of every static import declaration, i.e. the names as the EXPORTING module
// spells them, not the local bindings: `import { writeRunState as w }` yields "writeRunState".
// Checking local bindings instead is the hole that lets an aliased import walk past, and that was
// one of the seven rewrites which defeated the original acceptance probe.
function importedNames(source: string): string[] {
  const names: string[] = [];

  for (const statement of parse(source).statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;

    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.push((element.propertyName ?? element.name).text);
      }
    }
  }

  return names;
}

// The other way to get every export of a module into scope without ever writing the name of one:
// `import * as fileStore from "…/fileStore.js"` followed by `fileStore.writeRunState(…)`. It walked
// straight past the named-import check when it was tried, so it is checked separately rather than
// assumed away — and, like the check above, it is parsed rather than matched, because `import*as ns`
// beat the regex form of this one too.
function namespaceImportedModules(source: string): string[] {
  const modules: string[] = [];

  for (const statement of parse(source).statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;

    if (bindings !== undefined && ts.isNamespaceImport(bindings) && ts.isStringLiteral(statement.moduleSpecifier)) {
      modules.push(statement.moduleSpecifier.text);
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
// spells the call — without first naming it in a STATIC import declaration, which this test parses
// and fails on in any spelling. The precise boundary of that claim, including what it does not
// cover, is stated on the assertions below rather than left to the reader to discover.
describe("runLoop.ts run-state write chokepoint", () => {
  it("does not import writeRunState, so no rewrite of a call site inside runLoop.ts can reach it", async () => {
    const source = await readFile(runLoopSourcePath, "utf8");
    const imported = importedNames(source);

    // Anti-vacuity, and load-bearing: a parse that silently stopped producing names would make the
    // real assertion below pass forever while proving nothing — the failure mode this repository
    // keeps hitting, where a broken probe is mistaken for evidence of absence. These two anchors are
    // the in-test equivalent of a must-hit probe and a must-miss probe. `appendEvent` is imported
    // from the same fileStore module the moved writer used to draw writeRunState from, so if the
    // parse can see it, the parse can see writeRunState.
    expect(imported).toContain("appendEvent");
    expect(imported).not.toContain("thisNameIsNotImportedAnywhere");

    // The requirement. Stated on the imported-name list rather than on the raw text, so that
    // `writeRunState` appearing in prose or in a comment cannot fail it and an aliased import
    // cannot pass it.
    //
    // What this does NOT catch, stated because overstating it would recreate the very defect the
    // test exists to fix. All three are STILL OPEN and were measured to be so:
    //   - a direct `writeFile(join(runDir, "loop-state.json"), …)`, which never names writeRunState;
    //   - a dynamic `await import("…/fileStore.js")`, which is not a static import declaration and
    //     so is not a node this walk visits;
    //   - a third module that imports writeRunState and is called from runLoop.ts, since this reads
    //     one file's import list and nothing more.
    // Only the type-level invariant (option (c)) closes those, and it changes existing expectations
    // in tests/persistence/fileStore.test.ts, which task S4 was not authorised to do.
    expect(imported).not.toContain("writeRunState");

    // Same requirement, second spelling. Anti-vacuity first, on a literal the parse must see:
    // runLoop.ts has no namespace import to anchor on, so without this a walk that had stopped
    // finding them would look exactly like a module that imports no namespaces.
    //
    // Scoped by specifier substring, which is a KNOWN and deliberate limit: a namespace import of
    // some future barrel that re-exports writeRunState under a path not containing "fileStore"
    // would not be caught. No such barrel exists today.
    expect(namespaceImportedModules('import * as anything from "some/module.js";')).toEqual(["some/module.js"]);
    expect(namespaceImportedModules(source).filter((module) => module.includes("fileStore"))).toEqual([]);
  });
});
