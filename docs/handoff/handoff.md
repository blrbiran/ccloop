# ccloop Handoff — L1 / L1b / L2 均已实现、评审通过、merge 进 main

> 更新于 2026-07-29。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> 本文不硬钉 git HEAD：提交本文即会改变 HEAD。用下面「如何定位当前状态」自查。

## 快速接手入口

1. 前沿三层 **L1（run lease + heartbeat）、L1b（owner-transfer contention）、L2（run registry）都已完成并 merge 进 `main`**，**427 tests** 全绿（23 files/373 → 29 files/427），typecheck / build 干净，无遗留 worktree。
2. **L2 只做了「发现」，没做「触发」**。§17 item 2 原文是 "scheduler / unattended execution"，人明确裁定拆成两半：本层只回答「哪些 run 存在、各自什么状态」，`ccloop ls <root>`。触发留给下一层。
3. 下一步二选一：**L3（queue / triggering）** 或**先补 L5（cleanup / orphan GC）spec**。L5 至今未写，现在背 **4 笔**债（见下）。起点 skill 都是 `superpowers:brainstorming`。
4. 「为什么代码长这样」先读 ledger：`.superpowers/sdd/2026-07-2{6,7,8}-*/progress.md`，**不要重新推理**。
5. 三份 spec 都被修订过（L1 四处 a–d、L1b 五处 a–e、L2 九处 a–i），**全部是文档缺陷不是实现缺陷**；顶部 Status 行有索引。
6. **常驻禁令**：L1 spec §12 十九条中的第 2/5/7/15/17/19 条不得弱化或删除（已变异验证，人下过指令）。
7. 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`；**真实 Claude 调用须事先获批（付费）**。
8. `main` 领先 `origin/main` 若干笔且**尚未 push**——push 由人决定，不要擅自执行。
9. 已知 flake 债 5 个测试，**刻意未修**，别当新 bug 查。
10. **验证跑绝不要 `| tail -N`**：失败块会被截断、测试名丢失，只剩不可证伪的归因。计划风格：**不要附完整可抄代码**（三轮实践一致证明那会关掉实施者判断力）。

## 如何定位当前状态（不要照抄 commit hash）

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --oneline --decorate -20
git status --branch --short
git rev-list --count origin/main..main   # 待 push 笔数，以此为准
git worktree list                        # 期望只有主工作区
ls src/registry tests/registry           # L2 的 12 个文件
```

## 本轮（L2）做了什么

**唯一真相源是 spec**：`docs/superpowers/specs/2026-07-28-run-registry-design.md`
**实施计划**：`docs/superpowers/plans/2026-07-28-run-registry.md`（6 个任务）
**执行 ledger + 6 份任务报告**：`.superpowers/sdd/2026-07-28-run-registry/`（已提交）

新增 `ccloop ls <root>`：递归扫描、按 5 个 marker 文件识别 run 目录、认出后不再下钻、不跟随符号链接、深度上限 10、无法读取的目录变成一行而不是中止扫描。每行报**原始观测事实**——`loop-state.json` / `owner-record.json` / `owner-transfer.json` 的字段，逐字段三态 `present` / `absent` / `unreadable(parse|shape|io)`。

**本层的全部主张是「不新增任何授权」，而且是结构性的而非论证性的**：只读、不写、不执行，连 eligibility 都不判。消费者仍须走 `resumeLoop` 的完整 gate。

三个必须知道的实现约束（细节读 spec §7、§8）：

- **禁用 `readOwnerRecord`**（`fileStore.ts:566`）——它跑崩溃恢复，**会写盘**。只能用 `readOwnerRecordWithoutRecovery`。
- **`checkRunLease` 也禁用**——它会 append `lease_expired_observed` 事件。
- **`loop-state.json` 与首次创建的 `owner-record.json` 是非原子写**（裸 `writeFile`），撕裂读真实存在；只对这两个做有界重读，`owner-transfer.json` 原子、单次读。

### L2 spec 已被修订九处（a–i）

