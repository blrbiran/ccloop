# 第 4 笔 —— 实施报告（D2）

工作区 `/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4`，分支 `feat/pkg2-4th`。
BASE `2af4137`，HEAD `86e7aa4`（本报告落盘后另有一次 docs commit）。

---

## 1. 结论（最先写）

**状态：BLOCKED（带完整证据）。**

**D2 按规格实现了，并且它确实关闭了目标 TOCTOU —— 这一条我用实测证明了，不是推理。
但同一次实测证明：D2 会弄红一条**人裁 13 具名范围之外**的既有判据，而 brief §4 硬边界 1 明令我不许改它。
两件事都成立，所以我不收口，交人裁。**

三句话概括：

1. **D2 有效。** 新增的「输家先取锁 / 赢家先取锁」两条判据在**同一个终态命题**上各断言一次；
   把 D2 撤掉（变异 M3）之后，「赢家先取锁」那一条**靠终态断言变红**（赢家的记录被输家的降级覆盖）。
   §2 有三步证据与逐条计数。
2. **D2 撞墙。** `tests/controller/leaseLifecycle.integration.test.ts >
   lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy`
   **变红**（ENOENT `reconciliation-record.json`）。它**不是**人裁 13 具名的那一条，
   它被 spec `2026-08-01-…-design.md` 逐字列为锁忙行为的既有护栏之一（该清单第 6 条），
   其自陈是 Task 1 / spec §3、§5.3、§12 requirement 2。**我没有改它，就让它红着交上来。** 详见 §5.2。
3. **这堵墙不是调参能过的。** 它正是 spec §4.3 否决方案 (c) 时点名的那条代价
   （「给它加锁会让一条从不失败的路径新增一类 `OwnerTransferLockBusyError` 失败」）落到了实处：
   在那条判据的夹具里，转移锁**永远**忙，于是「转移因锁忙放弃」的 run 在 D2 下**再也不写** `reconciliation-record.json`。
   设计文档把这一片的范围界定为「stale_candidate ＋ 降级记录 ＋ 此刻恰有并发转移」——**范围判断是对的**，
   但它**没查出这一片已经被一条既有判据钉住了**（设计文档自陈爆炸半径只是「下界」，这就是下界之外的那一条）。

**给人裁的取舍（我不替人选，也不替人改判据）：**

| 选项 | 代价 |
|---|---|
| **(A) 扩权到那条判据** | 需要一次**新的、点名到它**的人裁（与人裁 13 同形）。语义变更是实质的：「转移因锁忙放弃」的 run 从此不写 reconciliation 记录，只留 `owner_transfer_contended` ＋ `reconciliation_write_abandoned` 两个事件。**这是 2026-08-02「不许删掉正常路径产物」那条代价的一个受限实例** —— 受限在「锁忙」这一片，不是 D1 的「绝大多数 run」。 |
| **(B) 否掉 D2** | 回到 §6 表里的 D1 / D3 / 不修。我实测过的东西一条也不浪费：D1 的代价仍如 4.1 所述，D3 仍只收窄。 |
| **(C) 缩小 D2 的适用面** | 我**没有**实现这条，也**不推荐**由实施者自选：任何「锁忙时仍然写」的形状都会把 §2 的终态证明作废（那正是 M3 变异证明会红的那条路径）。若人裁想要它，必须重新走设计。 |

**我不主张 (A)。** 理由在 §3.1：D2 的终态无关性是靠「拿不到锁就不写」买来的，
把「拿不到锁但还是写」放回去，等于把 §2 的红变回绿。

---

## 2. 两种交错的判据 —— 三步变异证据

三条判据（两条新增 ＋ 一条人裁 13 授权修改），全在 `tests/controller/runLoop.integration.test.ts`：

| 代号 | 完整测试名 |
|---|---|
| **I1** | `runLoop > keeps the loser's downgrade when its protected span runs first, and still ends at the winner's reconciliation record` |
| **I2** | `runLoop > keeps the winner's reconciliation record as the terminal state when the loser's write is forced to land after the winner's last rename` |
| **A9′** | `runLoop > abandons the loser's reconciliation write against the winner's held transfer lock and finalizes none of the winner's transaction inside the publish window`（人裁 13 那一条，改后） |

单跑命令（每次都带 `ECC_GATEGUARD=off DISABLE_OMC=1`，`RUN` 首行均为
`v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4`，已逐次核对）：

```
npx vitest run tests/controller/runLoop.integration.test.ts -t "<完整测试名>"
```

### 2.1 注入前（全绿）

| 判据 | 计数 | exit |
|---|---|---|
| I1 | `1 passed | 60 skipped (61)` | 0 |
| I2 | `1 passed | 60 skipped (61)` | 0 |
| A9′ | `1 passed | 60 skipped (61)` | 0 |

**计数非零已核**：`1 passed`，且 `Test Files 1 passed (1)`。

### 2.2 注入后（变红）—— 以及两次自曝的坏变异

⚠️ **我先按设计文档的直觉写了两个变异，实测把它们双双证伪。逐条记下，因为这正是 brief §1 警告的那件事。**

**变异 M2（作废）**：在 `publishReconciliationUnderTransferLock` 里把 `lock.release()` 提到读之前
（「锁不再跨越读→判定→写」）。
**实测：I1 / I2 / A9′ 全部仍绿（三次 exit=0）。**
**原因（我事后才看懂）**：I2 与 A9′ 的夹具里输家**根本拿不到锁**，abandon 发生在那句 release 之前，
M2 只变异了「拿得到锁」的那条路径。**M2 是死探针，不能用来证明任何事。**

