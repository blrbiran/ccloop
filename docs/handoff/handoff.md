# ccloop Handoff — 相位计时分支**已做完、未合并**；合并后才是 L3

> 更新于 2026-08-01。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> **本文不写死 commit hash、提交笔数或 HEAD**：提交本文即会改变 HEAD、push 会改变待推笔数。历史 commit hash（如 `07180a7`、各修复波的 hash）是**已固定的过去锚点**，可以引用；**当前状态一律用命令自查**，见「如何定位当前状态」。

## Executive Summary（下一位 agent 从这 8 行开始）

1. **不要直接开 L3。** 分支 `probe/perf-now-phase-timing`（worktree `.claude/worktrees/perfnow-probe`）**已做完、全绿，但未 push、未合并**——只等人拍板。
2. **它做了什么**：`runPhaseWithTimeout` 的超时按**已发放配额**计账，把「预算是否耗尽」从墙钟测量变成超时触发的后果。
3. **接手第一步**：`cd` 进那个 worktree，跑「如何定位当前状态」里的命令，以输出为准，**不要相信本文任何数字**。
4. **唯一剩余动作是人的**：push / merge。合并之后，下一步才是 L3（**必须先 brainstorm 出 spec**），再 L5。
5. ⚠️ **`main` 上的这份 handoff 是旧版**，指向 L3、没有本分支。从 `main` 起步的人看不见这支分支——**合并即解决**。
6. **「为什么长这样」读 `.superpowers/sdd/2026-07-31-phase-timing-quota/progress.md`**（本分支自己的 ledger）。**别读债 4 那份**，它不含本分支任何内容。
7. **跑全套件时只有 flake (B) 与 (F) 允许出现**；其余任何失败按新缺陷处理，必须捕获完整测试名与失败块再比对。
8. **三条铁律**：验证跑绝不过滤输出（`tail` / `grep` 同罪）；计划不附完整可抄代码；评审必须对着代码撞、不接受实施者自证。**本轮五波修复五波带缺陷，没有一波是实施者自己发现的。**

## ⚠️ 先读这一节：分支已完成但未合并，不要直接开 L3

分支 `probe/perf-now-phase-timing`（worktree 在 `.claude/worktrees/perfnow-probe`，有自己的真实 `node_modules`，**不是软链**——软链曾是一次无法解释的失败的领先嫌疑）。**未 push、未合并。**

**状态：交接清单上的四件已全部做完（2026-08-01），套件 / typecheck / build 全绿。剩下的唯一动作是人决定 push / merge。**

**定位它，不要照抄任何 hash：**

```bash
git branch --list                                   # 应能看到 probe/perf-now-phase-timing
git worktree list                                   # 应能看到 perfnow-probe
git log --oneline main..probe/perf-now-phase-timing # 分支上的提交，以输出为准
cd .claude/worktrees/perfnow-probe && ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run   # 期望 29 files / 446 tests
```

**已完成且已被独立评审复现的**（不是采信实施者）：

`runPhaseWithTimeout` 的三个超时返回点按**已发放配额**计账（`Math.max(elapsedMs, timeoutMs)`），把「预算是否耗尽」从墙钟测量变成超时触发的后果。三条守护测试，**逐条变异证明各钉各的返回点**：两条都退回 → `2 failed`；只退回 resolve → `1 failed`；只退回 reject → `1 failed`；文件还原后 sha256 逐字节一致。446 tests / typecheck / build 全绿。详见遗留事项 2 (E) 第 4 条。

**未完成——必须先做完这四件，再开 L3：**

1. ✅ **修复波 2 已于 2026-08-01 做完**（六条，第三轮评审五条 + 复核时撞出的第六条，全部是实施者自己带进去的）。留档：
   - 「the three `persistTerminalState` call sites」是**指错的符号锚点**——该符号在 `runLoop.ts` 有 **15** 个调用点，按原意（丢租约后仍写终态）收窄是 **4** 个，`three` 两头都不对。已改成 `if (leaseLoss.lost !== null)` / `if (isLeaseStopError(error))` 两个可 grep 的分支锚点，spec 与同名 plan 各一处。**错的符号锚点比陈旧行号更糟，因为它看起来是永久的。**
   - **引用清扫不完整，而 `9e554ce` 的提交信息声称「十处全部改完」**。已按「在 merge-base `07180a7` 上本来是否有效」逐条判定 `docs/` + `src/` + `tests/` 范围内全部 44 条 tracked 引用：**15 条**在分支起点有效、被本分支顶掉 → 已改成符号锚点；**2 条**位移为 0 未被顶掉；**27 条**在分支起点就已经错（L1/L1b/L2 时期漂移，动它们违反 Rule 3）→ **未动**，判定依据见修复波 2 的报告。
     **范围声明（修复波 3 补，此前从未写出来，而结论却被说成对「tracked」穷尽）**：`.superpowers/sdd/` 里另有 **23 条** `runLoop.ts:NNN` 引用，git 确实 track 它们（ledger 用 `git add -f` 入库）。**它们按不可改写的历史过程记录处理，刻意一条未动**——与下方第 8 项对 `9e554ce` 提交信息的处理同一立场：就地勘误，不改原件。修复波 3 已逐条回 `07180a7` 复核这 23 条（另有 2 处裸续接 `:1066` `:1098` 不计入 23）：**10 条 + 那 2 处裸续接 = 12 处**在分支起点有效且被本分支顶掉——`owner-transfer-contention/final-fix-wave-report.md` 的 `:910`、同目录 `progress.md` 的 `:774` `:788` `:1049`、`atomic-write-paths/progress.md` 的 `:821` `:862` `:864`×2 `:865`×2 与那 2 处裸续接；另有 **1 条**在分支起点有效**且位移为 0、至今仍有效**（`owner-transfer-contention/final-fix-wave-report.md` 的 `runLoop.ts:80-81`，该处 80–81 行在 `07180a7` 与 HEAD 上逐字相同）；其余 **12 条**在分支起点就已经错。10 + 2 + 1 + 12 = 23 + 2 处裸续接，与上面那条 `git grep` 对得上。**所以「全部 44 条」是 `docs/`+`src/`+`tests/` 范围内的穷尽，不是仓库范围内的穷尽。**
     ⚠️ **修复波 3 在这里塌了一个桶**：`docs/`+`src/`+`tests/` 的分类是**三桶**（顶掉 / 位移为 0 未顶掉 / 起点即错），而 `.superpowers/` 的分类只写了两桶，第三桶唯一的成员被误记进「起点即错」，把 12 写成了 13。**分类维度一旦在一个范围里立好，换个范围也要原样带过去。**

     ```bash
     git grep -o -E 'runLoop\.ts:[0-9]+' -- '.superpowers/sdd/' | wc -l   # 期望 23
     ```

     **注意 44 是「引用」数、不是 grep 出现次数**：同一条命令改指 `docs src tests`，在 `07180a7` 上数出 53、在本分支 HEAD 上数出 29（一条 `:864-866` 或一串裸续接算一条引用、多次出现）。修复波 3 复核的是 `.superpowers/` 那 23 条，**没有重数 44 / 15 / 2 / 27**——要用这四个数先自己重数。
   - `runLoop.ts` 超时分支注释里「本文件测试套大多是这么配置的」是没核的数量声明，实测 **10/49 ≈ 20%**（复现了评审员的数）。已改成「少数」并附再推导命令。
   - 「没有任何测试在任一方向钉住 `failureBoundary`」**为假**——`runLoop.integration.test.ts` 在 `07180a7` 上就有一条断言 `runtime_exhausted`。已改成「没有测试把它钉为配额下限的后果」。**注意该句不在 `runLoop.ts` 的注释里**（评审员写成「同一注释」），实际在 `runLoop.integration.test.ts` 的测试上方注释里。
   - `run-registry-design.md` 那处 perl 替换留下的重复短语（"after the lease gate" 说了两遍）已去重。
   - `9e554ce` 提交信息里的位移算术错误，已在下方遗留事项 8 就地更正。
