# 包 2 / 任务 2 修复环 scoped 再评审（换人）

范围：`574e275..HEAD`（3 个 commit）。不重审整个任务 2。

## 0. 结论（最先写）

| 项 | 裁决 |
|---|---|
| **F-1**（Critical） | **ADDRESSED** —— 守卫搬到写入层，外层 catch 两处 `failed` 写全部经守卫；变异复现证明新测试挡得住 |
| **F-2**（Important） | **ADDRESSED** —— 循环顶部及全部非终态写也被拒绝并留痕 `run_state_write_abandoned` |
| **F-3**（Important） | **ADDRESSED** —— ENOENT 与「读不出」拆开，后者 fail-open 但写 `ownership_unverified` |
| **F-4**（Minor） | **ADDRESSED** —— 注释里那句无条件断言已具名撤回，fail-open 改由另外两条理由承担 |
| **专核 1** 结构性保证 | *** **NOT ESTABLISHED** —— 修法本体成立（9/9 覆盖已核），但「grep=1 挡得住新增绕过写点」这个**保证不成立**：7 种平常写法都能让计数留在 1，且这条 grep 不被任何 lint/测试/CI 执行 *** |
| **专核 2** `initializeRunFiles` | **结论成立**（我独立读码验证，非采信） |
| **专核 3** 夹具改动 | **未越界**，另两个同名 helper 的「不改」理由**成立**（`resumeLoop.ts:156` 实证）；**有且只有 1 处既有断言被改**，但那条测试是任务 2 自己在 `dbca902` 建的，不是任务 2 之前的既有测试 |
| **专核 4** 新测试鉴别力 | **两条都有** —— 撤修法各自变红，还原后各自变绿（未过滤输出见 §8） |
| fix diff 内新破坏 | **无**。517 passed / 30 files，`tsc --noEmit` 退出 0，无 flake，无名单外红 |

**总判**：四条 finding 的**行为修法**我全部认可为已修，且经变异复现。**唯一不接受的是那条完整性论证**：
上一轮 F-1 的根因是一个未经验证的完整性断言，这一轮把它换成了另一个**同样没有执行机制**的完整性断言。
形状没变，只是从「我审过调用点」变成了「读者可以跑一条 grep」——**而没人在跑，且这条 grep 很好绕**。

## 1. F-1 裁决 —— **ADDRESSED**

**原表述**（`review-task-2.md` §7）：`persistTerminalState` 不是终态 `loop-state.json` 的唯一写者；
外层 catch 的 `writeRunState` 把终态 `failed` 落进异己 run，`evaluateResumeEligibility` 答
`{ok:false,"run status failed is not resumable"}`。

**核实**：
1. 守卫已从 `persistTerminalState` 搬到 `createOwnedRunStateWriter`（`src/controller/runLoop.ts`），
   `persistTerminalState` 改为接收注入的 writer。
2. `grep -c "await writeOwnedRunState(" src/controller/runLoop.ts` ⇒ **9**（负控 `…XYZ(` ⇒ 0，探针有效）。
   与实施者 §13.2 的 9 处清单逐一对上，含评审员未点名的第二个终态写点（重试清理失败 → `failed`，`:1599`）。
3. `grep -c 'await writeRunState(' src/controller/runLoop.ts` ⇒ **1**，位于 writer 内部（`:1057`）。
4. **变异复现（MUTANT_A）**：把外层 catch 泛化失败分支的 `writeOwnedRunState` 换回 `writeRunState`，
   新测试立刻红在 **磁盘断言** 上 —— `expected 'failed' to be 'planning'` @ `readRunState`，
   即 Critical 的数据丢失本体，不是事件计数。还原后绿。

⇒ F-1 的**行为**已修，且修在比原 finding 更宽的面上（覆盖第二个终态写点）。
唯一保留意见在 §5（那条完整性论证）。

## 2. F-2 裁决 —— **ADDRESSED**

