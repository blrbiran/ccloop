# ccloop Handoff — **点 B 的所有评审发现已闭合；但「点 B 通过 / C-1 关闭 / E1 通过」三件仍【未拍板】**

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
rtk proxy npm test -- --run             # 期望 34 files / 602 tests，零 skipped
rtk proxy npm run typecheck; rtk proxy npm run build
```

⚠️ **验证性命令一律走 `rtk proxy`**；**判断远端只能 `git ls-remote`** —— `git status` 的 `ahead N` 是缓存 ref。
⚠️ *** **rtk 的过滤层会骗你**：`git status --porcelain` 空时它打印 `ok`，`git diff | wc -c` 把 0 字节报成 1 字节。
**任何还原证明／字节比较一律走 `rtk proxy git … > 文件` 再 `wc -c`。** ***

### 上一会话（2026-08-25）实测基线，未过滤整份读回、`RUN` 路径已核

- **`34 files / 602 tests`** 全绿**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0`
- *** **判据基线是 602** *** —— 601 是上一会话开工时的数，600 是点 B 之前的数
- *** **红线函数 `tryRecoverStaleOwnerTransferLock` = 3185 字节**，签名命中数 =1 ***
  **970 与 1558 两个旧基线都已作废**（人裁 83 授权改函数、人裁 94／97 授权改它体内的注释）
- ⚠️ *** **这份基线在负载下会 flake。** *** 同一份代码（非 `.md` 改动 0 行）连跑三次：**绿 → `2 failed / 600 passed` → 绿**。
  两条红都是 `Test timed out in 5000ms`，那一轮总耗时 28.93s 而绿的两轮是 17–19s。**两条单独重跑 103/103 全绿。**
  ⚠️ *** **这两条不在人裁 10 的 flake 名单里** ***，名单只有 `records env names only …` 与 `persists phase usage evidence…`：
  `runLoop > accounts an execute timeout that rejects after the abort as exhaustion`
  与 `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data`。
  ⇒ **看到红先看是不是这四条之一 ＋ 是不是超时 ＋ 总耗时是否异常，再单独重跑那个文件，别急着报回归。**
- ⚠️ **整套在 Linux 上【不绿】**（`5 failed / 593 passed`，第六位评审在别的轮次实测）；**点 B 相关的任何一格都没在 Linux 上跑过**

---

## 唯一可信进度源（**引路径，不要重新推导**）

`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` —— **人裁 10–100 全在里面**。
*** **上一会话新增 §32／§33／§34。§34 末尾「⛔ 下一件事」是下一会话的第一件事，逐字照做。** ***
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

## 上一会话做完了什么（**都不要重做**，细节全在台账 §32–§34）

按提交主题行找（*** **别数笔数** *** —— 提交本文这个动作本身就会加笔），**全部本地，一笔未 push**：

1. `docs(comments): record that parsePid's coercion widens the redline's "ONLY condition" (Mi-2, human ruling 94)`
2. `docs(comments): mark the near-duplicate malformed-lock test as kept on purpose (T2, human ruling 95)`
3. `docs(sdd): record section 32 …`
4. `docs(comments): correct the caller count and state what the coercion costs on the E1 path (I-1, I-2, human ruling 97)`
5. `docs(unlock): correct the seventh stale comment, the one that made this file contradict itself (I-3, human ruling 97)`
6. `test(fileStore): pin the array-holder coercion human ruling 94 chose to record rather than close (human ruling 99)` —— **判据 601 → 602**
7. `docs(sdd): file the cleanup-round review brief and the independent report`
8. `docs(sdd): record section 33 …`
9. `docs(unlock): close I-3b and both M-3 sites … (human ruling 100)`
10. `docs(sdd): record section 34 …`
11. `docs(handoff): rewrite for a fresh agent …` ＋ `docs(handoff): make this document obey its own rule …`
12. `docs(sdd): record section 35 …` —— 上面那条 flake 事实

**人裁 96 那轮评审的 3 条 Important 已全部闭合**，且**每一条都是控制器自己复核过才动的**（其中两条是控制器自己写错的事实）。

