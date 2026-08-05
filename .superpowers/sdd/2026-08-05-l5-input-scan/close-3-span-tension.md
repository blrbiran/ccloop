# close-3-span-tension —— 收敛 scan-B 与 scan-D 在第 3 笔上的分歧

只读任务。本文件是本次唯一被写入的文件。仓库 `/Users/biran/code/skills/loop/ccloop`，分支 `main`，HEAD 见 §0。
锚点一律用符号名；行号只作当日快照，不作论据。

## 0. 基线与铁律合规

```
$ git rev-parse HEAD && git status --short && echo "STATUS_EXIT=$?"
e9021ef87770acf8052bc4c509e56a1aa226523f
STATUS_EXIT=0
```

（`git status --short` 输出为空 —— 上面那行 `ok` 是 rtk 代理的回显，不是 git 的输出行。工作区干净。）

**只读合规**：本轮未修改 `src/`、`tests/`、`docs/`、台账或任何既有报告。唯一写入的文件是本文件。
`git status --short` 在开工时为空；本文件是新增。

**方法声明**：我先读代码、独立推出结论，再回头读 scan-B 与 scan-D 的对应段落。
下面每条计数都附命令与逐字输出，无一条来自记忆或继承。
锚点用符号名；行号只作 HEAD `e9021ef` 当日快照。

**⚠️ 关于全称否定**：本报告里凡是「只有一个 / 恰好两个 / 没有任何」的断言，
grep 面都写在旁边，且都比被断言的范围宽（例如查 `.stop()` 时不只查 `heartbeat.stop()`）。

## 1. `persistBoundaryAnalysis` 的触发路径（独立核，未继承 L3 spec 的说法）

### 1.1 调用点：恰好 2 个，都在 `runLoopFromState` 内部

```
$ grep -rn 'persistBoundaryAnalysis' src/
src/runtime/types.ts:118:// Task A4 / §4.3: what `persistBoundaryAnalysis` can assemble BEFORE the epoch rule runs.
src/controller/runLoop.ts:724:async function persistBoundaryAnalysis(
src/controller/runLoop.ts:1217:          await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned);
src/controller/runLoop.ts:1266:        // What is NOT a route, because a previous fix wave claimed it was: persistBoundaryAnalysis's
src/controller/runLoop.ts:1271:        await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);
src/controller/leaseHeartbeat.ts:120:  // process (runLoop's persistBoundaryAnalysis), which rotates the epoch to this same process.
src/controller/leaseHeartbeat.ts:204:  // production call site (persistBoundaryAnalysis, runLoop.ts) is the read -> evaluate -> CAS
src/persistence/fileStore.ts:278:// through persistBoundaryAnalysis, and reaches runLoopFromState's outer catch — where
src/persistence/fileStore.ts:459:      //      writeBoundaryArtifacts, through persistBoundaryAnalysis, into runLoopFromState's outer
src/persistence/fileStore.ts:510:        // removed) would propagate out of writeBoundaryArtifacts, through persistBoundaryAnalysis,
```

```
$ grep -rnc 'persistBoundaryAnalysis(' src/controller/runLoop.ts
src/controller/runLoop.ts:3
```

3 = 定义行 `:724` ＋ 两个调用点 `:1217` / `:1271`。其余命中全是注释，无 `(`。
**L3 spec 说的「两个调用点都在 `runLoopFromState` 内部」，我独立核过，属实。**
（`:1266` 是注释里的 `persistBoundaryAnalysis's`，不带括号，不计入。）

### 1.2 两个调用点各自的相位与前置条件（读源码得出，非继承）

两处都在 `runLoopFromState` 的 attempt 循环里、**execute 相位之后**：

- **`:1217`** —— `executeOutcome.timedOut === true` **且** `execution === null`
  （execute 超时且 adapter 连部分结果都没交回）。传入**真实的** `executionRecovery`。
  紧接着 `:1218` 就是 `persistTerminalState(..., "exhausted", ...)`。
- **`:1271`** —— 非超时路径上 `execution === null`
  （execute 正常返回但没有结果）。传入 `executionRecovery = undefined`。
  紧接着 `:1272` 是 `throw new Error("execute phase completed without a result")`。

**触发不需要 `.stop()`，也不需要任何信号。** 两条都是一次普通 run 内部的 execute 异常路径。

