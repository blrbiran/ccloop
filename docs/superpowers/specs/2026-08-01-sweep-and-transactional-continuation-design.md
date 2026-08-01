# L3 — Sweep（触发层）与转移事务的跨文件原子性

Status: drafted 2026-08-01。**2026-08-01 经三个独立评审员对着代码撞过之后大幅修订**（修订索引见文末 §16）。本文是父设计 `2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17 item 2 的**后半**（触发），前半（发现）由 L2 `2026-07-28-run-registry-design.md` 完成。

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

> **本节是独立的一节、独立的任务组、独立的评审**（裁决记录「执行约束」，人下的指令）。**并且必须完成并通过独立评审之后，§6 的任务组才可开始**——裁决记录原文是「独立一节、独立任务组、独立评审，**先于触发逻辑**」，初稿把「先于」这两个字漏掉了。理由：sweep 先落地就等于把触发层挂到一条已知损坏的续跑路径上。

### 4.0 S-3 退路与被禁止的退路（初稿完全遗漏，本节补回）

裁决记录给了一条具名退路 **S-3**：若「reconciliation 加入 owner-transfer 事务」在实现中被判定不可行，**L3 不得就地发明替代方案**，而应回到裁决记录重新裁决债 1 的**归属与形式**。

**触发 S-3 的条件（本层就地定义，便于实施者识别）：** 若实现中发现事务化需要在恢复路径上新增一类**静默**失败模式、或需要改动 `finalizePendingOwnerTransfer` 的 catch **语义**（而不只是对称地多一个 `safeUnlink`，见 §13），**停下，回到裁决记录，不要发明变体。**

**被明确禁止的退路**：放松 `resumeLoop` 对 reconciliation 的必需性（例如「若存在则校验，不存在则跳过」）。那是引入新授权，违反 L1/L1b/L2 三层共同的「只增加拒绝」边界。

**对裁决记录「更窄」判断的回应（初稿只驳倒了一半，说成了全部）：** 裁决记录的「这条路比裁决时判断的更窄」有两条依据：(a) `newOwnerEpoch` 的排序主张；(b) 评审补充——「`assertHeld` 本身就是写者，说明这条修法要动的东西比初稿设想的多」。**§4.1 只驳倒了 (a)。(b) 成立，而且被本轮评审证实了**：真正要动的东西包含 marker 语义、两处 staging 回收路径、以及 finalize 的 catch 尾部。**所以正确的结论是：(a) 不成立，(b) 成立——而 (b) 正是本节必须是独立任务组、独立评审的原因。**

### 4.0a 裁决记录留给 L3 的问题 1，正面回答

裁决记录留了两个问题给 L3 spec，并写明「本轮不预设答案」。初稿答了问题 2（签名改动），**问题 1 一次都没点名**。补答如下。

> **问题 1**：`recoverInterruptedOwnerTransfer` 是否也要负责 finalize reconciliation？会扩大「读会写」的范围——而 L2 整层的设计正是围绕规避这一点建立的（禁用 `readOwnerRecord`）。

**答：是，必须由它负责，且这不扩大「读会写」的类别。**

理由三条：

1. **它今天已经是写者。** `recoverInterruptedOwnerTransfer` 已经会做两次 `rename` 加三次 `safeUnlink`。第三个文件加入的是**同一次**写，不是新增一类写。
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

### 4.2 reconciliation 的九个字段在事务前全部已知

| 字段 | 来源 | 计算位置 |
|---|---|---|
| `staleSuspicionBasis` | `boundaryEvidence.continuitySuspicion` 或 `boundaryAnalysis.staleCandidateReason` | `runExclusive` **之前** |
| `staleConfirmed` | 字面量 `true` | — |
| `ownershipVerdict` | `ownership.verdict`；transfer 分支内已知为 `OWNER_LOST` | `runExclusive` 内 |
| `lastTrustedBoundary` | `ownership.lastTrustedBoundary` | `runExclusive` 内 |
| `conflictingEvidence` | `boundaryEvidence.conflictingEvidence` | `runExclusive` **之前** |
| `takeoverPermission` | **`{ allowed: ownership.takeoverAllowed, reason: buildTakeoverReason(ownership.takeoverAllowed) }`** —— 是一个对象，不是布尔；`buildTakeoverReason` 必须一起调 | `runExclusive` 内 |
| `priorOwnerEpoch` | `ownerRecord.currentOwnerEpoch` | `runExclusive` 内 |
| `newOwnerEpoch` | `ownerRecord.currentOwnerEpoch + 1`（见 §4.1 事实 2） | 可在事务前算 |
| `eligibleForContinuation` | 成功路径上是类型级 `true`（`persistOwnerTransfer` 的返回类型钉死） | — |

```bash
grep -nF -e 'const boundaryEvidence = buildBoundaryEvidence(' -e 'const evaluateOwnershipFor =' \
         -e 'if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST"' \
         src/controller/runLoop.ts
