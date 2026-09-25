import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LoopContract } from "../../src/contract/schema.js";
import { probeVersion, resolveAgent } from "../../src/agents/materialize.js";
import { parseAgentsTable } from "../../src/agents/table.js";
import type { AgentSelectionV1, AgentsTableV1, InstallationV1, MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import type { StartEnvelopeV2 } from "../../src/control/protocol.js";
import type { CodexConfig } from "../../src/runtime/codex/protocol.js";

/**
 * Shared by the control criteria since agent selection (2026-09-26): an agents table the way readAgentsTable
 * demands it (0600 file in an owner-only directory), installation records whose `version` is whatever the
 * fixture command itself answers to `--version`, and the sealed config accept would write.
 */
export const FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
export const FAKE_CLAUDE_CLI = resolve("tests/fixtures/fake-claude-cli.mjs");

/** A selection for fixtures whose provider never runs: the envelope schema requires one, nothing resolves it. */
export const FIXTURE_SELECTION: AgentSelectionV1 = { agent: "codex", model: "fixture", contextWindow: "agent-default" };

async function probed(command: [string, ...string[]]): Promise<string> {
  const version = await probeVersion(command);
  if (version === null) throw new Error(`fixture command answers no --version: ${command.join(" ")}`);
  return version;
}

export async function codexInstallation(
  config: Pick<CodexConfig, "command" | "sandbox" | "budgetMode" | "timeoutMs" | "killGraceMs">,
): Promise<InstallationV1> {
  return {
    kind: "codex",
    command: config.command,
    version: await probed(config.command),
    configDir: null,
    timeoutMs: config.timeoutMs,
    killGraceMs: config.killGraceMs,
    sandbox: config.sandbox,
    budgetMode: config.budgetMode,
  };
}

export async function claudeInstallation(
  command: [string, ...string[]],
  limits: { timeoutMs: number; killGraceMs: number } = { timeoutMs: 10_000, killGraceMs: 50 },
): Promise<InstallationV1> {
  return { kind: "claude", command, version: await probed(command), configDir: null, ...limits };
}

/** Writes `<dir>/agents.json` (0600); `dir` defaults to a fresh mkdtemp directory (0700, owned by this process). */
export async function writeAgentsTable(
  installations: Record<string, InstallationV1>,
  dir?: string,
): Promise<{ path: string; table: AgentsTableV1 }> {
  const parent = dir ?? await realpath(await mkdtemp(join(tmpdir(), "ccloop-agents-table-")));
  const table = parseAgentsTable({ schema: "ccloop-agents-table-v1", installations });
  const path = join(parent, "agents.json");
  await writeFile(path, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 });
  return { path, table };
}

/** What accept seals for this codex config: the materialized config, its hash, and the filled selection. */
export async function sealCodex(
  config: CodexConfig,
): Promise<{ config: MaterializedAgentConfigV1; configHash: string; selection: AgentSelectionV1 }> {
  const table = parseAgentsTable({ schema: "ccloop-agents-table-v1", installations: { codex: await codexInstallation(config) } });
  const { config: sealed, resolution } = await resolveAgent(table, { agent: "codex", model: config.model, contextWindow: "agent-default" });
  return { config: sealed, configHash: resolution.configHash, selection: resolution.selection };
}

export function controlContract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "work", successCondition: "done", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalRuntimeBudgetMs: 2_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
    safetyPolicy: { allowlistPaths: ["src"], denylistPaths: [], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "command", requiredChecks: ["npm test"], rejectOn: ["failure"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

export function startEnvelope(input: {
  sourceDir: string;
  targetRepo: string;
  contract: LoopContract;
  agent: AgentSelectionV1;
  configHash: string;
}): StartEnvelopeV2 {
  const amount = { tokens: 10, activeMs: 20, attempts: 1, sessions: 1 };
  return {
    protocol: 2,
    claim: {
      groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1,
      targetVersion: 1, commandId: "command-1", configHash: input.configHash, agent: input.agent,
      grant: { work: amount, handoff: amount }, ownerToken: "owner-1",
    },
    contractHash: "b".repeat(64),
    inputCheckpoint: null,
    work: { contract: input.contract, targetRepo: input.targetRepo, base: "main", sourceDir: input.sourceDir },
  };
}
