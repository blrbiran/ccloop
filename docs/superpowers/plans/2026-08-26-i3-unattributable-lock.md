# I-3(b) 不可归属的转移锁 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一把永远清不掉的 owner-transfer 锁在操作员面前说真话，并指向 `ccloop unlock`。

**Architecture:** `tryRecoverStaleOwnerTransferLock` 的 `Promise<boolean>` 换成三态判别式返回值；不可归属那一格获得一个**兄弟**错误类 `OwnerTransferLockUnattributableError`；两条会打到操作员脸上的链（`resume` 与 transfer）各加一支显式分支。人裁 83 的失败关闭语义逐格不变。

**Tech Stack:** TypeScript (ESM, NodeNext)、vitest 2.1.9、Node `node:fs/promises`。

**Spec:** `docs/superpowers/specs/2026-08-26-i3-unattributable-lock-design.md`

## Global Constraints

- **授权边界**：人裁 106（开 I-3(b) ＋ 红线函数返回类型）＋ 人裁 107（指名改写一条既有判据）。**越界即事故。**
- **只许改写一条既有判据**：`tests/persistence/fileStore.test.ts` 的 `it("keeps a malformed lock without staged artifacts non-recoverable")`。其余一律**只加不改**。
- **注释铁律**：`src/**` 里**已发布**的注释**一字不改**，更正一律**追加具名 ERRATUM**，且 erratum **放在整个注释块末尾**。erratum 里**不许写计数**，**不许引用会移动的 git 引用**。
- **改注释必须按【行号 ＋ 整行锚点】插入**，插之前断言那一行**逐字相符**，不符就退出、文件一字不动。
- **不许 push。** 开门／合并／删分支或 worktree／push 四件需人单独授权。
- **变异只在 `git clone --local` 副本里做**，主仓库工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**。
- **验证性命令一律 `rtk proxy … > 文件` 再整份读回**，绝不 `grep`/`tail`/`head` 过滤（管道会吞退出码）。
- **测试环境变量**：`ECC_GATEGUARD=off DISABLE_OMC=1`。
- **本机 `rm`／`cp` 有 `-i` alias** ⇒ 一律 `/bin/rm -rf` 和 `cat pristine > target`。
- **已知 flake 四条**（负载下超时，非回归）：`records env names only …`、`persists phase usage evidence…`、`runLoop > accounts an execute timeout that rejects after the abort as exhaustion`、`run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data`。红了先看是否 `Test timed out in 5000ms` ＋ 总耗时是否异常（~29s vs 17–22s），单独重跑那个文件再下结论。
- **基线**：`35 files / 604 tests` 零 skipped。本计划新增 **5** 条判据 ⇒ 收尾预期 **609**。

---

### Task 1: 三态返回值 ＋ 兄弟错误类 ＋ 分抛

**Files:**
- Modify: `src/persistence/fileStore.ts`（`OwnerTransferLockBusyError` 类之后；`tryRecoverStaleOwnerTransferLock`；`acquireOwnerTransferLock` 的 EEXIST 分支）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: 无（本计划第一个任务）
- Produces:
  - `export class OwnerTransferLockUnattributableError extends Error`（`name === "OwnerTransferLockUnattributableError"`）
  - `type StaleOwnerTransferLockOutcome = { kind: "cleared" } | { kind: "holder-alive"; pid: number } | { kind: "unattributable"; why: "unparseable" | "no-pid-holder" }`（**模块内私有，不导出**）
  - `tryRecoverStaleOwnerTransferLock(runDir: string): Promise<StaleOwnerTransferLockOutcome>`（**模块内私有**）

- [ ] **Step 1: 改写人裁 107 指名的那一条判据**

在 `tests/persistence/fileStore.test.ts` 中，找到 `it("keeps a malformed lock without staged artifacts non-recoverable", async () => {`。
**整条改写**其断言部分——保留 fixture 与「malformed ⇒ 拒绝」的事实，加上类型判别与操作员指路：

```ts
    // §3 + 人裁 106／107：malformed-and-non-recoverable 不再是 lock-BUSY 那一类。一把无法归属到
    // 任何进程的锁永远不会自己清，所以它拿到自己的兄弟类；而 fileStore.ts 的兄弟房规要求它与 busy
    // 那个**两个方向都不许混**。消息还必须带上唯一能清掉它的那条命令 —— 看不见逃生舱的操作员，
    // 正是 I-3 点名的那个缺陷。
    const error = await writeOwnerTransferArtifacts(
      runDir,
      initialOwnerRecord,
      transfer.nextOwnerRecord,
      transfer.transferRecord,
    ).then(
      () => {
        throw new Error("expected writeOwnerTransferArtifacts to reject, but it resolved");
      },
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(OwnerTransferLockUnattributableError);
    expect(error).not.toBeInstanceOf(OwnerTransferLockBusyError);
    expect(String(error)).toContain("ccloop unlock");
```

