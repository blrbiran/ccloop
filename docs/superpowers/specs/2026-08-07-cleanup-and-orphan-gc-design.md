# L5 —— Cleanup 与 Orphan GC 的边界设计

> Status: proposed on 2026-08-07。**未实现**：本文只定边界与不变式，`src/` 与 `tests/` 本轮一字未动。
> Scope: 定义 L5 什么该保留、什么可以删、删的判据与模块边界，并把「GC 不得自行回收租约」写成不变式。**不写代码，不定保留时长，不解决 §7 指向的继承项。**
> Parent design: [`2026-07-22-ownership-and-reconciliation-boundaries-design.md`](2026-07-22-ownership-and-reconciliation-boundaries-design.md) §17 item 3（授权 retained 与 cleaned up 两者）
> Parent design: [`2026-07-21-stop-no-progress-stale-boundaries-design.md`](2026-07-21-stop-no-progress-stale-boundaries-design.md) §15 item 3 ＋ §13（禁令与义务）
> 起点: [`2026-07-29-atomic-write-paths-design.md`](2026-07-29-atomic-write-paths-design.md) §10 第 4 条（崩溃残留的临时文件，清理归属未分配）
> Sibling design: [`2026-07-26-run-lease-and-heartbeat-design.md`](2026-07-26-run-lease-and-heartbeat-design.md)（L1 分层表，§5.3）、[`2026-07-28-run-registry-design.md`](2026-07-28-run-registry-design.md)（L2）、[`2026-08-01-sweep-and-transactional-continuation-design.md`](2026-08-01-sweep-and-transactional-continuation-design.md)（L3）

**读者须知**：本文的每一条事实断言都附了能重推它的命令与该命令当时的输出。
行号一律标注「2026-08-07 实测」并仅作辅助 —— **定位以逐字引用与符号名为准**，行号会腐坏。

## 1. P1 —— 不变式：L5 的 GC 不得自行回收租约

**这一节排在第一位是人裁明令**：它是本 spec 唯一一条「写错了就直接造成数据丢失」的约束。

### 1.1 事实

`releaseOwnerLease` 全仓**只有 `stop()` 一个生产调用者**：

```bash
grep -rn 'releaseOwnerLease' src/ tests/
# src/controller/leaseHeartbeat.ts:16:  releaseOwnerLease,
# src/controller/leaseHeartbeat.ts:254:      await releaseOwnerLease(options.runDir, expected);
# src/persistence/fileStore.ts:1175:export async function releaseOwnerLease(runDir: string, expected: OwnerRecord): Promise<void> {
# （其余命中全在 tests/：leaseLifecycle.integration.test.ts 的 4 处注释、leaseStore.test.ts 的 3 处）
```

`src/` 内只有三行：`fileStore.ts:1175` 是定义，`leaseHeartbeat.ts:16` 是 import，
`leaseHeartbeat.ts:254` 是**唯一的调用**。该调用落在 `const stop = async (): Promise<void> => {`
的函数体内（`leaseHeartbeat.ts:239` 起，2026-08-07 实测；行号仅作辅助，定位以符号名 `stop` 为准）：

```
  const stop = async (): Promise<void> => {
    ...
    try {
      await releaseOwnerLease(options.runDir, expected);
    } catch {
      // Swallowed by contract: the lease simply ages out.
    }
  };
```

### 1.2 含义 —— 为什么这条必须是不变式而不是待裁选项

L5 输入盘点 §13 第 3 笔今天被记为「未发现可达路径」，**而那个判定完全依赖「租约的回收只发生在
`stop()` 里」这个今天的事实**。

*** **L5 的本职 GC 一旦自己回收租约，§13 第 3 笔立刻从「未发现可达路径」升级为数据丢失 ——
不需要任何人碰 `stop()`，也不需要常驻形态落地。L5 的正常工作方式恰好会触发它。** ***

一个「回收孤儿 run」的 GC 最自然的写法就是「这个 run 没人要了，把它的租约放掉」。
这正是本条不变式要挡住的写法。

### 1.3 不变式

> **INV-1：L5 的 GC 不得调用 `releaseOwnerLease`，也不得以任何其它方式写 owner-record 的租约字段。**

