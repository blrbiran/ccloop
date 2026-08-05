# Scan D — 清单外交接项盘点（L5 输入）

**扫描员**：只读输入盘点员（车道 D）
**仓库 / 分支 / HEAD**：`/Users/biran/code/skills/loop/ccloop`，`main`，`e9021ef`，工作区干净
**日期**：2026-08-05
**只读声明**：本次扫描未修改 `src/`、`tests/`、`docs/` 的任何文件。唯一写入的文件是本报告。

---

## 0. 完整度自述（先说哪块没做完）

| 块 | 状态 |
|---|---|
| `docs/superpowers/` 全库 `L5` 逐行过筛 | **完整**（78 行候选，逐行分类，见 §2） |
| 中英文同义交接措辞（「留给后续」「不在本层」「bequeathed」「deferred to」「out of scope」「later layer」等） | **完整**（命令与输出见 §1.2） |
| `.superpowers/sdd/` 门评审与台账里的 L5 交接 | **完整到「已枚举并逐条引用」**；未做的是逐条回代码复核每一条 minor 的技术真伪（不在本车道范围） |
| 必答问题 1（L5 原始委任状） | **完整**，且**发现派单前提有误**，见 §4.1 |
| 必答问题 2（§16 第 11 行伪结构） | **完整** |
| 必答问题 3（触发条件已变的交接） | **完整到「找到两条已记录的撤回先例 + 一条文档未同步的撤回」**；见 §4.3 |
| 「清单外共 N 条」这个数字 | **未给出单一 N**。理由见 §1.1 —— 我能给出两个可重数的**行数**，但「条目数」是人工归并，不可机械重数，按铁律不报 N |
| §5.1 的 §2/§5.4 张力 | **未完成**：我读了 `evaluateResumeEligibility` 的八条判据，但**没有**追出「一个被 Ctrl-C 的 run 在什么条件下盘上已有 eligible transfer」的完整路径。缺的是：`persistBoundaryAnalysis` 在一次正常 run 内的触发条件。按铁律标为「无法判断是否真矛盾」 |
| `docs/superpowers/specs/2026-08-01-…-design.md` §4.6「代码零改动」那句在计划阶段是否真被裁 | **未核实**。见 §2 的 D12 |

---

## 1. 可重数的计数（命令 + 逐字输出）

### 1.1 为什么不报「清单外共 N 条」

「交接项」是人工归并单位：同一件事在 spec / plan / 台账里各出现一次，且 §13 自己把某些事**并进**已有的笔而不单开（原文：「**不单开一笔**——它是本笔的前提条件，不是独立缺陷」，`:2431` 上下文）。因此**没有任何一条命令能重数出条目数**。
我给出的是两个**可重数的行数**，外加 §2 的人工分类表（表本身即证据，每条附出处与逐字引用）。

### 1.2 `docs/superpowers/` 里的 L5 候选行数 = 78

```bash
rtk proxy grep -rn 'L5' /Users/biran/code/skills/loop/ccloop/docs/superpowers/ | wc -l
```

```
      78
```

命中文件（`rtk proxy grep -rlc 'L5' …`，逐字输出，非零者）：

```
/Users/biran/code/skills/loop/ccloop/docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1
/Users/biran/code/skills/loop/ccloop/docs/superpowers/plans/2026-07-28-run-registry.md:1
/Users/biran/code/skills/loop/ccloop/docs/superpowers/specs/2026-07-28-run-registry-design.md:1
/Users/biran/code/skills/loop/ccloop/docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:1
/Users/biran/code/skills/loop/ccloop/docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md:1
/Users/biran/code/skills/loop/ccloop/docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1
/Users/biran/code/skills/loop/ccloop/docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md:1
```

（注：`-l` 与 `-c` 同时给时该 grep 打的是「有/无」而非计数，故上列 `:1` 只表示「该文件有命中」。**逐行清单**见本报告各条引用；78 是上面 `wc -l` 的实测值。）

### 1.3 门评审 / 台账里「带到 L5」类行数 = 23

```bash
rtk proxy grep -nF -e '带到 L5' -e 'defer 到 L5' -e '加到 L5' -e 'L5 台账' -e 'L5 条目' -e '改判给 L5' -e '顺延给 L5' \
  .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-c-lane2-report.md \
  .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-b-lane2-report.md \
  .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-c-fix-wave-report.md \
  .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/group-c-preflight-scan.md | wc -l
```

```
      23
```

完整 23 行逐字输出见 §3.2（**未削短**）。

### 1.4 官方那 6 项的原文锚点

```bash
rtk proxy grep -nF -e 'L5 的输入合计 = 债 2' -e '本层查实、明确不处理、留给 L5 具名继承的五笔' -e '清单是 5 条' -e 'L5 — cleanup / orphan handling' \
  docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
```

```
2321:- **L5 的输入合计 = 债 2 ＋ 下面具名的 5 笔 = 6 项。**（§14 第 1 条已同步。**这个数字随本节末尾的清单条数变化，改清单必须同时改这里。**）
2390:**本层查实、明确不处理、留给 L5 具名继承的五笔：**
2439:（**清单是 5 条**；加上债 2，L5 的输入合计 **6 项**，与本节开头及 §14 第 1 条一致。**改清单必须同时改这三处数字。** 第三轮做的是「一出一进」——第 4 笔换了内容，条数与合计都没动，对照表见本节开头。）
2443:1. **L5 — cleanup / orphan handling**（父设计 §17 item 3）。**输入合计 6 项 = 债 2 ＋ §13 具名的 5 笔**（锁可被偷、execute abort 无第二重上界、**`writeBoundaryArtifacts` 落在 span 外（本轮新发现，需重新裁归属）**、**输家 reconciliation 写的残余 TOCTOU**、被拒 run 的无退避重捡）。**这个数字与 §13 的清单联动，改一处必须改两处。**
```

**官方 6 项的名单（作为「在不在 6 项内」的判据）**：债 2（`persistTerminalState` 往已不拥有的 run 写）＋ 笔 1 锁可被偷 ＋ 笔 2 execute abort 无第二重上界 ＋ 笔 3 `writeBoundaryArtifacts` 落在 span 外 ＋ 笔 4 输家 reconciliation 写的残余 TOCTOU ＋ 笔 5 被拒 run 的无退避重捡。

---

## 2. 分类表 A —— `docs/superpowers/` 内的清单外交接

支撑本表的检索命令（逐字输出见各条引用）：