grep -nF -A20 'reconciliationRecord:' src/controller/runLoop.ts
grep -nF -A10 'export type ReconciliationRecord' src/runtime/types.ts     # 期望印出全部九个字段
```

（**刻意不接 `| head`**：管道会把 `grep` 的退出码换成 `head` 的。）

### 4.3 新形状

| 项 | 内容 |
|---|---|
| 新常量 | `.reconciliation.pending.json`、`.reconciliation.publish.tmp` |
| marker | `version: 1` → `2`；`finalizeOrder` 改为 `[reconciliation-record.json, owner-transfer.json, owner-record.json]`，**并且改为被读取**（§4.4） |
| 签名 | `writeOwnerTransferArtifacts` 追加参数 `reconciliationRecord`；`persistOwnerTransfer` 同步透传 |
| **暂存顺序（不变式）** | reconciliation pending 必须 **严格先于 marker** 写入。marker 的存在即宣告「三份 pending 齐备」 |
| 组装点 | `persistBoundaryAnalysis` 在 transfer 分支内、`persistOwnerTransfer` 调用前组装**一份事务专用拷贝** |
| **赢家路径的 `writeBoundaryArtifacts`** | 改为**不传** `reconciliationRecord`（只写 `boundary-analysis.json`）。不改则赢家会在事务外再写一次，重新打开 §4 要关闭的那条路径 |
| **`cleanupOwnerTransferStagingWithoutMarker`** | 必须加上两个新路径。它是无 marker 时**唯一**回收 staging 的地方 |
| **`finalizePendingOwnerTransfer` 的 try 首与 catch 尾** | 各多一个对称的 `safeUnlink(.reconciliation.publish.tmp)`（见 §13 的窄例外） |

**⚠️ 组装点是个陷阱（评审发现）**：输家路径上 `ownerRecord` 与 `ownership` 在 CAS 失败后**被重新赋值**（`assertHeld()` → 重读 → 重新 evaluate），现有 reconciliation 刻意用的是**失败后重读**的值。**实施者若把组装点上提为唯一一份，会静默把输家记录退回 CAS 前的值。** 事务专用的那份是**第二份拷贝**；`writeBoundaryArtifacts` 那份原地不动。

**为什么 reconciliation 排第一 —— 并且这不是承重论证（按评审更正）：**

崩溃可以落在 finalize 九步的任意间隙。按 `[reconciliation, transfer, owner]` 排序，所有中间态都让 `resumeLoop` 拒绝：只有 reconciliation 发布 → epoch 不等；reconciliation + transfer 发布 → owner record 的 epoch 不等。

**但真正承载 fail-closed 的不是这个顺序，是 `evaluateResumeEligibility` 里的两条 epoch 相等判定**：

- `reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch`
- `ownerRecord.currentOwnerEpoch === ownerTransfer.newOwnerEpoch`

评审员用「N→N+1 已成功、N+1→N+2 崩在中途」的双转移场景逐字段追过，**并且在 `resumeLoop` 那个并行 `Promise.all`（它不是快照，见 §4.0a）的每一种混合采样下追过**：每一种都被这两条之一挡住。marker 恢复对**两种排序同样有效**，所以崩溃论证本身并不能在两个顺序之间做区分。

**排序仍然选 reconciliation 优先**，理由降级为次要但仍成立：它让「transfer 已发布、reconciliation 缺失」这个具体状态**连瞬时都不出现**，而反过来排会让它成为一个真实的瞬时窗口。

**这两条 epoch 相等判定是本层之后任何改动都不得削弱的东西**——§10 测试 6b 就是钉它的。

### 4.4 finalize 机制 —— **改判为 marker 驱动**（初稿选错，此处是再决策）

初稿选「pending 存在性驱动」（reconciliation pending 存在就发布、不存在就跳过），理由是「零新失败模式」。**评审证明该理由为假，且它接受的失败模式严格更差：**

**推翻它的场景**：SIGKILL 落在 marker 写入之后、reconciliation pending 写入之前。磁盘：marker 在、两个旧 pending 在、无 reconciliation pending。下一次 `readOwnerRecord` → 恢复 → 见 marker → finalize → 按「不存在就跳过」的规则**发布 transfer 与 owner record，然后删掉 marker**。结果正是「transfer 已发布、reconciliation 缺失」，**且 marker 已删，永不可恢复**。

机制上无法检测——因为「pending 缺席」被**定义**成了「这是 v1 事务」。而初稿的**测试 4 恰好把这个磁盘状态断言为正确行为**，等于把缺陷的形状写进套件。

**「不可解析的 marker」是响亮的失败；「静默降级的提交」不是。初稿避开了前者，接受了后者。**

**采用的机制：**

1. marker 成为**被读取**的字段：finalize 解析 marker，按其 `finalizeOrder` 声明的文件集合与顺序办事。`version` 成为联合类型（1 | 2），v1 声明两个文件、v2 声明三个。
2. **v2 marker 但某个 pending 缺失 → 拒绝 finalize，保留 marker 与全部 staging**，抛一个具名错误。fail-closed，且状态保持**可恢复、可诊断**，而不是静默错误。
3. **marker 不可解析 → 同样拒绝 finalize，保留一切**，抛具名错误。这就是初稿想避开的那个「新失败模式」——本设计**明确接受它**，因为它是响亮的。
4. v1 marker 按两文件路径走完，不抛。

### 4.5 本节修好了什么（措辞已按评审收窄）

`writeBoundaryArtifacts` 之前那个**无条件 `assertHeld()` 原样保留**——L1b 的「只增加拒绝」立场一个字不改。变的是它身后守着的东西：赢家路径上它现在只守 `boundary-analysis.json`。

**关于「没人依赖 `boundary-analysis.json`」—— 初稿把它写成绝对断言，而附的命令刻意只覆盖了它成立的那个目录。** 事实是：

```bash
grep -rnF 'boundary-analysis.json' src/                    # 1 处，是写入
grep -rlF 'boundary-analysis.json' validation/ tests/      # 6 个文件，有读者
```

`validation/v1/lib/evidence.ts` **会读它并做 Zod 校验**，`validation/v1/README.md` 把它列为消费产物，四个测试文件读或断言它。该 harness 对缺失有 `MISSING` 降级，所以**不是正确性破损**——但正确表述是「**`src/` 内无生产读者**」，不是「没有任何读者」。本层之后，赢家路径上 `boundary-analysis.json` 在 supersede 窗口内可能缺失，validation harness 会观测到 `MISSING`；这是已知且可接受的。

**债 1 不是靠移除守卫修好的，是靠把守卫身后那件有生产依赖的东西搬进事务修好的。**

### 4.6 与既有代码的关系

`preserveSuccessfulReconciliationIfNeeded` **代码零改动**——赢家路径因为 `eligibleForContinuation` 是类型级 `true` 而必然早退：

```bash
grep -nF -A4 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
```

（`-F` 建议保留，因为**裸符号名不唯一**：它还会命中 `preserveSuccessfulReconciliationIfNeededFromArtifacts`，带 `async function ` 前缀才唯一。**初稿另给的理由「不加 `-F` 会因未闭合分组报错退出 2」是假的**——实测不加 `-F` 退出 0、输出相同，只有加 `-E` 才 exit 2。那条我是从裁决记录抄的，没自己跑。**这正是本仓库「不要相信别人写下的『已核实』」那条教训。**）

**但语义非零改动**：见 §4.0a 末尾——它的 `Promise.all` 里有一个读会触发恢复，而恢复现在会写第三个文件。代码不用改，但这条性质必须记下来，且 §10 测试 6b 钉住真正承重的东西。

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

### 5.3 改动 A — `runExclusive` 拒绝

**先把在先的裁定完整引出来**（初稿只引了前半句，而被略掉的后半句正好禁止本改动——这是 Rule 7 要求「挑一个并说明为什么」的场合）：

> Takes no position on `stopped` or `superseded` — it only serializes. **Refusal is Task 5's job; duplicating it here would just be a second, weaker copy of a decision that already has one home.**

**本层推翻后半句，理由**：那条裁定成立的前提是「`stop()` 之后不会再有 `runExclusive`」——L1b/L2 时期为真，因为没有触发调用者。**L3 是让这个窗口可达的那一层**，前提不再成立。而且这里的拒绝**不是** `assertHeld` 那条决策的第二份弱拷贝：`assertHeld` 判的是「所有权还在不在」，这里判的是「本进程的心跳是否已停」，两个不同的命题。

**新增错误类型** `RunHeartbeatStoppedError`（`readonly stopReason = "heartbeat_stopped"`，形状照抄现有两个）：

```bash
grep -nF -A4 -e 'export class RunLeaseLostError' -e 'export class RunLeaseUnverifiableError' src/ownership/lease.ts
```

**必须同笔改掉的两条注释：**

1. `runExclusive` 上方那条（上面引的），它记录的裁定被本改动推翻。
2. `isLeaseStopError` 上方的「the **two** ways `heartbeat.assertHeld()` can refuse a side effect」——新错误来自 `runExclusive` 而**不是** `assertHeld`，**数量与来源两头都会变假**。

```bash
grep -nF -B4 'function isLeaseStopError(' src/controller/runLoop.ts
```

**调用点事实更正**：`runExclusive` 只有**一个**生产调用点，在 `persistBoundaryAnalysis` 内，**不在** `runLoopFromState` 内。初稿写的「两个、在 `runLoopFromState` 内」两头都错——「两个」是 `persistBoundaryAnalysis` 的调用点数。

```bash
grep -rnF 'runExclusive(' src/    # 期望 1 行
```

落地路径**经由 `persistBoundaryAnalysis` 传递地**成立：它的两个调用点在 `runLoopFromState` 的 attempt `try` 内，外层 catch 的 `isLeaseStopError` 分支把这类错误当停机边界处理。

⚠️ **注意 `INERT_LEASE_HEARTBEAT` 与测试替身**：它们的 `runExclusive: (fn) => fn()` 是**桩**，不是调用点，**不要给它们加拒绝逻辑**——那会打断 `tests/controller/leaseLifecycle.integration.test.ts` 里若干提供同样桩的测试心跳。

⚠️ **新抛出会替换掉更有信息的错误**（评审发现，记录而非修复）：在 execute 超时无结果那条路径上，`RunHeartbeatStoppedError` 会让 run 终结为 `cancelled / heartbeat_stopped`，跳过本来要写的 `exhausted` + 相位超时原因、跳过 `cleanupAttemptWorkspaceWithStatus` 与 `execution-recovery.json` 的 `cleanupStatus` 回填。今天不可达；在 §5.3 要防御的并发 `stop()` 场景下才变活。**接受，因为那条路径上「本进程心跳已停」本来就意味着这些后续写入不该发生。**

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
- `resumeLoop` 的 `finally` 里已有的 `heartbeat.stop()` 会清掉 `leaseAffirmedAt`，所以下一次 sweep 的 `checkRunLease` 会放行，而 owner epoch 未变、门依然通过——**该 run 下一次 sweep 仍然 eligible**。§10 测试 8b 就是钉这一点的
- `resumeLoop` 追加**可选参数**（有默认值；现有调用点全部传 2 个实参，零改动）；它对 `runLoopFromState` 的调用需把信号作为**第七个位置参数**传下去
- **信号处理器装在 `cli.ts`，不装在 `sweepRuns.ts`**。`sweepRuns.ts` 保持纯函数、接收一个信号槽——既让 §3.1 的「sweep 自身不新增 writer」成立，也让测试 13 可测

⚠️ **停机粒度的界是「adapter 协作式」，不是无条件有界**（评审更正）。检查点是 **per-attempt** 边界。而 execute 相位用 `{ awaitAbortedResult: true }`，超时后 `abort()` 再 `await operationPromise` **没有第二重上界**；adapter 的 `onAbort` 只发 `SIGTERM`，无 SIGKILL 升级。一个不响应 SIGTERM 的子进程会让 attempt 无限期挂住。`createAttemptWorkspace` / `cleanupAttemptWorkspace` 的 git 子进程也完全无超时。**诚实的界是**：`planTimeoutMs + verifyTimeoutMs + (execute：adapter 协作则有界，否则无界) + 无超时的 git`。

⚠️ **因此必须留逃生口**（否则装了处理器反而让 sweep 杀不掉，因为默认处置被移除了）：**第二次收到同一信号立即 `process.exit(130)`**。本层不修 execute 的超时升级——那是行为变更，属独立任务，本层只记录。

**两个改动互补**：B 提供正常路径上的停机，A 保证并发 `stop()` 只会得到拒绝而非静默无主写入。**债 3 到此关闭。**

## 6. Sweep 触发层

```
ccloop sweep --root <root> --adapter <scripted|claude> --adapter-config <path>
        │
        ├─ scanRuns(root, defaultScanDeps)
        ├─ 过滤 kind === "run" 且 owner-transfer.json 的 eligibleForContinuation
        │        观测为 { kind: "present", value: true }
        ├─ 按 path 字典序排序（确定性，测试依赖它）
        ├─ 打印启动横幅到 stderr（adapter + 待续跑数量）→ 此后才构造 adapter
        ├─ 顺序 for-await：resumeLoop(runDir, adapter, { stopRequested })
        └─ 打印报告 → exit 0（扫描本身失败则 1）