L5 判定「这个 run 的 owner 已经不在了」时，**允许的动作只有观测与上报**：
读 owner-record、按 L1 的新鲜度判据得出结论、把结论作为 L5 自己的输出记录下来。
**让租约自然过期（age out）是唯一被允许的回收方式** —— 它已经是 `stop()` 那个 `catch` 块
逐字写下的兜底契约（`// Swallowed by contract: the lease simply ages out.`）。

**这条不变式怎么被钉住**：本 spec 不引入实现，因此这里只定义**验收要求** ——
L5 实现落地时必须带一条测试，断言 L5 的 GC 路径不产生对 owner-record 租约字段的写。
⚠️ 仅靠代码评审兜住这一条是不够的，理由见 §6。

### 1.4 与 §13 第 3 笔的耦合 —— 两者必须一起决策

上一轮四份扫描与两条评审车道**都没点出这条耦合**，在此记明：

§13 第 3 笔「今天不重开『保留即放宽』人裁」的理由，**完全依赖「span 外」这个结构** ——
即逃逸点排在写的前面。

*** **若为修第 3 笔把 `writeBoundaryArtifacts` 搬进 span，逃逸点就跑到写的后面，
那条理由随即失效，「保留即放宽」那条人裁*真的会重开*。** ***

=> **两者必须一起决策，不能分两轮。** 本 spec 不做这个决策（它不在 L5 本职范围内），
但**明确记下：谁先动其中一边，谁就必须同时把另一边摆上桌。**

## 2. L5 受两份委任状约束，不是一份

⚠️ 上一轮曾有转述把 L5 的委任状指到 `2026-07-28-run-registry-design.md` §17，**而该文件止于 §15**
（`grep -n '^## ' docs/superpowers/specs/2026-07-28-run-registry-design.md` 实测 15 条，末条为
`567:## 15. Success Criteria`）。**以下两处路径与节号均由本文作者跑命令重新确认。**

### 2.1 第一份 —— 授权：`retained` 与 `cleaned up` **两者**

`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md` **§17 item 3**
（`grep -n '^## '` 实测 `375:## 17. Follow-On Specs Required`）。逐字：

> 3. **Cleanup / orphan handling design**
>    - how superseded or lost-owner workspaces and evidence are retained or cleaned up safely.

*** **它同时授权 `retained` 与 `cleaned up`。** *** 本仓库此前的九份报告一次没提「保留」这半，
人裁明令不许只想着删。**§3 把 `retained` 写成完整的一半，不是脚注。**

L1 分层表也把 L5 认作这一条：`2026-07-26-run-lease-and-heartbeat-design.md` 逐字写
`L5 corresponds to the third follow-on spec named in the ownership design §17 and remains unwritten.`
—— **本文即是它，本行落盘后该句的后半（remains unwritten）不再成立**；本 spec 无授权去改那份文档，
在此记明，留给后续按本仓库体例就地勘误。

### 2.2 第二份 —— 禁令与义务

`docs/superpowers/specs/2026-07-21-stop-no-progress-stale-boundaries-design.md` **§15 item 3 ＋ §13**
（`grep -n '^## '` 实测 `290:## 13. Cleanup Is Not Part of This Layer`、
`334:## 15. Follow-on Specs Required`）。

§15 item 3 逐字：

> 3. **Cleanup / orphan handling spec**
>    - define how retained stale surfaces are inspected, preserved, or eventually cleaned up without violating evidence safety.

§13 逐字（`:296`–`:299`，2026-08-07 实测；定位以 §13 标题
`## 13. Cleanup Is Not Part of This Layer` 为准）：

> - stale detection and reconciliation may identify retained or orphaned execution surfaces,
> - but they may not treat “stale” as permission to delete them.
>
> Later cleanup design must consume stale/reconciliation output explicitly rather than being fused into it.

### 2.3 两份怎么合起来约束本 spec

方向互补，不重复：

| | 第一份（07-22 §17.3） | 第二份（07-21 §15.3 ＋ §13） |
|---|---|---|
| 性质 | **授权** | **禁令 ＋ 义务** |
| 给什么 | 允许 retain，也允许 clean up | 不允许把 "stale" 当成删除许可 |
| 要什么 | safely | inspected / preserved；**显式消费**，不得与 stale 检测融合 |

