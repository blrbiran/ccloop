# ccloop Handoff — **I-3(a) 已收口（人裁 125）；下一件事是 E1 的 I-2 与人裁 85 的设计（人裁 121）**

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
rtk proxy npm test -- --run             # 期望 35 files / 614 tests，零 skipped
rtk proxy npm run typecheck; rtk proxy npm run build
```

⚠️ **验证性命令一律走 `rtk proxy`**；**判断远端只能 `git ls-remote`** —— `git status` 的 `ahead N` 是缓存 ref。
⚠️ *** **`ls-remote` 的结果只在它跑出来的那一秒为真** —— 开工一次、收尾一次，中间做过判断就再来一次。 ***
⚠️ *** **rtk 的过滤层会骗你**：`git status --porcelain` 空时打印 `ok`，`git diff | wc -c` 把 0 字节报成 1 字节，
长 grep 截断成「[+N more]」，含括号的正则直接报错。
**任何还原证明／字节比较／整份读回一律 `rtk proxy … > 文件` 再 `cat`／`wc -c`；读大文件用 `sed -n 'a,bp'` 或 python，不要用 grep。** ***

### 最近一次会话（2026-08-28）实测基线 —— 未过滤整份读回，`RUN` 路径已核

- *** **`35 files / 614 tests`** *** 全绿**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0`，耗时 16.84s
- *** **判据基线是 614。613／609／604／603／602／601／600 全部作废。** ***（修复轮 +1：`stop()` 那条）
- *** **红线函数 `tryRecoverStaleOwnerTransferLock` 近两轮一个字未动**：第 1017–1095 行、**4769 字节**，
  口径 ＝ `src/persistence/fileStore.ts` 的【整行范围、含末尾换行】（`sed -n 'a,bp' … | wc -c`）***
  ⚠️ **行号会移动 ⇒ 引用前必须现测**（先找签名行，再大括号配对找收尾行）。**3185／4496 两个旧基线均已作废。**
  （独立评审员用同一口径复测过，并比对了 `30dde52` 与当时 HEAD 的 sha256 —— 逐字节相同。）
  ⚠️ *** **报任何字节数必须连口径一起报。** ***
- ⚠️ *** **这份基线在负载下会 flake。** *** 已知 **4 条**，其中**两条不在人裁 10 的名单里**：
  - 名单内：`records env names only …`、`persists phase usage evidence…`
  - *** **名单外**：`runLoop > accounts an execute timeout that rejects after the abort as exhaustion`、
    `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data` ***
  - 都是 `Test timed out in 5000ms`；红的那轮总耗时 **~25–29s**，绿的几轮 **17–22s**
  ⇒ **看到红先看：是不是这四条之一 ＋ 是不是超时 ＋ 总耗时是否异常，再单独重跑那个文件，别急着报回归。**
  ⇒ **派评审时，brief 的「已知 flake」清单必须写满 4 条。**
- ⚠️ **整套在 Linux 上【不绿】**（`5 failed / 593 passed`，第六位评审在别的轮次实测）；**本包近几轮没有任何一格在 Linux 上跑过**
  （实测 OrbStack daemon 未起：socket 不存在）

---

## 唯一可信进度源（**引路径，不要重新推导**）

`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` —— **人裁 10–119 全在里面**。
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
| I-3(b) 独立评审报告 ＋ brief（**下次派评审抄这份 brief**；⚠️ 它自己的消费点普查有错，见台账 §41） | `…/i3b-review.md`、`…/i3b-review-brief.md` |
| 更早几轮的评审 ＋ brief ＋ 裁决包 | `…/pointB-*.md`、`…/pointC-design.md`、`…/E1-review-*.md` |

---

## 人裁 109–119（**人亲自拍的，控制器一件都没替人宣布**）

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
| **120** | 本轮四笔**派独立评审**（人裁 110 只覆盖人裁 108 那一笔）。 |
| **125** | **I-3(a) 收口** —— 人主动开例，**不是人裁 100 的适用**（首审有 1 Critical）。 |
| **126** | 本会话到此为止；E1 与人裁 85 的设计**另开会话**。 |
| **121** | 挂账里**先动 E1 的 I-2 ＋ 人裁 85**；Linux 继续挂。 |
| **122** | **修完派复审**（本轮有 1 Critical，人裁 100 前提不成立）。 |
| **123** | C-1 **只补一条判据**，不做人裁 118 式披露注释。 |
| **124** | I-1 整条改写；I-2／I-3 向 N1 各加一条断言；K-1 追加具名 ERRATUM —— **四条全授权**。 |

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