### 1.3 什么条件下它才真的**发布**一次 eligible transfer

`persistBoundaryAnalysis` 内部只有一处发布：`:819` 的 `persistOwnerTransfer`，
被三个合取条件守着（`:794`）：

```
boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST" && ownership.takeoverAllowed
```

- `stale_candidate` 的充要条件（`src/stop/stopController.ts` `evaluateRunBoundary`）：
  `!observedStrongProgress && continuitySuspicion.length > 0`。
  `observedStrongProgress` 在 `:750` 写死为 `false`，所以只看 `continuitySuspicion`。
- `continuitySuspicion` 来自 `buildBoundaryEvidence(executionRecovery ?? null)`（`:550`）。
  **`executionRecovery === null` 分支返回 `continuitySuspicion: []`**（`:558`），
  其余每个非 null 分支都返回**非空** `continuitySuspicion`。

=> **`:1271` 传 `undefined` ⇒ 永远拿不到 `stale_candidate` ⇒ 永远不发布 transfer。**
=> **只有 `:1217`（execute 超时且无结果）这一条路能发布。**
   而它还要再满足 `ownership.verdict === "OWNER_LOST" && takeoverAllowed`
   —— 即这个进程**已经把自己判成失去所有权**。

### 1.4 全仓唯一的 transfer 发布链

```
$ grep -rn 'persistOwnerTransfer(' src/
src/controller/runLoop.ts:648:async function persistOwnerTransfer(
src/controller/runLoop.ts:819:          const transfer = await persistOwnerTransfer(

$ grep -rn 'applyOwnerEpochTransfer\|writeOwnerTransferArtifacts\|finalizePendingOwnerTransfer' src/ | grep -v '^\s*//'
src/runtime/types.ts:119:// `newOwnerEpoch` is the one field only `applyOwnerEpochTransfer` (ownerController.ts) can
src/controller/runLoop.ts:12:  writeOwnerTransferArtifacts,
src/controller/runLoop.ts:19:import { applyOwnerEpochTransfer, evaluateOwnership } from "../ownership/ownerController.js";
src/controller/runLoop.ts:656:  const transfer = applyOwnerEpochTransfer(expectedOwnerRecord, nextProcessInstanceId, at, reason);
src/controller/runLoop.ts:658:  // applyOwnerEpochTransfer's own output above — never a second, independently-computed `+ 1`.
src/controller/runLoop.ts:674:      await writeOwnerTransferArtifacts(
src/controller/runLoop.ts:690:  // appendEvent runs exactly once, reached only after writeOwnerTransferArtifacts above
src/controller/runLoop.ts:896:  // applyOwnerEpochTransfer's own output — a second write of the same record here would be
src/ownership/ownerController.ts:160:export function applyOwnerEpochTransfer(
src/persistence/fileStore.ts:162:// actually take there, because applyOwnerEpochTransfer always writes eligibleForContinuation: true.
src/persistence/fileStore.ts:676:// Production must publish owner-transfer.json only through finalizePendingOwnerTransfer.
src/persistence/fileStore.ts:894:// That stays driven by finalizeOrder itself (see the comment on finalizePendingOwnerTransfer).
src/persistence/fileStore.ts:931:async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
src/persistence/fileStore.ts:1021:  await finalizePendingOwnerTransfer(runDir);
src/persistence/fileStore.ts:1029:export async function writeOwnerTransferArtifacts(
src/persistence/fileStore.ts:1068:    await finalizePendingOwnerTransfer(runDir);
src/registry/observeFields.ts:32:    // transaction's writeOwnerRecordAtomically and finalizePendingOwnerTransfer, which both
```

`persistOwnerTransfer` 只有 `:819` 一个调用者；`writeOwnerTransferArtifacts` 只有 `:674` 一个调用者。

**结论**：`persistBoundaryAnalysis` → `persistOwnerTransfer` → `writeOwnerTransferArtifacts`
是全仓唯一能把 `owner-transfer.json` 写成 `eligibleForContinuation: true` 的生产链，
而它整条都在 `runLoopFromState` 内部 —— **只有活着的控制器能发布 transfer。**

## 2. 分歧裁定：B 与 D 问的不是同一个问题

