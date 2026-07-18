# Claude Usage Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不运行真实 Claude、也不改变 V1 停止策略的前提下，把 Claude usage 的白名单归一化证据持久化到标准 phase artifacts，并证明 controller 的 token 预算扣减与这些 artifacts 完全一致。

**Architecture:** `scripts/claude-phase-runner.mjs` 仍是唯一能看到 Claude JSON envelope 的边界；它用一个纯归一化函数同时生成 `usageEvidence` 与 `tokenUsage`。`SubprocessClaudeAdapter`、controller 和现有 `fileStore` 只负责按类型传输和原样持久化；wrapper 单元测试覆盖字段语义与脱敏，controller 集成测试通过 fake `claude` 可执行文件覆盖 plan → execute → verify → artifact/budget 的完整路径。

**Tech Stack:** TypeScript 5.5、Node.js ESM、Vitest 2、Claude CLI JSON wrapper（测试中仅使用 fake executable）、Git worktrees。

## Global Constraints

- 实现目标仅位于 `.worktrees/evidence-first-v1`；不要在 main checkout 实现产品代码。
- 不得运行真实 Claude，不得执行 A-04；所有 Claude 行为必须由测试创建的 fake executable 提供。
- 不得保存完整 Claude envelope、prompt、assistant text、凭证、未知 usage 字段或价格估算。
- 不得改变 token budget 阈值、重试规则、状态转换、停止优先级或 attempt accounting。
- `usageEvidence` 只允许出现在 Claude-backed `plan`、`execute`、`verify` results；`ScriptedAdapter` 无需伪造它。
- 旧 artifacts 无 `usageEvidence` 时仍保持可读；不得迁移或重写 A-01、A-02、A-03。
- interruption/error fallback partial execute 必须同时省略 `usageEvidence` 和 `tokenUsage`，不得从不完整 stdout 推断 usage。
- 每个方向 snake_case 优先于 camelCase；aliases 是替代关系，不能累加重复别名。
- 只有有限且大于零的 selected sum 才成为 `normalizedTotal`/`tokenUsage`；零、负数或加法溢出后的非有限总和均归一化为 `null`，并省略 `tokenUsage`。
- 不新增依赖，不 push，不 merge，不修改或清理已保留的 `.validation-runs/` 证据。

---

## File Map

- Modify: `.worktrees/evidence-first-v1/src/runtime/types.ts` — 定义共享的 `UsageFieldEvidence` / `UsageEvidence`，并把可选证据挂到三个 phase result 类型。
- Modify: `.worktrees/evidence-first-v1/scripts/claude-phase-runner.mjs` — 白名单提取、别名选择、总数归一化，并用同一结果生成 `usageEvidence` 和 `tokenUsage`。
- Modify: `.worktrees/evidence-first-v1/tests/runtime/claude/subprocessClaudeAdapter.test.ts` — fake Claude wrapper 的字段语义、脱敏、overflow 与 partial omission 回归测试。
- Modify: `.worktrees/evidence-first-v1/tests/controller/runLoop.integration.test.ts` — 通过 `SubprocessClaudeAdapter` + fake Claude CLI 验证 controller 预算与三个持久化 artifacts 同源。
- Modify: `.worktrees/evidence-first-v1/.superpowers/sdd/progress.md` — 在所有验证通过后记录本增量的 commits、测试结果与 A-04 仍未运行。
- Modify: `.worktrees/evidence-first-v1/.wolf/cerebrum.md` / `.wolf/buglog.json` / `.wolf/memory.md` — 仅按 OpenWolf hooks 的强制要求记录实际发现、错误和检查点；不要预先制造条目。

### Task 1: 定义并生成白名单 Usage Evidence

**Files:**
- Modify: `.worktrees/evidence-first-v1/src/runtime/types.ts:15-54`
- Modify: `.worktrees/evidence-first-v1/scripts/claude-phase-runner.mjs:94-118,400-415`
- Test: `.worktrees/evidence-first-v1/tests/runtime/claude/subprocessClaudeAdapter.test.ts:143-217,313-384`

