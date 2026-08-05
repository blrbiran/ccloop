# 独立复核 — lane 2（文档侧结论 ＋ 盘点完备性）

复核者：未参与本轮任何一份扫描报告。只读。工作区 `/Users/biran/code/skills/loop/ccloop`，
分支 `main`，HEAD `e9021ef`，`git status --short` 干净（本报告是本会话唯一写入的文件）。

约定：`spec` = `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（L3 spec）；
`plan` = `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`（L3 plan）；
`ledger` = `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`（L3 台账）。

<!-- SECTIONS -->

## 0. 结论速览

| # | 主张 | 结论 |
|---|---|---|
| 1 | §9「回调=数组 push」被 `:1578` 就地推翻，`:692`/`:751` 仍以它为前提，C 数出 9 处 | **CONFIRMED，但 C 低估**：无勘误站点实为 **9 处**（C 的 9 里有 3 处已带勘误，真正无勘误的是 6＋我补的 3）。C 漏 `spec:671` / `spec:2006` / `plan:1735` |
| 2 | B 找到的 `fileStore.ts:469` 在不在 C 的 9 处之内 | **不在。且 C「`src/`/`tests/` 没有任何一处」的全称否定被一条 grep 直接证伪** —— 两份报告的唯一直接矛盾 |
| 3 | §5.2 仍写「§13 据此把债 3 记为『部分关闭』」，G10 修订清单漏了 §5.2 | **CONFIRMED**（`spec:1143` vs `:2358`，同文档内直接矛盾；G10 四个修订处无一是 §5.2） |
| 4 | §16「第 11 行」锚点歧义 ＋ 伪结构 | **锚点歧义 CONFIRMED，伪结构内容 CONFIRMED；D 给的危害机制不准**（`11b` 本身已就地更正并带警告，坏的是指向它的锚点。修法比 D 描述的小） |
| 5 | D7：L2 spec 仍写「three debts bequeathed to L5」 | **CONFIRMED，且更强**：裁决记录 `:246`/`:248` 亲自下过「移到 L3 / 只剩 1 笔」的更正指令，从未执行 |
| 6 | D4：L1b「is L5's problem」人已裁关闭却无勘误 | **CONFIRMED，证据链最完整**（人裁 ＋ 评审员「NOT done here / Flag for the human」＋ 至今只到 `(e)` 无 `(f)`） |
| 7 | spec §12 `:2306` 旧措辞，且从未记成债 | **CONFIRMED，且更重**：与同节 5 行之上的 `:2301` 直接矛盾；旧措辞就长在把第 5 笔交给 L5 的那句话里 |
| 8 | L5 委任状在 ownership design §17 item 3，不在 run-registry | **CONFIRMED**（run-registry 止于 §15；两处「parent §17 item 2/3」与 ownership 逐字对齐）。D 的更正正确 |

**两个可重数的计数**：78 ✅ 精确复现；23 ✅ 精确复现（但「四份门报告」这个**标签**错了 —— 其中一份是组 C 预扫）。
**「报不出可重数的计数就不报数字」这个处置：正确，应立为规则**（但要限定：这两个数是搜索面，不是完备性证明）。

**治理四条：四条全部 CONFIRMED，缺口比 C 报的更宽。** 最要紧的一格是**不可补救**的：
GATE-C lane 1 的 3 条 Minor ＋ GATE-A 的两份门评审报告**证据已灭失**。
第 4 条我推得更远：**C1-M3 不是「今天过期」，是写下时就为假**（测试由 C1 自己那次提交 `c15b499` 加的）。

**集体漏掉的交接：有一条，而且它推翻了本轮的头号结论。**
`2026-07-29-atomic-write-paths-design.md` §10 第 4 条「崩溃残留临时文件无人清理、**清理归属未分配**」——
**这就是 L5 委任状的字面内容，是全仓唯一一条为 L5 本职预先写好的分析。四份报告零命中。**

## 1. 「一次数组 push」腐坏站点 —— 我自己数（主张 1）

**结论：主张成立，但扫描员 C 的计数本身低估了。真正无勘误的腐坏站点是 9 处，不是 C 数出的 6 处
（C 的「9 处」里有 3 处是已带勘误的）。C 漏掉的 3 处，成因是它的定位命令只搜了 `push` 这个词。**

### 1.1 我的定位命令与完整输出

C 用的是 `grep -n "push"`。我改用中文词根 `数组`（该族的每一处都带这两个字，而 `push` 不是每处都带）：

```
$ rtk proxy grep -rno "数组" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md | wc -l
      25
