import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readSavedResultEligibility } from "../../src/control/savedResultRecovery.js";
import { executeWireJsonSchema } from "../../src/runtime/codex/protocol.js";
import { savedRecoveryFixture } from "./savedRecoveryFixture.js";

const isolation = ["-c", "notify=[]", "-c", "features.plugins=false", "-c", "include_apps_instructions=false",
  "-c", "include_collaboration_mode_instructions=false", "-c", "features.hooks=false",
  "-c", 'shell_environment_policy.set.HOME="/private/tmp/fixture-real-home"'];

async function withPhaseIsolation(extra: string[] = [], modernSchema = false, withCatalog = false) {
  const f = await savedRecoveryFixture();
  for (const entry of f.archive.logs) {
    if (modernSchema && entry.kind === "file" && /^run\/codex\/1\/execute\/call-[^/]+\/schema\.json$/.test(entry.path)) {
      entry.ref = await f.put({ type: "object", properties: { result: executeWireJsonSchema() }, required: ["result"], additionalProperties: false });
      continue;
    }
    if (entry.kind !== "file" || !/^run\/codex\/1\/(plan|execute)\/call-[^/]+\/outcome\.json$/.test(entry.path)) continue;
    const outcome = f.log(entry.path);
    expect(outcome.args.at(-1)).toBe("-");
    const phaseArgs = withCatalog
      ? [...isolation.slice(0, -2), "-c", "mcp_servers.docs.enabled=false", ...isolation.slice(-2), "-c", 'model_catalog_json="/private/tmp/fixture-catalog.json"']
      : isolation;
    outcome.args = [...outcome.args.slice(0, -1), ...phaseArgs, ...extra, "-"];
    outcome.isolation = { home: "/private/tmp/fixture-isolated-home", codexHome: "/private/tmp/fixture-isolated-home/.codex", catalogError: null };
    entry.ref = await f.put(outcome);
  }
  f.manifest.source = await f.put(f.archive);
  f.admission.recoveryOf.capsuleHash = f.manifest.source.hash;
  f.input.savedResultRecovery!.recoveryOf.capsuleHash = f.manifest.source.hash;
  await f.seal();
  return f;
}

describe("saved result recovery of a phase-isolated Codex run", () => {
  it("accepts the fixed isolation arguments recorded by the real phase runner", async () => {
    const f = await withPhaseIsolation();
    try { expect(await readSavedResultEligibility(f.input)).toMatchObject({ status: "eligible" }); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("accepts the execute wire schema the current phase runner writes", async () => {
    const f = await withPhaseIsolation([], true);
    try { expect(await readSavedResultEligibility(f.input)).toMatchObject({ status: "eligible" }); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("accepts bounded MCP disable and resolved model catalog flags", async () => {
    const f = await withPhaseIsolation([], true, true);
    try { expect(await readSavedResultEligibility(f.input)).toMatchObject({ status: "eligible" }); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("refuses an extra arbitrary configuration flag", async () => {
    const f = await withPhaseIsolation(["-c", 'model="other"']);
    try { expect(await readSavedResultEligibility(f.input)).toEqual({ status: "unavailable", reason: "saved-result-config-mismatch" }); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
