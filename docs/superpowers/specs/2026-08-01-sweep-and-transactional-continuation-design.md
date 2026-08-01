# L3 — Sweep（触发层）与转移事务的跨文件原子性

Status: drafted 2026-08-01。本文是父设计 `2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17 item 2 的**后半**（触发），前半（发现）由 L2 `2026-07-28-run-registry-design.md` 完成。

> **本文不写死行号。** 所有代码锚点用「文件名 + 符号名」，并在旁边附一条能重推它的 `grep`。本仓库已有六处自造的失效行号引用案底；每一个算出来的数字旁边必须就地附重推命令。

## 1. 目的

让一个**已经具备续跑资格**的 run 在无人值守条件下被真正续跑，并在此过程中消除两笔被裁决归属本层的债：

- **债 1 — 跨文件事务性**：`owner-transfer.json` 已原子发布、而 `reconciliation-record.json` 要等一个**会抛的** `assertHeld()` 之后才写。第三方在此窗口 supersede，就留下「eligible 但无 reconciliation」的磁盘状态，`resumeLoop` 随即拒绝。这是 **liveness 洞**，不是安全洞。
- **债 3 — `heartbeat.stop()` 释放窗口**：`stop()` 只 await 了它读到的那一个 `queue` 快照，而 `runExclusive` 明确「takes no position on `stopped`」并会重新赋值 `queue`。

裁决记录：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`。债 2 留给 L5，本层不碰。

## 2. 范围与非目标

**做：**

1. 新增 `ccloop sweep <root>`：扫一次 registry → 对每个观测为 eligible 的 run 顺序调 `resumeLoop` → 退出。
2. 债 1：`reconciliation-record.json` 加入**已有的**转移事务，成为第三个参与文件。
3. 债 3：收紧 `runExclusive` 语义 + 增加一个停机信号槽。

**不做（每条都是刻意的）：**

1. **不发起 transfer。** sweep 永不创建所有权决策，只消费已发布的。全仓库唯一能发布 transfer 的生产路径是 `persistBoundaryAnalysis` → `persistOwnerTransfer` → `writeOwnerTransferArtifacts`，而 `persistBoundaryAnalysis` 的两个调用点都在 `runLoopFromState` 内部——**transfer 只由活着的控制器发布**。被硬杀的进程不会留下 eligible transfer，那类 run 本层碰不到。

   ```bash
   grep -rnF -e 'writeOwnerTransferArtifacts(' -e 'persistOwnerTransfer(' -e 'persistBoundaryAnalysis(' src/
   ```

2. **不常驻、不轮询、不并发。** 顺序执行，跑完退出。常驻形态若将来需要，建在 sweep 之上，不在本层。
3. **不做 orphan / cleanup / GC。** 父设计 §17 item 3，属 L5。
4. **不合成 reconciliation，不放松 `resumeLoop` 对它的必需性。** 裁决记录明令禁止——那是引入新授权。
5. **不修债 2**（`persistTerminalState` 往已不拥有的 run 写）。修它就造孤儿，孤儿是 L5 的定义域。

## 3. 授权立场

**L3 不引入任何新授权。** 这在本层是**结构性**事实而非承诺：

- sweep 自己不往任何 run 目录写一个字节。所有写入都发生在 `resumeLoop` 及其下游，本层不改那条路径。
- `evaluateResumeEligibility` 的七条判据一条不动。
- registry 观测到的 `eligibleForContinuation` 仍然**不是决策**（L2 spec §6、§7.3）。sweep 拿它当「值得一试」的过滤器，最终裁决权完全在 `resumeLoop` 的门。门拒绝是系统按设计工作，不是错误。

债 1 的修复方向同样只增加拒绝：见 §4.3 的顺序论证——所有崩溃中间态都落在拒绝一侧。

## 4. 债 1 — reconciliation 加入转移事务

> **本节是独立的一节、独立的任务组、独立的评审**（裁决记录 §「执行约束」，人下的指令）。理由：它改的是 L1b 刚变异验证稳定下来的转移写序，风险等级与触发逻辑不同，不得混批。

### 4.1 当前形状

```bash
grep -nF -e 'const OWNER_TRANSFER_MARKER_FILE' -e 'type OwnerTransferTransactionMarker' \
         -e 'async function finalizePendingOwnerTransfer' -e 'async function recoverInterruptedOwnerTransfer' \
         -e 'export async function writeOwnerTransferArtifacts' src/persistence/fileStore.ts
```

