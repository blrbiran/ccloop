// Task handoffs (Orca spec 2026-11-12 tester follow-up G §10.2): the agent must be able to read Orca's handoff input
// directory and write its output directory, both outside the worktree, so each runtime is given them as extra
// directories: claude `--add-dir <in> <out>` (after any extra worktrees), codex `--add-dir <out>` on execute only (its
// read-only phases may read anywhere; only execute writes), omp `--add-dir=<in> --add-dir=<out>`. Without a handoff the
// argv is exactly what it is today.
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { canonicalJson } from "../../src/control/protocol.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import { captureCodex, captureOmp, dispose, FAKE_CLAUDE, normalise, PHASES, world, type CaptureModules, type World } from "../fixtures/toolRules/argvCapture.js";

const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });
const IN = "<dir>/handoff/in", OUT = "<dir>/handoff/out";

async function handoffWorld(withHandoff: boolean): Promise<World> {
  const w = await world(m); worlds.push(w);
  if (withHandoff) {
    for (const name of ["in", "out"]) await mkdir(join(w.dir, "handoff", name), { recursive: true });
    w.context.handoff = { inputDir: join(w.dir, "handoff", "in"), outputDir: join(w.dir, "handoff", "out") };
  }
  return w;
}

/** claude: outcome.json's extraArgs (the fake refuses --add-dir, so the call itself fails; the argv is what is pinned). */
async function claudeExtraArgs(phase: "plan" | "execute" | "verify", w: World): Promise<string[]> {
  const config = { schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, FAKE_CLAUDE, "ok", w.marker, "--strict-mcp-config", "--disable-slash-commands"], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } };
  await new ClaudeAgentAdapter(config as never)[phase](w.context).catch(() => undefined);
  const root = join(w.runDir, "claude", "1", phase);
  const [call] = (await readdir(root)).filter((name) => name.startsWith("call-"));
  return normalise((JSON.parse(await readFile(join(root, call!, "outcome.json"), "utf8")) as { extraArgs: string[] }).extraArgs, w);
}

describe("the handoff directories in each runtime's argv", () => {
  for (const phase of PHASES) {
    it(`claude ${phase}: --add-dir <in> <out>; without handoff no --add-dir`, async () => {
      const without = await claudeExtraArgs(phase, await handoffWorld(false));
      const withIt = await claudeExtraArgs(phase, await handoffWorld(true));
      expect(without).not.toContain("--add-dir");
      const at = withIt.indexOf("--add-dir");
      expect(withIt.slice(at, at + 3)).toEqual(["--add-dir", IN, OUT]);
      expect([...withIt.slice(0, at), ...withIt.slice(at + 3)]).toEqual(without);
    }, 30_000);

    it(`codex ${phase}: --add-dir <out> ${phase === "execute" ? "on execute" : "absent"}; otherwise the argv is unchanged`, async () => {
      const without = (await captureCodex(m, phase, await handoffWorld(false), false)).args;
      const withIt = (await captureCodex(m, phase, await handoffWorld(true), false)).args;
      if (phase !== "execute") { expect(withIt).toEqual(without); return; }
      const at = withIt.indexOf("--add-dir");
      expect(withIt.slice(at, at + 2)).toEqual(["--add-dir", OUT]);
      expect(withIt.slice(at - 2, at)).toEqual(["-C", "<dir>/repo"]);
      expect([...withIt.slice(0, at), ...withIt.slice(at + 2)]).toEqual(without);
    }, 30_000);

    it(`omp ${phase}: --add-dir=<in> --add-dir=<out> after --cwd; without handoff the argv is unchanged`, async () => {
      const without = (await captureOmp(m, phase, await handoffWorld(false))).args;
      const withIt = (await captureOmp(m, phase, await handoffWorld(true))).args;
      expect(without.some((arg) => arg.startsWith("--add-dir"))).toBe(false);
      expect(withIt).toEqual([...without, `--add-dir=${IN}`, `--add-dir=${OUT}`]);
    }, 30_000);
  }
});
