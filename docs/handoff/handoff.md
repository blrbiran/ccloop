# ccloop Handoff — **L3 已发布；L5 输入盘点已完成；包 3（文档勘误）已开门合入 main；包 1 与包 2 授权在手、尚未开工**

---

# HANDOFF EXECUTIVE SUMMARY（下一位 agent 读这 9 行就能开工）

1. **一律自查，别信任何文字**：`git log --merges --format='%h %cd %s'` 最后一笔应是 `GATE-PKG3 PASSED`（门 `e42e062`，固定锚点）；**本会话从未 `git push`，远端落后** —— 跑 `git ls-remote origin refs/heads/main`。**本文不写死 HEAD、提交笔数与测试数**（提交本文就会改变前两者）。
2. **两份唯一可信进度源**（都已入库）：`.superpowers/sdd/2026-08-05-l5-input-scan/progress.md`（L5 输入清单 ＋ 四条人裁 ＋ 三个工作包）与 `.superpowers/sdd/2026-08-05-pkg3-doc-errata/progress.md`（包 3 全部裁决与教训）。**先读它们再决定从哪开始。**
3. **包 3 已完成并合入，不要重做**；**包 1、包 2 授权在手、一行代码都还没写**。
4. **下一步 = 包 1（写 L5 spec 本职）**。起点由**人裁 3** 定死为 `docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md` **§10 第 4 条**，**不从零 brainstorm**；委任状**同时授权 `retained` 与 `cleaned up`**，不许只想着删。
5. **spec 第一节必须写进 P1**：`releaseOwnerLease` 全仓只有 `stop()` 一个调用者 ⇒ **L5 的 GC 一旦自己回收租约，第 3 笔立刻升级为数据丢失 —— L5 的正常工作方式恰好会触发它。**
6. **包 2 已获准写 `tests/`**（人裁 4），用于给两条数据丢失路径补实跑注入；**边界在 L5 台账**（只含补测试，不含为了让测试变绿而改判据）。
7. **三条待办已议定方向，但人明令「先不改」** —— 不要自作主张去动：stderr 契约拆进包 1/包 2、`spec:2322` 维持不改、10 条 minor 并进包 1 的开工前扫描。详见下一节。
8. **⚠️ 落盘协议（写进每一份 brief）**：先 `Write` 只有小节标题的骨架并立刻落盘，之后每次 `Edit` 只填一节。**上一会话 12 名 agent 死了 6 名，全部发生在准备落盘时**，该协议两次救场。
9. **铁律不软化**：不接受实施者自证；**验证跑绝不过滤输出**（`grep` 与 `tail` 同罪）；**下「没有任何一处」之前先确认 grep 面覆盖你断言的范围** —— 这一条在包 3 一轮内栽了 **6 次**，控制器自己占 2 次。

---

# 【最新】2026-08-07：包 3 已开门合入 —— 本节取代下方**一切**状态描述

> 下方所有小节都停在更早的视角。**凡描述「现在该做什么 / 现在在哪一笔 / 还剩什么没做」的句子，一律以本节为准**；其余（陷阱、教训、铁律）照读。就地注解、不改原件。
>
> **具体作废紧随其后那节的这几句**：「三个工作包已授权、尚未开工」——**包 3 已完成并合入**；「建议先做 → 包 3 → 包 1 → 包 2」——**包 3 已做完，现在的起点是包 1**；「包 2 需要人单独授权写 `tests/`」——**授权已拿到**（人裁 4，见下）。

## 一句话

**包 3（纯文档勘误）三个任务全部实施、评审、修复、开门并合入 `main`（门 = `e42e062`），0 Critical；包 2 写 `tests/` 的授权已拿到；下一步是包 1（写 L5 spec 本职）。**

## 先跑这些，以输出为准（本文不写死 HEAD）

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --merges --format='%h %cd %s' --date=iso --reverse   # 最后一笔是 GATE-PKG3
git ls-remote origin refs/heads/main    # ⚠️ 本会话从未 push，远端落后
git status --short; git worktree list; git branch
export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm test -- --run"
```

## 两个唯一可信进度源（分别管两件事）

| 管什么 | 文件 |
|---|---|
| **L5 的输入清单、三条人裁、三个工作包** | `.superpowers/sdd/2026-08-05-l5-input-scan/progress.md` |
| **包 3 这一轮的全部裁决与教训** | `.superpowers/sdd/2026-08-05-pkg3-doc-errata/progress.md` |

两份台账**及其全部报告都已入库**（历史上它们被 `.superpowers/sdd/.gitignore` 的 `*` 忽略、只靠 `git add -f` 入库；本会话把上一轮的十份也补进去了，见 `4f3b790`）。

## ⚠️ 三件必须先读的事

1. **⚠️ 未 push。** 本会话从未跑过 `git push`，远端落后若干笔。**一律 `git ls-remote` 自查。**
2. **⚠️ 分支 `docs/pkg3-errata` 保留未删**（已完全并入 `main`，删除需单独授权）。
3. **⚠️ 人裁 4 已落**：**包 2 获准写 `tests/`**，用于给两条数据丢失路径补实跑注入。**边界写在 L5 台账里**：只含补测试，**不含为了让测试变绿而改判据**；变异仍走三步判据。

## 下一步：包 1（写 L5 spec 本职）

- **起点已由人裁 3 指定**：`docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md` **§10 第 4 条**。**不要从零 brainstorm。**
- **第一节必须写进 P1**：`releaseOwnerLease` 全仓只有 `stop()` 一个调用者 ⇒ **L5 的 GC 一旦自己回收租约，第 3 笔立刻升级为数据丢失；L5 的正常工作方式恰好会触发它。**
- **委任状同时授权 `retained` 与 `cleaned up`**，「保留」这一半九份报告一次没提，**设计时不许只想着删**。
- **一条耦合**：第 3 笔的修法必须与「保留即放宽」那条人裁**一起决策**；若为修它把 `writeBoundaryArtifacts` 搬进 span，那条人裁会重开。**不能分两轮。**

## 包 3 留下的三条待办 —— **方向已由人拍板，但人明令「先不改」**

> ⚠️ **2026-08-07 人裁 5**：人对下面三条的处置方向逐字答复「**这三条同意你的建议，但是先不改**」。
> **所以：方向已定，动手时机未到。下一位 agent 不要自作主张去改，也不要重新讨论方向。**
> 三条**都不阻塞包 1**。

| # | 事情 | 已定的方向（不要重开） | 为什么先不改 |
|---|---|---|---|
| 1 | `SweepOptions.stderr` 旁**没有任何「must not throw」契约注释**。那条「`appendEvent` 吞、回调不吞」的不对称论证，依据已从**结构性**（回调不做 I/O）退成**约定性**（落点是调用方注入的槽）。今天生产侧只有一个注入点（`src/cli.ts:234` 的 `console.error`），**三方独立确认今天无实际缺陷** | **拆两步塞进已有工作包，不单开一轮**：契约的规范半边写进**包 1 的 spec**（一句不变式：任何注入的 stderr sink 不得抛出）＋ 类型旁一行注释；**钉住它的测试留到包 2**（那里有 `tests/` 授权） | 理由是**时序**：今天安全只因**只有一个注入点**，而**包 1 要设计的 L5 GC 极可能引入第二个**。契约要**先于**第二个注入点落下。单开一轮的评审成本远高于改动本身 |
| 2 | `spec:2322` 该不该跟改（`--max-runs`「界的是付费调用」一族） | **维持「不改」，到此为止** | 实施者与 scoped 再评审员**两方独立深读上下文**后都判不改并各自给了可复核的理由（**目的性短语 vs 定义性断言**）；对面只是整分支评审的一条 Minor 分级。按 **Rule 7 不折中**，采信两方深读。再找第三名读者的期望收益很低 |
| 3 | **10 条 deferred minor**（9 条延后 ＋ 1 条新增） | **并进包 1 的开工前冲突扫描当输入清单，不单开清理轮** | 本仓库已证明这一手值钱：组 C 做了开工前扫描，**提前裁掉 7 条冲突、查证后清空 13 条**；组 A/B 没做，**各赔一轮返工**。边际成本几乎为零 |

*** 第 3 条里有一条建议在扫描中优先处理 ***：全仓另有**两个同形文件**（L1 的 spec 与 plan，文首同样带「修订总账 / 计数 / 全称限定」），**包 3 从未碰过它们，其自身是否已过期从未被验证**。**这正是刚刚产出包 3 那条必修 Important 的同一形状 —— 已经证明会咬人，不宜无限期延后。**

## 建议调用的 skills（接手包 1）

| skill | 何时 | 注意 |
|---|---|---|
| `superpowers:brainstorming` | **仅限包 1 的设计阶段** | **起点已由人裁 3 指定，不要从零开始。** 第一节必须写进 P1。**委任状同时授权 `retained` 与 `cleaned up`** |
| `superpowers:writing-plans` | 包 1 的 spec 定稿之后 | **不要用它去重做 L3 或包 3**，那两轮都已完成 |
| `superpowers:subagent-driven-development` | 包 1 / 包 2 的实施阶段 | 每任务「实施者 → 独立评审员 → 有 Critical/Important 进修复环 → scoped 再评审 → 台账记 complete」。**不接受实施者自证** |
| `superpowers:requesting-code-review` | 每任务一次 ＋ 每道门一次 | 提示词必写：不接受实施者自证、findings 带可构造场景、**锚点用符号名不用行号**、**不许用收窄的搜索面支撑全称否定** |
| `superpowers:verification-before-completion` | 声称「通过/完成」之前 | 复跑全套件 ＋ typecheck ＋ build，`rtk proxy`，**未过滤**，并核 vitest 首行 `RUN` 路径 |
| `superpowers:systematic-debugging` | 撞到不在 flake 名单内的失败 | 名单只有 (B) 与 (F) 两条 |
| `superpowers:using-git-worktrees` | 开新工作区之前 | 先 `git worktree add <path> -b <branch> HEAD` 显式指定基点；**建完立刻 `npm ci`**（陷阱 5）。**纯文档轮可不开 worktree** —— 包 3 就没开，理由在其台账 |
| `superpowers:finishing-a-development-branch` | 每道门之后 | **门必须是 merge、结论在主题行**；**合并与删分支都要人单独授权** |

## 包 3 换来的四条教训（比缺陷本身值钱，包 1/2 会原样再遇到）

1. *** 「用收窄的搜索面支撑全称否定」在包 3 一轮内出现 **6 次**，控制器自己占 2 次、一名再评审员占 1 次。 *** 这个形状在本仓库已**稳定复现**，不是个别 agent 的疏忽。
   **有效对策（已实证）**：把「建立一个可重数的计数」当作**独立派单**交给下游，并**要求给出判别式口径**。包 3 据此拿到 `15 标签 ＋ 10 交叉引用 ＋ 3 提及 = 28`（判别式是版式）——而控制器先前三次口径（10 / 12 / 28）**没有一次可重推**。
2. *** 一个假前提可以直接买单一条必修缺陷。 *** 任务 3 报告里「文件把 `(j)` 用了两次」为假，**而那正是「不修文首」的论证依据** —— 它直接导致整分支评审那条必修 Important 被漏掉。
3. *** 「验证跑绝不过滤输出」的代价第一次被当场量化 ***：任务 3 把一条自查输出摘要成一行，**而那条必修 finding 恰好就藏在被摘要掉的部分里**。
4. *** 勘误正文本身也是断言。 *** 任务 1 的勘误自己引入了一句新的不实描述，还与同一笔提交里自己写的兄弟勘误矛盾。**写每一句前先问：今天为真吗？我验过吗？与同 commit 其它句一致吗？**

## ⚠️ 落盘协议（强制写进每一份 brief）

**本会话 12 名 agent 中 6 名被流中断，全部发生在准备落盘时。**
**对策**：先 `Write` 一个**只有小节标题的骨架并立刻落盘**（在此之前不要做任何检索），之后**每次 `Edit` 只填一节（≤120 行）**，**结论一节最先写**。
**两次救场实证**：一名评审员的 454 行报告在写最后一节时被中断，**已落的十节一字未损**，resume 后一次 Edit 补完。

## 第八个环境陷阱（前七条见下方各节，全部仍然有效）

8. **`npx tsc` 会解析到另一份缓存工具链**，吐 `@types/node` 语法错。**改用 `./node_modules/.bin/tsc`** 后 0 行 exit 0。**不是回归。**

---

# 【已被上方 2026-08-07 那节取代，保留作历史】快速接手入口（读这 9 行，够开工）

> ⚠️ **2026-08-07：本节的「三个工作包已授权、尚未开工」与「建议先做包 3」均已作废** —— 包 3 已完成并合入 `main`（门 `e42e062`），包 2 的 `tests/` 授权也已拿到。其余照读。

1. **L3 完（三道门 `e5bf650`/`bafa6a6`/`81f3819` 全在 `main`），且远端已同步** —— push 由会话外完成，**一律 `git ls-remote origin refs/heads/main` 自查**，别信任何文字。分支与 worktree 都已清理。
2. **唯一可信进度源是新台账**：`.superpowers/sdd/2026-08-05-l5-input-scan/progress.md`。**任何情况下先读它**。L3 那份（`2026-08-02-…/progress.md`）仍是 L3 范围内的可信源，但它结尾的「STILL NOT DONE」三条**已有两条腐坏**。
3. **上一轮做的是 L5 输入盘点**：4 份扫描 ＋ 2 条独立复核 ＋ 3 条闭合 = 9 份报告，**全程只读，`src/` `tests/` `docs/` 一字未动 —— 没有任何东西需要回滚**。
4. **三条人裁已落台账**（债 2 复议 / 第 2 笔防遗忘勘误 / L5 从 `atomic-write-paths-design.md` §10 第 4 条起步），**不要重开**。
5. **三个工作包已授权、尚未开工**：包 1 写 L5 spec 本职；包 2 今天可达的三条数据丢失（债 2 → 第 4 笔 → 第 1 笔）；包 3 纯文档勘误（独立一轮，不进 L5）。逐条在台账。
6. **⚠️ 包 2 需要人单独授权写 `tests/`** —— 那两条数据丢失路径今天**只有静态论证、无实跑注入**，上一轮的只读铁律挡住了。没有注入实验，包 2 会退回「实施者自证」。
7. **不要重跑 brainstorm / writing-plans 去做 L3**（早已做完）；**L5 的 spec 也不要从零 brainstorm**（起点已由人裁指定）。
8. **本文与台账都不写死 HEAD、提交笔数、测试数** —— 提交本文这个动作本身就会改变前两者。**一律自查。**
9. **建议先做**：给本文以下各旧节做的那种就地注解已经做完，接着推荐的顺序是 → 包 3（小、独立、可当场收口）→ 包 1 → 包 2（开工前拿写 `tests/` 授权）。

---

# 【最新】2026-08-05 晚：L5 输入盘点完成 —— 本节取代下方**一切**状态描述（含紧随其后的「L3 完成」节）

> 下方所有小节都停在更早的视角。**凡描述「现在该做什么 / 现在在哪一笔 / 还剩什么没做」的句子，一律以本节为准**；其余（陷阱、教训、各组确立的不变量、约定与铁律）照读。就地注解、不改原件。
>
> **具体作废紧随其后那节的这几句**：「下一个动作是 push（需你授权）」——**push 已由会话外完成**；「本会话从未跑过 `git push`；远端落后本地若干笔」——**远端与本地已一致**；「L5 继承的东西（四项）」——**那是当时的视角，实际清单经本轮盘点已大幅改写，见下**。

## 一句话

**L3 已发布；L5 的输入盘点 ＋ 双车道独立复核 ＋ 三条阻塞项闭合全部完成，产出九份只读报告与三条人裁，三个工作包已授权但一行代码都还没写。**

## 先跑这些，以输出为准（本文不写死 HEAD）

```bash
cd /Users/biran/code/skills/loop/ccloop
git ls-remote origin refs/heads/main    # 远端已被会话外推进过四次，一律自查
git log --merges --format='%h %cd %s' --date=iso --reverse   # 最后三笔是 L3 三道门
git status --short; git worktree list; git branch
export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm test -- --run"
```

## 唯一可信进度源

**`.superpowers/sdd/2026-08-05-l5-input-scan/progress.md`** —— 本轮全部裁断、三条人裁、三个工作包、九份报告的承重结论、全部未完成项，逐条在内。**同目录九份报告都已落盘，不要重新推导。**

L3 范围内仍读 `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`，**但它结尾「STILL NOT DONE」三条里第 1 条（未 push）与第 2 条（组 C 分支/worktree 仍在）都已腐坏**，只剩第 3 条 L5。

## 本轮盘点最要紧的六条结论（细节全在台账，此处只给索引）

1. *** L5 的本职**有**设计输入 *** —— `docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md` **§10 第 4 条**（崩溃残留 tmp、清理归属未分配）是全仓唯一一条为 L5 本职预写的设计输入，**今天仍成立，且 L3 把三份 pending 改原子写后残留面已扩大、该文档从未被勘误**。四名扫描员集体漏掉它，由复核车道找出。
2. *** 第 1 笔（锁可被偷）的性质变了 *** —— 已扩到 **recovery 路径**，且面严格更宽。新查明的 **P-READ** 路径**不经过锁协议的缺陷**（补上活进程检查它照样存活），修法是一次牵动 L1/L2「读不许写」契约的**设计裁决**。
3. *** 一条对 L5 最危险的新前提（P1）*** —— **`releaseOwnerLease` 全仓只有 `stop()` 一个调用者**。含义：**L5 的本职 GC 一旦自己回收租约，第 3 笔立刻升级为数据丢失，不需要任何人碰 `stop()`、也不需要常驻形态落地。L5 的正常工作方式恰好会触发它。** 三份既有文件都没写过这条。
4. **GATE-C 有一半评审证据不存在** —— 三道门六份评审报告只落盘 2 份（全是 lane 2，GATE-A 连 lane 2 都没有）。GATE-C lane 1 的 3 条 Minor **证据已灭失、不可补救**（三条命令已证）。记 **GATE-C 名下的治理债，不进 L5 清单**；L5 输入清单的**分母裁定为 18**。
5. **第 3 笔今天「未发现可达路径」**（措辞按复核要求收紧），仅文档/纵深防御，等 §14.2 `watch`。**但它的修法必须与「保留即放宽」那条人裁一起决策** —— 不重开的理由完全依赖「span 外」这个结构。
6. **文档腐坏面比台账记的宽**：「一次数组 push」的最小勘误面是 **10 处**（不是 3 处，也不是 scan-C 建议的 6 处）；其中两处是**会被执行的变异指令**。

## 本轮新增的三条常设规则（都拿缺陷换来）

1. *** 报不出可重数的计数，就不要报数字。 *** 「条目」常是人工归并单位（§13 自己就在归并），没有命令能重数它。改为给出**可重数的行数**并附命令与输出，同时**声明那是搜索面、不是完备性证明**。
2. *** 下「没有任何一处」之前，先确认 grep 面覆盖你断言的范围。 *** 本轮抓到一次：某报告承认自己只 grep 了 spec/plan，却断言 `src/`/`tests/` 无一处，被一条命令证伪。**这是本仓库反复栽的形状。**
3. *** 转述他人结论时不许压缩掉主语。 *** 控制器把「一次并发 `stop()` 没有调用者」压成「触发没有调用者」，**凭空制造了一处不存在的「两份报告分歧」**，害一名 agent 专程去查。

## 第七个环境陷阱（前六条见下方各节，全部仍然有效）

7. **⚠️ 本会话存在一般性的流不稳定：9 名 agent 中 5 名被中断，全部发生在准备落盘时。**
   最初判断为「一次性吐整份大报告的巨型 tool call 被截断」，**后被一名在『准备写骨架』时中断的 agent 证伪** —— 更准确：**大 payload 只是放大它**。
   **有效对策（采用后交付率 100%，务必写进每一份 brief）**：**先 Write 一个只有小节标题的骨架并立刻落盘（在此之前不要再做任何检索），之后每次 Edit 只填一节（≤120 行），按把握度排序、最有把握的先写。**

## 铁律（三组 ＋ 本轮一致，不要软化）

- **不接受实施者自证**：每任务一个独立评审员；跨组的门派两个错开分工、且没参与过该组任何一条的评审员。
- **修完必须再评审**：本仓库**十五波修复十五次自带缺陷**，无一由作者自己发现。**本轮控制器自己也错了三次，三次都是被下游 agent 发现的**（详见台账「控制器本轮自曝错误 3 次」）。
- **验证跑绝不过滤输出**，`grep` 与 `tail` 同罪，连每文件 `✓` 清单也整段贴。
- **每个数字旁附一条能重推它的命令，并写下该命令当时的输出值。**
- **验证跑只有在 vitest 首行 `RUN` 路径正确时才算数**（subagent 的 bash cwd 会在调用间重置）。
- **变异必须走三步判据**（注入前绿 / 注入后红 / 还原后绿），每个单跑块必须显示具名测试的**非零**计数。
- **发现文档论据在今天代码上不成立 —— 原样上报，人裁 ＋ 就地勘误，不许实施者自改判据。**

## 建议调用的 skills

| skill | 何时 | 注意 |
|---|---|---|
| `superpowers:subagent-driven-development` | 包 1 / 包 2 的实施阶段 | **先读新台账再决定从哪开始。** 每任务「实施者 → 独立评审员 → 有 Critical/Important 进修复环 → scoped 再评审 → 台账记 complete」 |
| `superpowers:brainstorming` | **仅限包 1（L5 spec 的本职）** | **起点已由人裁指定为 `atomic-write-paths-design.md` §10 第 4 条，不要从零开始。** 第一节必须写进 P1。**委任状同时授权 `retained` 与 `cleaned up`，别只想着删。** |
| `superpowers:using-git-worktrees` | 开任何新工作区之前 | 先 `git worktree add <path> -b <branch> HEAD` 显式指定基点，再用 `EnterWorktree` 的 `path` 接管；**建完立刻 `npm ci`**（陷阱 5） |
| `superpowers:requesting-code-review` | 每任务一次 ＋ 每道门一次 | 提示词必写：不接受实施者自证、findings 带可构造场景、锚点用符号名不用行号 |
| `superpowers:verification-before-completion` | 声称「通过/完成」之前 | 复跑全套件 ＋ typecheck ＋ build，`rtk proxy`，**未过滤**，并核 `RUN` 路径 |
| `superpowers:systematic-debugging` | 撞到不在 flake 名单内的失败 | 名单只有 (B) 与 (F) 两条 |
| `superpowers:finishing-a-development-branch` | 每道门之后 | **门必须是 merge、结论在主题行**；删分支要单独授权 |
| ~~`superpowers:writing-plans`~~ | — | **L3 全程已做完，不要重跑。** |

**另**：任何新一组任务开工前，**先做一次计划冲突扫描**。组 C 这么做，提前裁掉 7 条冲突、查证后清空 13 条；组 A/B 没做，各赔一轮返工。本轮的 L5 输入盘点就是同一手法的放大版。

---

# 【已被上方 2026-08-05 晚那节取代，保留作历史】2026-08-05：L3 完成

> ⚠️ **本节的「下一个动作是 push，然后是 L5」已作废**：push 已由会话外完成（远端与本地一致）；L5 的继承清单经上方那轮盘点已大幅改写。其余（陷阱、教训、不变量、铁律）**全部仍然有效，请照读**。

> 下方所有小节（含「【最新】2026-08-03」那节）都停在更早的视角。**凡描述「现在该做什么 / 现在在哪一笔 / 还剩什么没做」的句子，一律以本节为准**；其余（陷阱、教训、各组确立的不变量、约定与铁律）照读。就地注解、不改原件。

## 一句话

**L3 的三组（A 债 1 / B 债 3 / C sweep 触发层）全部实施、评审、开门并合入 `main`，共 15 个任务、3 道门、0 Critical。下一个动作是 push（需你授权），然后是 L5。代码侧 L3 没有遗留工作。**

## 先跑这些，以输出为准（本文不写死 HEAD —— 提交本文就会改变它）

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --merges --format='%h %cd %s' --date=iso --reverse   # 最后三笔就是三道门
git ls-remote origin refs/heads/main    # 远端被本会话之外的东西推进过三次，一律自查
git status --short; git worktree list; git branch
export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm test -- --run"
```

