# 独立评审 —— 包 1 任务 1（L5 cleanup / orphan GC spec ＋ §10 第 4 条勘误）

> 评审员：未参与本轮任何一条。评审范围 `git diff 9f78169..fbeb6fd`（2 files / +503 −0）。
> 立场：不接受实施者自证，每句都自己拿命令验。

## 0. 结论（分级）

### **0 Critical / 2 Important / 5 Minor**

**总判**：可合入。承重断言我逐条独立重跑，**没有一条被证伪**。勘误**未越界、未过度勘误**（机械判据成立）。
定性**未被升级**。分层表**未被写成全称断言**。C4 处置**正确**。
两条 Important 都落在**完备性**上，不落在**正确性**上 —— 且其中一条正是实施者自己在报告 §4 第 7 条
点名请人来撞的那一处。

| # | 级别 | 一句话 |
|---|---|---|
| **I1** | Important | §3.2「四类默认保留」是**封闭枚举**，漏掉扫描员 2 报告 §4.3 逐条点名的既有「不许删」实体（**retained stashes / backup 分支 / `.validation-runs/` 下的 preserved evidence**）；全份 spec 对 `stash`、`backup`、`validation-runs` **零命中**，§4.5 的「非授权删除面」也只回指 §3.2 四类 + run 目录 + `worktrees/`。 |
| **I2** | Important | `writeOwnerTransferRecord` 在 `tests/` 的计数**报错了**：spec §6.1 与报告 C1 都写「**22 处调用**」，两个判别式下**都不是 22**（grep 行数 = **23**，调用形 = **21**）。承重措辞「全是 fixture、没有一处断言那条约束本身」经我复核**为真**。 |
| **M1** | Minor | §1.1 展示 `grep -rn 'releaseOwnerLease' src/ tests/` 却**只列 3 行**，把 `tests/` 的 7 行压成一句括注，且括注里「`leaseStore.test.ts` 的 **3 处**」与实测 **4 处**不符。承重结论（`src/` 内唯一调用点）**属实**。 |
| **M2** | Minor | §6.1 称那条注释「**逐字首句**是 `// Production must publish owner-transfer.json only through finalizePendingOwnerTransfer.`」——该注释块的首句实为 `// NOT atomic: this goes through the bare writeJsonFile, so a concurrent reader can observe a` |
| **M3** | Minor | §6.1「五份 L3 门报告」的判别式是 `find .superpowers/sdd -iname '*gate*'`，只覆盖**文件名含 gate** 者；它自己展示的输出里有 **6 个 `.md`**，spec 只排除了那个 `.diff`，没排除混进来的 `scan-C-backoff-and-gate-carries.md`。结论我复核成立，但呈现的判别式撑不起「五份」这个数。 |
| **M4** | Minor | INV-1 的「今天没有任何机制强制」这句**只写在实施者报告 §4 第 2 条，没有写进 spec §1**。§1.3 就地只说了「仅靠代码评审兜住不够」，读者要读到 §6/§8.2 才知道它今天是纯纸面。 |
| **M5** | Minor | C4 处置正确但**债未清**：`2026-07-26-…-design.md:45` 那句今天仍无任何指向本文的指针 —— 恰是 §7 自己拿来立论的「两份清单彼此无指针」形状。本轮**亲手造出了一条同型债**，控制器不派单它就会腐坏。 |

**我判 INV-1 的自指弱点在一份 spec 里可接受**（详见 §1.2），理由与「怎么写才算诚实」的判据一并写在那里。

## 1. 优先撞的五处

### 1.1 §3.2 四类保留面 vs 扫描员 2 报告 §4 → **I1（Important）**

实施者报告 §4 第 7 条自认：**没有逐条复核扫描员 2 报告 §4**。我替他做了。

`scan-2-design-input.md` §4.3「既有的『不许删』类约束」列了 **6 条**。我逐条回原文核实，
**6 条全部真实存在且引文逐字准确**（未过滤输出）：

