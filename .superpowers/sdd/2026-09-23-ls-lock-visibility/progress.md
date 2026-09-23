# 人裁 85 ＋ I-3 —— `ls` 也报锁 / 卡死的锁对操作员可见

> **归属**：控制器会话 `1de723ea`（Orca 仓的 run，ccloop 侧执行），2026-09-23。
> **观测锚点** ＝ 开工时 ccloop 主线的提交主题行
> `docs(handoff): stop calling E1's I-2 the next thing, and hand over what this round measured` 那一笔。
> 本文件**只追加，不改历史**（ccloop 铁律 4）。写错了另起一节记更正，原文逐字保留。

---

## 0. 开工核对（现测，未过滤整份读回）

三仓 `ls-remote` vs 本地：**全部相同**（Orca／ccloop／ccmem 都与远端一致，无待推的笔）。
三仓 `git status --short` 全空。`~/.orca` 只有空的 `control/`（0700），无 `not_my_taste` 行。

| 项 | 值 |
|---|---|
| 全套 `./node_modules/.bin/vitest run` | **56 files / 779 tests**，1 failed / 778 passed，**0 skipped**，`TEST_RC=1`，耗时 30.55s |
| 唯一的红 | `tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone` |
| `npm run typecheck` | `RC=0` |
| `npm run build` | `RC=0` |

环境：`ECC_GATEGUARD=off DISABLE_OMC=1`。
⚠️ **判别式 ＝「红的集合 ⊆ 已知 7 条，按名字核，不数条数」。**
⚠️ **台账 §46 与 Orca 检查点都记 777 条，本轮现测 779。引用条数前一律现测。**

---

## 1. 本轮的人裁（**人亲自拍的，控制器一件都没替人宣布**）

| 编号 | 裁决 |
|---|---|
| **129** | **范围**：人裁 85 与 I-3 合并为一轮。 |
| **130** | **深度**：实施 → 外派独立评审 → 修复。 |
| **131** | `ls` 报**全量七态**，复用 `inspectOwnerTransferLock`。 |
| **132** | 红线函数的 `not-determined-dead` **分格**，调用点对「活性未定」那一格报真话。 |
| **133** | 分格走**新错误类型**路线（而非只换 message），补齐全部路由点。 |
| **134** | 本会话**越过 Rule 6 的 T2（450,000 上下文占用）继续做完整条 task**，单次指令授权；并授权控制器在本轮自行提交（**push 仍归人**）、自行处置执行中出现的问题、最后统一报审。 |

⚠️ **人裁 134 是一次具名超支，不是常态。**
⚠️ **人裁 88 未被人裁 134 覆盖**：改既有判据仍需人指名。本轮处置 ——
**优先「只加不改」（人裁 119 的先例）；真改不可免时逐条记本文件、不放宽、并在最终报告里单列给人复核。**

---

## 2. 控制器裁决（**摘要；每条都写明依据**）

1. **路径分类为 architectural** —— 它改两个对外接口（`ls` 的输出契约、红线函数的返回形状），
   且两份 handoff 都写明「有实质设计成分，先 brainstorming」。
2. **不动 `src/sweep/lockPresence.ts`**（CLAUDE.md Rule 1 第 2 档自决：可逆，写清依据）。
   依据：`sweep` 用它做**决策输入**（有锁就不碰这个 run），boolean 在那里更保守也够用；
   它**不是给操作员看的报告路径**，所以不构成「两个报告路径两种口径」。
3. **方案选型 B（独立一层）而非注入进 `scanRuns`**。
   依据：`sweep` 也跑 `scanRuns`，注入会让 sweep 被动地开始做 liveness 探测；
   要躲开就得给 sweep 传 no-op inspector —— 那是为绕开自己的设计而造的洞。
   **附带收益**：要具名推翻的既有原则从两条缩到一条。
4. **不抽 `Unclearable` 基类**，用平行兄弟。
   依据：本仓库既有答案 —— `resumeLoop.ts` 人裁 106 那段「the two lock errors are siblings and
   neither `instanceof` implies the other」＋ `fileStore.ts` 的「deliberately NOT a subclass」doctrine。
   CLAUDE.md Rule 11：conformance > taste。基类更省字，但那是控制器的口味，不是本仓库的写法。
5. **新事件类型 `owner_transfer_lock_liveness_undetermined`，且两个错误各自一个 once-per-run 标志**。
   依据：人裁 119 的实测理由（复用会让「在数这个类型」的判据从 1 变 2 —— 消费者真的在数）；
   共用标志会让一个 run 里的第二条被静默吞掉，**那正是 I-3 要修的那种沉默**。
6. **`schemaVersion` 1 升 2**（可逆自决）。依据：行多了一个**带判断**的成员，
   而 run-registry spec §6.3 说这个版本号存在就是为了让消费者分辨行的含义。
7. **`renderScanTable` 顶上那句运行时 notice 不动**。依据：它说的是 **fields**，锁块不是 field，
   所以它不因本轮变成假话；按注释铁律不该去碰已发布的输出文本。

---

## 3. spec 自审抓到的（**全部已修**）

spec：`docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md`。

| 类型 | 抓到的 |
|---|---|
| 真占位符 1 条 | 人裁 121 的日期写成 `2026-09-XX`，现查台账为**同日 2026-08-28**（承接人裁 120） |
| **行号引错 3 处** | `resumeLoop.ts:253`→**250**；「applied to a third meaning」在 **881** 不是 880；人裁 111 那段在 **1568** 不是 1566 |
| 格式不一致 1 条 | 人裁 126 缺日期（也是 2026-08-28） |
| 字节扫描 | 0 命中（改前改后各一次，**用 python 直接读字节**） |

⚠️ **引了 7 个锚点、错了 3 个（43%）** —— 与历轮「16 条写错 5 条（31%）」同量级。
⇒ **普查必须写成命令，不许靠脑补。** 本轮是靠机械核对捞回来的，不是靠记忆。
⇒ 处置：spec §7 里两处已改成引「**人裁 119 那段／人裁 113 那段**」而不是行号 —— **行号会移动，人裁编号不会。**

---

## 4. 扫描器自测（**必抓 ＋ 必不抓两组样本**）

占位符扫描器跑之前先自测：探针 `["a TODO here", "2026-09-XX", "clean line"]` ⇒ **命中 2**（期望 2）。
⚠️ 依据：「BAD_COUNT = 0 什么都不证明 —— 恒返回 0 的扫描器给同样的输出」，
且「恒命中全部行的扫描器和恒返回 0 的一样没用」。

---

## 5. 计划前捞到的第一条「人裁 88 指名面」

现测 `tests/cli/cli.test.ts:141`：

```
it("emits a parseable ScanResult with schemaVersion 1 under --json", ...)
```

**判据名里就写着 `schemaVersion 1`。** ⇒ 控制器裁决 6（升到 2）会逼着**改这条既有判据**（连名字）。

⚠️ **这让控制器裁决 6 本身变得可疑**：本仓库的规矩是「需要新覆盖时先想能不能只加不改」
（人裁 119 正是靠这条绕开了改既有判据）。升版本的收益是告诉消费者行的形状变了，
**但若 `ScanResult` 现测零消费者，这个收益近乎为零，而代价是一条既有判据改写。**

⇒ **待独立评审席给出「`ScanResult` 有没有消费者」的现测证据后再定。**
若确认为零消费者 ⇒ **撤回裁决 6，保持 `schemaVersion: 1`**，新形状改由锁块自己的判据钉住。

---

## 6. 计划前捞到的第二条：`ls` 不许复制 `unlock` 的散文措辞

