#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { open, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = (path, data) => writeFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2), {mode: 0o600});

async function processes() {
  const {stdout} = await exec("ps", ["-axo", "pid=,pgid=,lstart=,stat="], {env: {...process.env, TZ: "UTC", LC_ALL: "C"}, timeout: 2000});
  return stdout.trim().split("\n").map(line => {
    const fields = line.trim().split(/\s+/);
    return {pid: Number(fields[0]), pgid: Number(fields[1]), startedAt: fields.slice(2, 7).join(" "), stat: fields[7]};
  }).filter(p => p.pid > 1 && p.pgid > 1 && p.stat && !p.stat.startsWith("Z"));
}

async function identityFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, {withFileTypes: true}); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "process.json") files.push(path);
    }
  }
  await walk(root);
  return files;
}

// Only groups registered by this invocation are eligible. If their leader exits,
// a member observed while the leader was alive must still match before signalling.
function watchdog(runDir, output) {
  const groups = new Map();
  const observations = [];
  let chain = Promise.resolve(), timer, observationError;
  const register = identity => {
    if (!Number.isInteger(identity.pid) || identity.pid <= 1 || identity.pgid !== identity.pid || !identity.startedAt) throw new Error("invalid process identity");
    const key = `${identity.pgid}:${identity.startedAt}`;
    if (!groups.has(key)) groups.set(key, {leader: identity, members: new Map()});
  };
  const tick = async () => {
    for (const file of await identityFiles(join(runDir, "codex"))) {
      try { register(await json(file)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    const table = await processes();
    for (const group of groups.values()) {
      const current = table.filter(p => p.pgid === group.leader.pgid);
      const supported = current.some(p => p.pid === group.leader.pid && p.startedAt === group.leader.startedAt)
        || current.some(p => group.members.get(p.pid)?.startedAt === p.startedAt);
      if (supported) for (const p of current) group.members.set(p.pid, p);
      if (current.length) observations.push({at: new Date().toISOString(), pgid: group.leader.pgid, supported, members: current});
    }
    await save(join(output, "process-observations.json"), observations);
  };
  const poll = () => { chain = chain.then(tick).catch(error => { observationError = String(error); }); };
  return {
    async start(pid) {
      const leader = (await processes()).find(p => p.pid === pid);
      if (!leader) throw new Error("CLI identity unavailable");
      register(leader);
      await tick(); timer = setInterval(poll, 100);
    },
    async cleanup(cliPid) {
      clearInterval(timer); await chain; await tick();
      const unresolved = [];
      if (observationError) unresolved.push(observationError);
      // Detached agent groups precede the controller group.
      const ordered = [...groups.values()].sort((a,b) => Number(a.leader.pid === cliPid) - Number(b.leader.pid === cliPid));
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        for (const group of ordered) {
          const current = (await processes()).filter(p => p.pgid === group.leader.pgid);
          if (!current.length) continue;
          if (!current.some(p => p.pid === group.leader.pid && p.startedAt === group.leader.startedAt || group.members.get(p.pid)?.startedAt === p.startedAt)) {
            unresolved.push({reason: "unconfirmed process group", current}); continue;
          }
          try { process.kill(-group.leader.pgid, signal); }
          catch (error) { if (error.code !== "ESRCH") unresolved.push(String(error)); }
        }
        await pause(signal === "SIGTERM" ? 250 : 100);
      }
      const remaining = await processes();
      for (const group of ordered) {
        const live = remaining.filter(p => p.pgid === group.leader.pgid);
        if (live.length) unresolved.push({reason: "remaining group members", live});
      }
      return {unresolved, registered: ordered.map(g => g.leader)};
    }
  };
}

export async function runValidation(options, testing = {}) {
  const {codex, model} = options;
  if (!isAbsolute(codex ?? "") || typeof model !== "string" || !model.trim() || !options.output) throw new Error("codex absolute path, model, and output are required");
  const output = resolve(options.output);
  await mkdir(output, {mode: 0o700}); // Exclusive: never harvest an earlier run.
  const runDir = join(output, "run");
  const summary = {passed: false, cliCode: null, status: null, tokenUsage: null, dollarCost: "unknown", cleanup: {unresolved: []}};
  let monitor, child, done, stdoutFile, stderrFile, outerTimer;
  try {
    const version = await exec(codex, ["--version"], {timeout: 10000});
    await save(join(output, "version.txt"), version.stdout + version.stderr);
    const repo = await mkdtemp(join(output, "repo-"));
    for (const args of [["init"], ["config","user.name","Codex acceptance"], ["config","user.email","acceptance@example.invalid"]]) await exec("git", args, {cwd: repo});
    await save(join(repo, "answer.txt"), "0\n");
    await save(join(repo, "AGENTS.md"), "Only modify answer.txt. Do not access the network, read paths outside this repository, install tools, commit changes, or start subagents. Set answer.txt to exactly 42 followed by a newline when asked to execute. Planning and verification must not modify files.\n");
    await exec("git", ["add", "answer.txt", "AGENTS.md"], {cwd: repo});
    await exec("git", ["commit", "-m", "acceptance fixture"], {cwd: repo});
    const checkPath = join(output, "check.cjs");
    await save(checkPath, 'if(require("fs").readFileSync("answer.txt","utf8")!=="42\\n")process.exit(1);\n');
    const check = `${quote(process.execPath)} ${quote(checkPath)}`;
    const contract = {
      objective: {taskId:"codex-smoke",goal:"Set answer.txt to exactly 42 followed by a newline",successCondition:"answer.txt equals 42 newline",nonGoals:[]},
      context: {repoPath:repo,targetPaths:["answer.txt"],buildTestCommands:[check],constraints:["Only modify answer.txt; no network, installs, commits, or subagents."]},
      executionPolicy: {autonomyLevel:"L2",maxAttempts:1,perAttemptTimeoutMs:120000,totalRuntimeBudgetMs:360000,tokenBudget:100000,worktreeRequired:true,partialOutcomeRecoveryWindowMs:1000},
      safetyPolicy: {allowlistPaths:["answer.txt"],maxFilesTouched:1},
      verification: {verifierType:"agent",requiredChecks:[check],rejectOn:["answer does not equal 42 newline"]},escalationAndExit:{}
    };
    const {loopContractSchema} = await import("../dist/src/contract/schema.js");
    await save(join(output, "contract.json"), loopContractSchema.parse(contract));
    await save(join(output, "adapter.json"), {command:[codex],model,budgetMode:"soft",sandbox:"workspace-write",timeoutMs:120000,killGraceMs:250});
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    stdoutFile = await open(join(output,"cli.stdout.log"), "wx", 0o600);
    stderrFile = await open(join(output,"cli.stderr.log"), "wx", 0o600);
    child = spawn(process.execPath, [cli,"run","--contract",join(output,"contract.json"),"--run-dir",runDir,"--adapter","codex","--adapter-config",join(output,"adapter.json")], {cwd:repo,detached:true,stdio:["ignore",stdoutFile.fd,stderrFile.fd]});
    done = new Promise((resolve, reject) => {child.once("error",reject);child.once("exit",(code,signal)=>resolve({code,signal}));});
    // Attach the deadline before any asynchronous observation work.
    const bounded = Promise.race([done, new Promise((_,reject) => {outerTimer = setTimeout(()=>reject(new Error("outer timeout")), testing.outerTimeoutMs ?? 420000);})]);
    monitor = watchdog(runDir, output);
    await monitor.start(child.pid);
    const exit = await bounded;
    summary.cliCode = exit.code; summary.cliSignal = exit.signal;
    const state = await json(join(runDir,"loop-state.json")); summary.status = state.status;
    if (exit.code !== 0 || state.status !== "succeeded") throw new Error(`controller did not succeed: ${state.stopReason}`);
    const {stdout: answer} = await exec("git", ["show",`refs/ccloop/${basename(runDir)}/attempts/1:answer.txt`], {cwd:repo});
    await save(join(output,"answer.txt"), answer);
    if (answer !== "42\n") throw new Error("independent answer mismatch");
    let tokenUsage = 0;
    for (const phase of ["plan","execute","verify"]) {
      const dir = join(runDir,"codex","1",phase), calls = await readdir(dir);
      if (calls.length !== 1) throw new Error(`expected one ${phase} call`);
      const evidence = join(dir,calls[0]);
      const outcome = await json(join(evidence,"outcome.json")), usage = await json(join(evidence,"usage.json"));
      if (outcome.reason !== "completed" || outcome.code !== 0 || usage.usageStatus !== "present" || !Number.isSafeInteger(usage.normalizedTotal) || usage.normalizedTotal <= 0) throw new Error(`incomplete ${phase} evidence`);
      for (const file of ["schema.json","final.json","process.json","events.jsonl","stderr.log"]) await readFile(join(evidence,file));
      tokenUsage += usage.normalizedTotal;
    }
    summary.tokenUsage = tokenUsage; summary.softBudgetOverrun = Math.max(tokenUsage - 100000, 0);
    if (state.budgetSnapshot.tokenBudgetRemaining !== Math.max(100000 - tokenUsage, 0)) throw new Error("usage accounting mismatch");
    summary.tokenUsage = tokenUsage; summary.passed = true;
  } catch (error) { summary.error = String(error); }
  finally {
    clearTimeout(outerTimer);
    if (monitor) {
      try { summary.cleanup = await monitor.cleanup(child?.pid); }
      catch (error) { summary.cleanup = {unresolved:[String(error)]}; }
    }
    if (child && summary.cleanup.unresolved.length === 0) await done?.catch(()=>{});
    await stdoutFile?.close(); await stderrFile?.close();
    if (summary.cleanup.unresolved.length) summary.passed = false;
    await save(join(output,"summary.json"), summary);
  }
  return summary.passed ? 0 : 1;
}

export async function main(argv) {
  try {
    if (argv.length !== 6) throw new Error("usage: --codex <absolute-bin> --model <name> --output <new-dir>");
    const options = {};
    for (let i=0;i<argv.length;i+=2) {
      if (!["--codex","--model","--output"].includes(argv[i]) || options[argv[i].slice(2)] !== undefined) throw new Error("invalid arguments");
      options[argv[i].slice(2)] = argv[i+1];
    }
    return await runValidation(options);
  } catch (error) { console.error(String(error)); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
