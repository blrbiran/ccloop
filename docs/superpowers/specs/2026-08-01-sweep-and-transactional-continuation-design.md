# L3 — Sweep（触发层）与转移事务的跨文件原子性

Status: drafted 2026-08-01。**经两轮独立评审对着代码撞过之后两次大幅修订**：第一轮三个独立评审员撞出 16 条 Critical（索引见 §16），**第二轮另派三个错开视角的评审员对着第一轮的修复波撞出 47 条**（索引见 §17，其中 4 条推翻或更正了第一轮修复本身）。本文是父设计 `2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17 item 2 的**后半**（触发），前半（发现）由 L2 `2026-07-28-run-registry-design.md` 完成。

> **本文不写死行号。** 所有代码锚点用「文件名 + 符号名」，并在旁边附一条能重推它的 `grep`。
> **每一个算出来的数字旁边必须就地附重推命令。** 初稿有 13 处数字没附命令，其中 **2 处是错的**；而每一处附了命令的数字都是对的。这条规矩在本文档自己身上又验证了一次。

## 1. 目的

让一个**已经具备续跑资格**的 run 在无人值守条件下被真正续跑，并在此过程中消除两笔被裁决归属本层的债：

- **债 1 — 跨文件事务性**：`owner-transfer.json` 已原子发布、而 `reconciliation-record.json` 要等一个**会抛的** `assertHeld()` 之后才写。第三方在此窗口 supersede，就留下「eligible 但无 reconciliation」的磁盘状态，`resumeLoop` 随即拒绝。这是 **liveness 洞**，不是安全洞。
- **债 3 — `heartbeat.stop()` 释放窗口**：`stop()` 只 await 了它读到的那一个 `queue` 快照，而 `runExclusive` 会重新赋值 `queue`。

裁决记录：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`。债 2 留给 L5，本层不碰。

## 2. 范围与非目标

**做：**

1. 新增 `ccloop sweep <root>`：扫一次 registry → 对每个观测为 eligible 的 run 顺序调 `resumeLoop` → 退出。
2. 债 1：`reconciliation-record.json` 加入**已有的**转移事务，成为第三个参与文件。
3. 债 3：收紧 `runExclusive` 语义 + 增加一个停机信号槽。

**不做（每条都是刻意的）：**

1. **不发起 transfer。** sweep 永不创建所有权决策，只消费已发布的。全仓库唯一能发布 transfer 的生产路径是 `persistBoundaryAnalysis` → `persistOwnerTransfer` → `writeOwnerTransferArtifacts`；`writeOwnerTransferArtifacts` 只有 `persistOwnerTransfer` 一个生产调用者，而 `persistBoundaryAnalysis` 的**两个**调用点都在 `runLoopFromState` 内部——**transfer 只由活着的控制器发布**。被硬杀的进程不会留下 eligible transfer，那类 run 本层碰不到（属 L5）。

   ```bash
   grep -rnF -e 'writeOwnerTransferArtifacts(' -e 'persistOwnerTransfer(' -e 'persistBoundaryAnalysis(' src/
   ```

2. **不常驻、不轮询、不并发。** 顺序执行，跑完退出。
3. **不做 orphan / cleanup / GC。** 父设计 §17 item 3，属 L5。
4. **不合成 reconciliation，也不放松 `resumeLoop` 对它的必需性。** 裁决记录明令禁止——那是引入新授权。见 §4.0 的 S-3。
5. **不修债 2**（`persistTerminalState` 往已不拥有的 run 写）。

## 3. 授权立场（措辞已按评审收窄）

**L3 不引入任何新授权。** 但初稿把这一点说成「本层不改任何写路径」，那是**假的**——§4 改的正是转移写路径，§5.4 还新增一个写触发点。正确的、可检验的表述分三条：

1. **sweep 自身不新增任何 writer。** `sweepRuns.ts` 只调 `scanRuns` 与 `resumeLoop`，自己不 open/write 任何 run 目录下的文件。
2. **但 sweep 会*导致*写入，这是预期行为，必须承认。** `resumeLoop` 在**任何门之前**就 `appendEvent(runDir, { type: "resume_requested" })`，四条拒绝路径各再追加一条 `resume_denied`。所以一个「观测 eligible 但门拒绝」的 run 目录**确实会变**。

   ```bash
   grep -nF -e 'type: "resume_requested"' -e 'type: "resume_denied"' src/controller/resumeLoop.ts   # 1 + 4 处
   ```

   **⚠️ 上面那条 grep 只扫 `resumeLoop.ts`，据它下「恰好两行」的绝对断言是错的**（第二轮评审撞出，本仓库最近三轮反复吃亏的同一个错法）。`resumeLoop` 调用的 `checkRunLease` 自己也写事件：租约存在但已过期时它**先追加 `lease_expired_observed` 再放行**，控制继续往后面的门走。

   ```bash
   grep -n 'appendEvent\|lease_expired_observed' src/controller/leaseGate.ts
   # 实测：:2 import、:58-59 追加 lease_expired_observed，随后 :63 return { kind: "expired" }
   grep -rn 'appendEvent' src/controller/leaseGate.ts src/controller/resumeLoop.ts
   # 实测：leaseGate 1 个追加点、resumeLoop 5 个追加点（1 requested + 4 denied，另有 resume_adopted 在放行后）
   ```

   **sweep 会导致的写入，完整清单**（每一条都对着代码核过）：

   1. `resume_requested`（无条件，第一条语句）。
   2. `lease_expired_observed`（**仅当** `owner-record.json` 的 `leaseAffirmedAt` 非 `null` 且已过 TTL；`leaseAffirmedAt === null` 走 `no_lease` 分支，不写事件）。
   3. `resume_denied`（四条拒绝路径各一条）或 `resume_adopted`（放行）。
   4. **CAS 拒绝路径上的文件系统副作用**：`claimOwnerRecordWithPrecondition` → `acquireOwnerTransferLock`（建后删 `.owner-transfer.lock`）→ `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })` → 无 marker 时 `cleanupOwnerTransferStagingWithoutMarker` **删掉若干 staging 文件**；有 marker 时直接 finalize 整个待决事务。

      ```bash
      grep -nF -A12 'export async function claimOwnerRecordWithPrecondition(' src/persistence/fileStore.ts
      grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
      ```

   5. `readOwnerRecord` 本身（`resumeLoop` 的 `Promise.all` 第一项）**也**跑 `recoverInterruptedOwnerTransfer`，且它走的是 `lockHeld` 未传的分支——见 §10 测试 14 与 §15 验收 6 对断言范围的收窄。

   初稿的「不往任何 run 目录写一个字节」按字面为假，且它对应的测试（旧测试 14）只测了**不** eligible 的目录——那种目录 sweep 根本不碰，所以那条测试**证明的是过滤器有效，不是零写入**。已按 L2 `tests/registry/zeroWrite.test.ts` 的承重形状重写，见 §10 测试 14。
3. **L3 改动的两条写路径都只增加拒绝或记录属主有权做的终态**，不新增许可：
   - `evaluateResumeEligibility` 的**八条**判据一条不动。

     ```bash
     grep -c 'return { ok: false' src/controller/resumeLoop.ts    # 期望 8
     ```
   - §4 让原本可能丢失的 reconciliation 进入事务，只减少「合法转移无法续跑」，不放宽任何准入。
   - §5.3 让 `runExclusive` 在 `stopped` 后**拒绝**，纯增加拒绝。
   - §5.4 的停机信号**不写终态**（见 §5.4），只追加事件。

registry 观测到的 `eligibleForContinuation` 仍然**不是决策**（L2 spec §6、§7.3）。sweep 拿它当「值得一试」的过滤器，最终裁决权完全在 `resumeLoop` 的门。门拒绝是系统按设计工作，不是错误。

## 4. 债 1 — reconciliation 加入转移事务

> **本节是独立的一节、独立的任务组、独立的评审，并且必须完成并通过独立评审之后，§6 的任务组才可开始。**
>
> **这个要求是裁决记录*两处*合起来的结果，不是任何一处的原文**（初稿写成「裁决记录原文是『独立一节、独立任务组、独立评审，先于触发逻辑』」——那句话在裁决记录里不存在，是本 spec 把两处拼接后冠以「原文」，而本文档自己把「引全句、不得拼接冠以原文」立为铁律）。两处分别是：
>
> - 「结论速查」表格债 1 行的括注：**「**L3**（spec 内独立一节，先于触发逻辑）」** —— 给出「先于触发逻辑」，但只说「独立一节」，不含「独立任务组、独立评审」。
> - 「执行约束（人下的指令）」节：**「债 1 在 L3 spec 里必须是独立的一节、独立的任务组、独立的评审，不得与触发逻辑混在同一批任务里。」** —— 给出三个「独立」，但不含「先于」二字（它说的是「不得混在同一批任务里」，那是并列关系，不是先后关系）。
>
> 另有一处「执行顺序」第 2 条写「其中债 1 作为独立一节先于触发逻辑落地」，同时含「独立一节」与「先于」，但不含「独立任务组、独立评审」。**三处都不含另外那一半，所以「原文」只能是拼接。**
>
> ```bash
> grep -nF -e '先于触发逻辑' -e '独立的一节、独立的任务组、独立的评审' \
>          docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
> # 实测 exit 0，命中 4 行：结论速查表格行、执行顺序第 2 条、执行约束节
> ```
>
> 理由（本层自己给的，不冒充裁决记录）：sweep 先落地就等于把触发层挂到一条已知损坏的续跑路径上。

### 4.0 S-3 退路与被禁止的退路（初稿完全遗漏，本节补回）

#### 4.0.1 裁决记录的原文部分

裁决记录「若修法方向不可行时的退路（S-3）」一节，**引全句**：

> 若 L3 的 brainstorming 判定「reconciliation 加入 owner-transfer 事务」不可行，**L3 不得就地发明替代方案**，而应回到本记录重新裁决债 1 的归属与形式。理由：本记录把债 1 判给 L3 的依据是「它是 L3 的功能前提」，不是「这条修法可行」——前者不因后者失败而改变，但**处理形式**（L3 内一节 / 独立分支 / 单开一层）必须重新定。

同节的**被明确禁止的退路**，同样引全句：

> **明确禁止的退路**：放松 `resumeLoop` 对 reconciliation 的必需性（例如「若存在则校验，不存在则跳过」）。那是**引入新授权**，违反 L1/L1b/L2 三层共同的「只增加拒绝，绝不新增许可」边界。缺失即拒绝的 fail-closed 行为必须保留。

```bash
grep -nF -e '若修法方向不可行时的退路（S-3）' -e '明确禁止的退路' \
         docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
```

**以上是裁决记录给的全部。裁决记录没有给触发条件。** 下一小节的触发条件是**本层就地发明的**，不是原文，读者不得把它当成裁决记录的要求。

#### 4.0.2 触发条件（本层就地定义，**非裁决记录原文**）

若实现中发现事务化需要在恢复路径上新增一类**静默**失败模式、或需要改动 `finalizePendingOwnerTransfer` 的 catch **语义**（而不只是对称地多一个 `safeUnlink`，见 §13），**停下，回到裁决记录，不要发明变体。**

这条触发条件是本层的安全阀。**它在第二轮评审中被真实命中过一次，且已被解除；下面记录全过程，不得因为「已经解除」而把它删掉或弱化。**

#### 4.0.3 S-3 命中一次的记录与解除方式（人已裁定）

**命中过程**：§4.4 把 marker 从「写下但从不读取」改判为**被解析**的承重字段。评审随即撞出：marker 今天用 `writeJsonFile`（裸 `writeFile`，非原子）写。

```bash
grep -nF 'await writeJsonFile(paths.transactionMarkerPath, marker);' src/persistence/fileStore.ts
grep -nF -e 'async function writeJsonFile(' -e 'async function writeJsonFileAtomically(' src/persistence/fileStore.ts
# 实测：marker 走的是 writeJsonFile（裸 writeFile），writeJsonFileAtomically 是另一个函数
```

掉电 / ENOSPC 可留下截断的 marker。marker 一旦被解析，截断的 marker 就让该 run 的 `readOwnerRecord` 永久抛——而 `recoverInterruptedOwnerTransfer` 是 `readOwnerRecord` 的第一条语句，`readOwnerRecord` 又是 `resumeLoop` 的 `Promise.all`、`writeOwnerTransferArtifacts`、`claimOwnerRecordWithPrecondition`、`updateOwnerRecordWithPrecondition` 的必经之路。**这正好是「恢复路径新增一类失败模式」，且 §2 把 cleanup/GC 排给了 L5，本层无恢复入口 —— 触发条件成立。**

**解除方式（人下的裁定，走最小解）**：**把 marker 改成原子写（temp + rename，与既有的 `writeOwnerRecordAtomically` 同法）**。

```bash
grep -nF -A5 'async function writeOwnerRecordAtomically(' src/persistence/fileStore.ts
# 实测：safeUnlink(temp) → writeJsonFile(temp) → rename(temp, target)，即本层要照抄的形状
```

原子写之后，「marker 存在但不可解析」被**压回不可达**（读者只能看到 rename 前的「无 marker」或 rename 后的「完整 marker」），**所以那类新失败模式不存在，S-3 不触发**，§4.4 的 marker 驱动方案原样保留。§4.4 规则 3 的 fail-closed 分支**仍然保留**，作为纵深防御而非可达路径。

**这次命中留下的教训**：S-3 的触发条件是有效的——它在一份已经过一轮修复的 spec 上仍然抓到了东西。**不要因为它这次是被「最小解」解除的，就以为它下次也会。**

#### 4.0.4 对裁决记录「更窄」判断的回应（第二轮更正：初稿伪造了论证结构）

**第一轮修订在这里写错了**，且错法是本仓库最忌讳的一种：它写「裁决记录的『这条路比裁决时判断的更窄』有**两条**依据：(a) `newOwnerEpoch` 的排序主张；(b) `assertHeld` 是写者」，然后宣布 §4.1 驳倒了 (a)。**(a) 是本 spec 自己造出来再打倒的——裁决记录从未把它列为「更窄」的依据。** §16 第 11 行还把这个伪结构固化进了修订索引，会被 L5 继承。

对着裁决记录原文重读，**那两段是两件事**：

```bash
grep -nF -e '否决的方向' -e '评审补充的判断' \
         docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
# 实测 exit 0，命中两行，分属「修法方向可行性」一节的两段
```

- **「否决的方向」段（引全句）**：「『先写 reconciliation，再发布 owner-transfer』做不到——reconciliation 的 `newOwnerEpoch` 要等 `persistOwnerTransfer` 返回才知道（`runLoop.ts` 的 `nextOwnerEpoch = transfer.ownerRecord.currentOwnerEpoch;`）。」
  这是一条**独立的否决**，否决的对象是「先写 reconciliation 再发布 transfer」这条路。**本 spec 根本没走这条路**（§4.3 走的是把三个文件放进同一次事务）。§4.1 驳倒的是**这一条**——它与「更窄」无关。
- **「评审补充的判断」段（引全句）**：「上面『真实缺陷』一节查实 `assertHeld` 本身就是写者（追加事件），这削弱了问题 1 里『不得扩大读会写』那条反对意见的分量——写路径早已不纯。但同时它也说明这条修法要动的东西比初稿设想的多。**「加入事务」这条路比裁决时判断的更窄，L3 不应假定它一定成立。**」
  **「更窄」这个结论只有这一条依据：`assertHeld` 本身就是写者，说明要动的东西比初稿设想的多。**

**因此正确的结论是**：

1. 裁决记录对「更窄」只给了**一条**依据，**这条成立**。本轮评审进一步证实了它——真正要动的东西包含 marker 语义与 marker 的写法、**三处** staging 回收路径的扩容、finalize 的 catch 尾部、以及组装点的 epoch 来源。
2. 另有一条**独立的**否决（「先写 reconciliation 再发布 transfer」做不到，因为 `newOwnerEpoch` 只能事后取到）。§4.1 驳倒的是**那一条**。它与「更窄」无关，**也不改变「更窄」成立**。
3. 「更窄」成立，正是本节必须是独立任务组、独立评审的原因。

### 4.0a 裁决记录留给 L3 的问题 1，正面回答

裁决记录留了两个问题给 L3 spec，并写明「本轮不预设答案」。初稿答了问题 2（签名改动），**问题 1 一次都没点名**。补答如下。

> **问题 1**：`recoverInterruptedOwnerTransfer` 是否也要负责 finalize reconciliation？会扩大「读会写」的范围——而 L2 整层的设计正是围绕规避这一点建立的（禁用 `readOwnerRecord`）。

**答：是，必须由它负责，且这不扩大「读会写」的类别。**

理由三条：