现测 `src/unlock/unlockCommand.ts:172-240`：`ccloop unlock` **已经为七态各写了一套诚实的操作员措辞**，
其中 liveness-unknown 那条还专门写明理由 ——
「"unreadable" would be a false statement — the record parsed fine and named a holder;
what failed was the probe. An operator told the wrong reason looks for the wrong fix.」

⇒ **控制器裁决 8**：`ls` 的锁块只报**结构化状态名 ＋ holder ＋ digest ＋ 下一条命令**，
**不复制 `unlock` 的散文**。依据：两个命令对同一把锁说不同的话，是本仓库最怕的静默分叉；
而把散文抽成共享函数要动已发布的 `unlockCommand.ts`，代价更大。
**`ls` 压根不说那些话，就不可能与它分叉。**

---

## 7. 独立评审（第一版 spec）＋ 控制器复核

**评审席**：独立上下文，brief 要求「不许改文件、只出诊断、拿不到证据就说没看到」。
用量：**186,950 token / 50 次工具调用 / 808 秒**（工具报数）。

**判定：4 Critical / 11 Important / 9 Minor。**
⚠️ *** **控制器逐条复核，承重主张【全部成立】，没有一条是错的。** ***

### 控制器亲自复核过的六条（各附现测命令）

| 条目 | 复核结果 |
|---|---|
| **C-1 循环依赖** | **成立**。`grep -n "^import" src/persistence/fileStore.ts` ⇒ 7 行，跨 `src/` 的全是 `import type`（对 `src/` 零值导入）；`sed -n '72p' src/unlock/inspectLock.ts` ⇒ 值导入 `parsePid`。`sed -n '436,446p'` ⇒ D2 先例白纸黑字「importing back would close a cycle」，为此宁可复制两个常量 |
| **C-2 重试语义** | **成立，且比评审员说的更硬**。三处闸门注释逐字写着人裁 106「deliberately left it unchanged … this lock will never be released, so every retry is dead time」。EPERM 格的持有者很可能活着、会自清 ⇒ 沿用该路由同时造成**行为回归**与**假话** |
| **C-4 schemaVersion** | **成立，且是两条**（`tests/cli/cli.test.ts:141/154`、`tests/registry/renderRuns.test.ts:80/82`）。控制器自己只找到一条 |
| **I-1 构造点** | **成立**。`sed -n '1394,1400p'` ⇒ `fileStore.ts:1396` 是 outcome→错误的构造点，第一版全文未提 |
| **I-5 人裁 6** | **成立，且是最该记住的一条** |
| **I-3 registry spec** | **成立**。`:181`「no derived field of any kind」与 `:573`「no derived judgment … enforced by a test」 |

### 🔴 I-5 是本轮最值钱的一条教训

*** **控制器把台账 §46 的「控制器裁决第 6 条」写成了「人裁 6」。** ***
现测：人裁 6 在**另一本台账** `.superpowers/sdd/2026-08-07-pkg1-l5-spec/`，内容是
「包 1 只写 `docs/`，`src/` 与 `tests/` 一字不动」，**与「如实登记钉不住」毫无关系**；
要引的那条在 `2026-08-07-pkg2-data-loss/progress.md:4925`，是 **I-2 轮的控制器裁决 6**。

⇒ *** **把【控制器自己的裁决】冒充成【人裁】，是「替人宣布」的反向形式，同样严重。** ***
⇒ **机械做法：凡写「人裁 N」，落笔前先 `grep -nE "人裁 N[^0-9]" 全部台账` 核一次它是什么。**
  ⚠️ 还要核**是哪一本台账** —— 本包有多本，编号各自独立。

### 控制器据此推翻的第一版结论

**共 13 条，逐条留档在 spec §10。** 其中四条是 Critical 级：
三态下沉解循环（§4.1）、重试闸门加一支（§4.5）、schemaVersion 保持 1（§3.4）、
删掉「钉不住」的不诚实登记（§5.2 #2）。

⚠️ *** **第一版说「换用三态函数这件事钉不住」是【不诚实的登记】** *** ——
现测有两条独立的看见方式（reason 字面量、`pid<1` 不发 syscall 可用 spy 钉）。
**本仓库铁律：有办法看见就不许登记成看不见。** 控制器第一版违反了它自己在 spec 里写的这条规矩。

---

## 8. 控制器裁决（续）

9. **新错误类型仍走重试**（三处闸门各加一支），而不是沿用 unattributable 的「第一次尝试就放弃」。
   依据：今天这三格本来就走满重试 ⇒ **加闸门才是「保住今天的行为」，不加反而改变它**；
   且 EPERM 格的持有者很可能活着，丢掉重试是真回归。
10. **不把 `liveness-undetermined` 细分成两格**（结构性永不清 vs 探测被拒）。
    依据：新措辞「may or may not clear on its own」对三格都为真，`reason` 字段已区分给操作员；
    再加一格只买到「省掉两格的有界 dead time」，是优化不是正确性（YAGNI）。
11. **`schemaVersion` 保持 1，撤回裁决 6。** 依据见 spec §3.4 —— 两条既有判据钉着它，
    而升版本的收益已由锁块自身的存在提供。**这是「只加不改」（人裁 119 的先例）。**

---

## 9. spec 第二版的自审（**表格扫描抓到真缺陷**）

三扫：markdown 表格单元格数一致性 ＋ 控制字节 ＋ 占位符，**每个扫描器都先自测必抓样本**。

- **表格扫描抓到 2 行被切断** —— 控制器在单元格里写了裸 `|`（`|| instanceof ...`、
  `ScanRow | (RunObservation & ...)`）。⚠️ **修完第一轮后重扫，同一行的第三个单元格里还有一个**
  （`ReportedRunRow | ScanIssue`）⇒ 第三轮才干净。
  *** **完全复现了历轮那条「第一轮改 12 漏 6，第二轮补 6 又漏 2，半改比不改坏」。** ***
  ⇒ **机械扫描必须跑到收敛，不是跑一次。**
- 终检：**9 张表全部完整、0 控制字节、0 占位符、扫描器自测 2/2**。

---

## 10. Task 8–10（`ccloop ls` 锁可见层）：实施 ＋ 修复轮 1

**实施**：`d093eee..2e918a7`，4 笔提交。`attachLockInspections`（Task 8）＋ `renderRuns.ts` 七态渲染
（Task 9）＋ `cli.ts` 接线／端到端／退出码／零写证明（Task 10）。实测 813/814，唯一红是既有的
`stopProof.test.ts` 稳定红。变异电池全跑：Task 8 四条、Task 9 七态各一条 ＋ M9-8、Task 10 四条
（M10-2 如实登记「预期无红」）。

⭐ **本轮顺带发现的既有缺陷（不是本轮引入的）**：共用的 `snapshotTree`（`tests/registry/
zeroWrite.test.ts`）从未记录过目录自身的 mtime，只记文件／符号链接。这意味着**在本轮之前**，
`run-registry spec §15 #2`「零写可证」对「探测代码 touch 了一个目录但没写任何文件」这一类回归
一直是瞎的——M10-4（在 `attachLockInspections` 里对每个 run 目录 `utimes`）第一次跑**全绿
（44/44）**，不是变异无效，是判据看不见。已扩展 `snapshotTree` 记录目录 mtime（严格更敏感、
不会让任何已过判据变红），重跑后 M10-4 正确单条变红。**列入 handoff**：任何以后依赖
`snapshotTree` 的零写判据，从这次起才真正覆盖「目录被 touch」这一类。

**评审席**：Needs fixes，0 Critical／1 Important／2 Minor。七态、类型环、四个禁改文件全核过，
无破损。

### Important（修复轮 1 已处置）