事务由 `writeOwnerTransferArtifacts` 驱动：取锁 → 恢复任何遗留事务 → CAS 比对持久化的 owner record → 暂存两个 pending + 一个 marker → `finalizePendingOwnerTransfer`（双 temp+rename，再清 marker 与 pending）→ 释放锁。崩溃恢复由 `recoverInterruptedOwnerTransfer` 承担，它只检查 marker 是否存在。

**两个必须先说清的事实：**

1. **marker 的 `finalizeOrder` 字段被写下、却从未被读取。** `finalizePendingOwnerTransfer` 按硬编码顺序直接读两个 pending 文件。这是一个无人核对的主张。
2. **`newOwnerEpoch` 在事务开启前就已知。** `applyOwnerEpochTransfer` 是纯同步函数，`nextEpoch = ownerRecord.currentOwnerEpoch + 1` 在 `persistOwnerTransfer` 的第一行算出，早于任何 I/O。

   ```bash
   grep -nF -A8 'export function applyOwnerEpochTransfer(' src/ownership/ownerController.ts
   grep -nF -e 'const transfer = applyOwnerEpochTransfer(' -e 'await writeOwnerTransferArtifacts(' src/controller/runLoop.ts
   ```

   裁决记录里「`newOwnerEpoch` 要等 `persistOwnerTransfer` 返回才知道」只对 `persistBoundaryAnalysis` 这个**调用者视角**成立，不是排序上的硬约束。**「加入事务」这条路因此比裁决时判断的更宽，不是更窄。**

### 4.2 reconciliation 的九个字段在事务前全部已知

`persistBoundaryAnalysis` 组装 reconciliation record 所需的九个字段，来源如下（全部在 `runExclusive` 内、transfer 调用之前完成）：

| 字段 | 来源 |
|---|---|
| `staleSuspicionBasis` | `boundaryEvidence.continuitySuspicion` 或 `boundaryAnalysis.staleCandidateReason` |
| `staleConfirmed` | 字面量 `true` |
| `ownershipVerdict` | `ownership.verdict`；在 transfer 分支内已知为 `OWNER_LOST` |
| `lastTrustedBoundary` | `ownership.lastTrustedBoundary` |
| `conflictingEvidence` | `boundaryEvidence.conflictingEvidence` |
| `takeoverPermission` | `ownership.takeoverAllowed`；在 transfer 分支内已知为 `true` |
| `priorOwnerEpoch` | `ownerRecord.currentOwnerEpoch` |
| `newOwnerEpoch` | `ownerRecord.currentOwnerEpoch + 1`（见 4.1 事实 2） |
| `eligibleForContinuation` | 成功路径上是类型级 `true`（`persistOwnerTransfer` 的返回类型钉死） |

重推这张表的锚点：

```bash
grep -nF -e 'const boundaryEvidence = buildBoundaryEvidence(' -e 'const evaluateOwnershipFor =' \
         -e 'if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST"' \
         src/controller/runLoop.ts
grep -nF -A20 'reconciliationRecord:' src/controller/runLoop.ts
```

（**刻意不接 `| head`**：管道会把 `grep` 的退出码换成 `head` 的，读者拿不到「命中/未命中」这个信号。本仓库对验证输出的任何过滤都有案底。）

### 4.3 新形状

| | |
|---|---|
| 新常量 | `.reconciliation.pending.json`、`.reconciliation.publish.tmp` |
| marker | `version: 1` → `2`；`finalizeOrder` 改为 `[reconciliation-record.json, owner-transfer.json, owner-record.json]` |
| 签名 | `writeOwnerTransferArtifacts` 追加参数 `reconciliationRecord: ReconciliationRecord`；`persistOwnerTransfer` 同步透传 |
| 组装点 | `persistBoundaryAnalysis` 在进入 transfer 分支**之前**组装好 record，传下去 |
| 暂存时机 | 与现有两个 pending 相同——**在 CAS 通过之后**。CAS 失败时什么都没暂存，组装好的 record 直接丢弃 |

**为什么 reconciliation 排第一（本节的核心论证）：**

崩溃可以落在三次 rename 的任意间隙。按 `[reconciliation, transfer, owner]` 排序，可能的中间态只有：