```bash
rtk proxy grep -rnF -e '原样留给 L5' -e '属 L2/L5' -e '会被 L5 继承' -e "is L5's problem" \
  -e '那类 run 本层碰不到' -e '本层无自动化入口' -e 'bequeathed to L5' -e 'a later layer picks it up' \
  docs/superpowers/
```

---

### D1 — `finalizePendingOwnerTransfer` 的 catch 错误掩盖

- **出处**：`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`，§13 「`finalizePendingOwnerTransfer` 的 catch —— 一条明确的窄例外」小节末尾（紧接在「本层查实…五笔：」标题之**前**）。同句复刻于 `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` 的 A? 任务陷阱清单。
- **逐字引用**（`:2388`）：
  > catch 那个「两个 `safeUnlink` 都可能替换正在传播的错误」的错误掩盖问题**原样留给 L5**（扩到三个之后是三个都可能），触发条件是「清理失败与转移失败同时发生」，与本层要修的窗口无关。

  计划侧（`plans/…:432`）：
  > catch 里「三个 `safeUnlink` 都可能替换正在传播的错误」这个错误掩盖问题**原样留给 L5**，不要顺手修。
- **交给谁**：L5（明确点名）
- **在不在 6 项内**：**不在**
- **类型**：代码缺陷（错误传播语义）
- **有意排除还是漏计**：**无法判断。** 证据两向：(a) 支持「有意」——该句被放在「五笔」标题的**上一行**，结构上像是被刻意排除在编号清单之外，且它挂在「窄例外」小节下（该小节讲的是本层**自己动过**的 catch）；(b) 支持「漏计」——全文**没有任何一句**说明它为何不计入 6 项，而同节对每一次条数变动（一出一进、H7 撤回）都留了显式的记账说明。缺的是一句「它不计入」的表态，因此不许猜。
- **风险**：本层把该 catch 从 2 个 `safeUnlink` 扩到 3 个，即**本层扩大了这个缺陷的面**，却把它留在编号清单外。

---

### D2 — 「人按过 Ctrl-C」这个信息无消费者

- **出处**：同 spec §5.4「⚠️ 停机不消耗任何配额，且不留任何被消费者读到的痕迹」第 2 条；复刻于 plan `:1343`。
- **逐字引用**（`:1400`）：
  > **本层刻意放弃这个区分**，理由：**两者的正确处置恰好相同**——run 停在非终态、所有权未变、租约已释放或将过期，正确动作都是「下一次 sweep 重新续跑」。**引入这个区分需要新增一个被 registry 观测的字段，那是新的磁盘契约，属 L2/L5 的范围，不属本层。** 这里写明是为了不让它被沉默继承。
- **交给谁**：**L2/L5**（含糊二选一，未裁）
- **在不在 6 项内**：**不在**
- **类型**：磁盘契约新增 ＋ 归属未裁（L2 还是 L5 没定）
- **有意排除还是漏计**：**证据指向「有意保留在清单外，但归属从未裁过」。** 第五波撤回第 4 笔的附带交接时**点名重审过这一条**并明确保留：
  > **第四轮那句「与 §5.4 对『人按过 Ctrl-C』的处置是同一个已知缺口，理由也相同」一并撤回**：两者不同类。§5.4 那条是**跨进程**可见性（本次 sweep 其实看得见停机，看不见的是下一次 sweep），只能靠磁盘契约；本条是**同一次 sweep、同一个进程内**的可见性，进程内回调就够。**是这句错误的归类把第四轮引向了「只能等 L2/L5」的结论。** §5.4 第 2 条本身不受影响，原样保留。（`:2436`）

  即：它被审视过、被判定为「真的需要磁盘契约」、被原样保留——**但从未被赋予 6 项中的任何一个位置，也从未在 L2 与 L5 之间裁出归属。**

---

### D3 — §16 修订索引里的伪结构会被 L5 继承

- **出处**：spec §4.0.4「对裁决记录『更窄』判断的回应（第二轮更正：初稿伪造了论证结构）」首段。
- **逐字引用**（`:209`）：
  > **第一轮修订在这里写错了**，且错法是本仓库最忌讳的一种：它写「裁决记录的『这条路比裁决时判断的更窄』有**两条**依据：(a) `newOwnerEpoch` 的排序主张；(b) `assertHeld` 是写者」，然后宣布 §4.1 驳倒了 (a)。**(a) 是本 spec 自己造出来再打倒的——裁决记录从未把它列为「更窄」的依据。** §16 第 11 行还把这个伪结构固化进了修订索引，会被 L5 继承。
- **交给谁**：L5（「会被 L5 继承」）
- **在不在 6 项内**：**不在**
- **类型**：**纯文档**（不需要写代码，但会被沉默继承成假前提）
- **有意排除还是漏计**：**无法判断，因为**缺的是一句说明「文档层面的继承是否算 §13 口径下的『输入』」。§13 对自己清单的定义是「**本层查实、明确不处理**的五笔」（`:2390`），按字面它并不排除文档项；但六项里现存的五笔全是代码/时序缺陷，无一为文档项。两种读法都能成立，无直接证据。
- **补充**：见 §4.2 —— 该行本身还带一处**锚点歧义**（§16 同时存在 `11` 行与 `11b` 行）。

---

### D4 — L1b「输家对赢家 reconciliation 视图的合成」

- **出处**：`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`，`**Amended 2026-07-28 (e)**` 段末句（`:113`）。
- **逐字引用**（该段末句）：
  > The same ruling deliberately gave up the losing process's synthesis of the winner's reconciliation view; if that view is still wanted, assigning it to a process that still holds the run is L5's problem.
- **交给谁**：L5（明确点名，且是 **L1b 时代**写下的，早于 L3 §13）
- **在不在 6 项内**：**不在**
- **类型**：**已裁决关闭，但文档未同步 → 纯文档假前提**
- **有意排除还是漏计**：**有意排除，有直接证据。** 台账 `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md` 记着一条人裁（Task A4）：
  > **Task A4: HUMAN RULING** … L1b `docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:113` "Amended 2026-07-28 (e)" … ends: "The same ruling deliberately gave up the losing process's synthesis of the winner's reconciliation view; if that view is still wanted, assigning it to a process that still holds the run is L5's problem." L3 debt 1 transactionalises reconciliation so the SAME CAS publishes it. **Human ruled: L3's transactionalisation SUPERSEDES L1b (e).** A4's assertion flip stands.

  以及同处显式的数字表态：
  > (b) **L5's inherited-input list is unaffected in NUMBER**: the L3 spec's 13 five-item list does not contain the L1b-side "winner reconciliation view" assignment, so 5 笔 / 6 项 stay. **Record that this L1b-side assignment is now closed by L3 rather than inherited by L5.**
