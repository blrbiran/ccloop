# Re-review: pkg3-doc-errata 分支最终修复（I-1）— Scoped Re-review

## 0. 元信息

- 范围：`6a714b1..45776e1`，`docs/superpowers/specs/2026-07-28-run-registry-design.md`，`+12 -0`（自跑 `numstat` 复核，与实施者所报一致）。
- HEAD 现为 `45776e1`，`git status --porcelain` 为空，工作树干净。
- 本报告只判 I-1 这一条修复；分支内其余内容（12 条 deferred minor、其他历史提交）不在本轮范围。

## 1. 结论（最先写）

**MERGE — 可以合并。** I-1 判 **ADDRESSED**。这条新注自身的五句可核实断言逐句核实**全部为真**，无越界（`Status:` 原句一字未动，diff 纯增 12 行，只加在 `Index:` 与 `(a)` 之间），日期 `2026-08-06` 正确（且不依赖存疑的「跨午夜惯例」——本次提交 `23:01:03` 未跨午夜，日期选择是平凡的），格式与 L1b 兄弟注一脉相承（同一个「Amended <日期> — note on X above / 原句留痕不改 / 说明何处过期」骨架，三点并列时改用加粗子标签是合理适配，不是背离模板）。「provenance notes」是实施者自己的概括用词，不在原文引号内出现，不构成误导性引用，只是措辞选择，不影响注文的真实性。四条自报 concern 我逐条判过，均成立、无需要求返工的漏洞（详见 §7）。**没有发现任何需要送回修复的问题。**



## 2. I-1 裁定：ADDRESSED / NOT ADDRESSED

**ADDRESSED。**

I-1 的病灶是文首 `Status:` 句里三处失效：**日期**（「Amended 2026-07-28」不再覆盖全部条目）、**条数**（「eight places (a)–(h)」实为十二条）、**性质限定**（「every amendment is a document defect」对 (j)/(k)/(l) 不成立）。新注逐一覆盖：

- 日期 → 注文「"Amended 2026-07-28" no longer bounds this Index — (j) is dated 2026-07-30, and (k)/(l) are dated 2026-08-06」直接点名三个晚于 07-28 的日期。
- 条数 → 「the Index below now runs to (l), twelve entries, not eight」直接给出正确计数与终止字母。
- 性质限定 → 「"every amendment is a document defect... " no longer holds without exception — (j) and (k) each say explicitly... "unlike (a)–(i) this is not a document defect"; (l) shares (k)'s ruling」直接点出例外的范围（j/k 明文、l 同裁）。

三处失效，三处都有对应句子覆盖，无遗漏、无新增失效点（见 §3 逐句核验）。修法照 L1b 模板、原句不动，符合整分支评审给出的处方（「照 L1b 的模板加一条注，不改原句」）。**裁定 ADDRESSED，不需要再送一轮。**

## 3. 五句事实断言逐句核验

我自己 `Read` 了 `docs/superpowers/specs/2026-07-28-run-registry-design.md` 全部 Index 条目（(a)–(l)，第 19–49 行），未采信实施者报告或控制器转述的文本。逐句核验如下。

### 3.1 断言一：(j) is dated 2026-07-30 —— **真**

`(j)` 原文（第 38–43 行）逐字：「§8.1, §13 item 4 — **the two "Atomic? no" rows are no longer true, and unlike (a)–(i) this is not a document defect.** They were accurate against the code on 2026-07-28; the `2026-07-29-atomic-write-paths` branch (debt 4) then changed the code underneath them. **Amended 2026-07-30 by that branch.**」日期逐字为 `2026-07-30`。断言真。

### 3.2 断言二：(k)/(l) are dated 2026-08-06 —— **真**

`(k)` 原文（第 44–47 行）末句：「Amended 2026-08-06.」`(l)` 原文（第 48–49 行）末句：「Amended 2026-08-06, same ruling as (k).」两条日期均逐字为 `2026-08-06`。断言真。

### 3.3 断言三a：Index runs to (l) —— **真**

`grep -oE -- '^\- \*\*\([a-z]\)\*\*'` 实测：Index 最后一个字母条目是 `(l)`（第 48 行），其后第 50 行起转入「Layer position」等正文，无 `(m)` 或更晚字母。断言真。

