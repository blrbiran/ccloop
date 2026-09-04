# ccloop Handoff — **P0 已做完（2026-09-04，Orca 那条线执行）；下一件事回到 E1 的 I-2 ＋ 人裁 85，人裁 121 仍有效；I-3(a) 已收口（人裁 125）**

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
rtk proxy npm test -- --run             # 期望 35 files / 624 tests，零 skipped（P0 之后的新基线）
rtk proxy npm run typecheck; rtk proxy npm run build
```

⚠️ **验证性命令一律走 `rtk proxy`**；**判断远端只能 `git ls-remote`** —— `git status` 的 `ahead N` 是缓存 ref。
⚠️ *** **`ls-remote` 的结果只在它跑出来的那一秒为真** —— 开工一次、收尾一次，中间做过判断就再来一次。 ***
⚠️ *** **rtk 的过滤层会骗你**：`git status --porcelain` 空时打印 `ok`，`git diff | wc -c` 把 0 字节报成 1 字节，
长 grep 截断成「[+N more]」，含括号的正则直接报错。
**任何还原证明／字节比较／整份读回一律 `rtk proxy … > 文件` 再 `cat`／`wc -c`；读大文件用 `sed -n 'a,bp'` 或 python，不要用 grep。** ***

### 2026-08-28 那一次会话的实测基线 —— 未过滤整份读回，`RUN` 路径已核

⚠️ *** **它已经不是「最近一次」了** *** —— P0 那一轮（2026-09-04）之后的现行基线见下一条与文末「📌 Orca 那条线」。
本段其余内容（四条已知 flake、红线函数字节数口径、Linux 上不绿）**原样有效**。

- *** **`35 files / 614 tests`** *** 全绿**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0`，耗时 17.58s
  （**收尾时在最终树上重跑过一次**，不是引用会话中段的数）
- *** **判据基线现在是 624（P0 那一轮 +10，2026-09-04 现测）。614 及此前的 613／609／604／603／602／601／600 全部作废。** ***
  ⚠️ **本行原文是「判据基线是 614」，由 P0 那一轮就地更正** —— 活文档不得把已知为假的说法带下去（铁律 4）。
  614 仍然是**那一次会话（2026-08-28）的实测值**，下面这一段整段保留不动。
- *** **红线函数 `tryRecoverStaleOwnerTransferLock` 在 I-3(a) 轮与修复轮都一个字未动**：第 1017–1095 行、**4769 字节**，
  口径 ＝ `src/persistence/fileStore.ts` 的【整行范围、含末尾换行】（`sed -n 'a,bp' … | wc -c`）***
  ⚠️ **行号会移动 ⇒ 引用前必须现测**（先找签名行，再大括号配对找收尾行）。**3185／4496 两个旧基线均已作废。**
  （两位独立评审员用同一口径各自复测过，并对**本轮开工点与收尾点**做了 sha256 比对 —— 逐字节相同。）
  ⚠️ *** **报任何字节数必须连口径一起报。** ***
- ⚠️ *** **这份基线在负载下会 flake。** *** 已知 **4 条**，其中**两条不在人裁 10 的名单里**：
  - 名单内：`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`、
    `runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`
  - *** **名单外**：`runLoop > accounts an execute timeout that rejects after the abort as exhaustion`、
    `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data` ***
  - 都是 `Test timed out in 5000ms`；红的那轮总耗时 **~25–29s**，绿的几轮 **17–22s**
  ⇒ **看到红先看：是不是这四条之一 ＋ 是不是超时 ＋ 总耗时是否异常，再单独重跑那个文件，别急着报回归。**
  ⇒ **派评审时，brief 的「已知 flake」清单必须写满 4 条。**
- ⚠️ **整套在 Linux 上【不绿】**（`5 failed / 593 passed`，第六位评审在别的轮次实测）；**本包近几轮没有任何一格在 Linux 上跑过**
  （实测 OrbStack daemon 未起：socket 不存在）

---

## 唯一可信进度源（**引路径，不要重新推导**）

`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` —— **人裁 10–126 全在里面**。
*** **最近一次会话新增 §43／§44／§45。§45 末尾「⛔ 下一件事」是下一会话的第一件事，逐字照做。** ***
（§42 是 I-3(a) 那一轮本身；§43 是它的评审 ＋ 修复；§44 是复审；**§45 是收口与总账**。
四节都要读，冲突以 §45 为准。）
⚠️ **§43 末尾那句「全部只在本地」现在是假的** —— 人随后把整包推上了远端，更正记在 §44。
⚠️ *** **`.superpowers/sdd/.gitignore` 内容是 `*`** *** —— 该目录下**新产物必须 `git add -f`**。

