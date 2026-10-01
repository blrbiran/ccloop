# Consolidation Step 1 (one claude adapter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `SubprocessClaudeAdapter` and `--adapter claude`, keep every runner criterion, retire the v1 toolchain's claude part, make `ClaudeAgentAdapter` return the partial execute result the runner writes after SIGTERM, and move Orca's handoff grace to the new stop bound.

**Architecture:** `ClaudeAgentAdapter.execute` gains one post-stop branch and a longer stop grace; everything that only existed for the old adapter is deleted or moved; Orca's `handoffGraceMsOf` takes the run's frozen recovery window.

**Tech Stack:** TypeScript (NodeNext), vitest, Node child processes, git.

**Spec:** ccloop `docs/superpowers/specs/2026-10-01-claude-adapter-consolidation-step1-design.md` (read §1–§10 and the addendum §11 before starting).

## Global Constraints

- Code, comments, commit messages, ledgers: English. Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Published comments (anything on `origin/main`) keep their words; append `*** ERRATUM (consolidation step 1, 2026-10-01, Orca session be653b22, ruling R5) … ***` at the END of the comment block. No counts, no "HEAD"/"remote tip" in an erratum.
- Only the criteria named in spec §7 may be deleted or rewritten. Any other existing criterion: do not touch; if one goes red, stop and report.
- `PARTIAL_FLUSH_MARGIN_MS = 5_000` on both sides; each side's comment names the other file.
- No `git push`, no merge, no branch/worktree deletion. Work on `main` of each repo (local commits only).
- Mutations only in a `git clone --local` copy under the session scratchpad; never in the main trees.
- Every verification run: redirect to a file and read it back whole; no `| grep`/`| tail` on a verification run.
- Use `/bin/rm`, `cat src > dst` (local `rm`/`cp` carry `-i`). Git checks with `/usr/bin/git`.
- ccloop focused runs: `./node_modules/.bin/vitest run <file> > out.txt 2>&1; echo RC=$? >> out.txt`.

## Review Focus

1. A stop that arrives after claude already answered (runner prints a complete result, exit 0) — execute must return that result, plan/verify must still throw (Task 1 criteria "complete after stop" and "plan after stop").
2. `killGraceMs` far below the recovery window — the partial must still arrive, and the group must still be gone afterwards (Task 1 grace criterion).
3. A stopped execute with a clean worktree — behaviour identical to today (`null` or `ClaudePhaseAborted`), pinned by the existing N4 and grandchild criteria, which must stay green untouched.
4. Usage on a returned partial — observed value, never 0, never overwriting a reported `tokenUsage` (Task 1 usage criteria).
5. Orca: a run with no start envelope yet (handoff before start) — grace must not grow (Task 4 criterion "no envelope").

---

### Task 1: `ClaudeAgentAdapter` returns the post-stop execute result (ccloop)

**Files:**
- Modify: `tests/fixtures/fake-claude-cli.mjs` (add modes; append ERRATUM-free header line describing them — the header is published, so add the new-mode description as a new comment line after the existing header block, do not edit existing lines)
- Modify: `src/runtime/claude/claudeAgentAdapter.ts`
- Test: `tests/runtime/claude/claudeAgentAdapter.test.ts` (new `describe` block at the end)

**Interfaces:**
- Produces: `export const PARTIAL_FLUSH_MARGIN_MS = 5_000` in `claudeAgentAdapter.ts`; fake-claude-cli modes `write-then-hang`, `write-quiet-then-hang`, `write-ignore-term`, `write-then-fail`, `answer-then-linger`.

- [ ] **Step 1: Add the fixture modes.** In `fake-claude-cli.mjs`, before the `if (mode === "usage-then-hang" …)` chain, add:

