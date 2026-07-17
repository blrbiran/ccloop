import type {
  AttemptContext,
  AttemptPlan,
  ExecutePhaseResult,
  ExecutionResult,
  RuntimeAdapter,
  VerificationResult,
} from "./types.js";

export type ScriptedFrame = {
  plan: AttemptPlan;
  execution: ExecutionResult;
  verification: VerificationResult;
};

export class ScriptedAdapter implements RuntimeAdapter {
  private readonly frames: ScriptedFrame[];
  private currentFrame: ScriptedFrame | null = null;

  constructor(frames: ScriptedFrame[]) {
    this.frames = [...frames];
  }

  async plan(_context: AttemptContext): Promise<AttemptPlan> {
    const frame = this.frames.shift();

    if (!frame) {
      throw new Error("no scripted frame remaining");
    }

    this.currentFrame = frame;
    return frame.plan;
  }

  async execute(_context: AttemptContext): Promise<ExecutePhaseResult> {
    if (!this.currentFrame) {
      throw new Error("plan must run before execute");
    }

    return this.currentFrame.execution;
  }

  async verify(_context: AttemptContext): Promise<VerificationResult> {
    if (!this.currentFrame) {
      throw new Error("plan must run before verify");
    }

    return this.currentFrame.verification;
  }
}
