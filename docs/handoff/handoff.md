# ccloop Handoff — **点 B 已通过、C-1 已记关闭、8 条 Minor 已收尾；无人裁待决，三件挂账等人开口**

> ⚠️ **一律自查，别信本文。** **只有两个门锚点 `e42e062`（GATE-PKG3）与 `86d3bd6`（GATE-PKG2）是已固定的历史值，可放心引用。**
> *** **本文一个当前哈希都不写** —— 提交本文这个动作本身就会改 HEAD 与笔数。 ***
> 需要指代某一笔时**引提交主题行**（`git log --grep` 找得回），需要指代材料时**引路径**。

---

## 先跑这些，以输出为准

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --merges --format='%h %cd %s'   # 末两笔应仍是 GATE-PKG2（86d3bd6）、其下 GATE-PKG3（e42e062）
git ls-remote origin refs/heads/main    # ⚠️ 一律现跑，开工核一次、收尾再核一次（人会自己动远端）
git status --short; git worktree list; git branch -vv
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run             # 期望 34 files / 603 tests，零 skipped
rtk proxy npm run typecheck; rtk proxy npm run build
```

⚠️ **验证性命令一律走 `rtk proxy`**；**判断远端只能 `git ls-remote`** —— `git status` 的 `ahead N` 是缓存 ref。
⚠️ *** **rtk 的过滤层会骗你**：`git status --porcelain` 空时它打印 `ok`，`git diff | wc -c` 把 0 字节报成 1 字节，
`grep -n '^## '` 这类正则它可能整个吞掉或截断成「[+N more]」。
**任何还原证明／字节比较／整份读回一律 `rtk proxy … > 文件` 再 `cat`／`wc -c`；读大文件用 `sed -n 'a,bp'` 而不是 grep。** ***

### 上一会话（2026-08-25 第二段）实测基线，未过滤整份读回、`RUN` 路径已核

- *** **`34 files / 603 tests`** *** 全绿**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0`
- *** **判据基线是 603** *** —— 602／601／600 都已作废
- *** **红线函数 `tryRecoverStaleOwnerTransferLock` = 3185 字节**，签名命中数 =1，返回类型 `Promise<boolean>` ***
  **970 与 1558 两个旧基线早已作废**；上一会话**逐字节没动它**
- ⚠️ *** **这份基线在负载下会 flake。** *** 已知 **4 条**，其中**两条不在人裁 10 的名单里**：
  - 人裁 10 名单内：`records env names only …`、`persists phase usage evidence…`
  - *** **名单外（§35 实测）**：`runLoop > accounts an execute timeout that rejects after the abort as exhaustion`、
    `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data` ***
  - 都是 `Test timed out in 5000ms`；红的那轮总耗时 **28.93s**，绿的几轮 **17–20s**
  ⇒ **看到红先看：是不是这四条之一 ＋ 是不是超时 ＋ 总耗时是否异常，再单独重跑那个文件，别急着报回归。**
  ⇒ **派评审时，brief 的「已知 flake」清单必须把名单外那两条也写上。**
- ⚠️ **整套在 Linux 上【不绿】**（`5 failed / 593 passed`，第六位评审在别的轮次实测）；**点 B 相关的任何一格都没在 Linux 上跑过**

---

## 唯一可信进度源（**引路径，不要重新推导**）

`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` —— **人裁 10–104 全在里面**。
*** **上一会话新增 §36。§36 末尾「⛔ 下一件事」是下一会话的第一件事，逐字照做。** ***
⚠️ *** **`.superpowers/sdd/.gitignore` 内容是 `*`** *** —— 该目录下**新产物必须 `git add -f`**。

| 材料 | 路径 |
|---|---|
| **第二轮（收尾轮）独立评审报告：0 Critical／3 Important／9 Minor** | `…/pointB-cleanup-review.md` |
| 该轮 brief（**下次派评审抄这份**，红线基线等数字需按现测更新） | `…/pointB-cleanup-review-brief.md` |
| 第一轮（点 B 本体）评审报告 ＋ brief | `…/pointB-review.md`、`…/pointB-review-brief.md` |
| B 的裁决包 v2／v1（**v1 已过期，保留不改**） | `…/pointB-ruling-package-v2.md`、`…/pointB-ruling-package.md` |
| 点 C 裁决 ＋ presence-only 实测 | `…/pointC-design.md` |
| E1 的六份评审 ＋ briefs | `…/E1-review-*.md` |

---

## 人裁 101–104（**上一会话人亲自拍的，控制器一件都没替人宣布**）

| | 裁决 |
|---|---|
| **人裁 101** | *** **点 B 通过。** *** |
| **人裁 102** | *** **C-1 记关闭**（按人裁 92 自己写下的条件）。 *** |
| **人裁 103** | *** **E1 仍不拍**（I-2 那一格未裁未修）。 *** |
| **人裁 104** | *** **修 8 条 Minor，然后记台账收工。** *** |

---

## 上一会话做完了什么（**都不要重做**，细节全在台账 §36）

