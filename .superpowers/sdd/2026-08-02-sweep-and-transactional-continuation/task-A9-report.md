# Task A9 报告 — 输家不得覆盖赢家（测试 6e，钉 §4.3 的排序改判）

> ⚠️ **全局 supersession 提示（修复轮 1，2026-08-02）**：本报告 §1–§9 里出现的测试名
> `runLoop > keeps the loser from writing through the winner's reconciliation inside the publish window`
> **已被改名**（人的裁定；理由与新名字见 §11「修复轮 1」）。新名字是
> `runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`。
> §1–§9 的原始输出块**一个字节没改**——它们是诚实的历史跑，只是引用的是旧名字；**改名后重跑的四块变异证据在 §11**。

状态：**完成**。提交 `d27f317`（本地），修复轮 1 提交见 §11。工作副本：`/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a`，分支 `feat/l3-debt1-transactional-continuation`，起点 HEAD `ced77e5`。

**过滤机制声明**：全局 `rtk` shell hook 会自动过滤输出。本报告中所有验证跑一律用 `rtk proxy "<command>"` 绕过；`rtk proxy` 不接受以环境赋值开头的字符串，所以先 `export ECC_GATEGUARD=off DISABLE_OMC=1`。测试名里含撇号（`winner's`），无法安全地嵌进 `rtk proxy` 的引号串，因此单跑命令写成一个脚本再由 `rtk proxy "bash <script>"` 执行，脚本内容逐字见下。**没有任何一次验证跑经过 `tail`/`grep`/`head`/`2>/dev/null` 管道**；每次跑都完整重定向进文件，本报告引用的是那些文件里的原始文本（全套件跑的 `✓` 明细行因长度只摘录了尾部汇总与全部失败块，这一点在此明确披露，脚本与命令都可原样重跑）。

---

## 1. 骨架：交错点由 mock 决定，不由 fixture 决定

测试文件：`tests/controller/runLoop.integration.test.ts`，完整测试名：

```
runLoop > keeps the loser from writing through the winner's reconciliation inside the publish window
```

**⚠️ 已被 §11（修复轮 1）取代**：现名 `runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`。本节以下所有引用旧名字的地方同此。

两侧都跑生产代码：

- **P1（赢家）**：测试直接调 `writeOwnerTransferArtifacts`（fileStore 导出面；Global Constraints 允许「手工构造磁盘状态的部分可直接调 fileStore 的导出面」）。它自己 `acquireOwnerTransferLock` → 暂存三个 pending ＋ marker → `finalizePendingOwnerTransfer` 走三次 rename。
- **P2（输家）**：`runLoopFromState`（`persistBoundaryAnalysis` 未导出，也没有为此导出它）。fixture 用 `ownerStatus: "lost"` ＋ execute 里改 worktree 文件，把裁决压在 `OWNER_UNDECIDABLE` / takeover denied 上，于是输家**不会**自己发起转移（也就不会去抢锁、不会死锁），而是带着一份 `stale_candidate` 的 reconciliation record 走到 `writeBoundaryArtifacts`。

**交错点**：`vi.resetModules()` ＋ `vi.doMock("node:fs/promises", …)` 包住 `rename`。**第一次「源文件名 ∈ 三个事务发布 temp」的 rename** 在真实 rename 落地之后，同步（`await`）把输家整个 `runLoopFromState` 跑完，再放行 P1 剩下的 rename。

为什么必须是 mock 而不是 fixture 决定这个点：三个发布 temp 的名字是固定的，**但哪一个先被 rename 完全由生产常量 `finalizeOrder` 决定**。mock 触发在「事务的第一次发布 rename」这个*位置*上，所以变异一（重排 `finalizeOrder`）改变的是「窗口里磁盘上有什么」，而不是「窗口在哪」。反过来，如果用 fixture 决定交错（定时 sleep、或手工摆好 pending 再手工 rename），那么改 `finalizeOrder` 的同时就得改 fixture，fixture 就变成了变异面的一部分，测试什么也钉不住。窗口开在**第一次发布 rename 之后**，正是排序改判要谈的那一瞬间。

fixture 在未变异跑、变异一跑、变异二跑三次里**一个字节都没动**（三次改的都只是 `src/persistence/fileStore.ts`，见下）。

## 2. fixture 如何让 `.owner-transfer.lock` 在窗口内被活着的 pid 持有

