# A-04 Preflight and Approval Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不触发真实 A-04 paid call 的前提下，把 A-04 的 contract freeze、deterministic preflight、approval package 生成和机械化检查步骤实现成可重复执行的本地 CLI 流程。

**Architecture:** 复用 `validation/v1` 现有的 scenario rendering、evidence schema 和 `run-scenario.ts` 命令形状，只新增一层 A-04 preparation helper + CLI。纯函数负责 execution-policy override、contract identity、approval package 和命令拼装；CLI 负责执行 deterministic preflight、写出冻结后的 A-04 contract，并把审批包打印到 stdout，不创建 A-04 run/evidence 目录，也不调用 Claude。

**Tech Stack:** TypeScript 5.5、Node.js ESM、Vitest 2、现有 `validation/v1` 脚本、Git、npm。

**Assessment boundary:** This branch assessment remains non-paid and non-destructive.

## Global Constraints

- 不得触发真实 Claude，不得运行 `validation/v1/scripts/run-scenario.ts` 的 paid call；本计划只实现 A-04 准备与审批前机械化步骤。
- 不得进入 V2，不得引入 retries、resume、reconciliation、scheduler、daemon、memory 机制或新的 runtime control surface。
- 必须保持 Scenario A 语义不变；允许修改的 contract 字段仅限 `executionPolicy.tokenBudget`、`executionPolicy.perAttemptTimeoutMs`、`executionPolicy.totalRuntimeBudgetMs`、`executionPolicy.partialOutcomeRecoveryWindowMs`。
- 目标 A-04 envelope 固定为：`tokenBudget 550000`、`perAttemptTimeoutMs 600000`、`totalRuntimeBudgetMs 1200000`、`partialOutcomeRecoveryWindowMs 5000`、`maxAttempts 1`、`automatic retries none`。
- approval package 必须展示：冻结后的 contract identity、expected file/diff scope、最多 3 个 Claude phases、`tokenBudget` 只是 controller stopping threshold 而不是 API cost cap、fixture clean、main checkout must remain unchanged。
- A-04 contract 路径可以在审批前创建；`.validation-runs/runs/A-04/` 与 `.validation-runs/evidence/A-04/` 在真实调用前必须保持不存在。
- deterministic preflight 必须机械执行：`npm test`、`npm run typecheck`、`npm run build`、`tests/validation/contracts.test.ts`、`tests/runtime/claude/subprocessClaudeAdapter.test.ts`、`tests/controller/runLoop.integration.test.ts`、`tests/validation/evidence.test.ts`。
- 新增或重命名文件后，必须按 OpenWolf 要求更新 `.wolf/anatomy.md`，并向 `.wolf/memory.md` 追加一行会话记录；如果学到新的项目约束，再更新 `.wolf/cerebrum.md`。
- 不新增依赖，不修改历史 A-01/A-02/A-03 证据，不 push，不 merge，不做任何 destructive cleanup。

---

## File Map

- Modify: `validation/v1/lib/scenarios.ts` — 为 Scenario A 渲染增加精确的 execution-policy override 支持，但保留其他场景默认值与现有 C/D `timeoutMs` 逻辑。
- Create: `validation/v1/lib/a04.ts` — 纯函数与可注入依赖的 orchestration helper；负责 A-04 路径、contract digest、preflight command list、approval package 结构与 deterministic checks。
- Create: `validation/v1/scripts/prepare-a04.ts` — CLI wrapper；解析 A-04 flags，执行 preflight，写出冻结 contract，并把审批包 JSON 打印到 stdout。
- Modify: `tests/validation/contracts.test.ts` — 覆盖 Scenario A execution-policy overrides，不回归现有 A-E rendering 语义。
- Create: `tests/validation/prepareA04.test.ts` — 覆盖 dirty fixture / existing path refusal、preflight command order、approval package fields、run/evidence dirs 保持未创建。
- Modify: `validation/v1/README.md` — 记录新的非 paid-call A-04 mechanical prepare 命令、输出字段、以及不创建 run/evidence dirs 的边界。
- Modify: `.wolf/anatomy.md` — 为 `validation/v1/lib/a04.ts`、`validation/v1/scripts/prepare-a04.ts`、`tests/validation/prepareA04.test.ts` 添加描述项。
- Modify: `.wolf/memory.md` — 追加实施检查点。

