# 裁决记录：四笔遗留技术债的归属

日期：2026-07-29
起点：`main` @ `ad0c4f5`，29 files / 427 tests 全绿，typecheck / build 干净（本轮独立复跑坐实）
范围：**只裁决归属。不写 spec，不改代码。**
前置阅读：`docs/handoff/handoff.md`、`.superpowers/sdd/2026-07-2{6,7,8}-*/progress.md`

本记录的每一条结论都对着 `src/` 的实际代码核实过。**其中两条推翻了 handoff 的描述**，见债 1 与债 4。

**关于「核实」的口径（初稿曾在此处过度声称，已更正）**：初稿写「未接受 handoff 或 ledger 的转述」，但债 3 的关键前提——「`runLoop` 与 `resumeLoop` 都在 `finally` 里 await 完才 `stop()`」——当时确实是抄 L1b ledger 的。同轮评审补撞了代码：`runLoop.ts` 里 `runLoop` 末尾那个 `try { return await runLoopFromState(...) } finally { await heartbeat.stop() }`、`resumeLoop.ts:181-185` 均为此形，**结论成立**。此处保留这段记录，因为「结论对但当时没验证」和「验证过」是两件事，后来者有权知道区别。

---

## 结论速查

| 债 | handoff 原描述 | 裁决去向 | 一句话理由 |
|---|---|---|---|
| 1 | reconciliation 合成责任无人认领 | **L3**（spec 内独立一节，先于触发逻辑） | 描述有误。生产者一直存在；真实缺陷是跨文件事务性。不修它，L3 的触发能力跑不通 |
| 2 | `persistTerminalState` 往已不拥有的 run 写 | **L5** | 修它就制造孤儿，而孤儿是 L5 的定义域 |
| 3 | `heartbeat.stop()` 释放窗口 | **L3** | L3 是加触发调用者、从而让它可达的那一层 |
| 4 | `writeRunState` / 首次 `writeOwnerRecord` 非原子 | **现在就修**（独立小分支） | 机械、低风险、有现成原子写辅助可复用 |

**附带结论：下一层是 L3，不是 L5。** 四笔债里两笔（1、3）是 L3 的前置；L5 的唯一输入（债 2）要等 L3 存在之后才有意义——没有触发层，孤儿产生速率接近零，先建 GC 是给不存在的问题建方案。

### 「前置」的准确含义（消歧）

- **债 1 与债 3 归 L3，指的是「在 L3 自己的 spec 内解决」，不是「在 L3 之前另开一层」。** 债 1 是 L3 spec 的独立一节、独立任务组、独立评审；债 3 是 L3 spec 必须显式表态的一项。二者都不构成 L3 之外的新层。
- **债 4「现在就修」指的是一个先于 L3 开始、且完成后再开 L3 的独立小分支。** 它不与 L3 并行——见下面的顺序约束。

### 执行顺序（不可打乱）

1. **债 4 分支**（原子写）→ 评审 → 合并。
2. **L3**（brainstorming → spec → plan → 实现），其中债 1 作为独立一节先于触发逻辑落地，债 3 在 spec 中显式表态。
3. **L5**（cleanup / orphan GC），届时处理债 2。

顺序不可打乱的原因：**债 4 与债 1 在 `reconciliation-record.json` 上重叠**。债 4 给它加 temp+rename（改「怎么写」），债 1 可能把它整个移进 owner-transfer 的事务（改「何时写」）。若并行推进，债 4 的改动会被债 1 直接覆盖掉；若 L3 先做，债 4 就得在一个正在变动的写路径上施工。**先做债 4、再做 L3 是唯一不返工的顺序**，代价是债 4 对该文件所做的工作有一部分会在 L3 中被取代——这是已知且接受的。

---

## 债 1 — 跨文件事务性（原「reconciliation 合成责任无人认领」）

### handoff 的描述是错的

「合成责任无人认领」不成立。核实：

- `persistOwnerTransfer` 在生产代码里**只有一个调用点**：`src/controller/runLoop.ts` 的 `persistBoundaryAnalysis`，被紧邻其上的 `boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST" && ownership.takeoverAllowed` 三重条件包住。
- `writeBoundaryArtifacts` 也**只有一个调用点**：`src/controller/runLoop.ts` 的 `await writeBoundaryArtifacts(runDir, {`，在同一函数、几十行之后。
- reconciliation 记录的构造条件是同一次调用里 `reconciliationRecord` 那一支的 `boundaryAnalysis.status === "stale_candidate"`——**是转移条件的超集**。

