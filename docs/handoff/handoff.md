# ccloop Handoff — L1 与 L1b 均已实现、评审通过、merge 进 main

> 更新于 2026-07-28。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> 本文不硬钉 git HEAD：提交本文即会改变 HEAD。用下面「如何定位当前状态」自查。

## 快速接手入口（10 行）

1. 前沿五层的 **L1（run lease + heartbeat）与 L1b（owner-transfer contention）都已完成并 merge 进 `main`**，373 tests 全绿，typecheck / build 干净，无遗留 worktree。
2. 下一步是 **L2（registry / queue）**，起点 skill 是 `superpowers:brainstorming`；`L5（cleanup / orphan GC）spec 至今未写`，且现在有两笔债指名要它接。
3. 「为什么代码长这样」先读 ledger：`.superpowers/sdd/2026-07-26-*/progress.md` 与 `.superpowers/sdd/2026-07-27-*/progress.md`，**不要重新推理**。
4. 两份 spec 都已被修订过（L1 四处 a–d，L1b 五处 a–e），**全部是文档缺陷不是实现缺陷**；顶部 Status 行有索引。
5. **常驻禁令**：L1 spec §12 十九条中的第 2/5/7/15/17/19 条不得弱化或删除（已变异验证，人下过指令）。
6. 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`；**真实 Claude 调用须事先获批（付费）**。
7. `main` 可能领先 `origin/main` 若干笔且**尚未 push**——push 由人决定，不要擅自执行。
8. 已知 flake 债 5 个测试，本轮**刻意未修**（修法见下），别当成新 bug 去查。
9. L2 的计划**不要附完整可抄代码**——两轮实践都证明那会关掉实施者判断力。
10. 验证跑**绝不要** `| tail -N`：失败块会被截断，测试名丢失，只剩不可证伪的归因。

## 如何定位当前状态（不要照抄 commit hash）

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --oneline --decorate -30
git status --branch --short
git log origin/main..HEAD --oneline   # 待 push 的全部提交，以此为准
git worktree list                     # 期望只有主工作区
```

所有 L1 / L1b 代码与测试都在 `main` 上，工作区干净，两个实现 worktree 均已清理完毕。

## 本轮（L1b）做了什么

**唯一真相源是 spec**：`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`
**实施计划**：`docs/superpowers/plans/2026-07-27-owner-transfer-contention.md`（5 个任务）
**执行 ledger + 6 份报告**：`.superpowers/sdd/2026-07-27-owner-transfer-contention/`（已提交）

解决的是 L1 交出的两个 tracked follow-up：

1. `fileStore` 把「锁忙」与「CAS 不匹配」混用一个错误类，导致合法 owner transfer 被静默丢弃。现已拆成**兄弟类** `OwnerTransferLockBusyError` / `OwnerTransferPreconditionError`，四个消费者逐一重判；只对锁忙做**有界重试**（3 次 / 50ms，最坏 100ms ≈ TTL 的 0.11%），CAS 不匹配**零重试**。
2. `persistBoundaryAnalysis` 完全没有租约 guard。现已加入口 guard（在 `readOwnerRecord` 之前，因为它会跑写盘的崩溃恢复）、catch 路径重读前的 guard、以及写 artifact 前的 guard。

此外新增 `LeaseHeartbeat.runExclusive`，把「读记录 → 评估 → CAS 转移 → adopt」整段放进心跳自身的串行队列，**由构造消除自我竞争**，同时把 L1 parked 的 adopt-vs-在飞-affirm 窗口关到零。

### L1b spec 已被修订五处

顶部 Status 行有索引，正文内联标注。五处**全部是文档缺陷**。要点（细节读 spec 本身）：

