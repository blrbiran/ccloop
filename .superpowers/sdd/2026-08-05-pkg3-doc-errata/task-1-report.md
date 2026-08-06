# 任务 1 报告 —「数组 push」族 10 处就地勘误

## 1. 今天的真实实现（贴行）

自己读的，不是照抄 brief。`src/sweep/sweepRuns.ts:203-209`（`sed -n '203,209p' src/sweep/sweepRuns.ts`）：

```
203	        // Deliberately NOT wrapped in try/catch: `options.stderr` throwing is a programming error
204	        // in the caller, and swallowing it here would hide it (Rule 12).
205	        onReconciliationWriteAbandoned: (detail) => {
206	          options.stderr(
207	            `note  ${candidate.path}  reconciliation_write_abandoned  ${detail.replace(/\r?\n/g, " ")}`,
208	          );
209	        },
```

**结论：与 brief 的描述一致 —— 回调体是一次立即的 `options.stderr(...)`，不是数组 push，回调外没有任何备注数组。**
`options.stderr` 的类型是注入槽 `stderr: (line: string) => void`（`src/sweep/sweepRuns.ts:95`）。
上方 `:191-196` 的注释自己也写着 "Written AT THE CALLBACK, not buffered for a flush after the loop"。

旁证（`grep -rn "array push\|数组" src/ tests/`）：勘误后**零命中，exit 1** —— 全仓源码与测试里已无「数组 push」的说法。

## 2. 10 处逐处

通用形状（房规）：**保留原句一个字不改**，在其后另起一段加 `**Amended 2026-08-05：…**`，
照 A `:1558`/`:1562`/`:1578`/`:1580` 四处样板的语气与结构（先点名哪一句为假 → 「这纠正的是*本文档*的缺陷，
不是实现的缺陷」→ 理由 → **读作**：… → 明写哪些部分不变且仍然成立）。
**每一处都自带一条可跟到完整理由的指针**（A 侧指向「本文档 §9 模块表 `src/sweep/sweepRuns.ts` 那一行下方的
`Amended 2026-08-05`」，B 侧指向「本计划 `### Task C3`「落点」一节的 `Amended 2026-08-04`」）——
指针按**名字**引用、不按行号，因为行号会被后续编辑移位。

### 站点 1 — A:671（⚠️ 承重论据）

**原句**：「(b) 的回调在事件发生的**当场**就把记录写进了 sweep 自己的数组里，后续无论 run 正常返回还是抛出，
记录都已在 sweep 手上。」

**勘误正文要点**：点名「写进了 sweep 自己的数组里 / 已在 sweep 手上」为假 —— 回调当场做的是 `options.stderr(...)`，
记录当场就**离开了本进程**，从来没有停在 sweep 手上。**读作**：(b) 今天仍然对，是因为记录当场**写出了本进程**，
所以无论后续正常返回还是抛出，它都已落在 stderr 上、cron 的「有 stderr 即告警」已能为它响。
并明写：**这不是同义改写，两种说法强度不同** —— 「已在 sweep 手上」把可见性押在「进程活到循环结束、数组被冲出」上，
今天的形状**根本不押这一注**（`--max-runs 50` 的 sweep 在第 40 个 run 被 SIGKILL 时，在手上的记录会消失，
写出去的不会）。**即今天的落脚点比原句更强，不是更弱。**

**为什么这么写**：brief 定死「结论不腐，腐的是论据的落脚点；勘误只许修论据，不许改结论、不许改选型」。
所以我在段首用 `⚠️ 结论不动` 显式声明 (b) 仍是被选中的方案、本条前半段（(a) 在 `runLoopFromState` 顶端抛出时
消息蒸发）一个字不改，只重述最后一句的落脚点。加「比原句更强」那句，是因为读者看到承重论据被勘误，
第一反应会是「那这个选型是不是也该重审」——必须当场堵住这条误读。

### 站点 2 — A:681（§4.3 四层通道表，`sweep.sweepRuns` 行）

**原句（表格单元）**：「为**当前这个 run** 传一个闭包，把 `{ path, detail }` **push 进本次 sweep 的备注数组**」

**勘误正文要点**：表后另起一段，点名该格已被推翻，**读作**：「……把 `note  <path>  reconciliation_write_abandoned
 <detail>` **当场写到 stderr**（`detail` 的 `\r?\n` 在回调里当场折成空格）」。并明写该行右侧「见下面的
『回调不得抛出』」不变且仍然成立。

**为什么这么写**：表格单元没法就地加段落而不改原件，房规要求「保留原句、在其后另起一段」，所以放在表后。
补上「折行也在回调里当场做」是因为原句的 `{ path, detail }` 未经格式化，而今天回调产出的是**成品行**，
只说「落点改 stderr」不足以让读者写对回调体。

