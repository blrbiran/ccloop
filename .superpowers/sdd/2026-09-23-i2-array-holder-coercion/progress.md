# SDD ledger — plan: docs/superpowers/plans/2026-09-23-i2-array-holder-coercion.md

**Spec**: docs/superpowers/specs/2026-09-23-i2-array-holder-coercion-design.md（可达，已读）
**BASE at start**: 7b8880553ae5a1d289099b89996f078c55cd0ef6
**授权**: 人裁 127（两侧一起闭 ＋ 人裁 88 指名改写一条既有判据）、人裁 128（动生产代码、走 subagent-driven），人 2026-09-23 亲自给。

---

## 开工前冲突普查

### 每一对共享文件／接口的 Task

| A | B | 共享什么 | A 产出 vs B 消费 | 结论 |
|---|---|---|---|---|
| T1 | T2 | `parsePid` 签名 | T1 产出 `(processInstanceId: unknown)`；T2 传一个 `unknown` 进去 | **顺序硬依赖**：T2 在 T1 之前做则 typecheck 失败。计划已把它写进 T2 的 Interfaces |
| T1 | T4 | `src/persistence/fileStore.ts` | T1 改函数体并在**函数内**加注释；T4 只在**函数上方**与另两个注释块**末尾追加** | 落点不重叠 |
| T2 | T3 | `LockInspection.holder` 语义 | T2 产出「非字符串 ⇒ `JSON.stringify`」；T3 只断言前缀，不断言 holder 渲染 | 不冲突；T3 只钉前缀正是为了不与 T2 的 N3 重叠 |
| T2 | T4 | `src/unlock/inspectLock.ts` | T2 改函数体；T4 只在**文件头部 ERRATUM 块末尾**追加 | 落点不重叠 |
| T1/T2/T4 | T5 | 生产代码 | T5 全在 `git clone --local` 副本里变异，主树零触碰 | 不冲突 |

### 每个 Task 自洽性（判据 vs 代码、import 是否现存）

| Task | 查了什么 | 结论 |
|---|---|---|
| T1 | 改写后的判据用到 `OwnerRecord`／`OwnerTransferLockUnattributableError`／`isProcessActive`／`applyOwnerEpochTransfer`／`writeOwnerRecord`／`readFile`／`mkdtemp`／`tmpdir`／`join`／`writeFile` | **全部已在 `fileStore.test.ts` 的 import 里现存**（现测 1–35 行） |
| T1 | Step 1 期望 91 tests | 与现测一致 |
| T2 | 新判据用 `describe`／`makeRunDir`／`writeLock`；`isForProcessActive` 需新增 import | `describe` 已 import；两个夹具函数在同文件定义；计划 Step 1 已明写要补 `isProcessActive` |
| T2 | Step 4 期望 18 tests ＝ 原 13 ＋ 新 5（1 计数 ＋ 2 state ＋ 2 render） | 算得通 |
| T3 | 用 `readFile`／`join`／`OWNER_TRANSFER_LOCK_FILE`／`DEAD_PID`／`seedLock`／`lockExists`／`run` | **全部已在 `unlockCommand.test.ts` 现存**（现测 18–60 行） |
| T4 | 只追加不删，Step 7 用「删除行数 ==0」做机械判据 | 自洽 |
| T5 | Step 5 先删软链再删目录 | 自洽（否则会删穿主树 node_modules） |
| 全局约束 | 「不许自改既有判据」 vs T1 改写一条 | **不冲突**：T1 携带人裁 127 的具名授权，计划已标注 |

### 普查发现的、开工前就裁掉的

**Ruling 1（工作区）**：skill 要求隔离 worktree，ccloop 的 CLAUDE.md／handoff 明写「删 worktree 需人授权，历轮直接在 main 上落本地提交，CLAUDE.md 优先」，且 Tier 0 闸门会机械拦下 worktree 操作。
⇒ **在 main 上做，只落本地提交，不 push。**
**代价**：整体回滚只能靠 `git revert`，不能删分支了事。

**Ruling 2（T3 的 TDD 偏离）**：T3 的判据写在生产改动之后，**当场就是绿的**，不满足「先红」。
计划 Task 3 Step 2 已显式披露，并把它的红证指派给 T5 的 M1。
⇒ **接受这个偏离，但 T5 的 M1 没看到它红之前，不许宣称它钉住了任何东西。**
**代价**：若 M1 跑出来它没红，说明这条判据是空的，要当场补强或删掉。

