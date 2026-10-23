// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.1, §16.1 C2, §19.2 P7): the contract's optional
// `repoKey` and `additionalRepos`. repoKey is present iff additionalRepos is; keys are unique and differ from repoKey;
// each extra repo has at least one target path; at most 7 extra repos (8 directories in all, Orca's member cap).
import { describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { RAW_CONTRACT } from "../fixtures/toolRules/argvCapture.js";

const extra = (key: string) => ({ key, repoPath: `/repos/${key}`, targetPaths: ["src/**"] });
const withRepos = (context: Record<string, unknown>) => ({ ...RAW_CONTRACT, context: { ...RAW_CONTRACT.context, ...context } });
const ok = (context: Record<string, unknown>) => loopContractSchema.safeParse(withRepos(context)).success;

describe("contract context.repoKey and context.additionalRepos (C2)", () => {
  it("accepts a valid multi-repo context and keeps it as given (optional fields stay absent)", () => {
    const context = { repoKey: "app", additionalRepos: [{ ...extra("lib"), allowlistPaths: ["src/**"], denylistPaths: [".env"], requiredChecks: ["test -f marker"] }, extra("docs")] };
    const parsed = loopContractSchema.parse(withRepos(context));
    expect(parsed.context.repoKey).toBe("app");
    expect(parsed.context.additionalRepos).toEqual(context.additionalRepos);
    expect(Object.keys(parsed.context.additionalRepos![1]!)).toEqual(["key", "repoPath", "targetPaths"]);
  });

  it("refuses each malformed context by name", () => {
    expect(ok({ repoKey: "app", additionalRepos: [extra("lib")] })).toBe(true);
    expect(ok({ repoKey: "app", additionalRepos: [extra("lib"), extra("lib")] })).toBe(false); // duplicate key
    expect(ok({ repoKey: "lib", additionalRepos: [extra("lib")] })).toBe(false); // key = repoKey
    expect(ok({ repoKey: "app" })).toBe(false); // repoKey without extra repos
    expect(ok({ additionalRepos: [extra("lib")] })).toBe(false); // extra repos without repoKey
    expect(ok({ repoKey: "app", additionalRepos: [] })).toBe(false); // empty list
    expect(ok({ repoKey: "app", additionalRepos: ["a", "b", "c", "d", "e", "f", "g"].map(extra) })).toBe(true); // 7
    expect(ok({ repoKey: "app", additionalRepos: ["a", "b", "c", "d", "e", "f", "g", "h"].map(extra) })).toBe(false); // 8
    expect(ok({ repoKey: "app", additionalRepos: [{ ...extra("lib"), targetPaths: [] }] })).toBe(false);
    expect(ok({ repoKey: "app", additionalRepos: [{ ...extra("lib"), unknown: true }] })).toBe(false);
    expect(ok({ repoKey: "App", additionalRepos: [extra("lib")] })).toBe(false); // key pattern
    expect(ok({ repoKey: "app", additionalRepos: [extra("lib/x")] })).toBe(false);
    expect(ok({ repoKey: "app", additionalRepos: [extra("lib-")] })).toBe(false);
  });
});
