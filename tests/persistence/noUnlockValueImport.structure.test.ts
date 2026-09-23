import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Why a structure criterion and not a behavioural one: a value import from src/unlock/ back into
// this module closes an ESM cycle (inspectLock.ts value-imports parsePid from here). The cycle
// would very likely still RUN -- both sides are function declarations used only at call time -- so
// no behavioural test can be counted on to catch it. fileStore.ts:438 records the package already
// refusing to close such a cycle, duplicating two constants rather than importing back.
//
// *** ERRATUM (ls lock visibility, HUMAN RULING 132, fix round 1) -- the paragraph above is kept
// verbatim. The guard it originally implemented judged each SOURCE LINE independently ("does this
// line start with `import ` and mention `../unlock/`?"), which a wrapped/multi-line import defeats:
// the module specifier lands on a continuation line that does not itself start with `import `, so
// the line-based scan never sees it (external review, fix round 1). The guard below now joins each
// import into one STATEMENT -- from a line starting with `import` through that statement's
// terminating `;`, across as many source lines as it takes -- before judging it, so a wrapped
// import is judged the same as a one-line import. M1-4's mutation only exercised the single-line
// form the old guard could see; M1-5 below exercises the wrapped form this fix closes. ***
describe("fileStore module boundary", () => {
  // Every top-level `import ...;` statement in the given source, joined across line breaks so a
  // wrapped (multi-line) import reads as one string instead of several line fragments. Matched
  // from a line that starts with `import` through the next `;` -- how every import in this
  // codebase is written: top-level, one statement, terminated by a semicolon that never appears
  // mid-specifier.
  function importStatements(source: string): string[] {
    return Array.from(source.matchAll(/^import\b[\s\S]*?;/gm), (match) => match[0]);
  }

  it("joins a wrapped multi-line import into one statement, same as a single-line import", () => {
    // Anti-vacuity, and load-bearing: proves the joining regex actually spans a line break before
    // the real assertion below is trusted to rely on it. A joiner that silently stopped joining
    // would leave the real check vacuously green forever -- the failure mode named in the design
    // spec's §5.3 #1, applied to the very fix for a guard that missed exactly this.
    expect(importStatements('import {\n  foo,\n} from "../bar.js";\n')).toEqual([
      'import {\n  foo,\n} from "../bar.js";',
    ]);
    expect(importStatements('import { foo } from "../bar.js";\n')).toEqual(['import { foo } from "../bar.js";']);
  });

  it("never value-imports from src/unlock, which would close the cycle inspectLock opens", async () => {
    const source = await readFile(new URL("../../src/persistence/fileStore.ts", import.meta.url), "utf8");
    const statements = importStatements(source);

    // Must-not-catch sample, on the REAL file: fileStore.ts legitimately has a multi-line
    // (wrapped) type-only import from ../runtime/types.js. Naming it here proves the joined-
    // statement scan actually ran on this file's real wrapped import (not vacuously -- see the
    // anti-vacuity test above) and that joining a multi-line import does not, by itself, make the
    // guard fire on a directory that isn't src/unlock.
    expect(statements).toContain(
      'import type {\n  ExecutionRecovery,\n  OwnerRecord,\n  OwnerTransferRecord,\n  ReconciliationRecord,\n} from "../runtime/types.js";',
    );

    // The requirement.
    const valueImportsFromUnlock = statements.filter(
      (statement) => statement.includes("../unlock/") && !statement.trimStart().startsWith("import type "),
    );

    expect(valueImportsFromUnlock).toEqual([]);
  });
});