⚠️ **用 `.then(onFulfilled, onRejected)` 而不是 `.catch((e) => e)`**：后者在 promise **成功**时会安静地给出 `undefined`，
于是三条 `expect` 全都在断言 `undefined`，判据变成空转。这正是本包两次栽过的「绿可能是空的」。

并在文件的 import 块中加入 `OwnerTransferLockUnattributableError`（与 `OwnerTransferLockBusyError` 同一处导入）。

- [ ] **Step 2: 跑它，确认真红**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npx vitest run tests/persistence/fileStore.test.ts > /tmp/t1.txt 2>&1; echo "RC=$?" >> /tmp/t1.txt; cat /tmp/t1.txt
```
Expected: **FAIL** —— `OwnerTransferLockUnattributableError` 这个符号还不存在，整个文件无法解析。
⚠️ **必须亲眼看到红。** 这一轮的「先红」是真的，不是变异模拟出来的。

- [ ] **Step 3: 加兄弟错误类**

在 `src/persistence/fileStore.ts` 中，锚点是 `OwnerTransferLockBusyError` 类定义的收尾 `}`。**紧随其后**插入：

```ts

// Sibling of OwnerTransferLockBusyError and OwnerTransferPreconditionError, and deliberately NOT a
// subclass of either — the doctrine stated directly above, applied to a third meaning. A subclass
// would let every existing `instanceof OwnerTransferLockBusyError` branch keep matching, silently
// retaining retry behaviour that is only ever correct for a lock that clears on its own. This one
// never clears: no process can be attributed to it, so nothing will ever release it, and the only
// route past it is the human typing `ccloop unlock`. Human ruling 106 (I-3(b)).
export class OwnerTransferLockUnattributableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerTransferLockUnattributableError";
  }
}
```

- [ ] **Step 4: 加返回类型，并在红线函数的注释块末尾追加 ERRATUM**

锚点：`async function tryRecoverStaleOwnerTransferLock(runDir: string): Promise<boolean> {` 这一整行。
**先断言该行逐字相符**，再在其**上方**插入类型定义：

```ts
// Human ruling 106 (I-3(b)): the boolean this used to return conflated two answers a caller must
// tell apart — a lock a LIVE holder is using (transient: it clears when that process exits) and a
// lock NOBODY can be attributed to (permanent: nothing will ever release it). Both were `false`, so
// every caller could only say one thing about them, and that thing was false for the second.
// Human ruling 83's fail-closed semantics are unchanged cell for cell: the only exit that deletes a
// lock is still "contents parse + `pid:<n>` holder + that process is not alive".
type StaleOwnerTransferLockOutcome =
  | { kind: "cleared" }
  | { kind: "holder-alive"; pid: number }
  | { kind: "unattributable"; why: "unparseable" | "no-pid-holder" };
```

⚠️ **函数体内那一整块已发布的注释（含 Mi-2／人裁 94 的 ERRATUM）一个字都不许动。**
在**整个注释块的末尾**（即紧接在 `*** ERRATUM (Mi-2, HUMAN RULING 94) … ***` 那一段收尾之后、`try {` 之前）追加：

```ts
  // *** ERRATUM (I-3(b), HUMAN RULING 106) — "returns false and leaves the lock on disk" above is
  // kept verbatim and still describes exactly what happens; only the VALUE changed. This function
  // no longer returns a boolean. Those exits now return { kind: "unattributable", why: … }, the
  // live-holder exit returns { kind: "holder-alive", pid }, and the two former `true` exits return
  // { kind: "cleared" } — so a caller can finally tell a lock that will clear on its own from one
  // that never will. NO exit gained or lost the right to delete: the single deleting exit is
  // unchanged, and ruling 83's wording above governs it verbatim. Which criterion pins which exit
  // is recorded in the ledger, not here. ***
```

- [ ] **Step 5: 改写函数体**

把签名改为 `Promise<StaleOwnerTransferLockOutcome>`，并把出口逐条替换（**顺序与条件一格不变**）：

```ts
  try {
    lockContents = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "cleared" };
    }

    throw error;
  }