**发现**：`tests/registry/renderRuns.test.ts` 里「no derived fields」守卫判据
（禁 `/resumable|fresh|stale|expired/i`，`eligible` 只放行 `eligibleForContinuation`）对本轮新增的
`lock`／`state` 键**照绿**，因为它的禁词表比这轮早，压根没提过这两个词。design spec §3.7 与
task-9-brief Step 4 都要求把这件事**测量并记录**，而不是留着不管——**三处都没记**：
不在台账、不在实施报告、不在判据旁边。评审席自己是重新踩了一遍这个坑才发现它，这正是这条要求
存在的理由。

**处置**：
1. **测量**：跑 `npx tsx .probe-guard-lock.ts`（会话内一次性探针，未提交，脚本已删除）——
   用真实的 `toScanResult` 生成一行带锁块的 `ReportedRunRow`，序列化后收集全部键
   （`lock`、`state`、`holder`、`pid`、`digest`、`identity`、…），逐个对守卫的正则
   `/resumable|fresh|stale|expired/i` 测试。**输出**：`does the guard pattern match ANY key? false`——
   六个新键全部不中，判据照绿是真的，不是巧合。
2. **记两处耐久处**：
   - `tests/registry/renderRuns.test.ts` 守卫判据正上方追加了一段注释，写明这条判据看不见
     `lock`／`state`，它自己原有的注释「real target is a future well-meaning derived column」——
     **本轮就是那个 column**——并点出这是「测量过，不是假设过」。
   - 本节（`progress.md`）——因为 SDD 过程台账（`sdd-ledger.md`）在计划收口时会被删除，
     只记在那里等于没记。`progress.md` 是仓库自己的轮次记录，会留下来。
3. **Minor（顺手做了，成本很低）**：`tests/registry/renderRuns.test.ts` 里最后一条
   `toScanResult(rows as unknown as ReportedScanRow[])` 的双重断言已消掉——改用
   `attachLockInspections(rows, { inspect: async () => ({ state: "absent" }) })` 产出真正的
   `ReportedScanRow[]` 值，不再需要绕过类型系统的 cast。
4. 另一条 Minor（`chmod 000` 那条判据以 root 身份跑时不会真的触发不可读路径）——
   评审席判定是既有惯例，不改。

**复核命令**（`export ECC_GATEGUARD=off DISABLE_OMC=1`，全量重定向到文件再读回，未过滤）：
```
npx tsc --noEmit                                                    # RC 0
./node_modules/.bin/vitest run tests/registry/renderRuns.test.ts tests/unlock/lockRows.test.ts
# Test Files  2 passed (2)  /  Tests  21 passed (21)
```

**提交**：`fix(test): record the no-derived-fields guard's blind spot on lock/state, drop the last unchecked cast`
（修复轮 1，紧跟在 `2e918a7` 之后）。

## 11. Task 11–12：勘误补全 ＋ run-registry 更正节 ＋ 全树扫描 ＋ 判据脚本 ＋ 变异总账

> **归属**：本节由本轮控制器会话 `1de723ea`（与本文件头部同一会话）在 BASE `bdaa92c`
> 上直接执行，未开 worktree，未 push。落地提交见 §11.7。

### 11.1 全树扫描

**词表机械导出**（来自本轮已落地的勘误句子，覆盖英文源注释与中文活文档两种语料）：

```
英文：not-determined-dead, two-state, three-state, classifyHolderLiveness, isProcessActive,
     "no derived field", "no derived judgment", "judging liveness in a reporting path",
     "will never be released", "exported for `ccloop unlock`", schemaVersion
中文：两态, 三态, 报告路径, 永不, 派生, 名单
自测控制词：zzz-not-present-anywhere-in-this-repo（已知必不命中）
```
扫描范围 `src tests docs .superpowers`，后缀 `.ts .md .mjs .js`，脚本见
`/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/1de723ea-71e0-4d2e-99b6-7d1116658c4f/scratchpad/scan_terms.py`。

**扫描器自测**（跑于 pass 1，命令 `python3 scan_terms.py`，整份读回 `/tmp/t11-scan-pass1.txt`）：
- 已知必命中词 `isProcessActive` → **251**（> 0，未恒零）
- 已知必不命中词 `zzz-not-present-anywhere-in-this-repo` → **0**（未恒命中全部行）
⇒ 扫描器不是"恒返回 0"也不是"逢词必中"的空判据。

**Pass 1**（改动前基线扫描，`/tmp/t11-scan-pass1.txt`，929 行）：18 个词共约数百行命中，
逐词过一遍上下文（非机械计数，读原文判断是否为"本轮弄假但没人改"），命中大多数是：
① 本轮已落地的 ERRATUM 自身引用旧词（预期，不是问题）；② 历史台账/评审 diff 的叙述性引用
（`.superpowers/sdd/**` 除本轮目录外，铁律 4 冻结，不碰）；③ 与本轮话题无关的同词重名
（如 `名单` 在 handoff.md 里指的是另一份 flake 名单，`派生` 在 2026-08-01 那份 spec 里说的是另一件事）。

**逐条定位到的、需要处理的真命中**（本轮弄假、且此前没有勘误覆盖）：

1. `src/sweep/lockPresence.ts:15` 的「judging liveness in a reporting path」段——spec §7 清单里
   点名的一处，Task 1–10 里没人接。**已处理**：块末追加 ERRATUM（人裁 131），写明两半——
   `ls` 那半被推翻，`sweep` 自身那半原样成立（§11.2 第 1 条）。
2. `docs/superpowers/specs/2026-07-28-run-registry-design.md` §6／§15#3——spec §7 清单里点名的
   第二处。**已处理**：文件末尾追加 `## ERRATUM (ls lock visibility, HUMAN RULING 131)` 节
   （§11.2 第 2 条）。
