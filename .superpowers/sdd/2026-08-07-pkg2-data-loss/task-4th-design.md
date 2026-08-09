# 第 4 笔 —— 只读设计（残余 reconciliation TOCTOU）

> 状态：骨架已落盘，各节待填。
> 本文件是**设计**，不是终局；控制器会把它交给人裁，人批了才实施。

## 0. 交付前置与偏差自陈

- **§0「先落盘再检索」被违反一次，如实记录，不辩护。** 我在读 brief 的同一条消息里并行跑了一条编排命令
  （`rtk proxy git status --short && rtk proxy git log --oneline -3 && ls .superpowers/sdd/2026-08-07-pkg2-data-loss/`）。
  它的目的是确认工作区与分支，但按 §0 的字面它已经算「检索」。骨架落盘发生在**该命令之后、任何源码/文档检索之前**。
- **只读边界遵守情况**：`src/`、`tests/`、spec、plan 一个字节未改；未 commit 代码；未 push / merge / 删分支 / 开门；
  `progress.md` 未动。本文件是本次唯一产物。
- **临时变异次数：1，且是「为了证明还原证明本身有效」的那一次**（往 `src/persistence/fileStore.ts` 末尾追加一行
  `// CCLOOP_SANITY_PROBE_MARKER` 再删掉），**已证明还原**，原始输出在 §9.2。
  **为设计目的而做的生产代码变异：0 次。**
  **代价必须一并写下：0 次设计性变异意味着本文档里所有「某测试会变红 / 不会变红」的判断都是*静态推理*，不是*实测*，
  每一条都在 §4 就地标了「未验（推理）」。** 这是刻意的取舍（见 §7 的预算说明），不是遗漏。
- **预算自陈（CLAUDE.md Rule 6）**：本任务的 harness 实测 token 数我读不到真实数字，**因此不给估计**。
  但按 Rule 6「不许静默超支」，我必须说明：本任务的检索量（读完 brief ＋ spec §4.3/§13 ＋ plan A7/A9 ＋
  `fileStore.ts` 的 100–540 与 810–1160 ＋ `leaseHeartbeat.ts` 的 185–335 ＋ `runLoop.ts` 三处 ＋ 一轮探针脚本）
  **很可能已超过 100,000 tokens 的 per-task 预算**。这是我停止做临时变异实验的直接原因。

## 1. 结论（最先写）

**判定一：形状 A 与形状 B 是同一条 TOCTOU 的两个入口，不是两条。** 依据不是我的推断，是 spec 自己的措辞 ——
`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` §13 第 4 笔逐字写「**两条已查实的时序**」，
并把它们挂在同一个根因下：「`preserveSuccessfulReconciliationIfNeeded` 的『读 → 判定 → 写』既不原子也不持锁，
**而且那次「读」本身是一个跨两个文件的 `Promise.all`，不是快照**」。两个入口只是让**保护判定失效**的两条不同途径
（A：判定压根没被求值；B：判定被求值但拿到跨文件的不一致快照），**失效之后的第二半完全相同**：
输家在一个不持锁的 `await` 边界之后把降级记录写下去。**因此只设计一组修法，不分开设计。** 论证见 §2。

**判定二：我给出 4 个候选（含 1 个「不修」基线之外的 4 个实修方案），其中只有 1 个能满足 brief §2 第 1 条。**

| 编号 | 形状 | 满足「终态不依赖调度顺序」？ | 有没有 2026-08-02 点名的那个代价 |
|---|---|---|---|
| **D1** | ENOENT 也一并 fail-closed（2026-08-02 已否的那个） | **是**（因为输家几乎不再写） | **有，且今天仍然成立** —— 我拿今天的代码证了，见 §4.1 |
| **D2** | 把输家的「读→判定→写」整块放进 `.owner-transfer.lock`（`acquireOwnerTransferLock`） | **是，但有条件** —— 条件是那把锁真的互斥 | **没有**，并给出机制级证明，见 §4.2 |
| **D3** | 写前贴身复核（re-read / double-check），不加锁 | **否** —— 只收窄不关闭 | 没有 |
| **D4** | 单文件单调性护栏（判定只读 `reconciliation-record.json`，不读另两个文件） | **否** —— 消掉了「跨文件非快照」那一半，留着「读早写晚」那一半 | 没有 |

**推荐：D2，且推荐是有条件的。** 一句理由：**D2 是四个里唯一一个既让终态在两种调度序下都正确、又不触发 2026-08-02 点名的那个代价的方案**
（它新增的唯一拒绝条件是「锁忙」，而锁忙要求另一个进程正在真的转移所有权 —— 与「`owner-transfer.json` 不存在」这个绝大多数 run 的常态**没有交集**）。

**推荐的条件（三条，缺一条我就不推荐它）：**

1. **D2 的顺序无关性建立在 `.owner-transfer.lock` 是一把可靠互斥锁之上，而 spec §13 第 1 笔逐字写着这把锁「可被偷」**
   （`tryRecoverStaleOwnerTransferLock`）。**所以 D2 关闭的是「本层的读与写不互斥」，它把残余降级成「锁协议自身的健全性」（§13 第 1 笔，L5）。
   这不是无条件关闭，我不把它写成无条件关闭。**
2. **D2 会新增一个 `tryRecoverStaleOwnerTransferLock` 的调用者** —— 那是 brief §4 明令不碰的待裁点 B。D2 不改 B 的一个字节，
   但它扩大 B 的执行面。**「这算不算碰 B」必须由人裁，我不替人裁。**
3. **锁忙（以及锁不可用的其余 errno）的处置是一条新增的拒绝**，按本仓库口径需要人裁。

*** **如果人裁认为「把残余从『本层读写不互斥』挪到『锁协议健全性』不算关闭」，那么本设计的诚实答复是：
在不动锁协议（§13 第 1 笔）、不接受 D1 那个代价的前提下，第 4 笔做不到 brief §2 第 1 条要求的那种终态顺序无关性。**
这句话我愿意作为交付，而不是硬编一个能过关的方案。*** （brief §3 第 5 条明确承认这是合格交付。）

**另有一条我必须提前说清、否则任何新判据都会钉出一条假命题**（详见 §5.1 与 §8 第 4 点）：
即便 D2 落地，「输家的降级不会成为终态」这个命题也**只在「没有成功 resume 介入」的前提下成立**。
`transferRepresentsPublishedWinner` 的 clause (b) 在任何一次成功 resume 之后同 epoch 变假
（`src/persistence/fileStore.ts` 该函数上方注释逐字：「(b) goes false at the SAME epoch after any successful resume, with no race and no crash」），
**保护随之停止，赢家的记录被 resume 进程的降级替换 —— 而这是人裁明令保留的行为**（S-3 的 "never permit more"）。
**D2 不改它，也不该改它。** 新判据必须带上这个限定。

## 2. 形状 A 与形状 B 是否同一条 TOCTOU

**判定：同一条，两个入口。分别设计是错的。**

### 2.1 两个入口在今天代码里的落点（用符号名）

两者都发生在 `src/persistence/fileStore.ts` 的这条链上：