2. ✅ **再评审已做，而且做了三轮，每一轮都抓到东西**（2026-08-01）。**本轮最硬的事实：五波修复，五波各自带缺陷，没有一波是实施者自己发现的。**
   - 修复波 2 → 第四轮评审：2 Important（位移表差 5；扫描范围被静默收窄）
   - 修复波 3 → 第五轮评审：1 Important（`.superpowers/` 的归属分类从三桶塌成两桶，12 被写成 13）+ 4 Minor
   - 修复波 4（**控制器本人实施**）→ 第六轮评审：1 Important（论证「锚点必须唯一」的那句话自己把 2 写成了 1）+ 1 Minor（附的重推命令在本仓库报错退出 2，`grep` 被改写成正则引擎、末尾 `(` 是未闭合分组，必须 `-F`）
   - 修复波 5 修掉上面两条，人明确裁定不再评审第七轮。**它只改了两句 markdown，两个新数字与那条 `grep -nF` 都当场跑过并贴了输出——但按本轮的记录，这不构成「它没有缺陷」的证据，只构成「没人去找」。**
3. ✅ **那条名单外的失败已定性**（2026-08-01），进 flake 名单 **(F)**，详见遗留事项 2。
   结论：**不是本分支引入的回归**——`main` 上全套件 1/100 复现，本分支 0/100，双臂隔离跑各 0/200。
   **两个不能顺手下的结论都写在 (F) 里**：不能说本分支修好了它（0/100 vs 1/100 分辨不出）；不能把它归进 (A) 的刀尖家族（它用默认 5000ms 预算，且负载方向相反）。
   **过程本身有个教训**：交接文件当初给的配方是「双臂各 50–100 次**隔离**跑」，照做（各 200 次）之后**双臂全 0**——隔离把并行负载拿掉了，而这条失败只在负载下出现。**那个配方对这条失败是错的条件，是它自己证伪了自己。** 真正定性靠的是全套件重复跑。
4. push 与 merge 都只在人明确下指令时执行。**本分支至今未 push、未合并。**
   ⚠️ **未合并带来一个真实的误导面**：`main` 上的 `docs/handoff/handoff.md` 仍是**指向 L3 的旧版**，没有本节。任何从 `main` 起步的接手者会读到「下一步是 L3」，读不到本分支存在。**合并即解决；在那之前，别假设别人看得见这一节。**

**所以现在真正剩下的只有一件**：由人决定是否 push / merge。**四件已全部做完，L3 在那之后。**

## 快速接手入口

1. **L1 / L1b / L2 / 债 4 都已在 `main` 上**（run lease + heartbeat / owner-transfer contention / run registry / 消除 fileStore 非原子写）。**443 tests 全绿，typecheck 与 build 干净**（这是 `main` 上的数；相位计时分支未合并前为 446 —— 以命令输出为准）。
2. **四笔遗留债的归属已由人裁决完毕**，见 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`。裁决同时回答了「下一层做什么」：**先做债 4（已完成），再做 L3，最后 L5**。
3. **债 4 已关闭并合并。** 五个任务，每任务一次独立评审，另加整分支评审 + 一轮修复波 + 一次 scoped 再评审，全程 0 Critical。**不要重做，也不要以为它还在分支上——worktree 与分支都已清理。**
4. **下一步是 L3，然后 L5。顺序不可打乱。** **L3 必须先 brainstorm 出 spec，不要拿债 4 的计划改**——两者问题域不同（债 4 只改「怎么写」，L3 要处理「何时写 / 写不写」与跨文件事务性）。
5. **「为什么长这样」先读 ledger——但要读对那一份。**
   **本分支（相位计时）的是 `.superpowers/sdd/2026-07-31-phase-timing-quota/progress.md`**（2026-08-01 补建）。此前有人把接手者指向下面那份债 4 的 ledger 说「本分支的来龙去脉在里面」，**那是假的**：那份通篇是债 4 的，grep 不到本分支任何内容。
   **债 4 的**是 `.superpowers/sdd/2026-07-29-atomic-write-paths/progress.md`——全部裁决、四条计划缺陷、两条 spec 缺陷、每一轮评审与修复都在里面。**不要重新推理。** 它已用 `git add -f` 入库。
6. **常驻禁令**：L1 spec §12 十九条中的第 2/5/7/15/17/19 条不得弱化或删除（已变异验证，人下过指令）。
7. 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`；**真实 Claude 调用须事先获批（付费）**。
8. **已知 flake（2026-07-31 两次更正后）**：`BUDGET_EXHAUSTED_REASON` 家族 4 条**已修**；剩 1 条已观测（`evidence.test.ts`）+ 2 条已具名但**从未观测到失败**（第五个家族成员、L1 交错测试）。详见遗留事项 2。
   **两次更正都值得知道**：旧版「7 个」是错的（一条被数了两次、一条分类为假、一条从未具名）；而更正后的版本**仍然带着一条被实测证伪的修法**——「只抬 `perAttemptTimeoutMs`」是空操作。**别拿这份清单挥手放过没核过的失败，也别照抄没跑过的修法。**
   **2026-08-01 再增一条 (F)**：`continues normally when execute returns a complete result during the recovery window`，已定性、已具名、已带样本数。**现在「允许出现」的是 (B) 与 (F) 两条，不再是一条。**
9. **验证跑绝不要 `| tail -N`**；**计划不要附完整可抄代码**；**评审必须对着代码撞、不接受实施者自证**。三条铁律，全部有案底。
   **「绝不 `| tail -N`」包括 `| grep`。** 2026-08-01 控制器自己在验证跑上用 `grep` 过滤了套件输出，还把退出码吞成空值，当场自曝并重跑。**任何对验证输出的过滤都是同一类违规，不只是 `tail`。**
