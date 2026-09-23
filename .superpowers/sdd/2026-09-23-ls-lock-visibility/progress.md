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