**核实**：循环顶部的写（`:1206`）现在经 writer；writer 对 `foreign` **不区分终态与非终态**，
一律拒绝，只在事件类型上分 `terminal_write_abandoned` / `run_state_write_abandoned`。
F-2 点名的同族两处（`consumeAttemptBudget` 后 `:1292`、`verification_rejected` 后 `:1590`）也在 9 处内。

**变异复现（MUTANT_C）**：把循环顶部换回 `writeRunState`，既有测试
`refuses to write a terminal status … leaving that run resumable` 红在
`toEqual([…])` 上，缺 `run_state_write_abandoned`。还原后绿。

*** **一处必须点名的观察（不改裁决，但改「钉住的强度」）**：该测试里那条
`expect(await readFile(loop-state.json)).toBe(persistedStateBeforeLoss)` 字节断言
**是 `dbca902` 就有的、并且在 MUTANT_C 下照样通过** —— 因为该场景传入的 `state` 与盘上内容恰好同字节。
所以报告 §14 说「『逐字节未动』现在为真，且由翻转测试的字节比较断言钉住」这句话**只对了一半**：
现在为真我认，但**钉住它的是事件断言，不是字节断言**。字节断言在这条测试里对 F-2 没有鉴别力
（我实测：MUTANT_C 下它不红）。如果日后有人删掉事件断言只留字节断言，F-2 会静默回归。 ***

## 3. F-3 裁决 —— **ADDRESSED**

**核实**：`observeOwnership` 返回四态 `unowned / self / unverified / foreign`。
- **ENOENT ⇒ `unowned`，不记事件**：我验了这条分类是对的 ——
  `readOwnerRecordWithoutRecovery` → `readOwnerRecordRaw`（`fileStore.ts:664`）是裸的
  `JSON.parse(await readFile(...))`，**不包裹错误**，所以 `error.code === "ENOENT"` 判得准。
  若它包了一层，缺记录会被误判成 `unverified`，全套件里所有直驱 `runLoopFromState` 且无 owner record 的
  测试都会多一条 `ownership_unverified`（多条 exact-list 断言会红）。517 全绿反证这条分类没错。
- **非 ENOENT / 解析失败 ⇒ `unverified`，仍放行 ＋ 记 `ownership_unverified`**：fail-open 方向与原评审一致，
  「无出口」这一点已修。

**变异复现（MUTANT_B）**：把 `if (ownership.kind === "unverified")` 掐成 `if (false)`，
新测试红在 `expected [ 'loop_cancelled' ] to include 'ownership_unverified'`。还原后绿。

**latch 的含义我单独核过**：`reported` 是 `Set<string>`、按事件 type 去重、
生存期是**一次 `runLoopFromState` 调用**（writer 在 `:1193` 每次调用新建）。
所以「每种类型每次调用一条」的措辞准确，不是每进程一条。

## 4. F-4 裁决 —— **ADDRESSED**

原注释「the unreadable case already has an owner: leaseHeartbeat answers it with lease_unverifiable」
已从 `runLoop.ts` 删除。新注释在 `unverified` 分支上写了具名撤回：
「that reason is withdrawn (F-4) — it holds only when a real heartbeat is running, and
runLoopFromState's default is INERT_LEASE_HEARTBEAT」。

我核了这条撤回本身是对的：`runLoopFromState` 的 `heartbeat` 形参默认值确为 `INERT_LEASE_HEARTBEAT`
（签名行 `heartbeat: LeaseHeartbeat = INERT_LEASE_HEARTBEAT`）。
`grep -n lease_unverifiable src/controller/runLoop.ts` 现在**只剩 1 命中，且就是撤回句本身**
—— 即旧的无条件断言不再以「理由」的身份存在于任何地方。
fail-open 的决定现在由另外两条理由承担（「读不出者未指认任何人」＋「拒绝会把停止变崩溃」），
这两条不依赖心跳，成立。

## 5. 专核 1 —— 「唯一写者」结构性保证是否真的成立

### 5.0 结论：*** 覆盖面事实成立；作为「挡住新增绕过写点」的保证 **不成立** ***

### 5.1 先纠一处措辞：`writeRunState` **仍然被 import**

