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

⚠️ **回填（修复环 1 开始前）**：控制器反馈 harness 实测上一轮用了 **195,610 tokens**——
远超我当时给的「6-8 成量级」估计（即已经**超过**单任务 100k 预算的 1.9 倍，不是接近而是已经超支）。
**如实认领**：我上一轮把「没有精确计数工具」当成了「可以给一个模糊估计」的许可，这是错的 ——
Rule 6 要求「若接近预算，当场明写，不许静默超支」，而我给的区间估计**在数量级上就错了**，
这不是「精确度不足」，是**我的估计方法本身不可靠**，不应该再被当作参考基准。
本轮（修复环 1）预算记账见本节末尾的回填，会明确标注「我依旧拿不到精确数字」，不再给一个
可能同样量级错误的估计冒充结论。

## 修复环 1（独立评审员 review-task-3.md，0 Critical / 3 Important / 3 Minor；本环只处理 3 条 Important）

### 结论（最先写）

**DONE。** 3 条 Important 全部处理；3 条 Minor 按控制器指示原样 deferred，未动。
**commit hash `4bc5392`**（parent `1cfba42`，控制器自己在此之前先提交了一次台账 §14；再之前是
评审员报告落盘的 `7ff426d`）。本环只有一个提交，改了 `tests/persistence/fileStore.test.ts` ＋
本报告本身；`src/` 零改动（`git diff --stat -- src` 本环全程零输出，生产代码未动，符合评审员
「生产代码本身我不要求改」的定性）。全量验证 30 files / 518 tests 全绿，
`TEST_EXIT=0 / TSC_EXIT=0 / BUILD_EXIT=0`，**没有任何既有判据变红**。

**每条 Important 用哪条判据钉住**（点名测试名，详见下文「验证证据」一节）：
- **Important-1**（承重注释为假、断言钉偶然调度顺序）：改写同一条
  `tests/persistence/fileStore.test.ts` 里
  `describe("recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker")`
  → `it("lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the
  other returns without writing")`——把对 `ownerFromB.currentOwnerEpoch`/`currentProcessInstanceId`
  的定值断言，换成「渲染只在 `finalizeOrder.length` 上」的 `rename` 调用计数不变式 ＋
  对 `ownerFromB.currentOwnerEpoch` 改为「合法值集合 `[1, 2]`」的宽断言，并改写了失实的注释。
- **Important-2**（finalize 抛时锁必须释放这条设计细节全仓零判据）：给
  `tests/persistence/fileStore.test.ts` 里三条既有 fail-closed 测试
  （`refuses to finalize a v2 marker whose finalizeOrder omits a legal file, rather than silently
  orphaning the omitted pending` / `refuses to finalize a v2 marker whose reconciliation pending
  is missing, keeping the marker and staging in place` / `refuses to finalize an unparseable
  marker, keeping every staged file in place`）各**新增一行纯断言**
  `await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();`
  ——三条既有断言一字未改，只加了新行。
- **Important-3**（新判据对真回归唯一鉴别力是 5 秒超时，非断言）：同 Important-1 的那条 `it(...)`,
  给 `aLockWritten` 的等待包一层新增的模块级辅助函数 `withNamedTimeout`（3000ms，早于 vitest 默认
  5000ms 超时），超时时抛一个具名 `Error`，直接指认「reader A 没有在 3s 内打开锁文件 ⇒ 未锁分支
  没有在取锁」这条不变式，取代 vitest 通用的 `Test timed out in 5000ms`。

**有没有既有判据变红**：**没有**。全量验证 518/518 全绿；三条 fail-closed 测试新增的断言不影响它们
既有的 `rejects.toBeInstanceOf(...)` 与「marker/pending 仍在」那几条既有断言（新行加在最后，
既有断言字节不变）。

### 3 条 Minor —— 按控制器指示，本环一律不动

- Minor-1（报告 §3 对 B 步变异的措辞不准确）：**不动**，属于报告措辞问题，deferred。
- Minor-2（C 步还原证据不锁定字节）：**不动**，本环所有变异均采用
  「先提交（HEAD `7ff426d`）→ 变异 → `grep -c MUTATION_RV` + `git diff --stat -- <file>` 验证还原」，
  已经是评审员建议的正确做法（见下），但这不算是回去改 Minor-2 本身的措辞，Minor-2 作为 deferred
  finding 原样挂账，不在本报告里改判它的状态。