### 站点 3 — A:692（台账已点名）

**原句**：「**本层的处置是把「不得抛出」定成回调的契约，并把 sweep 侧的实现定死为一次数组 push（不做 I/O、不格式化）**，
使违约成为一个显眼的编程错误而不是一条被吞的异常。」

**勘误正文要点**：定死的是「当场 `options.stderr(...)`，含 `\r?\n` 单行折叠」。**明写其余部分逐字不变且仍然成立**
（「不得抛出」仍是契约、仍刻意不包 try/catch、违约仍是显眼的编程错误）。**并单独点出「不格式化」这一句今天不能照留** ——
折行本身就是格式化，且人裁明令它在回调里当场做。

**为什么这么写**：原句里被推翻的其实是**三个短语**（「一次数组 push」「不做 I/O」「不格式化」），
而已有的锚点勘误（A `:1578`）只逐字提了前两个。「不格式化」若不单独点名，下一个读者会保留它，
写出一个不折行的回调 —— 那会让 `SyntaxError` 的多行 message 把一条 note 拆成看起来像好几条的输出，
正是 §4.3「detail 打印前必须折成单行」要堵的洞。

### 站点 4 — A:751（⚠️ 按名字引用 §9）

**原句**：「回调的实现**在本层的控制范围内**（**§9 已把它定死为一次数组 push，不做 I/O**），所以它抛出只可能是**编程错误**……」

**勘误正文要点**：点名括号里的转述在今天为假（§9 那一行已被 `Amended 2026-08-05` 改写），**结论一个字不改**
（`appendEvent` 吞、回调不吞的不对称处置仍然成立）。**读作**：回调仍在本层控制范围内，今天的理由**不再是「它不做 I/O」**
（它今天当场写 stderr），而是**它的落点 `options.stderr` 是调用方注入的槽**（`SweepOptions.stderr`），
回调体只有一次同步调用、不碰文件系统、不 await；因此它抛出仍然只可能是调用方的编程错误。
末尾点明：**本段论点的支点是「谁能修好它」，不是「回调做不做 I/O」**，支点没动。

**为什么这么写**：这是本轮最微妙的一处，**它不是纯粹的转述腐坏**。原论证用「不做 I/O」当作
「回调在本层控制范围内」的**依据**，而今天回调确实在做一次写 fd 2 的动作 —— 依据本身失效了，不只是措辞过时。
我没有自己发明新论证：替代依据（「`options.stderr` 抛出是调用方的编程错误」）是**本仓库已经裁定过的原话**，
逐字来自锚点勘误 A `:1578` 与 `src/sweep/sweepRuns.ts:203-204` 的现场注释，我只是把它搬到这一段。
**但我认为这条替代依据比原依据弱，已作为 concern 写进 §5。**

### 站点 5 — A:2006（⚠️ 变异指令）

**原句**：「**变异：把备注的落盘时机从「回调当场记入 sweep 的数组」改成「`resumeLoop` 正常返回后才记」→ 本条必须红**
（抛出路径上永远走不到那一步）。**这个变异正是上行方案 (a) 的失效形状**，用一行生产改动表达出来。」

**勘误正文要点 / 为什么这么写**：见 §3 整节（含实测输出）。要点是：不只加一句「已改为 stderr」，
而是把**变异动作**、**期望哪条测试红**、**实测结果**三样都写进勘误，并显式警告「本条不是描述，是一条会被照着执行的指令」。

### 站点 6 — B:876（⚠️ 按名字引用 §9，A:751 的计划侧对应）

**原句**：「**为什么 `appendEvent` 吞而回调不吞（两者危险同构、处置相反，理由必须写进注释）**：差别在**谁能修好它**。
回调的实现**在本层控制范围内**（**§9 定死为一次数组 push，不做 I/O**），所以它抛出只可能是**编程错误**……」

**勘误正文要点**：与站点 4 同构 —— 括号里的转述为假，结论不动，读作「依据改为：`options.stderr` 是调用方注入的槽」，
支点仍是「谁能修好它」。**额外一句**：原句括号里「理由必须写进注释」这条要求**仍然有效**，并指明落地的那段注释在
`src/persistence/fileStore.ts` 的 `writeBoundaryArtifacts` 内、**已按本条同步**。

**为什么这么写**：这一处与站点 10（源码注释）是同一条论证的两个副本，原文自己就写着「理由必须写进注释」——
所以这两处必须**互相指得到**，否则下一个人改了文档不改注释（`b9afbf3` 那次同步漏掉源码，正是这个失效）。
我在文档侧点名注释、在注释侧重写措辞，把这条链接闭合。

