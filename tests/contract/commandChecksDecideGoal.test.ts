import { describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { renderScenario } from "../../validation/v1/lib/scenarios.js";

const contract = () => renderScenario("A", { repoPath: "/tmp/ccloop-decisive-checks" });

describe("command checks that decide the task goal", () => {
  it("requires an explicit declaration for verification-only recovery", () => {
    const original = contract();
    expect(loopContractSchema.parse(original).verification).not.toHaveProperty("commandChecksDecideGoal");
    const optedIn = { ...original, verification: { ...original.verification, verifierType: "command", commandChecksDecideGoal: true } };
    expect(loopContractSchema.parse(optedIn).verification.commandChecksDecideGoal).toBe(true);
  });

  it("rejects a declaration when an agent verifier still decides the goal", () => {
    const original = contract();
    const claimed = { ...original, verification: { ...original.verification, commandChecksDecideGoal: true } };
    expect(loopContractSchema.safeParse(claimed).success).toBe(false);
  });

  it("rejects decisive checks with setup commands", () => {
    const original = contract();
    const claimed = { ...original, context: { ...original.context, setupCommands: ["true"] }, verification: { ...original.verification, verifierType: "command", commandChecksDecideGoal: true } };
    expect(loopContractSchema.safeParse(claimed).success).toBe(false);
  });
});