10. **五波修复，五波各自带缺陷，没有一波是实施者自己发现的**（2026-08-01 的记录，含控制器亲自实施的那两波）。**「修复之后必须再评审」不是流程洁癖，是本仓库六轮以来 100% 命中的经验规律。** 唯一有结构性作用的对策是下面第 8 项立的那条：**每一个算出来的数字旁边，就地附一条能重推它的命令**——本轮唯一没出错的数字，就是唯一附了重推命令的那个。

## 如何定位当前状态（不要照抄 commit hash）

```bash
cd /Users/biran/code/skills/loop/ccloop
git status --branch --short               # 主仓库应为 main，干净
git worktree list                         # 应看到主仓库 + .claude/worktrees/perfnow-probe
git branch --list                         # 应看到 main + probe/perf-now-phase-timing（+ backup/… 备份分支）
git log --oneline main..probe/perf-now-phase-timing   # 分支上的提交，以输出为准，不要照抄任何笔数
git rev-list --count origin/main..main    # main 待 push 笔数，以此为准

# 分支的验证跑必须在它自己的 worktree 里（它有自己的真实 node_modules）
cd .claude/worktrees/perfnow-probe
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run     # 分支上期望 29 files / 446 tests
npm run typecheck && npm run build                     # 均应退出 0
```

`main` 上期望 29 files / **443 tests**（分支的三条守护测试尚未并入）。

**核对状态时不要相信本文的数字，相信命令的输出。** 本项目已有多次「文档里的数字被自己的编辑证伪」的案底，见下方教训——**其中一次就是这个代码块自己**：它一度写着「期望只有主仓库 / 只有 main」，而当时 worktree 与分支都还在。

## 债务归属裁决（已完成，不要重开）

