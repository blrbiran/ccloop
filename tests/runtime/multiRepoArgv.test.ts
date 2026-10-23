// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.5, §16.1 C6, §19.2 P5): the extra worktrees reach each
// agent as extra directories -- claude `--add-dir <w1> … <wk>` on every phase, with the other lists before --model;
// codex `--add-dir <wi>` once per worktree after `-C <primary>`, on execute only (it grants nothing under read-only);
// omp `--add-dir=<wi>` after `--cwd <primary>` on every phase. Without extra worktrees the argv is the golden one.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopContractSchema } from "../../src/contract/schema.js";
import { canonicalJson } from "../../src/control/protocol.js";
import { ClaudeAgentAdapter } from "../../src/runtime/claude/claudeAgentAdapter.js";
import { buildExecutorPrompt } from "../../src/runtime/claude/prompts.js";
import { CodexAdapter } from "../../src/runtime/codex/codexAdapter.js";
import { OmpAdapter } from "../../src/runtime/omp/ompAdapter.js";
import { captureClaude, captureCodex, captureOmp, dispose, FAKE_CLAUDE, normalise, PHASES, world, type CaptureModules, type World } from "../fixtures/toolRules/argvCapture.js";

const m: CaptureModules = { loopContractSchema, canonicalJson, ClaudeAgentAdapter, CodexAdapter, OmpAdapter, buildExecutorPrompt };
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await dispose(w); });
const golden = async (kind: string, phase: string) => JSON.parse(await readFile(new URL(`../fixtures/toolRules/golden-2a2ae53/${kind}-${phase}.json`, import.meta.url), "utf8")) as Record<string, string[]>;

/** The capture world, with two extra worktrees (directories under the world) added to the attempt context. */
async function multiWorld(extras: boolean): Promise<World> {
  const w = await world(m); worlds.push(w);
  if (extras) {
    w.context.extraWorktrees = [];
    for (const key of ["lib", "docs"]) {
      await mkdir(join(w.dir, "dirs", key), { recursive: true });
      // omp snapshots every worktree in its read-only phases, so each is a repository with a commit.
      for (const args of [["init"], ["-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "--allow-empty", "-m", "init"]]) await promisify(execFile)("git", args, { cwd: join(w.dir, "dirs", key) });
      w.context.extraWorktrees.push({ key, worktreePath: join(w.dir, "dirs", key), targetPaths: [`${key}/**`], requiredChecks: [] });
    }
  }
  return w;
}
const ADD_LIB = "<dir>/dirs/lib", ADD_DOCS = "<dir>/dirs/docs";
// The flow insertion the claude execute golden needs (as tests/runtime/claude/claudeToolRules.test.ts applies it).
const withFlow = (argv: string[]): string[] => argv.map((arg, i) => argv[i - 1] === "--json-schema" ? arg.replace('"debug":{},', '"debug":{},"flow":{},') : arg);

/**
 * claude: the argv the fake received and outcome.json's extraArgs, as captureClaude reads them. fake-claude-cli records its
 * argv before parsing it and refuses an option it does not know (--add-dir), so the call itself fails here; the real
 * claude 2.1.309 lists `--add-dir <directories...>` (spec §3.3). The argv is what this criterion pins.
 */
async function captureClaudeArgv(phase: "plan" | "execute" | "verify", w: World): Promise<{ argv: string[]; extraArgs: string[] }> {
  const config = { schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, FAKE_CLAUDE, "ok", w.marker, "--strict-mcp-config", "--disable-slash-commands"], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" } };
  await new ClaudeAgentAdapter(config as never)[phase](w.context).catch(() => undefined);
  const argv = JSON.parse((await readFile(`${w.marker}.argv`, "utf8")).trim().split("\n").at(-1)!) as string[];
  const root = join(w.runDir, "claude", "1", phase);
  const [call] = (await readdir(root)).filter((name) => name.startsWith("call-"));
  const outcome = JSON.parse(await readFile(join(root, call!, "outcome.json"), "utf8")) as { extraArgs: string[] };
  return { argv: normalise(argv, w), extraArgs: normalise(outcome.extraArgs, w) };
}

describe("claude --add-dir (C6)", () => {
  for (const phase of PHASES) {
    it(`${phase}: the extra worktrees as one --add-dir list, before --model and before the prompt`, async () => {
      const { argv, extraArgs } = await captureClaudeArgv(phase, await multiWorld(true));
      const at = argv.indexOf("--add-dir");
      expect(argv.slice(at, at + 3)).toEqual(["--add-dir", ADD_LIB, ADD_DOCS]);
      expect(argv.filter((arg) => arg === "--add-dir")).toHaveLength(1);
      expect(at).toBeLessThan(argv.indexOf("--model"));
      expect(extraArgs.slice(-5)).toEqual(["--add-dir", ADD_LIB, ADD_DOCS, "--model", "claude-opus-5-5"]);
    }, 30_000);
    it(`${phase}: without extra worktrees the argv is the golden one`, async () => {
      const { argv, extraArgs } = await captureClaude(m, phase, await multiWorld(false));
      const want = await golden("claude", phase);
      expect(argv).toEqual(phase === "execute" ? withFlow(want.argv!) : want.argv);
      expect(extraArgs).toEqual(want.extraArgs);
    }, 30_000);
  }
});

describe("codex --add-dir (C6)", () => {
  for (const phase of PHASES) {
    it(`${phase}: --add-dir per extra worktree after -C on execute only; the golden argv otherwise`, async () => {
      const { args } = await captureCodex(m, phase, await multiWorld(true), false);
      const want = (await golden("codex", phase)).legacy!;
      const c = want.indexOf("-C") + 2;
      expect(args).toEqual(phase === "execute" ? [...want.slice(0, c), "--add-dir", ADD_LIB, "--add-dir", ADD_DOCS, ...want.slice(c)] : want);
      expect((await captureCodex(m, phase, await multiWorld(false), false)).args).toEqual(want);
    }, 30_000);
  }
});

describe("omp --add-dir= (C6)", () => {
  for (const phase of PHASES) {
    it(`${phase}: --add-dir=<wi> per extra worktree after --cwd; the golden argv without extras`, async () => {
      const want = (await golden("omp", phase)).args!;
      expect((await captureOmp(m, phase, await multiWorld(true))).args).toEqual([...want, `--add-dir=${ADD_LIB}`, `--add-dir=${ADD_DOCS}`]);
      expect((await captureOmp(m, phase, await multiWorld(false))).args).toEqual(want);
    }, 30_000);
  }
});