| scan-2 §4.3 条目 | 我的复核 | spec 里有没有 |
|---|---|---|
| 07-21 §10.2 `- silently clean up retained evidence or workspaces;` | 成立（`grep -n` → `:231`） | ✗ **零引用** |
| 07-21 §13（stale ≠ 删除许可 ＋ 显式消费） | 成立（`:296`–`:299`） | ✓ INV-2 / INV-3 |
| 07-21 §15 item 3（第二份委任状） | 成立（`:334` 起） | ✓ §2.2 |
| `plans/2026-07-17-evidence-first-v1-validation.md:19` 逐字 `Never delete prior run directories, retained worktrees, stashes, or evidence.` | 成立 | **部分**：run 目录与 worktrees 在 §4.5；**stashes 无** |
| `specs/2026-07-21-docs-and-backlog-truth-alignment-design.md:54` 逐字 `deletion or mutation of `.validation-runs/`, backup branches, or stashes;` | 成立 | ✗ **零引用** |
| `specs/2026-07-19-a04-…-design.md:57` 逐字 `backup branch `backup/evidence-first-v1-before-memory-history-cleanup` and retained stashes must not be deleted or published;` | 成立（同文 `:55` 另有 `preserved real-run evidence lives only under `.worktrees/evidence-first-v1/.validation-runs/` and must not be cleaned or rewritten;`） | ✗ **零引用** |

全份新 spec 对三个关键词**零命中**（未过滤）：

```bash
grep -in "stash"           docs/superpowers/specs/2026-08-07-cleanup-and-orphan-gc-design.md   # 无输出
grep -in "backup"          docs/superpowers/specs/2026-08-07-cleanup-and-orphan-gc-design.md   # 无输出
grep -in "validation-runs" docs/superpowers/specs/2026-08-07-cleanup-and-orphan-gc-design.md   # 无输出
```

**为什么这是缺陷而不是「详略取舍」**：§3.2 的引导句逐字是
「按 §2 两份委任状，**以下四类默认保留**」，§4.5 逐字是
「以下**不在**本 spec 授权范围内，L5 不得删：§3.2 的四类保留面、任何 run 目录本身、任何 `worktrees/` 下的条目」
—— **两处都是闭合清单的语气**，读者拿它当完备表用是**正确的读法**。

*** **可构造的场景** ***：L5 实现者按 §3.2 ＋ §4.5 办事，为「回收一个 orphan run 留下的残留面」
去清理 `backup/evidence-first-v1-before-memory-history-cleanup` 分支或与之配套的 retained stash
（这两者恰恰是本仓库**唯一**明文点名保护的两类**非 run 目录内**实体）。
他会发现 spec 里读不出任何禁止 —— 而三份既有文档逐字禁止此事。
本仓库已有先例证明 GC 会伸手到 git 层：`git worktree remove --force`。

**修法建议（不代改）**：§3.2 加第 5 类「**run 目录之外的既有受保护实体**」，
或在 §4.5 加一句「本表不穷尽；`docs/` 下另有若干逐条点名的『不许删』约束，见 `scan-2-design-input.md` §4.3」——
后者与 §7「只放指针」的体例一致，成本一行。

**同时记一条观察（不单列 finding）**：scan-2 §4.2 对包 1 下过一句逐字指令 ——
`cleanupAttemptWorkspace` = `git worktree remove --force`，「**`--force` 会连未提交的改动一起丢弃** ……
**包 1 设计 L5 时不能假装这条已有行为不存在**」。spec **两次**引用 `git worktree remove --force`
（§4.4、§5.3），但**两次都是当「删除授权非全称」的反例用**，没有一处承接那条 evidence-safety 张力。
我**不**单列 finding：§3.2 第 4 类 ＋ §4.5 把 `worktrees/` 整体排除出 L5 授权，
实质上化解了 **L5 自身**的暴露；该张力属于既有行为、归继承项，§7 已给出指针。

### 1.2 INV-1 无强制机制 —— 自指弱点 → **判：在一份 spec 里可接受；本份写法基本达标，差一句 → M4**

