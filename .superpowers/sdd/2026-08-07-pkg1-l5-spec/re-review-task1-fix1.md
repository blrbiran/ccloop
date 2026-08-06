# Re-review — 包 1 / 任务 1 / 修复环 1（scoped）

> 范围：`git diff fbeb6fd..978d825 -- docs/` —— 单文件
> `docs/superpowers/specs/2026-08-07-cleanup-and-orphan-gc-design.md`（`+79 −10`，4 个 hunk）。
> 评审员：未参与实施与修复。所有结论直接读 HEAD 文件与自跑命令，不采信任何报告转述。
> HEAD = `896d79c`；`git diff 978d825..HEAD --stat` 只动 `.superpowers/sdd/{progress,task-1-report}.md`，
> **本文件在 978d825 与 HEAD 上完全一致**，故「读 HEAD」与「读范围末端」等价。

## 结论

**I1 = ADDRESSED / I2 = ADDRESSED / M4 = ADDRESSED。本轮无新破坏，可收口。**

新增 **2 条 Minor**（都落在 §4.2 这个新的完备性依赖点上，都**不阻塞本轮收口**）：

| # | 级别 | 一句话 |
|---|---|---|
| **N1** | Minor | §4.2 的授权面与 §4.5／§3.2.2 的保留面**在字面上重叠且无裁决规则**：一个匹配五段形、位于 `.validation-runs/<run>/` 或 `<run>/worktrees/` 之内的崩溃临时文件，§4.2 判「授权删」、§4.5 判「不在授权范围」，INV-4 让 §4.2 赢。「§4.2 只有一个面，可以穷举」这句因此**尚未完全兑现**。 |
| **N2** | Minor（**先于本轮存在**，非新引入） | §4.2 逐字「**按 §4.1 的要求**本就必须不在任何固定名集合之内」—— §4.1 是 INV-2（stale ≠ 删除许可），与固定名集合无关。该交叉引用在 `fbeb6fd` 上已存在（`git show fbeb6fd:<spec> \| grep -n` → `229:`），但 INV-4 把 §4.2 升格为唯一授权源之后，它从「小笔误」变成「承重段落里的错引」。 |

**INV-4 未进 §8.2**：判为 **Minor 缺口，建议后续轮次补，不必现在补**（理由见附加判点 4 —— 我不是因为「补了更保险」，而是因为 spec 自己在 §6.2 立了一条规则而 INV-4 恰好落在规则之外；也不是因为「他自报了」就放行）。

## I1 — 闭合清单语气 / INV-4 → **ADDRESSED**

**修法成立。** 三点判据：

1. **确实没有只补三类。** §3.2 拆成 §3.2.1（INV-4，承重规则）＋ §3.2.2（已知保留物，明标下界）。
   §4.5 也从「以下不在授权范围内：……」的闭合清单改成「问『§4.2 授权了吗』——
   答案不是『是』就不许删；『§4.5 没提到它』不构成授权」。**两处闭合语气都被拆掉了**，
   不是只在旧清单尾巴上追加三行。
2. **代价不对称的论证成立**：保留清单漏一项 = 数据丢失，授权清单漏一项 = GC 少干活。
   把完备性压在授权侧是正确方向。**这个方向对，但兑现程度见 N1。**
3. **没有下无限定的全称断言。** §3.2.2 末段逐字：「⚠️ **不要把补上它们读成「清单现已完备」**——
   本文作者的检索面**未覆盖** `tests/`、`validation/`、`reference/` 三个目录，也未穷举 `docs/` 下的
   全部计划与报告。**第 5–7 条只把下界抬高了，没有把它变成上界。**」
   §4.5 同样自标「举例（同样是下界，非穷举）」。**符合原评审「I1 是下界不是完备清单」的要求。**

**新增引文我逐条回原文核，5 条全部逐字准确（未过滤输出）：**

