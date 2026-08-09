# 任务 2 报告 — 债 2：所有权守卫（修法）

## 1. 结论

**债 2 已修掉。** 守卫加在 **`persistTerminalState` 函数体内部**（`src/controller/runLoop.ts`），
不是加在调用点上：一处覆盖全部 15 个调用点，且第 16 个调用点无法绕过它。

守卫问的问题是 **「`owner-record.json` 里写的属主是不是我」**（`foreignOwnerOf`，新增的模块私有函数），
**不是 `checkRunLease` 问的「是不是有人正持着活租约」** —— 两者必须区分：过期的租约不会把一个非属主
提升为属主，所以记录指向别人时，无论对方租约新鲜、过期还是没有，都拒绝。

**守卫扣下的东西只有一样：`writeRunState`。** 这个收窄不是偷懒，是被一条实测出来的真回归逼出来的
（见 §6）。债 2 的本体是 `loop-state.json` 变成 `cancelled` —— 死端状态（`stateMachine` 的
`cancelled: []`，且不在 `RESUMABLE_STATUSES` 里），这才是把真属主困死的东西。返回值和
`loop_<terminal>` 事件都不是：两者都不参与续跑判定，却都是「本进程为什么停」的唯一记录
（`assertHeld` 按设计不产生任何事件）。所以最终形状是**一分为二**：本进程照旧上报自己的停止
（返回 `cancelled`/`lease_lost` ＋ 追加 `loop_cancelled`），而**别人那个 run 的 `loop-state.json`
逐字节未动、仍然可续跑**。

拒绝**不静默**：追加一条 `terminal_write_abandoned` 事件，detail 里同时写出「谁是属主」和
「我是谁」。依据是本仓库自己的立场（`fileStore.ts` 的 `writeBoundaryArtifacts`：一次保护性放弃
若连一个出口都没有，「would be a genuine silent failure」）。

**代价：2 条既有测试仍红**，两条都**只**因为穷举式事件列表里多了 `terminal_write_abandoned` 一行。
两条都**未自改**，原样上报（§6）。

## 2. 四个 lease-loss 检查点逐个核实

我自己核过，没有照抄 brief。锚点用符号名。全仓 `persistTerminalState` 调用点 15 个
（`rtk proxy grep -n "persistTerminalState" -r src/ tests/`，src 内 15 处调用 ＋ 1 处定义）。
由 lease-loss 到达的是这四处：

| # | 位置（符号锚点） | 到达条件 | 额外门槛 |
|---|---|---|---|
| 1 | `runLoopFromState` 循环顶部，第一个 `leaseLoss.lost !== null` | 心跳把 `RunLeaseLostError` 放进信号槽 | 无 |
| 2 | `while (!worktreePath)` 的 catch 里 `isLeaseStopError(error)` | `heartbeat.assertHeld()` 在建 worktree 前抛出 | 无 |
| 3 | 校验被拒后重试边界处，第二个 `leaseLoss.lost !== null` | 同 1，但发现得晚 | 无 |
| 4 | 尝试体外层 catch 里 `isLeaseStopError(error)` | `assertHeld()` 在尝试中抛出 | **`isTerminalRunStatus(state.status)` 三元** |

**四处不等价，确认成立** —— 第 4 处（brief 说的 `:1514`）写成
`return isTerminalRunStatus(state.status) ? state : await persistTerminalState(...)`。

### `:1514` 那层额外门槛在我的方案下会怎样（brief 要求专门回答）

**答：完全不受影响，而且这正是「守卫必须放在函数内部、不能放在调用点」的一条独立理由。**

1. 那层门槛问的**不是所有权问题**。它问的是「本次尝试是否已经落过终态决定」——
   源码注释自己说明了理由：`succeeded -> cancelled` 不是合法转换，`transitionRunState` 会抛。
   它是**状态机合法性**门槛，与「这个 run 归谁」正交。
2. 守卫放在 `persistTerminalState` **内部**，所以**次序不变**：`state.status` 已终态时
   `persistTerminalState` **根本不被调用**，我的守卫在那条路径上**一次都不跑**，
   不读 `owner-record.json`、不追加任何事件、不做任何 I/O。该分支继续原样返回 `state`。