**这个自指是真的。** INV-1 今天的地位与 §10 第 3 条那条「靠人评审兜住」的注释**同型**，
而 §6 的 RISK-1 正是在把这个形状记为风险。实施者自己在报告 §4 第 2 条逐字承认了。

**我的裁断：可接受。** 判据是「一份 spec 能不能强制什么」——
spec 是**约束的载体**，不是**执行机制**；一份只定边界、不落代码的 spec 里，
所有不变式在实现落地前**必然**都是纸面的。要求 spec 自带强制力等于要求它不是 spec。
**真正可判的是：它对自己这个状态诚不诚实。**

**怎么写才算诚实 —— 三条判据，本份过了两条半：**

1. ✅ **给出可证伪的验收判据，而不是停在「不得」。** §8.2 的 INV-1 行逐字带了一条 **mutation 式**判据：
   「断言 owner-record 的租约字段**零写入**。**把该断言删掉后测试必须变红**」——
   这一句把「哪条测试会变红」问死了，正是 §6.2 自己立的标准。
2. ✅ **明写这些护栏今天不存在。** §8.2 表下 ⚠️ 逐字：「上表是**要求**，不是已完成事项 ——
   **本 spec 落盘时这五条测试一条都不存在**」。这条自我否定写得比多数评审要求的更狠。
3. ⚠️ **就地标注，而不是让读者跨节拼装。** §1.3 就地只写了「⚠️ 仅靠代码评审兜住这一条是不够的，
   理由见 §6」—— 它说的是「评审不够」，**没说「今天连评审都没有、什么机制都没有」**。
   *** 可构造的场景 ***：只读 §1（本 spec 明令排在第一位、最可能被单独引用的一节）的读者，
   会带走「INV-1 是本 spec 的一条不变式」这个印象，而不会带走「它今天零强制」。
   → **M4**：建议 §1.3 就地补一句自我限定（例如「本条今天没有任何机制强制，它自己就是 §6 RISK-1
   的一个实例；实现落地前不要把它读成护栏」）。这句实施者已经在**报告**里写出来了，
   只是**没写进 spec** —— 而报告不随文档流通。

### 1.3 503 行新增里的事实断言逐句核

我把两份新增里的**事实断言**（可被命令重推者）全部拉出来独立重跑。**未过滤输出**。

