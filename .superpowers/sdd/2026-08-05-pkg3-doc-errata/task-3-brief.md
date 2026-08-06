# 任务 3 brief — 四条跨文档勘误：D7 / D4 / `spec:2306` / D12

## 你的身份与铁律（先读完这一节再动手）

你是本仓库的**实施者**。本仓库**不接受实施者自证**：你交付后有一名独立评审员逐条复核。

1. **发现判据在今天文档/代码上不成立 —— 原样上报，不许自改判据。** 本仓库五次「计划自身被实测证明为假」，
   五次处置都是人裁 + 就地勘误，**没有一次是实施者自己改判据**。
2. **验证跑绝不过滤输出**，`grep` 与 `tail` 同罪。
3. **每个数字旁附一条能重推它的命令，并写下该命令当时的输出值。**
4. 任何一处没做，报告里明写没做。

## ⚠️ 落盘协议（强制）

**第一件事**：先 `Write` 报告文件 `.superpowers/sdd/2026-08-05-pkg3-doc-errata/task-3-report.md`，
**只写小节标题的骨架并立刻落盘**，在这之前不要做任何检索。
之后**每次 `Edit` 只填一节（≤120 行）**，最有把握的先写。
（本会话 9 名 agent 中 5 名被中断，全部发生在准备落盘时；采用该协议后交付率 100%。）

## ⚠️ 行号会移位

下面的行号取自 HEAD `4f3b790`。**任务 1 与任务 2 已经在 `2026-08-01-…-design.md` 里落过勘误，
你拿到时该文件的行号必然已经变了。一律用逐字引用定位，不要照行号跳。** 你自己编辑时**倒序处理**。

## 你的证据在哪（**不要重新推导，去读**）

上一轮一名独立复核员（lane 2）已把这四条逐条查证到底，逐字引用与重推命令都在：

`/Users/biran/code/skills/loop/ccloop/.superpowers/sdd/2026-08-05-l5-input-scan/review-lane2-docs.md`

| 你要做的 | 读它的哪一节 |
|---|---|
| D7 | `## 5.`（§5.1–5.5） |
| D4 | `## 6.`（§6.1–6.5） |
| `spec:2306` | `## 7.`（§7.1–7.6） |
| D12 | `### 10.5`（**lane 2 已把勘误正文补完，可直接落**） |

另可参考原扫描员的报告 `scan-D-offlist-sweep.md` 的 `### D7` / `### D4` / `### D12` 三节，
**但两者冲突时以 lane 2 为准**（lane 2 是复核方，且在 D7 与 D12 两条上都比 scan-D 更强）。

**你仍然必须自己把每条的关键行重新读一遍并在报告里贴出来。** 照抄复核员的结论而不复验，
正是本仓库反复栽的形状。

---

## 条目 1 — D7：L2 spec 仍写「三笔债留给 L5」

**文件**：`docs/superpowers/specs/2026-07-28-run-registry-design.md`

两处今天逐字仍如此：

- `:57`：「6. discharge any of the **three debts** bequeathed to L5 (§13);」
- `:468`（§13 首句）：「**Debts 1–3 are bequeathed to L5** and are unchanged by this layer.」

**推翻它的裁决记录**：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`

- `:246`：「**L5 继承清单第 1 条描述有误**……该条应改写为跨文件事务性缺陷，**并从 L5 清单移到 L3**。」
- `:248`：「**L5 继承清单现在只剩 1 笔**（债 2），不是 4 笔。」

*** lane 2 比 scan-D 多查明的一条（更强）：裁决记录**亲自下过更正指令**，而 L2 spec 从未执行。 ***
**并且勘误分布不均**：债 4 在该 spec 里有 `Amended (j)`，**债 1/3 没有** —— 即这份文档被改过，
只是漏了这两笔。**（这三件事你都要自己用命令复验并贴输出。）**

**要做**：在 `:57` 与 `:468` 两处就地勘误，明写今天的真实清单（债 1 已移到 L3、L5 清单只剩债 2），
并指向裁决记录的那两条。**两处都要留下指针，不许只改一处。**

---

## 条目 2 — D4：L1b 的「is L5's problem」已被人裁关闭，却从未落勘误

**文件**：`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`

`:113` 那段 `**Amended 2026-07-28 (e)**` 的**末句**今天仍写着：输家对赢家 reconciliation 视图的合成，
「if that view is still wanted, assigning it to a process that still holds the run is **L5's problem**」。

**四要素俱全（lane 2 §6，逐条去核）**：

1. **人裁**在 L3 台账 `:36`（逐字，lane 2 §6.2 已贴）；
2. **当时的评审员点名要求落勘误并明写「NOT done here / Flag for the human」**，台账 `:44`
   —— *** lane 2 称这是**全仓唯一一处**这种形状的记录 ***；
3. **勘误至今不存在**：该 L1b 文档的勘误**只到 `(e)`，没有 `(f)`**（lane 2 §6.4 有命令与输出）；
4. 因此 L5 读者今天读到的仍是「这是 L5 的问题」。

**要做**：给该文档补一条 `(f)` 勘误（**沿用它自己 `(a)`–`(e)` 的既有编号与格式，不要另起一套**），
写明这一条已被 L3 取代 / 关闭，并指向人裁与评审员要求的那两处记录。

**⚠️ 你必须自己确认「已被 L3 关闭」这句话今天的确切含义再落笔。**
若你读完 lane 2 §6 与台账原文后认为「关闭」的措辞与证据不完全对得上 ——
**原样上报，不要自己挑一个更顺口的说法**（铁律 1）。

---

## 条目 3 — `spec:2306`：与同节 5 行之上的 `:2301` 直接矛盾

**文件**：`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（§12）