3. `src/persistence/fileStore.ts:973` 起「parsePid and isProcessActive are exported for
   \`ccloop unlock\`」——spec §7／§10 都点名。**已处理**：块末（`export function parsePid` 之前）
   追加 ERRATUM，写清 `isProcessActive` 今天零生产调用点、只剩两处测试 import，删不删是人的事
   （§11.2 第 3 条）。
4. `src/persistence/fileStore.ts:1143` 附近「"No longer alive" means TODAY's two-state
   isProcessActive ... not E1's three-state classifyHolderLiveness」——**扫描新捞到，spec §7
   清单没列**：这段紧邻的、稍后的另一段（原 ruling-108 段）已经有人裁 132 的 ERRATUM 说
   "isProcessActive now sits OUTSIDE the try"，但**这一段自己没有**，逐字核对后确认它现在也假
   （今天走的是 `classifyProcessLiveness`，不是 `isProcessActive`）。**已处理**：块末追加 ERRATUM。
5. `src/persistence/fileStore.ts:1389` 附近「not alive under isProcessActive (two-state, human
   ruling 86)」——**扫描新捞到，同一份说法在文件里第三处重复**（`acquireOwnerTransferLock`
   上方那段），恰好呼应它自己邻近那条「I-1 ... MISSED when the same sentence was corrected
   earlier in this file: one claim in three places, two of them left standing」的自嘲。**已处理**：
   块末追加 ERRATUM，并在文中点名"这是第三处，别再漏"。
6. `src/unlock/inspectLock.ts:29-34`（人裁 83 那段 ERRATUM 的收尾句）「the redline function's
   isProcessActive has two [states] and reads all three as alive」——**扫描新捞到**：现测这句已假，
   红线函数今天对 pid:0／越界 pid／EPERM 三格给的是独立的 `liveness-undetermined` 出口，
   不再折叠进 "alive"。**已处理**：块末（imports 之前）追加 ERRATUM。

**评估后判定"不在本轮范围"的命中**（记录理由，不动手，避免多 agent 仓库里越界改别的完成轮次）：
- `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`、
  `2026-08-26-i3-unattributable-lock-design.md` 里对 `isProcessActive` 的描述——这些是**更早、
  已完成轮次**自己的设计存档，其中对 isProcessActive 角色的描述本来就已经被【那些轮次之间】
  的多次改动（不只本轮）逐步稀释；本轮的 spec §7／§11 都没有点名它们，扫描的目的是「本轮弄假的
  没人记得改」，不是「审计全仓库有史以来的每一份 spec」。留给未来若真要处理它们的轮次。
- `docs/superpowers/specs/2026-09-23-i2-array-holder-coercion-design.md`——这是**另一个已完成的
  平行轮次**（i2-array-holder-coercion）自己的勘误清单草稿，其中提到的 `isProcessActive`
  短路表达式是**那一轮自己**要处理的既有技术债，不是本轮 ls-lock-visibility 弄出来的。
- `docs/handoff/handoff.md` 里的 `永不`／`名单` 命中——逐条读过，说的是另一件事（一次"绿本身
  可能是空"的教训、以及另一份 flake 名单），与本轮的 liveness/derived-field 话题无关。

**Pass 2**（改动后重扫，`/tmp/t11-scan-pass2.txt`，946 行）：各词命中数按预期**上升**
（如 `isProcessActive` 251→259，`two-state` 16→19），因为新增的 ERRATUM 本身引用了这些词——
这是预期行为，不是残留。**逐条核对新增的命中全部落在刚写的 ERRATUM 文本里**，没有新的"未勘误"命中。

**Pass 3**（收敛确认，`/tmp/t11-scan-pass3.txt`）：与 pass 2 **逐字节相同**
（`diff /tmp/t11-scan-pass2.txt /tmp/t11-scan-pass3.txt` 无输出）⇒ **跑到收敛，不是跑一次就停**。

`npm run typecheck` 于全部勘误落地后：`RC=0`（`/tmp/t11-typecheck-after-errata.txt`）。

### 11.2 勘误清单（本节逐条对应 §11.1 第 1–6 条的落点）

| # | 文件 | 原句 | 处置 |
|---|---|---|---|
| 1 | `src/sweep/lockPresence.ts` | "judging liveness in a reporting path would put a decision where an observation belongs" | 块末追加 ERRATUM（人裁 131）：`sweep` 本身不变，`ls` 被推翻，两半都写 |
| 2 | `docs/superpowers/specs/2026-07-28-run-registry-design.md` | §6 "no derived field of any kind"／§15#3 "no derived judgment ... enforced by a test" | 文件末尾追加 `## ERRATUM (ls lock visibility, HUMAN RULING 131)` 节，原文一字不改，含 §15#3 判据接不住新列的现测事实（详见 §10 本文件） |
| 3 | `src/persistence/fileStore.ts:~973` | "parsePid and isProcessActive are exported for `ccloop unlock`" | 块末（`parsePid` 定义前）追加 ERRATUM：`isProcessActive` 零生产调用点，只剩 `tests/persistence/fileStore.test.ts:1086`／`tests/unlock/inspectLock.test.ts:317` 两处测试 import；删不删留给人 |
| 4 | `src/persistence/fileStore.ts:~1143` | "'No longer alive' means TODAY's two-state isProcessActive ... not E1's three-state classifyHolderLiveness" | 块末（`let pid: number \| null;` 前）追加 ERRATUM |
| 5 | `src/persistence/fileStore.ts:~1389` | "not alive under isProcessActive (two-state, human ruling 86)" | 块末（`acquireOwnerTransferLock` 定义前）追加 ERRATUM，点名"同一句子在本文件第三处" |
| 6 | `src/unlock/inspectLock.ts:~29-34` | "the redline function's isProcessActive has two and reads all three as alive" | 块末（imports 前）追加 ERRATUM |

⚠️ **spec §7 清单里 `fileStore.ts:881`「applied to a third meaning」一项——控制器已撤回，本轮不追
ERRATUM。** 理由（spec §11.2 现测已记）：那句话说的是 `OwnerTransferLockUnattributableError`
**这个类自己**是该 doctrine 的第三种含义，新类自己的注释已写明「A fourth meaning, and a THIRD
sibling」——加一个兄弟不会让"它自己是第三种含义"变假。追 ERRATUM 只会是噪音。

### 11.3 `scripts/check-known-reds.mjs`

脚本见 `scripts/check-known-reds.mjs`。判据 1 的机械子集判定：失败集合的**全名**必须是
roster 的子集，比较用双向 `endsWith`（不是相等）——因为 vitest 的 `fullName` 字段是
`ancestorTitles` 与 `title` 用**空格**拼接，不是 `" > "`；脚本自己用
`[...ancestorTitles, title].join(" > ")` 重建全名，再和 roster 按后缀双向比对
（roster 第 1 条自带文件路径前缀，其余不带，双向 `endsWith` 两种形状都接得住）。

**Roster 是十三个全名**（十二条编号项，第 12 项是 `codexWatchdog` 的一对，算两个全名）——
不是脚本草稿里写的七条：

```
1. tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as
   group quiet and proves only after the full tree is gone
2. run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid
3. runLoop > persists phase usage evidence from the subprocess adapter without recomputing
   controller totals
4. runLoop > accounts an execute timeout that rejects after the abort as exhaustion
5. run-scenario CLI > fails on an existing run directory without creating evidence or
   harvesting stale run data
6. SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful
   execute
7. Codex phase process > kills a TERM-ignoring process before returning abort
8. run-scenario CLI > runs when invoked through a canonical-path alias
9. run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist
10. isolated Codex acceptance harness > succeeds only with real controller, three phases and
    published answer
11. accepts the controller's zero-clamped soft budget and records the overrun
12a. matches historical double-space start identities on single-digit days
12b. still reaps registered groups when the observation file becomes unwritable
```

**脚本自测（两个方向都跑，都记 RC）**：
```
node scripts/check-known-reds.mjs /tmp/fake-ok.json   → RC=0（只含已知红，见 /tmp/selftest-ok.txt）
node scripts/check-known-reds.mjs /tmp/fake-bad.json  → RC=1（含一条未知红，见 /tmp/selftest-bad.txt）
```
`/tmp/fake-ok.json` 含 1 号与 8 号已知红 ＋ 1 条 `passed`；`/tmp/fake-bad.json` 含 1 号已知红
＋ 1 条全新未知红 `something brand new > that nobody has seen`。两个方向都对，脚本才算数——
只跑「必不抓」那一半，恒返回 0 的脚本也能过，这里两半都真的跑了。

**真实跑一次**（`export ECC_GATEGUARD=off DISABLE_OMC=1`）：
```
./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/reds.json > /tmp/reds.log 2>&1
node scripts/check-known-reds.mjs /tmp/reds.json > /tmp/reds-verdict.txt 2>&1; echo "RC=$?" >> /tmp/reds-verdict.txt
```
**结果**（`/tmp/reds-verdict.txt`，整份读回）：
```
known reds in roster: 13
failed: 1
  known  quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone
unexpected: 0
RC=0
```
全量 `numTotalTestSuites` 59 files（*）／`numTotalTests` 814，`numFailedTests` 1（就是 roster 第 1 条那条
稳定红），`success: false`（因为那一条红），但 `check-known-reds` 判定 **RC 0**，与 Global
Constraints §8「baseline 失败集合 ⊆ roster」一致。
（*）文件数与开工基线 58 有 +1 出入，未深究——不影响判据 1 的子集判定，判据按全名不按文件数。

### 11.4 变异电池总账（Task 1–10 全量，逐条"期望红／实际红／sha256 前后"）

