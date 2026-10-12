import { isAbsolute } from "node:path";
import { z } from "zod";
import type { AgentDescriptor } from "./registry.js";
import { OmpAdapter } from "../runtime/omp/ompAdapter.js";
import { AgentError, assertContextOption, assertModel, commonSearchDirs } from "./types.js";

export const ompDescriptor: AgentDescriptor = {
  kind: "omp",
  binary: "omp",
  searchDirs: ({ home, platform }) => commonSearchDirs({ home, platform }),
  configDirEnv: "PI_CODING_AGENT_DIR",
  defaultsForInstallation: (installation) => ({ model: installation.defaultModel as string, contextWindow: "agent-default" }),
  contextOptions: ["agent-default"],
  installationExtras: {
    command: z.tuple([z.string().min(1).refine(isAbsolute)]),
    defaultModel: z.string().min(1).max(200).regex(/^[^/\s]+\/.+$/u),
    profile: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).nullable(),
  },
  draftInstallationExtras: { profile: null },
  validateInstallation(installation) {
    if (installation.profile !== null && installation.configDir !== null) {
      throw new AgentError("agents-table-invalid", "omp named profile cannot use configDir");
    }
  },
  validateSelection(selection) {
    assertModel(selection.model);
    assertContextOption(["agent-default"], selection);
    if (!/^[^/\s]+\/.+$/u.test(selection.model)) throw new AgentError("agent-selection-invalid", "omp model must be provider-qualified");
  },
  capabilities() {
    return {
      usageObservation: "phase-end",
      budgetEnforcement: "soft",
      contextObservation: "unavailable",
      handoffControl: "durable",
      handoffExecution: "mechanical-in-run-v1",
      contextWindowTokens: null,
      requestBoundProof: null,
    };
  },
  singleCallExecution() { return null; },
  createAdapter(config) { return new OmpAdapter(config); },
};
