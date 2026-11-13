import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalHash } from "../../src/control/protocol.js";
import { readSavedResultEligibility } from "../../src/control/savedResultRecovery.js";
import { savedRecoveryFixture } from "./savedRecoveryFixture.js";

// Orca tester follow-up I (V11/O19 regression): since ccloop afb9a51 every Orca task run carries work.handoff, so the codex
// execute argv gains `--add-dir <outputDir>` right after `-C <worktree>`. A saved result of such a run must stay eligible:
// the validator expects exactly the handoff arguments the source envelope named -- no more, no fewer, no other directory.
const named = { inputDir: "/private/tmp/fixture-handoff/in", outputDir: "/private/tmp/fixture-handoff/out" };

/** The genuine legacy fixture, its source envelope given `handoff` and its execute call's argv given `recorded` after -C. */
async function withHandoff(handoff: typeof named | undefined, recorded: string[]) {
  const f = await savedRecoveryFixture();
  const source = handoff === undefined ? f.source : { ...f.source, work: { ...f.source.work, handoff } };
  for (const entry of f.archive.logs) {
    if (entry.kind !== "file") continue;
    if (entry.path === "control/envelope.json") entry.ref = await f.put(source);
    else if (entry.path === "control/accepted.json") entry.ref = await f.put({ ...f.log(entry.path), envelopeHash: canonicalHash(source) });
    else if (/^run\/codex\/1\/execute\/call-[^/]+\/outcome\.json$/.test(entry.path)) {
      const outcome = f.log(entry.path), at = outcome.args.indexOf("-C") + 2;
      expect(outcome.args[at]).toBe("--output-schema");
      outcome.args = [...outcome.args.slice(0, at), ...recorded, ...outcome.args.slice(at)];
      entry.ref = await f.put(outcome);
    }
  }
  f.manifest.source = await f.put(f.archive);
  f.admission.source.envelopeHash = canonicalHash(source);
  f.admission.recoveryOf.capsuleHash = f.manifest.source.hash;
  f.input.savedResultRecovery!.recoveryOf.capsuleHash = f.manifest.source.hash;
  await f.seal();
  return f;
}

describe("saved result recovery of a Codex run that had handoff directories", () => {
  it("accepts the execute --add-dir of the output directory the source envelope named", async () => {
    const f = await withHandoff(named, ["--add-dir", named.outputDir]);
    try { expect(await readSavedResultEligibility(f.input)).toMatchObject({ status: "eligible" }); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30000);

  it("refuses a handoff --add-dir naming a directory other than the envelope's", async () => {
    const f = await withHandoff(named, ["--add-dir", "/private/tmp/fixture-handoff/elsewhere"]);
    try { expect(await readSavedResultEligibility(f.input)).toEqual({ status: "unavailable", reason: "saved-result-config-mismatch" }); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30000);

  it("refuses the envelope's handoff directories when the run recorded none", async () => {
    const f = await withHandoff(named, []);
    try { expect(await readSavedResultEligibility(f.input)).toEqual({ status: "unavailable", reason: "saved-result-config-mismatch" }); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30000);

  it("refuses an --add-dir that no envelope handoff named", async () => {
    const f = await withHandoff(undefined, ["--add-dir", named.outputDir]);
    try { expect(await readSavedResultEligibility(f.input)).toEqual({ status: "unavailable", reason: "saved-result-config-mismatch" }); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30000);
});