## Task 1: 支持冻结 A-04 contract 的 execution-policy overrides

**Files:**
- Modify: `validation/v1/lib/scenarios.ts`
- Modify: `tests/validation/contracts.test.ts`
- Test: `tests/validation/contracts.test.ts`

**Interfaces:**
- Produces:
  - `export type ExecutionPolicyOverrides = Partial<Pick<LoopContract["executionPolicy"], "tokenBudget" | "perAttemptTimeoutMs" | "totalRuntimeBudgetMs" | "partialOutcomeRecoveryWindowMs">>`
  - `renderScenario(id: ScenarioId, options: { repoPath: string; timeoutMs?: number; executionPolicyOverrides?: ExecutionPolicyOverrides }): LoopContract`
- Consumes:
  - Existing `DEFAULT_EXECUTION_POLICY`
  - Existing `loopContractSchema`

- [ ] **Step 1: 在 `tests/validation/contracts.test.ts` 里先写两个失败测试，锁定 override 语义**

把下面两个 `it(...)` 加到 `describe("validation scenario rendering", ...)` 和 `describe("render-contract CLI", ...)` 之前的纯函数区域里：

```ts
it("renders scenario A with explicit execution-policy overrides", () => {
  const contract = renderScenario("A", {
    repoPath: fixtureRepo,
    executionPolicyOverrides: {
      tokenBudget: 550000,
      perAttemptTimeoutMs: 600000,
      totalRuntimeBudgetMs: 1200000,
      partialOutcomeRecoveryWindowMs: 5000,
    },
  });

  expect(contract.executionPolicy).toMatchObject({
    maxAttempts: 1,
    tokenBudget: 550000,
    perAttemptTimeoutMs: 600000,
    totalRuntimeBudgetMs: 1200000,
    partialOutcomeRecoveryWindowMs: 5000,
  });
  expect(contract.objective.taskId).toBe("validation-v1-A");
  expect(contract.context.targetPaths).toEqual(["src/counter.js", "test/counter.test.js"]);
});

it("keeps non-overridden execution-policy fields unchanged", () => {
  const contract = renderScenario("A", {
    repoPath: fixtureRepo,
    executionPolicyOverrides: {
      tokenBudget: 550000,
    },
  });

  expect(contract.executionPolicy).toMatchObject({
    autonomyLevel: "L2",
    maxAttempts: 1,
    tokenBudget: 550000,
    perAttemptTimeoutMs: 300000,
    totalRuntimeBudgetMs: 600000,
    partialOutcomeRecoveryWindowMs: 3000,
    worktreeRequired: true,
  });
});
```

- [ ] **Step 2: 运行 targeted test，确认它因 `renderScenario` 还不接受 override 而失败**

Run:

```bash
npm test -- --run tests/validation/contracts.test.ts
```

Expected: FAIL，错误应类似 `Object literal may only specify known properties, and 'executionPolicyOverrides' does not exist` 或 `expected 50000 to be 550000`。

- [ ] **Step 3: 在 `validation/v1/lib/scenarios.ts` 中加入 override 类型与 merge 逻辑**

把 `RenderOptions` 和 execution policy 构建逻辑改成下面的形状：

```ts
export type ExecutionPolicyOverrides = Partial<
  Pick<
    LoopContract["executionPolicy"],
    | "tokenBudget"
    | "perAttemptTimeoutMs"
    | "totalRuntimeBudgetMs"
    | "partialOutcomeRecoveryWindowMs"
  >
>;

type RenderOptions = {
  repoPath: string;
  timeoutMs?: number;
  executionPolicyOverrides?: ExecutionPolicyOverrides;
};

function buildExecutionPolicy(
  id: ScenarioId,
  timeoutMs?: number,
  executionPolicyOverrides: ExecutionPolicyOverrides = {},
): LoopContract["executionPolicy"] {
  const perAttemptTimeoutMs =
    executionPolicyOverrides.perAttemptTimeoutMs ?? resolveTimeoutMs(id, timeoutMs);

  return {
    ...DEFAULT_EXECUTION_POLICY,
    ...executionPolicyOverrides,
    perAttemptTimeoutMs,
  };
}
```

