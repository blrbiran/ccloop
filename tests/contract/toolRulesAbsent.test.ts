// Per-contract tool rules (ccloop spec 2026-10-22 §2 "Absent ⇒ identical", §8 T1, contract part): a contract without
// `toolRules` must parse to exactly the bytes 2a2ae53 produced. Orca hashes the contract it sends and ccloop seals what it
// parsed; a key added on parse (a default) would make every existing contract a different contract.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { canonicalJson } from "../../src/control/protocol.js";
import { RAW_CONTRACT } from "../fixtures/toolRules/argvCapture.js";

const golden = new URL("../fixtures/toolRules/golden-2a2ae53/contract.json", import.meta.url);

describe("a contract without toolRules (spec §2, T1)", () => {
  it("parses to the canonical bytes captured from 2a2ae53", async () => {
    const parsed = loopContractSchema.parse(structuredClone(RAW_CONTRACT));
    expect(`${canonicalJson(parsed)}\n`).toBe(await readFile(golden, "utf8"));
    expect(Object.keys(parsed.executionPolicy)).not.toContain("toolRules");
  });
});
