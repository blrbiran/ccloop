import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { draftCommandForCandidate, draftInstallationForCandidate, findAgentCandidatePaths } from "./detect.js";
import { probeVersion } from "./materialize.js";
import { readAgentCatalog } from "./agentCatalog.js";
import { assertAgentsTableLocation, parseAgentsTable, readAgentsTableSnapshot } from "./table.js";
import { AgentError, type AgentsTableV1, type InstallationV1 } from "./types.js";
import { assertUpdatesRoot, cleanupOperationTemporary, readOwnedJson, replaceTableDurably, sha256, withTableUpdateLock, writeOwnedJson } from "./updateReceipt.js";
import { testCrashPoint } from "../control/testCrashPoint.js";
import { homedir } from "node:os";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function fail(detail: string): never { throw new AgentError("agent-installation-update-invalid", detail); }
function conflict(detail: string): never { throw new AgentError("agent-installation-update-conflict", detail); }
function stale(): never { throw new AgentError("agent-installation-update-stale"); }

export interface InstalledObservation {
  id: string;
  kind: string;
  command: string[];
  recordedVersion: string;
  observedVersion: string | null;
  realpath: string | null;
  status: "current" | "changed" | "unavailable";
}
export interface AgentDetectionObservation {
  schema: "orca-agent-detection-observation-v1";
  baseTableHash: string;
  observedAt: string;
  installed: InstalledObservation[];
}
export interface DetectionChange {
  changeId: string;
  kind: "version" | "path" | "addition";
  installationId: string;
  command: string[];
  realpath: string;
  version: string;
  installation?: InstallationV1;
  unavailableReason?: "omp-frozen-model-unavailable";
}
export interface AgentDetectionPreview extends Omit<AgentDetectionObservation, "schema"> {
  schema: "orca-agent-detection-preview-v1";
  previewId: string;
  changes: DetectionChange[];
}
export interface ApplyAgentDetection {
  opId: string;
  requestDigest: string;
  previewId: string;
  baseTableHash: string;
  acceptedChangeIds: string[];
}
export interface AgentDetectionReceipt {
  schema: "orca-agent-detection-receipt-v1";
  opId: string;
  requestDigest: string;
  previewId: string;
  acceptedChangeIds: string[];
  beforeHash: string;
  afterHash: string;
  before: AgentsTableV1;
  after: AgentsTableV1;
}
interface Intent { schema: "orca-agent-detection-intent-v1"; request: ApplyAgentDetection; receipt: AgentDetectionReceipt; mode: number }

function validateRequest(request: ApplyAgentDetection): void {
  if (!ID.test(request.opId) || !HASH.test(request.requestDigest) || !ID.test(request.previewId) || !HASH.test(request.baseTableHash) || !Array.isArray(request.acceptedChangeIds) || request.acceptedChangeIds.length === 0 || request.acceptedChangeIds.some((id) => typeof id !== "string" || !ID.test(id)) || new Set(request.acceptedChangeIds).size !== request.acceptedChangeIds.length) fail("invalid apply request");
}

async function exactRealpath(command: string[]): Promise<string | null> {
  try {
    const info = await stat(command[0]!);
    if (!info.isFile()) return null;
    await access(command[0]!, constants.X_OK);
    return await realpath(command[0]!);
  } catch { return null; }
}

export async function observeAgentInstallations(tablePath: string, deps: { probe?: typeof probeVersion } = {}): Promise<AgentDetectionObservation> {
  const snapshot = await readAgentsTableSnapshot(tablePath);
  const installed: InstalledObservation[] = [];
  for (const [id, row] of Object.entries(snapshot.table.installations)) {
    const command = [...row.command];
    const real = await exactRealpath(command);
    const observed = real === null ? null : await (deps.probe ?? probeVersion)(command);
    installed.push({ id, kind: row.kind, command, recordedVersion: row.version, observedVersion: observed, realpath: real, status: observed === null ? "unavailable" : observed === row.version ? "current" : "changed" });
  }
  return { schema: "orca-agent-detection-observation-v1", baseTableHash: sha256(snapshot.bytes), observedAt: new Date().toISOString(), installed };
}