`:2301` 已有第四轮更正，逐字：

> **⚠️ N 不等于付费调用次数（第四轮更正）**：`--max-runs N` 界的是**进入 `runLoopFromState` 的 run 数**……
> **付费上界是 `N × maxAttempts`。**……并把「横幅里的 N 就是付费次数」这个读法**明确标为错误**。

`:2306` 在**同一节、五行之下**却仍逐字写着旧措辞：

> **本节不界的东西，明写出来**：`--max-runs` **界的是付费调用**，不界事件追加。……**这一笔具名传给 L5**（§13）。

**两条 lane 2 查明的加重情节**：

- **为什么活下来**：§19 M2 的处置写的是「**各补一段**」而不是就地改，所以旧句原地存活（lane 2 §7.3）。
- *** **它就长在把第 5 笔交给 L5 的那句话里**（lane 2 §7.4）—— 也就是说，L5 读到的交接句本身带着
  一个已被本文档明确标为错误的读法。 ***
- **且它从未被记成任何一笔债**（lane 2 §7.5）。

**要做**：就地勘误 `:2306` 那句，让「界的是付费调用」与 `:2301` 的 `N × maxAttempts` 一致。
**不要改「不界事件追加」那半句**（那半句今天成立，也是第 5 笔交接的实质内容）。

---

## 条目 4 — D12：§4.6「代码零改动」这句话已为假（lane 2 已补完，直接落）

**文件**：同上 spec 的 §4.6（`:1012` 一带）与 `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`（`:225` 一带）

- spec §4.6 今天仍逐字写着：「`preserveSuccessfulReconciliationIfNeeded` **代码零改动**。」
  下面虽已有一条「⚠️ 但第一轮修订给的**理由**已过时（第二轮评审）」的注 ——
  *** 那条注只否定了**理由**，没有否定**「代码零改动」这个断言本身**。 ***
- 计划 `:225`「**裁定三**」逐字：「§4.6『……代码零改动』**这句话为假，予以推翻**」。
- 代码侧：该函数的返回类型今天已改为 `ReconciliationWriteDecision`。**这条你必须自己去源码里核实并贴出来。**

**scan-D 当时判「无法判断 / 悬空」，lane 2 一步查实并已把勘误补完**（见 lane 2 `### 10.5`）。

**要做**：把 lane 2 §10.5 的勘误落到 spec §4.6，明写「代码零改动」已被计划裁定三推翻、
以及今天的真实形状。**若 lane 2 的措辞与你实测的代码有出入，以代码为准并在报告里点名这处出入。**

---

## 验证（做完必须跑，输出整段贴进报告，不许过滤）

```
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy "npm test -- --run"
```

- **验收 vitest 首行 `RUN` 路径必须是 `/Users/biran/code/skills/loop/ccloop`**，不对一律作废重跑。
- 基线 **30 files / 514 tests / exit 0**。本任务只改 markdown，**不应改变这两个数字；变了就是回归，立刻上报**。
- 收尾自查（每条都要贴命令与输出）：

```
grep -n "three debts\|Debts 1–3" docs/superpowers/specs/2026-07-28-run-registry-design.md
grep -n "Amended" docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
grep -n "界的是" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
grep -n "代码零改动" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
```

## 提交

提交到当前分支 `docs/pkg3-errata`（**不要碰 main，不要 push，不要 rebase 前两个任务的提交**）。
主题行 `docs(errata): …`。四条可以一笔，也可以分笔，**但正文必须四条逐条点名**。

## 报告契约

报告写进 `.superpowers/sdd/2026-08-05-pkg3-doc-errata/task-3-report.md`，至少含：

1. 四条**逐条**：原句、你自己复验的命令与输出、勘误正文、理由；
2. D12 那条**单独说明**你与 lane 2 措辞的一致性（以及若有出入，出入在哪）；
3. 完整未过滤的验证输出 ＋ `RUN` 路径行 ＋ 四条自查命令的输出；
4. **你不确定或认为 brief 判错了的地方**（有就写，没有就明写「无」）。

**返回给我的只要**：状态（DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED）、提交 hash、
一行测试结论、四条是否全部处理、你的 concerns。**报告正文不要贴回来。**
