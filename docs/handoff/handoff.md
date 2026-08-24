# ccloop Handoff — **点 B 已实施并评审过一轮；A/C/B 三笔收尾已落地但【未评审】；C-1 仍不记关闭；「E1 通过」仍未拍板**

> ⚠️ **一律自查，别信本文。** **只有两个门锚点 `e42e062`（GATE-PKG3）与 `86d3bd6`（GATE-PKG2）是已固定的历史值，可放心引用。**
> *** **本文一个当前哈希都不写** —— 提交本文这个动作本身就会改 HEAD 与笔数。 ***
> 需要指代某一笔时**引提交主题行**（`git log --grep` 找得回），需要指代材料时**引路径**。
> **本文是重写的**（上一版 2322 行，内容留在 git 历史里，找 `docs(handoff): correct this session's token figure` 那笔的父提交状态）。

---

## 先跑这些，以输出为准

```bash
cd /Users/biran/code/skills/loop/ccloop
git log --merges --format='%h %cd %s'   # 末两笔应仍是 GATE-PKG2（86d3bd6）、其下 GATE-PKG3（e42e062）
git ls-remote origin refs/heads/main    # ⚠️ 一律现跑，开工核一次、收尾再核一次（人会自己动远端）
git status --short; git worktree list; git branch -vv
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run             # 期望 34 files / 601 tests，零 skipped
rtk proxy npm run typecheck; rtk proxy npm run build
```

⚠️ **验证性命令一律走 `rtk proxy`**；**判断远端只能 `git ls-remote`** —— `git status` 的 `ahead N` 是缓存 ref。
⚠️ *** **rtk 的过滤层会骗你**：`git status --porcelain` 空时它打印 `ok`，`git diff | wc -c` 把 0 字节报成 1 字节。
**任何还原证明／字节比较一律走 `rtk proxy git … > 文件` 再 `wc -c`。** ***

### 上一会话（2026-08-22／23）实测基线，未过滤整份读回、`RUN` 路径已核

- **`34 files / 601 tests`** 全绿**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0`
- *** **判据基线是 601，不是 600** *** —— 600 是点 B 之前的数
- **红线函数 `tryRecoverStaleOwnerTransferLock` = 1558 字节**，签名命中数 =1
  *** **970 字节那个旧基线已作废** —— 人裁 83 授权动了它，别再拿 970 去比 ***
- ⚠️ **整套在 Linux 上【不绿】**（`5 failed / 593 passed`，第六位评审在别的轮次实测）；**点 B 相关的任何一格都没在 Linux 上跑过**

---

## 唯一可信进度源（**引路径，不要重新推导**）

`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` —— **人裁 10–93 全在里面**。
*** **上一会话新增 §29／§30／§31。§31 末尾「⛔ 下一件事」是下一会话的第一件事，逐字照做。** ***
⚠️ *** **`.superpowers/sdd/.gitignore` 内容是 `*`** *** —— 该目录下**新产物必须 `git add -f`**。

| 材料 | 路径 |
|---|---|
| **点 B 的独立评审报告（1 Critical／3 Important／3 Minor）** | `…/pointB-review.md` |
| **该轮的 brief（下次派评审抄这份，它已按「红线是被审对象」改写过）** | `…/pointB-review-brief.md` |
| B 的裁决包 v2（实测于 600 条基线） | `…/pointB-ruling-package-v2.md` |
| B 的裁决包 v1（**已过期，保留不改**） | `…/pointB-ruling-package.md` |
| 点 C 裁决 ＋ presence-only 实测 | `…/pointC-design.md` |
| E1 的六份评审 ＋ briefs | `…/E1-review-*.md`（`E1-review-fix4-brief.md` 含「本机／网络」条款） |

---

## 上一会话做完了什么（**都不要重做**，细节全在台账 §29–§31）

按提交主题行找，**九笔，全部本地，一笔未 push**：

1. `fix(owner-transfer): make stale-lock recovery fail closed (point B, human ruling 83)`
   —— **点 B 实施**。红线函数两处改动（判据反向 ＋ `catch` 失败关闭），两条具名判据整条改写并改名。
2. `docs(sdd): record section 29 …`
3. `docs(unlock): correct the twelve comments point B turned false (human ruling 91)` —— 第一轮注释轮
4. `docs(sdd): record rulings 90-92 …`
5. `docs(sdd): file the point B review brief and the independent report`
6. `test(fileStore): pin the exit human ruling 83 closed and nobody covered` —— **A**
7. `docs(comments): make e22d1ea's own method claim true …` —— **C**
8. `docs(unlock): correct the six stale comments the first round missed (human ruling 93)` —— **B**
9. `docs(sdd): record section 31 …`