| 材料 | 路径 |
|---|---|
| **I-3(a) 设计（spec）** | `docs/superpowers/specs/2026-08-27-i3a-swallowed-unattributable-design.md` ⚠️ **§7 是落地更正，读上文以它为准** |
| **I-3(a) 实施计划** | `docs/superpowers/plans/2026-08-27-i3a-swallowed-unattributable.md` ⚠️ **末尾有【两节】更正：「执行后更正」＋「第二次更正」，后者是评审之后的** |
| **I-3(a) 独立评审报告 ＋ brief** | `.superpowers/sdd/2026-08-07-pkg2-data-loss/i3a-review.md`、`…/i3a-review-brief.md` |
| **修复轮的复审报告 ＋ brief（下次派评审抄这份 brief，它最新）** | `…/i3a-rereview.md`、`…/i3a-rereview-brief.md` |
| I-3(b) 设计／计划（上一轮） | `…/specs/2026-08-26-i3-unattributable-lock-design.md`、`…/plans/2026-08-26-i3-unattributable-lock.md` |
| I-3(b) 独立评审报告 ＋ brief（**已过时，别拿它当模板**；⚠️ 它自己的消费点普查有错，见台账 §41） | `…/i3b-review.md`、`…/i3b-review-brief.md` |
| 更早几轮的评审 ＋ brief ＋ 裁决包 | `…/pointB-*.md`、`…/pointC-design.md`、`…/E1-review-*.md` |

---

## 人裁 109–126（**人亲自拍的，控制器一件都没替人宣布**）

| | 裁决 |
|---|---|
| **109／110** | 同一轮开 I-3(a) ＋ `leaseHeartbeat` 两处吞；**援引人裁 100 对人裁 108 那一笔收口**（不再派评审）。 |
| **111** | `readOwnerRecord` 碰上不可归属的锁 ⇒ **收窄 `catch`，让它抛**（fail closed）。 |
| **112／113** | 心跳 `runAffirm` 与 `stop()` **各记一次事件，行为一字不改**。 |
| **114** | `runLoop` 走方案 B：**外层 catch 一处路由**，两个调用点一行不改。 |
| **115** | **指名改写四条既有判据**（全在 `tests/persistence/fileStore.test.ts`，名字见台账 §42）。 |
| **116／117** | 本会话逐任务执行；连着做到 Task 4。 |
| **118** | M8 那行 `writeOwnedRunState`「**留着，但注释里写明没被钉住**」。 |
| **119** | **心跳用自己的事件类型** `owner_transfer_lock_unattributable`（复用共享类型被实测打红两条既有/新判据）。 |
| **120** | I-3(a) 那四笔**派独立评审**（人裁 110 只覆盖人裁 108 那一笔，不覆盖它们）。 |
| **121** | 挂账里**先动 E1 的 I-2 ＋ 人裁 85**；Linux 继续挂。 |
| **122** | **修完派复审**（首审有 1 Critical，人裁 100 前提不成立）。 |
| **123** | C-1 **只补一条判据**，不做人裁 118 式披露注释。 |
| **124** | I-1 整条改写；I-2／I-3 向 N1 各加一条断言；K-1 追加具名 ERRATUM —— **四条全授权**。 |
| **125** | *** **I-3(a) 收口** *** —— 人主动开例，**不是人裁 100 的适用**（首审有 1 Critical）。**引用时引 125 本身。** |
| **126** | 会话到此为止；E1 与人裁 85 的设计**另开会话**（人裁 121 仍然有效）。 |

---

## 最近两轮做完了什么（**都不要重做**，细节在台账 §42／§43）

按提交主题行找（*** **别数笔数** ***）：

1. `docs(spec): design I-3(a) and the two leaseHeartbeat swallows as one round …`（＋一笔自审更正）
2. `docs(plan): task-by-task implementation of I-3(a) …`
3. `fix(fileStore): stop a lock that can never clear from being swallowed as if it would …`
4. `fix(resumeLoop): stop calling a blocked recovery an unreadable artifact …`
5. `fix(runLoop): route a blocked transfer recovery to abandonment, not to a failed attempt …`
6. `fix(leaseHeartbeat): stop retrying a lock that can never clear in silence …`
7. `docs(sdd): record section 42 …`（含台账 §42 ＋ 本文）