1. 三者皆未发布 → 与事务从未开始等价。
2. 只有 reconciliation 发布 → `readOwnerTransferRecord` 读到旧记录或 ENOENT。`resumeLoop` 要求 `ownerTransfer.eligibleForContinuation === true` **且** `reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch`，两种情况都**拒绝**。
3. reconciliation + transfer 发布，owner record 未更新 → `resumeLoop` 要求 `ownerRecord.currentOwnerEpoch === ownerTransfer.newOwnerEpoch`，**拒绝**。

**每一个中间态都落在拒绝一侧，fail-closed 与 deny-by-default 都未削弱。** 反过来排（reconciliation 排最后）就会造出「transfer 已发布、reconciliation 缺失」——正是本层要消灭的那个状态。

此外这些中间态都是**可恢复**的：下一次 `readOwnerRecord` 会触发 `recoverInterruptedOwnerTransfer`，marker 仍在，事务被推完。

### 4.4 v1 marker 兼容 —— 按 pending 存在性驱动

两条路，本设计选后者：

- **marker 驱动**：finalize 时解析 marker、按声明顺序办事。能把装饰性字段变成承重字段，v1/v2 自动兼容。**但引入一个今天不存在的失败模式**——marker 损坏时今天照样能 finalize（`recoverInterruptedOwnerTransfer` 只做 `pathExists`），改成解析后就必须对「marker 不可解析」表态。
- **pending 存在性驱动（本设计采用）**：finalize 时 `.reconciliation.pending.json` 存在就发布、不存在就跳过。v1 marker 天然只 finalize 两个文件；零新失败模式；diff 最小。

代价是 `finalizeOrder` 仍然不承重。**用一条测试补上**（§10 测试 5）：断言实际发布顺序等于 marker 声明的顺序。这样那个字段不再是无人核对的主张，也不必为此在保护区里开一条新的失败路径。

### 4.5 本节到底修好了什么（说精确）

`writeBoundaryArtifacts` 之前那个**无条件 `assertHeld()` 原样保留**——L1b 的「只增加拒绝、绝不新增许可」立场一个字不改。

变的是它身后守着的东西。transfer 成功路径上，它现在只守 `boundary-analysis.json`，而**没有任何读者依赖那个文件**：`resumeLoop` 不读它，registry 的 `OBSERVED_FILES` 不观测它。

```bash
grep -rnF 'boundary-analysis.json' src/
grep -nF 'file:' src/registry/observeFields.ts     # 三个文件，无 boundary-analysis.json
```

**债 1 不是靠移除守卫修好的，是靠把守卫身后那件有人依赖的东西搬进事务修好的。**

### 4.6 与既有代码的不相交部分

`preserveSuccessfulReconciliationIfNeeded` **零改动**。赢家路径本来就没走过它——它一进门就对 `eligibleForContinuation` 早退，而赢家的该字段是类型级 `true`：

```bash
grep -nF -A4 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
```

（`-F` 不可省：本仓库的 `grep` 被改写成正则引擎，锚点末尾的 `(` 会被当成未闭合分组而报错退出 2。裸符号名不唯一——它还会命中 `preserveSuccessfulReconciliationIfNeededFromArtifacts`，带 `async function ` 前缀才唯一。）

输家路径（`eligibleForContinuation` 保持 `false`）完全不进事务，继续走 `writeBoundaryArtifacts`，行为不变。

## 5. 债 3 — `heartbeat.stop()` 释放窗口

> 裁决记录要求 L3 spec **必须显式表态**，不得沉默继承。本节的表态是：**收紧 `runExclusive` 语义**（可接受表态之一），并额外提供一个不依赖 `stop()` 的停机通道。

### 5.1 机制复核

```bash
grep -nF -A10 'const stop = async (): Promise<void> => {' src/controller/leaseHeartbeat.ts
grep -nF -A4 'const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {' src/controller/leaseHeartbeat.ts
```

`stop()` 置 `stopped = true`、`clearInterval`、然后 `await queue.catch(...)`、最后 `releaseOwnerLease`。`runExclusive` 的注释白纸黑字写着 "Takes no position on `stopped` or `superseded` — it only serializes"，并重新赋值 `queue`。所以 `stop()` 可以在一个 exclusive span 仍在飞行时去释放租约。

今天不可达仅仅因为两个 `stop()` 调用点都在 `await runLoopFromState` 之后的 `finally` 里。

### 5.2 完整性论证：为什么「`stopped` 后拒绝」就够，不需要 drain 循环