```
grep -rn 'silently clean up retained evidence or workspaces' docs/
  docs/superpowers/specs/2026-07-21-stop-no-progress-stale-boundaries-design.md:231:- silently clean up retained evidence or workspaces;
grep -rn 'Never delete prior run directories' docs/
  docs/superpowers/plans/2026-07-17-evidence-first-v1-validation.md:19:- Never delete prior run directories, retained worktrees, stashes, or evidence. Every retry gets a new run ID.
grep -rn 'deletion or mutation of' docs/
  docs/superpowers/specs/2026-07-21-docs-and-backlog-truth-alignment-design.md:54:- deletion or mutation of `.validation-runs/`, backup branches, or stashes;
grep -rn 'preserved real-run evidence lives only under' docs/
  docs/superpowers/specs/2026-07-19-a04-branch-assessment-and-merge-readiness-design.md:55:- preserved real-run evidence lives only under `.worktrees/evidence-first-v1/.validation-runs/` and must not be cleaned or rewritten;
grep -rn 'retained stashes must not be deleted or published' docs/
  docs/superpowers/specs/2026-07-19-a04-branch-assessment-and-merge-readiness-design.md:57:- backup branch `backup/evidence-first-v1-before-memory-history-cleanup` and retained stashes must not be deleted or published;
```

（每条的另一处命中即 spec 自己的引用行 `:200/:201`、`:210`、`:214`、`:217`、`:218`，
说明行号与归属文档也标对了。）

## I2 — 计数 23 / 21 → **ADDRESSED**

**自跑（未过滤，脚本落盘后 `rtk proxy zsh <script>` 执行，避开三层引号陷阱）：**

```
grep -ro 'writeOwnerTransferRecord' tests/ | wc -l    →  23
grep -ro 'writeOwnerTransferRecord(' tests/ | wc -l   →  21
```

`grep -rn` 全量输出共 **23 行**（runLoop.integration 2、fileStore.test 17、zeroWrite.test 4），
每行恰一处命中，故「23 次出现 = 23 行」成立；两处无括号命中即
`tests/persistence/fileStore.test.ts:23`（具名导入项）与
`tests/registry/zeroWrite.test.ts:22`（`import { readOwnerRecord, writeOwnerRecord, writeOwnerTransferRecord } from …`）。
**「23 = 2 import + 21 调用」这条算式我独立重推成立，spec §6.1 今天的数字与判别式都对。**
§6.1 正文取「21 处调用」，与调用式判别式自洽。

**spec 内 stale「22」检查**（`grep -n '22' <spec>`，8 行全部列出、未过滤）：
`:5 :100 :137 :198 :234` 是日期 `2026-07-22` / `07-22`；`:161` 是 `runLoop.ts:1225`；
`:460` 是行号 `zeroWrite.test.ts:22`；`:467` 是**勘误注里有意保留的历史陈述**。
=> **spec 内零残留 stale 计数。**

**全仓 `grep -rn '22 处' . --include='*.md'`**（未过滤）：命中 9 处，逐条判：
spec `:467`（有意保留）、`task-1-report.md:129`（勘误注引旧值）、`review-task1.md:18/125/163/194`（评审在描述缺陷本身）、
`progress.md:439`（台账记账）—— **均非残留**。另两处
`scan-2-design-input.md:152`（`safeUnlink` 22 处）与 `:328`（`src/` 内其余 22 处命中）
**不是 I2 的对象**（不同符号／不同检索面），我**未去核它们真伪** —— 见「我没验的事」。

## M4 — INV-1「今天零强制」是否就地进 §1 → **ADDRESSED**

spec `:68`–`:77`（§1.3 内，位于 `:79` 的 §1.4 之前）新增整段，逐字包含：
「在 L5 实现落地之前，INV-1 **没有任何机制强制**：没有测试会因为违反它而变红，没有 lint 钉住它，
它今天的全部存在形式就是本节这段文字」、「**这使 INV-1 与 §6.1 那条注释完全同型**」、
「**本文因此无法宣称自己免疫于它所批评的问题**」、「**本 spec 是约束的载体，不是约束的执行机制**」。
**这正是原评审 M4 要求的内容，且写在 spec 而非报告里。** 该段还主动承认自指弱点，
比 M4 的最低要求更强。

## 附加判点 1 — §4.2 是新的完备性依赖点

**我按要求撞 §4.2，不再撞 §3.2。**

**准确的部分（都验了）**：

