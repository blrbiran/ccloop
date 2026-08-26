# ccloop Handoff — **人裁 106／107／108 全部落地：I-3(b) 已修并已过独立评审；无人裁待决，五件挂账等人开口**

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
rtk proxy npm test -- --run             # 期望 35 files / 609 tests，零 skipped
rtk proxy npm run typecheck; rtk proxy npm run build
```

⚠️ **验证性命令一律走 `rtk proxy`**；**判断远端只能 `git ls-remote`** —— `git status` 的 `ahead N` 是缓存 ref。
⚠️ *** **`ls-remote` 的结果只在它跑出来的那一秒为真** —— 开工一次、收尾一次，中间做过判断就再来一次。
前面的会话在这件事上栽过两次。 ***
⚠️ *** **rtk 的过滤层会骗你**：`git status --porcelain` 空时打印 `ok`，`git diff | wc -c` 把 0 字节报成 1 字节，
长 grep 截断成「[+N more]」，含括号的正则直接报错。
**任何还原证明／字节比较／整份读回一律 `rtk proxy … > 文件` 再 `cat`／`wc -c`；读大文件用 `sed -n 'a,bp'` 或 python，不要用 grep。** ***

### 最近一次会话（2026-08-26／27）实测基线 —— 未过滤整份读回，`RUN` 路径已核

- *** **`35 files / 609 tests`** *** 全绿**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0`，耗时 17.83s
- *** **判据基线是 609，测试文件 35 个** *** —— **604／603／602／601／600 全部作废**
- *** **红线函数 `tryRecoverStaleOwnerTransferLock`：签名命中数 =1，返回类型现为 `Promise<StaleOwnerTransferLockOutcome>`** ***
  最后实测 **4769 字节**，*** **口径 ＝ `src/persistence/fileStore.ts` 的【整行范围、含末尾换行】**（`sed -n 'a,bp' … | wc -c`）***
  ⚠️ **行号会移动 ⇒ 引用前必须现测**（先找签名行，再大括号配对找收尾行）。**3185 与 4496 两个旧基线均已作废。**
  ⚠️ *** **报任何字节数必须连口径一起报。** *** 少写口径已经让一个会话跑过一趟死胡同（台账 §39）。
- ⚠️ *** **这份基线在负载下会 flake。** *** 已知 **4 条**，其中**两条不在人裁 10 的名单里**：
  - 名单内：`records env names only …`、`persists phase usage evidence…`
  - *** **名单外（§35 实测）**：`runLoop > accounts an execute timeout that rejects after the abort as exhaustion`、
    `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data` ***
  - 都是 `Test timed out in 5000ms`；红的那轮总耗时 **~25–29s**，绿的几轮 **17–22s**
  ⇒ **看到红先看：是不是这四条之一 ＋ 是不是超时 ＋ 总耗时是否异常，再单独重跑那个文件，别急着报回归。**
  ⇒ **派评审时，brief 的「已知 flake」清单必须写满 4 条。**
- ⚠️ **整套在 Linux 上【不绿】**（`5 failed / 593 passed`，第六位评审在别的轮次实测）；**本包近几轮没有任何一格在 Linux 上跑过**
  （实测 OrbStack daemon 未起：socket 不存在）

---

## 唯一可信进度源（**引路径，不要重新推导**）

`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` —— **人裁 10–108 全在里面**。
*** **最近一次会话新增 §39／§40／§41。§41 末尾「⛔ 下一件事」是下一会话的第一件事，逐字照做。** ***
⚠️ *** **`.superpowers/sdd/.gitignore` 内容是 `*`** *** —— 该目录下**新产物必须 `git add -f`**。

| 材料 | 路径 |
|---|---|
| **I-3(b) 设计（spec）** | `docs/superpowers/specs/2026-08-26-i3-unattributable-lock-design.md` |
| **I-3(b) 实施计划** | `docs/superpowers/plans/2026-08-26-i3-unattributable-lock.md` |
| **I-3(b) 独立评审报告：0 Critical／1 Important／3 Minor** | `…/i3b-review.md` |
| 该轮 brief（**下次派评审抄这份**；⚠️ 它自己的消费点普查有错，见台账 §41）| `…/i3b-review-brief.md` |
| 第三轮（Minor 轮）评审报告 ＋ brief（⚠️ brief 末尾有具名 ERRATUM，说明它误导过评审员）| `…/pointB-minors-review.md`、`…/pointB-minors-review-brief.md` |
| 第二轮（收尾轮）／第一轮（点 B 本体）评审 ＋ brief | `…/pointB-cleanup-review*.md`、`…/pointB-review*.md` |
| B 的裁决包 v2／v1（**v1 已过期，保留不改**）| `…/pointB-ruling-package-v2.md`、`…/pointB-ruling-package.md` |
| 点 C 裁决 ＋ presence-only 实测 | `…/pointC-design.md` |
| E1 的六份评审 ＋ briefs | `…/E1-review-*.md` |

