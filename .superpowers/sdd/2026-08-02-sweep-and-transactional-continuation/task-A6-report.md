# Task A6 报告 — `evaluateResumeEligibility` 八条判据的变异 campaign（测试 15、验收 5）

**分支**：`feat/l3-debt1-transactional-continuation`（worktree `l3-debt1-group-a`）
**起点 HEAD**：`448e575`　**本任务提交**：`64171bf test(resumeLoop): give each of the eight eligibility criteria its own killing mutation`
**改动面**：只有 `tests/controller/resumeLoop.gate.test.ts`。`src/` 一个字节未改（证据见 §7.2）。

**过滤旁路声明**：本仓库有一个全局 `rtk` shell hook 会自动改写/摘要命令输出。本报告里**每一条**验证命令都以 `rtk proxy "<command>"` 执行以绕过它；`tee` 只用于把输出同时落盘供本报告逐字引用，**不截断任何内容**。除 `tee` 外没有任何管道、`tail`、`grep`、`head`、`2>/dev/null`。

---

## 1. Step 1 — 重推八条判据原文与计数守卫

命令：`sed -n '39,68p' src/controller/resumeLoop.ts` 与 `grep -cF 'return { ok: false' src/controller/resumeLoop.ts`（本次执行原始输出，未过滤）：

```
export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility {
  const { ownerRecord, ownerTransfer, reconciliation, runState } = input;

  if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
    return { ok: false, reason: "owner-transfer is not eligible for continuation" };
  }
  if (reconciliation.eligibleForContinuation !== true) {
    return { ok: false, reason: "reconciliation-record is not eligible for continuation" };
  }
  if (reconciliation.ownershipVerdict !== "OWNER_LOST") {
    return { ok: false, reason: `reconciliation verdict is ${reconciliation.ownershipVerdict}, expected OWNER_LOST` };
  }
  if (reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
    return { ok: false, reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch" };
  }
  if (ownerRecord.supersededByEpoch !== null) {
    return { ok: false, reason: `owner epoch is superseded by ${ownerRecord.supersededByEpoch}` };
  }
  if (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
    return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
  }
  if (ownerRecord.ownerStatus !== "current") {
    return { ok: false, reason: `owner status is ${ownerRecord.ownerStatus}, expected current` };
  }
  if (!RESUMABLE_STATUSES.includes(runState.status)) {
    return { ok: false, reason: `run status ${runState.status} is not resumable` };
  }

  return { ok: true };
}
sed_exit=0
8
count_guard_exit=0
```

**逐字比对结论：与 brief 表格中的八条判据逐字一致，无一字节差异**，计数守卫本次执行输出 **8**（不是引用计划里的 8，是上面这次执行打印的 8）。不需要停下上报。

对照表（左列为上面输出里的原文，右列为本任务采用的变异）：

| # | 判据原文（逐字，含 cast） | 采用的变异 | 变异 ID |
|---|---|---|---|
| 1 | `(ownerTransfer.eligibleForContinuation as boolean) !== true` | 整条删掉 | M1 |
| 2 | `reconciliation.eligibleForContinuation !== true` | 整条删掉 | M2 |
| 3 | `reconciliation.ownershipVerdict !== "OWNER_LOST"` | 整条删掉 | M3 |
| 4 | `reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch` | 改为 `>` | M4 |
| 5 | `ownerRecord.supersededByEpoch !== null` | 整条删掉 | M5 |
| 6 | `ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch` | 整条删掉 / 改为 `<` | M6a / M6b |
| 7 | `ownerRecord.ownerStatus !== "current"` | 整条删掉 | M7 |
| 8 | `!RESUMABLE_STATUSES.includes(runState.status)` | 改为恒 false（`if (false)`） | M8 |
| 1（额外） | 同第 1 条 | 改为 `=== false` | M1b |

**为什么第 6 条有两个变异（这是我对 brief 的一处解读，请评审员核）**：brief 的 Step 2 要求八条各有一个**具名**测试（其中第 6 条的名字是 `refuses when the owner epoch does not equal the transfer epoch`），Step 4 又要求第三组 fixture 单独一条具名测试（`refuses when the owner epoch has run ahead of the transfer epoch`），而 Step 6 要求「八 + 二 = 十次变异实验、共 20 份原始输出」，即**十条具名测试各有一次自己的击杀**。表里第 6 条的 `<` 变异按 Step 6 明令绑给第三组 fixture，于是 Step 2 那条第 6 条测试若不另配变异就会没有击杀。因此我给第 6 条配了两个变异：`<`（杀第三组 fixture 那条）与整条删掉（杀 Step 2 那条）。这样十条测试 × 十次实验 = 20 份原始输出，且表里那八个变异**一个不少全部执行过**。

---

## 2. 实现了什么

`tests/controller/resumeLoop.gate.test.ts` 里新增 10 条测试（全部落在既有的 `describe("evaluateResumeEligibility")` 内，因此完整测试名就是 brief 指定的那十个），外加一个 `doubleTransferInput()` 构造函数。既有 17 条测试**一条未改**。

### 2.1 击杀如何做到「归属正确」（本任务最关键的一条设计）

既有那批测试断的是 `expect(evaluateResumeEligibility(input).ok).toBe(false)` —— **只断真假，不断是哪一条判据拒的**。八条判据对同一个输入都能返回 `ok:false`，所以在一个「一次只变异一条」的 campaign 里，这个形状会让「变异了第 X 条，红的却是被第 Y 条钉住的测试」看起来像一次成功击杀。

