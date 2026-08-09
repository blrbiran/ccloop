# 独立评审 —— 包 2 / 任务 3（第 1 笔）阶段 1

评审员：独立评审员（未参与实施）。范围 `2d7ff84..be4c344`，分支 `feat/pkg2-data-loss`。

## 结论

**规范符合：✅**（改动面严格等于阶段 1，零越界）。
**质量：不通过（DONE_WITH_CONCERNS，需一个修复环）。**

生产代码 `recoverInterruptedOwnerTransfer` 的新形状**是对的**，我用三次生产侧变异 ＋ 一次
built-output 实跑独立确认了它的两个承重性质。全量套件我自己重跑：`30 files / 518 tests` 全绿，
`TEST_EXIT=0 / TSC_EXIT=0 / BUILD_EXIT=0`。

**问题全部在新增的那条判据上，而不是在生产代码上。** 三条 Important：

1. 新测试里 `expect(ownerFromB.currentOwnerEpoch).toBe(1)` **钉的是一个偶然的微任务顺序**，
   而不是它宣称的不变式；紧挨着它的那句承重注释（"held by the same gates, is still the
   pre-recovery record"）**在今天为假** —— 放行 A 的那个 gate 在 B 那次读**之前**就已经解除。
   我实跑证伪：只在**测试侧**加一次合法的 100ms 重调度（生产代码一个字没动），该断言即红
   （`expected 2 to be 1`）。这与上一轮「评审员实跑证伪实施者一句承重注释」同形。
2. 设计 §3.3 的**第二个必须细节**（`finalize` 抛时走 `finally` 释放锁 —— brief 原话「比不改还糟」）
   **今天全仓库零判据钉住**。我把 `release()` 从 `finally` 里挪出来（只在 finalize 成功时释放），
   **518 条测试全绿**。新判据对这条细节的边际覆盖 = 0。
3. 实施者 B 步用的变异（**整个删掉** release）比他报告里写的「去掉 `finally { lock.release() }`」
   **弱一档**，且早已被 8 条既有 leftover-lock 断言覆盖；新判据对**真回归**（旧的探锁-不持锁-finalize 形状）
   的唯一鉴别力是**一次 5 秒超时**，不是任何断言。

生产代码本身我不要求改。要求修的是判据。详见 Findings。

## 1. 规范符合：是否只做了阶段 1

**✅ 只做了阶段 1，零越界。** 证据（`git diff 2d7ff84..be4c344`，全范围，非抽样）：

```
=== full file list changed
.superpowers/sdd/2026-08-07-pkg2-data-loss/task-3-impl-report.md
src/persistence/fileStore.ts
tests/persistence/fileStore.test.ts

=== numstat
19	1	src/persistence/fileStore.ts
144	0	tests/persistence/fileStore.test.ts

=== deletions in tests diff (^-[^-])
0
=== deletions in src diff (^-[^-])
-  if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
```

**唯一一行删除**就是旧的探锁条件行；`src/` 侧的全部改动落在
`recoverInterruptedOwnerTransfer` 的 `!options?.lockHeld` 分支内。

brief §2 逐条点名的禁区，逐条核（搜索面 = `git diff --name-only` 的全集，不是抽样）：

| 禁区 | 是否被碰 | 依据 |
|---|---|---|
| `tryRecoverStaleOwnerTransferLock` 判活逻辑 | 否 | 不在 changed-files 之外；`src` 唯一 hunk 是 1011-1044 区间 |
| `parsePid` | 否 | 同上 |
| `acquireOwnerTransferLock` 取锁原语 | 否 | 同上；新代码是**调用**它，不改它 |
| `readOwnerRecordWithoutRecovery` | 否 | 同上 |
| `src/registry/` | 否 | 不在 changed-files 列表 |
| `leaseGate` / `leaseHeartbeat` | 否 | 不在 changed-files 列表 |
| 任何 spec / `docs/` | 否 | 不在 changed-files 列表 |

`lockHeld: true` 的三个调用点（`fileStore.ts` 的 1061 / 1104 / 1153）原样未动 —— 我用
`grep -rn "lockHeld" src` 核过，三处 `{ lockHeld: true }` 全在，且函数末尾那条
`await finalizePendingOwnerTransfer(runDir);` 保留。

