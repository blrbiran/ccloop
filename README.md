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

作为 Orca 的依赖时，Orca 用 git URL 钉到一个提交（`"ccloop": "github:blrbiran/ccloop#<commit>"`）。npm 会在临时 clone 里装 devDependencies、跑 `prepare`（即 `npm run build`），再只打包 `package.json` 的 `files` 列出的东西——所以除了 `dist/`，运行时从包根读的 `scripts/claude-phase-runner.mjs` 与它 import 的 `scripts/claude-stream.mjs` 也必须在 `files` 里（`tests/packaging/gitDependency.test.ts` 守着这一点）。副作用：在本仓库里 `npm install` 也会顺带 build 一次。

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
  --contract        examples/v1/minimal-contract.json \
  --run-dir         /tmp/ccloop-runs/task-1 \
  --agents          /abs/private/agents.json \
  --agent-selection /abs/private/selection.json
```

四个 flag **全部必填**，没有默认值。`--agents` 是 agents 表（装了哪些 agent CLI、各在哪、什么版本），`--agent-selection` 是这一次选哪个、用什么 model，连同它的 `configHash`——两份文件怎么来见 §6.0。

`run --agents` 会把校验过的选择**冻结**进 `<runDir>/agent-selection.json`（`0600`，已存在就拒绝、不覆盖）。之后 `resume`／`sweep` 不再收 `--agent-selection`，只用这份冻结的选择对着**当时的** agents 表重建 adapter——选择对应的配置变了（kind、`configDir`、kind 自己的字段或 selection；hash 对不上）或 CLI 升级了（版本漂移），都会在动 run 目录之前拒绝。

⚠️ `--run-dir` 必须是**干净的**：如果里面已经有 `loop-state.json`、`events.jsonl` 或非空的 `worktrees/`，`run` 会直接报错退出；留着一份 `agent-selection.json`（比如上一次 `run --agents` 冻结后中途失败）也会被拒绝，退出码 1，错误码 `agent-selection-exists`。V1 不支持在已有 run 上重新初始化——想续跑请用 `resume`。

### 3.2 `resume`

```bash
node dist/cli.js resume \
  --run-dir /tmp/ccloop-runs/task-1 \
  --agents  /abs/private/agents.json
```

不需要 `--agent-selection`：用的是 `run --agents` 冻结在 `<runDir>/agent-selection.json` 里的那份；没有这份文件的 run 目录（不是 `run --agents` 起的）会被拒绝。不需要 `--contract`：契约已经在 run 目录里了。resume 按顺序检查，任何一步不通过就拒绝：

- 租约还新鲜（owner 还在续约）⇒ 拒绝。
- run 目录是 Orca control store 里的 control run（`<dir>/run`，同级有 `control/` 目录）⇒ 拒绝，那类 run 由 Orca 自己恢复。
- run 里登记过、还没结束的 claude / codex 进程组：先回收（终止），回收不了或无法确认身份就拒绝。每个被回收的进程组记一条 `orphan_process_group_reaped` 事件。
- 没有 `owner-transfer.json` 的 run（进程被杀、没有人交接过）：只在 run 状态可续跑（planning / executing / verifying）、并且确认旧 owner 进程已经死亡时，resume 自己写下 owner-transfer 和 reconciliation 记录并接管（事件 `owner_crash_adopted`，随后是 `resume_adopted`）。owner 还活着，或者死活无法确定，一律拒绝。
- 之后照旧：8 条续跑资格检查、认领、继续跑 loop。

Ctrl-C 的后果：单次 Ctrl-C（或 SIGTERM）让 loop 在下一个 phase 边界停下，然后释放租约再退出；第二次 Ctrl-C 立即以退出码 130 退出，不释放租约。两种情况下，只要进程已经不在了，状态可续跑的 run 都能被 `resume` 接管（租约过期之后；`kill -9` 同理）。claude 的 runner 在父进程死后约 5 秒内自行退出（codex 没有这层保护）；仍残留的进程组由 resume 回收。单次 Ctrl-C 释放租约这一点，这里没有单独的测试钉住。

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
  --root     /tmp/ccloop-runs \
  --agents   /abs/private/agents.json \
  --max-runs 5
```

每个被挑中的 run 各用**它自己**冻结的 `agent-selection.json` 建 adapter，所以一次 sweep 里不同 run 可以是不同的 agent。

- `--max-runs` 必须是**字面上的正整数**（`1e3`、`2abc` 一律拒绝，不做容错解析）。它是人批准这次 sweep 的上限。
- 它 bound 的是**进入的 run 数**，不是 attempt 总数——每个 run 各自还有自己契约里的 `maxAttempts`。
- 候选有两类。(a) `owner-transfer.json` 里 `eligibleForContinuation` 观测为 `true`，banner 照旧只数这一类；(b) 被直接杀掉的 run：没有 `owner-transfer.json`、状态是 `planning`/`executing`/`verifying`、`leaseAffirmedAt` 是比 `LEASE_TTL_MS` 更早的时间戳（`null` 不算；Orca 控制 run 不算），仅在 K > 0 时多打一行 `sweep: <K> run(s) under <root> have no owner-transfer.json, a resumable status and an expired lease (observed fields; each is resumed only if its owner is confirmed dead)`。(b) 只是观测字段的筛选，owner 是否真的死了由 resume 判定，没死就拒绝。
- 顺序是硬的：先读 agents 表（读不了就 exit 1，一个 run 都不扫），再扫描，再打 banner，最后才逐个 run 构造 adapter（某个 run 的 adapter 建不起来，那一个 run 报 `refused`）。

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
    "rejectOn": ["tests fail"],   // 至少一个；交给 verifier 判断的拒绝条件，ccloop 不在 evidence 里搜它。command verifier 下不起作用——按输出拒绝请写成检查命令（如 ! grep -q 'tests fail' out.log）
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

