# ccloop Handoff — resume/adopt 续跑已实现、merge 进 main 并已 push 到 origin/main

> 写于 2026-07-25。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> 本文不硬钉 git HEAD：提交本文即会改变 HEAD。用下面「如何定位当前状态」自查。

## 一句话现状

**resume/adopt 续跑**（前沿第 1 项）已按 spec→plan→subagent-driven 全流程实现，8 笔提交在 feature 分支 `resume-adopt-continuation-20260725`，已用 `--no-ff` merge 进 `main` **并已 push 到 `origin/main`**（合并提交 `Merge branch 'resume-adopt-continuation-20260725'`）。合并后 `main` 全绿（270 tests / typecheck / build）。唯一可能本地领先、待 push 的是**本 handoff 更新**文档提交。feature 分支与 SDD workspace 均**未删**（留待人决定）。

## 如何定位当前状态（不要照抄 commit hash）

```bash
git -C /Users/biran/code/skills/loop/ccloop log --oneline --decorate -12
git -C /Users/biran/code/skills/loop/ccloop status --branch --short
git log origin/main..HEAD --oneline        # 本地领先、待 push 的全部提交
git branch --contains resume-adopt-continuation-20260725   # 确认已并入 main
```

- `main`（及 `origin/main`）顶部应能看到 `Merge branch 'resume-adopt-continuation-20260725'`（`--no-ff` 合并）；本文这篇 handoff 更新提交则叠在其上、可能仅存在于本地。
- 合并带入的 8 笔（分支上，从旧到新）：`runLoopFromState` 抽取 → 严格读取器 → CAS 写入器（含 1 笔 typecheck 修复）→ eligibility gate → `resumeLoop` 编排 → resume CLI → fix wave（CLI 打印拒绝原因 + worktree e2e 测试）。
- `origin/main` **已含**合并提交及其带入的 8 笔；唯一可能本地领先的是本 handoff 更新文档提交。

## 本次做了什么（细节看 spec / plan / commits / ledger，勿在此重复）

- 设计与计划：`docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md`、`docs/superpowers/plans/2026-07-25-resume-adopt-continuation.md`。
- 新增 `src/controller/resumeLoop.ts`：`resumeLoop(runDir, adapter)` = 读持久化产物 → 纯 eligibility gate → CAS 认领 owner-record → best-effort 清理残留 worktree → 委托 `runLoopFromState` 从下一 attempt 续跑。配套 `resume` CLI 子命令、`readRunState/readOwnerTransferRecord/readReconciliationRecord`（严格 throw）、`claimOwnerRecordWithPrecondition`（锁下 CAS）。
- 设计要点（均已落地并经最终 whole-branch review 确认）：resume **只消费**已发布的 transfer eligibility，**不做接管判断**；deny-by-default（缺失/损坏产物即拒绝）；拒绝时不改任何 run 状态；双重 supersede 防线（gate epoch fence + CAS precondition）；next-attempt-fresh（放弃在途 attempt 及其 worktree，跑 fresh 的 N+1）；resumable 状态白名单严格为 `planning|executing|verifying`。
- 过程中抓到并修复的两个真实 bug，已记入 `.wolf/buglog.json`：
  - **bug-041**（关键）：plan 字面代码把持久化 `RunState` 原样传给 `runLoopFromState` 会触发 `executing→executing` 非法转移、把成功续跑打成 `failed`。修法：`resumeLoop` 把非-`planning` 的 resumable 状态归一化为 `planning`（保留 `attemptsUsed`/`budgetSnapshot`/`recentFailures`），恰好符合 spec §7 next-attempt-fresh。未改 `runLoop`/`stateMachine`。
  - **bug-040**：Task 3 测试 helper 令 `ownerStatus` 被推断为 `string`，破坏全局 typecheck（因 Task 2/3 步骤只跑单测文件、没跑 typecheck 才漏掉）。修法：给 helper 加 `OwnerRecord` 类型标注。

## 验证证据（合并后在本地 main 上复跑）