**我采用的机制：新增的十条全部断言逐字的 `reason` 字符串**，即 `expect(evaluateResumeEligibility(input)).toEqual({ ok: false, reason: "<该判据自己的那一句>" })`。`reason` 是唯一能指名裁决者的可观测量，所以：

- 若变异使裁决权落到别的判据身上，测试会红在「reason 不对」，红块里 `Received` 会显示**另一条判据的 reason**——那说明 fixture 没隔离干净，是我的缺陷，不是击杀。
- 若 fixture 隔离干净，变异后输入会一路穿过全部八条到 `{ ok: true }`。

**§6 的 20 份原始输出里，10 份注入后红块的 `Received` 全部是 `{ "ok": true }`**（不是别的 reason）。这是「被变异那条是唯一裁决者」的直接证据，也是每次击杀归属正确的证据。brief 本身没有指定归属机制，这是我按 brief 的「测试名里每一个分句都必须有一条能失败的断言」与「不许靠别的判据顺带挡住」两条推出来的做法；我没有沿用邻近测试的弱断言形状。

### 2.2 两组 A5 fixture 的最小重建（不跨文件 import）

- **首发转移形态**：本文件既有的 `baseInput()` 就是它的输入层最小形态（转移 1→2 已发布、owner record 在 epoch 2、reconciliation 也在 2）。八条单字段测试里的七条直接在它上面只改一个字段，其余七条判据全部满足。
- **双转移形态**：新增 `doubleTransferInput()`。第一次转移 1→2 干净落地，第二次 2→3 在 `owner-transfer.json` 与 owner record 都已经转到 3、但 `reconciliation-record.json` 还没重写时崩掉，于是 reconciliation 仍描述 1→2。**这是唯一一种 reconciliation epoch 落在 transfer epoch 后面的形态**，也正是把第 4 条的 `!==` 与 `>` 区分开来所必需的：既有那条测试用的是 reconciliation epoch 跑在前面（3 > 2），`>` 变异在它上面**存活**。

---

## 3. Step 5 — 十条新测试各自单跑，十份原始输出

十次独立 `npx vitest run tests/controller/resumeLoop.gate.test.ts -t '<完整测试名>'`（每次都打印自己的退出码；这十次是**独立于** §6 注入前那十次的另一批执行，没有把两步塌缩成一批）：

```
===== STEP5 run 1/10: evaluateResumeEligibility refuses when owner-transfer eligibleForContinuation is not literally true

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:29
   Duration  338ms (transform 91ms, setup 0ms, collect 118ms, tests 2ms, environment 0ms, prepare 37ms)

STEP5_EXIT_1=0
===== STEP5 run 2/10: evaluateResumeEligibility refuses when the reconciliation record is not eligible

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:30
   Duration  329ms (transform 92ms, setup 0ms, collect 117ms, tests 2ms, environment 0ms, prepare 42ms)

STEP5_EXIT_2=0
===== STEP5 run 3/10: evaluateResumeEligibility refuses when the reconciliation verdict is not OWNER_LOST

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:31
   Duration  334ms (transform 88ms, setup 0ms, collect 112ms, tests 2ms, environment 0ms, prepare 36ms)

STEP5_EXIT_3=0
===== STEP5 run 4/10: evaluateResumeEligibility refuses when the reconciliation epoch does not equal the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:32
   Duration  336ms (transform 89ms, setup 0ms, collect 115ms, tests 1ms, environment 0ms, prepare 36ms)

STEP5_EXIT_4=0
===== STEP5 run 5/10: evaluateResumeEligibility refuses when the owner record has been superseded

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:33
   Duration  341ms (transform 93ms, setup 0ms, collect 118ms, tests 2ms, environment 0ms, prepare 36ms)

STEP5_EXIT_5=0
===== STEP5 run 6/10: evaluateResumeEligibility refuses when the owner epoch does not equal the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:33
   Duration  336ms (transform 92ms, setup 0ms, collect 117ms, tests 1ms, environment 0ms, prepare 38ms)

STEP5_EXIT_6=0
===== STEP5 run 7/10: evaluateResumeEligibility refuses when the owner status is not current

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:34
   Duration  333ms (transform 91ms, setup 0ms, collect 118ms, tests 2ms, environment 0ms, prepare 38ms)

STEP5_EXIT_7=0
===== STEP5 run 8/10: evaluateResumeEligibility refuses when the run status is not resumable

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:35
   Duration  325ms (transform 90ms, setup 0ms, collect 116ms, tests 2ms, environment 0ms, prepare 37ms)

STEP5_EXIT_8=0
===== STEP5 run 9/10: evaluateResumeEligibility refuses when owner-transfer eligibleForContinuation is missing entirely

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:36
   Duration  331ms (transform 93ms, setup 0ms, collect 118ms, tests 2ms, environment 0ms, prepare 35ms)

STEP5_EXIT_9=0
===== STEP5 run 10/10: evaluateResumeEligibility refuses when the owner epoch has run ahead of the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:32:37
   Duration  340ms (transform 92ms, setup 0ms, collect 118ms, tests 1ms, environment 0ms, prepare 35ms)

STEP5_EXIT_10=0
```

十次全部 `1 passed | 26 skipped` + `STEP5_EXIT_n=0`。`26 skipped` 同时证明**每次确实只跑了那一条**。

### ⚠️ 关于 `-t` 参数形状的一处硬性偏离（必须让评审员知道）

