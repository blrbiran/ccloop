# 任务 3（第 1 笔）阶段 1 —— 实施 brief

> 台账：`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md`（**先读 §11 与 §13，不要读全篇**）
> 已获批方案：同目录 `task-3-design.md` 的 **§3.3**（形状）与 **§6「阶段 1」**（边界）。**只读这两节。**
> 授权：**人裁 18**（阶段 1 方案获批）＋ **人裁 20**（本会话执行）。

---

## 1. 一句话任务

把 `recoverInterruptedOwnerTransfer` 的 `!lockHeld` 分支，从今天的
「**探锁 → 可能删锁 → 不持锁 finalize**」改成「**取锁 → 持锁 finalize → 释放**」。

改动面：**`src/persistence/fileStore.ts` 一个函数的一个分支**。加**至少一条**新判据（见 §4）。

---

## 2. 硬边界（越界即失败，不许自行放宽）

1. **只做阶段 1。** 阶段 2a（`parsePid` 判不出 pid 时失败关闭）、阶段 2b（消灭零长度锁窗口）、
   阶段 3（`readOwnerRecord` 变纯读）**都需要人裁，人明令先不裁**。
   ⇒ **不许碰 `tryRecoverStaleOwnerTransferLock` 的判活逻辑**，不许改 `parsePid`，
   不许改 `acquireOwnerTransferLock` 的取锁原语。
2. **不许动**：`readOwnerRecordWithoutRecovery`、`src/registry/`、`leaseGate`、`leaseHeartbeat`、
   任何 `docs/` 下的 spec、任何 Human ruling 产物。
3. *** **不许为了让测试变绿而改任何既有测试断言。** *** 本轮**没有**给你任何改判据的例外
   （人裁 13/14/17 的例外**各自只对它们具名的那一条**，**明令不得援引到本任务**）。
   **若你的改动让任何既有判据变红：停手，把「哪条测试、红在哪一行、为什么」写进报告并回报，
   由控制器交人裁。自行改断言 = 任务失败。**
4. `lockHeld: true` 的三个调用点**原样不动**。
5. **不许改本 brief 的要求，也不许缩范围。** 做不到就回报 BLOCKED。

---

## 3. 要写成什么形状（设计 §3.3，逐字照搬其约束）

```
（形状，非补丁；变量名/错误类型以今天代码为准）
if (!options?.lockHeld) {
  let lock;
  try {
    lock = await acquireOwnerTransferLock(runDir);   // 复用现成原语，含它自己的 EEXIST→stale→重试
  } catch {
    return;            // 拿不到锁 = 现在不该由我恢复。与今天「busy 就 return」同语义
  }
  try {
    await finalizePendingOwnerTransfer(runDir);
  } finally {
    await lock.release();
  }
  return;
}
await finalizePendingOwnerTransfer(runDir);           // lockHeld: true 的三个调用点，原样
```

*** **两个必须明写、且最容易做错的设计细节** ***：

- **取锁失败一律 `return`，绝不外抛，且只在「取锁」这一步宽 catch。**
  今天读路径在锁上只调 `pathExists`（吞一切错误）⇒ **读永远不会因为锁而失败**。
  `acquireOwnerTransferLock` 会抛 `OwnerTransferLockBusyError`，也会抛非 EEXIST 的 errno
  （`EACCES` / `ENOSPC`）。若不兜住，`readOwnerRecord` 就获得一类**今天没有的新失败模式**，
  会一路传到 `runLoopFromState` 的外层 catch（那里 `isLeaseStopError` 不匹配 I/O 错误），
  **把一次本可成功的 attempt 判成失败**。
  ⚠️ **反过来同样重要**：`finalizePendingOwnerTransfer` 自己的抛**必须原样外传**
  —— 那四种 fail-closed 抛是既有判据钉住的（`fileStore.test.ts` 三条
  `await expect(readOwnerRecord(...)).rejects.toBeInstanceOf(…)`）。**宽 catch 一旦罩住 finalize，
  那三条会红，而那是真回归，不是判据过时。**