```

注释块之后的判别部分，由原来的单一 `try` 拆成逐条：

```ts
  let pid: number | null;

  try {
    const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
    pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
  } catch {
    return { kind: "unattributable", why: "unparseable" };
  }

  if (pid === null) {
    return { kind: "unattributable", why: "no-pid-holder" };
  }

  // isProcessActive now sits OUTSIDE the try above, where it used to sit inside. That is safe only
  // because it is total: `process.kill(pid, 0)` inside its own try, ESRCH => false, every other
  // errno => true. It has no throw for the removed catch to have been catching. This is pinned by
  // the EPERM criterion in fileStore.test.ts, not by this sentence.
  if (isProcessActive(pid)) {
    return { kind: "holder-alive", pid };
  }

  await safeUnlink(lockPath);
  return { kind: "cleared" };
```

- [ ] **Step 6: 改调用点分抛**

锚点：`      if (!(await tryRecoverStaleOwnerTransferLock(runDir))) {` 这一整行（在 `acquireOwnerTransferLock` 的 EEXIST 分支里）。
**先断言逐字相符**，整段替换为：

```ts
      const outcome = await tryRecoverStaleOwnerTransferLock(runDir);

      if (outcome.kind === "unattributable") {
        // Human ruling 106 (I-3(b)). The busy message below is TRUE for a live holder — a transfer
        // really is in progress — so it is kept byte for byte. It was only ever false HERE, where
        // nobody holds the lock and no transfer is running. This exit names the reason and the one
        // command that can clear it. `ccloop unlock <runDir>` without --force refuses and prints
        // the `--force --expect <digest>` line itself, so the operator's next step comes from that
        // command rather than being duplicated (and left to rot) in this message.
        throw new OwnerTransferLockUnattributableError(
          `owner-transfer lock cannot be attributed to any process (${outcome.why}); ` +
            `it will not clear on its own — inspect it with: ccloop unlock ${runDir}`,
        );
      }

      if (outcome.kind === "holder-alive") {
        throw new OwnerTransferLockBusyError("owner transfer already in progress");
      }
```

⚠️ `cleared` 落空、继续循环 —— 与原来 `true` 的行为**逐字等价**。

- [ ] **Step 6b: 在对账重试处写明「不加代码」也是重决**

⚠️ **这是 spec §4 的消费点 #2，最容易被漏掉，因为它一行代码都不用改。**
锚点：`acquireOwnerTransferLockForReconciliation` 内 `      if (!(error instanceof OwnerTransferLockBusyError)) {` 这一整行。
**先断言逐字相符**，在其**上方**插入：

```ts
      // Human ruling 106 (I-3(b)) re-decided this site and deliberately left it unchanged: an
      // OwnerTransferLockUnattributableError is not an OwnerTransferLockBusyError, so it takes the
      // abandon arm on the FIRST attempt instead of consuming the whole retry bound. That is the
      // wanted answer — this lock will never be released, so every retry is dead time before the
      // same abandonment. The sibling doctrine's warning runs the other way (a SUBCLASS silently
      // KEEPING a match); this is a match deliberately LOST, recorded here so it is not later
      // mistaken for an oversight.
```

- [ ] **Step 7: 加两条新判据（只加不改）**

在改写后的那条 `it` **之后**新增：

```ts
  it("refuses a lock whose holder identity is not a pid as unattributable, never as busy", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    // Parses perfectly; simply names no pid. `upgrading` is the exact holder shape pointC-design's
    // mutation C used, so this is the second permanent exit — distinct from the unparseable one.
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: "upgrading", acquiredAt: "2026-07-22T10:04:59.000Z" }, null, 2),
    );

    const error = await writeOwnerTransferArtifacts(
      runDir,
      initialOwnerRecord,
      transfer.nextOwnerRecord,
      transfer.transferRecord,
    ).then(
      () => {
        throw new Error("expected writeOwnerTransferArtifacts to reject, but it resolved");
      },
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(OwnerTransferLockUnattributableError);
    expect(error).not.toBeInstanceOf(OwnerTransferLockBusyError);
    expect(String(error)).toContain("no-pid-holder");
    expect(String(error)).toContain("ccloop unlock");

    // The lock is still on disk: human ruling 83's fail-closed exit did not gain a delete.
    expect(await readFile(join(runDir, ".owner-transfer.lock"), "utf8")).toContain("upgrading");
  });

  it("keeps a live holder's lock a BUSY outcome, never the unattributable one", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-07-22T10:04:59.000Z" }, null, 2),
    );

    // The other direction of the sibling doctrine. A live holder's lock DOES clear on its own, so
    // it must never be reported as the permanent kind — an operator told to run `ccloop unlock` on
    // a live holder would be sent to a command that refuses and deliberately offers no --force.
    const error = await writeOwnerTransferArtifacts(
      runDir,
      initialOwnerRecord,
      transfer.nextOwnerRecord,
      transfer.transferRecord,
    ).then(
      () => {
        throw new Error("expected writeOwnerTransferArtifacts to reject, but it resolved");
      },
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(OwnerTransferLockBusyError);
    expect(error).not.toBeInstanceOf(OwnerTransferLockUnattributableError);
  });