**本 spec 必须同时满足两份**，落点：

- 「不得把 stale 当删除许可」=> **INV-2**，见 §4.1；
- 「显式消费而非融合」=> **INV-3**，见 §3.4，并直接决定了 L5 的模块边界（§4.3）；
- 「retained 是完整的一半」=> §3 整节。

## 3. `retained` 半边（完整的一半，不是脚注）

### 3.1 今天就活着的一个保留判定

`retained` 不是本 spec 新造的概念，仓库里已经有一个在跑：

```bash
grep -rn 'cleanupStatus' src/
# src/runtime/types.ts:67:  cleanupStatus: "retained" | "removed";
# src/controller/runLoop.ts:328:): Promise<ExecutionRecovery["cleanupStatus"]> {
# src/controller/runLoop.ts:526:  cleanupStatus: ExecutionRecovery["cleanupStatus"],
# src/controller/runLoop.ts:536:    cleanupStatus,
# src/controller/runLoop.ts:1225:          const cleanupStatus = await cleanupAttemptWorkspaceWithStatus(
# src/controller/runLoop.ts:1232:          if (cleanupStatus !== executionRecovery.cleanupStatus) {
# src/controller/runLoop.ts:1237:                cleanupStatus,
```

语义：**清理失败即保留**，并落一条具名事件：

```bash
grep -rn 'workspace_cleanup_failed' src/
# src/controller/runLoop.ts:334:      type: "workspace_cleanup_failed",
```

**本 spec 采纳这个既有形状，不另造一套词汇**（Rule 11：conformance > taste）：
L5 的每一次处置都必须归到 `retained` 或 `removed` 两个值之一，且 `retained` 必须可解释
—— 是「按规则保留」还是「想删但删失败了」，两者的事件必须能被区分。

### 3.2 什么该保留

按 §2 两份委任状，以下四类**默认保留**，L5 不得因为「看起来没人要了」就删：

1. **证据类**（evidence）—— 07-22 §17.3 与 07-21 §13 都直接点名。
   `events.jsonl`、`boundary-analysis.json`、`reconciliation-record.json` 属于此类。
2. **被 stale 检测识别出来的执行面** —— 07-21 §13 的禁令直接覆盖，见 §4.1 INV-2。
3. **被 superseded 的 owner 的记录** —— 它是「谁在什么时候失去了所有权」的唯一证据；
   删掉它等于把一次 supersession 变成无法复盘的事件。
4. **清理失败留下的工作区** —— 已经由 `cleanupStatus: "retained"` ＋
   `workspace_cleanup_failed` 表达；L5 **不得**把它当成「上次没删干净、这次补删」的输入
   而无条件重试删除，理由见 §4.2。

### 3.3 保留多久、谁来判

**本 spec 不定具体时长**，理由是本仓库已经栽过「凭一个没有判据的数字下结论」的跟头。
本 spec 只定判据的**形状**：

- **保留的终止条件必须是一个可判定的谓词，不能是一个裸时长。**
  「超过 N 天」单独不构成删除许可；它至多是**候选条件**，还必须叠加一个所有权/终态判据
  （例如：run 已达终态 **且** 其租约已按 L1 的判据过期 **且** 无未消费的 reconciliation 输出）。
- **判定者是 L5，执行者也是 L5，但输入不是 L5 自己产生的** —— 见 §3.4。
- **判不出来就保留。** 与 07-22 §7.3 对 `OWNER_UNDECIDABLE` 的取向一致：
  **无法判定时偏向保留，不偏向删除。**

### 3.4 INV-3 —— 「显式消费 stale/reconciliation 输出」在设计上怎么落

07-21 §13 的义务逐字是 `Later cleanup design must consume stale/reconciliation output explicitly
rather than being fused into it.` 落到设计上是三条可检查的要求：

