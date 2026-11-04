# Task setup commands (ccloop half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loop contract may carry `context.setupCommands`; ccloop runs them in every attempt worktree before the agent's first phase and ends the run `setup-failed` (phase `setup`, measured zero usage) when one fails or changes the tree.

**Architecture:** One new module runs and fingerprints setup; `runLoopFromState` calls it between budget consumption and the first phase; the cause, phase and contract field are widened where they are declared and parsed. Absent `setupCommands` leaves every byte as today.

**Tech Stack:** TypeScript, zod, vitest, git.

**Spec:** Orca `docs/superpowers/specs/2026-11-04-task-setup-and-check-retry-design.md` (§4.4, §4.5, §5, §6.2 rows 16–19). Orca plan for the other half: Orca `docs/superpowers/plans/2026-11-04-task-setup-and-check-retry.md`.

## Global Constraints

- This repository's `CLAUDE.md` governs (Rule 13–18). **No existing criterion is rewritten.** If a task finds one that must change, stop and ask the human by name.
- Mutations only in a built `git clone --local` copy (`npm run build` first); restore proven by `git diff | wc -c` = 0 and `git diff --cached | wc -c` = 0, via `rtk proxy … > file`.
- `context.setupCommands`: optional, no default, `z.array(z.string().min(1).max(4096).regex(/^[^\r\n]*$/)).min(1).max(8)`.
- Cause `"setup-failed"`, phase `"setup"`, `retries: 0`, `detail` through `causeDetail` (512 B): `<command> exit=<n>` | `<command> timeout` | `<command> changed: <paths joined by ", ">`.
- Per-command limit `SETUP_COMMAND_TIMEOUT_MS = 900_000`, capped by the attempt's remaining time.
- Setup log: `<runDir>/attempts/<n>/setup-<i>.log` (i from 1), stdout and stderr interleaved, streamed (not buffered), 0600.
- `setup-failed` is not in `RETRYABLE_CAUSES`.
- Merge into main with `--ff-only`; push is the human's.

## Review Focus

