import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ompSkillsPromptBlock } from "../../../src/runtime/omp/ompSkills.js";
import { runOmpPhase } from "../../../src/runtime/omp/runOmpPhase.js";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import type { AttemptContext } from "../../../src/runtime/types.js";

// OMP skill injection (spec 2026-10-13-omp-skill-injection-design.md §2, session 808feb6a): OMP's own discovery stays off
// (--no-skills), and the frozen snapshot is listed in the phase's private system prompt with each SKILL.md's absolute
// path, so the model can read exactly the skills Orca froze and nothing from the operator's machine.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function root(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-skills-")));
  roots.push(dir);
  return dir;
}

async function skill(skillsRoot: string, name: string, skillMd: string): Promise<string> {
  await mkdir(join(skillsRoot, name), { recursive: true });
  await writeFile(join(skillsRoot, name, "SKILL.md"), skillMd);
  return join(skillsRoot, name, "SKILL.md");
}

describe("ompSkillsPromptBlock", () => {
  it("lists every snapshot skill in name order with its one-line description and absolute SKILL.md path", async () => {
    const r = await root();
    const skills = join(r, "snapshot", "skills");
    const beta = await skill(skills, "beta", "---\nname: beta\ndescription: Second skill. Use for beta work.\n---\n# Beta\n");
    const alpha = await skill(skills, "alpha", "---\nname: alpha\ndescription: \"Quoted: alpha helper\"\n---\nbody\n");
    await writeFile(join(skills, "syncskill-lock.json"), "{}\n");
    const block = await ompSkillsPromptBlock(skills, join(r, "worktree"));
    expect(block).toBe([
      "<skills>",
      "These skills were frozen for this task. When one matches the work, read its SKILL.md with the read tool before acting on it.",
      `- alpha: Quoted: alpha helper (SKILL.md: ${alpha})`,
      `- beta: Second skill. Use for beta work. (SKILL.md: ${beta})`,
      "</skills>",
    ].join("\n"));
  });

  it("tells the model to read the file when the description is missing or not a single line, and bounds a long one", async () => {
    const r = await root();
    const skills = join(r, "skills");
    const block1 = await skill(skills, "block", "---\nname: block\ndescription: |\n  multi\n  line\n---\n");
    const none = await skill(skills, "none", "# no frontmatter\n");
    await skill(skills, "long", `---\ndescription: ${"x".repeat(2000)}\n---\n`);
    const block = await ompSkillsPromptBlock(skills, join(r, "worktree"));
    expect(block).toContain(`- block: (no one-line description; read the file) (SKILL.md: ${block1})`);
    expect(block).toContain(`- none: (no one-line description; read the file) (SKILL.md: ${none})`);
    expect(block).toContain(`- long: ${"x".repeat(1024)}… (SKILL.md: `);
    expect(block).not.toContain("x".repeat(1025));
  });

  it("returns no block for an empty snapshot", async () => {
    const r = await root();
    await mkdir(join(r, "skills"));
    expect(await ompSkillsPromptBlock(join(r, "skills"), join(r, "worktree"))).toBe("");
  });

  it.each([
    ["a relative root", async (r: string) => ({ skills: "skills", worktree: join(r, "wt") }), "root"],
    ["a root inside the worktree", async (r: string) => {
      await mkdir(join(r, "wt", ".agents", "skills"), { recursive: true });
      return { skills: join(r, "wt", ".agents", "skills"), worktree: join(r, "wt") };
    }, "inside-worktree"],
    ["a root reached through a symlink", async (r: string) => {
      await mkdir(join(r, "real"));
      await symlink(join(r, "real"), join(r, "link"));
      return { skills: join(r, "link"), worktree: join(r, "wt") };
    }, "root"],
    ["a child that is a file", async (r: string) => {
      await mkdir(join(r, "skills"));
      await writeFile(join(r, "skills", "stray.txt"), "x");
      return { skills: join(r, "skills"), worktree: join(r, "wt") };
    }, "child-stray.txt"],
    ["a child without SKILL.md", async (r: string) => {
      await mkdir(join(r, "skills", "empty"), { recursive: true });
      return { skills: join(r, "skills"), worktree: join(r, "wt") };
    }, "skill-md-empty"],
    ["a SKILL.md that is a symlink", async (r: string) => {
      await mkdir(join(r, "skills", "linked"), { recursive: true });
      await writeFile(join(r, "elsewhere.md"), "x");
      await symlink(join(r, "elsewhere.md"), join(r, "skills", "linked", "SKILL.md"));
      return { skills: join(r, "skills"), worktree: join(r, "wt") };
    }, "skill-md-link-linked"],
  ])("refuses %s by name", async (_label, make, detail) => {
    const r = await root();
    const { skills, worktree } = await make(r);
    await expect(ompSkillsPromptBlock(skills, worktree)).rejects.toThrow(`omp-skills-source-invalid:${detail}`);
  });
});

