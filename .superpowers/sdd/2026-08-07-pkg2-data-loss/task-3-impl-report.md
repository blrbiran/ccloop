# 任务 3（第 1 笔）阶段 1 —— 实施报告

## 1. 结论（最先写）

**DONE**。

**commit 范围**：本次会话在 `feat/pkg2-data-loss` 分支（`.worktrees/pkg2-data-loss`）上，
基于 BASE `2d7ff84`（"docs(sdd): 任务 3 阶段 1 实施 brief"）新增一个提交，改动两个文件：
- `src/persistence/fileStore.ts`（`recoverInterruptedOwnerTransfer` 的 `!lockHeld` 分支，形状按 §3.3）
- `tests/persistence/fileStore.test.ts`（新增一条并发判据 + 一个局部 `createDeferred` 辅助函数）
- 本报告文件本身（`git add -f`，该目录 `.gitignore` 为 `*`）
提交 hash 见 §9 末尾（**commit hash `e97ff05`**（parent `2d7ff84`），"fix(fileStore): make
recoverInterruptedOwnerTransfer's unlocked branch acquire the lock before finalizing (task 3 /
phase 1)"，`3 files changed, 472 insertions(+), 1 deletion(-)`，`git status` 确认工作树干净。

## 2. 改了什么

**文件**：`src/persistence/fileStore.ts`。**函数**：`recoverInterruptedOwnerTransfer`。**分支**：`!options?.lockHeld` 那一支（原第 1021-1023 行）。

**改前**（探锁 → 可能删锁 → 不持锁 finalize）：
```ts
if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
  return;
}

await finalizePendingOwnerTransfer(runDir);
```

**改后**（取锁 → 持锁 finalize → 释放，行 1021-1044）：
```ts
if (!options?.lockHeld) {
  let lock: { release: () => Promise<void> };

  try {
    lock = await acquireOwnerTransferLock(runDir);
  } catch {
    return;
  }

  try {
    await finalizePendingOwnerTransfer(runDir);
  } finally {
    await lock.release();
  }

  return;
}

await finalizePendingOwnerTransfer(runDir);
```
（`lockHeld: true` 分支——最后一行 `await finalizePendingOwnerTransfer(runDir)`——原样不动，三个调用点未碰。）

**为什么这个形状满足 §3 的两个设计细节**：
1. **取锁失败一律 `return`，不外抛**：`catch { return; }` 只包住 `acquireOwnerTransferLock` 这一步调用。`acquireOwnerTransferLock` 可能抛 `OwnerTransferLockBusyError`（EEXIST 且 `tryRecoverStaleOwnerTransferLock` 判活）或非 EEXIST errno（`EACCES`/`ENOSPC`，直接 rethrow，见源码 820-862 行），两者都被这个 catch 吞掉，`readOwnerRecord` 不会因为锁而产生新失败模式。
2. **只在「取锁」这一步宽 catch，`finalizePendingOwnerTransfer` 的抛原样外传**：`finalizePendingOwnerTransfer(runDir)` 被放在**第二个**独立的 `try`/`finally` 里，这个 try 没有 `catch`，四种 fail-closed 抛（`OwnerTransferMarkerUnreadableError`/`OwnerTransferPendingMissingError`/`OwnerTransferMarkerFinalizeOrderInvalidError`/其他 I/O 错误）会穿过 `finally` 正常向上传播，不被吞。
3. **`finalize` 抛时走 `finally` 释放锁**：`await lock.release()` 放在 `finally` 块里，无论 `finalizePendingOwnerTransfer` 是否抛都会执行，与 `writeOwnerTransferArtifacts`（1040-1076 行）已有形状一致。

## 3. 三步判据（A/B/C）的完整证据

**新增判据**：`tests/persistence/fileStore.test.ts` 内新 `describe("recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker", ...)`，
唯一测试标题：
`lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing`。