---

## 人裁 101–108（**人亲自拍的，控制器一件都没替人宣布**）

| | 裁决 |
|---|---|
| **101／102／103** | 点 B 通过；C-1 记关闭；**E1 仍不拍**（I-2 那一格未裁未修）。 |
| **104／105** | 两轮 Minor ＋ 第三轮评审全部收尾。 |
| **人裁 106** | *** **三件同开**：(a) 开 I-3；(b) 给上一轮两笔再派独立评审；(c) 记台账。 *** ⇒ **(a) 是对红线函数的新授权**（人裁 83 的措辞不含返回类型改动）；**(b) 明示不适用人裁 100 的收口**。 |
| **人裁 107** | **指名**改写唯一那条既有判据：`tests/persistence/fileStore.test.ts` 的 `it("keeps a malformed lock without staged artifacts non-recoverable")`。 |
| **人裁 108** | 评审的 1 Important ＋ 3 Minor **全修**，**并采纳评审员建议 2**：`holder-alive` 改名 `not-determined-dead` ＋ 删死字段。 |

---

## 最近一次会话做完了什么（**都不要重做**，细节在台账 §39／§40／§41）

按提交主题行找（*** **别数笔数** ***）：

1. `docs(sdd): record section 39 -- human ruling 106 opens three, …`
2. `docs(spec): design I-3(b) …` ＋ `docs(spec): correct the spec's own mutation proof, which proved nothing, …`
3. `docs(plan): task-by-task implementation of I-3(b), …`
4. `feat(fileStore): tell the caller WHY a stale transfer lock could not be reclaimed (I-3(b), human rulings 106/107)`
5. `fix(resumeLoop): report an unattributable transfer lock as itself, not as a CAS failure (I-3(b), human ruling 106)`
6. `fix(runLoop): keep an unattributable transfer lock contained as a recorded contention (I-3(b), human ruling 106)`
7. `docs(sdd): record section 40 …`
8. `fix(fileStore): name the exit for what the two-state predicate actually computes, … (human ruling 108)`（含台账 §41 ＋ 评审报告 ＋ brief）

**做出来的东西**：红线函数的 `Promise<boolean>` 换成三态判别式
（`cleared` ／ `not-determined-dead` ／ `unattributable{why}`）；不可归属那两条出口抛新的**兄弟类**
`OwnerTransferLockUnattributableError`，消息带原因并指向 `ccloop unlock <runDir>`；五个消费点各自重决。
*** **人裁 83 的删锁条件逐格未变** ***（评审员用 75 行差分探针 ＋ 全量变异攻过，攻不破）。

⚠️ *** **写本文时，上面这些提交全部【只在本地】，远端未被推动。** ***
但**提交本文这个动作本身就会让本地再多一笔**，而且人随时会推。
⇒ *** **开工第一件事是自己现跑 `git ls-remote`，别信这一句。** ***
⇒ *** **凡已发布的文本，一律只能追加具名 ERRATUM** ***；未发布且本会话所写且从未为真的，才可就地改。

---

## ⛔ 下一件事 —— **无人裁待决；五件挂账，都要人先开口**

### 1. I-3(a) —— `readOwnerRecord` 会无限期返回转移前的旧记录
`recoverInterruptedOwnerTransfer` 的裸 `catch { return; }`。评审员称之为 *"the project's signature defect"*。
⚠️ *** **新的错误类在这条路上同样被吞掉，所以 I-3(b) 对 `readOwnerRecord` 路径无效。** ***
**不在人裁 106 措辞内，需新授权。**

### 2. `leaseHeartbeat.ts` 的两处吞（**最近一轮新查出**）
`runAffirm` 的 `if (!(error instanceof OwnerTransferPreconditionError)) return;` 与停止路径的 `catch {}`。
新类被吞 ⇒ **心跳每 tick 重试一把永远不会清的锁**，而那段注释的前提写着 `transient`。
⚠️ **比 I-3(a) 更刺眼：走进去的是最近一轮新造的类。** 同样需新授权。