```

- [ ] **Step 8: 跑测试文件 ＋ typecheck，确认全绿**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npx vitest run tests/persistence/fileStore.test.ts > /tmp/t1b.txt 2>&1; echo "RC=$?" >> /tmp/t1b.txt; cat /tmp/t1b.txt
rtk proxy npm run typecheck > /tmp/tc1.txt 2>&1; echo "RC=$?" >> /tmp/tc1.txt; cat /tmp/tc1.txt
```
Expected: 该文件全绿（**90 tests**：原 88 ＋ 新 2），`typecheck` RC=0。

- [ ] **Step 9: 提交**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -F - <<'MSG'
feat(fileStore): tell the caller WHY a stale transfer lock could not be reclaimed (I-3(b), human rulings 106/107)

The boolean conflated a lock a live holder is using -- transient, it
clears when that process exits -- with a lock nobody can be attributed
to, which never clears at all. Both were false, so acquire could only
say one thing about them, and "owner transfer already in progress" is
false for the second: no transfer is in progress and none ever will be.

The unattributable exits now raise a sibling class, per the doctrine
already written above the busy class: a subclass would let every
existing instanceof branch keep matching and silently retain retry
behaviour only ever correct for a lock that clears on its own.

The busy message is kept byte for byte. For a live holder it is true.

Human ruling 83's fail-closed semantics are unchanged cell for cell:
the only exit that deletes is still parse + pid:<n> + not alive.

Human ruling 107 names the one existing criterion this rewrites.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 2: `resume` 链 —— 第三分支 ＋ I-3 的正主判据

**Files:**
- Modify: `src/controller/resumeLoop.ts`（`detail` 三元；`claimOwnerRecordWithBoundedLockRetry` 的重试判别处加注释）
- Test: `tests/controller/resumeLoop.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OwnerTransferLockUnattributableError`
- Produces: `resume_denied` 事件的 `detail` 以 `owner-transfer lock unattributable: ` 开头的新形状

- [ ] **Step 1: 写失败判据**

在 `tests/controller/resumeLoop.integration.test.ts` 末尾的 describe 内新增：

**紧跟在既有的 `it("stays fail-closed when the claim hits a busy owner-transfer lock, without claiming a CAS failure", …)` 之后**新增。
它是本判据的模板：fixture、调用形状、事件读法全部照抄，**只换锁内容与断言**。

```ts
  it("tells the operator a resume-blocking lock is unattributable and how to clear it, not that a transfer is in progress", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    // Unlike the test above, this lock has NO holder anyone can be attributed to. Nothing will
    // ever release it, so "owner transfer already in progress" was false in both halves: no
    // transfer, and no progress. This is the surface I-3 named.
    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    const ownerBefore = await readFile(join(runDir, "owner-record.json"), "utf8");

    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      ResumeNotEligibleError,
    );

    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe(ownerBefore); // untouched
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; detail: string });
    const denied = events.filter((event) => event.type === "resume_denied");

    expect(denied).toHaveLength(1);
    expect(denied[0].detail).toContain("unattributable");
    expect(denied[0].detail).toContain("ccloop unlock");
    // The two lies this criterion exists to keep out: the CAS that was never evaluated, and the
    // transfer that does not exist.
    expect(denied[0].detail).not.toContain("claim CAS failed");
    expect(denied[0].detail).not.toContain("already in progress");
  });
```

