// Task handoffs (Orca spec 2026-11-12 tester follow-up G §10.2, Part 4): Orca hands each loop run two directories it owns,
// outside every worktree -- one the agent reads its predecessors' handoffs from, one it writes its own into. They ride on
// the start envelope's `work.handoff`, optional so every envelope Orca sends today parses and hashes exactly as before. At
// accept ccloop checks they are real, separate directories outside the run's source directory and repositories, so an
// agent's handoff can never land in (or be read from) a tree ccloop publishes. A saved-result recovery builds no prompt,
// so it takes none.
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash, parseControlRequest, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function dir(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

/** The fixture envelope with its repository and target moved out of the source directory, so each "inside" case is alone. */
async function world(): Promise<{ envelope: LoopStartEnvelope; source: string; repo: string; target: string; inputDir: string; outputDir: string }> {
  const { root, envelope } = await fixture();
  roots.push(root);
  const repo = await dir("handoff-repo-");
  const target = await dir("handoff-target-");
  const outside = await dir("handoff-dirs-");
  const inputDir = join(outside, "in");
  const outputDir = join(outside, "out");
  await mkdir(inputDir);
  await mkdir(outputDir);
  const moved = structuredClone(envelope);
  moved.work.contract.context.repoPath = repo;
  moved.work.targetRepo = target;
  return { envelope: moved, source: root, repo, target, inputDir, outputDir };
}

const withHandoff = (envelope: LoopStartEnvelope, handoff: unknown): LoopStartEnvelope => ({ ...envelope, work: { ...envelope.work, handoff } as never });

describe("work.handoff on the start envelope", () => {
  it("absent: parses without the key and hashes as the envelope itself", async () => {
    const { envelope } = await world();
    const parsed = parseControlRequest("accept", envelope);
    expect(Object.keys(parsed.work)).not.toContain("handoff");
    expect(canonicalHash(parsed)).toBe(canonicalHash(envelope));
  });

  it("present: kept byte for byte on protocol 3 and 4", async () => {
    const { envelope, inputDir, outputDir } = await world();
    const v3 = withHandoff(envelope, { inputDir, outputDir });
    expect(parseControlRequest("accept", v3)).toEqual(v3);
    const v4 = { ...v3, protocol: 4 as const };
    expect(parseControlRequest("accept", v4)).toEqual(v4);
  });

  it("refuses at accept: relative, non-canonical, missing, equal, nested, inside the source, repository or target, extra key", async () => {
    const { envelope, source, repo, target, inputDir, outputDir } = await world();
    const linked = join(await dir("handoff-link-"), "in");
    await symlink(inputDir, linked);
    const inside = async (parent: string): Promise<string> => { const path = join(parent, "handoff-out"); await mkdir(path); return path; };
    const nested = join(inputDir, "nested");
    await mkdir(nested);
    const cases: Record<string, unknown> = {
      relative: { inputDir: "in", outputDir },
      symlinked: { inputDir: linked, outputDir },
      missing: { inputDir, outputDir: join(outputDir, "absent") },
      equal: { inputDir, outputDir: inputDir },
      nested: { inputDir, outputDir: nested },
      insideSource: { inputDir, outputDir: await inside(source) },
      insideRepo: { inputDir, outputDir: await inside(repo) },
      insideTarget: { inputDir, outputDir: await inside(target) },
      extraKey: { inputDir, outputDir, extra: true },
    };
    for (const [name, handoff] of Object.entries(cases)) {
      expect(() => parseControlRequest("accept", withHandoff(envelope, handoff)), name).toThrow("control-request-invalid");
    }
  });

  it("at collect only absoluteness is checked: a removed outputDir still parses", async () => {
    const { envelope, inputDir, outputDir } = await world();
    const sent = withHandoff(envelope, { inputDir, outputDir });
    await rm(outputDir, { recursive: true });
    expect(() => parseControlRequest("collect", { input: sent, afterSeq: 0 })).not.toThrow();
    expect(() => parseControlRequest("collect", { input: withHandoff(envelope, { inputDir: "in", outputDir }), afterSeq: 0 })).toThrow("control-request-invalid");
  });

  it("is refused beside mode verify-saved-result, which builds no prompt", async () => {
    const { envelope, inputDir, outputDir } = await world();
    const base = structuredClone(envelope);
    base.work.contract.executionPolicy.tokenBudget = null;
    const recovery = { ...base, protocol: 4 as const, mode: "verify-saved-result" as const,
      claim: { ...base.claim, grant: { ...base.claim.grant, work: { ...base.claim.grant.work, tokens: null } } },
      savedResultRecovery: { packagePath: join(inputDir, "package"), packageHash: "d".repeat(64), admissionHash: "e".repeat(64),
        recoveryOf: { sourceRunId: "run-0", sourceAttempt: 1, capsuleHash: "f".repeat(64), snapshotHash: "a".repeat(64), normalizedExecutionHash: "b".repeat(64) } } };
    expect(parseControlRequest("accept", recovery)).toEqual(recovery);
    expect(() => parseControlRequest("accept", withHandoff(recovery as never, { inputDir, outputDir }))).toThrow("control-request-invalid");
  });
});