然后把 `renderScenario(...)` 里的调用改成：

```ts
executionPolicy: buildExecutionPolicy(
  id,
  options.timeoutMs,
  options.executionPolicyOverrides,
),
```

不要修改 `ScenarioSpec`、`DEFAULT_EXECUTION_POLICY`、A-E 的业务语义，也不要把 `maxAttempts` 暴露成 override。

- [ ] **Step 4: 补一个负例测试，确保 override 仍受 schema 约束**

在 `tests/validation/contracts.test.ts` 追加：

```ts
it("rejects non-positive execution-policy overrides", () => {
  expect(() =>
    renderScenario("A", {
      repoPath: fixtureRepo,
      executionPolicyOverrides: { tokenBudget: 0 },
    }),
  ).toThrow();
});
```

这能防止后续 `prepare-a04.ts` 绕过 schema 直接写出非法 contract。

- [ ] **Step 5: 重新运行 contract tests，确认 A-E 旧语义未回归**

Run:

```bash
npm test -- --run tests/validation/contracts.test.ts
```

Expected: PASS；现有 A-E rendering tests 继续通过，新加入的 override tests 通过，C/D `timeoutMs` 要求仍保留。

- [ ] **Step 6: 提交 Task 1**

```bash
git status --short
git diff -- validation/v1/lib/scenarios.ts tests/validation/contracts.test.ts
git add validation/v1/lib/scenarios.ts tests/validation/contracts.test.ts
git commit -m "feat: support A-04 contract overrides"
```

Expected: commit 只包含这两个文件。

## Task 2: 实现 A-04 mechanical preflight helper 与 CLI

**Files:**
- Create: `validation/v1/lib/a04.ts`
- Create: `validation/v1/scripts/prepare-a04.ts`
- Create: `tests/validation/prepareA04.test.ts`
- Test: `tests/validation/prepareA04.test.ts`

**Interfaces:**
- Produces:
  - `type A04PrepareOptions = { repoRoot: string; fixturePath: string; contractPath: string; runDir: string; evidenceDir: string; adapterConfigPath: string; executionPolicyOverrides: Required<ExecutionPolicyOverrides>; }`
  - `type ApprovalPackage = { contractIdentity: { path: string; sha256: string; schemaValid: true }; executionPolicy: { tokenBudget: number; perAttemptTimeoutMs: number; totalRuntimeBudgetMs: number; partialOutcomeRecoveryWindowMs: number }; expectedFileScope: string[]; expectedDiffScope: string[]; exactCommand: string[]; usageEvidenceExpectations: string[]; invariants: { fixtureClean: true; mainCheckoutMustRemainUnchanged: true; maxClaudePhases: 3 } }`
  - `async function prepareA04(options: A04PrepareOptions, deps?: PrepareDeps): Promise<{ approvalPackage: ApprovalPackage; preflightCommands: string[] }>`
- Consumes:
  - `renderScenario("A", { repoPath, executionPolicyOverrides })`
  - existing `run-scenario.ts` CLI shape
  - existing `loopContractSchema`

- [ ] **Step 1: 先写 `tests/validation/prepareA04.test.ts` 的失败测试，冻结审批包字段与 preflight 顺序**

新建 `tests/validation/prepareA04.test.ts`，先放入下面三个 tests：