| spec 处 | 断言 | 我的重推 | 判 |
|---|---|---|---|
| §1.1 | `releaseOwnerLease` 在 `src/` 内仅三行：`fileStore.ts:1175` 定义、`leaseHeartbeat.ts:16` import、`:254` 唯一调用 | `grep -rn 'releaseOwnerLease' src/ tests/` 逐字复现三行，`src/` 内无第四行 | ✅ |
| §1.1 | 「其余命中全在 tests/：leaseLifecycle 4 处注释、leaseStore **3 处**」 | leaseLifecycle `:233 :266 :790 :1605` **确均为 `//` 注释**（4 ✅）；leaseStore `:9 :92 :96 :116` = **4 处，不是 3** | ❌ **M1** |
| §1.1 | `:254` 落在 `const stop = async (): Promise<void> => {` 体内 | 已读源码，成立 | ✅ |
| §2 | `2026-07-28-run-registry-design.md` 止于 §15，末条 `567:## 15. Success Criteria` | `grep -n '^## '` 输出 15 条，末条逐字一致，**无 §17** | ✅ |
| §2.1 | 07-22 §17 在 `375`，item 3 逐字 | `sed -n '375,386p'` 逐字一致，且 **item 3 确为第三条** | ✅ |
| §2.1 | 07-26 逐字 `L5 corresponds to the third follow-on spec named in the ownership design §17 and remains unwritten.` | `grep -n` → `45:` 逐字一致 | ✅ |
| §2.2 | 07-21 `290:## 13. Cleanup Is Not Part of This Layer`、`334:## 15. Follow-on Specs Required`；§13 逐字在 `:296`–`:299` | 全部逐字一致，**含 §13 那两句的行号区间精确** | ✅ |
| §3.1 | `cleanupStatus` 的 7 行 grep 输出、`workspace_cleanup_failed` 的 1 行 | 逐行逐字复现，**一字不差** | ✅ |
| §4.2 | `ensureFreshRunDir` 只挡 `loop-contract.json`/`loop-state.json`/`events.jsonl` ＋ `attempts/`、`worktrees/` 目录条目 | 读全函数体，成立 | ✅ |
| §5.1 | 固定名 **10** 个，全部来自同一次 `getOwnerTransferPaths(runDir)` 解构，十个名字逐字 | 读全函数体，**十个名字逐字全对，顺序也对** | ✅ |
| §5.1 | 4 → 7（`0f940ea`）→ 10（`dad8a14`），两笔都在 2026-08-02 | 逐提交重数：`0f940ea~1`→**4**、`0f940ea`→**7**、`dad8a14~1`→**7**、`dad8a14`→**10**、`HEAD`→**10** | ✅ |
| §5.1 | 起点文档最后一次被碰 `2e30d1c` 2026-08-01，在那两笔**之前** | `git log … fbeb6fd~1 -- <file>` 首条即 `2e30d1c 2026-08-01`，成立 | ✅ |
| §5.1 | 「`grep -c "Amended"` 的 0 是**基线相关**的，引用必须带提交」 | 这是本份里我最欣赏的一句 —— 它主动给自己引入的计数腐坏打了补丁 | ✅ |
| §5.2 | 源码块逐字 ＋ 「实际生成的名字是五段」＋「起点文档的五段形与源码一致」 | `fileStore.ts:610/628-634` 逐字一致；`startTime` ≡ `Math.trunc(performance.timeOrigin)` 成立 | ✅ |
| §5.3 | `41:\| L5 \| cleanup / orphan GC \| deletion \|` | `grep -n` 逐字一致 | ✅ |
| §5.4 | 起点文档逐字两句「定性要准确：这是无界垃圾，不是故障。」「不要把它上报成缺陷。」 | `grep -n` → `310:` 与 `313:`，**逐字一致** | ✅ |
| §6.1 | §10 第 3 条逐字 | 起点文档第 3 条逐字一致 | ✅ |
| §6.1 | 「那条注释**逐字首句**是 `// Production must publish …`」 | 该注释块首句实为 `// NOT atomic: this goes through the bare writeJsonFile, so a concurrent reader can observe a`；被引句是块内**第 5 行** | ❌ **M2** |
| §6.1 | 五份门报告 `grep -rc` 全 0，唯一非零是 `.diff` | 输出逐行复现，**一字不差**；但判别式覆盖面见 **M3** | ⚠️ |
| §6.1 | `tests/` 内 **22 处调用** | **21**（调用形）／**23**（行） | ❌ **I2** |
| §6.1 | `src/` 内仅 `fileStore.ts:689` 定义、无生产调用点 | `grep -rn` 成立 | ✅ |

*** **结论：全部承重断言经独立重推成立；三处不实全部落在旁注与计数上，无一条动摇结论。** ***
包 3 那种「勘误正文自引入不实描述、且与兄弟勘误自相矛盾」的形状，**本轮没有复现** ——
我另外做了自洽性检查：§4.2 的「十个，见 §5.1」、§5.1 的「已由本轮勘误修正，见 §9」、
§9 的「依据见 §5.1 / 理由见 §4.2」、勘误正文的「参见 …§5.1 与 §4.2」**四处交叉引用互相闭合，节号全部存在且指对**。

### 1.4 那条勘误有没有越界 / 过度勘误 → **没有。两项都没有。**

**机械判据（本仓库口径）**：

```bash
git diff --numstat 9f78169..fbeb6fd
# 21	0	docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md
# 482	0	docs/superpowers/specs/2026-08-07-cleanup-and-orphan-gc-design.md
```

*** **删除列恒为 `0` ⇒ 原件一字未被改写。** *** 「原句一字不动、就地加注」这条体例**守住了**。

**没有过度勘误 —— 三项证据：**

