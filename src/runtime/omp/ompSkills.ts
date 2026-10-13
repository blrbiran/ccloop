import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const DESCRIPTION_LIMIT = 1024;
const NO_DESCRIPTION = "(no one-line description; read the file)";

const invalid = (detail: string) => Object.assign(new Error(`omp-skills-source-invalid:${detail}`), { neverStarted: true });

/** The frontmatter's `description:` when it is one plain or quoted line; null for a block scalar, none, or no frontmatter. */
function oneLineDescription(skillMd: string): string | null {
  const lines = skillMd.split(/\r?\n/u);
  if (lines[0] !== "---") return null;
  for (const line of lines.slice(1)) {
    if (line === "---") return null;
    const match = /^description:\s*(.*)$/u.exec(line);
    if (match === null) continue;
    let value = match[1]!.trim();
    if (/^[|>]/u.test(value) || value === "") return null;
    if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    value = value.replace(/\s+/gu, " ").trim();
    if (value === "") return null;
    return value.length > DESCRIPTION_LIMIT ? `${value.slice(0, DESCRIPTION_LIMIT)}…` : value;
  }
  return null;
}

/**
 * OMP skill injection (spec 2026-10-13-omp-skill-injection-design.md §2): the `<skills>` block appended to a phase's
 * system prompt for Orca's frozen snapshot, or "" for an empty one. OMP's own discovery stays off, so this list is the
 * only way a skill reaches the model. Checked before any spawn; a violation is `omp-skills-source-invalid:<detail>`.
 */
export async function ompSkillsPromptBlock(skillsRoot: string, worktreePath: string): Promise<string> {
  try {
    if (!isAbsolute(skillsRoot) || await realpath(skillsRoot) !== skillsRoot || !(await lstat(skillsRoot)).isDirectory()) throw invalid("root");
  } catch (error) {
    if ((error as Error).message?.startsWith("omp-skills-source-invalid:")) throw error;
    throw invalid("root");
  }
  const withinWork = relative(resolve(worktreePath), skillsRoot);
  if (withinWork === "" || (!withinWork.startsWith("..") && !isAbsolute(withinWork))) throw invalid("inside-worktree");
  const entries: string[] = [];
  for (const name of (await readdir(skillsRoot)).sort()) {
    const path = join(skillsRoot, name);
    const stat = await lstat(path);
    if (name === "syncskill-lock.json" && stat.isFile()) continue;
    if (!stat.isDirectory() || await realpath(path) !== path) throw invalid(`child-${name}`);
    const skillMd = join(path, "SKILL.md");
    let mdStat;
    try { mdStat = await lstat(skillMd); } catch { throw invalid(`skill-md-${name}`); }
    if (mdStat.isSymbolicLink()) throw invalid(`skill-md-link-${name}`);
    if (!mdStat.isFile()) throw invalid(`skill-md-${name}`);
    const description = oneLineDescription(await readFile(skillMd, "utf8")) ?? NO_DESCRIPTION;
    entries.push(`- ${name}: ${description} (SKILL.md: ${skillMd})`);
  }
  if (entries.length === 0) return "";
  return [
    "<skills>",
    "These skills were frozen for this task. When one matches the work, read its SKILL.md with the read tool before acting on it.",
    ...entries,
    "</skills>",
  ].join("\n");
}