- [ ] **Step 2: 跑它，确认红**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npx vitest run tests/controller/resumeLoop.integration.test.ts > /tmp/t2.txt 2>&1; echo "RC=$?" >> /tmp/t2.txt; cat /tmp/t2.txt
```
Expected: **FAIL** —— detail 现在是 `claim CAS failed: …`（新类不是 busy，落进了 else 分支）。
⚠️ **这条红本身就是证据**：它证明 spec §4 #5 说的「不加分支会比现在更假」是真的。**把这段输出留档。**

- [ ] **Step 3: 加第三分支**

锚点：`    const detail = error instanceof OwnerTransferLockBusyError` 这一整行。**先断言逐字相符**，整段替换为：

```ts
    // §3: stays fail-closed either way, but a busy lock never evaluated a CAS, so the detail
    // must not claim one did.
    //
    // Human ruling 106 (I-3(b)): a THIRD branch, written first and explicitly, because the two
    // errors are siblings and neither `instanceof` implies the other. Without it an unattributable
    // lock would fall through to "claim CAS failed" — a worse lie than the one I-3 reported, since
    // no CAS was evaluated either. Measured before this branch existed: the criterion in
    // resumeLoop.integration.test.ts went red on exactly that string.
    const detail = error instanceof OwnerTransferLockUnattributableError
      ? `owner-transfer lock unattributable: ${String(error)}`
      : error instanceof OwnerTransferLockBusyError
        ? `owner-transfer lock busy: ${String(error)}`
        : `claim CAS failed: ${String(error)}`;