- **`finalize` 抛时必须走 `finally` 释放锁。** 否则一次 finalize 失败就永久留下一把无主锁，
  **把 G0 从偶发变成必然 —— 比不改还糟**。这是 `writeOwnerTransferArtifacts` 今天已在用的形状，
  属沿用既有约定，不是新发明。
  ✅ 已代你验过：`release()` = `handle.close()` ＋ `safeUnlink(lockPath)`，**确实删文件**。

---

## 4. 新判据（至少一条，必须你自己设计）

设计员点名要一条：**「两个并发的 `readOwnerRecord` 落在同一个 marker 上，只有一个会 finalize，
另一个不写」**。

⚠️ *** **设计员明写他没有把这条设计出来**：Node 单线程，得靠对 `finalizePendingOwnerTransfer`
或 `open` 打点交错才不是自证。**这部分是你的工作，不是照抄。** ***

**验收要求**：
- 这条测试**必须能红**。按下面 §6 的三步判据证明它不是恒绿测试。
- **不许**用「断言实现细节的字节」来钉它（本仓库有过 D-5 那种无鉴别力断言的先例）。
  钉的应当是**可观察行为**：谁 finalize 了、谁没写、终态是什么。
- 若你判断这条无法在不改生产代码打点的前提下写成非自证，**如实回报，并说明你试过什么**，
  不许交一条恒绿的占位测试充数。

---

## 5. 必须你自己再撞一次的三件事（**上游结论一律是单方证词**）

1. *** **控制器的 S1 判定：`snapshotTree` / `readdir` 精确文件集合类断言不受阶段 1 影响。** ***
   **那是读代码的机械论证，控制器一条测试都没跑。** 你必须实跑撞一次，**尤其是
   `tests/registry/zeroWrite.test.ts` 的全树快照**（`buildRecoveryRun()` 正是为触发
   recovery-on-read 而造的 fixture）。
   *控制器的论证供你参考、不供你免验*：`snapshotTree` 只为文件/符号链接记条目、目录只递归不记条目
   ⇒ 目录 mtime 不入快照 ⇒ 创建后又删除的锁不留 key。**唯一红条件是锁泄漏。**
2. **设计员 §7.1 那张「估计全绿」的表**（10 类既有判据）—— **全是估计，他一条测试都没跑**
   （他的理由正当：当时工作树在被并发变异）。**跑出来的红绿以你为准。**
3. **锁泄漏的现成执行机制**（你不必新造，但要知道它们会抓你）：
   `zeroWrite.test.ts` 有一条 `pathExists(runDir/".owner-transfer.lock") === false`；
   `fileStore.test.ts` 有 **8 处** `await expect(readFile(join(runDir,".owner-transfer.lock"),"utf8")).rejects.toThrow()`。
   ⚠️ **反向事实**：`ensureFreshRunDir` 的 `blockingPaths` **不含**该锁，`directoryHasEntries`
   只作用于 `attempts/` 与 `worktrees/` ⇒ **一把泄漏的锁在生产侧是静默的**，测试是唯一的防线。

---

## 6. 验证要求（不满足即不算 DONE）

**三步判据**（对你新增的每一条测试）：
- **A 注入前绿**：单跑该具名测试，**块里必须显示非零的 `N passed` 计数**（证明选择器命中，不是 0 matched 空跑）。
- **B 注入后红**：做一次**能杀死它的变异**（例如把 `finally { lock.release() }` 去掉、
  或把取锁改回 `pathExists`），**贴出红点的具体断言与消息**。
- **C 还原后绿**：`git checkout -- <单个明确文件路径>`，并证明还原：
  `git diff --stat -- src` 零输出 ＋ `grep -c MUTATION <file>` 0 命中 ＋ 重跑变绿。

**全量验证**（声称完成之前）：
`export ECC_GATEGUARD=off DISABLE_OMC=1` 后跑 `npm test -- --run`、`./node_modules/.bin/tsc --noEmit`、
`npm run build`，**三者的退出码都要贴**。
*** **验证跑绝不过滤输出 —— `grep` 与 `tail` 同罪。** *** 输出太长就**先重定向落盘再整份读**，
不许摘要成一行（本仓库有过「必修 finding 恰好藏在被摘要掉的那段里」的先例）。
**必须核 vitest 首行 `RUN` 路径**，确认是 `…/.worktrees/pkg2-data-loss` 而不是仓库根。