所以转移的赢家本人就是生产者，二者相隔几行。责任从未真空。

### 真实缺陷

`owner-transfer.json` 由 `finalizePendingOwnerTransfer`（`src/persistence/fileStore.ts:526-545`）发布；reconciliation 记录要到 `runLoop.ts` 的 `await writeBoundaryArtifacts(runDir, {` 才写。

**发布本身就不是一次原子动作**（初稿把这里写成「`:536-538` 原子 rename 发布」，措辞误导，已更正）：

```
await rename(transferTempPath, transferPath);    // owner-transfer.json 先落地
await writeJsonFile(ownerTempPath, ownerRecord);
await rename(ownerTempPath, ownerPath);          // owner-record.json 后落地
```

**单文件各自原子，这一对不原子。** 所以窗口的第一段是「transfer 已发布而 owner-record 尚未更新」——这一段有 pending 文件与事务标记支持崩溃恢复，但它确实存在。

其后到 reconciliation 落盘之间还隔着：

1. `:764` 的 `heartbeat.adopt()`
2. 退出 `heartbeat.runExclusive` 的 span（`:739-802`）
3. `:820` 的 `await heartbeat.assertHeld()`

**第 3 项比初稿描述的重得多**（初稿写「会抛，且含一次真实文件读」，严重低估，已更正）。`assertHeld`（`src/controller/leaseHeartbeat.ts:252` 起）实际是：

- 最多 `LEASE_VERIFY_READ_ATTEMPTS = 3` 次读，`LEASE_VERIFY_RETRY_DELAY_MS = 50`（`src/ownership/lease.ts:7-8`），最坏 **100ms 退避**
- **两条失败路径都会写**：supersede 路径经 `concludeSupersededOnce` 追加事件；不可读路径追加 `lease_unverifiable` 事件

**即这个 guard 本身是写者。** 这对债 1 的修法有直接影响，见下面的可行性一节。

第三个进程在这个窗口里 supersede 赢家，`:820` 就拒绝 `:821` 的写，**而 transfer 已经不可撤销地发布出去了**。

磁盘上留下：`owner-transfer.json` 存在且 `eligibleForContinuation: true`（**类型级保证**：`persistOwnerTransfer` 的返回类型 `Promise<{ ownerRecord: OwnerRecord; eligibleForContinuation: true }>` 把该字段钉成字面量 `true`，函数末尾的 `return { ownerRecord: ..., eligibleForContinuation: true }` 兑现），`reconciliation-record.json` 不存在。

### 症状链（已坐实，非推测）

L2 registry 如实报告 `eligibleForContinuation: true`
→ `src/controller/resumeLoop.ts:114` 调 `readReconciliationRecord`
→ `src/persistence/fileStore.ts:705-707` 直接 `readFile` + `JSON.parse`，文件缺失即 ENOENT 抛出
→ resume 失败。

这正是 handoff 记的「registry 显示 eligible 而磁盘上并无该文件」，机制现已查清。

**这是 liveness 洞，不是安全洞。** `evaluateResumeEligibility`（`resumeLoop.ts:39` 起；初稿写作 `:39-64`，那只是当时的阅读截断点，不是函数边界）把 reconciliation 当作必需输入，缺失即 fail-closed。代价是「合法转移过的 run 无法 resume」，不是「不该 resume 的被 resume 了」。deny-by-default 未被削弱。

### 为什么归 L3 而不是 L5

L3 的「触发」定义就是让 eligible run 继续执行，而继续必须走 `resumeLoop`——今天它会 ENOENT。**债 1 不是可延后的债，是 L3 的功能前提。** 它与 cleanup / orphan GC 不沾边，推给 L5 会把刚查清的分类重新弄糊。

### 修法方向可行性（本轮已验证，只读）

**否决的方向**：「先写 reconciliation，再发布 owner-transfer」做不到——reconciliation 的 `newOwnerEpoch` 要等 `persistOwnerTransfer` 返回才知道（`runLoop.ts` 的 `nextOwnerEpoch = transfer.ownerRecord.currentOwnerEpoch;`）。

**可行的方向**：把 reconciliation 加入转移**已有的**事务。`fileStore.ts:327-330` 已定义 `.owner-record.pending.json` / `.owner-transfer.pending.json` / `.owner-transfer.transaction.json` 事务标记，配合 `:536-538` 的双 rename 与 `recoverInterruptedOwnerTransfer` 的崩溃修复。reconciliation 可作为第三个文件加入同一事务，**不需要新发明一套原子性**。

