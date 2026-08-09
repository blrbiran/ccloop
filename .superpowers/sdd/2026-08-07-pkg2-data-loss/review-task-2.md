# 包 2 / 任务 2 独立评审报告

评审员：独立评审（未参与实施）
分支：`feat/pkg2-data-loss`
worktree：`/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss`

## 0. 结论（最先写）

- **规范符合：✅**。brief 的每一条硬要求都做到了：守卫加在 `persistTerminalState` 内部并给了设计
  裁决理由；`:1514` 那层额外门槛专门回答了；触发行为不静默（`terminal_write_abandoned`）；
  任务 1 那条测试翻转了且改了名；10 条变红逐条裁定，8 条判 (a) 后改的是修法不是测试；
  2 条 (b) 原样上报，人裁 14 才补事件。**没有一条既有判据被越权改动**（我自己 diff 核过）。
- **任务质量：不通过**。不是因为改错了代码——改动本身正确、有鉴别力、无回归——而是因为
  **§1 结论里两句承重话在今天的代码上不成立**，且其中一句掩盖了一条与债 2 同型、同等严重的
  真实缺陷（我实跑复现，见 F-1）：
  1. 「`persistTerminalState` **is the only writer of a terminal loop-state.json**」——**假**。
     外层 catch 的 `writeRunState` 会把终态 `failed` 落进别人的 run，
     `evaluateResumeEligibility` 随即答 `{ok:false, reason:"run status failed is not resumable"}`。
     **这就是债 2 的伤害本体，走的是守卫覆盖不到的路。**
  2. 「别人那个 run 的 `loop-state.json` **逐字节未动**」——**假**（只在翻转后那条测试的场景里为真）。
     实跑复现：文件被改动。这条实施者自己在 §9.5 已列为未验线索，我验了，**成立**。
- **债 2 是否修干净：部分**。「`persistTerminalState` 把 `cancelled` 写进别人的 run」这个**具名缺陷
  确已修掉且有鉴别力**；但「本进程不再往不属于自己的 run 写不可续跑的终态」这个**结论不成立**。
- 全套件 **515 passed / 0 failed**（未过滤，见 §6/§9），`tsc --noEmit` 退出 0。
  名单内 flake (B) 与人裁 10 那条本次均未复现。

## 1. 必撞清单 1 —— 债 2 是否修干净：循环顶部 `writeRunState` 是否绕过守卫

**结论：线索成立，而且我在同一条线上撞出一条更重的——实施者和 brief 都没有覆盖到的终态写路径。**

方法：临时探针文件 `tests/controller/zzreviewprobe.test.ts`（同跑内含一条必命中 sanity
`expect(1+1).toBe(2)`，已复现命中），跑完删除。未过滤输出见 §9。

### 1.1 PROBE-B：实施者 §9.5 那条未验线索 —— **成立**

场景（可构造，即 `resumeLoop` 的入参形状）：`initializeRunFiles` 写入
`{currentAttempt:0, attemptsUsed:0, lastTransitionAt:"2026-07-21…"}`；随后 `owner-record.json`
被改写为 `pid:999999:1234567890`（`ownerStatus:"current"`，epoch 2）；本进程带着一个已推进的
`state`（`currentAttempt:2, attemptsUsed:2, lastTransitionAt:"2026-08-09…"`，正是 `resumeLoop`
把磁盘状态归一化成 `planning` 后交给 `runLoopFromState` 的形状）进入循环，`leaseLoss.lost` 已置位。

实测输出：

```
PROBE-B file changed = true
before: "currentAttempt": 0, "attemptsUsed": 0, "lastTransitionAt": "2026-07-21T10:00:00.000Z"
after : "currentAttempt": 2, "attemptsUsed": 2, "lastTransitionAt": "2026-08-09T00:00:00.000Z"
PROBE-B events = ["loop_cancelled","terminal_write_abandoned"]
```

`runLoopFromState` 循环顶部的 `writeRunState(runDir, state)` 在 `leaseLoss.lost !== null`
检查**之前**执行，**确实改动了别人的 `loop-state.json`**；守卫随后正确拒绝了终态写
（`terminal_write_abandoned` 在场），但文件已经被动过了。