```ts
import { describe, expect, it, vi } from "vitest";
import { buildA04RunCommand, buildApprovalPackage, prepareA04 } from "../../validation/v1/lib/a04.js";
import { renderScenario } from "../../validation/v1/lib/scenarios.js";

describe("A-04 approval package", () => {
  it("builds a frozen approval package with contract identity and expected scope", () => {
    const contract = renderScenario("A", {
      repoPath: "/repo/.validation-runs/fixture-01",
      executionPolicyOverrides: {
        tokenBudget: 550000,
        perAttemptTimeoutMs: 600000,
        totalRuntimeBudgetMs: 1200000,
        partialOutcomeRecoveryWindowMs: 5000,
      },
    });

    const pkg = buildApprovalPackage({
      contract,
      contractPath: "/repo/.validation-runs/contracts/A-04.json",
      contractSha256: "abc123",
      fixturePath: "/repo/.validation-runs/fixture-01",
      runDir: "/repo/.validation-runs/runs/A-04",
      evidenceDir: "/repo/.validation-runs/evidence/A-04",
      adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
    });

    expect(pkg.contractIdentity).toEqual({
      path: "/repo/.validation-runs/contracts/A-04.json",
      sha256: "abc123",
      schemaValid: true,
    });
    expect(pkg.expectedFileScope).toEqual(["src/counter.js", "test/counter.test.js"]);
    expect(pkg.expectedDiffScope).toEqual(["src/**", "test/**"]);
    expect(pkg.executionPolicy).toEqual({
      tokenBudget: 550000,
      perAttemptTimeoutMs: 600000,
      totalRuntimeBudgetMs: 1200000,
      partialOutcomeRecoveryWindowMs: 5000,
    });
    expect(pkg.exactCommand).toEqual([
      "npx",
      "--no-install",
      "tsx",
      "validation/v1/scripts/run-scenario.ts",
      "--scenario",
      "A",
      "--contract",
      "/repo/.validation-runs/contracts/A-04.json",
      "--fixture",
      "/repo/.validation-runs/fixture-01",
      "--run-dir",
      "/repo/.validation-runs/runs/A-04",
      "--evidence-dir",
      "/repo/.validation-runs/evidence/A-04",
      "--adapter-config",
      "/repo/examples/v1/claude-adapter-config.json",
    ]);
  });

  it("refuses to prepare when run or evidence paths already exist", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      prepareA04(
        {
          repoRoot: "/repo",
          fixturePath: "/repo/.validation-runs/fixture-01",
          contractPath: "/repo/.validation-runs/contracts/A-04.json",
          runDir: "/repo/.validation-runs/runs/A-04",
          evidenceDir: "/repo/.validation-runs/evidence/A-04",
          adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
          executionPolicyOverrides: {
            tokenBudget: 550000,
            perAttemptTimeoutMs: 600000,
            totalRuntimeBudgetMs: 1200000,
            partialOutcomeRecoveryWindowMs: 5000,
          },
        },
        {
          pathExists: async (path) => path.endsWith("runs/A-04"),
          assertCleanFixture: async () => ({ head: "abc", status: "" }),
          runCommand,
          writeContract: async () => ({ contract: renderScenario("A", { repoPath: "/repo/.validation-runs/fixture-01" }), sha256: "abc123" }),
        },
      ),
    ).rejects.toThrow(/already exists/);

    expect(runCommand.mock.calls).toEqual([
      ["npm", ["test"], "/repo"],
      ["npm", ["run", "typecheck"], "/repo"],
      ["npm", ["run", "build"], "/repo"],
      ["npm", ["test", "--", "--run", "tests/validation/contracts.test.ts"], "/repo"],
      [
        "npm",
        [
          "test",
          "--",
          "--run",
          "tests/runtime/claude/subprocessClaudeAdapter.test.ts",
          "tests/controller/runLoop.integration.test.ts",
          "tests/validation/evidence.test.ts",
        ],
        "/repo",
      ],
    ]);
  });

  it("runs deterministic preflight commands in the required order", async () => {
    const commands: string[] = [];

    await prepareA04(
      {
        repoRoot: "/repo",
        fixturePath: "/repo/.validation-runs/fixture-01",
        contractPath: "/repo/.validation-runs/contracts/A-04.json",
        runDir: "/repo/.validation-runs/runs/A-04",
        evidenceDir: "/repo/.validation-runs/evidence/A-04",
        adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
        executionPolicyOverrides: {
          tokenBudget: 550000,
          perAttemptTimeoutMs: 600000,
          totalRuntimeBudgetMs: 1200000,
          partialOutcomeRecoveryWindowMs: 5000,
        },
      },
      {
        pathExists: async () => false,
        assertCleanFixture: async () => ({ head: "abc", status: "" }),
        runCommand: async (command, args) => {
          commands.push([command, ...args].join(" "));
          return { stdout: "", stderr: "" };
        },
        writeContract: async () => ({ contract: renderScenario("A", { repoPath: "/repo/.validation-runs/fixture-01" }), sha256: "abc123" }),
      },
    );

    expect(commands).toEqual([
      "npm test",
      "npm run typecheck",
      "npm run build",
      "npm test -- --run tests/validation/contracts.test.ts",
      "npm test -- --run tests/runtime/claude/subprocessClaudeAdapter.test.ts tests/controller/runLoop.integration.test.ts tests/validation/evidence.test.ts",
    ]);
  });
});
```

