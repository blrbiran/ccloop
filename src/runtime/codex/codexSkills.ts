import { lstat, mkdir, readdir, readlink, realpath, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown";
const failure = (prefix: string, detail: string) => new Error(`${prefix}:${detail}`);
export const codexSkillsPendingPath = (worktreePath: string) => `${worktreePath}.codex-skills-pending`;
async function optionalStat(path: string) {
  try { return await lstat(path); } catch (error) { if (codeOf(error) === "ENOENT") return null; throw error; }
}

/** Each invocation owns only exact snapshot links and parents it created. */
export async function withCodexSkillLinks<T>(worktreePath: string, skillsRoot: string, run: () => Promise<T>): Promise<T> {
  let sources: {name:string;path:string}[];
  try {
    if (!isAbsolute(skillsRoot) || await realpath(skillsRoot) !== skillsRoot || !(await lstat(skillsRoot)).isDirectory()) throw new Error("root");
    const withinWork = relative(resolve(worktreePath), skillsRoot);
    if (withinWork === "" || (!withinWork.startsWith("..") && !isAbsolute(withinWork))) throw new Error("inside-worktree");
    sources = [];
    for (const name of (await readdir(skillsRoot)).sort()) {
      const path = join(skillsRoot, name);
      if (name === "syncskill-lock.json" && (await lstat(path)).isFile()) continue;
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path || relative(skillsRoot,path).startsWith("..")) throw new Error(`child-${name}`);
      sources.push({name,path});
    }
  } catch (error) { throw failure("codex-skills-source-invalid", codeOf(error) === "unknown" ? (error as Error).message : codeOf(error)); }
  const parents = [join(worktreePath,".agents"),join(worktreePath,".agents","skills")];
  const created: string[] = [], owned: {name:string;path:string}[] = [];
  const identities = new Map<string,{dev:number;ino:number}>();
  const checkParents = async () => {
    for (const [path, identity] of identities) {
      const stat = await optionalStat(path);
      if (!stat?.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw failure("codex-skills-cleanup-failed","parent-changed");
    }
  };
  const cleanup = async () => {
    let first: unknown;
    try { await checkParents(); } catch (error) { first = error; }
    if (!first) for (const source of owned.slice().reverse()) {
      try {
        await checkParents();
        const leaf = join(parents[1]!,source.name), stat = await optionalStat(leaf);
        if (stat === null) continue;
        if (!stat.isSymbolicLink() || await readlink(leaf) !== source.path) throw failure("codex-skills-cleanup-failed","link-changed");
        await unlink(leaf);
      } catch (error) { first ??= error; }
    }
    if (!first) for (const path of created.slice().reverse()) {
      try { await rmdir(path); } catch (error) { if (!["ENOENT","ENOTEMPTY","EEXIST"].includes(codeOf(error))) first ??= error; }
    }
    if (first) throw failure("codex-skills-cleanup-failed", (first as Error).message.startsWith("codex-skills-cleanup-failed:") ? (first as Error).message.split(":").slice(1).join(":") : codeOf(first));
    await unlink(codexSkillsPendingPath(worktreePath)).catch(error=>{throw failure("codex-skills-cleanup-failed",codeOf(error));});
  };
  await writeFile(codexSkillsPendingPath(worktreePath),skillsRoot,{mode:0o600}).catch(error=>{throw failure("codex-skills-setup-failed",codeOf(error));});
  let value:T;
  try {
    try {
      for (const path of parents) {
        let stat = await optionalStat(path);
        if (stat === null) { await mkdir(path,{mode:0o700}); created.push(path); stat = await lstat(path); }
        if (!stat.isDirectory()) throw failure("codex-skills-path-conflict",relative(worktreePath,path));
        identities.set(path,{dev:stat.dev,ino:stat.ino});
      }
      for (const source of sources) {
        await checkParents();
        const leaf = join(parents[1]!,source.name), stat = await optionalStat(leaf);
        if (stat === null) await symlink(source.path,leaf);
        else if (!stat.isSymbolicLink() || await readlink(leaf) !== source.path) throw failure("codex-skills-path-conflict",source.name);
        owned.push(source);
      }
    } catch (error) {
      if ((error as Error).message.startsWith("codex-skills-")) throw error;
      throw failure("codex-skills-setup-failed",codeOf(error));
    }
    value = await run();
  } catch (error) { await cleanup(); throw error; }
  await cleanup();
  return value;
}