/** Creates a server-owned immutable preview; the configured table is never changed. */
export async function previewAgentInstallations(tablePath: string, input: { home?: string; path?: string; probe?: typeof probeVersion } = {}): Promise<AgentDetectionPreview> {
  const observation = await observeAgentInstallations(tablePath, { probe: input.probe });
  const snapshot = await readAgentsTableSnapshot(tablePath);
  if (sha256(snapshot.bytes) !== observation.baseTableHash) stale();
  const table = snapshot.table;
  const paths = await findAgentCandidatePaths({ home: input.home ?? homedir(), path: input.path ?? process.env.PATH ?? "", platform: process.platform });
  const probe = input.probe ?? probeVersion;
  const changes: DetectionChange[] = [];
  for (const row of observation.installed) {
    const frozen = table.installations[row.id]!;
    if (row.status === "changed" && row.realpath !== null && row.observedVersion !== null) {
      const unavailableReason = await ompUnavailable({ ...frozen, version: row.observedVersion });
      changes.push({ changeId: randomUUID(), kind: "version", installationId: row.id, command: row.command, realpath: row.realpath, version: row.observedVersion, ...(unavailableReason === undefined ? {} : { unavailableReason }) });
    }
    for (const candidate of paths[row.kind] ?? []) {
      if (candidate.realpath === row.realpath) continue;
      const command = [candidate.path, ...row.command.slice(1)];
      const version = await probe(command);
      if (version === null) continue;
      const unavailableReason = await ompUnavailable({ ...frozen, command: command as [string, ...string[]], version });
      changes.push({ changeId: randomUUID(), kind: "path", installationId: row.id, command, realpath: candidate.realpath, version, ...(unavailableReason === undefined ? {} : { unavailableReason }) });
    }
  }
  for (const [kind, candidates] of Object.entries(paths)) {
    if (Object.values(table.installations).some((row) => row.kind === kind) || Object.hasOwn(table.installations, kind)) continue;
    for (const candidate of candidates) {
      const command = draftCommandForCandidate(kind, candidate.path);
      const version = await probe(command);
      if (version === null) continue;
      const installation = await draftInstallationForCandidate(kind, candidate.path, version);
      changes.push({ changeId: randomUUID(), kind: "addition", installationId: kind, command, realpath: candidate.realpath, version, ...(installation === null ? {} : { installation }) });
    }
  }
  const preview: AgentDetectionPreview = { ...observation, schema: "orca-agent-detection-preview-v1", previewId: randomUUID(), changes };
  if (sha256((await readAgentsTableSnapshot(tablePath)).bytes) !== observation.baseTableHash) stale();
  const root = await assertUpdatesRoot(tablePath, true);
  await writeOwnedJson(root, `preview-${preview.previewId}.json`, preview);
  return preview;
}

function sameRequest(a: ApplyAgentDetection, b: ApplyAgentDetection): boolean {
  return a.opId === b.opId && a.requestDigest === b.requestDigest && a.previewId === b.previewId && a.baseTableHash === b.baseTableHash && JSON.stringify(a.acceptedChangeIds) === JSON.stringify(b.acceptedChangeIds);
}

async function ompUnavailable(installation: InstallationV1, refresh = false): Promise<DetectionChange["unavailableReason"]> {
  if (installation.kind !== "omp") return undefined;
  try {
    // Every-agent requirement chain (Orca spec 2026-10-15 §4.1): read through the catalog cache like every other reader.
    const answer = await readAgentCatalog(installation, { refresh });
    if (answer.catalogError !== null) return "omp-frozen-model-unavailable";
    return answer.rows!.some((row) => row.selector === installation.defaultModel) ? undefined : "omp-frozen-model-unavailable";
  } catch { return "omp-frozen-model-unavailable"; }
}

async function recheck(change: DetectionChange, probe: typeof probeVersion, table: AgentsTableV1): Promise<void> {
  if (change.unavailableReason !== undefined) fail(change.unavailableReason);
  const real = await exactRealpath(change.command);
  if (real !== change.realpath) stale();
  const version = await probe(change.command);
  if (version !== change.version) stale();
  const old = table.installations[change.installationId];
  const selected = change.kind === "addition" ? change.installation : old === undefined ? undefined : { ...old, command: change.command as [string, ...string[]], version: change.version };
  // Every-agent requirement chain (Task 4 ruling, Orca session a852f96a): Apply is a deliberate owner action that must see the
  // live catalog -- the cache key cannot see a provider-side or state change since preview -- so it re-probes.
  if (selected !== undefined && await ompUnavailable(selected, true)) fail("omp-frozen-model-unavailable");
}