```js
// Consolidation step 1 (2026-10-01, ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md §7.4):
// "write-then-hang" writes partial.txt (400 kB) in its cwd, under stream-json emits init + one closed message, then
// hangs; "write-quiet-then-hang" the same without any stream event; "write-ignore-term" writes partial.txt, ignores
// SIGTERM and hangs; "write-then-fail" writes partial.txt and exits 1; "answer-then-linger" answers like "ok", leaves a
// grandchild holding its stdout (so the runner's close waits), writes <marker>.answered and exits 0.
const PARTIAL_BYTES = "x".repeat(400_000) + "\n";
if (mode === "write-then-hang" || mode === "write-quiet-then-hang" || mode === "write-ignore-term" || mode === "write-then-fail") {
  writeFileSync("partial.txt", PARTIAL_BYTES);
  if (mode === "write-ignore-term") process.on("SIGTERM", () => {});
  if (mode === "write-then-hang" && stream) { await emitInit(); await emitClosedMessage(); }
  writeFileSync(`${marker}.wrote`, "1");
  if (mode === "write-then-fail") { process.stderr.write("fake-claude-cli: failing after a write\n"); process.exit(1); }
  setInterval(() => {}, 1000);
}
```

Place it after the `emitClosedMessage` definition (it uses `stream`, `emitInit`, `emitClosedMessage`), and turn the existing `if (mode === "usage-then-hang" …)` into `else if` only if needed for control flow — simplest: wrap the new block so the existing chain is reached only for other modes (`if (NEW_MODES.has(mode)) { … } else if (mode === "usage-then-hang" …`). For `answer-then-linger`, treat it like `ok` in the final `else` branch, and after `await respond()` add:

```js
if (mode === "answer-then-linger") {
  spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "ignore"] });
  writeFileSync(`${marker}.answered`, "1");
  process.exit(0);
}
```