---

## ⛔ 下一件事 —— **只剩一件在人手上**

### 1. 点 B 是否通过 / C-1 是否记关闭 / E1 是否通过（**等人裁，控制器一件都没宣布**）

**控制器给过建议，人尚未拍板。建议原文与理由：**

- **建议点 B 通过**：人裁 83 关的两个出口**各有判据、各有变异红证**（评审员把守卫翻回 `pid !== null && isProcessActive`，
  602 条里只有 A 那条变红）；**两轮独立评审、不同评审员、0 Critical**；第二轮 3 条 Important 全是注释文字，已全闭合。
- **建议 C-1 记关闭**：**人裁 92 自己写下了关闭条件** ——「两半均已修 … 但 B 尚未独立评审，评审通过前不记作关闭」。
  该条件现已达成。不是放宽标准，是既定标准被满足。权威措辞见台账 §30。
- **建议 E1 仍不拍**：上一会话新发现 **I-2** —— 数组 holder 让 `inspectLock` 答 `dead` 而非 `unrecognized-holder`，
  于是 `unlockCommand` **无 `--force` 直接删锁**。这一格**未裁未修**（E1 在授权面外）。缺口未处置前宣布通过不自洽。
- **不建议把 Linux 当成点 B 的门**：整套在 Linux 上本来就红 5 条，那是**先于点 B 存在的包级缺口**，
  绑上去点 B 会永远悬着。**Linux 应单列成一件独立的账。**

### 2. I-3 —— 失败关闭之后，操作员看不见被永久卡住的锁（**挂账**）
控制器建议**并入人裁 85 那一轮**（`ls` 也报锁），不另开第三轮：**两者是同一个病**。
⚠️ **评审员说的"最小修法"并不小**：要区分「持有者还活着」和「锁不可归属」，
得让 `tryRecoverStaleOwnerTransferLock` 把**为什么返回 false** 告诉调用方，而它现在是 `Promise<boolean>`
⇒ **那是再动一次红线函数并改它的返回类型。** **有实质设计成分，建议新会话用 `superpowers:brainstorming` 起手。**

### 3. E1 的 I-2 那一格（**新账，未裁**）
数组 holder ＋ 死 pid ⇒ E1 无 `--force` 删锁。**已在红线函数的注释里记录为实测，代码一行未改**（E1 在授权面外）。

### 4. 仍开着的 8 条 Minor（**人裁 100 明确不再为它们派评审**）
M-1（C 提交信息记错文件与字符数）、M-2（第一轮注释轮 `docs(unlock): correct the twelve comments point B turned false` 甩出去的那句仍在 ERRATUM 之后）、M-4（`open(lockPath,"wx")`）、
M-5（A 缺正向观测）、M-6（T2 注释只挂在较弱那条上）、M-7（一处 freeze 主张只补了方向 erratum）、
M-8（pid namespace，与本轮无关）、M-9（无需动）。逐条描述见 `…/pointB-cleanup-review.md`。

### 5. Linux 从没跑过点 B（**唯一的真覆盖缺口**）

---

## 铁律与边界（**违反即事故**）

1. **四件需人单独授权**：开门／合并／删分支或 worktree／**push**。*** **控制器不许 push。** *** 非门合并一律 `--ff-only`。
2. **不许实施者自改判据。** 人裁 4 许可的是**补测试**；**改既有判据**必须由人**指名到具体测试**（人裁 88 三条件：(a) 指名 (b) 整条改写不许放宽 (c) 改后写明编码的是哪条人裁）。
   ⇒ **需要新覆盖时，先想"能不能只加不改"** —— 上一会话的 A 与人裁 99 那条都是这么绕开裁决的。
3. **不许替人宣布**：点 B 通过、C-1 关闭、E1 通过 —— 三件都没人拍板。
4. **`.superpowers/sdd/**` 与 `docs/handoff/**` 里的历史记录一个字不改** —— 它们记的是当时为真的事，改了就毁证。
5. **注释铁律的分界（人裁 98／100 立的先例）**：
   - **就地改**只适用于**本会话自己刚写、且从未为真**的笔误；
   - **已在远端历史里、或上一会话写的** ⇒ **原文逐字保留 ＋ 追加具名 `*** ERRATUM (…, human ruling N) … ***`**。
