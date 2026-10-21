// Per-contract tool rules (ccloop spec 2026-10-22 §2, §8 T2): `executionPolicy.toolRules` is optional and strict at every
// level, every key required, no defaults; bounds are UTF-8 bytes. A contract that breaks any of them must be refused at
// accept (`control-request-invalid`) -- before any work -- because Orca's contractHash covers the rules and an agent run
// under a rule set ccloop did not understand would be run under a different boundary than the one the person declared.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlRequest, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { fixture } from "../control/optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function envelope(): Promise<LoopStartEnvelope> {
  const { root, envelope } = await fixture(); roots.push(root);
  return envelope;
}
const withRules = (base: LoopStartEnvelope, toolRules: unknown): unknown => ({
  ...base, work: { ...base.work, contract: { ...base.work.contract, executionPolicy: { ...base.work.contract.executionPolicy, toolRules } } },
});
const accepted = (value: unknown) => (parseControlRequest("accept", value) as LoopStartEnvelope).work.contract.executionPolicy as { toolRules?: unknown };
const refuses = (value: unknown) => expect(() => parseControlRequest("accept", value)).toThrow("control-request-invalid");
const rules = { commands: [{ kind: "exact", value: "npm test" }, { kind: "prefix", value: "npm run" }], network: false, secretEnv: ["NPM_TOKEN"] };

describe("executionPolicy.toolRules on the contract (spec §2)", () => {
  it("is accepted and kept exactly as sent: no key added, none dropped", async () => {
    const base = await envelope();
    expect(accepted(withRules(base, rules)).toolRules).toEqual(rules);
    const empty = { commands: [], network: true, secretEnv: [] };
    expect(accepted(withRules(base, empty)).toolRules).toEqual(empty);
  });

  it("refuses an unknown key at each level and a missing key", async () => {
    const base = await envelope();
    refuses(withRules(base, { ...rules, extra: 1 }));
    refuses(withRules(base, { ...rules, commands: [{ kind: "exact", value: "npm test", extra: 1 }] }));
    for (const key of ["commands", "network", "secretEnv"] as const) {
      const { [key]: _dropped, ...rest } = rules;
      refuses(withRules(base, rest));
    }
    refuses(withRules(base, { ...rules, commands: [{ kind: "exact" }] }));
    refuses(withRules(base, { ...rules, commands: [{ kind: "glob", value: "npm *" }] }));
  });

  it("bounds commands at 64 and secret names at 32", async () => {
    const base = await envelope();
    const commands = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "exact", value: `cmd-${i}` }));
    const names = (n: number) => Array.from({ length: n }, (_, i) => `NAME_${i}`);
    expect(accepted(withRules(base, { ...rules, commands: commands(64) })).toolRules).toBeDefined();
    refuses(withRules(base, { ...rules, commands: commands(65) }));
    expect(accepted(withRules(base, { ...rules, secretEnv: names(32) })).toolRules).toBeDefined();
    refuses(withRules(base, { ...rules, secretEnv: names(33) }));
  });

  it("bounds a value at 4096 UTF-8 bytes, not UTF-16 units (a 3-byte character ending at byte 4096)", async () => {
    const base = await envelope();
    const edge = `${"a".repeat(4093)}中`; // 4096 bytes, 4094 code units
    expect(Buffer.byteLength(edge)).toBe(4096);
    expect(accepted(withRules(base, { ...rules, commands: [{ kind: "exact", value: edge }] })).toolRules).toBeDefined();
    refuses(withRules(base, { ...rules, commands: [{ kind: "exact", value: `a${edge}` }] }));
    // 1366 three-byte characters: 4098 bytes in only 1366 code units -- a UTF-16 bound would let it through.
    refuses(withRules(base, { ...rules, commands: [{ kind: "prefix", value: "中".repeat(1366) }] }));
    refuses(withRules(base, { ...rules, commands: [{ kind: "exact", value: "" }] }));
  });

  it("refuses NUL in a value and a duplicate (kind, value); the same value under the other kind is not a duplicate", async () => {
    const base = await envelope();
    refuses(withRules(base, { ...rules, commands: [{ kind: "exact", value: "npm\u0000test" }] }));
    refuses(withRules(base, { ...rules, commands: [{ kind: "exact", value: "npm test" }, { kind: "exact", value: "npm test" }] }));
    expect(accepted(withRules(base, { ...rules, commands: [{ kind: "exact", value: "npm test" }, { kind: "prefix", value: "npm test" }] })).toolRules).toBeDefined();
  });

  it("refuses a bad secret name and a duplicate name; 128-character names are the limit", async () => {
    const base = await envelope();
    for (const bad of ["", "1ABC", "A-B", "A B", "A=B", `A${"B".repeat(128)}`]) refuses(withRules(base, { ...rules, secretEnv: [bad] }));
    refuses(withRules(base, { ...rules, secretEnv: ["NPM_TOKEN", "NPM_TOKEN"] }));
    expect(accepted(withRules(base, { ...rules, secretEnv: ["_x", `A${"B".repeat(127)}`] })).toolRules).toBeDefined();
  });

  it("refuses a non-boolean network", async () => {
    const base = await envelope();
    refuses(withRules(base, { ...rules, network: "false" }));
    refuses(withRules(base, { ...rules, network: null }));
  });
});