⚠️ **口径说明**：Task 1、Task 8–10 的原始报告本身已经记了全 64 位 sha256，下表直接照抄。
Task 2、Task 3–7 的原始报告把 sha256 写成了省略号截断形式（`sdd-ledger.md` 里已有 deferred
minor 记录这件事，裁定"不回溯改，只从下一 Task 起收紧"）。**为了满足本批次"每次引用都给全
64 位"的要求**，本节没有凭空补全那些截断值，而是**在同一份 HEAD（`bdaa92c`）上真实重放了
这些变异**：核实过 `fileStore.ts`／`runLoop.ts`／`resumeLoop.ts`／`leaseHeartbeat.ts` 四个文件
从 Task 3–7 落地到今天**字节未变**（Task 8–10 没碰它们，`shasum` 全部与截断引用的前后缀吻合），
所以在同一份 pristine 源码上重放同一处删除/替换，得到的就是当年本该测到、只是没被完整记下来
的**同一个**全 64 位值——不是另编的近似值。命令与结果见
`/private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/1de723ea-71e0-4d2e-99b6-7d1116658c4f/scratchpad/run_mutations.py`
与其输出 `/tmp/mutation_run.log`（整份读回，20 条全部 RC=1，即红被看见）。
**六条重放结果与原报告截断值完全吻合**（M4-1、M4-4、M5-1、M5-2、M5-3、M6-3 的全 64 位前
若干／后若干字符与原表一致），其余条目的具体删除文本无法逐字节还原原始 diff（原报告没留
下确切 diff），但删除的**分支/位置**与预测一致、且**实际红的测试名与原报告记录的完全一致**
——记为"今日重放测得"，不冒称"原始测量"。`M5-3` 的具体变异写法是从中文 brief
"把两处的 detail 改成共用一个字面量（让事件与错误漂移）" ＋ 原报告"drift 落在 claim-catch
共用的 appendEvent 调用上"反推重建的：把 claim-catch 的 `appendEvent` 的 `detail` 硬编码成
字面量、`throw` 那侧仍用计算值——**测得 5 条红，与原报告"5 tests"完全一致**，且 sha256 也
全 64 位吻合，判定重建准确。

#### Task 1（`fileStore.ts` 红线活性下沉 ＋ `noUnlockValueImport.structure.test.ts` 守卫）

| 变异 | 场景/改动 | 期望红 | 实际红 | sha256 前 | sha256 后 |
|---|---|---|---|---|---|
| M1-1 | 删 `classifyProcessLiveness` 的 `pid < 1` 提前返回 | pid-0 判据 | `classifyProcessLiveness > answers unknown for pid 0 WITHOUT issuing the syscall, and names why`（1/4，与预测一致） | `a7ec324812fe998f3f74eb43496920d570eff69b55733d551ade70614832ee73` | `05abfb1b66fe1ad42aab80b394ebbf8771994e1d256999153d4d2fe8efb121e1` |
| M1-2 | `reason` 字面量改成 `"unknown"` | 越界 pid 判据 | `... answers unknown with the errno for a pid too large to be one`（1/4，与预测一致） | 同上 | `75e1c865818dc5d9b48a059247b65c8b8cbbacc023ec9dd1eaeeb8cb1329e655` |
| M1-3 | `code === "ESRCH"` 取反 | brief 预言 ESRCH＋alive 两条 | **预言错**：实际是 ESRCH 判据 ＋ 越界-pid 判据（2/3）——"alive" 那条走 `process.kill(process.pid,0)` 成功路径，结构上进不了被变异的 `catch`；brief-anchor 错误，非实现缺陷 | 同上 | `f0a51226155c7b01d9614bdf27974dceb485a45f55b8f0c9fc104042b275d22b` |
| M1-4 | 单行值导入 `ownerTransferLockPath` from `../unlock/inspectLock.js` | 模块边界判据 | `fileStore module boundary > never value-imports from src/unlock...`（1/4，与预测一致） | 同上 | `be1b1ba56dd7c2e9e6de6fb0960ec83480f8931fe5d08113be584bad593ed33f` |
| M1-5（修复轮1新增） | 多行值导入（无注释） | 同上，验证收紧后的解析器仍抓多行 | 同上判据（1/5） | 同上 | `695e98432f30e9fc9a8ce87bbe3ec0971ccd4dd48ed465ff06475215523d562c` |
| M1-6（修复轮2新增） | 多行值导入，续行带 `// TODO;` 注释（分号在注释里） | 同上，验证"先剥注释再判" | 同上判据（1/7） | 同上 | `88edd9854fe4bf57a12aac90fbf46ec3f0849bc38cf52d4c60c7dfc8362154b7` |
| M1-7（修复轮3新增） | 测试文件自身：`stripComments` 换成恒等函数（针对测试自身的空判据发现） | 前一轮新增的两条判据都应变红 | 两条判据同时变红（2/6）：`... does not let a semicolon inside a trailing comment truncate...` 与 `... treats a mention of ../unlock/ inside a trailing comment as gone...` | `e97b90923562e3f51b97a5b4340edb2b1aeb38c6a3d3c44c09900adb877de3d7`（测试文件自身） | `1ae33adfc3f8d0699a131ad0a0872520a2f862eda45c7ec90ce2afe64a49e356` |

来源：`task-1-report.md`（全 64 位原文已给）。M1-4／M1-5 在修复轮 2 重跑回归检查，红不变。

#### Task 2（红线函数分格 ＋ 新错误类 ＋ 构造点）

| 变异 | 场景/改动 | 期望红 | 实际红 | sha256 前 | sha256 后（今日在 HEAD 重放，含义见口径说明） |
|---|---|---|---|---|---|
| M2-1 | 删 `liveness.verdict === "unknown"` 分支 | unprobeable-holder 判据 | 原报告：1/4，`refuses with a named liveness error...`。**今日在 HEAD `bdaa92c` 重放**：2 条红（多出 Task 3 后来加的"spends the whole reconciliation retry bound"判据，因为它也走同一分支——本轮之后新增判据覆盖面变宽，是预期的，不是缺陷） | `3bd418243959c276803512eac65c9efd6553086cf1da7b2d40a9c6546aba713c` | `3d9ef258f50f66559cb8c4f09ea0374753bf83d60e313ca1a82314be37b25f47` |
| M2-2 | 构造点 liveness-undetermined 分支改抛 `OwnerTransferLockBusyError` | 同上 | `refuses with a named liveness error...`（1/4，与预测一致） | 同上 | `a201621faaad9c626d9367600467c37f629e5a76e8c1145c4458198e5865816f` |
| M2-3 | 消息文案 "may or may not clear" → "will not clear" | 同上 | 同上（1/4，与预测一致） | 同上 | `6aad7d4d8e5ce2f9d047993c7a7af0464868ea41e5c9781678fc08b1a27ed146` |
| M2-4 | holder-alive 分支也抛新类 | `still calls a genuinely live holder busy...` | 同上（1/4，与预测一致） | 同上 | `e2acdc774dfdb2ab21d4efdc5e7815131303d36b5c8f2d2c9a1e35776f9be944` |
| M2-5 | `liveness.verdict === "alive"` 取反 | brief 预言 2 条红 | **预言错（原报告已记）**：实际 3 条红——取反后 `"dead" !== "alive"` 也为真，dead-holder 判据被连带带红。今日重放：3/4，测试名与原报告一致 | 同上 | `5c735b6cded89627f5ad50f680ae67ad38d8e9765be72f46256b7441f92cf110` |

来源：`task-2-report.md` 记录了原始测试名与截断 sha；后一栏全 64 位为今日重放（口径见 §11.4 开头）。

#### Task 3–7（三处重试闸门 ＋ 两处处置点 ＋ 逃逸点，合并派发）