### 站点 7 — B:1004（`spec:692` 的 copy）

**原句**：「本层的处置是把「不得抛出」定成**回调的契约**，并把 sweep 侧的实现定死为**一次数组 push**（不做 I/O、不格式化），
使违约成为一个**显眼的编程错误**而不是一条被吞的异常。」

**勘误正文要点**：与站点 3 逐条同构（含单独点名「不格式化」不能照留）。**指针写了两条**：
本计划 `### Task C3`「落点」一节的 `Amended 2026-08-04`，**以及** spec 侧同一处（A §4.3「回调不得抛出」段下方的
`Amended 2026-08-05`，即站点 3）。

**为什么这么写**：这一处是 spec `:692` 的复制品。房规硬要求「一处勘误管多个站点时，每个站点都要留下指针」，
而这两个站点是**同一句话的两份拷贝**，最容易出现「一份改了、另一份被读者当现状」——所以这里的指针
特意双向指到 spec 那一份，让读者一眼看出它们是同一条债。

### 站点 8 — B:1735（⚠️ 变异指令，A:2006 的计划侧对应）

**原句**：与 A `:2006` 几乎逐字相同，差别只在写作 `resume` 而非 `resumeLoop`。

**勘误正文要点 / 为什么这么写**：见 §3 整节。与 A `:2006` 的勘误同构，只有一处按上下文改了引用方式：
期望变红的测试在这里按**计划自己的 Step 5 测试名**指认（`keeps the abandonment note on stderr even when the run
throws afterwards`，即 12d(ii)），因为 plan Task C3 的读者手上就是那份 Step 列表，指「12d(ii)」他要跳回 spec 才认得。

### 站点 9 — B:1999（可追溯性矩阵表格单元）

**原句（表格单元）**：`| writeBoundaryArtifacts(runDir, artifacts, options?) 第三参 … | A8 | A8 的 12d(iii)、**C3（回调=数组 push）** | ✅ 回调签名三处都是 (detail: string) => void |`

**勘误正文要点**：表下加一段（房规允许「单元内加注或表下加一行」），点名「C3（回调=数组 push）」被推翻，
读作「C3（回调=当场写 stderr）」。**并特意声明：该行的 `✅` 与它的判据不变、且仍然成立** ——
这一行核对的是**回调签名**三处是否逐字相同（`(detail: string) => void`），而签名与回调体把记录落到哪里毫不相干；
被推翻的是括号里那句对**回调体**的描述，不是这一行的一致性结论。末句明写「**不要因为这句括号被推翻就去改那个 `✅`**」。

**为什么这么写**：这是本轮最容易被下一个人**改坏**的一处 —— 看到括号里的说法被推翻，顺手把 `✅` 改成 `❌` 或
删掉这一行，就把一条**成立的**一致性结论误标成了不一致。矩阵的整个价值在于它的判据是「名字/签名是否一致」，
勘误必须把「被推翻的是描述、不是判据」说死。这也正是台账那句「一笔债被一个看起来同名的东西承接」的反面：
这里是**同名但不同债**，不能一起勾销。

### 站点 10 — C:469（⚠️ 唯一的源码站点，只改注释）

**原文（`src/persistence/fileStore.ts:468-471`）**：

```
      // The callback deliberately does NOT get this treatment: its body is inside this layer's
      // control (a single array push, no I/O), so a throw from it is a programming error and must
      // be loud. appendFile's I/O is nobody's to fix — a throw from it is an environment fact, and
      // converting it into a failed attempt only hides a small error behind a larger one.
```

**改成**：

```
      // The callback deliberately does NOT get this treatment: its body is inside this layer's
      // control — a single synchronous call into a sink the caller injected (sweepRuns passes
      // SweepOptions.stderr), touching no filesystem and awaiting nothing — so a throw from it is
      // a programming error in the caller and must be loud. appendFile's I/O is nobody's to fix —
      // a throw from it is an environment fact, and converting it into a failed attempt only hides
      // a small error behind a larger one. The asymmetry turns on who can fix it, not on whether
      // the callback performs I/O: it writes a note line to stderr on the spot, and that is the
      // point (a buffered note dies with the process on a SIGKILL mid-sweep).
```

**为什么这么写**：

- **不用 `*Amended*` 标记**（brief 明令那是文档格式），按周围注释的写法**自然改写**——
  周围三条编号约束（`:455-467`）与下方 "Ordered BEFORE appendEvent on purpose" 段都是这种直述口气，改写后同形。
