import { describe, expect, it } from "vitest";
import { evaluatePathPolicy } from "../../src/policy/pathPolicy.js";

describe("evaluatePathPolicy", () => {
  it("blocks denylisted paths even if allowlisted broadly", () => {
    expect(
      evaluatePathPolicy({
        changedFiles: ["src/auth/token.ts"],
        allowlistPaths: ["src/**"],
        denylistPaths: ["src/auth/**"],
        maxFilesTouched: 10,
      }),
    ).toEqual({
      allowed: false,
      humanGateHit: true,
      reason: "denylist match: src/auth/token.ts",
    });
  });

  it("blocks when changed file count exceeds the limit", () => {
    expect(
      evaluatePathPolicy({
        changedFiles: ["a.ts", "b.ts", "c.ts"],
        allowlistPaths: [],
        denylistPaths: [],
        maxFilesTouched: 2,
      }).humanGateHit,
    ).toBe(true);
  });
});