- Minor-3（「全量绿」被报告 §5 说成对设计员估计的「最强实证」措辞过强）：**不动**，deferred，
  未回去改 §5 原文措辞。

### 修复设计（怎么改的，为什么这样改）

**Important-1 + Important-3 合并处理**（同一条测试的两处缺陷）：

- 评审员指出 `expect(ownerFromB.currentOwnerEpoch).toBe(1)` 钉的是「B 的裸读发生在 A 改写
  `owner-record.json` 之前」这一**偶然的时序**，不是「B 没有 finalize」这个真正该钉的不变式；
  且上方注释「held by the same gates」今天为假——我核实评审员的构造完全正确：`bAttemptedAcquire`
  在 B 的 `readFile(lockPath)` 调用**返回结果之后**才 resolve（见改动前代码 `const result = await
  actual.readFile(...args); if (...) bAttemptedAcquire.resolve(); return result;`），
  A 立刻被放行去跑 finalize；而 B 自己还要再走 `JSON.parse` → `isProcessActive` → 抛
  `OwnerTransferLockBusyError` → catch → `readOwnerRecordRaw`，这几步和 A 的 finalize（约 8 次 fs
  操作）完全没有互斥关系，谁先摸到 `owner-record.json` 纯属两条 promise 链各自要跑几步的偶然结果。
  **接受评审员的判断，不重新论证。**
- **改法**：采用评审员在 Findings 里给出的方向——「由计数（对 `rename`/marker unlock 的观测计数）
  或由『B 的这次 `readOwnerRecord` 全程没有产生任何写』来表达」。具体实现：在测试已有的
  `vi.doMock("node:fs/promises", ...)` 里新增一个 `rename` 包装，累加调用次数到 `renameCount`；
  `finalizePendingOwnerTransfer` 对 `marker.finalizeOrder` 的每个条目**恰好**做一次 `rename`
  （见 `src/persistence/fileStore.ts:991-996` 的 `for (const entry of staged) { …; await
  rename(entry.tempPath, entry.targetPath); }`），所以 `renameCount === finalizeOrder.length`
  直接编码「finalize 总共只跑了一次」——如果两个读者都跑到 finalize，要么是 4 次 rename（两次都
  成功），要么是第二次在读已被第一次删除的 pending 时 ENOENT 抛出（Promise.all 直接 reject，
  测试本身就会失败）。`finalizeOrder` 变量本身与写 marker fixture 那处**共用同一个数组**，
  避免把「2」这个数字写死两遍、失去可追溯性。
  对 `ownerFromB` 保留了两条**不依赖调度顺序**的断言：`runId` 不随 epoch 变化恒为 `"task-1"`；
  `currentOwnerEpoch` 断言改为「属于 `[1, 2]` 合法值集合」——诚实地承认两个值都是「B 走了
  busy-return 路径、自己没有 finalize」这同一个正确行为下的合法结果，不再假装能预测具体哪个。
  注释同步改写，不再写「held by the same gates」这句失实的话。
- **Important-3 单独再加一层**：给 `aLockWritten` 的等待包一个新增的模块级函数
  `withNamedTimeout<T>(promise, ms, message)`（放在 `createDeferred` 旁边，同样的辅助函数区），
  内部用 `Promise.race` 语义（`setTimeout` 拒绝 + 原 promise 的 `.then` 双路径，都会 `clearTimeout`
  避免遗留定时器）实现；超时阈值选 **3000ms**（明显小于 vitest 单测默认 5000ms 超时，保证具名错误
  一定先触发，而不是被 vitest 自己的通用超时抢先）。旧形状下 A 根本不 `open` 锁文件，`aLockWritten`
  永不 resolve，3s 后会抛出具名错误，直接指认「unlocked 分支没有在取锁」，而不是一条无信息量的
  `Test timed out in 5000ms`。

**Important-2**：评审员的建议是「给三条 fail-closed 测试中的至少一条补上」锁已释放的断言，
且强调「这是纯新增断言，不改任何既有断言」。本环选择**三条全补**而不是「至少一条」——
三条测试各自钉的是 `finalizePendingOwnerTransfer` 三种不同的抛出原因
（`OwnerTransferMarkerFinalizeOrderInvalidError` / `OwnerTransferPendingMissingError` /
`OwnerTransferMarkerUnreadableError`），补全三条能确认「finalize 抛时锁必被释放」这条设计细节
在**每一种**抛出原因下都成立，而不是只在其中一种下被偶然验证到。每条测试只在文件末尾追加了一行
`await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();`
（外加一行两句注释），**逐字核对过：三条测试原有的所有断言一个字节没动**。