- `stopped = true` 与读取 `queue` 的那一步之间**只隔一个同步的 `clearInterval`，没有任何 `await`**——同一个同步回合内完成。
- `runExclusive` 的函数体是纯同步的（`const result = queue.then(fn, fn); queue = result.then(...); return result`），调用返回时 `queue` 已经包含了 `fn` 的完成。

**因此：任何在 `stopped` 置位前发起的 span，必然已被折进 `stop()` 读到的那个 `queue`；任何之后发起的，都必然看见 `stopped === true`。** 两侧穷尽，无缝隙。

### 5.3 改动 A — `runExclusive` 拒绝

新增错误类型 `RunHeartbeatStoppedError`，形状照抄现有两个（`readonly stopReason = "heartbeat_stopped"`）：

```bash
grep -nF -A4 -e 'export class RunLeaseLostError' -e 'export class RunLeaseUnverifiableError' src/ownership/lease.ts
```

`runExclusive` 在 `stopped` 为真时抛它，不执行 `fn`。

**必须同笔改掉的注释**：`runLoop.ts` 里 `isLeaseStopError` 上方写着「the **two** ways `heartbeat.assertHeld()` can refuse a side effect」。新错误来自 `runExclusive` 而**不是** `assertHeld`，所以这句话**数量与来源两头都会变假**。谓词与注释必须一起改。

```bash
grep -nF -B4 'function isLeaseStopError(' src/controller/runLoop.ts
```

落地路径是现成的：`runExclusive` 的两个生产调用点在 `runLoopFromState` 的大 `try` 内，外层 catch 有 `if (isLeaseStopError(error))` 分支，把这类错误当**停机边界**而非崩溃处理——已被现有测试钉住。

### 5.4 改动 B — 停机信号槽

照抄 `LeaseLossSignal` 的形状：一个**调用者持有的槽**，由 `runLoopFromState` 在它自己选择的相位边界主动检查，而不是被回调打断。

```bash
grep -nF -e 'export type LeaseLossSignal' -e 'export function createLeaseLossSignal' \
         -e 'if (leaseLoss.lost !== null)' src/controller/runLoop.ts
```

- `StopRequestSignal = { requested: boolean }` + `createStopRequestSignal()`
- `runLoopFromState` 在**已有的**相位边界检查点旁边多查一个，命中则 `persistTerminalState(runDir, state, "cancelled", "stop_requested")`，不启动下一个 attempt
- `resumeLoop` 追加**可选参数**（有默认值，现有调用点零改动）
- sweep 安装 SIGINT / SIGTERM handler 置槽；当前 run 返回后 sweep 自己也查同一个槽，不再开下一个

**两个改动互补，不是二选一**：B 提供正常路径上的优雅停机（粒度 = 一个 attempt，由相位超时上界保证有界）；A 保证即便将来有人真的并发调 `stop()`，也只会得到一个拒绝，而不是一次静默的无主写入。

**债 3 到此关闭，不再传给 L5。**

## 6. Sweep 触发层

```
ccloop sweep <root> --adapter <scripted|claude> --adapter-config <path>
        │
        ├─ scanRuns(root, defaultScanDeps)
        ├─ 过滤：kind === "run" 且 owner-transfer.json 的 eligibleForContinuation
        │        观测为 { kind: "present", value: true }
        ├─ 顺序 for-await：resumeLoop(runDir, adapter, { stopRequested })
        │        每个 run 的结局记进报告；停机槽置位则不再开下一个
        └─ 打印报告 → exit 0（扫描本身失败则 1）
```

**消费 L2 的数据契约，但在进程内调用 `scanRuns`**，不 fork `ccloop ls --json` 再解析回来。两者数据完全相同，后者只多一层序列化和一个会失败的子进程。L2 spec §14.1 要求的是契约，不是进程边界。

**顺带讨清 L2 的一笔记录**：registry 只观测三个文件，**不观测 reconciliation**，所以 L2 spec §13.1 记着「一行可能显示 eligible，而磁盘上并无 reconciliation」。债 1 修好之后，该观测值第一次成为可靠信号，那条记录同时被讨清。

**并发 sweep 无需额外处理**：两个 sweep 同时扫到同一个 run，后到者被 `resumeLoop` 的租约门拒绝。这是正确行为，记入报告，不是错误。

## 7. CLI 表面与退出码

| 退出码 | 条件 |
|---|---|
| `1` | **扫描本身**失败（root 不存在或不可读），不跑任何 run |
| `0` | 其余一切，**包括**某个 run 跑成 `exhausted` / `failed` / 被门拒绝 |
| `2` | 不使用 |

