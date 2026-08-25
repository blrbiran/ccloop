# ccloop Handoff — **点 B 已通过、C-1 已关闭、两轮 Minor 与一轮独立评审全部收尾；三件挂账等人开口**

> ⚠️ **一律自查，别信本文。** **只有两个门锚点 `e42e062`（GATE-PKG3）与 `86d3bd6`（GATE-PKG2）是已固定的历史值，可放心引用。**
> *** **本文一个当前哈希都不写** —— 提交本文这个动作本身就会改 HEAD 与笔数，**远端也会被人自己推动**。 ***
> 需要指代某一笔时**引提交主题行**（`git log --grep` 找得回），需要指代材料时**引路径**。

---

## 先跑这些，以输出为准

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --merges --format='%h %cd %s'   # 末两笔应仍是 GATE-PKG2（86d3bd6）、其下 GATE-PKG3（e42e062）
git ls-remote origin refs/heads/main    # ⚠️ 开工核一次、收尾【必须】再核一次 —— 人会自己推远端
git status --short; git worktree list; git branch -vv
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run             # 期望 35 files / 604 tests，零 skipped
rtk proxy npm run typecheck; rtk proxy npm run build
```

⚠️ **验证性命令一律走 `rtk proxy`**；**判断远端只能 `git ls-remote`** —— `git status` 的 `ahead N` 是缓存 ref。
⚠️ *** **上一会话就栽在收尾没重跑 `ls-remote` 上**：报告「一笔未 push」时，远端其实已经被人推进了四笔。 ***
⚠️ *** **rtk 的过滤层会骗你**：`git status --porcelain` 空时打印 `ok`，`git diff | wc -c` 把 0 字节报成 1 字节，
长 grep 截断成「[+N more]」，含括号的正则直接报错。
**任何还原证明／字节比较／整份读回一律 `rtk proxy … > 文件` 再 `cat`／`wc -c`；读大文件用 `sed -n 'a,bp'`，不要用 grep。** ***

### 上一会话（2026-08-25 第二段）实测基线，未过滤整份读回、`RUN` 路径已核

- *** **`35 files / 604 tests`** *** 全绿**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0`
- *** **判据基线是 604，测试文件 35 个** *** —— 603／602／601／600 全部作废
- *** **红线函数 `tryRecoverStaleOwnerTransferLock` = 3185 字节**，签名命中数 =1，返回类型 `Promise<boolean>` ***
  970／1558／2515 三个旧基线早已作废；上一会话**逐字节没动它**
- *** **最宽注释行的口径：全文件、首个非空白为 `//` 的行、按【字符】计。** *** 现基线：
  `fileStore.ts` **101**／`fileStore.test.ts` **103**／`sweepRuns.test.ts` **99**／`inspectLock.ts` **100**／`unlockCommand.ts` **101**／`inspectLock.test.ts` **101**
  ⚠️ *** **别用 `awk length()` 量字符** —— macOS 的 awk 按字节算，`LC_ALL` 对它无效。用 python `len()`。 ***
- ⚠️ *** **这份基线在负载下会 flake。** *** 已知 **4 条**，其中**两条不在人裁 10 的名单里**：
  - 人裁 10 名单内：`records env names only …`、`persists phase usage evidence…`
  - *** **名单外（§35 实测）**：`runLoop > accounts an execute timeout that rejects after the abort as exhaustion`、
    `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data` ***
  - 都是 `Test timed out in 5000ms`；红的那轮总耗时 **~29s**，绿的几轮 **17–22s**
  ⇒ **看到红先看：是不是这四条之一 ＋ 是不是超时 ＋ 总耗时是否异常，再单独重跑那个文件，别急着报回归。**
  ⇒ **派评审时，brief 的「已知 flake」清单必须写满 4 条。**
- ⚠️ **整套在 Linux 上【不绿】**（`5 failed / 593 passed`，第六位评审在别的轮次实测）；**点 B 相关的任何一格都没在 Linux 上跑过**

---

## 唯一可信进度源（**引路径，不要重新推导**）

`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` —— **人裁 10–105 全在里面**。
*** **上一会话新增 §36／§37／§38。§38 末尾「⛔ 下一件事」是下一会话的第一件事，逐字照做。** ***
⚠️ *** **`.superpowers/sdd/.gitignore` 内容是 `*`** *** —— 该目录下**新产物必须 `git add -f`**。

