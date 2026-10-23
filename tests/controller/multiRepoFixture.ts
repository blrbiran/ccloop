// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §16.1): a primary repository and extra repositories, each
// with a file of its own, so a worktree made from the wrong repository is told apart; and a contract naming them.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LoopContract } from "../../src/contract/schema.js";
import { createContract, createRepo } from "./optionalFixture.js";

export const exec = promisify(execFile);
export const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();

/** A repository whose only file is <key>.txt, committed. */
export async function createKeyedRepo(key: string): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), `ccloop-extra-${key}-`)));
  for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test User"]]) await git(repo, ...args);
  await mkdir(join(repo, key));
  await writeFile(join(repo, key, `${key}.txt`), `${key}\n`);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", `init ${key}`);
  return repo;
}

export type ExtraSpec = { key: string; allowlistPaths?: string[]; denylistPaths?: string[]; requiredChecks?: string[] };

/** createContract's primary (src/** allowed) plus one extra repo per spec, each allowed `<key>/**` by default. */
export async function multiRepoWorld(extras: ExtraSpec[], checks: string[] = ["true"]): Promise<{ primary: string; repos: Record<string, string>; contract: LoopContract }> {
  const primary = await realpath(await createRepo());
  const repos: Record<string, string> = {};
  for (const extra of extras) repos[extra.key] = await createKeyedRepo(extra.key);
  const contract = createContract(primary, checks);
  contract.context.repoKey = "app";
  contract.context.additionalRepos = extras.map(({ key, ...rest }) => ({ key, repoPath: repos[key]!, targetPaths: [`${key}/**`], ...rest }));
  return { primary, repos, contract };
}