```
writeBoundaryArtifacts
  └─ preserveSuccessfulReconciliationIfNeeded            ← 读 + 判定，返回 ReconciliationWriteDecision
       └─ readPersistedSuccessfulTransferArtifacts       ← 两次读（owner-transfer.json；然后 owner-record + reconciliation 的 Promise.all）
            └─ preserveSuccessfulReconciliationIfNeededFromArtifacts
                 └─ shouldProtectSuccessfulTransferTruth
                      └─ transferRepresentsPublishedWinner   ← 跨两个文件的三条判定
  └─ writeJsonFileAtomically(join(runDir, "reconciliation-record.json"), decision.record)   ← 写
```

- **形状 A（spec 的「时序一」，T0/T1/T2）**：`readOwnerTransferRecordRaw` 抛 ENOENT →
  `readPersistedSuccessfulTransferArtifacts` 返回 `{ kind: "no_published_transfer" }` →
  `preserveSuccessfulReconciliationIfNeeded` 走那条**刻意放行**的分支 `return { kind: "write", record: nextReconciliationRecord }`。
  **`transferRepresentsPublishedWinner` 压根没被求值。**
- **形状 B（spec 的「时序二」，U0–U3）**：两次读都成功，但**读到的是不一致的一对**
  （`owner-transfer.json` 已是 N+1、`owner-record.json` 仍是 N）→ `transferRepresentsPublishedWinner` 的判据
  `ownerRecord.currentOwnerEpoch === ownerTransferRecord.newOwnerEpoch` 为假 → 保护退化 →
  `preserveSuccessfulReconciliationIfNeededFromArtifacts` 原样返回输家那份。

### 2.2 为什么是同一条

三条理由，每条都能独立支撑：

1. **spec 自己就是这么归的。** §13 第 4 笔标题下逐字：「两条已查实的时序」，共用一个笔号、一个根因句。
   §4.3 也把它们写在同一节（「上面四步只覆盖…」）。**我不发明新的分类。**
2. **两者的第二半逐字相同。** 无论保护是「没被求值」还是「被求值但退化」，之后都落到同一行
   `writeJsonFileAtomically(join(runDir, "reconciliation-record.json"), decision.record)`，
   而**这一行与前面那次读之间隔着 `await` 边界、没有锁、没有复核**。根因是这个间隙，不是使保护失效的那个具体机制。
3. **任何只针对一个入口的修法都留下另一个。** 反证：
   - D1（只堵 ENOENT）不碰形状 B —— B 根本不经过 ENOENT 臂（spec §13 第 4 笔逐字：「**这一条不需要 ENOENT**」）。
   - D4（只把判定改成单文件读）消掉形状 B 的跨文件不一致，也顺带消掉形状 A 的「判定没被求值」，
     **但留着「读早写晚」那一半** —— 也就是根因本身。
   **⇒ 只有针对「读—写间隙」本身的修法（D2）能同时覆盖两个入口。这就是同一条的实操含义。**

### 2.3 一处必须说清的口径分歧（brief 与 spec）