- §5.2 引的源码与 `src/persistence/fileStore.ts:628` **逐字一致**：
  `` `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${atomicTempPathSequence}.tmp` ``，
  而 `ATOMIC_TEMP_PROCESS_STAMP = \`${process.pid}.${Math.trunc(performance.timeOrigin)}\``。
  => 五段形 `.{basename}.{pid}.{timeOrigin}.{seq}.tmp` **描述准确**。
- 三条删除判据（五段形 ＋ 位于 run 目录内 ＋ 生成进程已死（pid＋timeOrigin 消歧）＋
  该 run 无进行中的 owner-transfer）**都是可判定的谓词**，不是「看起来没人要了」这类软判据。
  pid 复用的坑被点名了，方向正确。
- `src/` 那段注释独立佐证了「固定名与临时名是两套、不得合并」（`fileStore.ts` 注释逐字
  `The transaction's fixed names must stay fixed for the opposite reason: crash recovery finds
  leftover staged files by name. The two helpers are different things; do not merge them.`）。

**不准确／未收口的部分 → N1（Minor）**：

§3.2.1 的论证前提是「**§4.2 只有一个面，可以穷举**」。但 §4.2 对这个面的空间限定只有一句
「**且位于一个 run 目录内**」，而本 spec **从未定义「run 目录」的外延**。
`grep -n 'validation-runs' <spec>` 的全部命中是 `:211 :214 :215 :217 :320` —— 都在 §3.2.2 与 §4.5 的
**保留侧**，§4.2 一侧零处限定。于是产生一个字面重叠：

- 一个位于 `.worktrees/evidence-first-v1/.validation-runs/<run>/` 内、匹配五段形、
  生成进程已死的临时文件：**§4.2 判「授权删」**；
  但 §3.2.2 第 6/7 条与 §4.5 都把 `.validation-runs/` 列为保留面，
  07-21 逐字禁止的是「**deletion or mutation of** `.validation-runs/`」（含 mutation）。
- 同型冲突还有一处**在同一文档内**：`<run>/worktrees/…` 下的五段形临时文件 ——
  §4.2 授权，§4.5 逐字「任何 `worktrees/` 下的条目（它归 run 生命周期，不归 GC）」不授权。

**INV-4 的裁决规则（「只有 §4.2 授权的才可删」）在这里让 §4.2 赢**，即读者会读出「可以删」。
这不是把 I1 修坏了 —— 冲突在 `fbeb6fd` 上就存在；但 I1 的修法**把裁决权全部集中到 §4.2**，
使这处重叠从「两张清单不一致」升级为「唯一授权源自身外延未封口」。

**建议（不阻塞本轮）**：在 §4.2 给「run 目录」加一句外延限定，例如
「仅限 L5 当前 GC 面内的 run 根目录，**不含** `.validation-runs/` 下的任何路径，
**不含** `<run>/worktrees/` 下的任何路径」。这是一句话的改动，且**必须由人裁或授权轮次做**，
不由我代改（只读）。

**我没有发现 §4.2 把「明显不该授权的东西」直接划进来**（除上述边界重叠外）：
`getOwnerTransferPaths` 的十个**固定名**不匹配五段形，不会被这条判据吞掉，
§4.2 还额外要求「该 run 无进行中的 owner-transfer 事务」作第二道闸。

## 附加判点 2 — 无新破坏

**hunk 级核对**：`git diff fbeb6fd..978d825 -- docs/` 恰 4 个 hunk，起点
`@@ -65`（§1.3 追加）、`@@ -163`（§3.2 重构）、`@@ -264`（§4.5 改写）、`@@ -388`（§6.1 计数）。
**只改了一个文件**，M5 的对象是 `2026-07-26-…-design.md`，**本 diff 根本没碰到它**。

**4 条不动的 Minor 全部未被碰：**

| Minor | 位置 | 是否落在 4 个 hunk 内 | 判 |
|---|---|---|---|
| M1（§1.1 `releaseOwnerLease` 只列 3 行 / 「3 处」vs 实测 4 处） | §1.1，spec 前 60 行 | 否 | **未动**（缺陷仍在，符合「本轮只修三条」） |
| M2（§6.1 「逐字首句」认错了注释首句） | §6.1，`@@ -388` hunk 之前 | 否 | **未动** |
| M3（`find -iname '*gate*'` 撑不起「五份」） | §6.1，该行以**上下文行**（前缀空格）出现在 hunk 内 | 出现但未修改 | **未动** |
| M5（07-26 文档无回指指针） | 另一文件 | 否 | **未动** |