**变异 M2′（作废）**：把 `acquireOwnerTransferLockForReconciliation` 整个短路成「假锁」。
**实测：I2 变红了，但红在 `expect(loserReachedItsOwnPublish).toBe(false)`，而两条终态断言仍然绿。**
**原因**：M2′ 只删了锁，却留下了 D2 新增的 `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })`。
于是输家**替赢家把事务 finalize 掉了**（rename #2/#3 由输家完成），再去读时读到的是一致的已提交状态，
保护判定成立，写回的是赢家那份 —— 终态碰巧仍然正确。
**⇒ M2′ 不是「D2 缺席」，它是另一种（更危险的）代码形状。** 顺带记：M2′ 下 `tsc --noEmit` 报 TS2322（我的变异写得不严谨），
不影响 vitest 结论，但如实记下。

**变异 M3（真正的「D2 缺席」，两处一起改，`tsc --noEmit` exit 0）**：
1. `publishReconciliationUnderTransferLock` 的函数体换成 D2 之前的顺序（无锁、无持锁恢复）；
2. `readPersistedSuccessfulTransferArtifacts` 的 `readOwnerRecordRaw` 改回 `readOwnerRecord`。

| 判据 | M3 下结果 | **靠哪一条断言变红** | exit |
|---|---|---|---|
| **I2** | `1 failed | 60 skipped (61)` | *** `expect(terminal.eligibleForContinuation).toBe(true)`（原始输出：`AssertionError: expected false to be true`，行 2913）*** —— **就是终态断言本身**，赢家已发布的记录被输家的迟到写覆盖 | 1 |
| **A9′** | `1 failed | 60 skipped (61)` | `expect(reconciliationAbandonmentsInWindow).toHaveLength(1)`（`expected [] to have a length of 1 but got +0`，行 2584） | 1 |
| **I1** | `1 passed | 60 skipped (61)` | 不红（**预期如此**，见下） | 0 |

**变异 M1（D1 形状：ENOENT 也 fail-closed）**：把 `preserveSuccessfulReconciliationIfNeeded` 的
`no_published_transfer` 臂由 `{kind:"write"}` 改成 `{kind:"abandon"}`。`tsc --noEmit` exit 0。

| 判据 | M1 下结果 | **靠哪一条断言变红** | exit |
|---|---|---|---|
| **I1** | `1 failed | 60 skipped (61)` | *** `expect(abandonments).toEqual([])`（原始输出：`expected [ Array(1) ] to deeply equal []`，收到 `"Error: CCLOOP_MUTATION_M1_ENOENT_FAIL_CLOSED"`，行 2687）*** | 1 |
| **I2** | `1 passed | 60 skipped (61)` | 不红（**预期如此**） | 0 |

*** **两条判据都是靠 `AssertionError` 变红的，没有一条是靠异常或超时变红的**（brief §5 第 8 条）。 ***

**为什么 I1 与 I2 需要不同的杀手变异 —— 我主动说清，不藏：**
I1 那个交错（输家先、赢家后）里，赢家的 rename #3 天然最后落地，**任何**代码形状下终态都是赢家那份。
所以 I1 的终态断言在 M3 下必绿。I1 的承重断言是另外两条：「输家确实写下了它的降级」＋「没有 abandon」——
它挡的是**「用删掉正常路径产物换来的顺序无关性」**，也就是 D1。
**结论：I1 与 I2 是一对，谁也不能单独充当证据。I2 证明「锁关闭了危险交错」，I1 证明「关闭不是靠不写换来的」。**

### 2.3 还原（三步的第三步）

每次变异之后都 `git checkout -- src/persistence/fileStore.ts` 还原，并给出原始证明：

| 探针 | 期望 | 实测原始输出 |
|---|---|---|
| `rtk proxy git diff`（原始，未过滤） | 空 | 无输出；`RAW_BYTES=0` |
| **必不命中** `grep -rn "CCLOOP_MUTATION" src tests` | 零命中 | 零行，`MUT_EXIT=1` |
| **必命中（同一 grep、同一路径，证明探针活着）** `grep -rc "acquireOwnerTransferLockForReconciliation" src/persistence/fileStore.ts` | 非零 | `src/persistence/fileStore.ts:2` |
| **必命中 2** `grep -rc "publishReconciliationUnderTransferLock" src/persistence/fileStore.ts` | 非零 | `src/persistence/fileStore.ts:4` |
| `git status --porcelain` | 只剩 untracked | `?? …/rereview-s4.diff`、`?? …/review-s4.diff`（**两条本任务前就存在**）、`?? …/task-4th-impl-report.md`（本文件） |

⚠️ 全部走 `rtk proxy`。裸 `git diff` 经本仓库 hook 会吞输出，这里没有用它下过任何结论。

---

## 3. brief §3 两句举证的正面回答

**先声明**：下面没有一处用「人已授权」当论据。

### 3.1 第 4 笔关闭之后，那条轨迹为什么不再是 damaged —— 拿今天的代码证

**要害原文逐字**：「"P1's third rename puts the winner's record back" is an ordering **this harness imposes,
not a property of the system**」。

**我的答案，四层，第四层是限定：**

**(1) 那句话依赖的具体反例，被今天分支上的代码移除了 —— 而且这次是实测，不是推理。**
反例是「in production the loser's write may perfectly well land after rename #3」。
I2 的夹具**刻意制造这个反例**：hook (ii) 把输家自己那次 `rename(… → reconciliation-record.json)` 扣住，
直到赢家的整笔事务（含 rename #3）跑完才放行。
- **M3（D2 缺席）下**：输家确实落在 rename #3 之后，终态 = 输家的降级 ⇒ `expected false to be true`。
  **那句 2026-08-02 的话在没有 D2 的代码上是真的，我把它复现出来了。**