理由：一个 run 合法地跑到 `exhausted`，是「sweep 成功地处理了一个失败的 run」。把两者混进同一个退出码会让它失去意义。逐 run 结局进输出，不进退出码。这与 `ls` 的约定（扫描失败 → 1，行内 `unreadable` 不影响退出码）同构。

**不加 `--json`。** `ls` 有 `--json` 是因为它当时就声明了 L3 是消费者；sweep 的报告今天没有任何消费者。要加的那天再加。

## 8. 错误处理汇总

| 情形 | 反应 | 去向 |
|---|---|---|
| 扫描本身失败 | 立即 exit 1，不跑任何 run | stderr |
| 扫描 issue 行（`directory_unreadable` / `depth_truncated`） | 记录，不续跑，不中断 | stderr |
| `ResumeNotEligibleError` | **正常结果**，不是错误 | stdout |
| `RunLeaseHeldError` | 正常结果（别人正在跑） | stdout |
| run 跑到任一终态 | 记录终态 + `stopReason` | stdout |
| 意料之外的抛错 | 记录**完整 message**，继续下一个 | **stderr** |

**sweep 从不静默吞任何一种结果**（Rule 12）。最后一行的取舍说明：意外错误按 §7 的规则不改退出码（它是某个 run 的失败，不是 sweep 的失败），但写到 stderr 就能被 cron 默认的「有 stderr 即告警」行为捞住，不必污染退出码语义。

## 9. 模块边界

| 模块 | 职责 | 依赖 |
|---|---|---|
| `src/sweep/sweepRuns.ts` | 扫描 → 过滤 → 顺序续跑 → 汇报。**无任何写路径。** | `registry/scanRuns`、`controller/resumeLoop` |
| `src/cli.ts` | 新增 `sweep` 命令分支与参数解析 | 上者 |
| `src/controller/leaseHeartbeat.ts` | 改动 A（`runExclusive` 拒绝） | — |
| `src/controller/runLoop.ts` | 改动 B（信号槽）、reconciliation 组装点、`isLeaseStopError` 及其注释 | — |
| `src/persistence/fileStore.ts` | 三文件事务 | — |
| `src/ownership/lease.ts` | `RunHeartbeatStoppedError` | — |

`src/registry/` **零改动**。

## 10. 测试要求

每一条都必须能失败。**「加一个成分和加它的覆盖是一件事」**——测试名里每一个分句都要有一条能失败的断言。

**债 1**

1. **原缺陷复现**（最关键）：构造「transfer 已发布 → `assertHeld()` 抛 → reconciliation 缺失」，证明**修复前** `resumeLoop` 确实拒绝，修复后不再。Rule 9 要求测试编码 WHY，这条就是 WHY 本身。
2. **崩溃注入**：在 finalize 的每一次 rename 之间中断，断言 §4.3 列的**每一个中间态**都让 `resumeLoop` 走拒绝路径，而不是崩溃。
3. **恢复**：v2 marker + 三个 pending → `readOwnerRecord` 触发恢复 → 三文件就位。
4. **v1 兼容**：v1 marker + 两个 pending（无 reconciliation pending）→ 只发布两个，不抛。
5. **顺序钉定**：实际发布顺序 === marker 声明的 `finalizeOrder`。这条是 §4.4 的补偿，让那个字段不再是无人核对的主张。
6. **反方向变异**：`finalizeOrder` 改成 reconciliation 排最后 → 测试 2 必须红；reconciliation 退回事务外 → 测试 1 必须红。**两侧各自单独变异都要红**，否则是同义反复。

**债 3**

7. `runExclusive` 在 `stopped` 后拒绝（直接测 heartbeat 模块）；退回不拒绝 → 该测试必须红。
8. 信号槽置位 → `runLoopFromState` 在相位边界返回 `cancelled` / `stop_requested`，且**不启动新 attempt**。
9. `isLeaseStopError` 三种错误全部识别——否则 §5.3 改掉的那条注释又变成无人核对的主张。

**sweep**

10. 只对观测为 eligible 的行调 `resumeLoop`（scripted adapter + 构造的 run 目录）。
11. 一个 run 被拒绝不中断后续 run。
12. 扫描失败 → exit 1；其余一律 exit 0（含 run 跑成 `exhausted`）。
13. 信号槽置位后不再开下一个 run。
14. **零写入证明**：sweep 扫过一个**不** eligible 的 run 目录，该目录逐字节不变。对齐 L2 spec §15.2 的做法。**这条把「L3 不新增授权」从承诺变成结构性事实。**

