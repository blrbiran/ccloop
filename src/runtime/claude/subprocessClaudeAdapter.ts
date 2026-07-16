import { spawn } from "node:child_process";
import { buildExecutorPrompt, buildPlannerPrompt, buildVerifierPrompt } from "./prompts.js";
import type { ClaudePhaseRequest, SubprocessAdapterConfig } from "./types.js";
import type { AttemptContext, AttemptPlan, ExecutionResult, RuntimeAdapter, VerificationResult } from "../types.js";

async function runPhase<T>(
  command: string[],
  request: ClaudePhaseRequest,
  abortSignal?: AbortSignal,
): Promise<T> {
  const [file, ...args] = command;

  if (!file) {
    throw new Error("subprocess adapter requires a non-empty command");
  }

  return await new Promise<T>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanupAbort = () => {
      abortSignal?.removeEventListener("abort", onAbort);
    };

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupAbort();
      callback();
    };

    const onAbort = () => {
      child.kill("SIGTERM");
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("exit", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(stderr || `command failed with exit code ${code ?? "null"} and signal ${signal ?? "none"}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout) as T);
        } catch (error) {
          reject(new Error(`failed to parse subprocess JSON: ${String(error)}
stdout: ${stdout}
stderr: ${stderr}`));
        }
      });
    });

    child.stdin.end(JSON.stringify(request));
  });
}

export class SubprocessClaudeAdapter implements RuntimeAdapter {
  constructor(private readonly config: SubprocessAdapterConfig) {}

  async plan(context: AttemptContext): Promise<AttemptPlan> {
    return await runPhase<AttemptPlan>(
      this.config.command,
      {
        phase: "plan",
        prompt: buildPlannerPrompt(context.contract),
        attempt: context.attempt,
        runDir: context.runDir,
        worktreePath: context.worktreePath,
      },
      context.abortSignal,
    );
  }

  async execute(context: AttemptContext): Promise<ExecutionResult> {
    return await runPhase<ExecutionResult>(
      this.config.command,
      {
        phase: "execute",
        prompt: buildExecutorPrompt(context.contract),
        attempt: context.attempt,
        runDir: context.runDir,
        worktreePath: context.worktreePath,
      },
      context.abortSignal,
    );
  }

  async verify(context: AttemptContext): Promise<VerificationResult> {
    return await runPhase<VerificationResult>(
      this.config.command,
      {
        phase: "verify",
        prompt: buildVerifierPrompt(context.contract),
        attempt: context.attempt,
        runDir: context.runDir,
        worktreePath: context.worktreePath,
      },
      context.abortSignal,
    );
  }
}
