# ccloop Handoff — 债务归属已裁决；债 4（原子写）分支进行中，Task 1 已关闭

> 更新于 2026-07-30。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> 本文不硬钉 git HEAD：提交本文即会改变 HEAD。用下面「如何定位当前状态」自查。

> ⚠️ **本文当前位于分支 `worktree-debt4-atomic-write-paths`，尚未合并回 `main`。** 若你在 `main` 上读到的是旧版本，以本分支的为准。

## 快速接手入口

1. **L1 / L1b / L2 已 merge 进 `main`**（run lease + heartbeat / owner-transfer contention / run registry），`main` 上 **427 tests** 全绿。
2. **四笔遗留债的归属已由人裁决完毕**，见 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`。裁决同时回答了「下一层做什么」：**先做债 4，再做 L3，最后 L5**。
3. **当前工作：债 4（消除 fileStore 非原子写路径）**，在 worktree `.claude/worktrees/debt4-atomic-write-paths`、分支 `worktree-debt4-atomic-write-paths` 上。**Task 1 已关闭，下一步是 Task 2。**
4. **照着计划做，不要重新设计**：`docs/superpowers/plans/2026-07-29-atomic-write-paths.md`（5 个任务）。唯一真相源是 `docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md`。
5. **「为什么长这样」先读 ledger**：`.superpowers/sdd/2026-07-29-atomic-write-paths/progress.md`——它记了全部裁决、四条计划缺陷、两轮评审与两轮修复。**不要重新推理。**
6. **常驻禁令**：L1 spec §12 十九条中的第 2/5/7/15/17/19 条不得弱化或删除（已变异验证，人下过指令）。
7. 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`；**真实 Claude 调用须事先获批（付费）**。
8. **已知 flake 现为 7 个**（见遗留事项 2 的具名清单），刻意未修，别当新 bug 查。
9. **验证跑绝不要 `| tail -N`**；**计划不要附完整可抄代码**；**评审必须对着代码撞、不接受实施者自证**。三条铁律，全部有案底。

## 如何定位当前状态（不要照抄 commit hash）

```bash
cd /Users/biran/code/skills/loop/ccloop
git worktree list                         # 期望能看到 debt4-atomic-write-paths
git log --oneline --decorate -15
git rev-list --count origin/main..main    # 待 push 笔数，以此为准
git status --branch --short
# 在 worktree 内：
cd .claude/worktrees/debt4-atomic-write-paths
git log --oneline -15
grep -c "^- \[x\]\|^- \[ \]" docs/superpowers/plans/2026-07-29-atomic-write-paths.md
```

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

## 当前分支（债 4）状态

**范围**：五处裸 `writeFile` 改 temp+rename——`loop-state.json` 的**两个**写者（`initializeRunFiles:76`、`writeRunState:81`）、首次 `owner-record.json`、`boundary-analysis.json`、`reconciliation-record.json`。外加标记一个导出的非原子 transfer 写入口，以及更正 L2 的两处注释（**`atomic: false` 保留为纵深防御，`src/registry/` 零逻辑改动**）。

**Task 1 已关闭**：新增 `writeJsonFileAtomically`（模块私有）与 `buildAtomicTempPath`（导出仅为可测）。**零生产调用点替换、零行为变更。** 两轮评审 + 两轮修复，全程 0 Critical。当前 **431 tests** 全绿，typecheck / build 干净。

**Task 2 起的两条硬要求（已写进计划）**：
- `loop-state.json` 的**两个**写者都要改，**只改其一即未达标**；
- R2（残留与错误传播）在 Task 1 里**不可达**（缺陷 D1），已移到 Task 2 的 **Step 4b**，且**必须自己重跑残留变异并贴自己的输出，不得引用 ledger 当证据**。

**已发现并修正的四条计划缺陷（D1–D4）与两条 spec 缺陷**，全部记在 ledger，计划与 spec 均已就地更正并保留痕迹。其中最值得知道的一条：**spec 里那句「本仓库测试套件零处 `vi.mock`（已核实）」是假的**——`vi.mock(` 确实 0 处，但 `vi.doMock` 有 **24 处、跨 5 个文件，包括 `tests/persistence/fileStore.test.ts` 自己**。现已改为「优先真实 tmpdir，允许 `vi.doMock` 但必须写明为何真实手段不可行」。

## 遗留事项

1. **push** —— 用上面的命令看实际待 push 的是哪几笔，**不要假设数量**。push 由人决定。
   - 早前记录的「`origin/main` 无人 push 却自动前进」**已澄清：是人自己 push 的，不是环境异常**。原遗留事项 10 撤销。