1. **它今天已经是写者。** 第三个文件加入的是**同一次**写，不是新增一类写。

   **数字更正（第二轮评审，2/3 撞到）**：第一轮修订在这里写「已经会做**两次 `rename` 加三次 `safeUnlink`**」，**没附重推命令**——本文档自己立的核心规矩在新写的段落上被自己破了，而且这个数字与同文档 §4.1 的九步枚举直接打架。实测两条路径：

   ```bash
   grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
   grep -nF -A6  'async function cleanupOwnerTransferStagingWithoutMarker(' src/persistence/fileStore.ts
   grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
   ```

   - **marker 在 → `finalizePendingOwnerTransfer`**：try 内成功路径是 **2 `rename` + 5 `safeUnlink`**（先清 2 个 temp，双 rename 之间无 unlink，尾部再清 marker + 2 个 pending）；进 catch 时另有 **2 `safeUnlink`**。与 §4.1 的九步枚举一致。
   - **无 marker 且 `options.lockHeld` 为真 → `cleanupOwnerTransferStagingWithoutMarker`**：**4 `safeUnlink` + 0 `rename`**（2 个 pending + 2 个 temp）。
   - **无 marker 且 `lockHeld` 未传**：零写。

   本层之后这两个数都要涨，见 §4.3 与 §13。
2. **不让它负责就没有原子性可言。** 事务的定义就是「崩溃后由恢复推完」。把 reconciliation 排除在恢复之外，等于宣布它不在事务里。
3. **L2 的零写入保证不受影响，因为 L2 从不调 `readOwnerRecord`。** L2 spec §7.1 的做法是**禁用**这个函数、改用 `readOwnerRecordWithoutRecovery` 与只读观测。本层不改 L2 一行代码（§9），所以 L2 的保证按原样成立。

**但有一个必须记下的语义后果**（评审发现，初稿没有）：`readPersistedSuccessfulTransferArtifacts` 用 `Promise.all` 并行读三个文件，其中 `readOwnerRecord` 会触发恢复。本层之后，那次恢复**会写 `reconciliation-record.json`**，也就是这个「快照」自己的第三个读目标。**它本来就不是快照**，本层只是让这一点变得可观测。真正承载 fail-closed 的不是快照性，是 §4.3 末尾那两条 epoch 相等判定——见那里。

### 4.1 当前形状

```bash
grep -nF -e 'const OWNER_TRANSFER_MARKER_FILE' -e 'type OwnerTransferTransactionMarker' \
         -e 'async function finalizePendingOwnerTransfer' -e 'async function recoverInterruptedOwnerTransfer' \
         -e 'async function cleanupOwnerTransferStagingWithoutMarker' \
         -e 'export async function writeOwnerTransferArtifacts' src/persistence/fileStore.ts
```

事务由 `writeOwnerTransferArtifacts` 驱动：取锁 → 恢复任何遗留事务 → CAS 比对持久化的 owner record → 暂存两个 pending + 一个 marker → `finalizePendingOwnerTransfer` → 释放锁。

**`finalizePendingOwnerTransfer` 不是「两次 rename」**，它是九步：`safeUnlink(transferTemp) → safeUnlink(ownerTemp) → writeJsonFile(transferTemp) → rename → writeJsonFile(ownerTemp) → rename → safeUnlink(marker) → safeUnlink(transferPending) → safeUnlink(ownerPending)`，外加一个只清**两个** temp 并重抛的 catch。初稿把它简化成「两次/三次 rename」，因此 §4.3 的中间态枚举不穷尽——已修正。

**两个必须先说清的事实：**

1. **marker 的 `finalizeOrder` 字段被写下、却从未被读取。** `finalizePendingOwnerTransfer` 按硬编码顺序直接读两个 pending。这是一个无人核对的主张。**本设计把它变成承重字段**（§4.4）。
2. **`newOwnerEpoch` 在事务开启前就已知。** `applyOwnerEpochTransfer` 是纯同步函数，`nextEpoch = ownerRecord.currentOwnerEpoch + 1` 是它的第一条语句，`persistOwnerTransfer` 在任何 I/O 之前就调用它。

   ```bash
   grep -nF -A8 'export function applyOwnerEpochTransfer(' src/ownership/ownerController.ts
   grep -nF -e 'const transfer = applyOwnerEpochTransfer(' -e 'await writeOwnerTransferArtifacts(' src/controller/runLoop.ts
   ```

   裁决记录的「`newOwnerEpoch` 要等 `persistOwnerTransfer` 返回才知道」只对 `persistBoundaryAnalysis` 的**解构视角**成立，不是排序上的硬约束。

   **⚠️ 这条事实只用来驳倒裁决记录那条独立否决（§4.0.4），不构成「本 spec 可以自己再算一遍 `+ 1`」的许可。** 增量规则的唯一权威实现是 `applyOwnerEpochTransfer`；本层不得复制它，见 §4.3「组装点改判」。

### 4.2 reconciliation 的九个字段：八个在事务前已知，`newOwnerEpoch` 由事务内部填

（**标题已按第二轮评审更正**：初稿写「九个字段在事务前全部已知」。技术上 `newOwnerEpoch` 的**值**确实事务前可推（§4.1 事实 2），但**不得由第二处代码去推**——见 §4.3「组装点改判」。「已知」与「该由谁算」是两件事，初稿把它们混成了一件。）

| 字段 | 来源 | 计算位置 |
|---|---|---|
| `staleSuspicionBasis` | `boundaryEvidence.continuitySuspicion` 或 `boundaryAnalysis.staleCandidateReason` | `runExclusive` **之前** |
| `staleConfirmed` | 字面量 `true` | — |
| `ownershipVerdict` | `ownership.verdict`；transfer 分支内已知为 `OWNER_LOST` | `runExclusive` 内 |
| `lastTrustedBoundary` | `ownership.lastTrustedBoundary` | `runExclusive` 内 |
| `conflictingEvidence` | `boundaryEvidence.conflictingEvidence` | `runExclusive` **之前** |
| `takeoverPermission` | **`{ allowed: ownership.takeoverAllowed, reason: buildTakeoverReason(ownership.takeoverAllowed) }`** —— 是一个对象，不是布尔；`buildTakeoverReason` 必须一起调 | `runExclusive` 内 |
| `priorOwnerEpoch` | `ownerRecord.currentOwnerEpoch` | `runExclusive` 内 |
| `newOwnerEpoch` | **`transfer.transferRecord.newOwnerEpoch`**，即 `applyOwnerEpochTransfer` 的输出 | **`persistOwnerTransfer` 内、`applyOwnerEpochTransfer` 之后**（改判，见 §4.3「组装点改判」） |
| `eligibleForContinuation` | 成功路径上是类型级 `true`（`persistOwnerTransfer` 的返回类型钉死） | — |

```bash
grep -nF -e 'const boundaryEvidence = buildBoundaryEvidence(' -e 'const evaluateOwnershipFor =' \
         -e 'if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST"' \
         src/controller/runLoop.ts
grep -nF -A20 'reconciliationRecord:' src/controller/runLoop.ts
grep -nF -A10 'export type ReconciliationRecord' src/runtime/types.ts     # 期望印出全部九个字段
```

（**刻意不接 `| head`**：管道会把 `grep` 的退出码换成 `head` 的，而且 `head` 会**提前截断输出**，让「命中几行」这件事不可复核。**纪律的准确范围是「不接会截断输出的管道」**——第二轮评审指出，初稿把它写成「不接任何管道」，而 §9 自己用了 `| wc -l`，两处直接打架。`| wc -l` 同样覆盖退出码，所以本文档的处置是：**凡是要数数的地方一律改用 `grep -c`**，不用 `| wc -l`；§9 已照此改。）

### 4.3 新形状

| 项 | 内容 |
|---|---|
| 新常量 | `.reconciliation.pending.json`、`.reconciliation.publish.tmp`、`.owner-transfer.transaction.tmp`（marker 的原子写 temp，见 §4.0.3） |
| marker | `version: 1` → `2`；`finalizeOrder` 改为 **`[owner-transfer.json, owner-record.json, reconciliation-record.json]`**（改判，见下面「排序改判」）；**并且改为被读取**（§4.4）；**并且改为原子写**（temp + rename，照抄 `writeOwnerRecordAtomically` 的形状） |
| 签名 | `writeOwnerTransferArtifacts` 追加参数 `reconciliationRecord`；`persistOwnerTransfer` 追加参数 `reconciliationDraft` 并**在内部补齐 `newOwnerEpoch`** 后透传（见下面「组装点改判」） |
| **暂存顺序（不变式）** | 三份 pending 全部写完之后才写 marker；**reconciliation pending 严格先于 marker**。marker 的存在即宣告「三份 pending 齐备」。marker 原子写使这条不变式在读者侧真正成立（rename 前不可见） |
| 组装点 | **改判**：草稿在 `persistBoundaryAnalysis` 内组装（它是唯一拿得到 `boundaryEvidence` / `ownership` 的地方），但 `newOwnerEpoch` **留空**，由 `persistOwnerTransfer` 在 `applyOwnerEpochTransfer` 之后、`writeOwnerTransferArtifacts` 之前用 `transfer.transferRecord.newOwnerEpoch` 填入 |
| **赢家路径的 `writeBoundaryArtifacts`** | 改为**不传** `reconciliationRecord`（只写 `boundary-analysis.json`）。不改则赢家会在事务外再写一次，重新打开 §4 要关闭的那条路径 |
| **`cleanupOwnerTransferStagingWithoutMarker`** | 从 4 个 `safeUnlink` 扩到 **7** 个，新增的**三个**路径逐个具名：`.reconciliation.pending.json`、`.reconciliation.publish.tmp`、`.owner-transfer.transaction.tmp`。**这不是「总数两个」——原有四个（`.owner-record.pending.json` / `.owner-transfer.pending.json` / `.owner-record.publish.tmp` / `.owner-transfer.publish.tmp`）一个都不能删** |
| **`finalizePendingOwnerTransfer` 的 try 首与 catch 尾** | 各多一个对称的 `safeUnlink(.reconciliation.publish.tmp)`：try 首从 2 个变 3 个，catch 尾从 2 个变 3 个（见 §13 的窄例外）。**marker temp 不进 finalize 的对称清理**——finalize 不写它 |

```bash
grep -nF -A6 'async function cleanupOwnerTransferStagingWithoutMarker(' src/persistence/fileStore.ts
# 实测现状：4 个 safeUnlink（ownerPending / transferPending / ownerTemp / transferTemp），0 个 rename
```

**⚠️ `cleanupOwnerTransferStagingWithoutMarker` 的可达条件（第二轮评审补，测试 6c 的构造必需）**：它是无 marker 时**唯一**回收 staging 的地方——属实——但它**只在 `options.lockHeld` 为真时被调用**：

```bash
grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
grep -rnF 'recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
# 实测：传 { lockHeld: true } 的三个入口是 writeOwnerTransferArtifacts /
# claimOwnerRecordWithPrecondition / updateOwnerRecordWithPrecondition；
# readOwnerRecord 不传 options，因此走 readOwnerRecord 的调用**不会**触发这个回收
```

**所以「读一次就把孤儿清掉」是假的**：孤儿只在下一次持锁写路径上才被回收。测试 6c 必须经由 `claimOwnerRecordWithPrecondition`（或另两个持锁入口之一）驱动，不能只 `readOwnerRecord`。

**⚠️ 组装点是个陷阱（第一轮评审发现，仍然成立）**：输家路径上 `ownerRecord` 与 `ownership` 在 CAS 失败后**被重新赋值**（`assertHeld()` → 重读 → 重新 evaluate），现有 reconciliation 刻意用的是**失败后重读**的值。**实施者若把组装点上提为唯一一份，会静默把输家记录退回 CAS 前的值。** 事务专用的那份是**第二份拷贝**；`writeBoundaryArtifacts` 那份原地不动。**输家根本不进 `persistOwnerTransfer`，所以下面的组装点改判不影响这条警告。**

#### 组装点改判 —— 不得把 epoch 递增规则复制成第二份（第二轮评审）

第一轮修订要求「在 `persistOwnerTransfer` 调用**之前**组装事务专用拷贝」，并在 §4.2 表里把 `newOwnerEpoch` 的来源写成 `ownerRecord.currentOwnerEpoch + 1`。**那等于把 epoch 递增规则复制成两份生产实现**，而权威那份在别处：

```bash
grep -nF -A8 'export function applyOwnerEpochTransfer(' src/ownership/ownerController.ts
# 实测：const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
grep -nF -e 'const transfer = applyOwnerEpochTransfer(' -e 'nextOwnerEpoch = transfer.ownerRecord.currentOwnerEpoch;' src/controller/runLoop.ts
# 实测：persistOwnerTransfer 内先调 applyOwnerEpochTransfer；现有 reconciliation 的
# newOwnerEpoch 取自 transfer.ownerRecord.currentOwnerEpoch —— 今天就只有一份公式
```

而 §4.3 又把 `reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch` 定为本层之后不得削弱的承重判定之一。**两者相加的后果**：将来任何人改 `applyOwnerEpochTransfer` 的增量规则（例如改成跳号、或改成从持久记录重算），两份公式漂移 → 每一次合法转移之后 `resumeLoop` 都 fail-closed 拒绝 → **债 1 以另一形式复活，而且两侧都是生产代码，没有任何测试会红。**

**采用的形状（一份公式）：**

1. `persistBoundaryAnalysis` 在 transfer 分支内组装一份 **`ReconciliationDraft`**：九个字段里的八个填好，`newOwnerEpoch` 不由它决定。
2. `persistOwnerTransfer` 收下草稿，在它已有的 `const transfer = applyOwnerEpochTransfer(...)` **之后**、`writeOwnerTransferArtifacts(...)` **之前**，用 `transfer.transferRecord.newOwnerEpoch` 填入 `newOwnerEpoch`，得到完整的 `ReconciliationRecord` 再透传给 `writeOwnerTransferArtifacts`。
3. **`+ 1` 在本层新代码里出现零次。** 这是可检验的：

   ```bash
   grep -rn 'currentOwnerEpoch + 1' src/
   # 实测 exit 0，命中 1 行：src/ownership/ownerController.ts —— 本层落地后必须仍然只有这一行。
   # 注意 -r 不可省：不加 -r 对目录取 exit 2。
   ```

**若实施者坚持在 `persistBoundaryAnalysis` 内自行算 `newOwnerEpoch`**，则必须新增一条**变异测试**：改掉 `applyOwnerEpochTransfer` 的增量规则（例如 `+ 1` → `+ 2`），**某条测试必须红**。没有这条测试就不许走那条路。

§4.2 表里 `newOwnerEpoch` 一行的「计算位置」相应改为「**由 `persistOwnerTransfer` 在 `applyOwnerEpochTransfer` 之后填入**」；那一行原来写的「可在事务前算」是本缺陷的源头。

#### 排序改判 —— `finalizeOrder` 改为 `[transfer, owner, reconciliation]`（第二轮评审，Critical）

第一轮修订选了 `[reconciliation, transfer, owner]`，并同时规定赢家路径的 `writeBoundaryArtifacts` **不再补写** reconciliation。**这两条合起来会让输家永久覆盖赢家刚发布的 reconciliation。** 机制（逐环回代码核过）：

```bash
grep -nF -A10 'function transferRepresentsPublishedWinner(' src/persistence/fileStore.ts
grep -nF -A22 'async function readPersistedSuccessfulTransferArtifacts(' src/persistence/fileStore.ts
grep -nF -A20 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
```

- `writeBoundaryArtifacts` 写 reconciliation 前过 `preserveSuccessfulReconciliationIfNeeded` → `readPersistedSuccessfulTransferArtifacts` → `transferRepresentsPublishedWinner`。
- `transferRepresentsPublishedWinner` 要求 `ownerRecord.currentOwnerEpoch === ownerTransferRecord.newOwnerEpoch` **且** `ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId`。**它隐含默认「reconciliation 是三份文件里最后落盘的」**——今天成立，因为赢家在事务完成之后才经 `writeBoundaryArtifacts` 写它。
- **reconciliation 排第一 + 赢家不再补写 = 把这个默认整个反过来。**

**由此可达的最终态**：rival 控制器 P2 在 P1 的事务窗口内（reconciliation 已 rename、transfer / owner 未发布）走 `writeBoundaryArtifacts`。此时首发转移场景下 `readOwnerTransferRecordRaw` ENOENT → `readPersistedSuccessfulTransferArtifacts` 的**裸 `catch { return null }`** → 保护判定压根没跑，**整个保护退化为无保护直写** → P2 用 `eligibleForContinuation: false` 覆盖 P1 的 reconciliation。P1 随后照常发布 transfer + owner **并删掉 marker**。最终磁盘：transfer eligible、reconciliation 被降级、marker 已删 → `evaluateResumeEligibility` 永久拒绝、`recoverInterruptedOwnerTransfer` 永不介入。**比债 1 更糟——债 1 至少 marker 还在。**