### 3.4 断言三b：twelve entries —— **真，且与 3.3 相互独立地成立**

这是本次核验的关键防呆点：字母跑到 `(l)` **不自动等于** 十二条（本仓库确有「一条勘误两个落点」的先例——`(j)` 本身横跨 §8.1 与 §13 item 4 两处正文位置，但那是**一个** Index 条目引用两个落点，不是两个 Index 条目共用一个字母）。我用两条独立命令分别核：

```
$ awk '/^- \*\*\([a-z]\)\*\*/{print}' docs/superpowers/specs/2026-07-28-run-registry-design.md | wc -l
      12
$ grep -oE -- '^\- \*\*\([a-z]\)\*\*' docs/superpowers/specs/2026-07-28-run-registry-design.md | sort | uniq -c
   1 - **(a)**   1 - **(b)**   1 - **(c)**   1 - **(d)**   1 - **(e)**   1 - **(f)**
   1 - **(g)**   1 - **(h)**   1 - **(i)**   1 - **(j)**   1 - **(k)**   1 - **(l)**
```

计数为 12，且 `a` 到 `l` 十二个字母**每个恰好出现一次**作为顶层 Index 条目——无跳号、无字母复用。「runs to (l)」与「twelve entries」是两个各自独立验证为真的断言，合取仍真。断言真。

### 3.5 断言四：(j)和(k)各自条目内逐字写有 "unlike (a)–(i) this is not a document defect" —— **真，逐字比对**

`(j)` 原文：「the two "Atomic? no" rows are no longer true, and **unlike (a)–(i) this is not a document defect.**」
`(k)` 原文：「"discharge any of the three debts bequeathed to L5" is stale, and **unlike (a)–(i) this is not a document defect.**」

两处逐字比对，字符级完全一致（含大小写、连字符、句号），且都是各自条目**自身**的文字（不是引用别处）。断言真。

### 3.6 断言五：(l) shares (k)'s ruling and is the same in kind（推断，非引用）—— **成立，且比表面看起来更扎实**

`(l)` 原文末句自己写的是「Amended 2026-08-06, **same ruling as (k)**.」——这不是注文作者凭空推断，而是 `(l)` 条目**自身**已经用「same ruling as (k)」这五个字明文声明了同一裁决。注文的措辞「(l) shares (k)'s ruling and is the same in kind」是对这句原文的准确转述，且**没有**过度声称——它没有说 `(l)` 也逐字写了「unlike (a)–(i) this is not a document defect」那句话（`(l)` 确实没有重复这句话），断言四与断言五在措辞上做了正确的区分：四是「逐字引用」，五是「同裁推断」，注文没有把两者混为一谈。这个校准是准确的，有出处支撑（`(l)` 自己的「same ruling as (k)」），不是无根据的外推。

### 3.7 附带项："(i) and (j)'s own provenance notes" 措辞是否准确

`grep -n "provenance"` 全文只命中这条新注自身（第 16 行），`(i)`/`(j)` 原文都没有用「provenance」这个词——实施者自己 concern 里的坦白准确：这是他自己的概括用词，不是原文自称。是否误导：注文里这五个字**没有加引号**，不构成「声称逐字引用」，只是一个描述性标签。核对其指向内容是否准确——`(i)` 原文「Found while writing the implementation plan」、`(j)` 原文「Amended 2026-07-30 by that branch」——两句都在交代「这条是什么时候、因为什么被加进来的」，用「provenance notes」概括这类内容是合理的非引用性描述。**唯一可挑剔之处**：`(k)`/`(l)` 同样带日期与来由（「Amended 2026-08-06」「the 2026-07-29 debt-attribution ruling...」），本可以同样举例却未被引用；但注文的这句话只是为「Index below is itself... continuously-maintained」这个论点举例，不是穷举声明，选 `(i)`/`(j)` 作代表（原始八条之外最早的两条）是合理的例证选择，不构成失实。**判定：准确，不误导，是措辞选择问题不是事实问题。**

## 4. 越界检查

自跑 `git diff 6a714b1..45776e1 -- docs/superpowers/specs/2026-07-28-run-registry-design.md`（`rtk proxy` 绕过本机全局 hook 过滤），实测：单个 hunk，`@@ -4,6 +4,18 @@`，**只有 `+` 行，零 `-` 行**，插入位置在 `Status:` 段落末尾（`implementation defect. Index:` 之后）与 `- **(a)**` 列表之间。