- **⚠️ 但 L1b spec 的正文至今未改**，且这件事**当时就被评审员点名并主动放弃处置**：
  > 3. `docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:113` now states something production code contradicts. Repo convention is an in-place *Amended (f)* note, and the debt-4 precedent explicitly says a later layer that falsifies something should annotate in place. **NOT done here**: the human's approved option covered a code comment + ledger only, and the plan's stance is that spec errata are the human's timing call. **Flag for the human.**

  **后果**：任何只读 `docs/superpowers/` 的 L5 承接方，会把一条**已被裁定关闭**的事项当成活的 L5 委任读进来。

---

### D5 — 被硬杀的进程留下的那类 run

- **出处**：spec §2「不做（每条都是刻意的）」第 1 条。
- **逐字引用**（`:46`，末句）：
  > 被硬杀的进程不会留下 eligible transfer，那类 run 本层碰不到（属 L5）。
- **交给谁**：L5
- **在不在 6 项内**：**不在**
- **类型**：L5 **本职**范围声明（orphan 人口的唯一具名处）
- **有意排除还是漏计**：**有意排除，有结构性证据。** §14 第 1 条把 L5 的标题写成「**L5 — cleanup / orphan handling（父设计 §17 item 3）**」，把「本职」与「输入合计 6 项」并列成两件事；所以本条属于「本职」侧而非「6 项」侧。
- **⚠️ 但这正是问题所在**：它是全仓**唯一**一处指认 L5 要处理的实际 run 人口，且只有半句话。见 §4.1。

---

### D6 — 钉死态的人工恢复：本层无自动化入口

- **出处**：spec §15 验收 2「已知例外」第 3 条的尾段。
- **逐字引用**（`:2487`）：
  > 对**不可达的那两条**：若有人手工构造出它们（或把原子写改回去），表现是「marker 仍在但推不完」，**恢复手段只有人工删除该 run 目录下的 staging，本层无自动化入口**（§2 把 cleanup/GC 排给了 L5）。
- **交给谁**：L5（经 §2 转指）
- **在不在 6 项内**：**不在**
- **类型**：L5 本职（自动化清理入口）的一条**具体需求**
- **有意排除还是漏计**：同 D5，属「本职」侧。但它是全仓**唯一**一处写出「L5 需要提供什么样的清理入口」的句子，而它出现在一条验收标准的脚注里，不在任何交接清单上。

---

### D7 — L2 spec 仍写着「三笔债留给 L5」

- **出处**：`docs/superpowers/specs/2026-07-28-run-registry-design.md`，§2 Non-Goals 第 6 条与 §13 首段。
- **逐字引用**：
  > `:57`：6. discharge any of the three debts bequeathed to L5 (§13);
  > `:468`：Debts 1–3 are bequeathed to L5 and are unchanged by this layer.
- **交给谁**：L5
- **在不在 6 项内**：**不在**，且**与 6 项直接冲突**——2026-07-29 归属裁决把债 1、债 3 判给 L3，只留债 2 给 L5。
- **类型**：**纯文档 / 过期断言**
- **有意排除还是漏计**：**漏做，有直接证据。** 裁决记录**明令**要求改写这份清单，而改写从未落到该 spec 上：
  > `decisions/2026-07-29-technical-debt-attribution.md:246`：2. **L5 继承清单第 1 条描述有误**：「reconciliation 合成责任无人认领」不成立，见债 1。该条应改写为跨文件事务性缺陷，并从 L5 清单移到 L3。
  > `:248`：4. **L5 继承清单现在只剩 1 笔**（债 2），不是 4 笔。

  **且同一份 L2 spec 的 §13.4 拿到了就地勘误**（`*Amended (j) — this debt is discharged at the write side…*`），债 1/债 3 却没有。**同一节内两种标准**，这是「漏做」而非「刻意保留历史」的证据。

---

### D8 — L1 的 fresh-start 排他 TOCTOU

- **出处**：`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`（§10.1 相关论证段）。
- **逐字引用**（`:293`，末句）：
  > Closing the window properly (an atomic exclusive create) is a real improvement, deliberately **not** in L1's scope, and noted here so a later layer picks it up knowingly rather than discovering it.
- **交给谁**：**「a later layer」含糊指向**，全仓无一处把它指名给某一层
- **在不在 6 项内**：**不在**
- **类型**：代码缺陷 ＋ **归属未裁**
- **有意排除还是漏计**：**无法判断它是否本就该指向 L5**，因为原文只说 "a later layer"，且它与 §13 笔 1「锁可被偷」**不是同一把锁**（笔 1 是 `owner-transfer` 锁协议，本条是 run 目录创建期的排他）。缺的是一次归属裁决。

---

### D9 — L1 的「succeeded 之后才发现被 supersede」区分

- **出处**：同 L1 spec，§8.1 附近。
- **逐字引用**（`:239`，末句）：
  > A future layer that needs to distinguish "succeeded cleanly" from "succeeded, then discovered it had been superseded during cleanup" must read the event log, not the terminal state.
- **交给谁**：**「A future layer」含糊指向**
- **在不在 6 项内**：**不在**
- **类型**：磁盘/证据契约的消费约束（纯文档性质的约束声明）
- **有意排除还是漏计**：**无法判断**，原文未点名任何层。

---

### D10 — L1 记下的两个机制（re-leasing 上限 / 跨 run 路径排他）

- **出处**：L1 spec §3 末尾。
- **逐字引用**（`:47`–`:49` 区域）：
  > Two mechanisms noted here so they are not lost, both belonging to L2/L3 rather than L1:
  > - an **attempt cap on re-leasing**, so a repeatedly failing run cannot be leased and retried forever. …
  > - **cross-run path exclusion**, per §8.2.
- **交给谁**：**L2/L3**（明写不是 L5）
- **在不在 6 项内**：**不在**（也不该在）
- **类型**：归属已裁给 L2/L3
- **⚠️ 但**：L3 §5.4 的裁定与第一条**方向相反**——L3 明确**放弃**把停机计入 attempt 配额（「**本层正面接受这一点**……把停机计入 attempt 配额，等于让「操作者按 Ctrl-C」消耗掉本该留给真实失败重试的预算」，`:1339` 上下文），并把上界交给 `--max-runs`。**「attempt cap on re-leasing」这条 L1 交给 L2/L3 的机制，L3 未兑现且未声明放弃它。** 是否顺延到 L5：**无法判断，因为没有任何文档提过它的去向。**