**Ruling 3（基线不是全绿）**：`tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone` 在当前 HEAD 稳定红（副本 3/3、主树亦红、单跑 5.37s，非 flake），另有 4 条已知负载 flake。
⇒ **判别式 ＝「红的集合 ⊆ 这 5 条，且本轮新增／改写判据全绿」**，不是「恰好 N 条红」。
**代价**：若某条新红恰好混在这 5 条里被忽略，会漏掉一次真回归 —— 所以每次都要**按名字**核对，不只数条数。

---

## 执行记录

### Task 1 — parsePid 的类型守卫 ＋ 改写人裁 99 那条判据

- 实施席：sonnet，BASE `7b88805`。交回 **DONE**，提交 `4279280`。
- 自陈证据链：基线 91/91 绿 → 改写后**恰好 1 条红**（测试名与失败消息逐字匹配 brief）→
  加守卫后 91/91 绿 ＋ typecheck 绿 → 全套红集合 ＝ {stopProof 那条}，**按名字逐条核过**。
- 评审包：`review-7b88805..4279280.diff`（8729 字节，1 笔）。任务评审席已派（sonnet）。
- 任务评审（sonnet）：**Spec ✅ / 质量 Approved，0 Critical・0 Important・0 Minor**。
  逐条核过本仓库那 6 条判据陷阱，均未命中；确认改写后两半都在（锁逐字节还在 ＋ epoch 仍为 1），方向是**收紧**。
- 评审席给了 3 条「⚠️ 无法从 diff 判断」，**控制器逐条裁定：都不是缺口**，
  它们分别归 Task 4（ERRATUM）、Task 2（inspectLock 路径）、Task 5（M1 红证），计划已分工、台账普查表已记。
- **Task 1: complete (commits 7b88805..4279280, review clean)**

### Task 2 — inspectLock 拆分类值与渲染值（承重点）
- BASE `4279280`。
- 实施席交回 **BLOCKED**（正确行为）：Step 5 全套出现第 6 条红
  `subprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute`，
  名字不在已知 5 条集合里，按 brief 明文指令停下，未提交。
- **Ruling 4（控制器自己复核，未采信自陈）**：判为 flake，加入已知名单，放行提交。
  证据 (a) 因果面为零：`grep "inspectLock\|parsePid\|OwnerTransferLock\|unlock" src/runtime/claude/subprocessClaudeAdapter.ts` **零命中**；
  (b) 带 Task 2 未提交改动的工作树上**单跑 5 次 5/5 绿（28 passed）**。
  **代价**：若它其实是真回归，会被当噪声漏掉 —— 故把这两条证据一并留档，下轮可复查。
- **Ruling 5：计划写错了，实施席是对的。** Task 2 Step 2 写「应红 3 条」，实测 2 条 ——
  `parsePid` 守卫按 `typeof` 无条件拦、**不看值**，两条数组 state 判据在 Task 1 之后就双双已绿。
  已就地更正计划正文与 spec §8.1（本轮文档均未发布，就地改成立）。
  **代价**：无 —— 不影响 Task 5 的变异链（删守卫后两条仍会转红）。
- 实施席带裁决收尾：**DONE**，提交 `994f662`。提交前最后一次全套 RC=1，红的集合仅 `stopProof` 一条，
  第 6 条 flake 本次转绿 ⇒ ⊆ 已知 6 条集合。
- 评审包 `review-4279280..994f662.diff`（8608 字节）。**任务评审席用 opus**（这是承重点，第一版就栽在这里），
  并被指名**必须自己在副本里删掉守卫、亲眼验证它承重**（两条 `classifies` 必须红、两条 `renders` 必须保持绿）。
- **任务评审（opus）：Spec ✅ / 质量 Approved，0 Critical・1 Important・3 Minor。**
  评审席**亲手跑了守卫承重性验证**（副本，先 build）：M1 下 `3 failed | 138 passed (141)` ——
  两条 `classifies` 红（收到 `'dead'` 与 `'liveness-unknown'`，**各有独占场景**）、
  两条 `renders` ＋ 计数判据**保持绿** ⇒ *** **分类支与渲染支真的被拆开了，第一版那个形状被闭上了。** ***
  主树零触碰：`git diff -- src tests | wc -c` ＝ 0，`--cached` ＝ 0。