```

逐行（`grep -rn`，输出按 160 列截列显示以便阅读；**每一行的完整正文都在下面 §1.2 单独逐字贴出**）：

```
spec:671  spec:681  spec:692  spec:751  spec:829  spec:839  spec:1570  spec:1578  spec:2006
plan:133  plan:876  plan:1004 plan:1717 plan:1719 plan:1721 plan:1735 plan:1759 plan:1761 plan:1999
```

### 1.2 逐处判定

我逐行读了全文（`sed -n "${L}p"`，输出未削短），分四类：

**（a）无勘误、仍以「回调 = 数组 push / 落点是数组」为前提 —— 9 处：**

| # | 站点 | 逐字关键句 | C 有没有数到 |
|---|---|---|---|
| 1 | `spec:671` | 「(b) 的回调在事件发生的**当场**就把记录**写进了 sweep 自己的数组里**」 | ❌ **漏** |
| 2 | `spec:681` | 「传一个闭包，把 `{ path, detail }` **push 进本次 sweep 的备注数组**」 | ✅ |
| 3 | `spec:692` | 「把 sweep 侧的实现**定死为一次数组 push**（不做 I/O、不格式化）」 | ✅（台账点名） |
| 4 | `spec:751` | 「**§9 已把它定死为一次数组 push，不做 I/O**」（**按名字引用 §9**） | ✅（台账点名） |
| 5 | `spec:2006` | 「把备注的落盘时机从「**回调当场记入 sweep 的数组**」改成…→ 本条必须红」 | ❌ **漏** |
| 6 | `plan:876` | 「（**§9 定死为一次数组 push，不做 I/O**）」（**按名字引用 §9**） | ✅ |
| 7 | `plan:1004` | 「把 sweep 侧的实现定死为**一次数组 push**（不做 I/O、不格式化）」 | ✅（台账点名） |
| 8 | `plan:1735` | 「把备注的落盘时机从「**回调当场记入 sweep 的数组**」改成…→ 本条必须红」 | ❌ **漏** |
| 9 | `plan:1999` | 可追溯性矩阵：「A8 的 12d(iii)、**C3（回调=数组 push）**」，行末打着 `✅` | ✅ |

**（b）已带就地勘误、不再是债 —— 3 处：** `spec:1570`→`spec:1578`（`Amended 2026-08-05`，即 `b9afbf3`）；
`plan:1717`→`plan:1719`（`Amended 2026-08-04`）；`plan:1759`→`plan:1761`（`Amended 2026-08-04`）。

**（c）同族但只是复述勘误正文，不是独立站点：** `spec:1578`、`plan:1719`、`plan:1721`、`plan:1761`。

**（d）撞词、与本族无关：** `spec:829`、`spec:839`（「改一个**常量数组**的顺序」，指 `finalizeOrder`）、
`plan:133`（「往**测试数组**里注入」）。

### 1.3 三处漏掉的站点确实无勘误 —— 命令与输出

```
$ rtk proxy grep -n "Amended" docs/.../2026-08-01-...-design.md | awk -F: '$1>640 && $1<720'
（无输出）
$ rtk proxy grep -n "Amended" docs/.../2026-08-01-...-design.md | awk -F: '$1>1980 && $1<2030'
（无输出）
$ rtk proxy grep -n "Amended" docs/.../2026-08-02-....md | awk -F: '$1>1719 && $1<1759'
（无输出）
$ rtk proxy grep -c "Amended" docs/.../2026-08-01-...-design.md
4
```

全 spec 只有 4 处 `Amended`（`:1558` / `:1562` / `:1578` / `:1580`），**全在 §8/§9**，
离 `spec:671`（§4.3 第三步）与 `spec:2006`（§10 测试 12d）都很远。

### 1.4 三处漏掉的站点为什么承重（不是「多三处同义句」）

- **`spec:671` 是「为什么选 (b) 不选 (a)」那条*决定性*论证的落脚点。** 原句：(a) 会在
  `runLoopFromState` 顶端抛出时把消息丢掉，而「(b) 的回调……把记录写进了 sweep 自己的数组里，
  后续无论 run 正常返回还是抛出，记录都已在 sweep 手上」。今天的实现里记录**不在 sweep 手上**，
  它已经出了进程（stderr）。**结论（选 (b)）不腐；论据的落脚点腐了，而且腐的正是这一族被人裁
  推翻的那件事**（`plan:1719` 的整段理由就是「收进数组＝把可见性押在进程活到循环结束上」）。
  换句话说：`spec:671` 用**已被推翻的形状**去论证**做对了的选择**。
- **`spec:2006` 与 `plan:1735` 是一条*变异要求*的正文**，写在 §10 测试 12d / plan Task C3 里。
  它们不是描述，是**指令**：谁按字面复现这条变异，会去构造「回调当场记入数组」这个今天不存在的
  基线。这两处是三类里唯一会被**执行**的。

### 1.5 与台账的对照

台账 `:1774` 只写「the same-family spec sentences at spec:692 and spec:751 (and their copy at
plan:1004)」= **3 处**。因此：

- 台账记 3 处 → 实际无勘误 **9 处** → **6 处从未被任何台账或勘误提到**（`spec:671`、`spec:681`、
  `spec:2006`、`plan:876`、`plan:1735`、`plan:1999`）。
- C 的最小勘误建议是「3 条勘误覆盖 6 处」。**按我数出的 9 处，那个建议覆盖不全**：它没有覆盖
  `spec:671`、`spec:2006`、`plan:1735`。**不要照抄 C 的勘误清单。**

### 1.6 C 的一处台账更正，我复核过，成立

C 指出台账把 copy 关系记混：`spec:751` 的孪生句是 `plan:876`（两句都按名字引用 §9），
`plan:1004` 是 `spec:692` 的 copy（两句都是「本层的处置是把「不得抛出」定成回调的契约，
并把 sweep 侧的实现定死为一次数组 push」）。**逐字比对成立。** 这属于台账勘误，需人裁。

## 2. `fileStore.ts:469` 在不在 C 的 9 处之内（主张 2）

**结论：不在。而且 C 在同一节里写下的那句否定断言是错的 —— 这正是「两边都以为对方管了」的交界。**

### 2.1 C 写了什么

`scan-C…md:359` 逐字：

> - 这九处全部在 `docs/` 下，`src/` 与 `tests/` 里**没有任何一处**提到「数组 push」（上面那条 grep 只跑了 spec 与 plan；但 `sweepRuns.ts` 的回调注释与 `fileStore.ts:440-444` 的注释都已经是 stderr 措辞，见上面两段原样引用）

C 在**同一句话里**承认自己的 grep 只跑了 spec 与 plan，然后仍然给出了一个覆盖 `src/` 与 `tests/`
的**全称否定**，其支撑只有两处它恰好读到的注释（`fileStore.ts:440-444`、`sweepRuns.ts` 回调上方）。
`fileStore.ts:469` 落在 `:440-444` 与回调之间的那段注释里，**恰好在 C 读的两个窗口之外。**

### 2.2 我的重推命令与完整输出

```
$ rtk proxy grep -rn "array push\|数组" src/ tests/
src/persistence/fileStore.ts:469:      // control (a single array push, no I/O), so a throw from it is a programming error and must
```

**一行命中，`src/` 内，`tests/` 零命中。** C 的否定断言被这一行直接证伪。

### 2.3 原文与它的位置（Read 工具，`src/persistence/fileStore.ts:468-471`，原样）

```
468	      // The callback deliberately does NOT get this treatment: its body is inside this layer's
469	      // control (a single array push, no I/O), so a throw from it is a programming error and must
470	      // be loud. appendFile's I/O is nobody's to fix — a throw from it is an environment fact, and
471	      // converting it into a failed attempt only hides a small error behind a larger one.
```

这段注释是 `spec:751` / `plan:876` 那条不对称论证的**源码复刻**（「谁能修好它」）。
`b9afbf3` 同步了 `spec:1570` 一处，**源码这一处没跟**。

### 2.4 判定

- **B 的发现成立，且它是第 10 处**（在我 §1 数出的 9 处之外，因为那 9 处全在 `docs/`）。
- **C 与 B 的交界确实漏了**：C 声明 `src/` 干净，B 证明不干净。两份报告放在一起时，
  一个读者会因为 C 的全称否定而不去追 B 那一条。**这是本轮唯一一处两份报告直接相互矛盾的地方。**
- 分级不变：**仅文档**（注释不参与执行、无测试断言其内容）。但**它是唯一一处在源码里、
  会被下一个改这段代码的人当作现状读的腐坏站点**，可见度高于那 9 处文档。
- **最小勘误面因此是 10 处，不是 C 说的 6 处。**

## 3. §5.2「债 3 部分关闭」（主张 3）

**结论：CONFIRMED，三个半句逐条成立。**

### 3.1 §5.2 至今逐字如此

```
$ rtk proxy grep -n "部分关闭" docs/.../2026-08-01-...-design.md
:1143  …**§13 据此把债 3 记为「exclusive span 部分关闭」，span 外那段具名传给 L5。**
:2358  - **归类错误的实际危害**：写成「债 3 部分关闭」会让 L5 以为自己继承的是一笔**已被裁决过归属**的债…
:2812  | G10 | Important | §13 把债 3 归为「部分关闭」错了…
```

`:1143` 落在 §5.2 内（章节边界重推：`grep -n "^## \|^### 5\."` → `:1125 ### 5.2 完整性论证：为什么「`stopped` 后拒绝」就够`，
`:1145 ### 5.3 改动 A`，故 §5.2 = 1125–1144）。

### 3.2 §13 花整节论证这个说法有害 —— `spec:2358` 逐字

> - **归类错误的实际危害**：写成「债 3 部分关闭」会让 L5 以为自己继承的是一笔**已被裁决过归属**的债，从而不再重新裁决；而它其实是一条**从未被任何裁决记录处理过**的新发现，**归属应当重新裁**。

紧接下一句（`spec:2360`）：

> **因此**：债 3 记为**本层关闭**；span 外那段作为**本轮新发现**具名传 L5（下面第 3 笔，措辞已改），并明写它需要一次归属裁决。

### 3.3 G10 的修订处清单实测不含 §5.2 —— `spec:2812` 的第三列逐字

> §13 表、§13「债 3 的归类更正」（引裁决记录 :189 全句）、§13 第 3 笔（措辞改为「本轮新发现，需重新裁归属」）、§14 第 1 条

**四个修订处，无一是 §5.2。** 而 §5.2 恰恰是**唯一一处以第一人称主动语态宣告这个归类**的地方
（「**§13 据此把债 3 记为**……」），§13 只是被它引用的对象。**改了被引用方，没改引用方。**

### 3.4 判定

- 同一份文档内，`:1143` 与 `:2358` **今天直接互相矛盾**：一处宣告「记为部分关闭」，另一处宣告
  「这样记会造成危害，因此不这样记」。
- **失败模式今天仍可复现**：一个从 §5「债 3」这一章顺读进来的 L5 读者，会在 `:1143` 拿到
  「已被裁决过归属」这个前提，而 §13 的更正在 1200 行之后。§13 自己点名要防的那件事，
  由这份文档自己的 §5.2 兑现着。
- 分级：**仅文档**，但它污染的是**归属属性**（「需重裁」vs「已裁过」），
  而归属属性正是本轮反复强调「三种属性对应三种处置权、不可互换」的那个维度。

## 4. §16「第 11 行」锚点歧义与伪结构（主张 4）

**结论：锚点歧义 CONFIRMED。伪结构的内容 CONFIRMED。但 D 对「危害」的表述我不能全部背书 —— 见 §4.4。**

### 4.1 §16 同时存在 `11` 与 `11b`（Read 工具，`spec:2717-2718`，原样）

```
2717	| 11 | S-3 退路完全遗漏 | §4.0.1–4.0.3 |
2718	| 11b | ~~「更宽不是更窄」只驳倒了裁决记录两条依据中的一条~~ **本行的后半句在第二轮被判定为伪造的论证结构**：裁决记录对「更窄」只给了**一条**依据（`assertHeld` 是写者），**这条成立**；「`newOwnerEpoch` 的排序主张」是裁决记录中一条**独立的否决**，不是「更窄」的依据，是第一轮修订自己造出来再打倒的。**不要把这一行当成「已修好」继承下去。** | §4.0.4（就地更正） |
```

### 4.2 两处「第 11 行」都指向 `11b`，而字面第 11 行是 `11`

```
$ rtk proxy grep -n "第 11 行" docs/.../2026-08-01-...-design.md
:209   …**§16 第 11 行还把这个伪结构固化进了修订索引，会被 L5 继承。**
:2703  初稿的 Critical 级缺陷，逐条对应本文修订处。**本表的第 11 行在第二轮被判定为错误结论，已就地更正（见下面表内注）；其余各行仍然有效。**
```

- `:2703`（§16 自己的表头）说「本表的第 11 行……已就地更正（见下面表内注）」—— 带表内注的是 **`11b`**。
- `:209`（§4.0.4）说「§16 第 11 行还把这个伪结构固化进了修订索引」—— 伪结构在 **`11b`**。
- 而表里**字面标着 `11`** 的那一行是「S-3 退路完全遗漏 | §4.0.1–4.0.3」，与伪结构无关，且未被更正。