顶部 Status 行有索引，正文内联标注。**全部是文档缺陷**。最重的一条是 **(d)**：整个一致性模型建立在「每个被观测文件都是原子 rename 写入」上，而三个里有两个不是——这个假前提已被人批准过一轮，才被对抗式评审撞出来。另外 **(f)(g)** 两条是**有害的测试要求**：一条的崩溃恢复夹具描述错了、按它搭夹具即使误用禁用读函数测试也会通过；另一条禁用了 §6 强制要求的字段名，会打死正确实现。

### 本轮最值钱的一条发现

**最终整分支评审抓到、而六轮任务级评审结构上都看不见的**：本层招牌主张「零派生」的守护测试，遍历的是它自己的手写字面量而非真实产出。给生产类型加一个**可选**派生字段——字面量照样 typecheck、测试保持绿、字段就发出去了（必填字段才会被 typecheck 挡住，**保护是单向的**）。

配套教训：验证「这条测试能失败」时必须注入**生产类型**；往测试数组里注入只证明匹配器有效、没证明覆盖到位。修复后的证明是对的——加 `fresh?: boolean` 后只有新的流水线驱动测试失败、原夹具测试保持绿色。

这与前两轮是同一形状（「测试声称杀 A、实际杀不掉」），已进 `.wolf/cerebrum.md`。

## 验证证据

| 项 | 结果 |
|---|---|
| `npm test -- --run` | 29 files / **427** tests 全过（L2 起点 373，新增 54） |
| `npm run typecheck` / `npm run build` | 均干净 |
| 合并后在 `main` 上复跑 | 同上，已独立验证 |
| fix round | 6 个任务**零轮**；仅最终评审后一次修复波 |

全流程**零付费 Claude 调用**。

## 遗留事项

1. **push** —— 用上面第三条命令看实际待 push 的是哪几笔，**不要假设数量**。push 由人决定。
   - 观察到一个未解释的现象：早前三笔文档提交在无人 push 的情况下出现在 `origin/main`，但本轮合并后 `main` 确实领先。**只记录现象，未做归因。**
2. **已知 flake 债（刻意未修）**：`tests/controller/runLoop.integration.test.ts` 的四个 `BUDGET_EXHAUSTED_REASON` 测试（约 `:1002 / :1258 / :1655 / :1773`）把 `perAttemptTimeoutMs` 与 `totalRuntimeBudgetMs` 都钉在 20ms 互相赛跑。**修法：只抬 `perAttemptTimeoutMs`，`totalRuntimeBudgetMs` 必须保持 20**——它们断言的是「预算超限」那一侧，抬预算会悄悄改变断言内容。另有 L1 留下的一个依赖真实文件系统计时的交错测试。
3. **L2 挂账 5 条 Minor**（评审逐条判定可延后，见 ledger）：`ObservedFileSpec.file` 未收窄成字面量联合；`scanRootFailureDetail` 落在 `renderRuns.ts` 名不副实；`DT_UNKNOWN` 回退无测试（模拟不现实，**已如实记录而非写空壳测试充数**）；两条夹具注释瑕疵。
4. **`.superpowers/sdd/` 是跨会话共用的扁平目录**。三轮都只提交自己子目录里的 ledger 与报告（`git add -f`），**刻意跳过** `review-*.diff`（可从 `git diff` 重建）与 briefs（可从 plan 抽取）。同级目录属于更早的会话，**不要整删**。

## L5 的继承清单（现在 4 笔，写 L5 spec 时必须处理）

1. **reconciliation 合成责任无人认领**（L1b 裁决 1 的代价）。L2 不观测 `reconciliation-record.json`，所以一行可能显示 `eligibleForContinuation: true` 而磁盘上并无该文件——**那是这笔债透出来，不是 registry 缺陷**。
2. **`persistTerminalState` 往已不拥有的 run 里写**（`src/controller/runLoop.ts` 的 `isLeaseStopError` 分支）。
3. **`heartbeat.stop()` 释放窗口** —— 快照 queue 后 `await releaseOwnerLease`，期间新起的 `runExclusive` 不被 `stop` 等待。**L2 未使其可达**（只读、零新增调用者），这正是选 registry 而非 queue 的直接收益。**加触发调用者的那一层必须重新评估。**
4. **【L2 新增】`writeRunState` 与首次 `writeOwnerRecord` 非原子**（裸 `writeFile`，无 temp+rename），而 `loop-state.json` 每次状态转移都重写。L2 用有界重读绕过而非修复，因为只读层不该改别人的写路径。**任何需要连贯读 `loop-state.json` 的后续消费者都继承同一问题与同一 100ms 代价。**

