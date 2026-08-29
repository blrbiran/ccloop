# ccloop

一个 **L2 自治度**的代码任务循环控制器：你写一份**契约（contract）**声明目标、边界和验收标准，ccloop 反复执行「计划 → 执行 → 验证」直到进入某个终态，全过程把状态和证据落盘。

它自己不写代码，也不判断对错——真正干活的是 **adapter**（一个子进程，通常是 `claude -p`）。ccloop 负责的是：预算、隔离、崩溃恢复、所有权仲裁、证据留痕。

> **状态**：V1，`private: true`，未发布到 npm。仅支持 macOS / Linux。

---

## 1. 心智模型

```
contract.json ──▶ ccloop run ──▶ ┌──────────────────────────────┐
                                 │  attempt N                   │
                                 │   plan → execute → verify    │──▶ approved? ──▶ succeeded
                                 │   （在独立 git worktree 里）   │        │
                                 └──────────────────────────────┘        └──▶ 下一次 attempt
                                              │
                                        全程写入 runDir/
```

三个关键分离：

| 谁 | 管什么 |
|---|---|
| **contract** | 目标、边界、预算、验收标准。人写，机器不改。 |
| **controller**（ccloop 本体） | 循环、预算扣减、worktree 隔离、状态机、租约与所有权、崩溃后续跑 |
| **adapter** | 一次 phase 的实际执行。stdin 收 JSON 请求，stdout 吐 JSON 结果。 |

**controller 永不 push、永不合并、永不删分支**——这些是人的动作。

---

## 2. 安装

```bash
cd /path/to/ccloop
npm install
npm run build          # 产出 dist/cli.js
```

然后二选一：

```bash
# 直接跑
node dist/cli.js <command> ...

# 或开发模式（免 build）
npm run dev -- <command> ...      # tsx src/cli.ts
```

想全局有 `ccloop` 命令，`npm link` 即可（`package.json` 已声明 `bin`）。

自检：

```bash
npm run typecheck
npm test              # vitest run
```

---

## 3. 五个子命令

| 命令 | 干什么 | 退出码 |
|---|---|---|
| `run` | 从契约开一个新循环 | `0` succeeded / `2` 其他终态 / `1` 参数或加载失败 |
| `resume` | 接管一个被中断的 run，从落盘状态续跑 | 同上 |
| `ls` | 扫描一个根目录下所有 run，报告**观测到的**字段 | `0` / `1`（根目录本身读不了） |
| `sweep` | 批量续跑：扫描 + 挑出 `eligibleForContinuation=true` 的 run，逐个 adopt | `0` / `1` |
| `unlock` | 处理卡住的 owner-transfer 锁 | `0` 锁已不在 / `1` 任何拒绝 |

### 3.1 `run`

```bash
node dist/cli.js run \
  --contract   examples/v1/minimal-contract.json \
  --run-dir    /tmp/ccloop-runs/task-1 \
  --adapter    scripted \
  --adapter-config examples/v1/scripted-adapter-config.json
```

四个 flag **全部必填**，没有默认值。

⚠️ `--run-dir` 必须是**干净的**：如果里面已经有 `loop-state.json`、`events.jsonl` 或非空的 `worktrees/`，`run` 会直接报错退出。V1 不支持在已有 run 上重新初始化——想续跑请用 `resume`。

### 3.2 `resume`

```bash
node dist/cli.js resume \
  --run-dir /tmp/ccloop-runs/task-1 \
  --adapter claude \
  --adapter-config examples/v1/claude-adapter-config.json
```

不需要 `--contract`：契约已经在 run 目录里了。resume 会做所有权判定（这个 run 还归不归我）、边界分析（上次停在哪个 phase）、必要时走 owner-transfer。

### 3.3 `ls`

```bash
node dist/cli.js ls /tmp/ccloop-runs           # 人读的表
node dist/cli.js ls --json /tmp/ccloop-runs    # 机器读的 {schemaVersion:1, rows:[...]}
```

输出里每一行是一次**观测**，不是一次判定。表头那句 consistency notice 是契约的一部分：