- **(a)** §2「不改终态」的论据是**反的**——调用点位于终态持久化之前，恰恰是它导致终态翻转。真正成立的只有「exit code 不变」（`src/cli.ts` 不把 run status 映射成进程退出码）。
- **(b)** §5.1/§5.4 指名的 `guardedWriteArtifacts` 从 `persistBoundaryAnalysis` **不可达**（它是 `runLoopFromState` 内的闭包）。
- **(c)** §5.4 的「No third guard」改写为它真正的意思：转移 CAS 不加 guard，但函数内**每个** `readOwnerRecord` 都要加。
- **(d)** §6 requirement 4 只要求了一个交错方向，导致它声称击杀的变异**在它自己的测试下存活**。已改为显式要求两个方向。
- **(e)** 记录新的落盘形态：完成的 `owner-transfer.json` **不再蕴含** `reconciliation-record.json`。

### 本轮两次人工裁决（后果已固化，勿推翻）

1. **`writeBoundaryArtifacts` 无条件 guard**。代价：被超越的进程不再合成赢家的 reconciliation 视图——旧行为里那是该文件的唯一来源。理由是本层的全部主张就是「只增加拒绝、绝不授权」，而被删掉的写入正是一个已失去所有权的进程往它不再拥有的 run 里写。**合成责任留给 L5。**
2. **给 catch 路径重读加第三个 guard**，并连带改 spec 措辞（见修订 (c)）。字面与意图冲突时改文档，不留缺口。

## 验证证据

| 项 | 结果 |
|---|---|
| `npm test -- --run` | 23 files / **373** tests 全过（L1b 起点 356） |
| `npm run typecheck` / `npm run build` | 均干净 |
| merge 后在 `main` 上复跑 | 同上，已独立验证 |

全流程**零付费 Claude 调用**（ScriptedAdapter + 手写 stub adapter）。

## 遗留事项

1. **push** —— `main` 可能领先 `origin/main`。用上面第三条命令看实际待 push 的是哪几笔，**不要假设数量**。push 由人决定。
2. **已知 flake 债（本轮刻意未修，不要当新 bug 查）**：
   - `tests/controller/runLoop.integration.test.ts` 的四个 `BUDGET_EXHAUSTED_REASON` 测试（约 `:1002 / :1258 / :1655 / :1773`），把 `perAttemptTimeoutMs` 与 `totalRuntimeBudgetMs` 都钉在 20ms 互相赛跑。**修法：只抬 `perAttemptTimeoutMs`，`totalRuntimeBudgetMs` 必须保持 20**——因为它们断言的是「预算超限」那一侧的分支，抬预算会**悄悄改变它们断言的内容**。需要自己的一轮验证，且要覆盖 4 个而非 3 个。
   - L1 留下的那个依赖真实文件系统计时的交错测试。
3. **一次未定性的失败** —— 某次验证跑出现 372/373，但输出被 `tail -8` 截断，测试名未捕获；随后 13 轮全套件复跑未复现。记为「未定性、未复现、名字没抓到」，**没有做归因**（本轮已判定不可证伪的归因不可接受）。下次再见到 372/373 请完整落盘。
4. **`.superpowers/sdd/` 是跨会话共用的扁平目录**。两轮都只提交了自己子目录里的 ledger 与报告（`git add -f`），**刻意跳过** `review-*.diff`（就是 `git diff` 输出，可重建）与 briefs（可从 plan 抽取）。同级目录属于更早的会话，仍被 ignore，**不要整删**。

## L5 的继承清单（写 L5 spec 时必须处理）

1. **reconciliation 合成责任无人认领**（本轮裁决 1 的代价）。若 L2–L5 把 `reconciliation-record.json` 当证据消费，在 L5 补上之前存在缺口。
2. **`persistTerminalState` 往已不拥有的 run 里写**（`src/controller/runLoop.ts` 内 `isLeaseStopError` 分支）。本层的主张在下一帧被强制执行、却在上一帧被违反。**本轮不是引入者，但本轮的新 guard 让这条路径变得明显更频繁。**
3. `heartbeat.stop()` 快照 queue 后 `await releaseOwnerLease`，期间新起的 `runExclusive` 不被 `stop` 等待。评审确认**当前不可达**（两个调用点都在 `await runLoopFromState` 之后的 `finally` 里），但 L2 增加调用者后需重新评估。