```

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
| `1` | sweep **未能开始或未能完成扫描**：参数解析失败、`--adapter-config` 读取/解析失败、root 不存在或不可读 |
| `0` | 其余一切，**包括**某个 run 跑成 `exhausted` / `failed` / 被门拒绝 |
| `130` | 第二次收到 SIGINT/SIGTERM 的强制退出（§5.4 逃生口） |
| `2` | **不使用。** sweep 分支必须在 `finalState.status === "succeeded" ? 0 : 2` 那个映射之前返回 |

前三行都归 `1`，理由一致：都是「sweep 没能干成它的活」。逐 run 结局进输出，不进退出码——一个 run 合法地跑到 `exhausted`，是 sweep 成功地处理了一个失败的 run。

**不加 `--json`。** sweep 的报告今天没有消费者。

## 8. 错误处理汇总

| 情形 | 反应 | 去向 |
|---|---|---|
| 参数解析失败 / adapter-config 读取失败 | exit 1，不扫描 | stderr |
| 扫描本身失败 | exit 1，不跑任何 run | stderr |
| 扫描 issue 行（`directory_unreadable` / `depth_truncated`） | 记录，不续跑，不中断 | stderr |
| `ResumeNotEligibleError` | **正常结果**，不是错误 | stdout |
| `RunLeaseHeldError` | 正常结果（别人正在跑） | stdout |
| run 跑到任一终态 | 记录终态 + `stopReason` | stdout |
| run 因 `stop_requested` 返回非终态 | 记录为 `interrupted`，**明确标注该 run 仍可续跑** | stdout |
| 意料之外的抛错 | 记录**完整 message**，继续下一个 | **stderr** |

**报告格式（定死，因为没有 `--json`，人类可读形式就是全部契约）：** 每个尝试过的 run 一行，制表对齐三列 `path | outcome | detail`；`outcome` 取值域为 `succeeded` / `failed` / `exhausted` / `blocked_waiting_human` / `interrupted` / `refused` / `error`；末尾一行汇总 `N attempted, M succeeded, K refused`。启动横幅格式：`sweep: <count> eligible run(s) under <root>, adapter=<name>`，**打印在扫描之后、adapter 构造之前**。

**sweep 从不静默吞任何一种结果**（Rule 12）。意外错误按 §7 不改退出码，但写到 stderr 以便被 cron 的「有 stderr 即告警」捞住。

## 9. 模块边界

| 模块 | 职责 |
|---|---|
| `src/sweep/sweepRuns.ts` | 扫描 → 过滤 → 排序 → 顺序续跑 → 汇报。**纯函数，接收信号槽，自身无 writer、不装信号处理器** |
| `src/cli.ts` | `sweep` 分支、参数解析、**信号处理器注册**、退出码映射 |
| `src/controller/resumeLoop.ts` | 追加可选信号参数，并向 `runLoopFromState` 透传 |
| `src/controller/runLoop.ts` | 信号槽检查点、reconciliation 事务拷贝的组装、赢家路径 `writeBoundaryArtifacts` 改传 `undefined`、`isLeaseStopError` 及其注释 |
| `src/controller/leaseHeartbeat.ts` | `runExclusive` 拒绝 + 其上方注释 |
| `src/persistence/fileStore.ts` | 三文件事务、marker 驱动 finalize、`cleanupOwnerTransferStagingWithoutMarker` 扩容、finalize try 首与 catch 尾的对称 unlink |
| `src/ownership/lease.ts` | `RunHeartbeatStoppedError` |

`src/registry/` **零改动**。

⚠️ **签名改动的爆炸半径**：`writeOwnerTransferArtifacts` 若加**必需**参数，会打断 `tests/persistence/fileStore.test.ts` 的十余处直接调用与 `tests/controller/leaseLifecycle.integration.test.ts` 的若干 `Parameters<typeof ...>` 包装。计划必须显式安排这批测试的更新，或把参数设为可选并说明。

```bash
grep -rnF 'writeOwnerTransferArtifacts' tests/ | wc -l    # 动手前现数
```

## 10. 测试要求

**债 1**

1. **修复后行为**（初稿把它写成「证明修复前拒绝、修复后不再」，而一条提交的测试只跑一棵树，那不可表达）：驱动**生产**转移路径并注入 `assertHeld` 抛出，断言 `reconciliation-record.json` 已在盘上且 `resumeLoop` 放行。它变红的方式由测试 6 的变异提供。
2. **崩溃注入**：用本仓库既有手法（`vi.resetModules()` + `vi.doMock("node:fs/promises", …)` 包 `rename`/`writeFile`，见 `tests/persistence/fileStore.test.ts`）在 finalize **九步**的每一个间隙中断，断言每个中间态都让 `resumeLoop` 拒绝、且 marker 仍在时恢复能推完。
3. **恢复**：v2 marker + 三个 pending → `readOwnerRecord` 触发恢复 → 三文件就位。
4. **v2 marker 但 pending 缺失 → 拒绝 finalize、保留 marker 与 staging、抛具名错误**（这条取代初稿那条会把缺陷断言为正确的 v1 测试）。
4b. **v1 marker + 两个 pending → 只发布两个，不抛。**
4c. **marker 不可解析 → 拒绝 finalize、保留一切、抛具名错误。**
5. **`finalizeOrder` 承重**：断言实际发布顺序等于 marker 声明的顺序。**注意 marker 只在全部 rename 之后才被 unlink**，所以 `rename` 的 mock 可在首次调用时读到它。
6. **反方向变异**：reconciliation 退回事务外 → 测试 1 必须红；暂存顺序改成 marker 先于 reconciliation pending → 测试 4 必须红。**两侧各自单独变异都要红。**
6b. **钉住真正承重的东西**：变异掉 `evaluateResumeEligibility` 的任一条 epoch 相等判定 → 测试 2 必须红。（§4.3 已论证承重的是这两条，不是排序。）
6c. **孤儿回收**：中断在 finalize 成功尾部（marker 已删、pending 未删），随后走一次 `claimOwnerRecordWithPrecondition`，断言**三个** pending 与两个 temp 全部被回收，无残留。
6d. **赢家不二次写**：断言赢家路径上 `writeBoundaryArtifacts` 之后 `reconciliation-record.json` 的 inode/mtime 未变。

**债 3**

7. `runExclusive` 在 `stopped` 后拒绝；退回不拒绝 → 必须红。
8. 信号槽置位 → `runLoopFromState` 在相位边界返回**非终态** state、追加 `stop_requested` 事件、不启动新 attempt。
8b. **`stop_requested` 之后，同一个 run 目录在下一次 sweep 中仍然 eligible**（这条是 §5.4 改判的承重断言）。
9. `isLeaseStopError` 三种错误全部识别。（该谓词是模块私有的；若需导出，计划要写明。）

**sweep**

10. 只对观测为 eligible 的行调 `resumeLoop`。
11. 一个 run 被拒绝不中断后续 run（依赖 §6 的排序确定性）。
12. 参数错误 / adapter-config 错误 / 扫描失败 → exit 1；其余一律 exit 0（含 run 跑成 `exhausted`）。
13. 信号槽置位后不再开下一个 run；第二次信号 → 130。
14. **写面钉定（取代空洞的「零写入」）**：对一个**观测 eligible 但门拒绝**的 run 目录，断言它**恰好**新增 `resume_requested` + `resume_denied` 两行事件、**其余字节不变**；并配一条伴生断言：若 sweep 改为对**非** eligible 行也调 `resumeLoop`，该目录就会变——**使这条测试承重**（L2 `tests/registry/zeroWrite.test.ts` 的做法）。

**通用**

- 变异注入点必须在**生产代码 / 生产类型**上。
- 反方向变异：只改 A 侧失败、只改 B 侧也失败。
- 写区间必须带样本数。
- 测试 1 / 5 需经 `runLoop` / `runLoopFromState` 驱动（`persistBoundaryAnalysis` **未导出**）；**不要为此导出它**。

## 11. 执行约束

- **§4（债 1）是独立的一节、独立的任务组、独立的评审，且必须先于 §6 的触发逻辑完成并通过评审。**
- 每任务一次独立评审 + 整分支一次；**修复波之后必须再评审**。
- **评审必须对着代码撞，不接受实施者自证。**
- **验证跑绝不过滤输出**——`tail` 与 `grep` 同罪。
- **计划不附完整可抄代码。**
- **每一个算出来的数字旁边就地附一条能重推它的命令。**
- 跑全套件时**只有 flake (B) 与 (F) 允许出现**；名单外任何失败先捕获完整测试名与失败块。
- 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`。
- **L1 spec §12 的十九条约束一条都不得弱化**（L2 成功标准 4 的原样继承）。其中第 2/5/7/15/17/19 条与本层改动直接相邻，**对它们要逐条变异验证**——但这是「重点核查」，不是把其余十三条豁免。
- **所有编辑落地之后，全仓扫一遍指向被改文件的行号引用。**