brief 的判据写的是 `npx vitest run <文件> -t '<完整测试名>'`，而「完整测试名」在本报告的其它地方按 `describe > it` 书写。**vitest 2.1.9 的 `-t` 匹配的是用空格拼接的全名，不含 `>`。** 我实测过：

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy "npx vitest run tests/controller/resumeLoop.gate.test.ts -t 'evaluateResumeEligibility > refuses when supersededByEpoch is set'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ↓ tests/controller/resumeLoop.gate.test.ts (17 tests | 17 skipped)

 Test Files  1 skipped (1)
      Tests  17 skipped (17)
   Start at  15:26:31
   Duration  364ms (transform 97ms, setup 0ms, collect 126ms, tests 0ms, environment 0ms, prepare 39ms)

EXIT=0
```

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy "npx vitest run tests/controller/resumeLoop.gate.test.ts -t 'evaluateResumeEligibility refuses when supersededByEpoch is set'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (17 tests | 16 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 16 skipped (17)
   Start at  15:26:40
   Duration  358ms (transform 89ms, setup 0ms, collect 115ms, tests 1ms, environment 0ms, prepare 45ms)

EXIT=0
```

（这两次是在写新测试**之前**跑的，所以文件当时是 17 条；用的是既有测试 `refuses when supersededByEpoch is set`。）

**带 `>` 的形状匹配不到任何测试，`17 skipped`，而且退出码是 0** —— 也就是说，照字面写 `>` 会得到一个「命令绿了」的假绿：注入变异之后它照样绿，任何一条变异都会被记成「存活」；反过来，如果实施者只贴注入后那次，也可以拿这个 0 冒充「注入前绿」。这是一条**静默**的证据形状缺陷。因此本报告全部单跑都用**空格拼接**的全名，并且每一份输出里都能看到 `1 passed | 26 skipped`（而不是 `27 skipped`）来证明确实选中了一条。

---

## 4. 十条测试与它们钉住的判据

| # | 完整测试名（`describe > it`） | fixture 的决定性取值 | 断言的 reason | 击杀它的变异 |
|---|---|---|---|---|
| 1 | `evaluateResumeEligibility > refuses when owner-transfer eligibleForContinuation is not literally true` | `eligibleForContinuation = "true"`（真值但非布尔） | `owner-transfer is not eligible for continuation` | M1 |
| 2 | `evaluateResumeEligibility > refuses when the reconciliation record is not eligible` | `reconciliation.eligibleForContinuation = false` | `reconciliation-record is not eligible for continuation` | M2 |
| 3 | `evaluateResumeEligibility > refuses when the reconciliation verdict is not OWNER_LOST` | `ownershipVerdict = "OWNER_VALID"` | `reconciliation verdict is OWNER_VALID, expected OWNER_LOST` | M3 |
| 4 | `evaluateResumeEligibility > refuses when the reconciliation epoch does not equal the transfer epoch` | 双转移：reconciliation 2、transfer 3 | `reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch` | M4 |
| 5 | `evaluateResumeEligibility > refuses when the owner record has been superseded` | `supersededByEpoch = 3` | `owner epoch is superseded by 3` | M5 |
| 6 | `evaluateResumeEligibility > refuses when the owner epoch does not equal the transfer epoch` | owner epoch 1 < transfer 2 | `published eligibility has been superseded by a newer owner epoch` | M6a |
| 7 | `evaluateResumeEligibility > refuses when the owner status is not current` | `ownerStatus = "lost"` | `owner status is lost, expected current` | M7 |
| 8 | `evaluateResumeEligibility > refuses when the run status is not resumable` | `status = "succeeded"` | `run status succeeded is not resumable` | M8 |
| 9 | `evaluateResumeEligibility > refuses when owner-transfer eligibleForContinuation is missing entirely` | 字段被 `delete`（`undefined`） | `owner-transfer is not eligible for continuation` | M1b |
| 10 | `evaluateResumeEligibility > refuses when the owner epoch has run ahead of the transfer epoch` | owner epoch 3 > transfer 2 | `published eligibility has been superseded by a newer owner epoch` | M6b |

第 1 条用真值非布尔的 `"true"` 而不是 `false`：`as boolean` 这个 cast 的存在说明该字段静态类型是字面量 `true`（`src/runtime/types.ts` 的 `OwnerTransferRecord.eligibleForContinuation: true`），cast 只是为了让 `!== true` 不被编译器判成恒假——也就是说第 1 条防的就是从磁盘 JSON 读出来的**非布尔运行时取值**。第 9 条则钉住 `undefined` 这个具体取值。

第 5 条的 fixture 特意保留 `ownerStatus = "current"`：第 7 条在第 5 条**之后**，若顺手把 status 改掉，M5 变异后会被第 7 条接住，两侧行为一致 → 变异存活。这条注释写在测试里。

---

## 5. 第 6 条的第三组 fixture — 七条约束逐条核对

测试：`evaluateResumeEligibility > refuses when the owner epoch has run ahead of the transfer epoch`
取值：`currentOwnerEpoch = 3`、`ownerTransfer.newOwnerEpoch = 2`（即 N+2 与 N+1，N=1）。基线 `3 !== 2` → 拒绝；变异体 `3 < 2` 为 false → 放行 → 红。

测试体里对这七条**逐条显式赋值**（不依赖 `baseInput()` 恰好是对的），并逐条写了注释说明为什么要设：

