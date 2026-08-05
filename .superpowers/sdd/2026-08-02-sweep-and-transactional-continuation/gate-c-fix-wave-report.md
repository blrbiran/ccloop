# GATE-C 修复波报告 —— 人裁六件

**实施者**：GATE-C 修复波唯一实施者。
**分支**：`feat/l3-group-c-sweep`，worktree `/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep`，开工 HEAD = `4a24a94`，树干净。
**环境**：`export ECC_GATEGUARD=off DISABLE_OMC=1`，每条命令目录写死 `rtk proxy "bash -c 'cd <worktree> && …'"`，**输出零过滤**（无 `grep` / `tail` / `head` 出现在任何验证跑上）。
**基线核对**：本分支 30 文件 / 512 用例（主仓 29 / 490）。本波新增 2 条测试，收尾为 **30 / 514**，`RUN` 首行为 worktree —— 见 §7。

六件全做完，没有挑。下面逐件。

---

## A【人裁】把报告行的 `detail` 折成单行，并改掉那句假理由

### A.1 改了什么

`src/sweep/sweepRuns.ts`，报告行的 sink 调用：

```ts
    const sink = report.outcome === "error" ? options.stderr : options.stdout;
    // §8 is "one line per attempted run", and `detail` is a String(error): a ZodError out of
    // loadContract runs to a dozen lines. Unfolded, one run becomes that many output lines, all
    // but the first without a path column — and a cron job parsing the report by line reads one
    // run as a dozen ownerless records. Folded on the same rule as the note line above.
    sink(`${candidate.path}\t${report.outcome}\t${report.detail.replace(/\r?\n/g, " ")}`);
```

**那句假理由**（在 `onReconciliationWriteAbandoned` 回调上方）原文是：

> `detail` is a String(error) and a SyntaxError message can contain newlines, which would
> split one note into what looks like several output lines. Folded only here — §8's
> `errored` line has the same problem, **predates this wave**, and is deliberately left alone.

「predates this wave」为假：三列报告行本身就是 C1 建、C3 定格的**本波产物**。改成：

> …The three-column report line
> below folds for the same reason and by the same rule — **it is this wave's own output, not
> something inherited**, and §8's "one line per attempted run" is its whole contract.

### A.2 补了一条能钉住它的测试（现有测试没有一条能钉）

**为什么必须补**：改之前，全仓没有任何一条断言喂给报告行一个带换行的 `detail`。逐条查过 `tests/sweep/sweepRuns.test.ts` 的报告格式测试（八格 outcome 全覆盖，`detail` 全是单行）、12c 路由测试（两条 message 都单行）、12d(i) 的折行断言（钉的是 **`note` 行**，不是报告行）。折行加不加，全套件都是绿的。

**补在**：`tests/sweep/sweepRuns.test.ts`，紧挨 12c 路由测试之前（同属「输出格式契约」一族）。
**新测试名（裸 `it`）**：`folds a multi-line detail so one attempted run stays one report line`

**为什么这么写**：
- **两个 sink 都走**（run-1 走 stdout/`refused`，run-2 走 stderr/`error`）。折行是**两条支路共用的一个表达式**，只测 stderr 那侧的话，「只在 `error` 分支折行」这种半吊子实现照样绿。
- **前置条件先断言**（`expect(multilineRefusal).toContain("\n")` 两条）：否则折行断言可能跑在一个本来就不需要折行的字符串上，绿得毫无意义。
- **最后一条是性质本身**：两个 attempted run ⇒ 恰好两条报告行，每条不含 `\n`、恰好三列。字面量相等可以被巧合满足，这条不能。

### A.3 变异（三步齐走）

**注入**：`src/sweep/sweepRuns.ts` 去掉 `.replace(/\r?\n/g, " ")`，带标记 `// GATECFIX-MUT-A`。

**(1) 注入前，具名单跑绿：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (13 tests | 12 skipped) 3ms

 Test Files  1 passed (1)
      Tests  1 passed | 12 skipped (13)
   Start at  01:19:27
   Duration  439ms (transform 125ms, setup 0ms, collect 157ms, tests 3ms, environment 0ms, prepare 42ms)

PRE_MUTA_EXIT=0
```

**(2) 注入后，具名单跑红：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (13 tests | 1 failed | 12 skipped) 7ms
   × sweepRuns > folds a multi-line detail so one attempted run stays one report line 7ms
     → expected [ …(2) ] to deeply equal [ …(2) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts > sweepRuns > folds a multi-line detail so one attempted run stays one report line
AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]

- Expected
+ Received

  Array [
-   "/fake/root/run-1	refused	run status succeeded is not resumable   (reported by criterion 3)",
+   "/fake/root/run-1	refused	run status succeeded is not resumable
+   (reported by criterion 3)",
    "2 attempted, 0 succeeded, 1 refused, 1 errored (quota 1/100)",
  ]

 ❯ tests/sweep/sweepRuns.test.ts:522:27
    520| 
    521|     expect(exitCode).toBe(0);
    522|     expect(h.stdoutLines).toEqual([
       |                           ^
    523|       `${ROOT}/run-1\trefused\trun status succeeded is not resumable  …
    524|       "2 attempted, 0 succeeded, 1 refused, 1 errored (quota 1/100)",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 12 skipped (13)
   Start at  01:19:39
   Duration  396ms (transform 124ms, setup 0ms, collect 162ms, tests 7ms, environment 0ms, prepare 51ms)

POST_MUTA_EXIT=1
```

**机制与声称一致**：一条报告行在 received 里裂成了两行，第二行不带 path 列——正是 lane 1 描述的 cron 侧失效形状。

**(2b) 同一注入下，C 的新端到端用例也红（附带证据，非替代）**：见 §C.3 的 `MUTA_E2E_EXIT=1` 一段——那一次红里的 received 是**生产 zod 打出来的真 ZodError**，逐行照贴在 §C.3。这说明折行不是纸面担忧：真实数据通路上它就是多行。

**(3) 还原后绿 + 标记零命中：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (13 tests | 12 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 12 skipped (13)
   Start at  01:20:05
   Duration  470ms (transform 158ms, setup 0ms, collect 179ms, tests 2ms, environment 0ms, prepare 83ms)

RESTORED_MUTA_EXIT=0
MARKER_GREP_EXIT=1          ← grep -rnF GATECFIX-MUT-A src tests：零命中
 M src/sweep/sweepRuns.ts
PORCELAIN_ABOVE             ← 这一行 M 是本波该改的那处，不是变异残留
```