## 12. 治理与付费调用

`ccloop sweep --root <root> --adapter claude` 挂进 cron 就是无人值守的付费调用。

**本设计的表态**：操作者选择 `--adapter claude` 即构成对该次 sweep 全部续跑的批准。为使批准**有界**且知情：

- 启动横幅（§8）必须在扫描之后、adapter 构造之前打到 stderr，写明数量与 adapter
- **`--max-runs <N>` 为必需参数**，sweep 处理满 N 个即停。无界的「全部批准」不构成有界批准，而 §12 声称它是有界的

## 13. 继承债与不做的事

| 债 | 本层处置 |
|---|---|
| 1 跨文件事务性 | **本层修**（§4） |
| 2 `persistTerminalState` 往已不拥有的 run 写 | **不碰**，留 L5 |
| 3 `heartbeat.stop()` 释放窗口 | **本层修**（§5），关闭 |
| 4 非原子写 | 已于 `2026-07-29-atomic-write-paths` 关闭并合并 |

**L5 的继承清单确认为 1 笔**（只剩债 2）。降到 1 笔是 2026-07-29 那次归属裁决做的，不是本层做的；本层兑现其中的债 1 与债 3，使清单不再回涨。

**关于债 2**：§5.4 不再新增 `persistTerminalState` 调用点（改判为不写终态），所以本层对债 2 的接触面为零。

