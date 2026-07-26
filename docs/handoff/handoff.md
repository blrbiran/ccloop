# ccloop Handoff — L1（run lease + heartbeat）spec 已冻结，待进 writing-plans

> 更新于 2026-07-26。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> 本文不硬钉 git HEAD：提交本文即会改变 HEAD。用下面「如何定位当前状态」自查。

## 一句话现状

**resume/adopt 续跑**（前沿第 1 项）已实现并 merge 进 `main`、已 push。本轮做了两件事：①收尾 resume/adopt 遗留的 deferred minor（补测试，270 → 274 tests）；②为下一前沿的**第一层 L1「run lease + heartbeat」**完成 brainstorming → spec → **六轮对抗式评审**，spec 现已冻结，**尚未写实施计划、尚未写任何实现代码**。本轮提交已有一部分 push 到 `origin/main`，其余仍在本地——具体以下面的自查命令为准。

## 如何定位当前状态（不要照抄 commit hash）

```bash
git -C /Users/biran/code/skills/loop/ccloop log --oneline --decorate -12
git -C /Users/biran/code/skills/loop/ccloop status --branch --short
git log origin/main..HEAD --oneline        # 本地领先、待 push 的全部提交
```

- 本轮共 10 笔提交（1 笔测试 + 8 笔 spec + 1 笔本 handoff）；其中较早的若干笔已在 `origin/main`，末尾几笔可能仍在本地。用上面第三条命令看实际待 push 的是哪几笔，不要假设数量。
- 唯一的代码改动是 `tests/controller/resumeLoop.gate.test.ts`；其余全是 `docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`。
- `src/` **零改动**（可用 `git diff origin/main..HEAD -- src/` 验证为空）。

## 本轮做了什么

### 1. 收尾 resume/adopt 的 deferred minor（已完成、已验证）

补两条测试：eligibility gate 的三个 accept 分支（`planning|executing|verifying`）各自断言；`ResumeNotEligibleError` 的 `.name`/`.message`/`instanceof` 直测。

**变异验证**（证明测试真能失败）：临时删掉白名单里的 `"verifying"`、把 `this.name` 改成 `"Error"` → 恰好各挂 1 条新测试；随后 `src/` 逐字改回，`git diff -- src/` 为空。顺带证实这个缺口是真的——变异前**没有任何既有测试**能发现白名单被删。

### 2. L1 spec：`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`

**前沿被切成五层**（spec §3）：L1 lease+heartbeat（本份）→ L2 registry/queue → L3 scheduler → L4 daemon → L5 cleanup/orphan GC。L1 优先，因为其上每一层都要判断 owner 新鲜度，而该判断今天**无法机械测量**。注意 L5 对应 ownership spec §17 的第三份后续 spec，**至今未写**。

**四个已确认的设计决定**（人拍板，勿擅自推翻）：lease = 证据 + 互斥（只增加拒绝、不增加授权）；心跳 = 墙钟定时器 **+** 特定 event 双写；新鲜度**接进** `evaluateOwnership`（但只往拒绝方向用）；`leaseFresh` 为**必填**字段。

**六轮评审的产出**（细节看 spec 与 commit message，勿在此重复）：共修 30 条缺陷，其中前四轮是真设计缺陷，后两轮多为「上一轮修法自己留下的尾巴」。最重要的两条：
- **P1 → B 方案**：owner record 新增 `leaseAffirmedAt: string | null`，**只有心跳**能写非 null 值。原因是 `lastAffirmedAt` 被 transfer / 初始建记录 / 认领三方写入，把它当「有人在跑」会**拒掉刚被 transfer 授权的那次 resume**。
- **Q1**：`stop()` 除停定时器外还须 CAS 释放（写回 `null`），否则跑完的 run 在一个 TTL 内仍占着租约。

### 3. 评审方法论（写进了 `.wolf/cerebrum.md`）