**Interfaces:**
- Produces:
  - `UsageFieldEvidence = { status: "absent" | "finite" | "non_finite" | "invalid_type"; value?: number }`
  - `UsageEvidence = { usageStatus; fields; selectedInputField; selectedOutputField; normalizedTotal }`
  - `AttemptPlan.usageEvidence?: UsageEvidence`
  - `ExecutionArtifacts.usageEvidence?: UsageEvidence`
  - `VerificationResult.usageEvidence?: UsageEvidence`
  - wrapper response invariant: `tokenUsage` exists iff `usageEvidence.normalizedTotal` is a finite positive number, and the values are equal.
- Consumes: Claude JSON envelope field `usage`; no caller may pass the complete envelope beyond the wrapper.

- [ ] **Step 1: 扩展 wrapper 测试 helper，使其同时断言 usage evidence 与敏感字段过滤**

在 `tests/runtime/claude/subprocessClaudeAdapter.test.ts` 中把 usage table 扩展为包含 expected evidence，并增加一个完整白名单断言。测试数据至少包含：

```ts
{
  label: "duplicate camel and snake aliases without double counting",
  usageLiteral: `{
    input_tokens: 100,
    output_tokens: 25,
    inputTokens: 999,
    outputTokens: 888,
    cache_creation_input_tokens: 77,
    secretSentinel: "DO_NOT_PERSIST"
  }`,
  expectedTokenUsage: 125,
  expectedUsageEvidence: {
    usageStatus: "present",
    fields: {
      input_tokens: { status: "finite", value: 100 },
      inputTokens: { status: "finite", value: 999 },
      output_tokens: { status: "finite", value: 25 },
      outputTokens: { status: "finite", value: 888 },
    },
    selectedInputField: "input_tokens",
    selectedOutputField: "output_tokens",
    normalizedTotal: 125,
  },
}
```

在 assertion 中使用精确相等而不是只用 `toMatchObject` 检查 `usageEvidence`：

```ts
expect(outcome.payload.usageEvidence).toEqual(testCase.expectedUsageEvidence);
expect(outcome.payload.tokenUsage).toBe(testCase.expectedTokenUsage);
expect(JSON.stringify(outcome.payload)).not.toContain("cache_creation_input_tokens");
expect(JSON.stringify(outcome.payload)).not.toContain("DO_NOT_PERSIST");
```

同时为 `usage` 缺失和 `usage: null` 增加 raw-envelope cases，分别期望 `usageStatus: "absent"` 与 `usageStatus: "invalid"`，四个字段均为 `{ status: "absent" }`，selected fields 与 `normalizedTotal` 均为 `null`，且 payload 不含 `tokenUsage`。

- [ ] **Step 2: 运行新增 wrapper 测试并确认它因缺少 usageEvidence 失败**

Run:

```bash
npm --prefix .worktrees/evidence-first-v1 test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts
```

Expected: FAIL；至少出现 `expected undefined to deeply equal` 或等价的 `usageEvidence` 缺失断言，现有 token alias 测试仍可执行。

- [ ] **Step 3: 在共享 runtime types 中加入精确类型并挂到三个 phase result**

在 `src/runtime/types.ts` 中加入：

```ts
export type UsageFieldEvidence = {
  status: "absent" | "finite" | "non_finite" | "invalid_type";
  value?: number;
};

export type UsageEvidence = {
  usageStatus: "present" | "absent" | "invalid";
  fields: {
    input_tokens: UsageFieldEvidence;
    inputTokens: UsageFieldEvidence;
    output_tokens: UsageFieldEvidence;
    outputTokens: UsageFieldEvidence;
  };
  selectedInputField: "input_tokens" | "inputTokens" | null;
  selectedOutputField: "output_tokens" | "outputTokens" | null;
  normalizedTotal: number | null;
};
```