**评审 ＋ 修复轮（§43）再加三笔，生产代码一行未改**：

8. `test(fileStore): restore the weight the ruling-111 rewrite took out of one assertion …`
9. `test(runLoop): pin the outcome and the path this criterion only implied …`（含 K-1 的 ERRATUM）
10. `test(leaseHeartbeat): pin the release-path record that nothing was pinning …`

**复审 ＋ 收口（§44／§45）再加四笔文档，判据与生产代码都没再动**（按时间序）：

11. `docs(sdd): record section 43 …`（评审 ＋ 修复的台账）
12. `docs(handoff): stop saying the round is unpushed …`（远端在会话中途被推动，活文档纠错）
13. `docs(sdd): record section 44 …`（复审；**并记下整包已被推到远端这件事**）
14. `docs(sdd): record section 45 …`（人裁 125／126 ＋ 会话总账）

**做出来的东西**：三处吞掉 `OwnerTransferLockUnattributableError` 的地方全部处置 ——
`recoverInterruptedOwnerTransfer` 的裸 `catch` 收窄（Busy 与 errno 逐格不变）；`runLoop` 在
`runLoopFromState` 外层 catch **一处**接住并原地放弃本次尝试（不判 `failed`／`cancelled`）；
`resumeLoop` 的入口读改说真名；心跳两处各记一次、tick 与释放契约一字不改。
*** **人裁 83 的删锁条件逐格未变，红线函数一个字没动。** ***

⚠️ *** **写本文时（现测，`merge-base --is-ancestor` 逐笔验过）：远端含到第 12 笔
`docs(handoff): stop saying the round is unpushed …` 为止；第 13、14 笔与本文这一笔只在本地。** ***
人在那一会话里自己推了两次（`.git/logs/refs/remotes/origin/main` 可查），**不需要也不应该由控制器代劳**。
**而提交本文这个动作本身又会让本地再多一笔。**
⇒ *** **开工第一件事是自己现跑 `git ls-remote`，本文这一句只在写下的那一秒为真。** ***
⇒ ⚠️ *** **注释铁律的适用面已经切换**：已推上去的那些笔里，每一处注释、每一条 ERRATUM 都是【已发布文本】 ——
被推翻时唯一合法的修法是【再追加一条具名 ERRATUM】，不许就地改。
**判断某一笔发没发布，只能现跑 `git ls-remote` ＋ `git merge-base --is-ancestor`，不许查本文。** ***

---

## ⛔ 下一件事

### 0. ✅ **P0 已经做完（2026-09-04）—— 不要重做**

> **原文（2026-09-03 写下时为真）**：人裁「现在就动 ccloop，先做 Orca 这部分工作，
> **E1 的 I-2 ＋ 人裁 85 顺延**，**人裁 121 仍有效**。」

*** **P0 已由 Orca 那条线的 run `orca-dev-213d1395` 在本仓库执行完毕，四笔本地提交，未 push。** ***
细节、实测数与全部更正见本文档末尾「📌 Orca 那条线」一节。

⇒ *** **本仓库的下一件事因此回到下面第 2 条：E1 的 I-2 ＋ 人裁 85。** ***
**人裁 121 仍然有效，回来做它们时不需要重新拿授权。**
⚠️ *** **E1 仍在授权面外** *** —— 第 2 条里「动生产代码之前必须另拿一次具名授权」那句**至今没有被任何裁决碰过**。
⚠️ *** **push 仍需每次单独授权。控制器不许 push。本仓库现在有四笔未 push 的提交。** ***

### 1. **I-3(a) 已收口（人裁 125）—— 不要重开，也不要重做**
复审判 **0 Critical／1 Important（文档性：整包已推远端）／4 Minor**，四条修复各有红证。
⚠️ **人裁 125 是人主动开的一个例，不是人裁 100 的适用**（人裁 100 要「连续两轮 0 Critical」，首审有 1 Critical）。
**以后引用引人裁 125 本身。**

### 2. **下一件事就是这两件**（人裁 121 已开口，人裁 126 把它们推到了新会话）