- **`Status:` 原句是否一字未动**：自己对比 `git show 6a714b1:.../2026-07-28-run-registry-design.md | sed -n '1,5p'` 与当前文件同一段，两者**逐字节相同**（`Status: approved 2026-07-28. Amended 2026-07-28 in eight places (a)–(h) after an / adversarial review against the code; every amendment is a document defect, not an / implementation defect. Index:`）。控制器实测未动的说法复验属实。
- **Index 表体（(a)–(l) 各条目）**：diff 里没有任何一行触及 `- **(a)**` 到 `- **(l)**` 的既有内容，全部保持原样，新注插在它们**之前**。
- **§13 或正文其他位置**：`numstat` 显示改动只落在这一个文件、这一个 hunk；文件内没有第二处改动。
- **numstat**：自跑 `git diff --numstat 6a714b1..45776e1` → `12  0  docs/superpowers/specs/2026-07-28-run-registry-design.md`，与实施者所报、与控制器 review-package 所记完全一致。

**裁定：无越界。** 纯增量注释，原句、Index 表体、正文均未被触碰。

## 5. 日期判定（2026-08-06 是否正确）

**正确，且这次判断不需要依赖那条存疑的「跨午夜惯例」。**

自跑 `git log -1 --format='%H %cI %s' 45776e1`：

```
45776e177ba637a066e4f7b130655b355168ca31 2026-08-06T23:01:03+08:00 docs(errata): 整分支评审修复...
```

提交时刻 `2026-08-06 23:01:03 +0800`——**未跨午夜**（距 `2026-08-07 00:00` 尚有近一小时，不存在「会话跨过零点、该标哪一天」的歧义）。把这次提交与紧邻的前几次提交对比（`d5b3e79` 01:17:57、`ce934c4` 00:55:19、`26b0709` 00:39:43，均在 `2026-08-06` 当天凌晨），也确认整个「整分支评审修复」这次会话本身没有跨夜。

**这层逻辑要判清楚**：整分支评审用四个反例（`cad6236`/`1564cba`/`1b54190`/`519ae55`）确立的「跨午夜落注一律标上一日」惯例，是用来裁决**「会话跨过零点时，注的日期该标哪一天」**这个问题的。本次提交根本没有跨午夜的情形要裁决——直接用提交当天的日历日 `2026-08-06`，这是**平凡情形**，不落在那条惯例要解决的问题域里。换句话说，**即便那条「跨午夜零例外」的惯例本身站不住（样本不足以支撑「零例外」），也丝毫不影响这次日期选择的正确性**，因为这次的日期选择根本用不上那条惯例——它是靠「提交时刻所在的日历日」这个更基本、无争议的规则决定的。日期判定：**成立**。

## 6. 格式一致性（与兄弟文档 L1b 注的对齐）

自读 `docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`（L1b）中 `6a714b1` 加的注（逐字）：

> `> **Amended 2026-08-06 — note on the count above**: the paragraph above describes only the original whole-branch-review batch and is left as-is. A sixth amendment, **Amended 2026-08-06 (f)**, now also exists in §5.3 (alongside (e)); it is not part of the "five... found by the final whole-branch review" — it corrects a later, separately-discovered defect...; only the count and the "all found by" qualifier are stale.`

L2 这条新注的骨架：`**Amended 2026-08-06 — note on the Status line above**: three things in it are stale; the line above is left as-is. **Date**: ... **Count**: ... **Qualifier**: ... this note exists only so the summary line above it is not read as still accurate.`

**共同骨架（一脉相承）**：① 都以粗体 `**Amended <日期> — note on <目标> above**:` 开头；② 都明写原句「left as-is」/ 未重写；③ 都逐点指出「哪句话的哪个部分」过期，给出为什么过期的证据（字母、日期、来源）；④ 都以「这条注存在的目的只是防止上面那句话被读成仍然准确」收尾（L1b：「only the count and the "all found by" qualifier are stale」；L2：「this note exists only so the summary line above it is not read as still accurate」）。

