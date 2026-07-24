# ccloop Handoff — ownership + reconciliation 已落地；cleanupStatus 一致性 follow-up 已修并 push 到 origin/main

> 写于 2026-07-24，2026-07-25 更新（push + worktree/分支清理 + cleanupStatus 一致性 follow-up 已 push）。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> 本文不硬钉 git HEAD：提交本文即会改变 HEAD。用下面的“如何定位当前状态”自查。

## 一句话现状

Task 5（ownership + reconciliation 边界）实现已合并进 main（`--no-ff`）**并已推到 `origin/main`**；全套件 / typecheck / build 均绿。此后的 **cleanupStatus 终态一致性 follow-up 修复（bug-039）也已 push 到 `origin/main`**。唯一可能本地领先、待 push 的是「本 handoff 更新」文档提交。遗留的 agent worktree 与 scratch 分支已**全部清理**（详见「已完成的收尾」）。

## 如何定位当前状态（不要照抄 commit hash）

```bash
git -C /Users/biran/code/skills/loop/ccloop log --oneline --decorate -6
git -C /Users/biran/code/skills/loop/ccloop status --branch --short
git rev-parse HEAD origin/main   # 若 HEAD 领先，多出的仅是「本 handoff 更新」文档提交，尚未 push
git log origin/main..HEAD --oneline   # 看清「本地领先、待 push」的具体是哪几笔（预期只有本 handoff 更新）
```

- `origin/main` 顶部应能看到 `fix: keep cleanupStatus out of reconciliation conflictingEvidence`（bug-039），再往下是 `Merge branch 'ownership-reconciliation-boundaries-20260723'` 合并提交。
- 该合并带入完整 Task 5 实现；合并内最后两个是当时收尾：
  - `fix: accept owner-transfer fields in reconciliation validation`（validation 兼容修复，bug-038）
  - `chore: log reconciliation validation compat fix (bug-038)`
- **origin/main 已含**合并提交 + bug-039 修复 + 之前的收尾/文档提交；唯一可能本地领先的是「本 handoff 更新」文档提交，push 与否由人决定。

## 本次做了什么（细节看 commit / buglog，勿在此重复）

- 根因与修复详见 `.wolf/buglog.json` 的 `bug-038`。
- 一句话：controller 真实写出 `ownershipVerdict / priorOwnerEpoch / newOwnerEpoch / eligibleForContinuation`，而 `validation/v1/lib/evidence.ts` 的 `reconciliationRecordSchema` 曾被收窄回旧 shape 且保留 `.strict()`，把真实产物误判 INVALID。修法：这 4 个字段改为 `.optional()`、保留 `.strict()` —— validation 只「容忍/读取」，不强制、不删除；未知乱键仍 fail loud。新增回归测试见 `tests/validation/evidence.test.ts`。
- 关键判断：不要把这些字段设为**必填**（历史提交 `84bd66a` 这么做过），那会反过来拒绝 transfer 之前的旧产物，即所谓「Task 5 专属强约束泄漏」。optional 是正解。

## cleanupStatus 一致性 follow-up（2026-07-25，bug-039，已修并 push）

- 这是原 handoff「小尾巴」的落地：cleanup 成功后 `execution-recovery.json.cleanupStatus` 变 `removed`，但 `reconciliation-record.json.conflictingEvidence` 仍嵌着 cleanup 快照前的 `retained`，两产物终态矛盾。
- 根因/修复详见 `.wolf/buglog.json` 的 `bug-039`。一句话：`buildBoundaryEvidence`（`src/controller/runLoop.ts`）曾把可变的 `cleanupStatus` 拼进 `conflictingEvidence`，而它是在 cleanup 之前拍的快照、之后只回写 execution-recovery。修法（方案 A）：从 `conflictingEvidence` 两处删掉 `with cleanup <status>` 半句，让 `cleanupStatus` 只有 execution-recovery.json 一个权威源；保留稳定的 `failureBoundary`。
- 回归测试：给既有 `tests/controller/runLoop.integration.test.ts` 的 abort-after-changing-files 用例加终态一致性断言（`conflictingEvidence` 不得含 `with cleanup`/`retained`）；已按 TDD 先 RED 后 GREEN。
- 关键判断：未动终态控制流顺序（方案 C 有触碰 D-scenario 校验依赖的风险），也未在 cleanup 后二次重跑 boundary/ownership（方案 B 有 `persistOwnerTransfer` 重入副作用）。选 A = 消除第二真相源，是根因修复而非补丁。

