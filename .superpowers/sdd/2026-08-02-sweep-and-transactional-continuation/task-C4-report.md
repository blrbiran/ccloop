# Task C4 report — 写面钉定（测试 14 与 14b）

- 分支：`feat/l3-group-c-sweep`
- 工作目录：`/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep`
- 起始 HEAD：`1564cba`
- 提交：`4a24a94` `test(sweep): pin the exact write surface of a gate-refused run and the recovery of a staged transaction`
- 改动面：`tests/registry/zeroWrite.test.ts` **一个文件**（+519 / −1）。计划的 Files 名单未扩。

所有验证命令一律形如
`rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && …'"`，
并以 vitest 首行 `RUN  v2.1.9 /Users/biran/…/worktrees/l3-group-c-sweep` 作为「跑在本 worktree」的验收。
**没有任何一条验证命令带 `| grep` / `| tail` / `| head` / `2>/dev/null`。**

---

## Step 1 — 重跑 L2 §12.1 fixture 前提集那条命令

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && grep -nF -A14 \"Zero-write proof.\" docs/superpowers/specs/2026-07-28-run-registry-design.md'"
400:1. **Zero-write proof.** Snapshot the whole tree as `(path, size, mtime,
401-   content-hash)` before and after a scan; assert byte-identical.
402-
403-   This must include a fixture that genuinely triggers `readOwnerRecord`'s
404-   recovery, which requires **all** of: `.owner-transfer.transaction.json`
405-   present (`fileStore.ts:552` — the trigger), both `.owner-record.pending.json`
406-   and `.owner-transfer.pending.json` present (`finalizePendingOwnerTransfer`
407-   reads them and throws ENOENT otherwise), and `.owner-transfer.lock` **absent**
408-   (with a live lock, `readOwnerRecord` returns without writing, `:559-561`).
409-
410-   The earlier description of this fixture — "`owner-record.json` in the state
411-   that triggers crash recovery" — was wrong, and a fixture built to it would
412-   pass even against an implementation calling `readOwnerRecord`. That is the
413-   exact wrong implementation §7.1 exists to kill, so the fixture's precondition
414-   set is load-bearing and must be asserted, not assumed.
```

14b 逐条照搬了这四条（marker present、两份 pending present、lock absent），并按本层要求再加第三份
pending（`.reconciliation-record.pending.json`）与一个 v2 marker。**四条都在测试里被 `expect` 断言，
不是注释**（见下面「14b 的 fixture 怎么建的」一节）。

---

## §A 11 个 staging 路径 —— 逐个具名

测试文件里的常量 `OWNER_TRANSFER_STAGING_PATHS`，一条字面量对应 `src/persistence/fileStore.ts` 里的
一个常量（`OWNER_RECORD_TEMP_FILE` … `RECONCILIATION_RECORD_PENDING_TEMP_FILE`，用符号名锚定，不用行号）：

| # | 路径 | 组 | fileStore 常量 |
|---|---|---|---|
| 1 | `.owner-transfer.transaction.json` | marker (1) | `OWNER_TRANSFER_MARKER_FILE` |
| 2 | `.owner-record.pending.json` | pending (3) | `OWNER_RECORD_PENDING_FILE` |
| 3 | `.owner-transfer.pending.json` | pending (3) | `OWNER_TRANSFER_PENDING_FILE` |
| 4 | `.reconciliation-record.pending.json` | pending (3) | `RECONCILIATION_RECORD_PENDING_FILE` |
| 5 | `.owner-record.publish.tmp` | 发布 temp (3) | `OWNER_RECORD_TEMP_FILE` |
| 6 | `.owner-transfer.publish.tmp` | 发布 temp (3) | `OWNER_TRANSFER_TEMP_FILE` |
| 7 | `.reconciliation-record.publish.tmp` | 发布 temp (3) | `RECONCILIATION_RECORD_TEMP_FILE` |
| 8 | `.owner-transfer.transaction.tmp` | marker temp (1) | `OWNER_TRANSFER_MARKER_TEMP_FILE` |
| 9 | `.owner-record.pending.tmp` | pending temp (3) | `OWNER_RECORD_PENDING_TEMP_FILE` |
| 10 | `.owner-transfer.pending.tmp` | pending temp (3) | `OWNER_TRANSFER_PENDING_TEMP_FILE` |
| 11 | `.reconciliation-record.pending.tmp` | pending temp (3) | `RECONCILIATION_RECORD_PENDING_TEMP_FILE` |

`11 = 1 marker + 10`。第 2–11 这 10 个正是 `cleanupOwnerTransferStagingWithoutMarker` 逐个
`safeUnlink` 的那一组 —— 该函数解构并 unlink 的是 `ownerPendingPath / transferPendingPath /
reconciliationPendingPath / ownerTempPath / transferTempPath / reconciliationTempPath /
ownerPendingTempPath / transferPendingTempPath / reconciliationPendingTempPath /
transactionMarkerTempPath`，**恰好 10 个**。marker 自己不在其中，因为「无 marker」正是它被调用的前提
（`recoverInterruptedOwnerTransfer` 里 `!pathExists(transactionMarkerPath)` 且 `lockHeld` 时才调它）。

断言写法（测试 14，sweep 前后各跑一次）：

```ts
expect(OWNER_TRANSFER_STAGING_PATHS).toHaveLength(11);
expect(await pathExists(join(refusedRun, "owner-record.json"))).toBe(true);   // 正向对照
for (const stagingPath of OWNER_TRANSFER_STAGING_PATHS) {
  expect([stagingPath, await pathExists(join(refusedRun, stagingPath))]).toEqual([stagingPath, false]);
}
```

`toHaveLength(11)` 钉住「11 个」这个数本身（少写一条会红）；元组形式让失败信息带上具体路径名。

---

## §B 三条前提「能不能失败」的证明

这一节回答控制器补充第 4 节点名的问题：**如果那个前提本来就不成立、或那个目录本来就不存在，
这条断言会不会以完全错误的理由通过？**

### 机制一：`leaseAffirmedAt === null`

```ts
const refusedOwnerBefore = JSON.parse(await readFile(join(refusedRun, "owner-record.json"), "utf8"));
expect(Object.keys(refusedOwnerBefore)).toContain("leaseAffirmedAt");   // (a)
expect(refusedOwnerBefore.leaseAffirmedAt).toBeNull();                  // (b)
expect((await checkRunLease(refusedRun, buildProcessInstanceId())).kind).toBe("no_lease");  // (c)
```

- **(b) 单独写就是 GATE-B 那个坑的同族**：`leaseGate.ts` 读的是 `ownerRecord.leaseAffirmedAt ?? null`，
  所以「键缺席」和「键为 null」对生产代码等价 —— 一个省略了该键的 fixture 也会走 `no_lease`，
  而 `expect(undefined).toBeNull()` 在 vitest 下**会失败**，于是 (b) 会以错误的理由变红。
  **(a) 是为此加的**：fixture 显式写出 `leaseAffirmedAt: null`（见 `c4OwnerRecord`），(a) 钉住键存在，
  (b) 才只在「值不是 null」时红。
- **(c) 是最强的一条**：它不检查 fixture，而是**直接断言实际走到的分支**。若 fixture 的
  `leaseAffirmedAt` 是一个过期时间戳，`checkRunLease` 会返回 `{kind:"expired"}`（并在那之前追加
  `lease_expired_observed`）——(c) 立刻红。若是新鲜时间戳且进程不同，它会 **throw** `RunLeaseHeldError`，
  测试同样红。三种偏离全被覆盖。
- **(c) 会不会自己制造写入？** 只有 `expired` 一支写事件，而那一支必然让 (c) 失败；`no_lease` 一支
  零写入。且 (c) 跑在 `snapshotTree` 取 before 快照**之前**。

### 机制二：11 个 staging 路径不存在

- **失败模式「目录本来就不存在」**：`pathExists` 对不存在的目录同样返回 false，11 条否定断言会**全部
  以完全错误的理由通过**。堵法是紧挨着的正向对照
  `expect(await pathExists(join(refusedRun, "owner-record.json"))).toBe(true)` —— 目录不在、或探针写坏了，
  这一条先红。
- **失败模式「路径名拼错」**：拼错的名字永远不存在，断言恒真。堵法是表里每个字面量与 fileStore 常量
  一一对照（§A 的表），且 14b **反过来断言其中 4 条为 `true`**（marker + 三份 pending），
  这四条名字若拼错，14b 立刻红 —— 即两条测试互为对方的名字校验。
  未被 14b 反向覆盖的是 7 个 temp 路径（#5–#11 中除 marker/pending 外的部分）；对这些，只有
  §A 的常量对照作为保证。**这是本任务里我最不确定的一处，已写进 concerns。**
- **sweep 后再跑一遍同一循环**：证明 sweep 自己也没造出 staging 残留。

### 机制三：拒绝来自资格门，不是 CAS 门

- **fixture 侧**（sweep 前）：`expect(refusedReconciliation.eligibleForContinuation).toBe(false)` ——
  这一条能失败：把它改成 `true`，run 就会走到 CAS 门。
- **写者侧**（sweep 后，这才是证明）：
  ```ts
  expect(denied.detail).toBe("reconciliation-record is not eligible for continuation");
  ```
  这是 `evaluateResumeEligibility` 八条判据**第 2 条**的 `reason` 逐字。四条别的拒绝路径写的
  detail 全都不同：CAS 是 `claim CAS failed: …`、锁忙是 `owner-transfer lock busy: …`、
  租约门是 `checkRunLease` 抛出的 message、读失败是 `cannot read run artifacts: …`。
  用 `toBe` 而不是 `toContain`，任何一条别的路径都红。
- **旁证**：`expect(await pathExists(join(refusedRun, ".owner-transfer.lock"))).toBe(false)`
  加上「其余字节不变」——走 CAS 门必然建后删 `.owner-transfer.lock` 并跑一次 `lockHeld: true` 的恢复，
  两者都会让全目录快照对比失败。

### 伴生断言（非 eligible 那个目录）本身的非空洞性

```ts
const nonEligibleAfter = await snapshotTree(nonEligibleRun);
expect(Object.keys(nonEligibleAfter).sort()).toEqual(seededFiles);   // 6 个文件都在
expect(nonEligibleAfter).toEqual(nonEligibleBefore);
```
`{}` 与 `{}` 深比较相等，所以**「快照为空」**会让主断言空过。前一行显式钉住六个文件名
（`events.jsonl`、`loop-contract.json`、`loop-state.json`、`owner-record.json`、`owner-transfer.json`、
`reconciliation-record.json`），before 侧同样钉了一遍。

（*GATE-C 修复波更正 2026-08-05*：本段原写作「**目录不存在** / 快照为空」两种空过场景。
**「目录不存在」那一半是假的**：`snapshotTree` 用 `readdir` 走树，目录缺失时**直接抛 ENOENT**，
那个空过场景在结构上根本构造不出来——GATE-C lane 2 实测过（不建那个非 eligible 目录，红在
`zeroWrite.test.ts` 的 `snapshotTree` 自身，不是红在主断言上）。**上面那条 `seededFiles` 断言
本身是对的、也仍然必要**，它挡的是**「目录在但为空」**那一半；被更正的只是印在它旁边的机制表述。
**测试一个字节未动。**）

### 「恰好两行事件」的非空洞性

```ts
expect(refusedEventsRaw.startsWith(SEEDED_EVENT_LINE)).toBe(true);          // 追加而非重写
expect(appended).toHaveLength(2);
expect(await readEventTypes(refusedRun)).toEqual(["fixture_seed", "resume_requested", "resume_denied"]);
```
fixture 预置了一行 `fixture_seed`，所以「恰好两行」是**前缀保持 + 余下两行**，而不是对一个本来就空的
文件数行数（那样「重写成两行」与「追加两行」不可区分）。

「其余字节不变」的排除也做了非空洞保护：

```ts
expect(refusedBefore["events.jsonl"]).toBeDefined();
expect(refusedAfter["events.jsonl"]).toBeDefined();
expect(refusedAfter["events.jsonl"]).not.toEqual(refusedBefore["events.jsonl"]);   // 确实被写过
```
没有第三条，「除 events.jsonl 外全都没变」在「sweep 根本没碰这个目录」时也成立。

---

## §C 14b 的 fixture 怎么建的

### 建出来的磁盘状态

已发布（崩溃前那一刻的 published 面）：

| 文件 | 内容要点 |
|---|---|
| `loop-contract.json` | 与 `tests/controller/resumeLoop.integration.test.ts` 同形的严格合法契约，`repoPath` 指向一个**真的 git 仓库**（`createRepo()`） |
| `events.jsonl` | 空 |
| `loop-state.json` | `status: "executing"`（八条判据第 8 条要求可续跑状态） |
| `owner-record.json` | **`currentOwnerEpoch: 1`**（旧的，事务未提交） |
| `owner-transfer.json` | `eligibleForContinuation: true`、`newOwnerEpoch: 2`、`reason: "staged, not yet finalized"` |
| `reconciliation-record.json` | `OWNER_LOST` / `newOwnerEpoch: 2` / `eligibleForContinuation: true`、`takeoverPermission.reason: "published before the crash"` |

已 staged（L2 §12.1 前提集 + 本层第三份 pending）：

| 文件 | 内容要点 |
|---|---|
| `.owner-transfer.transaction.json` | **v2** marker，`finalizeOrder: ["owner-transfer.json","owner-record.json","reconciliation-record.json"]` |
| `.owner-record.pending.json` | **`currentOwnerEpoch: 2`** |
| `.owner-transfer.pending.json` | `reason: "owner lost mid-publish"` |
| `.reconciliation-record.pending.json` | `takeoverPermission.reason: "staged by the interrupted transfer"` |
| `.owner-transfer.lock` | **故意不存在** |

sweep 用**真实**的默认 `scan`（`scanRuns` + `defaultScanDeps`）与**真实**的默认 `resume`
（`resumeLoop`），`deps` 参数整个不传；adapter 是 `new ScriptedAdapter([successFrame()])`。

### 为什么每个「门相关」字段在 published 面上就已经是终值 —— 一处实测出来的实现性质

第一版 fixture 让 `reconciliation-record.json` **完全不存在**（由恢复来发布它），实测**红**：

```
 FAIL  tests/registry/zeroWrite.test.ts > sweep write surface > finalizes a staged three-file transaction during sweep and admits the run afterwards