**还原证明用的是能真正命中我所用标记的命令**：注入体里写的字面串就是 `GATECFIX-MUT-A`，`grep -rnF GATECFIX-MUT-A` 在注入期间必然命中，还原后 exit 1（零命中）。§7 收尾还有一次三标记合扫。

---

## B【人裁】给横幅补一句 observed-only 限定（三件一起做）

### B.1 改横幅措辞

**旧**：`sweep: 3 eligible run(s) under /fake/root, will attempt at most 2, adapter=claude`
**新（逐字）**：

```
sweep: 3 run(s) under /fake/root observed eligibleForContinuation=true (an observed field, not a decision that the run may be resumed), will attempt at most 2, adapter=claude
```

**口气来源，去读过而不是凭印象**：`src/registry/renderRuns.ts` 的 `CONSISTENCY_NOTICE`（实测）：

```
$ ... grep -nF 'eligibleForContinuation is an observed field' src/registry/renderRuns.ts
60:  "eligibleForContinuation is an observed field, not a decision that the run may be resumed.";
```

新横幅把该句的后半段原样搬过来（`an observed field, not a decision that the run may be resumed`），使同仓库两个只读表面对**同一个字段**说同一句话。

**守住的线**：新措辞里没有「保证 / 一定 / 能续跑 / will be resumed」任何形式；它只说这个字段被观测为 true，并明说这不是「该 run 可被 resume」的判定。**两个数字一个没少**（候选集大小与配额 N 都还在，§12 的「知情且有界」两半都在）。

代码注释里同步写下了理由（17 个 run 全被门拒的场景、只覆盖八条判据第 1 条、与 `ccloop ls` 对齐）。

### B.2 就地勘误计划（只动真正相关的那一处）

**先 grep 找准是哪一节**（未过滤）：

```
$ ... grep -nF "eligible run(s) under" docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md
1643:  `sweep: <eligible> eligible run(s) under <root>, will attempt at most <N>, adapter=<name>`
GREP_EXIT=0
```

```
$ ... grep -nF "### Task C" docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md
1406:### Task C1: `src/sweep/sweepRuns.ts` —— 扫描、过滤、排序、配额、顺序续跑
1526:### Task C2: CLI 表面 —— `sweep` 分支、`--max-runs`、退出码、`registerStopHandlers`
1628:### Task C3: 报告、横幅与错误路由（含 `reconciliation_write_abandoned` 的 stderr 备注行）
1811:### Task C4: 写面钉定（测试 14 与 14b）
```

⇒ **1643 落在 `### Task C3`（1628–1810）内，全文档只此一处**。`### Task C1` 里提到横幅但不含字面量，**未动**。

**形状照抄既有判例**：先 `grep -nF 'Amended 2026-08-0'` 读了既有十余处（49 / 72 / 87 / 658 / 661 / 678 / 691 / 695 / 1164 / 1290 / 1565 / 1666 / 1679 / 1715 / 1757 / 1761 行），统一形状是 `**Amended <日期>：<被推翻的那句话>。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。<理由> **读作**：<新读法> <落地字面量>`。本次照此写，标 `Amended 2026-08-05`，**原文一个字没删，只在其下增补**，并且**没有夹带任何「将来该怎么改」的建议**。

### B.3 同步被横幅字面量钉住的测试

**全仓扫一遍字面量落点**（未过滤）：

```
$ ... grep -rnF "eligible run(s) under" src tests docs .superpowers
src/sweep/sweepRuns.ts:139:...
tests/sweep/sweepRuns.test.ts:352:...
tests/sweep/sweepRuns.test.ts:386:...
tests/sweep/sweepRuns.test.ts:602:...
tests/registry/zeroWrite.test.ts:529:...
tests/registry/zeroWrite.test.ts:752:...
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1643:...
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1554:...
```

**派单点名的是 C1 那条（`sweepRuns > prints the banner before constructing the adapter`，`tests/sweep/sweepRuns.test.ts:352`），但实测钉住字面量的测试站点是 5 个，不是 1 个。** 全部同步（不同步就是红）：

| 站点 | 测试 | 处置 |
|---|---|---|
| `sweepRuns.test.ts:352` | `prints the banner before constructing the adapter`（C1，`toBe` 钉全字面） | 换新字面量，**顺序断言一条没动** |
| `sweepRuns.test.ts:386` | `prints the banner with the eligible count and the quota before constructing the adapter`（C3） | 换新字面量 |
| `sweepRuns.test.ts:602` | `keeps the abandonment note on stderr even when the run throws afterwards`（stderr 三行数组） | 换新字面量 |
| `zeroWrite.test.ts:529` | C4 测试 14 | 换新字面量 |
| `zeroWrite.test.ts:752` | C4 测试 14b | 换新字面量 |

**C1 那条要钉的「顺序」仍被钉住，逐条核过**：该测试的三条断言分工是 (a) `order.filter(=== "createAdapter")` 恰好一次、(b) `order[0]` 是横幅、(c) `order[1]` 是 `createAdapter`。我只换了 (b) 里的字面量，(a)(c) 一字未动 —— 「横幅在前、adapter 构造在后」这条顺序性质由 (b)+(c) 的下标关系承载，仍然成立。测试正文里那句「Literal updated by task C3 … the ORDERING this test pins is unchanged」也同步补记了本波这次更换。

**另外两条含数字断言的测试也复核过、无需改**：`attempts only the first max-runs directories…` 用 `banner).toContain("5")` / `toContain("2")`——新横幅里 `5 run(s)` 与 `at most 2` 依旧带这两个数字。

---

## C【人裁】补一条端到端测试，钉住那条跨模块字符串契约

### C.1 缺口复核（不接受转述，自己查）

```
$ ... grep -rnF "cannot read run artifacts" src/ tests/
src/controller/resumeLoop.ts:144   ← resume_denied 的 detail（生产侧写）
src/controller/resumeLoop.ts:145   ← throw ResumeNotEligibleError（生产侧写）
src/sweep/sweepRuns.ts:66          ← classifyThrow 的 startsWith("cannot read run artifacts:")（sweep 侧读）
tests/cli/cli.test.ts:77           ← stringContaining("cannot read run artifacts")  ← 不带冒号
tests/persistence/fileStore.test.ts:3702  ← startsWith("cannot read run artifacts") ← 不带冒号
tests/sweep/sweepRuns.test.ts:493/498/499 ← 12c 自己的字面量（替身 message，不经生产码）
```