**限定（我自己收窄的）**：写进去的 `status` 仍是 `planning`，**仍在 `RESUMABLE_STATUSES` 内**，
所以这一条本身**不造成不可续跑**——实施者 §9.5 把它归为「相邻的一笔债，不是债 2」，
**这个定性是对的**。它证伪的是 §1 结论里「逐字节未动」那句话，不是「债 2 已修」。

补充（读码，未单独实跑）：本进程内的循环第 2 圈及以后，顶部这次写的内容与 `verification_rejected`
分支里 `writeRunState` 刚写过的字节相同，所以**纯 in-loop 路径上它是无害的**；能改动内容的入口是
`resumeLoop` 那次（内存态 ≠ 磁盘态）。也就是说实施者那句话在措辞上偏保守——真正会改内容的是
`resumeLoss` 入口那一圈，以及下面 1.2 说的那两处。

### 1.2 PROBE-A：**守卫的承重前提「本函数是终态 loop-state.json 的唯一写者」是假的** ⇒ F-1

`runLoopFromState` 外层 catch 里：

```
if (state.status !== "failed") {
  state = transitionRunState(state, "failed", failureReason);
  await appendTransitionEvent(runDir, state, "attempt_failed", failureReason);
  await writeRunState(runDir, state);      // ← 不经过 persistTerminalState，不经过守卫
}
```

`failed` 是终态且是死端：`src/state/stateMachine.ts` 里 `failed: []`，
`src/controller/resumeLoop.ts` 的 `RESUMABLE_STATUSES = ["planning","executing","verifying"]`
不含它——**与 `cancelled` 完全同型**。重试清理失败分支
（`transitionRunState(state,"failed",…)` ＋ `writeRunState`）是第二处同型。

实测输出：

```
PROBE-A finalState.status = failed
PROBE-A persisted.status  = failed
PROBE-A events = ["attempt_failed"]        ← 没有 terminal_write_abandoned，守卫根本没被问到
PROBE-A resume verdict for the real owner = {"ok":false,"reason":"run status failed is not resumable"}
```

**可构造的生产场景**：进程 A 正在跑 attempt；`heartbeat.assertHeld()` 在该阶段起点通过（当时 A 还是
属主）；阶段内（plan/execute/verify，可长达分钟级）发生 epoch transfer，`owner-record.json` 改指
进程 B；随后 adapter 抛出**非租约类**错误（`PhaseExecutionError`／适配器崩溃）。外层 catch 的
`isLeaseStopError` 不匹配，**该路径在写盘前不再重新检查所有权**，于是把 `failed` 落进 B 的
`loop-state.json`。B 的 run 就此永久死端——**这正是债 2 描述的伤害**。

precondition 与债 2 完全相同（并发所有权移交 ＋ 心跳尚未在该写点介入），reachability 甚至更高
（「attempt 失败」是常规路径，比「租约丢失恰好落在四个检查点」常见）。守卫拆掉了这间屋子的一道门，
另外两道门原样敞着。

## 2. 必撞清单 2 —— 守卫的三条设计论证逐条验

### 2a 不复用 `checkRunLease` —— **理由成立**

读 `src/controller/leaseGate.ts`：`checkRunLease` 在租约**过期**时走的是
`return { kind: "expired", ownerRecord }`，**不抛**，即使 `currentProcessInstanceId` 指向别人；
只有「租约新鲜 ＋ 指向别人」才 `throw RunLeaseHeldError`。所以若 `persistTerminalState` 复用它并把
「没抛」当作「我是属主」，**一个租约已过期的异己属主会被放行**——正是债 2 要挡的那一格。
论证成立，且我给它补一条实施者没写的独立理由：`checkRunLease` 在 expired 分支会
`appendEvent("lease_expired_observed")`，**读操作带写副作用**，放在拒绝路径上不合适。

### 2b 读 RAW —— **理由成立**

