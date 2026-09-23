import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Mirrors tests/persistence/noUnlockValueImport.structure.test.ts's stripComments/importStatements
// approach (that file survived three fix rounds against wrapped imports and comment-embedded
// semicolons -- see its own erratum history). Why a structure criterion and not a behavioural one:
// a value import from src/unlock/ back into src/registry/renderRuns.ts would not necessarily fail
// any existing test -- both sides are plain function/type declarations, so nothing here is
// guaranteed to throw at import time. Only a criterion that reads the source text and classifies
// each import statement can tell a type-only import (erased at compile time, safe) from a value
// import (dragged into every runtime consumer of this module, including sweep -- see
// renderRuns.ts's own comment on this, corrected in the final fix wave of this round: the risk is
// NOT a cycle, it is sweep's runtime graph picking up the lock inspector it deliberately never
// probes).
describe("renderRuns module boundary", () => {
  // Copied verbatim from tests/persistence/noUnlockValueImport.structure.test.ts rather than
  // imported from it -- this repository's own precedent (fileStore.ts:438, RECONCILIATION_LOCK_
  // RETRY_*) is to duplicate a small, load-bearing piece rather than let two independent module-
  // boundary guards depend on each other's internals.
  function stripComments(source: string): string {
    let result = "";
    let i = 0;
    const n = source.length;
    while (i < n) {
      const ch = source[i];
      const two = source.slice(i, i + 2);
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < n && source[j] !== ch) {
          j += source[j] === "\\" ? 2 : 1;
        }
        j = Math.min(j + 1, n);
        result += source.slice(i, j);
        i = j;
        continue;
      }
      if (two === "//") {
        const end = source.indexOf("\n", i);
        i = end === -1 ? n : end;
        continue;
      }
      if (two === "/*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      result += ch;
      i += 1;
    }
    return result;
  }

  function importStatements(source: string): string[] {
    return Array.from(stripComments(source).matchAll(/^import\b[\s\S]*?;/gm), (match) => match[0]);
  }

  function valueImportsFromUnlock(statements: string[]): string[] {
    return statements.filter(
      (statement) => statement.includes("../unlock/") && !statement.trimStart().startsWith("import type "),
    );
  }

  // Must-catch sample: a WRAPPED (multi-line) value import from src/unlock/, the exact evasion
  // fix rounds 1-3 of the sibling fileStore guard were built to close. Proves the joiner/filter
  // combination used below actually flags this shape before the real-file test below is trusted
  // to rely on it (design spec §5.3 #1: a new branch must be shown catching its own deletion, and
  // this is the criterion-logic half of that -- the file-mutation half is run separately in a
  // disposable clone and recorded in the round's fix report).
  it("flags a wrapped value import from src/unlock/", () => {
    const source = 'import {\n  inspectOwnerTransferLock,\n} from "../unlock/inspectLock.js";\n';
    expect(valueImportsFromUnlock(importStatements(source))).toEqual([
      'import {\n  inspectOwnerTransferLock,\n} from "../unlock/inspectLock.js";',
    ]);
  });

  // Must-not-catch sample: a type-only import from src/unlock/ sitting right next to a VALUE
  // import from somewhere else entirely. Neither half may fire -- the type-only import is exactly
  // what this module is allowed to do, and a value import from an unrelated module must not be
  // mistaken for one from src/unlock/.
  it("does not fire on a type-only import from src/unlock/ next to a value import from elsewhere", () => {
    const source =
      'import type { LockInspection } from "../unlock/inspectLock.js";\n' +
      'import { scanRuns } from "./scanRuns.js";\n';
    expect(valueImportsFromUnlock(importStatements(source))).toEqual([]);
  });

  it("never value-imports from src/unlock, which would drag the lock inspector into sweep's runtime graph", async () => {
    const source = await readFile(new URL("../../src/registry/renderRuns.ts", import.meta.url), "utf8");
    const statements = importStatements(source);

    // Must-not-catch sample, on the REAL file: renderRuns.ts's actual type-only imports from
    // src/unlock/ (LockInspection, and ReportedRunRow/ReportedScanRow from lockRows.js). Naming
    // them proves the scan actually ran over this file's real imports, not vacuously.
    expect(statements).toContain('import type { LockInspection } from "../unlock/inspectLock.js";');
    expect(statements).toContain(
      'import type { ReportedRunRow, ReportedScanRow } from "../unlock/lockRows.js";',
    );

    // The requirement.
    expect(valueImportsFromUnlock(statements)).toEqual([]);
  });
});