**探针**：必命中 `acquireOwnerTransferLock` → `src/persistence/fileStore.ts:9` 次；
必零命中 `QQZZ_NOPE_881` → `src`+`tests` 零命中。检索面是活的。

## 2. 宽 catch 的范围（构造验证）

**结论：✅ 宽 catch 只吞「取锁」这一步；`finalizePendingOwnerTransfer` 的抛原样外传。**
**我没有只读代码 —— 我构造了两个方向的证据。**

**方向一（正向，built output 实跑）**：见 §3 的 `rv-leak.mjs` 探针，
`readOwnerRecord` 在 marker 不可解析时**确实向外抛出** `OwnerTransferMarkerUnreadableError`。
若宽 catch 罩住了 finalize，这里会静默返回而不是抛。

**方向二（反向，生产侧变异 M1）**：把 catch 扩大到罩住 finalize —— 即

```ts
try {
  const lock = await acquireOwnerTransferLock(runDir);
  try { await finalizePendingOwnerTransfer(runDir); } finally { await lock.release(); }
} catch { return; }
```

全量跑（未过滤，落盘 `rv-m1.log`）：

```
   × fileStore > refuses to finalize a v2 marker whose finalizeOrder omits a legal file, rather than silently orphaning the omitted pending 53ms
     → promise resolved "{ runId: 'task-1', …(7) }" instead of rejecting
   × fileStore > refuses to finalize a v2 marker whose reconciliation pending is missing, keeping the marker and staging in place 12ms
     → promise resolved "{ runId: 'task-1', …(7) }" instead of rejecting
   × fileStore > refuses to finalize an unparseable marker, keeping every staged file in place 5ms
     → promise resolved "{ runId: 'task-1', …(7) }" instead of rejecting
   × fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 2520ms
     → expected [ …(17) ] to deeply equal [ …(17) ]
 Test Files  1 failed | 29 passed (30)
      Tests  4 failed | 514 passed (518)
TEST_EXIT=1
```

⇒ brief 点名的那三条 `await expect(readOwnerRecord(...)).rejects.toBeInstanceOf(…)`
（`fileStore.test.ts` 的 `refuses to finalize a v2 marker whose finalizeOrder omits a legal file` /
`refuses to finalize a v2 marker whose reconciliation pending is missing` /
`refuses to finalize an unparseable marker`）**语义完好、且有鉴别力**：宽 catch 一旦越界罩住 finalize，
它们立刻红，外加 crash-gap 矩阵那条也红。**这一条实施者说对了，我确认。**

## 3. 锁泄漏：finalize 抛时是否走 finally 释放

**行为结论：✅ 会释放。判据结论：❌ 零测试钉住（Important #2）。**

**实跑造了一次 finalize 抛**（`rv-leak.mjs`，直接 import **built output**
`dist/src/persistence/fileStore.js`，不经 vitest、不经任何 mock）：写一个不可解析的
`.owner-transfer.transaction.json` ＋ 两个 pending，然后 `readOwnerRecord(runDir)`：

```
THROWN_NAME = OwnerTransferMarkerUnreadableError
THROWN_MESSAGE = owner transfer transaction marker could not be read or parsed
LOCK_PRESENT_AFTER_THROW = false
LOCK_BODY = null
MARKER_STILL_THERE = true
PROBE_EXIT=0
```

⇒ finalize 抛出 → 抛原样穿过 `finally` 外传 → **锁文件不存在**（`finally` 里的
`lock.release()` = `handle.close()` + `safeUnlink` 确实执行了）→ marker 与 staging 原样保留。
生产行为完全正确。

**但是**：这条性质**没有任何一条测试在守它**。变异 M2 —— 把 `release()` 从 `finally` 里挪出来，
改成只在 finalize 成功后释放（finalize 抛 ⇒ 锁永久泄漏，正是 brief 说的「把 G0 从偶发变成必然，
比不改还糟」）：

```
 Test Files  30 passed (30)
      Tests  518 passed (518)
TEST_EXIT=0
```