**lane 1 的自陈成立**：12c 注入替身 `resume`，message 是测试文件里的字面量，生产 `resumeLoop` 根本没被进入；两道间接护栏都**不带冒号**。于是「只改冒号之后」这种改法可以让 sweep 的路由整体失效而三处全绿。§C.3 的变异把这一点从「论证」变成了「实测」。

### C.2 补的用例

**放在**：`tests/registry/zeroWrite.test.ts` 的 `describe("sweep write surface")` —— 这是全仓**唯一**已经在真实文件系统上驱动 `sweepRuns` 且不注入替身 `resume` 的地方（C4 的测试 14/14b 就在这里）。**没有新建文件。** 放进 `tests/sweep/sweepRuns.test.ts` 会与该文件头逐字承诺的「Every test drives the real sweepRuns with an injected `resume` stand-in」直接冲突。

**新测试名（裸 `it`）**：`routes a real unreadable-artifacts refusal out of resumeLoop to stderr as one error line`

**fixture**：复用 C4 的 `seedGateRefusedRun`（L2 观测 eligible），只把 `loop-contract.json` 换成合法 JSON、但不合 `loopContractSchema` 的内容 ⇒ `loadContract`（`resumeLoop` 那个 `Promise.all` 的第五个读）抛 **ZodError** ⇒ 生产 `resumeLoop` 走 `cannot read run artifacts:` 那条路。**这正是 lane 1 描述的场景，只是由生产码而不是替身产生。**

**关键设计：不重述任何一侧的字面量。** 期望的报告行是**从 `resumeLoop` 自己写进 `events.jsonl` 的 `resume_denied` detail 推导出来的**：

```ts
expect(stderrLines.slice(1)).toEqual([`${runDir}\terror\t${detail.replace(/\r?\n/g, " ")}`]);
expect(stdoutLines).toEqual(["1 attempted, 0 succeeded, 0 refused, 1 errored (quota 0/5)"]);
```

两侧任何一侧的字面量移动，这条就红——这才是「把两侧绑在一起」，而不是把字面量抄第三遍。
另加两条前置条件断言：`expect(detail).toContain("\n")`（折行非空洞；将来 zod 若把 message 变成单行，这条**响亮**失败而不是静默失效）与 `readEventTypes(runDir)` 恰好 `["fixture_seed","resume_requested","resume_denied"]`（生产 `resumeLoop` 确实被进入且确实在读侧拒绝）。

**`src/controller/resumeLoop.ts` 一个字节没改**（只在变异期间临时改，随后还原并证明——见 §C.3 与 §7）。

### C.3 变异（三步齐走，只改冒号之后）

**注入**：`src/controller/resumeLoop.ts` 第 144、145 行，`cannot read run artifacts:` → `cannot read run artifacts for:`（两处，各带 `// GATECFIX-MUT-C`）。**前缀 `cannot read run artifacts` 完整保留**，被改掉的只有紧接其后的那一格——正是派单说的那种改法。

**(1) 注入前，具名单跑绿：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/registry/zeroWrite.test.ts (5 tests | 4 skipped) 9ms

 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
   Start at  01:19:28
   Duration  490ms (transform 147ms, setup 0ms, collect 163ms, tests 9ms, environment 0ms, prepare 89ms)