不用手工造锁：P1 的 `writeOwnerTransferArtifacts` 自己持锁跑完整个事务，`acquireOwnerTransferLock` 写进去的 `holderProcessInstanceId` 是 `pid:${process.pid}` —— **就是这个测试进程本身，所以 `isProcessActive` 必然为真**。窗口在 P1 的第一次发布 rename 内部打开，此时锁文件仍在（`lock.release()` 在事务的 `finally` 里，尚未执行），marker 也仍在（`safeUnlink(marker)` 在三次 rename 之后）。这正是 §4.3 排序改判第 2 步要求的状态：输家的 `readOwnerRecord` → `recoverInterruptedOwnerTransfer` 看见 marker ＋ 活锁 → `tryRecoverStaleOwnerTransferLock` 早退 `false` → **不替 P1 finalize**。

## 3. 两条断言

- **(a)** 输家那次调用期间发生过一次针对 `owner-transfer.json` 的**成功**读：`expect(ownerTransferReadOutcomesInWindow).toContain("ok")`。观测点是 mock 的 `readFile`，按「窗口是否打开」＋「basename 是否为 `owner-transfer.json`」记录 `"ok"` / `` `failed:${code}` ``。
- **(b)** 输家那次调用期间**没有任何 rename 以事务发布 temp 为源**：`expect(publishTempRenameSourcesInWindow).toEqual([])`。

选的是「rename 源」这一条，不是 spy `finalizePendingOwnerTransfer`（未导出，也不为测试导出它）；测试注释里写明了选哪条。断言形状是**集合成员**而非 rename **计数**——`writeBoundaryArtifacts` 自己就 rename，计数两侧都是错的数字。输家自己的原子写走 `buildAtomicTempPath`（进程戳＋序号），与三个固定发布 temp 不可能撞名。

fixture 前置条件（否则两条断言会在「窗口从未打开」或「输家根本没带 reconciliation record」上空过）：
`expect(await pathExists(join(runDir, "owner-transfer.json"))).toBe(false)`（事务开始前没有已发布的 transfer）、`expect(interleaved).toBe(true)`、`expect(analysis.status).toBe("stale_candidate")`。

**没有任何终态断言。**「P1 的第三次 rename 把真品盖回去」是 harness 强加的顺序，不是系统性质，测试注释里把这一点写死了。

---

## 4. 变异一：生产常量 `finalizeOrder` 重排

注入点（生产代码）：`src/persistence/fileStore.ts`，`writeOwnerTransferArtifacts` 里 v2 marker 的 `finalizeOrder`。

```
$ rtk proxy "git -C <worktree> diff -- src/persistence/fileStore.ts"
diff --git a/src/persistence/fileStore.ts b/src/persistence/fileStore.ts
index 0532be1..5b98c2c 100644
--- a/src/persistence/fileStore.ts
+++ b/src/persistence/fileStore.ts
@@ -953,7 +953,7 @@ export async function writeOwnerTransferArtifacts(
         : {
             version: 2,
             stagedAt: transferRecord.transferredAt,
-            finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE],
+            finalizeOrder: [RECONCILIATION_RECORD_FILE, OWNER_TRANSFER_FILE, OWNER_RECORD_FILE],
           };
 
     await writeJsonFileViaFixedTemp(paths.transferPendingTempPath, paths.transferPendingPath, transferRecord);
```

**A3 的 `isValidFinalizeOrder` 不会拦它**（这一点先核对过再依赖）：`legalFinalizeOrderFileNames(2)` 是三元集合，重排后长度仍为 3、无重复、无未知名字 → 校验通过。所以变异一测的是排序本身，不是校验器。

单跑脚本（逐字）：

```bash
#!/bin/bash
# Single-run of the named test 6e. The name carries an apostrophe ("winner's"), which is why the
# vitest invocation lives in a script instead of being nested inside rtk proxy's quoted string.
cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a || exit 1
export ECC_GATEGUARD=off DISABLE_OMC=1
npx vitest run tests/controller/runLoop.integration.test.ts -t "runLoop keeps the loser from writing through the winner's reconciliation inside the publish window"
echo "EXIT=$?"
```

（`-t` 用的是空格拼接的 `describe it` 全名，符合 Global Constraints 的 Amended 2026-08-02 (b)：箭头形式零匹配。下面每一段都显示了**具名那条本身**的非零计数，不是「全部 skipped」。）