```

并加入 import。

- [ ] **Step 4: 在重试处写明「不加代码」也是重决**

锚点：`claimOwnerRecordWithBoundedLockRetry` 内 `      if (!(error instanceof OwnerTransferLockBusyError) || isLastAttempt) {` 这一整行。
**先断言逐字相符**，在其**上方**插入：

```ts
      // Human ruling 106 (I-3(b)) re-decided this site and deliberately left it unchanged: an
      // OwnerTransferLockUnattributableError is not an OwnerTransferLockBusyError, so it exits on
      // the first attempt instead of being retried. That is the wanted answer — retrying a lock
      // that nothing will ever release only delays the operator's message by the full bound. The
      // sibling doctrine's warning runs the other way (a SUBCLASS silently keeping a match); this
      // is a match deliberately lost, and it is recorded rather than left to be rediscovered.
```

- [ ] **Step 5: 跑，确认绿**

```bash
rtk proxy npx vitest run tests/controller/resumeLoop.integration.test.ts > /tmp/t2b.txt 2>&1; echo "RC=$?" >> /tmp/t2b.txt; cat /tmp/t2b.txt
```
Expected: 该文件全绿（原 15 ＋ 新 1 = **16 tests**）。

- [ ] **Step 6: 提交**

```bash
git add src/controller/resumeLoop.ts tests/controller/resumeLoop.integration.test.ts
git commit -F - <<'MSG'
fix(resumeLoop): report an unattributable transfer lock as itself, not as a CAS failure (I-3(b), human ruling 106)

This is the surface I-3 actually named: resume_denied's detail is what
an operator reads when a resume is refused. Without a third branch the
new sibling class falls through to "claim CAS failed", which is a worse
lie than the one I-3 reported -- no CAS was evaluated either. Measured:
the criterion went red on exactly that string before this branch existed.

The bounded retry above is re-decided and deliberately unchanged: an
unattributable lock now exits on the first attempt, because retrying a
lock nothing will ever release only delays the message by the bound.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 3: transfer 链 —— 收敛分支 ＋ 收敛性判据

**Files:**
- Modify: `src/controller/runLoop.ts`（`persistOwnerTransfer` 的重试判别处加注释；`owner_transfer_contended` 那个 catch 加分支）
- Test: `tests/controller/leaseLifecycle.integration.test.ts`

⚠️ **判据落在 `leaseLifecycle.integration.test.ts`，不是 `runLoop.integration.test.ts`。**
`owner_transfer_contended` 的既有判据全在前者，模板是
`it("appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy", …)`。

**Interfaces:**
- Consumes: Task 1 的 `OwnerTransferLockUnattributableError`
- Produces: 无新导出；`owner_transfer_contended` 事件**复用**，不新增事件类型

- [ ] **Step 1: 写失败判据**

**紧跟在模板判据之后**新增。fixture 与模板逐字相同，**只有锁内容与断言不同**：

```ts
  it("contains an unattributable transfer lock as a recorded contention instead of throwing out of the attempt", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
          runId: "task-1",
          logicalSessionId: "task-1:lost",
          currentOwnerEpoch: 1,
          currentProcessInstanceId: buildProcessInstanceId(),
          lastAffirmedAt: "2026-07-23T00:00:00.000Z",
          ownerStatus: "lost",
          supersededByEpoch: null,
        }, null, 2));
        // The one difference from the template above: this lock names NO attributable holder, so
        // the class raised is not OwnerTransferLockBusyError. The catch around persistOwnerTransfer
        // contained only the busy one, so without its new sibling branch the error escapes the
        // attempt entirely — turning a contained, recorded abandonment into a thrown failure. That
        // is the regression this criterion exists to make impossible.
        await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);

    expect(finalState.status).toBe("exhausted");
    const contended = (await readEvents(runDir)).filter(
      (event) => event.type === "owner_transfer_contended",
    ) as Array<{ type: string; detail: string }>;
    expect(contended).toHaveLength(1);
    expect(contended[0].detail).toContain("unattributable");
    expect(contended[0].detail).toContain("ccloop unlock");
    expect(await readEventTypes(runDir)).not.toContain("owner_epoch_transferred");
  });
```

⚠️ 若 `readEvents` 的返回类型已带 detail，去掉上面的 `as Array<…>` 断言 —— **以该文件既有用法为准，不要为它新造类型**。

- [ ] **Step 2: 跑它，确认红**

```bash
rtk proxy npx vitest run tests/controller/leaseLifecycle.integration.test.ts > /tmp/t3.txt 2>&1; echo "RC=$?" >> /tmp/t3.txt; cat /tmp/t3.txt
```
Expected: **FAIL** —— 错误从 attempt 里**抛了出去**，`owner_transfer_contended` 根本没被写。**留档这段输出。**

- [ ] **Step 3: 加收敛分支**

锚点：`          if (error instanceof OwnerTransferLockBusyError) {` 这一整行（在 `persistOwnerTransfer` 的调用处 catch 内）。
**先断言逐字相符**，在该 `if` 块的收尾 `}` 之后、`} else if (!(error instanceof OwnerTransferPreconditionError)) {` 之前插入：

```ts
          } else if (error instanceof OwnerTransferLockUnattributableError) {
            // Human ruling 106 (I-3(b)). Same containment as the busy branch above, and for the
            // same reason: a refusal to overwrite must not be upgraded into a failed attempt. What
            // differs is the detail — this lock will not clear on its own, so the event carries the
            // reason and the command that can clear it. Deliberately NOT a new event type: the
            // shape of what happened (a transfer abandoned to a lock) is the same one this stream
            // already names, and a second type would split every consumer of it.
            await appendEvent(runDir, {
              type: "owner_transfer_contended",
              at: new Date().toISOString(),
              detail: `owner transfer abandoned: ${String(error)}`,
            });
```

并加入 import。

- [ ] **Step 4: 在重试处写明「不加代码」也是重决**

锚点：`      if (!(error instanceof OwnerTransferLockBusyError) || isLastAttempt) {` 这一整行（在 `persistOwnerTransfer` 内）。
**先断言逐字相符**，在其**上方**插入：

```ts
      // Human ruling 106 (I-3(b)) re-decided this site and deliberately left it unchanged: an
      // OwnerTransferLockUnattributableError is not an OwnerTransferLockBusyError, so it is thrown
      // on the first attempt rather than retried to the bound. Retrying a lock nothing will ever
      // release buys nothing but delay. It is caught and contained by the branch added at the
      // persistOwnerTransfer call site, not left to escape.
```

- [ ] **Step 5: 跑，确认绿**

```bash
rtk proxy npx vitest run tests/controller/leaseLifecycle.integration.test.ts > /tmp/t3b.txt 2>&1; echo "RC=$?" >> /tmp/t3b.txt; cat /tmp/t3b.txt
```
Expected: 该文件全绿（原 27 ＋ 新 1 = **28 tests**）。

- [ ] **Step 6: 提交**

```bash
git add src/controller/runLoop.ts tests/controller/leaseLifecycle.integration.test.ts
git commit -F - <<'MSG'
fix(runLoop): keep an unattributable transfer lock contained as a recorded contention (I-3(b), human ruling 106)

The catch around persistOwnerTransfer only contained OwnerTransferLockBusyError.
The new sibling class is not one, so without this branch the error escaped
the attempt entirely -- turning a contained, recorded abandonment into a
thrown failure. Measured: the criterion went red exactly that way before
the branch existed.

Same containment as the busy branch, same event type deliberately: the
shape of what happened is the one this stream already names, and a second
type would split every consumer. Only the detail differs, and it now
carries the reason and the command that can clear the lock.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 4: 钉住 `try` 边界 —— EPERM 判据

**Files:**
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `tryRecoverStaleOwnerTransferLock` 结构
- Produces: 无

**Why:** Task 1 把 `isProcessActive` 从 `try` 内挪到了 `try` 外。二者只在它**会抛**时才有差别。
它今天是全函数（`ESRCH ⇒ false`、其余 ⇒ `true`），但**「读过」不是证明**。

- [ ] **Step 1: 写判据**

```ts
  it("refuses a lock as busy when the holder's liveness cannot be determined, never letting the errno escape", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    // ... 与上面两条相同的 initialOwnerRecord / transfer / writeOwnerRecord fixture ...
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-07-22T10:04:59.000Z" }, null, 2),
    );

    // isProcessActive reads every non-ESRCH errno as "alive" (human ruling 86's two-state
    // predicate), and it does so INSIDE its own try. This criterion pins that totality: the
    // redline function calls it from OUTSIDE the try that wraps the parse, so an errno escaping
    // isProcessActive would leave the redline function as a raw EPERM instead of a refusal.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    let error: unknown;
    try {
      error = await writeOwnerTransferArtifacts(
        runDir,
        initialOwnerRecord,
        transfer.nextOwnerRecord,
        transfer.transferRecord,
      ).then(
        () => {
          throw new Error("expected writeOwnerTransferArtifacts to reject, but it resolved");
        },
        (rejection: unknown) => rejection,
      );
    } finally {
      killSpy.mockRestore();
    }

    expect(error).toBeInstanceOf(OwnerTransferLockBusyError);
    expect(error).not.toBeInstanceOf(OwnerTransferLockUnattributableError);
    expect(String(error)).not.toContain("EPERM");
  });