`fileStore.ts`：`readOwnerRecord` 第一行就是 `await recoverInterruptedOwnerTransfer(runDir)`，
而该函数会 finalize pending transfer / 删除 staging 文件（都是写）。
`readOwnerRecordWithoutRecovery` 直接 `readOwnerRecordRaw`。所以「一次拒绝写不该以触发 crash
recovery 为副作用」成立，且与 `leaseGate` §7.1 的既有立场一致（Rule 11 合规，不是自创一套）。
在本场景下这条比在 gate 里更强：`persistTerminalState` 跑在停止路径上，此时替**别人**完成一次
所有权移交尤其荒谬。

### 2c 不可读/缺失时不拒绝 —— **方向对，但有一处它自己立场不自洽的漏点**

方向判断：**对**。`foreignOwnerOf` 只在**正面识别出异己 id** 时返回非 null，其余一律 `null`（放行）。
这使守卫**只能增加拒绝、不能增加崩溃**。若改成 fail-closed，异常会从 `persistTerminalState` 冒出
`runLoopFromState`，把一次「停止」变成一次「崩溃」——而这一步之前 `appendTransitionEvent` 已经追加了
`loop_<terminal>`，会留下一条无下文的事件。dbca902 那一版正是 fail-closed
（非 ENOENT 直接 rethrow），实测弄红了 `stops with lease_unverifiable and writes no owner record
when the record is corrupt`（见 §4），a5498d0 改掉它是**被真回归逼出来的正确收窄**，不是妥协。

**漏点（⇒ F-3）**：拒绝时会写 `terminal_write_abandoned`，**判不出来时什么都不写**。
可构造场景：`owner-record.json` 因瞬时 EIO/EMFILE 读失败（不是 ENOENT），守卫 fail-open，
把 `cancelled` 写进一个**实际由别人持有**的 run——债 2 原样复发，且 `events.jsonl` 里**没有任何痕迹**
说明守卫当时是「没能判断」而不是「判断为自己」。这与它自己援引的
`writeBoundaryArtifacts`「a protective abandonment with no outlet at all would be a genuine silent
failure」立场不自洽：**放弃有出口，判不出来反而没出口。**
真实异己场景会不会漏掉：**除这一格外没有别的**——所有权只经 epoch transfer 易手，
`applyOwnerEpochTransfer` 写入的记录必然携带新属主 id，所以「记录可读但没指认异己」这一格里
不存在被漏掉的真实异己。

另外核过一条它注释里的说法：「the unreadable case already has an owner: leaseHeartbeat answers it
with lease_unverifiable」。**这条只在有真心跳时成立**。`runLoopFromState` 的默认心跳是
`INERT_LEASE_HEARTBEAT`（`assertHeld: async () => {}`），此时无人接管 unreadable 这一格。
注释把一个有条件的事实写成了无条件的（Minor，见 F-4）。

## 3. 必撞清单 3 —— 只扣 `writeRunState` 的窄度是否正确

**窄度本身正确；「窄到这个函数」不正确。**

- **保留内存终态与 `loop_<terminal>`：对。** 实测（§4）：把这两样也扣掉（dbca902）会弄红 8 条既有
  测试，其中如 `stops at the next phase boundary with stopReason lease_lost and leaves the new
  record intact` 断言的是 `finalState.stopReason === "lease_lost"` 与
  `loop_cancelled` 事件在场——**它们钉的是「本进程为什么停」的上报，不是「能写进别人的 run」**，
  所以是真回归。`assertHeld` 按设计不产生事件，抹掉这条转换会让一次租约原因的停止**无人署名**。
  这与 brief 第 4 条「静默失败不可接受」的立场一致。
- **别的该扣而没扣的写路径：有，见 §1.2（F-1）和 §1.1（F-2）。**
  `src/controller/runLoop.ts` 里 `writeRunState` 共 10 个调用点，守卫只覆盖 1 个
  （`persistTerminalState` 内那个）。其余 9 个全部无守卫，其中：
  - 外层 catch 的 `failed` 写 ＋ 重试清理失败分支的 `failed` 写：**落终态死端**（F-1，Critical）；
  - 循环顶部那次、`consumeAttemptBudget` 后那次、`verification_rejected` 后那次：落非终态，
    污染计数器但不致死端（F-2，Important）。注意后两处都排在各自的
    `heartbeat.assertHeld()` **之前**，窗口是整个阶段时长，不是一个瞬间。