| 变异 | 场景/改动 | 期望红 | 实际红 | sha256 前 | sha256 后（今日重放） |
|---|---|---|---|---|---|
| M3-1 | 删 `fileStore.ts` 调解重试闸门新增的 `\|\| ...LivenessUndeterminedError` 分支 | 调解重试判据 | `spends the whole reconciliation retry bound on an unprobeable holder...`（1/1，与预测一致；今日重放因新增判据覆盖变成 1/95 skip 形态，同一条判据命中） | `3bd418243959c276803512eac65c9efd6553086cf1da7b2d40a9c6546aba713c` | `9d99dfe2ce9392e68534e3456f205a23dcfdca7976e6f33b3323a9f6411daa67` |
| M3-2（重跑，Task4 之后） | `runLoop.ts` 重试闸门同一分支 | brief 预言由 Task4/5 判据接住 | **预言错（第一次跑 0 红）**：实施席补了专门判据后才捕获，`lease heartbeat lifecycle > retries a liveness-undetermined owner-transfer lock to the same bound a busy one gets, before abandoning`。今日重放（对最终已含该新判据的 HEAD）：1/32，同一条判据命中 | `62d3a3b73c59e77259b9a4430d554e6425d41a8e54f361e8284b9154f570131a` | `97e98b255747445bf64df95e5f5bd3ba11fb7be9101053b619733596f34b8252` |
| M3-3（重跑，Task5 之后） | `resumeLoop.ts` 同一分支 | 同上，Task4/5 判据接住 | **预言错（第一次 0 红）**，补判据后：`resumeLoop > retries a liveness-undetermined owner-transfer lock during the resume claim to the same bound a busy one gets`。今日重放：1/20，同一条命中 | `0c89587eb17b5f04b92d2a490082a582b96fbb061672ecaf161650be641831a2` | `5222268d5011000a50b787971079f4836c6e681a4579a9d9ecd3168131e1a3e9` |
| M4-1 | 删 `runLoop.ts` 第一处处置点新分支 | 2 条判据 | `contains an undetermined-liveness transfer lock...` ＋ `retries a liveness-undetermined...`（2/32，与预测一致；今日重放 sha256 后**与原报告截断值完全吻合**：`12a86f31...c508016ea50`） | `62d3a3b73c59e77259b9a4430d554e6425d41a8e54f361e8284b9154f570131a` | `12a86f31c2e7ae16fb9e6a6208c36551db31604e7f7cd179db0f8c508016ea50` |
| M4-2 | 删 `runLoop.ts` 第二处处置点新分支 | 1 条判据 | `abandons the attempt in place when the ownership read hits an undetermined-liveness transfer lock...`（1/32，与预测一致） | 同上 | `276005b2258a319ce44a56b19ab8c5fc5ab3f60e56aaedbba6d14ced5932e173` |
| M4-3 | 两处新分支都去掉 `${String(error)}` | 2 条判据 | 同 M4-1 的两条（2/32，与预测一致） | 同上 | `b537ca1dc3f21accc8dec3acd61a1ae8ed9df3af001327709fff017a2e826191` |
| M4-4 | 第二处处置点删 `writeOwnedRunState` | 1 条判据（推翻人裁 118 对该分支的"钉不住"） | `abandons the attempt in place...`（1/1，与预测一致；今日重放 sha256 后**与原报告截断值完全吻合**：`e6329edd...b481f9a233da3`） | 同上 | `e6329edd9a7b88365b5c0ae179569d653ea1000fee8f8fa03efb481f9a233da3` |
| M5-1 | 删 `resumeLoop.ts` 读-catch 新增三元分支 | 1 条判据 | `names an undetermined-liveness transfer lock on the entry read...`（1/20，与预测一致；今日重放 sha256 后**与原报告截断值完全吻合**：`9e25bc4a...4de318681404c34fce80a82f`） | `0c89587eb17b5f04b92d2a490082a582b96fbb061672ecaf161650be641831a2` | `9e25bc4a1efb1c46b3a44e154fcb53883fc1f8744de318681404c34fce80a82f` |
| M5-2 | 删 `resumeLoop.ts` claim-catch 新增三元分支 | 2 条判据 | `says the liveness could not be determined...` ＋ `retries a liveness-undetermined...`（2/20，与预测一致；今日重放 sha256 后**与原报告截断值完全吻合**：`31062cd7...981589fcc7c46594cbd4`） | 同上 | `31062cd7340f3b99e0b0af120fd50e994c55e1a2a58d981589fcc7c46594cbd4` |
| M5-3 | 两处 detail 改成共用一个字面量（事件与错误漂移） | brief 预言仅命中判据 2 | **比预言宽**：5 条红（原报告已记"wider than predicted"）——今日重放同样测得 **5/20**，与原报告"5 tests"一致；sha256 后**与原报告截断值完全吻合**：`ef74c0b3...397135e7ea6a0d8389bf` | 同上 | `ef74c0b3d4ea0baf5095de091ff2e6c632d0a05ada67397135e7ea6a0d8389bf` |
| M6-1 | 删 `leaseHeartbeat.ts` affirm-path 新分支 | 2 条判据 | `records an undetermined-liveness owner-transfer lock once...` ＋ `records both lock errors in one run...`（2/28，与预测一致） | `51159f2ed227be050c32bde2c3a6c6edd5817e80a0e19ab90537ba289b038990` | `7f76df67c3ab52a62d9d35da44b8813e4d27721e12f1294c883193dbbddd65b3` |
| M6-2 | 删 `leaseHeartbeat.ts` release-path 新分支 | 1 条判据 | `records an undetermined-liveness lock when stop() is the first to meet it...`（1/28，与预测一致） | 同上 | `03a2767a4ed62c6a4b948aace214a9e669f7474f0e006a4011211ccf9ab59bef` |
| M6-3 | 事件类型改回 `owner_transfer_lock_unattributable` | 3 条判据 | criteria 1/2/3 全红（3/28，与预测一致；今日重放 sha256 后**与原报告截断值完全吻合**：`64a6e883...274fef3d928fa4c6b0`） | 同上 | `64a6e883def4536dfb95f995473a37944d7f4b006b97c7274fef3d928fa4c6b0` |
| M6-4 | 两个 flag 合并成一个 | 1 条判据 | `records both lock errors in one run, because one flag cannot speak for the other`（1/28，与预测一致） | 同上 | `6341079b8759f8e65a13182a597db1d75416f29ead2f7f8ed5e9d0222ad9fd62` |
| Task7 逃逸点 | `fileStore.ts` `readOwnerRecord` 逃逸条件删掉 `\|\|` 那支 | 判据 ＋ 意外收获 | `fileStore > lets an undetermined-liveness lock escape the read...`（预测）**AND** `lease heartbeat lifecycle > abandons the attempt in place...`（意外收获，证实 Task7→Task4 的隐藏依赖）；今日重放 2/148，测试名与原报告一致 | `3bd418243959c276803512eac65c9efd6553086cf1da7b2d40a9c6546aba713c` | `1b63a264dbe8c1b43bee6991f49b747c5a9d432af711b102c3ff55360ad0e975` |

来源：`task-3-7-report.md`（原始截断 sha ＋ 原始判据名）。后一栏全 64 位为今日在 HEAD `bdaa92c`
重放所测（口径见 §11.4 开头），命令与整份日志见 `/tmp/mutation_run.log`。

**登记为"钉不住"的项**：本轮 Task 1–7 **没有**任何一条变异最终登记为"钉不住"——
两处预告过"可能钉不住"的（`runLoop.ts` 第二处处置点的 `writeOwnedRunState`、
`leaseHeartbeat.ts` 两个独立 once 标志）最终都造出了判据（M4-4、Task6 criterion 3），
详见 `task-3-7-report.md`"Registered as unpinnable"一节：**None**。