export async function applyAgentInstallations(tablePath: string, request: ApplyAgentDetection, deps: { probe?: typeof probeVersion } = {}): Promise<AgentDetectionReceipt> {
  validateRequest(request);
  await assertAgentsTableLocation(tablePath);
  // The only caller-supplied location is the control command's configured --agents table, never a payload path.
  return withTableUpdateLock(tablePath, request.opId, async (root, assertHeld) => {
    assertHeld();
    const receiptName = `receipt-${request.opId}.json`;
    const intentName = `intent-${request.opId}.json`;
    const completed = await readOwnedJson<AgentDetectionReceipt>(root, receiptName);
    const intent = await readOwnedJson<Intent>(root, intentName);
    if (completed !== null) {
      if (intent === null || !sameRequest(intent.request, request) || JSON.stringify(completed) !== JSON.stringify(intent.receipt)) conflict("operation identity or digest changed");
      return completed; // replay before CAS
    }
    if (intent !== null) {
      if (!sameRequest(intent.request, request)) conflict("operation identity or digest changed");
      await cleanupOperationTemporary(root, request.opId, request.requestDigest);
      const current = await readAgentsTableSnapshot(tablePath);
      const hash = sha256(current.bytes);
      if (hash === intent.receipt.afterHash) {
        assertHeld();
        await writeOwnedJson(root, receiptName, intent.receipt);
        return intent.receipt;
      }
      if (hash !== intent.receipt.beforeHash) conflict("table reached a third state");
      // Intent was durable but rename was not. The same operation may complete after a fresh probe.
      const preview = await readOwnedJson<AgentDetectionPreview>(root, `preview-${request.previewId}.json`);
      if (preview === null) conflict("preview missing for intent recovery");
      for (const id of request.acceptedChangeIds) {
        const change = preview.changes.find((entry) => entry.changeId === id);
        if (change === undefined) conflict("accepted change missing");
        await recheck(change, deps.probe ?? probeVersion, current.table);
      }
      if (sha256(current.bytes) !== intent.receipt.beforeHash) stale();
      await replaceTableDurably(tablePath, root, Buffer.from(`${JSON.stringify(intent.receipt.after)}\n`), current.bytes, intent.mode, request.opId, request.requestDigest, assertHeld);
      await testCrashPoint("agent-update-after-rename");
      assertHeld();
      await writeOwnedJson(root, receiptName, intent.receipt);
      return intent.receipt;
    }
    const preview = await readOwnedJson<AgentDetectionPreview>(root, `preview-${request.previewId}.json`);
    if (preview === null || preview.schema !== "orca-agent-detection-preview-v1" || preview.baseTableHash !== request.baseTableHash) conflict("preview missing or changed");
    const original = await readAgentsTableSnapshot(tablePath);
    if (sha256(original.bytes) !== request.baseTableHash) stale();
    const next = structuredClone(original.table);
    const used = new Set<string>();
    for (const id of request.acceptedChangeIds) {
      const change = preview.changes.find((entry) => entry.changeId === id);
      if (change === undefined || used.has(change.installationId)) conflict("accepted changes conflict");
      used.add(change.installationId);
      await recheck(change, deps.probe ?? probeVersion, original.table);
      if (change.kind === "addition") {
        if (Object.hasOwn(next.installations, change.installationId) || change.installation === undefined) conflict("addition id exists");
        next.installations[change.installationId] = change.installation;
      } else {
        const old = next.installations[change.installationId];
        if (old === undefined || old.kind !== preview.installed.find((entry) => entry.id === change.installationId)?.kind) stale();
        if (JSON.stringify(old.command) !== JSON.stringify(preview.installed.find((entry) => entry.id === change.installationId)?.command)) stale();
        next.installations[change.installationId] = change.kind === "version" ? { ...old, version: change.version } : { ...old, command: change.command as [string, ...string[]], version: change.version };
      }
    }
    parseAgentsTable(next);
    const afterBytes = Buffer.from(`${JSON.stringify(next)}\n`);
    const receipt: AgentDetectionReceipt = { schema: "orca-agent-detection-receipt-v1", opId: request.opId, requestDigest: request.requestDigest, previewId: request.previewId, acceptedChangeIds: [...request.acceptedChangeIds], beforeHash: request.baseTableHash, afterHash: sha256(afterBytes), before: original.table, after: next };
    // Intent includes the exact replacement bytes' hash; recovery derives the same bytes from its immutable after value.
    assertHeld();
    await writeOwnedJson(root, intentName, { schema: "orca-agent-detection-intent-v1", request, receipt, mode: original.mode } satisfies Intent);
    await testCrashPoint("agent-update-before-rename");
    const current = await readAgentsTableSnapshot(tablePath);
    if (!current.bytes.equals(original.bytes)) stale();
    await replaceTableDurably(tablePath, root, afterBytes, original.bytes, original.mode, request.opId, request.requestDigest, assertHeld);
    await testCrashPoint("agent-update-after-rename");
    assertHeld();
    await writeOwnedJson(root, receiptName, receipt);
    await testCrashPoint("agent-update-after-receipt");
    return receipt;
  });
}