- **`a single array push, no I/O` 是这段唯一说假话的地方**，它替换成对今天回调体的直述
  （注入槽 + 同步 + 不碰文件系统 + 不 await）。
- **补了最后两句**，因为 brief 指出「它的可见度高于那 9 处文档，下一个改这段代码的人会把它当**现状**读」：
  只删掉 `no I/O` 会让读者困惑「回调明明在写 stderr，凭什么不吞」——所以把支点
  （`turns on who can fix it, not on whether the callback performs I/O`）和它**为什么当场写**
  （缓冲的 note 会随 SIGKILL 一起消失）都写进去，让这段注释自己站得住，不必跳去文档。
- **一个字节的可执行代码都没动**：`git diff` 显示本文件 +7 −3，**全部 10 行都以 `//` 开头**（见 §4.5）。
  `npx tsc --noEmit` 退出码 0，514 条测试全绿。

## 3. 两处变异指令的处置（A:2006 / B:1735）

### 3.1 问题是什么

这两处是 §10 测试 12d(ii) / plan Task C3 Step 7 里一条**会被照着执行的变异要求**，原文：

> **变异：把备注的落盘时机从「回调当场记入 sweep 的数组」改成「`resumeLoop` 正常返回后才记」→ 本条必须红**

它的**基线**（「回调当场记入 sweep 的数组」）今天不存在。照字面复现的人会先去把回调改成数组 push
（**构造一个今天没有的形状**），再把它改成返回后才记 —— 两步都在改一个假基线，变异钉不住任何东西，
而执行者会以为自己走完了三步判据。所以这两处**不能只加一句「已改为 stderr」**。

### 3.2 我判断这不需要设计，只需要重述 —— 理由

铁律 1 要求：若「今天正确的变异动作」需要设计而不只是勘误，原样上报、不许自己发明变异。**我判断它不需要设计**，
依据是这条变异**要钉的性质**在改动前后完全没变：

> 记录必须在**回调当场**离开 sweep，而不是等 `resume` 返回之后才记。

变的只是「离开 sweep」的落点（数组 → stderr）。所以变异动作是同一个动作在新落点上的**逐字重述**，
不是一条新发明的变异。我没有改变异要钉的东西，也没有换一条更好钉的变异。

### 3.3 我写进两处勘误的变异动作（逐字）

- **变异动作**（只动生产代码 `src/sweep/sweepRuns.ts`，一处）：把 `onReconciliationWriteAbandoned` 回调体里
  那次当场的 `options.stderr(...)` 改成把该行 push 进一个声明在 `await resume(...)` **之外**的局部数组，
  并在 **`await resume(...)` 正常返回之后**才把数组里的行逐条 `options.stderr(...)` 出去。
- **期望**：测试 **12d(ii)**（裸 `it` 名 `keeps the abandonment note on stderr even when the run throws afterwards`）
  **必须红**。

### 3.4 ⚠️ 我实测跑过这条变异，没有只是写在纸上

本仓库的记录是「十五波修复十五次自带缺陷」，而上一轮最有价值的一次上报正是「计划的变异钉不住测试」。
一条**没跑过**的变异指令写进文档，和它原来那条假基线是同一类缺陷，所以我把它跑了。

**做法**：先 `cp src/sweep/sweepRuns.ts` 到 scratchpad 备份 → 施加变异 → 跑 → `git checkout -- src/sweep/sweepRuns.ts`
还原 → `diff` 与备份逐字节比对 + `git status --porcelain` 确认干净。

**变异前（基线，未过滤）**：

```
$ npx vitest run tests/sweep/sweepRuns.test.ts -t 'keeps the abandonment note on stderr even when the run throws afterwards'
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop
 ✓ tests/sweep/sweepRuns.test.ts (13 tests | 12 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 12 skipped (13)
```

**变异后（未过滤）**：

```
$ npx vitest run tests/sweep/sweepRuns.test.ts
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop
 ❯ tests/sweep/sweepRuns.test.ts (13 tests | 1 failed) 12ms
   × sweepRuns > keeps the abandonment note on stderr even when the run throws afterwards 5ms
     → expected [ …(2) ] to deeply equal [ …(3) ]

 FAIL  tests/sweep/sweepRuns.test.ts > sweepRuns > keeps the abandonment note on stderr even when the run throws afterwards
AssertionError: expected [ …(2) ] to deeply equal [ …(3) ]

- Expected
+ Received

  Array [
    "sweep: 1 run(s) under /fake/root observed eligibleForContinuation=true (an observed field, not a decision that the run may be resumed), will attempt at most 100, adapter=scripted",
-   "note  /fake/root/run-1  reconciliation_write_abandoned  EACCES: permission denied, rename 'reconciliation-record.json.tmp'",
    "/fake/root/run-1	error	ENOSPC: no space left on device, write loop-state.json",
  ]

 ❯ tests/sweep/sweepRuns.test.ts:652:27

 Test Files  1 failed (1)
      Tests  1 failed | 12 passed (13)
```

