# 任务 1 报告 —— 写 L5 spec 的本职部分（cleanup / orphan GC）

BASE `30cbdd5` / 分支 main / 日期 2026-08-07

--------------------------------------------------------------------------------
## 0. 我做了什么（最先写）
--------------------------------------------------------------------------------

两处落盘，与授权面完全一致，**`src/` 与 `tests/` 一字未动**：

1. **新建** `docs/superpowers/specs/2026-08-07-cleanup-and-orphan-gc-design.md`（9 节）。
2. **就地勘误一条**给 `docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md` §10 第 4 条
   （21 插入 / **0 删除** —— 原句一字未动，见 §2 命令 8）。

未改动：任何台账、`docs/handoff/handoff.md`、其它 spec/plan。

先按落盘协议 `Write` 了一份只有小节标题的骨架，之后每次 `Edit` 只填一节，
顺序为 §5（纯实测数据，最有把握）→ §1 → §2 → §3 → §4 → §6 → §7 → §8 → 文首块 → §9。
**协议全程未被打断，九节全部落地，`grep -c 'TBD'` → 0。**

--------------------------------------------------------------------------------
## 1. 任务 A–G 逐项落点
--------------------------------------------------------------------------------

| 任务 | 落在 spec 哪一节 | 承重断言 | 重推命令见 |
|---|---|---|---|
| **A** P1 写成不变式 | **§1**（全文第一节） | `releaseOwnerLease` 在 `src/` 内只有 `leaseHeartbeat.ts:254` 一个调用点，落在 `const stop` 体内 => **INV-1：L5 的 GC 不得回收租约**。§1.4 记下与 §13 第 3 笔的耦合 | §2 命令 1 |
| **B** 两份委任状 | **§2**（§2.1 / §2.2 / §2.3 对照表） | 两份路径与节号**均由本文作者跑命令确认**，逐字引用 | §2 命令 2、3 |
| **C** `retained` 完整的一半 | **§3**（整节，含 INV-3a/b/c） | `cleanupStatus: "retained" \| "removed"` 是今天就活着的保留判定；「显式消费不得融合」落成三条可检查要求 | §2 命令 4、5 |
| **D** 用今天的事实 | **§5**（整节） | 十个固定名（不是四个）；4→7→10 两笔都在 2026-08-02；五段临时名以源码为准；L5 deletion 授权**写成有限定表述**（§5.3） | §2 命令 6、7、9、10、11 |
| **E** 无法证明兑现的防线 | **§6** => **RISK-1** | 五份门报告 `.md` 全为 0；该函数零生产调用者、仍 export。§6.2 明写 L5 不得再依赖同型防线，§8.2 把每条不变式落成会变红的测试 | §2 命令 12、13 |
| **F** 就地勘误 | 07-29 §10 第 4 条 ＋ 本 spec **§9** | 只改数字不改结论；21 插入 / 0 删除 | §2 命令 8 |
| **G** 继承项指针 | **§7** | 只放指针指向 `2026-08-05-l5-input-scan/progress.md`，**刻意不重述内容**，并把「不造第三份清单」的理由写进正文 | — |

体例：按 brief §5 用了 `> Status: / > Scope: / > Parent design:` 形状，
**未写 `Amendments:` 总账**（新文件今天零修订，写空总账会埋一条会腐坏的计数）。
正文语言取中文，与起点文档（07-29）及兄弟层 L3（08-01）一致；英文原文逐字引用处保留英文。

--------------------------------------------------------------------------------
## 2. 我自己核实过的事实清单（命令 + 输出，未过滤）
--------------------------------------------------------------------------------

**命令 1** —— `grep -rn 'releaseOwnerLease' src/ tests/`
```
src/controller/leaseHeartbeat.ts:16:  releaseOwnerLease,
src/controller/leaseHeartbeat.ts:254:      await releaseOwnerLease(options.runDir, expected);
src/persistence/fileStore.ts:1175:export async function releaseOwnerLease(runDir: string, expected: OwnerRecord): Promise<void> {
tests/controller/leaseLifecycle.integration.test.ts:233 / :266 / :790 / :1605（均为注释）
tests/persistence/leaseStore.test.ts:9 / :92 / :96 / :116
```
`awk` 取包围函数：`239:  const stop = async (): Promise<void> => {` 是 :254 之前最近的 `const` 箭头函数声明。
⚠️ **brief 写的是「`leaseHeartbeat.ts:16`」而未给目录**，实际路径是 `src/controller/`，不是 `src/runtime/`。