**评审那轮的 Critical 已修**（第 6 笔）：人裁 83 关的两个出口里，**只有"解析失败"那个有判据**，
"解析成功但 holder 不是 `pid:<n>`"那个**零覆盖** —— 一个 token 翻回判据，600 条一条不响。现已补上并有红证。

---

## ⛔ 下一件事 —— **四件全部等人裁，控制器一件都没替他决定**

### 1. 要不要为 A／C／B 这三笔再派一轮独立评审（**最该先问的一件**）
⚠️ *** **那轮评审是在补 A 之前做的。第 6／7／8 三笔本身没有经过任何独立评审。** ***
⇒ **在这三笔被审过之前：不许宣布点 B 通过，不许把 C-1 记成关闭。**
派评审就抄 `…/pointB-review-brief.md`（**它已经把「红线是被审对象、新基线 1558 字节」写进去了**，别再抄那份要求核 970 字节的旧文）。

### 2. I-3 —— 失败关闭之后，操作员看不见被永久卡住的锁
控制器建议**并入人裁 85 那一轮**（`ls` 也报锁），不另开第三轮：**两者是同一个病**。
⚠️ **评审员说的"最小修法"并不小**：要区分「持有者还活着」和「锁不可归属」，
得让 `tryRecoverStaleOwnerTransferLock` 把**为什么返回 false** 告诉调用方，而它现在是 `Promise<boolean>`
⇒ **那是再动一次红线函数并改它的返回类型。**（read-only argument，**未实测**。）
现状实测：`readOwnerRecord` **静默返回过期记录不抛错**；唯一出声的 `owner transfer already in progress` **是假话**且不提 `ccloop unlock`。

### 3. Mi-2 —— 数组／强转 holder 绕过
`parsePid` 的正则 `exec` 会 `String()` 强转，`["pid:999999"]` 能命中。**pre-existing、有界**（pid 仍须是死的，不偷活锁）、
**与 E1 共用同一个缺口**。但红线函数里新写的注释宣称的"唯一条件"比代码实际强 —— 要么软化注释，要么加 `typeof === "string"`。**挂账。**

### 4. T2 的冗余
`fileStore > leaves the lock on disk when malformed staged state names no dead holder` 的唯一事后断言，
**逐字是另一条的四条之一**，前 27 行夹具逐字节相同。**是冗余不是僵尸**（编码的规格是对的）。
消它要动一条具名判据 ⇒ 需要人裁确认人裁 87 涵盖。**挂账。**

---

## 铁律与边界（**违反即事故**）

1. **四件需人单独授权**：开门／合并／删分支或 worktree／**push**。*** **控制器不许 push。** *** 非门合并一律 `--ff-only`。
2. **不许实施者自改判据。** 人裁 4 许可的是**补测试**；**改既有判据**必须由人**指名到具体测试**（人裁 88 三条件：(a) 指名 (b) 整条改写不许放宽 (c) 改后写明编码的是哪条人裁）。
   ⇒ **需要新覆盖时，先想"能不能只加不改"** —— 上一会话的 A 就是这么绕开一次裁决的。