**判定：变异是击杀变异，且是精确击杀。**

- **12d(ii) 红**，失败形态正是预期的那一种：`stderrLines` 只剩 2 行，**缺的就是 `note` 那一行**
  （替身 `resume` 在触发回调后 reject，冲出那一步永远走不到）。
- **12d(i) 保持绿是正确的，不是漏杀**：正常返回路径上那次冲出照样发生。这条变异钉的本来就只有抛出路径，
  我把这句也写进了两处勘误，免得下一个执行者看到「只红了一条」以为自己做错了。
- 其余 12 条全绿 —— 变异没有波及无关断言。

**还原验证（未过滤）**：

```
$ git checkout -- src/sweep/sweepRuns.ts && git status --porcelain && diff <备份> src/sweep/sweepRuns.ts
ok
---DIFF-VS-BACKUP---
[ok] Files are identical
IDENTICAL_TO_BACKUP
```

最终交付的 `git diff --stat` 里**没有 `src/sweep/sweepRuns.ts`**（§4.5），变异实验零残留。

### 3.5 一处顺带发现（对下一个执行者有用，已写进勘误）

测试 12d(ii) 今天比计划描述的**更强**：它断言的是 `expect(h.stderrLines).toEqual([...])`（**整个数组、含顺序**），
不是两个 `toContain`。所以**两种缓冲形状都会被它杀掉**，机制还不一样：

- 「等 `resume` 正常返回后才冲出」→ 抛出路径上 `note` **整条丢失**（我实测的这一种）；
- 「攒到整个 for-await 循环结束再冲出」→ `note` 还在，但**排到了 error 行后面**，`toEqual` 的顺序断言红。

测试文件自己的注释（`tests/sweep/sweepRuns.test.ts:642-647`）已经写明了第二种。两种都红，是好事。

## 4. 验证输出（未过滤）

### 4.1 `RUN` 路径行（首行）

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop
```

路径正确，是本仓库根。

### 4.2 `rtk proxy "npm test -- --run"` 尾部（完整未过滤输出见下，中段测试列表逐行绿）

```
 Test Files  30 passed (30)
      Tests  514 passed (514)
   Start at  23:44:49
   Duration  16.79s (transform 2.35s, setup 0ms, collect 3.78s, tests 58.52s, environment 3ms, prepare 1.81s)
```

**30 files / 514 tests / 0 failed，与基线逐字相同 —— 无回归。** 30 个测试文件全部 `✓`，无 skipped、无 todo。
测试输出中出现的 `stderr | tests/cli/cli.test.ts …` 三段是被测代码自己的预期输出（`missing required flags`、
`ENOENT … does-not-exist`、`ls` 的 damaged row 快照），不是失败。

### 4.3 typecheck

```
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy "npx tsc --noEmit -p tsconfig.json"; echo "TYPECHECK_EXIT=$?"
TYPECHECK_EXIT=0
```

`tsc` 零输出、退出码 0。

### 4.4 三条收尾自查命令的输出

```
$ grep -rno "数组" <文件A> <文件B> | wc -l
      43

$ grep -rn "array push\|数组" src/ tests/
EXIT=1        # 零命中

$ grep -c "Amended" <文件A>
10
```

三个数字各自怎么来的：

- **43**：这是**逐处出现数**（`-o`），不是「剩余待勘误数」。本轮**刻意保留每一句原文**（房规：就地注解、不改原件），
  所以原句里的「数组」一个都不会消失；勘误正文本身还要反复说「落点不是**数组**而是 stderr」，因此这个数
  **勘误之后必然上升**。它能证的只有「原件未被改写」，不能用来判完成度。判完成度用的是 §2 的逐处核对。
- **零命中 / exit 1**：源码与测试里**已无**「array push」或「数组」的说法 —— 站点 10 是唯一一处，已改掉。
  这条是本轮唯一一个「改完应该归零」的守卫，它归零了。
- **10**：文件 A 中含 `Amended` 的**行数**。勘误前是 4 行（`:1558`/`:1562`/`:1578`/`:1580`）。
  本轮往 A 加了 5 处站点，其中站点 5（A `:2006`）的勘误是**多段**结构、首段与末段各含一次 `Amended`，占 2 行，
  其余 4 处各占 1 行 → 4 + 4 + 2 = **10**，对得上，无遗漏也无重复。

### 4.5 提交前 `git diff --stat`

```
 .../2026-08-02-sweep-and-transactional-continuation.md   | 14 ++++++++++++++
 ...-08-01-sweep-and-transactional-continuation-design.md | 16 ++++++++++++++++
 src/persistence/fileStore.ts                             | 10 +++++++---
 3 files changed, 37 insertions(+), 3 deletions(-)
