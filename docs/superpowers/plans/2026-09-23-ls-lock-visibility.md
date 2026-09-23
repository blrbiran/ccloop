# `ls` 也报锁 ＋ 活性未定的锁对操作员可见 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让操作员在 `ccloop ls` 里看得见每个 run 的 owner-transfer 锁状态（人裁 85／131），
并让「活性判不了」的锁在转移被拒的那一刻就与「真有活人持锁」区分开（I-3／人裁 132／133）。

**Architecture:** 三态活性判别**下沉**到 `src/persistence/fileStore.ts`（解循环依赖）；红线函数
把 `not-determined-dead` 拆成 `holder-alive` 与 `liveness-undetermined`；新错误类
`OwnerTransferLockLivenessUndeterminedError` **仍被三处重试闸门接住**（这才是保住今天的行为）；
`ls` 侧走**独立一层** `src/unlock/lockRows.ts`，registry 的观测核心一个字节不动。

**Tech Stack:** TypeScript (ESM, `node16` resolution)、vitest 2.1.9、Node 22。

**Spec:** `docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md`
（**执行者必须连 spec 一起读**；本计划的每条论断都从 spec 来。）

---

## Global Constraints

**逐条从 spec 与 `CLAUDE.md` 抄来，每个 Task 的要求都隐含包含本节。**

1. **代码、注释、CLI help、commit message 一律英文**；spec／plan／台账中文。
2. **不 push、不合并、不删分支或 worktree。** 四件各自需人单独授权；控制器不许 push。
   在 `main` 上落本地提交（`superpowers:executing-plans` 要求隔离 worktree，但 `CLAUDE.md` 优先）。
3. **不许实施者自改既有判据。** 需要新覆盖时**先想能不能只加不改**（人裁 119 的先例）。
   真改不可免 ⇒ **停下来**把清单（文件／测试名／为什么必须改／改成什么）交人按**人裁 88** 指名。
4. **已发布文本一个字不就地改**（本轮开工时三仓与远端一致 ⇒ `src/**` 的注释全是已发布文本）。
   推翻它只能**在注释块末尾追加具名 ERRATUM**，格式
   `*** ERRATUM (<议题>, HUMAN RULING N) -- ... ***`。
   ERRATUM 里**不许写会被后续裁决推翻的计数**（指向台账即可），**不许引用会移动的 git 引用**。
5. **绝不过滤验证性跑。** `grep`/`tail`/`head`/`sed` 都算过滤，管道还会吞退出码。
   **重定向到文件再整份读回**，并核 vitest 第一行 `RUN` 指向的路径是主仓库根。
6. **所有 git 核对裸 `/usr/bin/git`**（rtk 有六种骗法）。本机**没有 `/usr/bin/ls`，用 `/bin/ls`**；
   `rm`/`cp` 有 `-i` alias ⇒ 一律 `/bin/rm -rf` 和 `cat pristine > target`；macOS 没有 `timeout(1)`。
7. **环境变量**：跑测试前 `export ECC_GATEGUARD=off DISABLE_OMC=1`。
8. **基线不是全绿。** 判别式 ＝ **红集合 ⊆ 下面 7 条，按【全名】核，不数条数**：
   1. `tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone`（**稳定红，非 flake**）
   2. `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
   3. `runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`
   4. `runLoop > accounts an execute timeout that rejects after the abort as exhaustion`
   5. `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data`
   6. `SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute`
   7. `Codex phase process > kills a TERM-ignoring process before returning abort`
   （2–7 是**负载 flake**，全部 `Test timed out in 5000ms`。开工那次跑它们全绿。）
9. **开工基线（现测）**：`56 files / 779 tests`，1 failed / 778 passed，0 skipped，`TEST_RC=1`；
   `typecheck` RC 0；`build` RC 0。**引用条数前一律现测。**
10. **变异只在 `git clone --local` 副本里**，主工作树全程零触碰；副本**必须先 `npm run build`**
    （`dist/` 被 gitignore，不 build 会让 `tests/control/endToEnd.test.ts` 的 6 条假红）；
    软链主树 `node_modules`；**施加变异前后 `shasum -a 256` 比对，不相等才算落上去**。
11. **`.superpowers/sdd/` 整个被 gitignore** ⇒ 该目录下的新产物必须**单独** `git add -f`
    （`git add <已跟踪> <被忽略>` 会非 0 退出，`&&` 会跳过 commit）。

---

## File Structure

| 文件 | 职责 | Task |
|---|---|---|
| `src/persistence/fileStore.ts` | 新增三态判别；红线函数分格；新错误类；构造点；重试闸门；逃逸点 | 1,2,3,7 |
| `src/unlock/inspectLock.ts` | 改为从 `fileStore` 导入三态并转发，导出名与行为不变 | 1 |
| `tests/persistence/liveness.test.ts` | **新建**。三态判别的判据（只加不改） | 1 |
| `tests/persistence/noUnlockValueImport.structure.test.ts` | **新建**。结构判据：`fileStore` 不得值导入 `src/unlock/` | 1 |
| `src/controller/runLoop.ts` | 重试闸门 ＋ 两处处置点 | 3,4 |
| `src/controller/resumeLoop.ts` | 重试闸门 ＋ 两处处置点 | 3,5 |
| `src/controller/leaseHeartbeat.ts` | 两处处置点 ＋ 新事件类型 ＋ 第二个 once 标志 | 6 |
| `src/unlock/lockRows.ts` | **新建**。`attachLockInspections` ＋ `defaultLockRowDeps` | 8 |
| `tests/unlock/lockRows.test.ts` | **新建** | 8 |
| `src/registry/renderRuns.ts` | 类型放宽 3 处 ＋ 七态锁块渲染 | 9 |
| `src/cli.ts` | `ls` 分支接线 | 10 |
| `src/sweep/lockPresence.ts` | **只追加 ERRATUM** | 11 |
| `docs/superpowers/specs/2026-07-28-run-registry-design.md` | 追加更正节 | 11 |
| `scripts/check-known-reds.mjs` | **新建**。判据 1 的机械子集判定 | 12 |

---

# Task 1: 三态活性判别下沉到 `fileStore.ts`

**为什么第一个做**：后面每个 Task 都要用它，而它**零行为改变** —— 先把地基挪对，再改行为。

**Files:**
- Modify: `src/persistence/fileStore.ts`（在 `isProcessActive` 上方新增）
- Modify: `src/unlock/inspectLock.ts:93-119`（改为导入转发）
- Create: `tests/persistence/liveness.test.ts`
- Create: `tests/persistence/noUnlockValueImport.structure.test.ts`

**Interfaces:**
- Produces: `export type LivenessVerdict = { verdict: "alive" } | { verdict: "dead" } | { verdict: "unknown"; reason: string }`
  和 `export function classifyProcessLiveness(pid: number): LivenessVerdict`，都从
  `src/persistence/fileStore.ts` 导出。Task 2 会用 `classifyProcessLiveness`。
- Consumes: 无。

⚠️ **`isProcessActive` 一个字不动**（`tests/persistence/fileStore.test.ts:1084` 与
`tests/unlock/inspectLock.test.ts:317` 在断言它的 boolean）。
⚠️ **`inspectLock.ts` 的 `classifyHolderLiveness` 与 `LivenessVerdict` 导出名一个字不改**
（现测零判据消费者，但保名字可确保零意外）。

- [ ] **Step 1: 写失败判据（新文件，只加不改）**

`tests/persistence/liveness.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { classifyProcessLiveness } from "../../src/persistence/fileStore.js";

// A pid that is almost certainly not running. Asserted below rather than assumed, the same way
// tests/unlock/inspectLock.test.ts chooses and checks its own.
const DEAD_PID = 999999;