**差异点，判断是否合理适配**：L1b 用连续散文单段覆盖一件事（计数+限定语），L2 用 `**Date**:` `**Count**:` `**Qualifier**:` 三个加粗子标签分述三件事。这是因为 L2 原句里失效的断言有三处（L1b 只有两处且合并成一句话讲得清），三点并列时改用子标签是合理的可读性适配，不是脱离模板——核心骨架（粗体开头、留痕不改、逐点证据、收尾定位注的作用）完全保留。另外 L1b 的段落在 blockquote（`>`）内，因为 L1b 原本的 `Status:`/`Amendments:` 段本身就是 blockquote 格式；L2 原本的 `Status:` 段是纯段落（无 `>`），新注同样用纯段落，是匹配各自文档局部既有格式，不是不一致。

**裁定：格式与 L1b 一脉相承，差异均为对局部约束的合理适配，不构成偏离。**

## 7. 实施者四条 concern 的独立判断

### 7.1 concern 1：provenance notes 措辞 —— **坦白准确，判断成立**

已在 §3.7 独立核验：「provenance」一词全文只在这条新注自身出现，`(i)`/`(j)` 原文都没有用这个词。实施者的自评「是我自己的概括用词，不是原文自称」经我独立核对为真，且这个概括本身准确、不误导（未加引号、不构成伪引用、指向的两句原文内容属实）。**结论：坦白准确，无需改动注文。**

### 7.2 concern 2：跨午夜惯例样本量是否足够 —— **坦白本身够格；但更关键的是这次根本用不上这条惯例**

实施者的坦白：只验证了控制器给的四个样本，未独立穷举反例，若存在「跨午夜但标新日期」的反反例，「零例外」结论会被削弱。这个坦白**如实**（他确实没有重新跑 `-S` 去独立搜索，只验证了给定四个 commit 的存在性与内容）。是否需要更强证据才能支撑**这次**的日期选择——**不需要**，理由见 §5：本次提交 `23:01:03` 未跨午夜，日期选择不经过那条惯例、直接取提交当天日历日即可决定。这正是提示词点出的那层逻辑：**如果这次提交根本没跨午夜，惯例是否成立不影响结果**——我独立核验这层逻辑成立（§5 已给出证据）。所以「坦白是否足够」这个问题本身在本次不产生风险：即使惯例站不住，也不会把 `2026-08-06` 变成错的。**结论：坦白诚实且无害，不构成需要返工的漏洞。**（若后续某次提交真的跨了午夜，则这条惯例的证据强度才会成为决定性因素，但那是另一个未来的判断，不在本轮范围。）

### 7.3 concern 3：范围界定（L1 同形文件未动）—— **界定正确，应作为一条 deferred 记录**

实施者用 `git diff --stat 4f3b790 HEAD -- <L1 spec> <L1 plan>` 确认空输出，本分支从未触碰这两个同形文件，按控制器给出的范围原话（「本分支实际改过这份文件」是条件之一）判定不在本轮内，这个界定与整分支评审、控制器的分诊口径一致——**本轮范围本就是「I-1 这一处」，不是「全仓同形扫描」**。实施者明写「未验证它们自身是否过期」，没有含糊留白，符合「Fail loud」的要求。

**是否要记一条 deferred**：应该记。这两个文件（`docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md`、`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`）与 L1b/L2 同形（都带「Amendments: N / in N places / every amendment is...」这类可变账本头），如果它们的头部也有类似的日期/条数/性质限定过期问题，那是一个独立于本分支的、可能更早就存在的缺陷，值得留给下一轮或另开一个任务去核实。**处置建议：作为台账里的一条新 deferred minor（范围：L1 spec/plan 头部账本是否过期，未验证），不阻塞本次合并。**

### 7.4 concern 4：因果认领的回溯重构诚实度 —— **诚实且记录完整，达标**

因果认领一节自陈是回溯重构、无法保证是当时思维的精确复现，只能保证结论在逻辑上说得通、与证据对得上。我读了这段认领（task-3-report.md 第 930–954 行）：它给出了具体的、可检验的推理链（「(j) 重复用字母」这个假前提 → 类比到「Status 段头部大概也是既有噪音」→ 没有反向追问「Index 若被严谨维护，头部越该同步」→ 完备性自查漏检 `Status:` 断言本身），每一步都有对应的可查证据（上一轮报告的原话、这一轮的 grep 结果），不是空洞的自我批评。这类回溯认领**不可能**做到「精确复现当时思维」这个更高标准（没有人能在事后精确复现自己当时的思维），实施者对此的坦白本身就是诚实的边界声明，没有假装比实际更精确。**结论：诚实、记录完整，不需要更高标准。**

