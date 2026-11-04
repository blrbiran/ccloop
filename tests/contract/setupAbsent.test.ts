// Task setup commands (ccloop plan 2026-11-04, Task 1): `context.setupCommands` is optional with no default, so a contract
// without it must keep parsing to the bytes 2a2ae53 produced -- Orca hashes the contract it sends and ccloop seals what it
// parsed; a default added on parse would make every existing contract a different contract.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { canonicalJson } from "../../src/control/protocol.js";
import { RAW_CONTRACT } from "../fixtures/toolRules/argvCapture.js";

const golden = new URL("../fixtures/toolRules/golden-2a2ae53/contract.json", import.meta.url);
const withSetup = (setupCommands: unknown) => {
  const raw = structuredClone(RAW_CONTRACT) as { context: Record<string, unknown> };
  raw.context.setupCommands = setupCommands;
  return raw;
};

describe("context.setupCommands", () => {
  it("a contract without setupCommands parses to the committed golden bytes", async () => {
    const parsed = loopContractSchema.parse(structuredClone(RAW_CONTRACT));
    expect(`${canonicalJson(parsed)}\n`).toBe(await readFile(golden, "utf8"));
    expect("setupCommands" in parsed.context).toBe(false);
  });

  it("setupCommands is kept as given and bounded", () => {
    expect(loopContractSchema.parse(withSetup(["npm ci"])).context.setupCommands).toEqual(["npm ci"]);
    expect(loopContractSchema.parse(withSetup(Array.from({ length: 8 }, () => "x"))).context.setupCommands).toHaveLength(8);
    for (const bad of [[], Array.from({ length: 9 }, () => "x"), ["a\nb"], ["a\rb"], [""], ["x".repeat(4097)]]) {
      expect(() => loopContractSchema.parse(withSetup(bad))).toThrow();
    }
  });

  // Final-review M5: setup runs only in the primary worktree; a multi-repo contract with setup would hand the agent its
  // other repositories unprepared, so the combination is refused at parse.
  it("setupCommands together with additionalRepos is refused", () => {
    const multi = (setupCommands: string[] | undefined) => {
      const raw = withSetup(setupCommands) as { context: Record<string, unknown> };
      if (setupCommands === undefined) delete raw.context.setupCommands;
      raw.context.repoKey = "app";
      raw.context.additionalRepos = [{ key: "lib", repoPath: "/tmp/lib", targetPaths: ["src"] }];
      return raw;
    };
    expect(loopContractSchema.safeParse(multi(undefined)).success).toBe(true);
    const refused = loopContractSchema.safeParse(multi(["npm ci"]));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual(["setup-commands-with-additional-repos"]);
  });
});