**⚠️ 本节下面两块（以及 §5 的两块）跑的是旧测试名，已被 §11 修复轮 1 用新名字重跑的四块取代。原始文本保留不动。**

**注入前（绿）**：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/runLoop.integration.test.ts (53 tests | 52 skipped) 220ms

 Test Files  1 passed (1)
      Tests  1 passed | 52 skipped (53)
   Start at  22:29:54
   Duration  739ms (transform 231ms, setup 0ms, collect 268ms, tests 220ms, environment 0ms, prepare 44ms)

EXIT=0
```

**注入后（红）**：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/runLoop.integration.test.ts (53 tests | 1 failed | 52 skipped) 225ms
   × runLoop > keeps the loser from writing through the winner's reconciliation inside the publish window 224ms
     → expected [ 'failed:ENOENT' ] to include 'ok'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > keeps the loser from writing through the winner's reconciliation inside the publish window
AssertionError: expected [ 'failed:ENOENT' ] to include 'ok'
 ❯ tests/controller/runLoop.integration.test.ts:1908:49
    1906|       // that file is published first and this is guaranteed; publish …
    1907|       // ends in ENOENT, taking the check with it.
    1908|       expect(ownerTransferReadOutcomesInWindow).toContain("ok");
       |                                                 ^
    1909| 
    1910|       // (b) The loser did not finalize the winner's transaction on it…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 52 skipped (53)
   Start at  22:30:14
   Duration  806ms (transform 291ms, setup 0ms, collect 327ms, tests 225ms, environment 0ms, prepare 39ms)

EXIT=1
```

失败文本 `expected [ 'failed:ENOENT' ] to include 'ok'` **正是 spec 预测的那条机制**：窗口内对 `owner-transfer.json` 只发生过一次读，且以 ENOENT 结束——因为重排后事务第一次发布的是 `reconciliation-record.json`，`owner-transfer.json` 在整个窗口期间根本不存在。计划把这条变异标为「今天不可表达、是否会红分辨不出」的未结清风险；**本任务实际注入、实际跑、原始输出如上，风险在此结清：它红，且红在预测的断言、预测的原因上。**（没有为了让它红而调整过任何断言：断言在第一次跑通之后就没有再改过，红/绿两次跑之间的 diff 只有上面那一行生产常量。）

### 变异一钉住了什么、没钉住什么（明写）

- **钉住的**：在输家的 `preserveSuccessfulReconciliationIfNeeded` 返回时，「保护判定（`transferRepresentsPublishedWinner`）有没有被**求值**」。未变异：`owner-transfer.json` 已发布 → `readPersistedSuccessfulTransferArtifacts` 读成功 → 走到 `kind: "artifacts"` 分支，保护判定被求值。变异后：读以 ENOENT 结束 → 返回 `kind: "no_published_transfer"` → 保护判定**压根没被求值**。
- **没钉住的**：「赢家有没有被覆盖」。未变异时，`transferRepresentsPublishedWinner` 的结果是 **false**（`owner-record.json` 还是旧 epoch，P1 的第二次 rename 还没发生），输家**确实**在此刻写下了一份降级版本——那正是残余 TOCTOU 的形状（§13 第 4 笔），本层没关闭它。所以这条断言**比「赢家不被覆盖」弱**。这句话不只写在报告里，也逐字写在测试自己的注释里（`⚠️ What assertion (a) pins, stated honestly:` 那一段）。

## 5. 变异二：删掉 `tryRecoverStaleOwnerTransferLock` 里的活进程早退

注入点（生产代码）：`src/persistence/fileStore.ts`，`async function tryRecoverStaleOwnerTransferLock(` 之后的 pid 存活判定。它模拟的是「**活进程检查被移除**」，不是「锁的持有范围被收窄」（后者对应删 `pathExists(paths.lockPath)` 合取项，是结构性等价变异，四格逐格相同，换任何 fixture 都杀不掉）。

```
$ rtk proxy "git -C <worktree> diff -- src/persistence/fileStore.ts"
diff --git a/src/persistence/fileStore.ts b/src/persistence/fileStore.ts
index 0532be1..f8df6e6 100644
--- a/src/persistence/fileStore.ts
+++ b/src/persistence/fileStore.ts
@@ -694,7 +694,7 @@ async function tryRecoverStaleOwnerTransferLock(runDir: string): Promise<boolean
     const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
     const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
 
-    if (pid !== null && isProcessActive(pid)) {
+    if (false && pid !== null && isProcessActive(pid)) {
       return false;
     }
   } catch {
```