> **INV-3a（数据流单向）**：L5 **读** stale / reconciliation 的**已落盘输出**，
> 不参与产生它们。L5 不得调用 stale 检测或 reconciliation 的写路径。
>
> **INV-3b（不得融合）**：L5 的判定逻辑不得内联进 stale 检测或 reconciliation 的代码路径，
> 也不得反过来把 L5 的删除决策塞进它们的返回值。两者是**两个模块、两次调用**。
>
> **INV-3c（显式即可追溯）**：L5 每一次删除决策都必须能指名**它消费了哪一条**
> stale / reconciliation 输出。**消费不到就不删** —— 这是 INV-3 与 §3.3「判不出来就保留」的合流点。

INV-3b 是本条里最容易被违反的一条：把 L5 的 GC 挂在 reconciliation 结束时顺手跑一遍，
在实现上非常自然，**而那正是 07-21 §13 明写要挡的 "being fused into it"**。

## 4. `cleaned up` 半边 —— 边界画在哪

### 4.1 INV-2 —— stale 不是删除许可

> **INV-2：L5 不得把「某个面被判为 stale」单独当成删除它的许可。**

直接来自 07-21 §13 逐字 `but they may not treat “stale” as permission to delete them.`

「stale」是 L5 删除判据的**必要不充分条件**。L5 要删一个面，除 stale 之外还必须同时满足
§3.3 的所有权/终态判据与 INV-3c 的可追溯要求。

### 4.2 L5 的本职删除面：崩溃残留的原子写临时文件

这是人裁定死的起点（起点文档 §10 第 4 条），也是本 spec 唯一一个**明确归属给 L5 的删除面**。

**为什么今天两条现存清理路径都够不着它**（起点文档已逐一核对代码，本文复核后仍成立）：

- `ensureFreshRunDir` 只对三个具名文件（`loop-contract.json`、`loop-state.json`、`events.jsonl`）
  加 `attempts/`、`worktrees/` 两个目录的条目做阻塞 —— 临时名不在其中；
- `cleanupOwnerTransferStagingWithoutMarker` 只清 `getOwnerTransferPaths` 的固定名
  （**十个，见 §5.1**），而 `buildAtomicTempPath` 生成的名字带一个进程戳与一个自增序号
  （§5.2），**按 §4.1 的要求本就必须不在任何固定名集合之内**。

=> **数字变了（4→10），但「够不着」这个结论没变**：固定名集合再长，也不可能包含一个含随机化
进程戳的名字。

**L5 对这个面的删除判据**（形状，不是实现）：

- 目标必须**同时**匹配 `buildAtomicTempPath` 的五段形（§5.2）**且**位于一个 run 目录内；
- 生成它的进程必须**不再活着**（进程戳里的 `pid` ＋ `timeOrigin` 给出了判据；
  ⚠️ 仅凭 pid 不够 —— pid 会复用，`timeOrigin` 正是用来消歧的那一段）；
- 该 run 必须没有正在进行的 owner-transfer 事务（否则 L5 会去踩 `finalizePendingOwnerTransfer`
  的恢复面）。

⚠️ **不要顺手把 `cleanupOwnerTransferStagingWithoutMarker` 扩成通配删除来解决它。**
那会把一个「无界垃圾」问题换成一个能踩事务恢复面的问题，**代价方向反了**。

### 4.3 模块边界

由 INV-3b 直接推出：

- L5 是**独立模块 ＋ 独立入口**，不是挂在 reconciliation 或 stale 检测尾巴上的一段代码；
- L5 的输入是**已落盘的**观测输出（L2 registry 的观测、reconciliation 的记录），
  **不是**这些模块的内存返回值 —— 后者会让 INV-3a 的单向性在实现上失守；
- L5 不得反向修改它消费的任何输入。

### 4.4 「只有 L5 能删」是一句有限定的话

§5.3 已经说明：分层表只能证「**只有 L5 被显式标注为 deletion**」。

落到设计上的实际后果：**L5 不得假设自己是仓库里唯一会删东西的角色**。
现成反例 `git worktree remove --force` 是实质删除却不叫 deletion。因此：

- L5 判定「这个工作区还在」不能等价于「没人删过它」——
  L5 的每一次删除前必须**重新观测**目标是否仍存在，不得依赖上一次观测的缓存结论；
- L5 遇到目标已不存在，**这不是错误**，应记为 `removed`（或明确的 `already-absent`），不得报故障。

### 4.5 非本 spec 授权的删除面