### 6.0 agents 表与选择文件：CLI 唯一的入口

> consolidation step 4（2026-10-01）删掉了 `--adapter`／`--adapter-config`。`run`／`resume`／`sweep` 带上其中任何一个都会 exit 1，报 `unknown flag --adapter`（或 `unknown flag --adapter-config`）——和别的不认识的 flag 一样，没有专门的提示。现在 CLI 只认 `--agents`。

agents 表（`ccloop-agents-table-v1`）登记装了哪些 agent CLI。`node dist/cli.js agents detect` 在 PATH 和常见安装目录里找 codex／claude，打印一份草稿表（只打到 stdout，不写任何文件）；挑出要的条目存成文件，再用 `agents validate` 核对版本：

```bash
node dist/cli.js agents detect                          # 草稿：{"schema":"ccloop-agents-detect-v1","table":{...},"candidates":[...]}
node dist/cli.js agents validate /abs/private/agents.json   # 每条安装的 --version 是否与表里一致
```

表文件必须是**绝对路径、就是它自己的 realpath**（macOS 上 `/tmp` 要写成 `/private/tmp`），文件和所在目录都属于当前用户、组和其他人不可写。一条 codex 安装长这样：

```json
{ "schema": "ccloop-agents-table-v1",
  "installations": { "codex": {
    "kind": "codex", "command": ["/abs/path/to/codex"], "version": "0.155.1", "configDir": null,
    "timeoutMs": 120000, "killGraceMs": 250, "sandbox": "workspace-write", "budgetMode": "soft" } } }
```

选择文件是 `{"selection": {...}, "configHash": "<64 位 hex>"}`。两个字段都向 ccloop 要，不要手算：

```bash
echo '{"agent":{"agent":"codex","model":"<model>"}}' \
  | node dist/cli.js control capabilities --agents /abs/private/agents.json
# 回答里的 selection 与 configHash 原样抄进选择文件
```

`run` 时 ccloop 会对着当时的表重算一遍：版本对不上报 `agent-version-drift`，hash 对不上报 `control-config-hash-mismatch`，都在读契约、动 run 目录之前。

### 6.1 `scripted`——只在测试里

`ScriptedAdapter`（`{ "frames": [ { "plan": {...}, "execution": {...}, "verification": {...} } ] }`，一个 frame 就是一次 attempt 的三段回放）还在，但它只是一个库类：测试直接 new 它喂给 `runLoop`／`resumeLoop`。CLI 已经没有选它的路——`examples/v1/scripted-adapter-config.json` 随 `--adapter` 一起删了。

### 6.2 `claude`——真跑

claude 只经由 `run --agents <table> --agent-selection <file>`（及其后的 `resume`／`sweep --agents`）或 `control` 跑。`ClaudeAgentAdapter`（`src/runtime/claude/claudeAgentAdapter.ts`）每个 phase 起一个 `scripts/claude-phase-runner.mjs` 子进程：stdin 收 JSON 请求、stdout 吐 JSON 结果。

仓库自带的 `scripts/claude-phase-runner.mjs` 是参考实现，它做了这些事：

- 在 `request.worktreePath` 里调 `claude -p --output-format stream-json --verbose --include-partial-messages --json-schema <该 phase 的 schema> <prompt>`，用 JSON Schema 硬约束模型输出。
- 用 `git status --porcelain=v1 -z --untracked-files=all` + `git diff` 采集本次 attempt 真实改了哪些文件、diff 是什么——**不信模型自报**。
- 从 claude 的 `usage` 里提取 token 计数（同时兼容 `input_tokens` / `inputTokens` 两种字段名），并把「字段缺失 / 类型不对 / 非有限数」各自记成不同的观测状态，而不是悄悄当 0。
- 收到 `SIGTERM` / `SIGINT` 时，在 `partialOutcomeRecoveryWindowMs` 窗口内尽量吐出一份带 `completionStatus: "partial"` 的部分结果。

runner 是固定的：`ClaudeAgentAdapter` 总是起这个 `scripts/claude-phase-runner.mjs`，不能换成别的 runner。能配的只有 agents 表里的 `installation.command`——也就是 runner 去调的那个 claude CLI。

### 6.3 Prompt 从哪来

`src/runtime/claude/prompts.ts` 从契约机械生成三个 phase 的 prompt。其中两条硬约束值得单独指出：