- **`:1514`（第 4 处 lease-loss 检查点）在本方案下的行为**：我核过，实施者的回答成立。
  该处是 `return isTerminalRunStatus(state.status) ? state : await persistTerminalState(...)`；
  守卫在函数**内部**，所以 `state.status` 已终态时 `persistTerminalState` 根本不被调用，
  守卫零 I/O、零事件。若按方案 (B) 加在调用点，守卫必然写在三元之外，
  会把「什么都不做」变成「读盘 ＋ 追加一条放弃事件」。**这条论证我确认成立。**
- **一处它注释里过窄的断言（Minor，F-5）**：注释说「A throw from it cannot be upgraded into a
  failed attempt — every **lease-loss** call site either sits outside the attempt try or already
  sits inside its catch」。但守卫作用于**全部 15 个**调用点，不只 4 个 lease-loss 点。
  在 try 体内的非 lease-loss 调用点（如终态决定那一处）上，若
  `appendEvent("terminal_write_abandoned")` 抛出，会被外层 catch 接住 →
  转 `failed` → `writeRunState`，**恰好把「不写别人的 run」变成「把 failed 写进别人的 run」**。
  论证的作用域比守卫的作用域窄了一圈。触发需要磁盘级失败，故定 Minor。

## 4. 必撞清单 4 —— 8 条「真回归」改判抽查

**抽查结论：8 条改判全部正确，没有任何一条是「把测试的正确期望改掉了」。**

最强的结构性证据先说：`git diff --stat b16d5a6..574e275 -- src tests` 只有两个文件
（`src/controller/runLoop.ts`、`tests/controller/runLoop.integration.test.ts`），
而 8 条红的测试**全在 `tests/controller/leaseLifecycle.integration.test.ts`**——
**这个文件一个字节都没被动过**。所以「改测试凑绿」在物理上就没发生。

行为证据（我自己复现，不看它的输出）：`git checkout dbca902 -- src/controller/runLoop.ts`
（宽守卫），对 HEAD 的测试跑全套件，未过滤计数 **`Tests 11 failed | 507 passed (518)`**：

- `leaseLifecycle.integration.test.ts` **8 条**（与实施者报的 8 条**同名逐条对上**）：
  `stops at the next phase boundary…` / `refuses the catch-path re-read once superseded…` /
  `check 2: stops at the retry boundary itself…` / `does not launch the next Claude call…` /
  `leaves the attempt worktree in place…` / `stops with lease_unverifiable and writes no owner
  record when the record is corrupt` / `refuses persistBoundaryAnalysis…（spec requirement 6）` /
  `writes no boundary artifact…（spec requirement 7）`。
- `runLoop.integration.test.ts` 3 条 = 翻转后那条 ＋ 人裁 14 那 2 条（518 含我的 3 条探针）。

逐条读判据后的定性：这 8 条断言的是**返回值的 `status`/`stopReason`** 和
**`loop_cancelled` 事件在场**，**没有一条断言「异己 run 的 `loop-state.json` 被写成了终态」**。
所以它们**不依赖缺陷行为**，判 (a) 真回归正确；宽守卫（返回未转换的 `state` ＋ 吞掉
`loop_<terminal>`）确实破坏了正确行为。收窄修法是对的方向。其中
`stops with lease_unverifiable…when the record is corrupt` 这一条对应的是 a5498d0 那次收窄
（fail-closed → fail-open），也判得对（见 §2c）。

## 5. 必撞清单 5 —— 2 条具名例外是否外推

**没有外推。**

- `git diff --stat b16d5a6..574e275 -- src tests` = 2 个文件；测试侧只有
  `tests/controller/runLoop.integration.test.ts`。**其余所有测试文件零改动**，
  包含承载那 8 条的 `leaseLifecycle.integration.test.ts`。
