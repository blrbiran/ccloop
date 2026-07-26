# ccloop Handoff — L1（run lease + heartbeat）已实现、评审通过、merge 进 main

> 更新于 2026-07-26。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> 本文不硬钉 git HEAD：提交本文即会改变 HEAD。用下面「如何定位当前状态」自查。

## 一句话现状

前沿五层里的 **L1（run lease + heartbeat）已经全部做完**：13 个任务、每个任务独立评审、4 个任务共 5 轮修复、最终整支评审判定 `Ready to merge: Yes`，已 **fast-forward merge 进 `main`**。测试 274 → **356** 全绿，typecheck / build 干净。下一步是 L2（registry / queue），或先清掉下面两个 tracked follow-up。

## 如何定位当前状态（不要照抄 commit hash）

```bash
git -C /Users/biran/code/skills/loop/ccloop log --oneline --decorate -30
git -C /Users/biran/code/skills/loop/ccloop status --branch --short
git -C /Users/biran/code/skills/loop/ccloop log origin/main..HEAD --oneline   # 待 push 的全部提交
git -C /Users/biran/code/skills/loop/ccloop worktree list                     # 见「收尾事项」
```

- 本轮在 `main` 上留下约 25 笔提交（13 个任务 + 修复轮 + spec 修订 + ledger）。数量以上面第三条命令为准，不要假设。
- 所有 L1 代码与测试都在 `main` 上，工作区干净。

## 本轮做了什么（细节都在仓库里，勿在此重复）

**唯一真相源仍是 spec**：`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`。
**实施计划**：`docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md`（13 个任务，末尾附 §12 十九条测试要求 → 任务的覆盖表）。
**执行全过程的 ledger 与 13 份实施报告**：`.superpowers/sdd/2026-07-26-run-lease-and-heartbeat/`（已提交）。里面有每条评审发现、每条人工裁决、每条 parked 项的理由，以及各测试的变异验证证据。**遇到「为什么代码长这样」的问题先读 `progress.md`，不要重新推理。**

新增模块：`src/ownership/lease.ts`（纯）、`src/controller/leaseGate.ts`、`src/controller/leaseHeartbeat.ts`、`src/runtime/processIdentity.ts`；`fileStore` 增三个租约函数；`runLoop` / `resumeLoop` 接线。

### spec 已被修订过四处 —— 它不再等同于当初冻结的那一版

顶部 Status 行有索引，正文内联标注 `**Amended 2026-07-26 (a)–(d)**`。**四处全部是文档缺陷，不是实现缺陷**：实施者忠实照做，是文本错了。

- **(a) §4.4**：漏了「运行中的 owner 把所有权转给自己」（`persistBoundaryAnalysis` 就会这么做）。后果是心跳按 epoch 比较会把自己判成被接管，写出 expected 与 observed **完全相同**的假 `lease_lost` 事件，污染 L2–L5 要消费的证据流。规则已补：自转移成功后必须 adopt 刚写下的记录，且 adopt **不得**清除已成立的 supersession。
- **(b) §8.1**：outcome 表默认所有 re-check 都发生在终态持久化之前，实际有一批在之后。已补明该窗口的语义，包括那句反直觉的结论：**租约丢失的 run 仍可能报告 `succeeded`，事件日志是唯一记录。**
- **(c) §8.1**：副作用清单漏了 `persistBoundaryAnalysis`（循环里最大的副作用）。
- **(d) §6**：冗余论证双向纠正——节流**不会**饿死事件路径（旧措辞会诱使后人去修一个不存在的 bug），而真正的丢失检测来自 `assertHeld`。

## 验证证据

| 项 | 结果 |
|---|---|
| `npm test -- --run` | 23 files / **356** tests 全过（本轮起点 274） |
| `npm run typecheck` / `npm run build` | 均干净 |
| merge 后在 `main` 上复跑 | 同上，已独立验证 |