**命令 2** —— `grep -n '^## ' .../2026-07-22-ownership-and-reconciliation-boundaries-design.md`
→ 18 条，`375:## 17. Follow-On Specs Required`。§17 item 3 逐字：
`**Cleanup / orphan handling design** — how superseded or lost-owner workspaces and evidence are retained or cleaned up safely.`

**命令 3** —— `grep -n '^## ' .../2026-07-21-stop-no-progress-stale-boundaries-design.md`
→ 16 条，`290:## 13. Cleanup Is Not Part of This Layer`、`334:## 15. Follow-on Specs Required`。
`sed -n '290,305p'` 实测 :297 `but they may not treat “stale” as permission to delete them.`、
:299 `Later cleanup design must consume stale/reconciliation output explicitly rather than being fused into it.`
—— **与 brief 给的两句逐字一致，行号也一致。**
⚠️ 原文用的是**弯引号** `“stale”`，不是直引号；spec 内已按原样保留。

**命令 3b（对照）** —— `grep -n '^## ' .../2026-07-28-run-registry-design.md`
→ **15 条，末条 `567:## 15. Success Criteria`。brief 所述「该文件止于 §15」属实，无 §17。**

**命令 4** —— `grep -rn 'cleanupStatus' src/`
```
src/runtime/types.ts:67:  cleanupStatus: "retained" | "removed";
src/controller/runLoop.ts:328 / :526 / :536 / :1225 / :1232 / :1237
```
**命令 5** —— `grep -rn 'workspace_cleanup_failed' src/` → `src/controller/runLoop.ts:334:      type: "workspace_cleanup_failed",`（仅 1 行）

**命令 6** —— `awk '/^async function cleanupOwnerTransferStagingWithoutMarker/,/^}/' src/persistence/fileStore.ts | grep -c "await safeUnlink"` → **`10`**
函数体实测十个名字全部来自同一次 `getOwnerTransferPaths(runDir)` 解构。

**命令 7** —— `git log --format='%h %ad %s' --date=short -1 <sha>`
```
0f940ea 2026-08-02 feat(fileStore): publish the transaction marker and both pendings by temp+rename
dad8a14 2026-08-02 feat(fileStore): make reconciliation-record.json the third file of the owner-transfer transaction
2e30d1c 2026-08-01 docs: finish the reference sweep 9e554ce claimed to have finished
```

**命令 8** —— `git diff --numstat -- .../2026-07-29-atomic-write-paths-design.md` → `21	0	...`
`git diff -U0 ... | grep '^-[^-]'` → `(no deletions)`。**原句一字未动，确证。**

**命令 9** —— `grep -c "Amended" .../2026-07-29-atomic-write-paths-design.md` → **`0`**（在我落勘误**之前**）。
⚠️ 我落勘误后该计数不再是 0；spec §5.1 已明写这个时序，未把过期计数写死。

**命令 10** —— `buildAtomicTempPath` ＋ `ATOMIC_TEMP_PROCESS_STAMP` 源码实测：
```
610:const ATOMIC_TEMP_PROCESS_STAMP = `${process.pid}.${Math.trunc(performance.timeOrigin)}`;
632:    `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${atomicTempPathSequence}.tmp`,
```
=> 落盘名**五段**：`.{basename}.{pid}.{timeOrigin}.{seq}.tmp`。
**§10 第 4 条的五段形正确**；台账/handoff 的四段 `{stamp}` 形描述的是**模板**（模板确有 4 个插值），
不是落盘文件名 —— stamp 自己展开成两段。spec §5.2 已写清引的是哪一种。

**命令 11** —— `grep -n 'cleanup / orphan GC' .../2026-07-26-run-lease-and-heartbeat-design.md`
→ `41:| L5 | cleanup / orphan GC | deletion |`。**行号 41 与 brief 一致。**
同文件另有逐字句 `L5 corresponds to the third follow-on spec named in the ownership design §17 and remains unwritten.`

**命令 12** —— `grep -rc 'writeOwnerTransferRecord' $(find .superpowers/sdd -iname '*gate*' -type f)`
```
2026-08-05-l5-input-scan/scan-C-backoff-and-gate-carries.md:0
2026-08-02-.../gate-c-fix-wave-report.md:0
2026-08-02-.../gate-a-package-src-and-plan.diff:0
2026-08-02-.../gate-a-option2-report.md:0
2026-08-02-.../gate-c-lane2-report.md:0
2026-08-02-.../gate-b-lane2-report.md:0
2026-08-02-.../gate-a-package-tests.diff:14
2026-08-02-.../gate-a-fix-wave-report.md:0
```
**五份门报告（`.md`）全部为 0**；唯一非零的是一份测试 diff，不是门报告。**brief 此项属实。**