- [ ] **Step 2: 运行新测试，确认它因 helper/CLI 尚不存在而失败**

Run:

```bash
npm test -- --run tests/validation/prepareA04.test.ts
```

Expected: FAIL，至少出现 `Cannot find module '../../validation/v1/lib/a04.js'`。

- [ ] **Step 3: 在 `validation/v1/lib/a04.ts` 中写出纯 helper 和可注入 orchestrator**

新建 `validation/v1/lib/a04.ts`，用下面这组核心接口和函数骨架：

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loopContractSchema, type LoopContract } from "../../src/contract/schema.js";
import { renderScenario, type ExecutionPolicyOverrides } from "./scenarios.js";

export type A04PrepareOptions = {
  repoRoot: string;
  fixturePath: string;
  contractPath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
  executionPolicyOverrides: Required<ExecutionPolicyOverrides>;
};

export type ApprovalPackage = {
  contractIdentity: { path: string; sha256: string; schemaValid: true };
  executionPolicy: Required<ExecutionPolicyOverrides>;
  expectedFileScope: string[];
  expectedDiffScope: string[];
  exactCommand: string[];
  usageEvidenceExpectations: string[];
  invariants: {
    fixtureClean: true;
    mainCheckoutMustRemainUnchanged: true;
    maxClaudePhases: 3;
  };
};

type PrepareDeps = {
  pathExists: (path: string) => Promise<boolean>;
  assertCleanFixture: (fixturePath: string) => Promise<{ head: string; status: string }>;
  runCommand: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  writeContract: (options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "executionPolicyOverrides">) => Promise<{ contract: LoopContract; sha256: string }>;
};

export function buildA04RunCommand(input: {
  contractPath: string;
  fixturePath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
}): string[] {
  return [
    "npx",
    "--no-install",
    "tsx",
    "validation/v1/scripts/run-scenario.ts",
    "--scenario",
    "A",
    "--contract",
    input.contractPath,
    "--fixture",
    input.fixturePath,
    "--run-dir",
    input.runDir,
    "--evidence-dir",
    input.evidenceDir,
    "--adapter-config",
    input.adapterConfigPath,
  ];
}