### 验证证据（每条 Important 各自的 A/B/C）

三条 Important 共用同一份「先改（对齐 HEAD `7ff426d`）→ 单独跑绿 → 精确复现评审员给出的那个
构造场景（红）→ 手工还原变异并核对（`grep -c MUTATION_RV` 0 命中 ＋ `git diff --stat -- src`/`--
src tests` 与预期改动面一致）→ 重跑绿」流程。**全部命令脚本先落盘、`rtk proxy zsh` 跑、
未过滤、整份读出**（下面贴的是关键片段，完整日志在 scratchpad
`fix1-a.log` / `fix1-m4.log` / `fix1-m4-restored.log` / `fix1-m3.log` / `fix1-m2.log` /
`fix1-full.log`）。

**A（本环改完之后，整份 `fileStore.test.ts` 单跑，含三条 Important 触及的全部测试）**：
```
export ECC_GATEGUARD=off DISABLE_OMC=1
cd .../.worktrees/pkg2-data-loss
npx vitest run tests/persistence/fileStore.test.ts --run
```
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

 ✓ tests/persistence/fileStore.test.ts (77 tests) 682ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 512ms

 Test Files  1 passed (1)
      Tests  77 passed (77)
```
非零命中（77/77），`RUN` 首行为 worktree 路径。

**Important-1 的 B（重放评审员的 M4：只在测试侧插入 100ms 合法重调度，生产代码不动，
证明改写后的判据不再被这个手法击穿）**：在 mock 的 `readFile` 里 `bAttemptedAcquire.resolve()`
之后加 `await new Promise((r) => setTimeout(r, 100));`（标注 `MUTATION_RV`），单跑该具名测试：
```
 ✓ tests/persistence/fileStore.test.ts (77 tests | 76 skipped) 111ms
 Test Files  1 passed (1)
      Tests  1 passed | 76 skipped (77)
```
**仍然绿**（耗时从 9ms 变成 111ms，符合插入了 100ms 延迟的预期）——证明 Important-1 的修复生效：
评审员用来证伪旧断言的那个「完全合法的重调度」，改写后的判据不再受它影响。
**C**：手工去掉这三行 `MUTATION_RV` 插入代码，`grep -c MUTATION_RV tests/persistence/fileStore.test.ts`
= 0，`git diff --stat -- src tests` 只剩本环合法改动（`tests/persistence/fileStore.test.ts | 85
+++...----`，`1 file changed, 76 insertions(+), 9 deletions(-)`，src 侧零输出），重跑同一条命令，
`Tests 1 passed | 76 skipped (77)`，9ms（与插入前一致）。

**Important-3 的 B（重放评审员的 M3：生产代码还原成阶段 1 之前「探锁 → 可能删锁 → 不持锁
finalize」的形状，标注 `MUTATION_RV`）**：
```
 ❯ tests/persistence/fileStore.test.ts (77 tests | 1 failed | 76 skipped) 3015ms
   × recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker >
     lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other
     returns without writing 3014ms
     → reader A never opened the owner-transfer lock file within 3000ms -- the unlocked branch is
       not acquiring a lock before finalizing (recoverInterruptedOwnerTransfer's !lockHeld branch
       may have regressed to the pre-phase-1 unlocked-finalize shape)
 Test Files  1 failed (1)
      Tests  1 failed | 76 skipped (77)
```
红点是**具名错误**（3014ms，早于 vitest 5000ms 默认超时），不再是通用的
`Test timed out in 5000ms.`——直接指认「unlocked 分支没有在取锁」这条不变式。
**C**：手工把 `src/persistence/fileStore.ts` 还原为持锁形状，`grep -c MUTATION_RV
src/persistence/fileStore.ts` = 0，`git diff --stat -- src` **零输出**（与 HEAD `7ff426d` 完全一致），
重跑同一条命令回到 A 步的绿。

**Important-2 的 B（重放评审员的 M2：`release()` 移出 `finally`，只在 finalize 成功路径释放，
标注 `MUTATION_RV`）**：整份 `fileStore.test.ts` 单跑：
```
 ❯ tests/persistence/fileStore.test.ts (77 tests | 3 failed) 705ms
   × fileStore > refuses to finalize a v2 marker whose finalizeOrder omits a legal file, rather
     than silently orphaning the omitted pending 9ms
     → promise resolved "'{\n  "holderProcessInstanceId": "pid:…'" instead of rejecting
   × fileStore > refuses to finalize a v2 marker whose reconciliation pending is missing, keeping
     the marker and staging in place 3ms
     → promise resolved "'{\n  "holderProcessInstanceId": "pid:…'" instead of rejecting
   × fileStore > refuses to finalize an unparseable marker, keeping every staged file in place 2ms
     → promise resolved "'{\n  "holderProcessInstanceId": "pid:…'" instead of rejecting
 Test Files  1 failed (1)
      Tests  3 failed | 74 passed (77)