```

⚠️ `mockRestore` 放在 `finally` 里：`process.kill` 是全局的，泄漏出去会污染同文件后续判据。

- [ ] **Step 2: 跑，确认绿（现状行为）**

```bash
rtk proxy npx vitest run tests/persistence/fileStore.test.ts > /tmp/t4.txt 2>&1; echo "RC=$?" >> /tmp/t4.txt; cat /tmp/t4.txt
```
Expected: 全绿（**91 tests**）。⚠️ **它天然是绿的 —— 所以它的价值全靠 Task 5 的 M5 变异来证明。**

- [ ] **Step 3: 提交**

```bash
git add tests/persistence/fileStore.test.ts
git commit -F - <<'MSG'
test(fileStore): pin that an undeterminable holder liveness refuses instead of escaping as an errno (I-3(b), human ruling 106)

I-3(b) moved isProcessActive out of the try that wraps the parse, so the
two structures differ only where it throws. It does not throw today --
every non-ESRCH errno is read as alive inside its own try -- but having
read that is not proof of it. This criterion injects EPERM and requires
the refusal, so a future change that lets an errno out of isProcessActive
turns the redline function's raw throw into a red test rather than into a
resume that dies with an unexplained EPERM.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 5: 变异证明（`git clone --local` 副本内）

**Files:** 无（主仓库工作树**零触碰**）

**Interfaces:**
- Consumes: Task 1–4 的全部落地
- Produces: 五条变异的实测记录，供 Task 6 写进台账

- [ ] **Step 1: 建副本，并把未提交改动同步进去**

```bash
cd /Users/biran/code/skills/loop
/bin/rm -rf /tmp/ccloop-mut
git clone --local ccloop /tmp/ccloop-mut > /tmp/clone.txt 2>&1; echo "RC=$?" >> /tmp/clone.txt; cat /tmp/clone.txt
```
⚠️ **clone 拿到的是 committed state。** Task 1–4 都已提交 ⇒ 无需再同步工作树。
若有未提交改动，用 `cat 工作树文件 > 副本对应文件`（**不要 `cp`**，本机 `cp` 有 `-i` alias 会静默拒绝覆盖）。

- [ ] **Step 2: 逐条跑五条变异**

每条的形状都是：改副本 → 跑指定判据 → **必须红** → `git checkout -- <file>` 还原 → 再跑 → 回绿。

| | 变异（在副本里） | 必须变红 |
|---|---|---|
| M1 | `unattributable` 出口改成 `throw new OwnerTransferLockBusyError("owner transfer already in progress")` | 改写后的 malformed 判据 ＋ resume detail 判据 |
| M2 | 删掉 `resumeLoop.ts` 的 `OwnerTransferLockUnattributableError` 那一支 | resume detail 判据 |
| M3 | 删掉 `runLoop.ts` 的 `OwnerTransferLockUnattributableError` 那一支 | 收敛性判据 |
| M4′ | `holder-alive` 出口改成 `await safeUnlink(lockPath); return { kind: "cleared" };`（把活持有者当可回收）| 既有 `rejects owner transfer while a live transfer lock is held` |
| M5 | `isProcessActive` 的 catch 改成 `throw error`（非 ESRCH 重抛）| EPERM 判据 |

