// Live token ceiling (Orca tester follow-up G part 2; spec docs/superpowers/specs/2026-11-12-live-ceiling-design.md): Orca
// bounds a run in a finite group by the group's remainder, which changes while the run runs, so it must be able to raise a
// running run's ceiling without restarting it. The ceiling is opt-in through the protocol-4 envelope (`liveCeiling`), and
// Orca updates it only through the `live-ceiling` control method, which ccloop answers by writing the run's own control file
// (0600, strictly increasing revisions, so a delayed older write can never lower a raise already delivered).
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runControlCommand } from "../../src/control/command.js";
import { liveCeilingPath } from "../../src/control/liveCeilingFile.js";
import { canonicalHash, canonicalJson, parseControlRequest, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const CEILING = { protocol: 1 as const, revision: 1, tokens: 1_000, cause: "group" as const };

/** A protocol-4 loop envelope with a null work token grant; `liveCeiling` only when asked. */
async function v4(withCeiling: boolean): Promise<{ root: string; envelope: LoopStartEnvelope }> {
  const { root, envelope } = await fixture();
  roots.push(root);
  const base = structuredClone(envelope);
  base.protocol = 4;
  base.work.contract.executionPolicy.tokenBudget = null;
  base.claim.grant.work = { ...base.claim.grant.work, tokens: null };
  return { root, envelope: withCeiling ? { ...base, liveCeiling: CEILING } : base };
}

async function accept(root: string, envelope: LoopStartEnvelope): Promise<void> {
  await writeAccepted(root, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
}

function call(root: string, envelope: LoopStartEnvelope, ceiling: unknown) {
  return runControlCommand(["live-ceiling", "--agents", join(root, "absent-agents.json")], JSON.stringify({ input: envelope, ceiling }));
}

describe("the live-ceiling control method", () => {
  it("writes the ceiling with mode 0600 and answers its revision", async () => {
    const { root, envelope } = await v4(true);
    await accept(root, envelope);
    const ceiling = { protocol: 1, revision: 2, tokens: 5_000, cause: "group" };
    const result = await call(root, envelope, ceiling);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ revision: 2, tokens: 5_000 });
    expect(JSON.parse(await readFile(liveCeilingPath(root), "utf8"))).toEqual(ceiling);
    expect((await stat(liveCeilingPath(root))).mode & 0o777).toBe(0o600);
  });

  it("refuses a revision that is not newer, and leaves the stored ceiling as it was", async () => {
    const { root, envelope } = await v4(true);
    await accept(root, envelope);
    expect((await call(root, envelope, { protocol: 1, revision: 2, tokens: 5_000, cause: "group" })).code).toBe(0);
    const before = await readFile(liveCeilingPath(root));
    for (const revision of [2, 1]) {
      const refused = await call(root, envelope, { protocol: 1, revision, tokens: 9_000, cause: "pause-line" });
      expect(refused.code).toBe(2);
      expect(refused.stderr).toBe("control-live-ceiling-stale\n");
    }
    expect(await readFile(liveCeilingPath(root))).toEqual(before);
  });

  it("refuses before the run is accepted, and for an envelope other than the accepted one", async () => {
    const { root, envelope } = await v4(true);
    const early = await call(root, envelope, { ...CEILING, revision: 2 });
    expect(early.stderr).toBe("control-live-ceiling-not-accepted\n");
    await accept(root, envelope);
    const other = { ...envelope, liveCeiling: { ...CEILING, tokens: 2_000 } };
    const conflict = await call(root, other, { ...CEILING, revision: 2 });
    expect(conflict.stderr).toBe("control-envelope-conflict\n");
    await expect(stat(liveCeilingPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses live-ceiling for a run started without one", async () => {
    const { root, envelope } = await v4(false);
    await accept(root, envelope);
    const refused = await call(root, envelope, { ...CEILING, revision: 2 });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toBe("control-live-ceiling-unsupported\n");
  });

  it("refuses a malformed ceiling at the request boundary", async () => {
    const { root, envelope } = await v4(true);
    await accept(root, envelope);
    for (const ceiling of [{ ...CEILING, revision: 0 }, { ...CEILING, cause: "other" }, { ...CEILING, tokens: -1 }, { ...CEILING, extra: true }]) {
      expect((await call(root, envelope, ceiling)).stderr).toBe("control-request-invalid\n");
    }
  });
});

describe("liveCeiling on the start envelope", () => {
  it("refuses an envelope that carries both a finite work grant and a live ceiling", async () => {
    const { envelope } = await v4(true);
    expect(parseControlRequest("accept", envelope)).toEqual(envelope);
    const finite = { ...envelope, claim: { ...envelope.claim, grant: { ...envelope.claim.grant, work: { ...envelope.claim.grant.work, tokens: 10 } } } };
    expect(() => parseControlRequest("accept", finite)).toThrow("control-request-invalid");
  });

  it("is refused on a protocol-3 envelope", async () => {
    const { envelope } = await fixture();
    roots.push(envelope.work.sourceDir);
    expect(() => parseControlRequest("accept", { ...envelope, liveCeiling: CEILING })).toThrow("control-request-invalid");
  });

  it("an envelope without liveCeiling parses and hashes exactly as before", async () => {
    const { envelope } = await v4(false);
    const parsed = parseControlRequest("accept", envelope);
    expect(Object.keys(parsed)).not.toContain("liveCeiling");
    expect(canonicalJson(parsed)).toBe(canonicalJson(envelope));
  });
});