（写成 `false &&` 而不是整段删掉，只是为了不引入未使用变量而改动第二处代码；语义与「删掉早退」相同：该分支永不成立，控制流一律落到 `safeUnlink(lockPath)` ＋ `return true`。）

**注入前（绿）**：如实说明时序——我在还原变异一之后**没有**先补跑一次绿就直接注入了变异二，所以「注入前」这一侧由两次跑共同构成，两次都在 `git diff -- src/` 为空的同一状态上：§4 的绿块（注入变异一之前），以及还原变异二之后重跑的同一条（下面这一块）。

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/runLoop.integration.test.ts (53 tests | 52 skipped) 213ms

 Test Files  1 passed (1)
      Tests  1 passed | 52 skipped (53)
   Start at  22:35:25
   Duration  667ms (transform 189ms, setup 0ms, collect 223ms, tests 213ms, environment 0ms, prepare 41ms)

EXIT=0
```


**注入后（红）**：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/runLoop.integration.test.ts (53 tests | 1 failed | 52 skipped) 227ms
   × runLoop > keeps the loser from writing through the winner's reconciliation inside the publish window 226ms
     → expected [ '.owner-transfer.publish.tmp', …(2) ] to deeply equal []

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > keeps the loser from writing through the winner's reconciliation inside the publish window
AssertionError: expected [ '.owner-transfer.publish.tmp', …(2) ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   ".owner-transfer.publish.tmp",
+   ".owner-record.publish.tmp",
+   ".reconciliation-record.publish.tmp",
+ ]

 ❯ tests/controller/runLoop.integration.test.ts:1912:48
    1910|       // (b) The loser did not finalize the winner's transaction on it…
    1911|       // window took one of the transaction's publish temps as its sou…
    1912|       expect(publishTempRenameSourcesInWindow).toEqual([]);
       |                                                ^
    1913|     } finally {
    1914|       vi.doUnmock("node:fs/promises");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 52 skipped (53)
   Start at  22:30:36
   Duration  718ms (transform 200ms, setup 0ms, collect 240ms, tests 227ms, environment 0ms, prepare 40ms)

EXIT=1
```

收到的正是「输家替赢家 finalize 了整整三个文件」。注意断言 (a) 在这次跑里**通过了**（失败停在其后的 (b)），两条断言互相独立、各自可失败：变异一杀 (a) 不杀 (b)，变异二杀 (b) 不杀 (a)。

**「注入前绿」的独立凭据**：本报告 §4 的绿块（同一脚本、同一测试名、`1 passed | 52 skipped`、EXIT=0）与 §7 还原后的全套件 `482 passed (482)`。两条变异的注入前状态都是 `git diff -- src/` 为空的那个状态。

### 变异二注入状态下的全套件——噪声记录（Step 6）

```
 Test Files  5 failed | 24 passed (29)
      Tests  7 failed | 475 passed (482)
   Start at  22:30:50
   Duration  16.64s (transform 2.24s, setup 0ms, collect 3.64s, tests 56.83s, environment 4ms, prepare 1.51s)

TEST_EXIT=1
```

被杀掉的 7 条（含 6e 本身）完整名单，逐字来自那次未过滤跑的 `Failed Tests 7` 段：

| # | 完整测试名 | 文件 |
|---|---|---|
| 1 | `startLeaseHeartbeat > treats a busy owner-transfer lock as transient: no lease_lost, no supersession concluded, retried next tick` | `tests/controller/leaseHeartbeat.test.ts` |
| 2 | `lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy` | `tests/controller/leaseLifecycle.integration.test.ts` |
| 3 | `resumeLoop > stays fail-closed when the claim hits a busy owner-transfer lock, without claiming a CAS failure` | `tests/controller/resumeLoop.integration.test.ts` |
| 4 | `runLoop > keeps the loser from writing through the winner's reconciliation inside the publish window`（**旧名，现为** `runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`，见 §11） | `tests/controller/runLoop.integration.test.ts` ← **本任务这一条** |
| 5 | `fileStore > rejects owner transfer while a live transfer lock is held` | `tests/persistence/fileStore.test.ts` |
| 6 | `fileStore > throws OwnerTransferLockBusyError for a busy lock and OwnerTransferPreconditionError for a CAS mismatch, and neither is an instance of the other` | `tests/persistence/fileStore.test.ts` |
| 7 | `fileStore > keeps a live lock in place when recovery cannot yet proceed` | `tests/persistence/fileStore.test.ts` |

