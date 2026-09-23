import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Why a structure criterion and not a behavioural one: a value import from src/unlock/ back into
// this module closes an ESM cycle (inspectLock.ts value-imports parsePid from here). The cycle
// would very likely still RUN -- both sides are function declarations used only at call time -- so
// no behavioural test can be counted on to catch it. fileStore.ts:438 records the package already
// refusing to close such a cycle, duplicating two constants rather than importing back.
describe("fileStore module boundary", () => {
  it("never value-imports from src/unlock, which would close the cycle inspectLock opens", async () => {
    const source = await readFile(new URL("../../src/persistence/fileStore.ts", import.meta.url), "utf8");
    const importLines = source.split("\n").filter((line) => line.startsWith("import "));

    const valueImportsFromUnlock = importLines.filter(
      (line) => line.includes("../unlock/") && !line.startsWith("import type "),
    );

    expect(valueImportsFromUnlock).toEqual([]);
  });
});