**`finalizePendingOwnerTransfer` 的 catch —— 一条明确的窄例外。** 初稿承诺「不触碰 catch 块的形状」。评审证明那做不到：不给 catch 加第三个对称 `safeUnlink`，`.reconciliation.publish.tmp` 会在终态失败路径上永久泄漏，且没有任何别处回收它。**本层的表态**：try 首与 catch 尾各多一个**对称的** `safeUnlink`，**不改变 catch 的形状与错误传播语义**；它那个「两个 `safeUnlink` 都可能替换正在传播的错误」的错误掩盖问题**原样留给 L5**，触发条件是「清理失败与转移失败同时发生」，与本层要修的窗口无关。

**本层查实、明确不处理、留给 L5 具名继承的两笔：**

1. **锁可被偷。** `tryRecoverStaleOwnerTransferLock` 在 `JSON.parse(lockContents)` 抛且存在 staging 时会删锁返回 true。而 `open(lockPath, "wx")` 之后、`handle.writeFile` 之前的锁文件恰好是零长度、不可解析。所以一个**活着的**持有者可能被夺锁，两个进程并发写入同一组固定 pending 文件名。今天由 epoch 不等挡住；本层之后，若 A、B 都从 epoch N 起算，两者的 `newOwnerEpoch` 都是 N+1，**epoch 三元组会通过**，得到一份「reconciliation 来自 A、transfer 来自 B」的记录——证据记录会对转移原因撒谎。**这是先于本层的缺陷，但 §4 扩大了它的影响面，故在此具名。** 不在本层修，因为修它要动锁协议本身。
2. execute 相位 abort 后无第二重超时上界（§5.4 的 ⚠️）。