其中 1、2、3、5、6、7 这 6 条与 6e 无关、今天就在套件里（与计划 §10 记的那份名单逐条相同）。**这份名单是 6e 的噪声，不是它的护栏**——这句话也写进了测试注释。达标凭据只有上面那次**具名单跑**的 `1 failed | 52 skipped`。

## 6. 还原证明

```
$ rtk proxy "git status --porcelain"
 M .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md
 M tests/controller/runLoop.integration.test.ts
$ rtk proxy "git diff --stat -- src/"     # 空输出
SRC_DIFF_EXIT=0
$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8
$ grep -rnF 'currentOwnerEpoch + 1' src/
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
$ rtk proxy "git diff --stat -- src/registry/"     # 空输出
```

`src/` 与 `git HEAD` 逐字节一致（`git diff --stat -- src/` 零行输出），`src/registry/` 零改动，两条计数守卫仍是 8 与单一命中。（`progress.md` 的改动不是本任务写的，未触碰。）本次跑的这三条命令与输出即上文，`-F` 锚点，未用 `--include`。

## 7. 还原状态下的全套件 ＋ typecheck ＋ build（Step 7）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"
 Test Files  29 passed (29)
      Tests  482 passed (482)
   Start at  22:31:38
   Duration  16.73s (transform 2.17s, setup 0ms, collect 3.41s, tests 57.51s, environment 4ms, prepare 1.70s)

TEST_EXIT=0

$ rtk proxy "npm run typecheck"
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

$ rtk proxy "npm run build"
> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

起点基线（Step 1，同一工作副本、未变异、未过滤）：`Test Files 29 passed (29)` / `Tests 481 passed (481)` / TEST_EXIT=0。481 → 482 的差就是本任务新增的这一条。**两条允许的 flake（(B) evidence.test.ts 的 `records env names only …`、(F) runLoop.integration 的 `continues normally when execute returns a complete result during the recovery window`）在基线跑与收尾跑里都是 `✓`，本任务没有出现名单外失败。**

## 8. 改动的文件

- `tests/controller/runLoop.integration.test.ts`：新增一条测试（＋其注释），并把第 4 行的 `import { join } from "node:path"` 扩成 `import { basename, join } from "node:path"`。`git show --stat d27f317`：1 file changed, 230 insertions(+), 1 deletion(-)。
- `src/` 零净改动（两条变异注入后均已还原，见 §6）。

行号引用扫描：全仓 `grep -rnF 'runLoop.integration.test.ts:'` 的命中全部在 `docs/superpowers/**` 与 `.superpowers/sdd/**` 的历史计划/报告里（它们记录的是过去某次跑的行号，本来就是历史快照，且在本任务之前就已失效）；`src/` 与 `tests/` 里没有任何指向本文件行号的引用。本任务新增的注释一律用「文件名＋符号名」，不写行号。

## 9. 自评（fresh eyes）

- **每条断言都能失败吗？** (a) 由变异一实测击杀；(b) 由变异二实测击杀；`interleaved`（窗口没打开就红）、`analysis.status === "stale_candidate"`（输家没带 reconciliation record 就红）、事务前 `owner-transfer.json` 不存在（fixture 被人预置就红）都是可失败的前置条件断言，而且缺了它们两条主断言会在空窗口上空过。没有「写空的断言」。
- **有没有终态断言？** 没有。所有观测都限定在 `loserWindowOpen` 为真的区间内；窗口关闭后只读了 `boundary-analysis.json` 的 `status` 作为 fixture 前置条件，那是输家自己那次调用的分类，不是「谁最后赢了」。
- **注释是否诚实地写了变异一钉住/钉不住什么？** 是，见测试里 `⚠️ What assertion (a) pins, stated honestly:` 一段，并明确写了「不要把它读成比它更强的东西」。
- **两条变异都在生产代码上？** 是，两次 `git diff` 都只碰 `src/persistence/fileStore.ts`，fixture 与测试代码在三次跑里完全相同。
- **不宣布护栏问题已解决。** 本报告只贴原始输出。
- 没有合并 `persistBoundaryAnalysis` 那两处近似重复的 18 行 reconciliation 字面量，也没有让重复变多（本任务没有碰它们）。