**518 条全绿，零红。** 原因我核过：brief §5.3 数的那 8/9 条
`readFile(join(runDir,".owner-transfer.lock"),"utf8")).rejects.toThrow()` 里，
**没有一条**挂在「finalize 抛」的测试上 —— 那三条 fail-closed 测试
（`fileStore.test.ts` 的 `refuses to finalize …` 三兄弟）在
`rejects.toBeInstanceOf(…)` 之后只断言 marker/pending 仍在，**从不看锁**。
新增的并发判据也只覆盖 finalize **成功**的路径。

⇒ 设计 §3.3 的两个必须细节里，**第一个有判据保护（§2 已证），第二个裸奔。**

## 4. 新增并发测试：三步判据独立复现 ＋ mock seam 鉴别力

**我没有采信他报告里的 A/B/C，全部自己跑。**

**A 注入前绿**：全量套件里 `tests/persistence/fileStore.test.ts (77 tests)` 全绿，
新 describe 计入 518 总数（非 0-matched 空跑）。单跑（§9 之外的一次）也绿。

**B 注入后红 —— 我做的是比他更强的变异。** 他的 B 步是**整个删掉** `release()`
（报告里写成「去掉 `finally { lock.release() }`」，措辞掩盖了这是一个更弱的变异）。
那个变异被新测试的 leftover-lock 断言杀死 —— 但**同样的字面断言在这个文件里已有 8 条**，
所以它证明不了新判据有任何**边际**鉴别力。我换成两个真正对准本任务的变异：

- **M2**（release 不在 `finally`）：**518 全绿**，新判据也绿。⇒ 对设计细节 2 零覆盖（见 §3）。
- **M3**（把分支整个还原成阶段 1 之前的「探锁 → 可能删锁 → 不持锁 finalize」）：

```
   × recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker > lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing 5003ms
     → Test timed out in 5000ms.
 FAIL  … Error: Test timed out in 5000ms.
 Test Files  1 failed (1)
      Tests  1 failed | 76 passed (77)
TEST_EXIT=1
```

⇒ **新判据对「真回归」的唯一鉴别力是一次 5 秒挂死，不是任何断言。** 机制：旧形状下读者 A
根本不 `open` 锁文件，`open` 打点永不触发，测试卡在 `await aLockWritten.promise` 直到超时。
一条靠 hang 变红的测试：①失败消息不指认任何不变式；②在慢机器上是天然的 flake 源；
③测试体内的四组断言在它本该守的那次回归里**一次都没被执行到**。
（注意 M3 下**其余 76 条全绿** —— 也就是说整个仓库里只有这一条测试能分辨新旧形状。）

**C 还原后绿**：见「变异还原证明」一节 —— 我用的是 `git checkout -- <file>`（HEAD 已含修复，
所以还原是干净的），`git diff --stat` 零输出。

### mock seam 的鉴别力判断（brief 点名要我判的那条）

`vi.doMock("node:fs/promises", …)` 这个 seam **本身是正当的**，不是「在测 mock」：
它只**包装并延迟**生产代码本来就会发的真实 fs 调用，EEXIST 仍由 OS 真实产生
（`open(lockPath,"wx")` 没有被伪造），且这是本文件既有 `crashOwnerTransferAtStep` 的同一手法，
符合 Rule 11。**问题不在 seam，在断言。**

*** **它钉的不是可观察行为，而是一个偶然的微任务顺序 —— 且承重注释为假。** ***
测试里这三行：

```ts
// Reader B's plain read observes whatever is on disk when it fell back after losing the
// acquire race -- which, held by the same gates, is still the pre-recovery record, proving
// B took the busy-return path rather than finalizing (or re-finalizing) anything itself.
expect(ownerFromB.currentOwnerEpoch).toBe(1);
expect(ownerFromB.currentProcessInstanceId).toBe("pid:12345");
```

