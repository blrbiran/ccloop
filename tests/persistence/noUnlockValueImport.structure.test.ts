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
//
// *** ERRATUM (ls lock visibility, HUMAN RULING 132, fix round 2) -- the erratum above is kept
// verbatim; the statement-joining fix it describes was itself incomplete. The joiner matched
// through the FIRST `;` after `import`, with no awareness of comments -- so a semicolon inside a
// trailing `//` comment on a continuation line (e.g. `foo, // TODO: remove this; temporary`)
// terminated the match early, truncating the statement before the real `from "../unlock/..."`
// clause and evading the guard again (external review, fix round 2, independently reproduced by
// the controller). The source is now stripped of `//` and `/* */` comments -- respecting string
// literals, so a module specifier is never mistaken for a comment -- BEFORE statements are joined.
// M1-6 below exercises the comment-semicolon form this fix closes; M1-4 and M1-5 were re-verified
// to still catch after this change. ***
describe("fileStore module boundary", () => {
  // Removes `//line` and `/* block */` comments from TypeScript source text, without disturbing
  // string or template-literal contents (so a module specifier is never misread as a comment, and
  // a comment inside a string -- not that any import specifier here has one -- would not be
  // stripped either). Line comments are removed up to but NOT including their trailing newline, so
  // line boundaries are preserved for the `^import` anchor below; block comments are removed
  // wholesale, including any newlines inside them.
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

  // Every top-level `import ...;` statement in the given source, joined across line breaks so a
  // wrapped (multi-line) import reads as one string instead of several line fragments. Comments
  // are stripped first (see stripComments) so a `;` inside a trailing comment cannot be mistaken
  // for the statement's real terminator. Matched from a line that starts with `import` through the
  // next `;` -- how every import in this codebase is written: top-level, one statement, terminated
  // by a semicolon that never appears mid-specifier once comments are gone.
  //
  // Not done: requiring the terminating `;` to be followed by end-of-line/EOF. Considered and
  // rejected (fix round 2) -- once comments are stripped, the first `;` after `import` in this
  // codebase's style IS the real terminator (specifiers are plain relative/package paths with no
  // embedded `;`, and no import here shares a line with anything after its own `;`). Requiring
  // end-of-line would add a constraint with no real evasion left to close, at the cost of a false
  // negative the day an import statement is followed on the same line by something else legal
  // (e.g. two statements on one line) -- a form this codebase does not use today but the guard has
  // no reason to become brittle against.
  function importStatements(source: string): string[] {
    return Array.from(stripComments(source).matchAll(/^import\b[\s\S]*?;/gm), (match) => match[0]);
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

  it("does not let a semicolon inside a trailing comment truncate the statement early", () => {
    // The exact evasion fix round 2 found: a `//` comment on a continuation line contains a `;`
    // before the real `from "..."` clause. Without comment stripping, the old joiner stopped at
    // that comment's `;` and never saw the module specifier at all.
    const source = 'import {\n  foo, // TODO: remove this; temporary\n} from "../bar.js";\nvoid foo;\n';
    expect(importStatements(source)).toEqual(['import {\n  foo, \n} from "../bar.js";']);
  });

  it("does not flag a comment that only MENTIONS ../unlock/ with no real import present", () => {
    // The flip side of the same rule: a scanner that fires on its own warning text, or on a
    // comment discussing the forbidden path, is exactly as broken as one that misses a real
    // import. This file's own header comments say "../unlock/" and "src/unlock" repeatedly and
    // must never be mistaken for an import themselves.
    const source = '// never import from ../unlock/ here; it would close the cycle\nexport const x = 1;\n';
    expect(importStatements(source)).toEqual([]);
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