brief 把形状 B 描述为「epoch 过期」，引的是**测试注释**里那句
「the check returns false here (owner-record.json is still the old epoch — P1's rename #2 has not happened)」。
**在那条测试的夹具里**，判据为假的原因是 P1 的 rename #2 尚未发生（时间上的先后），
**而在 spec §13 第 4 笔的「时序二」里**，判据为假的原因是**两次读之间隔着 `readOwnerRecord` 的
`recoverInterruptedOwnerTransfer` 前缀，读到的一对本身就不是快照**。
**这是同一个判据失效的两种到达方式，不是两条缺陷** —— 前者夹具强加、后者生产可达；
**对修法没有区别**（两者都被 D2 的锁段一并覆盖，都不被 D1 覆盖）。就地记下，避免下一位读者以为 brief 与 spec 打架。

## 3. 今天代码的事实基线

以下每条都是**读今天的代码**得到的，标了符号名。**这些是后面所有论证的支点，先摆出来接受检验。**

**F1 —— 输家那次写没有任何锁。** `writeBoundaryArtifacts`（`src/persistence/fileStore.ts`）的 reconciliation 分支：
`preserveSuccessfulReconciliationIfNeeded`（读＋判定）→ `await` 返回 → `writeJsonFileAtomically`（写）。
全程零锁、零复核。

**F2 —— 赢家那次发布**全部**在一把跨进程锁内。** `writeOwnerTransferArtifacts` 的形状是
`acquireOwnerTransferLock` → `try { recoverInterruptedOwnerTransfer(runDir,{lockHeld:true}) → readOwnerRecordRaw → CAS 检查
→ 三份 pending 写 → marker 写 → finalizePendingOwnerTransfer } finally { lock.release() }`。
**三次 rename 都在 `finalizePendingOwnerTransfer` 里，即都在锁段内、都在 `release()` 之前。**
⇒ **今天已经存在一把能把赢家整个发布事务圈起来的跨进程互斥原语。D2 的全部内容就是让输家也用它。**

**F3 —— 那把锁的实现与它的两个失败面。** `acquireOwnerTransferLock`：`open(lockPath, "wx")`；
`EEXIST` → `tryRecoverStaleOwnerTransferLock`，回 false 就抛 `OwnerTransferLockBusyError`；
**非 EEXIST 的 errno 直接抛出**（EACCES / ENOSPC / EROFS 等）。⇒ D2 必须把**两类失败都**映射到 abandon（见 §4.2）。

**F4 —— 锁不可重入，且有一条现成的正确写法。** `readOwnerRecord` = `recoverInterruptedOwnerTransfer(runDir)`（**无** `lockHeld`）+ `readOwnerRecordRaw`；
而 `recoverInterruptedOwnerTransfer` 在 marker 存在且 `!options?.lockHeld` 时会**再取一次同一把锁**。
持锁状态下调 `readOwnerRecord` 不会死锁（那次 acquire 失败时它 `catch { return }` 静默跳过恢复），
但会**静默丢掉恢复**。**判例现成**：`writeOwnerTransferArtifacts` 与 `claimOwnerRecordWithPrecondition` 都是
`acquireOwnerTransferLock` → `recoverInterruptedOwnerTransfer(runDir,{lockHeld:true})` → `readOwnerRecordRaw`。

**F5 —— 「exclusive span」不是跨进程的，不要指望它。** `leaseHeartbeat.ts` 的 `runExclusive` 是一条
**进程内的 promise 队列**（`queue.then(refuseIfStopped, refuseIfStopped)`）＋ 一个 `stopped` 拒绝。
它对另一个进程 P1 毫无约束力。
⇒ **spec §13 第 3 笔那句「`writeBoundaryArtifacts` 落在 exclusive span 外」不能被读成「把它挪进去就修好了」。
挪进去只改变本进程内的次序，对本条 TOCTOU 零效果。** 这是一个很容易踩的坑，就地钉死。

**F6 —— 本仓库已经有一个「贴身复核」机制，而它的注释自己承认那只是收窄。**
`assertHeld`（`leaseHeartbeat.ts`）在 `writeBoundaryArtifacts` 之前刚刚被调用过（`src/controller/runLoop.ts` 的
`persistBoundaryAnalysis` 里那次 `await heartbeat.assertHeld();`），它的就地注释逐字写：
「re-checked immediately before EVERY side effect, **narrowing** the window in which a superseded owner can still act
from one phase to one side effect」。**是 narrowing，不是 closing。**
而且在形状 B 的时序里 `assertHeld` **必然通过** —— 它读的 `owner-record.json` 此刻仍是旧 epoch、仍名 输家。
⇒ **D3（再加一次贴身复核）是把一个已被本仓库自己标注为「只收窄」的机制再做一遍。这是我否掉 D3 的主要依据。**

**F7 —— 谁会带着 reconciliation 记录走到这条链上。** `src/controller/runLoop.ts` 的 `persistBoundaryAnalysis`：
`nextOwnerEpoch !== null`（即本进程自己完成了转移，也就是赢家）走的分支**不传** `reconciliationRecord`
（就地注释：「that call already published reconciliation-record.json transactionally … a second write of the same record
here would be exactly the "winner writes it twice" this task removes」）；
`else` 分支传 `reconciliationRecord`，**当且仅当 `boundaryAnalysis.status === "stale_candidate"`**。
再加上 `preserveSuccessfulReconciliationIfNeeded` 首行 `if (nextReconciliationRecord.eligibleForContinuation) return {kind:"write",...}` 的早退，
⇒ **走到读侧的，恰好是「stale_candidate 且本进程没完成转移」的那些 run，且它们的记录一律是降级记录。**
**这是 §4.1 里判定 D1 代价是否成立的关键事实。**

**F8 —— 一个不能被 D2 承诺掉的既有行为。** `transferRepresentsPublishedWinner` 上方的长注释逐字：
「(b) goes false at the SAME epoch after any successful resume, with no race and no crash … writeBoundaryArtifacts
replaces the winner's already-published eligibleForContinuation record with the resumed process's downgrade.
**That divergence is INTENDED**, per the human ruling recorded in
`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`」。
⇒ **「输家的降级永不成为终态」这个命题，在有成功 resume 介入时本来就是假的、而且是人裁要它假。
任何新判据都必须带「无成功 resume 介入」的限定。**

## 4. 候选修法（逐个：机制／爆炸半径／2026-08-02 那个代价／终态是否不依赖调度顺序／需不需要新人裁）

### 4.0 爆炸半径的搜索面声明（**这是搜索面，不是完备性证明**）

我用的命令与原始输出在 §9.1。搜索面是：

```
grep -rnF 'writeBoundaryArtifacts' tests/
grep -rn 'reconciliation_write_abandoned|abandons the reconciliation write' tests/
grep -rn 'still writes the reconciliation record when owner-transfer.json is simply absent' tests/
```

*** **这个搜索面只覆盖「直接以符号名出现在测试里」的调用点。** 经 `runLoopFromState` / `resumeLoop` / `sweepRuns`
**间接**到达 `writeBoundaryArtifacts` 的测试**不在这个搜索面内**，我没有枚举它们。
因此下面每个方案的「会弄红哪些」都是**下界，不是全集**。*** 探针见 §9.1（必命中 ＋ 必不命中各一条）。

---

### 4.1 D1 —— ENOENT 也一并 fail-closed（2026-08-02 已否的那个）

**机制**：`readPersistedSuccessfulTransferArtifacts` 里 `readOwnerTransferRecordRaw` 的 catch，
把 `if (code === "ENOENT") return { kind: "no_published_transfer" }` 删掉，让它一并走 `{ kind: "unreadable", error }`；
或等价地，把 `preserveSuccessfulReconciliationIfNeeded` 里 `no_published_transfer` 那臂从 `write` 改成 `abandon`。

**2026-08-02 点名的那个代价，今天是否仍然成立 —— 成立。用今天的代码证：**

被否的原文逐字（`docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`）：
> **把 ENOENT 也一并 fail-closed 会关闭它，但代价不可接受** —— 那等于让绝大多数 run **再也不写 `reconciliation-record.json`**。
> 那不是「增加拒绝」，那是删掉一条正常路径上的产物。

今天的代码给出的三步链（即 §3 的 F7）：

1. `persistBoundaryAnalysis` 的 `else` 分支传 `reconciliationRecord` 的条件**只有**
   `boundaryAnalysis.status === "stale_candidate"` —— **与「是否发生过转移」无关**。
2. `preserveSuccessfulReconciliationIfNeeded` 首行对 `eligibleForContinuation === true` 早退，
   ⇒ 走到读侧的**全部**是降级记录。
3. 一个从未转移过所有权的 run，`owner-transfer.json` **本来就不存在** ⇒ 必然 ENOENT。

⇒ **「stale_candidate 且从未转移过」这一类 run（按结构就是绝大多数会写这份记录的 run）在 D1 下全部不再写 `reconciliation-record.json`。
那句 2026-08-02 的话在今天逐字仍然为真。我找不到任何「今天代码让这个代价不再成立」的路径，也不试图用「时代变了」搪塞。**

**爆炸半径（下界）**：

- `tests/persistence/fileStore.test.ts > fileStore > still writes the reconciliation record when owner-transfer.json is simply absent`
  —— **必红**。plan 的 A7 Step 7 变异 1 逐字写着这条：「删掉 ENOENT 豁免（一律 fail-closed）→ **6f(i) 必红**」。
  *** **这条判据不是人裁 13 授权修改的那一条。选 D1 需要一次新的、点名到这条判据的人裁。** ***
- `tests/sweep/sweepRuns.test.ts` 的两条 `reconciliation_write_abandoned` 用例：**未验（推理）**，方向是「新增大量 abandon 事件」，
  可能影响它们对 stderr 行集合的断言。
- **未验（推理）**：任何经 `runLoopFromState` 走到 stale_candidate 且检查 `reconciliation-record.json` 存在的集成测试。不在搜索面内。

**终态是否不依赖调度顺序**：**是**（输家几乎永不写，也就没有覆盖），但这是用「删掉产物」换来的。

**需不需要新人裁**：**需要**，点名到 `fileStore > still writes the reconciliation record when owner-transfer.json is simply absent`。

**判定：不推荐。** 它满足 §2 第 1 条，但代价正是 2026-08-02 那层已经量化否掉、且今天仍然成立的那一个。

---

### 4.2 D2 —— 把输家的「读→判定→写」整块放进 `.owner-transfer.lock`（**推荐，有条件**）

#### 机制（符号名，不用行号）

在 `src/persistence/fileStore.ts` 内新增一个**模块内私有**函数，暂名
`publishReconciliationUnderTransferLock(runDir, nextReconciliationRecord)`，返回今天已有的
`ReconciliationWriteDecision`（**类型不变、不导出、不扩公开签名**），形状抄 `writeOwnerTransferArtifacts` 的判例：

```
const lock = await acquireOwnerTransferLock(runDir)          // 全部失败 → abandon，见下
try {
  await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })   // F4 的判例
  ... 读 owner-transfer.json（readOwnerTransferRecordRaw）
  ... 读 owner-record（readOwnerRecordRaw，**不是** readOwnerRecord —— F4）
  ... 读 readPersistedReconciliationRecord（一个字节不改）
  ... preserveSuccessfulReconciliationIfNeededFromArtifacts（一个字节不改）
  ... describePublishedWinnerReplacement（一个字节不改）
  await writeJsonFileAtomically(join(runDir, RECONCILIATION_RECORD_FILE), record)   // ← 写也在锁内
} finally { await lock.release() }
```

`writeBoundaryArtifacts` 保留 `boundary-analysis.json` 的写、abandon 臂的回调 ＋ `reconciliation_write_abandoned` 事件、
以及 `reconciliation_published_winner_replaced` 事件（**这两个事件都留在锁外**：它们是审计、不参与判定，
放进锁内只会延长临界区）。

**三条必须一起做、不是可选项的配套：**

1. **`acquireOwnerTransferLock` 的*全部*失败都必须映射到 abandon 臂，不只是 `OwnerTransferLockBusyError`。**
   依据是今天代码里的既有约束：`acquireOwnerTransferLock` 对非 EEXIST 的 errno（EACCES / ENOSPC / EROFS）**直接抛出**（F3）。
   若让它逃出 `writeBoundaryArtifacts`，它会经 `persistBoundaryAnalysis` 到 `runLoopFromState` 的外层 catch
   （`isLeaseStopError` 不匹配 I/O 错误），**把一次保护性放弃升级成 attempt failed** ——
   这正是今天 abandon 臂就地注释里三条约束的第 1 条明令禁止的形状。
2. **必须用 `readOwnerRecordRaw` ＋ `recoverInterruptedOwnerTransfer(runDir,{lockHeld:true})`，不能沿用 `readOwnerRecord`**（F4）。
3. **`readPersistedSuccessfulTransferArtifacts` 里那段解释「ENOENT 早退顺带跳过 `recoverInterruptedOwnerTransfer` 副作用」的
   就地注释必须同步改写** —— D2 下恢复改由持锁的 `{lockHeld:true}` 那次承担，注释所描述的事实变了。
   **这属于「事实变了所以改注释」，不是「顺手改注释」。**

**brief §6 点名的两个「不要顺手动」，D2 下都不动**：
`preserveSuccessfulReconciliationIfNeededFromArtifacts` **一个字节不改**（只是被换了一个调用位置）；
`readPersistedReconciliationRecord` 的 `catch { return undefined }` **一个字节不改**。
**因此 brief §6 那条「必须逐字引用理由并说明为什么今天不再成立」的义务在 D2 下不被触发** —— 我没有动它们。

#### 有没有 2026-08-02 点名的那个代价 —— **没有**，机制级证明

那个代价的机制是「**`owner-transfer.json` 不存在 ⇒ 拒绝写**」。D2 **完全不改 ENOENT 那一臂的处置**：
`kind: "no_published_transfer"` 仍然 `return { kind: "write", record: nextReconciliationRecord }`。
D2 新增的唯一拒绝条件是**锁不可得**，而锁不可得的充要前提是 `open(lockPath, "wx")` 失败（F3），
即 `.owner-transfer.lock` **此刻存在**（另一个进程正在跑 `writeOwnerTransferArtifacts` /
`claimOwnerRecordWithPrecondition` / `updateOwnerRecordWithPrecondition` / 无锁形态的 `recoverInterruptedOwnerTransfer`
的锁段），或文件系统层面的 errno。

⇒ **「从未转移过所有权、也没有并发转移」的 run —— 正是那个代价针对的「绝大多数 run」—— 在 D2 下
`open(lockPath,"wx")` 必然成功，照常写下 `reconciliation-record.json`。那个代价在 D2 下不成立。**

**可判定的核对方式（给实施者，不给我自己开脱）**：把 D2 的锁段删掉、其余一字不动，行为应与今天**逐字相同**。
若不相同，说明 D2 混进了别的改动。

#### 终态是否不依赖调度顺序 —— **是，在三条前提下**

两序论证（P1 = 赢家，P2 = 输家；R = `reconciliation-record.json`）：

- **序一：P2 先拿到锁。** P2 在锁内读到「无 transfer」（或转移前状态）→ 写下降级 R → 释放。
  P1 随后取锁、跑完整个事务，**在同一个锁段内**以 rename#3 发布自己的 R → 释放。**终态 = 赢家的 R。正确。**
- **序二：P1 先拿到锁。** P1 在锁内跑完三次 rename（F2：全在 `finalizePendingOwnerTransfer` 内、都在 `release()` 之前）→ 释放。
  P2 随后取锁，读到的是**已提交的一致状态**：`owner-transfer.json` = N+1 且 `owner-record.json` = N+1
  → `transferRepresentsPublishedWinner` 三条判定成立 → `shouldPreserveExistingReconciliationRecord` 成立
  → `resolveSuccessfulReconciliation` 返回**盘上赢家那份** → 写回的就是赢家那份。**终态 = 赢家的 R。正确。**

**⇒ 两种序都得到同一个正确终态。这正是 brief §2 第 1 条要的东西：终态不取决于谁先谁后。**

**三条前提，逐条摆明，其中第一条今天不满足：**

1. *** **那把锁真的互斥。** *** spec §13 第 1 笔逐字把「锁可被偷」列为交给 L5 的输入
   （`tryRecoverStaleOwnerTransferLock` 在判定为 stale 时会删掉别人的锁文件）。
   **锁被偷 ⇒ 互斥破裂 ⇒ 顺序依赖回来。所以 D2 是把残余从「本层读写不互斥」降级成「锁协议健全性（§13 第 1 笔，L5）」，
   不是无条件关闭。我不把它写成无条件关闭。**
2. **赢家的三次 rename 全在同一锁段内。** ✔ 今天成立（F2）。
3. **赢家转移之后不再经 `writeBoundaryArtifacts` 写 R。** ✔ 今天成立（F7 的 `nextOwnerEpoch !== null` 分支）。

**以及一条 D2 不承诺、也不该承诺的**：F8 的 resume 路径。新判据必须带「无成功 resume 介入」的限定。

#### 爆炸半径（下界，逐条具名；**全部标未验（推理），因为我做了 0 次变异**）

| 判据（完整测试名） | D2 下的方向 | 依据 |
|---|---|---|
| `runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`（`tests/controller/runLoop.integration.test.ts`） | *** **必红（未验，推理）** *** —— 断言 (a) 钉的是「输家在窗口内**成功读到** `owner-transfer.json`」。D2 下输家在窗口内**根本读不到**：`.owner-transfer.lock` 由 P1 持有，锁不可得 ⇒ abandon ⇒ 那次读不发生 | plan A9 逐字要求「fixture 必须让 `.owner-transfer.lock` 在窗口内存在且由一个活着的 pid 持有」；**这正是人裁 13 授权修改的那一条判据，对上了** |
| `fileStore > still writes the reconciliation record when owner-transfer.json is simply absent` | **绿（未验，推理）** —— fixture 无并发，锁自由 | **与 D1 的关键差别** |
| `fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned` | **绿（未验）** —— 锁自由，读侧行为不变 | |
| `fileStore > abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned` | **绿（未验）** | |
| `fileStore > abandons the reconciliation write when owner-transfer.json is not valid JSON, appending reconciliation_write_abandoned` | **绿（未验）** | |
| `sweepRuns > prints a reconciliation_write_abandoned note on stderr without changing the run outcome` | **绿（未验）** —— abandon 通道形状不变 | |
| `writeBoundaryArtifacts publishes each of its two files by replacing the path, not by writing through it`（整组） | **绿（未验）** —— 仍走 `writeJsonFileAtomically`，inode 语义不变 | |
| `runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts` | **未验，方向不明** —— 它构造 abandon 的手法若依赖某个具体错误，D2 可能改变到达 abandon 的路径 | 实施时必须实测 |

⚠️ **未枚举的一片**：所有经 `runLoopFromState` / `resumeLoop` 间接到达的测试。**不在我的搜索面内，我不断言它们的方向。**
⚠️ **另一个坑，A9 的注释亲自警告过**：那条具名测试的**其余**变红名单在 `task-A9-report.md` 里，
注释逐字说「That list is NOISE, not this test's guardrail」。**评审时不要拿那批噪声当 D2 的爆炸半径，也不要拿它当 D2 的罪证。**

#### 需不需要新人裁 —— **需要三处**，见 §8 第 1、2、3、4 点

---

### 4.3 D3 —— 写前贴身复核（re-read / double-check），不加锁

**机制**：在 `writeBoundaryArtifacts` 的写之前，紧贴 `writeJsonFileAtomically` 再跑一次
`readPersistedSuccessfulTransferArtifacts` ＋ `shouldProtectSuccessfulTransferTruth`，不一致就 abandon。

**终态是否不依赖调度顺序 —— 否。** 复核与写之间仍有 `await` 边界，赢家仍可在这个（更窄的）间隙里发布完。
**而且本仓库自己已经做过这件事并留下了裁判**：`assertHeld` 的就地注释逐字写着
「re-checked immediately before EVERY side effect, **narrowing** the window in which a superseded owner can still act
from one phase to one side effect」—— **narrowing，不是 closing**；它已经在 `writeBoundaryArtifacts` 之前被调用了一次（F6），
且在形状 B 的时序里它**必然通过**。⇒ D3 是把一个已被本仓库承认只能收窄的机制再做一遍。

**有没有 2026-08-02 那个代价**：没有（ENOENT 臂不变）。
**爆炸半径**：小（**未验**；预期只影响构造了「读后写前状态改变」的测试，搜索面内没有这种测试）。
**需不需要新人裁**：**需要** —— 它新增拒绝；而且它**不能**支撑一条终态判据，
所以 **它不解锁人裁 13 授权的那次判据修改**（改了判据反而会写进一条 D3 保证不了的命题）。

**判定：不推荐。但它是 D2 因待裁点 B 被否时的唯一退路** —— 那时诚实的交付是「窗口再收窄一点 + 残余仍具名传 L5」，
**并且不动那条具名判据**。

---

### 4.4 D4 —— 单文件单调性护栏

**机制**：把「要不要保护」的判定从「读 `owner-transfer.json` ＋ `owner-record.json` 做跨文件比对」改成
**只读 `reconciliation-record.json` 一个文件**：若盘上那份 `eligibleForContinuation === true`
且 `newOwnerEpoch !== null` 且不早于本次要写的 `priorOwnerEpoch`，就**保留盘上那份**（不覆盖）。
即把 `shouldProtectSuccessfulTransferTruth` 的入参从三个文件收成一个。

**它买到什么（真实的）**：

- **形状 B 的「跨文件非快照」这一半被彻底消掉** —— 只读一个文件，而该文件由 temp+rename 发布，读到的天然是原子快照。
- **形状 A 的「保护判定压根没被求值」也被消掉** —— 判定不再以 `owner-transfer.json` 存在为前提，ENOENT 不再是决策输入。
- **且它不触碰锁协议、不触碰待裁点 B。**

**它买不到什么（决定性的）**：**「读早写晚」那一半原样留着。** 输家在赢家 rename#3 之前读到「盘上还没有赢家的记录」，
在 rename#3 之后才写 —— **终态仍是输家的降级。⇒ 终态仍依赖调度顺序；按 brief §2 第 1 条的标准，它仍然 damaged。我自己说出来。**

**有没有 2026-08-02 那个代价**：没有。
**爆炸半径（未验，推理）**：**大**。它改的是判定的**输入集合**：
`transferRepresentsPublishedWinner` / `isSuccessfulReconciliationForTransfer` / `shouldPreserveExistingReconciliationRecord` /
`describePublishedWinnerReplacement` 的语义全部要重写，而 `describePublishedWinnerReplacement`
上方那段长注释（含人裁记录的「(b) 变假是 INTENDED」）会整段失效。
**⇒ 它踩到 F8 那条人裁：单文件单调性会让「resume 之后允许替换赢家记录」这个人裁明令保留的行为一并消失（它不再看 process instance id）。
方向上是 permit fewer，本仓库允许，但它推翻的是一条独立的人裁，必须单独裁。**

**需不需要新人裁**：**需要，而且是一条与第 4 笔无关的人裁**（F8 那条）。

**判定：不推荐单独使用。** 它与 D2 正交、可叠加（叠加后 D2 给顺序无关性、D4 给更简单的判定），
**但叠加会把改动面从「一个函数搬家」扩大到「整套判定谓词重写」，且要额外推翻一条人裁。我不推荐在第 4 笔里叠加。**

## 5. 正面回答 brief §2 的两个问题

**先声明一句，因为 brief 明令它不是论据**：下面没有一处用到「人已授权」。
人裁 13 解除的是「不许改那条判据」这个流程约束，**举证责任一条没免**。

### 5.1 问题一：第 4 笔关闭之后，那条轨迹为什么就不再是 damaged？

**先复述那句话的要害（brief 已经点明，我不敢读偏）**：要害不是「顺序对不对」，而是
「**这个顺序是夹具强加的，不是系统性质**」。原文逐字：

> ⚠️ **No terminal-state assertion, deliberately.** "P1's third rename puts the winner's record back" is an ordering
> this harness imposes, not a property of the system — in production the loser's write may perfectly well land after
> rename #3. Asserting it as correct behaviour would **write a damaged trajectory into the suite**.

**在 D2 之下，我的答案分三层，第三层是限定条件，不能省：**

**(1) 那句话所依赖的具体反例被今天的机制移除了。**
反例是「in production the loser's write may perfectly well land after rename #3」。
D2 之下这句在**无成功 resume 介入**的前提下为假：输家的写与它自己的读在**同一个 `.owner-transfer.lock` 锁段内**，
而赢家的 rename#1..#3 全部在**同一把锁的另一个锁段内**（F2）。
两个锁段互斥 ⇒ 输家的写要么**整体早于**赢家取锁，要么**整体晚于**赢家释放锁。
- 整体早于：赢家随后以 rename#3 覆盖它 —— 终态是赢家的。
- 整体晚于：输家在自己的锁段里读到的是**赢家已提交的一致状态**，`transferRepresentsPublishedWinner` 三条全真，
  `resolveSuccessfulReconciliation` 把**盘上赢家那份**原样写回 —— 终态还是赢家的。
- **「落在 rename#1 与 rename#3 之间」这个第三种可能被锁消掉了**，而那正是唯一产生损坏终态的那一种。

**(2) 因此可断言的那条命题，与被否掉的那条不是同一条 —— 这一点必须说死，否则就是偷换。**
- 被否掉的命题是：**「P1 的第三次 rename 把赢家的记录盖回去」**。
  *** **这条命题在 D2 之后仍然是夹具强加的顺序，仍然是 damaged，仍然不许断言。** ***
  D2 没有把「rename#3 在后」变成系统性质，一个字也没有。
- 变得可断言的是**另一条**命题：**「两个进程都跑完之后，`reconciliation-record.json` 是赢家那份」**，
  **且它必须在两种交错下各断言一次**（输家先取锁 / 赢家先取锁）。
  **正是「在两种交错下都成立」这件事，把它从『夹具强加的顺序』变成『系统性质』。**

*** **⇒ 由此得出一条对新判据的硬性形状要求，我把它写在这里而不是留给实施者猜：
新判据必须是两条（或一条参数化的）交错断言。只写单序的那一条，就仍然是同一条 damaged trajectory 换了个名字 ——
那时 2026-08-02 的裁定原封不动地适用于新判据，我们只是重犯了它。** ***

**(3) 限定条件（不能省，省了新判据就钉出一条假命题）：**
上面的命题只在**没有成功 resume 介入**时成立。依据是今天的代码，F8 那段注释逐字：

> (b) goes false at the SAME epoch after any successful resume, with no race and no crash … `writeBoundaryArtifacts`
> replaces the winner's already-published `eligibleForContinuation` record with the resumed process's downgrade.
> That divergence is **INTENDED**, per the human ruling recorded in
> `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`

**D2 不改它，也不该改它。** 所以新判据的完整命题是：
**「在无成功 resume 介入的前提下，输家的降级记录不会成为 `reconciliation-record.json` 的终态，无论两个进程以何种顺序取到转移锁。」**

**(4) 我必须自己说出来的那一条（brief §2 明令）**：
*** **D2 之后终态仍然依赖一件事 —— 那把锁本身是否可靠。** *** `tryRecoverStaleOwnerTransferLock` 能偷走一把被判为 stale 的锁
（spec §13 第 1 笔具名，交给 L5）。**锁被偷的那条轨迹上，终态重新依赖调度顺序，仍然 damaged。**
所以精确的说法是：**D2 把「终态依赖调度顺序」收敛到「锁被偷」这一个前提上，而不是消灭它。**
**如果人裁认为这不算「关闭」，那么按 §1 的结论：第 4 笔在不动锁协议的前提下做不到无条件的顺序无关，
这是一个诚实的「做不了」，不是一个可以用措辞糊过去的「做到了」。**

### 5.2 问题二：这次改动推翻了 2026-08-02 那次 Human ruling 的哪一部分？

那次人裁的落点是 `tests/controller/runLoop.integration.test.ts` 中该具名测试上方的注释块，
自陈为 `Human ruling; the plan carries the matching in-place amendment note (Amended 2026-08-02 (d), §Task A9)`。
**逐句分列，不静默覆盖任何一句。**

#### 被**推翻**的句子（逐字引，D2 落地后为假）

1. > It does NOT pin "the winner was not overwritten". It cannot: the check returns false here (owner-record.json is
   > still the old epoch — P1's rename #2 has not happened), so the loser **does** go on to write its downgraded record,
   > which is exactly the shape of the residual TOCTOU this layer leaves open (§13, 4th entry).

   **推翻的是「the loser does go on to write its downgraded record」这半句在该窗口内的事实性**：
   D2 之下输家在该窗口内**根本进不去** —— 锁被 P1 持有，输家落到 abandon 臂。
   **括号里那句「the check returns false here」也随之不再描述该窗口**：那次检查在窗口内不再被求值。

2. > The stronger property is not pinnable at this layer.

   **推翻。** D2 使它可钉，但**只以 §5.1(2) 那条改写后的命题、并且必须两序断言**。

3. > in production the loser's write may perfectly well land after rename #3.

   **推翻（有限定）**：在 D2 且锁未被偷的前提下为假。**锁被偷时仍为真** —— 见 §5.1(4)。

4. > Everything asserted below is scoped to the loser's window.

   **推翻**：新判据要断言两个进程都跑完之后的终态，那**超出**输家的窗口。

#### 被**保留**的句子（逐字引，D2 落地后仍然为真，一个字不改）

1. > "P1's third rename puts the winner's record back" is an ordering this harness imposes, not a property of the system

   *** **原样保留，而且这是本设计最要紧的一条继承。** *** D2 没有把这个顺序变成系统性质。
   **新判据不许断言这一条。** 若哪天有人把新判据写成「rename#3 把它盖回去了」，那就是 2026-08-02 判死的那条 damaged trajectory 复活。

2. > Asserting it as correct behaviour would write a damaged trajectory into the suite.

   **原样保留** —— 其中的 "it" 指的正是上面那条顺序。**保留的是这条禁令本身**；新判据断的是另一条命题，不落在这条禁令之内。

3. > ⚠️ What assertion (a) pins, stated honestly: it pins the loser's successful PROTECTIVE READ of owner-transfer.json
   > — i.e. the PRECONDITION for the published-winner check, not the check itself. … **Do not read assertion (a) as more than it is.**

   **整段保留、且仍然正确**：D2 不改变 (a) 曾经钉的是什么。
   变的是 **(a) 在 D2 下会变红**（输家不再读），所以 (a) 会被**替换**，不是被重新解释。
   **这个区别很重要**：我们不是在说「(a) 其实一直钉着更强的东西」，那才是静默覆盖。

4. > ⚠️ Mutation 2 … also fails a handful of pre-existing tests elsewhere in the suite that have nothing to do with this
   > one — the list is in task-A9-report.md. **That list is NOISE, not this test's guardrail**

   **原样保留。** 这条对 D2 的评审同样适用（见 §4.2 的第二个 ⚠️）。

5. 关于测试改名的整段理由（「A name is what appears in failure output…」）**原样保留**：
   新判据换名字时必须沿用同一条口径 —— **名字只许说被断言的东西**。

#### 一条我必须点名、否则就是静默覆盖的

**这次改动不只是改一条判据，它还改一份 spec 的立场。** spec §13 第 4 笔逐字写着这条残余
「**这是先于本层的缺陷**」「修法需要给输家那次写加锁（**§4.3 已否决的方案 (c)**）或引入文件系统级 CAS / 写后复核重试，
两者都超出本层最小解」。
*** **D2 就是那个「已否决的方案 (c)」。我把它的否决原文找出来逐字引，不靠转述：** ***

> **(c) 让输家的 reconciliation 写也进 `acquireOwnerTransferLock`。** 否决：`writeBoundaryArtifacts` 被非转移路径也调用，
> 给它加锁会让一条从不失败的路径新增一类 `OwnerTransferLockBusyError` 失败，爆炸半径远大于改一个常量数组的顺序，
> 且要动锁协议的适用范围。**不排除它是更彻底的解**，但本层不做——按 Rule 2 取最小解。

**逐条对这段否决作答（这是 D2 必须过的关，不许绕）：**

- 「**不排除它是更彻底的解**」—— 这半句本身就说明**那次否决不是正确性否定，是范围否定**。第 4 笔的存在就是为了做那件超出上一层范围的事。
- 「给它加锁会让一条**从不失败的路径**新增一类 `OwnerTransferLockBusyError` 失败」——
  **这条代价在 D2 下真实存在，我不否认，它就是 §8 第 1 点要人裁的那条。**
  但要精确它的范围：`writeBoundaryArtifacts` 的**非转移路径**（`reconciliationRecord === undefined`）在 D2 下**完全不进锁段**
  （锁只包 reconciliation 那一支），所以「一条从不失败的路径」中真正被波及的只有
  「stale_candidate ＋ 降级记录 ＋ **此刻恰有并发转移**」这一小片（§4.2 的机制级证明）。
- 「**且要动锁协议的适用范围**」—— **这条我承认，且它就是 §8 第 2 点（待裁点 B）**。D2 不改锁协议的一个字节，
  但它给 `tryRecoverStaleOwnerTransferLock` 新增一个调用者，**这是「适用范围」的实质扩大**。

**⇒ 结论：D2 推翻的是 spec §4.3 对方案 (c) 的否决，而那次否决的两条理由今天一条失效（Rule 2 的范围理由）、
一条仍然成立且被我原样转成人裁点（锁协议适用范围）。这是一次对既有论证的公开推翻，不是静默覆盖。**

## 6. 推荐与落选项代价

**推荐：D2（锁段包住输家的「读→判定→写」），条件是 §8 的四点人裁全部放行。**
一句理由：**它是四个里唯一一个既让终态在两种调度序下都正确、又不触发 2026-08-02 点名的那个代价的方案。**

**落选项的代价必须看得见，逐条写全（brief §3 第 3 条）：**

| 方案 | 落选的代价（选它会失去什么 / 付出什么） |
|---|---|
| **D1** | **付出**：绝大多数会写 `reconciliation-record.json` 的 run 从此不再写它 —— 删掉一条正常路径上的产物（2026-08-02 原文，今天仍然成立，§4.1 有今天代码的证明）。**并且需要一次新的人裁**，点名到 `fileStore > still writes the reconciliation record when owner-transfer.json is simply absent`。**得到**：确实关闭，而且不碰锁协议、不碰待裁点 B。**如果人裁认为「碰 B」是红线，D1 是唯一还能真正关闭的方案 —— 代价就是那条产物。这个取舍必须由人做。** |
| **D3** | **失去**：终态仍依赖调度顺序，**因此不解锁那条判据的修改**（改了反而钉进一条它保证不了的命题）。**得到**：窗口更窄、改动最小、零人裁风险（除「新增拒绝」一条）。**它是 D2 被否时的退路，交付形态是「再收窄一点 + 残余仍具名传 L5」。** |
| **D4** | **失去**：终态仍依赖调度顺序（「读早写晚」那一半原样留着）。**付出**：判定谓词整套重写，且会连带取消 F8 那条人裁明令保留的 resume 行为，需要一条与第 4 笔无关的额外人裁。**得到**：形状 B 的跨文件不一致被根除，判定输入从三个文件收到一个，代码显著变简单。**它与 D2 正交，我不推荐在第 4 笔里叠加。** |
| **不修（保持现状）** | **付出**：第 4 笔原样留在 §13 交给 L5，包 2 少关一条今天可达的数据丢失路径。**得到**：零风险、零人裁。**brief §3 第 5 条明确承认这是合格交付；如果 §8 的第 2 点（待裁点 B）被判为红线且人不接受 D1 的代价，这就是唯一剩下的选项。** |

**我不替人选。上面四行里没有一行是「显然对的」，取舍点在 §8。**

## 7. 预算与规模估计

**按 brief §5 第 7 条：报不出可重数的计数就不报数字。下面只给「面」和「任务条数」，不给 token 估计、不给行数估计。**

### 7.1 D2 的改动面（可枚举、可核对）

**源文件：1 个。** `src/persistence/fileStore.ts`
（新增一个模块内私有函数；`writeBoundaryArtifacts` 的 reconciliation 分支改为调它；
`readPersistedSuccessfulTransferArtifacts` 的读侧拆解与它那段就地注释同步改写。
**导出面零变化** —— `writeBoundaryArtifacts` 的签名、`ReconciliationWriteDecision` 的形状都不动。）

**测试文件：2 个。** `tests/persistence/fileStore.test.ts`（新增锁忙 → abandon、非 EEXIST errno → abandon、
持锁不重入恢复三类用例）、`tests/controller/runLoop.integration.test.ts`（那条具名判据的替换 ＋ 两序终态判据）。

**文档：2 份，且有硬联动。**
`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（§4.3 方案 (c) 的否决要就地标注被推翻；
§13 第 4 笔改写）与 `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`（A7 陷阱清单里那句「残余具名传 L5」）。
*** **硬联动**：spec §13 自己逐字写着「**清单是 5 条**；加上债 2，L5 的输入合计 **6 项** …… **改清单必须同时改这三处数字**」
（§13 开头、§13 末尾括注、§14 第 1 条）。第 4 笔若被关闭，**这三处数字必须一起改**，
而且 §13 开头有一段就地留痕，警告「本仓库已两次栽在这个形状上」。**不要漏。** ***

### 7.2 任务条数（建议 3 条，顺序不可换）

1. **任务 1 —— D2 的锁段落地。** 只动 `src/persistence/fileStore.ts` ＋ `tests/persistence/fileStore.test.ts`。
   **不碰那条具名判据**（它此时应当变红，**并且必须把这次变红作为任务 1 的证据贴出来** —— 那是 §4.2 那张爆炸半径表里
   唯一一条我标了「必红（未验，推理）」的，任务 1 是它第一次被实测的机会）。
   **验收的核心不是全绿，而是「变红的恰好是预测的那一条」。**
2. **任务 2 —— 判据替换。** 只动 `tests/controller/runLoop.integration.test.ts`：
   替换那条具名判据、按 §5.1(2) 写**两序**终态断言、按 §5.2 就地重写注释块（逐字标明推翻哪句、保留哪句）。
   **⚠️ 人裁 13 授权的是「改那一条判据」，两序意味着至少多一条 `it`。「新增判据算不算在授权内」是 §8 第 4 点。**
3. **任务 3 —— 文档同步 ＋ §13 三处数字联动。** 见 7.1。

### 7.3 我对这次工作的风险排序（给控制器排期用）

1. **最高**：任务 2 —— 判据一旦写成单序，就等于重犯 2026-08-02 判死的那条 damaged trajectory，**而且这次是我们自己写进去的**。
2. **次高**：任务 1 的锁忙策略 —— 若漏掉「非 EEXIST errno 也要映射到 abandon」，会把一次保护性放弃升级成 attempt failed（§4.2 配套第 1 条）。
3. **中**：任务 3 的三处数字联动，spec 自己警告过两次。

## 8. 必须由人裁的点

**六点。前四点是 D2 的前置条件（任何一点被否，D2 即不成立），后两点是备选方案各自的前置条件。**

1. *** **D2 新增一类拒绝：锁不可得时放弃 reconciliation 写。** ***
   受影响的范围已在 §4.2 量化到「stale_candidate ＋ 降级记录 ＋ 此刻恰有并发转移」。
   **要裁的具体问题**：锁忙时选 **(i) 直接 abandon**（复用现成的 `reconciliation_write_abandoned` ＋ sweep stderr 回调通道）
   还是 **(ii) 有界重试后再 abandon**（抄 `persistOwnerTransfer` 的 `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS`）。
   **我的倾向是 (i)** —— 「锁忙」恰好就是这条 TOCTOU 唯一危险的那个窗口，重试只是把等待搬进保护路径；
   **但这是一个新增拒绝，按本仓库口径不许我自己定。**

2. *** **D2 会新增一个 `tryRecoverStaleOwnerTransferLock` 的调用者 —— 那是待裁点 B，brief §4 明令不碰。** ***
   D2 **不改 B 的一个字节**，但 `acquireOwnerTransferLock` 在 EEXIST 时必然调用它，
   所以一条保护性写路径从此可以**偷走别人的锁并删除锁文件**。
   spec §4.3 对方案 (c) 的否决原文里也点了这一条：「**且要动锁协议的适用范围**」。
   **要裁的具体问题**：「不改 B 的代码但扩大 B 的执行面」算不算「碰 B」。
   *** **这一点被判为红线 ⇒ D2 直接出局，剩下的选择是 §6 表里的 D1 / D3 / 不修。** ***

3. *** **顺序无关性是有条件的 —— 条件是那把锁不被偷。** ***
   **要裁的具体问题**：把残余从「本层的读与写不互斥」降级成「锁协议自身的健全性（§13 第 1 笔，L5）」，
   算不算「第 4 笔已关闭」。
   **我不替人裁，也不用措辞把它糊成「关闭」。** 若人裁认为不算，§1 的诚实结论生效：
   **在不动锁协议、不接受 D1 代价的前提下，第 4 笔做不到无条件的顺序无关。**

4. *** **新判据的形状：必须是两序断言，且必须带「无成功 resume 介入」的限定。** ***
   人裁 13 授权的是「改**那一条**具名判据」。**两序意味着至少多写一条 `it`。**
   **要裁的具体问题**：授权是否覆盖「新增判据」，还是需要再扩权一次。
   **⚠️ 这一点不能省略成实施细节** —— 单序断言就是 2026-08-02 判死的那条 damaged trajectory 换个名字（§5.1(2)）。

5. **若改选 D1**：它会弄红 `fileStore > still writes the reconciliation record when owner-transfer.json is simply absent`。
   *** **那不是人裁 13 授权的那一条判据，需要一次新的、点名到它的扩权。** ***

6. **若改选 D4（或 D2+D4 叠加）**：它会取消 F8 那条人裁明令保留的行为
   （「resume 之后允许用 resume 进程的降级替换赢家已发布的记录…… That divergence is **INTENDED**, per the human ruling」）。
   *** **那是一条与第 4 笔无关的独立人裁，必须单独推翻，不许搭第 4 笔的车。** ***

### 8.1 我判定**不需要**人裁、可以由实施者直接做的（列出来接受反驳）

- 把 `readOwnerRecord` 换成 `readOwnerRecordRaw` ＋ `recoverInterruptedOwnerTransfer(runDir,{lockHeld:true})`
  —— 这是 `writeOwnerTransferArtifacts` 与 `claimOwnerRecordWithPrecondition` 已有的判例，属 Rule 11 的 conformance。
- 把 `acquireOwnerTransferLock` 的非 EEXIST 抛出映射到 abandon —— 这是今天 abandon 臂就地注释里
  三条约束的第 1 条**已经要求**的东西，不是新决定。
- 同步改写 `readPersistedSuccessfulTransferArtifacts` 里那段已经不再描述事实的注释 —— 事实变了。

## 9. 验证记录（搜索面声明、探针、临时变异与还原证明）

**全部验证性命令走 `rtk proxy`；检索脚本先落盘再 `rtk proxy zsh <script>` 跑；全文 tee 落盘，不 grep、不 tail 过滤。**

### 9.1 爆炸半径的搜索面与探针

脚本：`<scratchpad>/probe1.sh`，日志：`<scratchpad>/probe1.log`（128 行，未过滤）。

| 探针 | 期望 | 实测 |
|---|---|---|
| **必命中** `grep -rnF 'writeBoundaryArtifacts' tests/` | 有命中 | **命中**，`runLoop.integration.test.ts` / `resumeLoop.integration.test.ts` / `leaseLifecycle.integration.test.ts` / `fileStore.test.ts` 共数十行 |
| **必不命中** `grep -rnF 'zzz_no_such_symbol_zzz' tests/` | 零命中、exit 1 | **零命中，`exit=1`** |
| 定位 `still writes the reconciliation record when owner-transfer.json is simply absent` | 命中 1 处 | `tests/persistence/fileStore.test.ts:2308` |
| 定位 abandon 三条 ＋ sweep 两条 | 命中 | `fileStore.test.ts:2363 / :2433 / :2524`；`sweepRuns.test.ts:570 / :609 / :610 / :656` |
| 定位那条具名判据的注释块 | 命中 | `runLoop.integration.test.ts:2320`–`:2389`（`Human ruling` 在 `:2387`–`:2388`，测试名在 `:2389`） |

*** **声明：以上是搜索面，不是完备性证明。** *** 它只覆盖「符号名直接出现在测试文本里」的位置。
**经 `runLoopFromState` / `resumeLoop` / `sweepRuns` 间接到达 `writeBoundaryArtifacts` 的测试没有被枚举**，
所以 §4 每张爆炸半径表都是**下界**。**我不下任何形如「除此之外没有别的测试会受影响」的全称否定。**

### 9.2 临时变异与还原证明

脚本：`<scratchpad>/restore.sh`，日志：`<scratchpad>/restore.log`（未过滤）。
**⚠️ 全部用 `rtk proxy git diff`** —— brief §5 第 2 条：裸 `git diff` 经本仓库 hook 会吞掉原始输出、空 diff 也打一个字节。

| 步骤 | 期望 | 实测原始输出 |
|---|---|---|
| **R1** `git diff`（tracked，原始） | 空 | `R1-exit=0  R1-bytes=0` |
| **R2** `git diff --stat` | 空 | `R2-bytes=0` |
| **R3** `git status --porcelain` | 只有 untracked | `?? …/rereview-s4.diff`、`?? …/review-s4.diff`（**两条本任务开始前就存在**）、`?? …/task-4th-design.md`（**本文件**）。**tracked 文件零改动。** |
| **R4 sanity 探针（必命中）** 故意往 `src/persistence/fileStore.ts` 追加一行标记后再看 diff | **必须非空**，否则 R1 的「空」什么也证明不了 | `src/persistence/fileStore.ts | 2 ++` / `1 file changed, 2 insertions(+)` / `R4-bytes=325` —— **探针有效** |
| **R5** 还原后再看 diff | 空 | `R5-bytes=0` |
| **R6 变异标记（必不命中）** `grep -rn 'CCLOOP_SANITY_PROBE_MARKER' src tests` | 零命中 | `R6-exit=1` |
| **R7 同一 grep 的必命中对照** `grep -rn 'writeBoundaryArtifacts' src/persistence/fileStore.ts` | 有命中 | `:148 :159 :277`，`R7-exit=0` —— **R6 的零命中不是坏探针造成的** |

*** **结论：临时变异 1 次（sanity 探针本身），已证明还原 —— 空 diff ＋ 变异标记零命中 ＋ 两条 sanity 探针都按预期命中。** ***

### 9.3 本次没有跑的东西（说清楚，不假装跑过）

- **没有跑测试套件**（`ECC_GATEGUARD=off DISABLE_OMC=1` 那条纪律因此没有用武之地）。
  理由：我是只读设计员，不实施；跑套件只能确认今天是绿的，**不能验证任何一个候选方案落地后的行为**，
  而验证那个需要真的实施 D2 —— 那超出 brief §4 第 1 条的边界。
- **因此 brief §5 允许的两条 flake（(B) evidence.test.ts 的 5000ms 超时、(F) recovery window 那条）
  与那条已挂账的 `plan.json` ENOENT，本次都没有出现的机会。** 我没有把它们当成「已确认无害」，也没有重新调查。
- **§4 各表里标「未验（推理）」的每一格都还是未验。** 任务 1 的第一件事就是把它们变成实测。