「held by the same gates」**在今天为假**。真实时序是：B 的失败 acquire 走进
`tryRecoverStaleOwnerTransferLock` → `readFile(lockPath)` → mock 在这里
`bAttemptedAcquire.resolve()` → **A 立刻被放行**。此后 B 还要走 parse → `isProcessActive` →
抛 `OwnerTransferLockBusyError` → catch → `readOwnerRecordRaw`，而 A 已经在跑 finalize。
**没有任何 gate 保证 B 的裸读发生在 A 改写 `owner-record.json` 之前** —— 今天它绿，
纯粹是因为 A 还要做约 8 次 fs 操作（读 marker、读 2 个 pending、写 2 个 temp、2 次 rename、
unlink marker/pendings）才轮到改写 `owner-record.json`，而 B 只需要 1 次读。

**我实跑证伪了这句注释**（变异 M4，**只改测试、生产代码一个字没动**）：在 mock 的 `readFile`
里 `resolve()` 之后加 `await new Promise(r => setTimeout(r, 100))` —— 模拟一次**完全合法的**
B 被重调度（两个真实进程之间这是常态，不是异常）：

```
   × … lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing 115ms
     → expected 2 to be 1 // Object.is equality
 ❯ tests/persistence/fileStore.test.ts:3015:46
    3015|         expect(ownerFromB.currentOwnerEpoch).toBe(1);
```

而 `ownerFromB.currentOwnerEpoch === 2` **是完全正确的生产行为**（B 输了竞争、没写任何东西、
随后读到 A 已发布的终态）。**这条断言会在正确行为上变红** ⇒ 它不是在钉不变式
「B 没有 finalize」，而是在钉「B 的裸读恰好抢在 A 的 rename 之前」。这正是 D-5 那类
无鉴别力/错鉴别力断言的同族。

**真正该钉的不变式**（供修复环参考，不代表我要求这个具体写法）：
「finalize 只发生了一次」应当由**计数**（对 `rename`/marker unlink 的观测计数）或由
「B 的这次 `readOwnerRecord` 全程没有产生任何写」来表达，而不是由 B 读到的 epoch 值来表达。

## 5. 既有判据是否被改

**✅ 零改动。** `git diff 2d7ff84..be4c344 -- tests` 的 numstat 是 `144  0`，
删除行计数 `grep -c '^-[^-]'` = **0**。全部 144 行都是新增（一个新 `describe` ＋ 一个
文件内局部 `createDeferred` 辅助函数）。**没有任何既有断言被改、被删、被放宽。**
本轮不需要动用任何改判据的例外，也没有动用。

⚠️ 一处**风格**观察（不构成 finding，不要求改）：新加的 `createDeferred` 被放在
新 `describe(...)` 与下一个 `describe("strict persisted-artifact readers")` **之间**，
靠函数提升生效。可读性略差于放文件顶部，但不违反本文件任何既有约定。

## 6. 全树快照类测试（zeroWrite / snapshotTree）

**我自己跑了，两次。**

（a）全量套件里：`✓ tests/registry/zeroWrite.test.ts (5 tests) 530ms`。
（b）单独再跑一次，确认不是被别的文件的副作用带绿的：

```
 ✓ tests/registry/zeroWrite.test.ts (5 tests) 464ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
ZW_EXIT=0
```

⇒ 控制器的 S1 判定（`snapshotTree` / `readdir` 精确文件集合类断言不受阶段 1 影响）
**在实跑上成立**，包括那条 `buildRecoveryRun()` 造出来、专门触发 recovery-on-read 的
全树快照 fixture。机械理由我也复核了：读路径现在**会创建又删除**一把锁，但
`readOwnerRecord` 返回时锁已不在盘上，而 `snapshotTree` 只在快照那一刻遍历、只为文件/符号链接记条目
⇒ 瞬时锁不留 key。**唯一红条件是锁泄漏** —— 而我在 §3 已实跑确认今天的代码在 finalize 抛时也不泄漏。

这同时回答了设计员在 `progress.md` 里自报的**唯一主要未知代价**
（「阶段 1 会让读路径创建/删除锁文件，会不会弄红精确文件集合类的测试 —— 无法判定」）：
**实跑答案是不会。**