### 裁定：**两者不同题。B 在自己的题上正确；D 在自己的题上未完成，但可以答完（见 §3）。**
### 附带：**D 的一条子断言为假**（「这个前提两处都没写」—— 实际两处都写了，见 §3.3）。

### 2.1 B 实际问的是什么

读 scan-B 项 A-1 的原文（不是台账的压缩转述）：B 把原文那句话**拆成两个命题**，
命题二逐字是：

> **命题二（触发）：「一次并发 `stop()` 可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`」 —— 在今天的 `src/` 里 *没有* 调用者能构造出来。**

**B 问的是：今天有没有任何生产路径能让一次 `stop()` 与飞行中的 `writeBoundaryArtifacts` 重叠。**
B 没有说 `persistBoundaryAnalysis` 没有调用者 —— 恰恰相反，B 自己在同一段写着
「`persistBoundaryAnalysis` 的两个调用点（:1217、:1271）都在 `runLoopFromState` **内部**并被 `await`」。

**⚠️ 分歧的表面来源是一次转述压缩。** 本轮 `progress.md` 把 B 的结论压成
「第 3 笔的触发在今天的 `src/` 内没有调用者」，去掉了「一次并发 `stop()`」这个主语，
读起来像是在说 `persistBoundaryAnalysis` 没有调用者 —— 那才与 D 的问题看似撞车。
**B 的报告原文没有这个问题；台账的转述有。**

### 2.2 B 的命题二我独立复核：**成立，且我把 grep 面放宽后仍成立**

B 用的是 `grep -rnF 'heartbeat.stop()' -- src`。那是一条**收窄的 grep**，
按本轮铁律 6 不足以支撑全称否定。我把面放宽：

```
$ grep -rn '\.stop(\|stop()\|stop,\|{ stop\|stop:' src/ ; echo "=== EXIT=$? ==="
src/cli.ts:169:// not: the two `heartbeat.stop()` call sites stay in the `finally` after runLoopFromState.
src/controller/runLoop.ts:989:    await heartbeat.stop();
src/controller/runLoop.ts:1001:  stop: async () => {},
src/controller/runLoop.ts:1451:        // §8: the same stop, checked again here because this phase boundary can be minutes
src/controller/resumeLoop.ts:215:    await heartbeat.stop();
src/controller/leaseHeartbeat.ts:25:  stop: () => Promise<void>;
src/controller/leaseHeartbeat.ts:208:  // here also covers a call that was made before stop() and only reaches the head afterwards.
src/controller/leaseHeartbeat.ts:232:  // This does NOT substitute for stop() —
=== EXIT=0 ===
```

放宽后新增的四行全部无害：`:169`/`:1451`/`:208`/`:232` 是注释，
`leaseHeartbeat.ts:25` 是接口声明，`runLoop.ts:1001` 是 `INERT_LEASE_HEARTBEAT` 的 **no-op** 实现
（`stop: async () => {}` —— 空函数体，不调 `releaseOwnerLease`）。
**真实调用点仍是 `runLoop.ts:989` 与 `resumeLoop.ts:215` 两处，都在 `finally` 里。**

我再从**危害侧**独立收一遍（B 没做这一步，我补上）——
第 3 笔具名的危害是 `releaseOwnerLease`：

```
$ grep -rn 'releaseOwnerLease' src/
src/controller/leaseHeartbeat.ts:16:  releaseOwnerLease,
src/controller/leaseHeartbeat.ts:254:      await releaseOwnerLease(options.runDir, expected);
src/persistence/fileStore.ts:1171:export async function releaseOwnerLease(runDir: string, expected: OwnerRecord): Promise<void> {
```

**`releaseOwnerLease` 全仓只有一个生产调用点，就在 `stop()` 里。**
所以「谁能在飞行中释放租约」这个问题**等价于**「谁能在飞行中调 `stop()`」，
B 的两个调用点枚举因此是**穷举的**，不是收窄的。**B 的命题二成立。**

### 2.3 D 实际问的是什么

scan-D §5.1 的收尾句逐字：

> **⚠️ 本项未完成**：我**没有**追出「一个正常 run 在什么条件下会在自己被杀之前就发布过 eligible transfer」的完整路径，因此**无法判断这是真矛盾还是一个未写出的前提**。缺的是：`persistBoundaryAnalysis` 在一次正常 run 生命周期内的触发条件。

**D 问的是：一个 run 在盘上留下 eligible transfer 的条件是什么。**
这与「谁能并发调 `stop()`」是两个正交的问题：
D 关心的是 `persistBoundaryAnalysis` 的**成功路径产物**（它写了什么到盘上），
B 关心的是它的**并发暴露面**（谁能在它写的时候插进来）。

### 2.4 为什么不能靠「其中一份对」来给第 3 笔定级

- B 的结论管的是**第 3 笔本身的可达性** —— 它决定第 3 笔今天是不是活缺陷。
- D 的问题管的是 **spec §2/§5.4 的自洽性** —— 它决定 L5 继承的文字有没有内在矛盾。

**两者都要答，答案互不替代。** lane 2 把它们并列成「同一件事的两个结论」是一次归并错误；
但 lane 2 把它列为阻塞项是**对的** —— 因为 D 那一半确实没答，而它落在第 3 笔的同一段代码上。

## 3. D 的「§2 vs §5.4」张力：独立推到底的结论

### 结论：**不是真矛盾。两句话量化在两个不相交的 run 群体上，且区分它们的前提两处都写了。**

### 3.1 两句话的落点

```
$ grep -n '该 run 下一次 sweep 仍然 eligible\|所以下一次 sweep 分不清\|两者的正确处置恰好相同\|被硬杀的进程不会留下 eligible transfer' docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
46:1. **不发起 transfer。** sweep 永不创建所有权决策，只消费已发布的。全仓库唯一能发布 transfer 的生产路径是 `persis...
1350:- `resumeLoop` 的 `finally` 里已有的 `heartbeat.stop()` **尝试**清掉 `leaseAffirmedAt`...
1398:`evaluateResumeEligibility` 也不读事件流。**所以下一次 sweep 分不清「人主动停的」和「被 OOM 杀的」。**
1400:**本层刻意放弃这个区分**，理由：**两者的正确处置恰好相同**——run 停在非终态、所有权未变、租约已释放或将过期，正确动作都是「下一次 sweep...
```

D 引的两句是 `:46` 与 `:1400`。D **没有读到** `:1350` 与 `:1398`。

### 3.2 两个群体

由 §1.3 / §1.4：`owner-transfer.json` 的 `eligibleForContinuation: true` 只能由
**一个活着的控制器**在 `persistBoundaryAnalysis` 的 `:1217` 路径上发布。于是：

- **群体 P1 —— 从未发布过 transfer 的 run。** 一个 `ccloop run` 起的 run，一路健康，
  然后被 OOM / SIGKILL 打死。盘上没有 eligible transfer。
  `resumeLoop` 的准入门第一条就把它挡在外面：
  ```
  src/controller/resumeLoop.ts:43:  if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
  ```
  **sweep 永远看不见它。** 这正是 §2 `:46` 说的「那类 run 本层碰不到（属 L5）」。

- **群体 P2 —— 已经发布过 transfer、正在被 sweep 续跑的 run。**
  它盘上早就有 eligible transfer（否则 sweep 不会捡它）。
  操作者 Ctrl-C 也好、OOM 也好，`owner-transfer.json` 都还在、epoch 未变，
  **下一次 sweep 照样捡它**。这正是 §5.4 `:1400` 说的「正确动作都是下一次 sweep 重新续跑」。

**P1 ∩ P2 = ∅。两句话各自为真，互不矛盾。**

### 3.3 D 说「这个前提两处都没写」—— **这条为假，前提两处都写了**

**§2 `:46` 自己就写了整条链**，逐字（`sed -n '46p'` 的内容）：

> 1. **不发起 transfer。** sweep 永不创建所有权决策，只消费已发布的。全仓库唯一能发布 transfer 的生产路径是 `persistBoundaryAnalysis` → `persistOwnerTransfer` → `writeOwnerTransferArtifacts`；`writeOwnerTransferArtifacts` 只有 `persistOwnerTransfer` 一个生产调用者，而 `persistBoundaryAnalysis` 的**两个**调用点都在 `runLoopFromState` 内部——**transfer 只由活着的控制器发布**。被硬杀的进程不会留下 eligible transfer，那类 run 本层碰不到（属 L5）。

**§5.4 也写了，就在 D 引的那句上方约 50 行**（`:1350`，逐字）：

> - `resumeLoop` 的 `finally` 里已有的 `heartbeat.stop()` **尝试**清掉 `leaseAffirmedAt`，所以下一次 sweep 的 `checkRunLease` 会放行，而 owner epoch 未变、门依然通过——**该 run 下一次 sweep 仍然 eligible**。§10 测试 8b 就是钉这一点的

「owner epoch 未变、门依然通过」**就是** D 说缺失的那个前提，且是主动语态写出来的。

=> **D 的「而这个前提两处都没写」是一条事实错误。** D 自己把该项标了「未完成」，
所以这属于**未完成项内的一条前提误判**，不是违反铁律。方向是**高估矛盾**（把已写的读成没写）。

### 3.4 代码侧的独立佐证：`stopRequested` 槽只挂在 `sweep` 上

```
$ grep -n 'stopRequested' src/controller/runLoop.ts
1029:stopRequested?: StopRequestSignal;
1084:if (options?.stopRequested?.requested === true) {

$ grep -n 'registerStopHandlers' src/cli.ts
170:export function registerStopHandlers(
224:const unregisterStopHandlers = registerStopHandlers(stopRequested);
```

`cli.ts:224` 在 `if (parsed.command === "sweep") { … }` 块内（`:218` 起），
**`run` 与 `resume` 分支都不注册停机处理器**。
所以 §5.4 讨论的「人主动停的」这个群体，**按构造只可能是 P2**。

而 `runLoop.ts:1080-1083` 的源码注释逐字把 §5.4 的主张写在了代码里：

```
    // next sweep cannot tell this apart from an OOM kill. That is accepted here, not overlooked:
    // both want the same handling, and distinguishing them needs a new observed disk field.
```

**代码与 §5.4 一致，且作用域同样是 P2。张力消解。**

### 3.5 残留的**文字**缺陷（不是矛盾，但会误导 L5）

`:1400` 那句「run 停在非终态、**所有权未变**、租约已释放或将过期」里，
「所有权未变」是唯一暗示 P2 的词，而它离 `:1350` 那条显式前提有 50 行，
中间隔着 §5.4 的另外两条 ⚠️。**一个只读 §13 交接清单、跳读 §5.4 的 L5 读者会重复 D 的误读。**
建议（未动手改）：在 `:1400` 那句里把「所有权未变」改写成「该 run 盘上已有的 eligible transfer 未被改动」，
或加一句回指 `:1350`。**这是文档缺陷，与第 3 笔的定级无关，不应并进第 3 笔。**

## 4. 第 3 笔的定级，及它依赖的前提

### 4.0 归属属性（**必须原样带进 L5，不因本报告的结论而改变**）

第 3 笔原文明写它是「**从未被任何裁决记录处理过**的新发现，**归属应当重新裁**」，
**不是**「债 3 的未关闭部分」。
**本报告不裁归属，也不改这条属性。** 无论下面的分级如何，L5 都必须为它做一次**新的归属裁决**。
（同理：`spec:1143` 至今仍写「§13 据此把债 3 记为『exclusive span 部分关闭』」这条文档缺陷
不属本报告范围，见 scan-B 自查第 1 条与 lane 2 主张 3。）

### 4.1 定级

| 前提状态 | 分级 |
|---|---|
| 今天（无常驻形态） | **仅文档 / 纵深防御** —— 结构成立，具名危害不可达 |
| §14.2 常驻形态 `watch` 落地后 | **数据丢失** |

**这与 scan-B 给的分级相同，但我是独立推出来的**，并且比 B 多走了一步：
B 从「谁能调 `stop()`」收口，我另从「谁能调 `releaseOwnerLease`」收口（§2.2），
两条独立枚举都落在同一个 `stop()` 上，**所以这个不可达结论是穷举的，不是收窄 grep 的产物。**

**结构（命题一）今天成立，我复核过**：`runExclusive` 的 `refuseIfStopped` 只跑在 `queue` 的续体头部
（`leaseHeartbeat.ts:209-226`），而 `:891` 的 `assertHeld()` 与 `:903`/`:905` 的
`writeBoundaryArtifacts` 都在 `await heartbeat.runExclusive(...)` **返回之后**（span 收于 `:873`），
从未进入 `queue`；`stop()` 只 `await queue.catch(() => {})`（`:246`），
读到的是已被重置为已决 promise 的 `queue`。**`stop()` 不等待 span 外那段。**

### 4.2 这个定级依赖哪些前提 —— 任一条变了就必须重判

按「变了以后不需要有人读到本报告就会失效」的顺序排：

1. **P1 —— `releaseOwnerLease` 只有 `stop()` 一个生产调用者。**
   重推：`grep -rn 'releaseOwnerLease' src/` 应只见 import（`leaseHeartbeat.ts:16`）、
   `stop()` 内的调用（`:254`）、定义（`fileStore.ts:1171`）。
   **⚠️ 这一条对 L5 最危险**：L5 的本职是 cleanup / orphan GC，
   而「回收孤儿 run 的租约」是 GC 最自然的动作之一。**L5 一旦加第二个 `releaseOwnerLease` 调用者，
   第 3 笔立刻升级为数据丢失，且不需要任何人碰 `stop()` 或常驻形态。**
   这条前提在 scan-B、lane 1、lane 2 三份文件里**都没有被写出来**，是本报告新增的。

2. **P2 —— `stop()` 的生产调用点恰好两个，都在一个 `finally` 里，
   而那个 `finally` 严格在被 `await` 的 `runLoopFromState` 之后。**
   重推见 §2.2 的宽面 grep。**结构条件是「串行」，不是「数目为 2」** ——
   加第三个 `finally` 内调用点不改变分级；把任何一个搬出 `finally`、或让它与飞行中的 run 并存，就改变。

3. **P3 —— §14.2 的常驻形态（`watch`）未落地。这是原文自己点名的那条路。**
   落地即升级为**数据丢失**。这是本表里唯一被 spec 预先写出来的触发条件。

4. **P4 —— `persistBoundaryAnalysis` 的两个调用点都在 `runLoopFromState` 内部且被 `await`。**
   重推：`grep -rnc 'persistBoundaryAnalysis(' src/controller/runLoop.ts` = 3（定义 ＋ 2 调用点）。
   若有人从信号处理器、定时器或第二个并发任务里调它，`stop()` 不必并发也会重叠。

5. **P5 —— `registerStopHandlers` 不碰心跳。**
   今天 `cli.ts:170` 起的处理器只置槽与 `exit(130)`，
   源码注释逐字：「It cannot stop the heartbeat, and does not」。
   处理器一旦获得 `heartbeat` 引用，P2 立即作废。

**核过但判定为不承重的一条**：sweep 是否并发。
`stop()` 是 per-heartbeat 的，两个并发 run 各有各的心跳与 `runDir`，
并发本身不制造「同一个心跳的 `stop()` 与它自己的 run 重叠」。**sweep 并发化不触发重判。**

### 4.3 定级的证据强度声明（按 lane 1 对「不可达」措辞的更正要求）

**准确表述是「未发现可达路径」，不是「不可达」。**
我的推导全部来自逐环静态阅读：**没有跑任何测试，没有构造任何场景，没有注入。**
穷举的是**静态调用图**（`releaseOwnerLease` ← `stop()` ← 两个 `finally`），
不是运行时行为。反射调用、动态导入、测试替身注入到生产路径这三类我**没有**排查。

### 4.4 与第 3 笔**附带第 (iii) 类**的关系

scan-B 的 A-2（L1 §12 第 17 条第 (iii) 类，跨进程 SIGKILL → 删 stale 锁 → 双 finalize 竞争）
**不在本报告范围内**，其分级（可重试拒绝）与归属属性（**L3 自己扩大出来的**）另计。
**不要把 A-1 的「今天仅文档」推广到第 (iii) 类 —— lane 1 已确认第 (iii) 类今天可达。**

## 5. 附带任务：`persistBoundaryAnalysis` 抛出后的路由 —— 有没有第二条不立刻走终态的路由

### 5.1 台账那条 open 项的原文

`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md:511-513`，逐字：

```
  4. IF GROUP B OR C ADDS A SECOND, NON-TERMINAL ROUTE TO persistBoundaryAnalysis,
     the bound that makes the predicate change unsafe today disappears and THE
     RULING REOPENS. Group C's brief must carry this line.
```

### 5.2 今天 HEAD 上枚举全部出口

| 出口 | 触发 | 落点 | 是否终态 |
|---|---|---|---|
| `:1217` 正常返回 | execute 超时且无结果 | `:1218` `persistTerminalState(…,"exhausted")` | **是，立刻** |
| `:1271` 正常返回 | 非超时 `execution === null` | `:1272` `throw new Error(...)` → 外层 catch 泛化分支 → `transitionRunState(state,"failed")` | **是**（`failed` 的 `legalTransitions` 为空 ⇒ `isTerminalRunStatus` 为真） |
| `assertHeld` 抛租约错（`:744` / `:865` / `:891`） | 被夺所有权 | 外层 catch `isLeaseStopError` 分支（`runLoop.ts:1506`）→ `persistTerminalState(…,"cancelled")` | **是**（除非 `state.status` 已终态，那时原样返回） |
| **`runExclusive` 抛 `RunHeartbeatStoppedError`（`:786`）** | 心跳已 `stop()` | 外层 catch **第一条**分支 `runLoop.ts:1489` → `appendEvent("heartbeat_stopped")` ＋ `writeRunState` ＋ **`return state`** | **否 —— 非终态返回** |

```
$ grep -rn 'RunHeartbeatStoppedError' src/
src/controller/runLoop.ts:23:import { RunHeartbeatStoppedError, RunLeaseLostError, RunLeaseUnverifiableError } from "../ownership/lease.js";
src/controller/runLoop.ts:1489:      if (error instanceof RunHeartbeatStoppedError) {
src/controller/leaseHeartbeat.ts:7:  RunHeartbeatStoppedError,
src/controller/leaseHeartbeat.ts:212:        throw new RunHeartbeatStoppedError(
src/ownership/lease.ts:46:export class RunHeartbeatStoppedError extends Error {
src/ownership/lease.ts:51:    this.name = "RunHeartbeatStoppedError";
```

`legalTransitions` 的证据（`src/state/stateMachine.ts:10-19`）：
```
  exhausted: [],
  cancelled: [],
  failed: [],
…
export function isTerminalRunStatus(status: RunStatus): boolean {
  return legalTransitions[status].length === 0;
}
```

### 5.3 核查结果

**⚠️ 是的，今天存在恰好一条这样的路由，而且它是 L3 组 B（B1）加的。**
按 open 项 4 的**字面条件**，触发条件**已经被满足**。

**但那条人裁没有因此重新打开** —— 台账在 B1 动第一行代码**之前**就把这个问题
交给了一名独立验证者，判决与理由逐字记在 `progress.md:641-661`：

```
VERDICT: (B) THE BOUND'S SUBJECT DISAPPEARS; THE RULING DOES NOT REOPEN.
…
  - the refusal point is runExclusive at runLoop.ts:786;
  - the destructive writes are writeBoundaryArtifacts at runLoop.ts:903 and
    :905, i.e. AFTER the runExclusive call closes at :873, deliberately outside
    the exclusive span (the comment at :784 states that placement is on
    purpose);
  - between them sits only the unconditional `await heartbeat.assertHeld()` at
    :891, which B1's hard constraint 2 forbids this error from being thrown by;
  - therefore a RunHeartbeatStoppedError raised at :786 escapes BEFORE any
    boundary or reconciliation write occurs. The harm the bound describes — a
    published winner record silently destroyed — DOES NOT HAPPEN on this route.
    That is not the bound being broken; it is the bound's subject not existing.
```

**该判决所依赖的三条前提，我在 HEAD 上逐条独立复核，全部仍成立：**

1. **拒绝在 `fn` 被调用之前求值。** `leaseHeartbeat.ts:209-226`：
   `refuseIfStopped` 先 `if (stopped) throw`（`:211-215`），再 `return await fn()`（`:218`）。
   `queue.then(refuseIfStopped, refuseIfStopped)`（`:221`）—— 两个位置都是同一个函数，
   正常与异常续体都过这道检查。
2. **`assertHeld` 不读 `stopped`。**
   ```
   $ grep -n 'stopped' src/controller/leaseHeartbeat.ts
   :39 (声明) :79(注释) :139(runAffirm) :194/:196/:198/:199/:207(注释) :211(runExclusive)
   :213(错误消息) :240/:244(stop 自身) :301/:319(注释)
   ```
   `assertHeld` 的函数体起于 `:275`，其内**零命中** `stopped`。
   ⇒ `:891` 的 `assertHeld` **不可能**抛出 `RunHeartbeatStoppedError`。
3. **`writeBoundaryArtifacts` 仍在 `runExclusive` 收口之后。** 见 §4.1（span 收于 `:873`，
   写在 `:903`/`:905`）。

**结论：今天没有「第二条会让人裁重新打开」的路由。**
字面条件满足了一次，但已被独立判决并记账；判决的三条支柱在 HEAD 上仍成立。
**组 C 也做过自己的确认**（`progress.md:1219-1235`）：C1 不新增路由，
只让**一条已有路由每进程被走 N 次**，判决同样是 `THE RULING DOES NOT REOPEN`，
记为「exposure ×N per invocation, mechanism unchanged」。

### 5.4 必须带进 L5 的一句（这条 open 项**没有关闭**，只是被答过一次）

open 项 4 的字面条件是「**加了**第二条非终态路由」。它已经被满足过一次，
而回答之所以是「不重开」，**完全依赖第 3 笔的那个「span 外」结构** ——
`RunHeartbeatStoppedError` 从 `:786` 逃出时**还没到** `:903`/`:905` 的写。

**⚠️ 这产生一个 L5 必须知道的耦合，本轮四份扫描与两条评审车道都没有点出来：**
**如果 L5 为了修第 3 笔而把 `writeBoundaryArtifacts` 搬进 exclusive span，
`RunHeartbeatStoppedError` 的逃逸点就跑到写的*后面*，
「the bound's subject not existing」这条理由随即失效，那条人裁就**真的**重新打开。**
=> **第 3 笔的修法与「保留即放宽」那条人裁是绑定的，不能分开决策。**
（这也正是原文说「本层不修，因为覆盖它要么把 artifact 写搬进 span（L1b 刚明确否决过），
要么另设一层守卫」时那个「L1b 否决」之外的**第二个**理由 —— 而这个理由没被写进 §13。）

## 6. 我自己的未完成项

**必须进下一位读者的输入，不许当成已查。**

1. **未跑任何测试、未构造任何场景、未做注入。** 全部结论来自静态阅读。
   §4.1 的「今天未发现可达路径」若要用来**授权改动**，按 lane 1 对组 B 那条的同一理由
   （全称否定命题，论域变了原穷举就不再穷举），**必须真跑一次，不能继承本报告。**
2. **未排查反射调用 / 动态 `import()` / 测试替身泄进生产路径**这三类绕过静态调用图的方式。
   §2.2 的「`releaseOwnerLease` 只有一个生产调用者」只在静态调用图上穷举。
3. **未读 `evaluateOwnership`（`src/ownership/ownerController.ts`）的判据全文。**
   §1.3 里 `ownership.verdict === "OWNER_LOST" && takeoverAllowed` 这一段
   我只确认了它是发布 transfer 的**必要条件**，**没有**追出它在一次正常 run 里
   何时为真。这不影响 §3 的结论（§3 只需要「必须由活着的控制器发布」这个方向），
   但**若有人要问「一个正常 run 多容易留下 eligible transfer」，本报告答不了。**
4. **未核 §14.2 常驻形态 `watch` 的原文。** §4.2 的 P3 是从 scan-B 的转引与 §13 原文里
   拿到的「§14 第 2 条」，**我没有回 spec 逐字核这一条的编号与措辞**
   （派单写的是「§14.2」，scan-B 引的是「§14 第 2 条」，两者是否同一条我没验）。
   **这是一个未验的锚点，L5 引用前须自核。**
5. **§3.5 的措辞建议未做影响面检查** —— 我没有查 `:1400` 那句话有没有被别处按名字引用。
   **不要照抄执行。**
6. **未核 scan-B 报告里 A-1 之外的其它段落**，也未核 scan-D 的其它 12 条。
   本报告只裁 lane 2 点名的那一处分歧。
7. **§5.4 那条耦合（搬进 span ⇒ 人裁重开）我只做了静态推理**，
   没有去 GATE-A 的裁决记录里核「the bound」的原始表述是否真的只在讲
   「已发布的 winner 记录被静默销毁」这一件事。**若「the bound」的外延更宽，
   §5.4 的耦合结论要重判。**

**Rule 6 记账**：本任务超出 CLAUDE.md 的 12,000 token 单任务预算，
按 Rule 12「fail loud」在此明写，而非静默超支。