## 8. 范围外观察（不进入本轮修复环）

以下观察超出本轮 `1 file / +12 -0` 的范围，**不会送回任何修复环**，仅记录供后续任务参考：

1. **L1 的两份同形文件是否过期未知**（呼应 §7.3）：`docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md`、`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md` 头部是否也有「Amendments: N / in N places / every amendment is...」形态的过期账本，未经任何一轮验证。建议后续开一个独立、小范围的核实任务。
2. **「跨午夜落注标哪一天」这条惯例尚未成文**：整分支评审的 m-2 已经指出这是一条规约债（未写进 `CLAUDE.md` 或 handoff 房规），本轮的日期判断能绕开它是因为这次恰好没跨午夜，但下一次跨午夜的场景仍然会重演这个歧义。不阻塞本次合并，留给 m-2 的既有处置建议（写进房规）。
3. **注文子标签风格（`**Date**:` `**Count**:` `**Qualifier**:`）目前只在 L2 出现一次**，尚未成为跨文档惯例；如果未来还有第三处类似三点式过期需要补注，可以考虑把这个子标签风格写成惯例，但现在样本量为一，不足以定规约，仅记录观察。

## 9. 附：可重放的核验命令与输出

```
$ rtk proxy "git log -1 --format='%H %cI %s' 45776e1"
45776e177ba637a066e4f7b130655b355168ca31 2026-08-06T23:01:03+08:00 docs(errata): 整分支评审修复 —— L2 文首 Status 段补注（日期/条数/性质限定三处过期）

$ rtk proxy "git diff --numstat 6a714b1..45776e1"
12  0  docs/superpowers/specs/2026-07-28-run-registry-design.md

$ rtk proxy "git diff 6a714b1..45776e1 -- docs/superpowers/specs/2026-07-28-run-registry-design.md"
（单个 hunk @@ -4,6 +4,18 @@，只有 12 行 + ，0 行 -，插入位置在 Status 段之后、(a) 列表之前——见正文第 4 节引用的完整 hunk）

$ git show 6a714b1:docs/superpowers/specs/2026-07-28-run-registry-design.md | sed -n '1,5p'
$ sed -n '1,5p' docs/superpowers/specs/2026-07-28-run-registry-design.md
（两次输出逐字节相同，Status 段未改）

$ grep -n -- '\*\*(j)\*\*' -A 6 docs/superpowers/specs/2026-07-28-run-registry-design.md
$ grep -n -- '\*\*(k)\*\*' -A 3 docs/superpowers/specs/2026-07-28-run-registry-design.md
$ grep -n -- '\*\*(l)\*\*' -A 1 docs/superpowers/specs/2026-07-28-run-registry-design.md
（(j) Amended 2026-07-30 by that branch；(k)/(l) 均 Amended 2026-08-06；(j)/(k) 均含 "unlike (a)–(i) this is not a document defect"；(l) 含 "same ruling as (k)"）

$ awk '/^- \*\*\([a-z]\)\*\*/{print}' docs/superpowers/specs/2026-07-28-run-registry-design.md | wc -l
      12

$ grep -oE -- '^\- \*\*\([a-z]\)\*\*' docs/superpowers/specs/2026-07-28-run-registry-design.md | sort | uniq -c
   1 - **(a)**   1 - **(b)**   1 - **(c)**   1 - **(d)**   1 - **(e)**   1 - **(f)**
   1 - **(g)**   1 - **(h)**   1 - **(i)**   1 - **(j)**   1 - **(k)**   1 - **(l)**

$ grep -n "provenance" docs/superpowers/specs/2026-07-28-run-registry-design.md
16:(j)'s own provenance notes); this note exists only so the summary line above
（"provenance" 全文只在新注自身出现一次，(i)/(j) 原文都没有这个词）

$ rtk proxy "git status --porcelain"
（空输出——工作树干净）
```