裁决记录：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`（含评审修正痕迹）

| 债 | 去向 | 一句话 |
|---|---|---|
| 1 跨文件事务性 | **L3**（spec 内独立一节，先于触发逻辑） | handoff 旧版说「reconciliation 合成责任无人认领」——**那是错的**，见下 |
| 2 `persistTerminalState` 往已不拥有的 run 写 | **L5** | 修它就造孤儿，孤儿是 L5 的定义域；**在 L5 之前修是净损失** |
| 3 `heartbeat.stop()` 释放窗口 | **L3**（spec 必须显式表态，不得沉默继承） | L3 是让它可达的那一层 |
| 4 非原子写 | **现在就修**（= 当前分支） | 机械、低风险、不依赖任何未来层 |

**执行顺序不可打乱**：债 4 分支 → L3 → L5。理由：债 4 与债 1 在 `reconciliation-record.json` 上重叠，并行会互相覆盖。

**债 1 的旧描述是错的，这点很重要**：`persistOwnerTransfer` 与 `writeBoundaryArtifacts` 各自只有**一个**生产调用点，在同一函数相隔几行——生产者从未真空。真实缺陷是 `owner-transfer.json` 已原子发布、而 reconciliation 要等一个**会抛的 `assertHeld()`** 之后才写，第三方在此窗口 supersede 就留下 eligible 但无 reconciliation 的磁盘状态，`resumeLoop` 随即 ENOENT。**是 liveness 洞，不是安全洞**（fail-closed，deny-by-default 未削弱）。

**L5 的继承清单因此从 4 笔降到 1 笔**（只剩债 2）。

## 债 4：已完成并合入 `main`（保留下来是为了「为什么长这样」，不是待办）

**范围（全部落地）**：五处裸 `writeFile` 改 temp+rename——`loop-state.json` 的**两个**写者（`initializeRunFiles`、`writeRunState`）、首次 `owner-record.json`、`boundary-analysis.json`、`reconciliation-record.json`。外加标记一个导出的非原子 transfer 写入口（`writeOwnerTransferRecord`，**刻意保持非原子**），以及更正 L2 的三处注释（**`atomic: false` 保留为纵深防御，`src/registry/` 零逻辑改动，全分支 diff 在该目录内只有注释行**）。

**验收（整分支评审自己跑出来的，不是采信报告）**：443 tests / 29 files 全绿，typecheck 与 build 退出 0；转移事务路径四个符号 + 8 个常量对 `ee001ba` **逐字节相同**；`src/registry/` 零逻辑改动。

⚠️ **行号已全面失效，别照 spec / 计划里的行号动手。** Task 1 在 `:379` 之前插入了约 67 行，spec 的 `:76` 现在指向 `loop-contract.json`（**本设计排除的文件**），`:379-381` 落进了新增的辅助块。**锚点一律用函数名 + 文件名字符串，动手前先 grep。** spec §2.1 已加警告横幅。

**两条最值钱的发现，都来自「任务级评审看不见」的层面：**

1. **整分支评审发现本分支自己声明的核心风险裸奔上线。** spec §4.1 说进程唯一临时名是「本设计的核心风险」——共享固定临时名会**反过来制造**新的撕裂源（A 暂存 → B 覆盖 → A rename 发布了 B 的字节 → B 拿 ENOENT）。三条钉唯一性的测试全都**直接调用**导出的 `buildAtomicTempPath`，**没有一条观察生产路径实际用的临时名**。把 `:420` 换成固定名，**整套件全绿 441/441，两次**。生成器有覆盖，接线没有。已在修复波补上，并由发现它的同一个评审员用自己的变异复验杀掉（2 failed）。
2. **本分支证伪了 L2 的设计 spec，然后让一条新注释指向了它。** `2026-07-28-run-registry-design.md` §8.1 的逐写者表格仍断言 `writeRunState` / `writeOwnerRecord` 是裸 `writeFile`、"Atomic? no"。已按该文档既有的 `*Amended (x)*` 约定注解，**31 行插入、0 行删除**——注解而非改写。**`(j)` 是该文档第一条起因于「后续分支改了代码」而非「文档本身有缺陷」的条目；L3 若再证伪什么，接着写 `(k)`，就地注解。**

**spec 在执行过程中被实测改了三次**，全部保留痕迹：§7.1a 从无到有（创建型写入 inode 判据**不适用**，改用悬挂符号链接判据）→ 拆开两个前提不同的创建型写者 → 分类维度从「创建 vs 覆写」改成「**守卫是否拒绝预先存在的目标**」，并给出三档表。**两个判据互补不冗余，已实测：分流实现只在 inode 判据下死，只改创建路径的实现只在符号链接判据下死。**

## 遗留事项

1. **push** —— 用上面的命令看实际待 push 的是哪几笔，**不要假设数量，也不要照抄本文**。push 由人执行、人决定。
   - 早前记录的「`origin/main` 无人 push 却自动前进」**已澄清：是人自己 push 的，不是环境异常**。原遗留事项 10 撤销。
   - 本次会话结束时 `main` 上有若干笔未 push；人已手动 push 过一次，之后又新增了 flake 相关的合并。**以命令输出为准。**
2. **已知 flake 债（刻意未修）。** 当前名单是 (A) / (A′) / (B) / (C) / (D) / (F) 六个条目，**各自的状态与允许出现与否逐条写在下面，不要只看这一行的汇总**——本清单被自己的汇总数字骗过一次了。跑全套件时**只有 (B) 与 (F) 允许出现**。

   > ⚠️ **本清单在 2026-07-31 被更正过一次，因为它自己犯了它要防的错。** 旧版声称「7 个」并附「具名清单」，实际是：**一条被数了两次**，**一条的分类是假的**，**一条从未具名**。更正依据全部来自读代码，不是推理。**下面每一条都能自己核。**

   **(A) `BUDGET_EXHAUSTED_REASON` 家族——已修，4 条。** 全在 `tests/controller/runLoop.integration.test.ts`，**对着测试名比对，不要用行号**：

   - writes stale reconciliation conflicting evidence when execute aborts after changing files
   - persists owner transfer artifacts and continuation eligibility after a controller-owned OWNER_LOST takeover-allowed verdict without resuming execution
   - records retained cleanupStatus in execution recovery when cleanup fails
   - treats execute timeout with no adapter result as exhausted even if files changed in the worktree

   ⚠️ **这份 handoff 之前给的修法（「只抬 `perAttemptTimeoutMs`，保持 `totalRuntimeBudgetMs: 20`」）是个空操作，已由实施者与评审员各自实测证伪。** `getPhaseTimeoutMs`（`src/controller/runLoop.ts:388-390`）是 `Math.min(perAttemptTimeoutMs, timeRemainingMs)`，而 `timeRemainingMs` 从预算起步、只减不增——**`min()` 本来就选预算那一侧，抬另一个操作数不改变任何会被求值的表达式**。照做的人会得到一个全绿的套件和一个原封不动的 flake。
   实测：把 `perAttemptTimeoutMs` 抬到 1000 后跑 160 次隔离，`chosenTimeoutMs` **100% 仍是 20/19**，失败 12/160（未改动的基线是 15/160），且失败信息报的是 `"timeout of 20ms"` 而非 1000。

   **真实根因**：`setTimeout` 与 `elapsedMs`（由 `Date.now()` 算）读数相差 ≤1ms，而控制器又把这个 elapsed 记回**同一个**预算（`applyPhaseUsage`），于是 `hasBudgetExceeded` 的 `=== 0` 判定落在硬币两面。实测余量 **−1..+4ms**。
   **（注意：只验证到「差 ≤1ms」这个可观测量，没验证到成因。** 两次 1ms 精度的 `Date.now()` 截断能预测同样的现象。不要把成因写成已证实的。）

   **修法（已落地）**：两个旋钮**一个都不动**，改让四个 execute adapter 在 abort 后再工作约 10ms——依据是 `prompts.ts:46` 本来就承诺 adapter 一个 `partialOutcomeRecoveryWindowMs` 的 flush 窗口，而这些测试早已把它设为 10。余量结构性下限变成「该窗口减去 ≤1ms 偏移」≈ **9ms**，比 1ms 高一个数量级。

   ⚠️ **反直觉但已双方实测：负载让这些测试更安全，空闲才危险。** 拥塞会推迟定时器回调、抬高 `elapsedMs`，预算侧因此获胜——基线在 `2×ncpu` 负载下 0/100 失败，空闲下 15/160 失败。**所以全套件并行跑绿是弱证据；空闲机器上的单条隔离跑才是对抗条件。**

   **旧版把其中一条记成了独立的「第 7 个」，并写明「与家族无关」。那句话是假的**——该测试的断言就是 `toBe(BUDGET_EXHAUSTED_REASON)`，旋钮也双双钉在 20。当初那条分类是**照测试名判的，没读测试体**（名字讲 cleanupStatus，形状却属这个家族）。

   **(A′) 第五个家族成员——已具名、已测量，✅ 现已被「超时按配额计账」结构性修掉（2026-07-31）**。下面保留的是修复前的测量记录，**不再是当前状态**：该测试的 `perAttemptTimeoutMs: 1_000` / `totalRuntimeBudgetMs: 20` 使超时值取自预算，超时触发即确定性归零，亚毫秒余量不再参与判定。**它不该再被当作「从未观测到失败、任一失败都是首次观测」那一类**：
   `tests/controller/runLoop.integration.test.ts > caps phase timeout by the remaining runtime budget`。
   同一根因，且**它本来就处在上面那个空操作配方会产生的状态**（`perAttemptTimeoutMs: 1_000` + `totalRuntimeBudgetMs: 20`）。
   两次独立测量一致：200 次隔离跑 **0 失败**，但余量分布 `{0:1, 1:87, 2:87, 3:25}`——**约 0.5% 的跑距离变红只有 1ms**。从未观测到失败。
   **(A) 的修法对它不适用**：plan 阶段没有 `awaitAbortedResult`（`runLoop.ts` 的 plan 相位 `runPhaseWithTimeout` 调用点），abort 之后 adapter 做什么都不计入 `elapsedMs`，**没有测试侧的杠杆**。
   ⚠️ **本条此前推荐的解法（换 `performance.now()`）已被 2026-07-31 的测量降级为「有效但非根治」，并已被一个更彻底的修法取代（已落地，见下）。** 原文声称「单调、亚毫秒的时钟不可能相对于已触发的 `setTimeout` 读短，这会一次性拔掉整个家族的根因」——**前半句在真实路径上未被证伪、后半句是过度声称**：
   - 真实路径成对测量（N=200，隔离、空闲机）：`Date.now()` 余量分布 `{0:2, 1:133, 2:65}`；同一批事件用 `performance.now()` 读则 min **+0.3886ms**、mean +1.3317、max +2.4735，**两者都从未读到低于超时值**。两条 `date_margin==0` 的原始记录真实耗时是 20.485ms 与 20.869ms——**截断把真实存在的 0.485ms 与 0.869ms 余量（就这两个样本）抹成了 0**，这是 `Date.now()` 确实有害的地方。
   - 但换时钟后**最小余量仍只有 +0.39ms**，是更宽的余量而非结构性保证。另有合成探针（2×2000 次）显示：当 `:397` 的起始读数与定时器注册之间的间隙接近 0 时，定时器会**真的**提前触发，此时 `performance.now()` 读到低于超时值的频率**高于** `Date.now()`（113/2000、137/2000 对 28/2000、75/2000）。该模式在真实路径上 0/200 未出现，**但它换任何时钟都治不了**。
   - **`performance.now()` 全量替换后 200 次隔离跑 0 失败，与基线 0/200 无可辨差异**——pass/fail 在此样本量下无区分力，以上结论全部来自余量测量，不是来自跑绿。

   **(B) `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`**——全套件并行负载下 5000ms 超时，隔离连过两次。发现于债 4 基线跑，**当时源码零改动**。

   **(C) 仅理论，从未观测到失败**：`tests/controller/leaseHeartbeat.test.ts:661 > appends one lease_lost event when a guard concludes while an affirm is already in flight`。
   旧版只描述为「L1 留下的一个依赖真实文件系统计时的交错测试」，**没有名字**——而规则是「不在名单内的失败一律按新缺陷处理」，**一条没名字的成员根本没法比对**。
   已按代码定名：`:662` 是 `vi.useRealTimers()`，`:655-660` 的注释自述其排序依赖「roughly eight filesystem round trips against one」。**L1 ledger 把它记为「a theoretical flake risk under heavy CI I/O contention」——是风险登记，不是观测记录。** 保留这个区分：**它不构成把一次真实失败挥手放过的理由。**

   **(D) 三处带着同一赛跑、但当前没有任何断言看得见它**（`totalRuntimeBudgetMs: 20` 在该文件共 **14** 处——修复前为 11，本轮的三条守护测试各加一处；**这个数字每加一条测试就会腐坏，别照抄，用 `grep -c "totalRuntimeBudgetMs: 20," tests/controller/runLoop.integration.test.ts` 现数**）：`persists execution-recovery.json when execute is entered but returns no result before exhaustion`、`keeps changed-path stale reconciliation on OWNER_UNDECIDABLE…`、`writes an OWNER_LOST reconciliation record with transferred ownership…`。三条都不断言 `stopReason`，也不断言 `failureBoundary`（后者是预算派生的，会暴露赛跑）。~~**今天无害；谁给它们加一条 `stopReason` 或 `failureBoundary` 断言，它们当天就变 flaky。**~~ **这条警告自 2026-07-31 起为假，不要再照它行事。** 三条都设 `perAttemptTimeoutMs` 等于 `totalRuntimeBudgetMs`（皆为 20），超时值取自预算，「超时按配额计账」使其确定性归零——现在给它们加 `stopReason` 或 `failureBoundary` 断言会得到**稳定**的测试，不是 flaky 的。本轮新增的三条守护测试正是这么做的（其中一条就断言 `failureBoundary` 为 `runtime_exhausted`）。

   **(E) 修 (A) 时挂下的 4 条，已具名、已测量、刻意未做**（无第二轮修复波，全部带裁定记录在此）：
   1. `runLoop.integration.test.ts` 里那句「窗口设为 0 会让这些测试**重回刀尖**」**过度声称**。实测：窗口=0 时余量 +1..+4、160 次 **0 失败**；而真正的修复前状态是余量 −1..+4、**15/160 失败**（`delay(0)` 被 Node 钳到 1ms，仍买到一个定时器回合）。**警告本身该留**（约 9ms 的缓冲确实塌成约 1ms），但准确说法是「只剩约 1ms 余量，而非约 9ms」。
   2. 同一注释块有一处**折行错位**（`// contract that set the`），纯外观。
   3. 该注释承诺「区间都带样本数」，但**只有一台机器的带了**；且另一台标注的 `+10..+13` 在重测后扩为 `+10..+15`。
   4. ~~**根治办法仍未做**：把 `runPhaseWithTimeout` 的相位耗时从 `Date.now()` 换成 `performance.now()`。**它是唯一能真正消除 (A′) 与 (D) 的手段**~~ —— **已作废并已由另一修法取代（2026-07-31 落地）。** 「唯一手段」这句是错的：换时钟只是把余量从 0 放宽到约 +0.39ms，时钟仍在判定里。
      **实际落地的修法**：`runPhaseWithTimeout` 的超时分支按**已发放的配额**计账（`Math.max(elapsedMs, timeoutMs)`，三个返回点）。依据是 `getPhaseTimeoutMs` 本就是 `min(perAttemptTimeoutMs, timeRemainingMs)`——**当预算是较小的那个操作数，超时触发即意味着预算按定义已耗尽**，不该回头拿墙钟去重新推导。这样 `hasBudgetExceeded` 的 `timeRemainingMs === 0` 成为「超时触发」的后果，而不是「两次时钟读数恰好跨满整个窗口」的后果；当 `perAttemptTimeoutMs` 是较小操作数时下限低于剩余预算，**不会强制任何东西耗尽**。
      守护测试：`runLoop.integration.test.ts > accounts a budget-capped phase timeout as exhaustion even when the clock reports no elapsed time`，用 `vi.useFakeTimers({ toFake: ["Date"] })` 冻结 Date、保留真实定时器，把这个依赖从亚毫秒赛跑变成确定性判定。**退回裸 `elapsedMs` 该测试即红**（已实测：`Received: "plan phase exceeded per-attempt timeout of 20ms"`）。
      **仍未消除的部分，别当已解决**：上面那个「间隙≈0 时定时器真提前触发」的模式与本修法无关，本修法只覆盖**预算封顶**这一路径；`perAttemptTimeoutMs` 封顶的超时仍由时钟测量决定其计账值。

   **(F) 已观测、已定性、刻意未修（2026-08-01 新增）**：`tests/controller/runLoop.integration.test.ts > runLoop > continues normally when execute returns a complete result during the recovery window`。
   失败断言：`expected 'exhausted' to be 'succeeded'`（`finalState.status`）。

   **实测（双臂，本轮跑的）**：

   | 条件 | 本分支 | `main` |
   |---|---|---|
   | 全套件 | 0/100 | **1/100** |
   | 单条隔离跑 | 0/200 | 0/200 |

   **定了的**：**不是本分支引入的回归**——它在 `main` 上、本分支一行代码都没有的情况下复现。
   **不能说的两件**：
   - **不要说本分支修好了它。** 0/100 vs 1/100 分辨不出（Fisher p≈1）；把更早那次观测并进来，两臂各是 1/112，完全一样。
   - **不要把它归进 (A) 的刀尖家族**，尽管都出现 `exhausted` 一词。该测试**不设** `totalRuntimeBudgetMs: 20`，用的是 `createContract` 的默认 **5000ms**；它只覆写 `perAttemptTimeoutMs: 20` 与 `partialOutcomeRecoveryWindowMs: 30`。**负载方向也相反**：刀尖家族是空闲危险、负载安全，这条是隔离 200 次不失败、只在全套件负载下失败。**按签名词归族，就是重蹈本文件上面记的那次「照测试名判、没读测试体」。**

   **机制是假说，未证明，别写成已证实**：全套件并行争 CPU 时某相位的真实墙钟把累计用量顶过 5000ms 总预算，于是控制器**合法地**判定耗尽。只有一个失败样本，且未捕获 `budgetSnapshot`。要证它需要在失败时把 `timeRemainingMs` 与各相位用量落盘，再跑一轮全套件重复跑（约 30 分钟机器时间）。**在那之前，「为什么」是空的。**

   **给实施者与评审员**：跑全套件时，**只有 (B) 与 (F)** 可以出现且不构成新缺陷。**(A) 的四条已修——它们若再失败，是回归，按新缺陷处理。** **(A′) 与 (C) 从未被观测到失败：任一失败都是首次观测，必须立刻上报，不得挥手放过。**
   **「像是已知 flake」不等于「是已知 flake」**：必须先捕获**完整测试名与失败块**再比对，**绝不允许 `| tail -N` 后凭印象归因**——L1b 正是这样丢过一次失败身份。**任何不在名单内的失败一律按新缺陷处理。**
   **比对时对着上表的测试名，不要对着行号**——行号会腐坏，本项目已有六处自造的失效引用案底。