以下**不在**本 spec 授权范围内，L5 不得删：§3.2 的四类保留面、任何 run 目录本身、
任何 `worktrees/` 下的条目（它归 run 生命周期，不归 GC）。
要动它们需要一次新的人裁，不由 L5 自行扩权。

## 5. 今天的残留面（2026-08-07 实测，不是文档里的旧数字）

本节的每一行都附了能重推它的命令与该命令当时的输出。**引用起点文档时以本节为准，不以起点文档
自己写的数字为准** —— 起点文档最后一次被碰是 2026-08-01，而残留面在 2026-08-02 变过两次。

### 5.1 `cleanupOwnerTransferStagingWithoutMarker` 清的是十个固定名，不是四个

```bash
awk '/^async function cleanupOwnerTransferStagingWithoutMarker/,/^}/' src/persistence/fileStore.ts \
  | grep -c "await safeUnlink"
# 实测输出：10
```

十个名字全部来自同一次 `getOwnerTransferPaths(runDir)` 解构，逐字为
`ownerPendingPath`、`transferPendingPath`、`reconciliationPendingPath`、
`ownerTempPath`、`transferTempPath`、`reconciliationTempPath`、
`ownerPendingTempPath`、`transferPendingTempPath`、`reconciliationPendingTempPath`、
`transactionMarkerTempPath`。

**演化**：4 → 7（`0f940ea`）→ 10（`dad8a14`），**两笔都在 2026-08-02**。

```bash
git log --format='%h %ad %s' --date=short -1 0f940ea
# 0f940ea 2026-08-02 feat(fileStore): publish the transaction marker and both pendings by temp+rename
git log --format='%h %ad %s' --date=short -1 dad8a14
# dad8a14 2026-08-02 feat(fileStore): make reconciliation-record.json the third file of the owner-transfer transaction
```

起点文档 `2026-07-29-atomic-write-paths-design.md` 最后一次被碰在这两笔**之前**：

```bash
git log --format='%h %ad %s' --date=short -1 2e30d1c
# 2e30d1c 2026-08-01 docs: finish the reference sweep 9e554ce claimed to have finished
```

**该数字已由本轮就地勘误修正**（见 §9）。⚠️ 注意时序：在本 spec 与那条勘误落盘**之前**，
`grep -c "Amended" docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md` 实测为 `0`；
勘误落盘之后该计数不再是 0。**引用这个计数必须带上「在哪个提交上测的」**。

### 5.2 临时文件名：三种写法在流通，以源码生成为准

源码是唯一判据（`src/persistence/fileStore.ts`，符号 `buildAtomicTempPath` 与
`ATOMIC_TEMP_PROCESS_STAMP`）：

```
const ATOMIC_TEMP_PROCESS_STAMP = `${process.pid}.${Math.trunc(performance.timeOrigin)}`;

export function buildAtomicTempPath(targetPath: string): string {
  atomicTempPathSequence += 1;
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${atomicTempPathSequence}.tmp`,
  );
}
```

**实际生成的名字是五段**：`.{basename}.{pid}.{timeOrigin}.{seq}.tmp`。
起点文档 §10 第 4 条写的五段形 `.{basename}.{pid}.{startTime}.{seq}.tmp` **与源码一致**
（`startTime` 即 `Math.trunc(performance.timeOrigin)`）。

台账与 handoff 里流通的四段 `{stamp}` 形是**模板层面的描述**（模板字面量确实只有四个插值），
但 `ATOMIC_TEMP_PROCESS_STAMP` 自己会展开成两段，所以**四段形描述的是模板、不是落盘的文件名**。
**本 spec 一律引用五段形；任何文档若按四段形去匹配落盘文件名，都匹配不上。**

### 5.3 L5 的删除授权：有限定的表述

L1 分层表把 deletion 记在 L5 名下（`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`）：

```bash
grep -n 'cleanup / orphan GC' docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md
# 41:| L5 | cleanup / orphan GC | deletion |
```

⚠️ **这条只能证「只有 L5 被*显式标注*为 deletion」，不能证「只有 L5 可能删东西」。**
现成反例：`git worktree remove --force` 是实质删除，却不在任何一层的 "New authority" 格里叫
deletion。**本 spec 不把它写成无限定的全称断言**，落到设计上的后果见 §4。

### 5.4 定性：这是无界垃圾，不是故障

起点文档 §10 第 4 条逐字写着 **「定性要准确：这是无界垃圾，不是故障。」** 与
**「不要把它上报成缺陷。」**，扫描员复核后判定该定性**今天仍然成立**（未找到任何功能性破坏路径）。

**本 spec 承接这个定性，不升级它。** 本 spec 的立项理由不是「有缺陷要修」，而是
§2 那两份委任状**明确点名**了一份尚未存在的 cleanup / orphan 设计。
本轮设计过程中**没有**找到新的功能性破坏路径；若后续有人找到，那是重要发现，
应原样上报并由人裁重新定性，**不由实施者自改**。

## 6. 风险面 —— 一道无法证明兑现过的防线

### 6.1 事实

起点文档 §10 第 3 条逐字：

> 3. **`writeOwnerTransferRecord` 仍可被误用**：只加了注释，没有机制强制。真正的防线是 L3 的评审。

那条注释今天还在（`src/persistence/fileStore.ts`，符号 `writeOwnerTransferRecord` 定义处上方），
逐字首句是 `// Production must publish owner-transfer.json only through finalizePendingOwnerTransfer.`