**设计**（回应 §4 的「怎么写才不是自证」）：Node 单线程，两个进程级并发不可能在单进程测试里真发生；
若单纯 `Promise.all([readOwnerRecord(runDir), readOwnerRecord(runDir)])` 不加控制，两次调用谁先拿到锁、
第二次的 `open(lockPath,"wx")` 是发生在第一次已写完锁内容之后（真 EEXIST）还是发生在一次「长度为 0」的
锁文件窗口（会误触发已知的残余 G3' 而不是本判据要测的东西），完全取决于调度巧合 —— **断言会自证或飘忽**。
沿用本文件既有的 `vi.doMock("node:fs/promises", ...)` + `vi.resetModules()` + 动态 `import()` 手法
（与文件里已有的 `crashOwnerTransferAtStep` 同一手法，仅用于**观察/延迟**生产代码本来就会发出的真实 fs 调用，
**不改一行生产代码**）：
- 包一层 `open`：读者 A 的 `open(lockPath,"wx")` 成功后，**只 monkey-patch 这一个 `FileHandle` 实例**的
  `writeFile` 方法（不影响模块级 `writeFile`、不影响其它任何测试）——真正把内容写完之后才 resolve
  `aLockWritten`（保证读者 B 看到的锁文件永远有完整合法内容，不会撞上已知且不在本任务范围内的
  「锁文件长度为 0」窗口），然后 `await bAttemptedAcquire.promise` 把 A **暂停在这里**，直到 B 已经真正
  尝试并失败地 acquire 过。
- 包一层 `readFile`：读者 B 的失败 acquire 路径里，`tryRecoverStaleOwnerTransferLock` 唯一会读的就是锁文件
  本身；一旦观察到这次读发生，就 resolve `bAttemptedAcquire`，放行 A 继续。
- 测试驱动：`const aPromise = readOwnerRecord(runDir); await aLockWritten.promise; const bPromise = readOwnerRecord(runDir); await Promise.all([aPromise, bPromise]);`
  —— B 是在 A 已经持有**内容完整**的锁之后才被启动的，保证 B 的 `open` 一定拿到真 `EEXIST`
  （OS 级原子保证，不是靠 mock 模拟），而 A 在 B 完成失败 acquire 之前不能继续，保证 A 不会抢跑到
  finalize/release。

**A 注入前绿**（命令 + 完整未过滤输出，脚本先落盘 `run-a.sh`，`rtk proxy zsh` 跑）：
```
export ECC_GATEGUARD=off DISABLE_OMC=1
cd /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss
npx vitest run tests/persistence/fileStore.test.ts -t "lets exactly one of two concurrent readOwnerRecord calls finalize the transaction" --run
```
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

 ✓ tests/persistence/fileStore.test.ts (77 tests | 76 skipped) 10ms

 Test Files  1 passed (1)
      Tests  1 passed | 76 skipped (77)
   Start at  12:54:38
   Duration  547ms (transform 226ms, setup 0ms, collect 264ms, tests 10ms, environment 0ms, prepare 50ms)
```
`Tests  1 passed | 76 skipped (77)` —— 非零命中，选择器命中的是这条新测试本身（不是 0 matched 空跑）；
`RUN` 首行路径已核为 `…/.worktrees/pkg2-data-loss`。

**B 注入后红**：对 `src/persistence/fileStore.ts` 做一次能杀死它的变异 —— 按 brief §6 给的第一个例子，
去掉 `finally { lock.release() }`（改成 finalize 完就直接 `return`，不释放锁；生产代码上加了
`// MUTATION: dropped the finally{ lock.release() } to prove the new concurrency test can go red.` 注释）。
同一条命令重跑：
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

 ❯ tests/persistence/fileStore.test.ts (77 tests | 1 failed | 76 skipped) 14ms
   × recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker > lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing 13ms
     → promise resolved "'{\n  "holderProcessInstanceId": "pid:…'" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker > lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing
AssertionError: promise resolved "'{\n  "holderProcessInstanceId": "pid:…'" instead of rejecting