**命令 13** —— `grep -rn 'writeOwnerTransferRecord' src/ tests/`
→ `src/` **仅 1 行**（`fileStore.ts:689` 定义，零生产调用者，仍 `export`）。
`tests/` 一侧的计数**须先给判别式**（修复环 1 重跑，原「22」在两个判别式下都不成立）：
`grep -ro 'writeOwnerTransferRecord' tests/ | wc -l` → **23**（符号出现）；
`grep -ro 'writeOwnerTransferRecord(' tests/ | wc -l` → **21**（调用点）；
差额 2 = 两处 import（`fileStore.test.ts:23`、`zeroWrite.test.ts:22`）。**即 23 = 2 import + 21 调用。**

--------------------------------------------------------------------------------
## 3. 我的 concern
--------------------------------------------------------------------------------

**C1（brief 任务 E 的一句前提不准确，已原样上报，未自行改判据）**
> ⚠️ **Amended 2026-08-07（修复环 1）**：本条原写「22 处调用」，**该数字错误**，
> 在两个判别式下都不成立 —— 符号出现 **23**、调用点 **21**、差额 2 为两处 import。
> 详见下方「修复环 1」I2。**本条结论（全是 fixture、无一断言那条约束）经复核仍为真。**

brief 逐字写「今天该函数**零生产调用者、仍 `export`、无任何测试或 lint 钉住它**」。
前两项实测属实；**第三项「无任何测试」不准确** —— `tests/` 里有 **21 处**调用（命令 13，判别式见修复环 I2）。
准确的说法是：**这 21 处调用全部是把它当 fixture 用于构造场景，没有任何一处断言 §10 第 3 条那条约束本身**
（「生产不得走这个函数」）。「无测试」与「无测试钉住那条约束」是两回事。
我在 spec §6.1 按**后者**写，并显式标注了这一区分，**没有沿用 brief 的措辞**。
这不影响任务 E 的结论（RISK-1 依然成立，且成立得更精确）。

**C2（brief 的一处路径不精确，影响很小）**
brief 把调用点写成 `leaseHeartbeat.ts:16` / `:254` 而未给目录，实际是 `src/controller/leaseHeartbeat.ts`。
我最初按 `src/runtime/` 读，`sed` 报 no such file。行号本身准确。

**C3（我落的勘误使 brief 表格里的一个数字过期，已在 spec 内处理）**
brief 任务 D 表格列了 `grep -c "Amended"` → **0**。这个数字在我落勘误**之后**不再成立。
我没有把它写死进 spec，而是在 §5.1 明写「必须带上在哪个提交上测的」。
**提醒控制器：后续任何人引用这个 0 都要先确认基线提交。**

**C4（本 spec 使一份既有文档的一句话过期，我无授权去改）**
`2026-07-26-run-lease-and-heartbeat-design.md` 逐字写着 L5 `remains unwritten`。
**本文落盘后该句后半不再成立。** 我无授权改那份文档，已在 spec §2.1 就地记明，
**留给控制器决定是否派一条就地勘误。这是本轮新产生的文档债，不是我发现的旧债。**

**C5（我未找到功能性破坏路径 —— 定性未被升级）**
按 brief 要求我特别找过：临时文件残留是否存在功能性破坏路径。**没找到。**
`RUN_MARKER_FILES` / `OBSERVED_FILES` / `ensureFreshRunDir` 三条路径我均按起点文档的论证方向复核，
未发现反例。**§10 第 4 条「无界垃圾，不是故障」「不要把它上报成缺陷」的定性，spec 原样承接、未升级。**
spec §5.4 明写立项理由是两份委任状点名，**不是「有缺陷要修」**。

**C6（分层表授权，已按扫描员的限定写）**
§5.3 写成「只能证『只有 L5 被**显式标注**为 deletion』，不能证『只有 L5 可能删东西』」，
并保留了 `git worktree remove --force` 这个反例。**未写成无限定全称断言**，
且把它落成了一条真实的设计后果（§4.4：L5 不得假设自己是唯一删除者，删前必须重新观测）。