**三道门**（都是 `--no-ff` merge，结论在**主题行**——验收 7 判据 (1) 只枚举 merge、只读主题行）：

| 门 | 组 | 说明 |
|---|---|---|
| `e5bf650` | A（§4 债 1，A1–A9） | 组 C 的 C1 要填的 `$A4` |
| `bafa6a6` | B（§5 债 3，B1–B2） | |
| `81f3819` | C（§6/§7/§8 sweep，C1–C4） | **L3 收官** |

另有两笔指向组 A 分支的合并（`787789e` / `94d7c0a`）**主题行明写不是门、不带结论**，别拿错。

## 唯一可信进度源

`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`

**任何情况下都先读它再决定从哪继续。** 三组的完整裁决、每一条人裁、全部 deferred minor 与 open 项都逐条在里面。同目录另有 15 份任务报告、3 份门的证据报告、组 C 的开工前扫描报告——**都已入库，不要重新推导**。

## 明确没做的三件事（不是遗漏，是边界）

1. **没有 push。** 本会话从未跑过 `git push`；远端落后本地若干笔。**接手时一律 `git ls-remote` 自查，不要相信任何文字描述。**
2. **没有进 L5。**
3. 三组的分支与 worktree **都已按授权清理**（各自删前都验过 `--is-ancestor` 且枚举过未入库产物）。

## L5 继承的东西（都已在 ledger 里逐条具名，这里只给索引）

- **`resumeLoop` 的并发裸读**（组 C 的 C4 用测试撞出来的）：五份 artifact 在同一个 `Promise.all` 里并发读，只有 `readOwnerRecord` 排在恢复之后。**已被独立构造复现并分级**：后果是**一次可重试的拒绝 + 一条把健康 run 报成故障的假告警**，**不是数据丢失**（实测下一次 sweep 直接 succeeded）。
- **组 B 的两条账**：`isLeaseStopError` 的「谓词加宽」半边**没有任何测试守着**（纯加宽今天行为惰性、全套件全绿）；B1 那条分支的 `writeRunState` **无 CAS**。两条今天都**不可达**，且组 C 落地后经重推**仍不可达**。**触发条件写死在 ledger 里：凡在循环内引入 `stop()` 调用点、或改动外层 catch 两条分支的顺序者，必须重跑对应论证，不许继承结论。**
- **spec 里还有两句**（`spec:692`、`spec:751`，及计划 `plan:1004` 的同段拷贝）以「一次数组 push」为**论据**——**结论今天仍成立**，失效的只是论据形状。
- 门上分诊过的 deferred minor 清单（组 C 十余条）。

## 五处「计划自身被实测证明为假」（**这是本项目最贵的教训**）

L3 全程有**五处**计划里的判据或观测在今天的代码上**根本不成立**。**五处的处置全是人裁 + 就地勘误，没有一次是实施者自己改判据。** 计划与 spec 里因此有十余处 `*Amended 2026-08-0x*`（`grep -nF 'Amended 2026-08-0'` 自查）。

**第五处是实施者自己先抓到的**（前四处都是评审员）：C3 的变异一钉不住测试 12c，因为 12c 按计划规定用**替身 `resume`**、message 是测试文件里的字面量，与生产字面量**没有数据通路**。它没有自己换变异，原样上报——**这是希望被复制的行为**。

## 六个会静默出错的环境陷阱（第 5、6 条是组 B/C 新撞出来的）

> 前四条见下方「四个会静默出错的环境陷阱」一节，**全部仍然有效**。这里只补新增的两条。

5. **新 worktree 没有自己的 `node_modules`。** Node 向上解析让 `npm test` 照跑，但 `tests/validation/evidence.test.ts` 的 `tsxBin` 用 `process.cwd()` 拼路径，**9 条 `run-scenario CLI` 会以 `spawn ENOENT` 假失败**——**不在允许 flake 名单内，看着像真回归**。开 worktree 后**立刻 `npm ci`**。
6. **⚠️ subagent 的 bash cwd 会在两次调用之间被重置。** 组 C 的实施者因此把一次全套件**跑到了主仓库**——全绿、看着完全正常、**却一条本分支的测试都没跑**。**规矩：每条要在 worktree 里跑的命令都把目录写死**（`rtk proxy "bash -c 'cd <worktree> && …'"`），**并以 vitest 输出首行的 `RUN` 路径作为验收**；首行不对一律作废重跑。交叉校验用算术：分支总数 − 主仓总数 = 本任务新增数。

## 组 C 新增的两条常设规则（都是拿缺陷换来的）

1. **改输出字面量时，正向断言会自己红，反向 `not.toContain` / `not.toEqual` 站点只会静默变空。** 必须在同一笔提交里回扫反向断言一族。**这是第十五次「修复波自带缺陷」的根因**，由实施者自己命名。
2. **验证跑只有在 vitest 首行 `RUN` 路径正确时才算数**（见陷阱 6）。

## 仍然成立的铁律（三组一致，不要软化）

- **不接受实施者自证**：每任务一个独立评审员，每道门两个错开分工、且**没参与过该组任何一条**的评审员。
- **修完必须再评审**：本仓库已**十五波修复十五次自带缺陷**，**没有一次是写它的人发现的**——包括一轮专门用来清「产物完整性」的修复轮，以及 GATE-C 那一波。
- **验证跑绝不过滤输出**，`grep` 与 `tail` 同罪，连每文件 `✓` 清单也整段贴。本轮有三次「用了管道随后自行作废重跑」，两次实施者自曝、一次评审员自曝。
- **每个数字旁附一条能重推它的命令，并写下该命令当时的输出值。** 本项目出过**凭记忆填 grep 输出**与**提交前先编造 commit hash** 各一次，都是自曝的。
- **变异必须走三步判据**（注入前绿 / 注入后红 / 还原后绿），**每个单跑块必须显示具名测试的非零计数**（全 skipped 是假绿），**还原必须用能真正命中你所用标记的命令来证明**（出过用 `grep MUTATION` 去证明一个 `EVIDENCE-ONLY` 标记的还原，那次「已还原」其实从未被证明）。
- **红不等于对**：每次红都要问「是不是因为**预期的机制**」。
- **控制器也会犯错，且必须记账**：本轮有两次——一次派了与计划文本冲突的修复却没先问人；一次把实施者明确请裁的问题**既没记 ledger 也没递给人**，被门上的评审员命名为「假结清发生在规格符合性上」。**两次都写进 ledger 了。**

## 建议调用的 skills（接手 L5 或 push）

| skill | 何时 | 注意 |
|---|---|---|
| `superpowers:subagent-driven-development` | 进 L5 的实施阶段 | **先读 ledger 再决定从哪开始。** 每任务「实施者 → 独立评审员 → 有 Critical/Important 进修复环 → scoped 再评审 → ledger 记 complete」 |
| `superpowers:using-git-worktrees` | 开任何新工作区之前 | 先 `git worktree add <path> -b <branch> HEAD` 显式指定基点，再用 `EnterWorktree` 的 `path` 接管；**建完立刻 `npm ci`**（陷阱 5） |
| `superpowers:requesting-code-review` | 每任务一次 + 每道门一次 | 提示词必写：不接受实施者自证、findings 带可构造场景、锚点用符号名不用行号 |
| `superpowers:verification-before-completion` | 声称「通过/完成」之前 | 复跑全套件 + typecheck + build，`rtk proxy`，**未过滤**，并核 `RUN` 路径 |
| `superpowers:systematic-debugging` | 撞到不在 flake 名单内的失败 | 名单只有 (B) 与 (F) 两条 |
| `superpowers:finishing-a-development-branch` | 每道门之后 | **门必须是 merge、结论在主题行**；删分支要单独授权 |
| ~~`superpowers:brainstorming`~~ / ~~`superpowers:writing-plans`~~ | — | **L3 全程都已做完，不要重跑。** |

**另建议：任何新一组任务开工前，先做一次「计划冲突扫描」。** 组 C 这么做了，**7 条冲突提前裁掉、13 条查证后清空**，其中包括一条被分诊给该组却没有任何任务认领的死代码、以及两处已腐坏的观测。组 A 与组 B 没做，各赔了一轮返工。

---

> ⚠️ **2026-08-03 更新：门开了。** 下方「快速接手入口」与「当前状态（2026-08-02 晚）」两节仍停在「门还关着」的视角。**具体作废这几句**：那两节里「两道工序仍然欠着」（A9 scoped 再评审 / GATE-A 整分支评审）——**两道都做完了**；「真正的 GATE-A 合并要另写一笔」——**已经写了**；「下一个动作是先补 A9 再评审」——**已完成**。其余（三个陷阱、各轮教训、组 A 确立的不变量、约定与铁律）**全部仍然有效，请照读**。就地注解、不改原件，与本仓库对 `run-registry-design.md` 的 `*Amended (x)*` 同一立场。
>
> **关于 hash 的读法**：本节引用的 `e5bf650` / `787789e` / `94d7c0a` / `ba8f8a0` 等都是**已固定的历史锚点**，可以放心引用。**当前 HEAD、领先远端几笔、测试总数一律自查**——提交本文这个动作本身就会改变前两者。

---

# 【已被 2026-08-05 那节取代，保留作历史】2026-08-03 收尾之后的真实状态

> ⚠️ **2026-08-05：本节已被文件顶部的「L3 完成」一节取代。** 具体作废这几句：「下一个动作是组 B（§5 债 3），一行代码都还没写」——**组 B 与组 C 都已完成、评审并开门**；「仍然没有 push。需人单独授权」——**push 仍未做，但远端已被会话外推进过三次，别照抄任何「未 push」的数字，一律 `git ls-remote` 自查**；标题里那句「本节取代下方一切状态描述」现在只对**下方**成立。其余（陷阱、教训、组 A 确立的不变量）**全部仍然有效，请照读**。

> 下方所有小节（含「2026-08-03：门已开」那节）都停在更早的视角。**凡描述「现在该做什么 / 现在在哪一笔 / 还剩什么没做」的句子，一律以本节为准**；其余（陷阱、教训、组 A 确立的不变量、约定与铁律）照读。就地注解、不改原件。

## 一句话

**GATE-A 早已通过（门 = merge `e5bf650`），组 A 关闭；此后又跑完一轮「补产物完整性 Minor」并按人的授权清理了组 A 的分支与 worktree。下一个动作是组 B（§5 债 3），一行代码都还没写。**