> 同一行里的各字段是相互独立的观测，**不构成一致快照**；`eligibleForContinuation` 是一个被观测到的字段，**不是「这个 run 可以被续跑」的结论**。

读 `ls` 输出时请认真对待这句话——它是设计意图，不是免责声明。

### 3.4 `sweep`

```bash
node dist/cli.js sweep \
  --root /tmp/ccloop-runs \
  --adapter claude \
  --adapter-config examples/v1/claude-adapter-config.json \
  --max-runs 5
```

- `--max-runs` 必须是**字面上的正整数**（`1e3`、`2abc` 一律拒绝，不做容错解析）。它是人批准这次 sweep 的上限。
- 它 bound 的是**进入的 run 数**，不是 attempt 总数——每个 run 各自还有自己契约里的 `maxAttempts`。
- 顺序是硬的：先读 adapter config（读不了就 exit 1，一个 run 都不扫），再扫描，再打 banner，最后才构造 adapter。

### 3.5 `unlock`

```bash
node dist/cli.js unlock /tmp/ccloop-runs/task-1                       # 只在锁可安全判定为死锁时删
node dist/cli.js unlock /tmp/ccloop-runs/task-1 --force --expect <sha256>
```

`--force` **必须**配 `--expect <锁文件的 sha256>`，这一约束在参数解析层就成立（类型上无法表达「force 但没有 digest」）。反过来，只给 `--expect` 不给 `--force` 也会被拒——不会被静默忽略。

所有拒绝一律 exit 1（fail closed）。

---

## 4. 停止一个正在跑的循环

`SIGINT` / `SIGTERM`：

- **第一次**：设置停止标志，循环跑到**下一个边界**再干净退出（状态与证据完整落盘）。
- **第二次**：立刻退出，exit code `130`。

两个信号共用一个计数器——「Ctrl-C 之后再 kill」这条最常见的升级路径能真正走到第二档。

---

## 5. 契约怎么写

Schema 在 `src/contract/schema.ts`（zod，`.strict()`——**多一个字段就报错**）。完整示例见 `examples/v1/minimal-contract.json`。六个必填块：

```jsonc
{
  "objective": {
    "taskId": "example-1",
    "goal": "……",                 // 要做成什么
    "successCondition": "……",     // 什么算做成了
    "nonGoals": ["……"]            // 明确不做什么
  },
  "context": {
    "repoPath": ".",              // worktree 从这个仓库开
    "targetPaths": ["src"],       // 至少一个
    "relevantDocs": [],
    "buildTestCommands": ["npm test"],   // 至少一个
    "constraints": ["smallest possible diff"]
  },
  "executionPolicy": {
    "autonomyLevel": "L2",        // V1 只接受 "L2"
    "maxAttempts": 3,
    "perAttemptTimeoutMs": 300000,
    "totalRuntimeBudgetMs": 900000,
    "tokenBudget": 200000,
    "worktreeRequired": true,     // V1 只接受 true
    "partialOutcomeRecoveryWindowMs": 1000   // execute 被中止后，允许它再吐一次部分结果的窗口
  },
  "safetyPolicy": {
    "allowlistPaths": ["src/**"],
    "denylistPaths": [".env", "auth/**"],
    "maxFilesTouched": 10,
    "humanGateConditions": ["touches gated path"]
  },
  "verification": {
    "verifierType": "agent",      // "command" | "agent"
    "requiredChecks": ["……"],     // 至少一个
    "rejectOn": ["tests fail"],   // 至少一个
    "evidenceRequired": ["command output"]
  },
  "escalationAndExit": {
    "escalationTargets": ["human"],
    "pauseOn": ["missing information"],
    "stopOn": ["budget exhausted"],
    "terminalStates": [ /* 必须**恰好**是下面这五个，不多不少 */ ]
  }
}
```

**终态（五个，全集固定）**：

| 终态 | 含义 |
|---|---|
| `succeeded` | 验证通过 |
| `blocked_waiting_human` | 需要人做决定，循环主动停 |
| `exhausted` | 预算（attempt / 时间 / token）耗尽 |
| `cancelled` | 被停止信号取消 |
| `failed` | 失败 |