```

**唯一的 3 行删除全部落在 `src/persistence/fileStore.ts`，且全部是注释行**（见 §2 站点 10 的 diff）。
两个文档文件**只增不删**（14 +0 / 16 +0），即原件一个字节未被改写，符合房规。

## 5. 我不确定 / 认为 brief 判错的地方

**没有一处站点我认为 brief 判错了**（10 处我都核过，逐处成立，见 §5.3）。但有 4 条要上报。

### 5.1 ⚠️ 站点 4 / 6 / 10 的性质比 brief 标的「描述」重 —— 那里失效的是**论证依据**，不只是转述

brief 把 A `:751` 与 B `:876` 标成「描述（台账已点名）」，把 C `:469` 标成「源码注释」。
**我照 brief 的范围做了，没有扩大**，但我认为它们的性质要重一档，理由是具体的：

那条不对称论证（「`appendEvent` 吞、回调不吞，差别在**谁能修好它**」）把「**不做 I/O**」当作
「回调在本层控制范围内 → 它抛出只可能是编程错误」的**依据**。**而今天回调确实在做一次写 fd 2 的动作。**
所以这里失效的不是一句过时的转述，而是**支撑结论的那条前提本身**。

我没有自己发明替代论证 —— 我用的是本仓库**已经裁定过的原话**（锚点勘误 A `:1578` 与
`src/sweep/sweepRuns.ts:203-204` 现场注释：「`options.stderr` 抛出是调用方的编程错误」），
只把它搬到了这三处。**但我认为这条替代依据比原依据弱**，具体在哪弱：

- 原依据「不做 I/O」是**结构性**的 —— 不碰外部世界的代码不可能有环境失败。
- 替代依据「sink 是调用方注入的」是**约定性**的 —— 它依赖注入方注入一个不会因环境原因抛出的 sink。
  若某个调用方注入的是裸 `process.stderr.write`，一次 `ccloop sweep | head` 造成的 **EPIPE
  就是一个不折不扣的「环境事实」**，正是文档划给 `appendFile` 并予以吞掉的那一类 —— 那时
  「回调抛出只可能是编程错误」就不成立了。

**一条缓解事实（我查了，写在这里供评审员判断）**：今天生产侧的注入是
`src/cli.ts:234` `stderr: (line) => console.error(line)`，而 Node 全局 `console` 默认
`ignoreErrors: true`、写失败不抛。**所以在今天的接线下那条断言仍然为真**，不存在实际缺陷。

**我没有动处置**（回调仍然不吞、仍不包 try/catch）—— 改处置是设计判断和人裁的事，不是勘误的事（铁律 1）。
**请评审员/人裁决定**：是就此打住（认为「注入方有责任注入不抛的 sink」是可接受的契约、也许该把它写成显式契约），
还是这条不对称需要重新论证。

### 5.2 brief 的自查命令 `grep -rno "数组" A B | wc -l` 不能用来判完成度

这条命令的数字（**43**）**做完勘误后必然上升而不是下降**：房规要求保留原句不改，勘误正文本身又要反复说
「落点不是**数组**而是 stderr」。它能证的只有「原件未被改写」。
**我另跑了一条能判完成度的**：`grep -rn "array push\|数组" src/ tests/` → **零命中、exit 1**（源码侧归零）。
文档侧的完成度靠 §5.3 的逐条归属核对，不靠计数。

### 5.3 我独立扫了一遍，确认「10 处是全集」—— 附归属

不照抄 brief 的清单，自己扫（勘误后的行号）：

```
grep -n "数组\|push" <文件A> <文件B> | grep -v "Amended"
```

命中 20 行，逐条归属，无一遗漏、无一多余：

- **本轮 10 处站点**：A `:671`/`:683`/`:696`/`:757`/`:2014`，B `:876`/`:1006`/`:1739`/`:2011`
  （＋源码 C，已不在 grep 命中里，因为它已改掉）。
- **brief 列的免动项**：A `:1578`（已带 `Amended 2026-08-05`）、B `:1721`/`:1725`/`:1771`（已带 `Amended 2026-08-04`）、
  A `:837`/`:847`（**常量数组**，指 `finalizeOrder`）、B `:133`（**测试数组**）。
- **我新写的勘误正文自身**：A `:2018`、B `:1743`。
- **brief 未列、但确属撞词无关的一处**：B `:150`「**push** 与 merge 都只在人明确下指令时执行」——
  这是 **git push**，与本族无关。它没进 brief 的免动清单，我判断是因为 brief 的免动清单只针对「数组」一词；
  **我没有动它**，在此点名以便评审员核对。

**结论：brief 的「10 处、不多不少」我独立复核后成立。** 我也没有在任何地方看到「6 处」或「9 处」的说法。

### 5.4 Rule 6 token 预算：本任务超支，主动上报

CLAUDE.md Rule 6 的每任务上限是 12,000 token。本任务需要读 3025 行的 spec 与 2020 行的 plan 的相关区段、
读三处源码、跑一次变异实验与两次全量验证，**显著超出该上限**。按 Rule 6 与 Rule 12 主动上报，不静默超支。
（压回预算的唯一办法是不做 §3.4 的变异实测，而那正是本任务最不该省的一步。）

---

# 修复环第 1 轮 — Important-1（`spec:759` 勘误正文自带一句不实描述）

## R1.1 我对这条判定的态度

**同意，无异议。三条加重情节我逐条自己复核过，全部成立。** 这是我自己写进勘误的一句不实描述，
上一轮我没发现它 —— 与本仓库「十五波修复十五次自带缺陷、无一由作者自己发现」的记录同形，这次是第十六次。

我原本的意图是给「回调在本层控制范围内」补一个可核对的边界（「它不会膨胀成一个格式化层」），
**但我选的措辞把一句本该是约束的话写成了一句事实断言，而那句事实断言是假的**。这是勘误里最不该犯的错：
勘误的全部作用就是让读者可以拿它去校核实现，一句校核不过的断言比没有勘误更坏。

## R1.2 我自己复核回调体的命令与输出

```
$ sed -n '205,209p' src/sweep/sweepRuns.ts
        onReconciliationWriteAbandoned: (detail) => {
          options.stderr(
            `note  ${candidate.path}  reconciliation_write_abandoned  ${detail.replace(/\r?\n/g, " ")}`,
          );
        },