## 给下一位实施者的重点提示

- **spec §12 的 19 条里有 6 条是专门写来打死某个具体错误实现的**（第 2、5、7、15、17、19 条），已全部变异验证。**不要因为「看起来冗余」而弱化或删除。** 这是人下过的常驻指令。
- **计划风格**：L1 用「附完整可抄代码」的计划，效率极高但**会关掉实施者判断力**——计划里的疏漏原样落地。L1b 改成「接口签名 + 测试要求 + 陷阱清单」，实施者**主动发现并上报了两处计划缺陷**（不可达的 `guardedWriteArtifacts`、观测上不可区分的变异），这是前一种风格拿不到的。**L2 继续用后者。**
- **评审要对着代码撞，不要只查文档自洽**。本轮最值钱的两条发现都来自评审员拒绝接受实施者的自证：一条查出「已变异验证」的测试只验证了它声称的一半；另一条把实施者的循环论证（「断言还过 → 说明分支还到」）替换成逐个核对「若提前分流是否必然失败」。
- **加 guard 时先 grep 同一函数内该危险调用的全部出现位置**。本轮 `readOwnerRecord` 有两处，第一次只加了一处，漏的那处恰在最危险的路径上。

## 仍然生效的治理边界

- 每次真实 Claude 调用前须显式获批（付费）。
- 不覆盖已接受的 `review.json`；`D-01` 保持 `INCONCLUSIVE / CONTRACT_GAP`，重解释走单独的 `review-reclassified.json`。
- `stale-confirmed` / `reconciliation-record.json` **本身不授权继续执行或接管**；auto-takeover 仍 deny-by-default。resume 只消费已发布 transfer、不自行判断接管。
- **L1 / L1b 不引入任何新授权**：活租约只增加拒绝；租约过期**既不许可也不拒绝**。这条已由实现与评审逐点验证成立，后续层不得削弱。
- 不做 `git clean` / `reset --hard` / 广域 `restore`；不删 `.validation-runs/`、备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`、`stash@{0}` / `stash@{1}`。
- push 与 merge 是两件事，都只在人明确下指令时执行。

## 参考（按路径读，勿在此复制内容）

- **L1b 设计（含五处修订）**：`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`
- **L1b 计划 + ledger**：`docs/superpowers/plans/2026-07-27-owner-transfer-contention.md`、`.superpowers/sdd/2026-07-27-owner-transfer-contention/`
- **L1 设计（含四处修订）+ 计划 + ledger**：`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`、`docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md`、`.superpowers/sdd/2026-07-26-run-lease-and-heartbeat/`
- 父设计：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`（§5.5 freshness anchor、§7.1 owner-loss 条件、§17 后续 spec 清单——其中 **L5 cleanup/orphan GC 的 spec 至今未写**）
- 兄弟设计：`docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md` 与对应 plan
- 外部参照：`reference/loop-engineering/tools/loop-worktree/README.md`、`reference/DoWhiz/DoWhiz_service/scheduler_module/`
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/buglog.json`

## 建议接手时调用的 skills

- `superpowers:brainstorming` — **下一步做 L2（registry / queue）时的起点**；补 L5（cleanup / orphan GC）spec 时同样。
- `superpowers:writing-plans` — brainstorming 出 spec 之后。注意上面关于计划风格的教训：**接口签名 + 测试要求 + 陷阱清单，不给完整实现**。
- `superpowers:subagent-driven-development` — 执行计划。两轮全程用它，ledger 机制被证明有效（跨压缩仍能准确定位进度）。
- `superpowers:test-driven-development` — spec 的测试要求天然是 TDD 输入。
- `superpowers:verification-before-completion` — 声称「通过/完成」前复跑 typecheck / build / 全套件并贴真实输出。
- `superpowers:using-git-worktrees` — 开始新一层实现前建立隔离工作区。
- `superpowers:finishing-a-development-branch` — 一层做完后收尾（合并 / worktree 清理）。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
