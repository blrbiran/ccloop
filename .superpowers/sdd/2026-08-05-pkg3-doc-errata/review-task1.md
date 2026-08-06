# Task 1 独立评审 — pkg3 文档勘误（4f3b790..811a2e7）

评审员：独立评审 agent，未参与实施、未参与 brief 的编写。
状态：**已完成**。

**立场声明**：本仓库不接受实施者自证。报告里凡引用数字，旁边都有我**自己**跑过的命令与当时的输出（§1）；
凡我没有独立验的，我在该处明写「我没有验」。锚点一律用符号名或逐字引用，行号只作辅助
（本轮编辑让行号大面积移位，行号不可作为唯一锚）。

## 0. 结论

- **规格符合性：✅** —— 10 处全做、不多不少；brief 明确排除的 10 处（已带勘误 3、复述 4、撞词 3）一处未动；
  两份文档是**纯新增**（0 删除），源码只动注释。
- **任务质量：有 findings** —— 0 Critical / 1 Important / 5 Minor。核心判断：**地基是真的**
  （今天实现＝当场 `options.stderr(...)`，我读了源码）、**两条变异指令今天照做真的能钉住**
  （我自己施加变异跑过，12d(ii) 红、12d(i) 绿）、**还原是干净的**（我用两条独立基准比对过）。
  Important 那一条是勘误正文自身引入的一句**新的不实描述**，且与它的同族拷贝失同步。

## 1. 我自己跑过的命令与输出

**说明**：以下每条都是我自己跑的，不是转述报告。凡我**没有**独立验的，本报告在该处明写。