然后把同一可选字段加入 `AttemptPlan`、`ExecutionArtifacts` 和 `VerificationResult`：

```ts
usageEvidence?: UsageEvidence;
```

不要修改 `ScriptedFrame` 或 `ScriptedAdapter`；它们会通过现有 result 类型自动兼容该可选字段。

- [ ] **Step 4: 用一个纯函数替换 getTokenUsage，单次生成证据与总数**

在 `scripts/claude-phase-runner.mjs` 中用以下结构替换 `getTokenUsage`：

```js
const USAGE_FIELDS = ["input_tokens", "inputTokens", "output_tokens", "outputTokens"];

function inspectUsageField(usage, field) {
  if (!Object.prototype.hasOwnProperty.call(usage, field)) {
    return { status: "absent" };
  }

  const value = usage[field];
  if (typeof value !== "number") {
    return { status: "invalid_type" };
  }

  if (!Number.isFinite(value)) {
    return { status: "non_finite" };
  }

  return { status: "finite", value };
}

function buildUsageEvidence(envelope) {
  const rawUsage = envelope && typeof envelope === "object" ? envelope.usage : undefined;
  const usageStatus = rawUsage === undefined
    ? "absent"
    : rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? "present"
      : "invalid";
  const usage = usageStatus === "present" ? rawUsage : {};
  const fields = Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, inspectUsageField(usage, field)]),
  );
  const selectedInputField = fields.input_tokens.status === "finite"
    ? "input_tokens"
    : fields.inputTokens.status === "finite"
      ? "inputTokens"
      : null;
  const selectedOutputField = fields.output_tokens.status === "finite"
    ? "output_tokens"
    : fields.outputTokens.status === "finite"
      ? "outputTokens"
      : null;
  const selectedValues = [selectedInputField, selectedOutputField]
    .filter((field) => field !== null)
    .map((field) => fields[field].value);
  const total = selectedValues.reduce((sum, value) => sum + value, 0);
  const normalizedTotal = selectedValues.length > 0 && Number.isFinite(total) && total > 0
    ? total
    : null;

  return {
    usageStatus,
    fields,
    selectedInputField,
    selectedOutputField,
    normalizedTotal,
  };
}
```

在 `main()` 成功解析完整 envelope 后只调用一次：

```js
const usageEvidence = buildUsageEvidence(envelope);
const response = usageEvidence.normalizedTotal === null
  ? { ...structured, usageEvidence }
  : { ...structured, usageEvidence, tokenUsage: usageEvidence.normalizedTotal };
```

不要把 `usage` 或 envelope spread 进 response。不要修改 `buildPartialExecutionOutcome()`；中断/error fallback 继续不含 usage 字段。

- [ ] **Step 5: 运行 focused tests 与 typecheck，确认基础实现通过**

Run:

```bash
npm --prefix .worktrees/evidence-first-v1 test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts
npm --prefix .worktrees/evidence-first-v1 run typecheck
```

Expected: focused test file 全部 PASS（基线为 20 tests，新增 case 后数量增加）；typecheck PASS。

- [ ] **Step 6: 提交 Task 1**

先检查并只暂存本任务文件：

```bash
git -C .worktrees/evidence-first-v1 status --short
git -C .worktrees/evidence-first-v1 diff -- src/runtime/types.ts scripts/claude-phase-runner.mjs tests/runtime/claude/subprocessClaudeAdapter.test.ts
git -C .worktrees/evidence-first-v1 add src/runtime/types.ts scripts/claude-phase-runner.mjs tests/runtime/claude/subprocessClaudeAdapter.test.ts
git -C .worktrees/evidence-first-v1 commit -m "feat: persist Claude usage evidence"
```

Expected: 新 commit 只包含上述三个文件；不要暂存现有 SDD scratch、`dist/`、复制的 docs 或 OpenWolf metadata。