- [ ] **Step 2: Write the failing criteria.** Append to `claudeAgentAdapter.test.ts` (reuse its `fixture()`, `alive`, `cleanup`, `exec`; extend `fixture`'s mode union with the five new modes). Helper:

```ts
// Consolidation step 1 (ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md §5, §7.3, §7.4; ruling R5).
describe("ClaudeAgentAdapter, the execute result written after a stop (consolidation step 1)", () => {
  const withWindow = (f: Awaited<ReturnType<typeof fixture>>, windowMs: number): AttemptContext => ({
    ...f.context,
    contract: { ...f.context.contract, executionPolicy: { ...f.context.contract.executionPolicy, partialOutcomeRecoveryWindowMs: windowMs } },
  });
  const waitFor = (path: string) => expect.poll(() => existsSync(path), { timeout: 10_000 }).toBe(true);
```

Criteria (each `20_000` ms timeout unless stated):

1. `"rewritten (R5) from SubprocessClaudeAdapter's large-partial criterion: an aborted execute with a changed worktree returns the runner's partial"` — mode `write-quiet-then-hang`; start `execute` with an `AbortController`; `await waitFor(\`${f.marker}.wrote\`)`; abort; result must `toMatchObject({ completionStatus: "partial", failureType: "timeout", changedFiles: ["partial.txt"] })`, `diffPatch` contains `diff --git a/partial.txt b/partial.txt` and `.length > 350_000`, and `"tokenUsage" in result` is `false`.
2. `"a returned partial carries the usage observed before the stop"` — mode `write-then-hang`; wait for `.wrote` AND for the call's `observed-usage.json` to show `openMessage === false` (copy the poll from `abortWhenObserved`); abort; `result.tokenUsage` is `1109`.
3. `"an execute stopped by the adapter's own timeout returns the partial"` — mode `write-quiet-then-hang`, installation `{ timeoutMs: 1_500 }`; no abort; result `toMatchObject({ completionStatus: "partial", failureType: "timeout" })`.
4. `"the partial still arrives when the recovery window is longer than killGraceMs"` — mode `write-ignore-term`, installation `{ killGraceMs: 300 }`, context `withWindow(f, 3_000)`; wait `.wrote`; abort; result is a partial with `changedFiles: ["partial.txt"]`; afterwards the fake claude's pid (from the marker JSON) is not `alive` (poll 2 000 ms). Test timeout 30_000.
5. `"rewritten (R5) from SubprocessClaudeAdapter's partial-outcome criterion: a runner that fails during execute returns its partial"` — mode `write-then-fail`; no abort; result `toMatchObject({ completionStatus: "partial", failureType: "error", changedFiles: ["partial.txt"] })`.
6. `"a complete answer written after a stop is returned for execute"` — mode `answer-then-linger`; wait `.answered`; abort; result `toMatchObject({ changedFiles: ["answer.txt"] })` and has no `completionStatus`.
7. `"a plan stopped after its answer still throws ClaudePhaseAborted"` — mode `answer-then-linger`, call `plan`; wait `.answered`; abort; rejection is `instanceof ClaudePhaseAborted`. Use `.then(() => { throw new Error("resolved"); }, (e) => e)`.

Close the `describe`.

- [ ] **Step 3: Run, expect red.** `./node_modules/.bin/vitest run tests/runtime/claude/claudeAgentAdapter.test.ts > s1.txt 2>&1`. Expected: 1–6 fail (criterion 4 may fail by `null`/throw), 7 passes (it is the guard M1 targets). Every pre-existing criterion in the file passes.

- [ ] **Step 4: Implement.** In `claudeAgentAdapter.ts`:

```ts
/**
 * Consolidation step 1 (2026-10-01, ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md §5.3): on execute
 * the group gets this long past the recovery window before SIGKILL, so the runner can stop claude, read git and print
 * its partial. Mirrored by Orca src/control/driverHandoff.ts (PARTIAL_FLUSH_MARGIN_MS), whose handoff grace waits it.
 */
export const PARTIAL_FLUSH_MARGIN_MS = 5_000;
```

- Add `stopGraceMs?: number` to `ClaudeCall`; in `run`, the kill timer uses `call.stopGraceMs ?? installation.killGraceMs`.
- `phase<T>(request, context, afterStop?: { stopGraceMs: number })`: pass `{ ...this.call(context), ...(afterStop ? { stopGraceMs: afterStop.stopGraceMs } : {}) }` to `run`. Then, before the existing `aborted` check:

```ts
if (afterStop !== undefined && (outcome.reason === "aborted" || outcome.reason === "timeout") && outcome.code === 0 && outcome.signal === null) {
  const written = parseObject(outcome.stdout);
  if (written !== undefined) {
    const usageEvidence = (written as { usageEvidence?: unknown }).usageEvidence;
    if (usageEvidence !== undefined) await writeFile(join(outcome.evidenceDir, "usage.json"), JSON.stringify(usageEvidence, null, 2), { mode: 0o600 });
    if ((written as { tokenUsage?: unknown }).tokenUsage === undefined) {
      const observed = await readObservedTokens(join(outcome.evidenceDir, OBSERVED_USAGE_FILE));
      if (observed !== null) (written as { tokenUsage?: number }).tokenUsage = observed;
    }
    return written as T;
  }
}
```

  with a module-level `const parseObject = (text: string): object | undefined => { try { const v: unknown = JSON.parse(text); return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; } };` (do not refactor the existing parse sites).
- `execute` passes `{ stopGraceMs: Math.max(this.config.installation.killGraceMs, context.contract.executionPolicy.partialOutcomeRecoveryWindowMs + PARTIAL_FLUSH_MARGIN_MS) }`. Its catch block is unchanged.
- Append the ERRATUM to the header comment block (lines starting `// Orca agent selection (2026-09-26), spec §4.7`): the sentence "SubprocessClaudeAdapter stays as it was (spec §11)" no longer holds — consolidation step 1 deleted it; this adapter now also returns the execute result the runner writes after a stop (spec path above).

- [ ] **Step 5: Run, expect green.** Same command → all criteria in the file pass. Then `./node_modules/.bin/vitest run tests/runtime/claude tests/runtime/phaseTimeoutUsage.test.ts tests/control > s1b.txt 2>&1` → no new red (known reds per `scripts/check-known-reds.mjs` excepted).
- [ ] **Step 6: Typecheck** `npm run typecheck > tc.txt 2>&1` RC 0.
- [ ] **Step 7: Commit** `feat(claude): return the execute result the runner writes after a stop, with the usage observed before it`.

### Task 2: delete `SubprocessClaudeAdapter`, move the runner criteria (ccloop)

**Files:**
- Create: `tests/runtime/claude/claudePhaseRunner.test.ts`
- Delete: `src/runtime/claude/subprocessClaudeAdapter.ts`, `tests/runtime/claude/subprocessClaudeAdapter.test.ts`, `tests/fixtures/fake-claude.mjs`, `examples/v1/claude-adapter-config.json`
- Modify: `src/runtime/claude/types.ts` (drop `SubprocessAdapterConfig`), `src/cli.ts`, `tests/runtime/claude/stderrDecoding.test.ts`, `tests/controller/runLoop.integration.test.ts`, `scripts/check-known-reds.mjs`, `README.md`, and ERRATA in: `src/sweep/sweepRuns.ts` (two comment blocks), `scripts/claude-phase-runner.mjs`, `tests/runtime/claude/claudeAgentAdapter.test.ts` (header), `tests/runtime/claude/claudePhaseRunnerEnv.test.ts` (header), `tests/runtime/claude/claudePhaseRunnerStream.test.ts` (two comments), `tests/fixtures/fake-claude-cli.mjs` (header).

**Interfaces:** Consumes Task 1's adapter. Produces describe name `claude phase runner`.

- [ ] **Step 1: Create `claudePhaseRunner.test.ts`.** Copy `subprocessClaudeAdapter.test.ts` verbatim, then: remove the `SubprocessClaudeAdapter` import and the module-level `adapter` constant; rename `describe("SubprocessClaudeAdapter", …)` to `describe("claude phase runner", …)`; delete exactly these five `it` blocks: `passes phase context through the wrapper and parses structured JSON`, `preserves partial execute outcomes returned by the wrapper`, `waits for close before parsing wrapper stdout`, `returns null when aborted execute yields no final result`, `parses a large partial execute payload after wrapper interruption`; delete `createNodeScript` if now unused. Every other line stays byte-identical. Add at the top: `// Consolidation step 1 (2026-10-01, ccloop spec …-step1-design.md §7.1, ruling R5): moved unchanged from tests/runtime/claude/subprocessClaudeAdapter.test.ts when SubprocessClaudeAdapter was deleted; these criteria drive scripts/claude-phase-runner.mjs directly or test the prompt builders.`
- [ ] **Step 2: Prove the move.** Write a python check into the scratchpad that extracts every `it(` block body from the old file and the new file and asserts the kept blocks are byte-identical and the five named ones are absent. Output to file, read back. Expected: all kept blocks identical.
- [ ] **Step 3: Delete** the old test file, `subprocessClaudeAdapter.ts`, `tests/fixtures/fake-claude.mjs` (re-grep first: no user besides the deleted test and a comment in `fake-claude-cli.mjs`), `examples/v1/claude-adapter-config.json`, `SubprocessAdapterConfig` (re-grep: no user).
- [ ] **Step 4: CLI.** In `src/cli.ts`: remove the import; the three `adapter` unions become `"scripted" | "codex"`; both validity checks drop `"claude"`; `buildAdapter`'s parameter type drops `"claude"` and its last line becomes `return new CodexAdapter(config);` with the `codex` branch folded (keep `if (adapter === "scripted") …` then `return new CodexAdapter(config);`). `src/sweep/sweepRuns.ts`'s `adapterName` type is NOT narrowed (spec addendum §11: a sweep criterion prints `adapter=claude` through it and is not in R5's list).
- [ ] **Step 5: stderrDecoding.** Delete the `it("SubprocessClaudeAdapter's error carries …")` block and the now-unused import.
- [ ] **Step 6: runLoop integration criterion.** Rename `"persists phase usage evidence from the subprocess adapter without recomputing controller totals"` to `"persists phase usage evidence from the claude agent adapter without recomputing controller totals"`; build the adapter as

```ts
const adapter = new ClaudeAgentAdapter({
  schema: "ccloop-agent-config-v1", kind: "claude",
  installation: { kind: "claude", command: [join(fakeBinDir, "claude")], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
  selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
});
```

  (import `ClaudeAgentAdapter`; drop the `SubprocessClaudeAdapter` import; keep the `PATH` set/restore lines only if still needed — they are not: remove them and the `originalPath` variable, keeping the `try` body). All assertions stay. Add `// Rewritten (consolidation step 1, ruling R5): …` naming the spec. If the fake's prompt matching fails because the runner hands the prompt on stdin for large prompts, read it from stdin when the last argv is not the prompt (the runner passes it as the last argument for these sizes — verify by running). Run the file; it must pass.
- [ ] **Step 7: Known reds.** In `scripts/check-known-reds.mjs` rename the two entries: `SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute` → `claude phase runner > waits for close before interrupting a close-pending successful execute`; the runLoop name → the new name. Add a comment line above the first renamed entry: `// Consolidation step 1 (2026-10-01): two names renamed with their criteria; five run-scenario names removed with theirs.`
- [ ] **Step 8: README.** §3.2 and §3.4: `--adapter claude` → `--adapter scripted`, `examples/v1/claude-adapter-config.json` → `examples/v1/scripted-adapter-config.json`, and after each block add one line (Chinese, matching the README): `claude 的 run 由 \`run --agents\` 起；在 #4 做完之前，\`resume\`／\`sweep\` 还不能续跑它们。` §6.2 (`claude`——真跑): replace its config example and the sentence introducing it with a short paragraph saying claude now runs only through `run --agents <table> --agent-selection <file>` / `control`, and that `scripts/claude-phase-runner.mjs` is what `ClaudeAgentAdapter` spawns; keep the runner bullet list. Line ~378 ("跑通之后再把 `--adapter` 换成 `claude` …"): rewrite to point at `run --agents`. Re-grep README for `claude-adapter-config` and `--adapter claude` → zero.
- [ ] **Step 9: ERRATA.** For each comment listed under Files, append an ERRATUM at the end of its block, naming what changed: the adapter was deleted in consolidation step 1; the stand-ins / criteria now live in `tests/runtime/claude/claudePhaseRunner.test.ts`; `fake-claude.mjs` was deleted. Then re-run the scan (`SubprocessClaudeAdapter|subprocessClaudeAdapter|subprocess adapter|fake-claude\.mjs` over `src scripts tests validation README.md`, output to file) and confirm every remaining hit is either inside an ERRATUM, in a criterion name that stays true (`claudePhaseRunnerStream.test.ts` "older SubprocessClaudeAdapter stand-ins"), or in files Task 3 deletes.
- [ ] **Step 10: Verify.** typecheck RC 0; `./node_modules/.bin/vitest run tests/runtime tests/controller/runLoop.integration.test.ts tests/cli > s2.txt 2>&1`; only known-red names may fail.
- [ ] **Step 11: Commit** `refactor(claude): delete SubprocessClaudeAdapter and --adapter claude; the runner criteria move unchanged`.

### Task 3: retire the v1 toolchain's claude part (ccloop)

**Files:**
- Delete: `validation/v1/scripts/run-scenario.ts`, `validation/v1/scripts/prepare-a04.ts`, `validation/v1/lib/a04.ts`, `tests/validation/prepareA04.test.ts`
- Modify: `tests/validation/evidence.test.ts` (delete the `describe("run-scenario CLI", …)` block and imports only it used), `validation/v1/README.md`, `scripts/check-known-reds.mjs`

- [ ] **Step 1:** Re-list the 44 `prepareA04.test.ts` names and the 10 `run-scenario CLI` names from a fresh read into the ledger; compare with spec §7.2 (any difference: stop and report).
- [ ] **Step 2:** Delete the files; delete the `run-scenario CLI` describe block; remove imports that become unused (typecheck tells).
- [ ] **Step 3:** `validation/v1/README.md`: replace the sections `## A-04 mechanical prepare (no paid call)` and each `npx --no-install tsx validation/v1/scripts/run-scenario.ts …` code block with one paragraph at the first such place: `> Retired (2026-10-01, ccloop consolidation step 1): run-scenario.ts and prepare-a04.ts drove ccloop through --adapter claude, which no longer exists. Paid real-claude acceptance now goes through Orca's acceptance script. The evidence these scripts produced stays where it is.` and at every later code block a one-line pointer to that paragraph. Keep all other text.
- [ ] **Step 4:** `check-known-reds.mjs`: delete the five `run-scenario CLI > …` entries (keep their comment lines only if they still describe a remaining entry).
- [ ] **Step 5:** typecheck RC 0; `./node_modules/.bin/vitest run tests/validation > s3.txt 2>&1` passes (known reds excepted); `npm run build` RC 0.
- [ ] **Step 6: Commit** `chore(validation): retire run-scenario and prepare-a04, which only drove --adapter claude`.

### Task 4: Orca's handoff grace waits the execute stop bound (Orca)

**Files:**
- Modify: Orca `src/control/driverHandoff.ts` (`handoffGraceMsOf`, new `recoveryWindowOf`, `settleIfPastGrace`, `PARTIAL_FLUSH_MARGIN_MS`), ERRATA in `src/control/driverHandoff.ts` (the comment above `handoffGraceMsOf`), `src/control/executionDriver.ts:71` comment, `src/panel/controlAssembly.ts:247` comment.
- Test: `tests/panel/assemblyHandoffGrace.test.ts`, `tests/control/agentFreeze.test.ts` (the two named criteria), plus one wiring criterion in the existing test file that exercises `settleIfPastGrace` (find it: grep tests for `handoff-grace-elapsed`).

**Interfaces:**
- Produces: `handoffGraceMsOf(run: { killGraceMs?: unknown }, recoveryWindowMs: unknown): number`; `recoveryWindowOf(envelope: StartEnvelope): unknown`; `export const PARTIAL_FLUSH_MARGIN_MS = 5_000`.

- [ ] **Step 1: Rewrite the two named criteria and add new ones (red first).**

```ts
// assemblyHandoffGrace.test.ts, the named criterion, rewritten under ruling R5 (ccloop consolidation step 1):
expect(HANDOFF_EXTRA_GRACE_MS).toBe(60_000);
expect(PARTIAL_FLUSH_MARGIN_MS).toBe(5_000);
expect(handoffGraceMsOf({ killGraceMs: 5_000 }, 0)).toBe(65_000);
expect(handoffGraceMsOf({ killGraceMs: 0 }, 0)).toBe(65_000);       // max(0, 0 + 5_000) + 60_000
for (const killGraceMs of [-1, 1.5, "5000", null, undefined]) expect(handoffGraceMsOf({ killGraceMs }, 0)).toBe(120_000);
expect(handoffGraceMsOf({}, 0)).toBe(120_000);
// new criterion "waits the recovery window plus the margin when that is longer than killGraceMs"
expect(handoffGraceMsOf({ killGraceMs: 5_000 }, 70_000)).toBe(135_000);
expect(handoffGraceMsOf({ killGraceMs: 30_000 }, 1_000)).toBe(90_000);
// new criterion "an unusable recovery window falls back to the ceiling grace"
for (const w of [-1, 1.5, "1000", null, undefined]) expect(handoffGraceMsOf({ killGraceMs: 5_000 }, w)).toBe(120_000);
// new criterion "reads the window from a loop envelope's frozen contract; a single call has none"
expect(recoveryWindowOf({ work: { kind: "loop", contract: { executionPolicy: { partialOutcomeRecoveryWindowMs: 60_000 } } } } as StartEnvelope)).toBe(60_000);
expect(recoveryWindowOf({ work: { kind: "single-call" } } as StartEnvelope)).toBe(0);
expect(recoveryWindowOf({ work: { kind: "loop", contract: {} } } as StartEnvelope)).toBeUndefined();
```

  Note `killGraceMs: 0` changes from 60_000 to 65_000 — the rewritten line must say so in its comment. The `agentFreeze.test.ts` criterion: `handoffGraceMsOf({ killGraceMs: 7_000 }, 0)` → `7_000 + HANDOFF_EXTRA_GRACE_MS`; unusable killGraceMs with window 0 → 120_000; add `handoffGraceMsOf({ killGraceMs: 7_000 }, 60_000)` → `65_000 + HANDOFF_EXTRA_GRACE_MS`. Each rewritten criterion gets a comment naming the ccloop spec and R5.
  Wiring criterion: in the test file that already drives `settleIfPastGrace` to `handoff-grace-elapsed`, add one where the run's frozen contract has `partialOutcomeRecoveryWindowMs: 70_000` and `killGraceMs: 5_000`, without the `handoffGraceMs` seam: at `deadline + 65_001` the request is not settled; at `deadline + 135_001` it is `outcome-unknown`. If no harness reaches it without the seam, add the criterion at the smallest level that does (a unit test of an exported helper `graceFor(deps, run)` that `settleIfPastGrace` calls) — record which in the ledger.
- [ ] **Step 2: Run, expect red** (`./node_modules/.bin/vitest run tests/panel/assemblyHandoffGrace.test.ts tests/control/agentFreeze.test.ts <wiring file> > s4.txt 2>&1`).
- [ ] **Step 3: Implement.**

```ts
/** ccloop consolidation step 1 (ccloop src/runtime/claude/claudeAgentAdapter.ts, PARTIAL_FLUSH_MARGIN_MS): ccloop waits this past the recovery window before it kills an execute. */
export const PARTIAL_FLUSH_MARGIN_MS = 5_000;
const usableMs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function handoffGraceMsOf(run: { killGraceMs?: unknown }, recoveryWindowMs: unknown): number {
  if (!usableMs(recoveryWindowMs)) return 120_000;
  const killGraceMs = usableMs(run.killGraceMs) ? run.killGraceMs : 60_000;
  return Math.max(killGraceMs, recoveryWindowMs + PARTIAL_FLUSH_MARGIN_MS) + HANDOFF_EXTRA_GRACE_MS;
}
/** The frozen contract's partialOutcomeRecoveryWindowMs; 0 for a single call (it has no execute to stop). */
export function recoveryWindowOf(envelope: StartEnvelope): unknown {
  if (envelope.work.kind !== "loop") return 0;
  const contract = envelope.work.contract as { executionPolicy?: { partialOutcomeRecoveryWindowMs?: unknown } } | null;
  return contract?.executionPolicy?.partialOutcomeRecoveryWindowMs;
}
```

  In `settleIfPastGrace`: `const window = run.drive?.envelopeHash == null ? 0 : recoveryWindowOf(readStartEnvelope(deps.store, run));` (no envelope ⇒ ccloop never started ⇒ nothing to wait for) and pass it as the second argument. Update every other caller (`grep handoffGraceMsOf src`). Append ERRATA to the three comments.
- [ ] **Step 4: Green.** Same run passes; then `./node_modules/.bin/vitest run tests/control tests/panel > s4b.txt 2>&1` → only known load flakes red, each 3/3 green alone; `npm run typecheck` RC 0.
- [ ] **Step 5: Commit** `fix(control): the handoff grace waits ccloop's execute stop bound, the recovery window plus five seconds`.

### Task 5: mutations and gate

- [ ] **Step 1:** ccloop clone: `git clone --local` into the scratchpad, symlink `node_modules`, `npm run build`. Run M1–M6 (spec §8) one at a time against `tests/runtime/claude/claudeAgentAdapter.test.ts`; each: apply with a python anchor replace (assert one hit), run, record which criterion is red, restore with `cat` from the main tree, prove `git diff | wc -c` and `git diff --cached | wc -c` are `0`. Also: **M9** — `execute` passes no `afterStop` (whole branch off) → criteria 1–6 red. Orca clone: M7, M8, and **M10** — `settleIfPastGrace` passes `0` instead of the window → the wiring criterion red.
- [ ] **Step 2:** Gate exactly as spec §10, ccloop and Orca both in fresh clones (Orca's `ORCA_CCLOOP_BIN` = the ccloop clone's `dist/cli.js`).
- [ ] **Step 3:** Ledger `.superpowers/sdd/2026-10-01-claude-adapter-consolidation/progress.md` (ccloop; `git add -f`), one section per task with commit subject lines, mutation table, gate numbers with the commands that produced them.