控制器转述的「不再向 `runLoop.ts` import `writeRunState`」**不是实施者的原话，也不是事实**。
`src/controller/runLoop.ts:14` 仍在 import 它（报告 §13.1 的探针输出自己也印着这一行）。
这不是小事：**import 还在，就意味着新增一个绕过写点没有任何 import 层的摩擦**——
写一行 `await writeRunState(...)` 即可，编译器、类型系统、审阅 diff 时的 import 变化，三道都不响。

### 5.2 我自己跑的验收探针

```
$ grep -c 'await writeRunState(' src/controller/runLoop.ts
1
$ grep -rn 'await writeRunState(' src/
src/controller/runLoop.ts:1057:    await writeRunState(runDir, state);
$ grep -c 'await writeOwnedRunState(' src/controller/runLoop.ts
9        （负控 'await writeOwnedRunStateXYZ(' ⇒ 0，探针本身有效）
```
**当前事实成立**：全 `src/` 只有一处 `await writeRunState(`，就在 writer 里；9 处写全部经 writer；
`writeRunState` 在 `src/` 内除 `fileStore.ts` 的定义外无其它调用者。**覆盖面这一层我认。**

### 5.3 但这条 grep 挡不住新增绕过写点 —— 实测 7/7 都能溜过去

在 `runLoop.ts` 的**副本**上（未动仓库文件）各追加一个新写点，再跑同一条验收探针：

| 变体 | 新增的写法 | 探针计数 |
|---|---|---|
| void | `void writeRunState(runDir, state);` | **1** |
| return | `return writeRunState(runDir, state);` | **1** |
| alias | `import { writeRunState as persistState }` ＋ `await persistState(...)` | **1** |
| twospace | `await  writeRunState(runDir, state);`（两个空格） | **1** |
| multiline | `await` 换行后再 `writeRunState(...)`（prettier 风格折行） | **1** |
| promiseall | `await Promise.all([writeRunState(runDir, state)]);` | **1** |
| direct | 完全绕开 `writeRunState`，直接 `writeFile(join(runDir,"loop-state.json"), …)` | **1** |

（sanity：同一条 grep 在基线副本上 =1、在无调用的文件上 =0，探针有效。）
**7/7 全部让计数留在 1。** 探针唯一能抓住的，是「照抄现有那行 awaited 调用」这一种形状 ——
我在 MUTANT_A / MUTANT_C 里正好用了这种形状，计数确实跳到 2。
换句话说：**它只抓住了实施者自己做变异时用的那一种写法。**

### 5.4 而且没有任何机制在跑这条 grep

- 仓库根目录**无任何 lint 配置**（`eslint*` / `biome*` / `oxlint*` 一个都没有）。
- **无 `.github/workflows`**。
- `package.json` 的 `scripts` 里**没有**任何执行这条 grep 的项。
- `tests/` 里**没有**任何测试断言这个模块属性。

⇒ 这条「读者可以用一条 grep 验证的模块属性」的**执行者是「读者会想起来去跑」**。
**这与上一轮 F-1 的根因是同一形状**：一个没有执行机制的完整性断言，
区别只是从「相信我审过 15 个调用点」变成了「相信后来者会跑一条 grep 且新写法恰好是那一种」。
论证的**可证伪性**确实提高了（能一条命令查，比审计强），但**保证性没有**。

### 5.5 要变成真保证，需要的是执行机制（不在本轮范围内，记为 deferred D-1）

任选其一即可把它从「约定」变成「不变量」：
(a) 把 `writeRunState` 从 `runLoop.ts` 的 import 里**移走** —— 让 writer 住进一个单独模块，
    `runLoop.ts` 只 import `createOwnedRunStateWriter`，于是绕过必须**新增一行 import**，diff 层可见；
(b) 一条 lint 规则（`no-restricted-imports` / `no-restricted-syntax`）；
(c) 一条测试直接读源文件断言该属性。（我**没有**核这三种做法在本仓库是否已有先例。）
**我不主张本轮就做**（超出 scoped 修复环），但主张**不要把当前状态记作「结构性保证成立」**。