| 判据 | fixture 取值（测试里显式那一行） | 相对第 6 条的位置 | 若不设会怎样 |
|---|---|---|---|
| 1 | `input.ownerTransfer.eligibleForContinuation = true` | 之前 | 两侧都被第 1 条抢先拒 → 变异存活 |
| 2 | `input.reconciliation.eligibleForContinuation = true` | 之前 | 同上 → 变异存活（brief 点名的最危险一条：场景描述是「owner epoch 跑到 transfer 前面」，与 reconciliation 的 eligible 位毫无直觉关联） |
| 3 | `input.reconciliation.ownershipVerdict = "OWNER_LOST"` | 之前 | 同上 |
| 4 | `input.ownerTransfer.newOwnerEpoch = 2` 与 `input.reconciliation.newOwnerEpoch = 2`（相等） | 之前 | 同上 |
| 5 | `input.ownerRecord.supersededByEpoch = null` | 之前 | 同上 |
| 7 | `input.ownerRecord.ownerStatus = "current"` | **之后** | 变异体在第 6 条放行后被第 7 条拒 → 两侧行为相同 → 变异存活 |
| 8 | `input.runState.status = "executing"`（∈ `RESUMABLE_STATUSES`） | **之后** | 同上 |

**七条全部满足的实证**（不是靠推理）：M6b 注入后该条单跑的红块里 `Received` 是 `{ "ok": true }` —— 输入穿过了全部其余七条判据，说明它们确实一条都没拦。见 §6.7 的原始输出。

**可达性**：这组 fixture 是手工构造的，生产中不可达（它对应「更晚的一次转移已经完成、但 `owner-transfer.json` 还是旧的」）。**测试注释里逐字写明了这一点**：测试 15 钉的是判据的**语义**不是可达性。

**关于第 6 条在 gate 层是否可达（任务交办说明要求我自己确认后再依赖它）**：我确认了。A5 在**磁盘**层测到的「第 6 条从不做出裁决」是 `resumeLoop` 读路径的性质——一次早于 gate 的、对尚不存在的 `reconciliation-record.json` 的裸读会先抛出。而 `evaluateResumeEligibility` 是对已构造好的 `ResumeGateInput` 的**纯函数**（`src/controller/resumeLoop.ts`，`export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility`，不碰磁盘），gate 测试直接喂输入，读路径的遮蔽根本不在这一层。实证：M6a 与 M6b 两次实验的基线单跑都是绿的，且它们断言的 reason 正是第 6 条自己那一句 `published eligibility has been superseded by a newer owner epoch`——即基线下确实是**第 6 条**做出的裁决；删掉它 / 改成 `<` 之后结果变成 `{ ok: true }`。**第 6 条在 gate 层直接可达，且是这两条 fixture 的唯一裁决者。**

---

## 6. Step 6 — 十次变异实验，20 份原始输出

每次实验一个脚本跑完四步，每一步各自打印退出码：

1. `npx vitest run <文件> -t '<完整测试名>'`（注入前）→ `PRE_EXIT`
2. 注入（`python3` 逐字替换生产代码，锚点必须**恰好出现一次**否则中止）+ `git diff -- src/controller/resumeLoop.ts` 展示被改的正是生产代码
3. 同一条单跑（注入后）→ `POST_EXIT`
4. 还原（从注入前留存的 pristine 副本 `cp` 回去）+ `shasum` 双边比对 + `git diff --stat -- src/controller/resumeLoop.ts`（须为空）+ `grep -cF 'return { ok: false'`（须为 8）

注入点全部在**生产代码** `src/controller/resumeLoop.ts` 上，没有一处改的是测试 fixture。

**十次实验结论：十条全部被击杀（`PRE_EXIT=0` 绿 → `POST_EXIT=1` 红），无一存活。** 因此不需要写补法。

### 6.1 M1 — 第 1 条整条删掉

```
===== [M1] PRE-INJECTION single run: evaluateResumeEligibility refuses when owner-transfer eligibleForContinuation is not literally true

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:29:51
   Duration  350ms (transform 89ms, setup 0ms, collect 119ms, tests 2ms, environment 0ms, prepare 44ms)

PRE_EXIT=0
===== [M1] INJECT
injected M1
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..0190c72 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -39,9 +39,6 @@ const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "veri
 export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility {
   const { ownerRecord, ownerTransfer, reconciliation, runState } = input;
 
-  if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
-    return { ok: false, reason: "owner-transfer is not eligible for continuation" };
-  }
   if (reconciliation.eligibleForContinuation !== true) {
     return { ok: false, reason: "reconciliation-record is not eligible for continuation" };
   }
DIFF_EXIT=0
===== [M1] POST-INJECTION single run: evaluateResumeEligibility refuses when owner-transfer eligibleForContinuation is not literally true

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 6ms
   × evaluateResumeEligibility > refuses when owner-transfer eligibleForContinuation is not literally true 6ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when owner-transfer eligibleForContinuation is not literally true
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "owner-transfer is not eligible for continuation",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:128:46
    126|     const input = baseInput();
    127|     (input.ownerTransfer as unknown as { eligibleForContinuation: unkn…
    128|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    129|       ok: false,
    130|       reason: "owner-transfer is not eligible for continuation",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:29:52
   Duration  339ms (transform 88ms, setup 0ms, collect 115ms, tests 6ms, environment 0ms, prepare 38ms)

POST_EXIT=1
===== [M1] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.2 M2 — 第 2 条整条删掉

```
===== [M2] PRE-INJECTION single run: evaluateResumeEligibility refuses when the reconciliation record is not eligible

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:29:59
   Duration  331ms (transform 90ms, setup 0ms, collect 114ms, tests 1ms, environment 0ms, prepare 38ms)

PRE_EXIT=0
===== [M2] INJECT
injected M2
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..4a3baf4 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -42,9 +42,6 @@ export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibi
   if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
     return { ok: false, reason: "owner-transfer is not eligible for continuation" };
   }
