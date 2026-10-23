// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.1, §16.1 C1): `context.repoKey` and
// `context.additionalRepos` are optional with no default, and so is `work.additionalRepos`. Orca hashes the contract and
// the envelope it sends and ccloop seals what it parsed, so a key added on parse (a default) would make every existing
// single-repo contract a different contract. The toolRules golden is the captured oracle for today's contract bytes.
import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { canonicalHash, canonicalJson, parseControlRequest } from "../../src/control/protocol.js";
import { RAW_CONTRACT } from "../fixtures/toolRules/argvCapture.js";
import { fixture } from "../control/optionalFixture.js";

const golden = new URL("../fixtures/toolRules/golden-2a2ae53/contract.json", import.meta.url);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("a single-repo contract and envelope without the multi-repo keys (C1)", () => {
  it("the golden contract parses to the golden bytes, and its context gains neither repoKey nor additionalRepos", async () => {
    const parsed = loopContractSchema.parse(structuredClone(RAW_CONTRACT));
    expect(`${canonicalJson(parsed)}\n`).toBe(await readFile(golden, "utf8"));
    expect(Object.keys(parsed.context)).not.toContain("repoKey");
    expect(Object.keys(parsed.context)).not.toContain("additionalRepos");
  });

  it("a protocol-4 envelope without work.additionalRepos parses to its own canonical hash and gains no key", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const v4 = { ...envelope, protocol: 4 as const };
    const parsed = parseControlRequest("accept", v4) as unknown as { work: Record<string, unknown> & { contract: { context: object } } };
    expect(canonicalHash(parsed)).toBe(canonicalHash(v4));
    expect(Object.keys(parsed.work)).not.toContain("additionalRepos");
    expect(Object.keys(parsed.work.contract.context)).not.toContain("additionalRepos");
    // Protocol 3 too: the legacy loop-work schema gains the same optional key.
    expect(canonicalHash(parseControlRequest("accept", envelope))).toBe(canonicalHash(envelope));
  });
});