describe("classifyProcessLiveness", () => {
  it("answers dead only for ESRCH, and proves the pid really is gone first", () => {
    expect(() => process.kill(DEAD_PID, 0)).toThrow();

    expect(classifyProcessLiveness(DEAD_PID)).toEqual({ verdict: "dead" });
  });

  it("answers alive for this very process", () => {
    expect(classifyProcessLiveness(process.pid)).toEqual({ verdict: "alive" });
  });

  // pid 0 means "every process in the caller's process group" to kill(2), so the syscall can never
  // answer ESRCH for it. Reading its silence as "alive" is what strands a lock forever, which is
  // why this cell returns before the syscall is issued at all.
  it("answers unknown for pid 0 WITHOUT issuing the syscall, and names why", () => {
    const calls: number[] = [];
    const realKill = process.kill;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).kill = (pid: number, signal?: string | number) => {
      calls.push(pid);
      return realKill.call(process, pid, signal as never);
    };
    try {
      expect(classifyProcessLiveness(0)).toEqual({
        verdict: "unknown",
        reason: "pid 0 does not name a process that can be probed",
      });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).kill = realKill;
    }

    // The literal that matters: not "some syscall count", but zero calls for THIS pid.
    expect(calls).toEqual([]);
  });

  it("answers unknown with the errno for a pid too large to be one", () => {
    expect(classifyProcessLiveness(1e21)).toEqual({
      verdict: "unknown",
      reason: "ERR_INVALID_ARG_TYPE",
    });
  });
});
```

⚠️ **期望值全部是字面量** —— 一个都不许调被测函数算出来（spec §5.3 #3）。

`tests/persistence/noUnlockValueImport.structure.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Why a structure criterion and not a behavioural one: a value import from src/unlock/ back into
// this module closes an ESM cycle (inspectLock.ts value-imports parsePid from here). The cycle
// would very likely still RUN -- both sides are function declarations used only at call time -- so
// no behavioural test can be counted on to catch it. fileStore.ts:438 records the package already
// refusing to close such a cycle, duplicating two constants rather than importing back.
describe("fileStore module boundary", () => {
  it("never value-imports from src/unlock, which would close the cycle inspectLock opens", async () => {
    const source = await readFile(new URL("../../src/persistence/fileStore.ts", import.meta.url), "utf8");
    const importLines = source.split("\n").filter((line) => line.startsWith("import "));

    const valueImportsFromUnlock = importLines.filter(
      (line) => line.includes("../unlock/") && !line.startsWith("import type "),
    );

    expect(valueImportsFromUnlock).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑它们，确认红**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/persistence/liveness.test.ts tests/persistence/noUnlockValueImport.structure.test.ts > /tmp/t1-red.txt 2>&1; echo "RC=$?" >> /tmp/t1-red.txt
cat /tmp/t1-red.txt
```
Expected: `liveness.test.ts` 四条**全红**，报 `classifyProcessLiveness is not a function`
（或 import 解析失败）；结构判据**绿**（`fileStore.ts` 今天本来就没有该导入）。
⚠️ 结构判据现在绿是**预期的** —— 它的作用是 Task 1 之后**挡住**反向导入，红证由 Step 6 的变异给。

- [ ] **Step 3: 在 `fileStore.ts` 里新增三态判别**

插在 `export function isProcessActive(pid: number): boolean {` **之前**（约 `:1004`）：

```ts
// Three outcomes, not two. isProcessActive below collapses every non-ESRCH result into "alive",
// which is the correct collapse for a function whose answer authorizes a deletion: the redline
// recovery must never steal a lock it is unsure about. It is the wrong collapse for REPORTING,
// where "I could not tell" and "it is running" send an operator to different places.
//
// This lives here, in the persistence layer, and not beside the command that first needed it:
// inspectLock.ts value-imports parsePid from this module, so importing a classifier back from
// there would close a cycle -- the same cycle the RECONCILIATION_LOCK_RETRY_* constants above are
// duplicated to avoid. Human ruling 132.
export type LivenessVerdict =
  | { verdict: "alive" }
  | { verdict: "dead" }
  | { verdict: "unknown"; reason: string };

export function classifyProcessLiveness(pid: number): LivenessVerdict {
  // Guarded before the syscall, because kill(0, ...) is not a query about a process at all: POSIX
  // gives pid 0 the meaning "every process in the caller's process group". It cannot throw ESRCH,
  // so it can never answer "dead", and taking its silence for "alive" strands the lock forever.
  if (pid < 1) {
    return { verdict: "unknown", reason: `pid ${pid} does not name a process that can be probed` };
  }

  try {
    process.kill(pid, 0);
    return { verdict: "alive" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { verdict: "dead" };
    }

    // EPERM (someone else's process), ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE (a number too large
    // to be a pid), and anything else: the probe failed, which is not the same as it succeeding.
    return { verdict: "unknown", reason: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}
```

⚠️ **函数体与 `inspectLock.ts:98-119` 今天的实现逐字相同** —— 这是搬家，不是重写。

- [ ] **Step 4: 把 `inspectLock.ts` 改成转发**

`src/unlock/inspectLock.ts`：`:72` 的 import 加上两个名字，`:93-119` 的类型与函数体换成转发。

```ts
import {
  OWNER_TRANSFER_LOCK_FILE,
  type OwnerTransferLockRecord,
  classifyProcessLiveness,
  type LivenessVerdict,
  parsePid,
} from "../persistence/fileStore.js";
```

```ts
export type { LivenessVerdict };

// The implementation moved down into fileStore (human ruling 132). The name stays here because
// this module is where the three-state question is ASKED; what moved is only where it lives, so
// that the redline function can ask it too without importing back across the layer boundary.
export const classifyHolderLiveness = classifyProcessLiveness;
```

⚠️ **删掉 `inspectLock.ts` 原来的 `classifyHolderLiveness` 函数体与 `LivenessVerdict` 类型定义**，
但**块上方那两段讲「三态 vs 两态分工」的注释逐字保留**，在**块末尾追加**：

```ts
// *** ERRATUM (ls lock visibility, HUMAN RULING 132) -- the paragraphs above are kept verbatim and
// their reasoning is unchanged: the three-state question still belongs to this module's callers,
// and the two-state collapse is still the right one where a deletion is authorized. What changed
// is location only. The classifier now lives in fileStore so that the redline function can ask the
// same question from the same single implementation; importing it back from here would close the
// cycle fileStore already refuses to close for its retry constants. Sentences above that read as
// "fileStore has two states and this module has three" now describe two EXPORTS of one module, not
// two implementations. The ledger for this round records the rest. ***
```

- [ ] **Step 5: 跑判据 ＋ 全量，确认绿**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run > /tmp/t1-green.txt 2>&1; echo "RC=$?" >> /tmp/t1-green.txt
npm run typecheck > /tmp/t1-tc.txt 2>&1; echo "RC=$?" >> /tmp/t1-tc.txt
cat /tmp/t1-green.txt; cat /tmp/t1-tc.txt
```
Expected: 新增 **5 条**（liveness 4 ＋ structure 1）；**红集合 ⊆ Global Constraints §8 那 7 条**；
`typecheck` RC 0。⚠️ **整份读回，不许 grep 过滤。**

- [ ] **Step 6: 变异电池（副本里）**

| 变异 | 期望红在（**全名，且仅此**） |
|---|---|
| M1-1：删掉 `if (pid < 1)` 整个提前返回 | `classifyProcessLiveness > answers unknown for pid 0 WITHOUT issuing the syscall, and names why` |
| M1-2：把 `reason: code ?? ...` 改成 `reason: "unknown"` | `classifyProcessLiveness > answers unknown with the errno for a pid too large to be one` |
| M1-3：把 `code === "ESRCH"` 改成 `code !== "ESRCH"` | `classifyProcessLiveness > answers dead only for ESRCH, and proves the pid really is gone first` 与 `... answers alive for this very process` |
| M1-4：在 `fileStore.ts` 顶部加 `import { ownerTransferLockPath } from "../unlock/inspectLock.js";` 并在任意函数里引用它 | `fileStore module boundary > never value-imports from src/unlock, which would close the cycle inspectLock opens` |

⚠️ **M1-4 是结构判据唯一的红证** —— 没有它，那条判据就是「恒绿的守卫」。
⚠️ 每条变异**前后 `shasum -a 256`**，不相等才算落上去。

- [ ] **Step 7: 提交**

```bash
/usr/bin/git add src/persistence/fileStore.ts src/unlock/inspectLock.ts \
  tests/persistence/liveness.test.ts tests/persistence/noUnlockValueImport.structure.test.ts
/usr/bin/git commit -F - <<'EOF'
refactor(liveness): move the three-state probe down to where both callers can reach it

inspectLock value-imports parsePid from fileStore, so the redline function
cannot import a classifier back without closing a cycle -- the same cycle
this module already duplicates two retry constants to avoid. The classifier
moves into fileStore; inspectLock keeps its export name and forwards.

No behaviour changes. A structure criterion now pins the direction, and its
own mutation (an added value import from src/unlock) is what proves it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8
EOF
```

---

# Task 2: 红线函数分格 ＋ 新错误类 ＋ 构造点

**Files:**
- Modify: `src/persistence/fileStore.ts`（错误类约 `:886` 后、outcome 类型 `:1040`、
  liveness 守卫 `:1128`、构造点 `:1396`）
- Modify: `tests/persistence/fileStore.test.ts` —— ⚠️ **只加不改**，新增判据放文件末尾

**Interfaces:**
- Consumes: Task 1 的 `classifyProcessLiveness`。
- Produces: `export class OwnerTransferLockLivenessUndeterminedError extends Error`；
  `StaleOwnerTransferLockOutcome` 多两格。Task 3–7 都依赖这个类。

- [ ] **Step 1: 写失败判据（追加到 `tests/persistence/fileStore.test.ts` 末尾）**

```ts
describe("owner-transfer lock with an unprobeable holder (human ruling 132)", () => {
  it("refuses with a named liveness error, says the lock may still clear, and leaves it on disk", async () => {
    const runDir = await makeRunDir();
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);
    await writeFile(
      lockPath,
      JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-09-23T00:00:00.000Z" }),
    );

    const error = await acquireOwnerTransferLock(runDir).then(
      () => {
        throw new Error("expected the acquire to be refused");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(OwnerTransferLockLivenessUndeterminedError);
    // The reason, not just the verdict: a criterion that only pins "it threw" cannot see a whole
    // branch of mutations (the package has measured 104 such criteria staying green).
    expect(String(error)).toContain("pid 0 does not name a process that can be probed");
    expect(String(error)).toContain("may or may not clear on its own");
    // The published wording for a lock nothing will ever release must NOT be reused here: an EPERM
    // holder is most likely alive and will clear when it exits.
    expect(String(error)).not.toContain("will not clear on its own");
    // Ruling 83's deletion condition is untouched: this exit never removes anything.
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it("still calls a genuinely live holder busy, in the published words, and leaves the lock alone", async () => {
    const runDir = await makeRunDir();
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);
    await writeFile(
      lockPath,
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-09-23T00:00:00.000Z" }),
    );

    const error = await acquireOwnerTransferLock(runDir).then(
      () => {
        throw new Error("expected the acquire to be refused");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(OwnerTransferLockBusyError);
    expect(error).not.toBeInstanceOf(OwnerTransferLockLivenessUndeterminedError);
    expect(String(error)).toContain("owner transfer already in progress");
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it("still removes a dead holder's lock, so ruling 83's one deletion condition is unchanged", async () => {
    const runDir = await makeRunDir();
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);
    expect(() => process.kill(999999, 0)).toThrow();
    await writeFile(
      lockPath,
      JSON.stringify({ holderProcessInstanceId: "pid:999999", acquiredAt: "2026-09-23T00:00:00.000Z" }),
    );

    const lock = await acquireOwnerTransferLock(runDir);
    await lock.release();

    expect(lock).toBeDefined();
  });
});
```

⚠️ 用 `.then(onFulfilled, onRejected)` 并在 onFulfilled 里 throw，**不用 `.catch(e => e)`**
（`.catch` 在 promise 成功时给出 `undefined`，会让三条断言全在断言 `undefined`）。
⚠️ 判据里需要的 `makeRunDir` / `OWNER_TRANSFER_LOCK_FILE` / `acquireOwnerTransferLock` /
`OwnerTransferLockBusyError` 该文件已经在用；**新增的 import 只有
`OwnerTransferLockLivenessUndeterminedError`**。

- [ ] **Step 2: 跑它们，确认红**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts > /tmp/t2-red.txt 2>&1; echo "RC=$?" >> /tmp/t2-red.txt
cat /tmp/t2-red.txt
```
Expected: 第 1 条红（`OwnerTransferLockLivenessUndeterminedError is not defined` 或
`expected OwnerTransferLockBusyError to be instance of ...`）；第 2、3 条**绿**（今天就成立）。

- [ ] **Step 3: 新增错误类**

`src/persistence/fileStore.ts`，紧接 `OwnerTransferLockUnattributableError` 的块**之后**：

```ts
// A fourth meaning, and a THIRD sibling: deliberately not a subclass of either neighbour, for the
// doctrine stated above. It is not Busy, because "busy" claims a transfer is running and this
// class exists precisely because nobody can tell. It is not Unattributable, because the record
// parsed fine and named a holder in the `pid:<n>` form -- what failed was the probe, and an
// operator told the wrong reason looks for the wrong fix.
//
// Unlike Unattributable, a lock in THIS state may still clear on its own: an EPERM refusal usually
// means the holder is another user's live process, which releases the lock when it exits. That is
// why the three retry gates admit this class alongside Busy (human ruling 133) -- dropping it out
// of the retry bound would abandon transfers that were about to succeed.
export class OwnerTransferLockLivenessUndeterminedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerTransferLockLivenessUndeterminedError";
  }
}
```

- [ ] **Step 4: outcome 分格 ＋ 折叠改用三态**

`:1040` 的类型：

```ts
type StaleOwnerTransferLockOutcome =
  | { kind: "cleared" }
  | { kind: "holder-alive" }
  | { kind: "liveness-undetermined"; reason: string }
  | { kind: "unattributable"; why: "unparseable" | "no-pid-holder" };
```

`:1128` 的守卫（**原注释块逐字保留，末尾追加 ERRATUM**）：

```ts
  const liveness = classifyProcessLiveness(pid);
  if (liveness.verdict === "alive") {
    return { kind: "holder-alive" };
  }
  if (liveness.verdict === "unknown") {
    return { kind: "liveness-undetermined", reason: liveness.reason };
  }

  await safeUnlink(lockPath);
  return { kind: "cleared" };
```

追加在该注释块末尾：

```ts
  // *** ERRATUM (ls lock visibility, HUMAN RULING 132) -- the paragraphs above are kept verbatim.
  // Two of their statements no longer describe this code. "isProcessActive now sits OUTSIDE the
  // try" named a call this exit no longer makes: the question is now asked once through
  // classifyProcessLiveness, which is total for the same reason and answers three ways instead of
  // two. And "this exit is called not-determined-dead rather than holder-alive" is superseded:
  // holder-alive is back as its own exit, carrying no pid (ruling 108's reason for dropping that
  // field is unchanged), while pid:0, an out-of-range pid and an EPERM refusal now take a separate
  // liveness-undetermined exit. The sentence "only the first of them clears on its own" was itself
  // too strong about EPERM, whose holder is usually alive; the new exit's message says so. What is
  // unchanged: none of these cells deletes anything, and ruling 83's single deletion condition is
  // byte-for-byte the one it always was. ***
```

⚠️ 在 `classifyProcessLiveness` 之外**不要**再调 `isProcessActive` —— 两次 `kill(pid,0)` 之间
进程状态可能改变，两个答案会自相矛盾。

- [ ] **Step 5: 构造点分两支**（`:1396`，原 ERRATUM 块逐字保留）

```ts
      if (outcome.kind === "liveness-undetermined") {
        throw new OwnerTransferLockLivenessUndeterminedError(
          `liveness of the owner-transfer lock holder cannot be determined (${outcome.reason}); ` +
            `this lock may or may not clear on its own -- inspect it with: ccloop unlock ${runDir}`,
        );
      }

      if (outcome.kind === "holder-alive") {
        throw new OwnerTransferLockBusyError("owner transfer already in progress");
      }
```

⚠️ `holder-alive` 那支的 message **逐字不动**。⚠️ 函数末尾那条兜底
`throw new OwnerTransferLockBusyError("owner transfer already in progress")`（`:1402`）**不动**。

- [ ] **Step 6: 跑判据 ＋ 全量 ＋ typecheck，确认绿**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run > /tmp/t2-green.txt 2>&1; echo "RC=$?" >> /tmp/t2-green.txt
npm run typecheck > /tmp/t2-tc.txt 2>&1; echo "RC=$?" >> /tmp/t2-tc.txt
cat /tmp/t2-green.txt; cat /tmp/t2-tc.txt
```
Expected: 新增 3 条；**红集合 ⊆ 那 7 条**；typecheck RC 0。

- [ ] **Step 7: 变异电池**

| 变异 | 期望红在（**全名，且仅此**） |
|---|---|
| M2-1：删掉 `liveness.verdict === "unknown"` 整支（让它落到 `safeUnlink`） | `owner-transfer lock with an unprobeable holder (human ruling 132) > refuses with a named liveness error, says the lock may still clear, and leaves it on disk` |
| M2-2：构造点的新错误改抛 `OwnerTransferLockBusyError` | 同上一条 |
| M2-3：message 里把 `may or may not clear on its own` 换成 `will not clear on its own` | 同上一条 |
| M2-4：把 `holder-alive` 那支也改抛新错误类 | `... still calls a genuinely live holder busy, in the published words, and leaves the lock alone` |
| M2-5：把 `liveness.verdict === "alive"` 改成 `!== "alive"` | 上面两条**都红** |

⚠️ M2-3 是「只断言 verdict 不断言理由」那个陷阱的专用红证 —— **没有它，措辞就没有判据承重。**

- [ ] **Step 8: 提交**

```bash
/usr/bin/git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
/usr/bin/git commit -F - <<'EOF'
fix(fileStore): stop telling an operator a lock is busy when nobody can tell

pid:0, an out-of-range pid and an EPERM refusal all reached the same exit as
a genuinely live holder and got the same words: "owner transfer already in
progress". Only one of those is true. The recovery function now answers
holder-alive and liveness-undetermined separately, and the new error names
the reason and says the lock MAY still clear -- which for EPERM it usually
will, because the holder is another user's running process.

Ruling 83's single deletion condition is byte-for-byte unchanged: every new
cell refuses, and none of them unlinks anything.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8
EOF
```

---

# Task 3: 三处重试闸门各加一支

⚠️ **这一 Task 的目的是【保住今天的行为】，不是改变它。** 不加这一支，三格会从「走满重试」
变成「第一次尝试就放弃」—— 那才是行为回归（spec §4.5）。

**Files:**
- Modify: `src/persistence/fileStore.ts:483`、`src/controller/runLoop.ts:761`、
  `src/controller/resumeLoop.ts:75`
- Modify: `tests/persistence/fileStore.test.ts`（**只加**）

**Interfaces:** Consumes Task 2 的错误类。Produces 无新接口。

- [ ] **Step 1: 写失败判据**（追加到 `tests/persistence/fileStore.test.ts`）

```ts
it("spends the whole retry bound on an unprobeable holder, exactly as it does on a busy one", async () => {
  const runDir = await makeRunDir();
  await writeFile(
    join(runDir, OWNER_TRANSFER_LOCK_FILE),
    JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-09-23T00:00:00.000Z" }),
  );

  const kills: number[] = [];
  const realKill = process.kill;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).kill = (pid: number, signal?: string | number) => {
    kills.push(pid);
    return realKill.call(process, pid, signal as never);
  };

  try {
    await acquireOwnerTransferLock(runDir).then(
      () => {
        throw new Error("expected the acquire to be refused");
      },
      () => undefined,
    );
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).kill = realKill;
  }

  // The literal that matters is the ATTEMPT COUNT, not "it threw". pid 0 never reaches the
  // syscall, so the probe is counted by how many times the read path ran instead: two attempts,
  // the same bound a busy lock gets. One attempt would mean the class fell out of the retry gate.
  const lockStillThere = await stat(join(runDir, OWNER_TRANSFER_LOCK_FILE));
  expect(lockStillThere).toBeDefined();
  expect(kills).toEqual([]);
});
```

⚠️ **这条判据的形状有风险** —— `pid:0` 不发 syscall，所以「数 syscall」量不到重试次数。
**执行者必须先做一次定向探针**：给锁路径的 `readFile` 装计数器（或用越界 pid 走真 syscall 路径），
**量出今天的实际次数字面量，再把它写死进断言**。
⇒ **要量什么就直接量什么；不许用「红在哪条断言」反推。**
⇒ 若两种探针都量不到，**如实登记「重试次数在这一层钉不住」**，把红证移到 `runLoop`／`resumeLoop`
那两处闸门（它们的重试有 `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 常量可断言），**不编假判据**。

- [ ] **Step 2: 跑，确认红**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts > /tmp/t3-red.txt 2>&1; echo "RC=$?" >> /tmp/t3-red.txt
cat /tmp/t3-red.txt
```

- [ ] **Step 3: 三处闸门各加一支**

三处的改法**形状相同**，逐处如下（原注释块逐字保留，末尾追加 ERRATUM）：

`src/persistence/fileStore.ts:483`：
```ts
      if (
        !(error instanceof OwnerTransferLockBusyError
          || error instanceof OwnerTransferLockLivenessUndeterminedError)
      ) {
        return { kind: "abandon", error };
      }
```

`src/controller/runLoop.ts:761` 与 `src/controller/resumeLoop.ts:75`：
```ts
      if (
        !(error instanceof OwnerTransferLockBusyError
          || error instanceof OwnerTransferLockLivenessUndeterminedError)
        || isLastAttempt
      ) {
        throw error;
      }
```

三处各追加（把 `<处>` 换成该处的名字）：
```ts
      // *** ERRATUM (ls lock visibility, HUMAN RULING 133) -- the paragraph above is kept verbatim
      // and still describes OwnerTransferLockUnattributableError exactly: that class still takes
      // the first-attempt arm, because a lock nobody can attribute really will never be released.
      // It no longer describes every non-Busy lock error. A holder whose liveness cannot be
      // determined is usually another user's LIVE process, and its lock clears when that process
      // exits -- so this gate admits that class alongside Busy. The retry behaviour those three
      // cells get today is therefore unchanged; it is the gate that had to move to keep it. ***
```

- [ ] **Step 4: 跑判据 ＋ 全量 ＋ typecheck，确认绿**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run > /tmp/t3-green.txt 2>&1; echo "RC=$?" >> /tmp/t3-green.txt
npm run typecheck > /tmp/t3-tc.txt 2>&1; echo "RC=$?" >> /tmp/t3-tc.txt
cat /tmp/t3-green.txt; cat /tmp/t3-tc.txt
```
Expected: **红集合 ⊆ 那 7 条**。⚠️ 特别注意 `tests/controller/leaseLifecycle.integration.test.ts`
与 `tests/controller/resumeLoop.integration.test.ts` 有没有新红 —— 它们钉着重试与放弃的语义。

- [ ] **Step 5: 变异电池**

| 变异 | 期望红在 |
|---|---|
| M3-1：删掉 `fileStore.ts` 那一支 | Step 1 那条（或探针确认的替代判据） |
| M3-2：删掉 `runLoop.ts` 那一支 | 由 Task 4 的判据接住（本 Task 记为**跨 Task 红证**） |
| M3-3：删掉 `resumeLoop.ts` 那一支 | 由 Task 5 的判据接住（同上） |

⚠️ **M3-2／M3-3 在本 Task 内没有红证是【已知的】** —— 必须在 Task 4／5 完成后**回头重跑**，
并把结果记进台账。**不许因为「Task 3 时没红」就宣布那两支没承重**（那正是上一轮 C-1 溜过去的形状）。

- [ ] **Step 6: 提交**

```bash
/usr/bin/git add src/persistence/fileStore.ts src/controller/runLoop.ts src/controller/resumeLoop.ts \
  tests/persistence/fileStore.test.ts
/usr/bin/git commit -F - <<'EOF'
fix(locks): keep the retry bound for a holder that might still be alive

The three retry gates admit only OwnerTransferLockBusyError, so introducing
a separate class for "liveness undetermined" would have dropped pid:0, an
out-of-range pid and an EPERM refusal out of the bound on the first attempt.
Two of those never clear, but an EPERM holder is usually another user's live
process whose lock clears when it exits -- abandoning it immediately would
give up on transfers that were about to succeed.

Each gate gains one arm. The behaviour those cells get is the behaviour they
already had; the gate is what had to change to keep it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8
EOF
```

---

# Task 4: `runLoop` 两处处置点

**Files:** Modify `src/controller/runLoop.ts:927`、`:1745`；
Modify `tests/controller/leaseLifecycle.integration.test.ts`（**只加**）

⚠️ **判据放 `leaseLifecycle.integration.test.ts`，不是 `runLoop.integration.test.ts`** ——
现测后者**一条 unattributable 判据都没有**；钉住这两处的是前者的 `:560`
（`contains an unattributable transfer lock as a recorded contention instead of throwing out of the attempt`）
与 `:618`（`abandons the attempt in place when the ownership read hits an unattributable transfer lock, without failing the run`）。
**照那两条的夹具形状写新判据。**

**Interfaces:** Consumes Task 2 的错误类。

- [ ] **Step 1: 写失败判据**

追加到 `tests/controller/leaseLifecycle.integration.test.ts`。**两条，每处一条，每条都钉住 detail 的字面量**。

⚠️ *** **本仓库造这类场景的手法不是注入错误对象，是往磁盘上写一把真锁。** *** 现测
`resumeLoop.integration.test.ts:326` 与 `leaseHeartbeat.test.ts:338` 都是
`await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n")`。
本轮对应的写法是**写一把 `pid:0` 的锁**：

```ts
await writeFile(
  join(runDir, ".owner-transfer.lock"),
  JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-09-23T00:00:00.000Z" }),
);
```

**用真锁驱动真代码路径，不要构造错误对象喂给分支** —— 后者测的是分支自己，不是它被怎么走到的。

```ts
it("contains an undetermined-liveness transfer lock as a recorded contention, not a failed attempt", async () => {
  // Shape copied from the sibling criterion that pins the unattributable branch: the point is that
  // a REFUSAL to overwrite must not be upgraded into a failed run.
  // Fixture shape copied from leaseLifecycle.integration.test.ts:560 -- the executor reads that
  // criterion and reuses its seeding helpers verbatim. The only change is the lock's contents.
  const { runDir, state } = await runAttemptWithLockOnDisk(
    JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-09-23T00:00:00.000Z" }),
  );

  expect(state.status).not.toBe("failed");
  const events = await readEvents(runDir);
  const contended = events.filter((event) => event.type === "owner_transfer_contended");
  // The count is pinned, not just presence: a criterion that only asks "is it there" cannot see a
  // mutation that records it twice.
  expect(contended).toHaveLength(1);
  expect(contended[0].detail).toContain("cannot be determined (EPERM)");
  expect(contended[0].detail).toContain("owner transfer abandoned");
});
```

⚠️ `runAttemptWithLockOnDisk` 是**对 `:560`／`:618` 两条现有夹具的指代**，不是一个已存在的函数名 ——
**执行者照那两条现有判据的 seeding 步骤原样铺场景**（建 repo、建 contract、seed run、写锁），
然后照同样形状写第二条钉 `:1745` 那处（detail 前缀是 `owner transfer recovery blocked:`）。
⚠️ **这不是「照抄」的许可** —— 每个空判据当成**待裁决**，不是待照抄。

- [ ] **Step 2–3: 跑确认红 → 实现**

`:927` 的 `else if` 链加一支（原注释逐字保留，块末追加 ERRATUM 引人裁 133）：

```ts
          } else if (error instanceof OwnerTransferLockLivenessUndeterminedError) {
            await appendEvent(runDir, {
              type: "owner_transfer_contended",
              at: new Date().toISOString(),
              detail: `owner transfer abandoned: ${String(error)}`,
            });
```

`:1745` 同形，detail 用 `owner transfer recovery blocked: ${String(error)}`，
并同样 `await writeOwnedRunState(runDir, state); return state;`。

⚠️ **`:1745` 那支的 `writeOwnedRunState`**：人裁 118 记过 M8 删掉它照绿。
**本 Task 必须先尝试构造能钉住它的场景**（让 `applyPhaseUsage` 在锁错误之前推进过 `state`，
使返回值与盘上值分叉）；**构造不出再按人裁 118 登记「留着＋注释写明没被钉住」，并本轮重跑 M8**。
**不许直接抄「继承钉不住」的结论。**

- [ ] **Step 4: 跑全量确认绿**（同前，整份读回，红集合 ⊆ 那 7 条）

- [ ] **Step 5: 变异电池 ＋ 回头重跑 M3-2**

| 变异 | 期望红在 |
|---|---|
| M4-1：删掉 `:927` 新增那一支 | 本 Task 第 1 条 |
| M4-2：删掉 `:1745` 新增那一支 | 本 Task 第 2 条 |
| M4-3：detail 去掉 `${String(error)}`（只留前缀） | 两条各自的 `toContain("cannot be determined (EPERM)")` |
| **M3-2 重跑**（删掉 `runLoop.ts:761` 的重试支） | 记录实际红在哪；**若全绿，如实登记** |

- [ ] **Step 6: 提交**（message 英文，trailers 同前）

---

# Task 5: `resumeLoop` 两处处置点

**Files:** Modify `src/controller/resumeLoop.ts:225`、`:256`；
Modify `tests/controller/resumeLoop.integration.test.ts`（**只加**）

- [ ] **Step 1: 写失败判据** —— 两条，分别钉两处的 detail 前缀：
  `:225` ⇒ `owner-transfer lock liveness undetermined: ...`；
  `:256` ⇒ 同前缀，且**必须断言它不含 `claim CAS failed`**（那正是人裁 106 修掉的谎话形状）。

```ts
it("says the liveness could not be determined, rather than claiming a CAS it never evaluated", async () => {
  // Fixture copied verbatim from resumeLoop.integration.test.ts:319-326, which is the criterion
  // that pins the unattributable sibling. The ONLY change is the lock's contents: a pid:0 holder
  // parses fine and names a holder, so the record is attributable and only the probe fails.
  const repoPath = await createRepo();
  const contract = createContract(repoPath);
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  await seedEligibleRun(runDir, contract, 1);
  await writeFile(
    join(runDir, ".owner-transfer.lock"),
    JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-09-23T00:00:00.000Z" }),
  );

  const refusal = await resumeLoop(runDir, new ScriptedAdapter([successFrame()])).then(
    () => {
      throw new Error("expected the resume to be refused");
    },
    (caught: Error) => caught,
  );

  expect(refusal.message).toContain("owner-transfer lock liveness undetermined");
  expect(refusal.message).toContain("cannot be determined (EPERM)");
  expect(refusal.message).not.toContain("claim CAS failed");
  expect(refusal.message).not.toContain("cannot read run artifacts");

  const denied = (await readFile(join(runDir, "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; detail: string })
    .filter((event) => event.type === "resume_denied");
  expect(denied).toHaveLength(1);
  expect(denied[0].detail).toBe(refusal.message);
});
```

⚠️ 最后一条断言钉住「事件与抛出的错误**不会漂移**」—— 这正是 `:224` 注释里
「both halves of the detail kept in one variable so the event and the thrown error cannot drift apart」
所保护的性质。**照着保护它，不要只断言其中一个。**
⚠️ 上面的 `createRepo` / `createContract` / `seedEligibleRun` / `ScriptedAdapter` / `successFrame`
**都是该文件现测已有的夹具**（见 `:319-332`），照用即可，不要新造。

- [ ] **Step 2–3: 跑确认红 → 两处各加一支三元分支**（原注释逐字保留，块末追加 ERRATUM 引人裁 133）

- [ ] **Step 4: 跑全量确认绿**
- [ ] **Step 5: 变异电池 ＋ 回头重跑 M3-3**

| 变异 | 期望红在 |
|---|---|
| M5-1：删掉 `:225` 新增那一支 | 本 Task 第 1 条 |
| M5-2：删掉 `:256` 新增那一支 | 本 Task 第 2 条 |
| M5-3：把两处的 detail 改成共用一个字面量（让事件与错误漂移） | 第 2 条的 `expect(denied[0].detail).toBe(refusal.message)` |
| **M3-3 重跑** | 记录实际红在哪 |

- [ ] **Step 6: 提交**

---

# Task 6: `leaseHeartbeat` 两处处置点 ＋ 新事件类型 ＋ 第二个 once 标志

**Files:** Modify `src/controller/leaseHeartbeat.ts:45`（标志）、`:168`、`:287`；
Modify `tests/controller/leaseHeartbeat.test.ts`（**只加**）

- [ ] **Step 1: 写失败判据 —— 三条**

1. affirm 路径记一次 `owner_transfer_lock_liveness_undetermined`，detail 含 `lease affirm blocked:`
   与 `cannot be determined`，且**不抛进控制循环**（run 继续）。
2. release 路径记一次，detail 含 `lease release blocked:`。
3. ⭐ **两个标志独立** —— 同一个 run 里**先**抛 unattributable、**再**抛 liveness-undetermined，
   断言**两条事件都在**，且类型名各是各的：

```ts
it("records both lock errors in one run, because one flag cannot speak for the other", async () => {
  const runDir = await seed(record());

  // Fixture copied from leaseHeartbeat.test.ts:327-345. Two ticks, each meeting a different lock:
  // the first unparseable (unattributable), the second a pid:0 holder (liveness undetermined).
  const heartbeat = startLeaseHeartbeat({ runDir, ownerRecord: record(), onLeaseLost: () => {} });

  await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");
  await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
  await heartbeat.affirmNow();

  await writeFile(
    join(runDir, ".owner-transfer.lock"),
    JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-09-23T00:00:00.000Z" }),
  );
  await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
  await heartbeat.affirmNow();

  const types = await readEventTypes(runDir);
  expect(types.filter((type) => type === "owner_transfer_lock_unattributable")).toHaveLength(1);
  expect(types.filter((type) => type === "owner_transfer_lock_liveness_undetermined")).toHaveLength(1);
});
```

⚠️ **这条的场景最难造。** 执行者**先试着造**（两次 tick，各注入一种错误）。
**造不出来 ⇒ 按 I-2 轮控制器裁决 6 的先例如实登记「两个标志的独立性钉不住」，不编假判据**，
并在台账里写明试过什么、为什么不成。
⚠️ `seed` / `record` / `startLeaseHeartbeat` / `readEventTypes` / `LEASE_HEARTBEAT_INTERVAL_MS`
**都是该文件现测已有的夹具**（见 `:327-345`），照用即可，不要新造。

- [ ] **Step 2–3: 跑确认红 → 实现**

`:45` 附近加第二个标志：
```ts
  let unattributableLockRecorded = false;
  let livenessUndeterminedLockRecorded = false;
```

`:168` 与 `:287` 各加一支，用**新事件类型** `owner_transfer_lock_liveness_undetermined`
与**自己的标志**。原注释块逐字保留，末尾追加：

```ts
      // *** ERRATUM (ls lock visibility, HUMAN RULING 133) -- the paragraph above is kept verbatim
      // and ruling 119's finding is unchanged: consumers really do count these types, which is why
      // reusing one for a different fact broke two criteria. This branch applies the same finding
      // rather than the same type. owner_transfer_lock_unattributable would be a FALSE NAME here:
      // the record parsed and named a holder in the pid:<n> form, so the lock IS attributable and
      // only the probe failed. The flag is its own too -- sharing one would let the second of the
      // two facts be swallowed in a run that hits both, which is the silence this round exists to
      // remove. ***
```

- [ ] **Step 4: 跑全量确认绿** —— ⚠️ 特别核 `tests/controller/leaseLifecycle.integration.test.ts`
  里**数事件类型**的那些判据有没有从 1 变 2（人裁 119 就是这么被打红的）。
- [ ] **Step 5: 变异电池**

| 变异 | 期望红在 |
|---|---|
| M6-1：删掉 `:168` 新增那一支 | 第 1 条 |
| M6-2：删掉 `:287` 新增那一支 | 第 2 条 |
| M6-3：新事件类型换回 `owner_transfer_lock_unattributable` | 第 1、2 条（按名字数）**与**第 3 条 |
| M6-4：两个标志改回共用一个 | 第 3 条（**若第 3 条登记为钉不住，M6-4 就没有红证 —— 如实记**） |

- [ ] **Step 6: 提交**

---

# Task 7: `fileStore.ts:1572` 的逃逸点

**Files:** Modify `src/persistence/fileStore.ts:1568-1574`；Modify `tests/persistence/fileStore.test.ts`（**只加**）

**为什么单独一个 Task**：这是**唯一**一处「让错误逃出 catch」的语义，而它决定
`readOwnerRecord` 的调用方会不会**拿着一份 pre-transfer 记录继续决定所有权**。

- [ ] **Step 1: 写失败判据** —— 断言 `readOwnerRecord`（或其对应入口）在遇到
  liveness-undetermined 时**抛出**而不是静默返回，且错误是新类：

```ts
it("lets an undetermined-liveness lock escape the read, instead of publishing a pre-transfer record", async () => {
  const runDir = await makeRunDir();
  await writeFile(
    join(runDir, OWNER_TRANSFER_LOCK_FILE),
    JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-09-23T00:00:00.000Z" }),
  );
  // Seeding copied from the existing criterion in this file that pins the unattributable escape
  // (search it by its own words: the one asserting readOwnerRecord surfaces
  // OwnerTransferLockUnattributableError rather than returning a pre-transfer record). It needs a
  // transaction marker present so recovery is actually attempted; reuse that setup verbatim.

  const error = await readOwnerRecord(runDir).then(
    () => {
      throw new Error("expected the read to surface the lock error");
    },
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(OwnerTransferLockLivenessUndeterminedError);
  expect(String(error)).toContain("pid 0 does not name a process that can be probed");
});
```

⚠️ 该 seeding 步骤**照该文件里钉 unattributable 逃逸那条判据的现有夹具原样抄** —— 不要新造夹具。⚠️ **若现测发现 `pid:0` 走不到这条路径**（比如 recovery 根本没被触发），
**不许把判据改成能过的形状** —— 改用能真正触发 recovery 的夹具，或如实登记钉不住。

- [ ] **Step 2–3: 跑确认红 → 加一支**

```ts
      if (
        error instanceof OwnerTransferLockUnattributableError
        || error instanceof OwnerTransferLockLivenessUndeterminedError
      ) {
        throw error;
      }
```

原注释与 ERRATUM 块逐字保留，末尾追加引人裁 133 的新 ERRATUM，说明「唯一逃出的类」现在是**两个**。

- [ ] **Step 4–6: 跑全量 → 变异（删掉新增的 `||` 支 ⇒ 期望红在本 Task 那条）→ 提交**

---

# Task 8: `src/unlock/lockRows.ts`

**Files:** Create `src/unlock/lockRows.ts`、`tests/unlock/lockRows.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ReportedRunRow = RunObservation & { lock: LockInspection };
  export type ReportedScanRow = ReportedRunRow | ScanIssue;
  export type LockRowDeps = { inspect(runDir: string): Promise<LockInspection> };
  export const defaultLockRowDeps: LockRowDeps;
  export function attachLockInspections(rows: ScanRow[], deps: LockRowDeps): Promise<ReportedScanRow[]>;
  ```
  Task 9 与 Task 10 都依赖这些名字。

- [ ] **Step 1: 写失败判据**（新文件）

```ts
import { describe, expect, it } from "vitest";
import { attachLockInspections } from "../../src/unlock/lockRows.js";
import type { LockInspection } from "../../src/unlock/inspectLock.js";
import type { ScanRow } from "../../src/registry/scanRuns.js";

const runRow: ScanRow = {
  kind: "run",
  path: "/runs/run-1",
  observedAt: "2026-09-23T00:00:00.000Z",
  files: [],
};

const issueRow: ScanRow = { kind: "directory_unreadable", path: "/runs/bad", detail: "EACCES" };

describe("attachLockInspections", () => {
  it("attaches an inspection to every run row, including one with no lock on disk", async () => {
    const attached = await attachLockInspections([runRow], {
      inspect: async () => ({ state: "absent" }) as LockInspection,
    });

    // The literal, not the shape: a row whose `lock` key is missing reads as "never probed", which
    // is a different fact from "probed, and there is nothing there".
    expect(attached).toEqual([{ ...runRow, lock: { state: "absent" } }]);
  });

  it("never probes an issue row, and passes it through byte for byte", async () => {
    const probed: string[] = [];
    const attached = await attachLockInspections([issueRow, runRow], {
      inspect: async (runDir: string) => {
        probed.push(runDir);
        return { state: "absent" } as LockInspection;
      },
    });

    expect(probed).toEqual(["/runs/run-1"]);
    expect(attached[0]).toEqual(issueRow);
  });

  it("probes each run row at its own path, in scan order", async () => {
    const second: ScanRow = { ...runRow, path: "/runs/run-2" } as ScanRow;
    const probed: string[] = [];
    await attachLockInspections([runRow, issueRow, second], {
      inspect: async (runDir: string) => {
        probed.push(runDir);
        return { state: "absent" } as LockInspection;
      },
    });

    expect(probed).toEqual(["/runs/run-1", "/runs/run-2"]);
  });
});
```

- [ ] **Step 2: 跑确认红**（`Cannot find module '../../src/unlock/lockRows.js'`）

- [ ] **Step 3: 实现**

```ts
// The `ls` command's lock column. It is a SECOND consumer of inspectLock's single reader -- the
// first is unlockCommand -- and deliberately not a second reader: run-registry spec 7.2 exists to
// stop a second JSON reading implementation from drifting against the first.
//
// It lives beside that reader rather than inside the registry, and the reason is `sweep`: sweep
// runs scanRuns too (sweepRuns.ts), so making the inspector a ScanDeps dependency would start
// probing liveness inside a command that deliberately asks only whether a lock file exists. A
// separate layer leaves sweep untouched, and leaves registry's observation types -- which carry no
// derived meaning -- exactly as they are. Human ruling 131.
import type { RunObservation } from "../registry/observeRun.js";
import type { ScanIssue, ScanRow } from "../registry/scanRuns.js";
import { type LockInspection, inspectOwnerTransferLock } from "./inspectLock.js";

// Written as run-rows-with-a-lock UNIONED with issue rows, never as `ScanRow | (RunObservation &
// { lock })`: that spelling collapses back to ScanRow on assignment and leaves `row.lock` an error
// on access, which would quietly give up the guarantee the next line states.
export type ReportedRunRow = RunObservation & { lock: LockInspection };
export type ReportedScanRow = ReportedRunRow | ScanIssue;

export type LockRowDeps = { inspect(runDir: string): Promise<LockInspection> };

export const defaultLockRowDeps: LockRowDeps = { inspect: inspectOwnerTransferLock };

// EVERY run row gets a lock field, including `absent`. A missing key reads as "not probed", which
// is a different fact, and run-registry spec 15 #1 already refuses to omit rows for the same
// reason. Issue rows are passed through untouched: there is no run directory to probe.
export async function attachLockInspections(
  rows: ScanRow[],
  deps: LockRowDeps,
): Promise<ReportedScanRow[]> {
  const attached: ReportedScanRow[] = [];
  for (const row of rows) {
    if (row.kind !== "run") {
      attached.push(row);
      continue;
    }
    attached.push({ ...row, lock: await deps.inspect(row.path) });
  }
  return attached;
}
```

⚠️ **串行 `for` 循环，不用 `Promise.all`** —— 第三条判据钉住「按扫描顺序探测」，
并行会让顺序不确定。这也与 `sweep` 的串行风格一致。

- [ ] **Step 4: 跑判据 ＋ 全量 ＋ typecheck 确认绿**
- [ ] **Step 5: 变异电池**

| 变异 | 期望红在（**全名，且仅此**） |
|---|---|
| M8-1：去掉 `row.kind !== "run"` 判断（对 issue 行也探测） | `attachLockInspections > never probes an issue row, and passes it through byte for byte` |
| M8-2：只在 `lock.state !== "absent"` 时挂 `lock` | `attachLockInspections > attaches an inspection to every run row, including one with no lock on disk` |
| M8-3：改用 `Promise.all` 并反转结果顺序 | `attachLockInspections > probes each run row at its own path, in scan order` |
| M8-4：把 `deps.inspect(row.path)` 改成 `deps.inspect(rows[0].path)` | 第 2、3 条 |

- [ ] **Step 6: 提交**

---

# Task 9: `renderRuns.ts` 的七态锁块渲染

**Files:** Modify `src/registry/renderRuns.ts:10,14,39`；Modify `tests/registry/renderRuns.test.ts`（**只加**）

⚠️ **`schemaVersion` 保持 1，一个字不动。** 两条既有判据钉着它
（`tests/cli/cli.test.ts:141/154`、`tests/registry/renderRuns.test.ts:80/82`）。

**Interfaces:** Consumes Task 8 的 `ReportedScanRow`。

- [ ] **Step 1: 写失败判据 —— 七条，每态一条**

每条都断言**字面量**（不是形状）。样例两条，其余五条照此写全：

```ts
it("renders an unrecognized holder with its holder text and its full digest", () => {
  const out = renderScanTable(
    toScanResult([
      {
        kind: "run",
        path: "/runs/run-1",
        observedAt: "2026-09-23T00:00:00.000Z",
        files: [],
        lock: {
          state: "unrecognized-holder",
          holder: '["pid","1"]',
          // A literal digest, written out rather than computed: an expectation the code under test
          // produces can never fail.
          digest: "a".repeat(64),
          identity: { dev: 1, ino: 2 },
        },
      },
    ]),
  );

  expect(out).toContain("  owner-transfer.lock");
  expect(out).toContain("    state: unrecognized-holder");
  expect(out).toContain('    holder: ["pid","1"]');
  expect(out).toContain(`    digest: ${"a".repeat(64)}`);
  expect(out).toContain("    next: ccloop unlock /runs/run-1");
});

it("renders an unreadable lock file with no digest line at all, because it has no credential", () => {
  const out = renderScanTable(
    toScanResult([
      {
        kind: "run",
        path: "/runs/run-1",
        observedAt: "2026-09-23T00:00:00.000Z",
        files: [],
        lock: { state: "file-unreadable", reason: "EACCES" },
      },
    ]),
  );

  expect(out).toContain("    state: file-unreadable");
  expect(out).toContain("    reason: EACCES");
  // The one state with no digest: --force's credential is a hash of bytes that cannot be read.
  // Printing a digest line here would advertise an escape hatch that does not exist.
  expect(out).not.toContain("digest:");
});
```

其余五条：`absent`（**只有 `state:` 行，无 `next:`**）、`dead`、`alive`、`liveness-unknown`
（含 `reason:`）、`unparseable`（含 `reason:`，有 digest）。**七条的期望字面量见 spec §3.5。**

- [ ] **Step 2: 跑确认红**
- [ ] **Step 3: 实现** —— `:10`/`:14`/`:39` 的类型放宽为 `ReportedScanRow` / `ReportedRunRow`
  （**`import type` only**，不许值导入，否则 `sweepRuns.ts:14` 的值导入链会形成运行时环），
  并在 `renderRunRow` 里追加锁块渲染。
- [ ] **Step 4: 跑全量确认绿** —— ⚠️ 特别核 `tests/registry/renderRuns.test.ts:96-104` 那条
  「no derived column」判据：**现测它只禁 `/resumable|fresh|stale|expired/i` 与 `eligible`，
  预期它【照绿】。把这个观察记进台账** —— 它照绿是**已知的**，不是「没问题」的证据。
- [ ] **Step 5: 变异电池** —— 七态各一条删除式变异（删掉该态的渲染分支 ⇒ 期望红在该态那条判据），
  外加 M9-8：让 `file-unreadable` 也渲染 digest ⇒ 期望红在第 2 条。
- [ ] **Step 6: 提交**

---

# Task 10: `cli.ts` 接线 ＋ 端到端 ＋ 退出码 ＋ 零写证明

**Files:** Modify `src/cli.ts:281-290`；Modify `tests/cli/cli.test.ts`（**只加**）；
Modify `tests/registry/zeroWrite.test.ts`（**只加**）

- [ ] **Step 1: 写失败判据 —— 三条**

1. **人裁 85 的真终点**：`$ROOT` 下一个 run 目录放一把 `pid:0` 的锁，跑 `main(["ls", root])`，
   断言 stdout 含 `state: liveness-unknown` **且退出码为 0**。
2. **EACCES ⇒ exit 0**：`chmod 000` 的锁文件 ⇒ 行里 `state: file-unreadable`，**退出码仍 0**。
3. **零写证明覆盖 `ls` 全路径**：照 `tests/registry/zeroWrite.test.ts` 现有的 `snapshotTree`
   口径（`{ size, mtimeMs, sha256 }`），对 **`main(["ls", root])`** 前后比对，断言逐项相同。

⚠️ 第 3 条**必须以 `main(["ls", ...])` 为被测对象**，不是 `scanRuns` ——
现测 `zeroWrite.test.ts:216-226` 测的是 `scanRuns`，而锁探测在它之外，
**那段新代码今天没有任何零写证明覆盖**。

- [ ] **Step 2: 跑确认红**
- [ ] **Step 3: 实现** —— `ls` 分支改成：

```ts
      const rows = await scanRuns(parsed.root, defaultScanDeps);
      const failureDetail = scanRootFailureDetail(rows, parsed.root);
      if (failureDetail !== undefined) {
        console.error(failureDetail);
        return 1;
      }
      const result = toScanResult(await attachLockInspections(rows, defaultLockRowDeps));
```

⚠️ **锁探测放在 `scanRootFailureDetail` 判定【之后】** —— 根失败时一个 run 都没有，
提前探测只会在一条注定 exit 1 的路径上做无谓 I/O。

- [ ] **Step 4: 跑全量确认绿**
- [ ] **Step 5: 变异电池**

| 变异 | 期望红在 |
|---|---|
| M10-1：不调 `attachLockInspections`（直接 `toScanResult(rows)`） | 判据 1、2 |
| M10-2：把锁探测挪到 `scanRootFailureDetail` 之前 | **预期无红** ⇒ **如实登记为顺序优化，无判据承重** |
| M10-3：`file-unreadable` 时 `return 1` | 判据 2 |
| M10-4：在 `attachLockInspections` 里对每个 run 目录 `utimes` | 判据 3 |

⚠️ **M10-2 预期无红要写进台账**，不许因为它无红就把它当成「不需要」——
它是**性能**决定，spec 里已具名。

- [ ] **Step 6: 提交**

---

# Task 11: ERRATUM 全套 ＋ registry spec 更正节 ＋ 全树扫描

⚠️ **这一 Task 的顺序不能提前** —— 注释要引用最终落地的行为，而行为到 Task 10 才定型。

**Files:** Modify `src/sweep/lockPresence.ts`（**只追加 ERRATUM**）、
`src/persistence/fileStore.ts:881`、`:946`、`:1379` 块末；
`docs/superpowers/specs/2026-07-28-run-registry-design.md`（追加更正节）

- [ ] **Step 1: 先做全树扫描，清单【从被更正的句子机械导出】**

```bash
/usr/bin/python3 - <<'PY' > /tmp/t11-scan.txt 2>&1
import pathlib, re
# Terms derived mechanically from the sentences this round falsifies. BOTH languages: the repo's
# living documents are in Chinese and an English-only term list scores zero against them.
terms = [
    "not-determined-dead", "two-state", "three-state", "classifyHolderLiveness",
    "isProcessActive", "no derived field", "no derived judgment",
    "judging liveness in a reporting path", "will never be released",
    "exported for `ccloop unlock`", "schemaVersion",
    "两态", "三态", "报告路径", "永不", "派生",
]
roots = ["src", "tests", "docs", ".superpowers"]
for t in terms:
    hits = []
    for r in roots:
        for p in pathlib.Path(r).rglob("*"):
            if not p.is_file() or p.suffix not in {".ts", ".md", ".mjs", ".js"}:
                continue
            try:
                for n, line in enumerate(p.read_text(encoding="utf-8").split("\n"), 1):
                    if t in line:
                        hits.append(f"{p}:{n}")
            except Exception:
                pass
    print(f"=== {t} === {len(hits)}")
    for h in hits:
        print("   ", h)
PY
cat /tmp/t11-scan.txt
```

⚠️ **扫描器先自测**：把一个已知必命中的词（如 `isProcessActive`）与一个已知必不命中的词
（如 `zzz-not-present`）各跑一次，确认前者 > 0、后者 == 0。**恒返回 0 与恒命中全部行的扫描器一样没用。**

- [ ] **Step 2: 逐处追加 ERRATUM**（清单见 spec §7，**扫描结果可能比它多，以扫描为准**）
- [ ] **Step 3: `docs/superpowers/specs/2026-07-28-run-registry-design.md` 追加更正节**

```markdown
## ERRATUM (ls lock visibility, HUMAN RULING 131)

§6 「There is no "can this be resumed" column, and no derived field of any kind」与
§15 #3 「The output contains no derived judgment about eligibility, resumability, or lease
freshness — enforced by a test, not by convention」**原文逐字保留**，但它们**不再描述 `ccloop ls`
的输出**：人裁 131 让 `ls` 报告 owner-transfer 锁的七态检查结果，而 `alive`／`dead`／
`liveness-unknown` 就是 derived judgment。

被推翻的**只有输出形状那一条**。registry 的**观测类型**（`types.ts` 的 `FieldObservation`）
仍然不带派生含义 —— 锁块不进 `FieldObservation`，它由 `src/unlock/lockRows.ts` 挂在行上。

⚠️ §15 #3 自称「enforced by a test」。**现测那条判据接不住这个新列** ——
它只禁 `/resumable|fresh|stale|expired/i` 与 `eligible`，`lock`／`state` 一个都不撞。
**本轮实测它照绿。** 记在这里，免得下一轮把「它照绿」读成「没问题」。
```

- [ ] **Step 4: 重跑扫描确认收敛**（改完再扫一次，**跑到零残留为止，不是跑一次**）
- [ ] **Step 5: 跑全量 ＋ typecheck ＋ build 确认绿**
- [ ] **Step 6: 提交**

---

# Task 12: 判据脚本 ＋ 变异电池总账

**Files:** Create `scripts/check-known-reds.mjs`

- [ ] **Step 1: 写脚本**（判据 1 的机械子集判定，spec §8）

```js
#!/usr/bin/env node
// Decides the round's baseline criterion mechanically: the set of failing tests must be a SUBSET
// of the seven known reds, compared by FULL NAME. Counting is not enough -- a new failure and a
// silenced flake give the same count.
import { readFileSync } from "node:fs";

const KNOWN_REDS = new Set([
  "tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone",
  "run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid",
  "runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals",
  "runLoop > accounts an execute timeout that rejects after the abort as exhaustion",
  "run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data",
  "SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute",
  "Codex phase process > kills a TERM-ignoring process before returning abort",
]);

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const failed = [];
for (const file of report.testResults ?? []) {
  for (const test of file.assertionResults ?? []) {
    if (test.status === "failed") {
      failed.push(test.fullName ?? test.title);
    }
  }
}

const unexpected = failed.filter(
  (name) => ![...KNOWN_REDS].some((known) => known.endsWith(name) || name.endsWith(known)),
);

console.log(`failed: ${failed.length}`);
for (const name of failed) console.log(`  ${name}`);
console.log(`unexpected: ${unexpected.length}`);
for (const name of unexpected) console.log(`  UNEXPECTED ${name}`);

process.exit(unexpected.length === 0 ? 0 : 1);
```

- [ ] **Step 2: 自测脚本本身（必抓 ＋ 必不抓）**

```bash
node -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fake-ok.json", JSON.stringify({testResults:[{assertionResults:[
 {status:"failed",fullName:"quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone"}]}]}));