```

**逐条核对三条加重情节：**

1. **原断言为假 —— 成立。** 回调体里那个模板字面量拼装了**整条成品行**：字面前缀 `note` ＋ 两个空格
   ＋ `candidate.path` ＋ 事件名 `reconciliation_write_abandoned` ＋ `detail`。
   **折行（`.replace(/\r?\n/g, " ")`）只是这条拼装里的一步，不是全部。**
   「不格式化超出一次折行」**描述不住它** —— 按这句话去校核，实现是「违规」的。

2. **与同族拷贝 `plan:878` 失同步 —— 成立。** 复核命令与输出（修复前）：

   ```
   $ sed -n '759p' <文件A> | grep -o "回调体本身只有一次同步调用 —— [^。]*。"
   回调体本身只有一次同步调用 —— 不碰文件系统、不 await、不格式化超出一次折行。
   $ sed -n '878p' <文件B> | grep -o "回调体本身只有一次同步调用 —— [^。]*。"
   回调体本身只有一次同步调用 —— 不碰文件系统、不 await。
   ```

   两处本该逐字同形（它们是同一条不对称论证的两份拷贝，我自己在 §2 站点 6/7 里写的处理原则就是「同构」），
   **实际差了半句**。

3. **与我同一笔提交里的兄弟勘误 `spec:698` 直接矛盾 —— 成立。** 复核输出：

   ```
   $ sed -n '698p' <文件A> | tr '。' '\n' | grep -n "不格式化"
   5:**注意「不格式化」这一句今天不能照留**：折行本身就是格式化，且人裁明令它在回调里当场做
   ```

   **同一个 commit `811a2e7`：`spec:698` 说「不格式化」这一句今天不能照留，`spec:759` 把它改造后留下了。**
   我在 §2 站点 3 的「为什么这么写」里还专门论证过这一点，**然后在 30 行之外自己违反了它**。

**关于可构造场景，我复核后认为成立且危害方向正确**：下一位读者按 `spec:759` 校核实现 → 发现回调在拼整行 →
判定「违规格式化」→ 把行拼装挪出回调体、改成先收集后统一格式化 → **反向复活人裁明令禁止的缓冲形状**。
这条路径的终点正是 `Amended 2026-08-04`/`-05` 一族花了大力气推翻的东西（缓冲在 SIGKILL 下静默丢告警），
**即这句话的失效方向是「把已经修好的洞重新挖开」，不是无害的措辞不准。** 定为 Important 我认为是恰当的。

## R1.3 改了什么

**一处，一句，只删不增。** `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:759`：

```
- ……回调体本身只有一次同步调用 —— 不碰文件系统、不 await、不格式化超出一次折行。
+ ……回调体本身只有一次同步调用 —— 不碰文件系统、不 await。
```

按评审员给的修法：**删掉「、不格式化超出一次折行」这半句**，让 `spec:759` 与 `plan:878` 逐字同形。
**没有往 `plan:878` 补任何东西**（对齐方向是删 spec，不是给 plan 补一句假的）。

**为什么删而不是改写成一句真话**：能描述准回调体的说法（「拼装一条固定格式的成品行」）**对这段论证毫无用处** ——
这段的支点是「谁能修好它」，回调格式化多少与「它抛出该由谁负责」毫不相干。
留一句正确但无关的话，只会再给下一位读者一个可以拿去校核实现的把手（Rule 2：不写超出所需的东西）。
删掉之后，这句话退回它唯一承重的两项 —— **不碰文件系统、不 await** —— 那两项今天为真，
且正是「它抛出不可能是环境事实」所需要的全部前提。

**同形/残留核对（修复后）**：

```
$ sed -n '759p' <文件A> | grep -o "回调体本身只有一次同步调用 —— [^。]*。"
回调体本身只有一次同步调用 —— 不碰文件系统、不 await。
$ sed -n '878p' <文件B> | grep -o "回调体本身只有一次同步调用 —— [^。]*。"
回调体本身只有一次同步调用 —— 不碰文件系统、不 await。
$ grep -rn "不格式化超出" docs/ src/ tests/
EXIT=1        # 全仓零残留
```

**两处现已逐字相同。**

## R1.4 验证：跑了什么、输出是什么

本轮只改一句 markdown，**理论上不可能影响测试**，但仍按要求跑了一次全套件确认无回归（成本 17s）。

**⚠️ 自曝一次程序违规**：我第一次跑全套件时用了 `rtk proxy "npm test -- --run" 2>&1 | tail -60`。
**`tail` 属于过滤输出，违反铁律 2（「`grep` 与 `tail` 同罪」），且它恰好切掉了必须核对的 `RUN` 路径首行。**
我当场作废那次运行并**未过滤重跑**。下面贴的是重跑的完整输出要件。

**`RUN` 路径首行（重跑，未过滤）**：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop
```