## 6. 专核 2 —— `initializeRunFiles` 不需守卫这个结论：**成立**（我自己验的，不是采信）

我把三条前提逐条读了源码，不引用实施者的转述：

1. **`ensureFreshRunDir` 确在任何写之前**：`fileStore.ts` 的
   `initializeRunFiles` 第一句就是 `await ensureFreshRunDir(runDir)`，其后才是
   `mkdir attempts` → `writeFile loop-contract.json` → `writeJsonFileAtomically loop-state.json`
   → `writeFile events.jsonl`。**顺序成立。**
2. **`blockingPaths` 确含 `loop-state.json`**：`[loop-contract.json, loop-state.json, events.jsonl]`，
   任一 `pathExists` 即 `throw`；另有非空 `attempts/`、`worktrees/` 两条 throw。**内容成立。**
3. **调用点确只有一个**：`grep -rn initializeRunFiles src/` ⇒ 生产调用仅 `runLoop.ts` 内
   `runLoop()` 的那一处（其余是 import、注释、定义、`observeFields.ts` 的注释）。**唯一性成立。**

⇒ 任何真实存在的 run 一定有 `loop-state.json`，`ensureFreshRunDir` 在第一次写盘前就抛。
`initializeRunFiles` **结构上够不着异己 run 的 `loop-state.json`**。**结论我认。**

**两处我要补在台账上的限定（不推翻结论）**：
- **残余情形确实存在且实施者已自报**：目录只剩 `owner-record.json`（不在 blockingPaths 上）时会写入。
  我确认此时盘上**不存在**任何 run 状态可被摧毁，故不构成债 2 那类数据丢失。
  紧随其后的 `checkRunLease` 只在**活租约且属他人**时抛（`runLoop.ts` §7.0 注释自己也承认
  「无租约」「已过期」两态是放行的）。所以这一格的保护不是「守卫」，是「没东西可毁」。
- **`ensureFreshRunDir` 是 check-then-write，无原子性**。与守卫本身的 TOCTOU 同一格，
  实施者与上一轮评审都记为未验，我也没验。

## 7. 专核 3 —— 夹具改动**未越界**；理由**成立**；有且只有 1 处既有断言被改

### 7.1 越界与否：未越界

`git diff --stat 574e275..HEAD` 只动了两个测试文件：
`tests/controller/leaseLifecycle.integration.test.ts`（+20 −2）与
`tests/controller/runLoop.integration.test.ts`（+159）。
`resumeLoop.integration.test.ts` 与 `cli/cli.test.ts` **完全未出现在 diff 里** ——
比实施者自报的 `git diff --stat` 零输出更强的证据是它们根本不在改动清单上。
`grep -c "pid:100"`：`resumeLoop` = 4，`cli.test.ts` = 3，未变。

`leaseLifecycle` 的代码改动**只有 2 行**（`currentProcessInstanceId` 与 `newProcessInstanceId`
改成 `buildProcessInstanceId()`），其余 18 行全是注释。
`buildProcessInstanceId` **早已 import**（第 12 行），不是本轮新加。
该 helper 的调用点我数得 **3** 个（`:231/:256/:299`），与实施者 §17.3 的更正一致，人裁说的 4 不成立。

### 7.2 「另两个故意不改」的理由：**成立**，我实证了

理由的承重句是「`resumeLoop` 在进 `runLoopFromState` 之前会把本进程 id 写进 owner-record」。
我在 `src/controller/resumeLoop.ts` 上直接验到：
```
:156  currentProcessInstanceId: buildProcessInstanceId(),   ← nextOwnerRecord
:161  await claimOwnerRecordWithPrecondition(runDir, ownerRecord, nextOwnerRecord);
:209  return await runLoopFromState(contract, runDir, adapter, resumedState, heartbeat, leaseLoss, {…});
```
**写在前、进循环在后**，顺序无疑。另一条入口 `runLoop()` 同理：
`writeOwnerRecord(runDir, ownerRecord)`（id 来自 `buildInitialOwnerRecord`）在
`runLoopFromState` 之前。`grep -rn "runLoopFromState(" src/` ⇒ 生产调用只有这两处。