**10 行删除逐条归因**（全部落在 I1／I2 授权范围内）：

- §3.2：`### 3.2 什么该保留`、`按 §2 两份委任状，以下四类**默认保留**…` = **2 行** → I1 去闭合语气；
- §4.5：原 3 行闭合清单 = **3 行** → I1 去闭合语气；
- §6.1：`grep -rn … src/ tests/` 改为 `src/`、两行 `# tests/ 内 22 处调用…` 注释 = **3 行** → I2；
- §6.1：`⚠️ **这里要说准**…22 处调用。` 与 `但这 22 处…` = **2 行** → I2（被同义重写为 21）。

**合计 10 行，零误删承重句。** 唯一的信息损失是极轻的：被删的注释曾点名三个测试文件，
新正文只点名了两个（`fileStore.test.ts`、`zeroWrite.test.ts`），
`tests/controller/runLoop.integration.test.ts` 不再被 spec 点名。
**这不构成缺陷**（承重断言是「全是 fixture、无一断言那条约束」，不依赖文件清单），仅记于此。

## 附加判点 3 — 修复正文本身的断言质量

**两处自查缺陷都真修好了：**

1. **反引号嵌套**：§3.2.2 第 6 条（spec `:213`–`:214`）现为块引用形式
   `` >  deletion or mutation of `.validation-runs/`, backup branches, or stashes; `` ——
   块引用内的反引号正常渲染，**渲染缺陷已消除**，引文仍逐字（见 I1 节 q3）。
   第 5、7 条也统一用块引用，风格一致。
2. **未限定检索面的自查断言**：该断言在**报告**里（`task-1-report.md:261`），已就地补上限定并
   自报全仓 3 处。我复跑 `grep -rn '22 处' . --include='*.md'` 得 9 行 —— **比他写的「3 处」多**，
   但多出来的都是评审文与台账在**描述这个缺陷本身**（`review-task1.md` 4 处、`progress.md` 1 处、
   `scan-2` 2 处属另一符号）。他的「3 处」写的是「加上本报告后」的口径，
   在他落盘的那一刻成立；**我不判它为新的不实断言**，但它仍是一个**口径依赖时点**的计数
   —— 建议此类计数一律带提交号。

**新正文有没有引入新的不实描述**：我逐句核了 §1.3 新段、§3.2.1/§3.2.2 全部、§4.5 全部、§6.1 新段。
**未发现事实错误**。唯一「说得比兑现的强」的一句是 §3.2.1 的
「§4.2 只有一个面，可以穷举」—— 已按 N1 记为 Minor，**不判为不实**（它是设计意图的陈述，
方向成立，只是外延未封口）。§6.1 的 `Amended` 注写「**坏的只是数字**，
『全是 fixture、无一断言那条约束』经复核仍为真」—— 与原评审的独立结论一致，**未越界勘误**。

**与兄弟勘误的矛盾**：本笔只有一处勘误注（`:467`），**不存在同笔内兄弟勘误互相矛盾的情形**。

## 附加判点 4 — INV-4 未进 §8.2 验收表

**事实核实**（`awk '/^### 8\.2/,/^## 9/'`，未过滤）：§8.2 表恰 5 行 ——
INV-1、INV-2、INV-3a/b、INV-3c、§4.4。**INV-4 确实不在表内**，实施者的自报属实。

**但缺口比他自报的大一处**：`grep -n 'INV-' <spec>` 显示 §6.2 结尾（`:485`–`:490`）那份
「哪些不变式要有会变红的测试」的**枚举**也只提 INV-1 与 INV-2/INV-3，同样漏了 INV-4。
而那一段自己立了一条规则，逐字：

> 凡是本 spec 写下「不得 / 必须」的地方，都要能回答**「哪条测试会在它被违反时变红」**。
> 回答不出来的，就明写成「今天没有机制强制」，**不要写成「由评审保证」**。