| 挂账 | 现场（已实测记录，代码一行未改） | 开工方式 |
|---|---|---|
| **E1 的 I-2** | 数组 holder ＋ 死 pid ⇒ `inspectLock` 答 `dead` 而非 `unrecognized-holder`，于是 `unlockCommand` **无 `--force` 直接删锁**。已写在红线函数的注释里 | 先 `superpowers:brainstorming` 出 spec。⚠️ *** **E1 在授权面外：出完设计、动生产代码之前必须另拿一次具名授权 —— 人裁 121 只授权了「开工设计」。** *** |
| **人裁 85 —— `ls` 也报锁** | 已立项挂账，无现场包袱 | 同样先 brainstorming |
| **Linux（仍挂着，唯一的真覆盖缺口）** | 整套在 Linux 上本来就红 5 条（**先于点 B 存在的包级缺口**）；本机 OrbStack daemon 实测未起（socket 不存在） | **要人自己开**（`! open -a OrbStack`）。⚠️ 历轮文档里那个「$5–15」**是自估，不是工具报数** —— 按铁律 8，开工前重新问工具或问人 |

⇒ 前两件都有实质设计成分 ⇒ **先 `superpowers:brainstorming`，再 `writing-plans`**。

### 3. 近两轮留下的方法论（**下一轮直接用**）
1. *** **「红在哪条断言」不是可靠的判别方式。** *** 前面的断言会先短路。**要量什么就直接量什么**（定向探针打印值）。
2. *** **「没跑过的那条变异」也不是证据。** *** 八条变异看着完备，`stop()` 那一支却只被别的分支的变异间接掠过，
   结果它**删掉全套照绿**。⇒ **机械检查：每新增一个分支，点名那条删掉【它自己】的变异，并确认它存在。**
3. *** **改写判据时，断言的【位置】和它的【文字】一样承重。** *** I-1 那处三条断言一字未改、只是顺序变了，
   其中一条就此不再观测任何生产行为。**「逐字保留」≠「承重保留」；验收改写要看「它还能不能红」。**
   ⇒ **一条不用跑变异就能查的形状**（复审员提的）：*** **排在被测调用【之前】、读回测试自己刚写进去的值的断言，
   永远不可能红。** *** 验收任何改写时先扫这个形状。
4. **一笔提交里的两处注释可以互相打脸**（K-1：`runLoop.ts` 说 M8 没红，同一笔的判据注释说 M8 证明了承重）。
   ⇒ **写完注释做一次「同一事实在别处怎么说」的对照。**

## 铁律与边界（**违反即事故**）

1. **四件需人单独授权**：开门／合并／删分支或 worktree／**push**。*** **控制器不许 push。** *** 非门合并一律 `--ff-only`。
2. **不许实施者自改判据。** **改既有判据**必须由人**指名到具体测试**（人裁 88 三条件：(a) 指名 (b) 整条改写不许放宽 (c) 改后写明编码的是哪条人裁）。人裁 107、115 都是这么给的。
   ⇒ **需要新覆盖时先想「能不能只加不改」** —— 人裁 119 就是靠这条绕开了改既有判据。
3. **不许替人宣布。** 101–119 全是人亲自拍的。
4. **`.superpowers/sdd/**` 里的历史记录一个字不改**；发现写错了，**在新一节里记更正**。
   `docs/handoff/**` 与 `docs/superpowers/**` 是活文档，可整篇重写或追加更正节，但**不得把已知为假的说法带下去**。
5. **注释铁律**：**就地改**只适用于**本会话自己刚写、从未为真、且未发布**的笔误；
   **已发布（`git ls-remote` 说了算）、或上一会话写的** ⇒ **原文逐字保留 ＋ 追加具名 `*** ERRATUM (…, HUMAN RULING N) … ***`**。
   - *** **erratum 里不许写新的、会被后续裁决推翻的计数** *** —— 指向台账即可。
   - *** **erratum 不许引用会移动的 git 引用**（「remote tip」「HEAD」）。 ***
   - *** **erratum 优先放在整个注释块的末尾。** ***
   - ⚠️ **改判据前要做全树扫描，扫描清单从被更正的句子机械导出** —— 本轮就是这么发现「改写会让人裁 104 的 ERRATUM 里两处计数变成假话」的。
6. **变异只在 `git clone --local` 副本里**，主仓库工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**。
   ⚠️ *** **副本是 clone【已提交】状态** *** —— 要测**未提交**的改动，必须先 `cat 工作树文件 > 副本对应文件` 再变异，并用 `diff` 证明逐字节相同。
   ⚠️ *** **删副本前做「副本判据文件 vs 工作树判据文件」的字节比对** *** —— 本轮八条变异全做了，皆 0 字节（上一轮承认这一档弱）。
   ⚠️ *** **代码改了以后，之前跑过的变异要重跑** *** —— 本轮 M4／M5 在人裁 119 改事件类型后重跑过。