1. A setup command that reads stdin (an installer prompt) must not hang until the time limit: stdin is `/dev/null`. Test in Task 2.
2. Setup that prints more than 10 MiB (a verbose `npm ci`) must not fail for buffer size: output is streamed to the log. Test in Task 2.
3. A handoff or stop during setup ends the run the way any abort does, not as `setup-failed`. Test in Task 2.
4. A continuation's first attempt (restored predecessor tree) with setup that writes only ignored files passes the fingerprint. Test in Task 2.
5. After a setup failure the attempt worktree is removed (Orca's archive walk must never see `node_modules`). Test in Task 2.

---

### Task 1: The contract field, the cause and the phase

**Files:**
- Modify: `src/contract/schema.ts:50-62` (context)
- Modify: `src/runtime/failureCause.ts:9-17,26` (`FAILURE_CAUSES`, `RunFailureCauseV1.phase`)
- Modify: `src/control/command.ts:215-218` (collect's `failureCause.phase` enum)
- Test: `tests/contract/setupAbsent.test.ts` (new), `tests/runtime/failureCause.test.ts` (add cases)

**Interfaces:**
- Produces: `LoopContract["context"]["setupCommands"]?: string[]`; `FailureCauseV1` includes `"setup-failed"`; `RunFailureCauseV1["phase"]` is `"plan" | "execute" | "verify" | "setup" | null`.

- [ ] **Step 1: Write the failing tests**

`tests/contract/setupAbsent.test.ts`, modelled on `tests/contract/toolRulesAbsent.test.ts`:
- `"a contract without setupCommands parses to the committed golden bytes"`: `canonicalJson(loopContractSchema.parse(RAW_CONTRACT)) + "\n"` equals `tests/fixtures/toolRules/golden-2a2ae53/contract.json`, and `"setupCommands" in parsed.context` is `false`.
- `"setupCommands is kept as given and bounded"`: parse with `["npm ci"]` ⇒ `parsed.context.setupCommands` equals `["npm ci"]`; `[]`, 9 entries, `"a\nb"`, `""` each throw.

`tests/runtime/failureCause.test.ts`:
- `"setup-failed is a cause and is not retryable"`: `FAILURE_CAUSES` contains it; `RETRYABLE_CAUSES.has("setup-failed")` is `false`.
- `"collect accepts a setup-phase cause"`: the collect response schema in `src/control/command.ts` parses `{cause:"setup-failed",phase:"setup",retries:0,detail:"npm ci exit=1"}`.

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/contract/setupAbsent.test.ts tests/runtime/failureCause.test.ts > <log> 2>&1`; the bounded-setup and setup-phase cases fail.
- [ ] **Step 3: Implement** the three declarations above (the field after `additionalRepos`, no default).
- [ ] **Step 4: Run, expect PASS**, plus `npx vitest run tests/contract tests/runtime/failureCause.test.ts tests/runtime/omp/ompToolRules.test.ts` and `npm run typecheck`.
- [ ] **Step 5: Mutations in the clone** — M1 give the field `.default([])` ⇒ golden case red; M2 drop `"setup"` from the collect enum ⇒ collect case red; M3 add `"setup-failed"` to `RETRYABLE_CAUSES` ⇒ red. Restore, 0 bytes.
- [ ] **Step 6: Commit** `feat(contract): an optional context.setupCommands, the setup-failed cause and the setup phase`

### Task 2: Run setup in every attempt

**Files:**
- Create: `src/controller/setupCommands.ts`
- Modify: `src/controller/runLoop.ts` (between `continuation` at ~1835 and `if (!continuation || continuation.nextPhase === "plan")` at ~1840; `RunControlHooks` ~1543)
- Modify: `src/control/worker.ts:262-273` (the new hook, beside `onRecoveryAttemptEntered`)
- Test: `tests/controller/setupCommands.test.ts` (new, unit), `tests/controller/setupRunLoop.test.ts` (new, through `runLoop` with `ScriptedAdapter` and `tests/controller/optionalFixture.ts`), `tests/control/setupWorker.test.ts` (new, collect through the worker)

**Interfaces:**
- Consumes: Task 1's types; `worktreeSnapshot(root: string): Promise<string>` and `observedChangedPaths(root: string): Promise<string[]>` (`src/runtime/omp/worktreeSnapshot.ts:12,39`); `persistTerminalState` (runLoop ~1367); `causeDetail` (failureCause.ts:31); `cleanupAttemptWorkspaceWithStatus` (runLoop ~548).
- Produces:
  - `export const SETUP_COMMAND_TIMEOUT_MS = 900_000;`
  - `export type SetupOutcome = { ok: true } | { ok: false; command: string; detail: string };`
  - `export async function runSetupCommands(commands: readonly string[], worktreePath: string, logDir: string, signal: AbortSignal | undefined, timeLeftMs: number): Promise<SetupOutcome>` — each command `spawn("sh", ["-lc", cmd], { cwd, stdio: ["ignore", fd, fd], signal })` with its own process group, killed on time limit; abort rethrows as today's abort error; after all commands, compares `worktreeSnapshot` taken before the first and after the last, and on a difference names `observedChangedPaths` that are new or changed versus before.
  - `RunControlHooks.onSetupFailed?: (input: { attempt: number }) => Promise<void>`; the worker appends `{observationId: "attempt-<n>-setup", threadTotalTokens: 0, elapsedMs: 0, attempts: n, sessions: 1, evidence: {kind: "setup-failed-attempt-v1", runId, generation, attempt: n}}` (when `envelope.protocol === 4 && !usageKnown`, `threadTotalTokens` follows today's rule).

- [ ] **Step 1: Write the failing unit tests** (`setupCommands.test.ts`, a temp git repo with `.gitignore` = `node_modules/`):
  - `"runs every command in order in the worktree"`: two commands append to an ignored file ⇒ `{ok:true}`, file has both lines in order.
  - `"a non-zero exit names the command"`: `["true", "exit 3"]` ⇒ `{ok:false, command:"exit 3", detail:"exit 3 exit=3"}`.
  - `"a command over its time limit is killed"`: `timeLeftMs` 200, `sleep 5` ⇒ `detail` ends with ` timeout`, elapsed < 2000 ms.
  - `"writing a tracked or untracked non-ignored file fails"`: `echo x > new.txt` ⇒ `detail` = `"echo x > new.txt changed: new.txt"`.
  - `"stdin is closed"` (Review Focus 1): `read x; echo got` ⇒ `{ok:true}` in < 2000 ms.
  - `"20 MiB of output is streamed to the log"` (Review Focus 2): `head -c 20971520 /dev/zero | tr '\0' a` ⇒ `{ok:true}`, `setup-1.log` size ≥ 20971520, mode 0600.
  - `"an abort rethrows, not a setup failure"` (Review Focus 3): abort during `sleep 5` ⇒ the promise rejects with the abort error.
- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement `runSetupCommands`** in `src/controller/setupCommands.ts`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Write the failing loop tests** (`setupRunLoop.test.ts`):
  - `"setup runs before the plan phase"`: contract `setupCommands: ["echo s > node_modules_marker"]` with the marker ignored; the scripted plan frame's adapter records that the marker exists when plan starts.
  - `"a failing setup ends the run setup-failed with no agent call"`: `["exit 2"]` ⇒ terminal `failed`, `failureCause` `{cause:"setup-failed",phase:"setup",retries:0,detail:"exit 2 exit=2"}`, the scripted adapter received 0 calls, `attemptsUsed` 1.
  - `"the attempt worktree is removed after a setup failure"` (Review Focus 5): `<runDir>/worktrees/attempt-1` does not exist after the run.
  - `"a continuation's restored tree passes when setup writes only ignored files"` (Review Focus 4): use `buildBundle()` (`tests/control/optionalMaterializeFixture.ts:52`) for `firstWorkspaceInput` with a modified tracked file; setup `mkdir -p node_modules && touch node_modules/x` ⇒ plan runs.
  - `"absent setupCommands runs no setup"`: no `attempts/1/setup-1.log`.
- [ ] **Step 6: Write the failing worker test** (`setupWorker.test.ts`, using `tests/control/optionalFixture.ts` `fixture()`): collect of a run whose setup fails has `failureCause.cause` `setup-failed` and a usage observation with `threadTotalTokens` 0 (not null) for attempt 1.
- [ ] **Step 7: Run, expect FAIL.**
- [ ] **Step 8: Implement** the call in `runLoopFromState`: when `contract.context.setupCommands` is present, run it with `logDir = <runDir>/attempts/<attempt>` and `timeLeftMs = min(SETUP_COMMAND_TIMEOUT_MS, attempt's remaining time)`; on `{ok:false}` call `options.onSetupFailed?.({attempt})`, then end the attempt through the same cleanup as a failed attempt and `persistTerminalState(..., "failed", "setup failed", {cause:"setup-failed", phase:"setup", retries:0, detail: causeDetail(outcome.detail)})`. Wire `onSetupFailed` in the worker.
- [ ] **Step 9: Run, expect PASS**; `npm run typecheck`.
- [ ] **Step 10: Mutations in the clone** — M4 run setup after plan ⇒ "before the plan phase" red; M5 ignore the exit code ⇒ failing-setup red; M6 skip the fingerprint ⇒ tree case red; M7 drop the `onSetupFailed` call ⇒ worker case red (null usage); M8 skip cleanup on setup failure ⇒ worktree-removed red; M9 stdin `"pipe"` ⇒ stdin case red. Restore, 0 bytes.
- [ ] **Step 11: Commit** `feat(loop): run a contract's setup commands in every attempt before the agent's first phase`

### Task 3: No saved-result recovery with setup

**Files:**
- Modify: `src/control/protocol.ts:450-471` (`validateEnvelopePaths`, beside `control-multi-repo-recovery-unsupported`)
- Test: `tests/control/setupRecoveryRefusal.test.ts` (new, modelled on `tests/control/multiRepoRefusals.test.ts`)

- [ ] **Step 1: Failing test** `"verify-saved-result of a contract with setupCommands is refused by name"`: accept with `mode: "verify-saved-result"` ⇒ throws `control-setup-recovery-unsupported`; the same envelope without `setupCommands` is not refused for that reason.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Mutation** M10 remove the check ⇒ red. Restore.
- [ ] **Step 6: Commit** `feat(control): refuse saved-result recovery of a contract with setup commands`

### Task 4: Gate, review, merge

- [ ] **Step 1:** In a fresh `git clone --local` of the branch tip: `npm ci --prefer-offline`, `npm run build`, typecheck, full vitest `--reporter=json`, `node scripts/check-known-reds.mjs <json>`; RC 0 (a red outside the list: rerun that file alone and compare with untouched main before calling it load).
- [ ] **Step 2:** Independent review of the branch diff (read-only subagent); fix Critical/Important; rerun the affected files.
- [ ] **Step 3:** `git merge --ff-only` into main; update this repository's handoff Orca section in place; push stays with the human. Orca repins after the push (Orca plan Part C).

## As built

(filled at the end)