## 先跑这些，以输出为准（本文不写死 HEAD —— 提交本文就会改变它）

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --merges --format='%h %cd %s' --date=iso --reverse | tail -3   # 第三笔 e5bf650 是门
git ls-remote origin refs/heads/main    # 远端会被本会话之外的东西推进，实测过两次
git status --short; git worktree list; git branch
export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm test -- --run"
```

**门是 `e5bf650`**（主题行 `GATE-A PASSED: L3 debt 1 group A (A1-A9), two independent reviewers, 0 Critical`），**这就是组 C 的 C1 要填的 `$A4`**。另外两笔 merge 明写不是门。**门必须是 merge**：验收 7 判据 (1) 只枚举 merge、只打印 `%s`，普通提交它看不见 —— GATE-B 照此办理。

## 这一轮（补 Minor + 清理）做了什么，别重做

1. **ledger GATE-A open 项 6 已关闭**：Option-2 修复报告的三个单跑块补记了 `-t` 命令（重跑复现，标注为 2026-08-03 的重建、未回填时间），守卫脚本块补齐五行 `echo` 后与输出块 `diff` 退出 0。**下方第 35 行「另有两条 Minor 是有意留下的」作废。**
2. **open 项 1/2/3/4/5/7 一条没动，仍然全开。** 其中第 4 条是给组 B/C 的硬约束（见下）。
3. **组 A 的分支与 worktree 已删**：`feat/l3-debt1-transactional-continuation`（`20457e6`）、`gate/l3-debt1-group-a`（`bf7c031`）、`.claude/worktrees/l3-debt1-group-a`。删前两者都验过 `--is-ancestor main` exit 0，不丢提交。**worktree 下那 25 个未入库产物（16 份 `review-*.diff` + 9 份 `task-A*-brief.md`）已 `cp -n` 拷进主仓库 `.superpowers/sdd/2026-08-02-…/`（仍是 gitignored，20 → 45 个文件）。下方第 23 行与「明确没做的三件事」第 2 条作废。**
4. **仍然没有 push。** 需人单独授权。**接手时一律 `git ls-remote` 自查，不要相信任何文字描述。**

## 下一个动作：组 B（§5 债 3），执行顺序 B1 → B2 → GATE-B

**计划逐字在** `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` 的 `### Task B1` / `### Task B2` / `### GATE-B` 三节，**Steps、测试名、变异实验、陷阱清单全在里面，不要重新推导、不要重写计划**。brief = `## Global Constraints` 整节逐字 + 该任务整段逐字。

**开工前的三件事：**

1. **开隔离工作区**：`git worktree add .claude/worktrees/l3-debt3-heartbeat-stop -b feat/l3-debt3-heartbeat-stop HEAD`，**先显式指定基点再用 `EnterWorktree` 的 `path` 接管**（陷阱 1）。
2. **⚠️ B1 的第一步是一次具名的可达性分析，不是写代码。** `runExclusive` 唯一的生产调用点在 `persistBoundaryAnalysis` 内（计划 B1 陷阱清单实测 1 行），而 B1 要加的新分支恰恰是「`persistBoundaryAnalysis` 抛出后**不**走 `persistTerminalState`」。**这在字面上就可能构成 ledger open 项 4 说的「第二条不立刻走终态的路由」——若成立，「保留即放宽」那条人裁当场重新打开，必须上报给人，不许控制器自裁。** 逐环节验（拒绝发生在写之前 ⇒ 破坏性写根本没发生？还是界确实消失？），结论落 ledger，**不接受实施者一句话断言**。
3. **组 B 往 A8 的 options 上加键**：有**两个**单键类型 `RunLoopFromStateOptions`（`src/controller/runLoop.ts`）与 `ResumeLoopOptions`（`src/controller/resumeLoop.ts`），跨层的键**两边都加并在 `resumeLoop` 里转发**，**不要建第三个**。

**GATE-B**：派**没参与过 B1/B2 任何一条**的评审员做整分支评审（沿用组 A 的两条错开分工），至多一轮修复波 + 一次 scoped 再评审，ledger 落完整结论与 open 项，**合并只在人明确下指令时执行、结论写在 merge 的主题行**。

**组 C 的 brief 必须带这句**（ledger open 项 4 原话）：若给 `persistBoundaryAnalysis` 加了第二条不立刻走终态的路由，「保留即放宽」那条人裁就重新打开。

## 这一轮新增的教训（比缺陷本身值钱）

- **十三波变十四波，而且是在专门用来关「产物完整性缺陷」的那一轮里破的。** 补 Minor 这一轮走了「实施 → 评审 → 修 → 评审 → 修 → 再评审 → 修 → 再评审 Approved」，**三次评审各抓到一条上一次修复引入的新缺陷**（一句关于 `git rev-parse --short` 的假话；一个差了一行 `EXIT=0` 的「line for line」；一条被折行折到以 `;` 开头、照抄即语法错误的命令），**没有一条是实施者自己发现的**。「修完必须再评审」不是流程洁癖。
- **文档里的命令必须能被逐字节抽出来跑，而不是「看着对」。** 验证方式就是 `awk '/^export /' <file> > x.sh && bash x.sh`，不要重打一遍 —— 重打会掩盖折行缺陷。
- **控制器自己也会违铁律。** 本轮全套件第一跑加了 `| grep -v '^stderr |'`，`grep` 与 `tail` 同罪，已作废重跑。**验证跑绝不过滤，连每文件 `✓` 清单也整段贴。**

## 建议调用的 skills（接手组 B）

| skill | 何时 | 注意 |
|---|---|---|
| `superpowers:subagent-driven-development` | **立刻** | 组 B 的执行框架。**先读 ledger 再决定从哪开始。** 每任务「实施者 → 独立评审员 → 有 Critical/Important 进修复环 → scoped 再评审 → ledger 记 complete」，**不接受实施者自证**。人已定：**每任务 1 个评审员，GATE-B 派 2 个错开分工** |
| `superpowers:using-git-worktrees` | 开组 B 之前 | 见上「开工前第 1 件事」 |
| `superpowers:requesting-code-review` | 每任务一次 + GATE-B 一次 | 提示词必写：不接受实施者自证、findings 带可构造场景、锚点用符号名不用行号 |
| `superpowers:verification-before-completion` | 声称「通过/完成」之前 | 复跑全套件 + typecheck + build，`rtk proxy`，**未过滤** |
| `superpowers:systematic-debugging` | 撞到不在 flake 名单内的失败 | 名单只有 (B) 与 (F) 两条 |
| `superpowers:finishing-a-development-branch` | GATE-B 之后 | 门必须是 merge、结论在主题行；删分支要单独授权 |
| ~~`superpowers:brainstorming`~~ / ~~`superpowers:writing-plans`~~ | — | **L3 全程都已做完，不要重跑。** |

---

## 2026-08-03：门已开（本节已被上方取代，保留作历史）

**先跑这些，以输出为准：**

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --merges --format='%h %cd %s' --date=iso --reverse | tail -3   # 第三笔才是门
git ls-remote origin refs/heads/main                                   # 远端真实状态，见下方警告
git status --short && git worktree list
export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm test -- --run"
```

1. **GATE-A 通过，门是 `e5bf650`**，主题行 `GATE-A PASSED: L3 debt 1 group A (A1-A9), two independent reviewers, 0 Critical`。**这就是计划 §15 验收 7 判据 (1) 定位到的那一笔，也是组 C 的 C1 要填的 `$A4`。** 另外两笔指向同一分支的合并（`787789e` / `94d7c0a`）**都明写不是门、都不带结论**——别拿错。
2. **门为什么必须是 merge**：判据 (1) 逐字是 `git log --merges --format='%h %cd %s'`——**只枚举 merge、只打印主题行**。一笔带结论的普通提交它根本看不见。这条是 GATE-A 评审当场发现的，别再退回「写一笔 docs 提交记结论」的方案。
3. **门的完整结论、证据与遗留全在 ledger 里**：`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md` 末尾那一大段 `*** GATE-A: PASSED ***`。**七条 open 项逐条具名**，其中第 4 条是给组 B/C 的硬约束：**若组 B 或 C 给 `persistBoundaryAnalysis` 加了第二条不立刻走终态的路由，那条「保留即放宽」的人裁就重新打开**——组 C 的 brief 必须带上这句。
4. **门前落了两波修复 + 一次生产改动**，全部在 `main` 上、全部经独立评审并各有一次再评审。生产改动是 `reconciliation_published_winner_replaced` 事件（把一次静默的记录销毁变响亮），**谓词 `transferRepresentsPublishedWinner` 一个字节没动**（人裁：保留即放宽），函数体 sha256 `b1d03f92…` 在门上复验过。
5. **分支与 worktree 仍在，删除仍需单独授权**：`feat/l3-debt1-transactional-continuation`（`20457e6`）、`.claude/worktrees/l3-debt1-group-a`、以及门分支 `gate/l3-debt1-group-a`（`bf7c031`，已并入 `main`）。**清理前先枚举 worktree 下会被一并销毁的未入库产物**（brief / report / review diff）——ledger 与 `task-*-report.md` 是 tracked 的，review `.diff` 不是。
6. **下一步是组 B（§5 债 3：`heartbeat.stop()` 释放窗口）。** 前置硬门已满足。组 B 往 A8 建的 `RunLoopFromStateOptions` 上加键——**注意 A8 实际建了两个单键 options 类型**（`ResumeLoopOptions` 与 `RunLoopFromStateOptions`），跨层的键要两边都加并在 `resumeLoop` 里转发，**不要新建第三个**。
7. **门上验证**：29 files / 484 tests exit 0；typecheck 0；build 0；三守卫 8 / 单点 / `src/registry/` 空；两条允许的 flake 都没出现。

> ⚠️ **推送：本会话中途远端又被推了一次，而 push 不是本会话做的。** 实测 `git reflog show refs/remotes/origin/main` 有 `2026-08-03 09:35:55 update by push`，落点是 `9fe1f02`——**这意味着 Option 2 那笔连同它当时还没修的一条缺陷已经发布，而修复轮四笔当时还没发布。** 本会话从未执行 `git push`。**接手时一律用 `git ls-remote origin refs/heads/main` 自查，不要相信任何文字描述，也不要把本地提交当成可以随手回滚的私有状态。**

### 明确没做的三件事（不是遗漏，是边界）

1. **没有 push。** 由人手动做。
2. **没有删任何分支或 worktree。** 需单独授权。
3. **没有进组 B。**

另有**两条 Minor 是有意留下的**，不是漏的：Option 2 修复报告的三个单跑块没记 `-t` 命令（再评审员自己把三次全重跑复现过，实质由独立方确立，只是产物没记），以及一处守卫脚本的命令块与输出块对不上（四个值都复验正确）。**都写在 ledger open 项第 6 条。** 若你认为门不该带着产物完整性问题开，补一轮清掉即可，不影响任何代码结论。

### 本轮产物索引（都在仓库里，不要重新推导）

| 产物 | 路径 |
|---|---|
| **唯一可信进度源 + GATE-A 完整结论与七条 open 项** | `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`（末尾 `*** GATE-A: PASSED ***` 那段） |
| 九个任务各自的完整报告 | 同目录 `task-A1..A9-report.md`、`task-errata-report.md` |
| GATE-A 两波修复的报告 | 同目录 `gate-a-fix-wave-report.md` |
| Option 2（生产改动）的报告与修复轮 | 同目录 `gate-a-option2-report.md` |
| 评审包（未入库，`git worktree remove` 会连带删掉） | 同目录 `review-*.diff`、`gate-a-package-*.diff` |
| 计划（含 (a)–(g) 七处就地勘误） | `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` |
| spec（§4.6 有一句已知过期，计划裁定三覆盖它） | `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` |
| 打包脚本（**不在本仓库**） | `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/review-package` |

### 建议调用的 skills（接手组 B 时）

| skill | 何时 | 注意 |
|---|---|---|
| `superpowers:subagent-driven-development` | **立刻** | 组 B 的执行框架。**先读 ledger 再决定从哪开始。** 每任务「实施者 → 独立评审员 → 有 Critical/Important 进修复环 → scoped 再评审 → ledger 记 complete」，**不接受实施者自证** |
| `superpowers:using-git-worktrees` | 开组 B 之前 | ⚠️ `EnterWorktree` 默认从 `origin/<默认分支>` 开分支且不报错。先 `git worktree add <path> -b <branch> HEAD` 显式指定基点，再用 `EnterWorktree` 的 `path` 接管 |
| `superpowers:requesting-code-review` | 每任务一次 + GATE-B 一次 | 提示词必写：不接受实施者自证、findings 带可构造场景、锚点用符号名不用行号。**GATE-B 的评审员必须没参与过组 B 任何一条** |
| `superpowers:verification-before-completion` | 声称「通过/完成」之前 | 复跑全套件 + typecheck + build 并贴**未过滤**输出（`rtk proxy`），**连每文件 `✓` 清单一起贴**——本轮有一次因「为了宽度省掉 60 行清单」被评审员记为违规 |
| `superpowers:systematic-debugging` | 撞到不在 flake 名单内的失败 | 名单只有 (B) 与 (F) 两条 |
| `superpowers:finishing-a-development-branch` | GATE-B 之后 | ⚠️ **门必须是 merge、结论必须在主题行**（见上方第 2 条），删分支要单独授权 |
| ~~`superpowers:brainstorming`~~ / ~~`superpowers:writing-plans`~~ | — | **L3 全程都已做完，不要重跑。** |

### 本轮最值钱的四条教训（组 B 会原样再遇到）

1. **验收判据要照着它的命令读，不要照着它的意思读。** §15 验收 7 写的是「合并信息里带评审结论」，读起来像「任何带结论的提交」；它的命令 `git log --merges --format='%h %cd %s'` 只枚举 merge、只打印主题行。**差别直到 GATE-A 评审员逐字读命令才暴露**，而当时门的写法已经定了。
2. **评审员给的「延后」处置，和评审员给的「发现」，是两件可信度不同的事。** 本轮那条 Important，发现是对的，**处置理由是错的**——它把触发写成崩溃竞态，实测是每一次成功续跑。核验推翻的是前提，不是结论。
3. **「最直觉的修法」要先跑再选。** 删掉那个合取项看起来是一行最小改动，实测是 permit-more，还会把一份损坏文件修复成「可续跑」。**设计分析花的那一轮，省掉了一次会被评审打回的实施轮。**
4. **修复波自带缺陷的规律没有被打破，现在是十三波。** 本轮两波修复各自带缺陷，都是**再评审**抓出来的，没有一次是实施者自己发现的。**「修完必须再评审」不是流程洁癖。**

---

> ⚠️ **本文件从下方「以下为 2026-08-01 的原文」那条分隔线往下的所有小节，都停在 2026-08-01 那一天的视角。** 它们没有被删除，因为其中的教训仍然有效；但凡是描述「现在该做什么」「现在在哪一笔」的句子，**一律以本节为准**。就地注解、不改原件，与本仓库对 `run-registry-design.md` 的 `*Amended (x)*` 与 `9e554ce` 提交信息勘误同一立场。

---

## 快速接手入口（先读这 8 行，够开工）

1. **L3 的 spec 与实施计划都已定稿。不要重新 brainstorm、不要重写 spec、不要重写计划。**
2. **先读 ledger**：`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`。**它是唯一可信的进度来源，任何情况下都先读它再决定从哪继续。**
3. **组 A 的 A1–A9 九个任务全部实施完成、各自通过独立评审，并已用 `--no-ff` 合入 `main`。** 分支 `feat/l3-debt1-transactional-continuation` 与 worktree `.claude/worktrees/l3-debt1-group-a` **都保留着**，GATE-A 的整分支 diff 还要用它们。
4. **⚠️ 那笔合并不是 GATE-A。** 提交信息里明写 `*** THIS IS NOT GATE-A. ***` 且**刻意不带任何评审结论**——计划 §15 验收 7 正是用「合并信息里有没有评审结论」来定位任务组的门。真正的 GATE-A 合并要**另写一笔并带上结论**。目前 `main` 上有**两笔**指向同一分支的合并（`787789e` 组 A 前四任务、`94d7c0a` 后五任务），**两笔都明写不是门**。
5. **两道工序仍然欠着**：(a) A9 改名修复轮的 scoped 再评审没跑；(b) GATE-A 整分支评审没做，评审员必须**没参与过 A1–A9 任何一条**、用最强模型，拿 ledger 里那份 deferred-minor 清单做分诊输入。**先做 (a) 再做 (b)。**
6. **执行方式**：`superpowers:subagent-driven-development`，每任务「实施者 → 独立评审员 → 有 Critical/Important 则进修复环 → scoped 再评审 → ledger 记 complete」。**不接受实施者自证。**
7. **三个会静默出错的陷阱**（第三个是本轮实测撞出来的新的）：`EnterWorktree` 默认从 `origin/<默认分支>` 开分支；全局 `rtk` hook 会过滤 vitest **与 `git diff`** 的输出；`-t 'describe > it'` 匹配不到任何测试却 exit 0。详见下方专节。
8. **状态一律用命令自查。** 本文不写死 HEAD、提交笔数与测试数——提交本文这个动作本身就会改变前两者。

---

## 当前状态（2026-08-02 晚）—— 取代下方一切更早的状态描述

### 一句话

**组 A（债 1）的九个任务全部实施并各自通过独立评审，已合入 `main`（那笔明写不是 GATE-A、不带评审结论）；GATE-A 整分支评审与 A9 修复轮的 scoped 再评审都还没做。**

> ⚠️ **关于 push：不要假设「本地提交就只是本地的」。** 本轮实测：合并落地约四分钟后，`refs/remotes/origin/main` 出现了一条 `update by push`，`git ls-remote` 确认远端已有该合并——**而这个 push 不是本会话执行的**（本会话没有跑过任何 `git push`）。合理推断是这台机器上的某个自动化或人手动推的。**接手时先用 `git ls-remote origin refs/heads/main` 与 `git reflog show refs/remotes/origin/main --date=iso` 自查真实推送状态，不要照抄任何「未 push」的描述**，也不要据此认为本地提交是可以随手回滚的私有状态。

### 先跑这些，以输出为准（不要相信本文任何数字）

```bash
cd /Users/biran/code/skills/loop/ccloop      # 组 A 已合入，主仓库就够用了

