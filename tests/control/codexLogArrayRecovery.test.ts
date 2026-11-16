import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "../../src/control/protocol.js";
import { atomicReplacePrivateFile } from "../../src/control/paths.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { savedResultPath } from "../../src/control/savedResultEvidence.js";
import { readSavedResultSourceEligibility } from "../../src/control/savedResultRecovery.js";
import { resultFixture } from "./taskResultFixture.js";
import { sealCodex } from "./agentsFixture.js";

async function arrayLogSource(f: Awaited<ReturnType<typeof resultFixture>>) {
  f.contract.executionPolicy.tokenBudget = 25;
  f.input.contractHash = canonicalHash(f.contract);
  const fake = join(f.root, "array-log-execute.mjs");
  await writeFile(fake, `import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('9.9.9-fake');process.exit(0)}
if(!process.argv.includes('exec')){process.stdout.write(process.argv.includes('mcp')?'[]\\n':process.argv.includes('models')?'{"models":[]}\\n':'',()=>process.exit(0));await new Promise(()=>{})}
for await(const part of process.stdin){}
const args=process.argv,s=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
const phase=s.properties?.result?'execute':s.properties?.approved?'verify':'plan';
if(phase==='verify')throw Error('verification must not enter');
if(phase==='execute')writeFileSync('answer.txt','complete\\n');
const value=phase==='plan'?{summary:'write answer',primaryTargetPaths:['answer.txt']}:{result:{changedFiles:['answer.txt'],diffPatch:'',commandOutputs:[],stdoutStderrLog:['first','second']}};
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(value));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`);
  const sealed = await sealCodex({ command: [process.execPath, fake], model: "fixture", sandbox: "workspace-write", budgetMode: "soft", timeoutMs: 10000, killGraceMs: 50 });
  f.input.claim.agent = sealed.selection; f.input.claim.configHash = sealed.configHash;
  await atomicReplacePrivateFile(f.sourceDir, join(f.sourceDir, "control/config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(f.sourceDir, join(f.sourceDir, "control/envelope.json"), Buffer.from(canonicalJson(f.input)));
  await writeAccepted(f.sourceDir, { protocol: 1, envelopeHash: canonicalHash(f.input), executionId: "execution-1", configHash: sealed.configHash, generation: 1,
    acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
  await runControlWorker(["--source-dir", f.sourceDir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  const response = await f.rpc("saved-result-evidence", { input: f.input });
  if (response.code !== 0) throw new Error(response.stderr);
  return JSON.parse(response.stdout) as { capsule: { artifactId: string; hash: string } | null };
}

type Ref = { artifactId: string; hash: string };
async function sourcePackage(f: Awaited<ReturnType<typeof resultFixture>>, capsule: Ref) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codex-log-source-")));
  await chmod(dir, 0o700);
  const fetched = await f.rpc("read-saved-result-evidence", { input: f.input, capsuleRef: capsule, ref: capsule });
  if (fetched.code !== 0) throw new Error(fetched.stderr);
  const capsuleBytes = Buffer.from(JSON.parse(fetched.stdout).base64, "base64");
  const content = JSON.parse(capsuleBytes.toString());
  const snapshot = JSON.parse((await readFile(savedResultPath(f.sourceDir, content.snapshot))).toString());
  const isRef = (value: unknown): value is Ref => value !== null && typeof value === "object" && "artifactId" in value && "hash" in value;
  const refs: Ref[] = [capsule, content.snapshot, content.verifier.proof,
    ...Object.values(content.artifacts).flatMap((value) => Array.isArray(value) ? value : [value]).filter(isRef),
    ...(content.artifacts.usageObservations ?? []).map((entry: { copy: Ref }) => entry.copy),
    snapshot.index, snapshot.bundle, snapshot.status, ...snapshot.files.map((file: { ref: Ref }) => file.ref)];
  const seen = new Set<string>(), artifacts: Array<{ ref: Ref; file: string }> = [];
  for (const ref of refs) {
    if (seen.has(ref.artifactId)) continue;
    seen.add(ref.artifactId);
    const bytes = ref.artifactId === capsule.artifactId ? capsuleBytes : await readFile(savedResultPath(f.sourceDir, ref));
    const file = `blob-${artifacts.length}.bin`;
    await writeFile(join(dir, file), bytes, { mode: 0o600 });
    artifacts.push({ ref, file });
  }
  const manifest = { schema: "ccloop-saved-result-source-package-v1", authorityKind: "execution-complete-before-verification-v1", source: capsule, artifacts };
  await writeFile(join(dir, "package.json"), canonicalJson(manifest), { mode: 0o600 });
  return { dir, hash: canonicalHash(manifest) };
}

it("keeps a Codex array-log execute as a completed source before verification (#316)", async () => {
  const f = await resultFixture();
  try {
    const page = await arrayLogSource(f);
    expect(JSON.parse(await readFile(join(f.runDir, "loop-state.json"), "utf8")).status).toBe("exhausted");
    expect(page.capsule, existsSync(join(f.runDir, "saved-result", "exhausted-candidate-unavailable.json"))
      ? await readFile(join(f.runDir, "saved-result", "exhausted-candidate-unavailable.json"), "utf8") : "missing source").not.toBeNull();
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("reads the published Codex array-log completion source without changing its stored execution shape", async () => {
  const f = await resultFixture();
  let packageDir: string | null = null;
  try {
    const page = await arrayLogSource(f);
    if (page.capsule === null) throw new Error("array-log completion source missing");
    const pkg = await sourcePackage(f, page.capsule);
    packageDir = pkg.dir;
    const eligible = await readSavedResultSourceEligibility({ source: f.input, sourceAttempt: 1, packagePath: pkg.dir, packageHash: pkg.hash });
    expect(eligible, JSON.stringify(eligible)).toMatchObject({ status: "eligible", authorityKind: "execution-complete-before-verification-v1", rawExecutionTokens: 15 });
  } finally {
    if (packageDir !== null) await rm(packageDir, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);