- 它另外自跑三条变异：M-B（无条件 stringify）打红 **6 条既有判据** ⇒ 证实 spec 删掉 N4 的判断对；
  M-C（表里删一行）计数判据接住；**M-D（整块删掉消费该表的 `for` 循环）⇒ 16 条全绿，接不住。**
- **Ruling 6（Important I-1）**：*** **拆分本身在输出层钉不住 —— 如实登记，不编判据。** ***
  实测：守卫留位、只把 `parsePid(rawHolder)` 改回 `parsePid(holder)` ⇒ 全套 141 条零红。
  结构性原因：守卫在位时拆与不拆在输出上不可区分（`JSON.stringify` 的结果必以 `[`/`{`/数字开头，
  没有任何 JSON 值能匹配 `^pid:(\d+)$`）。⇒ 它是纵深防御，判据只能是 M1 那条变异链。
  唯一能接住的形状是对 `parsePid` 实参下 spy，那会钉实现细节而非行为（Rule 9 的反面）。
  **代价**：将来把拆分收回去全套照绿，挡着它的只有注释与台账里 M1 的记录。已按 §3.3 的口径写进 spec §3.0。
- **Ruling 7（Minor M-1）**：计数判据钉住表长、**没钉住表被消费**（M-D 实测）。**当场修**，
  改成钉**文件级条数**，一条同时盖住两种形状 —— 这是本仓库「少跑一条在 vitest 里是绿的」那条教训的另一半。
  M-2（`pid:0` 那行携带无关前提断言 `isProcessActive(999999)`）、M-3（硬写 999999 而文件已有 `DEAD_PID`）一并捎上。
  ⚠️ 三条**都逐字来自计划给的代码块** ⇒ **是计划的问题，不是实施的问题。**
- 评审席 3 条「⚠️ 无法从 diff 判断」，控制器逐条核过：
  (1) N2 仍在计划里（Task 3），**没有随第一版被删**（被删的是 N4）；
  (2) 工作树那三个脏文件是控制器自己的（handoff ＋ 本轮 spec/plan），收尾统一落盘；
  (3) spec §4.1 的四处 ERRATUM ＋ 全树扫描**已安排给 Task 4**，没掉出去。**三条都不是缺口。**
- **Task 2: complete (commits 4279280..994f662, review clean, 1 Important 已裁并登记, 3 Minor 转 Task 3 修)**

### Task 3 — N2（unlock 命令层）＋ Ruling 7 的三条 Minor
- BASE `994f662`。
- 实施席交回 **DONE**，提交 `105af50`（+68/−9，只动两个测试文件）。
  全套 **777 条**（＝ 771 ＋ 6，与计划预测逐数吻合），红仅 `stopProof` 一条 ⊆ 已知 6 条。
  Ruling 7-D 自验：副本里删掉生成循环 ⇒ 新计数判据红，原文 `expected 16 to be 18`。
- ⚠️ **控制器自己的一处事实错误，实施席纠正了**：Ruling 7-C 我写「`inspectLock.test.ts` 没有 `DEAD_PID`」，
  实测**第 45 行就有**。我当时只读了该文件 1–40 与 85–120 行就下了断言 ——
  *** **这正是本仓库「引用前必须现测」那条的又一次兑现，记在这里以免下轮重犯。** ***
- 实施席自陈：计数判据改用 **Vitest 运行时任务树**（不是 brief 建议的按行首数源码），
  且**只验证了一种变异形状**。⇒ 已指名任务评审席**替它补验另外两种形状**
  （表里加一行不消费、删掉渲染生成循环）。评审包 `review-994f662..105af50.diff`。
- **任务评审（sonnet）：Spec ✅ / Approved，0 Critical・0 Important・1 Minor。**
  评审席**替实施席补验了两种计数变异**，都真的红：
  「表合法增长但字面量漏改」→ `expected 19 to be 18`；「删另一张表的生成循环」→ `expected 16 to be 18`。
  ⇒ 计数判据不是只对实施席测过那一种形状敏感。
  另现测核了 N2 前缀的**独占性**：`unlockCommand.ts:207` 是唯一匹配 `^refused  unrecognized holder identity: `
  的分支，`:237` 开头是 `removed` 不会误匹配。主树零触碰（两个 diff 都 0 字节）。