---

### D11 — §8 既有 `errored` 行的同形缺陷

- **出处**：spec §4.3 第四步末尾括注（`:762`）；复刻于 plan `:1713`。
- **逐字引用**：
  > （**§8 既有的 `errored` 那一行有同样的问题，先于本波存在，本波刻意不动它** —— 那是另一条契约的范围，改它要连带 §7 与测试 12c，收益不抵成本。**具名留给下一轮。**）
- **交给谁**：**「下一轮」**（指评审轮次，不是层）
- **在不在 6 项内**：**不在**
- **类型**：代码缺陷（输出契约） ＋ **归属未裁**
- **有意排除还是漏计**：**有意不在本层修**（原文明说），但「下一轮」是一个**已经过去**的指向——L3 已合入，没有下一轮了。**它现在事实上无人承接**，而没有任何文档把它改判给 L5。

---

### D12 — §4.6「`preserveSuccessfulReconciliationIfNeeded` 代码零改动」已为假

- **出处**：spec §4.3 处置一（`:567`）。
- **逐字引用**：
  > **⚠️ 与 §4.6 的一条冲突，本波只标不改（在本波清单之外，见交付报告）**：§4.6 写着「`preserveSuccessfulReconciliationIfNeeded` **代码零改动**」。**处置一落地之后那句话为假** —— 无论选上面哪种实现，这个函数或它的调用块都必然要动。**下一轮请裁定：是改 §4.6 那句话，还是把整块判定上移到 `writeBoundaryArtifacts` 从而真的保住「零改动」。**
- **交给谁**：「下一轮」（计划阶段接了这条：`plans/…:227`「§4.3 第六波已就地标出「处置一落地之后那句话为假」，并把裁定留给计划阶段。」）
- **在不在 6 项内**：**不在**
- **类型**：纯文档（spec 内自相矛盾）
- **状态**：**本项未完成 —— 我没有核实计划阶段最终裁成什么、也没有核实 §4.6 那句话在 HEAD 上是否已改。** 缺的是：读 `plans/2026-08-02-…md` §「spec 把三件事显式留给了计划阶段」全节 ＋ 比对 spec §4.6 当前文本。

---

### D13 — `writeAttemptArtifacts` 的非原子写

- **出处**：`docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md` §2.2 明确的非目标。
- **逐字引用**：
  > **不改 `writeAttemptArtifacts`（`:712+`）**：写的是 attempt 目录内的产物，不在 run 目录顶层，L2 不观测，且无并发读者依赖其连贯性。**若后续证明需要，另开一笔。**
- **交给谁**：**无人**（「另开一笔」）
- **在不在 6 项内**：**不在**
- **类型**：归属未裁
- **有意排除还是漏计**：**有意排除**（给了理由：L2 不观测、无并发读者）。列在此处只因它是一条无主的悬挂项，不因它指向 L5。

---

## 3. 分类表 B —— `docs/superpowers/` **之外**的第二份 L5 继承清单

> **⚠️ 我在中断前把这块称为「Major find」。复核后我**不**降级这个说法，但把它精确化**：它不是一份与 §13 竞争的「交接清单」文件，而是**台账 `progress.md` 在 GATE-C 合入时写下的一段「L5 现在继承什么」的收尾条目**，加上门评审报告里 23 行「带到 L5」的分诊。二者**与 §13 的 6 项完全不相交**，且 §13 的三处联动数字在同一波被明确宣告「一处都没动」。所以准确的表述是：**L5 今天有两份互不引用的输入来源，一份写在 spec 里（6 项），一份写在台账与门报告里（下列各条），后者从未被折算进前者。**

### 3.1 台账的收尾条目（逐字）

`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`，`STILL NOT DONE, EACH NEEDING ITS OWN HUMAN INSTRUCTION:` 一节第 3 条：

> 3. L5, which now inherits: the resumeLoop concurrent bare reads; the two spec
>    sentences still citing "a single array push" as a premise; group B's two
>    debts; and the deferred-minor list triaged at this gate.

同一份台账更早处（`STILL OPEN, NAMED SO IT CANNOT BE INHERITED AS CLOSED:`）逐字：

> - The `resumeLoop` concurrent bare reads (C4's discovery): five artifacts read
>   in one Promise.all with only readOwnerRecord preceded by recovery. Measured
>   consequence: ONE retryable refusal plus a healthy run reported as `error` on
>   stderr — a false alarm, i.e. an operability defect, not data loss. CARRIED TO
>   L5 with the grading evidence attached.
> - The same-family spec sentences at spec:692 and spec:751 (and their copy at
>   plan:1004) still cite "a single array push" as a PREMISE. Their CONCLUSIONS
>   still hold — spec:751's argument survives an injected stderr sink — so only
>   the supporting wording is stale. Named for L5; the controller did not widen
>   the round to take them.
> - Group B's two carried debts (the predicate-widening half has no test; B1's
>   branch writeRunState has no CAS) were re-derived as STILL UNREACHABLE after
>   group C lands, and travel to L5 unchanged.

**与 6 项的关系**：**完全不相交。** 6 项是「锁可被偷 / execute abort 无第二重上界 / `writeBoundaryArtifacts` 落在 span 外 / 输家 reconciliation TOCTOU / 无退避重捡 / 债 2」；上列是「resumeLoop 并发裸读 / 两句过期的 spec 前提 / 组 B 两笔 / GATE-C 的 deferred-minor 分诊」。无一重合。

**类型分布**：
- `resumeLoop` 并发裸读 → **代码缺陷 ＋ 可运维性缺陷（假告警）**
- 两句「一次数组 push」→ **纯文档，且就在当前 L3 spec 里**（见 §5.3，已在 HEAD 上实测确认仍为假）
- 组 B 两笔 → **代码缺陷（无测试守卫 / 无 CAS），均判定为今天不可达**
- deferred-minor 分诊 → 见 §3.2

**有意排除还是漏计**：**是「有意不折算」，有直接证据。** 同一波的记账明写三处联动数字不动：
> | **12d 四条子用例 / 验收 9 五条 / §13 清单 5 笔 / L5 输入 6 项 / cleanup 10 个 staging 路径六处联动** | — | **本波一处都没动** | 不变 |（spec `:3016`）

即：控制器**知道**这些条目存在，**选择**不去动 §13 的数字。**代价**：一个只读 spec 的 L5 承接方会以为自己的输入是 6 项。