6. **变异只在 `git clone --local` 副本里**，主仓库工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**，
   `diff -r` **不是**还原证明（它看不见 index）。
7. **绝不过滤验证性跑**（`grep`/`tail`/`head`/`sed` 都算，管道还会吞退出码）：重定向到文件、整份读回、核 vitest 第一行 `RUN` 指向的路径。

---

## 踩过的坑（**别再踩**）

1. *** **本机 `rm` 和 `cp` 都有 `-i` alias。** *** 普通 `rm -rf` 会**静默挂在确认提示上直到超时**；`cp` 会**静默拒绝覆盖**。
   ⇒ **一律用 `/bin/rm -rf` 和 `cat pristine > target`。**
2. *** **`str.replace` 的子串匹配会在句子中间切开段落。** *** ⇒ **改注释时锚点要落在行边界上，改完必须核每个文件的最宽注释行**
   （现基线：`fileStore.ts` 101／`fileStore.test.ts` 103／`inspectLock.ts` 100／`unlockCommand.ts` 101／`inspectLock.test.ts` 101）。
3. **注释轮必须做全树扫描再动手。** 第一轮改 12 漏 6；第二轮补 6 又漏 2（其中一处让同一文件**顶部说 REFUSER、80 行后说 STEALER**）。**半改比不改坏。**
4. **评审员的自陈也要核，数字也不能照抄。** 上一会话两次实测出它的数与控制器的数不一致（M-1 的 153／137／125 三个数**没有一个能互相复现**）。
5. **别信"判据增量 = 0"这种条数指标。** 它在条数上准，却掩盖了一整个出口零覆盖 —— 那是第一轮 Critical 的成因。
6. *** **人裁 10 的 flake 名单不全。** *** 上一会话实测到名单外的两条也会在负载下 5000ms 超时（见基线段）。
   ⇒ **派评审时，brief 里的「已知 flake」清单必须把这两条也写上**，否则评审员会把它们当成真回归去追。
7. *** **「为修复派评审」会无限递归** *** —— 每轮修复都在制造新的未评审面。人裁 100 的收口理由：连续两轮 0 Critical
   且 Important 全是文字准确性时，继续递归买不到安全，只买字面完美。**下次要收口，援引人裁 100。**

---

## Suggested skills

| skill | 什么时候用 |
|---|---|
| `superpowers:verification-before-completion` | *** **每次要说"做完了／通过了／绿了"之前。** *** 本项目 Rule 12 与它同形 |
| `superpowers:systematic-debugging` | 出现测试红／行为不符时**先用它**，别直接改代码 |
| `superpowers:test-driven-development` | 补任何新判据时。⚠️ **本仓库的"先红"是变异证明**（钉现状行为的判据天然先绿），人裁 99 那条就是这么做的 |
| `superpowers:requesting-code-review` | 派评审时；模板用 `…/pointB-cleanup-review-brief.md`，**里面每个数字都要按现测更新** |
| `superpowers:receiving-code-review` | *** 拿到报告之后。 *** ⚠️ **本项目额外要求：评审员的承重主张必须自己复核**，不许照单全收，也不许照抄它的数字 |
| `superpowers:brainstorming` | 只在 I-3（人裁 85 那轮）真要动设计时 —— 那件值得一个满上下文的开局 |

⚠️ **skill 与本仓库 CLAUDE.md 冲突时，CLAUDE.md 优先**（Rule 11：conformance > taste）。

---

## 预算

上一会话烧了约 **$48**（其中独立评审员一人 **185k tokens**），**超 CLAUDE.md Rule 6 写的每会话 400k**。
⇒ **下一会话开局先看 Rule 6**，大动作（再派评审、动 I-3、跑 Linux）之前先跟人报一次预估。