### Task 2: 覆盖无效值、溢出与 Partial Omission

**Files:**
- Modify: `.worktrees/evidence-first-v1/tests/runtime/claude/subprocessClaudeAdapter.test.ts:143-217,313-384,523-622`
- Modify only if a failing test proves necessary: `.worktrees/evidence-first-v1/scripts/claude-phase-runner.mjs:94-140,267-284`

**Interfaces:**
- Consumes: Task 1 的 `UsageEvidence` shape 和 `buildUsageEvidence(envelope)` 行为。
- Produces: 确定性边界测试，证明所有四个字段的状态、fallback、非有限总和处理，以及 partial fallback 不伪造 usage。

- [ ] **Step 1: 写参数化边界测试**

在现有 raw-envelope helper 上增加以下独立 cases；每个 case 都精确断言 `usageEvidence`、`tokenUsage` 是否存在，并检查 `JSON.stringify(payload)` 不包含未知字段或 sentinel：

```ts
[
  {
    label: "invalid types",
    usage: {
      input_tokens: "100",
      inputTokens: { value: 100 },
      output_tokens: null,
      outputTokens: true,
    },
    statuses: ["invalid_type", "invalid_type", "invalid_type", "invalid_type"],
    normalizedTotal: null,
  },
  {
    label: "negative and fractional values preserve current semantics",
    usage: { input_tokens: -2.5, output_tokens: 10 },
    selectedInputField: "input_tokens",
    selectedOutputField: "output_tokens",
    normalizedTotal: 7.5,
  },
  {
    label: "zero total is not reported",
    usage: { input_tokens: -10, output_tokens: 10 },
    normalizedTotal: null,
  },
]
```

使用 raw JSON 字符串单独覆盖：

```ts
'{"structured_output":{...},"usage":{"input_tokens":1e400,"inputTokens":100,"output_tokens":25}}'
```

期望 `input_tokens.status === "non_finite"`，选择 `inputTokens`，总数为 `125`。

再覆盖两个单独有限但相加溢出的值：

```ts
usage: { input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE }
```

期望两个字段均为 `finite`，但 `normalizedTotal === null`，payload 不含 `tokenUsage`。测试 source 可由 fake executable 在运行时调用 `JSON.stringify` 生成，以保留两个 `Number.MAX_VALUE` 值。

- [ ] **Step 2: 写 partial omission 测试**

扩展现有 interruption 与 non-zero-exit partial tests，加入精确断言：

```ts
expect(execution).not.toHaveProperty("usageEvidence");
expect(execution).not.toHaveProperty("tokenUsage");
```

以及对 phase runner raw payload：

```ts
expect(partial).not.toHaveProperty("usageEvidence");
expect(partial).not.toHaveProperty("tokenUsage");
```

这一步不要求 fake Claude 输出半截 JSON；目标是证明 fallback 不根据 incomplete/unavailable envelope 发明证据。

- [ ] **Step 3: 运行 focused test 并确认新测试的真实状态**

Run:

```bash
npm --prefix .worktrees/evidence-first-v1 test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts
```

Expected: 如果 Task 1 实现完整，全部 PASS；若 overflow case 暴露 `normalizedTotal` 或 `tokenUsage` 非有限，则 FAIL 并明确指向该断言。不要为制造 RED 而故意破坏已正确的 Task 1 实现。

- [ ] **Step 4: 仅在测试失败时做最小修正，然后重跑**

允许的修正范围只限 `buildUsageEvidence()`：确保总数判断同时要求：

```js
selectedValues.length > 0 && Number.isFinite(total) && total > 0
```

Run:

```bash
npm --prefix .worktrees/evidence-first-v1 test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts
npm --prefix .worktrees/evidence-first-v1 run typecheck
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交 Task 2**

```bash
git -C .worktrees/evidence-first-v1 diff -- tests/runtime/claude/subprocessClaudeAdapter.test.ts scripts/claude-phase-runner.mjs
git -C .worktrees/evidence-first-v1 add tests/runtime/claude/subprocessClaudeAdapter.test.ts
# 仅当本任务确实修正 wrapper 时，再显式 add scripts/claude-phase-runner.mjs
git -C .worktrees/evidence-first-v1 commit -m "test: cover Claude usage evidence boundaries"
```

Expected: commit 主要是边界回归测试；不得包含生成证据或 run artifacts。

### Task 3: 证明 Controller Accounting 与 Phase Artifacts 同源

**Files:**
- Modify: `.worktrees/evidence-first-v1/tests/controller/runLoop.integration.test.ts:1-36,77-end`
- Use without modifying unless test proves a defect: `.worktrees/evidence-first-v1/src/runtime/claude/subprocessClaudeAdapter.ts:13-146`
- Use without modifying unless test proves a defect: `.worktrees/evidence-first-v1/src/controller/runLoop.ts:168-199,317-329,392-410,470-654`

**Interfaces:**
- Consumes:
  - `SubprocessClaudeAdapter({ command: ["node", phaseRunnerPath] })`
  - Task 1 wrapper output containing `usageEvidence` and optional `tokenUsage`
  - standard persisted `plan.json`, `execution.json`, `verify.json`
- Produces: one controller integration test proving initial budget minus persisted phase totals equals final persisted budget for the same attempt.

- [ ] **Step 1: 在 controller test 中加入 fake Claude CLI helper**

新增 imports：

```ts
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SubprocessClaudeAdapter } from "../../src/runtime/claude/subprocessClaudeAdapter.js";
```

新增常量与 helper：

```ts
const phaseRunnerPath = fileURLToPath(new URL("../../scripts/claude-phase-runner.mjs", import.meta.url));