## 14. 后续

1. **L5 — cleanup / orphan handling**（父设计 §17 item 3）。输入是债 2 + 上面 §13 具名的两笔。
2. **常驻形态**（`watch`）：会让「飞行中 `stop()`」重新成为问题，§5.2 的论证是起点。
3. **execute abort 的 SIGKILL 升级**：独立任务，独立评审。

## 15. 验收标准

1. **没有任何生产路径**能产生「transfer 已发布、reconciliation 缺失」的磁盘状态。（初稿写的「该状态不可构造」是假的——任何人都能 `writeFile` 出来，而且测试 2 必须能构造它。）
2. 事务的每一个崩溃中间态都让 `resumeLoop` 拒绝；marker 仍在的中间态都能由 `recoverInterruptedOwnerTransfer` 推完。**已知例外必须在 spec 中具名**：marker 缺失的窗口，以及 `!lockHeld` 且锁文件存在、`isProcessActive` 为真时恢复会跳过（`isProcessActive` 对 `ESRCH` 以外的任何错误——含 `EPERM`——返回 true，故回收的 pid 会把事务钉成暂不可恢复）。
3. `runExclusive` 在 `stopped` 后必然拒绝；退回旧行为则测试 7 变红。
4. **`stop_requested` 中断过的 run，在下一次 sweep 中仍然 eligible**（测试 8b）。
5. `evaluateResumeEligibility` 的八条判据一个字节未改。
6. sweep 对一个被门拒绝的 run 目录**恰好**新增两行事件、其余字节不变，且该断言是承重的（测试 14）。
7. 全套件、typecheck、build 三者退出 0，且输出**未经任何过滤**地贴出。