7. **绝不过滤验证性跑**（`grep`/`tail`/`head`/`sed` 都算，管道还会吞退出码）：重定向到文件、整份读回、核 vitest 第一行 `RUN` 指向的路径。
8. *** **成本只报工具给出的数，拿不到就说拿不到，不许自估。** ***

---

## 踩过的坑（**别再踩**）

1. *** **本机 `rm` 和 `cp` 都有 `-i` alias。** *** 普通 `rm -rf` 会**静默挂在确认提示上直到超时**；`cp` 会**静默拒绝覆盖**。
   ⇒ **一律用 `/bin/rm -rf` 和 `cat pristine > target`。**
2. *** **改代码/注释要按【整行锚点 ＋ 断言命中数 ==1 否则退出】。** *** 子串 `replace` 会在句子中间切开段落。
   ⚠️ **锚点谓词也要写准**：本轮用「全文里出现几次判据名」做普查，两条各命中 2 次，**其实是两条判据在注释里互相引用**——差点误判成「判据被别的轮次动过」。
3. **注释轮必须做全树扫描再动手，而且【扫描清单要从被更正的句子机械导出】。** 历轮教训：第一轮改 12 漏 6；第二轮补 6 又漏 2。**半改比不改坏。**
4. *** **探针没被验证之前，它的输出不是证据。** *** 本包栽过三次：`timeout` 在 macOS 不存在被读成「无容器运行时」；
   `awk length()` 数字节被当成数字符；`clone --local` 只克隆已提交状态被当成克隆了工作树。
5. *** **「绿」本身可能是空的，连【证明】也会空。** *** 实测五次：红线函数改成永不被调用旧判据照绿；给锁加第二个读者计数判据照绿；
   spec 里那条 M4 变异后判据照绿；`.catch(e => e)` 在 promise 成功时给出 `undefined` 让三条断言全在断言 `undefined`；
   **本轮 M8 删掉一整行写入，判据照绿**（⇒ 人裁 118）。
   ⇒ *** **一条变异在被【看到】打红之前，它不是证明。** *** ⇒ **钉「什么都没发生」的判据必须配一条正向观测。**
   ⇒ **拿 rejection 一律用 `.then(onFulfilled, onRejected)` 并在 onFulfilled 里 throw，不要用 `.catch(e => e)`。**
6. *** **`vi.resetModules()` ＋ 动态 `import` ⇒ 类身份不同** ***：`toBeInstanceOf` 必须用**动态模块实例上的类**，
   否则会因模块身份而非行为失败。本轮第三条改写判据就踩在这上面。
7. *** **一条先例不要外推。** *** spec 为 `runLoop` 写了「不新造事件类型」，实施时外推到心跳 ⇒
   **打红两条在数该类型的判据**（一条是既有判据）⇒ 人裁 119 改回自己的类型。**碰撞本身就是「两个事实不可互换」的证据。**
8. **评审员的自陈要核，控制器自己的数字更要核。** 上一轮实测：评审员两处不准（`ERR_OUT_OF_RANGE` 实为 `ERR_INVALID_ARG_TYPE`；一条 Minor 报小了）。
9. *** **「为修复派评审」会无限递归** *** —— 人裁 100 的收口理由：连续两轮 0 Critical 且 Important 全是文字准确性时，
   继续递归买不到安全。**要收口就援引人裁 100。**⚠️ **但人主动指名要审时，人裁 100 不适用**（人裁 105、106(b) 都是这样）。
10. *** **评审员会替你发现你自己文档里的假话，但它发现不了「你没跑过的那条变异」。** ***
    本轮 C-1 就是这么溜过上一轮的：八条变异看着完备，唯独 `stop()` 那一支只被**别的分支的变异**间接掠过。
    ⇒ **交付前自己先跑那张表：每新增一个分支 → 点名删掉【它自己】的那条变异 → 确认它存在且被看见红。**
11. **spec／plan 的自查是真能抓东西的**：上一轮自查抓出 6 条；**本轮 spec 自查抓出「M6 期望方向写反」这个硬错**
    （写成「回绿」，实际应为「变红」），plan 自查抓出「spec 第二条未量前提没有任何一步去量它」⇒ 补了 M8。**别跳过自查。**

---

## Suggested skills