3. **L2 挂账 5 条 Minor**（可延后，见 L2 ledger）：`ObservedFileSpec.file` 未收窄成字面量联合；`scanRootFailureDetail` 落在 `renderRuns.ts` 名不副实；`DT_UNKNOWN` 回退无测试（**已如实记录而非写空壳测试充数**）；两条夹具注释瑕疵。
4. **`.superpowers/sdd/` 是跨会话共用的扁平目录**，且是 gitignored——提交自己子目录的 ledger 要用 `git add -f`。**刻意跳过** `review-*.diff` 与 briefs（都可重建）。同级目录属于更早的会话，**不要整删**。
5. **本分支范围外、但已查实、留给后续层的两笔**（都属 L3 / L5 的归属域）：
   - `finalizePendingOwnerTransfer` 自己的 catch 有与 D2 同型的潜在错误掩盖——两个 `safeUnlink` 都可能替换正在传播的错误。它在 spec §2.2 的不动范围内，本分支正确地未碰。**整分支评审复核后同意可以带着它合并**：修它需要动那个必须逐字节不变的保护区，而触发条件是「清理失败与转移失败同时发生」。
   - **【本轮实测新增】** `runLoop.ts` 里 `checkRunLease` 之上那段 `§7.0` 注释（`grep -n "ensureFreshRunDir" src/controller/runLoop.ts` 定位）断言了**两件已被实测证伪**的事：「`ensureFreshRunDir` 已经对任何既存 run 文件抛过了」和「此处只可能观测到『无 owner record』」。实测：`ensureFreshRunDir` 的 `blockingPaths` **不含** `owner-record.json`，且 `checkRunLease` 对空租约（`leaseGate.ts:38-42`）与**已过期**租约（`:44-64`）**都只返回、不拒绝**——所以一个只含 owner record 的 run 目录会以**覆写**形式到达 `writeOwnerRecord`（已实测：inode 发生变化）。
     **代码大概率是对的**（`leaseGate.ts` 说该状态按设计不表态），**错的是注释**。本分支正确地未碰（属归属域，动它违反 Rule 3）。**整分支评审的附加条件是：这条必须从 ledger 提升到 handoff，否则下一层只会读到那条假注释、读不到对它的证伪。此条即为履行该条件。**
     ✅ **已于 2026-07-31 修掉（注释改写，代码零改动）。** 两处断言由下一个接手者独立复核为假后才动手，不是采信本条。`blockingPaths` 实为 `loop-contract.json` / `loop-state.json` / `events.jsonl` 三项，外加非空的 `attempts/` 与 `worktrees/`。**本条自己那个失效的行号 `:864-866` 已于修复波 2 换成上面的符号锚点**（旧行号是这一整类腐坏的又一例，不是特例）。「inode 发生变化」那句是上一轮的测量，**本轮未复测**，按原样保留为上一轮的记录。