| 材料 | 路径 |
|---|---|
| **第三轮（Minor 轮）独立评审报告：0 Critical／5 Important／6 Minor** | `…/pointB-minors-review.md` |
| 该轮 brief（**下次派评审抄这份**，⚠️ **末尾有具名 ERRATUM，说明它误导过评审员**） | `…/pointB-minors-review-brief.md` |
| 第二轮（收尾轮）评审报告 ＋ brief | `…/pointB-cleanup-review.md`、`…/pointB-cleanup-review-brief.md` |
| 第一轮（点 B 本体）评审报告 ＋ brief | `…/pointB-review.md`、`…/pointB-review-brief.md` |
| B 的裁决包 v2／v1（**v1 已过期，保留不改**） | `…/pointB-ruling-package-v2.md`、`…/pointB-ruling-package.md` |
| 点 C 裁决 ＋ presence-only 实测 | `…/pointC-design.md` |
| E1 的六份评审 ＋ briefs | `…/E1-review-*.md` |

---

## 人裁 101–105（**人亲自拍的，控制器一件都没替人宣布**）

| | 裁决 |
|---|---|
| **人裁 101** | *** **点 B 通过。** *** |
| **人裁 102** | *** **C-1 记关闭**（按人裁 92 自己写下的条件）。 *** |
| **人裁 103** | *** **E1 仍不拍**（I-2 那一格未裁未修）。 *** |
| **人裁 104** | 修 8 条 Minor，然后记台账收工。 |
| **人裁 105** | 修复查出来的问题 ＋ 派独立评审；评审回来后追认**全修**。**并确认远端是人自己推的。** |

---

## 上一会话做完了什么（**都不要重做**，细节在台账 §36／§37／§38）

按提交主题行找（*** **别数笔数** ***）：

1. `docs(comments): correct the two fileStore.ts claims measurement and ruling 102 overtook (M-2, M-4, human ruling 104)`
2. `test(fileStore): give test A the positive observation it lacked, and close three comment Minors (…, human ruling 104)`
3. `docs(comments): put M-1's correction where a misled reader lands, not only in the ledger (human ruling 104)`
4. `docs(comments): close every site the Minors round left standing (I-1, I-2, I-4, I-5, Mi-1, Mi-2, human ruling 105)`
5. `test(fileStore): enforce the "one reader" premise the counting test rests on (Mi-3, human ruling 105)` —— **判据 603 → 604，新增第 35 个测试文件**
6. `docs(sdd): record section 36 / 37 / 38 …` ＋ 两笔 `docs(handoff): …`

**8 条 Minor 全部收尾**（M-3 早在人裁 100 闭合）；**第三轮评审的 5 条 Important ＋ 6 条 Minor 全部处置完毕**。

⚠️ *** **远端已被人推进过一次。开工时用 `git ls-remote` 现跑，自己看哪些笔已经发布** *** —— 已发布的文本**只能追加 ERRATUM**。

---

## ⛔ 下一件事 —— **无人裁待决；三件挂账，都要人先开口**

### 1. I-3 —— 失败关闭之后，操作员看不见被永久卡住的锁
⚠️ **评审员说的"最小修法"并不小**：要区分「持有者还活着」和「锁不可归属」，
得让 `tryRecoverStaleOwnerTransferLock` 把**为什么返回 false** 告诉调用方，而它现在是 `Promise<boolean>`
⇒ *** **那是再动一次红线函数并改它的返回类型。** *** 控制器建议**并入人裁 85 那一轮**（`ls` 也报锁）：**两者是同一个病**。
*** **有实质设计成分，建议单开一个满上下文新会话，用 `superpowers:brainstorming` 起手。预估 $40–80。** ***

### 2. E1 的 I-2 那一格（**未裁**）
数组 holder ＋ 死 pid ⇒ `inspectLock` 答 `dead` 而非 `unrecognized-holder`，于是 `unlockCommand` **无 `--force` 直接删锁**。
**已在红线函数的注释里记录为实测，代码一行未改**（**E1 在授权面外，动它要新授权**）。**人裁 103 不拍 E1 的理由就是这一格。**