按提交主题行找（*** **别数笔数** ***），**全部本地，一笔未 push**：

1. `docs(comments): correct the two fileStore.ts claims measurement and ruling 102 overtook (M-2, M-4, human ruling 104)`
2. `test(fileStore): give test A the positive observation it lacked, and close three comment Minors (…, human ruling 104)` —— **判据 602 → 603**
3. `docs(sdd): record section 36 …`
4. `docs(handoff): …`（本文）

**8 条 Minor 全部收尾**：M-2／M-4／M-5／M-6／M-7 已改（**M-3 早在人裁 100 闭合**）；
M-1／M-8／M-9 **只记台账、代码零改动**，理由见下。

---

## ⛔ 下一件事 —— **无人裁待决；三件挂账，都要人先开口**

### 1. I-3 —— 失败关闭之后，操作员看不见被永久卡住的锁
⚠️ **评审员说的"最小修法"并不小**：要区分「持有者还活着」和「锁不可归属」，
得让 `tryRecoverStaleOwnerTransferLock` 把**为什么返回 false** 告诉调用方，而它现在是 `Promise<boolean>`
⇒ *** **那是再动一次红线函数并改它的返回类型。** *** 控制器建议**并入人裁 85 那一轮**（`ls` 也报锁），不另开第三轮：**两者是同一个病**。
*** **有实质设计成分，建议单开一个满上下文新会话，用 `superpowers:brainstorming` 起手。预估 $40–80，必然超 Rule 6。** ***

### 2. E1 的 I-2 那一格（**未裁**）
数组 holder ＋ 死 pid ⇒ `inspectLock` 答 `dead` 而非 `unrecognized-holder`，于是 `unlockCommand` **无 `--force` 直接删锁**。
**已在红线函数的注释里记录为实测，代码一行未改**（**E1 在授权面外，动它要新授权**）。**人裁 103 不拍 E1 的理由就是这一格。**

### 3. Linux 从没跑过点 B（**唯一的真覆盖缺口**）
本机 **OrbStack 的 docker CLI 在 `/usr/local/bin/docker`，但 daemon 没起**
（`unix:///Users/biran/.orbstack/run/docker.sock` 连不上）⇒ **要人自己开**（`! open -a OrbStack`）。
整套在 Linux 上本来就红 5 条，是**先于点 B 存在的包级缺口**；**人裁 101 没把它绑成点 B 的门，它是独立一件账。** 预估 $5–15。

### 4. ⚠️ 上一会话那两笔【自身没有经过独立评审】
与 §33 同形。**人裁 100 的收口理由（「为修复派评审」会无限递归）在此同样适用，但要不要为这两笔破例，是人的事，未裁。**

---

## 两个记账缺陷（**已查实，按铁律 4 只记不改**）

1. *** **台账 §33 那句「『153』两边都复现不出来」是错的。** *** 它复现得出来：
   `src/persistence/fileStore.ts` 的 **L702 = 152 字符 ＋ 换行**（在哪一笔的树上量的，见台账 §36）。
   三个数**各自都对，量的不是同一样东西**：评审员的 **125** = sweepRuns 那条注释行的字符数；
   控制器的 **137** = sweepRuns **全文件最宽行**（一行代码）；C 的 **153** = fileStore 那行。
   **C 的提交信息把 fileStore 的长度、sweepRuns 的文本、和一个两处都不存在的 `***` 拼成了一句** —— 这就是 M-1。
   ⚠️ *** **那条提交信息本身永远修不了**：C 就是远端 main 的头。 ***
   ⇒ **更正已按本仓库自己的原则落在代码里**（提交主题行 `docs(comments): put M-1's correction where a misled reader lands …`）：
   erratum 只放 `tests/sweep/sweepRuns.test.ts`，**因为那是顺着假话找过去的读者唯一会落到的地方**。
2. *** **§33／§34 的「最宽注释行」口径从来没被写死，且数值对不上。** *** 全文件三种口径都复现不出 100／101／103；
   最接近的是「本次 diff 新增行里最宽的注释行」，但实测**人裁 100 那笔**（`docs(unlock): close I-3b and both M-3 sites …`）是 **101／100／100**，而 §34 记的是 **100／101／101** —— **差一且张冠李戴**。
   ⇒ *** **口径自 §36 起写死并每次复述：全文件、首个非空白为 `//`、按【字符】计。** *** 现基线：`fileStore.ts` **104**／`fileStore.test.ts` **129**。

---

## 铁律与边界（**违反即事故**）

1. **四件需人单独授权**：开门／合并／删分支或 worktree／**push**。*** **控制器不许 push。** *** 非门合并一律 `--ff-only`。
2. **不许实施者自改判据。** 人裁 4 许可的是**补测试**；**改既有判据**必须由人**指名到具体测试**（人裁 88 三条件：(a) 指名 (b) 整条改写不许放宽 (c) 改后写明编码的是哪条人裁）。
   ⇒ **需要新覆盖时，先想"能不能只加不改"** —— 人裁 99 与 104 的 M-5 都是这么绕开裁决的（**新开一条测试，不往既有测试里塞断言**）。