6. **一条随时可能被配置改动静默打破的依赖**：修复波新增的临时名接线测试依赖 vitest **文件内顺序执行**（`vitest.config.ts` 无 `sequence.concurrent`，该文件无 `it.concurrent`），否则模块级计数器会被竞争、临时名预测失效。**不是当前风险，但只隔着一个配置改动。** 若将来开启文件内并发，先看这条。
7. **硬编码数量与硬编码行号是同一类腐坏，但更隐蔽。** 本分支两次被自己的编辑证伪：一条注释写 `owner-record.json`「在**两条**路径上」发布（实为三条）；一条注释写「本文件 **51** 条测试全绿」，而同一波修复给该文件加了 2 条（实为 53）。**行号错了一 `sed` 就露馅，数量错了只有等人重新枚举才会浮出来。** 仓库里还有若干带实测数字的注释（`441/443`、`48/48`、40 次压测），~~**当前全部为真，无人强制**~~ —— **`441/443` 已于 2026-07-31 被本轮新增的三条测试证伪**（分母现为 446），已在 `fileStore.test.ts` 就地标注为历史测量而非实时计数；`48/48` 与 40 次压测本轮**未复核**，不要当作已核实。仍然无人强制——L3 若要动，先看这条。
8. **`9e554ce` 提交信息里的位移算术是错的，就地更正如下**（提交信息在历史里不可改写，不要 rebase / amend；这条是它的勘误）。原文写「+8 lines from the timeout branch, +19 from the lease-gate comment」。逐笔实测（`git diff -U0 <c>^ <c> -- src/controller/runLoop.ts | grep '^@@'`）：

   | commit | timeout 区（`runPhaseWithTimeout`） | lease-gate 区（`runLoop` 的 `checkRunLease` 之上） |
   |---|---|---|
   | `e33095b` | `@@ -421,0 +422,8 @@` → **+8** | — |
   | `a017689` | — | `@@ -872,3 +872,14 @@` → **+11** |
   | `ea271d6` | `@@ -427,3 +427,14 @@` → **+11** | `@@ -880,3 +891,11 @@` → **+8** |
   | `6b39697` | `@@ -431,2 +431,7 @@` → **+5** | — |
   | **合计** | **+24** | **+19** |

   前三笔早于 `9e554ce`，`6b39697` 是**修复波 2 自己的第三笔**（该波四笔依次为 `8fe6d40` → `2e30d1c` → `6b39697` → `4a4f2a0`）、晚于 `9e554ce`——它就是本表在修复波 2 里被写错的原因：表写在再下一笔 `4a4f2a0` 里，没把同波刚加的 5 行重新推进去。

   所以本分支相对 `07180a7` 对 `runLoop.ts` 的**净位移**（老行号 → 新行号）：**≤421 → +0**；**422–863 → +24**；**864–866** 被 `@@ -864,3 +888,22 @@` 整段替换、**无对应新行**；**≥867 → +43**（= 24 + 19）。文件长度 1364 → 1407，正是 +43。

   **这张表和上面这三段位移，会被后续任何一次 `runLoop.ts` 编辑作废。不要引用这里的数字，就地重推：**

   ```bash
   # 起点写死为 07180a7，不要用 $(git merge-base HEAD main)：本分支一旦并入 main，
   # merge-base 就变成 HEAD 自己，命令返回空——读者会读成「没有位移」而不是看到报错（违反 Rule 12）。
   git diff -U0 07180a7 HEAD -- src/controller/runLoop.ts | grep -E '^@@'
   ```

   原文的 `+8` 只算了 `e33095b`，漏掉实施者**自己后一笔** `ea271d6` 在同一区域加的 11 行；修复波 2 补上 `ea271d6` 后又漏掉**它自己的** `6b39697` 的 5 行。**同一个错误连犯两次，两次都是「写下数字，然后被同一波里更晚的编辑作废」。** 这条没有污染修复本身（那十处都转成了符号锚点，没有数字传播）。
   **规矩（修复波 3 立，不是例外）：文档里每一处算出来的行号 / 位移 / 计数，旁边必须就地附一条能重推它的命令。** 修复波 2 给 `runLoop.ts` 的注释配了重推命令，那几处就没错；唯独没给 handoff 自己的算术配，那处就错了。