### 3.2 门评审的「带到 L5」分诊（23 行，逐字，未削短）

```
gate-c-lane2-report.md:170:处置三档：**合并前修** / **带到 L5** / **只记录**。
gate-c-lane2-report.md:175:| C1-M2 | 带到 L5 | 横幅全字面被钉在一条「主语是顺序」的测试里；C3 确实改过横幅也确实动了那条测试。噪声，非缺陷 |
gate-c-lane2-report.md:176:| C1-M3 | 带到 L5 | `rootFailure → stderr + return 1` 是本层唯一非零退出、无测试。**与我在 §5.2 新发现的 C2 concern 8 同族，两条应一起承接** |
gate-c-lane2-report.md:179:| C2-M1 | 带到 L5 | 「`--max-runs` 作为末位 token 无值」未测。注意：变异 5（`?? "1"`）已覆盖「完全缺席」那格并击杀，真正敞开的只有末位那格 |
gate-c-lane2-report.md:180:| C2-M2 | 带到 L5 | `--adapter-config` 指向 `{}` → TypeError → exit 1，退出码表措辞未覆盖；与既有 run/resume 同形，非本波新增 |
gate-c-lane2-report.md:181:| C2-M3 | 带到 L5 | `--adapter bogus` → exit 1 在 `main sweep` 下无 `it` |
gate-c-lane2-report.md:182:| C2-M4 | 带到 L5（见独立条目 2） | 顶失效的是**当前** L3 spec |
gate-c-lane2-report.md:187:| C3-M5 | 带到 L5，**触发条件写进条目** | 「若 12d(ii) 的替身不再抛出，区分静默消失」。脆弱性经 §2.2 实测确认为真 |
gate-c-lane2-report.md:188:| C4-M1 | 带到 L5 | 14b 未断言 finalize 自己六个 temp 路径无残留；计划 (ii) 只要了 marker 与 pending |
gate-c-lane2-report.md:205:**分级：带到 L5，不阻塞合并。承接方 = L5 中负责 resume 读侧顺序的那一波**（它是 L2 §7.1 registry 侧保护的同胞，resume 路径从未拿到那层保护）。
gate-c-lane2-report.md:208:**但我要给这条加一句评审员没说、而它改变分级理由的事实**：因为 `classifyThrow` 的前缀支路优先，这个**健康的** run 被分类为 `error` 并写到 **stderr**——而 C3 整个设计意图就是「stderr 是 cron 的告警通道」（R2.1 的勘误原话：「可见性由 stderr 独家兑现」）。**于是一次瞬时、自愈的竞争会产生一次假告警（false page）。** 这不只是「一条误导性的 `error` 行」，是一处**可运维性缺陷**。L5 条目应当按这个措辞记，否则承接方会低估它。
gate-c-lane2-report.md:215:- **C2-M4 → 带到 L5 的文档卫生项，不阻塞合并。** 实测：引用在 `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`——**当前 L3 spec**，后续每一波都还在导航它。今天的真值是 244 / 248（两处 `? 0 : 2`）与 241（`loadAdapter`）。
gate-c-lane2-report.md:223:- **B1 分支的 `writeRunState` 无 CAS —— 仍然不可达。** 实测：`.stop()` 在 `src/` 下今天恰好两个生产调用点（`src/controller/runLoop.ts:989`、`src/controller/resumeLoop.ts:215`），两处都在 `runLoopFromState` 之后的 `finally` 里；`src/controller/runLoop.ts` 在本分支零改动。sweep 的 `StopRequestSignal` 是**另一套机制**（`signal.requested` 布尔槽），`registerStopHandlers` 的闭包只拿到那个槽和一个注入的 `exit`，够不到任何 heartbeat。→ **GATE-B 条件 1 继续 defer 到 L5，触发条件不变。**
gate-c-lane2-report.md:224:- **谓词加宽半边无测试守卫 —— 仍然不可达，但放大器变了。** 它的安全论证是一条**界**：没有任何一条到 `persistBoundaryAnalysis` 的路由会不经过终态。组 C 只为删除死孪生动过 `fileStore.ts`。C1 的评审员追踪过：sweep **不新增路由**，只让一条既有路由在一个进程内被走 N 次，而全仓每一处 `currentProcessInstanceId` 比较都在**同一个 runDir 之内**，没有跨 run 比较。→ **界成立，仍不可达，仍无测试守卫，原样带到 L5。**
gate-c-lane2-report.md:225:  **要加进那条 L5 条目的一句**：这条界今天由一份**推理产物**而非一条测试守着，而 sweep 把它的走访次数乘了 N。将来任何一波若新增一条绕过终态到 `persistBoundaryAnalysis` 的路由，**每一次人类批准的爆炸半径就是 N 倍**。这个放大器必须写进条目，否则承接方只会看到「不可达」。
gate-c-lane2-report.md:247:→ **补记为 C2-M5，带到 L5，与 C1-M3 同一个承接方。**
gate-c-lane2-report.md:252:→ **补记为 C2-M6，带到 L5。**
gate-c-lane2-report.md:262:→ **补记为 C3-M6，带到 L5。** concerns 2（双空格 vs tab）与 6（12d(i) 断言顺序被调整过）属流程/外观，**只记录**即可。
gate-c-lane2-report.md:279:- **未能隔离验证的一处**：C4 §B 提到的「7 个 temp 路径若名字拼错则断言恒真」——**拼错的名字永远不存在，这个风险在结构上不可用探针证伪**，只有 §A 的常量逐条对照作保。C4 concern 2 已自曝，我确认这个风险**真实且不可测**，属 C4-M1 的邻居，一并带到 L5。
gate-b-lane2-report.md:473:| **硬约束 1 的「谓词加宽」那一半没有可失败断言（靠注释承载）** | **可接受。** 依据是可复核的：谓词未导出、专属分支排在谓词分支之前并 `return`，所以纯加宽今天行为惰性（已由 task-B1-important-verification 整套件实测为绿）。风险是**延迟型**的：任何改动分支顺序 / 删除专属分支 / 让该错误逃到内层 catch 的编辑都会引爆它，而没有任何测试名会提示原因 | **组 C 的 brief 必须逐字携带**（与 open item 4 同级），**并加到 L5**。另建议 GATE-B 把一条**明确的触发条件**写进记账：「凡是改到 `runLoop.ts` 外层 catch 分支顺序的任务，必须先重跑 task-B1-important-verification 的加宽实验」 |
gate-c-fix-wave-report.md:616:4. **新增的端到端用例依赖 zod 的 message 形状**（`toContain("\n")` 那条前置断言）。这是**有意的**：zod 若把 message 变成单行，该断言**响亮**失败，而不是让折行断言静默变空洞。但它确实是一条**换 zod 大版本时需要重看**的测试，与 C2-M6（依赖 vitest pool 的那条）同族。**建议记进 L5 台账，本波未记**（`progress.md` 归控制器写）。
group-c-preflight-scan.md:50:Files 条目与一个步骤，要么把它改判给 L5。**删除范围是清楚的**：`fileStore.ts:185–195`
group-c-preflight-scan.md:145:(a) 认定 C2 不是条件 1 说的那笔接线，条件 1 顺延给 L5；
```