- 该文件内的改动只有 4 个 hunk（`review-task2.diff` 全文与 `git diff` 一致，我逐 hunk 核过）：
  2 个属于翻转那条测试（brief 第 2 条明确授权），2 个分别是两条 winner reconciliation 测试的
  穷举事件列表末尾追加一行 `"terminal_write_abandoned"`——**正是人裁 14 具名的那两条**。
- 这两处**只加了一行事件，没有削弱任何断言**：`toEqual` 仍是穷举式，
  `expect(finalState.status).toBe("cancelled")`、`expect(finalState.stopReason).toBe("lease_lost")`、
  `readdir(worktrees)`、`readEventDetails(runDir,"lease_lost")` 全部原样保留。
- 行为侧交叉验证（§6 变异 3）：把守卫整个拆掉后，`runLoop.integration.test.ts` 里**恰好 3 条红**
  ——翻转那条 ＋ 这 2 条，**其余 53 条全绿**。这从另一头证明：窄守卫对这 2 条以外的既有测试
  行为中性，两条例外确实是「前提变了」而不是「列表原来写错了」。

## 6. 必撞清单 6 —— 三步判据自行复现

**自己复现，成立，且鉴别力不止一层。**（我做了 3 次源码变异，全部还原，见 §9）

**变异 1 — 守卫整个拆掉**（`persistTerminalState` 内只留 `transitionRunState` ＋
`appendTransitionEvent` ＋ `writeRunState`）：

```
 ❯ tests/controller/runLoop.integration.test.ts (56 tests | 1 failed | 55 skipped)
   × runLoop > refuses to write a terminal status into a run a different, current owner already
     holds when this process's own lease is lost, leaving that run resumable
     → expected [ 'loop_cancelled' ] to deeply equal [ 'loop_cancelled', …(1) ]
 Tests  1 failed | 55 skipped (56)
```

具名测试非零计数：`1 failed`。

**变异 2 — 只拆掉「扣写」，保留事件**（守卫照旧读盘、照旧 append `terminal_write_abandoned`，
但不 early-return，仍执行 `writeRunState`）。这一步是为了排除「测试其实只靠那条新事件在红」：

```
   × runLoop > refuses to write a terminal status … leaving that run resumable
     → expected 'cancelled' to be 'planning' // Object.is equality
     ❯ tests/controller/runLoop.integration.test.ts:1318  expect(persisted.status).toBe("planning")
 Tests  1 failed | 55 skipped (56)
```

**磁盘那一半独立有鉴别力**——`persisted` 来自 `readRunState(runDir)`，是真磁盘。
这是本次复现里最重要的一格：翻转后的测试**不是**靠一条自己新造的事件在红。

**变异 3 — 守卫整个拆掉，跑整文件**（顺带服务 §5）：

```
 Tests  3 failed | 53 passed (56)
   × refuses to write a terminal status … leaving that run resumable
   × preserves the winner reconciliation view when another controller already completed the transfer
   × writes no synthesized winner reconciliation view when another controller already completed …
```

恢复守卫后复绿：全套件 **`Tests  515 passed (515)` / `Test Files  30 passed (30)`**，
`tsc --noEmit` 退出 0（未过滤输出见 §9）。vitest 首行
` RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss` —— 路径已目视核对，
是本 worktree。

## 7. Findings

### Critical

- **F-1：`persistTerminalState` 不是终态 `loop-state.json` 的唯一写者，守卫因此漏掉与债 2
  同型的死端写。** `runLoopFromState` 外层 catch 的 `writeRunState`（以及重试清理失败分支的那处）
  把终态 `failed` 落进异己 run，`evaluateResumeEligibility` 实测答
  `{ok:false, reason:"run status failed is not resumable"}`。
  **定级理由**：伤害与债 2 完全同型（真属主的 run 永久不可续跑）、precondition 相同、
  reachability 更高（attempt 失败是常规路径）；而且它**证伪了守卫选址的承重前提**——
  「一处覆盖 15 个调用点、第 16 个也绕不过」这句话只对 `persistTerminalState` 的调用点成立，
  对**绕过 `persistTerminalState` 的终态写**不成立。报告 §1 的「债 2 已修掉」据此不完整。
  场景见 §1.2，实测输出见 §9。