## 本轮新增的教训（比缺陷本身更值钱）

- **不要相信别人写下的「已核实」。** 本轮四次同一动作：我 grep 漏了 `doMock` 就写「已核实」；实施者信了我的「已核实」导致论述越界；我照抄评审员一段错误算术；实施者把那段错误算术写进了提交的注释。**别人标注为已验证的主张，在你自己跑之前仍是未验证的。**
- **加一个成分和加它的覆盖是一件事，不是两件事。**（实施者原话）修复轮加固了 pid 断言，却在**同一次编辑**里给新字段引入 `\d+` 并写了声称覆盖它的测试名——**把自己刚修掉的缺陷以更窄的形式重新引入**。教训不是「测试名要对范围诚实」，而是「**名字里每一个分句都必须有一条能失败的断言**」。
- **修复波会自带缺陷**，本仓库已有案底。**修复之后必须再评审**，且再评审的重点是「这次修复引入了什么」，不是重做上一次评审。
- **证明一个跨模块断言不是同义反复，要做反方向变异**：只改 A 侧失败、只改 B 侧也失败 → 是真钉定；同义反复只会在两侧同步变动时才失败。
- **注释里的机制，写之前先跑一遍。**（实施者为自己立的规矩，值得推广）

## 债 4 后半程新增的教训

- **「引用前先核实」原本只覆盖了读，不覆盖写。** 本分支 6 处失效行号引用**全部是自己造成的**——实施者插入的行把它自己另外几条注释引用的行顶走了，两轮各中一次。**规则扩展：所有编辑落地之后，重新核一遍每一条行号引用。** 更进一步的建议（留给 L3 定）：本仓库的跨文件行号引用得不偿失，没有编译 / 测试 / lint 会检查它们，改用符号名与「文件头部」这类锚点不损失精度。
- **判据要按调用点逐个选，「创建 vs 覆写」是错误的分类轴。** 正确的维度是「**该写者前面是否有守卫拒绝预先存在的目标**」。踩这个坑的代价是真金白银：spec §7.1a 因此改了三次。
- **一条声明「覆盖边界」的注释本身就是一个必须为真、必须可查的主张。** 但它并不因此就是坏的——判据是：**这个边界是否可构造、是否有人跑过、以及它失效时会不会大声过期。** 本分支那条通过了全部三项（点名了一个可构造的变异类、评审员跑了、补上 inode 测试后那句话会明晃晃地显得陈旧）。
- **纯测试的修复有时才是正确形状。** 整分支评审最重的那条 finding 是**覆盖缺口而非行为缺陷**，生产代码本来就在用生成器——改 `src/` 才是错的响应。但**要让评审员来判这一点，不要自己假设**。
- **控制器也会是假主张的源头，而且已经两次。** 一次是 `vi.mock` 的假前提，一次是我让实施者写「它点名的每个文件现在都经 rename 写入」——那句对 `OBSERVED_FILES` 整体为假，`owner-transfer.json` 标着 `atomic: true` 且仍有非原子写者。**两次都是子代理抓住的。「不要接受、自己核」这条规矩对控制器下达的指令同样适用。**
- **修复波要一次派完，不要一个 finding 派一个。** 每个修复者都要重建上下文、重跑套件，上一轮分支的最终修复波因此比它全部任务加起来还贵。
- **提取器要能大声失败。** 两个评审员各自写函数体哈希比对时，朴素版本对 `acquireOwnerTransferLock` **静默地提取出 1 行函数体**——因为它的返回类型 `Promise<{ release: () => Promise<void> }>` 里带大括号。**带「函数体过短就报错」的防护栏两次把静默的假通过变成了被抓住的错误。**
- **定罪前先验明正身。** 评审员发现两处测试文件里的行号引用在 HEAD 上是错的，**没有直接算在本分支头上**，而是回到 merge-base 去查，证实它们在分支开始前就已经错了（L2 时期的漂移）。

## flake 修复轮新增的教训（2026-07-31）

- **配方要先跑一遍再写进文档。** handoff 上传了不知多少轮的「只抬 `perAttemptTimeoutMs`」是个**空操作**——`getPhaseTimeoutMs` 是 `min(perAttempt, timeRemaining)`，预算本来就是较小的那个。实施者**照做了一遍再证伪**（抬到 1000 后仍 12/160 失败、报的仍是 `20ms`），而不是读代码推理出来就交差。**照它做的人会得到一个全绿的套件和一个原封不动的 flake。**
- **一个区间的可信度不会超过它背后的抽样数。** 本轮同一个错误犯了三次、三个人各一次：实施者用约 12 个样本报了 `+12..+14`；评审员用 160 个样本报 `+10..+13` 并据此说对方「乐观 2ms」；重测后两者都扩了（`+11..+15` / `+10..+15`），**所谓的分歧其实是两边的边缘抽样不足，不是硬件差异。** 评审员主动把这一条算在自己头上，并顺带撤回了「偏移**恰好**被 1ms 界定」——那是拿 320 个样本的尾部说了一个界。**写区间必须带样本数；没带的一律当未定。**
- **反直觉且已双方实测：负载让计时测试更安全，空闲才危险。** 拥塞推迟定时器回调、抬高 elapsed。**所以「全套件并行跑绿」对这类问题是弱证据，空闲机器上的单条隔离跑才是对抗条件。**
- **改了 helper 的签名就等于改了代码，不是改注释。** 实施者在无人要求的情况下对改造后的 helper 重跑了变异，理由是「本仓库 ledger 记着修复波会自带缺陷」。**这条规矩现在是自发执行的了。**

## 相位计时轮新增的教训（2026-07-31，代价最高的一轮）