`terminalStates` 必须包含且**只**包含这五个——写少写多写重都会被 schema 拒绝。这不是配置项，是让契约把 V1 的全集显式承认下来。

---

## 6. Adapter：真正干活的那一层

Adapter 契约（`src/runtime/types.ts`）有三个 phase：`plan` / `execute` / `verify`。ccloop 通过 stdin 发一个 JSON 请求，从 stdout 读一个 JSON 结果。

### 6.1 `scripted`——用来测试和演示

```json
{ "frames": [ { "plan": {...}, "execution": {...}, "verification": {...} } ] }
```

一个 frame 就是一次 attempt 的三段回放。不调任何模型，**确定性**，测试和跑通链路时用它。见 `examples/v1/scripted-adapter-config.json`。

### 6.2 `claude`——真跑

```json
{ "command": ["node", "scripts/claude-phase-runner.mjs"] }
```

`command` 是一个**任意子进程**——ccloop 不关心它内部怎么实现，只要满足「stdin 收 JSON、stdout 吐 JSON、exit 0」。

仓库自带的 `scripts/claude-phase-runner.mjs` 是参考实现，它做了这些事：

- 在 `request.worktreePath` 里调 `claude -p --output-format json --json-schema <该 phase 的 schema> <prompt>`，用 JSON Schema 硬约束模型输出。
- 用 `git status --porcelain=v1 -z --untracked-files=all` + `git diff` 采集本次 attempt 真实改了哪些文件、diff 是什么——**不信模型自报**。
- 从 claude 的 `usage` 里提取 token 计数（同时兼容 `input_tokens` / `inputTokens` 两种字段名），并把「字段缺失 / 类型不对 / 非有限数」各自记成不同的观测状态，而不是悄悄当 0。
- 收到 `SIGTERM` / `SIGINT` 时，在 `partialOutcomeRecoveryWindowMs` 窗口内尽量吐出一份带 `completionStatus: "partial"` 的部分结果。

要接别的模型或别的工具链，照着这个文件的 IO 契约另写一个即可，然后把 `command` 指过去。

### 6.3 Prompt 从哪来

`src/runtime/claude/prompts.ts` 从契约机械生成三个 phase 的 prompt。其中两条硬约束值得单独指出：

- executor 的 prompt 里写着 **"Never declare final success; only report what changed in this attempt."**——判定成功是 verifier 的职责，不是 executor 的。
- verifier 的 prompt 会把 `rejectOn` 和 `evidenceRequired` 原样注入，并要求「证据缺失即 `approved: false`」。

---

## 7. Run 目录长什么样

以下是一次真实 scripted 跑完之后的实测结果：

```
<runDir>/
├── loop-contract.json      # 契约的副本 —— 所以 resume 不需要 --contract
├── loop-state.json         # 状态机快照（原子写）
├── owner-record.json       # 所有权：epoch、进程实例 id、租约续期时间
├── owner-transfer.json     # 仅在发生过所有权移交时出现
├── events.jsonl            # 追加式事件流，一行一个事件
├── attempts/
│   └── 1/
│       ├── plan.json           # plan phase 的输出
│       ├── execution.json      # execute phase 的输出
│       ├── verify.json         # verify phase 的输出（含 approved / evidence）
│       ├── diff.patch          # 这次 attempt 的实际 diff
│       └── stdout-stderr.log
└── worktrees/                  # 跑完之后是空的，见下
```

`events.jsonl` 长这样：

```jsonc
{"type":"loop_planning","at":"…","detail":"run initialized and ready to plan"}
{"type":"attempt_started","at":"…","detail":"attempt 1"}
{"type":"execute_started","at":"…","detail":"attempt 1"}
{"type":"execution_finished","at":"…","detail":"attempt 1"}
{"type":"loop_succeeded","at":"…","detail":"success condition satisfied"}
```