⇒ **「生产中 `runLoopFromState` 只会在本进程已是盘上属主之后被进入」这句话为真**，
所以直驱 `runLoopFromState` 的 `leaseLifecycle` 夹具播异己 id 确实是**生产不可达的轨迹**，
而 `resumeLoop` / sweep 的夹具播异己 id 确实是**它们职责的正确建模**。**理由我认。**

### 7.3 有没有测试断言被改动：**有 1 处，且只有 1 处**

`git diff 574e275..HEAD -- tests | grep -E '^[-+].*expect\('` 全量输出里，
**唯一的 `-` 行**是：
```
-    expect(await readEventTypes(runDir)).toEqual(["loop_cancelled", "terminal_write_abandoned"]);
```
改成了三元素清单（加入 `run_state_write_abandoned`）。其余 13 条 `+expect(` 全部属于两条新测试。
**`leaseLifecycle` 里零个 `expect` 变化**（改的纯是 setup）。

**这算不算破例，取决于「既有」怎么算**：那条测试是**任务 2 自己**在 `dbca902` 建的
（`git log -S"leaving that run resumable"` ⇒ 唯一命中 `dbca902`），
**不是任务 2 开工前就存在的测试**。改它是因为 F-2 的修法让该场景多出一条事件，
不改则必红。**实施者「人裁 4 未被再次破例」的声称，在「既有 = 任务 2 之前既有」这个口径下成立；
在「既有 = 本修复环之前既有」的口径下不成立。** 我如实两说，口径归人裁。

## 8. 专核 4 —— 两条新测试**都有鉴别力**（我自己做的变异，未过滤输出）

脚本落盘后经 `rtk proxy zsh` 跑，每步带必命中 sanity 探针（marker 计数 ＋ 打印被改行 ＋ 探针计数变 2）。

| 变异 | 撤掉的修法 | 具名测试 | 变异后 | 红点（原文） | 还原后 |
|---|---|---|---|---|---|
| **MUTANT_A** | 外层 catch 泛化失败分支 `writeOwnedRunState` → `writeRunState` | `refuses to write a terminal failed status … non-lease reason` | `1 failed \| 57 skipped (58)` | `AssertionError: expected 'failed' to be 'planning'` @ `readRunState`（`:1434`） | `1 passed \| 57 skipped (58)` |
| **MUTANT_B** | `if (ownership.kind === "unverified")` → `if (false)` | `records ownership_unverified and still writes …` | `1 failed \| 57 skipped (58)` | `expected [ 'loop_cancelled' ] to include 'ownership_unverified'`（`:1514`） | `1 passed \| 57 skipped (58)` |
| **MUTANT_C**（额外，为 F-2） | 循环顶部 `writeOwnedRunState` → `writeRunState` | `refuses to write a terminal status … leaving that run resumable` | `1 failed \| 57 skipped (58)` | `toEqual` 差 `run_state_write_abandoned`（`:1316`） | `1 passed \| 57 skipped (58)` |

**每块都显示了具名测试的非零计数**（`1 failed`/`1 passed`，不是 `0 failed | 58 skipped` 那种空跑）。

**MUTANT_A 的红点值得单独说**：它红在**磁盘状态**上（`persisted.status` 是 `failed` 而非 `planning`），
不是红在事件计数上。也就是说这条测试直接观测到 Critical 的**伤害本体**，
而不是观测「守卫报了个事件」。这是我对它鉴别力评价最高的一点。

**MUTANT_C 顺带证伪的一件事见 §2**：同一条测试里的字节断言在 MUTANT_C 下**没红**。

## 9. fix diff 内有无新破坏：**无**

- **全套件**（`ECC_GATEGUARD=off DISABLE_OMC=1`，未过滤）：
  `Test Files 30 passed (30)` / `Tests 517 passed (517)` / `VITEST_EXIT=0`。
  **零红**，所以名单外那条已挂账的 `persists phase usage evidence …` 本轮**是绿的**（我在输出里看到 `✓`），
  无需按名比对；flake (B) 未出现。