spec 自查只查「文档内部一致性」不够，必须把每条断言拿去和被引用模块的**实际行为对撞**。本轮三条阻塞级缺陷全部只有对撞才照得出来。教训：凡是「顺手」引用代码位置而没读上下文的地方，就是下一轮的缺陷来源（`runLoop.ts:734` 那次只看了一行、没看上一行的 `initializeRunFiles`，直接导致第三轮的 M1/M2）。

## 验证证据

| 项 | 结果 |
|---|---|
| `npm test -- --run`（基线） | 17 files / **270** tests 全过 |
| `npm test -- --run`（补测试后） | 17 files / **274** tests 全过 |
| `npm run typecheck` / `npm run build` | 均干净 |

运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`。
全流程**零付费 Claude 调用**（纯本地推理 + ScriptedAdapter）。

## 待办 / 未擅自执行

1. **push 剩余提交**——本轮已有部分进入 `origin/main`，末尾几笔可能仍在本地。是否 push 由人决定。
2. **进 `writing-plans` 出 L1 实施计划**——这是明确的下一步。spec 已自足，新 session 只读 spec 即可开工。
3. **L1 实施**：`src/ownership/lease.ts`（纯）、`src/controller/leaseHeartbeat.ts`、`fileStore` 增 `affirmOwnerLease` / `releaseOwnerLease` / `readOwnerRecordWithoutRecovery`，并改 `evaluateOwnership` 输入。spec §11 有完整签名，§12 有 19 条测试要求。
4. **`.superpowers/sdd/` 是跨会话共用的扁平目录**（不是本次专属），整删会毁掉前几次会话的 ledger 与 review diff。**建议不删**。

## 给实施者的重点提示

spec §12 的 19 条要求里，至少 6 条是**专门写来打死某个具体错误实现**的，实施时不要弱化它们：
心跳 expected 自我过期（第 5 条）、只取消定时器不释放（第 17 条）、`assertHeld` 复用节流（第 19 条）、损坏记录被当成「不存在」（第 7 条）、PID 复用（第 2 条）、transfer 后立即 resume 被拒（第 15 条）。

`leaseFresh` 改必填会让**所有既有 `evaluateOwnership` 构造点与测试 fixture** 编译不过，需显式传 `"unknown"`——这是计划里一个独立且不小的任务。

## 仍然生效的治理边界

- 每次真实 Claude 调用前须显式获批（付费）。
- 不覆盖已接受的 `review.json`；`D-01` 保持 `INCONCLUSIVE / CONTRACT_GAP`，重解释走单独的 `review-reclassified.json`。
- `stale-confirmed` / `reconciliation-record.json` **本身不授权继续执行或接管**；auto-takeover 仍 deny-by-default。resume 只消费已发布 transfer、不自行判断接管。
- **L1 不得引入任何新授权**：活租约只增加拒绝；租约过期**既不许可也不拒绝**（spec §4.1、§7）。
- 不做 `git clean` / `reset --hard` / 广域 `restore`；不删 `.validation-runs/`、备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`、`stash@{0}` / `stash@{1}`。

## 参考（按路径读，勿在此复制内容）

- **L1 设计**：`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`（唯一真相源）
- 父设计：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`（§5.5 freshness anchor、§7.1 owner-loss 条件、§17 后续 spec 清单）
- 兄弟设计：`docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md` 与对应 plan
- 借鉴/反面参照的外部实现：`reference/loop-engineering/tools/loop-worktree/README.md`、`reference/DoWhiz/DoWhiz_service/scheduler_module/`（spec 内已给到行号）
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/buglog.json`

## 建议接手时调用的 skills

- `superpowers:writing-plans` — **下一步**：把 L1 spec 转成实施计划。
- `superpowers:subagent-driven-development` — 执行该计划。
- `superpowers:test-driven-development` — §12 的 19 条要求天然是 TDD 的输入。
- `superpowers:verification-before-completion` — 声称「通过/完成」前复跑 typecheck / build / 全套件并贴真实输出。
- `superpowers:brainstorming` — 仅当要开 L2（registry/queue）或补 L5（cleanup/orphan GC）时。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