1. 勘误正文逐字自限：「**坏的只是数字，本条的结论不变**」，并给了为什么结论不变的论证
   （进程戳 ＋ 自增序号 ⇒ 不可能落在任何固定名集合里）—— 即 brief 要证的事**被明确保住**，没被顺手推翻。
2. 逐字写「**本条其余部分（含下段的定性）未作改动**」，且我核对 diff：
   `310:` 与 `313:` 那两行定性文字**不在 diff 里**，未被触碰。
3. 插入位置是「四个固定名」那句之后、定性段落之前，**没有把定性段落切开**。

**勘误正文自身引入的新事实断言我也逐条重推**（brief 明令「注文本身也是断言」）：
`10` ✅、`4→7→10` ✅、`0f940ea`/`dad8a14` 的哈希 + 日期 + 提交标题**逐字** ✅、
`2e30d1c` 2026-08-01 ✅、`ATOMIC_TEMP_PROCESS_STAMP` = `` `${process.pid}.${Math.trunc(performance.timeOrigin)}` `` 与
`fileStore.ts:610` **逐字一致** ✅、「一个自增序号」= `atomicTempPathSequence += 1` ✅。
**`Amended 2026-08-07` 的日期**与提交日历日一致（`fbeb6fd` = `Fri Aug 7 01:14:42 2026 +0800`）✅。

**零 finding。**

### 1.5 重建 `writeOwnerTransferRecord` 在 tests/ 的计数 → **I2**

控制器数「23 行」、实施者报「22 处调用」，两方口径未互验。**我先定判别式，再跑命令，输出未过滤。**

**判别式 A —— 「`tests/` 下含该符号的行数」**（＝控制器口径）：

```bash
grep -ro 'writeOwnerTransferRecord' tests/ | wc -l
#       23
```

**判别式 B —— 「调用点」，即出现形态为 `writeOwnerTransferRecord(` 者**（＝实施者自称的口径）：

```bash
grep -ro 'writeOwnerTransferRecord(' tests/ | wc -l
#       21
```

逐行（`grep -ron 'writeOwnerTransferRecord(' tests/`，全量、未过滤）：

```
tests/controller/runLoop.integration.test.ts:2290 / :2458
tests/persistence/fileStore.test.ts:102 /:250 /:313 /:388 /:449 /:509 /:558 /:1878 /:1994
                                   /:2088 /:2147 /:2221 /:2357 /:2443 /:2601 /:2657
tests/registry/zeroWrite.test.ts:117 /:165 /:170
```

23 − 21 = 2，差额恰是两处 **import**（`tests/persistence/fileStore.test.ts:23` 的具名导入成员、
`tests/registry/zeroWrite.test.ts:22` 的 `import { readOwnerRecord, writeOwnerRecord, writeOwnerTransferRecord }`）。

**裁断**：
- **控制器的 23 成立**（判别式 A）。
- *** **实施者的 22 在两个判别式下都不成立** ***：行数是 23，调用点是 21。他在 spec §6.1
  与报告 C1 两处都写了「22 处」，且 spec 里那句紧挨着承重措辞，故记 **Important**。
- 这不是「行号腐坏」类误差 —— 它是一个**当场就能重推、却没重推**的数字。

**「全是 fixture，没有一处断言那条约束本身」是真是假 —— 判为真。**
`tests/` 下含该符号的 23 行**全部**是：2 处 import ＋ 21 处 `await writeOwnerTransferRecord(runDir, …)`
形态的场景构造调用。**没有任何一行是断言**（没有 `expect`/`assert` 直接作用于该符号，
也没有任何一处在断言「生产不得走这个函数」）。源码注释也自证同一事实，逐字：
`// It exists only to build test fixtures — every call site is under tests/ (fileStore, runLoop.integration, registry/zeroWrite); production has none.`
⚠️ **我验到的覆盖面**：判别式 = 「`tests/` 下逐字含 `writeOwnerTransferRecord` 的行」。
**一条不提该符号却仍钉住那条约束的测试（例如某种 AST/lint 式检查），我没验** —— 见 §「我没做完」。