git log --oneline -8                  # 只用来看形势，不要假设 HEAD 是哪一笔
git log --merges --format='%h %cd %s' --date=iso --reverse   # 两笔组 A 合并都明写不是门
git worktree list                     # 主仓库 + .claude/worktrees/l3-debt1-group-a（都还在）
git ls-remote origin refs/heads/main  # 远端真实状态；不要相信「未 push」的旧描述
git status --short                    # 两个工作区都应当干净

# GATE-A 的整分支范围（hash 锚点已固定，可以引用）：
#   ba8f8a0 = 计划提交，也是分支的基点；分支尖端含 A1–A9 全部九个任务
git diff --stat ba8f8a0..feat/l3-debt1-transactional-continuation

export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy "npm test -- --run"         # 见下方 rtk 陷阱：不用 rtk proxy 会被静默过滤
npm run typecheck; echo "typecheck_exit=$?"
npm run build;     echo "build_exit=$?"

# 三条守卫，任何任务结束时都必须成立
grep -cF 'return { ok: false' src/controller/resumeLoop.ts   # 必须是 8
grep -rnF 'currentOwnerEpoch + 1' src/                        # 必须单点命中
git diff --name-only ba8f8a0..feat/l3-debt1-transactional-continuation -- src/registry/   # 必须为空
```

**测试数会随任何新增测试腐坏。** 本会话轨迹：446（计划期基线）→ 460（组 A 前四任务合入 main 后）→ 463（A5）→ 473（A6）→ 477（A7）→ 481（A8）→ 482（A9）。**以你自己那次执行的输出为准，不要引用这里任何一个数。**

### 组 A 九个任务的落点（按任务，不写 hash——用 `git log --oneline ba8f8a0..feat/l3-debt1-transactional-continuation` 自查）

| 提交主题（可用它在 `git log` 里定位） | 任务 |
|---|---|
| marker 与两份既有 pending 改原子写 | A1（已在 `main`） |
| reconciliation 成为转移事务的第三个文件 | A2（已在 `main`） |
| finalize 改为 marker 驱动、fail-closed | A3（已在 `main`） |
| 拒绝 `finalizeOrder` 非完整全排列的 v2 marker | A3 修复轮（已在 `main`） |
| 草稿组装点、`newOwnerEpoch` 由事务内部填、赢家不再二次写 | A4（已在 `main`） |
| 让 `boundary-analysis.json` 缺席成为测试 1 的决定性断言 | A4 修复轮（已在 `main`） |
| pin every crash gap of the three-file transaction … | A5 |
| distinguish a torn publish from an absent one, rename test 2 … | A5 修复轮 1 |
| correct the criterion-B erratum's headline … | A5 修复轮 2 |
| give each of the eight eligibility criteria its own killing mutation | A6 |
| correct the -t command form's silent zero-match … | 计划勘误（人裁） |
| fail closed on unreadable transfer artifacts … | A7 |
| cover the corrupt owner-transfer read and assert the abandonment's detail | A7 修复轮 1 |
| thread an optional onReconciliationWriteAbandoned callback … | A8 |
| assert the layer-4 fixture preconditions … | A8 修复轮 1 |
| pin the finalize order re-ruling with two production-only mutations | A9 |
| name test 6e after what it pins … | A9 修复轮 1 |

每个任务另有一笔 `docs(sdd): land task A<n>'s ledger entries and report`，把 ledger 与该任务的完整报告入库（报告目录被 gitignore，用 `git add -f`）。

### 下一个动作

**0. 先认清：合并已经发生，但门还没开。** A1–A9 全部在 `main` 上，两笔合并都明写不是 GATE-A、都不带评审结论。所以「代码已在 main」**不等于**「已通过组 A 的把关」。

**1. 先补 A9 改名修复轮欠着的 scoped 再评审。** A9 的实施与首轮评审已完成（评审结论 **Approved，零 Critical**），随后人裁要求改测试名，改名提交已落地，**但那一轮的 scoped 再评审还没跑**。要验的是：改名后两次变异重跑的证据是否齐全且红在新名字上；测试注释里那处「(a) 钉的是保护判定被求值」被改成「钉的是其前置条件」后表述是否准确；计划里新加的那条 `### Task A9` 勘误是否只动了 A9 一节、原文是否保留。

**2. 然后才是 GATE-A。** 整分支 review package 用 `scripts/review-package <plan> ba8f8a0 feat/l3-debt1-transactional-continuation`——**不要再用 `git merge-base main HEAD`**，分支已合入，那条命令现在算不出组 A 的范围了。派一个**没参与过 A1–A9 任何一条**的评审员、用最强模型，并把 ledger 里那份 deferred-minor 清单作为分诊输入。之后至多一轮修复波 + 一次 scoped 再评审，残余按 breaker 规则裁定或上报。

**3. GATE-A 通过后，门本身要另写一笔带评审结论的提交。** 代码已经在 `main` 上了，所以那一笔不再是「合并」——可以是一笔记录评审结论的 `docs(sdd)` 提交，或（若 GATE-A 产生修复波）是修复波的合并。**关键是计划 §15 验收 7 要能靠「带评审结论」定位到它**，而现有两笔合并都刻意不带。

**4. 停在 GATE-A，不进组 B。** 组 B 的前置硬门是 GATE-A 已完成；组 C 的 C1 第一步就要能填出组 A 的门 hash，填不出说明顺序被违反。**删分支、删 worktree 都要单独授权**（GATE-A 的整分支 diff 依赖它们）。

### ⚠️ 四个会静默出错的环境陷阱（都是实测撞出来的）

> **第 4 条是 2026-08-03 补 Minor 那一轮新撞出来的**，与前三条同等硬。

1. **`EnterWorktree` 默认 `baseRef: fresh`，从 `origin/<默认分支>` 开分支，不是从你的 HEAD**，而且不报错——会让你照着过期的 spec 干活。解法：先 `git worktree add <path> -b <branch> HEAD` 显式指定基点，再用 `EnterWorktree` 的 `path` 参数接管。
2. **全局 `rtk` shell hook 会自动过滤 / 摘要输出**，与本仓库「验证跑绝不过滤输出」的铁律直接冲突。它不只影响 vitest：**`git diff` / `git diff --name-only` 也会被摘要成 `Changes:` 之类的空壳**，本轮控制器就因此把「空 diff」误读过一次。绕过方式：`rtk proxy "<命令>"`（它不接受以环境变量赋值开头的引号串，要先 `export`）。另注意 `mv` 被 alias 成交互式，脚本里要用 `command mv -f`。
3. **`-t 'describe > it'` 在 vitest 2.1.9 下匹配不到任何测试，输出是 `Tests N skipped (N)` ＋ exit 0——看上去就是绿的。** 计划 §10 那条全文适用的「变异必须红」判据，逐字照做正好得到这个形状。**已就地勘误为 `Amended 2026-08-02 (b)`**，并新增了真正堵洞的那条硬要求：**每个单跑块必须显示具名测试的非零计数**（注入前 `1 passed | N skipped`、注入后 `1 failed | N skipped`），全 skipped 不算绿——因为换命令形状挡不住「测试名打错」。已核实 A1–A5 实际用的都是裸 `it` 名，**已落地的变异证据没有被污染**。
4. **`rtk proxy` 只吃*单条*命令；给它复合命令会静默走形。** 实测：`rtk proxy "git rev-parse --short X && git log -1 X"` → `fatal: Needed a single revision`、**exit 128**，因为 `&&` 与其后的一切都被当成又一个 revision 传给了 `git`——本轮据此一度把一个**活着的**锚点误判为失效锚点。同型的第二种走形更阴：**把一条命令按 80 列折行写进文档，照抄会烂在两个不同的地方**——以 `;` 开头的续行是 bash 语法错误（exit 2），而折在双引号字符串内部会让 `npx vitest run …` 变成 `DEV` watch 模式、`run` 降格成过滤器，输出 `No test files found`。**规矩：一条 `rtk proxy` 一条命令；要复合就 `bash -c` 或写成脚本文件；文档里的命令宁可超宽也不折行，并写明「这是一行」。**

### 本轮产生的人裁（不要重开）

1. **A5 的测试 2 改名** —— 间隙 14–17 处三份文件都已发布且一致，`resumeLoop` 接受是正确的，在那里断言拒绝等于把 bug 钉成规范。原 brief 强制的名字只覆盖 17 个里的 13 个。
2. **计划里判据 B 的前提为假，就地加勘误** —— 「整条删掉的变异任何单转移场景都能杀」是错的：单转移下 `reconciliation-record.json` 缺席先抛，进门前就拒了，判据 B 从不成立、因而从不决定结果。
3. **判据 A 的同类过强措辞一并就地注记** —— 它比 B 那条弱（句子自带作用域，在该子集内属实），属「不完整」而非「假」，但同样不能被读成「不可达 ⇒ 可删」。
4. **§10 的 `-t` 缺陷就地注记，并加反假绿护栏**（见上条陷阱 3）。
5. **A9 的测试 6e 改名** —— brief 强制的名字首分句没有断言支撑，而且测试自己的注释正确地说明它今天为假（残余 TOCTOU 未关闭，输家确实会写下降级版本）。新名字按「实际钉住的两件事」重写。
6. **成本档位**：A8 的评审员降 sonnet，A9 保持最强模型。

### 控制器自裁（已记 ledger，未打扰人，供 GATE-A 复核）

**同一条 Rule 7 裁定应用了三次**：brief 的字面步骤与 Global Constraints 那条「加一个成分和加它的覆盖是一件事」冲突时，**取更一般的那条**——补覆盖是**满足**计划而非违背。三次分别是 A7 补第四条测试（腐坏的 `owner-transfer.json` 那条活分支）、A8 加 `resumeLoop` 转发的覆盖、A8 补第二调用点。三次理由一致、逐条记录在案。

### 计划文件已被就地勘误的四处（`*Amended 2026-08-02 (x)*`，用 `grep -nF 'Amended 2026-08-02'` 自查）

- **(a)** `### Task A5` 判据 B 的前提为假（三处联动：判据 B 那条 bullet、Step 5 第 3 项、以及「哪两条走完整三步击杀」那行的连带更正）
- **(b)** Global Constraints §10 的 `-t` 形状 + 反假绿护栏
- **(c)** `### Task A5` 判据 A 的同类过强措辞
- **(d)** `### Task A9` Step 2 强制的测试名

**A7/A8/A9 的 brief 已按勘误后的计划重建过**（每份 = `## Global Constraints` 整节逐字 + 该任务 `### Task A<n>` 整段逐字，不用行号）。**brief 与 review 的 diff 都不入库**，`git worktree remove` 会连带删掉；`progress.md` 与 `task-*-report.md` 是 tracked 的。

### 组 A 已确立、后续任务不要破坏的东西

- `cleanupOwnerTransferStagingWithoutMarker` = **10 个逐个具名的 `safeUnlink`**，六处联动
- `finalizePendingOwnerTransfer` **严格只按 `marker.finalizeOrder` 分流**，不按 `version` 硬编码
- `isValidFinalizeOrder` 在**任何读/写/删之前**校验完整全排列（顺序自由、无重复、无未知名）
- 四个并列**不继承**的具名错误类
- `writeJsonFileViaFixedTemp` 刻意不与 `writeJsonFileAtomically` / `buildAtomicTempPath` 合并
- **A7 产出的两个判别式联合** `PersistedTransferArtifactsRead` / `ReconciliationWriteDecision`（组 C 的测试 12d 依赖，**目前都未 export**）
- **A8 产出的 `RunLoopFromStateOptions` 是一个可选参数*对象*** —— 组 B 的 B2 与组 C 的 C1 会往**同一个**类型上加键，不要另建同名类型、不要塌成位置参数
- 三条守卫：`return { ok: false` 计数 = **8**；`currentOwnerEpoch + 1` 单点命中；`src/registry/` 零改动

### 约三十条待 GATE-A 分诊的 Minor

**全部逐条写在 ledger 里，不要重新发现它们。** GATE-A 的整分支评审要拿那份清单做分诊输入，判哪些必须在合并前修。其中两条值得单独留意：

- **A8 在 `runLoopFromState` 的非超时 `execution === null` 调用点上转发的那个回调参数，已被独立验证为「今天可证明不可达」**（五个环节逐链验证：字面 `undefined` → 输入无关的空证据 → 恒为 `no_progress` → `reconciliationRecord: undefined` → 整个 abandon 块被跳过）。保留它符合 brief §9，删掉它则违反 §9、需要人裁。**是否长期携带一个可证明为死的参数，是 GATE-A 的合并时机判断。**
- **A9 的变异一是计划里唯一「明令不许继承结论」的那条风险，已在 A9 内结清且验明是因正确机制而红。** 不要重新论证它。

### 本轮最值钱的四条教训

- **控制器自己会成为错误的来源。** 本轮有一条永久勘误的标题句写错了机制（把「判据 B 从不成立」写成「从未被求值」），源头是控制器把第一位评审员的措辞未经校准就传进了提问与派单。是再评审员抓出来的。**别把未经独立验证的前提递给人裁**——上报之前先派一次核验。
- **「不可能」这种主张必须逐链验证，不能采信也不能否认。** A8 的实施者报「要求的覆盖不可能存在」，控制器没有直接上报，而是派了一次五环节的源码核验，结论 PROVEN；核验者还顺带发现既有套件里早就有一条测试在钉那条分支，这让原本要递给人的三选一直接塌缩掉了。
- **红不等于对。** A9 的判据是「这个红是不是因为**对的理由**红的」——因错误理由而红等于把风险「假结清」，比留着不结更糟。评审员为此 grep 了全部调用点，确认那个 `failed:ENOENT` 单元素只能是那次保护性读。
- **可选回调的覆盖极易造假。** 传个 spy 再断言「被调用了」，只有在「这个 spy 真的可能不被调用」时才证明了接线；一条穿透四层的端到端测试也不能证明四层各自正确——它可能因四个不同原因中的任何一个而红，于是三层坏掉可以躲在一层好的后面。**要逐层各做一次「只让这一层把参数丢在地上」的变异。**

### 建议调用的 skills

| skill | 何时 | 注意 |
|---|---|---|
| `superpowers:subagent-driven-development` | **立刻** | 本轮的执行框架。先读 ledger 再决定从哪继续；每任务一个实施者 + 一个独立评审员；修复环最多 5 轮，1–3 轮 resume 原实施者、4–5 轮换更强模型的新实施者 |
| `superpowers:requesting-code-review` | **GATE-A 整分支一次** | 提示词必写：不接受实施者自证、findings 带可构造场景、锚点用符号名不用行号。GATE-A 的评审员必须**没参与过 A1–A9 任何一条** |
| `superpowers:verification-before-completion` | 声称「通过/完成」之前 | 复跑全套件 + typecheck + build 并贴**未过滤**输出（记得 `rtk proxy`） |
| `superpowers:systematic-debugging` | 撞到不在 flake 名单内的失败时 | 名单只有 (B) 与 (F) 两条 |
| `superpowers:finishing-a-development-branch` | GATE-A 之后 | 合并要带评审结论；删分支要单独授权 |
| ~~`superpowers:brainstorming`~~ / ~~`superpowers:writing-plans`~~ | — | **都已做完，不要重跑。** |

---

> 以下为 2026-08-01 的原文，**状态描述已过期，教训仍然有效**。
> 更新于 2026-08-01。接手前先用 Git / 文件系统核对每一条状态声明再动手。
> **本文不写死 commit hash、提交笔数或 HEAD**：提交本文即会改变 HEAD、push 会改变待推笔数。历史 commit hash（如 `07180a7`、各修复波与那笔 merge 的 hash）是**已固定的过去锚点**，可以引用；**当前状态一律用命令自查**，见「如何定位当前状态」。

## Executive Summary（下一位 agent 只读这 8 行就能开工）