- **Task 3: minor (deferred)**：计数判据用 `context.task.file as unknown as CollectedTask`，
  依赖 vitest 内部 `Task`/`File` 结构（非公开 API 契约）。实施席是有意识的权衡（为不碰顶部 import 行）。
  **留给最终全分支评审分诊。**
- **Task 3: complete (commits 994f662..105af50, review clean)**

### Task 4 — 四处具名 ERRATUM ＋ 两处邻近过期文本 ＋ 全树机械扫描
- BASE `105af50`。
- 实施席交回 **DONE**，提交 `9f5848b`。扫描**没有第七处 ERRATUM 位置**（四处必追 ＋ 两处邻近过期，共六处全落地）。
- **控制器自核**：这一笔 `git show 9f5848b -- src` 的**删除行 = 0、新增 52 行、非注释新增行 = 0**
  ⇒ 纯注释追加，已发布文本逐字未动，铁律 5 守住。
- **Ruling 8**：全套第一遍出现第 7 条红
  `tests/runtime/codex/runCodexPhase.test.ts > Codex phase process > kills a TERM-ignoring process before returning abort`
  （`expected 'io-error' to be 'aborted'`）。**判为负载 flake，已知集合升到 7 条（1 稳定红 ＋ 6 flake）。**
  证据：(a) 本 Task 是纯注释，注释在运行时不存在，与 codex 子系统零因果面；(b) 控制器单跑 **5/5 全绿**（16 passed）。
  **实施席拒绝自行折叠、如实上报，是正确行为。**
  **代价**：若它其实是真回归会被当噪声 —— 证据留档，下轮可复查。
- **Ruling 9（控制器自己的错，值得记）**：计划 Step 7 给的字节扫描命令**是坏的** ——
  `$'\x00\|\x01…'` 在 bash 里于 NUL 处**截断参数**，模式变成空串 ⇒ **命中每一行**（实测报 1798/222，
  正好等于两文件总行数）。实施席识破并另用两法确认真实命中为 0。
  ⇒ *** **这正是「计划正文里的 shell 是自审看不见的那一块」。** *** 我的自审扫描器查了未赋值变量与 `<占位符>`，
  **没查「这条命令是不是真在做它声称的事」** —— 恒命中全部行的扫描器与恒返回 0 的一样没用。
  已把计划里那条命令换成直接读字节的 python 版，并把这次踩坑写进注释。
  **代价**：无（缺陷只在计划文本里，没有流进代码）。
- **Task 4: complete (commits 105af50..9f5848b, 纯注释, 删除行 0)**

### Task 5 — 变异电池（终点判据）
- BASE `9f5848b`。
- **任务评审（sonnet）：Spec ✅ / Approved，0 Critical・0 Important・0 Minor。**
  六处 ERRATUM 逐条对照现在的源码核实为真（`typeof` 守卫、`rawHolder`/`holder` 拆分、
  `classifyHolderLiveness` 调用、测试注释里的人裁 88 佐证）；**没有一处凭空断言**。
  位置都在各自具名块末尾；无 HEAD／remote tip 引用；无易过期计数。
  机械检查独立复测：删除行 **0**、非注释新增行 **0**、控制字节 **0**（两文件 93965／13868 字节）。
  它用 `git grep … 9f5848b`（锁定提交树、不受工作树脏改动干扰）重跑全树扫描，**确认没有第七处**。
  并独立复核了「`unlockCommand.ts` 那两条 ERRATUM 未过期」的判断为**正确**，理由是那两句是对
  stranded set 的**抽象定义**，人裁 127 反而让代码更贴合它们原本声称的规则。
- **Ruling 10**：评审席指出仓库里查不到人裁 127 的记录。**前半（人裁 121）是它没找到** ——
  它在 `.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` §44 附近确有记录。
  **后半是真的**：人裁 127／128 是本轮新裁，**台账 §46 尚未写**。
  ⇒ *** **注释里已引用人裁 127，台账里却还没有它 —— 这是本仓库最忌的「无主断言」。** ***
  **§46 必须在本轮收口前写**，Task 5 跑完立刻补。
  **代价**：不写的话，下一个读到那几条 ERRATUM 的 agent 会查不到授权来源，无从判断改动是否越权。