**关于 `worktrees/`**：每次 attempt 会在 `worktrees/attempt-<n>/` 开一个 detached worktree
（`git worktree add --detach`，cwd 是 `context.repoPath`），attempt 结束后 ccloop 会
`git worktree remove --force` 掉它。所以正常跑完之后这个目录是空的——里面留着东西说明有 attempt 没走完清理。
主工作树全程不被触碰（实测：跑完之后 `git worktree list` 在源仓库里没有多出任何条目）。

`loop-state.json` 里的 `RunState`：

```ts
{
  status,               // queued | planning | executing | verifying | 五个终态
  currentAttempt, attemptsUsed, lastTransitionAt,
  waitingOnHuman, stopReason,
  budgetSnapshot: { attemptsRemaining, timeRemainingMs, tokenBudgetRemaining },
  recentFailures: [{ rejectCategory, primaryTargetPaths, failingCommand }]
}
```

`recentFailures` 里那个三元组叫 **failure fingerprint**：循环靠它识别「又栽在同一个地方」，而不是靠自然语言比对。

---

## 8. 所有权与租约（为什么这套代码这么重）

多个 ccloop 进程可能同时看到同一个 run 目录（比如两个 sweep、或一次 resume 撞上一个还活着的 run）。ccloop 的处理方式是：

- **租约 + 心跳**：run 的所有者持续续租；心跳停了，别的进程才可能接管。
- **owner-transfer 锁**：接管是一次跨进程加锁的事务（acquire → recover → 三次 rename → release），不是一次「谁先写谁赢」。
- **fail closed**：碰到读不懂的锁，宁可抛错停下，也不假装它是死锁然后删掉它。`unlock --force` 需要人给出锁文件的 sha256——**人亲手确认过这个锁是那个锁**。

如果你只是单进程跑一个 run，这些你都感觉不到。它们存在是因为并发场景下「悄悄抢走一个还活着的 run」的代价是数据丢失。

---

## 9. 五分钟跑通（scripted，不花钱）

```bash
npm install && npm run build
RUN_DIR=$(mktemp -d)/run-1

node dist/cli.js run \
  --contract examples/v1/minimal-contract.json \
  --run-dir "$RUN_DIR" \
  --adapter scripted \
  --adapter-config examples/v1/scripted-adapter-config.json
echo "exit=$?"        # 期望 0

cat "$RUN_DIR/loop-state.json"          # status 应为 succeeded
cat "$RUN_DIR/events.jsonl"
ls  "$RUN_DIR/attempts/1"               # plan.json execution.json verify.json diff.patch …
node dist/cli.js ls "$(dirname "$RUN_DIR")"
```

`--run-dir` 指向一个**还不存在**的路径也可以，ccloop 会建。

⚠️ `minimal-contract.json` 里 `context.repoPath` 是 `"."`，所以请在一个 **git 仓库**里跑，否则 `git worktree add` 会失败。

跑通之后再把 `--adapter` 换成 `claude`、`--adapter-config` 换成 `examples/v1/claude-adapter-config.json`，就是真跑了。**先确认你能承受它的 token 开销**。

---

## 10. 已知边界

- **V1 不支持在已有 run 目录上重新 `run`**——只能 `resume`。
- **契约 schema 是 `.strict()` 的**：多写一个字段就整份拒绝。这是故意的。
- **`ls` 报的是观测，不是结论**。别把 `eligibleForContinuation=true` 当成「可以放心续跑」。
- **成本不由 ccloop 估算**。它记录 adapter 报上来的 usage；拿不到就记成「拿不到」，不猜。
- 整套测试目前在 macOS 上绿；**Linux 上有已知红项**，见 `docs/handoff/handoff.md`。

---

## 11. 更多材料

| 想知道什么 | 看哪里 |
|---|---|
| 当前进度、待办、历史裁决 | `docs/handoff/handoff.md`（入口）、`.superpowers/sdd/**/progress.md`（真相源） |
| 每个特性的设计与实施计划 | `docs/superpowers/specs/`、`docs/superpowers/plans/` |
| 循环工程的方法论背景 | `docs/ref/LoopEngineering.md`、`docs/ref/loop-how-to-stop.md` |
| 本仓库的协作规则 | `CLAUDE.md` |