- **D2 下**：hook (ii) **根本没被触发**（`loserReachedItsOwnPublish === false`），
  因为输家在赢家持锁期间连读都开始不了。终态 = 赢家那份。
⇒ **不是「夹具排出了好顺序」，是「夹具排了坏顺序，系统拒绝进入它」。这是我能给出的最强区分。**

**(2) 可断言的那条命题与被否掉的那条不是同一条 —— 我兑现这个区分，不推翻它。**
- 被否掉的命题「**P1 的第三次 rename 把赢家的记录盖回去**」：**D2 之后仍然是夹具强加的顺序，仍然 damaged，
  我没有断言它，也在 A9′ 的注释块里逐字留了禁令**（见 §4）。
- 变得可断言的是**另一条**：「两个进程都跑完之后，`reconciliation-record.json` 是赢家那份」，
  **并且在两种取锁顺序下各断言一次**（I1 / I2）。**正是「两序都成立」这件事把它从夹具性质变成系统性质。**
  单序断言我明确拒绝过：I1 单独看不出任何东西（§2.2 末尾已自曝），I2 单独看缺「不是靠不写换来的」那一半。

**(3) 限定条件（不省，省了就钉出假命题）：** 命题只在**无成功 resume 介入**时成立。
依据是 `transferRepresentsPublishedWinner` 上方注释逐字：「(b) goes false at the SAME epoch after any successful
resume … That divergence is **INTENDED**, per the human ruling」。**D2 不改它。**
我把这个限定写进了 `publishReconciliationUnderTransferLock` 的就地注释，而不是只写在报告里。

**(4) 我必须自己说出来的残余**：**D2 之后终态仍依赖「那把锁没被偷」。**
`tryRecoverStaleOwnerTransferLock` 能删掉被判为 stale 的锁文件；锁被偷 ⇒ 互斥破裂 ⇒ 顺序依赖回来。
**所以精确说法是：D2 把「终态依赖调度顺序」收敛到「锁被偷」这一个前提上，不是消灭它。**
这一条我没有写任何判据去钉，也**不主张**它已关闭。

### 3.2 逐字指明推翻了哪一部分、保留了哪一部分

设计员给了「4 句推翻 / 5 句保留」。**我自己核了一遍，三条同意、一条不同意、一条要补。逐条说：**

**被推翻（我同意设计员的判断，复述并补实测依据）：**

1. > the loser **does** go on to write its downgraded record
   **同意推翻。实测**：A9′ 里 `reconciliationAbandonmentsInWindow` 长度 1、内容含 `OwnerTransferLockBusyError`，
   `ownerTransferReadOutcomesInWindow` 为 `[]`。输家在该窗口里既没读也没写。
2. > The stronger property is not pinnable at this layer.
   **同意推翻**，但**只以 §3.1(2) 改写后的两序命题**。原样的「更强性质」我仍然认为不可钉。
3. > in production the loser's write may perfectly well land after rename #3.
   **同意推翻，但必须带限定**：在 D2 且**锁未被偷**、且**无成功 resume**的前提下为假。M3 变异证明了去掉 D2 它就回来。

*** **我不同意的一条：** ***

4. 设计员把 > Everything asserted below is scoped to the loser's window. 列为「被推翻」。
   **我不同意。这句话在改后的 A9′ 里仍然逐字为真，而且我刻意让它继续为真。**
   A9′ 的所有断言仍然只看输家窗口内的事（abandon、读结果为空、窗口内没有 publish temp 被 rename）；
   **终态命题我没有塞进 A9′，而是放进了两条新增的 `it`。**
   理由正是 2026-08-02 那条禁令本身：在一个由夹具决定「输家整段跑在赢家窗口内」的测试里断言终态，
   就是拿夹具顺序当系统性质。**所以这句没有被推翻，它被遵守了。**
   *** 这是我与设计员读法的实质分歧，不是措辞差异，就地上报。 ***

**被保留（我核过，同意，且逐条落到代码注释里）：**

1. > "P1's third rename puts the winner's record back" is an ordering this harness imposes, not a property of the system
   **原样保留**，并在 A9′ 注释块里逐字重申「D2 does NOT lift that」。
2. > Asserting it as correct behaviour would write a damaged trajectory into the suite.
   **原样保留**，并就地写明「这就是新判据要两序、不要单序的原因」。
3. > ⚠️ What assertion (a) pins, stated honestly … **Do not read assertion (a) as more than it is.**
   **保留其判断，但那一段的**具体对象**没了**：(a) 被**替换**，不是被重新解释。
   我在注释里写死「the observation the old (a) made is not weakened here, it is no longer reachable」。
   **我不说「(a) 其实一直钉着更强的东西」——那才是静默覆盖。**
4. > ⚠️ Mutation 2 … **That list is NOISE, not this test's guardrail**
   **原样保留。** 本报告的所有变异结论都用**具名单跑**取得，没有一条用「套件红」当证据。
5. 关于命名口径（「A name is what appears in failure output…」）**原样保留**：
   新名字 `abandons the loser's reconciliation write against the winner's held transfer lock and finalizes
   none of the winner's transaction inside the publish window` 的两个子句分别对应改后的 (a) 与原样的 (b)，
   **没有一个子句是没有断言支撑的。**