| # | 命令 | 我当时拿到的输出 |
|---|---|---|
| V1 | `git log --oneline 4f3b790..811a2e7` | 单个 commit `811a2e7 docs(errata): 就地勘误「回调=一次数组 push」族仍无勘误的 10 处` |
| V2 | `git diff 4f3b790..811a2e7 --numstat` | `14 0 …plans/2026-08-02-…md` / `16 0 …specs/2026-08-01-…md` / `7 3 src/persistence/fileStore.ts` |
| V3 | `git status --porcelain`（rtk proxy 原样） | 空（工作树干净） |
| V4 | `git diff HEAD --numstat` | 空 |
| V5 | `git diff 4f3b790..811a2e7 -- src/sweep/sweepRuns.ts` | 空、exit 0（**该文件在本轮零改动**） |
| V6 | `diff <实施者备份 scratchpad/sweepRuns.ts.bak> src/sweep/sweepRuns.ts` | `Files are identical`，exit 0 |
| V7 | `git show 4f3b790:src/sweep/sweepRuns.ts > X; diff X src/sweep/sweepRuns.ts` | `Files are identical`，exit 0 |
| V8 | `grep -c Amended <文件A>` | `10` |
| V9 | `grep -c Amended <文件B>` | `22` |
| V10 | `grep -rn 'array push\|数组' src/ tests/` | 零命中，`GREP_EXIT=1` |
| V11 | `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run`（全量，输出整段落盘到 scratchpad/vitest.out） | `VITEST_EXIT=0`；`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop`（第 2 行）；`Test Files  30 passed (30)`；`Tests  514 passed (514)` |
| V12 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json`（输出整段落盘） | `TYPECHECK_EXIT=0`，输出 **0 行** |
| V13 | 施加变异后 `npx vitest run tests/sweep/sweepRuns.test.ts --reporter=verbose` | `PASS (12) FAIL (1)`，唯一失败 `sweepRuns keeps the abandonment note on stderr even when the run throws afterwards`，`AssertionError: expected [ …(2) ] to deeply equal [ …(3) ]` at `tests/sweep/sweepRuns.test.ts:652:27`，`VITEST_EXIT=1` |
| V14 | 变异前同一文件基线 `npx vitest run tests/sweep/sweepRuns.test.ts` | `PASS (13) FAIL (0)`，`VITEST_EXIT=0` |
| V15 | `grep -n 'stderr' src/cli.ts` | `234:          stderr: (line) => console.error(line),` |

**两条披露（房规「不许过滤」的诚实交代）**：

1. V11/V12 的输出**整段落盘**到 scratchpad（`vitest.out` / `tsc.out`），我在报告里只摘了汇总行与退出码 ——
   落盘的是完整未过滤输出，不是我只跑了 grep。V12 的 `tsc.out` 本身就是 **0 行**。
2. **一处我一开始跑错、如实记下**：`npx tsc --noEmit` 曾吐出上百条 `node_modules/@types/node/*.d.ts` 的
   `TS1005` 语法错。改用 `./node_modules/.bin/tsc`（两者 `--version` 都报 `5.9.3`）后 **0 行、exit 0**。
   这是 `npx` 解析到另一份缓存安装的工具链假象，**不是本轮改动引入的回归**（本轮 TS 侧只改了注释）。

**我没有独立验的**：实施者报告里贴的那几段变异实测原文（`- Expected / + Received` 的逐行差异）。
我没有去比对他的原文，而是**自己重跑了同一条变异**（V13/V14），结论一致。

## 2. 十处站点逐条核对（不多不少）

**方法**：不照抄 brief 的清单，也不照抄实施者的归属表。我用两条互不依赖的判据交叉核：

- **判据 A（数量对得上）**：`git diff --numstat` = `16 0` / `14 0`（V2）。**删除数为 0**，
  所以「原件一个字节没被改写」是**机械可证的**，不靠人核。新增 16 行 / 14 行，逐块拆：
  spec 5 块（4 块各 2 行「空行＋勘误段」＋ A:2006 那块 8 行）= 16；plan 4 块（3 块各 2 行＋ B:1735 那块 8 行）= 14。
  **所以 spec 恰好 5 个新勘误块、plan 恰好 4 个，加源码 1 处 = 10，没有第 11 处的余地。**
- **判据 B（位置对得上）**：`grep -n '数组\|push' <A>` 与 `<B>`，逐条归属，**零剩余**。

### 判据 B 的逐条归属（勘误后的行号，用逐字句锚定，不依赖行号本身）

**文件 A（spec）** 全部 `数组|push` 命中：

| 命中行 | 逐字锚点 | 归属 |
|---|---|---|
| 671 | 「(b) 的回调……**写进了 sweep 自己的数组里**」 | 站点 1，勘误在紧邻的 673 |
| 673 | `Amended 2026-08-05：本条最后一句的落脚点……` | 站点 1 的勘误正文 |
| 683 | 「把 `{ path, detail }` **push 进本次 sweep 的备注数组**」 | 站点 2，勘误在 685 |
| 685 | `Amended 2026-08-05：上表 sweep.sweepRuns 那一行……` | 站点 2 的勘误正文 |
| 696 | 「**定死为一次数组 push**（不做 I/O、不格式化）」 | 站点 3，勘误在 698 |
| 698 | `Amended 2026-08-05：上段「把 sweep 侧的实现定死为一次数组 push……` | 站点 3 的勘误正文 |
| 757 | 「（**§9 已把它定死为一次数组 push，不做 I/O**）」 | 站点 4，勘误在 759 |
| 759 | `Amended 2026-08-05：上段括号里「§9 已把它定死为……` | 站点 4 的勘误正文（**见 Important-1**） |
| 837 / 847 | 「改一个**常量数组**的顺序」「(c) 让输家的 reconciliation 写……」 | brief 免动项（`finalizeOrder`），**未动** ✅ |
| 1578 / 1586 | §9 模块表那一行 ＋ 其 `Amended 2026-08-05` | brief 免动项（已带勘误），**未动** ✅ |
| 2014 | 「**变异：把备注的落盘时机从「回调当场记入 sweep 的数组」……**」 | 站点 5，勘误在 2016–2022 |
| 2016 / 2018 | 站点 5 的勘误正文（含变异动作条目） | 站点 5 的勘误正文 |

**文件 B（plan）** 全部 `数组|push` 命中：

| 命中行 | 逐字锚点 | 归属 |
|---|---|---|
| 133 | 「往**测试数组**里注入只证明匹配器有效」 | brief 免动项（撞词），**未动** ✅ |
| 150 | 「**push** 与 merge 都只在人明确下指令时执行」 | git push，brief 未列但确属撞词；**未动** ✅（实施者也点名了，我复核属实） |
| 876 / 878 | 「（§9 定死为一次数组 push，不做 I/O）」 ＋ 其勘误 | 站点 6 ✅ |
| 1006 / 1008 | 「定死为**一次数组 push**（不做 I/O、不格式化）」 ＋ 其勘误 | 站点 7 ✅ |
| 1721 / 1723 / 1725 | Task C3「落点」一节 ＋ 其 `Amended 2026-08-04` ＋ 复述 | brief 免动项，**未动** ✅ |
| 1739 | 「**变异：把备注的落盘时机从「回调当场记入 sweep 的数组」……**」 | 站点 8，勘误在 1741–1747 |
| 1741 / 1743 / 1747 | 站点 8 的勘误正文 | 站点 8 的勘误正文 |
| 1771 / 1773 | Step 6 括号「回调=一次数组 push」＋ 其 `Amended 2026-08-04` | brief 免动项，**未动** ✅ |
| 2011 / 2020 | 可追溯性矩阵 `writeBoundaryArtifacts` 那一行「C3（回调=数组 push）」＋ 表下勘误 | 站点 9 ✅（**见 Minor-2**） |

**文件 C（源码）**：站点 10 已就地改写（旧句 `a single array push, no I/O` 已不存在），
所以它不再出现在 `grep` 命中里 —— 与 V10「`src/` `tests/` 零命中」互证。

### 结论

**10 处全做，一处不多、一处不少；brief 列的 10 处免动项一处未动。**
「brief 的『10 处是全集』判对了」这一点，我用判据 B 独立复核后成立 —— 我没有在 A/B 里找到
第 11 处仍以旧前提为准、且没有紧邻勘误的句子。

**（我没有验的）**：`.superpowers/` 台账与 `docs/handoff/handoff.md` 里也有「一次数组 push」的字样，
但那些是**记这笔债本身**的历史记录（例如 `handoff.md:52` 就是本任务的立项描述），
brief 把范围定死在 A/B/C 三个文件，**我按范围核，没有替 brief 重画范围**（铁律 1 同样约束我）。

## 3. spec:671 —— 勘误是否越界（结论有没有被顺手改掉）

**判定：没有越界。结论、选型、前半段论证都原封不动，只重述了最后一句的落脚点。**

逐条核（勘误正文在 `spec:673`，锚点是它的首句 `Amended 2026-08-05：本条最后一句的落脚点……`）：

| 该保护的东西 | 勘误正文有没有动它 |
|---|---|
| **结论：选 (b) 不选 (a)** | 明写「**⚠️ 结论不动**……**(b) 仍然是被选中的方案**」——没动 ✅ |
| **前半段论证**（(a) 在 `runLoopFromState` 顶端抛出时消息蒸发） | 明写「**选型与本条前半段……一个字不改**」——没动 ✅ |
| **三条否决理由的编号与结构** | `numstat` 删除数为 0，原句一个字节没被改写 ✅ |
| **论据的落脚点** | 改了 —— 从「记录已在 sweep 手上」改成「记录当场写出了本进程」✅ **这正是该改的那一处** |

**新论据支不支撑得住原结论？我独立推一遍：** (a) 的失效形状是「抛出 → 无返回值 → 消息蒸发」。
(b) 今天的形状是「事件发生的当场就 `options.stderr(...)`」——写发生在 `resume` 抛出**之前**，
所以抛出路径上记录仍然存在。**这条推理不依赖「记录留在 sweep 手上」这个已死的前提**，
原结论因此完整存活。**论据没有被削弱到支撑不住结论。**

**我实测印证了这一点**：§4 那条变异（把当场写换成返回后写，即人工重建方案 (a) 的失效形状）
让 12d(ii) 变红 —— 也就是说，**今天的测试仍在为「否决 (a)」这条论证站岗**，
论证不是纸面存活，是有护栏的。

**一处保留（Minor-3）**：勘误新加了一句判断 ——「**即今天的落脚点比原句更强，不是更弱**」。
这句是**本轮新引入的论断**，不是既有裁定的搬运。它在实践上成立（数组要押「进程活到循环结束」，
而那可能是数小时；stderr 写只押到 OS 缓冲，量级是微秒），但**在绝对意义上略被说满**：
生产接线是 `console.error`，当 stderr 是 **pipe** 时 Node 的写是**异步**的，
`ccloop sweep 2>&1 | tee log` 下一次紧随其后的 SIGKILL 理论上仍可能丢掉尚未 flush 的那一行。
可构造场景：下一个读者拿这句「更强」当**保证**去论证「stderr 路由已经是持久化级别的可见性」，
从而否掉某个未来提出的「同时落 events.jsonl」的冗余提议。**建议把「更强」降级为
「在本文档关心的失效模式（SIGKILL / OOM 打断一趟数小时的 sweep）上更强」。**

## 4. 两处变异指令（spec:2006 / plan:1735）—— 我自己执行了那条变异

这是本任务最容易被糊弄的地方，所以我**没有**只读文字，我把勘误正文写的那条变异**照字面做了一遍**。

### 4.1 勘误正文给的变异动作（逐字，两处同形）

> **变异动作**（只动生产代码 `src/sweep/sweepRuns.ts`，一处）：把 `onReconciliationWriteAbandoned` 回调体里
> 那次当场的 `options.stderr(...)` 改成把该行 push 进一个声明在 `await resume(...)` **之外**的局部数组，
> 并在 **`await resume(...)` 正常返回之后**才把数组里的行逐条 `options.stderr(...)` 出去。
>
> **期望**：测试 **12d(ii)**（裸 `it` 名 `keeps the abandonment note on stderr even when the run throws afterwards`）**必须红**。

### 4.2 我照它做了什么

在 `sweepRuns` 的 for 循环体内、`try {` 之前加 `const mutationBuffer: string[] = [];`；
把回调体的 `options.stderr(...)` 换成 `mutationBuffer.push(...)`；在 `await resume(...)` 那个表达式
**正常返回之后**（即 `});` 之后、`const outcome = …` 之前）加 `for (const buffered of mutationBuffer) options.stderr(buffered);`。
**只动生产代码，一行测试没碰。**

### 4.3 实测结果（V13/V14）

- **变异前**：`PASS (13) FAIL (0)`，exit 0。
- **变异后**：`PASS (12) FAIL (1)`，exit 1，唯一失败的就是
  `sweepRuns keeps the abandonment note on stderr even when the run throws afterwards`，
  失败点 `tests/sweep/sweepRuns.test.ts:652:27`，形态 `expected [ …(2) ] to deeply equal [ …(3) ]`。

**判定：这条变异今天照做，是一次精确击杀。它钉住了东西，没有构造假基线。**

### 4.4 为什么它没有构造假基线（这是本轮最重要的一条判断）

原文的病是：把「回调当场记入 sweep 的数组」当**基线**，而那个基线今天不存在，
所以执行者要先造一个假形状再变异它。**勘误把数组从「基线」翻到了「变异后的形状」** ——
今天的基线是 stderr 当场写（真实存在），变异把它换成「攒进数组、正常返回后才冲」。
**方向反过来之后，执行者不需要构造任何今天不存在的东西**，这正是修法该有的样子。

### 4.5 「12d(i) 保持绿是正确的」这个说法可不可信 —— 我独立判：**可信**

我不接受「他跑过所以对」。我读了测试再判：

- **12d(ii)**（`tests/sweep/sweepRuns.test.ts` 里 `keeps the abandonment note on stderr even when the run throws afterwards`）
  的替身 `resume` 是 `Promise.reject(...)`：变异后「正常返回」那一步永远走不到，`note` 行整条消失，
  断言 `expect(h.stderrLines).toEqual([banner, note, error])` 只收到 2 行 → **必红**。
- **12d(i)**（`prints a reconciliation_write_abandoned note on stderr without changing the run outcome`）
  的替身 `resume` 是 `Promise.resolve(finishedState)`：变异后冲出照样发生，两条 `note` 行仍按遍历顺序
  出现在 banner 之后（`expect(h.stderrLines.slice(1)).toEqual([note run-1, note run-2])`），
  报告行走 stdout 不受影响 → **仍绿，且这是对的**。
- **这条变异本来就只钉抛出路径**，正常路径上「当场写」与「返回后写」在**终态**上不可区分 ——
  12d(i) 断的是终态，所以它绿不是漏杀，是**分工**。勘误正文把这句话写进去了，
  正是为了堵住「只红一条 → 我是不是做错了」这条误判。**这一句我判成立。**

**结论：两处变异指令的勘误做到了 brief 要求的那件事** —— 不是加一句「已改为 stderr」了事，
而是把**变异什么、期望哪条红、为什么另一条不红**三样都写死了。

### 4.6 一处不足（Minor-1）：变异动作对「数组的作用域与是否清空」欠一句

原文只说「声明在 `await resume(...)` **之外**的局部数组」，没说是**每个 run 一个**还是**整趟 sweep 一个**，
也没说冲出后要不要清空。三种读法我都推了一遍：

| 读法 | 12d(ii) | 12d(i) |
|---|---|---|
| 数组声明在**循环体内**（我实测的这种） | 红 ✅ | 绿 ✅ |
| 声明在**循环外**、每次正常返回后冲出**并清空** | 红 ✅ | 绿 ✅ |
| 声明在**循环外**、冲出后**不清空** | 红 ✅ | **也红**（run-2 那次冲出会把 run-1 的 note 再打一遍，`toEqual` 多出一行） |

**可构造场景**：下一个执行者按第三种读法做，看到「红了两条」，与勘误明写的
「12d(i) 保持绿是正确的」冲突，于是要么怀疑自己做错、要么怀疑测试坏了，多烧一轮排查。
**三种读法都杀得掉 12d(ii)，所以这不影响变异的有效性**，只影响执行者的确定性。
修法是一句话：把「局部数组」明确成「**每个 run 一个**（声明在 for 循环体内）」。

## 5. 勘误正文描述的「今天真实实现」是否属实（地基）

我自己读了 `src/sweep/sweepRuns.ts`，不看实施者贴的行。回调体逐字如下
（锚点：`onReconciliationWriteAbandoned` 这个键，位于 `sweepRuns` 的 `for (const candidate of candidates)`
循环内、`await resume(candidate.path, adapter, {…})` 的参数对象里）：

```
        onReconciliationWriteAbandoned: (detail) => {
          options.stderr(
            `note  ${candidate.path}  reconciliation_write_abandoned  ${detail.replace(/\r?\n/g, " ")}`,
          );
        },
```

紧邻其上的现场注释逐字含：`Written AT THE CALLBACK, not buffered for a flush after the loop.`
以及 `Deliberately NOT wrapped in try/catch: 'options.stderr' throwing is a programming error in the caller`。
`options.stderr` 的类型在 `SweepOptions` 里是 `stderr: (line: string) => void`。

**地基判定：属实。** 勘误正文反复主张的四件事我逐条对上了：

1. **落点是 stderr、当场写、不是数组 push** —— ✅ 属实（回调体只有一次 `options.stderr(...)`；
   我通读了 `sweepRuns` 全函数，**回调之外不存在任何备注数组**）。
2. **`\r?\n` 折行在回调里当场做** —— ✅ 属实（`detail.replace(/\r?\n/g, " ")`）。
3. **不碰文件系统、不 await** —— ✅ 属实。
4. **仍然刻意不包 try/catch** —— ✅ 属实（现场注释自证）。

**一处不属实，见 Important-1**：`spec:759` 额外写的「**不格式化超出一次折行**」。回调体除折行外
还**拼装了整条成品行**（`note` 字面量 ＋ path ＋ 事件名 ＋ detail，用双空格分隔）——那就是格式化。

**顺带核了一条更远的事实**（因为它是这轮不对称论证的落点）：`writeBoundaryArtifacts` 的回调是从
`sweepRuns` 一路透传下来的 —— `src/sweep/sweepRuns.ts:205` → `src/controller/resumeLoop.ts:210`
→ `src/controller/runLoop.ts:1217`/`:1271` → `runLoop.ts:903`/`:927` → `src/persistence/fileStore.ts:482`
（`options?.onReconciliationWriteAbandoned?.(String(decision.error))`）。**生产侧只有这一条链**，
所以 `fileStore` 注释里「sweepRuns passes SweepOptions.stderr」在**今天**属实（见 Minor-4 的保留）。

## 6. fileStore.ts —— 是否动到可执行代码

**判定：没有。7 增 3 删，10 行全部是 `//` 注释行，可执行代码零字节变动。**

我怎么验的（不靠实施者的话）：

1. `git diff 4f3b790..811a2e7 -U6 -- src/persistence/fileStore.ts` 的**唯一 hunk** 落在
   `writeBoundaryArtifacts` 内那段以 `// The callback deliberately does NOT get this treatment:` 开头的注释里。
   **该 hunk 里每一条 `-` 行与每一条 `+` 行都以 `//` 开头。**
2. 上下文行 `// Ordered BEFORE appendEvent on purpose` 与其上的三条编号约束**未被触碰**。
3. `numstat` = `7 3`，与 hunk 内计数一致 —— **没有第二个 hunk**。
4. 全量测试 30 files / 514 tests 全绿（V11）、`tsc --noEmit` 0 行 exit 0（V12）。
   （这两条对「只改注释」是**弱**证据，真正的强证据是第 1、3 条 —— 我把它写清楚，不拿绿灯当证明。）

**改写内容本身也核了一遍**：旧句 `control (a single array push, no I/O)` 是这段唯一说假话的地方，
新句 `a single synchronous call into a sink the caller injected (sweepRuns passes SweepOptions.stderr),
touching no filesystem and awaiting nothing` 与我在 §5 读到的源码一致。
新增的末句 `The asymmetry turns on who can fix it, not on whether the callback performs I/O` 也与
`spec:757` 那段原论证的支点一致（该支点没被本轮改动）。**未使用 `*Amended*` 标记，符合 brief 的要求。**

## 7. 指针可跟性（逐站点核）

房规：一处勘误管住多个站点时，每个站点都要留下能跟到勘误的指针。我逐站点跟了一遍，
并且**真的去 grep 了指针指向的目标存不存在、唯不唯一**。

| 站点 | 指针逐字 | 目标存在？ |
|---|---|---|
| 1 A:671 | 「本文档 §9 模块表 `src/sweep/sweepRuns.ts` 那一行下方的 `Amended 2026-08-05`」＋「实现见 `src/sweep/sweepRuns.ts` 的 `onReconciliationWriteAbandoned`」 | ✅ 目标是 `spec:1586`；实现锚点也存在 |
| 2 A:681 | 同上（§9 模块表那一行下方） | ✅ `spec:1586` |
| 3 A:692 | 同上 | ✅ `spec:1586` |
| 4 A:751 | 同上，另加「源码里同形的那段注释在 `src/persistence/fileStore.ts` 的 `writeBoundaryArtifacts` 内，已同步」 | ✅ 两个目标都在 |
| 5 A:2006 | 同上 | ✅ `spec:1586` |
| 6 B:876 | 「`docs/…/2026-08-01-…-design.md` §9 模块表 `src/sweep/sweepRuns.ts` 那一行下方的 `Amended 2026-08-05`」（**跨文件全路径**） | ✅ 跨文件指针可跟 |
| 7 B:1004 | **双指针**：「本计划 `### Task C3`「落点」一节的 `Amended 2026-08-04`」＋ spec §4.3 同一处 | ✅ 目标是 `plan:1723` 与 `spec:698` |
| 8 B:1735 | 「本节上面「落点」一条的 `Amended 2026-08-04`」 | ✅ `plan:1723` |
| 9 B:1999 | 「本计划 `### Task C3`「落点」一节的 `Amended 2026-08-04`」 | ✅ `plan:1723` |
| 10 C:469 | **无指针** | ⚠️ 见下 |

**歧义检查（这条我特意做了，因为台账原话就是「一笔债被一个看起来同名的东西承接」）**：
`spec` 里 `Amended 2026-08-05` 共 10 行，其中 §9 附近有**两条**（`:1566` 横幅一族、`:1586` 模块表一族）。
指针写的是「**§9 模块表 `src/sweep/sweepRuns.ts` 那一行下方的**」，足以唯一定位到 `:1586`；
而 `spec:1588` 本身就明写「本文档 §8 横幅那一处的 `Amended 2026-08-05` 与计划 `### Task C3` 的同名勘误是另一族，
两族互不相干」。**同名混淆这个具体风险已被既有文本堵住，本轮没有把它捅开。**
`plan` 里 `Amended 2026-08-04` 有 7 条，指针用「`### Task C3`「落点」一节」限定，唯一 ✅。

**站点 10 无指针 —— 我的判断（Minor-5，不算规格不符）**：
站点 10 是**就地改写**（假句已不存在），没有留下需要被读者「跟到勘误」的腐句，
所以房规那条指针要求的**目的**在这里已经达成，我不把它记成规格不符。
但**链接是单向的**：`plan:878` 说「落地的那段注释在 `fileStore.ts` 内、**已按本条同步**」，
而注释里**没有任何一句指回 `spec §4.3/§9` 或 `plan Task C3`。
**可构造场景**：下一位改动回调语义的工程师只改这段注释（它自成一体、读起来无需外求），
文档两份拷贝再次静默腐坏 —— 这正是 `b9afbf3` 那次「文档同步了、源码没跟」的**镜像失效**。
同一段注释里既有引用计划任务号的先例（`the operator callback that A8 inserts immediately above`），
所以补一句 `// see §4.3 / §9 of docs/superpowers/specs/2026-08-01-…` 是零成本、同风格的。

## 8. 对实施者三条 concern 的独立判断

### concern 1 —— 站点 4/6/10 的替代依据站不站得住？缓解事实属不属实？

**我的独立判断：替代依据站得住，但确实比原依据弱；他的自评是诚实的，没有夸大也没有掩饰。
缓解事实我核了，属实。**

**(a) 「不是他发明的新论证」—— 属实，我逐字核过。** 替代依据的原话在 `spec:1586`（锚点勘误）里逐字存在：

> **回调仍然不得抛出**，且**仍然刻意不包 try/catch**——`options.stderr` 抛出是调用方的编程错误，吞掉它违反 Rule 12。

以及 `src/sweep/sweepRuns.ts` 现场注释：
`'options.stderr' throwing is a programming error in the caller, and swallowing it here would hide it (Rule 12)`。
**所以这是搬运既有裁定，不是发明。他这条自述可信。**

**(b) 替代依据站得住吗 —— 站得住。** 那段论证的支点是「**谁能修好它**」，
而这个支点在两种依据下都成立：回调是**调用方注入的**，所以回调抛出永远是调用方能修的；
`appendFile` 的 I/O 是环境事实，谁也修不了。**不对称的处置（一个吞、一个不吞）因此完整存活。**
换句话说，旧依据「不做 I/O」只是支点的一个**充分条件**，不是支点本身；它死了，支点没死。

**(c) 他说「比原依据弱」—— 我同意，而且我认为他描述的弱法是准确的。**
「不做 I/O」是**结构性**的（不碰外部世界就不可能有环境失败，无需任何人守约）；
「sink 是注入的」是**约定性**的（要求每个注入方都注入一个不因环境原因抛出的 sink）。
**而这条约定今天在类型上没有任何表达**：我读了 `SweepOptions`，
`stderr: (line: string) => void` 旁边**没有一句「must not throw」的契约注释**。
所以它是一条**隐式契约**。这是真问题，值得人裁，他上报是对的。

**(d) 缓解事实属不属实 —— 属实，我自己验的。**

- `grep -n 'stderr' src/cli.ts` → `234:          stderr: (line) => console.error(line),`（V15）✅ 生产接线确是 `console.error`。
- Node 全局 `console` 的 `ignoreErrors` 默认为 `true`（`node:console` 的文档化默认值），写失败不抛。
  **这一条我是按 Node 的文档化行为判的，我没有构造一次真实 EPIPE 去实测** —— 如实写在这里。
- 因此他举的 `ccloop sweep | head` 触发 EPIPE 那条路径，**在今天的接线下不会让回调抛出**，
  「回调抛出只可能是编程错误」今天为真。**不存在实际缺陷。**

**(e) 我加一条他没说的**：这条隐式契约今天之所以安全，靠的是**只有一个生产注入点**
（我追了链：`cli.ts:234` → `sweepRuns` → `resumeLoop:210` → `runLoop:1217/1271` → `runLoop:903/927` → `fileStore:482`）。
**第二个注入点出现的那一天，安全性就没了。**
建议人裁时一并考虑：把「`SweepOptions.stderr` 不得抛出」写成 `SweepOptions` 上的**显式契约注释**，
成本一行，正好补上「约定性依据」缺的那半边。**我没有改任何东西，这只是给人裁的输入。**

### concern 2 —— 变异实测的还原干不干净？

**我的独立判断：还原是真的干净，而且我用了两条与他不同的基准，不依赖他那个 `IDENTICAL_TO_BACKUP` 标记。**

本仓库出过「用错误的标记去证明还原」的先例，所以我**完全不看**他打印的标记，改用：

- **基准一（他的备份文件）**：我在 scratchpad 里找到了他留下的 `sweepRuns.ts.bak`，
  `diff` 与今天工作树的 `src/sweep/sweepRuns.ts` → `Files are identical`，exit 0（V6）。
- **基准二（本轮开工前的仓库状态，与他无关）**：`git show 4f3b790:src/sweep/sweepRuns.ts` 落成文件，
  `diff` 与今天工作树 → `Files are identical`，exit 0（V7）。**这条最关键：它证明的是
  「今天的 sweepRuns.ts 就是任务开始前的那一份」，完全绕开他的备份是否可信。**
- **第三条**：`git diff 4f3b790..811a2e7 -- src/sweep/sweepRuns.ts` → 空、exit 0（V5），
  即**该文件根本没进这个 commit**；`git status --porcelain` 与 `git diff HEAD --numstat` 均为空（V3/V4）。

**结论：变异实验零残留，concern 2 不成立为问题。**
（附带一提：我自己也施加了同一条变异并还原，还原后重跑 V7 仍是 `Files are identical`，工作树干净。）

### concern 3 —— brief 那条自查命令不能判完成度，他的替代判据够不够？

**我的独立判断：他指出的问题成立；他给的替代判据**够用但不完整**，我补了一条更强的机械判据。**

- **他指出的问题成立**：`grep -rno "数组" A B | wc -l` 数的是**逐处出现数**，
  而房规要求保留原句、勘误正文又要反复提「数组」，**这个数做完必然上升**。它证不了完成度。
  （这是控制器已认账的记账错误，我不替谁辩护，只确认判断本身对。）
- **他的替代判据之一「`grep -rn "array push\|数组" src/ tests/` 零命中」**：我重跑了，确是零命中 exit 1（V10）。
  **但它只守得住源码侧的 1 处，守不住文档侧的 9 处** —— 文档侧他靠的是逐条归属核对，
  那是人核，不是机械判据。**够用（因为逐条归属我复核过、成立），但依赖人核。**
- **我补的机械判据（比两者都强，建议以后就用这条）**：
  `git diff <base>..<head> --numstat`，**要求两份文档的删除列恒为 0** ——
  这一条**一次性机械证明**「原件一个字节未被改写」，比 `grep -c "数组"` 强得多；
  再配上「A/B 里每一条 `数组|push` 命中要么紧邻一条 `Amended`、要么在免动清单上」，
  完成度与不越界两件事就都被机械覆盖了。本轮我就是这么核的（§2 判据 A ＋ 判据 B）。

## 9. Findings

**Critical：0 条。**
我特意去找了本仓库的经典失效形状（假基线、结论被顺手改掉、还原没被证明、
一处改了另一处没跟、用错误的标记自证），**逐条查过，本轮都没有踩到**（§3/§4/§7/§8）。

### Important-1 —— `spec:759` 引入了一句**新的不实描述**，且与它的同族拷贝 `plan:878` 失同步

**逐字锚点**（`spec` 里 `Amended 2026-08-05：上段括号里「§9 已把它定死为一次数组 push，不做 I/O」在今天为假`
那一段的中段）：

> 回调体本身只有一次同步调用 —— 不碰文件系统、不 await、**不格式化超出一次折行**。

**三个问题叠在一起：**

1. **它不实。** 今天的回调体除折行外还**拼装了整条成品行**：
   `` `note  ${candidate.path}  reconciliation_write_abandoned  ${detail.replace(/\r?\n/g, " ")}` ``。
   拼 `note` 字面量、拼路径、拼事件名、按双空格分隔 —— **那就是格式化**，且远不止「一次折行」。
2. **它与同一个 commit 里的兄弟勘误自相矛盾。** `spec:698`（站点 3）在本轮明写：
   「**注意「不格式化」这一句今天不能照留**：折行本身就是格式化」。
   而 61 行之后的 `spec:759` 又把「不格式化」以「不格式化超出一次折行」的形式**放了回去**。
3. **它与自己的同族拷贝失同步。** brief 把 `spec:751` 与 `plan:876` 标成同一条论证的两份拷贝。
   `plan:878` 的对应句写的是「回调体本身只有一次同步调用 —— **不碰文件系统、不 await。**」——
   **没有那半句**。两份拷贝在本轮之后逐字不再相同。
   **这正是紧邻上一个 commit `b9afbf3`（「GATE-C residual — sync the second same-family sentence」）
   刚刚为之开过一笔的失效形状**，本轮在同一族句子上又制造了一个新的。
   （同族的第二处小失同步：紧跟着的结论句 `spec:759` 写「只可能是**调用方的**编程错误」、
   `plan:878` 写「只可能是**编程错误**」。这一处**不影响语义**，但既然要动手改第 1 点，
   顺带对齐是零成本的 —— 我把它列在这里只为让人裁一次看全，不单独记一条 finding。）

**可构造场景（谁、在什么情况下、得出什么错误结论）：**

- **场景 A（改坏实现）**：下一位实施者接到「按 spec §4.3 校核回调实现」的任务，
  读到 `spec:759` 的「不格式化超出一次折行」，认定今天的回调**违规**（它拼了整行），
  于是把行拼装挪出回调体 —— 挪到哪儿都只有两个去处：挪进 `fileStore`（回调层不知道 path，做不到）
  或挪到 sweep 的循环里**回调之后**（那就退回了「回调只记、别处才写」的缓冲形状，
  **正是人裁在 `spec:1586` 明令禁止的那一件事**）。一条勘误因此可能反向复活它要杀掉的形状。
- **场景 B（再开一笔债）**：下一位评审员按 `b9afbf3` 立下的规矩去 diff 两份同族拷贝，
  发现 `spec:759` 与 `plan:878` 不一致，**无法从文本判断哪一份是权威**，只能再上一次人裁。

**修法（一句话，零风险）**：把 `spec:759` 的「、不格式化超出一次折行」**删掉**，
使它与 `plan:878` 逐字相同；「折行也在回调里当场做」这件事 `spec:698` 与 `spec:685` 已经各说过一次，
不需要在 `:759` 再说，更不该以「不格式化」的形式说。

### Minor-1 —— 变异动作对「数组的作用域与是否清空」欠一句

详见 §4.6。三种读法都能杀掉 12d(ii)（**所以不影响变异有效性**），
但「声明在循环外且冲出后不清空」这一种会**连带把 12d(i) 也打红**，
与勘误明写的「12d(i) 保持绿是正确的」冲突，让执行者多烧一轮排查。
锚点：两处勘误里逐字的「push 进一个声明在 `await resume(...)` **之外**的局部数组」。
修法：把「局部数组」明确成「**每个 run 一个**（声明在 for 循环体内）」。

### Minor-2 —— `plan:2020` 的粗体嵌套，把勘误后的正确读法排版成了非粗体

逐字锚点：`**Amended 2026-08-05：上表 … 「C3（回调=数组 push）」已被人裁推翻 —— C3 侧的回调是**当场 `options.stderr(...)`**，不是数组 push。**`
外层 `**…**` 里又嵌了一对 `**`，CommonMark 会把它解析成「粗体—普通—粗体」三段，
**结果恰好是「当场 `options.stderr(...)`」这个最该被看见的短语渲染成了非粗体**。
本轮其余 8 个勘误块都用 `*斜体*` 做内层强调、刻意避开了嵌套 —— 只有这一处破了自己的格式约定。
可构造场景：读者在渲染视图（而非 raw）里扫这张矩阵下方的勘误，视线被粗体带走，
漏读中间那半句，只记住「被推翻了」而没记住「改成什么」。修法：内层两个 `**` 改成 `*`。

### Minor-3 —— `spec:673` 新引入的「比原句更强」略被说满

详见 §3 末段。建议限定为「在本文档关心的失效模式上更强」。

### Minor-4 —— `fileStore.ts` 的注释把一个跨两层的调用方写死进了本层注释

逐字锚点：`a single synchronous call into a sink the caller injected (sweepRuns passes SweepOptions.stderr)`。
`writeBoundaryArtifacts` 的第三参是一个通用回调（`(detail: string) => void`），
`tests/persistence/fileStore.test.ts` 就直接传自己的回调调它。
今天生产侧确实只有 `sweepRuns` 这一条链（我追过，见 §5），**所以这句今天不假**；
但它把一个隔了两层的模块名钉进了本层注释，**第二个生产调用点出现的那天它就变成假话**。
（旧句 `a single array push, no I/O` 有同样的耦合，所以这**不是回归**，只是耦合面变宽了。）
可构造场景：将来有人给 `writeBoundaryArtifacts` 加第二个调用点（例如 `ccloop resume` 单跑路径
也想路由这条备注），注释里的 `sweepRuns passes SweepOptions.stderr` 就成了新的腐句 ——
而它长在一段**专门解释为什么不吞**的承重注释里。
修法（可选）：把括号里的具体模块名换成「the caller's sink（today: sweep's stderr）」一类的弱断言。

### Minor-5 —— 站点 10 是全轮**唯一没有回指指针**的站点，链接是单向的

详见 §7 末段。我**不把它记成规格不符**（该站点已就地改写、没有留下腐句），
但 `plan:878` 单方面声称「已按本条同步」而注释里没有任何一句指回文档，
下一次改动会重演 `b9afbf3` 的镜像失效。修法：注释里补一句 `// see §4.3 / §9 of …-design.md`，
与同段既有的 `A8` 引用同风格。