**注意 `gate-c-fix-wave-report.md:616` 自曝的一条**：「**建议记进 L5 台账，本波未记**」——即评审员自己指出有一条连台账都没进。**该条今天既不在 §13 的 6 项里，也不在台账的收尾条目里。**

---

## 4. 三个必答问题

### 4.1 L5 的原始委任状是什么？L5 的本职工作今天有设计输入吗？

**⚠️ 派单前提有误，先更正**：`docs/superpowers/specs/2026-07-28-run-registry-design.md` **没有 §17**，它的最后一节是 §15。

```bash
rtk proxy grep -n '^## ' docs/superpowers/specs/2026-07-28-run-registry-design.md
```

```
38:## 1. Purpose
48:## 2. Non-Goals
70:## 3. Authorization Position
87:## 4. Run Directory Recognition
122:## 5. Traversal Rules
140:## 6. Observation Record Shape
193:## 7. Read Path and the Zero-Write Guarantee
265:## 8. Consistency Model
333:## 9. CLI Surface and Exit Codes
362:## 10. Module Boundaries
374:## 11. Error Handling Summary
393:## 12. Test Requirements
466:## 13. Inherited Debts — Explicitly Not Taken
523:## 14. Follow-On
533:## 15. Success Criteria
```

它在 §14 里说的是「**Parent** §17 item 3」——那个 parent 是**所有权设计** `2026-07-22-ownership-and-reconciliation-boundaries-design.md`。L1 spec 独立佐证了这一点：

> L5 corresponds to the third follow-on spec named in **the ownership design §17** and remains unwritten.（`2026-07-26-run-lease-and-heartbeat-design.md:45`）

**原始委任状逐字**（`2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17）：

```
## 17. Follow-On Specs Required

This design intentionally leaves the following next specs:

1. **Resume / adopt design**
   - how an eligible run actually resumes under a valid new owner epoch.
2. **Scheduler / unattended execution design**
   - when and how an eligible run is re-queued or continued.
3. **Cleanup / orphan handling design**
   - how superseded or lost-owner workspaces and evidence are retained or cleaned up safely.