**补一条设计员没提、但我认为必须点名的：**
spec `2026-08-01-…-design.md` §4.3 对方案 (c) 的否决**被这次改动推翻了一半**：
「不排除它是更彻底的解」＋「Rule 2 取最小解」这半是范围否定，第 4 笔就是来做超范围那件事的；
但「**给它加锁会让一条从不失败的路径新增一类 `OwnerTransferLockBusyError` 失败**」这半
**今天被实测证明为真**（§5.2 的红），**没有被推翻**。
⚠️ **我没有改 spec 的任何一个字节**（brief §4 硬边界 5）——就地记进报告。

---

## 4. 被改的那一条既有判据 —— 改前改后逐字对照

**唯一被改的既有判据**：人裁 13 具名的那一条。**测试名**：
- 改前：`reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`
- 改后：`abandons the loser's reconciliation write against the winner's held transfer lock and finalizes none of the winner's transaction inside the publish window`

**断言 (a)**：
- 改前：`expect(ownerTransferReadOutcomesInWindow).toContain("ok");`
- 改后：
  ```
  expect(reconciliationAbandonmentsInWindow).toHaveLength(1);
  expect(reconciliationAbandonmentsInWindow[0]).toContain("OwnerTransferLockBusyError");
  expect(ownerTransferReadOutcomesInWindow).toEqual([]);
  ```
**断言 (b)**：`expect(publishTempRenameSourcesInWindow).toEqual([]);` —— **一个字节没动。**
**夹具**：只加了一个 `onReconciliationWriteAbandoned` 回调（`runLoopFromState` 既有的可选参数），
mock、交错点、window 的开合逻辑**一个字节没动**。

**为什么新形状不再 damaged：**
1. 它**没有**断言终态，因此不落在 2026-08-02 那条禁令之内（禁令针对的是「拿夹具顺序当系统性质的终态断言」）。
2. 它断言的是**输家窗口内**的事实，与旧 (a) 同一个作用域 —— 「Everything asserted below is scoped to the loser's
   window」这句仍然逐字成立（§3.2 第 4 条）。
3. 旧 (a) 观察的那个数组**被留下并断言为空**，而不是删掉：将来谁把输家的读放回这个窗口，这条判据**会红**，
   不会静默通过。
4. 终态命题被移到 I1 / I2，**两序各一次**。

**关于删除行（brief §4 硬边界 1 要求单独讲清）：**
`git diff --numstat 2af4137 HEAD` ⇒ `tests/controller/runLoop.integration.test.ts | 373 +, 16 -`。
把 16 条删除行逐条列出（`git diff -U0 … | grep "^-"`，原始输出见 §7）：
**5 行注释（旧「It does NOT pin…」段）＋ 4 行注释（旧「⚠️ No terminal-state assertion」段）＋ 1 行测试名
＋ 1 行 `await observedRunLoopFromState(...)`（改成带回调的多行调用）＋ 4 行注释（旧 (a) 的说明）＋ 1 行旧断言 (a)。**
*** **16 行全部落在人裁 13 具名的那一条 `it` 及其注释块内。`tests/` 其余部分删除行数 = 0。** ***

---

## 5. 锁忙语义的复用核实结果

**结论：形状可复用（有一处被既有约束强制的偏离）；但把它用到 reconciliation 写上会撞一条既有判据。两句都要看。**

### 5.1 可复用的部分（已核实，不是照抄）

控制器裁量给的形状是「**有界重试 → 耗尽则放弃 ＋ 争用事件恰好追加一次**」，判例是 `persistOwnerTransfer`。逐条核：

| 要素 | 判例（`src/controller/runLoop.ts`） | 本次复用 | 核实结论 |
|---|---|---|---|
| 有界重试 | `for (attempt < OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)`，`delay(OWNER_TRANSFER_LOCK_RETRY_DELAY_MS)` | 同形，`RECONCILIATION_LOCK_RETRY_ATTEMPTS = 3` / `..._DELAY_MS = 50` | **可复用** |
| 常量来源 | `runLoop.ts` 导出 | **不能 import** —— `runLoop.ts` import 了 `fileStore.ts`，反向 import 会成环 | **不可直接复用，只能同值另立**；已在就地注释里写明理由 |
| 只重试 busy | `if (!(error instanceof OwnerTransferLockBusyError) || isLastAttempt) throw` | 只重试 `OwnerTransferLockBusyError` | **可复用** |
| 耗尽后的处置 | **rethrow** | **abandon**（不 throw） | *** **不可复用，且偏离是被强制的** *** —— `writeBoundaryArtifacts` abandon 臂就地注释的约束 1 逐字禁止：throw 会经 `persistBoundaryAnalysis` 落到 `runLoopFromState` 外层 catch（`isLeaseStopError` 不匹配 I/O 错误），**把一次保护性放弃升级成 attempt failed**。 |
| 非 EEXIST errno | 判例里 rethrow | abandon | 同上，同一条约束 |
| 争用事件恰好一次 | `owner_transfer_contended`，在 catch 里追加一次 | **复用既有的 `reconciliation_write_abandoned` 通道**（abandon 臂里 callback 一次 ＋ appendEvent 一次，`return` 收尾） | **可复用，且按构造就是恰好一次** |

**⇒ 我没有发明第三种语义**：偏离的两格都是既有就地注释**已经要求**的东西，不是新决定。
控制器点名的两条既有判据在本分支上**都是绿的**（见 §7 全套件：
`retries a busy owner-transfer lock and completes once it clears (spec requirement 1)` ✓、
`abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2)` ✓）。