export function buildApprovalPackage(input: {
  contract: LoopContract;
  contractPath: string;
  contractSha256: string;
  fixturePath: string;
  runDir: string;
  evidenceDir: string;
  adapterConfigPath: string;
}): ApprovalPackage {
  return {
    contractIdentity: {
      path: input.contractPath,
      sha256: input.contractSha256,
      schemaValid: true,
    },
    executionPolicy: {
      tokenBudget: input.contract.executionPolicy.tokenBudget,
      perAttemptTimeoutMs: input.contract.executionPolicy.perAttemptTimeoutMs,
      totalRuntimeBudgetMs: input.contract.executionPolicy.totalRuntimeBudgetMs,
      partialOutcomeRecoveryWindowMs: input.contract.executionPolicy.partialOutcomeRecoveryWindowMs,
    },
    expectedFileScope: [...input.contract.context.targetPaths],
    expectedDiffScope: [...input.contract.safetyPolicy.allowlistPaths],
    exactCommand: buildA04RunCommand(input),
    usageEvidenceExpectations: [
      "plan/execute/verify artifacts may include usageEvidence fields and tokenUsage when normalizedTotal is finite and positive",
      "tokenBudget is a controller stopping threshold, not an API cost cap",
    ],
    invariants: {
      fixtureClean: true,
      mainCheckoutMustRemainUnchanged: true,
      maxClaudePhases: 3,
    },
  };
}
```

继续在同文件中实现 `defaultDeps.writeContract(...)`：

```ts
async function defaultWriteContract(options: Pick<A04PrepareOptions, "fixturePath" | "contractPath" | "executionPolicyOverrides">) {
  const contract = loopContractSchema.parse(
    renderScenario("A", {
      repoPath: options.fixturePath,
      executionPolicyOverrides: options.executionPolicyOverrides,
    }),
  );
  const contractPath = resolve(options.contractPath);
  await mkdir(dirname(contractPath), { recursive: true });
  const body = `${JSON.stringify(contract, null, 2)}\n`;
  await writeFile(contractPath, body, { flag: "wx" });
  return {
    contract,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}
```

最后实现 `prepareA04(...)`，顺序必须是：
1. assert fixture clean；
2. 运行 5 条 deterministic commands；
3. assert `contractPath`/`runDir`/`evidenceDir` freshness；
4. 写 contract；
5. 生成 approval package；
6. 返回 package + command list。  
注意：**不要创建 `runDir` 或 `evidenceDir`**。

- [ ] **Step 4: 写 `validation/v1/scripts/prepare-a04.ts` CLI wrapper**

新建 `validation/v1/scripts/prepare-a04.ts`，使用下面的 flags：

```ts
--fixture <path>
--contract <path>
--run-dir <path>
--evidence-dir <path>
--adapter-config <path>
--token-budget <positive integer>
--per-attempt-timeout-ms <positive integer>
--total-runtime-budget-ms <positive integer>
--partial-recovery-window-ms <non-negative integer>
```

主流程骨架：

```ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareA04 } from "../lib/a04.js";