### 3. E1 的 I-2 那一格（**未裁**）
数组 holder ＋ 死 pid ⇒ `inspectLock` 答 `dead` 而非 `unrecognized-holder`，于是 `unlockCommand` **无 `--force` 直接删锁**。
已在红线函数注释里记录为实测，代码一行未改（**E1 在授权面外**）。**人裁 103 不拍 E1 的理由就是这一格。**

### 4. Linux 从没跑过（**唯一的真覆盖缺口**）
本机 **OrbStack 的 docker CLI 在 `/usr/local/bin/docker`，daemon 实测未起**（socket 不存在）⇒ **要人自己开**（`! open -a OrbStack`）。
整套在 Linux 上本来就红 5 条，是**先于点 B 存在的包级缺口**。预估 $5–15。

### 5. 人裁 85 —— `ls` 也报锁
已立项挂账（「要，但另开一轮」）。与 I-3 是同一个病（操作员看不见锁），但**没有被人裁 106 一并打开**。

### ⚠️ 另一件未裁的
**人裁 108 那一笔自身没有再经独立评审。** 人裁 100 的递归收口理由适用（连续 0 Critical，
且本轮 Important 是文字准确性）—— *** **控制器建议援引人裁 100 收口，但破不破例是人的事，未裁。** ***

---

## 铁律与边界（**违反即事故**）

1. **四件需人单独授权**：开门／合并／删分支或 worktree／**push**。*** **控制器不许 push。** *** 非门合并一律 `--ff-only`。
2. **不许实施者自改判据。** **改既有判据**必须由人**指名到具体测试**（人裁 88 三条件：(a) 指名 (b) 整条改写不许放宽 (c) 改后写明编码的是哪条人裁）。人裁 107 就是这么给的。
   ⇒ **需要新覆盖时先想「能不能只加不改」** —— 人裁 99／104／105／106 全是这么绕开裁决的。
3. **不许替人宣布。** 101–108 全是人亲自拍的。
4. **`.superpowers/sdd/**` 里的历史记录一个字不改**；发现写错了，**在新一节里记更正**（§41 更正 §40 的普查错，就是这么做的）。
   `docs/handoff/**` 与 `docs/superpowers/**` 是活文档，可整篇重写，但**不得把已知为假的说法带下去**。
5. **注释铁律**：**就地改**只适用于**本会话自己刚写、从未为真、且未发布**的笔误；
   **已发布（`git ls-remote` 说了算）、或上一会话写的** ⇒ **原文逐字保留 ＋ 追加具名 `*** ERRATUM (…, HUMAN RULING N) … ***`**。
   - *** **erratum 里不许写新的、会被后续裁决推翻的计数** *** —— 指向台账即可。
   - *** **erratum 不许引用会移动的 git 引用**（「remote tip」「HEAD」）—— 它会和字节基线一样烂掉。 ***
   - *** **erratum 优先放在整个注释块的末尾** *** —— 插在中间会把隔壁段落的先行词推远（人裁 105 的 Mi-1）。
6. **变异只在 `git clone --local` 副本里**，主仓库工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**，
   `diff -r` **不是**还原证明（它看不见 index）。
   ⚠️ *** **副本是 clone【已提交】状态** *** —— 要测**未提交**的改动，必须先 `cat 工作树文件 > 副本对应文件` 再变异，
   并用 `diff` 证明两边逐字节相同。**最近一轮的控制器自己在这里栽过一次**（测了旧代码还差点得出错误结论）。
7. **绝不过滤验证性跑**（`grep`/`tail`/`head`/`sed` 都算，管道还会吞退出码）：重定向到文件、整份读回、核 vitest 第一行 `RUN` 指向的路径。
8. *** **成本只报工具给出的数，拿不到就说拿不到，不许自估。** ***

---

## 踩过的坑（**别再踩**）

1. *** **本机 `rm` 和 `cp` 都有 `-i` alias。** *** 普通 `rm -rf` 会**静默挂在确认提示上直到超时**；`cp` 会**静默拒绝覆盖**。
   ⇒ **一律用 `/bin/rm -rf` 和 `cat pristine > target`。**
2. *** **改注释要按【行号 ＋ 整行锚点】插入，插之前先断言那一行逐字相符。** *** 用 `str.replace` 的子串匹配会在句子中间切开段落。
   最近一轮全部编辑都走「断言命中数 ==1 否则退出」，**当场拦下过一次跑错代码的变异**。