**歧义的实际后果，具体化**：`:2703` 那句「其余各行仍然有效」在 `11` / `11b` 两种读法下含义相反 ——
若「第 11 行」= `11b`，则 `11` 属「其余各行」、有效（正确）；若读者按字面把「第 11 行」认成 `11`，
则他会认为 `11`（S-3）是那条被推翻的错误结论，而把 `11b` 归入「其余各行仍然有效」——
**恰好把唯一一条明写「不要把这一行当成已修好继承下去」的行，读成了有效行。**
控制器派单时引用的「§16 第 11 行」正是踩在这个歧义上。

### 4.3 伪结构的内容 —— `spec:209` 逐字，与 D 的描述一致

> **第一轮修订在这里写错了**，且错法是本仓库最忌讳的一种：它写「裁决记录的『这条路比裁决时判断的更窄』有**两条**依据：(a) `newOwnerEpoch` 的排序主张；(b) `assertHeld` 是写者」，然后宣布 §4.1 驳倒了 (a)。**(a) 是本 spec 自己造出来再打倒的——裁决记录从未把它列为「更窄」的依据。** §16 第 11 行还把这个伪结构固化进了修订索引，会被 L5 继承。

第二轮的 F1 独立记了同一件事（`spec:2733`，逐字）：

> | F1 | Critical | §4.0 伪造裁决记录的论证结构：把「更窄」说成有两条依据、其中 (a) 被驳倒；实际「更窄」只有一条依据且成立，(a…

### 4.4 我不能全部背书 D 的危害表述 —— 原样上报

D 写 L5 若沉默继承会拿到两个假前提（「『更窄』已被驳倒一半」「排序主张已处理」）以及元层面的
「§16 表里每行都已修好」。**核下来是这样：**

- **`11b` 这一行本身不再传播那两个假前提。** 它是删除线 ＋ 就地更正 ＋ 一句显式警告
  （「不要把这一行当成「已修好」继承下去」）。**照它读，读者拿到的是正确的。**
- **真正还在传播的是两件别的事**：(i) `:209` 与 `:2703` 都用一个**指错行**的锚点去引用它；
  (ii) `:2703` 的「其余各行仍然有效」在错读下会把 `11b` 的警告一笔勾销（见 §4.2）。
- 因此我把这一条判为：**D 的结论（L5 会继承一个坏东西）成立，但 D 给的机制不准 ——
  坏东西不是 `11b` 的内容，是指向它的那个锚点。** 这一处**不需要重写 `11b`**，
  需要的是把两处「第 11 行」改成「第 `11b` 行」。修法比 D 描述的小。

## 5. D7 — L2 spec 仍写「three debts bequeathed to L5」（主张 5）

**结论：CONFIRMED，三个半句全部成立，且我另找到一条更强的证据 —— 裁决记录自己下过明确的更正指令，无人执行。**

### 5.1 L2 spec 今天的两句 —— 全仓唯一命中

```
$ rtk proxy grep -rn "three debts\|bequeathed" docs/
docs/superpowers/specs/2026-07-28-run-registry-design.md:57:6. discharge any of the three debts bequeathed to L5 (§13);
docs/superpowers/specs/2026-07-28-run-registry-design.md:468:Debts 1–3 are bequeathed to L5 and are unchanged by this layer. This layer does
```

该文件确是 L2 spec（首行 `# L2 — Run Registry (Discovery Only)`）。

### 5.2 2026-07-29 裁决把清单降到只剩债 2

`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md` 归属表（`:18`–`:21`）：

```
| 1 | reconciliation 合成责任无人认领       | **L3**（spec 内独立一节，先于触发逻辑）
| 2 | `persistTerminalState` 往已不拥有的 run 写 | **L5**
| 3 | `heartbeat.stop()` 释放窗口            | **L3**
```

`:23` 逐字：「**附带结论：下一层是 L3，不是 L5。** 四笔债里两笔（1、3）是 L3 的前置；
**L5 的唯一输入（债 2）**要等 L3 存在之后才有意义」。

### 5.3 勘误分布：债 4 有，债 1/3 没有

```
$ rtk proxy grep -n "Amended" docs/superpowers/specs/2026-07-28-run-registry-design.md
:3 :28-29 :89 :173 :223 :267 :288 :376 :395 :515
```

`:515` 起是 `*Amended (j) — this debt is discharged at the write side. …*`，挂在 **§13 第 4 条**下。
**§13 第 1 条与第 2 条下无任何 `Amended`。** 第 3 条正文里有一句 **`**This debt must be
re-evaluated by whichever layer adds a triggering caller**, which is the deferred queue layer,
not this one.`** —— 方向对（指向 L3），**但它没有推翻上方 `:468` 的「Debts 1–3 are bequeathed to L5」**，
两句同节并存。

### 5.4 我另找到的、比 D7 更强的一条 —— 裁决记录亲自下过更正指令

`decisions/2026-07-29-technical-debt-attribution.md` 有一节标题就叫 **「## 对 handoff 的更正」**，
`:246` / `:248` 逐字：

> 2. **L5 继承清单第 1 条描述有误**：「reconciliation 合成责任无人认领」不成立，见债 1。该条应改写为跨文件事务性缺陷，**并从 L5 清单移到 L3**。
> 4. **L5 继承清单现在只剩 1 笔**（债 2），不是 4 笔。

**这不是「D7 推断出来的」，是裁决记录自己写死的执行项。它至今没有在 L2 spec 上被执行。**
D7 因此不是「措辞过期」，是**一条有名有姓、有下达方、未执行的更正指令**。

### 5.5 判定

L5 若把 L2 spec 当输入读（它是 L5 最近的上游、且 §14 item 2 就是 L5 的派单处），
会在 `:57` 与 `:468` 两处拿到「三笔债」，**多出两笔已经归 L3 且已在 L3 关闭的债**。
分级：**仅文档**，但它直接放大 L5 的输入面（3 笔 vs 1 笔）。

## 6. D4 — L1b「is L5's problem」已裁关闭却无勘误（主张 6）

**结论：CONFIRMED，三个半句全部成立。这是本轮证据链最完整的一条 —— 裁定、评审员点名、未执行，三样俱全。**

### 6.1 L1b spec 今天仍如此（`2026-07-27-owner-transfer-contention-design.md:113` 末句，逐字）

> The same ruling deliberately gave up the losing process's synthesis of the winner's reconciliation view; if that view is still wanted, assigning it to a process that still holds the run is **L5's problem**.

### 6.2 人已裁定它被 L3 取代 —— L3 台账 `:36`（逐字，未削短）

> Task A4: HUMAN RULING (Rule 7 conflict between two spec documents, surfaced by the implementation, not by any review round). L1b docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:113 "Amended 2026-07-28 (e)" states that a completed owner-transfer.json no longer implies a reconciliation-record.json, calls that requirement 7's INTENDED behaviour, and ends: "The same ruling deliberately gave up the losing process's synthesis of the winner's reconciliation view; if that view is still wanted, assigning it to a process that still holds the run is L5's problem." L3 debt 1 transactionalises reconciliation so the SAME CAS publishes it. **Human ruled: L3's transactionalisation SUPERSEDES L1b (e).** A4's assertion flip stands.

同一处台账 `:38` 还写死了它对 L5 清单的记账后果（逐字）：

> (b) L5's inherited-input list is unaffected in NUMBER: the L3 spec's 13 five-item list does not contain the L1b-side "winner reconciliation view" assignment, so 5 笔 / 6 项 stay. **Record that this L1b-side assignment is now closed by L3 rather than inherited by L5.**

### 6.3 当时的评审员点名要求落勘误，并明写没做 —— 台账 `:44`（逐字，未削短）

> 3. docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:113 now states something production code contradicts. Repo convention is an in-place *Amended (f)* note, and the debt-4 precedent explicitly says a later layer that falsifies something should annotate in place. **NOT done here**: the human's approved option covered a code comment + ledger only, and the plan's stance is that spec errata are the human's timing call. **Flag for the human.**

```
$ rtk proxy grep -rn "NOT done here\|Flag for the human" .superpowers/ docs/   # 排除本轮扫描目录
.superpowers/sdd/2026-08-02-...-continuation/progress.md:42:  3. docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:113 …
```

**全仓仅此一处。** 也就是说这条被点名的 flag 此后再无任何文档接过它。

### 6.4 勘误至今不存在 —— 命令与输出

```
$ rtk proxy grep -n "Amended" docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
:4  …marked inline as **Amended 2026-07-28 (a)–(e)** in §2, §5.1, §5.3, §5.4 a…
:17 …side-effect omission recorded as **Amended 2026-07-26 (c)** in the L1 spec §8.1.
:27 …now described in L1 §8.1 (**Amended (b)**) is untouched…
:29 **Amended 2026-07-28 (a): …
:95 **Amended 2026-07-28 (b): …
:113 **Amended 2026-07-28 (e): …
:123 **Amended 2026-07-28 (c): …
:139 **Amended 2026-07-28 (d): …
```

**只到 `(e)`，没有 `(f)`。** 评审员点名的那条 `*Amended (f)*` 从未落盘。

### 6.5 判定

D4 是**四份报告里唯一一条同时具备「人已裁定 ＋ 评审员点名 ＋ 明确记为未做 ＋ 至今未做」四要素**的项。
它不需要任何新的技术判断，只需要执行一条早已裁定的文档动作。**分级：仅文档，但零争议、零成本。**
反过来说：它已经在这个仓库里悬了整整一个 L3（六波以上评审）无人接 —— 这一点本身是治理证据。

## 7. spec §12 `:2306`「界的是付费调用」（主张 7）

**结论：CONFIRMED，且比「漏同步」更重 —— 它与同一节 5 行之上的更正直接互相矛盾，
而且它就长在那句把第 5 笔交给 L5 的句子里。**

### 7.1 六处「界的是」的分布（命令 ＋ 输出）

```
$ rtk proxy grep -n "界的是" docs/.../2026-08-01-...-design.md
:1441  **⚠️ 但「`--max-runs` 界的是付费调用次数」这句话过头了（第四轮评审，Minor，就地更正）。** `--max-runs N` 界的是**进入…
:1450  …准确表述：**`--max-runs` 界的是「本次 sweep 会启动多少个 run 的续跑」，每个 run 的付费调用由它自己的 `maxAttempts`…
:2301  …数（第四轮更正）**：`--max-runs N` 界的是**进入 `runLoopFromState` 的 run 数**；每个 run 内部的 `while…
:2302  …run 一次付费调用都没发生，让它吃掉配额既不符合「界的是付费调用」这个目的…
:2306  …不界的东西，明写出来**：`--max-runs` 界的是**付费调用**，不界事件追加。…
:2885  …| M2 | Minor | §6 那句「`--max-runs` 界的是付费调用次数」过头：它界的是**进入 `runLoopFromState` 的 run 数**…
```

§12 的边界：`grep -n "^## "` → `:2292 ## 12. 治理与付费调用`，`:2308 ## 13. 继承债与不做的事`。
**`:2301` 与 `:2306` 在同一节内，相距 5 行。**

### 7.2 两句逐字对照 —— 同一节内直接矛盾

`:2301`（第四轮就地更正）：

> **⚠️ N 不等于付费调用次数（第四轮更正）**：`--max-runs N` 界的是**进入 `runLoopFromState` 的 run 数**；…**付费上界是 `N × maxAttempts`。** …**把「横幅里的 N 就是付费次数」这个读法明确标为错误。**

`:2306`（本节末段，未更正）：

> **本节不界的东西，明写出来**：`--max-runs` 界的是**付费调用**，不界事件追加。一次 sweep 扫到 M 个永久被拒的 run 仍会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件（无退避、无上限、无标记，理由与代价见 §6），**这一笔具名传给 L5**（§13）。

`:2301` 把「N＝付费次数」标为**错误读法**；`:2306` 在 5 行后**按那个错误读法**给出「界的是付费调用」。

### 7.3 为什么没被同步 —— §19 M2 的修订处措辞

`spec:2885` 第三列逐字：

> §6 第 1 条与 §12 各补一段（附 `while (true)` 与 `maxAttempts` 的实测）。…

**「各补一段」而不是「就地改」。** §6 侧的两处（`:1441` / `:1450`）确实是就地改的；
§12 侧只**新增**了 `:2301` 那一段，**旧措辞 `:2306` 原封不动地留在下面**。
这是「补一段」型勘误的典型失效：新段和旧句共存，读者按顺序读到的是旧句。

### 7.4 承重之处：`:2306` 就是第 5 笔的交接句

`:2306` 不是一句闲话，它是 **§13 第 5 笔（被拒 run 的无退避重捡）向 L5 交接的原句**
（末尾「**这一笔具名传给 L5**（§13）」）。也就是说：**L5 拿到第 5 笔时，
随之拿到的语境是一句已被本文档自己判为错误读法的话。**

### 7.5 从未被记成任何一笔债 —— 我的核对

- §13 的 5 笔 ＋ 债 2 里没有它（§13 = `:2308`–`:2440`，第 5 笔讲的是无退避重捡本身，不是这句措辞）。
- L3 台账 `:1773-1776` 的 L5 继承三项里没有它。
- §19 只把它记成一条 Minor（M2），而 M2 的处置是「补一段」，**处置执行完毕即闭环，
  残留的旧措辞不产生新的债项**。

**所以「从未被记成任何一笔债」CONFIRMED。** 它今天既不在债表、也不在勘误、也不在交接清单里。

### 7.6 一条附带记录

控制器派给扫描员 C 的 brief 逐字引用了 `:2306` 并标注「原文明写」。**引用是忠实的**
（我按行核过），**腐坏在文档自身**。这条已由控制器在台账 `:266-268` 自曝，我复核后无异议。

## 8. L5 的原始委任状（主张 8）

**结论：扫描员 D 的更正是对的。控制器派单前提有误，D 证伪成立，我独立复核确认。**

### 8.1 `2026-07-28-run-registry-design.md` 确实没有 §17

```
$ rtk proxy grep -n "^## " docs/superpowers/specs/2026-07-28-run-registry-design.md
:38 ## 1. Purpose        :48 ## 2. Non-Goals      :70 ## 3. Authorization Position
:87 ## 4. Run Directory Recognition                :122 ## 5. Traversal Rules
:140 ## 6. Observation Record Shape                :193 ## 7. Read Path and the Zero-Write Guarantee
:265 ## 8. Consistency Model                       :333 ## 9. CLI Surface and Exit Codes
:362 ## 10. Module Boundaries                      :374 ## 11. Error Handling Summary
:393 ## 12. Test Requirements                      :466 ## 13. Inherited Debts — Explicitly Not Taken
:523 ## 14. Follow-On                              :533 ## 15. Success Criteria
```

**止于 §15。没有 §17。**

### 8.2 真正的委任状 —— `2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17

```
$ rtk proxy grep -n "^## " docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md
… :375 ## 17. Follow-On Specs Required   :386 ## 18. Success Criteria
```

`:375`–`:384` 原样：

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

### 8.3 「Parent」指向的独立验证（不靠 D，靠两处逐字对齐）

`run-registry-design.md` §14（`:523`–`:531`）逐字：

```
1. **Queue / triggering layer.** The remaining half of parent §17 item 2: when and
   by whom a discovered, eligible run is re-queued or continued. …
2. **L5 cleanup / orphan GC.** Parent §17 item 3, still unwritten, and now
   holding the debts in §13. …
```

- 「parent §17 **item 2**」= "when and by whom a discovered, eligible run is **re-queued or continued**"
  ↔ ownership §17 item 2 = "when and how an eligible run is **re-queued or continued**" —— **逐字对齐**。
- 「Parent §17 **item 3**」= "L5 cleanup / orphan GC" ↔ ownership §17 item 3 =
  "**Cleanup / orphan handling design**" —— **逐字对齐**。

两处独立对齐同时成立，**「parent」指向 ownership 设计这一点被钉死**，不需要依赖任何一份报告的转述。

### 8.4 判定

- 控制器的派单前提（委任状在 run-registry §17 item 3）**被证伪**。
- 扫描员 D 的更正（委任状在 ownership design §17 item 3）**独立复核成立**。
- D 的处置（原样上报派单前提有误、不替控制器圆场、不自改判据）**正确**。
- **附带**：委任状全文只有一行（"how superseded or lost-owner workspaces and evidence are
  retained or cleaned up safely"）。这一行**同时授权「retained」与「cleaned up」两个方向**，
  而本轮的合并态势只提「deletion 授权」。**保留（retention）这一半在四份报告里一次都没被提到。**

## 9. 盘点完备性 —— 两个可重数的计数，以及「报不出就不报」这个处置

### 9.1 数字 1：`grep -rn 'L5' docs/superpowers/ | wc -l` = 78 —— 精确复现

```
$ rtk proxy grep -rn 'L5' docs/superpowers/ | wc -l
      78
$ rtk proxy grep -rn 'L5' docs/superpowers/ | rtk proxy cut -d: -f1 | rtk proxy sort | rtk proxy uniq -c
  16 docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
   2 docs/superpowers/plans/2026-07-28-run-registry.md
   7 docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md
   4 docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md
   2 docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
   4 docs/superpowers/specs/2026-07-28-run-registry-design.md
  43 docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
```

16+2+7+4+2+4+43 = 78。**CONFIRMED，精确。**

### 9.2 数字 2：门报告「带到 L5」类 = 23 —— 精确复现

用 D 报告 `:59-64` 逐字给出的同一条命令：

```
$ rtk proxy grep -nF -e '带到 L5' -e 'defer 到 L5' -e '加到 L5' -e 'L5 台账' -e 'L5 条目' -e '改判给 L5' -e '顺延给 L5' \
    …/gate-c-lane2-report.md …/gate-b-lane2-report.md …/gate-c-fix-wave-report.md …/group-c-preflight-scan.md | wc -l
      23
```

按文件拆解（`-c`，我自己加的，D 没给）：

```
gate-c-lane2-report.md:19    gate-b-lane2-report.md:1
gate-c-fix-wave-report.md:1  group-c-preflight-scan.md:2      → 19+1+1+2 = 23
```

**CONFIRMED，精确。**

### 9.3 但这个数字的**标签**不准，我原样上报

D 把这四份文件称作「**四份门报告**」。实测：

- `group-c-preflight-scan.md` **不是门报告**，是组 C 开工前的计划冲突扫描。
- 目录里另有两份真正的门产物被排除在外：`gate-a-fix-wave-report.md`、`gate-a-option2-report.md`。

我把这两份也跑了一遍，以确认排除不影响数字：

```
gate-a-fix-wave-report.md:0    gate-a-option2-report.md:0    progress.md:0
```

**两份都是 0，所以 23 这个数不受影响；但「四份门报告」这个标签是错的**，
准确说法是「三份门产物 ＋ 一份组 C 预扫」。**数字对，标签错，原样上报。**

（附带：`progress.md` 也是 0，因为台账用英文措辞交接。**这条七词中文 grep 天然扫不到台账**，
这是它作为「完备性度量」的一个已知盲区，D 未声明这一点。）

### 9.4 「报不出可重数的计数就不报数字」这个处置 —— 判定：**正确，且应当立为规则**

D 拒绝报「清单外交接共 N 条」，理由是「条目」是人工归并单位、没有命令能重数它。我核了它给的两条理由：

1. **§13 自己就在做归并。** `spec:2422` 第 4 笔逐字：「输家 reconciliation 写的残余 TOCTOU
   （第三轮新增，**接替第二轮那笔被收回的 pending 非原子写**；第四轮**扩写为*两条*时序**）」——
   一笔债里装着两条独立时序，且这一笔是替换进来的。**「笔」与「条」在同一份文档里就不是一回事。**
2. **同一份文档里，「5 笔 / 6 项」两个口径并存**（`spec:2321` 的「6 项」= 债 2 ＋ 5 笔）。
   一个数字要同时兼容两种归并口径，本身就不可重数。

**因此这个处置不仅正确，而且是本轮最该被沿用的方法论产出。** 它把「盘点」从
「一个会被下游当权威传播的合计数」换成了「两条任何人都能在 10 秒内重跑的命令」，
正对着本仓库反复栽的那个形状（聚合数字被从交接文档传播进 dispatch）。

**但要加一条限定，否则它会被过度引用**：这两个数字**不是**「清单外交接的条数」的替代品，
它们是**搜索面的大小**。78 里绝大多数是叙述性提及；23 里包含同一条被多次记录的项。
**它们能证明「盘点覆盖了多大范围」，不能证明「盘点是完备的」。**
本报告 §12 找到的那条集体漏项，正是这两个数字都扫不到的（它不含 `L5` 字样、也不在门报告里）。

## 10. D1–D13 抽查（6 条）

抽 D8 / D9 / D10 / D11 / D12 / D13（六条，超出要求的 5 条）。**逐字引用六条全部核对无误。**
出处、「在不在 6 项内」的判定六条全部成立。分歧只在 D12。

### 10.1 D8 — L1 fresh-start 排他 TOCTOU

`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md:293` 末句，逐字核对：

> Closing the window properly (an atomic exclusive create) is a real improvement, deliberately **not** in L1's scope, and noted here so a later layer picks it up knowingly rather than discovering it.

**逐字命中。** D 判「「a later layer」含糊指向、归属未裁、无法判断是否该指向 L5」——
**成立**，我另核了它与 §13 笔 1 不是同一把锁（笔 1 是 owner-transfer 锁协议，本条是 run 目录创建期排他），
D 这个区分是对的。**补一条 D 没给的**：同一条在 plan 侧还有一处未勘误的复刻
（`plans/2026-07-26-run-lease-and-heartbeat.md:2527`，「Closing the window properly is a real
improvement and **belongs to a later layer**」），D 的出处只写了 spec。

### 10.2 D9 — 「succeeded 之后才发现被 supersede」

L1 spec `:239` 末句，逐字核对：

> A future layer that needs to distinguish "succeeded cleanly" from "succeeded, then discovered it had been superseded during cleanup" must read the event log, not the terminal state.

**逐字命中。** 「A future layer」含糊指向、不在 6 项内 —— **成立**。
D 判它是「消费约束（纯文档性质）」而非缺陷 —— **同意**，它是对未来读者的读法约束，不是待修项。

### 10.3 D10 — L1 记下的两个机制

L1 spec `:47`–`:49`，逐字核对（Read 原样）：

```
Two mechanisms noted here so they are not lost, both belonging to L2/L3 rather than L1:

- an **attempt cap on re-leasing**, so a repeatedly failing run cannot be leased and retried forever. …
- **cross-run path exclusion**, per §8.2.
```

**逐字命中**（D 引用时省略了 DoWhiz 的引证尾巴，用了 `…`，属正当省略）。
「明写不是 L5、不在 6 项内、也不该在」—— **成立**。
D 附的那条 ⚠️（L3 §5.4 放弃把停机计入 attempt 配额，与「attempt cap on re-leasing」方向相反，
而 L3 未兑现也未声明放弃）**是本条最有价值的部分，且 D 正确地把去向判为「无法判断」。**

### 10.4 D11 — §8 既有 `errored` 行的同形缺陷

`spec:762` 逐字核对：

> （**§8 既有的 `errored` 那一行有同样的问题，先于本波存在，本波刻意不动它** —— 那是另一条契约的范围，改它要连带 §7 与测试 12c，收益不抵成本。**具名留给下一轮。**）

**逐字命中。** plan 侧复刻在 `:1713`（我核过，措辞差一个字：plan 写「**本层**刻意不动它」，
spec 写「**本波**刻意不动它」）。
D 的判断「「下一轮」是一个**已经过去**的指向 —— L3 已合入，没有下一轮了；它现在事实上无人承接」
—— **成立，且这是 D1–D13 里论证最干净的一条**：交接的接收方是一个时间点，那个时间点已经过去。

### 10.5 D12 — §4.6「代码零改动」—— **D 判为「悬空、未完成」，我把它推到底了，它是一条确凿的活缺陷**

D 自陈：「本项未完成 —— 我没有核实计划阶段最终裁成什么、也没有核实 §4.6 那句话在 HEAD 上是否已改。」
**我补齐了这两步，缺口关闭，结论是坐实而非悬空：**

**(1) 计划阶段裁了，而且裁的方向是「改 §4.6 那句话」** —— `plan:225`–`:229` 逐字：

> ### 裁定三 —— §4.6「`preserveSuccessfulReconciliationIfNeeded` 代码零改动」这句话为假，予以推翻
> **spec §4.6 写着这个函数代码零改动；§4.3 第六波已就地标出「处置一落地之后那句话为假」，并把裁定留给计划阶段。**
> **裁定：改 §4.6 那句话，不去为了保住「零改动」而把整块判定上移。**

**(2) §4.6 那句话在 HEAD 上没改** —— `spec:1012` 逐字：

> `preserveSuccessfulReconciliationIfNeeded` **代码零改动**。

全 spec 只有 4 处 `Amended`（`:1558`/`:1562`/`:1578`/`:1580`），**没有一处在 §4.6 附近**。
（§4.6 下方 `:1014` 那条 ⚠️ 更正的是**理由**「赢家必然早退」，不是「零改动」这个结论本身。）

**(3) 代码今天证明它为假** ——

```
$ rtk proxy grep -nF -A 6 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
392:async function preserveSuccessfulReconciliationIfNeeded(
393-  runDir: string,
394-  nextReconciliationRecord: ReconciliationRecord,
395-): Promise<ReconciliationWriteDecision> {
396-  if (nextReconciliationRecord.eligibleForContinuation) {
397-    return { kind: "write", record: nextReconciliationRecord };
398-  }
```

返回类型今天是 `Promise<ReconciliationWriteDecision>`（判别式联合），
plan `:231` 记录的改动前形态是 `Promise<ReconciliationRecord>`。**函数确实改了。**

=> **D12 从「无法判断 / 悬空」升级为：一条被人裁明令要改、代码已证其为假、而勘误从未落盘的活缺陷。**
它与 D4 同形（裁定在、执行不在），且**同形第三次**（D4 / D12 / §7 的 `:2306`）。

### 10.6 D13 — `writeAttemptArtifacts` 非原子写

`docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md:48` 逐字核对：

> - **不改 `writeAttemptArtifacts`（`:712+`）**：写的是 attempt 目录内的产物，不在 run 目录顶层，L2 不观测，且无并发读者依赖其连贯性。若后续证明需要，另开一笔。

**逐字命中**（D 给该句末半句加了粗体，原文无粗体；内容一致）。
D 判「**有意排除**（给了理由）、列在此处只因它是一条无主的悬挂项，不因它指向 L5」——
**成立，且这个自我限定是对的**，它没有把一条明确排除的项包装成交接。

### 10.7 抽查小结

- 六条出处 **6/6 正确**，逐字引用 **6/6 准确**（两处无实质影响的排版差异已在上面指出）。
- 「在不在 §13 那 6 项之内」的判定 **6/6 正确**。
- 「有意排除 vs 漏掉」的证据：D8/D9/D10 判「无法判断」**证据充分且判得对**（原文确实没点名层）；
  D13 判「有意排除」**证据充分**（原文给了理由）；D11 判「事实上无人承接」**证据充分**；
  **D12 的「无法判断」证据不足 —— 它缺的两步都在 8 行以内可查，见 §10.5。**

## 11. 治理四条 —— 我自己的证据

**四条全部 CONFIRMED。第 4 条我推得比 C 更远：C1-M3 的论据不是「今天过期」，是「写下时就为假」。**
**合并结论：GATE-C 的产物完整性有缺口，且缺口不止一处。**

### 11.1 治理 1 — GATE-C 的 deferred-minor 分诊结论从未落进 ledger：**CONFIRMED**

台账里带逐条处置的 `DEFERRED-MINOR TRIAGE` 段落全仓只有两处：

```
$ rtk proxy grep -n "DEFERRED-MINOR TRIAGE" …/progress.md
431:DEFERRED-MINOR TRIAGE. 44 discrete items, re-derived by COUNTING the itemised list   ← GATE-A
1032:DEFERRED-MINOR TRIAGE (lane 2): B1 M-2 record only; B2 M-1 UPGRADED from record-     ← GATE-B
```

**GATE-C 段（`:1582` 起）内没有同位段落。** 更强的证据：GATE-C 段内**任何** C 组 minor ID 都不出现：

```
$ rtk proxy grep -n "C1-M\|C2-M\|C3-M\|C4-M" …/progress.md | awk -F: '$1>1580'
1631:below as C2-M5, C2-M6, C3-M6 and two doc items.
```

**唯一一行，还是那句没兑现的承诺（见 11.2）。** 而 lane 2 在 GATE-C 的车道定义（`:1589`）
逐字是「Lane 2 — full mutation/evidence rescan and **deferred-minor triage**」，
台账 `:1775` 又写着「the deferred-minor list **triaged at this gate**」。

=> **分诊被派了、被声明做过了、结论只活在 `gate-c-lane2-report.md` 里，一条都没进台账。**
对照 GATE-B（`:1032` 那段把 B1 M-2、B2 M-1..M-4 逐条写了处置，还记了一次 UPGRADED），
**GATE-C 少的就是这一段。**

### 11.2 治理 2 — `:1631` 承诺的三个 ID 此后一次没出现：**CONFIRMED**

`:1625`–`:1631` 逐字（未削短）：

> question that was properly escalated went unanswered across the whole branch.
> Lane 2 named this "a false close occurring on SPEC COMPLIANCE". Human ruling:
> COMPLIANT — "not a positive integer" is ONE square of the exit-code table, the
> six values are an enumeration within it, and each iteration clears the spy and
> asserts the specific message. Recorded here, which is the half that was missing.
> **Lane 2 also found five more escalated-but-unrecorded concerns; they are logged
> below as C2-M5, C2-M6, C3-M6 and two doc items.**

```
$ rtk proxy grep -n "C2-M5\|C2-M6\|C3-M6" …/progress.md
1631:below as C2-M5, C2-M6, C3-M6 and two doc items.
```

**一行命中，就是承诺本身。三个 ID 此后零出现，两条 doc items 也没有。**

**⚠️ 加重情节，我自己找的**：这段话的上文说的是「一个被正当上报的问题，在整条分支上无人回答」，
而人裁的落点是「**Recorded here, which is the half that was missing**」——
**台账在同一段里一边宣告「补上了缺失的那一半」，一边留下一句从未兑现的「logged below」。**
同一段文字既是治理修复，又是新的治理缺口。

**附带发现（C 没报）**：C 组的 minor ID 序列本身有洞 ——
`grep -c "^Task C[1-4]: minor (deferred" ` = **15**，但 C3 的编号是 M1/M2/**M4**/M5，
`C3-M3` 走的是另一条记法（`:1450 Task C3: minor (folded into fix round 1): C3-M3`）。
**编号连续但记法不连续**，任何按 ID 枚举的复核都会在这里错位。

### 11.3 治理 3 — lane 1 的门评审报告没落盘：**CONFIRMED，且比 C 说的更严重**

全仓 `-iname "*lane*"` 实测（已排除 `reference/` 下的无关命中）：

```
/Users/biran/code/skills/loop/ccloop/.superpowers/sdd/2026-08-05-l5-input-scan/review-lane1-code.md   ← 本轮，正在写
/Users/biran/code/skills/loop/ccloop/.superpowers/sdd/2026-08-02-…/gate-c-lane2-report.md
/Users/biran/code/skills/loop/ccloop/.superpowers/sdd/2026-08-02-…/gate-b-lane2-report.md
```

- **三道门、每道两名评审员 = 6 份报告，落盘的只有 2 份，全是 lane 2。**
- **GATE-A 连 lane 2 报告都没有**（目录里只有 `gate-a-option2-report.md` 与 `gate-a-fix-wave-report.md`，
  两者都不是门评审报告）。C 只说了 lane 1 缺，**GATE-A 两条车道都缺，这一点 C 没报。**
- lane 1 在 GATE-C 有 **3 条 Minor**（台账 `:1587` 逐字：「Lane 1 — … PASS WITH CONDITIONS,
  0 Critical, 2 Important, 3 Minor」）。我通读了 GATE-C 全段（`:1582`–`:1740`）：
  **2 条 Important 写了「fixed before the gate」，3 条 Minor 一条都没有落点。**

=> **lane 1 的 3 条 Minor 今天既不在报告里（报告不存在）、也不在台账里。它们已经不可恢复。**
这不是「未复核」，是**证据已灭失**。四项里这一条是唯一不可补救的。

### 11.4 治理 4 — C1-M3：**CONFIRMED，且比 C 判得更重 —— 它写下时就为假**

**(a) C1-M3 的原文** —— 台账 `:1246`-`:1249` 逐字：

> Task C1: minor (deferred): C1-M3 — the `rootFailure → stderr + return 1` path is
>   this layer's ONLY non-zero exit and has NO test. The plan's four required tests
>   do not ask for one, so this is not a violation; if a later edit turns it into
>   `return 0`, §7's whole error contract fails silently and nothing reds.

**(b) 那条测试今天存在** —— `tests/cli/cli.test.ts:363-378`（Read 原样）：

```
363	  // §7: the scan failing at its OWN root is the only per-scan condition that exits non-zero. The
364	  // stderr assertion is what distinguishes it from the argument failures above, which would also
365	  // be exit 1 — this run got as far as the scan and the scan is what refused.
366	  it("exits 1 when the root does not exist", async () => {
367	    const { adapterConfigPath } = await seedSweepRoot();
368	    const missingRoot = join(await mkdtemp(join(tmpdir(), "ccloop-sweep-missing-")), "does-not-exist");
369	    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
370	    try {
371	      await expect(
372	        main(["sweep", "--root", missingRoot, "--adapter", "scripted", "--adapter-config", adapterConfigPath, "--max-runs", "1"]),
373	      ).resolves.toBe(1);
374	      expect(errorSpy.mock.calls.flat().join("\n")).toContain(`sweep: cannot scan ${missingRoot}`);
375	    } finally {
376	      errorSpy.mockRestore();
377	    }
378	  });
```

它同时钉住 exit code（`:373`）**和** stderr 前缀（`:374`），正是 C1-M3 担心的「改成 `return 0`
就静默失效」的那条路径。**（C 的锚点写 `:366`，那是 `it(` 行；断言在 `:373`/`:374`。不影响结论。）**

**(c) 关键 —— 它不是后来补的，是 C1 自己那次提交加的：**

```
$ rtk proxy git log --format='%h %ad %s' --date=short -S 'exits 1 when the root does not exist' -- tests/cli/cli.test.ts
c15b499 2026-08-04 feat(cli): add the sweep command with a required --max-runs and an injectable stop-signal escape hatch
f5cbd97 2026-07-28 feat: add the ccloop ls subcommand
```

`c15b499` 就在 GATE-C 的评审区间内（`git log --oneline 2713c20..4a24a94` 八条，`c15b499` 是 C1 的那条）。
`git show c15b499 -- tests/cli/cli.test.ts` 的 hunk 显示这个 `it` 与它上方那三行 §7 注释
**是被这次提交新增的（`+` 号）**。

=> **C1-M3 说「has NO test」时，同一个 commit 已经带着这条测试。论据不是「后来腐坏」，是从一开始就为假。**

**(d) lane 2 在 GATE-C 上把它当「仍成立」的对照物** —— `gate-c-lane2-report.md` 两处：

```
:176 | C1-M3 | 带到 L5 | `rootFailure → stderr + return 1` 是本层唯一非零退出、无测试。**与我在 §5.2 新发现的 C2 concern 8 同族，两条应一起承接** |
:243 ### 5.2 C2 concern 8 未记账，且与已记账的 C1-M3 同形（分诊不对称）
:246 C1-M3（「本层唯一的非零退出路径无测试」）**被记成了 deferred minor**；形状完全相同的这一条**没有**。同一个缺陷形状在同一组里被两种标准处理。
:247 → **补记为 C2-M5，带到 L5，与 C1-M3 同一个承接方。**
```

**这是一条完整的失效链**：一条**从未成立**的 minor（C1-M3）→ 被 lane 2 当作「已记账的同形先例」→
用来论证必须补记 C2-M5 →「补记」的承诺写进台账 `:1631` → **从未兑现**。
**链条的两端都断了，中间那段还建立在假前提上。**
（C2-M5 自身的事实是否成立不属我的车道，我未核；**我核的是它的论证支柱，那根支柱是假的。**）

### 11.5 治理四条的合并判定

**成立，四条全中，且缺口比 C 报的更宽。** 具体化「产物完整性有缺口」：

| 缺口 | 可否补救 |
|---|---|
| GATE-C 的分诊结论未进台账（15 条 ＋ 报告独有 3 条） | **可补**：`gate-c-lane2-report.md` 还在，照 GATE-B `:1032` 的形状补写一段 |
| `:1631` 承诺的 C2-M5 / C2-M6 / C3-M6 ＋ 两条 doc items | **可补**：三个 ID 的正文都在 lane 2 报告里；两条 doc items 需先定位 |
| GATE-C lane 1 的 3 条 Minor | **不可补 —— 报告未落盘，台账无记录，证据已灭失** |
| GATE-A 的两份门评审报告 | **不可补 —— 同上** |
| C1-M3 的假前提污染了 C2-M5 的论证 | **可补，但需重新论证 C2-M5，不能继承原论证** |

**这一格「不可补」是本轮最要紧的单条发现**，因为它不是一笔债，是**判据本身的灭失**：
任何未来对 GATE-C 的复核都无法再问「lane 1 当时说了什么」。
本仓库的铁律是「不接受实施者自证」，而**一道门有一半的评审证据不存在，等于那一半从未被验证过**。

## 12. 被四名扫描员集体漏掉的交接

**有。一条，而且它恰好是 L5 本职（cleanup / orphan GC）唯一的一条现成设计输入 ——
这直接修正了本轮的头号结论「L5 的本职工作今天没有任何设计输入」。**

### 12.1 我的扫法（D 的 78 行扫不到它，因为它不含 `L5` 字样）

```
$ rtk proxy grep -rniE "a later layer|a future layer|later layers|future layers|whichever layer|some future|Owner: unassigned|owner is unassigned|left unassigned|deferred to a|out of scope for this layer|not this layer's" docs/superpowers/
$ rtk proxy grep -rnE "留给(后续|下一|未来)|属后续层|后续层|交给后续|留待|另开一笔|不在本层|超出本层|本层不做|无人认领|无主|待裁|归属未裁" docs/superpowers/
```

（两条命令的完整输出较长，逐行我都读过；**未削短、未过滤**，下面只列出**不在 D1–D13 且不在 6 项内**的新命中。）

### 12.2 漏项：`atomic-write-paths` spec §10 第 4 条 —— 崩溃残留临时文件无人清理

出处：`docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md`，§10「已知会留下的问题
（不在本分支解决）」第 4 条。**Read 原样，`:281`–`:291`：**

```
4. **崩溃残留的临时文件没有任何机制会清理**：`SIGKILL` 落在 `writeFile(temp)` 与 `rename` 之间时，
   `.{basename}.{pid}.{startTime}.{seq}.tmp` 会**永久**留在 run 目录里。两条现存清理路径都够不着它，
   已逐一核对代码：`ensureFreshRunDir` 只对三个具名文件（`loop-contract.json`、`loop-state.json`、
   `events.jsonl`）加 `attempts/`、`worktrees/` 两个目录的条目做阻塞；
   `recoverInterruptedOwnerTransfer` 经 `cleanupOwnerTransferStagingWithoutMarker` 只清
   `getOwnerTransferPaths` 的**四个固定名**——而临时名按 §4.1 的要求本就必须不在那四个之内。

   **定性要准确：这是无界垃圾，不是故障。** 未发现任何功能性破坏：临时名不在 `RUN_MARKER_FILES`
   （`scanRuns.ts:30-36`，五个具名文件）里，所以它不会把一个目录误认成 run；L2 只读
   `OBSERVED_FILES` 的三个文件，不会读到它；`ensureFreshRunDir` 也不会因它而拒绝初始化。
   代价只是崩溃次数足够多之后 run 目录内文件数无上限增长。**不要把它上报成缺陷。** 清理归属未分配。
```

### 12.3 为什么这是本轮最重要的一条漏项

1. **它是 L5 委任状的字面内容。** 委任状（§8.2）逐字是 "how superseded or lost-owner
   **workspaces and evidence are retained or cleaned up safely**"。
   「崩溃残留的临时文件永久留在 run 目录、无任何清理路径、清理归属未分配」
   **就是 cleanup / orphan GC，一字不差。**
2. **它明写「清理归属未分配」。** 不是「留给后续层」这种含糊指向 —— 是一条自陈无主的项。
3. **它已经带着完整的、可直接用的设计输入**：残留物的命名模式、两条现存清理路径为什么够不着、
   为什么不会造成功能破坏、代价是什么、以及一条明确的分级指令（「不要把它上报成缺陷」）。
   **这是全仓唯一一条为 L5 的本职工作预先写好的分析。**
4. **四份报告一条都没提。** 重推：

```
$ rtk proxy grep -rn "临时文件\|\.tmp\|atomic-write-paths" .superpowers/sdd/2026-08-05-l5-input-scan/
scan-D-offlist-sweep.md:273:- **出处**：`docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md` §2.2 明确的非目标。
scan-C-backoff-and-gate-carries.md:1275:>   success path that forgot to unlink .owner-record.publish.tmp keeps 14b gre…
```

D **读了这份文件**（D13 取自它的 §2.2），**但没读到 §10**。C 那一行是别的上下文。
**A、B 零命中。**

### 12.4 它在今天的代码上仍然成立 —— 我的核验

```
$ rtk proxy grep -rn "\.tmp" src/
src/persistence/fileStore.ts:524:const OWNER_RECORD_TEMP_FILE = ".owner-record.publish.tmp";
src/persistence/fileStore.ts:525:const OWNER_TRANSFER_TEMP_FILE = ".owner-transfer.publish.tmp";
src/persistence/fileStore.ts:526:const RECONCILIATION_RECORD_TEMP_FILE = ".reconciliation-record.publish.tmp";
src/persistence/fileStore.ts:532:const OWNER_TRANSFER_MARKER_TEMP_FILE = ".owner-transfer.transaction.tmp";
src/persistence/fileStore.ts:533:const OWNER_RECORD_PENDING_TEMP_FILE = ".owner-record.pending.tmp";
src/persistence/fileStore.ts:534:const OWNER_TRANSFER_PENDING_TEMP_FILE = ".owner-transfer.pending.tmp";
src/persistence/fileStore.ts:535:const RECONCILIATION_RECORD_PENDING_TEMP_FILE = ".reconciliation-record.pending.tmp";
src/persistence/fileStore.ts:628:    `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${atomicTempPathSequence}.tmp`,
```

`:628` 就是文档描述的那个动态临时名生成点，**`src/` 内没有任何按该模式删除的代码**。
`RUN_MARKER_FILES`（`src/registry/scanRuns.ts:30-36`）实测仍是五个具名文件
（`loop-contract.json` / `loop-state.json` / `events.jsonl` / `owner-record.json` / `owner-transfer.json`），
**文档「不会把目录误认成 run」的论据今天仍成立。**

*** ⚠️ 但 L3 之后残留面**扩大了**，文档没跟上：*** 文档写这条时，三份 pending 还不是原子写；
L3 §4.0.3a 把三份 pending 一并改成 temp+rename（`spec:2812` G11 逐字：「**人已裁定：
三份 pending 一并改原子写，与 marker 逐字同形**」），**于是新增了三个走 `:628` 那条临时名路径的写点**。
**残留物的种类比这份文档描述的更多，而这份文档从未被 L3 勘误过。**

### 12.5 另外两条较轻的新命中（一并上报，不夸大）

- **`atomic-write-paths` spec §10 第 3 条**：「**`writeOwnerTransferRecord` 仍可被误用**：
  只加了注释，没有机制强制。**真正的防线是 L3 的评审。**」
  —— **L3 已完成并合入，这条防线已经用掉了。** 是否兑现（L3 评审是否真的看过这个导出）
  **无法判断，因为 GATE-A 的两份门评审报告都没落盘**（见 §11.3）。
  代码今天仍是导出的、非原子的（`src/persistence/fileStore.ts:685`，
  上方 `:677-684` 有 L3 期加的长注释）。四份报告均未提。
- **`atomic-write-paths` spec §10 第 2 条**（L2 的有界重读变成冗余、故意保留为纵深防御）
  与 **L1 spec `:99` / `:169`** —— 我核过，**都不是缺陷交接**，不应进 L5 清单。列出以示已扫过。

### 12.6 一条我未能证伪也未能证实的

`decisions/2026-07-29-technical-debt-attribution.md:255` 末句逐字：
「**若后续层依赖本记录的某条结论，值得再撞一次。**」——
该裁决记录自陈是**撰写者本人自评审、未派独立评审员**，并明写这不等于独立评审。
**L5 的唯一一笔债（债 2）的归属结论就出自这份自评审的记录。**
四份报告都引用了这份记录的结论（尤其 A 引了 `:159` 的条件复议条款），
**但没有一份报告提到这份记录自己声明过「需要再撞一次」。**
是否触发这条 —— **不属我的车道，且这是人的判断，我只上报它存在。**

## 13. 铁律合规 / 高估 / 未完成项排序

### 13.1 有没有哪份报告违反了铁律（编造输出 / 过滤证据 / 自改判据 / 自改分级）—— 逐份

我的检查手段：(1) 抽样重跑各报告贴出的命令并比对输出（本报告 §1/§2/§9/§11 都是这么来的）；
(2) 全文搜削短/截断的自陈；(3) 全文搜自改判据/分级的语言。

```
$ rtk proxy grep -cn "削短\|截断\|下略\|省略" scan-A….md scan-B….md scan-C….md scan-D….md
scan-A-debt2-lock-abort.md:1    scan-B-span-and-toctou.md:4
scan-C-backoff-and-gate-carries.md:7    scan-D-offlist-sweep.md:2
$ rtk proxy grep -n "我改判\|自行改判\|我把分级\|我降级\|我升级\|重新分级" （四份）
scan-B-span-and-toctou.md:23:**⚠️ 两处需要人裁、我按铁律 5 未自行改判的地方**…
scan-B-span-and-toctou.md:190:**⚠️ 这里有一处必须交给人裁的不对称，我不自行改判：**
scan-B-span-and-toctou.md:829:按对 L5 的重要性排。**全部只上报，不自行改判。**
```

**逐份结论：**

- **scan-A —— 未违反。** 我重跑了它的关键计数（`.stop()` 生产调用点 = 2、fail-closed 抛出 = 3），
  与它一致。它把一句不可核的主张（「今天由 epoch 不等挡住」描述的是 L3 合入前的代码）
  **明写为「既无法证实也无法证伪」而不是绕过去**，这是正面样本。
  它把「未推到底」的 `recoverInterruptedOwnerTransfer:1017` **主动记为未完成**。
- **scan-B —— 未违反，且是四份里合规度最高的一份。** 三处「我不自行改判、交人裁」的显式声明；
  §5.6 找到 `fileStore.ts:469` 后**没有替 C 圆场，而是明写「复核者必须核这处在不在 C 的 9 处之内」**
  —— 我核了，不在（§2）。它还明写「我未独立验证 C 的 `resumeLoop` 结论，上述不构成背书」。
- **scan-C —— 未违反铁律，但有一处方法论失误（见 13.2）。** 它对全文唯一一处输出削短
  在原地明写（`:273`），并说明被削的三行都是「已带勘误标记」的一族 —— 我核对过，属实且不影响判断。
  它三处转录笔误当场标注并保留。**没有自改判据，没有自改分级**（GATE-C 给项 B 的分级它明写「没有改它」）。
- **scan-D —— 未违反。** 它证伪了控制器的派单前提并原样上报，没有圆场（§8）。
  它拒绝报不可重数的计数（§9.4，我判为正确）。四处未完成明写在报告开头 §0。

**四份都没有编造或凭记忆重建命令输出**（我抽样重跑的 6 条命令输出全部逐字复现）。

### 13.2 有没有哪份报告高估了自己的把握

**有两处，一重一轻。**

**（重）scan-C 项 D 的全称否定。** `:359`「`src/` 与 `tests/` 里**没有任何一处**提到「数组 push」」——
支撑只有两个它恰好读过的注释窗口，而它在**同一句括号里就承认自己的 grep 只跑了 spec 与 plan**。
一条 `grep -rn` 即可证伪（§2.2），它没跑。**这是把「我没看到」写成了「不存在」。**
它同时把腐坏站点数定为 9（实为 12 处同族、9 处无勘误，§1），最小勘误建议因此覆盖不全。
**判定：高估。** 且这处高估的形状正是本仓库反复栽的那一个 —— 用收窄的 grep 支撑绝对断言
（spec §16 第 13 行记的初稿缺陷逐字就是「「无人读 `boundary-analysis.json`」用收窄的 grep 支撑了绝对断言」）。

**（轻）scan-D 的 D12 判「无法判断」。** 缺的两步（计划阶段裁成什么 / §4.6 今天改没改）
分别在 `plan:225` 与 `spec:1012`，**各一条 grep 即可**（§10.5）。
它没有把「未推到底」写成结论 —— 它诚实地标了未完成，所以**不算违规**；
但把一条**一步可查**的事判为「无法判断」，是**低估了自己能达到的把握**。**判定：低估。**

**没有发现第三处。** 特别是：B 的「时序二不需要 ENOENT」、A 的「接触面为零」、
C 的「论据腐坏、结论不腐坏」三条，我抽查其文档侧依据均未发现夸大。

### 13.3 四份报告明写的未完成项 —— 承重排序

**不是全都重要。按「不补掉就定不了 L5 边界」排，只有前三条是承重的。**

**承重（必须补）**

1. **C 的项 E：GATE-C 的 18 条 deferred minor 里 6 条未复核 ＋ lane 1 的 3 条无落点。**
   为什么承重：这不是一条技术债，是**L5 输入清单的分母未知**。
   本轮把 L5 的输入从「6 项」扩到了一大批门上追加项，而这批项的**完整名单今天不存在**
   （台账没记、承诺的三个 ID 没兑现、lane 1 的份额已灭失，§11）。
   **在分母未知的情况下画出来的 L5 边界，下一轮必然被推翻。**
   补法：照 GATE-B `:1032` 的形状，从 `gate-c-lane2-report.md` 把 15+3 条逐条落进台账；
   lane 1 的 3 条**明写为不可恢复**，不要假装能补。

2. **A 的 `recoverInterruptedOwnerTransfer:1017` 夺锁成功后不重开锁直接 finalize。**
   为什么承重：§13 第 1 笔（锁可被偷）今天的分级是**数据丢失且可达**，
   而 A 明写这条是「第 1 笔之外的第二条入口，只做了静态阅读、未推到底」。
   **第 1 笔的可达面是不是比已记录的更宽，直接决定 L5 要不要把它排在债 2 前面。**
   （这条属代码可达性，是 lane 1 的车道；我只判它承重。）

3. **D 的「§2 vs §5.4 张力缺 `persistBoundaryAnalysis` 触发路径」。**
   为什么承重：它决定 §13 第 3 笔（span 外写）今天到底是「无调用者、仅文档」
   还是「已有一条我们没数到的触发路径」。B 独立判「今天 `src/` 内无调用者」，
   **两份报告在同一件事上一个说无法判断、一个说已核**，这个分歧必须收敛才能给第 3 笔定级。

**不承重（可以带着走）**

4. D 的 spec §4.6「零改动」未核实 —— **我已在 §10.5 补完，此项关闭。**
5. D 的 `cleanupOwnerTransferStagingWithoutMarker` 未读源码 —— 它是 §12.2 那条漏项的论据之一，
   但那条漏项的分级是「无界垃圾、不是故障」，读不读不改变边界。
6. D 的 `docs/handoff/handoff.md` 未读 —— handoff 已被本轮台账证明在两处腐坏（push 状态、worktree 状态），
   它不是权威源，读它的边际收益低。
7. B 的三处小缺口 ＋ 一处全局限制 —— 都在已定级的项内部，不改变分级。

### 13.4 我自己的未完成项（明写，不许当成已查）

1. **我没有核 C2-M5 自身的事实是否成立**（§11.4）—— 我只核了它的论证支柱是假的。
2. **我没有核 `gate-c-lane2-report.md` 里那 15+3 条 minor 的技术真伪**，
   只核了它们在台账里的落点（无）。
3. **§12.2 那条漏项我没有推到「L5 该怎么设计它」**，只推到「它存在、无主、今天成立、且残留面已扩大」。
4. **代码可达性一律未碰**（车道分工），本报告所有「今天成立/不成立」的判断都只走文档与
   `grep`/`Read` 级别的源码核对，**不构成对任何可达性结论的背书**。
5. **CLAUDE.md Rule 6**：本任务的证据量超出 12,000 token 的单任务预算。
   **明写超支，不静默。**