## 2. 规格符合性（brief 七件事 A–G ＋ 授权面）

| 任务 | 要求 | 落点 | 判 |
|---|---|---|---|
| **A** | 第一节必须是 P1；P1 写成不变式 | §1（**确为第一节**），INV-1 逐字「L5 的 GC 不得调用 `releaseOwnerLease`，也不得以任何其它方式写 owner-record 的租约字段」；§1.4 单列了那条耦合 | ✅ |
| **B** | 两份委任状、逐字引用、**自己核实路径与节号** | §2.1 ＋ §2.2，两份逐字引文我全部回原文比对**一字不差**；且他主动复现了「07-28 止于 §15」这个反例 | ✅ |
| **C** | `retained` 写成完整的一半 | §3 整节（4 小节、含 INV-3a/b/c），**不是脚注** | ✅ 形式达标；**完备性见 I1** |
| **D** | 用今天的数字，不用文档旧数字 | §5 整节：10 而非 4、演化两笔、五段形、deletion 有限定 | ✅ |
| **E** | 「无法证明兑现的防线」记为风险面 ＋ L5 不再依赖同型 | §6 RISK-1 ＋ §6.2 三条推论 | ✅（计数瑕疵见 I2） |
| **F** | 就地勘误，原句一字不动，不过度勘误 | 见 §1.4，**全部达标** | ✅ |
| **G** | 继承项**只放指针、不放内容**，并写明理由 | §7：一个指针 ＋ 理由 ＋ ⚠️「刻意不重述」的自我约束 ＋ 一处明写的例外（§1.4 的耦合，理由充分：它约束 §1 怎么被改） | ✅ |

**有没有多做（越界）**：**没有**。
**授权面守住了吗**：`git diff --numstat 9f78169..fbeb6fd` 只有 **2 个 `docs/` 文件**，
`src/`、`tests/`、任何台账、`docs/handoff/handoff.md`、其它 spec/plan **零改动**。✅
（注：后一笔 `37a1093` 动了台账并 force-add 报告，**不在本次评审范围 `9f78169..fbeb6fd` 内**，且系控制器所为。）

**文档体例**（brief §5）：文首块形状与 `2026-07-26-…-design.md` 一致；
⚠️ brief 明令「不要在新文件文首写 `Amendments:` 总账」—— **确实没写**（`grep -in "amendment"` 对新文件无输出）。✅

## 3. 「无界垃圾不是故障」的定性有没有被偷偷升级 → **没有。**

**三重证据：**

1. §5.4 **逐字复述**了那两句约束（我比对起点文档 `310:`/`313:`，**一字不差**），
   并逐字写「**本 spec 承接这个定性，不升级它**」。
2. §5.4 **把立项理由与缺陷脱钩**，逐字：「本 spec 的立项理由**不是**『有缺陷要修』，而是
   §2 那两份委任状**明确点名**了一份尚未存在的 cleanup / orphan 设计」——
   *** 这正是「偷偷升级」最常见的动机（给自己找立项理由），他把这条动机**当场堵死了**。 ***
3. §8.1 非目标第 5 条再钉一次：「**不把起点文档 §10 第 4 条升级成缺陷**」。
   §5.4 末句还预置了正确处置：「若后续有人找到，那是重要发现，应原样上报并**由人裁重新定性**，不由实施者自改。」

**我独立找了一次功能性破坏路径 —— 我也没找到，但我的覆盖面比他窄，明写：**
我只独立复核了 `ensureFreshRunDir` 一条（读了全函数体）：其阻塞集是三个具名文件 ＋
`attempts/`、`worktrees/` 两个目录的**条目非空**判断；`buildAtomicTempPath` 生成的
`.{basename}.{pid}.{timeOrigin}.{seq}.tmp` 不在三个具名文件之列。
⚠️ **`RUN_MARKER_FILES`（五个具名）与 `OBSERVED_FILES`（三个）这两条路径我没有独立复核** ——
我采信了起点文档与扫描员 2 的结论。**这是我在这一条上的覆盖缺口，不要把我的「没找到」读成全覆盖。**
另有一条我**没验**的线索，记在最后一节，供后续判。