| 项 | 结果 |
|---|---|
| `npm test -- --run`（全套件） | 17 files / 270 tests 全过 |
| `npm run typecheck` | 干净 |
| `npm run build` | 干净（exit 0） |

运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run ...`。
全流程 **未发生任何付费 Claude 调用**（纯 ScriptedAdapter）。

## 待办 / 未擅自执行（等人拍板）

1. **push 本 handoff 更新**：`origin/main` 已含 resume/adopt 合并；**本地尚未 push** 的仅是本 handoff 更新文档提交。是否 push 由人决定。
2. **删 feature 分支** `resume-adopt-continuation-20260725`（已并入 main，可 `git branch -d`）——未删。
3. **删 SDD workspace** `.superpowers/sdd/2026-07-25-resume-adopt-continuation/`（ledger + 各 task brief/report/diff；gitignored）——未删。
4. **剩余 deferred minor**（非阻塞，最终 review 已 triage）：gate accept 分支仅测 `executing`，未单独断言 `planning`/`verifying`；`ResumeNotEligibleError` 无直接 `.name`/`.message` 单测。详见 ledger `progress.md`。

## 关键事实（沿用，接手前仍需逐条核实）

- **已接受不可变证据集**（`.validation-runs/evidence/<id>/review.json`）：`A-04-08 PASS`、`B-02 PASS`、`C-05 PASS`、`D-01 INCONCLUSIVE/CONTRACT_GAP`、`E-01 PASS`。勿覆盖、勿原地重解释。
- **superseded 运行不是最终真相**：`B-01`、`C-01`~`C-04` 目录仍在但已被取代。
- **须保护、删除前必问的具名物**（当前均存在）：备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`（勿 push、勿删）；stash `stash@{0} pre-local-merge-evidence-first-v1-2026-07-18`、`stash@{1} pre-merge local changes 2026-07-16`；保留 fixture `.validation-runs/fixture-01`。
- **前沿（resume/adopt 之后仍未实现）**：scheduler、daemon、queue、lease、heartbeat、多任务协调。
- **两个 gotcha**：`validation/v1/scripts/run-scenario.ts` 已 canonicalize 脚本路径（勿回退 macOS `/var` vs `/private/var` 修复）；`claudeChildExited` 仍为 `NOT_OBSERVABLE`，除非有被跟踪的后代 PID 证明。

## 仍然生效的治理边界

- 每次真实 Claude 调用前须显式获批（付费）。
- 不覆盖已接受的 `review.json`；`D-01` 保持 `INCONCLUSIVE / CONTRACT_GAP`，重解释走单独的 `review-reclassified.json`。
- `stale-confirmed` / `reconciliation-record.json` **本身不授权继续执行或接管**；auto-takeover 仍 deny-by-default。resume 已实现，但同样**只消费**已发布 transfer、不自行判断接管。
- 不做 `git clean` / `reset --hard` / 广域 `restore`；不删 `.validation-runs/`、备份分支、stash。

## 参考（按路径读，勿在此复制内容）

- 本次设计 / 计划：见上「本次做了什么」。
- SDD ledger（过程与逐 task review 结论）：`.superpowers/sdd/2026-07-25-resume-adopt-continuation/progress.md`（gitignored）。
- bug 记录：`.wolf/buglog.json`（bug-040、bug-041；gitignored）。
- 前序 ownership/reconciliation 设计：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`、对应 plan。
- 校验层：`validation/v1/README.md`、`validation/v1/lib/evidence.ts`。
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`。

## 建议接手时调用的 skills

- `superpowers:verification-before-completion` — 声称「通过/完成」前复跑 typecheck / build / 全套件并贴真实输出。
- `superpowers:finishing-a-development-branch` — 若要决定 push / 删 feature 分支 / 清理 SDD workspace。
- `superpowers:brainstorming` → `writing-plans` → `subagent-driven-development` — 若开工下一前沿项（scheduler / daemon / queue / lease / heartbeat）。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