**C7（token 预算已超，按 Rule 6 明写不静默超支）**
CLAUDE.md Rule 6 的每任务 12,000 token 预算**已被突破**。主因是一条本可避免的操作：
我用 `for f in ...; do head -1 "$f"; done` 想看各 spec 标题，rtk 代理**把输出折叠成了 `[N more lines]`**,
迫使我改用 `rtk proxy` 重跑，而重跑命中了 `2026-08-01` 那份 3045 行的 spec，一次返回了上百行。
**教训（值得进规矩）**：本仓库禁止过滤验证输出，而 `rtk` 的默认改写本身就会折叠输出 ——
**做验证性检索时应直接走 `rtk proxy`，否则拿到的是被过滤过的证据。**

--------------------------------------------------------------------------------
## 4. 我没做完的事
--------------------------------------------------------------------------------

1. **§8.2 那五条验收测试一条都没写。** 本轮无 `tests/` 授权（人裁 6 / Q2）。
   spec §8.2 已用 ⚠️ 明写「上表是**要求**，不是已完成事项，本 spec 落盘时这五条测试一条都不存在」。
   **不要把 §8.2 读成已有护栏。**
2. **INV-1 今天没有任何机制强制。** 它现在的地位与 §10 第 3 条那条注释**完全同型**
   —— 即 §6 记为 RISK-1 的那个形状。我把它写成了不变式并给了验收判据，
   **但在 L5 实现落地前，它自己就是一条「无法证明兑现」的防线。这是本 spec 最大的自身弱点，明写在此。**
3. **保留时长未定**（§3.3 只定了判据形状，没定数字）—— 有意为之，理由已写进 spec，但确实是缺口。
4. **L5 的触发形态未定**（§8.1 非目标 6）—— 取决于 L4。
5. **§1.4 那条耦合我只记录、未决策。** 「§13 第 3 笔 ＋ 保留即放宽人裁必须一起决策」
   需要一次人裁，**不在本任务授权内**。⚠️ 这条是上一轮四份扫描与两条评审车道都漏掉的，
   **建议控制器单独立项，不要让它随本 spec 一起被当成「已处理」。**
6. **C4 那条新产生的文档债未修**（无授权）。
7. **我没有独立复核扫描员 2 报告 §4 里「四条以上『不许删』约束」的全部条目。**
   brief 任务 C 要求「去读，逐条核」。我核实并写进 spec §3.2 的是四类保留面，
   其依据是**两份委任状的逐字原文 ＋ `cleanupStatus` 的源码实测**，
   **不是对扫描员 2 报告 §4 的逐条复核** —— 那一步我因预算已破而跳过了。
   **若评审员要验 §3.2 的完备性，这是我证据链最薄的一处，请优先撞这里。**

--------------------------------------------------------------------------------
## 5. 修复环 1/5 —— 处置
--------------------------------------------------------------------------------

评审结论 0 Critical / 2 Important / 5 Minor，判可合入。本轮按控制器指定**只修三条**
（I1 / I2 / M4），**其余 4 条 Minor 一字未动**，留给整分支评审分诊。
`src/` 与 `tests/` 仍一字未动。提交为**另起一笔**，未 amend `fbeb6fd`。

### I1（Important）—— 闭合清单语气 → 默认拒绝　**已修，且按建议改了语气本身**

**我先独立复核了前提，全部成立**：
- `grep -c 'stash\|backup\|validation-runs'` 对首版 spec → **0**（三类确实读不出禁止）。
- 扫描员 2 §4.3 的 6 条约束我**逐条回原文重验**，引文逐字准确：
  - `docs/superpowers/plans/2026-07-17-evidence-first-v1-validation.md:19`
    `Never delete prior run directories, retained worktrees, stashes, or evidence. Every retry gets a new run ID.`
  - `docs/superpowers/specs/2026-07-21-docs-and-backlog-truth-alignment-design.md:54`
    在 `This pass does not include:` 清单内：``deletion or mutation of `.validation-runs/`, backup branches, or stashes;``
  - `docs/superpowers/specs/2026-07-19-a04-branch-assessment-and-merge-readiness-design.md:55/:57`
    `preserved real-run evidence ... must not be cleaned or rewritten;`、
    `backup branch backup/evidence-first-v1-before-memory-history-cleanup and retained stashes must not be deleted or published;`
  - `2026-07-21-...-stale-boundaries-design.md:231` `- silently clean up retained evidence or workspaces;`