实施者报告 §5.3 对 brief 的两处**向上勘误**我复核后确认属实，记正面样本：
`tests/registry/zeroWrite.test.ts` 的 `pathExists(...".owner-transfer.lock"...).toBe(false)`
实有 **3 处**（`:567 :736 :802`），brief 原文写「有一条」；
`fileStore.test.ts` 的 leftover-lock 断言现为 9 条 = 既有 8 ＋ 本任务新增 1。

## 7. 报告第 6 条「明确不 covers」五句是否原样

**✅ 五句全部原样复述，没有一句被淡化。** 我逐句比对了源头
（`progress.md` 「阶段 1 明确不 covers」那段，与 `task-3-design.md` §3.4）：

| 应复述的话 | 源头 | 报告 §6 |
|---|---|---|
| 锁**仍可被偷** | `progress.md` 逐字 | 逐字，且标注「§13 第 1 笔原文原封不动」 |
| G0 → G3' ＋ G2-null，**是降级不是关严** | `progress.md`、`design §3.4` | 逐字保留「**是降级，不是关严**」，并额外展开 G3'/G2-null 各自触发条件与可达性，**比要求更细** |
| `readOwnerRecord` **依然是写者** | `progress.md`、`design §4.0` | 逐字，并正确指出契约本身（只读层必须绑 `readOwnerRecordWithoutRecovery`）一个字没变 |
| `finalizePendingOwnerTransfer` 内**依然零守卫** | `progress.md` | 逐字，并补了「连 `lockPath` 这个名字都不出现在函数体里」（我核过，属实） |
| **fsync 一概没有** | `progress.md` | 逐字 |

无淡化、无「已大幅改善」这类滑坡措辞；`design §3.4` 里那句「不是关严，是从常态降到窄窗」
的语义被完整保住。**这一节是他这份报告写得最好的部分。**

## 8. 自报偏离（手工 Edit 还原 vs git checkout --）证据是否等价

**❌ 不等价 —— 但缺陷现在是 moot 的，因为我自己重做了一遍。**（Minor finding）

他的论证是「变异做在尚未提交的工作树上，`git checkout --` 会连修复一起丢」——
这个**事实判断是对的**。但由此得出「效果与先提交再变异再 checkout **完全等价**」**不成立**：

1. **他给的两项证据都不锁定字节。** `grep -c MUTATION = 0` 只证明**注释标记**没了，
   不证明手工改回的那几行与变异前**逐字节相同**；`git diff --stat -- src` 显示
   `19 insertions(+), 1 deletion(-)` 同样与「修复 ＋ 任意等行数的残留漂移」相容。
   **他的证据链里没有一环能排除残留漂移。**
2. **正确做法当时就存在且成本为零**：先 `git commit` 修复 ＋ 测试，再变异，再
   `git checkout -- src/persistence/fileStore.ts`。他自陈的困难完全来自「先变异后提交」
   这个**他可以自由选择**的顺序，不是外部约束。所以「只是执行手段不同」这句是把
   一个可避免的方法学退让说成了中性差异。

**moot 的原因**：HEAD `be4c344` 已含修复，我做的四次变异全部从这个已提交基线出发、
用 `git checkout --` 还原，`git diff --stat` 全树零输出（见「变异还原证明」一节），
并且我重跑的 518 条全绿 —— **入库的字节我已独立验证是正确的**。
所以这条按 **Minor** 记：方法学问题，不是结果错误。

## 9. 全量验证（test / tsc / build）

自己重跑，脚本先落盘（`rv-full.sh`）、`rtk proxy zsh` 执行、整份输出落盘
（`rv-full.log`，168 行）后**整份读出，未过滤**。跑之前 `export ECC_GATEGUARD=off DISABLE_OMC=1`。

- **HEAD**：`be4c344`；`git status --porcelain` 只有 `?? …/review-task-3.md`（我自己的报告），
  工作树对 `src`/`tests` 干净。
- **`RUN` 首行**：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss`
  —— **是 worktree，不是仓库根**。

**两行计数**：

```
 Test Files  30 passed (30)
      Tests  518 passed (518)