⚠️ **M4′ 不是原 spec 里那条 M4。** 原 M4（只改成 `cleared`、不 unlink）**证明不了任何东西**：
循环第二次迭代仍 EEXIST，走到底照样抛 busy，判据全绿。**每条变异都必须先看到它真的把判据打红，否则它就是空的。**

- [ ] **Step 3: 还原证明**

```bash
cd /tmp/ccloop-mut
rtk proxy git diff > /tmp/mut-diff.txt 2>&1; rtk proxy wc -c < /tmp/mut-diff.txt
rtk proxy git diff --cached > /tmp/mut-cached.txt 2>&1; rtk proxy wc -c < /tmp/mut-cached.txt
```
Expected: **两者都是 0 字节**。⚠️ `diff -r` **不是**还原证明（它看不见 index）。

- [ ] **Step 4: 证明主仓库全程未被触碰**

```bash
cd /Users/biran/code/skills/loop/ccloop
rtk proxy git status --porcelain > /tmp/main-st.txt 2>&1; rtk proxy wc -c < /tmp/main-st.txt
```
Expected: **0 字节**。

- [ ] **Step 5: 清理副本**

```bash
/bin/rm -rf /tmp/ccloop-mut
```

---

### Task 6: 收尾 —— 全量验证 ＋ 钉死数字 ＋ 台账 §40

**Files:**
- Modify: `.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md`（**append only**，`git add -f`）
- Modify: `docs/superpowers/specs/2026-08-26-i3-unattributable-lock-design.md`（§7 写死数字）

- [ ] **Step 1: 全量三件套，未过滤整份读回**

```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run > /tmp/full.txt 2>&1; echo "TEST_RC=$?" >> /tmp/full.txt; cat /tmp/full.txt
rtk proxy npm run typecheck > /tmp/tc.txt 2>&1; echo "TYPECHECK_RC=$?" >> /tmp/tc.txt; cat /tmp/tc.txt
rtk proxy npm run build > /tmp/bd.txt 2>&1; echo "BUILD_RC=$?" >> /tmp/bd.txt; cat /tmp/bd.txt
```
Expected: **`35 files / 609 tests`** 全绿零 skipped，三个 RC 均 0，`RUN` 第一行指向主仓库根。
⚠️ 红了先核四条已知 flake ＋ 是否超时 ＋ 总耗时（正常 17–22s）。

- [ ] **Step 2: 重量红线函数并连口径一起记**

```bash
rtk proxy python3 - <<'PY'
s=open('src/persistence/fileStore.ts',encoding='utf-8').read()
i=s.index('async function tryRecoverStaleOwnerTransferLock')
start=s[:i].count('\n')+1
print('signature line:', start)
PY
```
然后按 §39 钉死的口径量：`sed -n '<start>,<end>p' … | wc -c`，**新基线连同「起止行号 ＋ 含末尾换行」一起记**。
⚠️ **旧基线 3185 自本轮起作废**（函数被授权改了）。

- [ ] **Step 3: 把 spec §7 的数字写死**

把 `docs/superpowers/specs/2026-08-26-i3-unattributable-lock-design.md` §7 判据 1 里的「新增判据条数定下后写死」
换成实测的 `35 files / 609 tests`。

- [ ] **Step 4: 写台账 §40**

追加一节，标题形如 `40. 人裁 106／107 落地 —— I-3(b)：不可归属的锁开口说话了`，内容必须含：
- 人裁 106／107 的措辞与授权边界
- 五条变异**各自**打红了哪条判据（**含 M4′ 取代 M4 的原因**）
- 新的红线函数字节基线**连口径**
- ⛔ 下一件事：**独立评审（人裁 106(b)，brief 覆盖上一轮两笔 ＋ 本轮四笔）**
- 仍挂账：**I-3(a)**、**`leaseHeartbeat.ts:150`／`:254`**、E1 的 I-2、Linux、人裁 85

```bash
git add -f .superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md
git add docs/superpowers/specs/2026-08-26-i3-unattributable-lock-design.md
git commit -m "docs(sdd): record section 40 -- I-3(b) landed, and the mutation that replaced the one proving nothing"
```

- [ ] **Step 5: 收尾核远端**

```bash
rtk proxy git ls-remote origin refs/heads/main > /tmp/ls2.txt 2>&1; cat /tmp/ls2.txt
rtk proxy git log -n 1 --format='LOCAL %H %s'
```
⚠️ **人会自己推远端。** `ls-remote` 的结果只在它跑出来的那一秒为真。**控制器不许 push。**