**与 `preserveSuccessfulReconciliationIfNeeded` 无冲突**（本轮专门验证的一点）：它在 `fileStore.ts:282` 一进门就 `if (nextReconciliationRecord.eligibleForContinuation) return`。

**论据已更正。** 初稿给的理由是「loser 的转移根本没进入事务」——**那条从未验证过**，而且与 staging/CAS 的先后有关，本记录无权断言。真正的理由不依赖事务，而且强得多：`persistOwnerTransfer` 的返回类型 `Promise<{ ownerRecord: OwnerRecord; eligibleForContinuation: true }>` 就把 `eligibleForContinuation` 钉成**字面量 `true`**，函数末尾的 `return` 兑现。所以赢家**必然**命中 `fileStore.ts:282` 的早退，loser（`eligibleForContinuation` 保持 `runLoop.ts` 里 `let eligibleForContinuation = false;` 的初值）**必然**不命中。**这是类型级保证，与事务机制无关。** 两者不相交。

**留给 L3 spec 回答、本轮不预设答案的两个问题：**

1. `recoverInterruptedOwnerTransfer` 是否也要负责 finalize reconciliation。会扩大「读会写」的范围——而 L2 整层的设计正是围绕规避这一点建立的（禁用 `readOwnerRecord`）。
2. reconciliation 的内容依赖 exclusive span **之外**算出的 `boundaryEvidence` / `ownership`（`runLoop.ts` 的 `const boundaryEvidence = buildBoundaryEvidence(...)` 到 `evaluateOwnershipFor` 定义结束，以及 span 之后的 `heartbeat.assertHeld()` / `writeBoundaryArtifacts` 那一段）。塞进事务要改 `persistOwnerTransfer` 的签名——**那是 L1b 刚刚变异验证稳定下来的函数**。

**评审补充的判断（不改变归属，只调整预期）**：上面「真实缺陷」一节查实 `assertHeld` 本身就是写者（追加事件），这削弱了问题 1 里「不得扩大读会写」那条反对意见的分量——写路径早已不纯。但同时它也说明这条修法要动的东西比初稿设想的多。**「加入事务」这条路比裁决时判断的更窄，L3 不应假定它一定成立。**

### 若修法方向不可行时的退路（S-3）

若 L3 的 brainstorming 判定「reconciliation 加入 owner-transfer 事务」不可行，**L3 不得就地发明替代方案**，而应回到本记录重新裁决债 1 的归属与形式。理由：本记录把债 1 判给 L3 的依据是「它是 L3 的功能前提」，不是「这条修法可行」——前者不因后者失败而改变，但**处理形式**（L3 内一节 / 独立分支 / 单开一层）必须重新定。

**明确禁止的退路**：放松 `resumeLoop` 对 reconciliation 的必需性（例如「若存在则校验，不存在则跳过」）。那是**引入新授权**，违反 L1/L1b/L2 三层共同的「只增加拒绝，绝不新增许可」边界。缺失即拒绝的 fail-closed 行为必须保留。

### 执行约束（人下的指令）

债 1 在 L3 spec 里**必须是独立的一节、独立的任务组、独立的评审**，不得与触发逻辑混在同一批任务里。理由：它改的是 L1b 刚稳定的转移写序，风险等级与触发逻辑不同。

---

## 债 2 — `persistTerminalState` 往已不拥有的 run 写

### 核实

`src/controller/runLoop.ts` 的 `async function persistTerminalState(`：

```
appendTransitionEvent(runDir, terminalState, ...)   // 写
writeRunState(runDir, terminalState)                // 写
```

两个裸写，**无任何 guard**。进入路径是 `if (isLeaseStopError(error))` 的两处分支——**恰好是本进程已经知道自己丢了租约的那条路**。同一性质、初稿漏记的还有 `if (leaseLoss.lost !== null)` 的两处；四者合计四个调用点，而 `persistTerminalState` 全文共十五个调用点（`grep -n 'persistTerminalState' src/controller/runLoop.ts` 现数，不要照抄）。

L1b 最终评审的原话仍然成立：层的论点在下一帧被执行、在上一帧被违反。而 L1b 的守卫使这条路径变得**更频繁**。

### 为什么归 L5

修债 2 意味着丢租约的进程不再写终态，于是 run 永远停在 `executing` / `verifying`——**制造孤儿**。孤儿正是 L5（cleanup / orphan GC）的定义域。

反过来说：**在 L5 存在之前修债 2 是净损失**。今天它至少留下一个终态和一条事件；修掉之后留下的是一个没人清理的活状态。所以这笔债的正确顺序是「先有 GC，再收紧写」，不是反过来。