## 4. 分层表 `deletion` 授权有没有被写成全称断言 → **没有。而且做得比 brief 要求的更远。**

- §5.3 逐字：「⚠️ **这条只能证『只有 L5 被\*显式标注\*为 deletion』，不能证『只有 L5 可能删东西』。**」
  并**保留了反例** `git worktree remove --force`，逐字写「**本 spec 不把它写成无限定的全称断言**」。
- §4.4 标题本身就是限定语：「『只有 L5 能删』是一句**有限定**的话」。
- *** 关键：他没有停在「不写成全称」，而是把这个限定**落成了两条真实的设计后果** *** ——
  ① L5 每次删除前**必须重新观测**目标是否仍存在，不得依赖缓存结论；
  ② 目标已不存在**不是错误**，记 `removed`/`already-absent`，不得报故障。
  brief 只要求「不许写成全称断言」，他把它转成了可验收的行为约束（§8.2 末行还给了对应测试）。

**零 finding。**

## 5. C4 处置 → **处置正确；措辞准确；但债未清（M5）。**

**事实核实**（全部我自己跑）：
- `2026-07-26-run-lease-and-heartbeat-design.md:45` 逐字 `L5 corresponds to the third follow-on spec named in the ownership design §17 and remains unwritten.` —— 与 spec §2.1 的引文**一字不差**。
- 该句说的「the third follow-on spec named in the ownership design §17」：07-22 §17 共 3 条，
  item 3 = `**Cleanup / orphan handling design**`。**本 spec 确实就是它** ⇒ `remains unwritten` **今天确实不再成立**。

**处置对不对 —— 对。** brief §0 只授权两处落盘，改 07-26 **不在授权面内**；
「不许推定」是 brief 逐字的。他的做法是**双落点上报**：spec §2.1 就地记明 ＋ 报告 C4 直接上报控制器，
并逐字写「**这是本轮新产生的文档债，不是我发现的旧债**」——
*** 主动区分「我造的债」与「我发现的债」，这一句在本仓库应记为正面行为。 ***

**记明的措辞本身准不准 —— 准。** §2.1 逐字：「本行落盘后该句的后半（remains unwritten）**不再成立**；
本 spec 无授权去改那份文档，在此记明，留给后续按本仓库体例就地勘误。」
三个成分（**只否定后半**、**声明无授权**、**指定后续动作**）都准确，没有多说也没有少说。

**但 → M5**：这条债今天**只被记在债的下游**。从 `2026-07-26-…-design.md:45` 出发的读者
**拿不到任何指向本文的指针**（`grep -in "2026-08-07\|cleanup-and-orphan"` 对该文件无命中）。
*** 这恰是 §7 自己拿来立论的形状：「两份文档并存、彼此无指针，于是各自腐坏、读者无从知道该信哪一份」。 ***
**本轮亲手造出了一条同型债。** 处置无可指摘（无授权就是无授权），
但**控制器不实际派那条勘误，§7 的立论就会被本 spec 自己的副产品打脸**。

## 6. Findings 明细

见 §0 表 ＋ 各节内的逐条论证。此处不重复，仅补两条**级别理由**：

- **I2 为什么是 Important 而不是 Minor**：它不是「难以重推的数字算错了」，
  而是**当场一条 grep 就能定的数字，两处（spec ＋ 报告）都写错了同一个值**，
  且它紧挨着 §6.1 的承重措辞。本仓库铁律逐字是「**每个数字附能重推它的命令与其输出；
  报不出可重数的计数就不要报数字**」—— §6.1 那处**恰恰没有附命令**（它给了 `grep -rn` 但没给计数命令，
  22 是人工数出来的）。**这个形状不纠正，下一轮还会犯。**
- **I1 为什么不是 Critical**：它不造成 spec 内部矛盾，也不使任何已落盘断言为假；
  它是**遗漏**。且实施者已在报告里点名请人来撞这里 —— 按本仓库口径，**自报未完成不加重量刑**。