**采用的解法：把 `finalizeOrder` 改成 `[owner-transfer.json, owner-record.json, reconciliation-record.json]`。**

**为什么这不削弱 fail-closed**：§4.3 自己已经论证过「排序不承重，承重的是两条 epoch 相等判定」（论证原样保留在下面）。逐个中间态复核新排序：

| 已发布 | 拦截者 |
|---|---|
| 仅 transfer | `ownerRecord.currentOwnerEpoch`（仍是 N）`!== ownerTransfer.newOwnerEpoch`（N+1）→ 判据 B 拒绝 |
| transfer + owner，reconciliation 未发布（**首发转移**） | `reconciliation-record.json` 不存在 → `readReconciliationRecord` ENOENT → `resumeLoop` 的 `Promise.all` catch → 拒绝 |
| transfer + owner，reconciliation 是**上一次**转移留下的（**双转移**） | `reconciliation.newOwnerEpoch`（N+1）`!== ownerTransfer.newOwnerEpoch`（N+2）→ 判据 A 拒绝 |
| 三者齐备 | 放行——正确 |

**并且新排序恰好恢复 `transferRepresentsPublishedWinner` 依赖的那个默认。** 逐步核过 P2 落在「transfer + owner 已发布、reconciliation 未发布」窗口内的那条路：

1. P2 走 `preserveSuccessfulReconciliationIfNeeded` → `readPersistedSuccessfulTransferArtifacts` → `Promise.all` 的第一项 `readOwnerRecord` → `recoverInterruptedOwnerTransfer(runDir)`（**不传 `options`**）。
2. 该窗口内 `.owner-transfer.lock` **仍被 P1 持有**（`writeOwnerTransferArtifacts` 的 `finally` 尚未执行），于是 `!options?.lockHeld && pathExists(lockPath) && !tryRecoverStaleOwnerTransferLock(...)` 成立——P1 的 pid 活着 → **P2 的恢复直接 return，不会替 P1 finalize**。
3. P2 因此读到「已 rename 的新 owner record」与「已 rename 的新 owner-transfer」，`transferRepresentsPublishedWinner` 的两个判定（epoch 相等、`currentProcessInstanceId === newProcessInstanceId`）**都成立**。
4. P2 的降级尝试被 `shouldSynthesizeSuccessfulReconciliation` 改写为一份「合成的赢家 reconciliation」，随后被 P1 finalize 的真品 rename 覆盖。两次写的内容对同一次转移都是「成功」，无损。

```bash
grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
grep -nF -A26 'export async function writeOwnerTransferArtifacts(' src/persistence/fileStore.ts
# 实测：锁在整个 staging + finalize 期间被持有，finally 才 release；
# 而 recoverInterruptedOwnerTransfer 在 !lockHeld 且锁被活进程持有时直接 return
```

**第 2 步是这条修法能成立的关键，而且它不明显**——若将来有人把锁的持有范围收窄到只包住 staging，这条论证就断了，F6 会以另一种形状回来。**§10 测试 6e 的变异必须覆盖它。**

**接受的代价（诚实记下）**：「transfer 已发布、reconciliation 缺失」从「连瞬时都不出现」变成**一个真实的瞬时窗口**。该窗口内 marker **必在盘上**（marker 的 `safeUnlink` 在三次 rename 全部完成之后），所以 marker 驱动的恢复覆盖它。次生代价：`resumeLoop` 的 `Promise.all` 里 `readReconciliationRecord` 与触发恢复的 `readOwnerRecord` 并行，可能在恢复完成前读到 ENOENT，于是**该次** sweep 拒绝、下一次 sweep 通过。这是**瞬时且自愈**的 liveness 抖动，不是安全洞，本层接受并在 §15 验收 1 如实写明。

**评估过并否决的另外两条：**

- **(b) 保留赢家事后那次 `writeBoundaryArtifacts` 的 reconciliation 写。** 否决：它只在 `writeBoundaryArtifacts` 之前那个**无条件 `assertHeld()`** 通过时才发生，而「`assertHeld` 抛出」正是债 1 的定义场景。也就是说它恰好在需要它的那个场景里不执行，修不了任何东西，只多一次冗余写。
- **(c) 让输家的 reconciliation 写也进 `acquireOwnerTransferLock`。** 否决：`writeBoundaryArtifacts` 被非转移路径也调用，给它加锁会让一条从不失败的路径新增一类 `OwnerTransferLockBusyError` 失败，爆炸半径远大于改一个常量数组的顺序，且要动锁协议的适用范围。**不排除它是更彻底的解**，但本层不做——按 Rule 2 取最小解。

**钉住这次改判的测试是 §10 测试 6e**（新增），验收面是 §15 验收 1a。

**为什么排序不是承重论证（第一轮结论，原样保留）：**

**真正承载 fail-closed 的不是顺序，是 `evaluateResumeEligibility` 里的两条 epoch 相等判定**：

- **判据 A**：`reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch`
- **判据 B**：`ownerRecord.currentOwnerEpoch === ownerTransfer.newOwnerEpoch`

评审员用「N→N+1 已成功、N+1→N+2 崩在中途」的双转移场景逐字段追过，**并且在 `resumeLoop` 那个并行 `Promise.all`（它不是快照，见 §4.0a）的每一种混合采样下追过**：每一种都被这两条之一挡住。marker 恢复对**两种排序同样有效**，所以崩溃论证本身并不能在两个顺序之间做区分——**能做区分的是上面那条输家覆盖路径**。

**这两条 epoch 相等判定是本层之后任何改动都不得削弱的东西**——§10 测试 6b 就是钉它的，而测试 6b 的 fixture 要求见 §10（判据 A 只有双转移 fixture 杀得掉）。

### 4.4 finalize 机制 —— **改判为 marker 驱动**（初稿选错，此处是再决策）

初稿选「pending 存在性驱动」（reconciliation pending 存在就发布、不存在就跳过），理由是「零新失败模式」。**评审证明该理由为假，且它接受的失败模式严格更差：**

**推翻它的场景**：SIGKILL 落在 marker 写入之后、reconciliation pending 写入之前。磁盘：marker 在、两个旧 pending 在、无 reconciliation pending。下一次 `readOwnerRecord` → 恢复 → 见 marker → finalize → 按「不存在就跳过」的规则**发布 transfer 与 owner record，然后删掉 marker**。结果正是「transfer 已发布、reconciliation 缺失」，**且 marker 已删，永不可恢复**。

机制上无法检测——因为「pending 缺席」被**定义**成了「这是 v1 事务」。而初稿的**测试 4 恰好把这个磁盘状态断言为正确行为**，等于把缺陷的形状写进套件。

**「不可解析的 marker」是响亮的失败；「静默降级的提交」不是。初稿避开了前者，接受了后者。**

**⚠️ 「响亮」这个词在第一轮修订里是无依据的**（第二轮评审，Critical）。具名错误从 `readOwnerRecord` 逃出后，被 `resumeLoop` 的 `Promise.all` catch 包成 `ResumeNotEligibleError`；而 §8 的错误表把 `ResumeNotEligibleError` 归为「**正常结果，不是错误**」→ stdout → exit 0。**在实际调用图上它一点都不响亮**，cron 的「有 stderr 即告警」永远不会响。

```bash
grep -nF 'cannot read run artifacts' src/controller/resumeLoop.ts
# 实测 exit 0，2 行：一行 appendEvent(resume_denied)，一行
# `throw new ResumeNotEligibleError(...)` —— Promise.all 的 catch 把任何读侧抛出
# 统一改写成 ResumeNotEligibleError，原错误类型在这里被丢掉
```

**本立论靠 §8 的路由兑现，不靠错误类型本身**：§8 已为这个具名错误**单开一行** → stderr + outcome `error`，不再落进 `refused`。为使它可路由，`resumeLoop` 在改写时必须带上 `cause`（`throw new ResumeNotEligibleError(msg, { cause: error })`），sweep 按 `cause` 分类。这条改动记在 §9。

**采用的机制：**

1. marker 成为**被读取**的字段：finalize 解析 marker，按其 `finalizeOrder` 声明的文件集合与顺序办事。`version` 成为联合类型（1 | 2），v1 声明两个文件、v2 声明三个。
2. **v2 marker 但某个 pending 缺失 → 拒绝 finalize，保留 marker 与全部 staging**，抛一个具名错误。fail-closed。
3. **marker 不可解析 → 同样拒绝 finalize，保留一切**，抛具名错误。
4. v1 marker 按两文件路径走完，不抛。
5. **marker 改为原子写**（§4.0.3，人已裁定）。

**规则 2 / 3 的可达性与恢复手段 —— 第二轮评审要求正面写清，不得含糊成「可恢复、可诊断」：**

第一轮修订说这两种状态「保持**可恢复、可诊断**」。**「可诊断」成立，「可恢复」在本层没有任何机制兑现——那句话现予撤回。** 逐条：

- **规则 3（marker 不可解析）：因 §4.0.3 的原子写而不可达。** rename 之前 marker 不可见，rename 之后 marker 完整。分支保留为**纵深防御**（例如有人手工放了一个坏 marker，或将来有人把原子写改回去），不作为可达路径论证。
- **规则 2（v2 marker 但 pending 缺失）：因暂存顺序不变式（三份 pending 全部写完才写 marker，且 marker 原子）而不可达。** 分支同样保留为纵深防御。
- **但有一类真实可达的「marker 仍在、按设计永远推不完」**：**pending 文件被写坏（截断）**。三份 pending 走的都是裸 `writeJsonFile`，`finalizePendingOwnerTransfer` 在 try **之前**就 `JSON.parse` 它们，parse 抛出会一路逃出 `readOwnerRecord`，而 marker 仍在盘上 → 每一次 `readOwnerRecord` 都重复同一次抛出。**这是先于本层的既有缺陷**（今天已有两份 pending 这样被解析），**本层把它从两份扩到三份，扩大了影响面但没有改变性质**。

  ```bash
  grep -nF -A4 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
  # 实测：try 之前两次 readFile + JSON.parse（本层之后三次）
  grep -nF 'await writeJsonFile(paths.transferPendingPath' src/persistence/fileStore.ts
  grep -nF 'await writeJsonFile(paths.ownerPendingPath' src/persistence/fileStore.ts
  # 实测：pending 走裸 writeJsonFile，非原子
  ```

  **本层的处置**：不修（人对 §4.0.3 的裁定只覆盖 marker，按 Rule 2 / Rule 3 不扩范围），**具名传给 L5**，见 §13。**恢复手段目前只有「人工删除该 run 目录下的 staging 文件」**——本层坦白它没有自动化入口，因为 §2 把 cleanup/GC 排给了 L5。

这三种状态全部写进 §15 验收 2 的具名例外。**不允许再用「可恢复」一词描述其中任何一种，除非同时给出恢复它的代码路径。**

### 4.5 本节修好了什么（措辞已按评审收窄）

`writeBoundaryArtifacts` 之前那个**无条件 `assertHeld()` 原样保留**——L1b 的「只增加拒绝」立场一个字不改。变的是它身后守着的东西：赢家路径上它现在只守 `boundary-analysis.json`。

**关于「没人依赖 `boundary-analysis.json`」—— 初稿把它写成绝对断言，而附的命令刻意只覆盖了它成立的那个目录。** 事实是：

```bash
grep -rnF 'boundary-analysis.json' src/                    # 1 处，是写入
grep -rlF 'boundary-analysis.json' validation/ tests/      # 6 个文件，有读者
```

`validation/v1/lib/evidence.ts` **会读它并做 Zod 校验**，`validation/v1/README.md` 把它列为消费产物，四个测试文件读或断言它。该 harness 对缺失有 `MISSING` 降级，所以**不是正确性破损**——但正确表述是「**`src/` 内无生产读者**」，不是「没有任何读者」。

**⚠️ 归属更正（第二轮评审）**：第一轮修订写「**本层之后**，赢家路径上 `boundary-analysis.json` 在 supersede 窗口内可能缺失」——**那是先于本层的既有事实，不是本层引入的**。L2 spec §13.1 第 1 条已白纸黑字记着：

> **Reconciliation synthesis is unowned.** Consequence of the L1b ruling that the `writeBoundaryArtifacts` call is guarded unconditionally (`src/controller/runLoop.ts`, the `heartbeat.assertHeld()` / `writeBoundaryArtifacts` pair). A completed `owner-transfer.json` may now exist with neither `boundary-analysis.json` nor `reconciliation-record.json`.

```bash
grep -nF -A10 'Reconciliation synthesis is unowned' docs/superpowers/specs/2026-07-28-run-registry-design.md
```

**本层对这条既有事实的改变是单向收窄**：`reconciliation-record.json` 那一半被 §4 消除，`boundary-analysis.json` 那一半按本节刻意保留为有损（validation harness 观测到 `MISSING`，已知且可接受）。**本层没有新增任何缺失窗口。**

**债 1 不是靠移除守卫修好的，是靠把守卫身后那件有生产依赖的东西搬进事务修好的。**

### 4.6 与既有代码的关系

`preserveSuccessfulReconciliationIfNeeded` **代码零改动**。

**⚠️ 但第一轮修订给的理由已过时**（第二轮评审）。它写的是「赢家路径因为 `eligibleForContinuation` 是类型级 `true` 而必然**早退**」。§4.3 之后赢家传 `reconciliationRecord: undefined`，而 `writeBoundaryArtifacts` 里那句 `if (artifacts.reconciliationRecord !== undefined)` 直接跳过整个分支，**赢家根本走不到那个早退**。

```bash
grep -nF -A14 'export async function writeBoundaryArtifacts(' src/persistence/fileStore.ts
# 实测：reconciliationRecord === undefined 时，preserveSuccessfulReconciliationIfNeeded 不被调用
```

**正确的理由**：本层之后，赢家路径**根本不再调用**这个函数（`reconciliationRecord` 传 `undefined`），输家路径的调用形态与今天逐字节相同。**两侧都不需要改它的代码**，所以结论「代码零改动」仍然成立，只是靠的是另一条依据。（**若将来有人改回 §4.3 否决过的方案 (b)，即赢家继续补写 reconciliation，本段理由要跟着改回早退论证。**）

```bash
grep -nF -A4 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
```

（`-F` 建议保留，因为**裸符号名不唯一**：它还会命中 `preserveSuccessfulReconciliationIfNeededFromArtifacts`，带 `async function ` 前缀才唯一。**初稿另给的理由「不加 `-F` 会因未闭合分组报错退出 2」是假的**——实测：

```bash
grep -n  'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts; echo $?   # 命中 1 行，exit 0
grep -nE 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts; echo $?   # parentheses not balanced, exit 2
```

即默认的 `-G` 下末尾 `(` 是字面量、退出 0，只有 `-E` 才 exit 2。那条我是从裁决记录抄的，没自己跑。**这正是本仓库「不要相信别人写下的『已核实』」那条教训。**）