```
三条新增断言全部精确命中（红点行号分别是 `:483` / `:540` / `:579`，都是新增的那一行），
消息都是 `promise resolved "...holderProcessInstanceId..." instead of rejecting`
——锁文件真实还在，`rejects.toThrow()` 落空。这就是评审员报告 §3 里说的「M2 之前 518 全绿」
的那个真回归，现在被三条新增断言同时抓住。
**C**：手工把 `release()` 放回 `finally`，`grep -c MUTATION_RV src/persistence/fileStore.ts` = 0，
`git diff --stat -- src` 零输出，`git status --porcelain -- src` 零输出。

### 全量验证（三条 Important 全部还原之后）

命令（脚本先落盘 `run-full.sh`，`rtk proxy zsh` 跑，未过滤，整份读出）：
```
export ECC_GATEGUARD=off DISABLE_OMC=1
npx vitest run --run; echo "TEST_EXIT=$?"
./node_modules/.bin/tsc --noEmit; echo "TSC_EXIT=$?"
npm run build; echo "BUILD_EXIT=$?"
```
**首行**：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss`
（worktree，非仓库根）。
**结尾两行**：
```
 Test Files  30 passed (30)
      Tests  518 passed (518)
```
**三个退出码**：`TEST_EXIT=0 / TSC_EXIT=0 / BUILD_EXIT=0`。测试总数与本环之前一致（518，
本环只在既有测试里加断言，没有新增 `it` 块，数量不变符合预期）。
flake (B) `records env names only and tracks descendants rooted at the spawned pid` 本轮绿
（2799ms，第 118 行）；人裁 10 挂账那条 `persists phase usage evidence from the subprocess adapter
without recomputing controller totals` 本轮也绿（734ms，第 114 行）——按名比对记录，不重新调查、
不外推。

**没有任何既有判据变红。**

### 预算记账（修复环 1，回应控制器「要最诚实数字或明说拿不到」）

**如实说明：这个环境里我没有能读到我自身逐调用 token 用量的工具或 API。** 上一轮我把「没有精确
计数」偷换成了「可以给一个模糊估计」，而那个估计（6-8 成量级）与控制器后来给出的 harness 实测
195,610 tokens **在数量级上都对不上**（195,610 已经是 100k 预算的约 1.96 倍）。这说明我的估计方法
本身不可靠，不是"精度不够"的问题。

**本环（修复环 1）我能诚实给出的只有这些**：
- 本环做了 3 次「改代码/测试 → 单跑验证 → 手工变异复现评审员场景 → 手工还原 → 核对
  `grep -c MUTATION_RV` / `git diff --stat`」的循环，外加 1 次整份 `fileStore.test.ts` 单跑
  （A 步）、1 次全量套件跑（30 files/518 tests）、1 次 tsc、1 次 build；输入端读了完整的
  `review-task-3.md`（492 行）；输出端本节报告约 200 行。
- **我不会把"操作次数"换算成一个 token 估计再报出来**——上一轮已经证明这类换算会错到数量级，
  与其重复同一个不可靠的方法，不如明确说：**拿不到精确数字，也不再提供替代的模糊估计**。
- 如果控制器需要一个可信的用量数字，**只有 harness 自己的实测（如上一轮的 195,610）是可信来源**，
  我这边报不出等价可信度的数字。
- 感知层面的信号（仅供参考，非计数）：本环任务范围比上一轮小（只改 4 个测试断言 + 1 个新增辅助
  函数，不涉及生产代码的净变更），过程中没有出现「大段来回读同一批文件」的情况，主观判断本环
  消耗低于上一轮，但**这仍然是判断，不是数字，不应被当成预算依据**。