## 16. 修订索引（2026-08-01，三个独立评审员）

初稿的 Critical 级缺陷，逐条对应本文修订处：

| # | 初稿缺陷 | 修订处 |
|---|---|---|
| 1 | 「七条判据」实为**八条** | §3.3 |
| 2 | 「`runExclusive` 两个生产调用点、在 `runLoopFromState` 内」两头都错，实为**一个**、在 `persistBoundaryAnalysis` 内 | §5.3 |
| 3 | §4.4 选「pending 存在性驱动」会**静默发布降级提交且不可恢复**，且旧测试 4 把该状态断言为正确 | §4.4 **改判为 marker 驱动** |
| 4 | 孤儿 pending / temp 的回收路径（`cleanupOwnerTransferStagingWithoutMarker`、catch 尾）完全不在改动清单里 | §4.3 表、§13 |
| 5 | `stop_requested` 写终态会**永久杀死正在飞行的 run** | §5.4 **改判为不写终态** |
| 6 | 「零写入」声明为假，其测试空洞 | §3.2、§10 测试 14 |
| 7 | 只引了 `runExclusive` 注释的前半句，而后半句正好禁止本改动 | §5.3 |
| 8 | 裁决记录留给 L3 的问题 1 从未点名 | §4.0a |
| 9 | `parseArgs` 解析不了 `sweep <root> --flag` | §6 改用 `--root` |
| 10 | §4.3 把「排序」当承重论证，实际承重的是两条 epoch 相等判定 | §4.3 |
| 11 | S-3 退路完全遗漏；「更宽不是更窄」只驳倒了裁决记录两条依据中的一条 | §4.0 |
| 12 | 「先于触发逻辑」的实施顺序强制被漏掉 | §4 节首、§11 |
| 13 | 「无人读 `boundary-analysis.json`」用收窄的 grep 支撑了绝对断言 | §4.5 |
| 14 | 「不加 `-F` 会 exit 2」是抄来的、未跑过的假主张 | §4.6 |
| 15 | 把 L1 §12 的十九条悄悄收窄成六条 | §11 |
| 16 | 测试 1 按字面不可表达；§15.1「不可构造」为假 | §10 测试 1、§15.1 |