**五份 L3 门报告全部在盘上**（这推翻了上一轮「门报告没落盘」那个前提），
但它们全都没有提过这个函数名：

```bash
grep -rc 'writeOwnerTransferRecord' $(find .superpowers/sdd -iname '*gate*' -type f)
# .superpowers/sdd/2026-08-05-l5-input-scan/scan-C-backoff-and-gate-carries.md:0
# .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-c-fix-wave-report.md:0
# .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-a-package-src-and-plan.diff:0
# .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-a-option2-report.md:0
# .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-c-lane2-report.md:0
# .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-b-lane2-report.md:0
# .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-a-package-tests.diff:14
# .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-a-fix-wave-report.md:0
```

**五份门报告（`.md`）全部为 0。** 唯一非零的 `gate-a-package-tests.diff` 是一份测试 diff、不是门报告。

**缺的不是报告，是报告与 §10 第 3 条之间的对应关系。**

该函数今天**零生产调用者**、仍 `export`：

```bash
grep -rn 'writeOwnerTransferRecord' src/ tests/
# src/persistence/fileStore.ts:689:export async function writeOwnerTransferRecord(...)
# （src/ 内仅此一行 —— 定义，无任何生产调用点）
# tests/ 内 22 处调用，分布于 tests/persistence/fileStore.test.ts、
# tests/controller/runLoop.integration.test.ts、tests/registry/zeroWrite.test.ts
```

⚠️ **这里要说准**：该函数**并非无测试触及** —— `tests/` 里有 22 处调用。
但这 22 处**全部是把它当 fixture 用来构造场景**，**没有任何一处断言 §10 第 3 条那条约束本身**
（即「生产不得走这个函数」）。**「无测试」与「无测试钉住那条约束」是两回事，本节取后者。**

### 6.2 这对 L5 意味着什么

**记为 L5 的风险面**：

> **RISK-1：「靠人评审兜住、事后无法证明兑现」的防线，在本仓库已有一个实例走完了整个生命周期
> 并且无法证明兑现过。**

这个形状的特征是：约束写在注释里 → 声明由评审兜底 → 评审确实发生了、报告确实落盘了 →
**但报告里没有任何一处能对上那条约束**。事后想验证「这道防线兑现了吗」，**查无可查**。

**=> L5 自己的设计不应再依赖同型防线。**

具体到本 spec：

- §1 的 INV-1（不得回收租约）**必须由测试钉住，不得只写成注释加一句「评审会看」**
  —— 这一条已写进 §1.3；
- §3 与 §4 的 INV-2 / INV-3 同理，验收要求见 §8.2；
- 凡是本 spec 写下「不得 / 必须」的地方，都要能回答**「哪条测试会在它被违反时变红」**。
  回答不出来的，就明写成「今天没有机制强制」，**不要写成「由评审保证」** ——
  后者在本仓库已被证明是不可验证的表述。

## 7. 继承项 —— 只放指针，不放内容