**通用**

- 变异注入点必须在**生产代码 / 生产类型**上。往测试数组里注入只证明匹配器有效。
- 证明跨模块断言不是同义反复，要做**反方向变异**：只改 A 侧失败、只改 B 侧也失败。
- 写区间必须带样本数；没带的一律当未定。

## 11. 执行约束

- **§4（债 1）是独立的一节、独立的任务组、独立的评审**，不得与触发逻辑混批（人下的指令）。
- 每任务一次独立评审 + 整分支一次；**修复波之后必须再评审**。本仓库六轮以来 100% 命中「修复波自带缺陷」。
- **评审必须对着代码撞，不接受实施者自证。** 上一轮五波修复五波带缺陷，没有一波是实施者自己发现的。
- **验证跑绝不过滤输出**——`tail` 与 `grep` 同罪。
- **计划不附完整可抄代码**（接口签名 + 测试要求 + 陷阱清单）。
- **每一个算出来的数字旁边就地附一条能重推它的命令。**
- 跑全套件时**只有 flake (B) 与 (F) 允许出现**；名单外任何失败先捕获完整测试名与失败块再比对，不许凭印象归因。
- 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`。
- L1 spec §12 十九条中的第 2/5/7/15/17/19 条不得弱化或删除。
- **所有编辑落地之后，全仓扫一遍指向被改文件的行号引用。**

## 12. 治理与付费调用

治理边界要求「每次真实 Claude 调用前须显式获批（付费）」。`ccloop sweep <root> --adapter claude` 挂进 cron 就是无人值守的付费调用。

**本设计的表态**：操作者在命令行上选择 `--adapter claude`，**即构成对该次 sweep 全部续跑的批准**。把批准点从「每次调用」上移到「每次 sweep 调用」，是这个形态下唯一可执行的语义。为使该批准是知情的，sweep 启动时必须向 stderr 打印将要用哪个 adapter 续跑多少个 run。

藏着不说才是真的破坏边界。

## 13. 继承债与不做的事

| 债 | 本层处置 |
|---|---|
| 1 跨文件事务性 | **本层修**（§4） |
| 2 `persistTerminalState` 往已不拥有的 run 写 | **不碰**，留 L5。修它就造孤儿，孤儿是 L5 的定义域 |
| 3 `heartbeat.stop()` 释放窗口 | **本层修**（§5），关闭，不再传给 L5 |
| 4 非原子写 | 已于 `2026-07-29-atomic-write-paths` 关闭并合并 |

**L5 的继承清单确认为 1 笔**（只剩债 2）。**降到 1 笔是 2026-07-29 那次归属裁决做的，不是本层做的**；本层做的是兑现其中的债 1 与债 3，使该清单不再回涨。

另有一笔本层查实、但不属本层定义域的：`finalizePendingOwnerTransfer` 自己的 catch 里两个 `safeUnlink` 都可能替换正在传播的错误。**§4 会改这个函数，所以本层必须显式表态**：改动只增加「reconciliation pending 存在则一并发布」这一条件分支，**不触碰 catch 块的形状**；该错误掩盖问题原样留给 L5，理由是触发条件是「清理失败与转移失败同时发生」，与本层要修的窗口无关。

## 14. 后续

1. **L5 — cleanup / orphan handling**（父设计 §17 item 3）。输入只剩债 2。
2. **常驻形态**（`watch`）若将来需要，建在 sweep 之上；它会让「飞行中 `stop()`」重新成为问题，届时 §5.2 的论证是起点。

## 15. 验收标准

1. 「transfer 已发布、reconciliation 缺失」这个磁盘状态在本层之后**不可构造**——测试 1 与 2 各自从一个方向证明。
2. 事务的每一个崩溃中间态都让 `resumeLoop` 拒绝，无一例外，且都可由 `recoverInterruptedOwnerTransfer` 推完。
3. `runExclusive` 在 `stopped` 后必然拒绝；退回旧行为则测试 7 变红。
4. sweep 对一个不 eligible 的 run 目录逐字节非变更。
5. `resumeLoop` 的门（`evaluateResumeEligibility`）一个字节未改。
6. 全套件、typecheck、build 三者退出 0，且输出**未经任何过滤**地贴出。