PRE_MUTC_EXIT=0
```

**(2) 注入后，具名单跑红：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/registry/zeroWrite.test.ts (5 tests | 1 failed | 4 skipped) 13ms
   × sweep write surface > routes a real unreadable-artifacts refusal out of resumeLoop to stderr as one error line 12ms
     → expected [] to deeply equal [ Array(1) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/registry/zeroWrite.test.ts > sweep write surface > routes a real unreadable-artifacts refusal out of resumeLoop to stderr as one error line
AssertionError: expected [] to deeply equal [ Array(1) ]

- Expected
+ Received

- Array [
-   "…/scan-root/run-unreadable-contract	error	cannot read run artifacts for: [   {     \"code\": \"invalid_type\", …  } ]",
- ]
+ Array []

 ❯ tests/registry/zeroWrite.test.ts:640:36
    638|       // only what follows the colon — and this run is classified `ref…
    639|       // instead, taking both of these assertions with it.
    640|       expect(stderrLines.slice(1)).toEqual([`${runDir}\terror\t${detai…
    641|       expect(stdoutLines).toEqual(["1 attempted, 0 succeeded, 0 refuse…
    642|     } finally {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 4 skipped (5)
   Start at  01:20:24
   Duration  509ms (transform 120ms, setup 0ms, collect 157ms, tests 13ms, environment 0ms, prepare 52ms)

MUTC_POST_EXIT=1
```

（received 的 `Array []` 中间那一大段 ZodError 已在上面的 Expected 行里逐字给出；为可读只在此处省略了中段重复的 issue 条目，**完整未省略的同一串**见下方 §C.3 的 MUT-A 那次输出。）

**红的机制正是 §4.4 的失效形状**：`expected [Array(1)] → received Array []` —— **banner 之后 stderr 上一个字都没有**。那个 run 没有消失，它被降级成了 `refused` 印在 stdout 上、exit 0，cron 永不告警。

**(2b) 两道间接护栏在同一注入下是否双双存活 —— 实测：双双存活。**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

（stderr/stdout 调试块原样：cli.test.ts 的三段 missing required flags / ENOENT / ls 表格）

 ✓ tests/persistence/fileStore.test.ts (76 tests) 841ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 665ms
 ✓ tests/cli/cli.test.ts (23 tests) 1024ms

 Test Files  2 passed (2)
      Tests  99 passed (99)
   Start at  01:20:31
   Duration  1.56s (transform 273ms, setup 0ms, collect 523ms, tests 1.87s, environment 0ms, prepare 88ms)

MUTC_GUARDS_EXIT=0
```

**99 passed / exit 0 —— lane 1 的说法逐字成立。** 这就是新用例价值的证据：在这次注入下，全仓**只有新用例**是红的。

**(3) 还原后绿 + 三重证明：**

```
 ✓ tests/registry/zeroWrite.test.ts (5 tests | 4 skipped) 8ms
 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
   Start at  01:20:47
RESTORED_MUTC_EXIT=0
MARKER_GREP_EXIT=1     ← grep -rnF -e GATECFIX-MUT-C -e GATECFIX-MUT-A -e "cannot read run artifacts for" src tests：零命中
 M src/sweep/sweepRuns.ts
 M tests/registry/zeroWrite.test.ts
 M tests/sweep/sweepRuns.test.ts
PORCELAIN_ABOVE        ← src/controller/resumeLoop.ts 不在列
RESUMELOOP_DIFFSTAT_ABOVE  ← git diff --stat src/controller/resumeLoop.ts 零输出：与 HEAD 逐字节相同
```

**还原证明命中的是我实际注入的东西**：`GATECFIX-MUT-C` 是我写进文件的字面串，`cannot read run artifacts for` 是被注入的**内容**本身——两者任一残留都会被这条 `-F` 抓到。

---

## D 报告卫生（三处，都是文档）

### D.1 C3 报告 §3.1 的预测表（同族笔误未清干净）

`task-C3-report.md` §3.1 那张预测表末行原写「内含 **17 + 4** 行期望字面分歧」，而 §3.3 早在修复轮 1 就更正为 **13 + 4 = 17**。修复轮 1 只改了 §3.3 一处，**同一处算术在同一份报告里两种写法并存**。

**已就地改为 `13 + 4 = 17`**，并按该文件既有的更正体例加了一段 `（*GATE-C 修复波更正 2026-08-05*：…）`，写明原写法、为什么错、正确拆分与其依据（§3.2 自己贴的「gap 01–13 共 13 行、gap 01–04 共 4 行」）。**只改了这一格的数字，预测本身与其余各格未动。**

### D.2 C3 报告 §9 的变异清单标题作废 —— 补了覆盖全部 7 次的索引

标题「计划的四次 + 我自己加的第五次」在两轮修复之后作废：C3 实际有 **7 次**变异，散在**三个互不索引的章节**（§3、§9、修复轮 1／2）。只读 §9 会数出 5，并且漏掉的恰好是最载重的两条。

**已在 §9 抬头补一张 7 行索引表**（原标题保留不删），每行给：变异内容 / 落点章节 / **来自哪一轮** / 目标测试 / 结果。逐条如下（标注「来自修复轮」的是第 6、7 两条）：

| # | 变异 | 落点 | 来自哪一轮 | 结果 |
|---|---|---|---|---|
| 1 | 改 `resumeLoop.ts` 前缀字面量（原版） | §3.2 | 计划 Step 7 | **存活**，已上报人裁 |
| 2 | note 路由进 `error` 格 | §9.1 | 计划 Step 7 | 击杀 |
| 3 | 退回「不路由」 | §9.2 | 计划 Step 7 | 击杀 |
| 4 | 「`resume` 返回后才记」 | §9.3 | 计划 Step 7 | 击杀 |
| 5 | 删 `\|\| RunLeaseHeldError` | §9.3b | **计划外，实施者自加** | 击杀 |
| 6 | 改 `sweepRuns.ts` 自己的前缀字面量（替换版） | **R1.2** | **修复轮 1（人裁）** | 击杀 12c |
| 7 | 缓冲变异（note 收数组、循环后冲出） | **R2.2** | **修复轮 2（人裁）** | 击杀 12d(ii) 的顺序断言 |

并写下三条读法提醒：第 1 条是存活不是击杀（其击杀职责今天由第 6 条承担）；第 6、7 不在 §9；§9.4 那份「五次变异的还原总证明」按字面只覆盖第 2–5 并转引 §3.2 的第 1 条，第 6、7 的还原证明**就地写在 R1.2 与 R2.2 自己的小节里**（标记分别是 `C3-MUTATION-1B` 与 `C3-MUTATION-BUFFERED`），**没有任何一处总证明同时覆盖全部 7 次**。

> **自曝一处：这一段我第一版写错了。** 初稿写作「第 6、7 两条的还原证明分别在 R1.4 与 R2.4」，是凭章节名推的。落笔后去读了原文，实际在 R1.2 与 R2.2 自己的小节内（R1.4／R2.4 是收尾验证节，装的是守卫与全套件）。**已在提交前改正**，此处记账。

### D.3 C4 报告 §B 的论证错误（断言对，机制错）

`task-C4-report.md` §B「伴生断言本身的非空洞性」原文：「`{}` 与 `{}` 深比较相等，所以**「目录不存在 / 快照为空」**会让主断言空过」。

**「目录不存在」那一半是假的**：`snapshotTree` 用 `readdir` 走树，目录缺失直接抛 ENOENT，那个空过场景在结构上根本构造不出来（lane 2 §3.1 探针 5 实测：干脆不建那个目录，红在 `snapshotTree` 自身而不是主断言）。

**已改**：机制表述收敛为「**快照为空**」这一种，并加一段 `（*GATE-C 修复波更正 2026-08-05*：…）` 写明原文、为什么假、以及**那条 `seededFiles` 断言本身是对的、也仍然必要**（它挡的是「目录在但为空」那一半）。**测试一个字节未动**——被改的只是印在断言旁边的机制表述。

---

## 硬边界与守卫（自己数，贴输出）

```
$ ... grep -cF "return { ok: false" src/controller/resumeLoop.ts
8
CRITERIA_GREP_EXIT=0

$ ... grep -rnF "currentOwnerEpoch + 1" src/
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
EPOCH_GREP_EXIT=0          ← 单点

$ ... git diff --stat src/registry/
REGISTRY_DIFFSTAT_ABOVE    ← 上方零输出：src/registry/ 零改动

$ ... git diff --stat
 ...6-08-02-sweep-and-transactional-continuation.md |  4 ++
 src/sweep/sweepRuns.ts                             | 22 +++++--
 tests/registry/zeroWrite.test.ts                   | 74 +++++++++++++++++++++-
 tests/sweep/sweepRuns.test.ts                      | 61 ++++++++++++++++--
 4 files changed, 151 insertions(+), 10 deletions(-)
FULL_DIFFSTAT_ABOVE
```

**改动面就是这 4 个文件**（+ 三份 SDD 报告，它们在 `.superpowers/sdd/` 下、被 `.superpowers/sdd/.gitignore` 的 `*` 覆盖、不进提交）。

**不许动的东西，一处未动**：`stop()` / `isLeaseStopError` 的谓词与签名 / B1 在 `runLoopFromState` 外层 catch 的分支及其与 `isLeaseStopError` 的先后 / B2 的停机槽 / `onReconciliationWriteAbandoned` 的两处转发 / `transferRepresentsPublishedWinner` —— 这些全在 `src/controller/runLoop.ts`、`src/ownership/`、`src/persistence/fileStore.ts` 里，本波对这三处的 `git diff` 为空（上方 diffstat 未列出）。C1 的流水线顺序与配额语义（`adopted`/`onAdopted`/`break`）、C2 的类型收窄、C3 的即时写回调**均未触碰**：`sweepRuns.ts` 的 22 行改动全部落在①报告行 sink 的一处表达式 + 4 行注释、②横幅字符串 + 8 行注释、③note 回调上方那句假理由的措辞。

---

## 收尾验证（未过滤）

### 全套件

```
> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (13 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 460ms
 ✓ tests/registry/zeroWrite.test.ts (5 tests) 513ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/registry/renderRuns.test.ts (11 tests) 8ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-9Cp4n9/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-BaSU0D/run-1  observed 2026-08-04T17:23:33.870Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/registry/scanRuns.test.ts (9 tests) 6ms
 ✓ tests/cli/cli.test.ts (23 tests) 1585ms
   ✓ parseArgs > returns 0 for the scripted example run 326ms
   ✓ main sweep > exits 0 when a run reaches exhausted 422ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 27ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 3002ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 2458ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 91ms
 ✓ tests/ownership/lease.test.ts (16 tests) 9ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 3256ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 334ms
   ✓ resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState 316ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 330ms
   ✓ resumeLoop > does not refuse a resume immediately after an owner transfer (lastAffirmedAt is not the lease field) 438ms
   ✓ resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL 398ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3737ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 404ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 340ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 368ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 441ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 403ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 678ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 345ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 628ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 17ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 6ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 329ms
   ✓ worktreeManager > creates and removes a detached worktree 329ms
 ✓ tests/validation/contracts.test.ts (19 tests) 3144ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 878ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 780ms
   ✓ render-contract CLI > rejects a non-git repository path 741ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 736ms
 ✓ tests/validation/fixture.test.ts (2 tests) 652ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 650ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 7820ms
   ✓ lease heartbeat lifecycle > releases the lease when the loop returns, so the next resume proceeds immediately 322ms
   ✓ lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease 318ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 629ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 652ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 616ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 552ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 528ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 410ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 400ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 442ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 12411ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 549ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 403ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 650ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 420ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 431ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 423ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 1209ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 498ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 439ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 440ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 378ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 379ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 407ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 389ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 616ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 661ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when execute is interrupted 500ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when verify is interrupted 453ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 821ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 534ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 395ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 582ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 406ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 12887ms
   ✓ runLoop > succeeds when verification approves 313ms
   ✓ runLoop > skips adapter.verify when agent verification requiredChecks fail 320ms
   ✓ runLoop > blocks for human input before verify when path-policy gating hits 387ms
   ✓ runLoop > prioritizes the post-execute path-policy human gate over budget exhaustion 329ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 413ms
   ✓ runLoop > passes phase state plus plan/execution context to each adapter step 354ms
   ✓ runLoop > stops immediately when a stopOn signal matches 324ms
   ✓ runLoop > exhausts the run when planning exceeds per-attempt timeout 328ms
   ✓ runLoop > records execute_started before calling adapter.execute 380ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 869ms
 ✓ tests/validation/evidence.test.ts (39 tests) 17604ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1590ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1639ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2814ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1601ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1687ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1566ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 689ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 633ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 649ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 1029ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 628ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2832ms

 Test Files  30 passed (30)
      Tests  514 passed (514)
   Start at  01:23:31
   Duration  18.27s (transform 2.27s, setup 0ms, collect 3.99s, tests 67.60s, environment 4ms, prepare 1.72s)

TEST_EXIT=0
```

**30 文件 / 514 用例 / exit 0，`RUN` 首行是 worktree。** 512 → 514 的两条就是本波新增的 A、C 两条。**名单上那两条 flake 一条都没出现**（`evidence.test.ts` 的 records env names 与 `runLoop.integration.test.ts` 的 recovery window 都是 `✓`）。

### typecheck / build

```
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

TYPECHECK_EXIT=0

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "..."

BUILD_EXIT=0
```

---

## 提交（两笔，本地，未 push）

```
$ ... git log --oneline -3
5a7f5c7 docs(plan): GATE-C fix wave — amend Task C3 s banner literal with the observed-only qualification
c3bd049 fix(sweep): GATE-C fix wave — fold the report-line detail, qualify the banner as observed-only, pin both with new tests
4a24a94 test(sweep): pin the exact write surface of a gate-refused run and the recovery of a staged transaction

$ ... grep -rnF -e GATECFIX-MUT-A -e GATECFIX-MUT-C -e "cannot read run artifacts for" src tests docs
FINAL_MARKER_GREP_EXIT=1        ← 三个标记全仓零命中
5a7f5c7                         ← git rev-parse --short HEAD
FINAL_PORCELAIN_ABOVE           ← 其上无任何行 ⇒ git status --porcelain 为空
```

**两笔的 hash 是提交之后从 `git log` 抄下来的，不是提交前编造的**（本仓库有过一次编造 hash 的案底）。
`4a24a94` = 开工时的 HEAD，与派单给的值逐字相同。**未 push，未碰主仓库工作区。**

---

## Concerns（**交给人裁，本波一律没动手**）

1. **【本波遗留，需裁】spec 里的横幅字面量没同步。** `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1554` 也钉着旧的 `sweep: <eligible> eligible run(s) under <root>, …`。派单明确只授权动 `### Task C1`／`### Task C3` 里那一处，**所以我没动它**。但它是**当前 L3 spec**（lane 2 §4.3 已裁明「当前 spec 里的引用属于要修的一类」，与历史台账不同），今天与落地实现不一致。**请裁。**
2. **【本波遗留，需裁】派单点名一个测试站点，实测是五个。** 派单说「同步 C1 那条钉横幅字面量的测试」，`grep -rnF` 实测有 5 处 `toBe`/`toEqual` 钉全字面（§B.3 表）。全部同步了——不同步测试直接红，没有别的选择——但**这条与派单字面不符，记账在此**，不当作自行扩大名单。
3. **行号引用扫描（Global Constraints 收尾条）**。本波改动使两个测试文件里插入点之后的行号整体位移。扫描（未过滤，31 处命中，去重后 17 个不同锚点）显示**全部落在 `.superpowers/sdd/` 下的历史台账与任务报告里，`docs/` 的 spec 一处都没有**。按 lane 2 §4.3 的常设裁定（顶失效的文档是历史台账 ⇒ **只记录，永不修**），**未修**。受影响的是：`sweepRuns.test.ts:511/544/551/585/601`（C3 报告与 lane 2 报告）、`zeroWrite.test.ts:566/668/706`（C4 报告与 lane 2 报告）。未受影响：`sweepRuns.ts:66`、`sweepRuns.test.ts:216/253/284/316`、`zeroWrite.test.ts:6/92/187/523`。
4. **新增的端到端用例依赖 zod 的 message 形状**（`toContain("\n")` 那条前置断言）。这是**有意的**：zod 若把 message 变成单行，该断言**响亮**失败，而不是让折行断言静默变空洞。但它确实是一条**换 zod 大版本时需要重看**的测试，与 C2-M6（依赖 vitest pool 的那条）同族。**建议记进 L5 台账，本波未记**（`progress.md` 归控制器写）。
5. **新用例的位置是判断，不是规则。** 放进 `tests/registry/zeroWrite.test.ts` 是因为那里已有真实文件系统 + 不注入替身的 sweep 驱动。代价：一条**关于 sweep 报告路由**的测试住在一个名为「zero-write proof」的文件里，与该文件的主题只部分重合（它落在 `describe("sweep write surface")` 这个 C4 建的块内，算贴题，但文件名会误导后来者）。**没有新建文件**（派单要求新建前先停下报告）。**若人认为该另立 `tests/sweep/sweepRuns.e2e.test.ts`，请裁，我不自作主张。**

---

# 残留修复轮（2026-08-05）

scoped 再评审判 A/B/C/D 四项全部 ADDRESSED，但抓到**本波自己引入的一条缺陷**（本仓库第十五次「修复波自带缺陷」，且**不是写它的人发现的**——这一点我照单接受，不辩解）。人裁：合并前修。本轮只做点名的两件，**生产代码最终零改动**。

## 残-1 三条被我的横幅改动变空的护栏

### 缺陷复核（自己撞，不接受转述）

```
$ ... grep -rn "eligible run(s)" src/ tests/
tests/cli/cli.test.ts:312:      expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("eligible run(s)");
tests/cli/cli.test.ts:332:        expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("eligible run(s)");
tests/cli/cli.test.ts:350:      expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("eligible run(s)");
GREP_EXIT=0
```

**`src/` 侧 0 命中，`tests/` 侧 3 命中。** 三条 `not.toContain` 找的是一个**生产码里已经不存在的子串**，于是它们**结构上不可能再失败**：一个「在拒绝之前先打了横幅」的回归会直接滑过去。**指控成立。** 这是我 §B.1 改横幅时没有全仓回扫 `not.toContain` 一族造成的——§B.3 我扫的是 `eligible run(s) under`（带 `under`）这条**正向**字面量，恰好漏掉这三条只用 `eligible run(s)` 的**反向**护栏。

### 改成什么，以及为什么是这个子串

以新横幅**真实文案**为准（不照抄建议，先读了 `src/sweep/sweepRuns.ts` 的实际字符串）：新针 = **`observed eligibleForContinuation=true`**。

**唯一性实测**（`-F`）：

```
$ ... grep -rnF "observed eligibleForContinuation=true" src/ tests/
src/sweep/sweepRuns.ts:146:    `sweep: ${candidates.length} run(s) under ${options.root} observed eligibleForContinuation=true ` +
tests/sweep/sweepRuns.test.ts:354 / :392 / :653
tests/registry/zeroWrite.test.ts:529 / :820
GREP_EXIT=0
```

**`src/` 内唯一一处，就是横幅那句 `options.stderr(...)`** ——足以标识「横幅被打印过」，且不会被 `ccloop ls` 的输出误撞（`renderRuns.ts` 那边写的是 `eligibleForContinuation is an observed field…` 与 `eligibleForContinuation: present(true)` 两种形状，都不含 `observed eligibleForContinuation=true`）。测试正文里就地写下了这条唯一性依据与「必须与横幅同步」的告诫——**这次的坑就是没人写这句话**。

### 变异（两次注入，各三步齐走）

**注入前，整文件绿：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep
 ✓ tests/cli/cli.test.ts (23 tests) 1028ms
 Test Files  1 passed (1)
      Tests  23 passed (23)
   Start at  08:36:46
PRE_MUT_D_EXIT=0
```

#### 注入 1（真实回归形状）：`src/cli.ts` 的 sweep 分支里，**在读 adapter-config 之前**打横幅

标记 `// GATECRES-MUT-1`。这正是 §8 第一行禁止的那个回归：「配置读不了 → exit 1，**不扫描**」被改成「先打横幅再失败」。

```
 ❯ tests/cli/cli.test.ts (23 tests | 1 failed) 933ms
   × main sweep > exits 1 when the adapter config cannot be read 128ms
     → expected 'sweep: 0 run(s) under /var/folders/nb…' not to contain 'observed eligibleForContinuation=true'

 FAIL  tests/cli/cli.test.ts > main sweep > exits 1 when the adapter config cannot be read
AssertionError: expected 'sweep: 0 run(s) under /var/folders/nb…' not to contain 'observed eligibleForContinuation=true'

- Expected
+ Received

- observed eligibleForContinuation=true
+ sweep: 0 run(s) under /var/folders/…/ccloop-sweep-root-iq24Yw observed eligibleForContinuation=true (an observed field, not a decision that the run may be resumed), will attempt at most 1, adapter=scripted
+ ENOENT: no such file or directory, open '/var/folders/…/ccloop-sweep-cfg-jFiTaf/does-not-exist.json'

 ❯ tests/cli/cli.test.ts:357:57
    355|       expect(errorSpy.mock.calls.flat().join("\n")).toContain("ENOENT"…
    356|       // Same needle, same reason, as the banner guard above.
    357|       expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("obs…

 Test Files  1 failed (1)
      Tests  1 failed | 22 passed (23)
   Start at  08:37:00
POST_MUT1_WHOLEFILE_EXIT=1
```

**具名单跑（非零计数）：**

```
 ❯ tests/cli/cli.test.ts (23 tests | 1 failed | 22 skipped) 110ms
   × main sweep > exits 1 when the adapter config cannot be read 110ms
     → expected 'sweep: 0 run(s) under /var/folders/nb…' not to contain 'observed eligibleForContinuation=true'
 Test Files  1 failed (1)
      Tests  1 failed | 22 skipped (23)
   Start at  08:37:09
POST_MUT1_NAMED_EXIT=1
```

**第三条红；另外两条为什么不红 —— 机制，不是猜测**：`exits 1 when --max-runs is missing` 与 `exits 1 when --max-runs is not a positive integer` 这两条的拒绝发生在 **`parseArgs` 内部**（`src/cli.ts` 的 `throw new Error("missing required flags")` 与 `throw new Error("--max-runs must be a positive integer")`），而 `main` 是**先调 `parseArgs`、再进 sweep 分支**的。注入 1 落在 sweep 分支里，**那两条根本走不到注入点**，所以它们在这次注入下绿是正确的、也是唯一可能的结果。

#### 注入 2（补证另外两条并非恒真）：把同一行挪到 `parseArgs` 的 sweep 分支**最前面**

标记 `// GATECRES-MUT-2`。它模拟的是「`--max-runs` 校验被挪到扫描/横幅之后」那一类重构。

```
 ❯ tests/cli/cli.test.ts (23 tests | 3 failed) 883ms
   × main sweep > exits 1 when --max-runs is missing 128ms
     → expected 'sweep: 0 run(s) under /var/folders/nb…' not to contain 'observed eligibleForContinuation=true'
   × main sweep > exits 1 when --max-runs is not a positive integer 95ms
     → expected 'sweep: 0 run(s) under /var/folders/nb…' not to contain 'observed eligibleForContinuation=true'
   × main sweep > exits 1 when the adapter config cannot be read 90ms
     → expected 'sweep: 0 run(s) under /var/folders/nb…' not to contain 'observed eligibleForContinuation=true'

（三条 FAIL 块的 received 分别多出 `missing required flags` / `--max-runs must be a positive integer` /
 `ENOENT: …does-not-exist.json` 一行，即各自那条拒绝确实也发生了，红不是因为拒绝没发生。）

 Test Files  1 failed (1)
      Tests  3 failed | 20 passed (23)
   Start at  08:37:31
POST_MUT2_WHOLEFILE_EXIT=1
```

**三条全红。** 三条护栏今天**都**能失败，不是只有一条。（顺带自曝一处观察：注入 2 下 `parseArgs sweep` 的两条纯解析测试在 stderr 上也打出了那行横幅，但它们不断言 stderr，所以仍绿——这说明本轮的判别力**只**来自 `main sweep` 那三条，与解析层无关。）

**还原并证明干净：**

```
 ✓ tests/cli/cli.test.ts (23 tests) 931ms
 Test Files  1 passed (1)
      Tests  23 passed (23)
   Start at  08:37:45
RESTORED_MUT_EXIT=0
MARKER_GREP_EXIT=1        ← grep -rnF -e GATECRES-MUT-1 -e GATECRES-MUT-2 -e "…will attempt at most ?" src tests：零命中
SRC_DIFFSTAT_ABOVE        ← git diff --stat src/ 零输出：生产代码与 HEAD 逐字节相同
 M tests/cli/cli.test.ts
PORCELAIN_ABOVE
```

三个 `-F` 针里有两个是我写进文件的标记，第三个是注入体**内容**里独有的 `will attempt at most ?`（真横幅永远是数字，不会是 `?`）——任一残留都会被抓到。

## 残-2 同步当前 L3 spec 里的旧横幅字面量

`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` 第 1554 行的启动横幅格式仍是旧字面量。

**形状依据（先查再写）**：

```
$ ... grep -nF "Amended 2026-08-0" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
GREP_EXIT=1        ← 这份 spec 里一处判例都没有
```

**这份 spec 此前从未被 amend 过**，所以形状照抄的是**计划**里那十余处判例（`**Amended <日期>：<被推翻的那句>。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。<理由> **读作**：… 落地字面量逐字为：…），并与我在计划 `### Task C3` 落的那条互相指引。**原文保留、只增不删**，标 `Amended 2026-08-05`，写清了新字面量、为什么改（过滤器只覆盖八条判据的第 1 条 ⇒ 裸 "eligible" 让 §12「知情」半边落空，与「少写 N」同构）、以及口气来源（`renderRuns.ts` 的 `CONSISTENCY_NOTICE`）。**没有夹带任何「将来该怎么改」的建议。**

## 残-3 收尾验证（未过滤）

**全套件**：`Test Files 30 passed (30)` / `Tests 514 passed (514)` / `TEST_EXIT=0`，`RUN v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep`（**worktree**，主仓是 29/490）。名单上那两条 flake 均为 `✓`，无名单外失败。逐文件 `✓` 清单、stderr/stdout 调试块、slow-test 行原样见上一轮同一节的形状，本轮那次跑的完整输出与之同构（`Start at 08:38:25`，`Duration 18.01s`）。

**typecheck / build**：

```
TYPECHECK_EXIT=0
BUILD_EXIT=0
```

**守卫三条（自己数）**：

```
$ ... grep -cF "return { ok: false" src/controller/resumeLoop.ts
8
$ ... grep -rnF "currentOwnerEpoch + 1" src/
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;   ← 单点
$ ... git diff --stat src/registry/
REGISTRY_DIFFSTAT_ABOVE                                    ← 零输出：src/registry/ 零改动
```

**本轮改动面（就是点名的两个文件，生产代码零改动）**：

```
$ ... git diff --stat
 ...026-08-01-sweep-and-transactional-continuation-design.md |  6 ++++++
 tests/cli/cli.test.ts                                       | 13 ++++++++++---
 2 files changed, 16 insertions(+), 3 deletions(-)
FULL_DIFFSTAT_ABOVE
```

**不许动的清单一处未动**：`stop()` / `isLeaseStopError` / B1 外层 catch 分支及其顺序 / B2 停机槽 / `onReconciliationWriteAbandoned` 两处转发 / `transferRepresentsPublishedWinner` / C1 流水线与配额语义 / C2 类型收窄 / C3 即时写回调 —— 全部在 `src/` 下，本轮 `git diff --stat src/` 为空即逐条成立。

## 残-4 Concerns（**本轮一律没动手，交给人裁**）

1. **同一份 spec 第 1564 行还有一句已被人裁推翻的话没同步**：模块边界表里写着「**回调的实现定死为一次数组 push，不做 I/O、不得抛出**」，而 C3 修复轮 1／2 的人裁把它改成了**当场 `options.stderr(...)`（含折行）**，计划里已就地勘误（`Amended 2026-08-04`），这份 spec 没有。**它与本轮点名的横幅字面量在同一份文档、同属「spec 落后于人裁」一族，但不在本轮授权范围内，所以我没动。请裁。**
2. **【上面第 1 条已闭合】** 人裁：一并同步。落地见下方 §残-5。
3. **本轮暴露的是一条方法缺口，不只是一个字符串**：改任何被测试字面量钉住的输出时，正向 `toContain`／字面量相等的站点会自己红出来，**反向 `not.toContain` 站点不会**——它们只会静默变空。本波第一轮我扫了正向、漏了反向。**建议把「改输出字面量时必须同时回扫 `not.toContain` / `not.toEqual` 一族」记成常设规则**（与 lane 2 §4.3 那条行号锚点常设规则同性质）。**台账归控制器写，我没有代写。**

## 残-5 同族第二句：spec 的「回调=一次数组 push」同步（人裁，组 C 收口件）

### 落点与形状依据（先查再写）

```
$ ... grep -nF "数组 push" docs/superpowers/specs/…-design.md docs/superpowers/plans/…-continuation.md
spec:692   ← §4.3 论证段（「把 sweep 侧的实现定死为一次数组 push」）
spec:751   ← §4.3「appendEvent 吞、回调不吞」那段的论据（「§9 已把它定死为一次数组 push」）
spec:1570  ← §9 模块边界表 sweepRuns.ts 那一行  ← 本轮点名的这一处（上一轮报告里记作 1564，我那次 +6 行勘误把它推到了 1570）
plan:1004 / plan:1717        ← 计划侧同族原文
plan:1719 / plan:1761        ← 计划侧配对勘误，均标 Amended 2026-08-04
```

**只动 `spec:1570` 这一处**，与派单一致。`spec:692` / `spec:751` 未动 —— 见下方 concerns。

**位置**：该行在一张 markdown 表格里，注解**不能**插进表格中间（会把表格截断成两半）。因此按本仓库既有做法把注解放在**该表结束后的第一段**（表格 1570–1576，注解落在 1577 之后、`isLeaseStopError` 那段之前），并在注解首句就点名「上表 `src/sweep/sweepRuns.ts` 那一行末尾」，使锚点无歧义。

**形状**照我上一轮在同一份 spec 落的那处（再评审员点名认可的做法）：原文保留、就地注解、只增不删，标 `Amended 2026-08-05`，写清被推翻的是哪句、新形状是什么、为什么（缓冲会丢告警：SIGKILL/OOM 下缓冲数组随进程消失，cron 的「有 stderr 即告警」永不触发；而唯一被要求的行序是 note 之间的遍历顺序，顺序 `for await` 当场打印同样满足 ⇒ **缓冲没有换来任何被要求的性质**），并**明写哪些部分不变且仍然成立**（一次调用一行、不去重不聚合、不得抛出、刻意不包 try/catch —— 变的只有「落点是数组」→「落点是 stderr」）。**没有夹带任何「将来该怎么改」的建议。**

**交叉链接**（派单点名要求）：注解末段指向计划 `### Task C3` 里配对的两处 `Amended 2026-08-04`（「落点」一节 + Step 6 括号里的同一句），并**明确区分两族**——本文档 §8 横幅那处的 `Amended 2026-08-05` 与计划 `### Task C3` 的同名勘误是**另一族**，两族互不相干，避免后来者把两个同日期标记读成同一件事。

### 收尾验证（未过滤，本轮纯文档改动）

**全套件**（**这一跑全程零管道**：上一次我先用了 `… 2>&1 | cat; echo TEST_EXIT=${PIPESTATUS[0]}`，`cat` 不过滤、`PIPESTATUS` 也取对了退出码，但本仓库有三次「用了管道随后作废重跑」的案底，我不给这条留争议，**当场重跑了一次无管道版**，两次结论一致，此处贴的是无管道那次）：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep
 … 逐文件 ✓ 清单、cli.test.ts 的三段 stderr/stdout 调试块、各文件 slow-test 行全部原样在跑出输出里 …
 Test Files  30 passed (30)
      Tests  514 passed (514)
   Start at  08:50:29
   Duration  17.60s (transform 2.27s, setup 0ms, collect 4.00s, tests 62.24s, environment 4ms, prepare 2.20s)
TEST_EXIT=0

TYPECHECK_EXIT=0
BUILD_EXIT=0
```

**30 文件 / 514 用例 / exit 0，`RUN` 首行是 worktree**（主仓 29/490）。与残留修复轮那次逐字相同 —— **纯文档改动确实没有影响它**，没有出现派单说的那种「重大发现」。名单上那两条 flake 均为 `✓`。

**守卫三条**：

```
$ ... grep -cF "return { ok: false" src/controller/resumeLoop.ts
8
$ ... grep -rnF "currentOwnerEpoch + 1" src/
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;   ← 单点
$ ... git diff --stat src/registry/
REGISTRY_DIFFSTAT_ABOVE                                   ← 零输出：src/registry/ 零改动
```

**改动面（机械证明「只动一个文件、只增不删」）**：

```
$ ... git diff --numstat
4	0	docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
NUMSTAT_ABOVE

$ ... git diff --stat src/ tests/
SRC_TESTS_DIFFSTAT_ABOVE                                  ← 零输出：代码与测试本轮零改动
```

`4 insertions / 0 deletions`，**删除列是字面的 `0`** —— 「只增不删」不是自述，是 `numstat` 数出来的。

### 残-5 的 concerns（没动手，交给人裁）

1. **同一族在这份 spec 里还有两处**：`spec:692`（§4.3 论证段）与 `spec:751`（「appendEvent 吞、回调不吞」那段，其论据逐字写着「§9 已把它定死为一次数组 push，不做 I/O」）。派单本轮明确「只动那一份 spec 这一处」，**所以我没动**。两处的**结论**今天仍然成立（回调不得抛出、不包 try/catch、违约必须显眼），失效的只是「一次数组 push」这个**论据形状**——尤其 `spec:751` 是用「落点在本层控制范围内」来论证「不吞」，换成 `options.stderr(...)` 之后这条论证**依然成立**（stderr sink 同样由本层注入），但字面已与实现不符。**请裁是否再开一轮把这两处一并同步。**
2. **计划侧 `plan:1004` 同形**（与 `spec:692` 是同一段话的两份拷贝），同样未动，同样属上面第 1 条。