## 10. 顾虑 / 遗留

1. **(a) 的语义边界**：断言写的是「窗口内发生过一次针对 `owner-transfer.json` 的成功读」，窗口是**输家那次 `runLoopFromState` 调用**（而不是收窄到 `writeBoundaryArtifacts` 那一层）。这在今天是等价的——输家路径上唯一读 `owner-transfer.json` 的地方就是 `readPersistedSuccessfulTransferArtifacts`，而且变异一下该文件在整个窗口内都不存在，任何位置的成功读都不可能发生——但如果将来有别的组件在 runLoop 路径上开始读这个文件，(a) 会变弱（可能被别人的成功读满足）。若要收紧，得给 `writeBoundaryArtifacts` 加一层可观测边界，那是另一处改动。
2. **执行时长与稳健性**：输家整个 `runLoopFromState`（含 git worktree）在 P1 的一次 `rename` 内部跑完，实测 ~220ms，无超时；但它把一个真实 git 操作放进了 fs mock 的回调里，属于本组最重的构造，将来若 vitest 开文件内并发或 runLoop 起后台任务，这条测试的确定性需要重新评估。
3. **变异二写成 `false &&` 而非整段删除**，理由见 §5（避免为躲未使用变量而改第二处生产代码）。语义等价，但严格说它比「物理删除」少动一行；若评审要求物理删除形态，重跑一次即可（预期同样红在 (b)）。
4. **`.superpowers/.../progress.md` 在我开工时就是 modified 状态**，非本任务所写，未触碰。

---

# §11 修复轮 1（2026-08-02）

提交 `6226fb6`（本地）：`test(runLoop): name test 6e after what it pins, and amend the plan's mandated name in place`，2 files changed, 31 insertions(+), 9 deletions(-)。独立评审结论是 **Approved / zero Critical**，本轮不是返工：一条被标为「计划强制」的 Important 上交人裁定，加一处注释准确性的折入，就是本轮全部内容。**fixture、交错构造、两条断言本身一个字节没动。**

## 11.1 改了什么

1. **改名（人的裁定）**。旧名 `keeps the loser from writing through the winner's reconciliation inside the publish window` 的第一个分句背后没有断言，而且它断言的东西在本层今天是**假的**——窗口内 `transferRepresentsPublishedWinner` 求值为 false，输家**确实**写下降级记录（残余 TOCTOU 未关闭），这一点我自己的测试注释就是这么写的。名字才是失败输出里出现的东西。新名字逐字：

   `reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`

   **分句映射（提交前逐条核对过）**：分句 1 ←→ 断言 (a) `expect(ownerTransferReadOutcomesInWindow).toContain("ok")`，实测由变异一击杀；分句 2 ←→ 断言 (b) `expect(publishTempRenameSourcesInWindow).toEqual([])`，实测由变异二击杀。**两个分句各有一条实测可失败的断言，没有为了迁就名字调整过任何断言。**

2. **注释折入**：原 `⚠️ What assertion (a) pins` 段说 (a) 钉的是「保护判定有没有被**求值**」，这比事实强了一环。改为：(a) 钉的是**成功的保护性读**，即那次判定的**前置条件**；并点名那条唯一能「满足 (a) 却没求值」的路径——`readPersistedSuccessfulTransferArtifacts` 里后续 `Promise.all` 的 `readOwnerRecord` 抛出时返回 `{ kind: "unreadable" }` → abandon，此时 (a) 仍绿而 `transferRepresentsPublishedWinner` 从未被求值；并写明该路径是**响的**（abandonment 经 operator 回调与 events.jsonl 出去）而不是静默的，所以这个缺口是被点名而非在此关闭。残余 TOCTOU 那段（评审员核实为准确）原样保留。断言 (a) 处的行内注释同步由 "The loser's protection check was reached" 改为 "The loser's protective read succeeded"。

3. **测试内新增一段注释**，说明本测试为何**不用**计划 Step 2 强制的那个名字，并指向计划里的 `Amended 2026-08-02 (d)`。