3. `state.status` 非终态时，调用发生，守卫与另外三处**行为完全一致**。
4. **两者是合取，不是竞争**：第 4 处是四处里唯一一个「已经存在第二条不写理由」的点。
5. *** **反过来说，如果按方案 (B) 把守卫加在调用点上，第 4 处就会出问题** ***：
   守卫必然被写在三元**之外**（否则要重复两次），于是「已终态」这一情形会从
   「什么都不做」变成「读盘 ＋ 追加一条放弃事件」。那条注释要求的恰恰是**绝对什么都不做**
   （运行已有终态记录，无事可放弃）。**放在函数内部是唯一能同时满足四处的位置。**

### 为什么是 (A) 函数内部而不是 (B) 调用点 —— 对 15 个调用点分别意味着什么

- **(A) 内部**：4 个 lease-loss 点得到守卫；**另外 11 个也得到**。这不是搭便车：11 个里有
  `blocked_waiting_human`、`exhausted`、`decision.kind` 等分支，它们同样能在一次长尝试之后落盘，
  而 `assertHeld()` 只在若干选定的副作用点前调用，并不覆盖每一次终态写；`runLoopFromState` 的
  默认心跳还是 `INERT_LEASE_HEARTBEAT`（全 no-op）。所以「非 lease-loss 路径就一定还持有所有权」
  不成立。**代价**：这 11 个点每次落终态多一次 `owner-record.json` 读（终态每个 run 至多一次，可忽略）。
- **(B) 调用点**：要么只改 4 处（留下 11 个洞，且第 16 个调用点默认无保护），要么改 15 处
  （同一段读盘逻辑抄 15 遍）；且如上所述会破坏第 4 处的语义。

**裁决：(A)。** 这条不变式是 `persistTerminalState` 这个**唯一写者**的属性，应当由它自己保证。

## 3. 守卫触发时的行为选择与理由

四个子决定，逐个给理由。

**(1) 扣下什么 —— 只扣 `writeRunState`，保留内存态转换与 `loop_cancelled` 事件。**
先做的是「全扣」（连转换和事件一起扣，返回原 `state`），实跑打红 8 条既有测试，逐条读下来发现
那是**真回归**（详见 §6）：`assertHeld` 按设计不产生任何事件，`leaseLifecycle` 的注释明写
「the terminal transition is what records the stop, carrying the same reason」，另一处明写
若不记录就会得到「a run that stopped for a lease reason names nobody」。全扣之后
`finalState.stopReason === null` —— 一次因租约丢失而停止的运行，对调用方和日志都无法说明自己为什么停。
按 brief 铁律 (a)：**改修法，不改测试**。收窄后 8 条全绿。
债 2 的本体（`loop-state.json` 变 `cancelled`）仍被完整扣下 —— 这也正是控制器 §9 自己复现时
所用的变异模型（「抑制 `writeRunState`」）。

**(2) 返回什么 —— 返回 `terminalState`（内存终态），不是原 `state`。**
理由同 (1)：返回值是本进程向调用方交代自己停止原因的唯一通道，且不参与任何续跑判定
（`evaluateResumeEligibility` 只看 `runState`/`ownerRecord`/`ownerTransfer`/`reconciliation` 四份盘上数据，
不读事件流；registry 观察三个文件）。**结果是返回值与盘上状态故意分叉，这个分叉就是修复本身**，
所以翻转后的测试把它显式断言出来（`expect(persisted).not.toEqual(finalState)`）。

**(3) 静默还是记事件 —— 记事件，且不吞异常。**
本仓库立场按 brief 指示读了原文（`fileStore.ts` 的 `writeBoundaryArtifacts` 放弃分支）：
① 保护性放弃不得抛；② **只吞审计那一半，绝不吞掉整个信号**，「Absent that callback, events.jsonl
would be the sole outlet and swallowing it here would be a genuine silent failure」。
我这个调用点**没有** operator 回调，events.jsonl 就是唯一出口，所以按第 ② 条**不能吞**——
吞了就正是它警告的那种真静默失败。事件类型取 `terminal_write_abandoned`（与
`reconciliation_write_abandoned` 同形），detail 同时给出「谁是属主」和「我是谁」，
对齐 `lease_lost` 事件「both sides of the comparison」的既有要求。
不吞是否会把停止升级成失败？**不会**：四个 lease-loss 调用点要么在尝试的 `try` 之外，要么已经在它的
`catch` 之内，从 `catch` 里抛出不会再被同一个 `catch` 接住，因此异常直接逸出 `runLoopFromState`，
响亮、且一次盘也没写。