- executor 的 prompt 里写着 **"Never declare final success; only report what changed in this attempt."**——判定成功是 verifier 的职责，不是 executor 的。
- verifier 的 prompt 会把 `rejectOn` 和 `evidenceRequired` 原样注入，并要求「证据缺失即 `approved: false`」。

---

## 7. Run 目录长什么样

以下是一次 run 跑完之后 run 目录的结构（`agent-selection.json` 由 `run --agents` 写入）：

```
<runDir>/
├── loop-contract.json      # 契约的副本 —— 所以 resume 不需要 --contract
├── agent-selection.json    # run --agents 冻结的选择（0600）—— resume／sweep 靠它重建 adapter
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

### Attempt commit：worktree 被移除之前，改动会先被提交并钉上一个 ref

`git worktree remove --force` 之前，ccloop 会把 attempt worktree 里的东西 `git add -A` ＋ commit，
并写一个 ref 让它在 worktree 消失之后仍然可达：

```
refs/ccloop/<run-id>/attempts/<n>
```

`<run-id>` 是 run 目录的 basename，`<n>` 与 `attempts/<n>/` 那个产物目录一一对应。
attempt 的**基点就是这笔提交的第一个父提交**，所以想知道某次 attempt 改了什么：

```bash
git for-each-ref --format='%(refname) %(objectname)' 'refs/ccloop/<run-id>/attempts/'
git diff --name-only <sha>^ <sha>
```

**什么都没改的 attempt 也会有一笔提交**（`--allow-empty`）。所以「**有 ref 但 diff 为空**」＝
agent 什么都没干，「**没有 ref**」＝发布失败 —— 这两件事不是一回事，而后者在 `events.jsonl` 里有
`attempt_commit_publish_failed`。**发布成功不记事件**：ref 本身就是产物，
`git for-each-ref` 已经能回答「发布了没有」，再记一条只是重复。

提交身份用 `-c user.name=ccloop -c user.email=ccloop@invalid` 显式传，不依赖环境里的 git config ——
一次性 clone 与 CI 容器常常没有可用身份，那正是这个功能最该工作的场景。

`attempts/<n>/diff.patch` **一个字节没变**，它仍然是给人看的证据。但它**不是**给机器用的那一份：
它那两处 `git diff` 都没有 `--binary`，且 `readGitDiff` 的 catch 只对 `code === 1` 返回 stdout、
其余一律返回空串。

**已知代价**（都不是 bug，是这个设计换来的）：

- **ref 会堆积。** 一个 attempt 一个 ref，ccloop **不会**清理它们 —— 删 ref 不可逆，按铁律要人单独授权。
  run 多了之后 `git for-each-ref refs/ccloop/` 会很长。
- **对象库会变大。** attempt 的改动此前随 worktree 一起消失，现在有 ref 拽着，gc 不会收。
- **被 gitignore 的文件不会进去。** `git add -A` 尊重 `.gitignore`。
- **临时文件会进去。** agent 在 worktree 里留下的任何东西都会进这笔提交。`diff.patch` 本来也收，
  所以这不是新问题，但值得知道。

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

## 9. 跑通一次（codex）

⚠️ **CLI 上没有不调模型的跑法了。** 以前这里用 `--adapter scripted`，它随 consolidation step 4（2026-10-01）删了。测试套件不花钱，是因为它把 agents 表的 `command` 指向假的 codex（`tests/fixtures/fake-codex.mjs`）——那是测试夹具，不是给用户的生产路径。下面这条会真调 codex，**先确认你能承受它的 token 开销**。

```bash
npm install && npm run build
PRIV=$(cd "$(mktemp -d)" && pwd -P)       # 表必须在自己的 realpath 上
RUN_DIR="$PRIV/runs/run-1"

node dist/cli.js agents detect             # 从草稿里取 codex 那条，存成 "$PRIV/agents.json"（见 §6.0）
chmod 600 "$PRIV/agents.json"
echo '{"agent":{"agent":"codex","model":"<model>"}}' \
  | node dist/cli.js control capabilities --agents "$PRIV/agents.json"
# 把回答里的 selection 与 configHash 存成 "$PRIV/selection.json"：{"selection":…,"configHash":…}

node dist/cli.js run \
  --contract examples/v1/minimal-contract.json \
  --run-dir "$RUN_DIR" \
  --agents "$PRIV/agents.json" \
  --agent-selection "$PRIV/selection.json"
echo "exit=$?"        # 期望 0

cat "$RUN_DIR/loop-state.json"          # status 应为 succeeded
cat "$RUN_DIR/events.jsonl"
ls  "$RUN_DIR/attempts/1"               # plan.json execution.json verify.json diff.patch …
cat "$RUN_DIR/agent-selection.json"     # run --agents 冻结的选择，resume／sweep 用它
node dist/cli.js ls "$(dirname "$RUN_DIR")"
```

`--run-dir` 指向一个**还不存在**的路径也可以，ccloop 会建。

⚠️ `minimal-contract.json` 里 `context.repoPath` 是 `"."`，所以请在一个 **git 仓库**里跑，否则 `git worktree add` 会失败。

想换 claude：表里加一条 claude 安装，选择文件里 `agent` 换成它的 id（见 §6.2）。

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