4. **计划就地注记**：`docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` 的 `### Task A9` → Step 2 下，按仓库 `*Amended <date> (x)*` 惯例新增 **`Amended 2026-08-02 (d)`**（先读过 `### Task A5` 的 (a)、Global Constraints 的 (b)，以及第 618 行已占用的 (c)，故续为 (d)）。原措辞一字未动，注记写在旁边，内容含：第一个分句没有断言且今天为假、为什么（残余 TOCTOU 使输家确实在窗口内写降级）、本测试实际钉住什么（成功的保护性读 ＋ 零次以发布 temp 为源的 rename）、以及新名字逐字。**计划文件只动了这一处。**

## 11.2 改名后重跑的变异证据（四块）

单跑脚本（逐字，只有 `-t` 里的名字换成了新名）：

```bash
#!/bin/bash
# Single-run of the named test 6e, under the renamed test (fix round 1). The name carries an
# apostrophe ("winner's"), which is why the vitest invocation lives in a script instead of being
# nested inside rtk proxy's quoted string.
cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a || exit 1
export ECC_GATEGUARD=off DISABLE_OMC=1
npx vitest run tests/controller/runLoop.integration.test.ts -t "runLoop reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window"
echo "EXIT=$?"
```

调用方式：`rtk proxy "bash <上面这个脚本>"`（`rtk` 全局 hook 会过滤输出，一律用 `rtk proxy` 绕过；脚本内先 `export ECC_GATEGUARD=off DISABLE_OMC=1`）。四块全部显示**具名那条本身**的非零计数。

### (1) 变异一，注入前（绿）

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/runLoop.integration.test.ts (53 tests | 52 skipped) 227ms

 Test Files  1 passed (1)
      Tests  1 passed | 52 skipped (53)
   Start at  22:46:34
   Duration  766ms (transform 245ms, setup 0ms, collect 268ms, tests 227ms, environment 0ms, prepare 59ms)

EXIT=0
```

### (2) 变异一，注入后（红）

```
$ rtk proxy "git -C <worktree> diff -- src/persistence/fileStore.ts"
diff --git a/src/persistence/fileStore.ts b/src/persistence/fileStore.ts
index 0532be1..5b98c2c 100644
--- a/src/persistence/fileStore.ts
+++ b/src/persistence/fileStore.ts
@@ -953,7 +953,7 @@ export async function writeOwnerTransferArtifacts(
         : {
             version: 2,
             stagedAt: transferRecord.transferredAt,
-            finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE],
+            finalizeOrder: [RECONCILIATION_RECORD_FILE, OWNER_TRANSFER_FILE, OWNER_RECORD_FILE],
           };
 
     await writeJsonFileViaFixedTemp(paths.transferPendingTempPath, paths.transferPendingPath, transferRecord);
```

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/runLoop.integration.test.ts (53 tests | 1 failed | 52 skipped) 218ms
   × runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window 218ms
     → expected [ 'failed:ENOENT' ] to include 'ok'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window
AssertionError: expected [ 'failed:ENOENT' ] to include 'ok'
 ❯ tests/controller/runLoop.integration.test.ts:1924:49
    1922|       // that file is published first and this is guaranteed; publish …
    1923|       // ends in ENOENT, taking the check with it.
    1924|       expect(ownerTransferReadOutcomesInWindow).toContain("ok");
       |                                                 ^
    1925| 
    1926|       // (b) The loser did not finalize the winner's transaction on it…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 52 skipped (53)
   Start at  22:46:44
   Duration  757ms (transform 229ms, setup 0ms, collect 276ms, tests 218ms, environment 0ms, prepare 42ms)

EXIT=1
```

### (3) 变异一还原 ＋ 三条守卫 ＋ 两次实验之间的绿跑（本轮补上了上一轮缺的这一次）

```
--- git diff --stat -- src/ ---
exit=0
--- guard 1 ---
8
--- guard 2 ---
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
--- guard 3: src/registry/ diff ---
exit=0

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/runLoop.integration.test.ts (53 tests | 52 skipped) 221ms

 Test Files  1 passed (1)
      Tests  1 passed | 52 skipped (53)
   Start at  22:47:00
   Duration  689ms (transform 189ms, setup 0ms, collect 238ms, tests 221ms, environment 0ms, prepare 42ms)

EXIT=0
```

（守卫命令逐字：`rtk proxy "git -C $PWD diff --stat -- src/"`（零行输出）、`grep -cF 'return { ok: false' src/controller/resumeLoop.ts` → `8`、`grep -rnF 'currentOwnerEpoch + 1' src/` → 单一命中、`rtk proxy "git -C $PWD diff --stat -- src/registry/"`（零行输出）。`-F` 锚点，未用 `--include`。）