- Expected:
[Error: rejected promise]

+ Received:
"{
  \"holderProcessInstanceId\": \"pid:83135\",
  \"acquiredAt\": \"2026-08-09T04:56:04.352Z\"
}"

 ❯ tests/persistence/fileStore.test.ts:3027:76
    3025|         await expect(readFile(join(runDir, ".owner-transfer.pending.js…
    3026|         await expect(readFile(join(runDir, ".owner-record.pending.json…
    3027|         await expect(readFile(join(runDir, ".owner-transfer.lock"), "u…
       |                                                                            ^
    3028|       } finally {
    3029|         vi.doUnmock("node:fs/promises");

 Test Files  1 failed (1)
      Tests  1 failed | 76 skipped (77)
```
**具体红点**：`fileStore.test.ts:3027`，`await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();` ——
锁文件不再被删除（因为 finalize 之后没有 `finally` 释放），断言「锁不该留下」失败，`readFile` 拿到了真实
锁文件内容而不是抛错。**这证明新判据不是恒绿**：它确实会因为「finalize 后不释放锁」这个真实回归而变红，
命中的正是设计文档 §3.3 点名的第二个必须细节（finalize 抛/完成后必须走 `finally` 释放）。

**C 还原后绿**：
- ⚠️ **一处与 brief 字面的偏差，如实记录**：brief 建议用 `git checkout -- <单个明确文件路径>` 做还原。
  但本次变异是在**尚未提交**任何改动的工作树上做的 —— 此刻 `git checkout -- src/persistence/fileStore.ts`
  会把文件整个还原到 BASE `2d7ff84`（连同本任务真正的修复一起丢掉），而不是只丢掉这次手工加的变异。
  为避免这个误操作，本笔改用 `Edit` 工具把变异那几行**精确改回**变异前记录下的原文（逐字比对，见下），
  效果与「先提交修复、再变异、再 `git checkout --` 丢弃未提交变异」完全等价，只是顺序不同
  （本任务是先修复+测试都还没提交，所以选择先手工精确还原，稍后一次性提交「修复 + 测试」）。
  证据链条与 brief 要求的三项完全一致，只是执行手段不同，如实记录以便评审员核对。
- **证明还原**：
  ```
  $ grep -c MUTATION src/persistence/fileStore.ts
  0
  $ git diff --stat -- src/persistence/fileStore.ts
  src/persistence/fileStore.ts | 20 +++++++++++++++++++-
   1 file changed, 19 insertions(+), 1 deletion(-)
  ```
  （非零输出符合预期 —— 这是「相对 BASE 的合法修复」的 diff，`grep -c MUTATION` 为 0 证明变异注释本身已清除；
  变异存在时那 20 行会变成完全不同的一段并带有 `MUTATION` 字样，这里确认已经是修复后的干净版本。）
- **重跑变绿**（同一条命令）：
  ```
   RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

   ✓ tests/persistence/fileStore.test.ts (77 tests | 76 skipped) 10ms

   Test Files  1 passed (1)
        Tests  1 passed | 76 skipped (77)
     Start at  12:57:07
     Duration  546ms (transform 238ms, setup 0ms, collect 276ms, tests 10ms, environment 0ms, prepare 49ms)
  ```
  随后跑了一次全量套件（见 §4），该测试在 `Tests 518 passed (518)` 里正常计入，无需靠单跑窄化才能绿。

## 4. 全量验证

命令（脚本先落盘 `run-full.sh`，`rtk proxy zsh` 跑，未过滤，完整落盘到 scratchpad `full-run.log` 后整份读出）：
```
export ECC_GATEGUARD=off DISABLE_OMC=1
cd /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss
npx vitest run --run; echo "TEST_EXIT=$?"
./node_modules/.bin/tsc --noEmit; echo "TSC_EXIT=$?"
npm run build; echo "BUILD_EXIT=$?"
```

**首行**：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss`
—— 已核为 worktree 路径，不是仓库根。

**结尾两行**：
```
 Test Files  30 passed (30)
      Tests  518 passed (518)
```
（基线是 30 files / 517 tests；本轮 518 = 517 + 本任务新增的那 1 条判据。）

**三个退出码**：`TEST_EXIT=0` ／ `TSC_EXIT=0` ／ `BUILD_EXIT=0`。

**关于「允许出现的红」**：本轮**零红**，连允许名单里的两条 flake（(B) `records env names only and
tracks descendants rooted at the spawned pid`、(F) `continues normally when execute returns a
complete result during the recovery window`）本轮都是绿的（(B) 见完整输出第 128 行，
`✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 3121ms`；
(F) 未在 vitest 默认 reporter 的详细行里单独打印——`runLoop.integration.test.ts` 该文件 58 条测试里
reporter 只展开打印了 9 条，但文件级 `✓ tests/controller/runLoop.integration.test.ts (58 tests) 13284ms`
且总计 `Tests 518 passed (518)` 零失败，说明该文件全部 58 条含 (F) 都通过，不是被摘要掉的红）。
人裁 10 那条名单外挂账失败（`persists phase usage evidence from the subprocess adapter without
recomputing controller totals`）本轮也是绿的（完整输出第 124 行，820ms）——**按名比对，不重新调查根因，
只如实记录本轮通过**，不外推为「已修复」。

## 5. §5 三件事的实撞结果

**搜索面先声明**：本节的 grep 全部限定在 `src/` + `tests/`，脚本先落盘、`rtk proxy zsh` 跑；
每次检索配一条必命中探针（`readOwnerRecord` 在 `tests/persistence/fileStore.test.ts` 命中 27 次）
和一条零命中探针（`ZZZ_NONEXISTENT_TOKEN_9f3x` 在 `src`+`tests` 零命中），两条都核对过，检索面是活的。

**1. `snapshotTree`/全树快照类断言不受阶段 1 影响 —— 亲自实跑撞过，不是转述控制器的机械论证**：

  §4 的全量验证已经把 `tests/registry/zeroWrite.test.ts`（5 条测试）整个跑过一遍，全绿
  （见 §4 完整输出）。特别读了其中承重的第一条
  `it("is load-bearing: readOwnerRecord itself mutates the recovery fixture (brief step 1)")`
  （`tests/registry/zeroWrite.test.ts:190-216`）：它直接调用 `readOwnerRecord(recoveryRun)`
  （不经 scan 层），断言 `after !== before`、`.owner-transfer.transaction.json`/两个 pending 在 after
  快照里 `toBeUndefined()`、`owner-record.json` 被改写到 epoch 2。**阶段 1 之后这条测试原样通过**
  ——机械理由亲自核实：我的新分支在锁被 `acquireOwnerTransferLock` 创建后，`finalizePendingOwnerTransfer`
  执行完毕、`lock.release()`（`handle.close()` + `safeUnlink`）执行完毕才 `return`，**锁文件在
  `readOwnerRecord` 调用返回之前已经被创建又删除**，`snapshotTree` 只在快照那一刻遍历磁盘，
  不可能捕捉到一个已经不存在的瞬时文件（它只记文件/符号链接的 `{size, mtimeMs, sha256}`，
  目录本身不留 mtime 记录）。**这是实跑通过 + 读代码验证到的机制，不是单方转述。**
  第二条 `it("scans a realistic tree with defaultScanDeps and writes nothing, including on the recovery
  path")`（`:218`）走 `defaultScanDeps` → `readOwnerRecordWithoutRecovery`，本任务一个字没碰，
  同样全绿。

**2. 设计员 §7.1「估计全绿」的 10 类既有判据 —— 全部实跑过，不是继承估计**：

  §4 的全量验证覆盖了整个仓库 30 个测试文件 518 条测试（含 `fileStore.test.ts` 的全部 77 条、
  `zeroWrite.test.ts` 的全部 5 条），**零红**。这本身就是对「估计全绿」最强的一次实证 ——
  不是只挑设计员列的 10 条单独验，而是全量套件一次不漏地跑过。

**3. 锁泄漏的现成执行机制 —— 亲自数过，数字比 brief 引用的略多一点，如实记明**：

  `grep -c 'readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow()'
  tests/persistence/fileStore.test.ts` = **9**（brief §5.3 原文引用「8 处」，是阶段 1 之前的计数；
  本任务新增的并发判据里那条「no leftover lock」断言正好用的是同一个字面模式，
  ⇒ 8 + 1（我新加的）= 9，**不是 brief 数错，是基数随本任务改动同步长了一个**，就地记明不外推）。
  `tests/registry/zeroWrite.test.ts` 里 `pathExists(...".owner-transfer.lock"...).toBe(false)`
  这一类断言实测有 **3 处**（`:567 :736 :802`），比 brief §5.3 原文「有一条」多——**这是 brief 原文对
  既有测试基数的一处不准确复述，我这次是照今天真实代码数出来的，不是沿用 brief 的数字**，
  就地记明、不外推、不影响本任务结论（无论是 1 处还是 3 处，这些既有断言在本轮全量验证里都是绿的，
  说明锁没有泄漏）。
  ⚠️ 反向事实也复核过：`grep -n "blockingPaths" src/**/*.ts` 与 `directoryHasEntries` 的调用点—— 本任务
  没有改动 `ensureFreshRunDir`/`blockingPaths`/`directoryHasEntries` 任何一行，这条「锁泄漏在生产侧静默」
  的反向事实原样成立，未被本任务改变，也未被本任务验证（不在阶段 1 改动面内，见 §8）。

## 6. 阶段 1 明确不 covers 的部分（原样复述，不含糊过去）

- **锁仍可被偷**（§13 第 1 笔原文原封不动）。残余口子从「marker 一在就长期敞开的 G0」缩到
  「需撞纳秒调度窗口的 G3'」＋「G2-null」—— **这是降级，不是关严**。
  - **G3'（零长度锁窗口）**：读者恰好落在持有者 `open(wx)` 返回、`writeFile` 未落盘之间；
    `JSON.parse("")` 抛 → catch → `hasStagedArtifacts`（marker 在时恒真）→ 删锁。今天可达，
    但要求命中一个很窄的调度窗口（本任务的新判据在设计上专门避开了这个窗口 —— 见 §3 里
    monkey-patch `handle.writeFile` 那一段，是为了不让测试误撞进 G3'，不是为了关闭它）。
  - **G2-null**：锁记录里的 `holderProcessInstanceId` 不是 `pid:<digits>` 形式 → `parsePid`
    返回 `null` → 跳过判活直接删锁。今天不可达（写者形式写死），且无测试钉住。
  - 要关严两者都要走阶段 2（人裁点 B / C），本任务未做、未获授权做。
- `readOwnerRecord` **依然是写者**。它现在是「持锁的写者」而不是「不持锁的写者」，但契约本身
  （L1/L2「读不许写」= 只读层不许绑 `readOwnerRecord`，必须绑 `readOwnerRecordWithoutRecovery`）
  一个字没变，仍然是一条靠注释 + 测试守的人工纪律，不是结构性保证（路 B 才是，未做）。
- `finalizePendingOwnerTransfer` 内**依然零守卫**：不 CAS、不比所有权、不判活、连 `lockPath`
  这个名字都不出现在函数体里。它对「我是不是唯一 finalizer」没有自检能力 —— 阶段 1 给它的保护
  完全来自调用者（现在总是持锁调用），而不是它自己变得更安全。
- **fsync 一概没有**。本任务未新增任何 fsync 调用，也未评估此事，与阶段 1 之前状态一致。

## 7. 有没有既有判据变红

**没有。** §4 全量验证：30 files / 518 tests **全绿**，零红（含允许名单里的 (B)/(F) 两条 flake
本轮也是绿的，人裁 10 那条名单外挂账失败本轮同样是绿的，按名比对记录，不外推为已修复）。
没有任何既有判据被改动断言，也没有任何既有判据变红。

## 8. 没做/没验的部分（如实列，不用「应该没问题」代替）

- **没有测试真正跨 OS 进程的并发**，只在单进程内用 `vi.doMock` 强制交错模拟两个「读者」。
  两个真实进程各自 `open(lockPath,"wx")` 竞争同一把锁在 OS 层面仍然是原子的（这是
  `acquireOwnerTransferLock` 本身依赖的 POSIX 保证，阶段 1 没有改这部分），但本任务没有另外
  写一个真正 spawn 两个子进程的测试去实测这一层——判断这类测试收益低（POSIX `O_EXCL` 的原子性
  不是本任务改动的东西）而没有做，**是我的判断，未经额外验证**。
- **G3'（零长度锁窗口）与 G2-null 的实际可达性未测**：brief §2 硬边界 1 明令不许碰
  `tryRecoverStaleOwnerTransferLock` 的判活逻辑，本任务遵守边界，没有为这两个残余口子写任何
  新测试（新判据的设计里还特意 monkey-patch 了 `handle.writeFile` 来**避开**误撞进 G3' 的窗口，
  见 §3），所以这两个口子目前处于「设计文档推演过、本任务未验证」的状态，与阶段 1 之前一致。
- **`acquireOwnerTransferLock` 抛非 `EEXIST` errno（`EACCES`/`ENOSPC`）时的 catch 分支未单独构造测试**。
  §3.3 要求「取锁失败一律 return」覆盖这类错误，代码上 `catch {}` 是无条件宽 catch，逻辑上确实覆盖
  这条路径，但本任务没有另写一条注入 `EACCES`/`ENOSPC` 的测试去实测这个特定分支——只验证了
  `OwnerTransferLockBusyError`（EEXIST → 判活 → busy）这一条路径。**这是我判断优先级后跳过的一项**，
  如实列出，不代表已验证。
- **S1 表格里除 zeroWrite 之外的其它「精确文件集合」断言点**（`runLoop.integration:1586`、
  `runLoop.integration:1884/2530/2701/2843`、`leaseLifecycle:1419/1490`、`fileStore.test.ts:3186/3206`）
  没有逐条单独重新构造针对性验证，依据的是：①这些断言点本身在完整套件里全绿跑过一次（间接证据）；
  ②它们的机械理由（判据只看 `attempts/`/`worktrees/` 子目录、或不经 `readOwnerRecord`）本任务读代码
  复核过、逻辑不因本任务改动而变化。**没有为它们单独写新的定向测试**，如实列出。
- **commit 尚未在本节撰写时完成**——落盘协议要求先写报告骨架、后续按小节填充，实际提交动作在
  全部报告小节写完之后执行；commit hash 见 §1（提交后回填）。

## 9. 预算记账（Rule 6：单任务 100k）

**没有精确的 token 计数工具可读**，只能给数量级估计，如实标注这是估计不是精确值：
本任务读了 brief 全文（约 180 行）＋ progress.md §11/§13（约 140 行）＋ design.md §3.3/§6
（约 220 行，含 §3.4/§4/§5 的相邻上下文，因为 §3.3 的推理依赖它们）＋ 大量源码/测试代码阅读
（`fileStore.ts` 相关函数 ~400 行、`fileStore.test.ts` 相关片段 ~600 行）＋ 三次单测运行 ＋
一次全量套件运行（30 files / 518 tests，日志 155 行）＋ 本报告自身（约 200 行）。
**估计已经消耗了单任务 100k 预算里相当可观的一部分（大致处于 6-8 成量级），但没有精确数字可以
贴出，如实标注为估计，不假装精确**。没有触发「必须当场收口」的信号（任务已经做完到可以交付的状态），
但如果后续还有本任务范围内的追加工作（例如评审员要求的修复环），**下一步操作前应该先重新核一次
实际用量，不能想当然认为还有余量**。