describe("runOmpPhase with a skill snapshot", () => {
  async function phaseFixture() {
    const r = await root();
    const worktree = join(r, "worktree");
    const runDir = join(r, "run");
    await mkdir(worktree);
    await mkdir(runDir);
    const argsPath = join(r, "args.json");
    const binary = join(r, "omp");
    await writeFile(binary, `#!/usr/bin/env node
import {writeFileSync} from "node:fs";
(async()=>{
for await(const chunk of process.stdin){}
writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(process.argv.slice(2)));
const message={role:"assistant",content:[{type:"text",text:"{}"}],provider:"gateway",model:"model-a",stopReason:"stop",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
for(const row of [{type:"agent_start"},{type:"message_end",message},{type:"agent_end",isTerminal:true,yielded:true,messages:[message]}])process.stdout.write(JSON.stringify(row)+"\\n");
})();
`, { mode: 0o700 });
    const config: MaterializedAgentConfigV1 = {
      schema: "ccloop-agent-config-v1", kind: "omp",
      installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
      selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" },
    };
    const context = { runDir, worktreePath: worktree, attempt: 1, state: { budgetSnapshot: { timeRemainingMs: 10_000 } } } as unknown as AttemptContext;
    return { r, config, context, argsPath };
  }

  it("appends the snapshot list to the phase system prompt and keeps OMP's own skill discovery off", async () => {
    const f = await phaseFixture();
    const skillMd = await skill(join(f.r, "snapshot", "skills"), "selected", "---\ndescription: The frozen one.\n---\n");
    const outcome = await runOmpPhase(f.config, "plan", "prompt", f.context, { skillsDir: join(f.r, "snapshot", "skills") });
    expect(outcome.reason).toBe("completed");
    const system = await readFile(join(outcome.evidenceDir, "system-prompt.md"), "utf8");
    expect(system).toContain("planning phase");
    expect(system.endsWith(`\n\n<skills>\nThese skills were frozen for this task. When one matches the work, read its SKILL.md with the read tool before acting on it.\n- selected: The frozen one. (SKILL.md: ${skillMd})\n</skills>`)).toBe(true);
    const args = JSON.parse(await readFile(f.argsPath, "utf8")) as string[];
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-extensions");
  });

  it("leaves the system prompt exactly as before without a snapshot", async () => {
    const f = await phaseFixture();
    const outcome = await runOmpPhase(f.config, "verify", "prompt", f.context);
    expect(await readFile(join(outcome.evidenceDir, "system-prompt.md"), "utf8")).not.toContain("<skills>");
  });

  it("fails before spawning when the snapshot is invalid, with no provider call", async () => {
    const f = await phaseFixture();
    await mkdir(join(f.r, "bad", "skills", "empty"), { recursive: true });
    await expect(runOmpPhase(f.config, "plan", "prompt", f.context, { skillsDir: join(f.r, "bad", "skills") }))
      .rejects.toMatchObject({ message: "omp-skills-source-invalid:skill-md-empty", neverStarted: true });
    await expect(readFile(f.argsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