| skill | 什么时候用 |
|---|---|
| `superpowers:verification-before-completion` | *** **每次要说「做完了／通过了／绿了」之前。** *** 本项目 Rule 12 与它同形 |
| `superpowers:brainstorming` | 动 E1 的 I-2／人裁 85／Linux 之前 —— 都有实质设计成分。⚠️ **它的 architectural 路径终点只能接 `writing-plans`** |
| `superpowers:writing-plans` | brainstorming 出 spec 之后。⚠️ **写完必须跑它的自查三项**（spec 覆盖／占位扫描／类型一致），本轮靠这个补出了 M8 |
| `superpowers:executing-plans` | 执行计划时。⚠️ 它要求隔离 worktree，**但本仓库铁律 1 把「删 worktree」列为需人授权**，且历轮都直接在 `main` 上落本地提交 —— **CLAUDE.md 优先** |
| `superpowers:test-driven-development` | 补新判据时。⚠️ **本仓库的「先红」多数要靠变异证明**；但**改既有判据成 `rejects` 时是真 TDD**（本轮 Task 1 就先红了 4 条） |
| `superpowers:requesting-code-review` | 派评审时；模板用 *** `…/i3a-rereview-brief.md`（最新的一份）***，**每个数按现测更新，已知 flake 写满 4 条，并把相关文档的「更正节」一并给评审员** |
| `superpowers:receiving-code-review` | *** 拿到报告之后。 *** ⚠️ **本项目额外要求：评审员的承重主张必须自己复核**，不许照单全收，也不许照抄它的数字 |
| `superpowers:systematic-debugging` | 出现测试红／行为不符时**先用它**，别直接改代码 |

⚠️ **skill 与本仓库 CLAUDE.md 冲突时，CLAUDE.md 优先**（Rule 11：conformance > taste）。

---

## 预算

**都只抄工具报数，一个自估都没有**（铁律 8）：

| 会话 | 工具报数 | 构成 |
|---|---|---|
| I-3(a) 实施那一会话 | **约 $128** | 无外派评审员；约 8 次全量测试 ＋ 10 条变异，每条变异都要建 `clone --local` 副本 |
| 评审 ＋ 修复 ＋ 复审那一会话 | *** **约 $71** *** | **两个外派评审员是大头**（各约 190k token、各七十来次工具调用）；控制器自己约 8 次全量 ＋ 7 条变异 |

⇒ *** **一轮「派评审 → 修复 → 复审」的量级就是几十美元，且大部分花在评审员身上。** ***
**远超 CLAUDE.md Rule 6 的每会话 400k。**
⚠️ **大动作（派评审、动 E1、跑 Linux、动人裁 85）之前先跟人报一次预估**，且**只报工具给出的数，拿不到就说拿不到**。
⚠️ **历轮都在实施中途报过一次预算并让人重新拍板** —— **这是对的做法，照做。**

---

# 📌 铁律已迁入 CLAUDE.md（**本节由另一会话追加，2026-08-29；上面一字未动**）

*** **`CLAUDE.md` 现在是铁律的权威副本（Rule 13–18）。本文档上方的铁律原文【暂时保留、未删】。** ***
*** **两处若有出入，以 `CLAUDE.md` 为准。** ***

**为什么搬**：铁律此前**只住在本文档里**，而本文档是**允许整篇重写、且多 agent 共享**的活文档。
最承重的规则住在最不稳定的地方 —— 任何一次重写都可能把它们写没了，**且没有任何机制会发现**。
`CLAUDE.md` 是每个任务无条件加载的，且没人会"顺手重写"它。

**为什么不直接删本文档里的原文**：E1 那一轮还在飞，而本文档是共享的 ——
**现在删等于在别人干活时抽掉他脚下的板子**。等那一轮收口后再由人决定是否清理重复。
⚠️ **这是一个【已知的临时重复状态】，不是终局。**

**同时修掉的一处已知误读**：`CLAUDE.md` Rule 6 现已写明**单位是【上下文窗口占用】，不是【累计消耗 token】**。
本文档「预算」一节按"累计消耗"读过这条并宣布「远超 Rule 6」—— *** **那是读法错了，不是数字错了。** ***
按"上下文窗口"读，330k/task 与实测舒适区间 300K–450K 几乎重合。
每会话额度同时由 400,000 统一为 **450,000**（与 ccmem 对齐；两仓库此前只差这一个数字，属复制后的漂移）。
⚠️ **本节不修改「预算」一节的原文**（那是已发布文本），此处即为具名更正。