- **合成复现模型不忠实于调用点时，结论会整个反向。** 本轮先用一个合成探针测出「`performance.now()` 读到低于超时值的频率**高于** `Date.now()`」（113/2000、137/2000 对 28/2000、75/2000），据此一度判断换时钟「方向正好是反的」。**对真实路径而言那是错的**：探针的 operation 几乎立刻注册定时器，而真实路径在起始读数与注册之间有大量工作，那个模式根本不显现。真实路径成对测量给出相反结论。**教训：合成模型的每一个简化都可能是结论的开关，用它下判断前先问「真实调用点在这一点上和它一样吗」。**
- **「实验没有区分力」本身就是结果，必须如实报告，不能当成阴性结论。** 本轮两次踩到：`performance.now()` 全量替换后 200 次跑 0 失败、基线也 0 失败——**这不叫「修法无效」，叫这个观测量在此样本量下看不见差别**；名单外那条失败 base 0/12、分支 1/12 同理。**把「分辨不出」写成「没差别」是本项目最容易犯的谎。**
- **错的符号锚点比陈旧行号更糟。** 行号错了一 `sed` 就露馅；符号锚点错了**看起来是永久的**，读者 grep 不回原意还以为自己搞错了。改锚点时必须验证该符号存在、且**唯一**指向原意——本轮就写了一个指向 15 个调用点的「the three ... call sites」。
- **修行号引用的那笔提交，自己制造了新的失效行号引用。** 两次插入把同文件下方推移 +8 与 +19，打断的引用**实际是 10 处而非评审员报的 6 处**（另外 4 处是实施者自查补出来的）。**规则再扩展：改完之后不是「重核自己引用的行号」，而是全仓扫一遍指向被改文件的行号引用。**
- **「不接受实施者自证」这条规矩，对实施者自己也成立。** 本轮三条最重的 finding（只保护了三分之一、`failureBoundary` 静默变更、指错的符号锚点）**没有一条是实施者自己发现的**，全部来自对着代码撞的独立评审。

## 更早的教训（仍然有效）

- **计划风格**：接口签名 + 测试要求 + 陷阱清单，**不给完整实现**。四轮一致：给完整代码效率高但计划的疏漏原样落地；给要求则实施者会主动发现并上报计划缺陷（本轮 Task 1 一个实施者就报了 4 条）。
- **评审要对着代码撞**，且**明确要求评审员不接受实施者的自证**。四轮最值钱的发现全部来自这一条。
- **任务级评审有结构性盲区**：只看单任务 diff。跨任务的、以及「守护测试守护的到底是什么」，**只有整分支评审能看见**——上一轮最贵的缺陷正是它抓到的。**不要因为每任务都过了就跳过最终评审。**
- **写「证明某测试能失败」时，注入点必须在生产代码/生产类型上。** 往测试数组里注入只证明匹配器有效。
- **加 guard 或改读写路径前，先 grep 同一函数内该危险调用的全部出现位置。**

## 仍然生效的治理边界

- 每次真实 Claude 调用前须显式获批（付费）。
- 不覆盖已接受的 `review.json`；`D-01` 保持 `INCONCLUSIVE / CONTRACT_GAP`。
- `stale-confirmed` / `reconciliation-record.json` **本身不授权继续执行或接管**；auto-takeover 仍 deny-by-default。resume 只消费已发布 transfer。
- **L1 / L1b / L2 不引入任何新授权**，后续层不得削弱。**债 1 的修复明确禁止放松 `resumeLoop` 对 reconciliation 的必需性**——那是引入新授权。
- 不做 `git clean` / `reset --hard` / 广域 `restore`；不删 `.validation-runs/`、备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`、`stash@{0}` / `stash@{1}`。
- push 与 merge 是两件事，都只在人明确下指令时执行。

## 参考（按路径读，勿在此复制内容）

- **当前分支（相位计时，未合并）**：`.superpowers/sdd/2026-07-31-phase-timing-quota/progress.md` ——**它没有 spec / plan**，这支分支起于 flake 修复轮的一条评审建议，不是走 SDD 流程立项的。ledger 里记了配额计账的依据、位移表与重推命令、引用清扫的归属判据、flake (F) 的定性方法。
- **债 4（已合并）**：`docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md`、`docs/superpowers/plans/2026-07-29-atomic-write-paths.md`、`.superpowers/sdd/2026-07-29-atomic-write-paths/progress.md`
- **债务裁决**：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`
- **L2 / L1b / L1**：`docs/superpowers/specs/2026-07-2{8,7,6}-*-design.md` + 同名 plan + `.superpowers/sdd/2026-07-2{8,7,6}-*/`
- 父设计：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`（§17 后续 spec 清单——**item 2 的触发那一半与 item 3 的 L5 cleanup 都还没写**）
- 兄弟设计：`docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md`
- 外部参照：`reference/loop-engineering/tools/loop-worktree/README.md`、`reference/DoWhiz/DoWhiz_service/scheduler_module/`
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/buglog.json`、`.wolf/anatomy.md`

## 建议接手时调用的 skills

- `superpowers:finishing-a-development-branch` — **接手后的第一个动作**：相位计时分支已完成待整合，用它来走「怎么并」这一步。**但 push / merge 本身只在人明确下指令时执行**，不要自作主张。
- `superpowers:brainstorming` — **开 L3 的第一步**，在分支整合之后（债 4 已完成合并，不要拿它的计划改）。
- `superpowers:subagent-driven-development` — L3 有了 spec 与计划之后。
- `superpowers:finishing-a-development-branch` — L3 做完时。**注意一条已被实测证伪的旧建议**：`.claude/worktrees/` 下的 worktree 若是**上一个会话**用 EnterWorktree 建的，本会话的 `ExitWorktree` 是 **no-op**（它只管本会话建的），实际可用的是 `git worktree remove` —— 而且它**不动分支**，正好符合「删分支要单独授权」。
- **清理约定（债 4 已按此执行，可照做）**：`.superpowers/sdd/<plan>/` 里只有 `progress.md` 被 `git add -f` 入库，其余 brief / report / review diff 都可重建、不入库。**移除 worktree 会连带删掉那些未入库产物 —— 这正是清理方式；但主仓库那份 `progress.md` 是 tracked 文件，`rm -rf` 整个目录会误删它。**
- `superpowers:requesting-code-review` — 每任务一次 + 整分支一次，缺一不可；修复轮之后还要再评审一次。**债 4 的两条最贵发现都来自整分支那一次。**
- `superpowers:verification-before-completion` — 声称「通过/完成」前复跑 typecheck / build / 全套件并贴真实输出。
- `superpowers:writing-plans` — L3 brainstorming 出 spec 之后。注意计划风格教训。
- `superpowers:systematic-debugging` — 若遇到不在 flake 名单内的失败。**也建议用在遗留事项 2 的 (B)**（`evidence.test.ts` 那条，至今只有现象、没有 root cause）。
- ~~**L3 之外还有两笔独立的小活**~~ —— **两笔均已于 2026-07-31 在 L3 之前完成**：(1) 相位计时的根治改为「超时按已发放配额计账」，**不是**原先记的换 `performance.now()`（原方案经测量为有效但非根治，见遗留事项 2 (E) 第 4 条的更正）；(2) 那条被证伪的注释已改写，代码零改动。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
