# rejectOn as the verifier's judgment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ccloop stops overriding an approving verifier by substring-searching evidence for `rejectOn`; the verifier prompt tells the verifier to reject when a condition holds.

**Architecture:** Remove the `rejectOn` branch of `enforceVerificationContract` (src/controller/runLoop.ts); change one line of `buildVerifierPrompt` (src/runtime/claude/prompts.ts, shared by all three model adapters). Contract schema unchanged. Docs follow.

**Tech Stack:** TypeScript, vitest, Node `child_process` (`sh -lc` for required checks).

**Spec:** `docs/superpowers/specs/2026-10-01-rejecton-verifier-judgment-design.md` (option D; human approved 2026-10-01).

## Global Constraints

- New prompt line, exactly: `Reject-on conditions (if any of these holds for this attempt, approved must be false):`
- `evidenceRequired` behavior and `evidenceIncludes` unchanged.
- Contract schema unchanged (`rejectOn: z.array(z.string()).min(1)`).
- Existing criteria: only `tests/runtime/claude/subprocessClaudeAdapter.test.ts` "includes plan, execution, rejectOn, and evidenceRequired in the verifier prompt" may change (human named it, 2026-10-01: "点名改写必要的test"). Its rewrite carries a comment naming that ruling (CLAUDE.md Rule 15 (c)).
- Mutations only in a `git clone --local` copy (Rule 17); verification runs redirected to a file and read whole (Rule 14).
- `dist/` is rebuilt, never edited.

## Review Focus

1. A check command whose own text contains the token (`echo "tests fail"`): after the change it must not reject either — covered by Task 1's mutation step, which shows the command-text path is separate from the output path.
2. A verifier that rejects by itself while naming a token: must keep its own `rejectCategory` and `safeToRetry` (unchanged path) — Task 1 test 3.
3. `evidenceRequired` still enforced after the branch is gone (approval with a missing label → `missing-required-evidence`) — Task 1 test 4.
4. A contract whose `rejectOn` is the dead placeholder (`REJECT:unused`, as Orca writes) — no behavior difference; covered by tests 1–2 using a non-placeholder token.
5. Old persisted `recentFailures` holding `"reject-on-matched"` — load unchanged (type is `z.string()`); no code reads the value, no task.

---

### Task 1: Controller no longer overrides approvals on rejectOn

**Files:**
- Modify: `src/controller/runLoop.ts:225-257` (`enforceVerificationContract`)
- Test: `tests/controller/runLoop.integration.test.ts` (new `describe` at the end of the file)

**Interfaces:**
- Consumes: `runLoop(contract, runDir, adapter)`, `ScriptedAdapter`, `createRepo`, `createContract`, `readRunState` (all in the test file / src today).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests** — append to `tests/controller/runLoop.integration.test.ts`:

```ts
// Spec 2026-10-01-rejecton-verifier-judgment-design.md (human ruling 2026-10-01, option D): rejectOn is a condition
// for the verifier to judge; ccloop no longer substring-searches evidence for it. Orca measured a real approving
// verifier quoting the rule ("...so REJECT:empty-document does not apply") and the old search failed that good work.
describe("rejectOn is the verifier's judgment, not a search over evidence", () => {
  const frame = (verification: Record<string, unknown>) => ({
    plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
    execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
    verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, pauseSignals: [], stopSignals: [], ...verification },
  });

  it("an approving agent verifier that quotes the rule, or names it alone, still succeeds", async () => {
    const contract = createContract(await createRepo()); // rejectOn ["tests fail"], requiredChecks ["true"]
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = new ScriptedAdapter([frame({ evidence: ["no failures, so tests fail does not apply", "tests fail"] })]);
    const finalState = await runLoop(contract, runDir, adapter);
    expect(finalState.status).toBe("succeeded");
    expect(finalState.attemptsUsed).toBe(1);
  });

  it("a command verifier whose passing check prints the token still succeeds", async () => {
    const base = createContract(await createRepo());
    // The token is only in the check's output: the command text holds an octal escape, not "tests fail".
    const contract: LoopContract = { ...base, verification: { ...base.verification, verifierType: "command", requiredChecks: ["printf 'tests\\040fail\\n'"] } };
    expect(contract.verification.requiredChecks[0]).not.toContain("tests fail");
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = new ScriptedAdapter([frame({ evidence: [] })]);
    const finalState = await runLoop(contract, runDir, adapter);
    expect(finalState.status).toBe("succeeded");
  });

  it("a rejecting verifier keeps its own category and retry choice", async () => {
    const base = createContract(await createRepo());
    const contract: LoopContract = { ...base, executionPolicy: { ...base.executionPolicy, maxAttempts: 1 } };
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = new ScriptedAdapter([frame({ approved: false, rejectCategory: "tests-red", safeToRetry: true, evidence: ["tests fail"] })]);
    const finalState = await runLoop(contract, runDir, adapter);
    expect(finalState.status).toBe("exhausted");
    expect(finalState.recentFailures.at(-1)).toMatchObject({ category: "tests-red" });
  });

  it("evidenceRequired is still enforced on an approval", async () => {
    const base = createContract(await createRepo());
    const contract: LoopContract = { ...base, executionPolicy: { ...base.executionPolicy, maxAttempts: 1 }, verification: { ...base.verification, evidenceRequired: ["coverage report"] } };
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = new ScriptedAdapter([frame({ evidence: ["looks good"] })]);
    const finalState = await runLoop(contract, runDir, adapter);
    expect(finalState.status).not.toBe("succeeded");
    expect(finalState.recentFailures.at(-1)).toMatchObject({ category: "missing-required-evidence" });
  });
});
```