### Important

- **F-2：循环顶部 `writeRunState` 在 lease-loss 检查之前改动异己 run 的 `loop-state.json`。**
  实施者 §9.5 自报的未验线索，我实跑复现**成立**（PROBE-B）。落的是非终态 `planning`，
  **仍可续跑**，所以不是死端；但会用本进程的 `currentAttempt`/`attemptsUsed`/`lastTransitionAt`
  覆盖真属主的计数器。同族的还有 `consumeAttemptBudget` 后与 `verification_rejected` 后两处，
  且都排在各自 `assertHeld()` **之前**，窗口是整个阶段时长。
  **定级理由**：真实数据覆盖且静默，但不致不可续跑，最后写者胜出后可自愈；
  低于 F-1 一级。**同时它直接证伪了报告 §1 的「逐字节未动」**。
- **F-3：守卫「判不出属主」时 fail-open 且完全无痕。** 非 ENOENT 读失败 / 记录畸形 →
  `foreignOwnerOf` 返回 `null` → 照写终态，`events.jsonl` 里没有任何记录说明守卫当时未能判断。
  **定级理由**：fail-open 的方向我认同（见 §2c，fail-closed 会把停止变崩溃），
  但「无出口」这一点与它自己援引的 `writeBoundaryArtifacts`「genuine silent failure」立场矛盾，
  且这正是债 2 复发的那一格。修法很小（catch 里补一条 `terminal_write_guard_inconclusive` 事件），
  不改任何判定语义。

### Minor

- **F-4：注释里一句有条件的事实被写成了无条件。** 「the unreadable case already has an owner:
  leaseHeartbeat answers it with lease_unverifiable」只在有真心跳时成立；
  `runLoopFromState` 默认心跳是 `INERT_LEASE_HEARTBEAT`（`assertHeld` 空实现），
  此时无人接管这一格。**定级理由**：不影响运行行为，只影响后来者据此注释做判断的正确性。
- **F-5：「throw 不会被升级成 failed attempt」这句论证的作用域比守卫窄一圈。** 它只核了 4 个
  lease-loss 调用点，但守卫作用于全部 15 个；try 体内的非 lease-loss 调用点上，
  `appendEvent` 抛出会被外层 catch 转成 `failed` ＋ `writeRunState`。
  **定级理由**：需要磁盘级失败才触发，概率低；但后果恰好是守卫要防的那件事，值得记一笔。
- **F-6：报告 §1「代价：2 条既有测试仍红」在 HEAD 上已过期。** 人裁 14 的 574e275 之后
  全套件 515 passed / 0 failed。**定级理由**：纯文档时序，非缺陷。

## 8. 我没验到的部分

1. **F-1 我没有用真心跳（`startLeaseHeartbeat`）实跑，用的是 `runLoopFromState` 的默认
   `INERT_LEASE_HEARTBEAT`。** 「阶段内发生 transfer、阶段末非租约错误、外层 catch 写盘前不再
   复查所有权」这条链我是**读码论证**的（`assertHeld` 是时点检查，外层 catch 的
   `state.status !== "failed"` 分支路径上没有第二次所有权检查）。**真心跳注入的实跑我没做。**
   这不影响「存在一条绕过守卫的终态写路径」这个事实（PROBE-A 已直接观测到），
   但影响它在带真心跳的生产配置下的**触发频率**估计。
2. **并发/竞态一格未验**：守卫的读与另一进程的 owner-record 写之间没有原子性，我没写竞态测试。
   与实施者 §9.6 同一格，我没有补上。
3. **`resumeLoop` 入口我没有实跑注入**，F-2 的 PROBE-B 是**直接调 `runLoopFromState` 模拟
   `resumeLoop` 的入参形状**，不是走真 `resumeLoop`（后者有四道拒绝在前，需要构造
   owner-transfer/reconciliation 全套 fixture）。所以 F-2 的 TOCTOU 窗口宽度我没有量到。