fs.writeFileSync("/tmp/fake-bad.json", JSON.stringify({testResults:[{assertionResults:[
 {status:"failed",fullName:"something brand new > that nobody has seen"}]}]}));'
node scripts/check-known-reds.mjs /tmp/fake-ok.json;  echo "known-only RC=$? (expect 0)"
node scripts/check-known-reds.mjs /tmp/fake-bad.json; echo "new-red   RC=$? (expect 1)"
```

⚠️ **两个 RC 都对，脚本才算数。** 只跑「必不抓」那一半，恒返回 0 的脚本也能过。

- [ ] **Step 3: 用真实跑验一次**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/reds.json > /tmp/reds.log 2>&1
node scripts/check-known-reds.mjs /tmp/reds.json > /tmp/reds-verdict.txt 2>&1; echo "RC=$?" >> /tmp/reds-verdict.txt
cat /tmp/reds-verdict.txt
```

- [ ] **Step 4: 变异电池总账落台账**

把 Task 1–10 的每条变异**逐格**记进
`.superpowers/sdd/2026-09-23-ls-lock-visibility/progress.md`：**变异名 / 喂它的场景 /
期望红在哪 / 实际红在哪 / 落上去的 sha256 前后值**。
⚠️ **「没跑过的那条变异不是证据」** —— 表里每一格都必须有「实际」列，空的就是没做。
⚠️ **M3-2／M3-3 的重跑结果、M10-2 的「预期无红」、以及所有登记为「钉不住」的项，都要在这里具名。**