- **Task 4: complete (commits 105af50..9f5848b, review clean)**

---

## ⚠️ 本台账的具名更正（控制器，最终全分支评审之后）

*** **上文「### Task 5 — 变异电池（终点判据）」那一节下面写的是【Task 4 的评审结论】，
并以第二个 `Task 4: complete` 收尾。那是控制器的记账错误，原文逐字保留，此处更正。** ***
最终全分支评审把它报成 Important I-2：**终点判据的结论在权威台账里查不到。**

### Task 5 — 变异电池（终点判据）真正的结果

实施席在 `git clone --local` 副本里跑完三条变异，**每条都被【看到】打红**，
每条都用 `shasum -a 256` 前后比对确认真落上去、还原后字节级复原。逐格对照：

| 变异 | 预期红在 | 实测红在 | 相符 |
|---|---|---|---|
| **M1** 删 `parsePid` 守卫（写 `exec(… as string)`） | 两条 `classifies` ＋ 改写后的 fileStore 那条 ＋ unlockCommand 新判据；两条 `renders` ＋ 计数判据**保持绿** | 同左 | ✅ |
| **M3** 删渲染（`rawHolder as string`） | **两条 `renders`，且仅这两条** | 同左 | ✅ |
| **M5** `why` 换字面量 | 改写后那条 ＋ 既有的 `refuses a lock whose holder identity is not a pid as unattributable, never as busy` | 同左 | ✅ |

三轮之外唯一出现的红始终是同一条已知稳定红 `stopProof`。判据总数三轮均为 **777**（＝771＋6）。
主树零触碰：`git diff` 与 `git diff --cached` 对 `src tests` 字节数均为 **0**。
完整证据（命令原文、退出码、shasum 值、整份回读）在 `task-5-report.md`。

**Task 5: complete（无提交 —— 本 Task 只跑变异、只写报告）**

### **Ruling 11**（编号补齐 —— 最终评审的 M-6 指出台账编号止于 10，而控制器口头说过 11 条）

`scripts/verify-control-protocol.mjs` **硬要求两个环境变量**（现测 `:9-12`）：
`ORCA_CCLOOP_BIN` 与 `ORCA_CCLOOP_ADAPTER_CONFIG`，**ccloop 自己的文档一处都没记**，
实施席只能反推构造 fixture 才跑通前置校验。
取值在 **Orca 仓的 handoff §八.2** 里（现测两者都在）：
`ORCA_CCLOOP_BIN=/tmp/ccloop-codex-0919/dist/cli.js`、
`ORCA_CCLOOP_ADAPTER_CONFIG=/tmp/orca-ccloop-d3-task8/fake-codex-config.json`。
⚠️ 该脚本跑的 vitest 子集**包含 `stopProof`** ⇒ **它现在退出 1 的根因就是那条稳定红**，不是本轮的。
⇒ **补进 ccloop 的 handoff**（跨仓文档缺口）。
**代价**：不补的话，下一轮又会有人在这道门上白花一轮去反推 fixture。

### 最终全分支评审报出的其余条目与处置