3. **不许替人宣布**：「E1 通过」至今没人拍板；C-1 不许记关闭；点 B 不许宣布通过。
4. **`.superpowers/sdd/**` 与 `docs/handoff/**` 里的历史记录一个字不改** —— 它们记的是当时为真的事，改了就毁证。
   （旧措辞「C-1 降级，未关闭」在台账里约二十处，**全部保留**；新记录用 §30 那段权威文本。）
5. **变异只在 `git clone --local` 副本里**，主仓库工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**，
   `diff -r` **不是**还原证明（它看不见 index）。
6. **绝不过滤验证性跑**（`grep`/`tail`/`head`/`sed` 都算，管道还会吞退出码）：重定向到文件、整份读回、核 vitest 第一行 `RUN` 指向的路径。

---

## 本会话踩过的坑（**别再踩**）

1. *** **本机 `rm` 和 `cp` 都有 `-i` alias。** *** 普通 `rm -rf` 会**静默挂在确认提示上直到超时**（实测浪费 2 分钟）；
   `cp` 会**静默拒绝覆盖**。⇒ **一律用 `/bin/rm -rf` 和 `cat pristine > target`。**
2. *** **`str.replace` 的子串匹配会在句子中间切开段落。** *** 上一会话因此制造了两个 splice bug
   （一行 153 字符、一整句被甩到 ERRATUM 之后），都是自己抓回来的。
   ⇒ **改注释时锚点要落在行边界上，改完必须核最宽注释行宽度**（这八个文件的基线是 **≤103**）。
3. **注释轮必须做全树扫描再动手。** 第一轮改了 12 处、漏了 6 处，其中一处是同一论断的**第四份逐字拷贝** ——
   结果读者会看到三处说 REFUSER、一处说 STEALER，**且无从判断哪份权威**。**半改比不改坏。**
4. **注释的写法**：本仓库**不静默覆盖** —— 原文逐字保留，后面接具名 `*** ERRATUM (…, human ruling N) … ***`。
   ⇒ **改完要用"每一行被删的注释是否还能逐字搜到"来自查**，这是评审员抓住上一轮的方法。
5. **评审员的自陈也要核。** 上一轮它报 M1 变异「600/600 ALL PASS」，实测是 `599 passed + 1 名单内 flake`。
   结论不变，但**数字不能照抄**。
6. **别信"判据增量 = 0"这种条数指标。** 它在条数上准，却掩盖了一整个出口零覆盖 —— 这是那轮 Critical 的成因。

---

## Suggested skills

| skill | 什么时候用 |
|---|---|
| `superpowers:verification-before-completion` | *** **每次要说"做完了／通过了／绿了"之前。** *** 本项目的 Rule 12 与它同形：跑过、整份读回、贴出证据再下结论 |
| `superpowers:systematic-debugging` | 出现测试红／行为不符时**先用它**，别直接改代码。本包的历史反复证明：先射后画靶会写出"因为错的理由而绿"的判据 |
| `superpowers:test-driven-development` | 补任何新判据时（比如下一轮若要补 Mi-2 或 I-3 的覆盖）：**先红后绿**，本会话的 A 就是这么做的 |
| `superpowers:requesting-code-review` | 派上面第 1 件那轮评审时；派之前先读 `…/pointB-review-brief.md` 当模板 |
| `superpowers:receiving-code-review` | *** 拿到评审报告之后。 *** ⚠️ **本项目额外要求：评审员的承重主张必须自己复核**，不许照单全收，也不许照抄它的数字 |
| `superpowers:brainstorming` | 只在第 2 件（I-3／人裁 85）真要动设计时；那件有实质设计成分，值得一个满上下文的开局 |

⚠️ **skill 与本仓库 CLAUDE.md 冲突时，CLAUDE.md 优先**（Rule 11：conformance > taste）。

---

## 预算

上一会话烧了约 **$45**（其中独立评审员一人 **190k tokens**），**远超 CLAUDE.md Rule 6 写的每会话 400k**。
⇒ **下一会话开局先看 Rule 6**，大动作（再派评审、动 I-3）之前先跟人报一次预估。