### 替代裁决与暴露窗口（初稿此节自相矛盾，已重写）

初稿写「『明确接受』被否决」，同时又写「在 L5 存在之前修债 2 是净损失」。**这两句不能同时成立**——若现在不修、L5 才修，那么在此期间我们**事实上就是在接受它**。把这称为「否决接受」是自欺。准确的表述：

- **「现在就修」被否决**，理由如上（会制造无人清理的孤儿）。
- **「永久接受」被否决**——它是层的核心论点的实际违反，不能声明为长期可接受。
- **实际裁决是「暂时接受，至 L5 消除」**，并如实记录代价。

**暴露窗口：两层。** 执行顺序是「债 4 分支 → L3 → L5」，所以债 2 从今天起要一直带到 L5 落地，跨越债 4 分支与整个 L3。而 L1b 的守卫**使这条路径更频繁**（L1b 最终评审的架构注记）。**这是本记录里代价最大的一条裁决，且代价随 L3 的工期线性增长。**

若 L3 的工期显著超出预期，**应重新审视是否把债 2 提前到 L3 之后、L5 之前单独处理**——那要求先回答「不写终态的 run 由谁负责收尾」，也就是提前借用 L5 的一部分职责。本记录不预判该权衡，只标明触发条件。

---

## 债 3 — `heartbeat.stop()` 释放窗口

### 核实（比 ledger 记的更硬）

`src/controller/leaseHeartbeat.ts:216-235`：

- `:221` 置 `stopped = true`
- `:223` `await queue.catch(() => {})` —— **对当前 `queue` 取快照**
- `:231` `await releaseOwnerLease(...)`

关键在 `runExclusive`（`:196-203`）的注释白纸黑字写着：

> Takes no position on `stopped` or `superseded` — it only serializes.

**所以 `stopped` 标志根本挡不住新的 `runExclusive`。** 它重新赋值模块级 `queue`，而 `stop` 早已 await 完旧的那个，于是 `stop` 在一个 exclusive span 仍在飞行时返回，并继续去释放租约。

### 为什么归 L3

L1b 最终评审判定它**今天不可达**：`runLoop` 与 `resumeLoop` 都在 `finally` 里 await 完 `runLoopFromState` 之后才调 `stop()`，两个 `persistBoundaryAnalysis` 调用点也都被 await。

L2 刻意没有使其可达（只读、零新增调用者）——这是选 registry 而非 queue 的直接收益。

**L3 是加触发调用者的那一层，也就是让它可达的那一层。**

### 执行约束

L3 spec **必须显式对债 3 表态**，不得沉默继承。可接受的表态包括「收紧 `stop` 语义」「收紧 `runExclusive` 语义」「论证 L3 的调用形态不使其可达并加守护测试」——但不接受不提。

---

## 债 4 — 非原子写

### 核实（范围比 handoff 记的大一个文件）

非原子（裸 `writeFile`）：

- `src/persistence/fileStore.ts:81` —— `writeRunState`，即 `loop-state.json`，**每次状态转移都重写**
- `src/persistence/fileStore.ts:368` —— `writeOwnerRecord`（`:379`）走的辅助，即**首次创建**的 `owner-record.json`
- `src/persistence/fileStore.ts:316` —— **`reconciliation-record.json`**（本轮新查出，handoff 未记）

原子（temp + rename）：

- `:325-326`、`:536-538` —— owner-transfer 发布的双 rename
- `:632-636` —— `writeOwnerRecordAtomically`，owner-record 的**轮转**路径

**同一个 `owner-record.json`，首次创建非原子、后续轮转原子。** 这个不一致本身就是缺陷源。核实：`writeOwnerRecord`（`:379-381`）走 `writeJsonFile`（`:367-369`，裸 `writeFile`），生产代码**唯一调用者**是 `runLoop.ts` 里 `await writeOwnerRecord(runDir, ownerRecord);`——正是首次创建（`checkRunLease` 之后、心跳启动之前）。

### 评审新查出的陷阱：一个导出的非原子 transfer 写函数（M-1）

`writeOwnerTransferRecord`（`fileStore.ts:383-385`）也走同一个 `writeJsonFile`，即**一个导出的、非原子的 `owner-transfer.json` 写入口**。

**生产代码零调用者**（`src/` 全域 grep 只命中定义本身；其余全部在 `tests/`）。所以**今天不构成缺陷**，L2 的「`owner-transfer.json` 原子」一致性前提在生产路径上仍然成立。