function parsePositiveInteger(flag: string, value: string | undefined): number { /* 与现有 render-contract.ts 一致 */ }
function parseNonNegativeInteger(flag: string, value: string | undefined): number { /* 允许 0 */ }

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const result = await prepareA04({
      repoRoot: resolve("."),
      fixturePath: resolve(parsed.fixturePath),
      contractPath: resolve(parsed.contractPath),
      runDir: resolve(parsed.runDir),
      evidenceDir: resolve(parsed.evidenceDir),
      adapterConfigPath: resolve(parsed.adapterConfigPath),
      executionPolicyOverrides: {
        tokenBudget: parsed.tokenBudget,
        perAttemptTimeoutMs: parsed.perAttemptTimeoutMs,
        totalRuntimeBudgetMs: parsed.totalRuntimeBudgetMs,
        partialOutcomeRecoveryWindowMs: parsed.partialRecoveryWindowMs,
      },
    });

    process.stdout.write(`${JSON.stringify(result.approvalPackage, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
```

输出只打印 approval package JSON。不要调用 `run-scenario.ts`，不要写 review，不要创建 evidence 目录。

- [ ] **Step 5: 补一个轻量 CLI smoke test，锁定 stdout 结构与“无 paid call”边界**

把下面这个 test 追加到 `tests/validation/prepareA04.test.ts`：

```ts
it("buildA04RunCommand matches the current run-scenario CLI shape", () => {
  expect(
    buildA04RunCommand({
      contractPath: "/repo/.validation-runs/contracts/A-04.json",
      fixturePath: "/repo/.validation-runs/fixture-01",
      runDir: "/repo/.validation-runs/runs/A-04",
      evidenceDir: "/repo/.validation-runs/evidence/A-04",
      adapterConfigPath: "/repo/examples/v1/claude-adapter-config.json",
    }),
  ).toEqual([
    "npx",
    "--no-install",
    "tsx",
    "validation/v1/scripts/run-scenario.ts",
    "--scenario",
    "A",
    "--contract",
    "/repo/.validation-runs/contracts/A-04.json",
    "--fixture",
    "/repo/.validation-runs/fixture-01",
    "--run-dir",
    "/repo/.validation-runs/runs/A-04",
    "--evidence-dir",
    "/repo/.validation-runs/evidence/A-04",
    "--adapter-config",
    "/repo/examples/v1/claude-adapter-config.json",
  ]);
});
```

如果这条测试失败，先修 helper；不要改 `run-scenario.ts` 的 CLI 形状，除非 helper 只是和真实脚本参数不一致。

- [ ] **Step 6: 运行 focused tests，确认 helper/CLI 都通过**

Run:

```bash
npm test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts
```

Expected: PASS；新 tests 全部通过，且 run/evidence dirs 在测试中从不被创建。

- [ ] **Step 7: 提交 Task 2**

```bash
git status --short
git diff -- validation/v1/lib/scenarios.ts validation/v1/lib/a04.ts validation/v1/scripts/prepare-a04.ts tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts
git add validation/v1/lib/scenarios.ts validation/v1/lib/a04.ts validation/v1/scripts/prepare-a04.ts tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts
git commit -m "feat: add A-04 preparation workflow"
```

Expected: commit 包含 override support、helper、CLI 和 tests；不包含 `.validation-runs/` 实物输出。

## Task 3: 记录 operator workflow 并完成 deterministic verification

**Files:**
- Modify: `validation/v1/README.md`
- Modify: `.wolf/anatomy.md`
- Modify: `.wolf/memory.md`
- Test: `tests/validation/prepareA04.test.ts`

**Interfaces:**
- Consumes:
  - `validation/v1/scripts/prepare-a04.ts` CLI
  - Task 2 的 `ApprovalPackage` JSON stdout shape
- Produces:
  - operator-facing command example for non-paid A-04 preparation
  - OpenWolf inventory entries for the three new files

- [ ] **Step 1: 更新 `validation/v1/README.md`，加入新的 A-04 mechanical preflight 命令**

在 `## Preflight` 之后、`## Scenario A - Successful End-to-End Run` 之前新增一个小节，内容至少包含这条命令：

```md
## A-04 mechanical prepare (no paid call)

```bash
npx --no-install tsx validation/v1/scripts/prepare-a04.ts \
  --fixture .validation-runs/fixture-01 \
  --contract .validation-runs/contracts/A-04.json \
  --run-dir .validation-runs/runs/A-04 \
  --evidence-dir .validation-runs/evidence/A-04 \
  --adapter-config examples/v1/claude-adapter-config.json \
  --token-budget 550000 \
  --per-attempt-timeout-ms 600000 \
  --total-runtime-budget-ms 1200000 \
  --partial-recovery-window-ms 5000
```

Expected result:
- deterministic local checks pass;
- `.validation-runs/contracts/A-04.json` is created once;
- `.validation-runs/runs/A-04/` and `.validation-runs/evidence/A-04/` still do not exist;
- stdout prints an approval package containing contract identity, expected file scope, expected diff scope, exact `run-scenario.ts` command, and cost semantics.
```

同时在这一节最后再补一句：`prepare-a04.ts` must not invoke Claude or create `review.json`.

- [ ] **Step 2: 跑与 A-04 准备直接相关的 deterministic verification**

Run:

```bash
npm test -- --run \
  tests/validation/contracts.test.ts \
  tests/validation/prepareA04.test.ts \
  tests/runtime/claude/subprocessClaudeAdapter.test.ts \
  tests/controller/runLoop.integration.test.ts \
  tests/validation/evidence.test.ts
npm run typecheck
npm run build
```

Expected: 全部 PASS；没有真实 Claude 调用；`dist/` 变化如果出现，只来自正常 build 输出。

- [ ] **Step 3: 手工 dry-run 一次 `prepare-a04.ts`，但只到 approval package stdout**

Run:

```bash
npx --no-install tsx validation/v1/scripts/prepare-a04.ts \
  --fixture .validation-runs/fixture-01 \
  --contract .validation-runs/contracts/A-04.json \
  --run-dir .validation-runs/runs/A-04 \
  --evidence-dir .validation-runs/evidence/A-04 \
  --adapter-config examples/v1/claude-adapter-config.json \
  --token-budget 550000 \
  --per-attempt-timeout-ms 600000 \
  --total-runtime-budget-ms 1200000 \
  --partial-recovery-window-ms 5000
```

Expected: exit `0`; stdout 是 approval package JSON；`jq '.contractIdentity, .executionPolicy, .exactCommand, .expectedFileScope, .expectedDiffScope'` 能读到关键字段；`test ! -e .validation-runs/runs/A-04` 与 `test ! -e .validation-runs/evidence/A-04` 仍为真。

如果 `.validation-runs/contracts/A-04.json` 已存在于前一次 dry-run，就先删掉你自己这次创建的测试产物或改用新 literal，例如 `A-04-dryrun`；不要覆盖已有 contract。

- [ ] **Step 4: 更新 OpenWolf metadata**

在 `.wolf/anatomy.md` 的合适分组下新增三项，描述分别为：

```md
- `validation/v1/lib/a04.ts` — Builds A-04 deterministic preflight results and approval package (~N tok)
- `validation/v1/scripts/prepare-a04.ts` — CLI for non-paid A-04 preparation and approval package output (~N tok)
- `tests/validation/prepareA04.test.ts` — Covers A-04 preparation command order, approval package fields, and freshness gates (~N tok)
```

然后在 `.wolf/memory.md` 追加一行：

```md
| HH:MM | Implemented non-paid A-04 preparation workflow and approval package generation | validation/v1/lib/a04.ts, validation/v1/scripts/prepare-a04.ts, tests/validation/prepareA04.test.ts, validation/v1/README.md | done | ~TOKENS |
```

如果在实施过程中发现新的项目约束（例如 contract override 只能通过 `executionPolicy.*` 四个字段，或 approval package 必须与 `run-scenario.ts` CLI shape 完全一致），再把它补到 `.wolf/cerebrum.md` 的 `## Key Learnings` 或 `## Decision Log`。

- [ ] **Step 5: 提交 Task 3**

```bash
git status --short
git diff -- validation/v1/README.md .wolf/anatomy.md .wolf/memory.md
git add validation/v1/README.md .wolf/anatomy.md .wolf/memory.md
git commit -m "docs: record A-04 preparation workflow"
```

Expected: commit 只包含 operator docs 与 OpenWolf bookkeeping。

## Self-Review

- **Spec coverage:**
  - `Authority/Invariants` → Task 1 lock exact override fields + Task 2 approval package + Task 3 README command.
  - `Deterministic Preflight Checklist` → Task 2 `prepareA04()` command order + Task 3 deterministic verification + dry-run.
  - `Approval Package` → Task 2 `ApprovalPackage` tests and CLI stdout.
  - `Run Interpretation/PASS Gate` → plan intentionally does not implement paid-call execution or runtime interpretation changes; it only prepares the non-paid prerequisites exactly as the spec requests.
  - `Single-Run Stop Policy` → Task 2/3 ensure no `runDir` or `evidenceDir` is created and no Claude call is made.
- **Placeholder scan:** no `TODO`/`TBD`; every code-changing step includes concrete code or exact command.
- **Type consistency:** `ExecutionPolicyOverrides`, `A04PrepareOptions`, `ApprovalPackage`, and `buildA04RunCommand()` are defined once and reused consistently across tasks.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