3. **不许替人宣布。** 上一会话的 101–104 全是人亲自拍的。
4. **`.superpowers/sdd/**` 与 `docs/handoff/**` 里的历史记录一个字不改** —— 它们记的是当时为真的事，改了就毁证。
   ⇒ **发现台账写错，就在新一节里记更正，别回去改**（§36 就是这么处理 §33／§34 那两个数的）。
5. **注释铁律的分界（人裁 98／100／104 的先例）**：
   - **就地改**只适用于**本会话自己刚写、且从未为真**的笔误；
   - **已在远端历史里、或上一会话写的** ⇒ **原文逐字保留 ＋ 追加具名 `*** ERRATUM (…, HUMAN RULING N) … ***`**。
6. **变异只在 `git clone --local` 副本里**，主仓库工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**，
   `diff -r` **不是**还原证明（它看不见 index）。
   ⚠️ **副本是 clone committed state** —— 要测**未提交**的改动，得 `cat 工作树文件 > 副本对应文件` 再变异。
7. **绝不过滤验证性跑**（`grep`/`tail`/`head`/`sed` 都算，管道还会吞退出码）：重定向到文件、整份读回、核 vitest 第一行 `RUN` 指向的路径。

---

## 踩过的坑（**别再踩**）

1. *** **本机 `rm` 和 `cp` 都有 `-i` alias。** *** 普通 `rm -rf` 会**静默挂在确认提示上直到超时**；`cp` 会**静默拒绝覆盖**。
   ⇒ **一律用 `/bin/rm -rf` 和 `cat pristine > target`。**
2. *** **`str.replace` 的子串匹配会在句子中间切开段落。** *** ⇒ **改注释要按【行号 ＋ 整行锚点】插入，插之前先断言那一行逐字相符**
   （上一会话就靠这个当场抓到一个差一行的锚点，脚本直接退出、文件一字未动）。改完必须重量每个文件的最宽注释行。
3. **注释轮必须做全树扫描再动手。** 第一轮改 12 漏 6；第二轮补 6 又漏 2；**上一轮的 M-4，评审员只点了测试那一处，
   全树扫描查出 `src/persistence/fileStore.ts:506` 有同一句现在时的假话。****半改比不改坏。**
4. **评审员的自陈也要核，数字也不能照抄** —— 但**控制器自己的数字更要核**：M-1 那三个数最后证明**三方都对**，
   错的是**没人写下自己在量什么**。⇒ **报任何数字，连同口径一起报。**
5. **别信"判据增量 = 0"这种条数指标。** 它在条数上准，却掩盖了一整个出口零覆盖 —— 那是第一轮 Critical 的成因。
6. *** **"绿"本身可能是空的。** *** M-5 实测：把红线函数改成**永不被调用**，旧判据**照绿**。
   ⇒ **钉"什么都没发生"的判据必须配一条正向观测**，否则它与"代码根本没跑"不可区分。
7. *** **「为修复派评审」会无限递归** *** —— 每轮修复都在制造新的未评审面。人裁 100 的收口理由：连续两轮 0 Critical
   且 Important 全是文字准确性时，继续递归买不到安全，只买字面完美。**下次要收口，援引人裁 100。**

---

## Suggested skills

| skill | 什么时候用 |
|---|---|
| `superpowers:verification-before-completion` | *** **每次要说"做完了／通过了／绿了"之前。** *** 本项目 Rule 12 与它同形 |
| `superpowers:systematic-debugging` | 出现测试红／行为不符时**先用它**，别直接改代码 |
| `superpowers:test-driven-development` | 补任何新判据时。⚠️ **本仓库的"先红"是变异证明**（钉现状行为的判据天然先绿），人裁 99 与 104 的 M-5 都是这么做的 |
| `superpowers:requesting-code-review` | 派评审时；模板用 `…/pointB-cleanup-review-brief.md`，**里面每个数字都要按现测更新，且已知 flake 要写满 4 条** |
| `superpowers:receiving-code-review` | *** 拿到报告之后。 *** ⚠️ **本项目额外要求：评审员的承重主张必须自己复核**，不许照单全收，也不许照抄它的数字 |
| `superpowers:brainstorming` | 只在 I-3（人裁 85 那轮）真要动设计时 —— 那件值得一个满上下文的开局 |

⚠️ **skill 与本仓库 CLAUDE.md 冲突时，CLAUDE.md 优先**（Rule 11：conformance > taste）。

---

## 预算

上一会话（本轮）**约 $57**。⚠️ 控制器在会话中途自估过「约 $6」，**那个数从未为真** —— 是凭感觉报的，真数来自成本钩子。
⇒ *** **成本只报工具给出的数，不许自估。** ***
⚠️ **CLAUDE.md Rule 6 是每会话 400k tokens。** 大动作（再派评审、动 I-3、跑 Linux）之前**先跟人报一次预估**。