#### Task 8–10（`ccloop ls` 锁可见层）

| 变异 | 场景/改动 | 期望红 | 实际红 | sha256 前 | sha256 后 |
|---|---|---|---|---|---|
| M8-1 | 删 `row.kind !== "run"` 判断（issue 行也被探测） | never-probes-issue-row 判据 | 该判据 ＋ 连带命中 in-scan-order 判据（2 条，符合预期加连带） | `9949dd69e43bb2c774f2eb11d143dd6d2879255e54aaffc11a2685c58672cae5` | `c3991e6de664d70fd5334bdfc33eac32e8cd7bf3ea4fdffa43309e38f31d3d8a` |
| M8-2 | 只在 `state !== "absent"` 时挂 `lock` | attaches-inspection-to-every-run-row 判据 | 该判据（1 条，与预测一致） | 同上 | `8271f3f822798bb07dedf05864ff4b3facc2683718c72827ae8cf19b89edab7a` |
| M8-3 | `Promise.all` ＋ `.reverse()` | brief 预言"in scan order"判据 | **预言不准（原报告已记）**：`in scan order` 判据只钉调用序不钉结果序，**不红**；实际是 never-probes-issue-row 判据被打红（2 元反转导致 `attached[0]` 互换）。不是覆盖缺口（该变异确实被逮住），但诊断精度被记为"registered as unpinnable / flagged"里的一条 | 同上 | `25207d90dc3d75322432f79a19cd810ecde768fd392f768ef7fe2954d817031e` |
| M8-4 | 探测总用 `rows[0].path` 而非 `row.path` | 2 条判据 | never-probes-issue-row ＋ in-scan-order（2 条，与预测一致） | 同上 | `f84884b91a1958bdaa35a70a13cc2c42ad6df21630371d869c41781bb007d4ea` |
| M9-absent | 删 `absent` 早退早返回 | absent 渲染判据 | 只有该判据（1/18，与预测一致） | `9c8d08cf250291b44764a5ebe89831173cb7039e56785504d4d0ced9fab63837` | `2e0be8fe4e182771e37656870a045e6b9aeef573213adc6493f48ed738036786` |
| M9-dead | 删共用分支的 `case "dead":` | dead 渲染判据 | 只有该判据（与预测一致） | 同上 | `9d79aa29028d6b6f1de0d714977c1da74da532b33bef6e2bb0e72c6554716edd` |
| M9-alive | 删共用分支的 `case "alive":` | alive 渲染判据 | 只有该判据（与预测一致） | 同上 | `f39ee06dad32dec3b4b633d3218960127b7ba7c6d109d3410c55a29ef2c097a2` |
| M9-liveness-unknown | 删该 case | liveness-unknown 渲染判据 | 只有该判据（与预测一致） | 同上 | `f08e2ab93eb44a9288ddd5b02bde5a73db5f5e53b5e25c583330ed5b5643ccbc` |
| M9-unrecognized-holder | 删该 case | unrecognized-holder 渲染判据 | 只有该判据（与预测一致） | 同上 | `559e8192508767bbb29b19a7ba94e0b72ac79c82efaf5af7a68076e3a8d8d02c` |
| M9-unparseable | 删该 case | unparseable 渲染判据 | 只有该判据（与预测一致） | 同上 | `0eaed8850b699c1199849e7158cdae28ec61f8ca9e98b3843a4033cd3eef1bc6` |
| M9-file-unreadable | 删该 case | file-unreadable 渲染判据 | 只有该判据（与预测一致） | 同上 | `4af858063055f227a291245707de62f85ae855b88f0240f8158412e8afef3457` |
| M9-8 | 让 file-unreadable 也渲染 digest | file-unreadable 判据（第 2 断言） | 只有该判据（与预测一致，brief 明确"期望红在第 2 条"） | 同上 | `7435554487094c09adec215a9885e213c3ac65be7750c223b5e0909026b2f039` |
| M10-1 | 跳过 `attachLockInspections`，直接 `toScanResult(rows as never)` | 判据1／2 | 判据1/2 ＋ 3 条连带（共 5 条，全部因同一根因：`row.lock.state` 无条件访问），与预测一致外加连带说明 | `92e37f2daf52d762889471667f8b2b1c61000773235b8fe474ea17b6b01b74de` | `e84d971a681cc76181340660df3ea52e9121ec90eec546988934a512b87ef453` |
| M10-2 | 把 `attachLockInspections` 挪到 `scanRootFailureDetail` 之前 | brief 明确预言"无红" | **无红**，41/41 全绿——今日重放**证实同一结果**（41/41），这是性能排序决策，本身就不该有判据钉它，无红不是缺口 | 同上 | `8e7433c2b65bf2a9b27f77ede9831c197350f9fffbb149984b3110c4337a254d` |
| M10-3 | 遇到 `file-unreadable` 时 `return 1` | 判据2 | 只有判据2（与预测一致），今日重放证实同一结果 | 同上 | `32255339bd008d4ef198827b72ba12cfcc41652dcc75d65b3705944d7c575a29` |
| M10-4（第一次） | 在 `attachLockInspections` 里对每个 run 目录 `utimes` | 零写判据 | ⭐ **意外全绿（44/44），真缺口**：共用的 `snapshotTree` 从未记录目录自身 mtime——零写证明对"目录被 touch"这一类回归结构性看不见（本轮之前就存在，本轮发现） | `src/unlock/lockRows.ts` 前 `9949dd69e43bb2c774f2eb11d143dd6d2879255e54aaffc11a2685c58672cae5` | 后 `00de62d5de82728fa96c4ca8eb485dccf772aca4a27715198c1caf96cb24c866` |
| M10-4（修复 `snapshotTree` 后重跑） | 同一变异，`2e918a7` 之后的新 clone | 零写判据 | 正确单条变红（43/44），无连带损伤 | 同上（`2e918a7` 提交前后的 `lockRows.ts`） | 同上 |

来源：`task-8-10-report.md`（M8/M9/M10-1/M10-4 全 64 位原文已给）；M10-2／M10-3 原报告 sha256
栏是空的（`—`），**今日在 HEAD 用同一段代码重放补齐**（同一份 `src/cli.ts` pristine sha
`92e37f2d...b74de` 与原报告完全一致，说明这两条变异是在同一份源码上重放，不是近似值）。

**登记为"钉不住"的项**：Task 8–10 也没有正式登记任何一条为"钉不住"；M8-3 被记为
"registered as unpinnable / flagged, not silently smoothed over"里的一条，但它**不是**判据看不见
这个变异（它确实被逮住），只是诊断精度不如 brief 预期精准——已如实记录，未改代码。

### 11.5 全量结果对照（判据 1、typecheck、build）

命令（`export ECC_GATEGUARD=off DISABLE_OMC=1`，全部重定向到文件再整份读回）：
```
./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/final.json > /tmp/final.log 2>&1
node scripts/check-known-reds.mjs /tmp/final.json > /tmp/final-verdict.txt 2>&1; echo "RC=$?" >> /tmp/final-verdict.txt
npm run typecheck > /tmp/final-tc.txt 2>&1; echo "RC=$?" >> /tmp/final-tc.txt
npm run build     > /tmp/final-build.txt 2>&1; echo "RC=$?" >> /tmp/final-build.txt
```
结果见任务收尾报告 `task-11-12-report.md`。

### 11.6 变异副本处置