async function createUsageAwareFakeClaude(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "ccloop-controller-claude-bin-"));
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? "";
let structured_output;
let usage;
if (prompt.includes("Plan one isolated L2 attempt")) {
  structured_output = { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
  usage = { input_tokens: 100, output_tokens: 10, inputTokens: 999, secretSentinel: "DO_NOT_PERSIST" };
} else if (prompt.includes("Execute one isolated attempt")) {
  structured_output = { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" };
  usage = { inputTokens: 200, outputTokens: 20, unknown_usage: 777 };
} else {
  structured_output = { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["verified"], pauseSignals: [], stopSignals: [] };
  usage = { input_tokens: 300, outputTokens: 30 };
}
process.stdout.write(JSON.stringify({ structured_output, usage }));
`);
  await chmod(claudePath, 0o755);
  return binDir;
}
```

该 helper 仅创建本地 fake binary，不访问网络或真实 Claude。

- [ ] **Step 2: 写 controller-level 集成测试**

新增测试，使用 `verifierType: "agent"`、`requiredChecks: ["true"]`、`tokenBudget: 1000`，临时把 fake bin 置于 PATH，运行：

```ts
const adapter = new SubprocessClaudeAdapter({ command: ["node", phaseRunnerPath] });
const finalState = await runLoop(contract, runDir, adapter);
```

读取：

```ts
const attemptDir = join(runDir, "attempts", "1");
const plan = JSON.parse(await readFile(join(attemptDir, "plan.json"), "utf8"));
const execution = JSON.parse(await readFile(join(attemptDir, "execution.json"), "utf8"));
const verify = JSON.parse(await readFile(join(attemptDir, "verify.json"), "utf8"));
const persistedState = await readRunState(runDir);
```

精确断言：

```ts
expect(finalState.status).toBe("succeeded");
expect(plan.tokenUsage).toBe(110);
expect(execution.tokenUsage).toBe(220);
expect(verify.tokenUsage).toBe(330);
expect(plan.usageEvidence.normalizedTotal).toBe(plan.tokenUsage);
expect(execution.usageEvidence.normalizedTotal).toBe(execution.tokenUsage);
expect(verify.usageEvidence.normalizedTotal).toBe(verify.tokenUsage);
expect(persistedState.budgetSnapshot.tokenBudgetRemaining).toBe(1000 - 110 - 220 - 330);
expect(JSON.stringify({ plan, execution, verify })).not.toContain("DO_NOT_PERSIST");
expect(JSON.stringify({ plan, execution, verify })).not.toContain("unknown_usage");
```

同时断言三份 evidence 的 selected aliases 与 fake envelope 对应，证明 phase/attempt 未串线。`finally` 中恢复原始 `PATH`。

- [ ] **Step 3: 运行测试并确认它先因未接通的集成细节失败或直接通过**

Run:

```bash
npm --prefix .worktrees/evidence-first-v1 test -- --run tests/controller/runLoop.integration.test.ts
```

Expected: 若 Task 1 的 transport/persistence 已自然接通，则新测试直接 PASS；否则 FAIL 必须明确表现为字段丢失、预算不一致或 fake CLI 调用错误。不要把“必须先失败”置于验证真实设计之上。

- [ ] **Step 4: 若失败，做最小实现修正**

允许的修正按失败原因限定：

- 若 TypeScript transport 丢字段：只修 `src/runtime/types.ts` 的可选字段。
- 若 wrapper response 丢字段：只修 `scripts/claude-phase-runner.mjs` 的 response construction。
- 若 verifier contract 丢字段：保留 `enforceVerificationContract()` 的 spread 语义，不新增第二套 usage 计算。
- 若 `fileStore` 原样 JSON 持久化已工作，不要修改它。
- 不得在 controller 内重新计算 aliases 或 `normalizedTotal`。

- [ ] **Step 5: 运行 focused controller、wrapper 与 typecheck**

```bash
npm --prefix .worktrees/evidence-first-v1 test -- --run tests/controller/runLoop.integration.test.ts tests/runtime/claude/subprocessClaudeAdapter.test.ts
npm --prefix .worktrees/evidence-first-v1 run typecheck
```

Expected: 两个 test files 全部 PASS，typecheck PASS；没有真实 Claude 调用。

- [ ] **Step 6: 提交 Task 3**

```bash
git -C .worktrees/evidence-first-v1 diff -- tests/controller/runLoop.integration.test.ts src/runtime/types.ts scripts/claude-phase-runner.mjs src/runtime/claude/subprocessClaudeAdapter.ts src/controller/runLoop.ts src/persistence/fileStore.ts
git -C .worktrees/evidence-first-v1 add tests/controller/runLoop.integration.test.ts
# 仅显式 add 被失败测试证明必须修改的产品文件
git -C .worktrees/evidence-first-v1 commit -m "test: verify Claude usage accounting end to end"
```

Expected: 默认只提交 controller integration test；若产品修正必要，commit 中必须有对应失败测试证据。

### Task 4: 全量验证、文档化结果并停在 A-04 Gate 前

**Files:**
- Modify: `.worktrees/evidence-first-v1/.superpowers/sdd/progress.md`
- Modify as required by OpenWolf only: `.worktrees/evidence-first-v1/.wolf/cerebrum.md`
- Modify as required by OpenWolf only: `.worktrees/evidence-first-v1/.wolf/buglog.json`
- Modify as required by OpenWolf only: `.worktrees/evidence-first-v1/.wolf/memory.md`

**Interfaces:**
- Consumes: Tasks 1-3 commits and test evidence。
- Produces: 可恢复的 SDD checkpoint；明确说明 deterministic gate 已验证、A-04 未获批准且未运行。

- [ ] **Step 1: 运行完整确定性验证**

Run sequentially:

```bash
npm --prefix .worktrees/evidence-first-v1 test
npm --prefix .worktrees/evidence-first-v1 run typecheck
npm --prefix .worktrees/evidence-first-v1 run build
```

Expected baseline before this increment was 13 test files / 104 tests；新增 tests 后所有 test files 与 tests 均 PASS，typecheck PASS，build PASS。必须记录实际数量，不得沿用估计值。

这些命令不会调用真实 Claude，因为所有新增 Claude paths 都通过测试创建的 fake executable 覆盖 PATH。

- [ ] **Step 2: 做隐私与 scope 机械检查**

Run:

```bash
rg -n "DO_NOT_PERSIST|secretSentinel|unknown_usage|cache_creation_input_tokens" \
  .worktrees/evidence-first-v1/src \
  .worktrees/evidence-first-v1/scripts
```

Expected: no output；sentinels 只能存在于 tests。

Run:

```bash
git -C .worktrees/evidence-first-v1 diff --check
git -C .worktrees/evidence-first-v1 status --short
```

Expected: `diff --check` no output；status 中历史 scratch/untracked material 仍存在但未被清理或广泛暂存。

- [ ] **Step 3: 更新 durable progress ledger**

在 `.superpowers/sdd/progress.md` 追加一行，使用实际 commit SHA 与验证数字：

```text
Claude usage evidence: complete (commits <first>..<last>; whitelisted phase evidence + fake-Claude controller accounting; <focused/full test counts>; typecheck/build pass; no real Claude call; A-04 unapproved and unrun)
```

如果任何 test/typecheck/build 未通过，不得写 `complete`；保持任务未完成并记录 blocker。

- [ ] **Step 4: 按 OpenWolf 要求记录实际学习与错误**

只记录本次真实发生的事项：

- 若发现新的项目 convention，更新 `.wolf/cerebrum.md`。
- 若命令或测试失败、修复 defect，先/后按协议更新 `.wolf/buglog.json`。
- 在 `.wolf/memory.md` 追加验证 checkpoint。

不要为“可能发生”的错误预写 buglog。验证 JSON metadata 可解析：

```bash
node -e "JSON.parse(require('fs').readFileSync('.worktrees/evidence-first-v1/.wolf/buglog.json','utf8')); console.log('buglog valid')"
```

Expected: `buglog valid`。

- [ ] **Step 5: 提交进度与必要 metadata**

```bash
git -C .worktrees/evidence-first-v1 diff -- .superpowers/sdd/progress.md .wolf/cerebrum.md .wolf/buglog.json .wolf/memory.md
git -C .worktrees/evidence-first-v1 add .superpowers/sdd/progress.md
# 仅对本任务实际变更且已审阅的 OpenWolf 文件逐个显式 add
git -C .worktrees/evidence-first-v1 commit -m "docs: record Claude usage evidence validation"
```

Expected: commit 不包含 `dist/`、validation run artifacts、copied design docs 或无关 scratch files。

- [ ] **Step 6: 最终 review gate**

对本增量从 Task 1 前的 base SHA 到当前 HEAD 请求独立 code review，重点检查：

- `usageEvidence` 白名单是否可能泄漏未知字段；
- `tokenUsage` 是否只来自 `normalizedTotal`；
- controller 是否没有第二套 alias 算法；
- partial fallback 是否确实省略 usage；
- fake-Claude controller integration 是否同时证明三 phase artifacts 与最终 budget；
- 未触发任何真实 Claude 或 A-04。

若有 Critical/Important finding，修复、重跑 Task 4 全部验证并创建新 commit；不得 amend 或跳过 hooks。

- [ ] **Step 7: 停止，不执行 A-04**

向用户报告 deterministic gate 的实际结果，并单独说明：

```text
A-04 仍未获批准，也没有运行。下一步需要另行提出 fresh contract/run/evidence paths 与精确 budgets，等待明确批准。
```

不得在本计划内 render 或执行 A-04，不得复用 A-01/A-02/A-03 paths。