### 5.2 撞上的那一条（就地停住，上报）

```
tests/controller/leaseLifecycle.integration.test.ts
  > lease heartbeat lifecycle
  > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy
→ Error: ENOENT: no such file or directory, open '…/reconciliation-record.json'   (行 517)
```

**机制（读它的夹具读出来的，不是猜的）**：该测试的 adapter 在 `execute` 里往 runDir 写了一个
`.owner-transfer.lock`，holder 是 `pid:${process.pid}`（**活着的 pid，因此 stale 回收会拒绝清它**），
而且**整条 run 里没有任何东西删它**。于是：
- **今天（D2 之前）**：转移的 CAS 因锁忙放弃 → 追加 `owner_transfer_contended` → 循环继续 →
  `writeBoundaryArtifacts` **不需要锁**，照常写下降级的 `reconciliation-record.json`（`newOwnerEpoch: null`、
  `eligibleForContinuation: false`）→ 测试读它、断言它。
- **D2 之后**：那次 reconciliation 写**也要同一把锁**，锁**永远**忙 → 有界重试耗尽 → abandon → 文件根本不存在 → ENOENT。

**它的自陈**（就地注释逐字）：「a transfer abandoned because the owner-transfer lock stayed busy must leave
**the same trace shape as any other abandoned transfer (newOwnerEpoch: null)** PLUS an event naming the reason」，
落款 `Task 1 / spec §3, §5.3 and §12 requirement 2`。
**它还被 spec `2026-08-01-…-design.md` 逐字列进「锁忙行为的既有护栏」清单的第 6 条。**

⇒ **这不是一条可以顺手改的测试**：它不是人裁 13 具名的那一条，改它会产生 `tests/` 里第 17 行删除，
而 brief §4 硬边界 1 明令那 16 行是**唯一**被允许的。**所以我没有碰它，红着交。**

**它在生产上的含义（不要只当成测试问题）**：D2 之下，一个**转移因锁持续忙而放弃**的 run，
从此**不再写 `reconciliation-record.json`**，只留两个事件。这是真实的行为变更，不是夹具产物。

---

## 6. 爆炸半径实测 —— 对设计文档「未验（推理）」逐条

设计 §4.2 那张表全部标「未验（推理）」。**逐条实测结果如下，与设计不一致的已点名。**

| 判据（完整测试名） | 设计的推理 | **我的实测** | 一致？ |
|---|---|---|---|
| `runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window` | **必红** | **红**，`AssertionError: expected [] to include 'ok'`（行 2564）。**且 `ownerTransferReadOutcomesInWindow` 实测为 `[]`，与设计给的机制解释一致** | ✅ |
| `fileStore > still writes the reconciliation record when owner-transfer.json is simply absent` | 绿 | **绿**（`fileStore.test.ts` 77/77 全绿） | ✅ |
| `fileStore > abandons the reconciliation write when owner-record.json is missing…` | 绿 | **绿** | ✅ |
| `fileStore > abandons … not valid JSON`（两条） | 绿 | **绿** | ✅ |
| `sweepRuns > prints a reconciliation_write_abandoned note on stderr without changing the run outcome` | 绿 | **绿**（`sweepRuns.test.ts` 13/13） | ✅ |
| `writeBoundaryArtifacts publishes each of its two files by replacing the path…`（整组） | 绿 | **绿** | ✅ |
| `runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts` | **方向不明，要求实测** | **绿**（`runLoop.integration.test.ts` 61/61） | ✅（不明 → 已定为绿） |
| *** `lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy` *** | *** **表里没有这一行** *** | *** **红** *** | ❌ **设计遗漏** |

*** **点名不一致处：设计文档的爆炸半径表漏了这一条。** *** 设计文档自陈「只覆盖符号名直接出现在测试里的调用点，
经 `runLoopFromState` 间接到达的不在搜索面内，因此是下界」——**这一条正是落在那个自陈的盲区里，而它恰好是决定性的。**
**这就是为什么「未验（推理）」不能当结论用。**

另外三条设计文档没预测、我实测到的**新事实**：
1. **变异 M2 是死探针**（§2.2）：「把 release 提前」不能弄红任何一条 —— 说明**「锁跨不跨越读写」这个属性
   在现有夹具里只能通过「拿不到锁」这一侧被观测**。
2. **变异 M2′ 暴露一条我自己引入的风险面**：只删锁、留下 `{lockHeld:true}` 的恢复，会让输家**替赢家 finalize 事务**。
   D2 下这不发生（拿不到锁就不进那段），但它说明**这两处改动是耦合的，不能分开回滚**。已写进就地注释。
3. `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })` 在 marker 不存在时会走
   `cleanupOwnerTransferStagingWithoutMarker`（删 staging 临时文件）——**这是本路径上一个新增的写**。
   我判断它安全（staging 只在持锁时发生，而此刻锁在我手里），且今天这条路径**本来就**经 `readOwnerRecord`
   做恢复（只是在锁空闲时才做）。**全套件没有因此变红。但这是我自己引入的、值得评审员盯的一处。**

---

## 7. 全套件 ＋ `tsc --noEmit` ＋ `npm run build`（未过滤）