### 3. Linux 从没跑过点 B（**唯一的真覆盖缺口**）
本机 **OrbStack 的 docker CLI 在 `/usr/local/bin/docker`，但 daemon 没起** ⇒ **要人自己开**（`! open -a OrbStack`）。
整套在 Linux 上本来就红 5 条，是**先于点 B 存在的包级缺口**；**人裁 101 没把它绑成点 B 的门。** 预估 $5–15。

### 4. ⚠️ 上一轮那两笔【自身又没经过独立评审】
人裁 100 的递归收口理由适用（连续 0 Critical 时继续递归只买字面完美），**但要不要再破一次例是人的事，未裁**。

---

## 一条已查实、已更正的**控制器自己的错**（**别再犯**）

*** **台账 §36 指控 §33／§34 的「最宽注释行」口径不可复现 —— 那条指控是假的。** ***
真相：控制器用 `LC_ALL=en_US.UTF-8 awk 'length($0)'` 量「字符」，而 **macOS 的 awk 按字节计，`LC_ALL` 对它无效**。
用真字符实现重量，§33／§34 的**五个数全中**（101／103／100／101／101），它们用的一直是最显然的口径。

- §36 立的那个「新口径」**从来就不需要**，而且本轮自己也没遵守（全部数字是字节数贴了字符标签）。
- 该指控已随台账与 handoff **推到远端**。按铁律 4，§33／§34／§36 原文一字不改，更正在 §38。
- ⚠️ *** **更糟的一层：这个错经由 brief 变成了评审员的前提** *** —— brief 里写着「别跟 §33／§34 比」，
  评审员的 I-3 只抓到标签错、没抓到根因。**brief 已追加具名 ERRATUM。**
- ⇒ *** **规矩：一个探针在被验证之前，它的输出不是证据。** *** 这是本包第二次栽在坏探针上
  （第一次是把 macOS 上不存在的 `timeout` 命令返回的 127 读成「本机无容器运行时」，见 §25.20）。

---

## 铁律与边界（**违反即事故**）

1. **四件需人单独授权**：开门／合并／删分支或 worktree／**push**。*** **控制器不许 push。** *** 非门合并一律 `--ff-only`。
2. **不许实施者自改判据。** 人裁 4 许可的是**补测试**；**改既有判据**必须由人**指名到具体测试**（人裁 88 三条件：(a) 指名 (b) 整条改写不许放宽 (c) 改后写明编码的是哪条人裁）。
   ⇒ **需要新覆盖时，先想"能不能只加不改"** —— 人裁 99、104 的 M-5、105 的 Mi-3 都是这么绕开裁决的：**新开一条测试（甚至新开一个文件），不往既有测试里塞断言**。
3. **不许替人宣布。** 101–105 全是人亲自拍的。
4. **`.superpowers/sdd/**` 里的历史记录一个字不改**；发现写错了，**在新一节里记更正**（§37 更正 §36 的处置，§38 更正 §36 的指控，都是这么做的）。
   `docs/handoff/**` 是活文档，可整篇重写，但**不得把已知为假的说法带下去**。
5. **注释铁律（人裁 98／100／104／105 的先例）**：
   - **就地改**只适用于**本会话自己刚写、且从未为真**的笔误；
   - **已发布（`git ls-remote` 说了算）、或上一会话写的** ⇒ **原文逐字保留 ＋ 追加具名 `*** ERRATUM (…, HUMAN RULING N) … ***`**。
   - *** **erratum 里不许写新的、会被后续裁决推翻的计数**（人裁 105 的 Mi-6）——指向台账即可。 ***
   - *** **erratum 不许引用会移动的 git 引用**（「remote tip」「HEAD」）—— 它会和字节基线一样烂掉。 ***
6. **变异只在 `git clone --local` 副本里**，主仓库工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**，
   `diff -r` **不是**还原证明（它看不见 index）。
   ⚠️ **副本是 clone committed state** —— 要测**未提交**的改动，得 `cat 工作树文件 > 副本对应文件` 再变异。
7. **绝不过滤验证性跑**（`grep`/`tail`/`head`/`sed` 都算，管道还会吞退出码）：重定向到文件、整份读回、核 vitest 第一行 `RUN` 指向的路径。
8. *** **成本只报工具给出的数，拿不到就说拿不到，不许自估。** *** （上一会话自估 $6，实际 ~$57。）