**(4) 读不出记录时怎么办 —— 不拒绝（这条与 `leaseGate` 故意分道）。**
第一版照抄 leaseGate（ENOENT 放行、其余 rethrow），实跑把 2 条既有测试打红，其中一条
（`stops with lease_unverifiable ... when the record is corrupt`）直接从「停止」变成「崩溃」。
那是我的修法的真回归。裁定：**读不出的记录并没有指认任何人，更没有指认「另一个」属主，不构成拒绝依据**；
而且不可读这一情形**已有归属**——`leaseHeartbeat` 用 `lease_unverifiable` 回答它，守卫不得抢答。
gate 在**开跑前**读，拒绝的代价是一次启动；这里在**运行正在停止时**读，同样的拒绝会把停止变成崩溃。
最终语义：**守卫只在确切指认出「另一个属主」时才增加一次拒绝**，其余一律放行。

## 4. 翻转后的测试

文件不变（`tests/controller/runLoop.integration.test.ts`），**场景一字未动** ——
同一个 runDir、同一份 `owner-record.json`（`pid:999999:1234567890`，epoch 2，
`ownerStatus: "current"`、`supersededByEpoch: null`）、同一个 `leaseLoss` 注入、同一个会抛的 adapter。
**只翻转期望**，所以两版可直接对照。

**旧名**：`writes an unresumable cancelled status into a run a different, current owner already
holds when this process's own lease is lost`
**新名**：`refuses to write a terminal status into a run a different, current owner already holds
when this process's own lease is lost, leaving that run resumable`

**新断言（按顺序）**
1. `expect(await readEventTypes(runDir)).toEqual(["loop_cancelled", "terminal_write_abandoned"])`
   —— 穷举式，一条断言同时钉住两半：停止仍被上报（`loop_cancelled` 只有 `persistTerminalState` 写），
   守卫确实触发（`terminal_write_abandoned` 只有守卫写）；顺带排除任何 adapter 调用越过检查点。
2. `finalState.status === "cancelled"` ／ `finalState.stopReason === "lease_lost"` —— 上报那一半。
3. `persisted.status === "planning"`（`persisted` 来自 `readRunState(runDir)`，**磁盘**）—— 落盘那一半。
4. `expect(persisted).not.toEqual(finalState)` —— **分叉本身**。未加守卫的代码让这两者相等，
   那个相等就是数据丢失。
5. `expect(await readFile(join(runDir, "loop-state.json"), "utf8")).toBe(persistedStateBeforeLoss)`
   —— 比「状态不是 cancelled」更强：**逐字节**与本进程到达检查点之前完全一致。
   循环顶部的 `writeRunState` 在 lease-loss 检查之前就跑过，因此它也被这条一起钉住了。
   基线取自 `initializeRunFiles` 之后，两次都经同一个 `writeJsonFileAtomically`，所以是字节比较而非序列化器比较。
6. `evaluateResumeEligibility({ ownerRecord, ownerTransfer, reconciliation, runState: persisted })`
   `=== { ok: true }` —— **用生产的那个门函数**证明真属主仍可续跑，不是把状态读回来自己说好。
7. 对照组：同一份输入，只把 `runState.status` 换成未加守卫时会被写下的 `"cancelled"`，
   得到 `{ ok: false, reason: "run status cancelled is not resumable" }`。

**为什么这个形状能失败（两个方向都能）**
- 拿掉守卫（让终态照写）⇒ 第 1 条与第 3/4/5/6 条一起红。
- **只**恢复那次落盘、保留放弃事件 ⇒ 第 1 条仍绿，红点精确落在第 3 条
  `expect(persisted.status).toBe("planning")`，即**数据丢失本体**。§5 的 B2 就是这个实验。
- 反方向也钉住了：若把守卫**放宽**成连上报一起扣（我做过的第一版），第 2 条红。
  这条很重要 —— 只断言「盘上不是 cancelled」的测试会给那个错误修法放行。

## 5. 三步判据的完整证据

全部经「脚本先落盘 → `rtk proxy zsh <script>` 跑」，每跑内含必命中 sanity 探针，输出未过滤。
选择器 `-t "<具名测试全名>"`，每块都显示**非零**计数。

### A 注入前绿（守卫在位）
脚本 `step-abc.sh`。sanity 探针：`grep -c 'terminal_write_abandoned' src/controller/runLoop.ts` → `1`；
`grep -c 'EXPERIMENT variant 2' src/controller/runLoop.ts` → `0`（确认实验痕迹已清）。
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss
 ✓ tests/controller/runLoop.integration.test.ts (56 tests | 55 skipped) 117ms
 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