-  if (reconciliation.eligibleForContinuation !== true) {
-    return { ok: false, reason: "reconciliation-record is not eligible for continuation" };
-  }
   if (reconciliation.ownershipVerdict !== "OWNER_LOST") {
     return { ok: false, reason: `reconciliation verdict is ${reconciliation.ownershipVerdict}, expected OWNER_LOST` };
   }
DIFF_EXIT=0
===== [M2] POST-INJECTION single run: evaluateResumeEligibility refuses when the reconciliation record is not eligible

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 7ms
   × evaluateResumeEligibility > refuses when the reconciliation record is not eligible 6ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when the reconciliation record is not eligible
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "reconciliation-record is not eligible for continuation",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:137:46
    135|     const input = baseInput();
    136|     input.reconciliation.eligibleForContinuation = false;
    137|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    138|       ok: false,
    139|       reason: "reconciliation-record is not eligible for continuation",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:30:00
   Duration  342ms (transform 90ms, setup 0ms, collect 117ms, tests 7ms, environment 0ms, prepare 43ms)

POST_EXIT=1
===== [M2] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.3 M3 — 第 3 条整条删掉

```
===== [M3] PRE-INJECTION single run: evaluateResumeEligibility refuses when the reconciliation verdict is not OWNER_LOST

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:30:08
   Duration  327ms (transform 94ms, setup 0ms, collect 117ms, tests 1ms, environment 0ms, prepare 50ms)

PRE_EXIT=0
===== [M3] INJECT
injected M3
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..6883c5e 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -45,9 +45,6 @@ export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibi
   if (reconciliation.eligibleForContinuation !== true) {
     return { ok: false, reason: "reconciliation-record is not eligible for continuation" };
   }
-  if (reconciliation.ownershipVerdict !== "OWNER_LOST") {
-    return { ok: false, reason: `reconciliation verdict is ${reconciliation.ownershipVerdict}, expected OWNER_LOST` };
-  }
   if (reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
     return { ok: false, reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch" };
   }
DIFF_EXIT=0
===== [M3] POST-INJECTION single run: evaluateResumeEligibility refuses when the reconciliation verdict is not OWNER_LOST

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 6ms
   × evaluateResumeEligibility > refuses when the reconciliation verdict is not OWNER_LOST 5ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when the reconciliation verdict is not OWNER_LOST
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "reconciliation verdict is OWNER_VALID, expected OWNER_LOST",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:146:46
    144|     const input = baseInput();
    145|     input.reconciliation.ownershipVerdict = "OWNER_VALID";
    146|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    147|       ok: false,
    148|       reason: "reconciliation verdict is OWNER_VALID, expected OWNER_L…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:30:08
   Duration  334ms (transform 87ms, setup 0ms, collect 113ms, tests 6ms, environment 0ms, prepare 44ms)

POST_EXIT=1
===== [M3] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.4 M4 — 第 4 条 `!==` → `>`（双转移 fixture）

```
===== [M4] PRE-INJECTION single run: evaluateResumeEligibility refuses when the reconciliation epoch does not equal the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:30:15
   Duration  368ms (transform 92ms, setup 0ms, collect 133ms, tests 2ms, environment 0ms, prepare 46ms)

PRE_EXIT=0
===== [M4] INJECT
injected M4
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..7d03552 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -48,7 +48,7 @@ export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibi
   if (reconciliation.ownershipVerdict !== "OWNER_LOST") {
     return { ok: false, reason: `reconciliation verdict is ${reconciliation.ownershipVerdict}, expected OWNER_LOST` };
   }