## 验证证据（bug-039 修复后在本地 main 上复跑；合并后 main 亦曾全绿）

| 项 | 结果 |
|---|---|
| `npm test -- --run`（全套件） | 15 files / 243 tests 全过 |
| validation evidence | 39/39 |
| `npm run typecheck` | 干净 |
| `npm run build` | 干净 |

运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run ...`。

## 已完成的收尾（不再是待办）

- **main 已 push**：`origin/main == 合并后 main`。
- **遗留 worktree / 分支已全部清理**：`.claude/worktrees/agent-*` 共 25 个 worktree 移除（17 个干净移除、8 个有 agent scratch 未提交改动的 `--force` 移除），37 个 `worktree-agent-*` / `task*` scratch 分支 `-D` 删除。丢弃的仅是 agent scratch（task 报告、`buglog.json`/`memory.md` 工作副本、一对已并入 main 的 `src` 顶层残留）。**`backup/evidence-first-v1-...`、两个 stash、`.validation-runs/` 均未动**。

## 待办 / 未擅自执行（等人拍板）

1. **push 本 handoff 更新**：`origin/main` 已含合并 + bug-039 修复 + 之前的收尾/文档提交；**本地尚未 push** 的仅是本 handoff 更新文档提交。是否 push 由人决定（用户偏好自己 push）。

## 关键事实（2026-07-24 已逐条核实）

- **已接受不可变证据集**（`.validation-runs/evidence/<id>/review.json`）：`A-04-08 PASS`、`B-02 PASS`、`C-05 PASS`、`D-01 INCONCLUSIVE/CONTRACT_GAP`、`E-01 PASS`。勿覆盖、勿原地重解释。
- **superseded 运行不是最终真相**：`B-01`、`C-01`、`C-02`、`C-03`、`C-04` 目录仍在但已被取代，勿当接受结论。
- **须保护、删除前必问的具名物**（当前均存在）：
  - 备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`（勿 push、勿删）
  - stash：`stash@{0} pre-local-merge-evidence-first-v1-2026-07-18`、`stash@{1} pre-merge local changes 2026-07-16`
  - 保留 fixture checkout `.validation-runs/fixture-01`
- **Task 5 已落地后仍未实现的前沿**（下一步方向，勿假设已存在）：resume/adopt 续跑、scheduler、daemon、queue、lease、heartbeat、多任务协调。
- **两个 gotcha**：
  - `validation/v1/scripts/run-scenario.ts` 已 canonicalize 调用脚本路径，闭合了 macOS `/var` vs `/private/var` 的 zero-exit / 无产物 bug —— 勿回退。
  - `claudeChildExited` 仍为 `NOT_OBSERVABLE`，除非有被跟踪的后代 PID 证明。
- **~~一个小的一致性 follow-up~~（2026-07-25 已修并 push，bug-039）**：cleanup 成功后 `execution-recovery.json.cleanupStatus` 与 `reconciliation-record.json.conflictingEvidence` 的终态一致性已修复并在 `origin/main`；详见上方「cleanupStatus 一致性 follow-up」。

## 仍然生效的治理边界

- 每次真实 Claude 调用前须显式获批（付费）。
- 不覆盖已接受的 `review.json`；`D-01` 保持 `INCONCLUSIVE / CONTRACT_GAP`，重解释走单独的 `review-reclassified.json`。
- `stale-confirmed` / `reconciliation-record.json` **本身不授权继续执行或接管**；auto-takeover 仍 deny-by-default。
- 不做 `git clean` / `reset --hard` / 广域 `restore`；不删 `.validation-runs/`、备份分支、stash。

## 参考（不要在此复制内容，按路径读）

- 设计 / 计划：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`、`docs/superpowers/plans/2026-07-22-ownership-and-reconciliation-boundaries.md`
- 校验层：`validation/v1/README.md`、`validation/v1/lib/evidence.ts`
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/buglog.json`

## 建议接手时调用的 skills

- `superpowers:verification-before-completion` — 声称任何东西“通过/完成”前，先复跑 typecheck / build / 全套件并贴出真实输出。
- `superpowers:systematic-debugging` — 若继续排障，先定位根因再改，勿照抄结论。
- `superpowers:finishing-a-development-branch` — 若产生新分支需收尾，或要决定 push（遗留 worktree/分支清理已完成）。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