| 编号 | 内容 | 处置 |
|---|---|---|
| **I-1** | `--force` 那一臂零判据，而本轮**新把数组 holder 路由进了它**；且 `dead` 分支排在 digest 门之前 ⇒ **今天 `--force --expect <错误 digest>` 对数组 holder 照样 exit 0 删锁**，落地后变 exit 1 留盘 —— 一次**安全相关**的行为改变，spec 没写、判据没有、四个 Task 谁都没报告 | **派修复席补判据**（正确 digest ⇒ 放行；**错误 digest ⇒ 拒绝**，后者是安全判据），并要求看见红 |
| **I-2** | 台账缺 Task 5 结果 | **本节即是更正** |
| **I-3** | `docs/handoff/handoff.md` 仍把本轮干完的活写成「下一件事」、仍说「E1 在授权面外」 | 控制器收尾时整节替换。⚠️ **根因记下**：本轮扫描的搜索词从**英文源码注释**机械导出，而 handoff 是**中文** ⇒ **扫描器对它恒零命中**。这是 **Ruling 9 的同族**：命令跑了、范围对了，但**语料语言不匹配**，一样是「扫描器没在做它声称的事」 |
| **M-1** | 拆分那段注释没写出 Ruling 6 量到的代价（收回去全套零红） | 交修复席追加 |
| **M-2** | Ruling 7-C 只兑现一半：`holder` 硬写 999999、前提用 `DEAD_PID`，两者只是碰巧相等 | 交修复席 |
| **M-3** | 计数判据接不住「整个 describe 被删」（连它自己一起消失） | *** **登记为已知边界，不编判据** *** —— 任何测试文件都挡不住「删测试」。Ruling 7 对该判据能力的描述**要收窄成「两种形状」**，不是全部 |
| **M-4** | `[]` 与 `[""]` 的操作员可见输出变了（由空变成 `[]`／`[""]`），无独占判据 | *** **登记为已知零覆盖** *** —— 它们走 N3 已钉住的同一条 `JSON.stringify` 分支，**没有任何现实变异能把它们与 `["pid:999999"]` 分开**（Rule 2：不编冗余判据）。方向是改善（原来操作员什么都看不到） |
| **M-5** | spec §5 逐格表只列了一层数组，没列嵌套 `[["pid:999999"]]`（今天同样 exit 0 删锁） | **spec 的记录缺口，不是覆盖缺口**（§8.2 已写明「嵌套可任意深」，且它与 N1 共用同一条 `typeof` 分支）。已补进 spec §5 |
| **M-6** | 台账编号止于 Ruling 10，控制器说过 11 条 | **上面的 Ruling 11 即是补齐** |

⚠️ **最终评审自陈没能验证的 7 项**（人裁原文、没重跑 M1/M3/M5、没跑 `verify:control`、
探针是函数边界不是真 CLI 进程、活文档只按有限搜索词扫、更深嵌套与 `String()` 会抛的 holder 没测、
两条 flake 没单跑复验）—— **原样留档**，下一轮要用时先现测，不要当成已验证。

### 修复轮 ＋ 限定范围复审（最终全分支评审之后）

- 修复席落地 I-1／M-1／M-2，**一笔提交**（主题行
  见 `git log --grep="force"`），全套 **779 条**（777＋2）。
- **限定范围复审：I-1 ADDRESSED／M-1 ADDRESSED／M-2 ADDRESSED，修复 diff 内部零新破坏。**
  复审席**自己复现了安全判据的红证**：把 digest 门改成 `if (false)` ⇒ **4 条同时红**
  （3 条既有 digest-gate 判据 ＋ 本轮新增的
  `refuses an ARRAY holder under --force when the digest does not match, and leaves the lock on disk byte for byte`，
  报 `an array holder's lock was deleted despite a mismatched --force digest`）。
  还原后全套 **778 passed / 1 failed（779）**，唯一红是 `stopProof`。
- ⚠️ *** **复审席捎回一条方法论细节，转台账** ***：用 `if (false)` 做变异会让 `npm run build`
  先以 **`TS2339` RC=2** 失败 —— 因为 tsc 对 `if(false)` 的死分支**仍按控制流窄化后的类型检查它**
  （`inspection.digest` 在该处已被窄化掉）。**不影响判据**（`tests/**` 直接 import `src/*.ts`，
  走 esbuild 不过 tsc），**但若有人把「变异 → build → 测」当成必须顺序且 build 失败就中止，会在这类变异上卡住**。
  ⇒ **变异验证时 build 是可选步骤，判据红不红才是证据。**

## 本轮收口

- **全部 5 个 Task ＋ 1 轮修复完成**，最终全分支评审 **0 Critical**，3 Important 全部处置
  （I-1 补判据并见红、I-2 台账更正、I-3 handoff 整节替换）。
- **最终实测**：全套 **779 条**，红仅 `stopProof` 一条（已知 7 条集合之一）；
  `typecheck` RC=0、`build` RC=0；主工作树 `src tests` 的 `git diff` 与 `--cached` 均 **0 字节**。
- ⚠️ *** **本工作区【不删】** *** —— skill 建议删，但本仓库铁律 4 把 `.superpowers/sdd/**` 当证据链，
  且台账 §46 直接引用了这里的 `task-5-report.md` 等文件。删了会让 §46 指向不存在的东西。
  **改为随本轮一起 `git add -f` 入库**（该目录 `.gitignore` 内容是 `*`）。