### (4) 变异二，注入后（红）

```
$ rtk proxy "git -C <worktree> diff -- src/persistence/fileStore.ts"
diff --git a/src/persistence/fileStore.ts b/src/persistence/fileStore.ts
index 0532be1..f8df6e6 100644
--- a/src/persistence/fileStore.ts
+++ b/src/persistence/fileStore.ts
@@ -694,7 +694,7 @@ async function tryRecoverStaleOwnerTransferLock(runDir: string): Promise<boolean
     const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
     const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
 
-    if (pid !== null && isProcessActive(pid)) {
+    if (false && pid !== null && isProcessActive(pid)) {
       return false;
     }
   } catch {
```

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/runLoop.integration.test.ts (53 tests | 1 failed | 52 skipped) 222ms
   × runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window 221ms
     → expected [ '.owner-transfer.publish.tmp', …(2) ] to deeply equal []

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window
AssertionError: expected [ '.owner-transfer.publish.tmp', …(2) ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   ".owner-transfer.publish.tmp",
+   ".owner-record.publish.tmp",
+   ".reconciliation-record.publish.tmp",
+ ]

 ❯ tests/controller/runLoop.integration.test.ts:1928:48
    1926|       // (b) The loser did not finalize the winner's transaction on it…
    1927|       // window took one of the transaction's publish temps as its sou…
    1928|       expect(publishTempRenameSourcesInWindow).toEqual([]);
       |                                                ^
    1929|     } finally {
    1930|       vi.doUnmock("node:fs/promises");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 52 skipped (53)
   Start at  22:47:16
   Duration  736ms (transform 198ms, setup 0ms, collect 243ms, tests 222ms, environment 0ms, prepare 45ms)

EXIT=1
```

（变异二的「注入前绿」是上面第 (3) 块那一次跑，时间戳 22:47:00，注入发生在它之后、22:47:16 那次之前，中间只改了这一行生产代码。）

**两条断言仍然各自独立可失败**：变异一杀 (a) 不杀 (b)，变异二的失败块显示 (a) 通过、停在 (b)。

## 11.3 还原 ＋ 收尾验证（未过滤）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"
 Test Files  29 passed (29)
      Tests  482 passed (482)
   Start at  22:48:09
   Duration  17.30s (transform 2.39s, setup 0ms, collect 3.82s, tests 59.87s, environment 5ms, prepare 1.84s)

TEST_EXIT=0

$ rtk proxy "npm run typecheck"
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

$ rtk proxy "npm run build"
> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0

$ 三条守卫（还原后）
src_diff_exit=0            # rtk proxy "git -C $PWD diff --stat -- src/" 零行输出
8                          # grep -cF 'return { ok: false' src/controller/resumeLoop.ts
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
registry_diff_exit=0       # rtk proxy "git -C $PWD diff --stat -- src/registry/" 零行输出
```

两条允许的 flake 在本轮收尾跑里都是 `✓`，无名单外失败。测试总数仍为 482（本轮没有增删测试，只改了名字与注释）。

## 11.4 本轮改动的文件

- `tests/controller/runLoop.integration.test.ts`：测试改名 ＋ 三处注释（`⚠️ (a) pins` 段重写、断言 (a) 行内注释一句、新增改名理由段）。断言、fixture、mock、交错逻辑零改动。
- `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`：`### Task A9` Step 2 下新增 `Amended 2026-08-02 (d)`，原措辞未动，文件其余部分未动。
- `src/` 零净改动（两条变异注入后均已还原，证明见 11.2(3) 与 11.3）。

## 11.5 本轮顾虑

1. `Amended` 字母序取 **(d)**，因为 (c) 已被本计划第 618 行占用（Task A5 判据 A 那条）。若仓库另有别处也在用 (d)，需要重编。
2. §1–§9 的历史证据块引用旧测试名，按指示保留原文并加了取代标记（顶部全局提示 ＋ §1、§4、§5 噪声表三处就地标记）；这些块里的 vitest 原始输出无法加标记（改动即失真），标记一律加在其紧邻的正文里。
3. 上一轮的三条顾虑（(a) 的窗口边界、交错构造的重量、变异二写成 `false &&`）评审均判为 sound，本轮未做改动，仍然成立。