**修法（采纳了「同时改掉闭合语气本身」这条建议，没有只补三类）**：
1. §3.2 重构为 §3.2.1 + §3.2.2，新增承重规则 **INV-4：L5 只允许删除 §4.2 明确授权的那一个面，
   其余一切默认保留**。理由写进正文：**保留清单漏一项 = 数据丢失，授权清单漏一项 = GC 少干活，
   两种错误代价不对称**，故把完备性压在只有一个面的授权侧，而不是压在会漏的保留侧。
2. §3.2.2 补入第 5–7 条（三类既有保留物），并**明写它是下界非穷举**，
   逐字标注**我的检索面未覆盖 `tests/` / `validation/` / `reference/`**，也未穷举 `docs/`。
3. §4.5 同样去掉清单语气，改成「问『§4.2 授权了吗』，不是『§4.5 提到了吗』；
   **§4.5 没提到不构成授权**」。

⚠️ **我没有写下「已覆盖全部」这类断言**，§3.2.2 末段逐字写着
「第 5–7 条只把下界抬高了，没有把它变成上界」。

### I2（Important）—— 计数错误，两处同错　**已修**

独立重跑，两个判别式：
```
grep -ro 'writeOwnerTransferRecord' tests/ | wc -l    → 23
grep -ro 'writeOwnerTransferRecord(' tests/ | wc -l   → 21
```
差额 2 为两处 import（`tests/persistence/fileStore.test.ts:23`、`tests/registry/zeroWrite.test.ts:22`）。
**控制器所报数字全部复现，我原写的「22」在两个判别式下都不成立。**

修法：spec §6.1 改为**先给判别式再给数字**（23 = 2 import + 21 调用），正文取 **21 处调用**，
并就地加一条 `Amended 2026-08-07` 记明坏的只是数字、RISK-1 结论未变。
**报告 C1 那处也已就地勘误**（见 §3 C1 顶部）。

### M4（Minor，控制器折入）—— INV-1「今天零强制」搬进 spec　**已修**

复核前提：`grep -n '零强制\|没有任何机制强制'` 对首版 spec → **exit 1，零命中**，属实。

修法：在 §1.3 末尾就地补入一段，逐字写明 INV-1 **今天没有任何机制强制**、
**与 §6.1 那条注释完全同型**、**本文无法宣称自己免疫于它所批评的问题**，
并给出诚实表述「本 spec 是约束的载体，不是约束的执行机制」。
`grep -c '没有任何机制强制'` → **1**，缺口已具名。

### 我自己在修复正文里发现并修掉的一处缺陷

本仓库记录「十六波修复十六次自带缺陷，没有一次是作者自己发现的」。本轮自查发现一处并已修：
§3.2.2 第 6 条我最初把含反引号的原文嵌进反引号内
（``` `deletion or mutation of `.validation-runs/`, ...` ```），**嵌套反引号会破坏 Markdown 渲染**。
已改为块引用。**这不是事实错误，是渲染缺陷** —— 但按本仓库标准，引文渲染坏了就等于引文不可核。

### 一致性自查（改完之后跑的）

- `grep -n '四类'` → 仅 1 处，位于 §3.2 解释「首版曾写成四类」的历史陈述，**是有意保留的**。
- `grep -n '22 处\|22处' <spec>` → **仅 1 处**（`:467`），位于 I2 的勘误注内，**是有意保留的历史陈述**。
  ⚠️ 本条最初写成「仅 1 处」而未限定检索面 —— 加上本报告后全仓共 **3 处**
  （spec `:467`、报告 `:129` 勘误注、本行自身）。**这是我在自查里写下的第二个无限定断言，
  已就地限定检索面。**（本仓库铁律：下全称/计数断言前先确认 grep 面覆盖断言范围。）
- `grep -c 'TBD'` → 0。
- `git status --porcelain -- src/ tests/` → 空。

### 我不同意 / 需要控制器注意的

**无不同意项** —— 三条判定我都独立复核，前提全部成立，未发现判错。

但有两点请注意：
1. **I1 修完之后，spec 的完备性依赖点转移了。** 原来依赖「§3.2 那张表是否列全」，
   现在依赖「**§4.2 那个授权面是否描述准确**」。这是**有意的**收窄（一个面比一张开放清单可穷举），
   但它意味着**下一轮评审应该去撞 §4.2，而不是继续撞 §3.2**。
2. **INV-4 是本轮新增的不变式，它没有进 §8.2 的验收表。** 我没有动 §8.2，
   因为控制器只授权修三条、且 §8.2 属于未被点名的部分。
   **这是一个我知道存在、但本轮有意未修的缺口，明写在此**，请控制器决定是否在后续轮次补。
