// Crash resume (2026-10-02), spec §3.1, plan Task 3: a stand-in for the ccloop process that owns a claude phase runner.
// It spawns scripts/claude-phase-runner.mjs exactly the way ClaudeAgentAdapter does (detached, a fourth "pipe" on fd 3
// that it never writes, CCLOOP_PARENT_WATCH_FD=3), so a criterion can SIGKILL this process and watch what the runner does.
//
// argv[2]: one JSON object {command, graceMs, cwd, request, lingerChild?, noRequest?}
//   command      the claude argv tuple (CCLOOP_CLAUDE_COMMAND)
//   graceMs      CCLOOP_PARENT_GONE_GRACE_MS
//   request      the phase request written on the runner's stdin (skipped with noRequest: Review Focus 4)
//   lingerChild  also start an unrelated long-lived child of this process (not detached, stdio "ignore"): criterion T2
// Prints one JSON line {"runner": <pid>, "linger": <pid|null>} on its stdout, then idles until killed.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const config = JSON.parse(process.argv[2]);
const runnerPath = fileURLToPath(new URL("../../scripts/claude-phase-runner.mjs", import.meta.url));
const runner = spawn(process.execPath, [runnerPath], {
  cwd: config.cwd,
  detached: true,
  stdio: ["pipe", "pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CCLOOP_CLAUDE_COMMAND: JSON.stringify(config.command),
    CCLOOP_PARENT_WATCH_FD: "3",
    CCLOOP_PARENT_GONE_GRACE_MS: String(config.graceMs),
  },
});
// The runner's output is drained and dropped; nothing here is under test but the runner's death.
runner.stdout.resume();
runner.stderr.resume();
runner.stdin.on("error", () => {});
if (config.noRequest !== true) runner.stdin.end(JSON.stringify(config.request));
const linger = config.lingerChild === true ? spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }) : null;
process.stdout.write(`${JSON.stringify({ runner: runner.pid, linger: linger?.pid ?? null })}\n`);
setInterval(() => {}, 1000);