**⚠️ 裁决记录该处至今未勘误，本节即为它的就地勘误。** 假主张原文在 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md` 债 1「修法方向可行性」一节：「本仓库的 `grep` 被改写成正则引擎，锚点末尾的 `(` 会被当成未闭合分组而**报错退出 2**，而不是返回 0 命中」。按本仓库「就地勘误、不改原件」的立场，**不修改裁决记录**，但任何后来者读到那句话时应以本节的实测为准。

```bash
grep -nF '会被当成未闭合分组' docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
```

**语义非零改动**：见 §4.0a 末尾——`readPersistedSuccessfulTransferArtifacts` 的 `Promise.all` 里有一个读会触发恢复，而恢复现在会写第三个文件。代码不用改，但这条性质必须记下来，且 §10 测试 6b 钉住真正承重的东西。

输家路径完全不进事务，继续走 `writeBoundaryArtifacts`，行为不变。

## 5. 债 3 — `heartbeat.stop()` 释放窗口

### 5.1 机制复核

```bash
grep -nF -A10 'const stop = async (): Promise<void> => {' src/controller/leaseHeartbeat.ts
grep -nF -B12 -A8 'const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {' src/controller/leaseHeartbeat.ts
```

`stop()` 置 `stopped = true`、`clearInterval`、`await queue.catch(...)`、`releaseOwnerLease`。今天不可达仅仅因为两个 `stop()` 调用点都在 `await runLoopFromState` 之后的 `finally` 里（`runLoop.ts` 与 `resumeLoop.ts` 各一处）。

### 5.2 完整性论证：为什么「`stopped` 后拒绝」就够

- `stopped = true` 与读取 `queue` 那一步之间**只隔一个同步的 `clearInterval`，没有任何 `await`**。
- `runExclusive` 的函数体是纯同步的，调用返回时 `queue` 已包含 `fn`。

**任何在 `stopped` 置位前发起的 span 必已被折进 `stop()` 读到的 `queue`；任何之后发起的必然看见 `stopped === true`。** 两侧穷尽，无需 drain 循环。（三个评审员独立复核，一致确认。）

**⚠️ 范围声明（第二轮评审补，不得省略）：「两侧穷尽」只对 *exclusive span 内部* 成立。**

`runExclusive` 的拒绝只覆盖进入 `queue` 的那一段。而 `persistBoundaryAnalysis` 里 `runExclusive` **返回之后**的 `assertHeld()` + `writeBoundaryArtifacts` 明确留在 span **外面**——代码注释自己写着这句：

> `writeBoundaryArtifacts` below stays OUTSIDE: there is no reason to make the heartbeat wait behind artifact writes.

```bash
grep -nF -B6 'const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(' src/controller/runLoop.ts
grep -nF -A3 'await heartbeat.assertHeld();' src/controller/runLoop.ts
```

**因此一次并发 `stop()` 完全可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`。** 改动 A 不覆盖这一段，本层也不覆盖它（覆盖它要么把 artifact 写搬进 span——L1b 刚刚明确否决过——要么另设一层守卫）。**§13 据此把债 3 记为「exclusive span 部分关闭」，span 外那段具名传给 L5。**

### 5.3 改动 A — `runExclusive` 拒绝

**先把在先的裁定完整引出来**（初稿只引了前半句，而被略掉的后半句正好禁止本改动——这是 Rule 7 要求「挑一个并说明为什么」的场合）：

> Takes no position on `stopped` or `superseded` — it only serializes. **Refusal is Task 5's job; duplicating it here would just be a second, weaker copy of a decision that already has one home.**

**⚠️ 第一轮修订给的推翻理由已被改判 B 抽掉地基，现予改写（第二轮评审，Critical）。**

第一轮写的是：「那条裁定成立的前提是『`stop()` 之后不会再有 `runExclusive`』——L1b/L2 时期为真，因为没有触发调用者。**L3 是让这个窗口可达的那一层**，前提不再成立。」

**两个问题：**

1. **「那条裁定成立的前提是……」这句话注释里没有**，是本 spec 自己替它重建的。在一份把「引全句、不得替原文补论证」立为铁律的文档里，这是双标。注释的**全文**只有上面引的那两句，它没有陈述任何前提。
2. **更要命的是：§5.4 采用的设计把那个「前提」原样保住了。** 改判 B 把信号处理器装在 `cli.ts`（只置槽）、`sweepRuns.ts` 保持纯函数、逃生口是 `process.exit(130)`，**L3 内没有任何路径会在 `runLoopFromState` 飞行期间调 `heartbeat.stop()`**：

   ```bash
   grep -rn 'heartbeat\.stop()' -- src
   # 实测 2 处：src/controller/runLoop.ts:929、src/controller/resumeLoop.ts:185，
   # 都在 await runLoopFromState(...) 之后的 finally 里
   ```

   **所以「L3 让这个窗口可达」按本 spec 自己采用的设计为假。** 按 Rule 7 必须挑一个，不能两节各说各的。

**本层采用的理由（改写后，不依赖那个被抽掉的前提）：**

**这里的拒绝不是 `assertHeld` 那条决策的第二份弱拷贝，因为「本进程心跳已停」这个命题今天根本没有 home。** 实测 `assertHeld` **从不读 `stopped`**：

```bash
grep -n 'stopped' src/controller/leaseHeartbeat.ts
# 实测命中 8 行：:38 声明、:78 与 :296 是注释、:138 在 runAffirm 内、:193 是被推翻的那条注释、
# :217 与 :221 在 stop() 自己内、:278 是注释。assertHeld（:252 起）一次都没读它。
grep -nF -A30 'const assertHeld = async (): Promise<void> => {' src/controller/leaseHeartbeat.ts
```

`assertHeld` 判的是「所有权还在不在」（读持久 owner record），`stopped` 判的是「本进程还打不打算继续」（纯进程内状态）。**两个命题不同，而后者今天没有任何守卫读它，所以谈不上「第二份弱拷贝」——这个论据比 spec 第一轮给的强，且不依赖任何关于可达性的主张。**

**关于可达性，本层的诚实表态**：`stopped` 之后的 `runExclusive` 在 **L3 内不可达**（上面那条 grep 就是证据）。本改动是**纵深防御**，也是 §14 常驻形态（`watch`）的前置加固——常驻形态会让飞行中 `stop()` 真正可达。**因此本层不主张「在先裁定的前提不再成立」**；本层主张的是：那条裁定把「refusal 只有一个 home」当作理由，而这个特定命题恰恰没有 home，所以拒绝在此处不构成重复。

**新增错误类型** `RunHeartbeatStoppedError`（`readonly stopReason = "heartbeat_stopped"`，形状照抄现有两个）：

```bash
grep -nF -A4 -e 'export class RunLeaseLostError' -e 'export class RunLeaseUnverifiableError' src/ownership/lease.ts
```

**必须同笔改掉的三样东西**（第一轮修订只列了两条注释，把「谓词本身要接受新错误」降级成了隐含；第二轮评审要求显式列出，并已进 §9 改动清单）：

1. **`isLeaseStopError` 谓词本身**：类型守卫要从 `error is RunLeaseLostError | RunLeaseUnverifiableError` 扩到含 `RunHeartbeatStoppedError`，判定体同步。**这是代码改动，不是注释改动。**
2. `runExclusive` 上方那条注释（上面引的），它记录的裁定被本改动局部推翻。
3. `isLeaseStopError` 上方的「the **two** ways `heartbeat.assertHeld()` can refuse a side effect」——新错误来自 `runExclusive` 而**不是** `assertHeld`，**数量与来源两头都会变假**。

```bash
grep -nF -B4 'function isLeaseStopError(' src/controller/runLoop.ts
```

#### ⚠️ 改动 A 与 §5.4 的冲突（第二轮评审，Critical，2/3 撞到）—— 必须选一个

`isLeaseStopError` 的**两个**使用点都以写终态收尾：

```bash
grep -n 'isLeaseStopError' src/controller/runLoop.ts
# 实测 3 行：:105 定义、:1001 与 :1353 两个使用点
grep -cF 'state, "cancelled"' src/controller/runLoop.ts     # 实测 4（其中两处正是这两个分支）
grep -nF 'cancelled:' src/state/stateMachine.ts             # cancelled: [] —— 终态，无合法出边
grep -nF 'RESUMABLE_STATUSES' src/controller/resumeLoop.ts  # ["planning","executing","verifying"]，不含 cancelled
```

**于是**：`RunHeartbeatStoppedError` 一旦进 `isLeaseStopError`，一次并发 `stop()` 就能让飞行中的 run 被写成 `cancelled`——**而 §5.4 用一整节论证「写 `cancelled` = 一次 Ctrl-C 永久摧毁飞行中的 run」，§5.3 从另一扇门把同一个后果放了回来。**

**注意这不是「遗漏」。** 下面那条 ⚠️ 确实提到了会终结为 `cancelled / heartbeat_stopped` 并写「接受」，但它给的接受理由只谈「跳过 `exhausted` 与相位超时原因的信息损失」，**从未认出被接受的其实是一次永久终结**。**理由答非所问，比遗漏更难被下一个读者发现。**

**本层的选择：(a) —— 新错误不进 `isLeaseStopError`，另设分支。**

- `isLeaseStopError` 的签名与判定体**保持今天的两种错误不变**（上面第 1 条相应作废；第 3 条那句注释里的「two」因此仍然为真，**不必改**；只有第 2 条注释仍要改）。
- 在 `runLoopFromState` 的外层 catch 里，**在 `isLeaseStopError` 分支之前**新增一条 `error instanceof RunHeartbeatStoppedError` 分支：**追加 `heartbeat_stopped` 事件，返回当前的非终态 `state`，不调 `persistTerminalState`**。形状与 §5.4 的停机点同构，两处对「停机」的处置因此一致。
- **为什么不选 (b)（在写终态前判 `stopReason === "heartbeat_stopped"` 就跳过）**：那是在一条 fail-closed 分支里加一个字符串条件，读者要跨两个文件才能看懂它为什么在那儿；(a) 让两条停机路径长得一样。
- **为什么不选 (c)（明确接受终结、撤回 §5.4 的论证）**：§5.4 的论证是对的——写 `cancelled` 后 `resume` / `sweep` / `runLoop` 三条路全部拒绝，代码里没有任何路径退出终态。接受它就等于接受本层存在的理由被一次信号摧毁。

**§9 的改动清单已按 (a) 更新**：`runLoop.ts` 一行「新增 `RunHeartbeatStoppedError` 分支，不写终态」；`isLeaseStopError` 谓词**不改**。

**§13 的连带更正**：第一轮修订写「§5.4 不再新增 `persistTerminalState` 调用点，所以本层对债 2 的接触面为零」——**前提对、结论当时不成立**（§5.3 会让两个**既有**调用点被一类新错误触达，而债 2 恰是「`persistTerminalState` 往已不拥有的 run 写」）。选了 (a) 之后结论才真正成立，§13 已改为写明这个依赖关系。

**调用点事实更正**：`runExclusive` 只有**一个**生产调用点，在 `persistBoundaryAnalysis` 内，**不在** `runLoopFromState` 内。初稿写的「两个、在 `runLoopFromState` 内」两头都错——「两个」是 `persistBoundaryAnalysis` 的调用点数。

```bash
grep -rnF 'runExclusive(' src/    # 期望 1 行
```

落地路径**经由 `persistBoundaryAnalysis` 传递地**成立：它的两个调用点在 `runLoopFromState` 的 attempt `try` 内，外层 catch 的 `isLeaseStopError` 分支把这类错误当停机边界处理。

⚠️ **注意 `INERT_LEASE_HEARTBEAT` 与测试替身**：它们的 `runExclusive: (fn) => fn()` 是**桩**，不是调用点，**不要给它们加拒绝逻辑**——那会打断 `tests/controller/leaseLifecycle.integration.test.ts` 里若干提供同样桩的测试心跳。

⚠️ **新抛出会替换掉更有信息的错误**（记录而非修复；**已按上面的选择 (a) 重写**）：在 execute 超时无结果那条路径上，`RunHeartbeatStoppedError` 会抢在本该发生的处理之前逃出，跳过本来要写的 `exhausted` + 相位超时原因、跳过 `cleanupAttemptWorkspaceWithStatus` 与 `execution-recovery.json` 的 `cleanupStatus` 回填。今天不可达；在 §5.3 要防御的并发 `stop()` 场景下才变活。

**接受，理由**：那条路径上「本进程心跳已停」本来就意味着这些后续写入不该发生。**选了 (a) 之后，被接受的只是「这些写入不发生」，不再包含「run 被永久终结」**——run 停在非终态，下一次 sweep 仍然 eligible（与 §5.4 同构，§15 验收 4 覆盖）。

**这条退化是本层唯一一条被明写「接受」的行为退化，因此必须有断言面**（第二轮评审：第一轮在 §10 里对它零断言）。见 §10 测试 7b：断言 `RunHeartbeatStoppedError` 逃出时 (i) 不写终态、(ii) 不写 `execution-recovery.json` 的 `cleanupStatus`、(iii) 返回的 `state.status` 仍在 `RESUMABLE_STATUSES` 内。**测试的用途是把「接受」钉成一个具体形状，使将来无意中改变它时会红**，不是证明它是好的。

### 5.4 改动 B — 停机信号槽（**不写终态**）

**初稿在这里有一个会摧毁本层全部价值的缺陷**：它规定命中信号槽时 `persistTerminalState(runDir, state, "cancelled", "stop_requested")`。而：

```bash
grep -nF 'cancelled:' src/state/stateMachine.ts             # cancelled: []  —— 终态，无合法出边
grep -nF 'RESUMABLE_STATUSES' src/controller/resumeLoop.ts  # ["planning","executing","verifying"]
```

**后果**：操作者 Ctrl-C 一次 sweep，正在飞行的那个 run 被写成 `cancelled`，从此 `resume` 拒绝、`sweep` 拒绝、`runLoop` 被 `ensureFreshRunDir` 拒绝，代码里没有任何路径退出终态。**优雅停机会永久摧毁本层存在的理由。**

初稿照抄了 `leaseLoss` 的先例，但两者**不类比**：`leaseLoss` 下写终态是对的，因为**有新 owner 会接着跑**；`stop_requested` 下没有新 owner。

**采用的语义：**

- `StopRequestSignal = { requested: boolean }` + `createStopRequestSignal()`，形状照抄 `LeaseLossSignal`

  ```bash
  grep -nF -e 'export type LeaseLossSignal' -e 'export function createLeaseLossSignal' \
           -e 'if (leaseLoss.lost !== null)' src/controller/runLoop.ts
  ```
- `runLoopFromState` 在**已有的**相位边界检查点旁边多查一个；命中则 **`appendEvent(runDir, { type: "stop_requested", ... })` 并返回当前的非终态 `state`**，不启动下一个 attempt，**不调 `persistTerminalState`**
- `resumeLoop` 的 `finally` 里已有的 `heartbeat.stop()` **尝试**清掉 `leaseAffirmedAt`，所以下一次 sweep 的 `checkRunLease` 会放行，而 owner epoch 未变、门依然通过——**该 run 下一次 sweep 仍然 eligible**。§10 测试 8b 就是钉这一点的

  **⚠️ 「会清掉」是无条件断言，而实际是尽力而为（第二轮评审）**：`stop()` 里那句 `releaseOwnerLease` 被 `try { … } catch {}` 包着，而它走 `updateOwnerRecordWithPrecondition`，**CAS 不匹配就抛、随即被吞**。

  ```bash
  grep -nF -A6 'await releaseOwnerLease(options.runDir, expected);' src/controller/leaseHeartbeat.ts
  grep -nF -A8 'export async function releaseOwnerLease(' src/persistence/fileStore.ts
  # 实测：releaseOwnerLease → updateOwnerRecordWithPrecondition（CAS，失配抛 OwnerTransferPreconditionError）
  ```

  **诚实的表述（§15 验收 4 已按此改写）**：**租约释放成功后立即 eligible；释放失败（CAS 失配、锁忙、I/O）则最迟 `LEASE_TTL_MS` 之后 eligible。** 两种情形下 run 都不会被永久拒绝，这才是 §5.4 要保住的性质。**测试 8b 若只测顺利路径就不承重**，必须同时覆盖释放失败路径（见 §10 测试 8b）
- `resumeLoop` 追加**可选参数**（有默认值；现有调用点全部传 2 个实参，零改动）；它对 `runLoopFromState` 的调用需把信号作为**第七个位置参数**传下去
- **信号处理器装在 `cli.ts`，不装在 `sweepRuns.ts`**。`sweepRuns.ts` 保持纯函数、接收一个信号槽——既让 §3 第 1 条的「sweep 自身不新增 writer」成立，也让测试 13 可测

⚠️ **停机粒度的界是「adapter 协作式」，不是无条件有界**（评审更正）。检查点是 **per-attempt** 边界。而 execute 相位用 `{ awaitAbortedResult: true }`，超时后 `abort()` 再 `await operationPromise` **没有第二重上界**；adapter 的 `onAbort` 只发 `SIGTERM`，无 SIGKILL 升级。一个不响应 SIGTERM 的子进程会让 attempt 无限期挂住。`createAttemptWorkspace` / `cleanupAttemptWorkspace` 的 git 子进程也完全无超时。**诚实的界是**：`planTimeoutMs + verifyTimeoutMs + (execute：adapter 协作则有界，否则无界) + 无超时的 git`。

⚠️ **因此必须留逃生口**（否则装了处理器反而让 sweep 杀不掉，因为默认处置被移除了）：**第二次收到停机信号立即 `process.exit(130)`**。

**「第二次」的定义（第二轮评审要求定死；第一轮 §5.4 写「同一信号」、§7 写「SIGINT/SIGTERM」，两处不一致）：本层采用「跨信号种类合并计数」** —— 计数器是一个，SIGINT 与 SIGTERM 都对它 `+1`；第一次置槽，第二次（无论来自哪一个）立即 `process.exit(130)`。**理由**：操作者第二次按下去表达的是「现在就停」，不是「换一种信号试试」；按信号种类分别计数会让「先 Ctrl-C 再 `kill`」这个最常见的升级序列**永远走不到逃生口**。§7 的退出码表已按此改写。

本层不修 execute 的超时升级——那是行为变更，属独立任务，本层只记录。

⚠️ **停机不消耗任何配额，且不留任何被消费者读到的痕迹（第二轮评审，两条，本层正面表态）：**

1. **停机点落在已有的相位边界检查点旁，而那个位置在 `attemptsUsed` 递增之前。**

   ```bash
   grep -n 'leaseLoss.lost !== null\|const attempt = state.attemptsUsed + 1;\|await writeRunState(runDir, state);' src/controller/runLoop.ts
   # 实测：while(true) 内顺序为 writeRunState(state) → affirmNow → leaseLoss 检查 → const attempt = state.attemptsUsed + 1
   ```

   所以一次 `stop_requested` 之后，`loop-state.json` 的 `status` 与 `attemptsUsed` 与停机前**逐字节相同**（那次 `writeRunState` 写的是同一个 `state`）。而 `attemptsUsed` / `maxAttempts` 是唯一的收敛边界，**因此重复停机不消耗任何配额**：一个被反复 Ctrl-C 的 run 可以被 sweep 无限次重新捡起。

   **本层正面接受这一点**，理由：把停机计入 attempt 配额，等于让「操作者按 Ctrl-C」消耗掉本该留给真实失败重试的预算——一次误按就永久减少了这个 run 的成功机会。**代价（无限次重捡）由 §12 的 `--max-runs` 在每一次 sweep 上界住**，不由 run 侧的配额界住。

2. **「人按过 Ctrl-C」这个信息只进 `events.jsonl`，而没有任何消费者读它。**

   ```bash
   grep -n 'file:' src/registry/observeFields.ts
   # 实测 3 个观测文件：loop-state.json、owner-record.json、owner-transfer.json；无 events.jsonl
   ```

   `evaluateResumeEligibility` 也不读事件流。**所以下一次 sweep 分不清「人主动停的」和「被 OOM 杀的」。**

   **本层刻意放弃这个区分**，理由：**两者的正确处置恰好相同**——run 停在非终态、所有权未变、租约已释放或将过期，正确动作都是「下一次 sweep 重新续跑」。**引入这个区分需要新增一个被 registry 观测的字段，那是新的磁盘契约，属 L2/L5 的范围，不属本层。** 这里写明是为了不让它被沉默继承。

**两个改动互补**：B 提供正常路径上的停机，A 保证并发 `stop()` 只会得到拒绝而非静默无主写入。**债 3 在 exclusive span 内关闭；span 外那段按 §5.2 的范围声明具名传给 L5**（§13）。

## 6. Sweep 触发层

```
ccloop sweep --root <root> --adapter <scripted|claude> --adapter-config <path> --max-runs <N>
        │
        ├─ scanRuns(root, defaultScanDeps)
        ├─ scanRootFailureDetail(rows, root) !== undefined → stderr + exit 1（见 §7）
        ├─ 过滤 kind === "run" 且 owner-transfer.json 的 eligibleForContinuation
        │        观测为 { kind: "present", value: true }
        ├─ 按 path 字典序排序（确定性，测试依赖它）
        ├─ 打印启动横幅到 stderr（root + adapter + eligible 总数 + 配额 N）→ 此后才构造 adapter
        ├─ 顺序 for-await：resumeLoop(runDir, adapter, { stopRequested })
        │        每次调用返回（未抛）即 consumed += 1；consumed === N 时停止遍历
        └─ 打印报告 → exit 0（扫描本身失败则 1）
```

**`--max-runs <N>` 是必需参数**（§12 的治理表态；第一轮修订只写在 §12，定义 CLI 形状的**五节**一次都没提它，本轮补齐：§6 调用式与本流水线、§7 退出码、§8 横幅与报告、§9 模块表、§10 测试 12b）。

**截断步放在排序之后**，不是过滤之后——否则「跑哪 N 个」不确定，测试 11 / 13 的确定性依赖就断了。

#### `--max-runs` 只对**实际进入 `runLoopFromState`** 的 run 计数

第二轮评审撞出：「必需 `--max-runs` + 排序确定 + 拒绝也计入配额」三者相加是**确定性饿死**——字典序排在前面的、永久被拒的 run 每一轮吃掉配额，后面真正可跑的 run **永远轮不到**。而被拒的 run 今天**没有任何收敛机制**：

```bash
grep -n 'file:' src/registry/observeFields.ts
# 实测：registry 只观测 loop-state.json / owner-record.json / owner-transfer.json，
# 不观测 reconciliation-record.json —— 所以「transfer eligible 但 reconciliation 不合格」
# 的 run 每一次 sweep 都会被重新捡起
```

**本层的处置，两条：**

1. **配额只计入「`resumeLoop` 正常返回」的次数。** `resumeLoop` 抛出（`ResumeNotEligibleError` / `RunLeaseHeldError` / 意外错误）一律**不计**。这是外部可观测的判据：`resumeLoop` 只有在 `runLoopFromState` 跑完之后才正常返回，抛出必然发生在它之前。**这同时也让 §12 的治理论证更强**——`--max-runs` 界的是**付费调用**次数，而被拒的 run 一次付费调用都没发生。
2. **排序与退避二选一，本层选「保留字典序、不做退避」。** 理由：选了第 1 条之后，饿死的机制已经消失（拒绝不消耗配额，遍历一定会走到可跑的 run）。退避需要在 run 目录里新增一个被读取的状态文件——那是新的磁盘契约，属 L2/L5。**代价必须记下**：一次 sweep 扫到 M 个永久被拒的 run，就会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件，**无退避、无上限、无标记**。这不影响付费界，但会让 `events.jsonl` 单调增长。**具名传给 L5**（§13）。

**参数语法用 `--root` 而不是位置参数。** `parseArgs` 对非 `ls` 命令走的是 `for (index = 1; index < argv.length; index += 2)` 的纯 flag/value 配对；`sweep <root> --adapter x` 会被配成 `root → "--adapter"`，**在一条完全合法的命令行上报 `missing required flags`**。改用 `--root` 让 sweep 直接复用既有配对循环，不必给它单开分支。

```bash
grep -nF -e 'for (let index = 1; index < argv.length; index += 2)' -e 'const root = rest.find' src/cli.ts
```

**排序是必须的**：`scanRuns` 全文无任何 sort，行序取决于 `readdir` 的文件系统顺序。测试 11 与 13 都依赖「谁先跑」。

**消费 L2 的数据契约，但在进程内调用 `scanRuns`**，不 fork `ccloop ls --json`。**代价要记下来**：sweep 因此耦合到 `ScanRow` 类型，而非 L2 §6.3 定义的版本化 JSON 形状；L2 §14.1 的字面要求是后者。

**对 L2 §13.1 的处置是「收窄」不是「讨清」**（初稿说过头了）：那条记录同时点名 `boundary-analysis.json` 与 `reconciliation-record.json` 可能缺失；本层只消除后者，前者按 §4.5 刻意保留为有损。

**并发 sweep 无需额外处理**：后到者被 `resumeLoop` 的租约门拒绝，记入报告，不是错误。

## 7. CLI 表面与退出码

| 退出码 | 条件 |
|---|---|
| `1` | sweep **未能开始或未能完成扫描**：参数解析失败（**含 `--max-runs` 缺失、非正整数、无法解析**）、`--adapter-config` 读取/解析失败、`scanRootFailureDetail(rows, root)` 返回非 `undefined`（root 不存在或不可读） |
| `0` | 其余一切，**包括**某个 run 跑成 `exhausted` / `failed` / 被门拒绝、以及扫描 issue 行 |
| `130` | 收到**第二次**停机信号（SIGINT 与 SIGTERM **合并计数**，见 §5.4）的强制退出 |
| `2` | **不使用。** sweep 分支必须在 `finalState.status === "succeeded" ? 0 : 2` 那**两处**映射之前返回 |

```bash
grep -rnF 'succeeded" ? 0 : 2' src/
# 实测 2 处：src/cli.ts:131（resume 分支）、src/cli.ts:135（run 分支）。
# 第一轮修订写「那个映射」是单数，实际是两处 —— sweep 分支必须在两处之前返回
```

**`scanRootFailureDetail` 是判据本身，不要重新发明**（第二轮评审）：§7 的「root 不存在或不可读 → exit 1」与 §8 的「扫描 issue 行 → 记录，不中断」在**根目录自身不可读**时重叠。`src/cli.ts` 的 `ls` 分支已经用这个符号区分了两者，sweep 分支照抄同一判据。

```bash
grep -n 'scanRootFailureDetail' src/cli.ts
# 实测 2 行：:7 import、:118 在 ls 分支内的使用；定义在 src/registry/renderRuns.ts
grep -nF 'export function scanRootFailureDetail(' src/registry/renderRuns.ts
```

前三行都归 `1`，理由一致：都是「sweep 没能干成它的活」。逐 run 结局进输出，不进退出码——一个 run 合法地跑到 `exhausted`，是 sweep 成功地处理了一个失败的 run。

**不加 `--json`。** sweep 的报告今天没有消费者。

## 8. 错误处理汇总

| 情形 | 反应 | 去向 |
|---|---|---|
| 参数解析失败（含 `--max-runs` 缺失/非法）/ adapter-config 读取失败 | exit 1，不扫描 | stderr |
| 扫描本身失败（`scanRootFailureDetail` 非 `undefined`） | exit 1，不跑任何 run | stderr |
| 扫描 issue 行（`directory_unreadable` / `depth_truncated`） | 记录，不续跑，不中断，**不影响退出码** | stderr |
| `ResumeNotEligibleError` | **正常结果**，不是错误 | stdout |
| **`ResumeNotEligibleError` 且 `cause` 是转移事务的具名拒绝错误** | **不是正常结果**：outcome `error`，detail 带 `cause.message` | **stderr** |
| `RunLeaseHeldError` | 正常结果（别人正在跑） | stdout |
| run 跑到任一终态 | 记录终态 + `stopReason` | stdout |
| run 因 `stop_requested` 或 `RunHeartbeatStoppedError` 返回非终态 | 记录为 `interrupted`，**明确标注该 run 仍可续跑** | stdout |
| 意料之外的抛错 | 记录**完整 message**，继续下一个 | **stderr** |

**转移事务具名拒绝为什么单开一行**（第二轮评审，Critical）：§4.4 的整条立论是「不可解析的 marker / 缺失的 pending 是**响亮**的失败」。但该错误从 `readOwnerRecord` 逃出后被 `resumeLoop` 的 `Promise.all` catch 统一改写成 `ResumeNotEligibleError`，若让它落进上一行的「正常结果 → stdout → exit 0」，**「响亮」在实际调用图上就不成立**，cron 的「有 stderr 即告警」永远不响。**§4.4 的立论靠这一行兑现，不靠错误类型本身。**

**报告格式（定死，因为没有 `--json`，人类可读形式就是全部契约）：**

- 每个尝试过的 run 一行，制表对齐三列 `path | outcome | detail`。
- `outcome` 取值域：`succeeded` / `failed` / `exhausted` / `blocked_waiting_human` / **`cancelled`** / `interrupted` / `refused` / `error`。

  **`cancelled` 是本轮补进取值域的**（第二轮评审：第一轮漏了它，而它是可达终态，实施者遇到只能瞎填）。

  ```bash
  grep -cF 'state, "cancelled"' src/controller/runLoop.ts   # 实测 4 —— 四个直接写终态的调用点
  grep -nF 'kind: "cancelled"' src/controller/runLoop.ts    # 实测 1 —— stopOn 命中经 decision.kind 走第五条路
  ```

  即 `cancelled` 今天有 **5 个**生产来源。`detail` 必须携带 `stopReason`。**它不归入 `failed`**：两者对操作者意味着不同的下一步（`failed` 是 run 自身失败，`cancelled` 是所有权/信号原因中止）。
- 末尾一行汇总：`<attempted> attempted, <succeeded> succeeded, <refused> refused, <errored> errored (quota <consumed>/<N>)`。
- 启动横幅格式：**`sweep: <eligible> eligible run(s) under <root>, will attempt at most <N>, adapter=<name>`**，**打印在扫描之后、adapter 构造之前**。

  **横幅必须同时显示 eligible 总数与配额 N**（第二轮评审）：§12 的整个论证是「操作者选 `--adapter claude` 即构成对该次 sweep 的**知情且有界**批准」，而知情的前提是横幅里有 N。第一轮的横幅里没有 N，论证悬空。

**sweep 从不静默吞任何一种结果**（Rule 12）。意外错误按 §7 不改退出码，但写到 stderr 以便被 cron 的「有 stderr 即告警」捞住。

## 9. 模块边界

| 模块 | 职责 |
|---|---|
| `src/sweep/sweepRuns.ts` | 扫描 → `scanRootFailureDetail` 判据 → 过滤 → 排序 → **按 `--max-runs` 截断遍历** → 顺序续跑 → 汇报。**纯函数，接收信号槽与配额 N，自身无 writer、不装信号处理器** |
| `src/cli.ts` | `sweep` 分支、参数解析（**含 `--max-runs`**）、**可注入的信号处理器注册 `registerStopHandlers(signal, { exit = process.exit })`**、退出码映射 |
| `src/controller/resumeLoop.ts` | 追加可选信号参数并向 `runLoopFromState` 透传；**`Promise.all` 的 catch 改写为 `new ResumeNotEligibleError(msg, { cause: error })`**（§8 的路由依赖它） |
| `src/controller/runLoop.ts` | 信号槽检查点；`ReconciliationDraft` 的组装（**不含 `newOwnerEpoch`**）；`persistOwnerTransfer` 内用 `applyOwnerEpochTransfer` 的输出补齐 `newOwnerEpoch` 并透传；赢家路径 `writeBoundaryArtifacts` 改传 `undefined`；**新增 `RunHeartbeatStoppedError` 分支（不写终态，返回非终态 `state`）**；`runExclusive` 注释那一条的连带更新 |
| `src/controller/leaseHeartbeat.ts` | `runExclusive` 拒绝 + 其上方注释 |
| `src/persistence/fileStore.ts` | 三文件事务、**marker 原子写（temp + rename）**、marker 驱动 finalize、`cleanupOwnerTransferStagingWithoutMarker` 从 4 扩到 7 个 `safeUnlink`、finalize try 首与 catch 尾各从 2 扩到 3 个对称 unlink |
| `src/ownership/lease.ts` | `RunHeartbeatStoppedError` |

**`isLeaseStopError` 的谓词与签名不改**（§5.3 选了方案 (a)）；只改 `runExclusive` 上方那条注释。

`src/registry/` **零改动**。

⚠️ **签名改动的爆炸半径**：`writeOwnerTransferArtifacts` 若加**必需**参数，会打断 `tests/persistence/fileStore.test.ts` 的直接调用与 `tests/controller/leaseLifecycle.integration.test.ts` 的若干 `Parameters<typeof ...>` 包装。计划必须显式安排这批测试的更新，或把参数设为可选并说明。

```bash
grep -cF 'writeOwnerTransferArtifacts(' tests/persistence/fileStore.test.ts   # 实测 17 —— 直接调用
grep -rnF 'writeOwnerTransferArtifacts' tests/                                # 实测 34 行，含 import 与包装
```

（**第二轮评审更正**：第一轮写「`fileStore.test.ts` 十余处直接调用」，旁边附的却是 `grep -rnF ... tests/ | wc -l`，实测 **34** —— **命令不重推它旁边的数字**。上面两条各自重推自己那个数，且按 §4.2 的纪律改用 `grep -c` 而非 `| wc -l`。）

## 10. 测试要求

**债 1**

1. **修复后行为**（初稿把它写成「证明修复前拒绝、修复后不再」，而一条提交的测试只跑一棵树，那不可表达）：驱动**生产**转移路径并注入 `assertHeld` 抛出，断言 `reconciliation-record.json` 已在盘上且 `resumeLoop` 放行。它变红的方式由测试 6 的变异提供。
2. **崩溃注入**：用本仓库既有手法（`vi.resetModules()` + `vi.doMock("node:fs/promises", …)`，见 `tests/persistence/fileStore.test.ts`）在 finalize 的每一个间隙中断，断言每个中间态都让 `resumeLoop` 拒绝、且 marker 仍在时恢复能推完。

   **⚠️ mock 面必须含 `unlink`**（第二轮评审）：finalize 九步里有 **5 个 `safeUnlink`**，`safeUnlink` 走的是 `node:fs/promises` 的 `unlink`。

   ```bash
   grep -nF -A8 'async function safeUnlink(' src/persistence/fileStore.ts
   grep -n 'from "node:fs/promises"' src/persistence/fileStore.ts
   # 实测：safeUnlink → unlink；unlink / rename / writeFile 同自 node:fs/promises 导入
   ```

   只 mock `rename` / `writeFile`（第一轮的字面写法）**做不出步 7 之后的两个间隙**——正是测试 6c 需要的孤儿 pending 状态——测试 2 会悄悄退化成七个间隙。

   **⚠️ 区间必须写全**（第二轮评审）：`finalizePendingOwnerTransfer` 在 try **之前**还有 2 次（v2 之后 **3** 次）`readFile` + `JSON.parse`，那些间隙**不在九步内**，而 §4.4 新增的拒绝逻辑正是落在那个位置。

   ```bash
   grep -nF -A4 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
   # 实测：try 之前 2 次 readFile + JSON.parse（本层之后 3 次）
   ```

   **测试 2 的完整区间 = 「try 之前的 3 次 `readFile` + `JSON.parse`」＋「try 内的每一步」的每一个间隙。**

   try 内的步数：**改动前 9 步** = 2 个 temp 清理 + 2×(`writeJsonFile`, `rename`) + 3 个尾部 `safeUnlink`（marker、transferPending、ownerPending）＝ 2 + 4 + 3。
   **改动后 13 步** = 3 个 temp 清理 + 3×(`writeJsonFile`, `rename`) + 4 个尾部 `safeUnlink`（marker、三份 pending）＝ 3 + 6 + 4。

   **实施者必须按最终落地的代码重数一遍并在计划里附命令**（`grep -nF -A26 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts`），**不要照抄本段的 9 或 13**——13 是本 spec 按设计推出来的，不是从已存在的代码数出来的。

   **⚠️ fixture 必须有两组**（第二轮评审，为测试 6b 服务）：**(i) 首发转移**（`owner-transfer.json` 事前不存在）；**(ii) 双转移**（N→N+1 已成功落盘，N+1→N+2 崩在中途）。理由见测试 6b。

3. **恢复**：v2 marker + 三个 pending → `readOwnerRecord` 触发恢复 → 三文件就位。
4. **v2 marker 但 pending 缺失 → 拒绝 finalize、保留 marker 与 staging、抛具名错误**（这条取代初稿那条会把缺陷断言为正确的 v1 测试）。**该状态在生产中不可达**（§4.4），fixture 必须手工构造，测试注释要写明它钉的是纵深防御分支。
4b. **v1 marker + 两个 pending → 只发布两个，不抛。**
4c. **marker 不可解析 → 拒绝 finalize、保留一切、抛具名错误。** 同样是手工构造的纵深防御分支（marker 原子写之后不可达，§4.0.3）。
4d. **marker 原子写（§4.0.3 的承重断言）**：mock `rename` 在 marker 的那次 rename 上抛出，断言磁盘上**没有** `.owner-transfer.transaction.json`、只有 `.owner-transfer.transaction.tmp`；随后一次持锁入口把 tmp 回收干净。**变异：marker 退回 `writeJsonFile` 直写 → 本测试必须红。**
5. **`finalizeOrder` 承重 —— 必须手工 stage 一个被置换过的 v2 marker**（第二轮评审，Critical）。

   第一轮写的是「断言实际发布顺序等于 marker 声明的顺序」。**那是同义反复**：生产代码用同一组常量既生成 marker 又（在最自然的变异下）决定顺序，两者恒等；把 finalize 退回今天的硬编码形状，只要硬编码顺序与常量一致，测试依然绿。**而这是 §4.4 整个方案的支点**（§4.1 把「`finalizeOrder` 被写下却从未被读取」列为必须先说清的两个事实之一）。

   ```bash
   grep -nF -B2 -A6 'const marker: OwnerTransferTransactionMarker = {' src/persistence/fileStore.ts
   # 实测：finalizeOrder 由 [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE] 两个常量拼出
   grep -nF -A16 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
   # 实测：finalize 按硬编码顺序办事，从不读 marker
   ```

   **正确形状**：手工 stage 一个 `finalizeOrder` 与生产默认**不同**的 v2 marker，例如
   `["owner-record.json", "owner-transfer.json", "reconciliation-record.json"]`，
   加上与之匹配的三份 pending，然后断言 `rename` 的实际调用序列**逐项等于 marker 里写的顺序**。
   **这样「忽略 `marker.finalizeOrder`、按 version 硬编码」的实现必红。**
   （**注意 marker 只在全部 rename 之后才被 unlink**，所以 `rename` 的 mock 可在首次调用时读到它。）
6. **反方向变异**：reconciliation 退回事务外 → 测试 1 必须红；`finalizeOrder` 退回 `[reconciliation, transfer, owner]` → 测试 6e 必须红。**两侧各自单独变异都要红。**
6a. **暂存顺序不变式的承重测试（第二轮评审新增）**：§4.3 把「reconciliation pending 严格先于 marker」列为不变式，而第一轮**没有任何测试能证伪它**——第一轮测试 6 的后半句说「暂存顺序改成 marker 先于 reconciliation pending → 测试 4 必须红」，但**测试 4 是手工构造磁盘状态的测试，根本不执行 `writeOwnerTransferArtifacts`，换了暂存顺序它照样绿。**

   **正确形状**：mock 记录 `writeOwnerTransferArtifacts` 的写入序（按路径），驱动一次真实转移，断言 `.reconciliation.pending.json` 的写入**严格早于** marker 的 rename（marker 原子写之后，「marker 出现」的时刻是那次 rename）。**变异：把 marker 的暂存提到三份 pending 之前 → 本测试必须红。** 测试 6 的后半句已改指本条。
6b. **钉住真正承重的东西**：变异掉 `evaluateResumeEligibility` 的任一条 epoch 相等判定 → 测试 2 必须红。（§4.3 已论证承重的是这两条，不是排序。）

   **⚠️ 两条判据的杀伤 fixture 不同（第二轮评审，第一轮写「任一条」而没写 fixture 要求，判据 A 的变异会存活）：**

   - **判据 B**（`ownerRecord.currentOwnerEpoch === ownerTransfer.newOwnerEpoch`）：**任何**单转移场景都能杀。
   - **判据 A**（`reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch`）：**只有双转移 fixture 杀得掉**。单转移时，reconciliation 已发布而 transfer 未发布的那些间隙里 `owner-transfer.json` 尚不存在，`readOwnerTransferRecord` 直接抛、`resumeLoop` 在进门前就拒绝，**判据 A 根本没被求值，变异存活**。双转移下（N→N+1 已成功、N+1→N+2 崩在 transfer 发布之后），盘上是「reconciliation.newOwnerEpoch = N+1、ownerTransfer.newOwnerEpoch = N+2、ownerRecord.currentOwnerEpoch = N+2」，判据 B 通过、**只有判据 A 拒绝**——这才是唯一杀得掉它的形状。

   **所以测试 2 必须显式提供上面那两组 fixture，测试 6b 的变异要分别对两组各跑一次。**
6c. **孤儿回收**：中断在 finalize 成功尾部（marker 已删、pending 未删），随后走一次 **`claimOwnerRecordWithPrecondition`**，断言 **7 个** staging 路径全部被回收、无残留：三个 pending（`.owner-record.pending.json` / `.owner-transfer.pending.json` / `.reconciliation.pending.json`）与四个 temp（`.owner-record.publish.tmp` / `.owner-transfer.publish.tmp` / `.reconciliation.publish.tmp` / `.owner-transfer.transaction.tmp`）。fixture 必须把这 7 个全部放上去。

   **⚠️ 第一轮写的是「三个 pending 与*两个* temp」——按那个字面写出来的测试，会在 `.reconciliation.publish.tmp` 泄漏时*变绿***，等于把泄漏断言为正确，与 §13 那条「不加第三个对称 `safeUnlink` 就会永久泄漏」的窄例外直接对撞。

   **⚠️ 驱动入口不能换成 `readOwnerRecord`**：`cleanupOwnerTransferStagingWithoutMarker` 只在 `options.lockHeld` 为真时被调用，而 `readOwnerRecord` 不传 `options`（见 §4.3 的可达条件与那条 grep）。用 `readOwnerRecord` 驱动，测试会因为「什么都没回收」而红，或更糟——被人改成断言「不回收」。
6d. **赢家不二次写**：断言赢家路径上 `writeBoundaryArtifacts` 之后 `reconciliation-record.json` 的 inode/mtime 未变。
6e. **输家不得覆盖赢家（第二轮评审新增，钉 §4.3 的排序改判）**：构造 P1 的事务中断在「transfer + owner 已发布、reconciliation pending 与 marker 仍在」；在该磁盘状态上驱动一次**输家**的 `writeBoundaryArtifacts`（`reconciliationRecord.eligibleForContinuation === false`、`newOwnerEpoch === null`）；断言盘上的 `reconciliation-record.json` **不是**降级版本（`preserveSuccessfulReconciliationIfNeeded` 的保护判定成立）；随后让恢复推完，断言 `resumeLoop` 放行。

   **fixture 必须让 `.owner-transfer.lock` 在窗口内存在且由一个活着的 pid 持有**（§4.3 排序改判第 2 步：P2 的 `readOwnerRecord` 靠这一点才不会替 P1 finalize）。

   **两条必须红的变异：**

   - **变异一**：把 `finalizeOrder` 改回 `[reconciliation, transfer, owner]` 并同步改中断点，使 P1 的窗口变成「reconciliation 已发布、transfer/owner 未发布」——此时 `readOwnerTransferRecordRaw` ENOENT → `readPersistedSuccessfulTransferArtifacts` 的裸 `catch { return null }` → 保护退化为无保护直写 → 输家的降级落盘 → `resumeLoop` **永久**拒绝。
   - **变异二**：把 fixture 里的锁文件删掉（模拟「锁的持有范围被收窄到只包 staging」）——P2 的 `readOwnerRecord` 会替 P1 finalize，窗口消失、断言的对象变了。**本测试必须察觉到这一点并红**，因为 §4.3 的论证第 2 步正建立在锁的持有范围上。

**债 3**

7. `runExclusive` 在 `stopped` 后拒绝；退回不拒绝 → 必须红。
7b. **被明写「接受」的退化的形状钉定（第二轮评审新增，§5.3 的 ⚠️ 指向本条）**：在 execute 超时无结果的路径上注入 `RunHeartbeatStoppedError`，断言 (i) **不调 `persistTerminalState`**（run 未被终结）、(ii) `execution-recovery.json` 的 `cleanupStatus` 未被回填、(iii) 返回的 `state.status` 仍在 `RESUMABLE_STATUSES` 内。**变异：把新错误放回 `isLeaseStopError` → (i) 与 (iii) 必须红**——这条变异同时也是 §5.3 选择 (a) 的护栏。
8. 信号槽置位 → `runLoopFromState` 在相位边界返回**非终态** state、追加 `stop_requested` 事件、不启动新 attempt。
8b. **`stop_requested` 之后，同一个 run 目录在下一次 sweep 中仍然 eligible**（这条是 §5.4 改判的承重断言）。**必须两条子用例**：(i) `releaseOwnerLease` **成功** → 立即 eligible（在 TTL 之内断言，否则一个只 `clearInterval` 的实现也能过）；(ii) `releaseOwnerLease` **抛出并被吞**（mock `updateOwnerRecordWithPrecondition` 抛 `OwnerTransferPreconditionError`）→ TTL 之内被 `checkRunLease` 拒绝、TTL 之后 eligible。**只测 (i) 不承重**（§5.4）。
9. `isLeaseStopError` 仍然**只**识别两种错误，`RunHeartbeatStoppedError` **不**被它识别（§5.3 方案 (a)）；把新错误加进去 → 测试 7b 必须红。（该谓词是模块私有的；若需导出，计划要写明。）

**sweep**

10. 只对观测为 eligible 的行调 `resumeLoop`。
11. 一个 run 被拒绝不中断后续 run（依赖 §6 的排序确定性）。
12. 参数错误 / adapter-config 错误 / 扫描失败 → exit 1；其余一律 exit 0（含 run 跑成 `exhausted`）。**`--max-runs` 缺失也走 exit 1。**
12b. **`--max-runs` 承重（第二轮评审新增）**：fixture 含 5 个 eligible 目录、`--max-runs 2`，断言 `resumeLoop` **恰好被调用 2 次**、且是排序后的前 2 个；横幅同时含 `5` 与 `2`。**另一子用例**：前 2 个目录都被门拒绝（`resumeLoop` 抛出）、第 3 个可跑，断言**第 3 个也被调用**——即拒绝不消耗配额（§6）。**变异：把配额改成「每次调用都计数」→ 第二个子用例必须红。**
13. 信号槽置位后不再开下一个 run（`sweepRuns` 层，纯函数，可自动化）。
13b. **第二次信号 → 130**：`registerStopHandlers(signal, { exit })` 注入一个假 `exit`，断言第二次信号（**SIGINT 与 SIGTERM 混合计数**，§5.4）调用了 `exit(130)`。

   **⚠️ 第一轮把这两件事写成一条测试（「信号槽置位后不再开下一个 run；第二次信号 → 130」），而后半句按字面不可表达**——`process.exit(130)` 装在 `cli.ts` 的处理器里，第一轮没给任何注入缝，而 §10 通用条又要求「变异注入点必须在生产代码/生产类型上」。**本仓库有案底：一个测试名讲两件事、只有一件有断言。** 本层的处置是**把逃生口做成可注入形状**（`registerStopHandlers` 的第二参数，已进 §9 模块表），并拆成 13 / 13b 两条。
14. **写面钉定（取代空洞的「零写入」）**：对一个**观测 eligible 但门拒绝**的 run 目录，断言它**恰好**新增 `resume_requested` + `resume_denied` 两行事件、**其余字节不变**。

   **⚠️ 「恰好两行」只在被显式规定的 fixture 下成立（第二轮评审，Critical，两种独立机制）：**

   - **机制一**：若 owner record 的 `leaseAffirmedAt` 非 `null` 且已过 TTL，`checkRunLease` 会**先追加 `lease_expired_observed` 再放行**（§3 第 2 条那条 grep 只扫 `resumeLoop.ts`，结构上看不到 `leaseGate.ts`）。**fixture 必须把 `leaseAffirmedAt` 设为 `null`，走 `no_lease` 分支。**
   - **机制二**：`resumeLoop` 的 `Promise.all` 调 `readOwnerRecord`，它第一条语句就是 `recoverInterruptedOwnerTransfer` —— 可能 finalize 一个待决事务（本层之后是 3 rename + 若干 unlink），§4 之后还会多写 `reconciliation-record.json`。**L2 早把这个坑标出来了**：L2 §7.1 专门**禁用** `readOwnerRecord`、改用 `readOwnerRecordWithoutRecovery`，而 sweep 走的 `resumeLoop` **没有**那层保护。**fixture 必须规定目录内无任何 staging 残留**（marker、三个 pending、四个 temp 全部不存在）。

   ```bash
   grep -nF -A2 'export async function readOwnerRecord(' src/persistence/fileStore.ts
   grep -nF -B4 'export async function readOwnerRecordWithoutRecovery(' src/persistence/fileStore.ts
   ```

   **伴生断言（措辞已按第二轮评审改明确）**：fixture **必须再包含第二个*非* eligible 的 run 目录**；主断言是**那个非 eligible 目录**字节不变。变异：若 sweep 改为对非 eligible 行也调 `resumeLoop`，**那个非 eligible 目录**就会变 → 断言必须红。（第一轮写「该目录就会变」，按句法指向前半句那个 eligible 目录，而变异实际改变的是非 eligible 那个。）
14b. **恢复确实发生且被记录（第二轮评审新增，与 14 配对）**：对一个刻意 staged 触发恢复的 **eligible** 目录（构造照搬 L2 §12.1：marker present、`.owner-record.pending.json` 与 `.owner-transfer.pending.json` present、`.owner-transfer.lock` **absent**，本层再加 `.reconciliation.pending.json`），断言 sweep 之后 (i) 三个文件全部就位、(ii) marker 与全部 pending 已被回收、(iii) `resumeLoop` 放行。**这条把「sweep 会导致恢复」从一个被隐藏的事实变成一个被断言的事实。**

   ```bash
   grep -nF -A14 'Zero-write proof.' docs/superpowers/specs/2026-07-28-run-registry-design.md
   # L2 §12.1 的 fixture 前提集，逐条照搬
   ```

**通用**

- 变异注入点必须在**生产代码 / 生产类型**上。
- 反方向变异：只改 A 侧失败、只改 B 侧也失败。
- 写区间必须带样本数。
- 测试 1 / 5 / 6e 需经 `runLoop` / `runLoopFromState` 驱动（`persistBoundaryAnalysis` **未导出**）；**不要为此导出它**。测试 5 / 6e 里手工构造磁盘状态的那部分可直接调 `fileStore` 的导出面。
- **凡是断言「恰好 N 行事件」的测试，都必须在同一条里写明 fixture 的前置条件**（`leaseAffirmedAt`、staging 残留），否则那个 N 是环境依赖的。

## 11. 执行约束

- **§4（债 1）是独立的一节、独立的任务组、独立的评审，且必须先于 §6 的触发逻辑完成并通过评审。**
- 每任务一次独立评审 + 整分支一次；**修复波之后必须再评审**。
- **评审必须对着代码撞，不接受实施者自证。**
- **验证跑绝不过滤输出**——`tail` 与 `grep` 同罪。
- **计划不附完整可抄代码。**
- **每一个算出来的数字旁边就地附一条能重推它的命令。**
- 跑全套件时**只有 flake (B) 与 (F) 允许出现**；名单外任何失败先捕获完整测试名与失败块。
- 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`。
- **L1 spec §12 的十九条约束一条都不得弱化**（L2 成功标准 4 的原样继承）。

  **重点核查名单（第二轮评审：第一轮的名单漏掉了两条与本层改动最直接相邻的，且名单本身没附选取依据）：第 2 / 4 / 5 / 6 / 7 / 15 / 17 / 19 条。**

  **选取依据（本轮补，逐条给）：**

  | 条 | 为什么它与本层直接相邻 |
  |---|---|
  | 2 | 进程身份比较——`RunHeartbeatStoppedError` 与 sweep 的多进程形态都踩它 |
  | **4**（新增） | 「after `stop()` no further *heartbeat* write occurs …… **assert the absence of affirms, not the absence of writes**」——**全 19 条里唯一直接规定 post-`stop()` 契约的一条**，而 §5.3 改的正是 `stop()` 之后的语义 |
  | 5 | 心跳跨自身写入存活——`runExclusive` 加拒绝后必须仍然成立 |
  | **6**（新增） | 「a second `resume` against a live-lease run is refused, and the run directory is unchanged **except for appended events** …… **and no interrupted-transfer recovery ran**」——它既是 §10 测试 14 的原型，**又**是被 §4「让恢复多写一个文件」直接威胁的对象 |
  | 7 | 「corrupt is not absent」——§4.4 的 marker / pending 解析路径同形 |
  | 15 | 「转移之后立刻 resume 不被拒」——正是 sweep 每一次要走的路 |
  | 17 | 「跑完的 run 释放租约」——§5.4 的 8b 直接依赖它，且 §5.4 已指出释放是尽力而为 |
  | 19 | 「`assertHeld` 从不被节流」——§4 在事务里多了一个文件，不得因此改变 assertHeld 的频次语义 |

  **第 9 与第 12 条也值得顺带核**（9：被挡住的副作用「就地放弃而非回滚」，与 §5.3 方案 (a) 的返回非终态同形；12：`lease_expired_observed` 事件在两种情形下都必须存在，与 §3 第 2 条的写入清单直接对应）。**但这是「重点核查」，不是把其余十一条豁免**——十九条减去八条重点＝**其余十一条**仍然全部适用。

  ```bash
  grep -n '^[0-9]\+\. \*\*' docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md
  # 实测 exit 0，21 行。**不要直接 -c 取这个数**：其中两行是 §6 的两个心跳写者
  # （"Wall-clock timer" / "Event-driven refresh"），§12 的清单是从 "Pure predicate"
  # 开始的那一段连续 1–19。这条命令刻意打印全部行而非计数，就是为了让读者看见这两行。
  grep -nF -e '4. **Heartbeat under fake timers**' -e '6. **Mutual exclusion**' \
           docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md
  # 本轮新增进重点名单的两条，各自定位
  ```
- **所有编辑落地之后，全仓扫一遍指向被改文件的行号引用。**

## 12. 治理与付费调用

`ccloop sweep --root <root> --adapter claude` 挂进 cron 就是无人值守的付费调用。

**本设计的表态**：操作者选择 `--adapter claude` 即构成对该次 sweep 全部续跑的批准。为使批准**有界**且知情：

- 启动横幅（§8）必须在扫描之后、adapter 构造之前打到 stderr，**同时写明 eligible 总数、配额 N、root 与 adapter**。少了 N，「知情」就不成立。
- **`--max-runs <N>` 为必需参数**，sweep 处理满 N 个即停。无界的「全部批准」不构成有界批准。
- **配额只对实际进入 `runLoopFromState` 的 run 计数**（§6）。被门拒绝的 run 一次付费调用都没发生，让它吃掉配额既不符合「界的是付费调用」这个目的，又会造成确定性饿死。

**`--max-runs` 的完整落地面（第二轮评审：第一轮只在本节写了它，定义 CLI 形状的五节一次都没提，导致这条治理要求实际上不可实施）**：§6 调用式与流水线、§7 退出码表（缺失/非法 → exit 1）、§8 横幅与报告汇总行、§9 模块表、§10 测试 12b。

**本节不界的东西，明写出来**：`--max-runs` 界的是**付费调用**，不界事件追加。一次 sweep 扫到 M 个永久被拒的 run 仍会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件（无退避、无上限、无标记，理由与代价见 §6），**这一笔具名传给 L5**（§13）。

## 13. 继承债与不做的事

| 债 | 本层处置 |
|---|---|
| 1 跨文件事务性 | **本层修**（§4） |
| 2 `persistTerminalState` 往已不拥有的 run 写 | **不碰**，留 L5 |
| 3 `heartbeat.stop()` 释放窗口 | **本层修**（§5），**在 exclusive span 内关闭；span 外部分具名传 L5**（下面第 3 笔） |
| 4 非原子写 | 已于 `2026-07-29-atomic-write-paths` 关闭并合并 |

**术语先说清（第二轮评审：第一轮本节首段写「L5 的继承清单确认为 1 笔」、末段写「留给 L5 具名继承的两笔」、§14 第 1 条又写「输入是债 2 + 两笔」= 3，同一节内自相矛盾）：**

- **归属裁决把「技术债」清单降到 1 笔**（只剩债 2）。降到 1 笔是 2026-07-29 那次归属裁决做的，不是本层做的；本层兑现其中的债 1 与债 3，使这份清单不再回涨。
- **本层另行具名了若干「查实、明确不处理」的项**，它们不是那次裁决口径下的「技术债」，但同样要交接。
- **L5 的输入合计 = 债 2 ＋ 下面具名的 5 笔 = 6 项。**（§14 第 1 条已同步。**这个数字随本节末尾的清单条数变化，改清单必须同时改这里。**）

**关于债 2**：§5.4 改判为不写终态，**且 §5.3 选了方案 (a)**（`RunHeartbeatStoppedError` 不进 `isLeaseStopError`，另设不写终态的分支），所以本层既不新增 `persistTerminalState` 调用点，也不让任何**既有**调用点被一类新错误触达。**本层对债 2 的接触面为零。**

**⚠️ 这个结论依赖 §5.3 选 (a)。** 第一轮修订在选 (a) 之前就写了「接触面为零」——那时它不成立：§5.3 会让两个既有调用点被 `RunHeartbeatStoppedError` 触达，而债 2 恰是「`persistTerminalState` 往已不拥有的 run 写」。**若将来有人把方案改回 (c)，本段必须一起改。**

**`finalizePendingOwnerTransfer` 的 catch —— 一条明确的窄例外（数目已按 marker 原子写重数）。** 初稿承诺「不触碰 catch 块的形状」。评审证明那做不到：不给 catch 加第三个对称 `safeUnlink`，`.reconciliation.publish.tmp` 会在终态失败路径上永久泄漏，且没有任何别处回收它。

**本层的表态与准确数目：**

- `finalizePendingOwnerTransfer` 的 **try 首**：`safeUnlink` 从 **2 个（transferTemp、ownerTemp）扩到 3 个**（加 `reconciliationTemp`）。
- `finalizePendingOwnerTransfer` 的 **catch 尾**：同样从 **2 个扩到 3 个**。**不改变 catch 的形状与错误传播语义。**
- **marker 的 temp（`.owner-transfer.transaction.tmp`）不进这两处**：finalize 不写它，加进来就不对称了。它由 `cleanupOwnerTransferStagingWithoutMarker` 回收。
- `cleanupOwnerTransferStagingWithoutMarker`：**从 4 个 `safeUnlink` 扩到 7 个**（§4.3 已逐个具名）。

```bash
grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
grep -nF -A6  'async function cleanupOwnerTransferStagingWithoutMarker(' src/persistence/fileStore.ts
# 实测改动前：finalize try 首 2 个、catch 尾 2 个；cleanup 4 个
```

catch 那个「两个 `safeUnlink` 都可能替换正在传播的错误」的错误掩盖问题**原样留给 L5**（扩到三个之后是三个都可能），触发条件是「清理失败与转移失败同时发生」，与本层要修的窗口无关。

**本层查实、明确不处理、留给 L5 具名继承的五笔：**

1. **锁可被偷。** `tryRecoverStaleOwnerTransferLock` 在 `JSON.parse(lockContents)` 抛**且** `hasStagedArtifacts` 为真时，才删锁返回 true。

   ```bash
   grep -nF -A18 'async function tryRecoverStaleOwnerTransferLock(' src/persistence/fileStore.ts
   grep -nF -A14 'const handle = await open(lockPath, "wx");' src/persistence/fileStore.ts
   ```

   **场景需要两个前提，第一轮只写了一个（第二轮评审补齐）：**

   - **前提一**：`open(lockPath, "wx")` 之后、`handle.writeFile` 之前的锁文件恰好是**零长度、不可解析**——夺锁者的 `JSON.parse` 因此进 catch。
   - **前提二（第一轮省略）**：catch 分支还要求 `hasStagedArtifacts` 为真（marker 或任一 pending 存在）。**而零长度锁窗口内新持有者尚未 staging 任何东西**，所以场景**还需要一次前一次崩溃留下的残余 staging**。

   两个前提同时成立时，一个**活着的**持有者可能被夺锁，两个进程并发写入同一组固定 pending 文件名。今天由 epoch 不等挡住；本层之后，若 A、B 都从 epoch N 起算，两者的 `newOwnerEpoch` 都是 N+1，**epoch 三元组会通过**，得到一份「reconciliation 来自 A、transfer 来自 B」的记录——证据记录会对转移原因撒谎。**这是先于本层的缺陷，但 §4 扩大了它的影响面，故在此具名。** 不在本层修，因为修它要动锁协议本身。
2. **execute 相位 abort 后无第二重超时上界**（§5.4 的 ⚠️）。
3. **债 3 在 exclusive span *外* 的那一段。** `runExclusive` 的拒绝只覆盖进入 `queue` 的 span，而 `persistBoundaryAnalysis` 里 `runExclusive` 返回之后的 `assertHeld()` + `writeBoundaryArtifacts` 明确留在 span 外（代码注释自己写着 "`writeBoundaryArtifacts` below stays OUTSIDE"）。**一次并发 `stop()` 可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`。** 见 §5.2 的范围声明。本层不修，因为覆盖它要么把 artifact 写搬进 span（L1b 刚明确否决过），要么另设一层守卫。
4. **三份 pending 的非原子写。** 三份 pending 走裸 `writeJsonFile`，而 `finalizePendingOwnerTransfer` 在 try **之前**就 `JSON.parse` 它们；一份被写坏（截断）的 pending 会让该 run 的 `readOwnerRecord` **永久抛**，marker 仍在盘上，本层无自动恢复入口（见 §4.4）。**这是先于本层的缺陷**——今天已有两份 pending 这样被解析——**本层把它从两份扩到三份，扩大了影响面**。修法与 §4.0.3 的 marker 完全同形（temp + rename），但人对 §4.0.3 的裁定只覆盖 marker，按 Rule 2 / Rule 3 本层不扩范围。
5. **被拒 run 的无退避重捡。** registry 不观测 `reconciliation-record.json`，所以「transfer eligible 但 reconciliation 不合格」的 run 会被**每一次** sweep 重新捡起、每次追加 2～3 行事件，无退避、无上限、无标记。见 §6 与 §12。

（**清单是 5 条**；加上债 2，L5 的输入合计 **6 项**，与本节开头及 §14 第 1 条一致。**改清单必须同时改这三处数字。**）

## 14. 后续

1. **L5 — cleanup / orphan handling**（父设计 §17 item 3）。**输入合计 6 项 = 债 2 ＋ §13 具名的 5 笔**（锁可被偷、execute abort 无第二重上界、债 3 的 span 外部分、三份 pending 的非原子写、被拒 run 的无退避重捡）。**这个数字与 §13 的清单联动，改一处必须改两处。**
2. **常驻形态**（`watch`）：会让「飞行中 `stop()`」重新成为问题，§5.2 的论证是起点。
3. **execute abort 的 SIGKILL 升级**：独立任务，独立评审。

## 15. 验收标准

1. **没有任何生产路径**能产生一个**持久的**「transfer 已发布、reconciliation 缺失」磁盘状态。（初稿写的「该状态不可构造」是假的——任何人都能 `writeFile` 出来，而且测试 2 必须能构造它。）

   **⚠️ 「持久的」三个字是本轮按 §4.3 排序改判加上去的，不得省略。** 新排序 `[transfer, owner, reconciliation]` 下，该状态是一个**真实的瞬时窗口**；判定它是否可接受的标准是：**该窗口内 marker 必在盘上**（marker 的 `safeUnlink` 排在三次 rename 全部完成之后），因此恢复必然推完。次生后果——`resumeLoop` 的 `Promise.all` 可能在恢复完成前读到 reconciliation ENOENT，使**该次** sweep 拒绝、下一次通过——**本层明确接受**，它是瞬时且自愈的 liveness 抖动，不是安全洞。
1a. **输家不得覆盖赢家已发布的 reconciliation**（本轮新增，钉 §4.3 的排序改判）：在「transfer + owner 已发布、reconciliation 尚未发布」的窗口内，一次输家的 `writeBoundaryArtifacts` 不得把 `reconciliation-record.json` 降级为 `eligibleForContinuation: false`。测试 6e 承重；把 `finalizeOrder` 改回 reconciliation 优先则测试 6e 变红。
2. 事务的每一个崩溃中间态都让 `resumeLoop` 拒绝；marker 仍在的中间态都能由 `recoverInterruptedOwnerTransfer` 推完。

   **已知例外，全部在此具名（本轮补全三条；第一轮只有前两条，而 §4.4 规则 2/3 制造的状态不在名单里，与本条的「都能推完」直接冲突）：**

   1. **marker 缺失的窗口**——恢复无从判断有没有待决事务，只能在持锁入口回收 staging。
   2. **`!lockHeld` 且锁文件存在、`isProcessActive` 为真**时恢复会跳过。`isProcessActive` 对 `ESRCH` 以外的任何错误——含 `EPERM`——返回 true，故被回收的 pid 会把事务钉成暂不可恢复。
   3. **pending 文件被写坏（截断）**——`finalizePendingOwnerTransfer` 在 try 之前 `JSON.parse` 三份 pending，parse 抛出会一路逃出 `readOwnerRecord`，而 marker 仍在盘上，于是**每一次** `readOwnerRecord` 重复同一次抛出。**这是先于本层的既有缺陷，本层把它从两份 pending 扩到三份。本层无自动恢复入口**，恢复手段只有人工删除该 run 目录下的 staging；具名传 L5（§13 第 4 笔）。
   4. **§4.4 规则 2 / 3 的两个 fail-closed 分支**（v2 marker 但 pending 缺失；marker 不可解析）——**按 §4.0.3 的原子写与暂存顺序不变式，两者在生产中不可达**，分支保留为纵深防御。若有人手工构造出它们，同样是「marker 仍在但推不完」，恢复手段同第 3 条。

   **本条不得再用「可恢复」一词描述上面任何一种状态**，除非同时给出恢复它的代码路径。
3. `runExclusive` 在 `stopped` 后必然拒绝；退回旧行为则测试 7 变红。
4. **`stop_requested` 或 `RunHeartbeatStoppedError` 中断过的 run，在下一次 sweep 中仍然 eligible。** 准确表述（本轮按 §5.4 改写；第一轮写成无条件「仍然 eligible」，而 `stop()` 里的 `releaseOwnerLease` 是 `try{}catch{}` 包着的 CAS，会失败）：**租约释放成功后立即 eligible；释放失败则最迟 `LEASE_TTL_MS` 之后 eligible。** 两条子用例都由测试 8b 覆盖，只测顺利路径不算达标。
5. `evaluateResumeEligibility` 的八条判据一个字节未改。

   **⚠️ 本条必须有钉住手段，第一轮一个都没有（第二轮评审）**：§3 第 3 条的 `grep -c 'return { ok: false'` 只能数条数、数不出内容——把 `!==` 改成 `>` 仍然是一条 `return { ok: false`，计数不变；§10 里也没有对应测试。

   **本层定的手段（两条并用，缺一不可）：**

   1. **计数守卫**：`grep -c 'return { ok: false' src/controller/resumeLoop.ts` **必须仍为 8**。
   2. **函数体哈希守卫**：提取 `evaluateResumeEligibility` 的函数体并比对一个写死在测试里的哈希；改动任何一个字节即红。

   **⚠️ 哈希守卫必须连同防护栏一起实现，否则它会静默假通过。** 本仓库踩过这个坑：两个评审员各自写函数体哈希提取器时都中招，靠「函数体过短就报错」的防护栏才把静默的假通过变成被抓住的错误。**强制要求：**

   - 提取器在函数体行数 **< 20** 时**必须抛错**，不得返回一个短字符串去算哈希。

     ```bash
     grep -nF -A30 'export function evaluateResumeEligibility(' src/controller/resumeLoop.ts
     # 实测：签名在 :39，函数体（含首行解构、八条 return、末行 return { ok: true };）
     # 占 :40–:67 共 28 行，闭合大括号在 :68
     ```

     阈值定在 20 而不是 27，是为了留出「将来合法地删掉某几行空行」的余量，同时离「配平错误时提取出的 1 行」远到不可能撞上。**实施者若发现实际行数已跌到 20 附近，要连同阈值一起重定，不许直接调低阈值让它过。**
   - 提取器必须**同时**断言提取出的文本包含全部八个 `return { ok: false`，否则报错。这条让「配平算法把大括号数错」这类失败**响亮地**失败，而不是算出一个稳定但错误的哈希。
   - **不要假定签名行里没有大括号。** 本轮实测当前签名是 `export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility {`，返回类型是具名别名、不含大括号；**但把返回类型内联成 `{ ok: true } | { ok: false; reason: string }` 是一个完全可能的将来重构**，那时朴素的配平提取器就会在签名行上提前收敛。上面两条防护栏在两种签名下都必须成立。
6. sweep 对一个被门拒绝的 run 目录**恰好**新增 `resume_requested` + `resume_denied` 两行事件、其余字节不变，且该断言是承重的（测试 14）。

   **⚠️ 「恰好两行」只在测试 14 显式规定的 fixture 下成立**（本轮收窄；第一轮把它写成了无条件断言，两条独立机制各自证伪它）：fixture 必须满足 **(i) `leaseAffirmedAt` 为 `null`**（否则 `checkRunLease` 会多写一行 `lease_expired_observed`），**(ii) 目录内无任何 staging 残留**（否则 `resumeLoop` 的 `readOwnerRecord` 会触发恢复，写文件而不只是事件）。两条前提必须在测试里被断言，不得默认。
6b. **恢复确实发生时被断言，而不是被回避**（测试 14b）：对一个刻意 staged 触发恢复的 eligible 目录，恢复必须发生、三文件就位、staging 被回收。
7. **§11 的实施顺序硬约束有验收面**（本轮新增；第一轮的「§4 必须完成并通过独立评审之后 §6 才可开始」在 §15 里没有任何验收面，分支合并时无人能据 §15 判定它被遵守过）：**§4 任务组的独立评审报告，其提交时间必须早于 §6 任务组的第一次提交。** 合并前用一条命令核：

   ```bash
   git log --reverse --format='%h %ad %s' --date=iso -- src/sweep/ src/cli.ts
   git log --reverse --format='%h %ad %s' --date=iso -- docs/superpowers/reviews/
   # 前者的第一条（§6 任务组的第一次提交）必须晚于后者中 §4 评审报告那一条
   ```

   若评审报告不落盘为文件，则改用「§4 任务组最后一次提交 → §6 任务组第一次提交之间存在一条评审记录」的等价证据，**但必须落在仓库里、可被这条命令看见**。口头评审不算。
8. 全套件、typecheck、build 三者退出 0，且输出**未经任何过滤**地贴出。

## 16. 第一轮修订索引（2026-08-01，三个独立评审员）

初稿的 Critical 级缺陷，逐条对应本文修订处。**本表的第 11 行在第二轮被判定为错误结论，已就地更正（见下面表内注）；其余各行仍然有效。**

| # | 初稿缺陷 | 修订处 |
|---|---|---|
| 1 | 「七条判据」实为**八条** | §3 第 3 条 |
| 2 | 「`runExclusive` 两个生产调用点、在 `runLoopFromState` 内」两头都错，实为**一个**、在 `persistBoundaryAnalysis` 内 | §5.3 |
| 3 | §4.4 选「pending 存在性驱动」会**静默发布降级提交且不可恢复**，且旧测试 4 把该状态断言为正确 | §4.4 **改判为 marker 驱动** |
| 4 | 孤儿 pending / temp 的回收路径（`cleanupOwnerTransferStagingWithoutMarker`、catch 尾）完全不在改动清单里 | §4.3 表、§13 |
| 5 | `stop_requested` 写终态会**永久杀死正在飞行的 run** | §5.4 **改判为不写终态** |
| 6 | 「零写入」声明为假，其测试空洞 | §3 第 2 条、§10 测试 14 |
| 7 | 只引了 `runExclusive` 注释的前半句，而后半句正好禁止本改动 | §5.3 |
| 8 | 裁决记录留给 L3 的问题 1 从未点名 | §4.0a |
| 9 | `parseArgs` 解析不了 `sweep <root> --flag` | §6 改用 `--root` |
| 10 | §4.3 把「排序」当承重论证，实际承重的是两条 epoch 相等判定 | §4.3 |
| 11 | S-3 退路完全遗漏 | §4.0.1–4.0.3 |
| 11b | ~~「更宽不是更窄」只驳倒了裁决记录两条依据中的一条~~ **本行的后半句在第二轮被判定为伪造的论证结构**：裁决记录对「更窄」只给了**一条**依据（`assertHeld` 是写者），**这条成立**；「`newOwnerEpoch` 的排序主张」是裁决记录中一条**独立的否决**，不是「更窄」的依据，是第一轮修订自己造出来再打倒的。**不要把这一行当成「已修好」继承下去。** | §4.0.4（就地更正） |
| 12 | 「先于触发逻辑」的实施顺序强制被漏掉 | §4 节首、§11 |
| 13 | 「无人读 `boundary-analysis.json`」用收窄的 grep 支撑了绝对断言 | §4.5 |
| 14 | 「不加 `-F` 会 exit 2」是抄来的、未跑过的假主张 | §4.6 |
| 15 | 把 L1 §12 的十九条悄悄收窄成六条 | §11 |
| 16 | 测试 1 按字面不可表达；§15 第 1 条「不可构造」为假 | §10 测试 1、§15 验收 1 |

（第 15 行的修订处在第二轮又被改了一次：重点名单从六条扩到八条，「其余十三条」相应变为「其余十一条」——**「十九」这个总数未变**。见 §17 的 F39。）

## 17. 第二轮修订索引（2026-08-01，三个新的独立评审员 + 控制器回代码复核）

**背景**：§16 那一波修复完成后又派了三个错开视角的独立评审员，撞出 47 条；控制器逐条回代码核过承重的那些。**本仓库六轮 100% 命中「修复波自带缺陷」**——第一轮修复新写的 §4.0a 与同文档新写的 §4.1 直接打架（F5），新写的 §4.3 引入了一条比债 1 更糟的永久损坏路径（F6）。**本表是第三轮再评审的清单。**

| # | 级别 | 缺陷摘要 | 修订处 |
|---|---|---|---|
| F1 | Critical | §4.0 伪造裁决记录的论证结构：把「更窄」说成有两条依据、其中 (a) 被驳倒；实际「更窄」只有一条依据且成立，(a) 是另一条独立否决 | §4.0.4、§16 第 11/11b 行 |
| F2 | — | S-3 被命中过一次的过程与解除方式未记录 | §4.0.3 |
| F3 | Minor | 「裁决记录原文」与「本层就地定义的触发条件」版式未分 | §4.0.1 / §4.0.2 拆节 |
| F4 | Minor | §4 节首把两处拼接冠以「原文」 | §4 节首（改写为「两处合起来」，各附定位命令） |
| F5 | Important | 「两次 rename 加三次 safeUnlink」错（实为 2 rename + 5 safeUnlink，另一条路径 4 safeUnlink + 0 rename），且无重推命令 | §4.0a 理由 1 |
| F6 | **Critical** | reconciliation 排第一 + 赢家不补写 ⇒ 输家可**永久**覆盖赢家的 reconciliation（`transferRepresentsPublishedWinner` 的隐含默认被反转 + 裸 `catch { return null }`） | §4.3「排序改判」、§10 测试 6e、§15 验收 1a |
| F7 | Important | 事务前组装 ⇒ epoch 递增规则被复制成两份生产实现，漂移则债 1 以另一形式复活且无测试会红 | §4.3「组装点改判」、§4.2 表 |
| F8 | Minor | 「必须加上两个新路径」易被读成总数 | §4.3 表（逐个具名，4 → 7） |
| F9 | Important | 「reconciliation pending 严格先于 marker」无任何测试能证伪（测试 4 根本不执行 `writeOwnerTransferArtifacts`） | §10 测试 6a（新增）、测试 6 后半句改指 |
| F10 | **Critical** | marker 用裸 `writeJsonFile` 写；被解析之后截断的 marker 会永久拒绝该 run 的全部路径 | §4.0.3（人已裁定：改原子写）、§4.3 表、§4.4、§10 测试 4d、§13 |
| F11 | **Critical** | §4.4 规则 2/3 制造的「marker 仍在但推不完」状态不在 §15 验收 2 的具名例外里；「可恢复」无机制 | §4.4、§15 验收 2（四条例外全列，撤回「可恢复」） |
| F12 | **Critical** | 「响亮的失败」在实际调用图上不成立——被包成 `ResumeNotEligibleError` → stdout → exit 0 | §4.4、§8 错误表新增一行、§9（`cause` 透传） |
| F13 | **Critical** | 测试 5 是同义反复：同一组常量既生成 marker 又决定顺序 | §10 测试 5（改为手工 stage 置换过的 v2 marker） |
| F14 | **Critical** | 新错误进 `isLeaseStopError` ⇒ 两个既有调用点写 `cancelled`，把 §5.4 论证要防的永久终结从另一扇门放回来 | §5.3「改动 A 与 §5.4 的冲突」（选方案 (a)）、§9、§10 测试 7b/9、§13 |
| F15 | **Critical** | 推翻在先裁定的理由依赖「L3 让窗口可达」，而改判 B 恰恰使它不可达；且「那条裁定成立的前提是……」注释里没有 | §5.3（改写为「`assertHeld` 从不读 `stopped`，该命题没有 home」＋诚实的可达性表态） |
| F16 | Important | 「两侧穷尽」「债 3 关闭」忽略了 span 外的 `assertHeld` + `writeBoundaryArtifacts` | §5.2 范围声明、§13 表与第 3 笔 |
| F17 | Important | 「`stop()` 会清 `leaseAffirmedAt`」是无条件断言，实为被吞的 CAS | §5.4、§15 验收 4、§10 测试 8b（两条子用例） |
| F18 | Important | 停机点在 `attemptsUsed` 递增之前 ⇒ 无字节记录「被停过」，重复停机不消耗配额 | §5.4 ⚠️ 第 1 条（正面接受＋理由） |
| F19 | Important | 「人按过 Ctrl-C」只进 `events.jsonl`，registry 不观测它 | §5.4 ⚠️ 第 2 条（明写刻意放弃区分＋理由） |
| F20 | Minor | 「谓词本身要接受新错误」被降级为隐含 | §5.3（显式三条）、§9（选 (a) 后谓词不改，已写明） |
| F21 | Minor | 「同一信号」vs「SIGINT/SIGTERM」未定 | §5.4（合并计数）、§7 |
| F22 | **Critical** | `--max-runs` 必需，但定义 CLI 形状的五节一次都没提 | §6、§7、§8、§9、§10 测试 12/12b、§12 |
| F23 | Important | §8 outcome 取值域漏 `cancelled` | §8（补入＋5 个生产来源的重推命令） |
| F24 | Minor | 「那个映射」是单数，实为两处 | §7 |
| F25 | Minor | 「十余处直接调用」旁边的命令重推不出它（实测 34 / 17） | §9（改用两条各自重推的 `grep -c`） |
| F26 | Minor | §4.2 立「不接管道」纪律，§9 自己用 `\| wc -l` | §4.2（纪律收窄为「不接会截断输出的管道」＋统一改用 `grep -c`）、§9 |
| F27 | Minor | `scanRootFailureDetail` 从未点名 | §6 流水线、§7、§8 |
| F28 | **Critical** | §3 那条 grep 只扫 `resumeLoop.ts`，看不到 `leaseGate.ts` 的 `lease_expired_observed`；CAS 拒绝路径的文件系统副作用也未列 | §3 第 2 条（五条完整清单） |
| F29 | **Critical** | 「恰好两行、其余字节不变」为假（两种独立机制） | §10 测试 14（fixture 显式化）、测试 14b（新增）、§15 验收 6/6b |
| F30 | Important | 测试 6c 写「三个 pending 与两个 temp」，`.reconciliation.publish.tmp` 泄漏时会变绿 | §10 测试 6c（改为 7 个 staging 路径全列） |
| F31 | Important | 「变异任一条 epoch 判定」——判据 A 只有双转移 fixture 杀得掉 | §10 测试 2（两组 fixture）、测试 6b（分别变异） |
| F32 | Important | 测试 2 的 mock 面漏 `unlink`，做不出步 7 之后的两个间隙 | §10 测试 2 |
| F33 | Important | 「finalize 九步」漏掉 try 之前的 readFile + JSON.parse ——而那正是 §4.4 新逻辑的落点 | §10 测试 2（区间写全＋要求按最终代码重数） |
| F34 | Important | 测试 13 第二个分句按字面不可表达，且一个测试名讲两件事 | §10 测试 13 / 13b（拆开＋`registerStopHandlers` 可注入）、§9 |
| F35 | Important | §15 验收 5 没有任何钉住手段 | §15 验收 5（计数守卫＋哈希守卫＋三条防护栏） |
| F36 | Important | §5.3 明写「接受」的行为退化在 §10 里零断言 | §10 测试 7b（新增）、§5.3 ⚠️ |
| F37 | Minor | 测试 14 伴生断言的「该目录」指代含糊 | §10 测试 14（明写第二个非 eligible 目录为主断言对象） |
| F38 | Important | §11 的实施顺序硬约束在 §15 无验收面 | §15 验收 7（新增，附 `git log` 判据） |
| F39 | Important | 重点核查名单漏掉 L1 §12 第 4、6 条，且无选取依据 | §11（名单扩为 8 条＋逐条依据＋「其余十一条」算术同步） |
| F40 | Important | §13 内「1 笔 / 两笔」与 §14 第 1 条的「3」自相矛盾 | §13 术语段、§13 清单、§14 第 1 条（三处联动为 6 项） |
| F41 | Minor | 「锁可被偷」省略了 `hasStagedArtifacts` 这个前提 | §13 第 1 笔（两个前提写全） |
| F42 | Minor | §16 用了不存在的锚点 `§3.3` / `§3.2`（§3 没有小节，只有编号项） | §16 第 1、6 行；**顺带把同一类问题的其余本文档锚点一并规范化**：`§15.1`→「§15 验收 1」、`§15.2`→「§15 验收 2」、`§14.1`→「§14 第 1 条」、`§3.1`→「§3 第 1 条」。**指向 L2 spec 的 `§7.1` / `§12.1` / `§13.1` / `§6.3` / `§14.1` 不动**——那是 L2 自己的编号约定 |
| F43 | Minor | §4.6「必然早退」的理由已被 §4.3 作废 | §4.6（改为「赢家根本不再调用它」） |
| F44 | Minor | 「本层之后 `boundary-analysis.json` 可能缺失」是先于本层的既有事实 | §4.5（引 L2 §13.1 全句） |
| F45 | Minor | `cleanupOwnerTransferStagingWithoutMarker` 只在 `lockHeld` 为真时被调用，测试 6c 的构造依赖它 | §4.3 可达条件、§10 测试 6c |
| F46 | Important | 必需配额 + 确定排序 + 拒绝计入 = 确定性饿死；被拒 run 无收敛机制 | §6（配额只计实际执行 + 排序/退避的选择与理由）、§12、§13 第 5 笔 |
| F47 | Minor | 裁决记录里那条假 grep 主张至今未勘误 | §4.6（就地勘误，不改原件） |

**本轮新增或改判的承重测试**：6a（暂存顺序）、6e（输家不覆盖赢家）、4d（marker 原子写）、7b（被接受的退化）、12b（`--max-runs`）、13b（逃生口）、14b（恢复被断言）。**改判的**：5（`finalizeOrder` 不再同义反复）、6b（两组 fixture）、6c（7 个 staging 路径）、2（mock 面 + 区间 + 两组 fixture）、8b（两条子用例）、9（方向反转）、14（fixture 显式化 + 伴生断言指代）。

**本轮的数字回扫**：全文每一个计数类数字都在本轮被重推过一遍，重推命令就地附在数字旁。**下一轮评审请从「哪个数字旁边没有命令」开始找——本仓库三轮的规律是：附了命令的数字全对，没附命令的地方就是错的地方。**