2. **已知 flake 债（刻意未修）——现为 7 个**：

   - `tests/controller/runLoop.integration.test.ts` 的四个 `BUDGET_EXHAUSTED_REASON` 测试（约 `:1002 / :1258 / :1655 / :1773`）把 `perAttemptTimeoutMs` 与 `totalRuntimeBudgetMs` 都钉在 20ms 互相赛跑。**修法：只抬 `perAttemptTimeoutMs`，`totalRuntimeBudgetMs` 必须保持 20**——它们断言的是「预算超限」那一侧，抬预算会悄悄改变断言内容。
   - L1 留下的一个依赖真实文件系统计时的交错测试。
   - **【第 6 个】** `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`——全套件并行负载下 5000ms 超时，隔离连过两次。发现于债 4 基线跑，**当时源码零改动**。
   - **【第 7 个】** `tests/controller/runLoop.integration.test.ts > runLoop > records retained cleanupStatus in execution recovery when cleanup fails`——偶发失败，隔离通过、其后全套件连过两次。发现于 Task 1 收口跑，**当次提交是纯注释（4 行）**，因果上不可能造成它。与 `BUDGET_EXHAUSTED_REASON` 家族无关。

   **给实施者与评审员**：在本分支跑全套件时，这三条具名失败**可以**出现且**不构成**新缺陷——
   `runLoop.integration.test.ts > treats execute timeout with no adapter result as exhausted even if files changed in the worktree`、上面第 6 个、上面第 7 个。
   **但「像是已知 flake」不等于「是已知 flake」**：必须先捕获**完整测试名与失败块**再比对，**绝不允许 `| tail -N` 后凭印象归因**——L1b 正是这样丢过一次失败身份。**任何不在名单内的失败一律按新缺陷处理。**
3. **L2 挂账 5 条 Minor**（可延后，见 L2 ledger）：`ObservedFileSpec.file` 未收窄成字面量联合；`scanRootFailureDetail` 落在 `renderRuns.ts` 名不副实；`DT_UNKNOWN` 回退无测试（**已如实记录而非写空壳测试充数**）；两条夹具注释瑕疵。
4. **`.superpowers/sdd/` 是跨会话共用的扁平目录**，且是 gitignored——提交自己子目录的 ledger 要用 `git add -f`。**刻意跳过** `review-*.diff` 与 briefs（都可重建）。同级目录属于更早的会话，**不要整删**。
5. **本分支范围外、但已查实、留给后续层的一笔**：`finalizePendingOwnerTransfer` 自己的 catch 有与 D2 同型的潜在错误掩盖——两个 `safeUnlink` 都可能替换正在传播的错误。它在 spec §2.2 的不动范围内，本分支正确地未碰。

## 本轮新增的教训（比缺陷本身更值钱）

- **不要相信别人写下的「已核实」。** 本轮四次同一动作：我 grep 漏了 `doMock` 就写「已核实」；实施者信了我的「已核实」导致论述越界；我照抄评审员一段错误算术；实施者把那段错误算术写进了提交的注释。**别人标注为已验证的主张，在你自己跑之前仍是未验证的。**
- **加一个成分和加它的覆盖是一件事，不是两件事。**（实施者原话）修复轮加固了 pid 断言，却在**同一次编辑**里给新字段引入 `\d+` 并写了声称覆盖它的测试名——**把自己刚修掉的缺陷以更窄的形式重新引入**。教训不是「测试名要对范围诚实」，而是「**名字里每一个分句都必须有一条能失败的断言**」。
- **修复波会自带缺陷**，本仓库已有案底。**修复之后必须再评审**，且再评审的重点是「这次修复引入了什么」，不是重做上一次评审。
- **证明一个跨模块断言不是同义反复，要做反方向变异**：只改 A 侧失败、只改 B 侧也失败 → 是真钉定；同义反复只会在两侧同步变动时才失败。
- **注释里的机制，写之前先跑一遍。**（实施者为自己立的规矩，值得推广）

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

- **当前分支**：`docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md`、`docs/superpowers/plans/2026-07-29-atomic-write-paths.md`、`.superpowers/sdd/2026-07-29-atomic-write-paths/progress.md`
- **债务裁决**：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`
- **L2 / L1b / L1**：`docs/superpowers/specs/2026-07-2{8,7,6}-*-design.md` + 同名 plan + `.superpowers/sdd/2026-07-2{8,7,6}-*/`
- 父设计：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`（§17 后续 spec 清单——**item 2 的触发那一半与 item 3 的 L5 cleanup 都还没写**）
- 兄弟设计：`docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md`
- 外部参照：`reference/loop-engineering/tools/loop-worktree/README.md`、`reference/DoWhiz/DoWhiz_service/scheduler_module/`
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/buglog.json`、`.wolf/anatomy.md`

## 建议接手时调用的 skills

- `superpowers:subagent-driven-development` — **接着做 Task 2 的直接入口。** 计划已就绪，不需要重新 brainstorm。
- `superpowers:requesting-code-review` — 每任务一次 + 整分支一次，缺一不可；修复轮之后还要再评审一次。
- `superpowers:verification-before-completion` — 声称「通过/完成」前复跑 typecheck / build / 全套件并贴真实输出。
- `superpowers:finishing-a-development-branch` — 债 4 五个任务做完后收尾。`.claude/worktrees/` 下的 worktree 由 harness 管理，用 `ExitWorktree` 而非 `git worktree remove`。
- `superpowers:brainstorming` — **只在开 L3 时才用**（债 4 已有 spec 与计划，不要重开）。
- `superpowers:writing-plans` — L3 brainstorming 出 spec 之后。注意计划风格教训。
- `superpowers:systematic-debugging` — 若遇到不在 flake 名单内的失败。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