- [ ] **Step 5: 提交**

---

## 交付前的最终核对（**执行者逐条跑，不是逐条读**）

```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/final.json > /tmp/final.log 2>&1
node scripts/check-known-reds.mjs /tmp/final.json > /tmp/final-verdict.txt 2>&1; echo "RC=$?" >> /tmp/final-verdict.txt
npm run typecheck > /tmp/final-tc.txt 2>&1; echo "RC=$?" >> /tmp/final-tc.txt
npm run build     > /tmp/final-build.txt 2>&1; echo "RC=$?" >> /tmp/final-build.txt
/usr/bin/git status --short > /tmp/final-status.txt 2>&1
/usr/bin/git log --oneline -15 --format='%s%n  %(trailers:key=Co-Authored-By)' > /tmp/final-log.txt 2>&1
cat /tmp/final-verdict.txt /tmp/final-tc.txt /tmp/final-build.txt /tmp/final-status.txt /tmp/final-log.txt
```

**全部满足才算完成：**
1. `check-known-reds` RC **0**
2. `typecheck` RC **0**、`build` RC **0**
3. `git status --short` **空**
4. 每一笔的 `Co-Authored-By` 都是 `Claude Opus 5 (1M context)`
5. 变异总账里**每条变异都有「实际红在哪」**，登记为「钉不住」的都写明试过什么
6. **一条既有判据都没改** —— 若改了，清单已交人按人裁 88 指名