-  if (reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
+  if (reconciliation.newOwnerEpoch > ownerTransfer.newOwnerEpoch) {
     return { ok: false, reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch" };
   }
   if (ownerRecord.supersededByEpoch !== null) {
DIFF_EXIT=0
===== [M4] POST-INJECTION single run: evaluateResumeEligibility refuses when the reconciliation epoch does not equal the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 6ms
   × evaluateResumeEligibility > refuses when the reconciliation epoch does not equal the transfer epoch 5ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when the reconciliation epoch does not equal the transfer epoch
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:158:46
    156|   it("refuses when the reconciliation epoch does not equal the transfe…
    157|     const input = doubleTransferInput();
    158|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    159|       ok: false,
    160|       reason: "reconciliation newOwnerEpoch does not match owner-trans…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:30:16
   Duration  332ms (transform 92ms, setup 0ms, collect 114ms, tests 6ms, environment 0ms, prepare 41ms)

POST_EXIT=1
===== [M4] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.5 M5 — 第 5 条整条删掉

```
===== [M5] PRE-INJECTION single run: evaluateResumeEligibility refuses when the owner record has been superseded

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:30:23
   Duration  348ms (transform 90ms, setup 0ms, collect 128ms, tests 2ms, environment 0ms, prepare 41ms)

PRE_EXIT=0
===== [M5] INJECT
injected M5
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..8af7af4 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -51,9 +51,6 @@ export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibi
   if (reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
     return { ok: false, reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch" };
   }
-  if (ownerRecord.supersededByEpoch !== null) {
-    return { ok: false, reason: `owner epoch is superseded by ${ownerRecord.supersededByEpoch}` };
-  }
   if (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
     return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
   }
DIFF_EXIT=0
===== [M5] POST-INJECTION single run: evaluateResumeEligibility refuses when the owner record has been superseded

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 6ms
   × evaluateResumeEligibility > refuses when the owner record has been superseded 5ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when the owner record has been superseded
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "owner epoch is superseded by 3",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:170:46
    168|     const input = baseInput();
    169|     input.ownerRecord.supersededByEpoch = 3;
    170|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    171|       ok: false,
    172|       reason: "owner epoch is superseded by 3",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:30:24
   Duration  338ms (transform 91ms, setup 0ms, collect 119ms, tests 6ms, environment 0ms, prepare 38ms)

POST_EXIT=1
===== [M5] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.6 M6a — 第 6 条整条删掉

```
===== [M6a] PRE-INJECTION single run: evaluateResumeEligibility refuses when the owner epoch does not equal the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:30:31
   Duration  362ms (transform 91ms, setup 0ms, collect 121ms, tests 1ms, environment 0ms, prepare 44ms)

PRE_EXIT=0
===== [M6a] INJECT
injected M6a
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..cd15639 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -54,9 +54,6 @@ export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibi
   if (ownerRecord.supersededByEpoch !== null) {
     return { ok: false, reason: `owner epoch is superseded by ${ownerRecord.supersededByEpoch}` };
   }
-  if (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
-    return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
-  }
   if (ownerRecord.ownerStatus !== "current") {
     return { ok: false, reason: `owner status is ${ownerRecord.ownerStatus}, expected current` };
   }
DIFF_EXIT=0
===== [M6a] POST-INJECTION single run: evaluateResumeEligibility refuses when the owner epoch does not equal the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 6ms
   × evaluateResumeEligibility > refuses when the owner epoch does not equal the transfer epoch 5ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when the owner epoch does not equal the transfer epoch
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "published eligibility has been superseded by a newer owner epoch",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:182:46
    180|     const input = baseInput();
    181|     input.ownerRecord.currentOwnerEpoch = 1;
    182|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    183|       ok: false,
    184|       reason: "published eligibility has been superseded by a newer ow…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:30:32
   Duration  337ms (transform 90ms, setup 0ms, collect 118ms, tests 6ms, environment 0ms, prepare 36ms)

POST_EXIT=1
===== [M6a] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.7 M6b — 第 6 条 `!==` → `<`（第三组 fixture）

```
===== [M6b] PRE-INJECTION single run: evaluateResumeEligibility refuses when the owner epoch has run ahead of the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:30:39
   Duration  340ms (transform 90ms, setup 0ms, collect 119ms, tests 2ms, environment 0ms, prepare 38ms)

PRE_EXIT=0
===== [M6b] INJECT
injected M6b
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..db23e0f 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -54,7 +54,7 @@ export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibi
   if (ownerRecord.supersededByEpoch !== null) {
     return { ok: false, reason: `owner epoch is superseded by ${ownerRecord.supersededByEpoch}` };
   }
-  if (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
+  if (ownerRecord.currentOwnerEpoch < ownerTransfer.newOwnerEpoch) {
     return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
   }
   if (ownerRecord.ownerStatus !== "current") {
DIFF_EXIT=0
===== [M6b] POST-INJECTION single run: evaluateResumeEligibility refuses when the owner epoch has run ahead of the transfer epoch

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 5ms
   × evaluateResumeEligibility > refuses when the owner epoch has run ahead of the transfer epoch 5ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when the owner epoch has run ahead of the transfer epoch
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "published eligibility has been superseded by a newer owner epoch",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:246:46
    244|     input.runState.status = "executing"; // 8
    245| 
    246|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    247|       ok: false,
    248|       reason: "published eligibility has been superseded by a newer ow…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:30:40
   Duration  340ms (transform 91ms, setup 0ms, collect 115ms, tests 5ms, environment 0ms, prepare 36ms)

POST_EXIT=1
===== [M6b] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.8 M7 — 第 7 条整条删掉

```
===== [M7] PRE-INJECTION single run: evaluateResumeEligibility refuses when the owner status is not current

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:30:52
   Duration  334ms (transform 89ms, setup 0ms, collect 115ms, tests 2ms, environment 0ms, prepare 37ms)

PRE_EXIT=0
===== [M7] INJECT
injected M7
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..6f29b17 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -57,9 +57,6 @@ export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibi
   if (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
     return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
   }
-  if (ownerRecord.ownerStatus !== "current") {
-    return { ok: false, reason: `owner status is ${ownerRecord.ownerStatus}, expected current` };
-  }
   if (!RESUMABLE_STATUSES.includes(runState.status)) {
     return { ok: false, reason: `run status ${runState.status} is not resumable` };
   }
DIFF_EXIT=0
===== [M7] POST-INJECTION single run: evaluateResumeEligibility refuses when the owner status is not current

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 6ms
   × evaluateResumeEligibility > refuses when the owner status is not current 5ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when the owner status is not current
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "owner status is lost, expected current",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:191:46
    189|     const input = baseInput();
    190|     input.ownerRecord.ownerStatus = "lost";
    191|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    192|       ok: false,
    193|       reason: "owner status is lost, expected current",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:30:53
   Duration  360ms (transform 87ms, setup 0ms, collect 114ms, tests 6ms, environment 0ms, prepare 49ms)

POST_EXIT=1
===== [M7] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.9 M8 — 第 8 条改为恒 false

```
===== [M8] PRE-INJECTION single run: evaluateResumeEligibility refuses when the run status is not resumable

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:31:03
   Duration  343ms (transform 92ms, setup 0ms, collect 121ms, tests 2ms, environment 0ms, prepare 39ms)

PRE_EXIT=0
===== [M8] INJECT
injected M8
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..3d28d22 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -60,7 +60,7 @@ export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibi
   if (ownerRecord.ownerStatus !== "current") {
     return { ok: false, reason: `owner status is ${ownerRecord.ownerStatus}, expected current` };
   }
-  if (!RESUMABLE_STATUSES.includes(runState.status)) {
+  if (false) {
     return { ok: false, reason: `run status ${runState.status} is not resumable` };
   }
 
DIFF_EXIT=0
===== [M8] POST-INJECTION single run: evaluateResumeEligibility refuses when the run status is not resumable

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 6ms
   × evaluateResumeEligibility > refuses when the run status is not resumable 6ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when the run status is not resumable
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "run status succeeded is not resumable",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:200:46
    198|     const input = baseInput();
    199|     input.runState.status = "succeeded";
    200|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    201|       ok: false,
    202|       reason: "run status succeeded is not resumable",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:31:04
   Duration  335ms (transform 90ms, setup 0ms, collect 118ms, tests 6ms, environment 0ms, prepare 35ms)

POST_EXIT=1
===== [M8] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

### 6.10 M1b — 第 1 条 `!== true` → `=== false`（`undefined` fixture）

```
===== [M1b] PRE-INJECTION single run: evaluateResumeEligibility refuses when owner-transfer eligibleForContinuation is missing entirely

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  15:31:12
   Duration  337ms (transform 92ms, setup 0ms, collect 119ms, tests 2ms, environment 0ms, prepare 36ms)

PRE_EXIT=0
===== [M1b] INJECT
injected M1b
INJECT_EXIT=0
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 1c91d85..1bb7ad9 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -39,7 +39,7 @@ const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "veri
 export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility {
   const { ownerRecord, ownerTransfer, reconciliation, runState } = input;
 
-  if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
+  if ((ownerTransfer.eligibleForContinuation as boolean) === false) {
     return { ok: false, reason: "owner-transfer is not eligible for continuation" };
   }
   if (reconciliation.eligibleForContinuation !== true) {
DIFF_EXIT=0
===== [M1b] POST-INJECTION single run: evaluateResumeEligibility refuses when owner-transfer eligibleForContinuation is missing entirely

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.gate.test.ts (27 tests | 1 failed | 26 skipped) 5ms
   × evaluateResumeEligibility > refuses when owner-transfer eligibleForContinuation is missing entirely 5ms
     → expected { ok: true } to deeply equal { ok: false, …(1) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.gate.test.ts > evaluateResumeEligibility > refuses when owner-transfer eligibleForContinuation is missing entirely
AssertionError: expected { ok: true } to deeply equal { ok: false, …(1) }

- Expected
+ Received

  Object {
-   "ok": false,
-   "reason": "owner-transfer is not eligible for continuation",
+   "ok": true,
  }

 ❯ tests/controller/resumeLoop.gate.test.ts:212:46
    210|     const input = baseInput();
    211|     delete (input.ownerTransfer as unknown as { eligibleForContinuatio…
    212|     expect(evaluateResumeEligibility(input)).toEqual({
       |                                              ^
    213|       ok: false,
    214|       reason: "owner-transfer is not eligible for continuation",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  15:31:12
   Duration  332ms (transform 90ms, setup 0ms, collect 116ms, tests 5ms, environment 0ms, prepare 39ms)

POST_EXIT=1
===== [M1b] REVERT
REVERT_COPY_EXIT=0
64c2db1873ccada54d721bf9bec985495fd3a3f2  /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/acb4a867-d584-4b3c-bcd0-ee701aad9288/scratchpad/resumeLoop.ts.pristine
64c2db1873ccada54d721bf9bec985495fd3a3f2  /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a/src/controller/resumeLoop.ts
POST_REVERT_DIFF_EXIT=0
8
COUNT_GUARD_EXIT=0
```

---

## 7. Step 7 / Step 8 — 计数守卫、全套件、typecheck、build（未过滤）

### 7.1 `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`

```

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 434ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 143ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 7ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 26ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/fileStore.test.ts (68 tests) 1746ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1368ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 31ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/registry/observeRun.test.ts (4 tests) 5ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-gq3VeB/does-not-exist'

 ✓ tests/controller/resumeLoop.integration.test.ts (11 tests) 2300ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 350ms
   ✓ resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL 313ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 17ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-r4ghOj/run-1  observed 2026-08-02T07:38:29.154Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/cli/cli.test.ts (15 tests) 433ms
   ✓ parseArgs > returns 0 for the scripted example run 309ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 258ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 2935ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 345ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 356ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 383ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 365ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 359ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 415ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2446ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 623ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 562ms
   ✓ render-contract CLI > rejects a non-git repository path 616ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 637ms
 ✓ tests/validation/fixture.test.ts (2 tests) 547ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 545ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6477ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 566ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 542ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 638ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 469ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 373ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 382ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 388ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 378ms
 ✓ tests/controller/runLoop.integration.test.ts (51 tests) 10254ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 313ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 897ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 11012ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 688ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 1155ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 1089ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 372ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 350ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 355ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 357ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 347ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 348ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 366ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 363ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 356ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 356ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 347ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 512ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 382ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when execute is interrupted 392ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 495ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 503ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 375ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 522ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 378ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15623ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1386ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1148ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2479ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1537ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1528ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1534ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 593ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 581ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 584ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 996ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 566ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2495ms

 Test Files  29 passed (29)
      Tests  473 passed (473)
   Start at  15:38:26
   Duration  16.23s (transform 2.06s, setup 0ms, collect 3.31s, tests 54.73s, environment 3ms, prepare 1.63s)

TEST_EXIT=0
```

`Test Files  29 passed (29)` / `Tests  473 passed (473)`，**TEST_EXIT=0**。
473 = 交办说明给的基线 463 + 本任务新增 10 条（新增条数可由上面这次输出自身重推：本文件 `27 tests` − HEAD 时的 17 条 = 10）。
两条允许 flake **本次都没有出现**（`tests/validation/evidence.test.ts` 与 `tests/controller/runLoop.integration.test.ts` 两个文件在上面输出里都是 `✓`）。名单外也没有任何失败。

### 7.2 `npm run typecheck` / `npm run build` / 计数守卫 / 工作区状态

```

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

计数守卫与工作区（**提交之后**重跑的一次）：

```
 M .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md
status_exit=0
src_diff_vs_HEAD_exit=0
 tests/controller/resumeLoop.gate.test.ts | 161 +++++++++++++++++++++++++++++++
 1 file changed, 161 insertions(+)
range_diff_exit=0
```

`grep -cF 'return { ok: false' src/controller/resumeLoop.ts` = **8**（§1 与 §7.2 两次执行都打印 8，十次变异实验的收尾各打印一次 8）；`git status --short` 里**没有任何 `src/` 条目**（唯一那条 `progress.md` 在我开工前的 HEAD 就已是 modified 状态，不是我改的）；`git diff HEAD --stat -- src` 空；`git diff 448e575..HEAD --stat` 只有 `tests/controller/resumeLoop.gate.test.ts | 161 +++…`，即**从 A5 的 HEAD 到本任务提交，`src/` 一个字节没变**。

---

## 8. 文件改动

| 文件 | 改动 |
|---|---|
| `tests/controller/resumeLoop.gate.test.ts` | +161 行：`doubleTransferInput()` 一个构造函数 + 10 条新测试 + 说明性注释。既有 17 条测试与 `baseInput()` 未改。 |

`src/` 零改动。`src/registry/` 零接触。没有导出任何新符号，没有加函数体哈希守卫（§15 验收 5 已裁定撤销它）。

提交：

```
64171bf test(resumeLoop): give each of the eight eligibility criteria its own killing mutation
```

（Step 9 指定的 `git add tests/controller/resumeLoop.gate.test.ts` 与该 message 原样执行；仓库约定的 `Co-Authored-By` 尾注按 CLAUDE.md 附上。）

---

## 9. 自评（第二遍、冷眼重读之后）

- **每条新断言都能失败吗？** 能。十条全部是 `toEqual({ ok: false, reason: <逐字> })`，reason 字符串改一个字节就红；十次变异实验各自把对应那条变红，这本身就是「能失败」的实证。没有一条是恒真断言。
- **有没有击杀被记到错的判据头上？** 没有。十份红块的 `Received` 全部是 `{ "ok": true }`——若归属错了，`Received` 会是另一条判据的 reason 而不是 `ok:true`。
- **`src/` 干净吗？** 干净。每次实验尾部都有 `shasum` 双边一致 + `git diff --stat` 空 + 计数守卫 8；收尾又独立核了一次（§7.2）。
- **每个证据块都完整、都带退出码吗？** 我回头逐块扫过：本报告**没有任何一处由我做的省略**（红块里 vitest 自己打印的 `…(1)` 与源码行尾的单字符省略号是 vitest 输出的原样内容，不是我删的；`git diff` 的 `@@ -39,9 +39,6 @@` 是 hunk 头）；每一条命令都紧跟自己的退出码（`PRE_EXIT` / `POST_EXIT` / `STEP5_EXIT_n` / `TEST_EXIT` / `typecheck_exit` / `build_exit` / `sed_exit` / `count_guard_exit` / `status_exit` / `SCRIPT_EXIT`）；每一个数字（8、473、29、161、10）旁边都有产生它的那条命令的**本次执行**输出，没有一处是引用交办说明或计划里的旧值。
- **有没有把多个实验塌缩成一次跑？** 没有。十次变异实验各自是独立的一次注入 + 两次单跑；§3 那十次绿跑是**另外**十次执行，没有拿注入前那十次充数。
- **有没有偷偷沿用弱断言形状？** 没有，见 §2.1；这是本任务我唯一一处主动没跟随邻近既有代码风格的地方，理由已写明。

## 10. 关切 / 留给评审员的点

1. **第 6 条我配了两个变异**（M6a 删除 + M6b `<`），理由见 §1 末段。若评审认为 Step 2 的第 6 条测试与 Step 4 的第三组 fixture 测试应当合并成一条、只保留 `<` 变异，那就是「九次实验、18 份输出」的读法；我选了覆盖更全的那个读法，代价是多一条测试与多一次实验。**这是解读，不是实测结论，请核。**
2. **`-t` 的 `>` 形状是一个静默假绿源**（§3）。本任务已绕开，但计划 §10 通用条里的判据命令若被后续任务照字面抄，会把「17 skipped / exit 0」当成绿。**建议就地更正为空格拼接形式**——这超出本任务改动面（我未改计划文件），交由评审/控制方决定。
3. **计数守卫的已知误红形状**（brief 已记录）：`grep -cF 'return { ok: false'` 依赖那八行各自在同一行写完，一次 `prettier` 换行会掉到 7。本任务未触碰它，只是照跑。
4. **新旧测试有语义重叠**：既有的 `refuses when owner-transfer is not eligible` / `refuses a superseded eligibility (owner epoch newer than the transfer) …` 等与新增几条覆盖同一判据，只是断言强度不同（`.ok` vs 逐字 reason）。按 Rule 3（外科手术式改动）我**没有删改既有测试**。若评审希望收敛，可另起一次清理把弱断言那几条替换掉——但那会动到不属于本任务的行。