Before trusting tests 3 and 4, the implementer reads `RunState.recentFailures` in `src/state/types.ts` and the place
`runLoop.ts` appends to it, and adjusts the field name (`category` above) and the terminal status to what the code
actually records — reading back, not guessing (Rule 8). Record the adjustment in the task report.

- [ ] **Step 2: Run, expect tests 1 and 2 red, 3 and 4 green**

Run: `./node_modules/.bin/vitest run tests/controller/runLoop.integration.test.ts -t "verifier's judgment" > $SCRATCH/t1-red.txt 2>&1; echo RC=$?` then read the file whole.
Expected: RC 1; tests 1 and 2 fail with `expected 'failed' to be 'succeeded'` (or the attempt's reject path); tests 3 and 4 pass (they pin unchanged paths).

- [ ] **Step 3: Remove the branch** — in `enforceVerificationContract`, the function becomes:

```ts
function enforceVerificationContract(contract: LoopContract, verification: VerificationResult): VerificationResult {
  if (!verification.approved) {
    return verification;
  }

  // rejectOn is a condition the verifier judges (it is in the verifier prompt); ccloop does not search evidence for
  // it. A substring cannot tell "occurred" from "mentioned" (spec 2026-10-01-rejecton-verifier-judgment-design.md).
  const missingEvidence = contract.verification.evidenceRequired.filter(
    (requiredEvidence) => !evidenceIncludes(verification.evidence, requiredEvidence),
  );

  if (missingEvidence.length === 0) {
    return verification;
  }

  return {
    ...verification,
    approved: false,
    rejectCategory: "missing-required-evidence",
    safeToRetry: false,
    evidence: [...verification.evidence, `missing required evidence: ${missingEvidence.join(", ")}`],
  };
}
```

- [ ] **Step 4: Run, expect all four green**

Same command to `$SCRATCH/t1-green.txt`. Expected RC 0, 4 passed. Then the whole file to `$SCRATCH/t1-file.txt`: RC 0.

- [ ] **Step 5: Mutations (clone only)** — in `$SCRATCH/t1-mut` (`git clone --local`, symlink `node_modules`, copy the uncommitted files in with `cat`, `cmp` each):
  - M1: put the old `rejectOn` branch back → tests 1 and 2 red.
  - M2: on the M1 code, change test 2's check to `echo "tests fail"` and its output to nothing (`echo "tests fail" > /dev/null`) → still red: the command text alone also triggered the old branch. Record it as the evidence that the criterion measures output, not command text (spec §5).
  - M3: make `missingEvidence` always empty → test 4 red.
  Restore with `cat` from the main tree; prove with `git diff | wc -c` and `git diff --cached | wc -c` equal to the pre-mutation byte counts.

- [ ] **Step 6: Commit**

```bash
git add src/controller/runLoop.ts tests/controller/runLoop.integration.test.ts
git commit -m "fix(runLoop): stop overriding an approving verifier because its evidence mentions a rejectOn condition"
```

### Task 2: Verifier prompt says what rejectOn means

**Files:**
- Modify: `src/runtime/claude/prompts.ts:60`
- Test: `tests/runtime/claude/subprocessClaudeAdapter.test.ts:287-318` (named criterion)

- [ ] **Step 1: Rewrite the named criterion first** — replace the line asserting the old text:

```ts
    // Rewritten under the human's 2026-10-01 ruling (rejectOn spec, option D; "点名改写必要的test"): the verifier is
    // told to reject when a condition holds, not that ccloop searches evidence for it.
    expect(prompt).toContain("Reject-on conditions (if any of these holds for this attempt, approved must be false):");
    expect(prompt).not.toContain("when present in evidence");
```

- [ ] **Step 2: Run, expect red** — `vitest run tests/runtime/claude/subprocessClaudeAdapter.test.ts -t "verifier prompt"` to `$SCRATCH/t2-red.txt`; expected RC 1 on the new `toContain`.

- [ ] **Step 3: Change the prompt line** in `buildVerifierPrompt`:

```ts
    "Reject-on conditions (if any of these holds for this attempt, approved must be false):",
```

- [ ] **Step 4: Run, expect green** — same command to `$SCRATCH/t2-green.txt`, RC 0. Then `grep -rn "when present in evidence" src tests` → no hits (read the output file whole).

- [ ] **Step 5: Mutation (clone)** — restore the old line → the criterion red. Restore and prove as in Task 1.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/claude/prompts.ts tests/runtime/claude/subprocessClaudeAdapter.test.ts
git commit -m "fix(prompts): tell the verifier to reject when a rejectOn condition holds"
```

### Task 3: Docs, ledger, handoff

**Files:**
- Modify: `README.md:189`
- Modify (append only): `docs/superpowers/specs/2026-07-14-loop-engineer-framework-design.md` (new section at the end)
- Create: `.superpowers/sdd/2026-10-01-rejecton-verifier-judgment/progress.md` (`git add -f`)
- Modify: `docs/handoff/handoff.md` (Orca section: lines describing the substring rule as current/open, and awaitingHuman)

- [ ] **Step 1: README** — line 189 becomes:

```
    "rejectOn": ["tests fail"],   // 至少一个；交给 verifier 判断的拒绝条件，ccloop 不在 evidence 里搜它。command verifier 下不起作用——按输出拒绝请写成检查命令（如 ! grep -q 'tests fail' out.log）
```

- [ ] **Step 2: Framework spec correction** — append:

```markdown
## Correction (2026-10-01): rejectOn

`rejectOn` (§ Verification) is a condition the verifier judges; it is listed in the verifier prompt. ccloop does not
search evidence for it: a substring search turned approvals that merely mentioned a condition into failures with no
retry. For `verifierType: "command"` it has no effect; a condition on check output is written as a check. Design:
`docs/superpowers/specs/2026-10-01-rejecton-verifier-judgment-design.md`.
```

- [ ] **Step 3: Ledger** — `progress.md` with: the human's rulings quoted (spec §1, "D（原方案，我仍然推荐）", "点名改写必要的test"); per task: commit subject, red/green file names, mutation table with restore byte counts; the gate (Task 4).

- [ ] **Step 4: Handoff** — in the Orca section, the `rejectOn` item becomes done (commit subjects), the dependency bullet says `rejectOn` is prompt-only, awaitingHuman drops it; add: Orca must repin to get it and correct its comments (spec §6).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-14-loop-engineer-framework-design.md docs/handoff/handoff.md
git add -f .superpowers/sdd/2026-10-01-rejecton-verifier-judgment/progress.md
git commit -m "docs: rejectOn is the verifier's judgment; README, framework spec correction, ledger, handoff"
```

### Task 4: Gate

- [ ] **Step 1:** fresh `git clone --local` in the session scratchpad, symlink `node_modules`, `npm run build`; HOME and the four XDG roots redirected; `TMPDIR=$(mktemp -d /private/tmp/cl-XXXX)`.
- [ ] **Step 2:** `npm run typecheck`, `npm test -- --reporter=default --reporter=json --outputFile.json=$F/cc.json`, `node scripts/check-known-reds.mjs $F/cc.json`, `node scripts/check-tmp-leak.mjs`; each redirected to a file, RC recorded, read whole.
- [ ] **Step 3:** Expected: typecheck/build RC 0; only `stopProof` red (or a name on the known list, re-run alone 3/3 after load drops, `uptime` recorded); `check-known-reds` RC 0; `check-tmp-leak` RC 0. Record in the ledger and commit it.
