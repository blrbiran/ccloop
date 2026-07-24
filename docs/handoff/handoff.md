# ccloop Handoff — ownership + reconciliation 已落地本地 main

> 写于 2026-07-24。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> 本文不硬钉 git HEAD：提交本文即会改变 HEAD。用下面的“如何定位当前状态”自查。

## 一句话现状

Task 5（ownership + reconciliation 边界）实现已 **本地合并进 main（`--no-ff`，未 push）**；最后一个 validation 兼容性 blocker 已修复，全套件 / typecheck / build 均绿。

## 如何定位当前状态（不要照抄 commit hash）

```bash
git -C /Users/biran/code/skills/loop/ccloop log --oneline --decorate -6
git -C /Users/biran/code/skills/loop/ccloop status --branch --short
git rev-parse origin/main   # 应仍指向合并前的 main（本地合并未 push）
```

- main 顶部应能看到一条 `Merge branch 'ownership-reconciliation-boundaries-20260723'` 合并提交。
- 该合并带入 13 个 commit / 完整 Task 5 实现；其中最后两个是本次收尾：
  - `fix: accept owner-transfer fields in reconciliation validation`（validation 兼容修复）
  - `chore: log reconciliation validation compat fix (bug-038)`
- **origin/main 未变**：这是本地合并，尚未 push。是否 push 由人决定。

## 本次做了什么（细节看 commit / buglog，勿在此重复）

- 根因与修复详见 `.wolf/buglog.json` 的 `bug-038`。
- 一句话：controller 真实写出 `ownershipVerdict / priorOwnerEpoch / newOwnerEpoch / eligibleForContinuation`，而 `validation/v1/lib/evidence.ts` 的 `reconciliationRecordSchema` 曾被收窄回旧 shape 且保留 `.strict()`，把真实产物误判 INVALID。修法：这 4 个字段改为 `.optional()`、保留 `.strict()` —— validation 只「容忍/读取」，不强制、不删除；未知乱键仍 fail loud。新增回归测试见 `tests/validation/evidence.test.ts`。
- 关键判断：不要把这些字段设为**必填**（历史提交 `84bd66a` 这么做过），那会反过来拒绝 transfer 之前的旧产物，即所谓「Task 5 专属强约束泄漏」。optional 是正解。

## 验证证据（均在合并后的 main 上复跑）

| 项 | 结果 |
|---|---|
| `npm test -- --run`（全套件） | 15 files / 243 tests 全过 |
| validation evidence | 39/39 |
| `npm run typecheck` | 干净 |
| `npm run build` | 干净 |

运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run ...`。

## 待办 / 未擅自执行（等人拍板）

1. **worktree 与分支未清理**：`.worktrees/ownership-reconciliation-boundaries-20260723`（分支同名）保留。合并已验证通过，如需清理可用 `superpowers:finishing-a-development-branch` 流程，但删除前须人确认。
2. **本地 main 未 push**：`origin/main` 仍是合并前状态；是否 push 由人决定。
3. worktree 内有个无关未跟踪文件 `src/.DS_Store`，本次未动。

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
- **一个小的一致性 follow-up**：cleanup 成功后，`execution-recovery.json.cleanupStatus` 与 `reconciliation-record.json.conflictingEvidence` 应保持终态一致；这是小尾巴，不是重开已接受证据的理由。

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
- `superpowers:finishing-a-development-branch` — 若要清理已合并的 worktree / 分支或决定 push。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