```

**三个退出码**：`TEST_EXIT=0` ／ `TSC_EXIT=0` ／ `BUILD_EXIT=0`。

### 关于「异常地全绿」这一点（brief 特别要我留意的）

**我复现了，而且我认为它不构成隐瞒。** 逐条核：

- **flake (B)** `records env names only and tracks descendants rooted at the spawned pid`：
  我这轮**绿**，输出里明确打印 `✓ run-scenario CLI > records env names only and tracks
  descendants rooted at the spawned pid 3070ms`（他那轮 3121ms，同一条）。
- **flake (F)** `continues normally when execute returns a complete result during the recovery window`：
  reporter 默认只展开慢测试，这条没被单独打印。他给的理由（文件级
  `✓ tests/controller/runLoop.integration.test.ts (58 tests)` ＋ 总计零失败 ⇒ 含它在内全通过）
  **成立**，我另外用 `grep -rn` 核实该测试名确实存在于
  `tests/controller/runLoop.integration.test.ts:3098`，不是一个已被删掉的名字。
- **人裁 10 挂账那条** `persists phase usage evidence from the subprocess adapter without
  recomputing controller totals`：我这轮**也绿**（输出第 139 行，748ms）。按名比对记录，
  **不重新调查根因，不外推为「已修复」**。

**为什么这轮会全绿（我的判断，标注为判断不是证据）**：这三条都是时序/环境敏感项，
本机负载低、单次采样。**本仓库立场我沿用：「本次没跑出来」不构成 flake 消失的证据。**
我没有为了逼出 flake 而反复跑 N 次 —— **如实记为我没做的事**（见 Findings 末尾）。
但我确认了两件更重要的事：（i）这轮的绿不是靠过滤或摘要得来的，输出是整份读的；
（ii）我的四次变异跑里，红点每次都精确落在预期位置、其余全绿，说明这个套件在本机
**是有鉴别力的**，不是整体失灵。

## Findings

无 Critical。**Important 3 条，Minor 3 条。全部集中在判据侧，生产代码不要求改。**

### Important-1 —— 新判据的承重注释为假，其断言钉的是偶然调度顺序（会在正确行为上变红）

- **锚点**：`tests/persistence/fileStore.test.ts`，
  `describe("recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker")`
  → `it("lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing")`
  → 断言 `expect(ownerFromB.currentOwnerEpoch).toBe(1)` 与
  `expect(ownerFromB.currentProcessInstanceId).toBe("pid:12345")`，及其上方注释
  「…which, **held by the same gates**, is still the pre-recovery record…」。
- **缺陷**：该注释断言 B 的裸读被 gate 保护。**事实相反** ——
  `bAttemptedAcquire.resolve()` 发生在 B 那次 `readFile(lockPath)` **之内**，
  A 在此刻即被放行；B 之后的 parse → `isProcessActive` → 抛 busy → catch → `readOwnerRecordRaw`
  与 A 的 finalize **完全并发，无任何 gate**。今天能绿只因为 A 在改写 `owner-record.json` 前
  还要做约 8 次 fs 操作，而 B 只需 1 次读。
- **可构造场景**：在 mock 的 `readFile` 里 `bAttemptedAcquire.resolve()` 之后插入
  `await new Promise(r => setTimeout(r, 100))`（= B 被重调度 100ms，两个真实进程间是常态），
  **生产代码一字不动** ⇒ `AssertionError: expected 2 to be 1`，红在
  `fileStore.test.ts:3015`。而 `ownerFromB.currentOwnerEpoch === 2`
  （B 输了竞争、没写任何东西、随后读到 A 已发布的终态）**是完全正确的生产行为**。
- **后果**：①一条会在正确行为上变红的断言 ⇒ latent flake；
  ②它没有在钉「B 没有 finalize」这个不变式（违反 Rule 9）；
  ③承重注释与今天的代码不符（本仓库上一轮 Critical 的同形问题）。
- **建议**：把「只有一个 finalize」改成用**写操作计数/观测**表达（例如统计 `rename` 或
  marker `unlink` 的发生次数、或断言 B 这次调用全程零写），而不是用 B 读到的 epoch 值表达；
  同时把那句注释改成今天为真的措辞。

### Important-2 —— 设计 §3.3 第二个必须细节（finalize 抛时走 `finally` 释放）全仓库零判据

- **锚点**：`src/persistence/fileStore.ts` → `recoverInterruptedOwnerTransfer` →
  `try { await finalizePendingOwnerTransfer(runDir); } finally { await lock.release(); }`。
- **缺陷**：把 `release()` 移出 `finally`（只在 finalize 成功后释放）后，
  **518 条测试全绿、退出码 0**。即：brief 明写「否则把 G0 从偶发变成必然，**比不改还糟**」的
  那条性质，今天**没有任何一条判据在守**。
- **可构造场景**：`await finalizePendingOwnerTransfer(runDir); await lock.release();`
  （去掉 try/finally）⇒ 任何让 finalize 抛的输入（不可解析 marker／缺 pending／
  非法 finalizeOrder）都会**永久留下一把无主锁**，而套件全绿放行。
  真实触发路径：`readOwnerRecord` 撞上一个损坏的 `.owner-transfer.transaction.json` ⇒
  锁泄漏 ⇒ 该 run 后续所有转移/心跳/claim 被这把锁挡住，
  且 brief §5.3 已记明**生产侧对泄漏的锁是静默的**（`ensureFreshRunDir` 的 `blockingPaths` 不含它）。
- **为什么没被发现**：三条 fail-closed 测试（`refuses to finalize …` 三兄弟）在
  `rejects.toBeInstanceOf(…)` 之后只断言 marker/pending 仍在，**从不看锁**；
  新判据只覆盖 finalize **成功**的路径。
- **建议**：给那三条 fail-closed 测试中的**至少一条**补上
  `await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();`
  ——**这是纯新增断言，不改任何既有断言**，不触碰 brief §2.3 的禁令。

### Important-3 —— 新判据对真回归的唯一鉴别力是 5 秒超时，不是断言

- **锚点**：同 Important-1 的那条 `it(...)`。
- **缺陷**：把 `recoverInterruptedOwnerTransfer` 的分支还原成阶段 1 之前的
  「探锁 → 可能删锁 → 不持锁 finalize」形状后，该测试以
  `Error: Test timed out in 5000ms.` 变红，**测试体内四组断言一次都没执行到**；
  同一次跑里其余 76 条**全绿**（⇒ 全仓库只有这一条能分辨新旧形状）。
- **可构造场景**：旧形状下读者 A 根本不 `open` 锁文件 ⇒ `open` 打点永不触发 ⇒
  测试卡死在 `await aLockWritten.promise` 直到 vitest 超时。
- **后果**：①失败消息不指认任何不变式，未来维护者看到只会当成 flake；
  ②5s 超时本身是慢机器上的 flake 源；③实施者报告 §3 用来证明「不是恒绿」的那次变异
  （**整个删掉** `release()`）比这弱一档，且被 8 条既有 leftover-lock 断言覆盖 ⇒
  **他的 B 步没有证明新判据有任何边际鉴别力**。
- **建议**：给 `aLockWritten` 加一个显式超时并抛出具名错误（例如
  "reader A never opened the lock file — the unlocked branch is not acquiring"），
  让回归时的失败消息直接指认不变式。

### Minor-1 —— 报告 §3 对自己所做变异的描述不准确

`「去掉 finally { lock.release() }」`（报告 §3 B 步）与他实际做的
「finalize 完直接 return、**完全不释放**」不是同一个变异。前者正是设计细节 2，后者只是
「忘了释放」。**这个措辞让读者以为设计细节 2 已被证明有判据保护，而实际上没有**（见 Important-2）。
锚点：`task-3-impl-report.md` §3「B 注入后红」。

### Minor-2 —— C 步还原证据不锁定字节（详见 §8）

`grep -c MUTATION = 0` ＋ `git diff --stat` 的组合无法排除残留漂移；成本为零的正确做法
（先提交再变异再 `git checkout --`）当时可用而未用。**结果无误**（我已独立验证入库字节），
仅方法学退让。锚点：`task-3-impl-report.md` §3「C 还原后绿」。

### Minor-3 —— 报告 §5.2 把「全量套件全绿」说成对设计员 §7.1 估计的「最强实证」

全量绿证明的是**这 10 类判据没红**，不等于它们**有能力**在阶段 1 出错时变红。
我的 M2（518 全绿）正是反例：一次真实的、brief 点名「比不改还糟」的回归可以完整穿过全量套件。
「全量绿」应当被记为**必要不充分**证据。锚点：`task-3-impl-report.md` §5 第 2 条。

### 我没做的事（如实列，不用「应该没问题」代替）

- **没有反复跑 N 次去逼 flake (B)/(F)**。我只采样一次，全绿。
  沿用本仓库立场：**「本次没跑出来」不构成 flake 消失的证据。**
- **没有构造 `EACCES`/`ENOSPC` 注入**去实测宽 catch 的非 EEXIST 分支。
  我用 M1 从反方向证明了 catch 的**范围**正确，但「非 EEXIST errno 被吞且不外抛」
  这条具体路径我**没有**实跑（与实施者 §8 自陈的缺口相同，我确认这个缺口仍在）。
- **没有跑真正 spawn 两个进程的并发测试**。与实施者同，`O_EXCL` 的 POSIX 原子性
  不在本任务改动面内。
- **没有复核 `progress.md`／`task-3-design.md` 中除 §11/§13、§3.3/§6 之外的内容**（brief 限定我的阅读面）。
- **没有为 Important-1/2/3 写出修复补丁** —— 评审员不改判据，交由修复环处理。

## 变异还原证明

我为验证做了 **4 次临时变异**，全部从已提交基线 `be4c344` 出发，全部用
`git checkout -- <单个明确文件路径>` 还原，全部带 `MUTATION_RV` 标记：

| # | 文件 | 变异 | 结果 |
|---|---|---|---|
| M1 | `src/persistence/fileStore.ts` | 宽 catch 扩大到罩住 `finalizePendingOwnerTransfer` | 4 条既有判据红（§2） |
| M2 | `src/persistence/fileStore.ts` | `release()` 移出 `finally` | **518 全绿**（§3，Important-2） |
| M3 | `src/persistence/fileStore.ts` | 分支还原成阶段 1 之前的形状 | 仅新判据红，**且是超时**（§4，Important-3） |
| M4 | `tests/persistence/fileStore.test.ts` | B 被重调度 100ms（**生产代码未动**） | 新判据红 `expected 2 to be 1`（§4，Important-1） |

**还原证明（最终状态，未过滤）**：

```
--- git diff --stat (whole tree):