---

## 踩过的坑（**别再踩**）

1. *** **本机 `rm` 和 `cp` 都有 `-i` alias。** *** 普通 `rm -rf` 会**静默挂在确认提示上直到超时**；`cp` 会**静默拒绝覆盖**。
   ⇒ **一律用 `/bin/rm -rf` 和 `cat pristine > target`。**
2. *** **`str.replace` 的子串匹配会在句子中间切开段落。** *** ⇒ **改注释要按【行号 ＋ 整行锚点】插入，插之前先断言那一行逐字相符**
   （上一会话靠这个当场抓到差一行的锚点，脚本直接退出、文件一字未动）。改完必须重量最宽注释行。
3. **注释轮必须做全树扫描再动手，而且【扫描清单要从被更正的句子机械导出】。**
   实测教训：第一轮改 12 漏 6；第二轮补 6 又漏 2；第三轮为 `open(lockPath,"wx")` 扫了树却**没为「C-1 未关闭」那句扫**，
   于是同一句话三处只改一处 —— **而且漏掉的两处就在当轮编辑过的文件里，其中一处距新加的 erratum 只有 26 行。****半改比不改坏。**
4. *** **修一个 erratum 会制造下一个 erratum。** *** 插入 M-7 的更正把隔壁段落的先行词推远了一块（人裁 105 的 Mi-1）
   ⇒ **erratum 优先放在整个注释块的末尾**，或者在 erratum 里把被打断的先行词重述一遍。
5. **评审员的自陈要核，控制器自己的数字更要核** —— M-1 那三个数最后证明**三方都对**，错的是没人写下自己在量什么。
   ⇒ **报任何数字，连同口径一起报。**
6. *** **探针没被验证之前，它的输出不是证据。** *** 本包栽过两次：`timeout` 不存在被读成「无容器运行时」；`awk length()` 数字节被当成数字符，
   进而**对前人工作发出了一条假指控并推上远端**。
7. *** **"绿"本身可能是空的。** *** 实测两次：把红线函数改成永不被调用，旧判据照绿（M-5）；给锁加第二个读者，计数判据照绿（Mi-3）。
   ⇒ **钉"什么都没发生"的判据必须配一条正向观测；正向观测所依赖的前提也必须被强制执行**，否则只是把空转推后一层。
8. *** **「为修复派评审」会无限递归** *** —— 每轮修复都在制造新的未评审面。人裁 100 的收口理由：连续两轮 0 Critical
   且 Important 全是文字准确性时，继续递归买不到安全，只买字面完美。**下次要收口，援引人裁 100。**
   ⚠️ **但人主动指名要审时，人裁 100 不适用**（人裁 105 就是这样）。

---

## Suggested skills

| skill | 什么时候用 |
|---|---|
| `superpowers:verification-before-completion` | *** **每次要说"做完了／通过了／绿了"之前。** *** 本项目 Rule 12 与它同形 |
| `superpowers:systematic-debugging` | 出现测试红／行为不符时**先用它**，别直接改代码 |
| `superpowers:test-driven-development` | 补任何新判据时。⚠️ **本仓库的"先红"是变异证明**（钉现状行为的判据天然先绿），人裁 99／104／105 都是这么做的 |
| `superpowers:requesting-code-review` | 派评审时；模板用 `…/pointB-minors-review-brief.md`，**每个数字按现测更新，已知 flake 写满 4 条，并读它末尾那条 ERRATUM —— brief 写错会直接变成评审员的前提** |
| `superpowers:receiving-code-review` | *** 拿到报告之后。 *** ⚠️ **本项目额外要求：评审员的承重主张必须自己复核**，不许照单全收，也不许照抄它的数字 |
| `superpowers:brainstorming` | 只在 I-3（人裁 85 那轮）真要动设计时 —— 那件值得一个满上下文的开局 |

⚠️ **skill 与本仓库 CLAUDE.md 冲突时，CLAUDE.md 优先**（Rule 11：conformance > taste）。

---

## 预算

上一会话**约 $57 以上**（含一名独立评审员 **168k tokens**），**远超 CLAUDE.md Rule 6 的每会话 400k**。
⚠️ **大动作（再派评审、动 I-3、跑 Linux）之前先跟人报一次预估**，且**只报工具给出的数**。