运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`。
全流程**零付费 Claude 调用**（ScriptedAdapter + 手写 stub adapter）。

## 收尾事项 / 未擅自执行

1. **push** —— L1 的实现提交已进 `origin/main`；本文这笔（及之后的）可能仍在本地。用上面第三条命令看实际待 push 的是哪几笔，不要假设数量。push 由人决定。
2. **worktree 尚未清理** —— `.claude/worktrees/l1-run-lease-heartbeat`（分支 `worktree-l1-run-lease-heartbeat`，处于 locked）。已 FF merge，内容与 main 相同，可以安全移除，但**没有人下过指令，所以没动**。
3. **`.superpowers/sdd/` 是跨会话共用的扁平目录**。本轮只提交了自己那个子目录里的 ledger 与报告（`git add -f`），并**刻意跳过** 21 个 `review-*.diff`（就是 `git diff` 输出，可重建）和 briefs（可从 plan 抽取）。同级目录属于更早的会话，仍被 ignore，**不要整删**。

## 两个 tracked follow-up（评审明确判定不在本分支做）

建议**一起做**，因为第 1 条是第 2 条那个 parked race 的放大器：

1. **`OwnerTransferLockBusyError`** —— `fileStore` 目前把「锁忙」和「CAS 不匹配」混用同一个 `OwnerTransferPreconditionError`。本轮引入了 owner-transfer 锁的**第一个周期性竞争者**（心跳），所以一次合法的 owner transfer 可能被静默丢弃：`writeOwnerTransferArtifacts` 抢不到锁 → `runLoop` 当成「记录已变」→ 重读重判、**永不重试**，reconciliation record 写成 `newOwnerEpoch: null`。同时这也让 spec §6 那句「吞掉锁竞争」目前不可实现。
2. **给 `persistBoundaryAnalysis` 加 guard** —— spec 修订 (c) 已把它写进副作用清单，依据明确。注意 Layer A 靠转移 CAS 自保，缺口在 `writeBoundaryArtifacts`。

其余 parked 项（含 adopt 与在飞 affirm 之间几毫秒的窗口、guard 站点计数、`namesSomeoneElse` 对缺失 `supersededByEpoch` 的处理等）全部连同裁决理由记在 `progress.md`，**不要重新发现一遍**。

## 给下一位实施者的重点提示

- **spec §12 的 19 条里有 6 条是专门写来打死某个具体错误实现的**（第 2、5、7、15、17、19 条）。它们现在都已实现并经变异验证，**不要因为「看起来冗余」而弱化或删除**。这是人下过的常驻指令。
- **本轮最值钱的教训**：给实施者附完整可抄代码的计划风格，效率极高（13 个任务只有 1 次真正的实现偏离），但**会关掉实施者的判断力**——计划里的疏漏会被原样落地，只能靠事后评审捞。三条 Important 缺陷正是这么来的。做 L2 的计划时建议改成「接口签名 + 测试要求 + 明确的陷阱清单」，不给完整实现。
- **评审要对着代码撞，不要只查文档自洽**。本轮几条关键发现都是评审员跑去读被引用模块的实际行为才照出来的（例如追出 `assertHeld` 先置 `superseded` 导致心跳的事件写入路径永久不可达）。

## 仍然生效的治理边界

- 每次真实 Claude 调用前须显式获批（付费）。
- 不覆盖已接受的 `review.json`；`D-01` 保持 `INCONCLUSIVE / CONTRACT_GAP`，重解释走单独的 `review-reclassified.json`。
- `stale-confirmed` / `reconciliation-record.json` **本身不授权继续执行或接管**；auto-takeover 仍 deny-by-default。resume 只消费已发布 transfer、不自行判断接管。
- **L1 不引入任何新授权**：活租约只增加拒绝；租约过期**既不许可也不拒绝**。这条已由实现与评审逐点验证成立，后续层不得削弱。
- 不做 `git clean` / `reset --hard` / 广域 `restore`；不删 `.validation-runs/`、备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`、`stash@{0}` / `stash@{1}`。

## 参考（按路径读，勿在此复制内容）

- **L1 设计（含四处修订）**：`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`
- **L1 计划**：`docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md`
- **执行 ledger + 13 份报告**：`.superpowers/sdd/2026-07-26-run-lease-and-heartbeat/`
- 父设计：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`（§5.5 freshness anchor、§7.1 owner-loss 条件、§17 后续 spec 清单——其中 L5 cleanup/orphan GC 的 spec **至今未写**）
- 兄弟设计：`docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md` 与对应 plan
- 外部参照：`reference/loop-engineering/tools/loop-worktree/README.md`、`reference/DoWhiz/DoWhiz_service/scheduler_module/`
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/buglog.json`

## 建议接手时调用的 skills

- `superpowers:brainstorming` — **下一步做 L2（registry / queue）时的起点**；补 L5（cleanup / orphan GC）spec 时同样。
- `superpowers:writing-plans` — brainstorming 出 spec 之后。注意上面「重点提示」里关于计划风格的教训。
- `superpowers:subagent-driven-development` — 执行计划。本轮全程用它，ledger 机制被证明有效（跨压缩仍能准确定位进度）。
- `superpowers:test-driven-development` — spec 的测试要求天然是 TDD 输入。
- `superpowers:verification-before-completion` — 声称「通过/完成」前复跑 typecheck / build / 全套件并贴真实输出。
- `superpowers:using-git-worktrees` — 开始新一层实现前建立隔离工作区。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