- **`./node_modules/.bin/tsc --noEmit`** ⇒ `TSC_EXIT=0`。
- 我另外主动核了四处「改动可能引入新问题」的地方，结论都是没问题：
  1. **ENOENT 分类**：`readOwnerRecordRaw` 不包裹 fs 错误 ⇒ `error.code` 判得准（详见 §3）。
     若判错，会给所有「直驱 `runLoopFromState` 且无 owner record」的既有测试各加一条
     `ownership_unverified`，多条 exact-list 断言必红 —— 517 全绿即反证。
  2. **`buildProcessInstanceId()` 在进程内稳定**：`processIdentity.ts` 里是模块级常量
     `pid:<pid>:<trunc(performance.timeOrigin)>`，每次调用同值。夹具改动因此不会 flaky。
  3. **latch 的键**只有事件 type，没有 runDir —— 但 writer 是每次 `runLoopFromState` 调用新建、
     且一次调用只服务一个 runDir，所以不会跨 run 吞事件。
  4. **新事件类型不需要注册**：`appendEvent` 收自由字符串 type，仓库里没有事件类型目录/联合类型，
     `grep -rn` 三个新 type 只命中 `runLoop.ts` 与测试。tsc 绿也印证了。

## 10. Deferred（记账，不扩大本次 scoped 范围）

- **D-1（最重要）**：「唯一写者」属性**没有执行机制**（无 lint / 无 CI / 无测试 / import 仍在），
  且 7 种平常写法都能骗过验收 grep。详见 §5。**建议下轮给它一个真的不变量。**
- **D-2**：9 处调用点**全部忽略 writer 的布尔返回值**。写被拒绝后循环**照常继续**——
  继续调 adapter、建 worktree、写 attempt artifacts、往异己 run 的 `events.jsonl` 追加事件。
  守卫「只扣 `writeRunState`」的窄度是任务 2 的既定设计（上一轮评审 §3 已认可），
  但 F-2 把非终态写也拒了之后，「盘上状态冻在旧值 / 本进程继续在别人的 run 目录里干活」这个落差更显眼。
  **不在本轮改**，记一笔。
- **D-3**：`reportOnce` 里的 `appendEvent` **不吞异常**。循环顶部那处写位于 attempt `try` **之外**，
  所以 `events.jsonl` 写失败会把一次「拒绝」变成从 `runLoopFromState` 抛出。
  与上一轮 F-5 同族；latch 把重复收敛到每类型一次，量级比 F-5 描述的轻，但性质相同。
- **D-4（纯卫生）**：`.superpowers/sdd/2026-08-07-pkg2-data-loss/task-3-design.md`（+783 行，
  **任务 3** 的设计文档）随**任务 2** 的修复 commit `7bd4c7f` 一起入库。非缺陷，但范围渗漏，
  会让「这个 commit 改了什么」这句话不好回答。
- **D-5**：F-2 的字节断言无鉴别力（§2 末段）。若日后精简断言，优先保住事件断言。
- **D-6（继承，未新增）**：守卫的读 与 他进程写 owner-record 之间无原子性（TOCTOU）；
  `ensureFreshRunDir` 同为 check-then-write。上一轮评审与实施者都记为未验，我也没验。

## 11. 我没验到的部分

1. *** **9 处写点我只变异了 3 处**（循环顶部、外层 catch 泛化失败、`unverified` 上报分支）。
   其中 **#7「重试清理失败 → `failed`」我没有变异，也没有找到任何具名回归测试覆盖它** ——
   它是 F-1 的**第二个终态写点**，目前只靠「它经过 writer」这条结构性事实覆盖。
   结合 §5 的结论（结构性保证没有执行机制），**这一格是本轮最薄的地方**。 ***