4. **另外 11 个非 lease-loss 调用点我没有逐个写针对性测试**（与实施者 §9.3 同一格）。
   我只核了它们结构上都经过 `persistTerminalState`。
5. **`npm run build` 我没跑**（brief 要求实施者跑，我作为评审只跑了 `tsc --noEmit`，退出 0）。
6. **实施者报告的 §3–§8、§10、§11 我没有逐字通读**，只按需读了 §1、§2、§9。
   报告里可能还有别的过期或过强的措辞是我没看到的。
7. **`git status` 里有两个不是我的条目**：`A .superpowers/…/task-3-design.md`（已 staged）与
   `?? .superpowers/…/task-3-brief.md`。会话开始时快照是 clean，这两个是本次评审期间由别处产生的，
   **我没有触碰、也没有调查它们**。

## 9. 变异还原证明

本轮为验证三步判据做了 3 次 `src/controller/runLoop.ts` 变异 ＋ 1 次
`git checkout dbca902 -- src/controller/runLoop.ts`，另建了 1 个临时探针文件
`tests/controller/zzreviewprobe.test.ts`。**全部还原。**

```
$ rm -f tests/controller/zzreviewprobe.test.ts
$ git diff --stat -- src
<空>
$ git diff --stat -- tests
<空>
$ grep -rn "REVIEW_MUTATION_MARKER" src tests scripts | wc -l
       0
$ grep -rn "persistTerminalState" src tests scripts | wc -l      # 同一 grep 面的 sanity 探针
      26
$ ls tests/controller/
leaseGate.test.ts  leaseHeartbeat.test.ts  leaseLifecycle.integration.test.ts
resumeLoop.gate.test.ts  resumeLoop.integration.test.ts  runLoop.integration.test.ts
$ git status --porcelain
A  .superpowers/sdd/2026-08-07-pkg2-data-loss/task-3-design.md      ← 不是我的（见 §8.7）
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task-2.md      ← 本报告
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task1.diff     ← 控制器提供的输入
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task2.diff     ← 控制器提供的输入
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/task-3-brief.md       ← 不是我的（见 §8.7）
$ git log --oneline -1
574e275 test(runLoop): 人裁 14 —— 两条 winner reconciliation 测试的期望事件清单补入 terminal_write_abandoned
```

**`src` 与 `tests` 对 HEAD 零 diff**，变异标记零命中（同 grep 面的必命中探针 26 命中，
证明 grep 本身有效、覆盖面包含 `src`/`tests`/`scripts`），探针文件已删除。

还原后重跑（未过滤）：

```
$ ./node_modules/.bin/tsc --noEmit
TSC_EXIT=0
$ ./node_modules/.bin/vitest run
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss
 …
 Test Files  30 passed (30)
      Tests  515 passed (515)
```

名单内 flake (B)（`evidence.test.ts > run-scenario CLI > records env names only and tracks
descendants rooted at the spawned pid`）与人裁 10 那条挂账项
（`runLoop.integration.test.ts > runLoop > persists phase usage evidence from the subprocess
adapter without recomputing controller totals`）本次两跑均**绿**，未复现，按名比对后未再调查。

## 10. 预算记账

**上限 100,000，实际约 115,000 —— 破了，明写。**

超支来源：(1) 必撞清单第 1 条要求实跑证伪，写探针 ＋ 3 次变异 ＋ 4 次 vitest 跑
（其中 3 次全套件，未过滤输出各约 2.5k）；(2) `runLoop.ts` 1639 行、
`runLoop.integration.test.ts` 3903 行，定位承重代码需要多次分段 Read；
(3) 为回答第 4 条又跑了一次 dbca902 宽守卫的全套件。

按 Rule 6 主动上报，未静默overrun。若控制器要压预算，可砍的是 §4 那次 dbca902 全套件重跑
（约 8k），代价是「8 条同名逐条对上」只能靠读报告而非自证。