---

# 📌 本仓库本轮还多了一份 `README.md`（**同一会话追加，上面一字未动**）

仓库此前**没有 README**。现有一份，**是从源码写的、且 quickstart 先跑通再写下来**：
`cli.ts`、契约 schema、两个 adapter、`scripts/claude-phase-runner.mjs`。

**它记录了几件此前只散落在 spec 里的事**（都实测过）：
- run 目录的**真实**结构 —— 除 `loop-state.json`／`events.jsonl` 外还有
  `loop-contract.json`（**所以 `resume` 不需要 `--contract`**）、`owner-record.json`、
  `attempts/<n>/{plan,execution,verify}.json` ＋ `diff.patch` ＋ `stdout-stderr.log`；
- **`worktrees/` 跑完是空的** —— `cleanupAttemptWorkspace` 会 `git worktree remove --force`，
  源仓库 `git worktree list` 不多出任何条目；
- scripted 路径在一次性 git 仓库里 **exit 0**（没在主仓库跑，避免注册 worktree 触碰铁律的授权面）。

⚠️ **README 是活文档**，但它写的每个结构性断言都来自实测 —— **改它之前请先现测，别照抄。**

## 本会话对本仓库的改动一览（**都只在本地提交，一次没 push**）

按提交主题行找（**别数笔数，也别记 SHA**）：

1. `docs(readme): write the missing README, verified against a real scripted run`
2. `docs(spec): design A' …` ＋ `docs: point at Orca for the ledger design instead of keeping a second copy here`
   （spec 曾短暂存在于本仓库，**已删；真相源在 Orca**）
3. `docs: move the ironclad rules into CLAUDE.md and fix Rule 6's unit ambiguity`

*** **`src/**` 与 `tests/**` 一个字节都没动。E1 的 I-2 ＋ 人裁 85 那一轮原样挂着，仍是下一件事。** ***

---

# 📌 Orca 那条线（**单节滚动更新，最后更新 2026-09-04**）

> ⚠️ *** **本节就地更新，不新增编号章节** *** —— 规矩是人 2026-09-02 定的。
> 合法性依据：`CLAUDE.md:74` 与本文档铁律 4 都明写 `docs/handoff/**` 是**允许整篇重写**的活文档，
> 只是「**不得把已知为假的说法带下去**」。**历次原文可由 `git log -- docs/handoff/handoff.md` 取回。**
> ⚠️ 本节**不写任何当前哈希，也不写「远端到第几笔」** —— 提交本文这个动作本身就会改 HEAD。
> 要指代某一笔就**引提交主题行**。⚠️ 例外：**实测值的观测锚点 commit 必须写** —— 那是有效期，不是当前状态。

## 🔴 一、本次更新最重要的一件事：**本仓库这一轮一个跟踪字节都没被动过**

Orca 那条线（run `orca-dev-c2fd0c3b`，2026-09-04）执行了它自己的 **P2 计划：子系统 C，15 个任务**。
C 是「把 ccloop 当作单任务执行器的调度器」，所以整轮**大量 spawn 本仓库**（几十次 `scripted` 跑），
但：

*** **`git status --short` 全程为空，HEAD 恒为 `7f2c5f6`，`src/**`／`tests/**`／`scripts/**`／
`.superpowers/**` 零触碰。** *** 唯一的写入是在**被 gitignore 的 `dist/`** 里跑过一次 `npm run build`
（`package.json` 是 `private: true`、`bin` 指向 `dist/cli.js`，spawn 需要它）。

⇒ **本仓库的下一件事没有变**：仍是 **E1 的 I-2 ＋ 人裁 85**（人裁 121 仍然有效；
**E1 动生产代码之前仍需另拿一次具名授权**）。**本节不产生任何任务。**

## 🔴 二、P0 那个 ref 命名空间现在**真的有消费者了**

此前本节写着 `refs/ccloop/<run-id>/attempts/<n>` 是「已登记的未来消费点」。**那句话现在为假。**

子系统 C 已经落地并有 161 条判据在跑，其中收产物那一层
（`git for-each-ref refs/ccloop/<run-id>/attempts/`，取编号最高的一个，`base` 就是 `<sha>^`）
是**执行路径上的代码**，不是意图。⇒ *** **改这个命名规则、改 ref 的写入时机、或让某个终态不再发布 ref，
都会静默弄坏一个正在运行的下游。** *** 不是不许改，是改之前要知道有人在读。

