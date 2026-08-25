import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const fileStoreSourcePath = fileURLToPath(new URL("../../src/persistence/fileStore.ts", import.meta.url));

// Parsed with the TypeScript compiler, NOT matched with a regex, for the same reason
// tests/controller/ownedRunStateWriter.structure.test.ts gives: a regex over source text loses to
// ordinary rewrites (a deleted space, a line wrap, a comment that happens to contain the string),
// and a probe that can be beaten by formatting is not evidence. `typescript` is already a
// devDependency and tsconfig.json already compiles this directory, so this costs no new toolchain.
function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("fileStore.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

type ReadSite = { argument: string; enclosingFunction: string };

// Every `readFile(<first argument>, …)` call, paired with the name of the function declaration it
// sits inside. The first argument is reported as written — an identifier by its name, anything
// else by its source text — because the claim under test is about ONE identifier, `lockPath`.
function readFileCallSites(source: string): ReadSite[] {
  const sites: ReadSite[] = [];

  const walk = (node: ts.Node, enclosingFunction: string): void => {
    const scope = ts.isFunctionDeclaration(node) && node.name !== undefined ? node.name.text : enclosingFunction;

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "readFile" &&
      node.arguments.length > 0
    ) {
      const first = node.arguments[0];
      sites.push({
        argument: ts.isIdentifier(first) ? first.text : first.getText(),
        enclosingFunction: scope,
      });
    }

    ts.forEachChild(node, (child) => walk(child, scope));
  };

  walk(parse(source), "<module>");

  return sites;
}

// Mi-3 of the Minors-round review, HUMAN RULING 105. A PURE ADDITION under human ruling 4: a new
// file, no existing criterion touched, so no naming under ruling 88 was owed.
//
// WHY THIS EXISTS. `observes that the redline function actually ran on the strong-holder fixture`
// (tests/persistence/fileStore.test.ts) counts reads of the lock path and treats a non-zero count
// as proof that tryRecoverStaleOwnerTransferLock was entered. That inference is only sound while
// the lock path has exactly ONE reader in fileStore.ts, and that premise was stated in a comment
// with nothing enforcing it — which is this package's signature defect, applied to the very fix
// for it. An independent reviewer named it. Here the premise is the thing under test.
//
// Constructible scenario it closes: someone adds a diagnostic re-read of the lock, or a pre-check
// in acquireOwnerTransferLock, or a retry that re-reads before deciding. `lockReads` then rises
// for a reason that has nothing to do with entering the redline function, the counting test stays
// green, and it has quietly stopped observing what it was added to observe. This goes red instead.
describe("the owner-transfer lock has exactly one reader inside fileStore.ts", () => {
  it("reads the lock path only inside tryRecoverStaleOwnerTransferLock, so a read of it means that function ran", async () => {
    const source = await readFile(fileStoreSourcePath, "utf8");
    const sites = readFileCallSites(source);
    const args = sites.map((site) => site.argument);

    // Anti-vacuity, and load-bearing: a walk that silently stopped producing sites would make the
    // real assertion below pass forever while proving nothing — the failure mode this repository
    // keeps hitting, where a broken probe is mistaken for evidence of absence. A must-hit on a
    // literal the walk must see, and a must-hit on a DIFFERENT read in the module under test, so
    // that "no lockPath reads found" cannot be confused with "no reads found at all".
    expect(readFileCallSites('await readFile(somePath, "utf8");').map((site) => site.argument)).toEqual(["somePath"]);
    expect(args).toContain("paths.transactionMarkerPath");

    // The requirement.
    const lockReads = sites.filter((site) => site.argument === "lockPath");

    expect(lockReads).toHaveLength(1);
    expect(lockReads[0].enclosingFunction).toBe("tryRecoverStaleOwnerTransferLock");

    // What this does NOT catch, stated because overstating it would recreate the defect the test
    // exists to fix. All three are open and known:
    //   - a read whose first argument is not the identifier `lockPath` — `join(runDir, …)` spelled
    //     out again, or an alias assigned from it;
    //   - a read through another API: `open` plus `read`, `readFileSync`, or a stream;
    //   - a read of the lock path from ANOTHER module. src/unlock/inspectLock.ts deliberately has
    //     one (human ruling 70 board C-d); it is out of this file's scope and out of the counting
    //     test's, which observes reads made during readOwnerRecord.
  });
});