INV-4 是本 spec 里语气最强的「只允许 / 不得」，**既没有 §8.2 条目、也没有「今天零强制」的自注**。
=> 这不是「补了更保险」的锦上添花，而是 **spec 对自己立的规则的一处内部不一致**。

**判定：Minor 缺口，建议后续轮次补，不必现在补。理由（判理由本身，不判自报）：**

1. **不阻塞**：§8.2 全表今天**一条测试都不存在**（该节自己逐字写明「本 spec 落盘时这五条测试
   一条都不存在，因为本轮无 `tests/` 授权」）。少一行的实际风险发生在 L5 实现落地那一刻，
   不在本轮收口这一刻。
2. **修它需要先修 N1**：INV-4 的达标判据必须引用 §4.2 的外延，而 §4.2 的外延正是 N1 指出的未封口处。
   现在补一行验收表，只会把一个外延未定的判据固化进表里，**顺序反了**。
3. **它不是「实施者自报所以放行」**：我是先独立跑 `awk`／`grep -n 'INV-'` 拿到 §8.2 与 `:485` 两处
   证据，再判的；而且我判出的缺口**比他自报的多一处（`:485` 那份枚举）**，
   说明这个判定不是接受他的框定。

**具体建议给后续轮次**（不由我代改）：先给 §4.2 加外延限定（N1），再向 §8.2 补一行，
达标判据可写成「L5 的删除路径只有一个删除点，其判据逐字实现 §4.2；存在一条测试，
构造一个满足 stale／看起来无主但**不匹配 §4.2 判据**的面，断言 L5 不删；删掉该断言测试变红」。
同时把 `:485`–`:490` 那份枚举补上 INV-4。

## 我没验的事

1. **本范围之外的一切**：`git diff fbeb6fd..978d825` 的另外 3 个文件
   （`progress.md`、`review-task1.md`、`task-1-report.md`，`+616 −11`）我**没评**，
   也没评 `978d825..HEAD`（`896d79c`）对台账与报告的 `+130 −4`。
   我读 `review-task1.md` 与 `task-1-report.md` 只为取判据与知道实施者声称了什么。
2. **M1 / M2 / M3 / M5 的缺陷是否仍然成立，我没有重验**。我只验了「它们没有被本 diff 碰过」
   （hunk 落点比对）。若控制器需要「这 4 条今天仍成立」的独立确认，那是另一次评审。
3. **`scan-2-design-input.md:152/:328` 的两处「22 处」我没有核真伪** —— 它们是 `safeUnlink`
   与 `src/` 检索面，与 I2 的对象（`writeOwnerTransferRecord` 在 `tests/`）不同。
4. **§6.1「21 处调用全部是 fixture、无一断言 §10 第 3 条那条约束」我没有逐处打开 21 个调用点复核。**
   原评审声称复核过并为真；我只验了计数与判别式。**这条承重措辞在我这里是「未独立复核」，不是「已确认」。**
5. **spec 里未被本 diff 触及的其余章节（§2、§3.3、§3.4、§5.1、§5.3、§7、§9–§13）我没有做完备性检查。**
   §5.1「十个固定名」「4→7→10」等数字我**没有重跑**。
6. **N1 的可构造性我只做了文本推理，没有在仓库里实际找到一个落在
   `.validation-runs/` 或 `worktrees/` 下的五段形临时文件。** 我的断言是
   「**spec 文本对这种文件给出矛盾指引**」，**不是**「仓库里今天存在这种文件」。
7. **全仓 stale「22」的搜索面**：`grep -rn '22 处' . --include='*.md'` ——
   只覆盖 `.md`、只覆盖字串「22 处」。**我未覆盖**非 `.md` 文件，也未覆盖
   「22个 / 22 calls / twenty-two」等其它写法。在这个搜索面内为「零残留」。
8. **渲染**：我判反引号嵌套已修是**按 Markdown 语义推的**，**没有真正渲染这份文档看过**。

## 预算

**超支，明写**：本轮任务给的是 12,000 token 预算，实际用量约 **34,000–38,000**（约 3×）。
主因：范围虽只有一个文件，但判据分散在 4 份文档（spec、原评审、报告、scan-2 引用的 3 份外部文档），
且「不接受自证」要求我把 5 条引文与 2 条计数全部独立重跑。**未静默超支。**