```

**L1 分层表逐字**（`2026-07-26-run-lease-and-heartbeat-design.md` §3）：

```
| Layer | Content | New authority |
|---|---|---|
| **L1 (this design)** | lease + heartbeat | none |
| L2 | run registry / queue (read-only multi-run index) | none |
| L3 | scheduler (pure decision function over the registry) | none |
| L4 | daemon (executes scheduler decisions unattended) | large |
| L5 | cleanup / orphan GC | deletion |
```

**回答：L5 的本职工作（orphan 清理 / GC / 删除）今天没有任何设计输入。**

依据三条：
1. **委任状本身只有一行**：「how superseded or lost-owner workspaces and evidence are retained or cleaned up safely」。**没有**说什么可以删、什么必须保留、保留多久、由谁触发、删除是否需要授权。而 L1 的表格给 L5 标的 New authority 是 **`deletion`** —— 全五层里唯一一个带破坏性授权的层，却是设计输入最少的一层。
2. **官方 6 项里没有一项是关于删除/GC/保留的**。逐项核：债 2（往已不拥有的 run 写终态）、笔 1（锁可被偷）、笔 2（execute abort 无第二重上界）、笔 3（`writeBoundaryArtifacts` 落在 span 外）、笔 4（输家 reconciliation TOCTOU）、笔 5（被拒 run 无退避重捡）。**六项全部是其它层留下的并发/事务缺陷，无一属于 L5 的本职域。**
3. **全仓只有两个半句触及本职**，都不在任何清单上：D5（`:46`「被硬杀的进程不会留下 eligible transfer，那类 run 本层碰不到（属 L5）」）与 D6（`:2487`「恢复手段只有人工删除该 run 目录下的 staging，本层无自动化入口」）。

**结论**：L5 的处境是——**它的委任状是一行字，它的授权是「删除」，它的 6 项已知输入没有一项需要用到删除。** 一个只读 §13/§14 的承接方，会把 L5 当成一个「修 5 个并发缺陷 + 1 笔债」的层，而不是一个 GC 层。**这是本次扫描发现的最大的一处假前提风险。**

---

### 4.2 §16 第 11 行那个「会被 L5 继承的伪结构」具体是什么？

**§16 表头与相关行逐字**（`2026-08-01-…-design.md` §16）：

> 初稿的 Critical 级缺陷，逐条对应本文修订处。**本表的第 11 行在第二轮被判定为错误结论，已就地更正（见下面表内注）；其余各行仍然有效。**

> | 11 | S-3 退路完全遗漏 | §4.0.1–4.0.3 |
> | 11b | ~~「更宽不是更窄」只驳倒了裁决记录两条依据中的一条~~ **本行的后半句在第二轮被判定为伪造的论证结构**：裁决记录对「更窄」只给了**一条**依据（`assertHeld` 是写者），**这条成立**；「`newOwnerEpoch` 的排序主张」是裁决记录中一条**独立的否决**，不是「更窄」的依据，是第一轮修订自己造出来再打倒的。**不要把这一行当成「已修好」继承下去。** | §4.0.4（就地更正） |

**伪结构是什么**：第一轮修订虚构了一个「二依据结构」——它宣称归属裁决记录对「这条路比裁决时判断的更窄」这个判断给出了**两条**依据：(a) `newOwnerEpoch` 的排序主张、(b) `assertHeld` 是写者——然后宣布本 spec §4.1 已经驳倒了 (a)。

**为什么它是伪的**：裁决记录**从未**把 (a) 列为「更窄」的依据。(a) 在裁决记录里是一条**独立的否决**，与「更窄」的论证无关。所以第一轮是**自己造了一个论敌再打倒它**，并借此宣称自己回应了裁决记录。§4.0.4 的原话：

> **(a) 是本 spec 自己造出来再打倒的——裁决记录从未把它列为「更窄」的依据。** §16 第 11 行还把这个伪结构固化进了修订索引，会被 L5 继承。

**不处理它，L5 会继承到什么假前提**：
1. **「裁决记录的『更窄』判断已被本 spec 驳倒（至少一半）」** —— 假。真实情况是那**唯一**的一条依据（`assertHeld` 是写者）**成立且未被驳倒**（11b 原文：「**这条成立**」）。
2. **「排序主张已经被处理掉了」** —— 假。它是裁决记录里一条**独立的、仍然活着的否决**。
3. 更危险的是**元层面的**：§16 是一张「初稿缺陷 → 修订处」的索引表，读者的默认读法是「表里的每一行都已被修好」。表头虽然警告了第 11 行，但一个只扫表格不读表头的承接方，会把 11b 当成「已闭合」，从而把一条虚构的论证结构当成本 spec 与裁决记录之间的已决事项。

**⚠️ 同时上报一处锚点歧义（不替它圆场）**：§16 **同时存在** `| 11 |` 与 `| 11b |` 两行。`11` 是「S-3 退路完全遗漏」，与伪结构无关；`11b` 才是伪结构。而 §16 表头自己把 `11b` 称作「**本表的第 11 行**」，§4.0.4 也写「§16 **第 11 行**」。**因此「第 11 行」这个锚点在同一份文档内指向两个不同的行**，其中一个（`11`）与该句描述的内容完全无关。派单里说的「§16 第 11 行」按内容应读作 `11b` 行。

---

### 4.3 有没有哪一条交接，其触发条件在 L3 落地之后已经变了？

**有。除派单已知的那条外，我找到第二条已记录的整条撤回，以及第三条「条件已变但文档未同步」的。**

#### 先例 A（派单已知）—— `reconciliation_write_abandoned` 的具名代价，第五波整条撤回

逐字（`:2433`）：
> **⚠️ 第五波撤回第四轮在这里交接的第二件事：「`reconciliation_write_abandoned` 事件对 sweep 不可见」。** 第四轮把「cron 的『有 stderr 即告警』不会为它响」写成一条具名代价传给 L5；**人已裁定必须路由到 sweep 的 stderr，本层就地实现，这条代价不再成立，整条从交接清单里删除**

#### **先例 B（本次新找到）—— 「三份 pending 的非原子写」整笔被本层收回**

这是**同一形状**：第二轮把它作为**第 4 笔**推给 L5；人裁 pending 必须原子写之后，触发条件消失，整笔收回。

逐字（`:201`）：
> **连带收回**：第二轮把「三份 pending 的非原子写」作为第 4 笔推给 L5（§13）。**本轮收回本层。**

逐字（`:979`）:
> **人已裁定（§4.0.3a）：三份 pending 一并改原子写。** 之后 pending 只有「不存在」与「完整」两态 … **所以这一条从「真实可达、本层扩大影响面、具名传 L5」改判为「与规则 2/3 同类的纵深防御」**，§13 第二轮那笔（三份 pending 的非原子写）**由本层收回**。

逐字（`:2489`，§15 验收 2 的配套改判）：
> **⚠️ 第三轮的改判必须写明**：第二轮把「pending 写坏」列为**唯一一类真实可达**的钉死状态并具名传 L5。**人对 pending 原子化的裁定（§4.0.3a）之后它不再可达**，那一笔已由本层收回、不再传 L5

**与先例 A 的差别**：A 是「并进第 4 笔的一件附带交接被撤回，条数不变」；B 是「一整笔被收回，但同一轮里 §4.3 的残余 TOCTOU 顶上，形成**一出一进**，条数仍不变」。**两者都不改数字，这正是 §13 的数字长期看起来「稳定」的原因。**

#### **先例 C（本次新找到，且尚未落到文档上）—— L1b (e) 的「is L5's problem」**

人裁判定 L3 的事务化**取代**了 L1b (e)，该项**不再由 L5 继承**（台账逐字见 D4）。**但 L1b spec 正文至今未加勘误**，且评审员当时就点名并主动放弃处置（「NOT done here … Flag for the human」）。
**这是「触发条件已变、文档未同步」的一条，方向与 A/B 相反**：A/B 是从清单上删掉，C 是**该删而没删**。

#### 我逐条核过、确认触发条件**未变**的（附证据）

- **D2（Ctrl-C 区分，属 L2/L5）**：其触发条件是「需要新增一个**被 registry 观测**的字段」。L3 加的通道是**进程内可选回调**，spec 自己划清了界（`:1534`：「**通道是进程内的可选回调，不是新的磁盘契约**」）。且 registry 观测文件在 HEAD 上仍是 3 个：

  ```bash
  rtk proxy grep -nF 'file:' src/registry/observeFields.ts
  ```
  ```
  7:    file: "loop-state.json",
  29:    file: "owner-record.json",
  45:    file: "owner-transfer.json",
  111:  return { file: spec.file, fields };
  ```
  → 三个观测文件（`:7`/`:29`/`:45`），`:111` 是返回构造不是观测文件。**触发条件不变。** 第五波还专门重申「§5.4 第 2 条本身不受影响，原样保留」（`:2436`）。
- **笔 5（无退避重捡）**：触发条件是「需要在 run 目录里新增一个被读取的状态文件」。同上，L3 未新增任何被 registry 观测的字段。**触发条件不变。**
- **D1（catch 错误掩盖）**：L3 把 `safeUnlink` 从 2 个扩到 3 个，spec 已就地把措辞从「两个」改成「（扩到三个之后是三个都可能）」。**性质不变，规模变大了。**
- **D6（无自动化入口）**：L3 把 `cleanupOwnerTransferStagingWithoutMarker` 从 4 个路径扩到 10 个，但该函数按名字与 §13 的描述只在 **marker 缺失**时回收 staging，而 D6 说的钉死态是 **marker 仍在**。**触发条件不变。**
  **⚠️ 证据强度声明**：这一条我依据的是函数名与 §13 的描述（「marker 的 temp … 由 `cleanupOwnerTransferStagingWithoutMarker` 回收」），**没有读该函数源码确认**。

---

## 5. 文档自相矛盾之处（原样上报，未做任何修正或圆场）

### 5.1 §2 不做 #1 与 §5.4 第 2 条对「被硬杀的 run」的处置对不上

- §2（`:46`）：「被硬杀的进程不会留下 eligible transfer，**那类 run 本层碰不到（属 L5）**。」
- §5.4（`:1400`）：「**两者的正确处置恰好相同**——run 停在非终态、所有权未变、租约已释放或将过期，**正确动作都是「下一次 sweep 重新续跑」**。」（「两者」＝「人主动停的」与「**被 OOM 杀的**」）

而 sweep 的准入门第 1 条判据要求盘上已有 eligible transfer：

```
src/controller/resumeLoop.ts:43:  if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
src/controller/resumeLoop.ts:49:  if (reconciliation.ownershipVerdict !== "OWNER_LOST") {
```

**同一份 spec 一处说这类 run「本层碰不到」，另一处说它「正确动作是下一次 sweep 重新续跑」。** 二者只有在「该 run 盘上早已存在一次先前发布的 eligible transfer」时才能同时成立，**而这个前提两处都没写**。

**⚠️ 本项未完成**：我**没有**追出「一个正常 run 在什么条件下会在自己被杀之前就发布过 eligible transfer」的完整路径，因此**无法判断这是真矛盾还是一个未写出的前提**。缺的是：`persistBoundaryAnalysis` 在一次正常 run 生命周期内的触发条件。

### 5.2 §16 的「第 11 行」指向两行

见 §4.2 末段。`| 11 |`（S-3 退路遗漏）与 `| 11b |`（伪结构）并存，而表头与 §4.0.4 都用「第 11 行」称呼后者。

### 5.3 **当前 L3 spec 内部**：「回调 = 一次数组 push」在 §9 已被推翻，在 §4.3 两处仍作为前提

```bash
rtk proxy grep -rn '数组 push' docs/superpowers/
```

实测在 spec 内命中四处：`:692`、`:751`、`:1570`、`:1578`。其中：

- `:1570`（§9 模块表）原文仍写「**回调的实现定死为一次数组 push，不做 I/O、不得抛出**」，但紧跟其后的 `:1578` 是一条 **2026-08-05 的就地勘误**：「**上表 … 那一行末尾的「回调的实现定死为一次数组 push，不做 I/O」已被人裁推翻——回调改为在其中*当场* `options.stderr(...)`** … **读作**：上表该行末尾改为「**回调的实现定死为当场 `options.stderr(...)`（含单行折叠），不得抛出**」。」
- `:692` 原文：「**本层的处置是把「不得抛出」定成回调的契约，并把 sweep 侧的实现定死为一次数组 push（不做 I/O、不格式化）**，使违约成为一个显眼的编程错误而不是一条被吞的异常。」——**无任何勘误标记**。
- `:751` 原文：「差别在**谁能修好它**：回调的实现**在本层的控制范围内**（**§9 已把它定死为一次数组 push，不做 I/O**），所以它抛出只可能是**编程错误**……」——**无任何勘误标记，且它按名字引用 §9**，而 §9 已在 `:1578` 被改判。

**即：`:751` 引用 §9 得出的前提，与 §9 自己的现行文本相反。** 台账早已点名这两句（「The same-family spec sentences at spec:692 and spec:751 … still cite "a single array push" as a PREMISE … Named for L5; the controller did not widen the round to take them.」），而 HEAD 的最后一次 spec 提交只同步了其中一处：

```
commit b9afbf3930c531e245c4555e10cf6e8d3219749d
    docs(spec): GATE-C residual — sync the second same-family sentence, the callback is an immediate stderr write, not an array push
 .../specs/2026-08-01-sweep-and-transactional-continuation-design.md   | 4 ++++
 1 file changed, 4 insertions(+)
```

**这是本仓库栽过两次的那个形状的第三次实例**（§13 自己记着前两次：「第一轮本节首段写「L5 的继承清单确认为 1 笔」、末段写「留给 L5 具名继承的两笔」、§14 第 1 条又写「3」，同一节内自相矛盾」）——只不过这次不是数字对不上，是**同一份文档里一句话引用另一节，而那一节已经改判**。

### 5.4 L2 spec 说「三笔债留给 L5」，裁决记录说「只剩 1 笔」

见 D7。`run-registry-design.md:57` 与 `:468` vs `decisions/2026-07-29-technical-debt-attribution.md:246`/`:248`。**同一份 L2 spec 的 §13.4 拿到了就地勘误，§13.1/§13.3 没有。**

### 5.5 L1 的分层表与实际交付的层不符

L1 §3 的表写 `L3 = scheduler (pure decision function over the registry)`、`L4 = daemon (executes scheduler decisions unattended)`。而实际交付的 L3 是 **sweep 触发层**，它自己**执行** `resumeLoop`（`ccloop sweep --root … --max-runs N`，顺序续跑），即已经吃掉了表里 L4 的一部分。L2 spec §2 也写过它把 triggering「deferred to a later layer」而那一层成了 L3。
**L5 那一行本身没变**（`| L5 | cleanup / orphan GC | deletion |`），所以 L5 的编号是安全的；但**任何从 L1 表格建立心智模型的承接方，会对 L3/L4 的边界得到一个错误的图**。

### 5.6 两份互不引用的 L5 输入清单并存

spec 侧三处联动数字（§13 开头 / §13 末尾括注 / §14 第 1 条）一致写 **5 笔 / 6 项**，并在最后一波被明确宣告「本波一处都没动」；台账侧在 GATE-C 合入时写下「**L5, which now inherits: …**」四类全新条目 ＋ 门报告 23 行「带到 L5」分诊。
**两份清单完全不相交，且彼此都没有指向对方的指针。** 一个按派单指示「读 spec §13 拿输入」的 L5 承接方，会拿到 6 项而不知道另一份存在。

---

## 6. 本报告未覆盖的范围（明写）

1. **未逐条回代码复核**门报告里那 23 行分诊的技术真伪（C1-M2 … C4-M1 等）。我只确认它们**被具名交接给 L5** 且**不在 6 项内**。
2. **未核实** spec §4.6「代码零改动」那句在 HEAD 上的现状（D12）。
3. **未追出** §5.1 那处张力是否为真矛盾（缺 `persistBoundaryAnalysis` 的触发条件路径）。
4. **未读** `cleanupOwnerTransferStagingWithoutMarker` 源码（§4.3 末尾的证据强度声明）。
5. **未扫** `docs/` 下 `superpowers/` 以外的目录（如 `docs/handoff/handoff.md`）是否另有 L5 交接。派单范围是 `docs/superpowers/`，但 HEAD 提交恰好动的是 `docs/handoff/handoff.md`，**那份文件我没有读**。