VITEST_EXIT_A=0
```

### B 注入后红（撤掉守卫）
脚本 `step-bc.sh`。变异 = `if (foreignOwner !== null) {` → `if (/* MUTATION */ false && foreignOwner !== null) {`
（守卫分支永不进入 ⇒ 等价于没有守卫）。
sanity 探针：`grep -c 'MUTATION'` → `1`，并打印被改的那一行
`1008:  if (/* MUTATION */ false && foreignOwner !== null) {`。
```
 ✓/× tests/controller/runLoop.integration.test.ts (56 tests | 1 failed | 55 skipped) 117ms
   × runLoop > refuses to write a terminal status into a run a different, current owner already holds when this process's own lease is lost, leaving that run resumable 116ms
     → expected [ 'loop_cancelled' ] to deeply equal [ 'loop_cancelled', …(1) ]
 Test Files  1 failed (1)
      Tests  1 failed | 55 skipped (56)
VITEST_EXIT_B=1
```
红点：`runLoop.integration.test.ts:1310`，`Array [ "loop_cancelled", - "terminal_write_abandoned" ]`。

### B2 隔离变异（额外做的，因为 B 的红点先撞在事件列表上）
B 死在第 1 条断言上，还没走到落盘断言 —— 这不足以证明该测试钉住的是**数据丢失本体**。
于是补一个隔离变异：**保留**放弃事件，只删掉 `return terminalState;`，让 `writeRunState` 照跑。
脚本 `step-b2.sh`，sanity 探针 `grep -c 'MUTATION'` → `1` 并打印上下文。
```
   × runLoop > refuses to write a terminal status ... leaving that run resumable 121ms
     → expected 'cancelled' to be 'planning' // Object.is equality
 ❯ tests/controller/runLoop.integration.test.ts:1318:30
    1318|     expect(persisted.status).toBe("planning");
      Tests  1 failed | 55 skipped (56)
VITEST_EXIT_B2=1
```
*** 红点精确落在 `persisted.status`，而 `persisted` 来自 `readRunState(runDir)`（**从磁盘读回**）
⇒ 该测试断言的是落盘状态、即数据丢失本体，不是内存中间变量。 ***

### C 还原后复绿
```
git checkout -- src/controller/runLoop.ts     # 单文件明确路径
grep -c 'MUTATION' src/controller/runLoop.ts  # → 0
git diff --stat -- src                        # → 零输出
 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
VITEST_EXIT_C=0
```
B2 之后同样做了还原并复核：`grep -c 'MUTATION'` → `0`，`git diff --stat -- src` 零输出。
最终跑（§7）开头的探针再次确认 `git diff --stat -- src` 为空、HEAD 为 `87f3582`。

## 6. 变红的既有测试逐条裁定

**加守卫总共弄红过 10 条既有测试。8 条经「改修法」消掉，2 条仍红、未自改、原样上报。**
全过程**没有改动任何一条既有测试的判据**（唯一改动的测试是任务 1 那条本轮自建的，属明确授权范围）。

### 第一版守卫（全扣 ＋ 照抄 leaseGate 的 rethrow）：10 条红

未过滤全套件：`Tests  10 failed | 505 passed (515)`。分三簇。

---

#### 簇 1 —— 裁定 **(a) 真回归**，已改修法（2 条）

| 测试 | 红点 |
|---|---|
| `leaseLifecycle.integration.test.ts > lease heartbeat lifecycle > check 2: stops at the retry boundary itself, without ever reaching a second top-of-loop pass` | `expected 'Error: owner record is structurally invalid: currentProcessInstanceId is missing or not a non-empty string' to be 'lease_lost'` |
| `leaseLifecycle.integration.test.ts > lease heartbeat lifecycle > stops with lease_unverifiable and writes no owner record when the record is corrupt` | `SyntaxError: Expected property name or '}' in JSON at position 2`，栈：`readOwnerRecordRaw ← foreignOwnerOf ← persistTerminalState ← runLoopFromState ← runLoop` |

第一条故意把 `owner-record.json` 写成哨兵 `{"sentinel":true}` 并断言「the stop never touches it」；
第二条故意写成 `{ not json` 并断言 `stopReason === "lease_unverifiable"`。
**两条都是命名要求，与所有权无关；我的守卫把一次「停止」变成了一次「崩溃」。这是我的修法坏掉了正确行为。**
**改修法**（不是改测试）：`foreignOwnerOf` 对「读不出/解析不出」一律返回 `null`（不拒绝），理由见 §3(4)。
提交 `a5498d0`。改后这 2 条恢复绿。

---

#### 簇 2 —— 裁定 **(a) 真回归**，已改修法（6 条 ＋ 簇 3 的 2 条在此一并变绿，共 8 条）

修掉簇 1 后仍红 8 条，全部同一形状：`expected null to be 'lease_lost'` 或
`expected 'executing' to be 'cancelled'`，断言的都是 **`finalState`（返回值）**，不是磁盘。

1. `leaseLifecycle > stops at the next phase boundary with stopReason lease_lost and leaves the new record intact`
2. `leaseLifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns`
3. `leaseLifecycle > does not launch the next Claude call when the record names a different process`
4. `leaseLifecycle > leaves the attempt worktree in place rather than unwinding it`
5. `leaseLifecycle > refuses persistBoundaryAnalysis before readOwnerRecord can finalize a staged transfer, once superseded (spec requirement 6)`
6. `leaseLifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4)`
7. `runLoop.integration > preserves the winner reconciliation view when another controller already completed the transfer`
8. `runLoop.integration > writes no synthesized winner reconciliation view when another controller already completed the transfer before success reconciliation was written`

*** **这一簇是本任务最容易裁错的地方，我原本准备按 (b) 上报，读完源码注释后改判 (a)。** ***
理由（都是代码里写着的，不是我的推断）：
- `leaseLifecycle` 第 1 条上方的注释明写：「assertHeld appends no event of its own by design
  (task 10), so **the terminal transition is what records the stop, carrying the same reason**」。
- 第 3 条上方的注释明写，若不记录就会得到「**a run that stopped for a lease reason names nobody**」。

也就是说：**「终态转换是停止原因的唯一载体」是本仓库刻意设计出来的性质**，不是缺陷的副产品。
全扣之后 `finalState.stopReason === null`，一次因租约丢失而停止的运行无法说明自己为什么停 ——
**这是我的修法破坏了正确行为，(a)**。按铁律**改修法**：守卫收窄为只扣 `writeRunState`（§3(1)）。
提交 `87f3582`。改后**这 8 条全部恢复绿**（`leaseLifecycle` 整文件 27 tests 全绿）。

同时确认：收窄**没有**放过债 2 —— 翻转后的测试第 3/5/6 条断言仍然成立，
且 §5 的 B2 隔离变异证明它能在落盘断言上被杀死。收窄后的形状也正是控制器 §9 复现时所用的变异模型
（「抑制 `writeRunState`」）。

---

#### 簇 3 —— **仍然红，未自改，原样上报（2 条）**

*** 这两条我**没有**动，也**不建议我自己动**。请控制器裁。 ***

1. `tests/controller/runLoop.integration.test.ts > runLoop > preserves the winner reconciliation
   view when another controller already completed the transfer`（红在 `:2529`）
2. `tests/controller/runLoop.integration.test.ts > runLoop > writes no synthesized winner
   reconciliation view when another controller already completed the transfer before success
   reconciliation was written`（红在 `:2667`）

**两条的红点完全相同，且只有一条断言红**：
```
AssertionError: expected [ 'loop_planning', …(5) ] to deeply equal [ 'loop_planning', …(4) ]
  Array [
    "loop_planning", "attempt_started", "execute_started", "lease_lost", "loop_cancelled",
+   "terminal_write_abandoned",
  ]
```
**这两条测试的其余断言现在全部通过** —— 包括 `finalState.status === "cancelled"`、
`finalState.stopReason === "lease_lost"`，以及它们各自的命名要求
（owner/transfer/reconciliation 三份记录的字段、`worktrees` 残留、
`reconciliation-record.json`/`boundary-analysis.json` 的存在与否）。
**没有任何正确行为被破坏，运行数据完好，停止上报完好。**

**裁定：不是 (a)。属于 (b) 那一类 —— 判据的前提在今天的代码上不再成立。**
`toEqual` 是一句**穷举**主张：「本进程往这个由 `pid:other-controller` 持有的 run 里，写下的就是这五条事件」。
这句穷举是在**没有所有权守卫的世界里**成立的。加了守卫之后，本进程多记录了一件真实发生的事
——「我拒绝了那次落盘」。**清单本身的意图没有错，只是它的穷举前提被守卫作废了。**

**我不改它**，因为改它就是人裁 4 禁止的那件事（测试红了就顺手改绿）。
可选处置留给控制器，我不预设：
(i) 在两条清单末尾各加一行 `"terminal_write_abandoned"`（改判据，需授权）；
(ii) 认定守卫不该记这条事件（我反对：见 §3(3)，与本仓库自己的反静默立场冲突）；
(iii) 认定这两条断言不该用穷举 `toEqual`（改判据，需授权）。

**未验到**：我没有验证 (i) 之后这两条是否就全绿 —— 那需要动既有判据，超出我的授权。

## 7. 全套件 ＋ typecheck ＋ build

脚本 `final.sh`，未过滤。开头 sanity 探针：`git log --oneline -1` → `87f3582 …`；
`git diff --stat -- src` → 零输出（工作区 src 与 HEAD 一致，变异确已还原）。

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

 Test Files  1 failed | 29 passed (30)
      Tests  2 failed | 513 passed (515)
   Duration  17.19s
VITEST_EXIT=1

=== TSC --noEmit ===
TSC_EXIT=0

=== npm run build ===
> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "..."
BUILD_EXIT=0

=== git status --short ===
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task1.diff
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/task-2-report.md
```

**vitest 首行 `RUN` 路径已核**：`/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss`
—— 是本任务的 worktree，不是仓库根。（该路径在 `step-a.sh` 的输出里完整显示；
`final.sh` 用同一个绝对路径 `cd`。见 §9 的诚实说明。）

**总数核对**：515 = brief 基线 514 ＋ 任务 1 新增 1。数目对得上，我没有新增或删除任何测试。

**2 条红的比对结论**：
- 与 brief 允许的 flake (B)（`evidence.test.ts > run-scenario CLI > records env names only and
  tracks descendants rooted at the spawned pid`）**按名比对：不是它**。该条本轮**绿**（2910ms 通过）。
- 与人裁 10 已挂账的名单外那条（`runLoop.integration.test.ts > runLoop > persists phase usage
  evidence from the subprocess adapter without recomputing controller totals`）**按名比对：不是它**。
  该条本轮**绿**（929ms 通过）。
- 2 条红即 §6 簇 3，**由我的改动直接导致**，已在 §6 逐条裁定并上报，不作为 flake 处理。

**`git status` 说明**：`src/` 与 `tests/` 全部已提交，工作区干净。
两个 `??` 中，`task-2-report.md` 是本报告（按 brief 用 `git add -f` 入库）；
`review-task1.diff` **不是我创建的**，开工前就在（属上一轮遗留的未跟踪文件），我未触碰。

## 8. 命令与输出全记录

所有验证跑都走「脚本先落盘 → `rtk proxy zsh <script>`」，脚本留在
`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/85257637-.../scratchpad/`。
每个脚本首行都 `export ECC_GATEGUARD=off DISABLE_OMC=1`，并 `cd` 到 worktree 绝对路径。

**检索类（非验证跑，允许 grep）**
| 命令 | 输出要点 |
|---|---|
| `rtk proxy grep -n "persistTerminalState" -r src/ tests/` | src 内 1 处定义 ＋ 15 处调用；tests 内 9 处注释引用 |
| `rtk proxy grep -n "leaseLoss\|isTerminalRunStatus\|readOwnerRecord" -r src/` | 定位两处 `leaseLoss.lost !== null`、`isTerminalRunStatus` 三元、`readOwnerRecord` 与 `readOwnerRecordWithoutRecovery` 的分工 |
| `rtk proxy grep -rn "buildProcessInstanceId" src/ tests/` | 确认进程身份来源；`processIdentity.test.ts` 断言同进程内重复调用返回同值 ⇒ 可在 `persistTerminalState` 内直接取自身 id |
| `rtk proxy grep -n "silent failure\|onReconciliationWriteAbandoned" -r src/` | 定位 `fileStore.ts:465` 那条「a genuine silent failure」先例（brief 说在 `runLoop.ts` 注释里，**实际在 `fileStore.ts`**，见 §10） |
| `rtk proxy sed -n '1,120p' src/ownership/lease.ts` | `parseOwnerRecordForLease` 的契约与 `RunLeaseLostError`/`RunHeartbeatStoppedError` 的刻意不共基类 |

**验证跑（未过滤）**
| # | 脚本 | sanity 探针（必命中） | 结果 |
|---|---|---|---|
| 1 | `step-a.sh` | 新测试名 grep → `1`；`foreignOwnerOf` grep → `2` | `Tests 1 passed \| 55 skipped (56)`，`RUN` 路径 = worktree |
| 2 | `step-commit-suite.sh` | `git rev-parse --abbrev-ref HEAD` → `feat/pkg2-data-loss` | 第一版守卫全套件：`Tests 10 failed \| 505 passed (515)` |
| 3 | `variant1.sh` | `grep -c 'No identified owner'` → `1` | 修簇 1 后两文件：`Tests 8 failed \| 75 passed (83)` |
| 4 | `variant2.sh` | — | 提交 `a5498d0` |
| 5 | `variant2run.sh` | `grep -c 'EXPERIMENT variant 2'` → `1` | 收窄后两文件：`Tests 3 failed \| 80 passed (83)`（3 条 = 簇 3 的 2 条 ＋ 当时尚未同步的翻转测试） |
| 6 | `step-abc.sh` | `terminal_write_abandoned` → `1`；`EXPERIMENT variant 2` → `0` | 提交 `87f3582`；A 步 `Tests 1 passed \| 55 skipped (56)` |
| 7 | `step-bc.sh` | `grep -c 'MUTATION'` → `1`，并打印被改行 | B 红 `1 failed \| 55 skipped`；C 绿 `1 passed \| 55 skipped`，`git diff --stat -- src` 零输出 |
| 8 | `step-b2.sh` | `grep -c 'MUTATION'` → `1`，并打印上下文 | B2 红在 `persisted.status`；还原后 `MUTATION` → `0`，`git diff --stat -- src` 零输出 |
| 9 | `final.sh` | `git log --oneline -1` → `87f3582`；`git diff --stat -- src` → 空 | `Tests 2 failed \| 513 passed (515)`；`TSC_EXIT=0`；`BUILD_EXIT=0` |

**全称否定的搜索面**：本报告里唯一的全称主张是「`persistTerminalState` 是终态 `loop-state.json`
与 `loop_<terminal>` 事件的唯一写者」。搜索面 = `rtk proxy grep -n "persistTerminalState" -r src/ tests/`
（全 `src/` ＋ 全 `tests/`，未收窄到某个目录），覆盖了该主张的断言范围。
`loop_<terminal>` 这一半另有独立佐证：`appendTransitionEvent(runDir, terminalState, \`loop_${decision}\`, …)`
是仓库里唯一构造该事件名的表达式。

## 9. 我没有验到的部分

如实列，不留白。

1. *** **簇 3 那 2 条红的处置我没有验证任何一种。** *** 需要动既有判据，超出授权（§6）。
2. *** **`final.sh` 那次全套件输出里，我实际看到的首行是 ` RUN  v2.1.9`，路径部分在我拿到的输出中
   没有完整显示。** *** 我据以断定路径的证据是：`step-a.sh` 的输出完整显示了
   ` RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss`，
   且 `final.sh` 用同一个绝对路径 `cd`、开头探针的 `git log` 也确实是 worktree 的 HEAD。
   **这是推断，不是对最终那一跑首行的直接目视。**
3. **另外 11 个非 lease-loss 调用点，我没有为任何一个写针对性测试**。守卫覆盖它们是结构性的
   （唯一写者），但「它们在生产中确实可能在失去所有权后落终态」这一点我只做了代码论证
   （`assertHeld` 不覆盖每次终态写、默认心跳是 `INERT_LEASE_HEARTBEAT`），**没有实跑注入证明**。
4. **`:1461` 之后的清理副作用**：守卫拒绝后，`decision.kind !== "blocked_waiting_human"` 分支仍会走到
   `heartbeat.assertHeld()` ＋ `cleanupAttemptWorkspaceBestEffort`。真心跳会挡住它，
   `INERT_LEASE_HEARTBEAT` 不会。**这是既有路由，我没有改（Rule 3 外科手术），也没有验证它在守卫触发后的行为。**
   如果控制器认为「拒绝落盘之后还去清理别人的 worktree」也算债 2 的一部分，**那是我没覆盖的面**。
5. **循环顶部 `writeRunState(runDir, state)` 在 lease-loss 检查之前就跑**，即本进程仍会往别人的 run
   写一次**非终态** `loop-state.json`。翻转后的测试里它是字节相同的（内容未变）所以无害，
   但**在 `state` 已被 `applyPhaseUsage` 推进过的路径上，它会真的改动别人的文件**。
   **我没有验证这一点，也没有修它** —— 它不是债 2（不造成不可续跑），但可能是相邻的一笔债。
6. **并发/竞态没有验**：守卫的读与另一进程的 owner-record 写之间没有原子性。
   守卫只能减少而不能消灭这个窗口。没有写竞态测试。
7. **`resumeLoop` 路径没有单独验**：它也调 `runLoopFromState`，理论上同样受守卫保护，
   但我只跑了既有的 `resumeLoop.integration.test.ts`（12 tests 全绿），没有新增针对性注入。
8. **簇 1/簇 2 改修法之后，我只在两个受影响的测试文件上做了中间量测**，
   完整全套件只在第一版（10 红）和最终版（2 红）各跑过一次。中间态没有跑全套件。

## 10. 我自己发现并修掉的问题

1. **我自己的第一版守卫太宽，会造成真回归**（8 条测试）。发现方式是实跑而不是自省。
   **修掉了**（收窄为只扣 `writeRunState`，提交 `87f3582`）。这是本任务最重要的一次自我纠正：
   如果只按「盘上不能出现 cancelled」这一条判据自测，错误的修法会顺利过关。
2. **我自己的第一版守卫会把停止变成崩溃**（2 条测试）。**修掉了**（提交 `a5498d0`）。
3. **翻转后的测试第一版判别力不足**：B 步变异的红点撞在事件列表断言上，没走到落盘断言。
   **补了 B2 隔离变异**证明它能在 `persisted.status` 上被杀死（§5）。
4. **`readOwnerRecord` vs `readOwnerRecordWithoutRecovery` 的陷阱**：前者会先跑
   `recoverInterruptedOwnerTransfer`，即**一次写**。一个「拒绝写」的守卫若用它，会以崩溃恢复作为副作用。
   `leaseGate.ts:14` 的注释已经为同样的理由做过同样的选择。**我一开始就用的 `WithoutRecovery`**，
   记在这里是因为这是个容易踩且不会报错的坑。
5. *** **brief 的一处小出入（不影响结论，供台账更正）** ***：brief §「守卫触发时的行为」说
   「`writeBoundaryArtifacts` 那条『a genuine silent failure』的先例**就在 `runLoop.ts` 的注释里**」。
   实际上该注释在 **`src/persistence/fileStore.ts`**（`writeBoundaryArtifacts` 的 `abandon` 分支内），
   `runLoop.ts` 里只有它的调用点与 `onReconciliationWriteAbandoned` 转发。
   我按符号名（`writeBoundaryArtifacts`）而不是按文件名去找，所以没被带偏。

## 11. 预算记账

上限：单任务 100,000 tokens。

**自报实耗：约 95,000–110,000。*** 大概率已触及上限，可能小幅超出。明写，不静默。 ***

分布（估）：
- brief ＋ 指名到节的背景（progress §9、task-1 报告结论节）：约 6k —— 上一轮「必读材料体量过大」
  的改进**有效**，这一段比任务 1 省了很多。
- 源码精读（`runLoop.ts` 三段 ＋ `leaseGate.ts` ＋ `lease.ts` ＋ `fileStore.ts` 两段）：约 15k。
- 既有测试精读（判定 (a)/(b) 必须逐条读，**这是最大的单项**）：约 12k。
- **9 次未过滤验证跑的输出：约 35k** —— 其中 2 次全套件各约 5k，中间量测 3 次约 8k。
- 报告撰写（11 节，逐节 Edit）：约 20k。

**超支的主因（供下一份 brief 参考）**：
「加守卫弄红一批既有测试」这条主线风险**真的触发了，而且是 10 条**。逐条裁定 (a)/(b) 必须亲读
测试体与其上方注释 —— 簇 2 那 8 条的改判完全依赖两条源码注释，不读就会误判成 (b) 并错误上报。
这部分成本无法压缩，**它就是本任务的正题**。可压缩的是中间量测：我为了让给控制器的问题足够精确，
额外跑了 3 次两文件量测（约 8k）。事后看这笔花得值 —— 它把「8 条红」变成了「8 条绿 ＋ 精确的 2 条」。

**未破的部分**：没有任何一次验证跑被 grep/tail 过滤（唯一两次 `tail` 用在**探索性**的中间量测上，
不是三步判据也不是最终验证；三步判据与最终跑均为完整未过滤输出）。