路径正确，是本仓库根。

**结果**：

```
 Test Files  30 passed (30)
      Tests  514 passed (514)
   Start at  00:20:50
   Duration  16.69s (transform 2.49s, setup 0ms, collect 3.82s, tests 57.77s, environment 6ms, prepare 1.63s)
```

**30 files / 514 tests / 0 failed，与基线及上一轮逐字相同 —— 无回归。**
输出中的三段 `stderr | tests/cli/cli.test.ts …` 与 `stdout | … ls …` 是被测代码自己的预期输出，不是失败
（与上一轮同）。

**未重跑 `tsc`**，理由：本轮 diff 只有一个 markdown 文件的一行，**没有触及任何 `.ts` 文件**
（`git diff --name-only` 只列出该 md），`tsc` 的输入集合与上一轮 `TYPECHECK_EXIT=0` 时完全一致。
如需我照样跑一遍，说一声即可。

## R1.5 边界自查（五条 Minor 未动、免动项未动）

按指令，本轮**只修 Important-1，五条 Minor 一律不动**，以免扩大 diff 面、让 scoped 再评审失去范围。

**diff 面自查**：

```
$ git diff --stat
 ...2026-08-01-sweep-and-transactional-continuation-design.md | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

**一个文件、一行、+1 −1** —— 即单行内的一次删词。逐条对照四条边界：

- ✅ **没有改 `spec:698`**（那处今天是对的）—— 它不在 diff 里。
- ✅ **没有往 `plan:878` 加任何东西** —— `plan` 文件不在 diff 里。
- ✅ **没有改结论** —— 「回调抛出只可能是编程错误、必须显眼地炸出来」「支点是谁能修好它」
  两句在 diff 的 `+` 行里逐字保留，一个字未动。
- ✅ **没有顺手动五条 Minor**，也没有动上一轮 brief 的任何免动项（A `:1578`、B `:1721`/`:1725`/`:1771`、
  A `:837`/`:847`、B `:133`）—— 它们都不在 diff 里。

**上一轮的 10 处站点仍全部在位**：本轮是在站点 4（`spec:751`→现 `:759`）的勘误正文内部删一个短语，
**没有删除或撤销任何一处勘误**，10 处依然是 10 处。
