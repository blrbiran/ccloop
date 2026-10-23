// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.1, §16.1 C2): the start envelope's optional
// `work.additionalRepos` names each extra repository's target and base, in the contract's order. At accept every extra
// `targetRepo` is absolute and every extra contract `repoPath` is a canonical directory, and the repositories are
// pairwise distinct with none inside another; anything else is `control-request-invalid`.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlRequest } from "../../src/control/protocol.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
// Review I1: accept reads each working repository's git common directory, so every repoPath is a repository of its own.
const gitInit = (path: string) => { execFileSync("git", ["init", "-q"], { cwd: path }); };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function world(keys = ["lib", "docs"]) {
  const { root, envelope } = await fixture(); roots.push(root);
  gitInit(root);
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "ccloop-multi-repo-"))); roots.push(elsewhere);
  const dirs: Record<string, string> = {};
  for (const key of keys) { dirs[key] = join(elsewhere, key); await mkdir(dirs[key]!); gitInit(dirs[key]!); }
  const contract = { ...envelope.work.contract, context: { ...envelope.work.contract.context, repoKey: "app",
    additionalRepos: keys.map((key) => ({ key, repoPath: dirs[key]!, targetPaths: ["src/**"] })) } };
  const work = { ...envelope.work, contract, additionalRepos: keys.map((key) => ({ key, targetRepo: join(elsewhere, `target-${key}`), base: "main" })) };
  return { envelope: { ...envelope, work }, dirs, elsewhere };
}
type Env = Awaited<ReturnType<typeof world>>["envelope"];
const refuses = (envelope: unknown) => expect(() => parseControlRequest("accept", envelope)).toThrow("control-request-invalid");
const withWork = (envelope: Env, work: Record<string, unknown>) => ({ ...envelope, work: { ...envelope.work, ...work } });
const withExtras = (envelope: Env, additionalRepos: unknown) => ({ ...envelope, work: { ...envelope.work,
  contract: { ...envelope.work.contract, context: { ...envelope.work.contract.context, additionalRepos } } } });

describe("work.additionalRepos on the start envelope (C2)", () => {
  it("accepts a valid multi-repo envelope on protocol 3 and 4, kept as given", async () => {
    const { envelope } = await world();
    expect(parseControlRequest("accept", envelope)).toEqual(envelope);
    const v4 = { ...envelope, protocol: 4 as const };
    expect(parseControlRequest("accept", v4)).toEqual(v4);
  });

  it("refuses work keys that are not the contract's keys in the contract's order", async () => {
    const { envelope } = await world();
    const [lib, docs] = envelope.work.additionalRepos;
    refuses(withWork(envelope, { additionalRepos: [docs, lib] }));
    refuses(withWork(envelope, { additionalRepos: [lib] }));
    refuses(withWork(envelope, { additionalRepos: undefined }));
    const { additionalRepos: _drop, ...single } = envelope.work;
    refuses({ ...envelope, work: { ...single, additionalRepos: [lib] } as typeof envelope.work });
  });

  it("refuses a relative extra targetRepo and an extra repoPath that is not a canonical directory", async () => {
    const { envelope, dirs } = await world();
    const [lib, docs] = envelope.work.additionalRepos;
    refuses(withWork(envelope, { additionalRepos: [{ ...lib!, targetRepo: "relative/lib" }, docs] }));
    const extras = envelope.work.contract.context.additionalRepos;
    refuses(withExtras(envelope, [{ ...extras[0]!, repoPath: join(dirs.lib!, "missing") }, extras[1]]));
    refuses(withExtras(envelope, [{ ...extras[0]!, repoPath: "relative/lib" }, extras[1]]));
  });

  it("refuses equal or nested repositories", async () => {
    const { envelope, dirs } = await world();
    const extras = envelope.work.contract.context.additionalRepos;
    refuses(withExtras(envelope, [extras[0], { ...extras[1]!, repoPath: dirs.lib! }])); // equal
    await mkdir(join(dirs.lib!, "inner"));
    gitInit(join(dirs.lib!, "inner")); // a repository of its own: only the nesting check refuses it
    refuses(withExtras(envelope, [extras[0], { ...extras[1]!, repoPath: join(dirs.lib!, "inner") }])); // nested
    await mkdir(join(envelope.work.contract.context.repoPath, "inside"), { recursive: true });
    gitInit(join(envelope.work.contract.context.repoPath, "inside"));
    refuses(withExtras(envelope, [extras[0], { ...extras[1]!, repoPath: join(envelope.work.contract.context.repoPath, "inside") }])); // inside the primary
    const [lib, docs] = envelope.work.additionalRepos;
    refuses(withWork(envelope, { additionalRepos: [lib, { ...docs!, targetRepo: lib!.targetRepo }] })); // equal targets
    refuses(withWork(envelope, { additionalRepos: [lib, { ...docs!, targetRepo: join(lib!.targetRepo, "x") }] })); // nested targets
  });
});