**RUN 首行已核**：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4`（每次跑都核了）。
命令：`ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npx vitest run`，全文 tee 落盘，**没有 grep、没有 tail**。

| 项 | 结果 | exit |
|---|---|---|
| 全套件（最终态） | `Test Files 1 failed | 30 passed (31)` / `Tests 1 failed | 521 passed (522)` | **1** |
| `npx tsc --noEmit` | 无输出 | **0** |
| `npm run build` | 正常输出，无错误 | **0** |

**唯一的失败**：§5.2 那一条。**它不在 brief §5 允许的两条 flake 名单内，也不是那条已挂账的 `plan.json` ENOENT
（按完整测试名比对：那条是 `runLoop > persists phase usage evidence from the subprocess adapter without recomputing
controller totals`，本次两轮全套件里它都是**绿**的）。⇒ 按 brief 的规矩，它是新缺陷，我按新缺陷处理并停住。**

允许的两条 flake 本次**都没有出现**：`evidence.test.ts > run-scenario CLI > records env names only…` 绿（2787ms），
`continues normally when execute returns a complete result during the recovery window` 绿。

**改动面（`git diff --numstat 2af4137 HEAD`，原始）**：
```
115	15	src/persistence/fileStore.ts
373	16	tests/controller/runLoop.integration.test.ts
```
**只有两个文件。** spec / plan / `package.json` / 包 1 / `progress.md` **一个字节未动**（`git status --porcelain` 已核）。

---

## 8. 预算

**harness 的真实 token 计数我读不到，因此不给估计**（brief §7 第 8 条：读不到就明说）。
可重数的事实只有这些：读了 brief ＋ 设计文档全文 ＋ `fileStore.ts` 三段 ＋ `runLoop.ts` 三段 ＋
`runLoop.integration.test.ts` 两段 ＋ `leaseLifecycle.integration.test.ts` 一段；
跑了 2 次全套件、3 组具名单跑（每组 2–3 条）、2 次 `tsc`、1 次 `build`。
**按 CLAUDE.md Rule 6 我必须说明：本任务几乎肯定超过 100,000 tokens 的 per-task 预算。人裁 32 已预先放行，我没有为此停下，但记账在此。**

---

## 9. 我自己发现的、自己的缺陷

**有，三条，全部是我自己抓到并当场改掉/记下的（正面样本）：**

1. *** **我先写的变异 M2 是死探针，三条判据全绿。** *** 如果我按设计文档的直觉「release 提前 = 锁不再跨越」
   就收工，我会拿一个**什么也证明不了的绿**去宣称「变异证据齐备」。**是三步判据里的「注入后必须红」把它挡下来的。**
2. *** **我第二个变异 M2′ 让 I2 变红了，但红错了地方** *** —— 红在 `loserReachedItsOwnPublish`，
   终态断言仍绿。如果我只看「红了」就收，我会把一条**没有被终态断言承重**的测试报成「终态可断言」。
   **是「明确说明靠哪一条断言变红」这条要求把它挡下来的。**
3. **第一次跑 `-t 'lock order'` 命中 0 条**（`61 skipped`），我当场发现这是坏探针并换成完整测试名。
   **坏探针的零命中不能证明任何事** —— 这次没有让它变成结论。

**另有一条我判断为「我引入的、但不算缺陷、需要评审员复核」的**：§6 第 3 条的 staging 清理副作用。

**最后，一条我明确标「未验」的**：D2 之后终态仍依赖「锁不被偷」（`tryRecoverStaleOwnerTransferLock`）。
**我没有为它写任何判据，也没有实测过锁被偷的轨迹。它仍然是残余，应当具名传给 L5。**

---

# 修复环 1（人裁 37）—— 追加报告

**FIX_BASE `9881b91`**，本轮改动面：**`tests/controller/leaseLifecycle.integration.test.ts` 一个文件，+27 / −8。`src/` 自 FIX_BASE 起零字节改动。**

## F1. 结论

**状态：DONE。上一轮的 BLOCKED 已解除，且解除它的不是授权本身，是两件被实测的事。**

1. **人裁 37 具名的那条判据已按「只改读 `reconciliation-record.json` 的那一半」改完，全套件回到全绿**
   （`Test Files 31 passed (31)` / `Tests 522 passed (522)`，exit 0；本轮**一条 flake 都没出现**）。
   `owner_transfer_contended` 的两条断言**逐字未动**（见 F4 的删除行清单：8 行删除里没有一行属于它们）。
2. *** **人裁 37 的硬性条件已完成实测，答案是两句话，不能只说一句：** ***
   - **那个组合的后果不是无害的** —— 实测：把 `reconciliation-record.json` 从一个本来可 resume 的 run 里删掉，
     `resumeLoop` 抛 `ResumeNotEligibleError`，报错信息里逐字含 `reconciliation-record.json`（G3b）。
     **所以「后果 inert」这条路走不通，我不拿它交差。**
   - **但 D2 造不出那个组合** —— 两条腿都实测了（G1、G2），加上一次代码面枚举（带必命中/必不命中对照）。
3. **有一个我必须主动交代的窗口**：那个组合**确实存在**，但只存在于**赢家自己事务的 finalize 窗口内**
   （rename #1 之后、rename #3 之前）。**这个窗口不是 D2 造的，而且实测在 D2 前后逐字相同**（G4）。

## F2. 人裁 37 硬性条件的实测 —— 「reconciliation 缺席 ＋ owner-transfer 在场」

**方法**：临时探针 `tests/controller/tmp-gap-probe.test.ts`（**已删除**，删除证明在 F5），
在 HEAD（D2）与 **pre-D2 对照**（`git checkout 2af4137 -- src`）各跑一遍。
对照有效性已核：对照下 `grep -c "publishReconciliationUnderTransferLock" src/persistence/fileStore.ts` = **0**；
还原后 = **4**。

| 探针 | 问的问题 | HEAD（D2） | pre-D2 对照 |
|---|---|---|---|
| **G1** | 生产路径上唯一的 `owner-transfer.json` 发布者，会不会留下「transfer 在、reconciliation 不在」？ | **绿** —— 经 `runLoop` 完成一次真实转移后，两个文件**都在**，`reconciliation.newOwnerEpoch === 2` | **绿（相同）** |
| **G2** | 已经有这两个文件的 run，D2 的锁忙 abandon 会不会把 reconciliation 删掉？ | **绿** —— abandon 确实发生（`abandonments` 长度 1，含 `OwnerTransferLockBusyError`），而 `reconciliation-record.json` **逐字节未变** | **红**（`expected [] to have a length of 1`）—— pre-D2 根本不 abandon，它去写。**这条本来就是 D2 专属命题，红得其所** |
| **G3a** | 基线：两个文件都在的 eligible run 能 resume 吗？ | **绿**（`status === "succeeded"`） | **绿（相同）** |
| **G3b** | *** 只删掉 `reconciliation-record.json`，后果是什么？ *** | **绿** —— `resumeLoop` 抛 `ResumeNotEligibleError`，`String(thrown)` 含 `reconciliation-record.json` | **绿（相同）** |
| **G4** | 赢家事务自己的 finalize 窗口里，这个组合出现吗？ | **绿**，实测序列逐字：<br>`after owner-transfer.json: transfer=true reconciliation=false`<br>`after owner-record.json: transfer=true reconciliation=false`<br>`after reconciliation-record.json: transfer=true reconciliation=true` | **绿（序列逐字相同）** |

### F2.1 代码面枚举（脚本落盘后 `rtk proxy zsh` 跑，全文 tee，未过滤；带必不命中对照）

- **`owner-transfer.json` 的生产发布者只有一条路**：`finalizePendingOwnerTransfer`。
  另一个能写它的导出 `writeOwnerTransferRecord` 在 `src/` 下**零调用者**（`B_EXIT=0`，命中只有它自己的定义行），
  且其就地注释逐字自陈：「It exists only to build test fixtures — every call site is under tests/…；
  **Production must publish owner-transfer.json only through finalizePendingOwnerTransfer**」。
- **`writeOwnerTransferArtifacts` 的生产调用者只有一处**：`src/controller/runLoop.ts:681`（`persistOwnerTransfer`），
  它**总是**传 `reconciliationRecord` ⇒ marker 恒为 **v2**（`finalizeOrder` 含 `RECONCILIATION_RECORD_FILE`）。
  v1（不含 reconciliation）只有在 `reconciliationRecord === undefined` 时才产生，**生产上没有这样的调用点**。
- **`src/` 下没有任何东西删除 `reconciliation-record.json`**（`cleanupOwnerTransferStagingWithoutMarker` 只删 staging 临时/pending 文件）。
- **必不命中对照** `zzz_control_token_never_present_zzz`：`D_EXIT=1`（同一批 grep、同一批路径）⇒ 上面的零命中不是坏探针造成的。

### F2.2 正面回答

*** **组合可达吗？** —— **D2 造不出它。** 三条独立的实测/枚举各自足以支撑： ***
(i) 唯一的生产发布者把两个文件放在**同一笔事务**里提交（G1，pre-D2 相同）；
(ii) D2 的 abandon **不写也不删**，已有的文件逐字节不动（G2）；
(iii) 没有任何代码删除该文件，且能单独写 `owner-transfer.json` 的那个导出在生产上零调用者（F2.1）。

*** **那它在哪儿真的出现？** —— **只在赢家事务的 finalize 窗口内**（G4 的第 1、2 行）。 ***
**这个窗口属于 `finalizePendingOwnerTransfer`，D2 一个字节没碰它；实测序列在 D2 前后逐字相同。**
⇒ 若有并发 `resumeLoop` 恰好落在这个窗口里读，它会被拒（G3b 的后果），
**但这是一条先于 D2 就存在的行为，不是 D2 引入的，也不是本笔的范围。我把它具名记下，不顺手改。**

*** **后果 inert 吗？** —— **不 inert，我不含糊**（G3b）。 ***
正因为不 inert，本条的结论**完全压在「D2 造不出它」上**，而那三条是实测/枚举，不是推理。

⚠️ **仍然标未验的一格**：G3b 只证明「该组合会拒绝 resume」。
**我没有测「finalize 窗口内并发 resume」这条完整轨迹**（要同时驱动一笔事务与一次 resume 竞速）。
**它是先于 D2 的行为，我判断不属于本笔，但我不假装测过。**

## F3. 被改的那一条既有判据（人裁 37）—— 改前改后逐字对照

**测试名：一个字未改**（`appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy`）。

**删掉的（读 `reconciliation-record.json` 的那一半，且仅此）：**
```ts
const reconciliation = JSON.parse(
  await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
) as { ownershipVerdict: string; newOwnerEpoch: number | null; eligibleForContinuation: boolean };
...
expect(reconciliation.newOwnerEpoch).toBeNull();
expect(reconciliation.eligibleForContinuation).toBe(false);
```
**换成的：**
```ts
await expect(access(join(runDir, "reconciliation-record.json"))).rejects.toThrow();
expect(await readEvents(runDir)).toContainEqual(
  expect.objectContaining({ type: "reconciliation_write_abandoned" }),
);
```
*** **必须保留的那一半，逐字未动（可与 FIX_BASE 逐字节比对）：** ***
```ts
expect(await readEvents(runDir)).toContainEqual(
  expect.objectContaining({ type: "owner_transfer_contended" }),
);
expect(await readEventTypes(runDir)).not.toContain("owner_epoch_transferred");
```
`expect(owner.currentOwnerEpoch).toBe(1)`、`expect(finalState.status).toBe("exhausted")`、
`await expect(access(join(runDir, "owner-transfer.json"))).rejects.toThrow();` 同样**逐字未动**。

**为什么是「替换」而不是「删除」**：新形状把一条断言换成**两条** ——
「文件不在」**和**「拒绝上了事件流」。**缺席不等于沉默**：只断言前者，将来谁把事件那半砍掉，测试仍然绿，
而那正是 `writeBoundaryArtifacts` 约束 2 逐字点名的 "a genuine silent failure"。这一层理由写进了就地注释。

### F3.1 三步变异证据（这条判据自己的）

| 步 | 做法 | 结果 |
|---|---|---|
| 注入前 | HEAD | **绿**，`1 passed | 26 skipped (27)`，exit 0 |
| **注入后** | **pre-D2 对照**（`git checkout 2af4137 -- src`，D2 符号计数实测为 0） | *** **红**，`AssertionError: promise resolved "undefined" instead of rejecting`（行 541，即 `access(reconciliation-record.json)` 那条断言） *** —— **靠断言变红，不是异常、不是超时**；`1 failed | 26 skipped (27)`，exit 1 |
| 还原 | `git checkout HEAD -- src` | `rtk proxy git diff -- src` **原始输出 0 字节**；必命中探针 `publishReconciliationUnderTransferLock` = **4**；必不命中 `CCLOOP_MUTATION` = **0** |

## F4. 改动面与删除行（硬边界）

`git diff --numstat 9881b91 -- src tests`：
```
27	8	tests/controller/leaseLifecycle.integration.test.ts
```
**`src/` 自 FIX_BASE 起零改动 —— 本轮是纯测试改动。**
`git diff -U0 9881b91 -- tests | grep "^-"` 的 8 行删除**全部**落在人裁 37 具名那条 `it` 的
「读 `reconciliation-record.json`」那一半（3 行读取 ＋ 1 行空行 ＋ 2 行注释 ＋ 2 行断言）。
*** **`owner_transfer_contended` 相关断言零删除、零修改。其余任何既有判据零删除。** ***
**我没有需要第二条例外**（人裁 37 明令：需要第二条就停下上报 —— 不需要）。

## F5. 临时探针的删除证明

| 探针 | 期望 | 实测 |
|---|---|---|
| `git status --porcelain` | 不再出现 `tmp-gap-probe.test.ts` | 只剩 ` M tests/controller/leaseLifecycle.integration.test.ts` ＋ 两条本任务前就存在的 `?? …*.diff` |
| **必不命中** `grep -rn "tmp-gap-probe\|gap probe" tests/` | 零命中 | `PROBE_GREP_EXIT=1` |
| **必命中对照（同一 grep 根）** `grep -rc "describe(" tests/controller/leaseLifecycle.integration.test.ts` | 非零 | `1` ⇒ **上面的零命中不是坏探针** |
| `rtk proxy git diff -- src` | 空 | 0 字节 |

## F6. 全套件 ＋ `tsc --noEmit` ＋ `npm run build`（未过滤）

`RUN` 首行已核：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4`。