**做出来的东西**：三处吞掉 `OwnerTransferLockUnattributableError` 的地方全部处置 ——
`recoverInterruptedOwnerTransfer` 的裸 `catch` 收窄（Busy 与 errno 逐格不变）；`runLoop` 在
`runLoopFromState` 外层 catch **一处**接住并原地放弃本次尝试（不判 `failed`／`cancelled`）；
`resumeLoop` 的入口读改说真名；心跳两处各记一次、tick 与释放契约一字不改。
*** **人裁 83 的删锁条件逐格未变，红线函数一个字没动。** ***

⚠️ *** **写本文时，上面十笔【全部已经推到远端】** *** —— 人在本会话里推了两次（`4493338 → d4a9bb1 → 26da28e`，
reflog 可查）。**但提交本文这个动作本身就会让本地再多一笔。**
⇒ *** **开工第一件事是自己现跑 `git ls-remote`，别信这一句。** ***
⇒ ⚠️ *** **注释铁律的适用面已经切换**：这十笔里的每一处注释、每一条 ERRATUM 都是【已发布文本】 ——
被推翻时唯一合法的修法是【再追加一条具名 ERRATUM】，不许就地改。 ***

---

## ⛔ 下一件事

### 1. **I-3(a) 已收口（人裁 125）—— 不要重开，也不要重做**
复审判 **0 Critical／1 Important（文档性：整包已推远端）／4 Minor**，四条修复各有红证。
⚠️ **人裁 125 是人主动开的一个例，不是人裁 100 的适用**（人裁 100 要「连续两轮 0 Critical」，首审有 1 Critical）。
**以后引用引人裁 125 本身。**

### 1b. **下一件事就是这两件（人裁 121 已开口，人裁 126 把它们推到了新会话）**
- **E1 的 I-2** —— 先 `superpowers:brainstorming` 出 spec；⚠️ *** **动生产代码前必须另拿具名授权。** ***
- **人裁 85（`ls` 也报锁）** —— 同样先 brainstorming。

### 2. 挂账（**人裁 121 已经开口两件**）
- **E1 的 I-2**（人裁 121 已开工设计）：数组 holder ＋ 死 pid ⇒ `inspectLock` 答 `dead` 而非 `unrecognized-holder`，
  于是 `unlockCommand` **无 `--force` 直接删锁**。⚠️ *** **E1 在授权面外：动生产代码前必须另拿一次具名授权。** ***
- **人裁 85 —— `ls` 也报锁**（人裁 121 已开工设计）。
- **Linux 从没跑过**（唯一的真覆盖缺口，**仍挂着**）：OrbStack daemon 实测未起（socket 不存在）⇒ **要人自己开**
  （`! open -a OrbStack`）。整套在 Linux 上本来就红 5 条。预估 $5–15。

⇒ 这两件都有实质设计成分 ⇒ **先 `superpowers:brainstorming`，再 `writing-plans`**。

### 3. 近两轮留下的方法论（**下一轮直接用**）
1. *** **「红在哪条断言」不是可靠的判别方式。** *** 前面的断言会先短路。**要量什么就直接量什么**（定向探针打印值）。
2. *** **「没跑过的那条变异」也不是证据。** *** 八条变异看着完备，`stop()` 那一支却只被别的分支的变异间接掠过，
   结果它**删掉全套照绿**。⇒ **机械检查：每新增一个分支，点名那条删掉【它自己】的变异，并确认它存在。**
3. *** **改写判据时，断言的【位置】和它的【文字】一样承重。** *** I-1 那处三条断言一字未改、只是顺序变了，
   其中一条就此不再观测任何生产行为。**「逐字保留」≠「承重保留」；验收改写要看「它还能不能红」。**
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
10. **spec／plan 的自查是真能抓东西的**：上一轮自查抓出 6 条；**本轮 spec 自查抓出「M6 期望方向写反」这个硬错**
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
| `superpowers:requesting-code-review` | 派评审时；模板用 `…/i3a-review-brief.md`（比 i3b 那份新），**每个数按现测更新，已知 flake 写满 4 条** |
| `superpowers:receiving-code-review` | *** 拿到报告之后。 *** ⚠️ **本项目额外要求：评审员的承重主张必须自己复核**，不许照单全收，也不许照抄它的数字 |
| `superpowers:systematic-debugging` | 出现测试红／行为不符时**先用它**，别直接改代码 |

⚠️ **skill 与本仓库 CLAUDE.md 冲突时，CLAUDE.md 优先**（Rule 11：conformance > taste）。

---

## 预算

最近一次会话**约 $128**（**工具报数**，无外派评审员；大头是约 8 次全量测试 ＋ 10 条变异，每条变异都要建 `clone --local` 副本）。
**远超 CLAUDE.md Rule 6 的每会话 400k。**
⚠️ **大动作（派评审、动 E1、跑 Linux、动人裁 85）之前先跟人报一次预估**，且**只报工具给出的数**。
⚠️ **上一会话在实施中途报过一次预算超支并让人重新拍板** —— **这是对的做法，照做。**
