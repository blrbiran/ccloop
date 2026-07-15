import { describe, expect, it } from "vitest";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";

describe("ScriptedAdapter", () => {
  it("returns the next scripted plan, execution result, and verification result", async () => {
    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: {
          changedFiles: ["src/index.ts"],
          diffPatch: "diff --git a/src/index.ts b/src/index.ts",
          commandOutputs: ["edited"],
          stdoutStderrLog: "ok",
        },
        verification: {
          approved: true,
          rejectCategory: "",
          primaryTargetPaths: ["src/index.ts"],
          failingCommand: null,
          safeToRetry: false,
          evidence: ["npm test passed"],
        },
      },
    ]);

    const plan = await adapter.plan();
    const execution = await adapter.execute();
    const verification = await adapter.verify();

    expect(plan.summary).toBe("change src/index.ts");
    expect(execution.changedFiles).toEqual(["src/index.ts"]);
    expect(verification.approved).toBe(true);
  });
});