同理，契约的 `context.targetPaths` 与 `safetyPolicy.allowlistPaths` **也不再只是登记**：
C 的写集就是这两个字段的并集，`orca plan` 会把它打印给人看，调度判据靠它分层。

## 🔴 三、Orca 这一轮在本仓库现测到的五条（**都是诊断，不是任务；要不要跟进由本仓库自己决定**）

**观测锚点：ccloop `7f2c5f6`，2026-09-04。** 全部靠真跑得出，不是读代码推的。

1. *** **`blocked_waiting_human` 只能经 `evaluatePathPolicy` 在 `verifierType: "command"` 下到达；
   `pauseOn` / `pauseSignals` 那条路在那里是死的。** *** ⇒ 本仓库若认为那条路应当可达，这是一个真缺口。
2. **四个非成功终态全部 exit 2** —— `exhausted`／`failed`／`blocked_waiting_human`／`cancelled` 不可区分。
   下游只能读 `loop-state.json` 的 `status`。（这条本仓库已知，此处是复测确认。）
3. **`exhausted` 与 `failed` 的分岔点是 `stopController` 先查尝试次数上限、后查 `safeToRetry`。**
   ⇒ 想让一个 scripted 跑到 `exhausted`，就得超 `maxAttempts`；想到 `failed`，就得 `safeToRetry: false`。
4. *** **`blocked_waiting_human` 的运行【不发布任何 attempt ref】。** *** 收产物的一侧必须显式处理这件事，
   否则会把「升人」误读成「空改动」。
5. *** **attempt ref 落在 `context.repoPath` 指向的那个仓库里** *** —— worktree 与母仓共用 ref store，
   `worktreeManager.ts` 的 `update-ref` 跑在 worktree 内。⇒ **任何调用方若不改写 `repoPath`，
   ref 就会写进用户自己的仓库。** C 因此给每个任务开一个 `git clone --local` 副本；
   这一点值得写进本仓库的 README，因为它对**所有**调用方成立，不只对 C。

## 四、Orca 那边现在到哪了（**知情，不复述细节**）

- **A′（决策台账校验器）已落地并已发布。**
- **子系统 C 的 spec、三份实施计划（P0／P1／P2）全部写完；P0、P1、P2 全部执行完毕。**
  P0 就是本仓库那五笔（`publishAttemptCommit` 等），**已在本仓库，未 push**。
- **C 本身有 `orca plan` 与 `orca run` 两个子命令**，三层结构，161 条判据，16 条点名变异全部见过红。
- ⚠️ **Orca 本地领先它自己的远端 37 笔，一次都没 push** —— 判断它某一笔发没发布，
  **现跑它那边的 `git ls-remote`，别读本节。**

## 五、Orca 是什么、跟本仓库什么关系（**不变**）

| | 角色 |
|---|---|
| **ccloop（本仓库）** | **一个工具** —— 把单个任务跑成循环。**C 通过 spawn 子进程使用它，不是 npm 依赖** |
| **Orca**（`/Users/biran/code/skills/loop/Orca`） | **系统** —— 调度、决策台账、索引器、Web 面板 |
| **ccmem** | 记忆层，走 CLI/DB 接口，**不 vendor** |

**ccloop 不知道 Orca 存在，也不需要知道。** 设计与进度的真相源只在 Orca 那边
（`…/Orca/docs/superpowers/specs/`、`…/plans/`、`…/docs/handoff/handoff.md`）。

## 六、归属与边界

本节本次更新由 Orca 那条线的 run `orca-dev-c2fd0c3b` 于 2026-09-04 写入，
写入时本仓库工作树干净、只有主工作树（口径 `git status --short`、`git worktree list`，写入当时现测）。

⚠️ 执行 P2 全程守的是**本仓库自己的 `CLAUDE.md` 与铁律**，不是 Orca 的（Orca spec §7 ／ Orca CLAUDE.md Rule 16）。
⚠️ *** **本仓库领先远端 6 笔未 push（现测 `git rev-list --count 7caa4cb..HEAD`，2026-09-04）** *** ——
P0 那一轮的五笔，加上更早的 `docs(handoff): record the ruling that puts P0 ahead of E1's I-2 and ruling 85`。
⚠️ **本节此前写的「五笔」只数了 P0 自己那一轮，漏了前一笔；此处即为更正。**
本轮除本文这一笔外没有增加。**push 仍需人单独授权，控制器不许 push。**