## 我没做完 / 未验证的事

逐条明写。**不要把上面任何一条结论读成超出这里划定的覆盖面。**

1. *** **我没有独立复核 `RUN_MARKER_FILES`（五个具名）与 `OBSERVED_FILES`（三个）两条路径。** ***
   §3 里「定性未被升级」的判断，在这两条上**采信了起点文档与扫描员 2 的结论**，没有自己读源码。
   我只独立读了 `ensureFreshRunDir` 的全函数体。
2. *** **一条我没验的功能性破坏线索，原样交出，不自裁分级** ***：
   `buildAtomicTempPath` 把临时文件落在 `dirname(targetPath)`。若仓库里存在任何一处
   `writeJsonFileAtomically`（或其它经 `buildAtomicTempPath` 的写）的目标位于
   `<runDir>/worktrees/` 之下，则崩溃残留会让 `directoryHasEntries(join(runDir,"worktrees"))` 为真，
   进而使 `ensureFreshRunDir` **抛错**——那就不再只是「无界垃圾」。
   **我没有枚举 `buildAtomicTempPath` / `writeJsonFileAtomically` 的全部调用点去证伪或证实这一条**（预算）。
   ⚠️ 我**不**据此下任何结论，也**不**建议改定性 —— 交控制器决定要不要派一条一小时的核实。
   （`attempts/` 那一支我判为无新增破坏：该目录本来就会有条目。）
3. **「全是 fixture」的判别式是「`tests/` 下逐字含 `writeOwnerTransferRecord` 的行」。**
   一条**不提该符号**却仍钉住「生产不得走这个函数」的检查（AST/lint/自定义规则等），**我没验**。
4. **我没有复核 `.superpowers/sdd/2026-08-05-l5-input-scan/progress.md` 的内容** ——
   §7 的指针指向它，我只确认了**路径存在**，没有核对「包 2 的三条数据丢失 / §13 第 3 笔 / 组 B 两条债」
   这些提法与那份台账是否对得上。**§7 的指针正确性未验。**
5. **我没有复核 §1.4 那条耦合的技术内容**（`writeBoundaryArtifacts` 与 span 的位置关系）。
   我只确认了 spec **记录**了它、并且**没有替它做决策**。**那条耦合是否真实成立，我没验。**
6. **我没有核实「上一轮四份扫描与两条评审车道都没点出这条耦合」这句全称否定**（§1.4 逐字）。
   要验它得读完那六份材料，我没读。**这是一句 spec 里的全称否定，今天无人验过。**
7. **我没有核实「本仓库此前的九份报告一次没提『保留』这半」**（§2.1 逐字）——
   同为全称否定，同样无人验过，且我连「九份」指哪九份都没确定。
8. **§8.2 五条验收要求的可实现性我没评估**（是否真能写出会变红的测试），只判了它们「可证伪」。
9. **`docs/` 下是否还有第 7、第 8 条「不许删」约束，我没有独立做一次全仓扫描** ——
   I1 的清单**完全来自扫描员 2 报告 §4.3 的 6 条**，我只做了「逐条回原文核实」，
   **没有扩大检索面**。⚠️ 扫描员 2 自己也明写他「没有检索 `tests/`、`validation/`、`reference/`、
   `.superpowers/`」。**所以 I1 是一个下界，不是完备清单。**
10. **⚠️ token 预算：CLAUDE.md Rule 6 的每任务 12,000 token 已被突破。**
    主因是本任务的验证面（两份委任状 ＋ 六条既有约束 ＋ 逐提交重数 ＋ 计数重建）本身就大于该预算。
    **明写，不静默超支。**
11. **我全程走 `rtk proxy`**（按 brief 铁律 1 的警告）。上面所有粘贴的命令输出**均未过滤、未 `tail`、未摘要**。
    唯一例外：`ensureFreshRunDir` 那次我用了 `| head -60`，但函数体在 24 行内已完整结束，**未截断任何内容**——
    仍按规矩在此明写。