## 给下一位实施者的重点提示

- **spec §12 的 19 条里有 6 条是专门写来打死某个具体错误实现的**（第 2、5、7、15、17、19 条），已全部变异验证。**不要因为「看起来冗余」而弱化或删除。** 人下过的常驻指令。
- **计划风格**：接口签名 + 测试要求 + 陷阱清单，**不给完整实现**。三轮一致：给完整代码效率高但计划的疏漏原样落地；给要求则实施者会主动发现并上报计划缺陷——本轮 6 个实施者里 4 个报了。
- **评审要对着代码撞，不要只查文档自洽**，且**明确要求评审员不接受实施者的自证**。三轮最值钱的发现全部来自这一条。
- **任务级评审有结构性盲区**：它只看单个任务的 diff。跨任务的、以及「守护测试守护的到底是什么」这类问题，只有整分支评审能看见。**不要因为每个任务都过了就跳过最终评审。**
- **写「证明某测试能失败」的步骤时，注入点必须在生产代码/生产类型上。**
- **加 guard 或改读写路径前，先 grep 同一函数内该危险调用的全部出现位置。**

## 仍然生效的治理边界

- 每次真实 Claude 调用前须显式获批（付费）。
- 不覆盖已接受的 `review.json`；`D-01` 保持 `INCONCLUSIVE / CONTRACT_GAP`。
- `stale-confirmed` / `reconciliation-record.json` **本身不授权继续执行或接管**；auto-takeover 仍 deny-by-default。resume 只消费已发布 transfer。
- **L1 / L1b / L2 不引入任何新授权**：活租约只增加拒绝；租约过期既不许可也不拒绝；registry 只报事实、不判 eligibility。后续层不得削弱。
- 不做 `git clean` / `reset --hard` / 广域 `restore`；不删 `.validation-runs/`、备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`、`stash@{0}` / `stash@{1}`。
- push 与 merge 是两件事，都只在人明确下指令时执行。

## 参考（按路径读，勿在此复制内容）

- **L2 设计（含九处修订）+ 计划 + ledger**：`docs/superpowers/specs/2026-07-28-run-registry-design.md`、`docs/superpowers/plans/2026-07-28-run-registry.md`、`.superpowers/sdd/2026-07-28-run-registry/`
- **L1b**：`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`、对应 plan、`.superpowers/sdd/2026-07-27-owner-transfer-contention/`
- **L1**：`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`、对应 plan、`.superpowers/sdd/2026-07-26-run-lease-and-heartbeat/`
- 父设计：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`（§5.5、§7.1、§17 后续 spec 清单——**item 2 的另一半（触发）与 item 3（L5 cleanup）都还没写**）
- 兄弟设计：`docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md`
- 外部参照：`reference/loop-engineering/tools/loop-worktree/README.md`、`reference/DoWhiz/DoWhiz_service/scheduler_module/`
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/buglog.json`、`.wolf/anatomy.md`

## 建议接手时调用的 skills

- `superpowers:brainstorming` — **做 L3（queue / triggering）或补 L5 spec 的起点。**
- `superpowers:writing-plans` — brainstorming 出 spec 之后。注意计划风格教训。
- `superpowers:subagent-driven-development` — 执行计划。三轮全程用它，ledger 机制跨压缩仍能准确定位进度。
- `superpowers:using-git-worktrees` — 开始新一层实现前建立隔离工作区。注意本仓库 `.worktrees/` 与 `.claude/worktrees/` **都**已 gitignore，且 `.wolf/*` 是 gitignored，新 worktree 不带这些文件。
- `superpowers:requesting-code-review` — 每任务一次 + 整分支一次，缺一不可。
- `superpowers:verification-before-completion` — 声称「通过/完成」前复跑 typecheck / build / 全套件并贴真实输出。
- `superpowers:finishing-a-development-branch` — 一层做完后收尾。注意 `.claude/worktrees/` 下的 worktree 由 harness 管理，用 `ExitWorktree` 而非 `git worktree remove`。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