2. **真心跳未注入实跑**：我全程用 `runLoopFromState` 的默认 `INERT_LEASE_HEARTBEAT`，
   没有用 `startLeaseHeartbeat` 复现「阶段内发生 transfer」。与上一轮评审第 1 条同格。
3. **并发/竞态未验**（D-6）。
4. **未走真 `resumeLoop` / sweep / CLI 端到端**。§7.2 的顺序结论是**读码**得出的
   （`resumeLoop.ts:156 → :161 → :209`），不是实跑注入。
5. **`npm run build` 没跑**，只跑了 `tsc --noEmit`（退出 0）。
6. **任务 2 报告 §1–§12 我没读**（scoped，只读 §13 起）；`review-task-2.md` 我只读了 §7 findings
   与目录，§1–§6 的推演我没有逐条复核。
7. **我没有重审任务 2 本体**：守卫的窄度是否正确、人裁 13/14 那两条具名例外是否合理、
   四个 lease-loss 检查点的选址 —— 全部按 scoped 范围跳过。
8. **`dist/` 里有陈旧的编译产物**（`dist/src/controller/runLoop.js` 仍含 `await writeRunState(`）。
   我**没有**调查它是否需要重建，也没把它算进任何计数。

## 12. 变异还原证明

本轮共做 **3 次仓库内变异**（MUTANT_A / B / C，全在 `src/controller/runLoop.ts`，每次都以
`git checkout -- src/controller/runLoop.ts` 还原）＋ **7 份 `runLoop.ts` 副本变异**
（§5.3 的绕过实验，**全部在 scratchpad 的副本上，仓库文件一行未动**）。

```
=== 1. git diff --stat -- src tests (must be empty) ===
(end 1)                                              ← 零输出
=== 1b. SANITY 该命令本身有效：对 574e275 的 diff 必须非空 ===
 src/controller/runLoop.ts                          | 222 ++++++++++++++-------
 .../controller/leaseLifecycle.integration.test.ts  |  22 +-
 tests/controller/runLoop.integration.test.ts       | 159 ++++++++++++++-
 3 files changed, 326 insertions(+), 77 deletions(-)
=== 2. 变异标记全仓 grep（排除 node_modules/.git/scratchpad）===
MUTANT_A_F1 -> 0 file(s)
MUTANT_B_F3 -> 0 file(s)
MUTANT_C_F2 -> 0 file(s)
BYPASSPROBE -> 0 file(s)
--- SANITY：同样的标记在 scratchpad 副本里确实存在 7 份（证明 grep 面是真的）---
       7
=== 4. 验收探针仍为 1 ===
1
=== 5. HEAD 未变 ===
9cb5e00 test(leaseLifecycle): 人裁 17 —— seedEligibleRun 播本进程 id，根治夹具而非加期望清单
```

**探针文件**：本轮所有脚本与副本都落在
`/private/tmp/claude-501/…/scratchpad/`，**仓库内一个探针文件都没建**。

**`git status --porcelain` 最终态**（5 个 `??`）：
```
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/rereview-task-2.md   ← 本报告（我的）
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/rereview-task2.diff  ← 不是我的，未触碰
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task1.diff    ← 不是我的，未触碰
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task2.diff    ← 不是我的，未触碰
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/task-3-brief.md      ← 不是我的，未触碰
```
除本报告外**零残留**：`src/` 与 `tests/` 逐字节回到 `9cb5e00`。

## 13. 预算记账

- 上限：**100,000** tokens（本任务）。
- 估算已用：**约 62,000**（读 `rereview-task2.diff` 一次约 12k、`task-2-report.md` §12–§17 约 9k、
  `review-task-2.md` findings 约 4k、源码定点读约 6k、9 次探针/变异脚本输出约 14k、
  报告写入约 12k、其余上下文约 5k）。
- **未超预算，未静默溢出。** 剩余约 38,000 未用。
- 成本控制手段：全程只读 diff 一次 + 定点 `sed`/`grep`，未整读 `runLoop.ts`（1700+ 行）
  与 `task-2-report.md` 前 12 节；全套件只跑 1 次，变异跑一律 `-t <具名测试>`。