(empty = fully restored)
--- MUTATION_RV grep across src+tests:
grep done            ← 零命中
--- git status --porcelain:
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task-3.md
```

**两条 sanity 探针**（证明上面那次「零命中」不是被弄坏的检索面）：
- 必命中：`grep -rc "acquireOwnerTransferLock" src/persistence/fileStore.ts` → **9**
- 必零命中：`grep -rn "QQZZ_NOPE_881" src tests` → 0

⇒ `git diff --stat` 全树零输出 ＋ `MUTATION` 标记零命中 ＋ 检索面已验活；
工作树唯一的未跟踪文件是本报告。**还原完整。**

另有一个只读探针脚本 `rv-leak.mjs`（§3 用），落在 scratchpad，**不在仓库内**，
它只 import `dist/` 的构建产物并在 `mkdtemp` 临时目录里操作，未触碰仓库文件。

## 预算

**本次评审估计消耗约 75k–85k tokens**（单任务上限 100k，Rule 6）。
构成：三份输入（brief 183 行 ＋ 实施报告 311 行 ＋ 评审包约 545 行）、
`fileStore.ts` 与 `fileStore.test.ts` 的定向阅读、`progress.md`/`task-3-design.md` 的限定小节、
**6 次 vitest 跑**（1 次基线全量 ＋ M1/M2 全量 ＋ M3/M4 单文件 ＋ 1 次 zeroWrite 单跑）、
1 次 tsc ＋ 1 次 build、1 次 node 探针，以及本报告约 300 行。

**标注为估计，不是精确计数**（本环境无逐调用 token 读数）。
**未超支，但已进入上限的 8 成量级** —— 若控制器要在本会话内追加任务（例如让我复核修复环），
**应当先开新会话**，不要在本会话续跑。这是当场明写的预警，不是事后追认。