AssertionError: expected false to be true // Object.is equality
 ❯ tests/registry/zeroWrite.test.ts:668:76
    668|       expect(await pathExists(join(runDir, "reconciliation-record.json…
```

原因（读代码确认，不是猜）：`resumeLoop` 在**一个 `Promise.all` 里并发**读五份 artifact ——
`readOwnerRecord` / `readOwnerTransferRecord` / `readReconciliationRecord` / `readRunState` /
`loadContract`。只有 `readOwnerRecord` 前面挂着 `recoverInterruptedOwnerTransfer`；另外三个是**裸读**，
与恢复的 rename 竞争。于是：

- `reconciliation-record.json` 若尚未发布，裸读拿到 ENOENT → 整个 `Promise.all` 抛 →
  `resume_denied: cannot read run artifacts: …`，**恢复即使发生了也来不及救它**。
- `owner-transfer.json` / `reconciliation-record.json` 的裸读读到 rename 前还是后，是**竞争**。

因此 fixture 的取法是：**只让 `currentOwnerEpoch` 这一个门相关字段依赖恢复**（它由
`readOwnerRecord` 提供，构造上排在恢复之后，确定性成立），其余门相关字段在 published 面上就与 pending
一致（读到哪一份都不改变判据结果）。而 `reason` / `takeoverPermission.reason` 这两个**门完全不读**的
字段则故意 published ≠ pending，用作 sweep 之后的「published 的确是 staged 那份字节」的判别器 ——
我的断言在 sweep 返回后才读文件，那时 finalize 必然已完成，所以不受竞争影响。

这条实现性质**没有**被计划或 brief 断言过相反的东西，所以我不把它当作计划勘误；但它是一处真实的、
此前未被记录的行为，见 concerns。

### 断言分三组

- **(i) 三个文件全部就位**：三条 `pathExists` 为 true；`owner-record.currentOwnerEpoch === 2`（1→2 只能
  来自 staged pending 被发布）、`ownerStatus === "current"`；`owner-transfer.reason === "owner lost mid-publish"`
  （sweep 前实测断言过它是 `"staged, not yet finalized"`）、`newOwnerEpoch === 2`；
  `reconciliation.ownershipVerdict === "OWNER_LOST"` / `newOwnerEpoch === 2` /
  `eligibleForContinuation === true` / `takeoverPermission.reason === "staged by the interrupted transfer"`
  （sweep 前实测断言过它是 `"published before the crash"`）。
  **三条判别器各自在 sweep 前后都被断言了一次，所以 (i) 不是 fixture 的复述。**
- **(ii) marker 与全部 pending 已被回收**：四条 `pathExists` 为 false（sweep 前这四条**都被断言为 true**，
  所以这四条否定断言不可能因「那个文件本来就不存在」而空过）；外加 `.owner-transfer.lock` 为 false
  （CAS 门的锁被释放而非泄漏）。
- **(iii) `resumeLoop` 放行**：`events.jsonl` 含 `resume_requested` 与 `resume_adopted`、
  **不含** `resume_denied`；`owner-record.currentProcessInstanceId === buildProcessInstanceId()`
  （CAS 认领的结果，位于八条判据全部通过之后）；`loop-state.json` 终态 `succeeded`；
  sweep 返回 0；stdout 两行、stderr 一行逐字比对。

### 关于「Test only」与「照搬既有写法」

按 brief 第 1 节的裁定，fixture 全部建在 `tests/registry/zeroWrite.test.ts` **内部**（`createRepo` /
`createContract` / `c4OwnerRecord` / `c4TransferRecord` / `c4ReconciliationRecord` / `successFrame` /
`readEventTypes` 都是本文件内的新函数），**没有碰第二个文件，没有扩 Files 名单**。
形状上复用了该文件既有的 `snapshotTree`；契约与 scripted frame 的形状照抄
`tests/controller/resumeLoop.integration.test.ts` 的对应物（严格 zod 契约必须如此），
这一点在文件内的注释里写明了。

---

## Step 3 / Step 4 —— 写完后跑，原始输出

第一次（14 绿、14b 因上面那条并发读性质而红）与第二次（14b 因我猜错 `stopReason` 字面量而红）的原始
输出见上一节与下一段；两次都不是「改判据去凑」：第一次改的是 fixture 的构造前提（并在报告里说明了
为什么），第二次改的是我对 `stopReason` 文案的**猜测值** —— 实测值是
`stopReason=success condition satisfied`，不是我先写的 `stopReason=null`：

```
- "…/run-staged-transaction	succeeded	stopReason=null",
+ "…/run-staged-transaction	succeeded	stopReason=success condition satisfied",
```

修正后整文件：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && npx vitest run tests/registry/zeroWrite.test.ts; echo EXIT=\$?'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/registry/zeroWrite.test.ts (4 tests) 325ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  00:28:31
   Duration  747ms (transform 131ms, setup 0ms, collect 170ms, tests 325ms, environment 0ms, prepare 48ms)

EXIT=0
```

---

## Step 5 —— 变异实验（两次，各走三步判据）

变异注入点**都在生产代码上**（`src/sweep/sweepRuns.ts`、`src/persistence/fileStore.ts`），不是 fixture。
基线工作副本就是这个 worktree（git 仓库，`npm ci` 已跑过，注入前全套件绿 —— 见 Step 6）。

### 变异一：sweep 对非 eligible 行也调 `resume`

**第 1 步 具名**（`describe > it` 全串）：
`sweep write surface > appends exactly resume_requested and resume_denied to a gate-refused run and leaves the non-eligible run byte-identical`

**注入内容**（`src/sweep/sweepRuns.ts`，`isObservedEligible` 首行）：

```ts
function isObservedEligible(row: ScanRow): row is RunObservation {
  if (row.kind === "run") return true; // MUTANT-C4-1
  if (row.kind !== "run") return false;
```

**注入前单跑（绿）：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "bash -c 'cd …/l3-group-c-sweep && npx vitest run tests/registry/zeroWrite.test.ts -t \"appends exactly resume_requested and resume_denied to a gate-refused run and leaves the non-eligible run byte-identical\"; echo EXIT=\$?'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/registry/zeroWrite.test.ts (4 tests | 3 skipped) 17ms

 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)
   Start at  00:28:42
   Duration  422ms (transform 134ms, setup 0ms, collect 179ms, tests 17ms, environment 0ms, prepare 39ms)

EXIT=0
```

`Tests  1 passed | 3 skipped` —— 具名那条计数**非零**，过滤器确实命中，不是「全 skipped 假绿」。

**注入后单跑（红）：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/registry/zeroWrite.test.ts (4 tests | 1 failed | 3 skipped) 21ms
   × sweep write surface > appends exactly resume_requested and resume_denied to a gate-refused run and leaves the non-eligible run byte-identical 21ms
     → expected [ …(3) ] to deeply equal [ …(2) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/registry/zeroWrite.test.ts > sweep write surface > appends exactly resume_requested and resume_denied to a gate-refused run and leaves the non-eligible run byte-identical
AssertionError: expected [ …(3) ] to deeply equal [ …(2) ]

- Expected
+ Received

  Array [
    "/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-c4-writesurface-4EqqA7/scan-root/run-gate-refused	refused	reconciliation-record is not eligible for continuation",
-   "1 attempted, 0 succeeded, 1 refused, 0 errored (quota 0/5)",
+   "/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-c4-writesurface-4EqqA7/scan-root/run-not-eligible	refused	owner-transfer is not eligible for continuation",
+   "2 attempted, 0 succeeded, 2 refused, 0 errored (quota 0/5)",
  ]

 ❯ tests/registry/zeroWrite.test.ts:523:27

 Test Files  1 failed (1)
      Tests  1 failed | 3 skipped (4)
   Start at  00:28:59
   Duration  426ms (transform 119ms, setup 0ms, collect 161ms, tests 21ms, environment 0ms, prepare 61ms)

EXIT=1
```

`1 failed | 3 skipped` —— 具名那条**本身**红，达标。

**补充探针（因为上面这次是 stdout 断言先红，而计划要求的是「伴生断言（非 eligible 目录字节不变）必红」）：**
在变异仍然注入的前提下，临时把该测试里更靠前的 stdout/stderr 断言替换成
`// PROBE-C4-1 begin … void …; // PROBE-C4-1 end` 的空转（**测试侧的临时改动，已还原**），重跑：

```
 ❯ tests/registry/zeroWrite.test.ts (4 tests | 1 failed | 3 skipped) 21ms
   × sweep write surface > appends exactly resume_requested and resume_denied to a gate-refused run and leaves the non-eligible run byte-identical 21ms
     → expected { 'events.jsonl': { …(3) }, …(5) } to deeply equal { …(6) }
…
  Object {
    "events.jsonl": Object {
-     "mtimeMs": 1785860964538.3672,
-     "sha256": "2439bd8f68a59be4255492a4c7465efaaf7097abc0d5a406ceb7e57a9faa8124",
-     "size": 92,
+     "mtimeMs": 1785860964547.231,
+     "sha256": "0128207e1e4f1f27b918332ff012a8b99ca99434ca4175bcdab5c446fb08a346",
+     "size": 385,
    },
    "loop-contract.json": Object { … 未变 … },
    "loop-state.json": Object { … 未变 … },
    "owner-record.json": Object { … 未变 … },
    "owner-transfer.json": Object { … 未变 … },
    "reconciliation-record.json": Object { … 未变 … },
  }

 ❯ tests/registry/zeroWrite.test.ts:566:32
    566|       expect(nonEligibleAfter).toEqual(nonEligibleBefore);

 Test Files  1 failed (1)
      Tests  1 failed | 3 skipped (4)
   Start at  00:29:24
   Duration  404ms
EXIT=1
```

失败行就是**伴生断言本体**（第 566 行 `expect(nonEligibleAfter).toEqual(nonEligibleBefore)`），
变的是 **`run-not-eligible`（非 eligible 那个目录）**的 `events.jsonl`，92 字节 → 385 字节。
这正是计划第一轮那处句法歧义所要求的主语。探针已还原。

### 变异二：`recoverInterruptedOwnerTransfer` 在无锁时也早退

**第 1 步 具名**：
`sweep write surface > finalizes a staged three-file transaction during sweep and admits the run afterwards`

**注入内容**（`src/persistence/fileStore.ts`，`recoverInterruptedOwnerTransfer` 首行）：

```ts
async function recoverInterruptedOwnerTransfer(runDir: string, options?: { lockHeld?: boolean }): Promise<void> {
  if (!options?.lockHeld) return; // MUTANT-C4-2
  const paths = getOwnerTransferPaths(runDir);
```

**注入前单跑（绿）：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/registry/zeroWrite.test.ts (4 tests | 3 skipped) 202ms

 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)
   Start at  00:28:44
   Duration  580ms (transform 113ms, setup 0ms, collect 150ms, tests 202ms, environment 0ms, prepare 35ms)

EXIT=0
```

**注入后单跑（红）：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/registry/zeroWrite.test.ts (4 tests | 1 failed | 3 skipped) 138ms
   × sweep write surface > finalizes a staged three-file transaction during sweep and admits the run afterwards 137ms
     → expected 1 to be 2 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/registry/zeroWrite.test.ts > sweep write surface > finalizes a staged three-file transaction during sweep and admits the run afterwards
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ tests/registry/zeroWrite.test.ts:706:44
    704|       const ownerAfter = JSON.parse(await readFile(join(runDir, "owner…
    705|       // epoch 1 -> 2 can only have come from the staged pending being…
    706|       expect(ownerAfter.currentOwnerEpoch).toBe(2);

 Test Files  1 failed (1)
      Tests  1 failed | 3 skipped (4)
   Start at  00:29:50
   Duration  511ms (transform 124ms, setup 0ms, collect 152ms, tests 138ms, environment 0ms, prepare 57ms)

EXIT=1
```

失败点是断言 (i) 的 `owner-record.currentOwnerEpoch === 2` —— 恢复没有发生，epoch 停在 1。达标。

### 还原证明

```
$ rtk proxy "bash -c 'cd …/l3-group-c-sweep && grep -rnF -e MUTANT-C4 -e PROBE-C4 src tests; echo GREP_EXIT=\$?; git status --porcelain; echo ----; git diff --stat'"
GREP_EXIT=1
 M tests/registry/zeroWrite.test.ts
----
 tests/registry/zeroWrite.test.ts | 520 ++++++++++++++++++++++++++++++++++++++-
 1 file changed, 519 insertions(+), 1 deletion(-)
```

`grep -rnF`（`-F`，退出码作数）零命中两个标记；`git status --porcelain` 只剩测试文件一条 —— 两处
生产代码的注入被逐字节还原（否则它们会出现在 status 里）。命令确实能命中所用标记：注入期间同一条
命令必然命中 `MUTANT-C4-1` / `MUTANT-C4-2` / `PROBE-C4-1` 这三个字面量，因为它们就是我写进文件的字符串。

---

## Step 6 —— 全套件 / typecheck / build（未过滤）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && npm test -- --run; echo TEST_EXIT=\$?'"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (12 tests) 5ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 451ms
 ✓ tests/registry/zeroWrite.test.ts (4 tests) 555ms
   ✓ sweep write surface > finalizes a staged three-file transaction during sweep and admits the run afterwards 357ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/registry/renderRuns.test.ts (11 tests) 7ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-ELtfZ5/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-1ZVCXm/run-1  observed 2026-08-04T16:30:10.998Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/registry/scanRuns.test.ts (9 tests) 7ms
 ✓ tests/cli/cli.test.ts (23 tests) 1393ms
   ✓ parseArgs > returns 0 for the scripted example run 343ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 2248ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1723ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 5ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 37ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 6ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 34ms
 ✓ tests/ownership/lease.test.ts (16 tests) 7ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 5ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2873ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 337ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 329ms
   ✓ resumeLoop > lets an eligible resume through an expired lease and records the observation 332ms
   ✓ resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL 328ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 24ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 4ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3604ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 418ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 332ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 364ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 452ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 417ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 428ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 403ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 599ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 4ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 267ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 577ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 575ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2731ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 652ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 666ms
   ✓ render-contract CLI > rejects a non-git repository path 741ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 660ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 7561ms
   ✓ lease heartbeat lifecycle > releases the lease when the loop returns, so the next resume proceeds immediately 310ms
   ✓ lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease 315ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 573ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 663ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 711ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 499ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 391ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 400ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 382ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 367ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9803ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 489ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 381ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 375ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 367ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 376ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 384ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 399ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 417ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 550ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 364ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 361ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 374ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 373ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 363ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 559ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 388ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 530ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 509ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 419ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 528ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 393ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 12139ms
   ✓ runLoop > succeeds when verification approves 308ms
   ✓ runLoop > prioritizes the post-execute path-policy human gate over budget exhaustion 320ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 404ms
   ✓ runLoop > passes phase state plus plan/execution context to each adapter step 308ms
   ✓ runLoop > stops immediately when a stopOn signal matches 390ms
   ✓ runLoop > exhausts the run when planning exceeds per-attempt timeout 328ms
   ✓ runLoop > publishes reconciliation-record.json inside the transfer transaction even when assertHeld throws afterwards 302ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 801ms
 ✓ tests/validation/evidence.test.ts (39 tests) 16570ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1539ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1389ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2705ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1621ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1588ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1548ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 602ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 596ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 597ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 995ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 608ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2569ms

 Test Files  30 passed (30)
      Tests  512 passed (512)
   Start at  00:30:09
   Duration  17.27s (transform 2.68s, setup 0ms, collect 4.41s, tests 60.93s, environment 5ms, prepare 1.77s)

TEST_EXIT=0
```

> 上面这段是逐字粘贴：每个文件的 `✓` 清单、两块 stderr/stdout 调试输出、全部 slow-test 行都原样保留，
> 无节略、无管道过滤。

- **`RUN` 路径 = `/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep`，是 worktree，不是主仓。**
- **30 文件 / 512 用例**（本任务开工前是 30 / 510，本任务 +2 条）。主仓是 29 / 490，数字明显不同。
- 名单上那两条允许的 flake（evidence.test.ts 的 `records env names only …`、runLoop.integration 的
  `continues normally when execute returns a complete result during the recovery window`）**这次都是 `✓`**，
  没有出现；名单外零失败。

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && npm run typecheck; echo typecheck_exit=\$?; npm run build; echo build_exit=\$?'"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "…"

build_exit=0
```

---

## 边界与守卫（控制器补充第 3 节）

```
$ rtk proxy "bash -c 'cd …/l3-group-c-sweep && echo -n \"ok_false_count=\"; grep -cF \"return { ok: false\" src/controller/resumeLoop.ts; echo ---- ; grep -rnF \"currentOwnerEpoch + 1\" src/; echo ---- ; git status --porcelain src/registry/; echo \"registry_status_done\"'"
ok_false_count=8
----
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
----
registry_status_done
```

- `evaluateResumeEligibility` 八条判据：`grep -cF` 实测 **8**，未动。
- `currentOwnerEpoch + 1`：`grep -rnF` 实测**单点命中**（`ownerController.ts`），未动。
- `src/registry/` **零改动**（`git status --porcelain src/registry/` 空输出）。我的 Files 是
  `tests/registry/zeroWrite.test.ts`，在 `tests/` 下。
- C1 的流水线与配额语义、C2 的类型收窄、C3 的即时写回调、`stop()`、`isLeaseStopError`、B1/B2 的分支：
  **一个字节都没有改**（`git diff --stat` 只有测试文件一行）。
- C3 措辞纪律：我写进测试与注释的任何地方**都没有**出现「保证 / 一定 / 仍可续跑」这类对 `interrupted`
  的措辞；`sweepRuns.ts` 里那句「this sweep makes no claim that it can be resumed」原样未动。测试注释里
  明确写了 filter 只覆盖八条判据里的第 1 条。

## 行号引用扫描（Global Constraints 收尾条）

```
$ rtk proxy "bash -c 'cd …/l3-group-c-sweep && grep -rnF \"zeroWrite.test.ts:\" . --exclude-dir=node_modules --exclude-dir=.git'"
./.superpowers/sdd/2026-07-29-atomic-write-paths/progress.md:956:`readObservedFile.test.ts:97` cites `fileStore.ts:535-536` and `zeroWrite.test.ts:6,92` cite
./.superpowers/sdd/2026-07-28-run-registry/progress.md:24:Task 5: load-bearing assertion IS committed (zeroWrite.test.ts:187), not merely narrated …
./.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A7-report.md:922:   - `tests/registry/readObservedFile.test.ts:97` 引用 `fileStore.ts:535-536`、`tests/registry/zeroWrite.test.ts:6,:92` 引用 `fileStore.ts:549-563`…
./.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A2-report.md:689:- `tests/registry/zeroWrite.test.ts:6` and `:92` → `fileStore.ts:549-563` — lines 549-563 in the
```

实测当前行号（不是推算）：

```
$ rtk proxy "bash -c 'cd …/l3-group-c-sweep && grep -nF \"fileStore.ts:549-563\" tests/registry/zeroWrite.test.ts'"
6:// triggers readOwnerRecord's crash recovery (fileStore.ts:549-563), so that binding the
99:// preconditions recoverInterruptedOwnerTransfer checks (fileStore.ts:549-563) at once:
```

- `zeroWrite.test.ts:6` —— **仍然有效**（我在 import 块之后才加行，第 6 行是原来的头注释）。
- `zeroWrite.test.ts:92` —— **已移位到 99**（我在 import 块加了 7 行）。
- `zeroWrite.test.ts:187` —— 载荷断言所在的 `it(` 现在在 **190**。
- 这四条引用都在**历史 SDD 报告 / progress 文档**里，属于既成的历史证据记录，且都在我的 Files 名单之外。
  **我没有改它们**，按纪律在此披露。反方向（本文件指向 `fileStore.ts` 的行号引用）不受影响：我一个字节
  也没动 `fileStore.ts`；我自己新增的注释全部用**符号名**锚定，零处新行号。

---

## Concerns（写给独立评审员，不接受实施者自证）

1. **`resumeLoop` 的 `Promise.all` 里三个裸读与恢复竞争 —— 这是我在做 14b 时实测撞出来的实现性质，
   此前仓库里没有任何文档写过。** 只有 `readOwnerRecord` 排在 `recoverInterruptedOwnerTransfer` 之后；
   `readOwnerTransferRecord` / `readReconciliationRecord` / `readRunState` 是裸读，与 finalize 的三次
   rename 并发。后果之一是**确定的**：一个 staged 事务若 `reconciliation-record.json` 尚未发布，
   resume 会以 `cannot read run artifacts: … ENOENT` 被拒，恢复救不了它（我贴了这次红的原始输出）。
   后果之二是**竞争性的**：另外两份文件读到 rename 前还是后不确定。我据此把 14b 的 fixture 构造成
   「只有 `currentOwnerEpoch` 依赖恢复」，从而消除测试自身的不确定性 —— **但这意味着 14b 并不覆盖
   那个竞争窗口**。这是否是一个需要修的缺陷（L3 是否该给 resume 路径也上 §7.1 那层保护），
   超出 C4 的范围，我没有动任何生产代码，请裁定。
2. **11 条 staging 断言里，7 个 temp 路径的名字只有「与 fileStore 常量表逐条对照」这一层保证。**
   marker 与三份 pending 被 14b 反向断言为 `true`（拼错就红），7 个 temp 没有这层交叉校验 ——
   若我把某个 temp 名字拼错，那条断言会恒真地绿。我逐条比对过（§A 的表），但这是人工比对，
   请评审员独立复核这 7 行字面量。
3. **14b 依赖 `stopReason=success condition satisfied` 这个文案字面量**，以及两条 sweep 报告行 /
   一条 banner 行的完整格式。这些是 C3 的产出，格式一改这两条测试就红。我认为这是**想要**的
   （C3 的写面本来就该被钉住），但它确实让 C4 与 C3 的措辞耦合，评审员若认为过紧请指出。
4. **14b 跑真实 `runLoopFromState` + 真实 git worktree**，单条约 357ms，属于本文件里最慢的一条。
   它引入了对 `git` 可执行文件的依赖（`createRepo`），与 `resumeLoop.integration.test.ts`、
   `leaseLifecycle.integration.test.ts` 的既有做法一致，但这是 `tests/registry/` 下第一条这么做的测试。
5. **测试 14 的 `repoPath` 指向一个不存在的目录**（`…/repo-that-is-never-touched`）。这是故意的：
   资格门在 `cleanupResidualWorktrees` 之前拒绝，所以它永远不被解引用；若门哪天不再拒绝，
   这条会以一个吵闹的错误失败而不是安静地绿。但它确实意味着「这条测试的契约不是一个可用的契约」。
6. **变异一的直接失败点是 stdout 断言，不是伴生断言**。我用一次带标记的临时探针证明了伴生断言本体
   也红（原始输出已贴，探针已还原、`grep -rnF` 零命中）。若评审员认为「必须由伴生断言本身第一个红」
   才算达标，那就需要把 stdout 断言挪到伴生断言之后 —— 我没有这么做，因为 stdout 断言在诊断上更有用。
7. **两次「跑了不合预期就改」的地方我都改了测试侧**，请重点撞：一次是 14b 的 fixture 构造前提
   （见 concern 1，我认为是我对实现的假设错了，不是实现错了）；一次是 `stopReason` 的字面量
   （我先写的是猜测值 `null`，实测是 `success condition satisfied`）。**两次都不是改判据去凑变异结果**，
   变异实验是在这两处定稿之后才做的。