**允许出现的红只有两条 flake**：
- (B) `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`（`Test timed out in 5000ms`）
- (F) `continues normally when execute returns a complete result during the recovery window`

**另有一条已挂账、不在 flake 名单内的失败**（人裁 10）：
`tests/controller/runLoop.integration.test.ts > runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`（ENOENT `plan.json`）。
**见到它按这个完整测试名比对，记录挂账即可，不要重新调查根因，也不得挥手说「已知 flake」把别的红一起放过。**
**任何不在上述三条内的红，一律按新缺陷处理，不许挥手放过。**

---

## 7. 探针与检索纪律（本仓库栽过多次）

- **脚本先落盘，再 `rtk proxy zsh <script>` 跑。** 不要在命令行里嵌三层引号
  —— 多层引号会把 `grep` 的交替模式静默弄坏，产出全 0 的假计数、退出码还是 0。
- **每次检索都放两条 sanity 探针**：一条**必命中**、一条**必零命中**（无意义 token），
  用来证明检索面是活的。*** **一条被弄坏或被过滤的探针，永远不能证明「不存在」。** ***
- **不许用收窄的搜索面支撑全称否定。** 下全称否定前先声明搜索面，再断言。
- **锚点用符号名，不用行号。**
- `git show "$c:path"` 在 zsh 下会被当成参数修饰符 `:s`，静默产出假计数 —— 要用就 `bash -c` 包一层。

---

## 8. 落盘协议（强制）

**先 `Write` 一个只有小节标题的骨架报告并立刻落盘**（在此之前不要做任何检索），
之后**每次 `Edit` 只填一节**，**「结论」一节最先写**。
本仓库有一会话 12 名 agent 死 6 名、全部发生在准备落盘时；采用该协议后交付率 100%。

**报告路径**：`.superpowers/sdd/2026-08-07-pkg2-data-loss/task-3-impl-report.md`

---

## 9. 报告契约（必须逐条覆盖，缺一条即退回）

1. **结论**：DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED ＋ commit 范围。
2. **改了什么**：文件、函数、分支；为什么这个形状满足 §3 的两个设计细节。
3. **三步判据的完整证据**（A/B/C，命令 ＋ 未过滤输出 ＋ 具体红点）。
4. **全量验证**：三个退出码 ＋ `Test Files` / `Tests` 两行 ＋ `RUN` 首行路径。
5. **§5 三件事的实撞结果**（尤其 zeroWrite 全树快照）—— **明写你跑了什么，不是「控制器说不受影响」**。
6. *** **阶段 1 明确不 covers 的部分，原样复述、不许含糊过去**：锁**仍可被偷**（§13 第 1 笔原文
   原封不动）；残余口子从「marker 一在就长期敞开的 G0」缩到「需撞纳秒调度窗口的 G3'」＋「G2-null」
   —— **是降级，不是关严**；`readOwnerRecord` **依然是写者**；`finalizePendingOwnerTransfer` 内
   **依然零守卫**；**fsync 一概没有**。 ***
7. **有没有既有判据变红**（有就点名 ＋ 停手回报，不许自行改断言）。
8. **你没做/没验的部分**，如实列。**不许用「应该没问题」代替「我没验」。**
9. **预算记账**（Rule 6：单任务 100k）。**接近或超出就当场明写，不许静默超支。**

---

## 10. 铁律（本仓库用真缺陷换来的）

- *** **不接受实施者自证。** *** 你交付后会有**换人**的独立评审员实跑核你的承重前提。
  上一轮正是评审员实跑证伪了实施者的一句承重注释，换来一条 Critical。
- **转述前先核原文。** 上一轮控制器把实施者**提案**里的一句话当成**已实现**向下游传播，被再评审员查出。
- **写每一句注释前先问：今天为真吗？我验过吗？与同一 commit 里其它句一致吗？**
  勘误正文本身也是断言。
- **「完成」是错的，如果有任何东西被静默跳过。**