3. **注释轮必须做全树扫描再动手，而且【扫描清单要从被更正的句子机械导出】。** 实测教训：第一轮改 12 漏 6；第二轮补 6 又漏 2。**半改比不改坏。**
4. *** **探针没被验证之前，它的输出不是证据。** *** 本包栽过三次：`timeout` 在 macOS 不存在被读成「无容器运行时」；
   `awk length()` 数字节被当成数字符（**并因此对前人发出过一条假指控**）；`clone --local` 只克隆已提交状态被当成克隆了工作树。
5. *** **「绿」本身可能是空的，连【证明】也会空。** *** 实测四次：红线函数改成永不被调用旧判据照绿；给锁加第二个读者计数判据照绿；
   **spec 里那条 M4 变异后判据照绿**；`.catch(e => e)` 在 promise 成功时给出 `undefined` 让三条断言全在断言 `undefined`。
   ⇒ *** **一条变异在被【看到】打红之前，它不是证明。** *** ⇒ **钉「什么都没发生」的判据必须配一条正向观测。**
   ⇒ **拿 rejection 一律用 `.then(onFulfilled, onRejected)` 并在 onFulfilled 里 throw，不要用 `.catch(e => e)`。**
6. **评审员的自陈要核，控制器自己的数字更要核。** 最近一轮实测：评审员两处不准
   （`ERR_OUT_OF_RANGE` 实为 `ERR_INVALID_ARG_TYPE`；一条 Minor **报小了**，它说只有 brief 有错，实际 spec 与台账同错）。
   ⇒ **报任何数字，连同口径一起报。**
7. *** **「为修复派评审」会无限递归** *** —— 人裁 100 的收口理由：连续两轮 0 Critical 且 Important 全是文字准确性时，
   继续递归买不到安全，只买字面完美。**下次要收口，援引人裁 100。**
   ⚠️ **但人主动指名要审时，人裁 100 不适用**（人裁 105、106(b) 都是这样）。
8. **spec／plan 的自查是真能抓东西的**：最近一轮自查共抓出 **6 条**缺陷（spec 3、plan 3），全部在落地前修掉，
   **一条都没漏到评审员手里**。评审员本人也把这条列为该轮最有价值的东西。**别跳过自查。**

---

## Suggested skills

| skill | 什么时候用 |
|---|---|
| `superpowers:verification-before-completion` | *** **每次要说「做完了／通过了／绿了」之前。** *** 本项目 Rule 12 与它同形 |
| `superpowers:brainstorming` | 动 I-3(a)／`leaseHeartbeat`／人裁 85 之前 —— 都有实质设计成分。⚠️ **它的 architectural 路径终点只能接 `writing-plans`** |
| `superpowers:writing-plans` | brainstorming 出 spec 之后。⚠️ **写完必须跑它的自查三项**（spec 覆盖／占位扫描／类型一致），最近一轮靠这个抓出 3 条 |
| `superpowers:executing-plans` | 执行计划时。⚠️ 它要求隔离 worktree，**但本仓库铁律 1 把「删 worktree」列为需人授权**，且历轮都直接在 `main` 上落本地提交 —— **CLAUDE.md 优先** |
| `superpowers:test-driven-development` | 补新判据时。⚠️ **本仓库的「先红」多数要靠变异证明**（钉现状行为的判据天然先绿）；但**引用尚不存在的符号时，真 TDD 是成立的** |
| `superpowers:requesting-code-review` | 派评审时；模板用 `…/i3b-review-brief.md`，**每个数字按现测更新，已知 flake 写满 4 条** |
| `superpowers:receiving-code-review` | *** 拿到报告之后。 *** ⚠️ **本项目额外要求：评审员的承重主张必须自己复核**，不许照单全收，也不许照抄它的数字 |
| `superpowers:systematic-debugging` | 出现测试红／行为不符时**先用它**，别直接改代码 |

⚠️ **skill 与本仓库 CLAUDE.md 冲突时，CLAUDE.md 优先**（Rule 11：conformance > taste）。

---

## 预算

最近一次会话**约 $135**（**工具报数**，含一名独立评审员 **156,724 tokens**），**远超 CLAUDE.md Rule 6 的每会话 400k**。
⚠️ **大动作（再派评审、动 I-3(a)、动心跳、跑 Linux）之前先跟人报一次预估**，且**只报工具给出的数**。
⚠️ **上一会话在实施中途报过一次预算超支并让人重新拍板** —— **这是对的做法，照做。**