| 项 | 结果 | exit |
|---|---|---|
| 全套件 | **`Test Files 31 passed (31)` / `Tests 522 passed (522)`** | **0** |
| `npx tsc --noEmit` | 无输出 | **0** |
| `npm run build` | 正常输出，无错误 | **0** |

**本轮零失败、零 flake**：允许的两条 flake 与那条已挂账的 `plan.json` ENOENT **都没有出现**
（`evidence.test.ts > run-scenario CLI > records env names only…` 绿 3027ms；
`runLoop > persists phase usage evidence…` 绿 858ms）。

## F7. 按协调者要求原样带过来的东西（不改口径）

- **两个死/错变异必须留档**：M2（把 `release()` 提前）**三条判据全绿**，是死探针；
  M2′（只删锁、留下 `{lockHeld:true}` 恢复）让 I2 红在 `loserReachedItsOwnPublish` 而**终态断言仍绿**。
  *** **只有忠实的两处一起回退（M3：函数体回退 ＋ `readOwnerRecordRaw` 改回 `readOwnerRecord`）才能让 I2 的终态断言变红。**
  复现必须用 M3。 ***
- **与设计员的分歧仍然挂着，不合并**：他把
  「Everything asserted below is scoped to the loser's window」列为**被推翻**；
  **我仍然认为它被保留了** —— 改后的 A9′ 所有断言仍只看输家窗口，终态命题在两条新增 `it` 里。
  **我没有采纳他的读法，也没有要求他采纳我的。**
- **`cleanupOwnerTransferStagingWithoutMarker` 那处我自己引入的新写，仍然挂在评审员名下**（本轮未动它，全套件绿）。
- **偷锁残余仍然具名、未钉、属于 L5**，本轮没有为它加任何判据。

## F8. 预算

**harness 的实数我读不到，因此不给估计。** 会话成本提示（hook）本轮显示 `~$148.84`，
**那是美元不是 token，我不拿它当 token 计数用。** 人裁 32 已放行，我没有为预算停下。

## F9. 本轮我自己发现的、自己的缺陷

**一条**：我最初打算把 G3b 写成「后果 inert」的证据 —— 实测直接把这个期待打掉了（resume 被拒）。
**是先写探针再下结论救了这一条**；如果我先写结论再补探针，我会写出一句「后果无害」的假话。
本轮没有其他自伤。