1. **L3 spec 已过两波修复、六个独立评审员，代码一行未动。** 路径 `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`。**不要重新 brainstorm，不要重写 spec。**
2. **下一个动作是第三波修复**，清单在下一节逐条列好（12 条阻塞 + 一批记账类），**不需要再派评审去重找**。**一次性派完，不要一个 finding 派一个人。**
3. **第三波修完必须再评审一轮。** 本仓库七轮 100% 命中「修复波自带缺陷」，没有一次是实施者自己发现的。
4. **有一条要人裁，不要自己发明**：pending 文件是否也原子化（清单第 11 条）。它与人已裁定的 marker 修法逐字同形。
5. **通过后才进 `superpowers:writing-plans`**，再按 `superpowers:using-git-worktrees` 开隔离 worktree 动代码。顺序 L3 → L5 不可打乱；spec §11 另有硬约束：债 1（§4）通过独立评审后 §6 触发逻辑才可开始。
6. **人已裁定、不要重开的设计决策**见 spec §2/§4/§5/§7；债务归属见 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`。
7. **动手前先跑「如何定位当前状态」那一节，以命令输出为准**——不要相信本文任何数字，也不要假设 HEAD 是哪一笔（`main` 会被人并发推进）。
8. **铁律**：验证跑绝不过滤输出（`tail` / `grep` 同罪）；计划不附完整可抄代码；评审不接受实施者自证；每个数字旁附一条能重推它的命令**并写下该命令当时的输出值**；跑全套件时只有 flake (B) 与 (F) 允许出现，名单外一律按新缺陷处理。

## 第三波修复要修什么（2026-08-01 第三轮评审的产物，这就是待办清单）

**范围**：只改 `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`，代码仍然一行不动。
**第三轮评审看的 diff 范围（就地重推，不要照抄 hash）**：

```bash
git log --oneline -- docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
# 三笔，从新到旧：第二波修复 / 第一波修复（重写）/ 初稿。
# 第三轮评审看的是「第一波..第二波」；第二轮评审看的是「初稿..第一波」。
```

三个再评审员的分工是「三处开放设计选择 / 范围蔓延 / 数字与可测性全量回扫」。
**一次性派完，不要一个 finding 派一个人**（本仓库明确的教训：分散派会让每个人重建上下文、比全部任务加起来还贵）。

**Critical（阻塞）：**

1. **§4.3 的排序改判没有关闭它要修的那条缺陷，只是把窗口缩小了。**（两个视角独立撞到）
   输家的「读 → 改 → 写」既不原子也不持锁：`readPersistedSuccessfulTransferArtifacts` 的读可以早于赢家发布任何东西（首发转移时 `readOwnerTransferRecordRaw` ENOENT → **裸 `catch { return null }`** → 保护整个退化为无保护直写），它的写可以晚于赢家的 reconciliation rename。**`finalizeOrder` 排哪个方向都拦不住。**
   最小解（比本波否决掉的「加锁」小得多、且符合本层「只增加拒绝」的边界）：**把那个裸 catch 收窄成 fail-closed——读失败就放弃写**。
   ```bash
   grep -nF -A22 'async function readPersistedSuccessfulTransferArtifacts(' src/persistence/fileStore.ts
   grep -nF -A10 'function transferRepresentsPublishedWinner(' src/persistence/fileStore.ts
   ```
2. **为这处改判新加的两条「必须红」的护栏变异，实测都不会红。**（两个视角独立走完同一条五步链，结论一致）
   变异二（删掉 fixture 里的锁文件）：无锁 → `recoverInterruptedOwnerTransfer` 的 `!lockHeld && pathExists(lock) && !tryRecover…` 短路 → 输家**替赢家**把三文件 finalize 了 → `transferRepresentsPublishedWinner` 反而成立 → 保护生效 → spec 规定的两条断言**全部通过**。变异一是「改 fixture 并同步改中断点」，那不是变异、是另写一条测试，违反 §10 通用条。
   **所以本波最承重的改判目前零有效护栏。** 修法：加一条**窗口内**断言（输家的 `writeBoundaryArtifacts` 返回那一刻 `reconciliation-record.json` 仍不存在 / marker 仍在），或 spy `rename` 断言输家那次调用期间零 rename。
3. **§8 新增的「按 `Error.cause` 路由」方向是反的，且编译不过。**
   §4.4 自己判定规则 2/3 在生产中不可达；唯一**可达**的永久钉死是 torn pending，它抛的是 `JSON.parse` 的 `SyntaxError`，**不匹配**那一行的「具名拒绝错误」条件 → 照样落 stdout / exit 0。**本层为不可达分支买单，把可达的静默留着——正是 §4.4 整段立论要防的东西。**
   而且 `new ResumeNotEligibleError(msg, { cause })` 在当前签名下 `TS2554`（评审员真跑了 `tsc`），§9 把一个**导出类**的公开签名变更写成了「catch 里改一行」（`tests/controller/resumeLoop.gate.test.ts` 直接 `new` 它）。
   **好消息，可以撤销一条担心**：`Error.cause` 的 Node 版本风险**不存在**——`tsconfig.json` 是 `"target": "ES2022"`，`@types/node` `^22.x`，本机 v22。
   最小解：**放弃这笔生产改动**，sweep 在报告层按 `cannot read run artifacts:` 前缀（该字面量全仓唯一）判为 `error` → stderr。
4. **§15 验收 7 在今天的仓库上无条件通过。**
   判据指向 `docs/superpowers/reviews/`，而 `docs/superpowers/` 下只有 `decisions/ plans/ specs/`；`git log` 对不存在的路径**空输出退出 0**。另一条 `git log --reverse -- src/sweep/ src/cli.ts` 的首条永远是 2026-07-15 的引导提交（`src/cli.ts` 早有历史）。**这条验收是为「实施顺序要有验收面」新加的，结果是一条恒真的命令 + 一个仓库从未有过的目录约定。**
5. **§4.6 与 F47 的「就地勘误」方向反了。** 见 Executive Summary 第 5b 条。改成按解析到的 `grep` 限定，把裁决记录那条从「假」降级为「未限定 grep 实现」。
6. **§10 测试 2 的完整区间少一格。**（两个视角撞到）§4.4 规则 1/3 使 finalize 新增一次 marker 的 `readFile` + `JSON.parse`（今天只 `pathExists`），所以 try 之前是 **4 次**（marker 1 + pending 3），不是 spec 写的 3 次。按字面写出来的测试**恰好跳过 marker 解析那个间隙**——而那正是规则 3 与测试 4c 唯一的落点。（顺带：「改动后 13 步」两个评审员各自独立重推，**都同意是 13**，不用改，但要限定为 v2 专属。）

**Important：**

7. **§10 测试 8b(ii) 按字面不可表达**：它要 mock 的 `updateOwnerRecordWithPrecondition` **从未导出**（`fileStore.ts` 内 `async function`，无 `export`；全仓 grep 只有同文件内部调用与注释）。这是第一波「测试 1 按字面不可表达」的同型复发。替代：mock 已导出的 `releaseOwnerLease`，或从测试侧改写 `owner-record.json` 让 CAS 真实失配（更贴生产语义）。
8. **§10 测试 14 的 fixture 少第三条前提**：拒绝必须由 `evaluateResumeEligibility` 给出。走 CAS 门那条会建/删 `.owner-transfer.lock` 并跑一次 `lockHeld: true` 的回收，「其余字节不变」在全树快照下必假。
9. **§6/§12 的配额论证依赖一条假的绝对断言**（两个视角撞到）：`runLoopFromState` 的 `while (true)` 以 `writeRunState` / `affirmNow` 开头，**它们在任何 try 之外**。第 k+1 轮顶端 ENOSPC → 抛出 → sweep 记 `error`、**配额不计**，而前 k 次付费调用已经发生。修法：配额在**门通过、`resume_adopted` 追加之时**计入。
10. **§13 的归类错了**：裁决记录对债 3 要的是「**显式表态**」，本层已按可接受方式表了态，**按裁定它是关闭的**；而 §5.2 的 span 外那段（`writeBoundaryArtifacts` + 它前面的 `assertHeld` 从来就没进过任何 span）是**本轮新发现**，不该写成「债 3 部分关闭」。另：第 4 笔（pending 非原子）在 §17 索引里**没有对应的 F 行**——它是实施者自查加的，要么补一行标注「本轮自查新增，非评审要求」，要么就是无来源的扩张。
11. **§4.0.3 的「S-3 不触发」结论盖过了它的证据范围**——原子 marker 只消掉 marker 那条路由；torn pending 通向**同一个**永久钉死形态（marker 在盘 + `readOwnerRecord` 永久抛 + 本层无恢复入口），而本层把它从两份扩到三份。spec 在 §4.4 / §13 / §15 三处诚实披露了，但 §4.0.3 全节一次没提。**这条建议回交给人再裁一次**：pending 原子化与已裁定的 marker 修法**逐字同形**。
12. **§5.3 方案 (a) 的三处未声明副作用**：新分支插在外层 catch 最前，会抢掉兜底的「转 `failed` 并落盘」（这是意图）**和 `cleanupAttemptWorkspaceBestEffort`（未声明）**；返回的 `state` 与磁盘不一致（`applyPhaseUsage` 之后没有 `writeRunState`），所以「与 §5.4 同构」为假。**另外必须加一条硬约束**：`RunHeartbeatStoppedError` 与现有两个**并列、不得继承**——(a) 的全部安全性建立在 `isLeaseStopError` 的 `instanceof` 不匹配它上。本仓库对这件事已有判例（`OwnerTransferLockBusyError` 上方那段 "deliberately NOT a subclass"）。
13. **§11 新加的重点名单里，L1 §12 第 4/6 两条引文都被省略号截断，而被省掉的正是与本层冲突的那半句**（第 4 条的「The one write `stop()` is permitted — **and required** — to make is the release of requirement 17」，而 §15 验收 4 把这次 release 降级为尽力而为）。按 Rule 7 必须挑一个并说明。
14. **§5.4 的停机检查点单数 vs 代码两处**（两个视角撞到）：`grep -c 'leaseLoss.lost !== null' src/controller/runLoop.ts` → **2**。「停机不消耗 `attemptsUsed`」只对循环顶部那一处成立。明写只装一处，或把结论限定。
15. **§15 验收 5 的哈希守卫在 §10 没有对应测试条目**（孤儿验收）。**并且两个评审员在这里意见相反**：一个实测「阈值 20 vs 函数体 28 行合理、防护栏针对的失败模式正确」，另一个认为它违反 Rule 2、更小的解是「八条判据各配一条会红的变异测试」（变异点天然落在生产代码上，且 §10 已有这条纪律）。**按 Rule 7 挑一个并说明为什么，别两边都留。** 本文倾向后者（Rule 2 是项目规约）。
16. **§10 测试 9 没有自有的可失败断言**（`isLeaseStopError` 模块私有），杀伤全借给测试 7b。要么裁定导出，要么并进 7b，别留空壳。

**记账类（不阻塞，但要一起改掉）：** §4 节首「命中 **4** 行」实测 **3**（**这是本波唯一一个错的数字，而它偏偏是附了命令的**——见下方教训）；§3「resumeLoop 5 个追加点」实测 6 个 `appendEvent` 调用点；§17 的 F6 行只记新增、漏记它把 §15 验收 1 弱化成了「**持久的**」；§8 汇总行新增的 `errored` 追不到任何 F；`transferRepresentsPublishedWinner` 实为三条判定而 §4.3 两处只列两条；`hasStagedArtifacts` 看不见第三份 pending（属 L5，但要在 §13 第 1 笔具名）；§9 未说明 `registerStopHandlers` 是否导出（测试 13b 要够得着）；观测 `resumeLoop` 调用次数的缝在 §9 未定义（测试 10/11/12b/13 都要数）；新常量命名 `.reconciliation.pending.json` 与既有 `<产物名>.pending.json` 约定不完全对齐。

**本轮最值钱的三条教训：**

- **`grep` 的退出码取决于解析到哪个 `grep`，本仓库里两个答案都出现过，别再把任何一个当成绝对事实。** 交互 shell 里 `grep` 是 `~/.claude/shell-snapshots/` 里的 zsh 函数（ugrep 系）：末尾带 `(` 的锚点不加 `-F` 会 `unclosed group` **exit 2**；而 `rtk proxy "…"` 起的子 shell 不加载该函数、解析到 `/usr/bin/grep`，同一条 **exit 0**。**六个评审员里四个报 exit 0、一个报 exit 2，控制器自己也一度跟着确认了错的那个**——因为大家跑的壳不同。**规矩：写「实测」必须连同「在哪个壳里实测」一起写；锚点一律保留 `-F`。** 用 `type grep` 先看清自己在哪个壳里。

- **失效模式迁移了。** 前几轮是「数字错」，本轮数字层几乎全对（一个评审员跑了 **92 次调用 / 81 条唯一命令，全部 exit 0**，锚点无一失效）。**新的失效模式是「论证链里某一步把非原子的东西当原子用」**：把 `Promise.all` 当快照（spec 自己在 §4.0a 白纸黑字写着「它本来就不是快照」）、把并发读写当顺序、把「改 fixture」当变异。**下一轮请从每一句「所以 X 读到 Y」开始查，问一句：这两个动作之间隔着几个 `await`，中间有谁能写。**
- **「附了命令的数字全对」这条规律，本轮被破了一次**——唯一错的那个数字恰恰附了命令（§4 节首）。**说明贴命令的人没有真跑它。** 规矩要升级为：**附命令 + 把该命令的输出行数/值一并写下**，否则命令只是装饰。

## 上一轮（2026-08-01 L3 spec 初稿轮）发生了什么

**产出**：L3 spec 两笔提交——初稿，以及经三轮独立评审后的重写。定位：

```bash
git log --oneline -- docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
# 两笔：初稿在前，重写在后。再评审的 diff 就是这两笔之间
```

**三个评审员的分工是刻意错开的**（事实核查 / 设计缺陷 / 一致性与可测性），三份报告不在仓库里（会话产物），但**结论已全部吸收进 spec 的 §16 修订索引**——那张表是「初稿缺陷 ↔ 修订处」的对照，再评审时应该拿它当清单逐条验证「修好了没有、修的时候有没有引入新的」。

**两条是决策反转，不是措辞修补，评审时优先撞这两条：**

- **§4.4 finalize 机制从「pending 存在性驱动」改判为「marker 驱动」。** 原因：前者无法区分「v1 事务」与「v2 事务但 reconciliation pending 没落盘」，崩在 marker 与该 pending 之间会发布 transfer、删掉 marker、留下**永不可恢复**的债 1 状态——而初稿的测试 4 恰好把这个状态断言为正确。
- **§5.4 停机信号从「写终态 cancelled」改判为「不写终态」。** 原因：`legalTransitions.cancelled = []` 且 `RESUMABLE_STATUSES` 不含它，写终态等于一次 Ctrl-C 永久杀死飞行中的 run。初稿照抄了 `leaseLoss` 的先例却没注意到不类比——那里有新 owner 接手，`stop_requested` 下没有。

**本轮最值钱的三条教训（比缺陷本身值钱）：**

- **三个评审员各自都错了至少一处，每一处的错法完全相同：接受了一条没有把命令放宽去跑的主张。** 一个只 grep `src/` 就宣布「无人读 `boundary-analysis.json`」（`validation/v1/lib/evidence.ts` 读它并做 Zod 校验）；一个把「`grep` 不加 `-F` 会 exit 2」标成「确实会报错」而没跑（实测 exit 0，只有 `-E` 才 2）。**「评审员说的」和「实施者说的」一样需要自己跑。**
- **引用在先的裁定时必须引全句。** spec 初稿引了 `runExclusive` 注释的前半句，而被略掉的后半句（"Refusal is Task 5's job; duplicating it here would just be a second, weaker copy…"）正好禁止它要做的改动。Rule 7 要求冲突时挑一个并说明为什么，不是引一半。
- **一个「最小 diff」的选择，如果它避开的失败模式是响亮的、接受的失败模式是静默的，那它就选反了。** §4.4 的改判就是这一条。

**遗留的两笔已在 spec §13 具名、刻意留给 L5**：锁可被偷（零长度锁文件不可解析 → 活着的持有者被夺锁，本层之后会让 epoch 三元组失去区分力）；execute 相位 abort 后无第二重超时上界（adapter 只发 SIGTERM、无 SIGKILL 升级）。

## 相位计时分支：已合并，本节留档不是待办

分支 `probe/perf-now-phase-timing` 已用 `--no-ff` 合并进 `main`（沿用本仓库带描述的 merge commit 惯例），并**已由人推送**；worktree `.claude/worktrees/perfnow-probe` 已 `git worktree remove`，分支已 `git branch -d`（完全并入，未用 `-D`）。**不要再去找它们，也不要重做。**

合并前在分支尖端、合并后在 `main` 上各验证一次：**29 files / 446 tests，exit 0**；typecheck 与 build 退出 0。合并结果与分支尖端**逐字节相同**（fast-forward 之外无冲突解析）。

**它落地了什么**（已被独立评审复现，不是采信实施者）：

`runPhaseWithTimeout` 的三个超时返回点按**已发放配额**计账（`Math.max(elapsedMs, timeoutMs)`），把「预算是否耗尽」从墙钟测量变成超时触发的后果。三条守护测试，**逐条变异证明各钉各的返回点**：两条都退回 → `2 failed`；只退回 resolve → `1 failed`；只退回 reject → `1 failed`；文件还原后 sha256 逐字节一致。446 tests / typecheck / build 全绿。详见遗留事项 2 (E) 第 4 条。

**这四件曾是「开 L3 之前必须做完」的清单，2026-08-01 已全部做完。留在这里是为了「为什么长这样」，不是待办：**

1. ✅ **修复波 2 已于 2026-08-01 做完**（六条，第三轮评审五条 + 复核时撞出的第六条，全部是实施者自己带进去的）。留档：
   - 「the three `persistTerminalState` call sites」是**指错的符号锚点**——该符号在 `runLoop.ts` 有 **15** 个调用点，按原意（丢租约后仍写终态）收窄是 **4** 个，`three` 两头都不对。已改成 `if (leaseLoss.lost !== null)` / `if (isLeaseStopError(error))` 两个可 grep 的分支锚点，spec 与同名 plan 各一处。**错的符号锚点比陈旧行号更糟，因为它看起来是永久的。**
   - **引用清扫不完整，而 `9e554ce` 的提交信息声称「十处全部改完」**。已按「在 merge-base `07180a7` 上本来是否有效」逐条判定 `docs/` + `src/` + `tests/` 范围内全部 44 条 tracked 引用：**15 条**在分支起点有效、被本分支顶掉 → 已改成符号锚点；**2 条**位移为 0 未被顶掉；**27 条**在分支起点就已经错（L1/L1b/L2 时期漂移，动它们违反 Rule 3）→ **未动**，判定依据见修复波 2 的报告。
     **范围声明（修复波 3 补，此前从未写出来，而结论却被说成对「tracked」穷尽）**：`.superpowers/sdd/` 里另有 **23 条** `runLoop.ts:NNN` 引用，git 确实 track 它们（ledger 用 `git add -f` 入库）。**它们按不可改写的历史过程记录处理，刻意一条未动**——与下方第 8 项对 `9e554ce` 提交信息的处理同一立场：就地勘误，不改原件。修复波 3 已逐条回 `07180a7` 复核这 23 条（另有 2 处裸续接 `:1066` `:1098` 不计入 23）：**10 条 + 那 2 处裸续接 = 12 处**在分支起点有效且被本分支顶掉——`owner-transfer-contention/final-fix-wave-report.md` 的 `:910`、同目录 `progress.md` 的 `:774` `:788` `:1049`、`atomic-write-paths/progress.md` 的 `:821` `:862` `:864`×2 `:865`×2 与那 2 处裸续接；另有 **1 条**在分支起点有效**且位移为 0、至今仍有效**（`owner-transfer-contention/final-fix-wave-report.md` 的 `runLoop.ts:80-81`，该处 80–81 行在 `07180a7` 与 HEAD 上逐字相同）；其余 **12 条**在分支起点就已经错。10 + 2 + 1 + 12 = 23 + 2 处裸续接，与上面那条 `git grep` 对得上。**所以「全部 44 条」是 `docs/`+`src/`+`tests/` 范围内的穷尽，不是仓库范围内的穷尽。**
     ⚠️ **修复波 3 在这里塌了一个桶**：`docs/`+`src/`+`tests/` 的分类是**三桶**（顶掉 / 位移为 0 未顶掉 / 起点即错），而 `.superpowers/` 的分类只写了两桶，第三桶唯一的成员被误记进「起点即错」，把 12 写成了 13。**分类维度一旦在一个范围里立好，换个范围也要原样带过去。**

     ```bash
     git grep -o -E 'runLoop\.ts:[0-9]+' -- '.superpowers/sdd/' | wc -l   # 期望 23
     ```

     **注意 44 是「引用」数、不是 grep 出现次数**：同一条命令改指 `docs src tests`，在 `07180a7` 上数出 53、在本分支 HEAD 上数出 29（一条 `:864-866` 或一串裸续接算一条引用、多次出现）。修复波 3 复核的是 `.superpowers/` 那 23 条，**没有重数 44 / 15 / 2 / 27**——要用这四个数先自己重数。
   - `runLoop.ts` 超时分支注释里「本文件测试套大多是这么配置的」是没核的数量声明，实测 **10/49 ≈ 20%**（复现了评审员的数）。已改成「少数」并附再推导命令。
   - 「没有任何测试在任一方向钉住 `failureBoundary`」**为假**——`runLoop.integration.test.ts` 在 `07180a7` 上就有一条断言 `runtime_exhausted`。已改成「没有测试把它钉为配额下限的后果」。**注意该句不在 `runLoop.ts` 的注释里**（评审员写成「同一注释」），实际在 `runLoop.integration.test.ts` 的测试上方注释里。
   - `run-registry-design.md` 那处 perl 替换留下的重复短语（"after the lease gate" 说了两遍）已去重。
   - `9e554ce` 提交信息里的位移算术错误，已在下方遗留事项 8 就地更正。
2. ✅ **再评审已做，而且做了三轮，每一轮都抓到东西**（2026-08-01）。**本轮最硬的事实：五波修复，五波各自带缺陷，没有一波是实施者自己发现的。**
   - 修复波 2 → 第四轮评审：2 Important（位移表差 5；扫描范围被静默收窄）
   - 修复波 3 → 第五轮评审：1 Important（`.superpowers/` 的归属分类从三桶塌成两桶，12 被写成 13）+ 4 Minor
   - 修复波 4（**控制器本人实施**）→ 第六轮评审：1 Important（论证「锚点必须唯一」的那句话自己把 2 写成了 1）+ 1 Minor（附的重推命令在本仓库报错退出 2，`grep` 被改写成正则引擎、末尾 `(` 是未闭合分组，必须 `-F`）
   - 修复波 5 修掉上面两条，人明确裁定不再评审第七轮。**它只改了两句 markdown，两个新数字与那条 `grep -nF` 都当场跑过并贴了输出——但按本轮的记录，这不构成「它没有缺陷」的证据，只构成「没人去找」。**
3. ✅ **那条名单外的失败已定性**（2026-08-01），进 flake 名单 **(F)**，详见遗留事项 2。
   结论：**不是本分支引入的回归**——`main` 上全套件 1/100 复现，本分支 0/100，双臂隔离跑各 0/200。
   **两个不能顺手下的结论都写在 (F) 里**：不能说本分支修好了它（0/100 vs 1/100 分辨不出）；不能把它归进 (A) 的刀尖家族（它用默认 5000ms 预算，且负载方向相反）。
   **过程本身有个教训**：交接文件当初给的配方是「双臂各 50–100 次**隔离**跑」，照做（各 200 次）之后**双臂全 0**——隔离把并行负载拿掉了，而这条失败只在负载下出现。**那个配方对这条失败是错的条件，是它自己证伪了自己。** 真正定性靠的是全套件重复跑。
4. ✅ **push 与 merge 均已由人明确下令后执行**（2026-08-01）。合并用 `--no-ff` 带描述的 merge commit，worktree 与分支在人单独授权后才清理。
   **当时记下的那个误导面已消失**：`main` 上的 handoff 曾是指向 L3 的旧版、看不见那支分支；合并把它替换掉了。**这条留档是想说明一件通用的事：分支上的 handoff 只对分支上的人可见，未合并期间 `main` 的接手者读到的是旧版。下次开分支写 handoff 时记住这一点。**

**清理时的一个观察，值得下一位知道**：`git worktree remove` 会连带删掉该目录下所有**未入库**产物（brief / report / review diff / 它自己的 `node_modules` / `dist/` / `.DS_Store`）。本轮清理前逐条枚举过，确认 ledger 的 `progress.md` 已 tracked 并随合并进了主仓库才动手。**照做：先枚举会被销毁的东西，再销毁。**

## 快速接手入口

1. **L1 / L1b / L2 / 债 4 / 相位计时都已在 `main` 上**（run lease + heartbeat / owner-transfer contention / run registry / 消除 fileStore 非原子写 / 超时按已发放配额计账）。合并当时实测 **29 files / 446 tests 全绿，typecheck 与 build 退出 0** —— **以命令输出为准，不要照抄这个数**。
2. **四笔遗留债的归属已由人裁决完毕**，见 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`。裁决同时回答了「下一层做什么」：**先做债 4（已完成），再做 L3，最后 L5**。
3. **债 4 已关闭并合并。** 五个任务，每任务一次独立评审，另加整分支评审 + 一轮修复波 + 一次 scoped 再评审，全程 0 Critical。**不要重做，也不要以为它还在分支上——worktree 与分支都已清理。**
4. **L3 的 spec 已经写完了（2026-08-01），不要重新 brainstorm。** 路径 `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`。下一个动作是**对修复波再评审一轮**，通过后才写实施计划。顺序仍是 L3 → L5，不可打乱。
   **spec §11 有一条实施顺序的硬约束**：债 1（§4）的任务组必须完成并通过独立评审之后，触发逻辑（§6）的任务组才可开始——这是裁决记录「先于触发逻辑」的原话，初稿曾把「先于」两字漏掉。
5. **「为什么长这样」先读 ledger——但要读对那一份。**
   **本分支（相位计时）的是 `.superpowers/sdd/2026-07-31-phase-timing-quota/progress.md`**（2026-08-01 补建）。此前有人把接手者指向下面那份债 4 的 ledger 说「本分支的来龙去脉在里面」，**那是假的**：那份通篇是债 4 的，grep 不到本分支任何内容。
   **债 4 的**是 `.superpowers/sdd/2026-07-29-atomic-write-paths/progress.md`——全部裁决、四条计划缺陷、两条 spec 缺陷、每一轮评审与修复都在里面。**不要重新推理。** 它已用 `git add -f` 入库。
6. **常驻禁令**：L1 spec §12 十九条中的第 2/5/7/15/17/19 条不得弱化或删除（已变异验证，人下过指令）。
7. 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`；**真实 Claude 调用须事先获批（付费）**。
8. **已知 flake（2026-07-31 两次更正后）**：`BUDGET_EXHAUSTED_REASON` 家族 4 条**已修**；剩 1 条已观测（`evidence.test.ts`）+ 2 条已具名但**从未观测到失败**（第五个家族成员、L1 交错测试）。详见遗留事项 2。
   **两次更正都值得知道**：旧版「7 个」是错的（一条被数了两次、一条分类为假、一条从未具名）；而更正后的版本**仍然带着一条被实测证伪的修法**——「只抬 `perAttemptTimeoutMs`」是空操作。**别拿这份清单挥手放过没核过的失败，也别照抄没跑过的修法。**
   **2026-08-01 再增一条 (F)**：`continues normally when execute returns a complete result during the recovery window`，已定性、已具名、已带样本数。**现在「允许出现」的是 (B) 与 (F) 两条，不再是一条。**
9. **验证跑绝不要 `| tail -N`**；**计划不要附完整可抄代码**；**评审必须对着代码撞、不接受实施者自证**。三条铁律，全部有案底。
   **「绝不 `| tail -N`」包括 `| grep`。** 2026-08-01 控制器自己在验证跑上用 `grep` 过滤了套件输出，还把退出码吞成空值，当场自曝并重跑。**任何对验证输出的过滤都是同一类违规，不只是 `tail`。**
10. **五波修复，五波各自带缺陷，没有一波是实施者自己发现的**（2026-08-01 的记录，含控制器亲自实施的那两波）。**「修复之后必须再评审」不是流程洁癖，是本仓库六轮以来 100% 命中的经验规律。** 唯一有结构性作用的对策是下面第 8 项立的那条：**每一个算出来的数字旁边，就地附一条能重推它的命令**——本轮唯一没出错的数字，就是唯一附了重推命令的那个。

## 如何定位当前状态（不要照抄 commit hash）

```bash
cd /Users/biran/code/skills/loop/ccloop
git status --branch --short               # 应为 main，干净
git worktree list                         # 应只有主仓库；相位计时的 worktree 已移除
git branch --list                         # 应只有 main + backup/evidence-first-v1-…（备份分支，禁删）
git rev-list --count origin/main..main    # 待 push 笔数，以此为准，不要照抄本文
git log --oneline --decorate -8           # 只用来看形势，不要假设 HEAD 是哪一笔

# L3 spec 的三笔提交与各轮评审范围（不要照抄 hash，就地重推）
git log --oneline -- docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
# 从新到旧：第二波修复 / 第一波修复（重写）/ 初稿。第三轮评审看的是「第一波..第二波」。
# 若这里出现第四笔，说明第三波修复已经做了，先读它的 diff 再决定还要不要做。

# 本文自己的提交会改变 HEAD，push 会改变待推笔数——两者都不要写死，也不要照抄任何数字。
# 注意：`main` 会被人并发推进（已发生两次）。发现 HEAD 与预期不符时先跑
#   git log --format='%h parents=%p %ad %an %s' -5
#   git merge-base --is-ancestor <你关心的那笔> HEAD
# 确认自己的提交是否仍可达，再下结论——不要当成环境异常。

ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run     # 本轮实测 29 files / 446 tests，exit 0
npm run typecheck && npm run build                     # 均应退出 0
```

**本轮全套件实测 29 files / 446 tests 全绿、typecheck 与 build 退出 0，且 (B) 与 (F) 都未出现。** 后者只说明「本次没跑出来」，**不构成任何 flake 已消失的证据**——(A′) 与 (C) 至今从未被观测到失败，任一失败都是首次观测。

**本轮 spec 轮代码零改动**，所以这三个数字反映的是 `main` 的既有状态，不是 L3 的成果。

**446 这个数字会随任何一次加测试而腐坏**——它是合并当时的实测值，不是承诺。以命令输出为准。

**核对状态时不要相信本文的数字，相信命令的输出。** 本项目已有多次「文档里的数字被自己的编辑证伪」的案底，见下方教训——**其中一次就是这个代码块自己**：它一度写着「期望只有主仓库 / 只有 main」，而当时 worktree 与分支都还在。

## 债务归属裁决（已完成，不要重开）

裁决记录：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`（含评审修正痕迹）

| 债 | 去向 | 一句话 |
|---|---|---|
| 1 跨文件事务性 | **L3**（spec 内独立一节，先于触发逻辑） | handoff 旧版说「reconciliation 合成责任无人认领」——**那是错的**，见下 |
| 2 `persistTerminalState` 往已不拥有的 run 写 | **L5** | 修它就造孤儿，孤儿是 L5 的定义域；**在 L5 之前修是净损失** |
| 3 `heartbeat.stop()` 释放窗口 | **L3**（spec 必须显式表态，不得沉默继承） | L3 是让它可达的那一层 |
| 4 非原子写 | **现在就修**（= 当前分支） | 机械、低风险、不依赖任何未来层 |

**执行顺序不可打乱**：债 4 分支 → L3 → L5。理由：债 4 与债 1 在 `reconciliation-record.json` 上重叠，并行会互相覆盖。

**债 1 的旧描述是错的，这点很重要**：`persistOwnerTransfer` 与 `writeBoundaryArtifacts` 各自只有**一个**生产调用点，在同一函数相隔几行——生产者从未真空。真实缺陷是 `owner-transfer.json` 已原子发布、而 reconciliation 要等一个**会抛的 `assertHeld()`** 之后才写，第三方在此窗口 supersede 就留下 eligible 但无 reconciliation 的磁盘状态，`resumeLoop` 随即 ENOENT。**是 liveness 洞，不是安全洞**（fail-closed，deny-by-default 未削弱）。

**L5 的继承清单因此从 4 笔降到 1 笔**（只剩债 2）。

## 债 4：已完成并合入 `main`（保留下来是为了「为什么长这样」，不是待办）

**范围（全部落地）**：五处裸 `writeFile` 改 temp+rename——`loop-state.json` 的**两个**写者（`initializeRunFiles`、`writeRunState`）、首次 `owner-record.json`、`boundary-analysis.json`、`reconciliation-record.json`。外加标记一个导出的非原子 transfer 写入口（`writeOwnerTransferRecord`，**刻意保持非原子**），以及更正 L2 的三处注释（**`atomic: false` 保留为纵深防御，`src/registry/` 零逻辑改动，全分支 diff 在该目录内只有注释行**）。

**验收（整分支评审自己跑出来的，不是采信报告）**：443 tests / 29 files 全绿，typecheck 与 build 退出 0；转移事务路径四个符号 + 8 个常量对 `ee001ba` **逐字节相同**；`src/registry/` 零逻辑改动。

⚠️ **行号已全面失效，别照 spec / 计划里的行号动手。** Task 1 在 `:379` 之前插入了约 67 行，spec 的 `:76` 现在指向 `loop-contract.json`（**本设计排除的文件**），`:379-381` 落进了新增的辅助块。**锚点一律用函数名 + 文件名字符串，动手前先 grep。** spec §2.1 已加警告横幅。

**两条最值钱的发现，都来自「任务级评审看不见」的层面：**

1. **整分支评审发现本分支自己声明的核心风险裸奔上线。** spec §4.1 说进程唯一临时名是「本设计的核心风险」——共享固定临时名会**反过来制造**新的撕裂源（A 暂存 → B 覆盖 → A rename 发布了 B 的字节 → B 拿 ENOENT）。三条钉唯一性的测试全都**直接调用**导出的 `buildAtomicTempPath`，**没有一条观察生产路径实际用的临时名**。把 `:420` 换成固定名，**整套件全绿 441/441，两次**。生成器有覆盖，接线没有。已在修复波补上，并由发现它的同一个评审员用自己的变异复验杀掉（2 failed）。
2. **本分支证伪了 L2 的设计 spec，然后让一条新注释指向了它。** `2026-07-28-run-registry-design.md` §8.1 的逐写者表格仍断言 `writeRunState` / `writeOwnerRecord` 是裸 `writeFile`、"Atomic? no"。已按该文档既有的 `*Amended (x)*` 约定注解，**31 行插入、0 行删除**——注解而非改写。**`(j)` 是该文档第一条起因于「后续分支改了代码」而非「文档本身有缺陷」的条目；L3 若再证伪什么，接着写 `(k)`，就地注解。**

**spec 在执行过程中被实测改了三次**，全部保留痕迹：§7.1a 从无到有（创建型写入 inode 判据**不适用**，改用悬挂符号链接判据）→ 拆开两个前提不同的创建型写者 → 分类维度从「创建 vs 覆写」改成「**守卫是否拒绝预先存在的目标**」，并给出三档表。**两个判据互补不冗余，已实测：分流实现只在 inode 判据下死，只改创建路径的实现只在符号链接判据下死。**

## 遗留事项

1. **push** —— 用上面的命令看实际待 push 的是哪几笔，**不要假设数量，也不要照抄本文**。push 由人执行、人决定。
   - 早前记录的「`origin/main` 无人 push 却自动前进」**已澄清：是人自己 push 的，不是环境异常**。原遗留事项 10 撤销。
   - **2026-08-01 又发生了一次同型的困惑，记下来免得下一位再吓一跳**：agent 合并完成后再看 `git log`，发现 HEAD 不是自己那笔 merge，而是一笔陌生的 `update .gitignore`，且 `origin/main..main` 计数变成 0。**不是异常**——是人在同一时段自己提交并 push 了。**教训：这个仓库里 `main` 会被人并发推进，agent 不能假设自己是唯一写者；发现 HEAD 与预期不符时先查 `git log --format='%h parents=%p %ad %an %s'` 与 `git merge-base --is-ancestor`，确认自己的提交是否仍可达，再下结论。**
2. **已知 flake 债（刻意未修）。** 当前名单是 (A) / (A′) / (B) / (C) / (D) / (F) 六个条目，**各自的状态与允许出现与否逐条写在下面，不要只看这一行的汇总**——本清单被自己的汇总数字骗过一次了。跑全套件时**只有 (B) 与 (F) 允许出现**。

   > ⚠️ **本清单在 2026-07-31 被更正过一次，因为它自己犯了它要防的错。** 旧版声称「7 个」并附「具名清单」，实际是：**一条被数了两次**，**一条的分类是假的**，**一条从未具名**。更正依据全部来自读代码，不是推理。**下面每一条都能自己核。**

   **(A) `BUDGET_EXHAUSTED_REASON` 家族——已修，4 条。** 全在 `tests/controller/runLoop.integration.test.ts`，**对着测试名比对，不要用行号**：

   - writes stale reconciliation conflicting evidence when execute aborts after changing files
   - persists owner transfer artifacts and continuation eligibility after a controller-owned OWNER_LOST takeover-allowed verdict without resuming execution
   - records retained cleanupStatus in execution recovery when cleanup fails
   - treats execute timeout with no adapter result as exhausted even if files changed in the worktree

   ⚠️ **这份 handoff 之前给的修法（「只抬 `perAttemptTimeoutMs`，保持 `totalRuntimeBudgetMs: 20`」）是个空操作，已由实施者与评审员各自实测证伪。** `getPhaseTimeoutMs`（`src/controller/runLoop.ts:388-390`）是 `Math.min(perAttemptTimeoutMs, timeRemainingMs)`，而 `timeRemainingMs` 从预算起步、只减不增——**`min()` 本来就选预算那一侧，抬另一个操作数不改变任何会被求值的表达式**。照做的人会得到一个全绿的套件和一个原封不动的 flake。
   实测：把 `perAttemptTimeoutMs` 抬到 1000 后跑 160 次隔离，`chosenTimeoutMs` **100% 仍是 20/19**，失败 12/160（未改动的基线是 15/160），且失败信息报的是 `"timeout of 20ms"` 而非 1000。

   **真实根因**：`setTimeout` 与 `elapsedMs`（由 `Date.now()` 算）读数相差 ≤1ms，而控制器又把这个 elapsed 记回**同一个**预算（`applyPhaseUsage`），于是 `hasBudgetExceeded` 的 `=== 0` 判定落在硬币两面。实测余量 **−1..+4ms**。
   **（注意：只验证到「差 ≤1ms」这个可观测量，没验证到成因。** 两次 1ms 精度的 `Date.now()` 截断能预测同样的现象。不要把成因写成已证实的。）

   **修法（已落地）**：两个旋钮**一个都不动**，改让四个 execute adapter 在 abort 后再工作约 10ms——依据是 `prompts.ts:46` 本来就承诺 adapter 一个 `partialOutcomeRecoveryWindowMs` 的 flush 窗口，而这些测试早已把它设为 10。余量结构性下限变成「该窗口减去 ≤1ms 偏移」≈ **9ms**，比 1ms 高一个数量级。

   ⚠️ **反直觉但已双方实测：负载让这些测试更安全，空闲才危险。** 拥塞会推迟定时器回调、抬高 `elapsedMs`，预算侧因此获胜——基线在 `2×ncpu` 负载下 0/100 失败，空闲下 15/160 失败。**所以全套件并行跑绿是弱证据；空闲机器上的单条隔离跑才是对抗条件。**

   **旧版把其中一条记成了独立的「第 7 个」，并写明「与家族无关」。那句话是假的**——该测试的断言就是 `toBe(BUDGET_EXHAUSTED_REASON)`，旋钮也双双钉在 20。当初那条分类是**照测试名判的，没读测试体**（名字讲 cleanupStatus，形状却属这个家族）。

   **(A′) 第五个家族成员——已具名、已测量，✅ 现已被「超时按配额计账」结构性修掉（2026-07-31）**。下面保留的是修复前的测量记录，**不再是当前状态**：该测试的 `perAttemptTimeoutMs: 1_000` / `totalRuntimeBudgetMs: 20` 使超时值取自预算，超时触发即确定性归零，亚毫秒余量不再参与判定。**它不该再被当作「从未观测到失败、任一失败都是首次观测」那一类**：
   `tests/controller/runLoop.integration.test.ts > caps phase timeout by the remaining runtime budget`。
   同一根因，且**它本来就处在上面那个空操作配方会产生的状态**（`perAttemptTimeoutMs: 1_000` + `totalRuntimeBudgetMs: 20`）。
   两次独立测量一致：200 次隔离跑 **0 失败**，但余量分布 `{0:1, 1:87, 2:87, 3:25}`——**约 0.5% 的跑距离变红只有 1ms**。从未观测到失败。
   **(A) 的修法对它不适用**：plan 阶段没有 `awaitAbortedResult`（`runLoop.ts` 的 plan 相位 `runPhaseWithTimeout` 调用点），abort 之后 adapter 做什么都不计入 `elapsedMs`，**没有测试侧的杠杆**。
   ⚠️ **本条此前推荐的解法（换 `performance.now()`）已被 2026-07-31 的测量降级为「有效但非根治」，并已被一个更彻底的修法取代（已落地，见下）。** 原文声称「单调、亚毫秒的时钟不可能相对于已触发的 `setTimeout` 读短，这会一次性拔掉整个家族的根因」——**前半句在真实路径上未被证伪、后半句是过度声称**：
   - 真实路径成对测量（N=200，隔离、空闲机）：`Date.now()` 余量分布 `{0:2, 1:133, 2:65}`；同一批事件用 `performance.now()` 读则 min **+0.3886ms**、mean +1.3317、max +2.4735，**两者都从未读到低于超时值**。两条 `date_margin==0` 的原始记录真实耗时是 20.485ms 与 20.869ms——**截断把真实存在的 0.485ms 与 0.869ms 余量（就这两个样本）抹成了 0**，这是 `Date.now()` 确实有害的地方。
   - 但换时钟后**最小余量仍只有 +0.39ms**，是更宽的余量而非结构性保证。另有合成探针（2×2000 次）显示：当 `:397` 的起始读数与定时器注册之间的间隙接近 0 时，定时器会**真的**提前触发，此时 `performance.now()` 读到低于超时值的频率**高于** `Date.now()`（113/2000、137/2000 对 28/2000、75/2000）。该模式在真实路径上 0/200 未出现，**但它换任何时钟都治不了**。
   - **`performance.now()` 全量替换后 200 次隔离跑 0 失败，与基线 0/200 无可辨差异**——pass/fail 在此样本量下无区分力，以上结论全部来自余量测量，不是来自跑绿。

   **(B) `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`**——全套件并行负载下 5000ms 超时，隔离连过两次。发现于债 4 基线跑，**当时源码零改动**。

   **(C) 仅理论，从未观测到失败**：`tests/controller/leaseHeartbeat.test.ts:661 > appends one lease_lost event when a guard concludes while an affirm is already in flight`。
   旧版只描述为「L1 留下的一个依赖真实文件系统计时的交错测试」，**没有名字**——而规则是「不在名单内的失败一律按新缺陷处理」，**一条没名字的成员根本没法比对**。
   已按代码定名：`:662` 是 `vi.useRealTimers()`，`:655-660` 的注释自述其排序依赖「roughly eight filesystem round trips against one」。**L1 ledger 把它记为「a theoretical flake risk under heavy CI I/O contention」——是风险登记，不是观测记录。** 保留这个区分：**它不构成把一次真实失败挥手放过的理由。**

   **(D) 三处带着同一赛跑、但当前没有任何断言看得见它**（`totalRuntimeBudgetMs: 20` 在该文件共 **14** 处——修复前为 11，本轮的三条守护测试各加一处；**这个数字每加一条测试就会腐坏，别照抄，用 `grep -c "totalRuntimeBudgetMs: 20," tests/controller/runLoop.integration.test.ts` 现数**）：`persists execution-recovery.json when execute is entered but returns no result before exhaustion`、`keeps changed-path stale reconciliation on OWNER_UNDECIDABLE…`、`writes an OWNER_LOST reconciliation record with transferred ownership…`。三条都不断言 `stopReason`，也不断言 `failureBoundary`（后者是预算派生的，会暴露赛跑）。~~**今天无害；谁给它们加一条 `stopReason` 或 `failureBoundary` 断言，它们当天就变 flaky。**~~ **这条警告自 2026-07-31 起为假，不要再照它行事。** 三条都设 `perAttemptTimeoutMs` 等于 `totalRuntimeBudgetMs`（皆为 20），超时值取自预算，「超时按配额计账」使其确定性归零——现在给它们加 `stopReason` 或 `failureBoundary` 断言会得到**稳定**的测试，不是 flaky 的。本轮新增的三条守护测试正是这么做的（其中一条就断言 `failureBoundary` 为 `runtime_exhausted`）。

   **(E) 修 (A) 时挂下的 4 条，已具名、已测量、刻意未做**（无第二轮修复波，全部带裁定记录在此）：
   1. `runLoop.integration.test.ts` 里那句「窗口设为 0 会让这些测试**重回刀尖**」**过度声称**。实测：窗口=0 时余量 +1..+4、160 次 **0 失败**；而真正的修复前状态是余量 −1..+4、**15/160 失败**（`delay(0)` 被 Node 钳到 1ms，仍买到一个定时器回合）。**警告本身该留**（约 9ms 的缓冲确实塌成约 1ms），但准确说法是「只剩约 1ms 余量，而非约 9ms」。
   2. 同一注释块有一处**折行错位**（`// contract that set the`），纯外观。
   3. 该注释承诺「区间都带样本数」，但**只有一台机器的带了**；且另一台标注的 `+10..+13` 在重测后扩为 `+10..+15`。
   4. ~~**根治办法仍未做**：把 `runPhaseWithTimeout` 的相位耗时从 `Date.now()` 换成 `performance.now()`。**它是唯一能真正消除 (A′) 与 (D) 的手段**~~ —— **已作废并已由另一修法取代（2026-07-31 落地）。** 「唯一手段」这句是错的：换时钟只是把余量从 0 放宽到约 +0.39ms，时钟仍在判定里。
      **实际落地的修法**：`runPhaseWithTimeout` 的超时分支按**已发放的配额**计账（`Math.max(elapsedMs, timeoutMs)`，三个返回点）。依据是 `getPhaseTimeoutMs` 本就是 `min(perAttemptTimeoutMs, timeRemainingMs)`——**当预算是较小的那个操作数，超时触发即意味着预算按定义已耗尽**，不该回头拿墙钟去重新推导。这样 `hasBudgetExceeded` 的 `timeRemainingMs === 0` 成为「超时触发」的后果，而不是「两次时钟读数恰好跨满整个窗口」的后果；当 `perAttemptTimeoutMs` 是较小操作数时下限低于剩余预算，**不会强制任何东西耗尽**。
      守护测试：`runLoop.integration.test.ts > accounts a budget-capped phase timeout as exhaustion even when the clock reports no elapsed time`，用 `vi.useFakeTimers({ toFake: ["Date"] })` 冻结 Date、保留真实定时器，把这个依赖从亚毫秒赛跑变成确定性判定。**退回裸 `elapsedMs` 该测试即红**（已实测：`Received: "plan phase exceeded per-attempt timeout of 20ms"`）。
      **仍未消除的部分，别当已解决**：上面那个「间隙≈0 时定时器真提前触发」的模式与本修法无关，本修法只覆盖**预算封顶**这一路径；`perAttemptTimeoutMs` 封顶的超时仍由时钟测量决定其计账值。

   **(F) 已观测、已定性、刻意未修（2026-08-01 新增）**：`tests/controller/runLoop.integration.test.ts > runLoop > continues normally when execute returns a complete result during the recovery window`。
   失败断言：`expected 'exhausted' to be 'succeeded'`（`finalState.status`）。

   **实测（双臂，本轮跑的）**：

   | 条件 | 本分支 | `main` |
   |---|---|---|
   | 全套件 | 0/100 | **1/100** |
   | 单条隔离跑 | 0/200 | 0/200 |

   **定了的**：**不是本分支引入的回归**——它在 `main` 上、本分支一行代码都没有的情况下复现。
   **不能说的两件**：
   - **不要说本分支修好了它。** 0/100 vs 1/100 分辨不出（Fisher p≈1）；把更早那次观测并进来，两臂各是 1/112，完全一样。
   - **不要把它归进 (A) 的刀尖家族**，尽管都出现 `exhausted` 一词。该测试**不设** `totalRuntimeBudgetMs: 20`，用的是 `createContract` 的默认 **5000ms**；它只覆写 `perAttemptTimeoutMs: 20` 与 `partialOutcomeRecoveryWindowMs: 30`。**负载方向也相反**：刀尖家族是空闲危险、负载安全，这条是隔离 200 次不失败、只在全套件负载下失败。**按签名词归族，就是重蹈本文件上面记的那次「照测试名判、没读测试体」。**

   **机制是假说，未证明，别写成已证实**：全套件并行争 CPU 时某相位的真实墙钟把累计用量顶过 5000ms 总预算，于是控制器**合法地**判定耗尽。只有一个失败样本，且未捕获 `budgetSnapshot`。要证它需要在失败时把 `timeRemainingMs` 与各相位用量落盘，再跑一轮全套件重复跑（约 30 分钟机器时间）。**在那之前，「为什么」是空的。**

   **给实施者与评审员**：跑全套件时，**只有 (B) 与 (F)** 可以出现且不构成新缺陷。**(A) 的四条已修——它们若再失败，是回归，按新缺陷处理。** **(A′) 与 (C) 从未被观测到失败：任一失败都是首次观测，必须立刻上报，不得挥手放过。**
   **「像是已知 flake」不等于「是已知 flake」**：必须先捕获**完整测试名与失败块**再比对，**绝不允许 `| tail -N` 后凭印象归因**——L1b 正是这样丢过一次失败身份。**任何不在名单内的失败一律按新缺陷处理。**
   **比对时对着上表的测试名，不要对着行号**——行号会腐坏，本项目已有六处自造的失效引用案底。
3. **L2 挂账 5 条 Minor**（可延后，见 L2 ledger）：`ObservedFileSpec.file` 未收窄成字面量联合；`scanRootFailureDetail` 落在 `renderRuns.ts` 名不副实；`DT_UNKNOWN` 回退无测试（**已如实记录而非写空壳测试充数**）；两条夹具注释瑕疵。
4. **`.superpowers/sdd/` 是跨会话共用的扁平目录**，且是 gitignored——提交自己子目录的 ledger 要用 `git add -f`。**刻意跳过** `review-*.diff` 与 briefs（都可重建）。同级目录属于更早的会话，**不要整删**。
5. **本分支范围外、但已查实、留给后续层的两笔**（都属 L3 / L5 的归属域）：
   - `finalizePendingOwnerTransfer` 自己的 catch 有与 D2 同型的潜在错误掩盖——两个 `safeUnlink` 都可能替换正在传播的错误。它在 spec §2.2 的不动范围内，本分支正确地未碰。**整分支评审复核后同意可以带着它合并**：修它需要动那个必须逐字节不变的保护区，而触发条件是「清理失败与转移失败同时发生」。
   - **【本轮实测新增】** `runLoop.ts` 里 `checkRunLease` 之上那段 `§7.0` 注释（`grep -n "ensureFreshRunDir" src/controller/runLoop.ts` 定位）断言了**两件已被实测证伪**的事：「`ensureFreshRunDir` 已经对任何既存 run 文件抛过了」和「此处只可能观测到『无 owner record』」。实测：`ensureFreshRunDir` 的 `blockingPaths` **不含** `owner-record.json`，且 `checkRunLease` 对空租约（`leaseGate.ts:38-42`）与**已过期**租约（`:44-64`）**都只返回、不拒绝**——所以一个只含 owner record 的 run 目录会以**覆写**形式到达 `writeOwnerRecord`（已实测：inode 发生变化）。
     **代码大概率是对的**（`leaseGate.ts` 说该状态按设计不表态），**错的是注释**。本分支正确地未碰（属归属域，动它违反 Rule 3）。**整分支评审的附加条件是：这条必须从 ledger 提升到 handoff，否则下一层只会读到那条假注释、读不到对它的证伪。此条即为履行该条件。**
     ✅ **已于 2026-07-31 修掉（注释改写，代码零改动）。** 两处断言由下一个接手者独立复核为假后才动手，不是采信本条。`blockingPaths` 实为 `loop-contract.json` / `loop-state.json` / `events.jsonl` 三项，外加非空的 `attempts/` 与 `worktrees/`。**本条自己那个失效的行号 `:864-866` 已于修复波 2 换成上面的符号锚点**（旧行号是这一整类腐坏的又一例，不是特例）。「inode 发生变化」那句是上一轮的测量，**本轮未复测**，按原样保留为上一轮的记录。
6. **一条随时可能被配置改动静默打破的依赖**：修复波新增的临时名接线测试依赖 vitest **文件内顺序执行**（`vitest.config.ts` 无 `sequence.concurrent`，该文件无 `it.concurrent`），否则模块级计数器会被竞争、临时名预测失效。**不是当前风险，但只隔着一个配置改动。** 若将来开启文件内并发，先看这条。
7. **硬编码数量与硬编码行号是同一类腐坏，但更隐蔽。** 本分支两次被自己的编辑证伪：一条注释写 `owner-record.json`「在**两条**路径上」发布（实为三条）；一条注释写「本文件 **51** 条测试全绿」，而同一波修复给该文件加了 2 条（实为 53）。**行号错了一 `sed` 就露馅，数量错了只有等人重新枚举才会浮出来。** 仓库里还有若干带实测数字的注释（`441/443`、`48/48`、40 次压测），~~**当前全部为真，无人强制**~~ —— **`441/443` 已于 2026-07-31 被本轮新增的三条测试证伪**（分母现为 446），已在 `fileStore.test.ts` 就地标注为历史测量而非实时计数；`48/48` 与 40 次压测本轮**未复核**，不要当作已核实。仍然无人强制——L3 若要动，先看这条。
8. **`9e554ce` 提交信息里的位移算术是错的，就地更正如下**（提交信息在历史里不可改写，不要 rebase / amend；这条是它的勘误）。原文写「+8 lines from the timeout branch, +19 from the lease-gate comment」。逐笔实测（`git diff -U0 <c>^ <c> -- src/controller/runLoop.ts | grep '^@@'`）：

   | commit | timeout 区（`runPhaseWithTimeout`） | lease-gate 区（`runLoop` 的 `checkRunLease` 之上） |
   |---|---|---|
   | `e33095b` | `@@ -421,0 +422,8 @@` → **+8** | — |
   | `a017689` | — | `@@ -872,3 +872,14 @@` → **+11** |
   | `ea271d6` | `@@ -427,3 +427,14 @@` → **+11** | `@@ -880,3 +891,11 @@` → **+8** |
   | `6b39697` | `@@ -431,2 +431,7 @@` → **+5** | — |
   | **合计** | **+24** | **+19** |

   前三笔早于 `9e554ce`，`6b39697` 是**修复波 2 自己的第三笔**（该波四笔依次为 `8fe6d40` → `2e30d1c` → `6b39697` → `4a4f2a0`）、晚于 `9e554ce`——它就是本表在修复波 2 里被写错的原因：表写在再下一笔 `4a4f2a0` 里，没把同波刚加的 5 行重新推进去。

   所以本分支相对 `07180a7` 对 `runLoop.ts` 的**净位移**（老行号 → 新行号）：**≤421 → +0**；**422–863 → +24**；**864–866** 被 `@@ -864,3 +888,22 @@` 整段替换、**无对应新行**；**≥867 → +43**（= 24 + 19）。文件长度 1364 → 1407，正是 +43。

   **这张表和上面这三段位移，会被后续任何一次 `runLoop.ts` 编辑作废。不要引用这里的数字，就地重推：**

   ```bash
   # 起点写死为 07180a7，不要用 $(git merge-base HEAD main)：本分支一旦并入 main，
   # merge-base 就变成 HEAD 自己，命令返回空——读者会读成「没有位移」而不是看到报错（违反 Rule 12）。
   git diff -U0 07180a7 HEAD -- src/controller/runLoop.ts | grep -E '^@@'
   ```

   原文的 `+8` 只算了 `e33095b`，漏掉实施者**自己后一笔** `ea271d6` 在同一区域加的 11 行；修复波 2 补上 `ea271d6` 后又漏掉**它自己的** `6b39697` 的 5 行。**同一个错误连犯两次，两次都是「写下数字，然后被同一波里更晚的编辑作废」。** 这条没有污染修复本身（那十处都转成了符号锚点，没有数字传播）。
   **规矩（修复波 3 立，不是例外）：文档里每一处算出来的行号 / 位移 / 计数，旁边必须就地附一条能重推它的命令。** 修复波 2 给 `runLoop.ts` 的注释配了重推命令，那几处就没错；唯独没给 handoff 自己的算术配，那处就错了。

## 本轮新增的教训（比缺陷本身更值钱）

- **不要相信别人写下的「已核实」。** 本轮四次同一动作：我 grep 漏了 `doMock` 就写「已核实」；实施者信了我的「已核实」导致论述越界；我照抄评审员一段错误算术；实施者把那段错误算术写进了提交的注释。**别人标注为已验证的主张，在你自己跑之前仍是未验证的。**
- **加一个成分和加它的覆盖是一件事，不是两件事。**（实施者原话）修复轮加固了 pid 断言，却在**同一次编辑**里给新字段引入 `\d+` 并写了声称覆盖它的测试名——**把自己刚修掉的缺陷以更窄的形式重新引入**。教训不是「测试名要对范围诚实」，而是「**名字里每一个分句都必须有一条能失败的断言**」。
- **修复波会自带缺陷**，本仓库已有案底。**修复之后必须再评审**，且再评审的重点是「这次修复引入了什么」，不是重做上一次评审。
- **证明一个跨模块断言不是同义反复，要做反方向变异**：只改 A 侧失败、只改 B 侧也失败 → 是真钉定；同义反复只会在两侧同步变动时才失败。
- **注释里的机制，写之前先跑一遍。**（实施者为自己立的规矩，值得推广）

## 债 4 后半程新增的教训

- **「引用前先核实」原本只覆盖了读，不覆盖写。** 本分支 6 处失效行号引用**全部是自己造成的**——实施者插入的行把它自己另外几条注释引用的行顶走了，两轮各中一次。**规则扩展：所有编辑落地之后，重新核一遍每一条行号引用。** 更进一步的建议（留给 L3 定）：本仓库的跨文件行号引用得不偿失，没有编译 / 测试 / lint 会检查它们，改用符号名与「文件头部」这类锚点不损失精度。
- **判据要按调用点逐个选，「创建 vs 覆写」是错误的分类轴。** 正确的维度是「**该写者前面是否有守卫拒绝预先存在的目标**」。踩这个坑的代价是真金白银：spec §7.1a 因此改了三次。
- **一条声明「覆盖边界」的注释本身就是一个必须为真、必须可查的主张。** 但它并不因此就是坏的——判据是：**这个边界是否可构造、是否有人跑过、以及它失效时会不会大声过期。** 本分支那条通过了全部三项（点名了一个可构造的变异类、评审员跑了、补上 inode 测试后那句话会明晃晃地显得陈旧）。
- **纯测试的修复有时才是正确形状。** 整分支评审最重的那条 finding 是**覆盖缺口而非行为缺陷**，生产代码本来就在用生成器——改 `src/` 才是错的响应。但**要让评审员来判这一点，不要自己假设**。
- **控制器也会是假主张的源头，而且已经两次。** 一次是 `vi.mock` 的假前提，一次是我让实施者写「它点名的每个文件现在都经 rename 写入」——那句对 `OBSERVED_FILES` 整体为假，`owner-transfer.json` 标着 `atomic: true` 且仍有非原子写者。**两次都是子代理抓住的。「不要接受、自己核」这条规矩对控制器下达的指令同样适用。**
- **修复波要一次派完，不要一个 finding 派一个。** 每个修复者都要重建上下文、重跑套件，上一轮分支的最终修复波因此比它全部任务加起来还贵。
- **提取器要能大声失败。** 两个评审员各自写函数体哈希比对时，朴素版本对 `acquireOwnerTransferLock` **静默地提取出 1 行函数体**——因为它的返回类型 `Promise<{ release: () => Promise<void> }>` 里带大括号。**带「函数体过短就报错」的防护栏两次把静默的假通过变成了被抓住的错误。**
- **定罪前先验明正身。** 评审员发现两处测试文件里的行号引用在 HEAD 上是错的，**没有直接算在本分支头上**，而是回到 merge-base 去查，证实它们在分支开始前就已经错了（L2 时期的漂移）。

## flake 修复轮新增的教训（2026-07-31）

- **配方要先跑一遍再写进文档。** handoff 上传了不知多少轮的「只抬 `perAttemptTimeoutMs`」是个**空操作**——`getPhaseTimeoutMs` 是 `min(perAttempt, timeRemaining)`，预算本来就是较小的那个。实施者**照做了一遍再证伪**（抬到 1000 后仍 12/160 失败、报的仍是 `20ms`），而不是读代码推理出来就交差。**照它做的人会得到一个全绿的套件和一个原封不动的 flake。**
- **一个区间的可信度不会超过它背后的抽样数。** 本轮同一个错误犯了三次、三个人各一次：实施者用约 12 个样本报了 `+12..+14`；评审员用 160 个样本报 `+10..+13` 并据此说对方「乐观 2ms」；重测后两者都扩了（`+11..+15` / `+10..+15`），**所谓的分歧其实是两边的边缘抽样不足，不是硬件差异。** 评审员主动把这一条算在自己头上，并顺带撤回了「偏移**恰好**被 1ms 界定」——那是拿 320 个样本的尾部说了一个界。**写区间必须带样本数；没带的一律当未定。**
- **反直觉且已双方实测：负载让计时测试更安全，空闲才危险。** 拥塞推迟定时器回调、抬高 elapsed。**所以「全套件并行跑绿」对这类问题是弱证据，空闲机器上的单条隔离跑才是对抗条件。**
- **改了 helper 的签名就等于改了代码，不是改注释。** 实施者在无人要求的情况下对改造后的 helper 重跑了变异，理由是「本仓库 ledger 记着修复波会自带缺陷」。**这条规矩现在是自发执行的了。**

## 相位计时轮新增的教训（2026-07-31，代价最高的一轮）

- **合成复现模型不忠实于调用点时，结论会整个反向。** 本轮先用一个合成探针测出「`performance.now()` 读到低于超时值的频率**高于** `Date.now()`」（113/2000、137/2000 对 28/2000、75/2000），据此一度判断换时钟「方向正好是反的」。**对真实路径而言那是错的**：探针的 operation 几乎立刻注册定时器，而真实路径在起始读数与注册之间有大量工作，那个模式根本不显现。真实路径成对测量给出相反结论。**教训：合成模型的每一个简化都可能是结论的开关，用它下判断前先问「真实调用点在这一点上和它一样吗」。**
- **「实验没有区分力」本身就是结果，必须如实报告，不能当成阴性结论。** 本轮两次踩到：`performance.now()` 全量替换后 200 次跑 0 失败、基线也 0 失败——**这不叫「修法无效」，叫这个观测量在此样本量下看不见差别**；名单外那条失败 base 0/12、分支 1/12 同理。**把「分辨不出」写成「没差别」是本项目最容易犯的谎。**
- **错的符号锚点比陈旧行号更糟。** 行号错了一 `sed` 就露馅；符号锚点错了**看起来是永久的**，读者 grep 不回原意还以为自己搞错了。改锚点时必须验证该符号存在、且**唯一**指向原意——本轮就写了一个指向 15 个调用点的「the three ... call sites」。
- **修行号引用的那笔提交，自己制造了新的失效行号引用。** 两次插入把同文件下方推移 +8 与 +19，打断的引用**实际是 10 处而非评审员报的 6 处**（另外 4 处是实施者自查补出来的）。**规则再扩展：改完之后不是「重核自己引用的行号」，而是全仓扫一遍指向被改文件的行号引用。**
- **「不接受实施者自证」这条规矩，对实施者自己也成立。** 本轮三条最重的 finding（只保护了三分之一、`failureBoundary` 静默变更、指错的符号锚点）**没有一条是实施者自己发现的**，全部来自对着代码撞的独立评审。

## 更早的教训（仍然有效）

- **计划风格**：接口签名 + 测试要求 + 陷阱清单，**不给完整实现**。四轮一致：给完整代码效率高但计划的疏漏原样落地；给要求则实施者会主动发现并上报计划缺陷（本轮 Task 1 一个实施者就报了 4 条）。
- **评审要对着代码撞**，且**明确要求评审员不接受实施者的自证**。四轮最值钱的发现全部来自这一条。
- **任务级评审有结构性盲区**：只看单任务 diff。跨任务的、以及「守护测试守护的到底是什么」，**只有整分支评审能看见**——上一轮最贵的缺陷正是它抓到的。**不要因为每任务都过了就跳过最终评审。**
- **写「证明某测试能失败」时，注入点必须在生产代码/生产类型上。** 往测试数组里注入只证明匹配器有效。
- **加 guard 或改读写路径前，先 grep 同一函数内该危险调用的全部出现位置。**

## 仍然生效的治理边界

- 每次真实 Claude 调用前须显式获批（付费）。
- 不覆盖已接受的 `review.json`；`D-01` 保持 `INCONCLUSIVE / CONTRACT_GAP`。
- `stale-confirmed` / `reconciliation-record.json` **本身不授权继续执行或接管**；auto-takeover 仍 deny-by-default。resume 只消费已发布 transfer。
- **L1 / L1b / L2 不引入任何新授权**，后续层不得削弱。**债 1 的修复明确禁止放松 `resumeLoop` 对 reconciliation 的必需性**——那是引入新授权。
- 不做 `git clean` / `reset --hard` / 广域 `restore`；不删 `.validation-runs/`、备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`、`stash@{0}` / `stash@{1}`。
- push 与 merge 是两件事，都只在人明确下指令时执行。

## 参考（按路径读，勿在此复制内容）

- **相位计时（已合并进 `main`）**：`.superpowers/sdd/2026-07-31-phase-timing-quota/progress.md` ——**它没有 spec / plan**，这支分支起于 flake 修复轮的一条评审建议，不是走 SDD 流程立项的。ledger 里记了配额计账的依据、位移表与重推命令、引用清扫的归属判据、flake (F) 的定性方法。
- **债 4（已合并）**：`docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md`、`docs/superpowers/plans/2026-07-29-atomic-write-paths.md`、`.superpowers/sdd/2026-07-29-atomic-write-paths/progress.md`
- **L3（当前，spec 已定稿、代码未动）**：`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` ——**先读它的 §16 修订索引**，那是「初稿 16 条 Critical ↔ 修订处」的对照表，再评审时拿它当清单。**它没有 ledger 目录**：本轮只有 brainstorming 与评审，没有走 SDD 实施流程。
- **债务裁决**：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md` ——注意 L3 spec §4.0 / §4.1 **推翻了它的一条否决理由**，并**正面回答了它留给 L3 的问题 1**（初稿曾漏掉）。两处都在 spec 里附了重推命令。
- **L2 / L1b / L1**：`docs/superpowers/specs/2026-07-2{8,7,6}-*-design.md` + 同名 plan + `.superpowers/sdd/2026-07-2{8,7,6}-*/`
- 父设计：`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md`（§17 后续 spec 清单——**item 2 的触发那一半与 item 3 的 L5 cleanup 都还没写**）
- 兄弟设计：`docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md`
- 外部参照：`reference/loop-engineering/tools/loop-worktree/README.md`、`reference/DoWhiz/DoWhiz_service/scheduler_module/`
- 项目规约：`CLAUDE.md`、`.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/buglog.json`、`.wolf/anatomy.md`

## 建议接手时调用的 skills

- ~~`superpowers:brainstorming`~~ — **L3 的 brainstorming 已于 2026-08-01 完成并产出 spec，不要重跑。** 只有在 spec 被判定需要推翻重来时才回到它。
- **接手后的第一个动作不是评审，是「第三波修复」**——清单已在上面那一节列好，直接派一个实施者一次性改完（只改 spec，代码不动）。派单时把这几条写进提示词：不接受任何「已核实」（含本文和控制器给的）；每条 finding 判定不成立必须单列一节写依据、不许悄悄跳过；改完做一次**全文数字回扫**；每个数字附命令**并写下输出值**。
- `superpowers:requesting-code-review` — **第三波修完之后立刻用它，不可省**。**派多个视角错开的独立评审员**，提示词里明写「不接受实施者自证、findings 必须带可构造的具体场景、锚点用符号名不用行号」。另外必须提醒评审员两件事：(1) **评审员自己也会犯「没把搜索命令放宽就下结论」的错**（第二轮三个全中）；(2) **反方向也发生过**——第三轮有一个评审员的前提被实施者反驳，而实施者是对的。两边都要自己跑。
  **第四轮的重点已经知道了**：本轮失效模式已从「数字错」迁移到「论证链里某一步把非原子的东西当原子用」。让评审员从每一句「所以 X 读到 Y」查起，问「这两个动作之间隔着几个 `await`，中间有谁能写」。
- `superpowers:subagent-driven-development` — L3 有了 spec 与计划之后。
- `superpowers:finishing-a-development-branch` — L3 做完时。**已按它走过一遍（2026-08-01 的相位计时分支），三条实测补充**：(1) `.claude/worktrees/` 下若是**上一个会话**建的 worktree，本会话的 `ExitWorktree` 是 **no-op**，实际可用的是 `git worktree remove`；(2) 该 skill 的 Option 1 把「删分支 + 移除 worktree」当作合并的一部分，**但本仓库规定删分支要单独授权**——两者冲突时以本仓库为准，先合并再单独问；(3) `git merge -F -` **不读 stdin**（与 `git commit -F -` 不同），带描述的 merge message 要先写进临时文件。
- **清理约定（债 4 已按此执行，可照做）**：`.superpowers/sdd/<plan>/` 里只有 `progress.md` 被 `git add -f` 入库，其余 brief / report / review diff 都可重建、不入库。**移除 worktree 会连带删掉那些未入库产物 —— 这正是清理方式；但主仓库那份 `progress.md` 是 tracked 文件，`rm -rf` 整个目录会误删它。**
- `superpowers:requesting-code-review` — 每任务一次 + 整分支一次，缺一不可；修复轮之后还要再评审一次。**债 4 的两条最贵发现都来自整分支那一次。**
- `superpowers:verification-before-completion` — 声称「通过/完成」前复跑 typecheck / build / 全套件并贴真实输出。
- `superpowers:writing-plans` — L3 brainstorming 出 spec 之后。注意计划风格教训。
- `superpowers:systematic-debugging` — 若遇到不在 flake 名单内的失败。**也建议用在遗留事项 2 的 (B)**（`evidence.test.ts` 那条，至今只有现象、没有 root cause）。
- ~~**L3 之外还有两笔独立的小活**~~ —— **两笔均已于 2026-07-31 在 L3 之前完成**：(1) 相位计时的根治改为「超时按已发放配额计账」，**不是**原先记的换 `performance.now()`（原方案经测量为有效但非根治，见遗留事项 2 (E) 第 4 条的更正）；(2) 那条被证伪的注释已改写，代码零改动。
- OpenWolf 协议（`.wolf/OPENWOLF.md`）：改文件后更新 `.wolf/anatomy.md` / `memory.md`；修 bug 后写 `.wolf/buglog.json`。