L5 继承了一批输入，但**它们不在本 spec 解决**：包 2 的三条今天可达的数据丢失、
§13 第 3 笔、组 B 的两条债，以及 L5 输入盘点里的其余各项。

**它们的权威清单只有一份**：

> [`.superpowers/sdd/2026-08-05-l5-input-scan/progress.md`](../../../.superpowers/sdd/2026-08-05-l5-input-scan/progress.md)

**本节为什么只放指针**：本仓库已经有过一个真实的文档缺陷 —— **两份交接清单并存、彼此之间没有指针**，
于是两份各自腐坏、读者无从知道该信哪一份。**本节存在的全部目的就是不造出第三份。**

⚠️ **因此本节刻意不重述那些项的技术内容。** 在这里复述它们，就等于造出第三份清单，
与本节的目的直接自相矛盾 —— 要看内容，去上面那份台账。

**唯一的例外**是 §1.4 记下的那条耦合（§13 第 3 笔与「保留即放宽」人裁必须一起决策）：
它出现在本 spec 里不是因为它是继承项，而是因为**它直接约束 §1 的不变式怎么被修改**。

## 8. 非目标与验收要求

### 8.1 非目标

本 spec **不做**以下事情，逐条明写以免被后来者当成遗漏：

1. **不写代码。** 本 spec 只定边界与不变式；`src/` 与 `tests/` 在本轮一字未动。
2. **不定具体保留时长**（理由见 §3.3）。
3. **不解决 §7 指向的任何继承项。**
4. **不重开「保留即放宽」人裁**，也不改动 §13 第 3 笔的现有判定 —— 只在 §1.4 记下二者的耦合。
5. **不把起点文档 §10 第 4 条升级成缺陷**（理由见 §5.4）。本轮未找到功能性破坏路径。
6. **不定 L5 的触发形态**（手动命令 / 常驻 / 挂在 sweep 后）。它取决于 L4，且 §4.3 的模块边界
   对三种形态都成立。

### 8.2 验收要求（给 L5 实现落地时用）

按 §6.2，每一条不变式都要有一条会变红的测试，而不是一句「评审会看」：

| 不变式 | 内容 | 达标判据 |
|---|---|---|
| **INV-1** | L5 GC 不得回收租约 | 存在一条测试：让 L5 的 GC 跑过一个 owner 已失联的 run，断言 owner-record 的租约字段**零写入**。把该断言删掉后测试必须变红 |
| **INV-2** | stale 不是删除许可 | 存在一条测试：构造一个仅满足 stale、不满足 §3.3 其余判据的面，断言 L5 **不删** |
| **INV-3a/b** | 显式消费、不得融合 | L5 模块不 import stale / reconciliation 的写路径；且 reconciliation 的代码路径不调用 L5 |
| **INV-3c** | 消费不到就不删 | 存在一条测试：拿走 reconciliation 输出后，断言 L5 **不删** |
| §4.4 | 不假设自己是唯一删除者 | 存在一条测试：观测之后、删除之前把目标移走，断言 L5 记 `removed` / `already-absent` 而**不报故障** |

⚠️ 上表是**要求**，不是已完成事项 —— **本 spec 落盘时这五条测试一条都不存在**，
因为本轮无 `tests/` 授权。它们随 L5 实现一起落地。

## 9. 本轮对外部文档的唯一一处改动

本轮除新建本文外，只动了一处：给
[`2026-07-29-atomic-write-paths-design.md`](2026-07-29-atomic-write-paths-design.md) §10 第 4 条
落了一条**就地勘误**（原句一字未动，紧随其后加注），把「只清 `getOwnerTransferPaths` 的**四个固定名**」
更正为**十个**，依据见 §5.1。

**勘误只改数字，不改结论**：该条要证的事 ——
`cleanupOwnerTransferStagingWithoutMarker` 够不着 `buildAtomicTempPath` 生成的名字 —— **仍然成立**，
理由见 §4.2。**本仓库立场：过度勘误本身也是缺陷**，故未顺手改动该条的其余部分，
也未改动 §10 第 4 条的定性段落（§5.4）。

**本轮未改动**：任何台账、`docs/handoff/handoff.md`、其它 spec/plan、`src/`、`tests/`。