本节所有变异重放都在会话 scratchpad 目录下的 `git clone --local` 副本
（`ccloop-mutclone-t1112`）里进行，主工作树全程未被写入——每条变异跑完都用
`git checkout -- <file>` 复原并用 `shasum -a 256` 核对复原后与变异前完全一致；主树的
`fileStore.ts`／`runLoop.ts`／`resumeLoop.ts`／`leaseHeartbeat.ts`／`cli.ts` 在整个变异电池
期间 `git status --porcelain` 全程为空。副本用完后按人裁 137 的站立授权（同时满足：不在
`git worktree list` 里／HEAD 是主仓库已有提交／除变异残留与 `node_modules` 软链外无未跟踪
内容）清理：先 `/bin/rm -f` 软链，再 `/bin/rm -rf` 目录，删后核对主树 `node_modules` 完好。

### 11.7 提交

本节改动分两笔提交：
1. 代码勘误（`src/sweep/lockPresence.ts`、`src/persistence/fileStore.ts`、
   `src/unlock/inspectLock.ts`）＋ `docs/superpowers/specs/2026-07-28-run-registry-design.md`
   更正节 ＋ `scripts/check-known-reds.mjs`。
2. `.superpowers/sdd/2026-09-23-ls-lock-visibility/progress.md`（本节）── 该目录整体
   gitignored，需单独 `git add -f`，不与第 1 笔混在一次 `git add` 里。

具体 SHA 见任务收尾报告 `task-11-12-report.md`。

---

## 12. 整支复审修复轮（Final Whole-Branch Review Fix Wave，2026-09-23）

> **归属**：控制器会话 `1de723ea`（Orca 仓的 run，在 ccloop 侧执行），2026-09-23，紧接 §11 之后、
> HEAD `63f0a4a` 之上的一批 review 修复。观测锚点即本节写入时 ccloop 的 HEAD。
> 详细证据（每条判据的 RED/GREEN、每个变异的完整 sha256 前后、命令原文、实际红名）见同目录
> `final-fix-report.md`（英文，Rule 1 语言分工：代码/报告细节用英文）。本节只留中文摘要与
> CARRY 项的正式登记。

### 12.1 已处置（Critical/Important/Minor，逐条落点）

| 编号 | 落点 | 处置 |
|---|---|---|
| C1 | `fileStore.ts`，`StaleOwnerTransferLockOutcome` 上方注释块（人裁 108 的 ERRATUM） | 追加具名人裁 132／133 的新 ERRATUM，指出三处不再成立的断言；disposition 点另一处同源假话也补了一段 |
| I1 | 人裁 138：message 必须点名 pid | `liveness-undetermined` 变体加回 `pid: number`（`holder-alive` 不加，人裁 108 对它仍成立）；message 改字面量；新判据用 EPERM 格钉住 pid；spec §11.6 记录定案；变异（去掉 pid）现场翻红 |
| I2 | `renderRuns.ts` 的"避免闭合循环"论证是假的 | 就地改正（本轮自己的文本）；新增 `tests/registry/noUnlockValueImport.structure.test.ts`，镜像 persistence 侧同名判据的 stripComments/importStatements 手法，必抓/必不抓两个方向都过 |
| M1 | `check-known-reds.mjs` 的双向 suffix 匹配留了一个洞 | 追加具名 ERRATUM（本条脚本注释是本轮早前提交发布过的文本，就地不改，只追加）；匹配收紧为只认祖先边界（`known === name \|\| known.endsWith("> " + name)`）；三个方向（已知全绿、含未知红、洞的复现样本）都实测 |
| M2 | `fileStore.ts` 一段本轮自己的 ERRATUM 漏列了两个 import | 就地改正（本轮自己的文本） |

### 12.2 CARRY — 不修，正式登记

**M3**：一把锁**同时**满足「活性判不了」与「有事务标记」时，`owner_transfer_contended` 会被记两次
（一次在 disposition 点，一次在 escape 重抛之后）。现有判据全部只断言"恰好一次"，没有一条覆盖这个
组合。**这不是回归**——`unattributable` 的同胞格早就有这个形状——但新类把它从一个偏门场景变成了
一个远更普通的诱因也能踩到的坑。登记为已知的、未覆盖的组合，不在本修复轮里处置（会改变一处既有
判据背后的事件计数逻辑，触发人裁 88 的指名程序，超出本轮授权范围）。

**M4**：`tests/registry/zeroWrite.test.ts` 的 `snapshotTree` 只记目录条目，不记扫描根自身。
一个只碰了根目录自身 mtime（而不碰任何条目）的探测，对零写证明结构性不可见。此前 Task 10 已在
`M10-4` 项下发现并修过"目录条目 mtime 看得见"这一半（见 §11.4 表格），**根目录自身**这一半仍是
盲区，本轮如实登记，不处置。

### 12.3 变异副本处置

沿用 §11.6 同一套规矩：所有变异（I1 的去 pid、I2 的插入 value import）都在会话 scratchpad 目录下
新开的 `git clone --local` 副本（`mutclone`）里进行，主工作树全程未被写入 —— 每条变异跑完立即
`git checkout -- <file>` 复原并用 `shasum -a 256` 核对复原结果，主树 `git status --porcelain`
在整段变异电池期间为空（今测：仅有本轮自己尚待提交的修复本身，无变异残留）。M1 的两个既有方向
与洞的复现样本无需 build/clone（纯 Node 脚本 + 构造好的 JSON 报告），直接在主树用
`git show HEAD:scripts/check-known-reds.mjs` 取出修复前的版本对照复现，未触碰主树任何文件。

### 12.4 §12.1 里 C1 的"附带"修复自己造了一处假话 —— 外派复审抓到，已改

`fileStore.ts` disposition 点那处"附带"追加的 ERRATUM（§12.1 表格 C1 行里提到的"disposition 点
另一处同源假话"）里写了「no longer holds for two of its three named cells」。**现测为假**：
用 `classifyProcessLiveness` 逐支核对——`pid < 1` 返回 `unknown`（即 `pid:0`）；`ESRCH` 返回
`dead`；**其余全部**返回 `unknown`（覆盖越界 pid 与 EPERM）——`pid:0`、越界 pid、EPERM 三格
**全部**落在 `unknown`，没有一格落在 `alive`。也就是说该 ERRATUM 点名的三格**没有一格**还会走到
下面那个 Busy 的 throw，不是"三格里的两格"。该段自己后面几句话已经把这件事说对了（"pid:0, an
out-of-range pid and an EPERM refusal are now liveness-undetermined... only a genuinely live
holder (holder-alive) still reaches that throw"），所以这段话是**自相矛盾**的——前半句和后半句
打架，写的时候没人核对过。

**破的规矩**：本仓库对 ERRATUM 的铁律是"不许在里面写一个会被后续裁决推翻的新计数——指向台账即可"
（design spec §7 明说）。这次错的不是"两"该改成"三"，而是**一个计数压根不该被写进 ERRATUM**——
这条 ERRATUM 是本轮自己在处理 C1 时"顺手"追加的（不在 C1/I1/I2/M1/M2 五条具名 finding 之列），
外派复审逐字核对时抓到。**已用同一手法（追加新 ERRATUM，不改历史）改正**：新 ERRATUM 指出那句
"two of its three"为假、指出段落自相矛盾、指出计数本不该出现在 ERRATUM 里，且**自己也不带任何
计数**——不写"三"作为断言，只点名三格各自的名字（`pid:0`、越界 pid、EPERM 拒绝），照抄 spec §7
的规矩。

**过程教训（本轮最锋利的一条）**：这个缺陷是在**关闭同一类缺陷的这一轮修复里，被一次未被要求
的"顺手"修复自己引入的**。正确的做法本该是发现即报告、交给复审处置，而不是自己动手——这正是
外派复审这次纠正想说的话。