但它是个真陷阱：**L3 若顺手用它发布 transfer，会静默击穿整个原子发布前提**——而 L2 的读侧正是依赖该前提才敢做单次读（`readObservedFile.ts:101` 的 `spec.atomic ? 1 : LEASE_VERIFY_READ_ATTEMPTS`）。绕过 `finalizePendingOwnerTransfer` 的发布不会有任何编译期或测试期信号。

**债 4 分支应顺带处理**：收窄导出（若测试可改用其他入口），或在函数上加明确警示注释说明它不得用于生产发布路径。**二选一即可，不强制哪一种**，但不得原样留着不加标记。

L2 用 100ms 有界重读绕过而非修复，因为只读层不该改别人的写路径——那个判断是对的，但它把代价传给了每一个需要连贯读的后续消费者。

### 为什么现在就修

机械、低风险、边界清楚，而且 `writeOwnerRecordAtomically`（`:632-636`）已经是现成可复用的辅助。它不依赖任何未来层的设计决策，也不属于任何一层的定义域——把它挂在 L3 或 L5 下面只会推迟一个本可以立即消除的代价。

### 执行约束

- 独立小分支，独立评审，**先于 L3 完成并合并**（见上面的执行顺序）。
- **不得顺手改 `reconciliation-record.json` 的写入时机**——那是债 1 的范围，属于 L3。本次只改「怎么写」，不改「什么时候写」「写不写」。已知该文件上的部分工作会在 L3 中被取代，这是接受的代价。
- 顺带处理 M-1 的 `writeOwnerTransferRecord`（收窄导出或加警示注释，二选一）。
- **不设性能门禁**（初稿此处写「若基准显示不可接受，如实上报」，但没给基准、没给阈值、没给测量方法，是一条无法执行的空要求，已删除）。事实基础：`:81` 的 `writeRunState` 是热路径（每次状态转移都重写），temp+rename 把每次写从 1 个 syscall 变成 2 个。**判断：不值得为此设门禁。** 该循环每次迭代都包含 Claude 调用与文件系统 I/O，多一次 rename 在量级上不可见。**若实施者在实测中观察到可测量的退化，如实上报并停下等裁决——但不要为了找它而专门跑基准。**

---

## 本轮明确没有做的事

- 没有写任何 spec。
- 没有改任何代码。
- 没有预设债 1 的具体修法（只验证了方向可行与不冲突）。
- 没有裁决 L2 挂账的 5 条 Minor（`handoff.md` 遗留事项 3）——它们不在本轮范围。
- 没有裁决 5 个已知 flake（遗留事项 2）——修法已记在 handoff，仍待独立验证轮。

## 对 handoff 的更正

1. **遗留事项 10 撤销**：`origin/main` 自动前进不是环境异常，是人自己 push 的。已向人确认。
2. **L5 继承清单第 1 条描述有误**：「reconciliation 合成责任无人认领」不成立，见债 1。该条应改写为跨文件事务性缺陷，并从 L5 清单移到 L3。
3. **L5 继承清单第 4 条范围偏小**：漏了 `reconciliation-record.json`（`fileStore.ts:316`）。
4. **L5 继承清单现在只剩 1 笔**（债 2），不是 4 笔。
5. **新增一条陷阱**：`writeOwnerTransferRecord`（`fileStore.ts:383-385`）是导出的非原子 `owner-transfer.json` 写入口，生产零调用者但足以静默击穿 L2 的原子性前提。见债 4 的 M-1 节。

## 本记录的评审历史

初稿于同日提交（`44469d0`）后经过一轮评审，**评审对着代码重新撞了初稿中每一条可证伪的断言**，改出 4 条 Important、2 条 Minor、3 条结构性问题，全部已在正文就地更正并保留更正痕迹。

**评审的结构性局限，如实记录**：这轮评审由撰写者本人执行，未派独立评审员。项目铁律是「评审必须对着代码撞、不接受实施者自证」，而自评审在结构上无法满足后半句。缓解措施是把重点放在**「当时推断而非直接读过」的断言**上——4 条 Important 里有 3 条（I-1 口径过度声称、I-2 论据未验证、I-4 描述低估）正是从这类断言中撞出来的。**但这不等于独立评审。若后续层依赖本记录的某条结论，值得再撞一次。**

四条 Important 的性质值得记下：**没有一条推翻了裁决结论，全部是论据或描述层面的缺陷**——两条把未验证的推断当成了已验证的事实（I-1、I-2），一条措辞误导（I-3），一条严重低估了机制的复杂度（I-4）。这与前三轮的教训同形：结论对不等于论据对，而后来者继承的是论据。
