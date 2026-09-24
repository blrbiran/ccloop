# ccloop Handoff — *** **G1 缝 A（capability 词汇表）已做完（2026-09-24）** ***；**下一件事归人：先推 ccloop、再推 Orca，然后裁缝 B**

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
rtk proxy npm test -- --run             # 期望见下方「2026-09-23 现测」一段，不是 35/624
rtk proxy npm run typecheck; rtk proxy npm run build
```

⚠️ **验证性命令一律走 `rtk proxy`**；**判断远端只能 `git ls-remote`** —— `git status` 的 `ahead N` 是缓存 ref。
⚠️ *** **`ls-remote` 的结果只在它跑出来的那一秒为真** —— 开工一次、收尾一次，中间做过判断就再来一次。 ***
⚠️ *** **rtk 的过滤层会骗你**：`git status --porcelain` 空时打印 `ok`，`git diff | wc -c` 把 0 字节报成 1 字节，
长 grep 截断成「[+N more]」，含括号的正则直接报错。
**任何还原证明／字节比较／整份读回一律 `rtk proxy … > 文件` 再 `cat`／`wc -c`；读大文件用 `sed -n 'a,bp'` 或 python，不要用 grep。** ***

### 2026-09-23 现测（**本轮收尾**）—— *** **开工核对里那个期望值早已过期，以本段为准** ***

命令 `./node_modules/.bin/vitest run`（`ECC_GATEGUARD=off DISABLE_OMC=1`，重定向到文件再整份读回）。
**观测锚点** ＝ 提交主题行 `docs(sdd): append the post-review correction section to final-fix-report.md` 那一笔。

- *** **现测 `818 tests / 817 passed / 1 failed`。** *** `typecheck` RC 0、`build` RC 0。
- 🔴 *** **已知红名单是 13 个名字，不是 7 个。** *** 本轮实测把它从 7 补到 13 —— 多出来的 6 个
  **一直都在 flake，只是没人把名字记下来**，于是判别式会把它们误报成回归。
  ⇒ **不要再靠肉眼核名单**：跑 `node scripts/check-known-reds.mjs <vitest --reporter=json 的输出>`，
  它按**全名**做子集判定，RC 0 才算绿。**该脚本两个方向都验过**（名单内退 0、名单外退 1、
  以及「名字是某条名单项的裸后缀」这种伪装也退 1）。
- ⚠️ *** **那条稳定红仍然红着**：`tests/control/stopProof.test.ts > quiet execution proof >
  does not treat leader exit as group quiet and proves only after the full tree is gone`。
  根因未查，无人授权动它。** ***
- ⚠️ *** **`git clone --local` 副本必须先 `npm run build`** *** —— `dist/` 被 gitignore，
  不 build 会让 `tests/control/endToEnd.test.ts` 的 6 条以 `ENOENT … dist/cli.js` **假红**。
  ⚠️ **副本一律建在会话 scratchpad 目录下，不要建在仓库旁边**（人裁 137）。


### 2026-08-28 那一次会话的实测基线 —— 未过滤整份读回，`RUN` 路径已核

⚠️ *** **它已经不是「最近一次」了** *** —— P0 那一轮（2026-09-04）之后的现行基线见下一条与文末「📌 Orca 那条线」。
本段其余内容（四条已知 flake、红线函数字节数口径、Linux 上不绿）**原样有效**。

- *** **`35 files / 614 tests`** *** 全绿**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0`，耗时 17.58s
  （**收尾时在最终树上重跑过一次**，不是引用会话中段的数）
- *** **判据基线现在是 624（P0 那一轮 +10，2026-09-04 现测）。614 及此前的 613／609／604／603／602／601／600 全部作废。** ***
  ⚠️ **本行原文是「判据基线是 614」，由 P0 那一轮就地更正** —— 活文档不得把已知为假的说法带下去（铁律 4）。
  614 仍然是**那一次会话（2026-08-28）的实测值**，下面这一段整段保留不动。
  ⚠️ *** **「现在是 624」这句已由 2026-09-23 现测的 `56 files / 771 tests` 取代**（见上一段）。 ***
  624 是 **2026-09-04** 的值，作为历史实测保留。
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

### 0. ✅ **P0（2026-09-04）／E1 的 I-2（2026-09-23，人裁 127／128）／I-3(a)（人裁 125）都已收口 —— 不要重做**

### 0.1 ✅ *** **人裁 85（`ls` 也报锁）＋ I-3 也做完了（2026-09-23，人裁 129–138）—— 不要重做** ***

两件合并为一轮（人裁 129）。**做出来的东西**（按提交主题行找，**别数笔数、别记哈希**）：

- `ccloop ls` 现在为每个 run 报告 owner-transfer 锁的**全部七态**
  （`absent`／`dead`／`alive`／`liveness-unknown`／`unrecognized-holder`／`unparseable`／`file-unreadable`），
  带 holder、pid、**全长 sha256 digest**、以及下一条命令。
  ⚠️ `file-unreadable` **不印 digest**（它是唯一拿不到 `--force --expect` 凭证的态），
  `absent` **不印 next**，而且**这两种都仍然 exit 0** —— 一行里的坏消息是报告内容，不是命令失败。
- 红线函数的 `not-determined-dead` 拆成了 **`holder-alive`** 与 **`liveness-undetermined`**。
  `pid:0`、越界 pid、EPERM 三格现在抛 `OwnerTransferLockLivenessUndeterminedError`，
  消息**点名 pid 与理由**，并且**不说「永不自清」** —— 因为 EPERM 的持有者通常是别人的活进程。
- ⚠️ *** **人裁 83 的删锁条件逐字节未动。** *** 全函数仍只有一处 `safeUnlink`，
  仍只有 `dead` 那条 fallthrough 能到，**新增的两格一个都不删东西**。
- ⚠️ *** **三处重试闸门各加了一支，接住新错误类 —— 这是为了【保住】今天的行为，不是改它。** ***
  那三格今天本来就走满重试预算；不加闸门它们会变成第一次尝试就放弃。
- ⚠️ **但有一处行为确实变了**：一把**瞬态的 EPERM 锁**现在会在 `readOwnerRecord` 的逃逸点
  就地放弃本次尝试，而以前它会让 run 带着 pre-transfer 记录继续。**这是 I-3(a) 的既定方向、有判据覆盖，
  但它是常见情形上的真实行为改变**，不要读成「什么都没变」。

**细节**：spec `docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md`（§10／§11 记着
**18 条被实测推翻的初版结论**）、计划 `docs/superpowers/plans/2026-09-23-ls-lock-visibility.md`、
台账 `.superpowers/sdd/2026-09-23-ls-lock-visibility/progress.md`（含 43 行变异总表，全 64 位 sha256）。

### 1. ✅ *** **G1 缝 A 已做完（2026-09-24，Orca 控制器会话 `9c9f7f5f`）—— 不要重做** ***

**本仓库只有一笔**：`feat(control): answer the v2 eight-field capability vocabulary`（落在 `main`）。
`control capabilities` 现在答 `protocol: 2` 的八字段：`usageObservation:"phase-end"`／`budgetEnforcement:"soft"`／
`contextObservation:"unavailable"`／`handoffControl:"durable"`／`handoffExecution:"mechanical-in-run-v1"`／
`contextWindowTokens:null`／`requestBoundProof:null`。`durableAccept`／`ownershipIsolation`／`evidenceRetention`
**删掉了，没有东西替代它们**（三个恒 `true` 的字面量，Orca 侧对应的三道闸门也一并删了）。
`budgetEnforcement` 的第三值 `unsupported` → `unavailable`。
- 既有判据 `tests/control/command.test.ts` > `routes the real CLI through control … emits one JSON value`
  **由人 2026-09-24 授权整条改写**（人裁 88 形状），`toEqual` 钉死八字段。
- 变异：M1（`protocol` 2→1）、M2（多答一个字段）都红，但**红在 `result.code`**（本仓库自己的 strict 响应 schema 先拒）；
  控制器补跑 M2b（放开 `.strict()` ＋ 多答字段）才看到 **`toEqual` 本身红**（第 115 行）。
  ⇒ *** **「红在哪条断言」又一次不是 `toEqual` 本身 —— 要单独打它的变异。** ***
- 2026-09-24 现测（该笔之上，`ECC_GATEGUARD=off DISABLE_OMC=1`，json reporter）：`check-known-reds.mjs` **RC 0**
  （名单 13 / failed 1 / unexpected 0，唯一的红仍是 `stopProof`）；typecheck RC 0；build RC 0。

**Orca 侧的五个 Task 也都做完了**（细节在 Orca 仓 handoff §四 与台账
`.superpowers/sdd/2026-09-24-g1-capability-vocabulary/progress.md`，那个台账是这一轮的唯一进度源）。

⚠️ *** **G1 是两条独立的缝（结论未变）：缝 A 做完了，缝 B（`targetVersion` 类型分叉）被人裁排除、没做。** ***
Orca `webCcloopSmoke` 那两条 `start-envelope-conflict:run:targetVersion` **仍然红，且应该红**。
⚠️ **ccloop 侧改动落在 `main`，不在 `codex/codex-adapter-0919`**（那个分支落后 10142 行，结论未变）。
⚠️ `handoffControl = "durable"` 的依据（handoff 两态 `latched`/`complete`、经 `atomicReplacePrivateFile` 落盘、带 `testCrashPoint`）见 spec §5。
⚠️ `handoffExecution = "mechanical-in-run-v1"` 那一格**推翻过一次**（`src/control/handoff.ts` 构造 packet 那段全是 `runState` 的三元表达式、零模型调用），经过在 spec §10，别再按「adapter 能跑模型」去推。

### 1.1 ⛔ 下一件事（**都归人**）

1. 🔴 *** **推送顺序：先推 ccloop（上面那一笔），再推 Orca。** *** 2026-09-24 现测：Orca 远端已被推到
   要求 `protocol: 2` 的那一笔（本会话**没有任何一席跑过 `git push`**），而本仓库远端仍答 `protocol: 1`
   ⇒ **已发布的两个 main 此刻对不上线**，任何一次 `capabilities` 调用都会得 `control-response-invalid`。
2. **缝 B 要不要做、`targetVersion` 拍成什么** —— 下游是 Orca 的 `planFile.ts`（人写的 plan 文件格式），人裁排除过，需要人重新开口。
3. `capabilities` **计算化**（人裁「分两步」的第二步）—— 到那时 `requestBoundProof` 才会非 `null`，见下表第一行挂账。

### 2. 仍然挂着的

| 挂账 | 现场 |
|---|---|
| **`stopProof` 那条稳定红** | 根因未查，**要人先开口**。判别过程：副本单跑 3/3 红、主树也红、单跑 5.37s（远低于 flake 画像 25–29s） |
| **Linux** | 整套在 Linux 上本来就红 5 条（先于点 B 的包级缺口）；本机 OrbStack daemon 实测未起。**要人自己开** |
| **M3（本轮登记，未修）** | 一把锁若**同时**是 liveness-undetermined 且带 transaction marker，会记**两条** `owner_transfer_contended`，而所有判据都断言一条。**形状是既有的**（unattributable 那支一模一样），但新错误类让它从一个**平常得多**的起因就能到达 |
| **M4（本轮登记，未修）** | `tests/registry/zeroWrite.test.ts` 的 `snapshotTree` **不记录扫描根自身的 mtime** ⇒ 探测若 touch 了根目录仍然隐形 |
| **descriptor 维度偏松（G1 挂账）** | `src/control/command.ts` 的 `requestBoundProof.workDimensions／handoffDimensions` 是 `z.array(z.string())`，Orca 侧是「排序、去重、四值枚举」。今天恒 `null` 不触发；**将来一旦非 null 且维度写错，Orca 会整条拒收（fail closed，但连 soft 组也会被挡）**。计算化那一步要一起收紧 |

⚠️ M3／M4 都**要改既有判据**，需人按**人裁 88** 指名，故本轮只登记不修。

### 3. 方法论（**前七条是历轮攒的，仍然活着；后五条是本轮新的**）

**历轮攒下的（不要因为压缩就丢掉）：**

1. *** **「红在哪条断言」不是可靠的判别方式** *** —— 前面的断言会先短路。
   **要量什么就直接量什么**（定向探针打印值）。
2. *** **「没跑过的那条变异」不是证据。** *** 八条变异看着完备，`stop()` 那一支只被别的分支的
   变异间接掠过，结果它**删掉全套照绿**。⇒ **每新增一个分支，点名那条删掉【它自己】的变异，
   并确认它存在且被看见红。**
3. *** **改写判据时，断言的【位置】和它的【文字】一样承重。** *** 有一处三条断言一字未改、只是顺序变了，
   其中一条就此不再观测任何生产行为。**「逐字保留」≠「承重保留」。**
   ⇒ 一条不跑变异就能查的形状：*** **排在被测调用【之前】、读回测试自己刚写进去的值的断言，
   永远不可能红。** ***
4. *** **一笔提交里的两处注释可以互相打脸。** *** ⇒ **写完注释做一次「同一事实在别处怎么说」的对照。**
   ⚠️ **本轮又栽了一次**（见下面第 10 条），所以这条不是历史，是现行。
5. *** **一个变量同时承担「被判断」和「被展示」时，任何一端的规范化都会【静默解除】另一端的守卫。** ***
   E1／I-2 那轮：把「渲染成 `JSON.stringify`」贴在既喂分类又喂显示的变量上，于是类型守卫在那条路径上
   **完全不承重 —— 删掉它行为一格不变、全套零红**。⇒ **修法是拆成两个变量；
   判别办法是删掉你新加的那个守卫，看行为变不变。**
6. *** **`grep` 配 `$'\x00\|…'` 在 bash 里会在 NUL 处截断参数** *** ⇒ 模式变空串、**命中每一行**，
   报出的数正好等于文件总行数。**扫控制字节一律用 python 直接读字节。**
7. *** **扫描词从英文源码机械导出，对中文活文档恒零命中。** *** 曾有一轮全树扫描**范围覆盖到了**
   中文 handoff 却一条都没捞到。⇒ **导出扫描词时要覆盖语料的语言。**

**本轮新的：**

8. *** **「别人会接住」本身就是一条预言，而预言会错。** *** 本轮**四条**红预言被实测推翻，
   最贵的一条是「这两处闸门的变异由另外两个 Task 的判据接住」—— **实测零红**，只好另写两条判据。
   ⇒ **跨 Task 的红证必须在两个 Task 都落地后真的重跑一次。**
9. *** **护栏自己也有盲区，而盲区看起来和「通过」一模一样。** *** 零写证明用的 `snapshotTree`
   **从来没记过目录的 mtime**，于是「探测时 touch 了 run 目录」这条变异**跑出全绿**。
   ⇒ **补护栏时先写一条打它盲区的变异。**
10. *** **erratum 里不许写计数。** *** 本轮自己犯了：一条 erratum 写「不再适用于三格中的两格」，
    实测是**三格全部**，而**同一段的下一句自己就说了三格**。**点名，不要计数。**
11. *** **在「关闭某类缺陷」的那一波里顺手多修一处，正是新引入该类缺陷的地方。** ***
    上面第 10 条就是这么来的 —— 那处修改不在命名的发现清单里。**看见了就报，不要顺手修。**
12. *** **扫描器要有【必抓】和【必不抓】两组样本，而且要跑到收敛。** *** 一个结构判据本轮修了三轮：
    单行解析 → 被续行注释里的分号截断 → 必不抓样本本身是空判据（删掉整个机制它照绿）。

⚠️ **人裁 125 的引用方式（未变）**：它是**人主动开的一个例**，不是人裁 100 的适用
（人裁 100 要「连续两轮 0 Critical」，而那次首审有 1 Critical）。**以后引用引人裁 125 本身。**

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
# 📌 Orca 那条线（**单节滚动更新，2026-09-24 第二版**；整节替换上一版，**不追加子会话日志**）

⚠️ **本节不写任何哈希、不记发布状态** —— 提交本文这个动作就会移动 HEAD，人也会自己推远端。
指代某一笔引**提交主题行**；判发布只跑 `/usr/bin/git ls-remote origin refs/heads/main` 与本地比。

## 本仓库该知道的四件

1. *** **G1 缝 A 做完了**：本仓库一笔（见上文「下一件事 §1」），Orca 五笔跟随 ＋ 修复。 ***
   spec／计划仍在本仓库 `docs/superpowers/{specs,plans}/2026-09-24-g1-*`，**未改**；执行中的全部裁定记在 Orca 台账。
2. 🔴 *** **推送必须先 ccloop 后 Orca**（上文 §1.1），否则已发布的两边线上契约不一致。 ***
3. **G1 是两条独立的缝**（结论未变）：修好 A 不会让 Orca 那两条 `targetVersion` 判据回绿，那是缝 B。
4. ⚠️ **G1 的边界仍然写死**：只有 ccloop↔Orca 的线上契约归 ccloop —— control 方法集、capability 词汇表、
   start envelope、usage／evidence 的形状与版本。*** **Orca 的 `work item`／`group`／`orca-raw-command-v1`／`expectedRevision` 一律不搬过来。** ***

## 给本仓库留下的环境事实（**直接用，别再反推**）

- *** **已知红是 13 个名字，用 `node scripts/check-known-reds.mjs` 机械判。** *** 2026-09-24 G1 那一笔之上现测 RC 0。
- 🔴 *** **`/tmp` 会被 macOS 周期清理吃掉整棵树** *** ⇒ 副本一律 `git clone --local` 到会话 scratchpad（人裁 137），**必须 `npm run build`**
  （`dist/` 被 gitignore，不 build 会让 `tests/control/endToEnd.test.ts` 以 `ENOENT` 假红）。
  `/private/tmp/ccloop-codex-0919` 那个 `prunable` 的 worktree 注册项**没人动过，删它是 Tier 0**。
  ⚠️ *** **在副本的 `main` 上 `git pull` 会被 Orca 的 Tier 0 闸门拦下**（算「合并进 main」）⇒ 要新版本就**重新 clone 一份到新目录**。
- ⚠️ Orca 的 `ORCA_CCLOOP_ADAPTER_CONFIG` 路径必须 `realpath` 等于自身 ⇒ macOS 上写 `/private/tmp/…`。
  🔴 *** **它必须指向本仓库的 `tests/fixtures/fake-codex.mjs integration <marker>`，不能指向真 `codex`** *** ——
  Orca 的 `ccloopProtocol.integration.test.ts` 会真的驱动 adapter 跑一次 run（本轮先用真 codex 配置跑出一条额外红才发现）。

## 本轮实测出来、本仓库也用得上的四条

- 🔴 *** **「守卫恒假」不等于「没判据覆盖」** *** —— 中间隔着夹具（判据用的是合成对象，不是对端应答）。结论未变。

- 🔴 *** **`grep` 会静默漏行且不打截断提示** *** ⇒ 清点消费者一律 python 直读（结论未变）。
- 🔴 *** **「红在哪条断言」不可靠 —— 本轮在两个仓各栽一次**：本仓库 M1／M2 红在 `result.code` 而非 `toEqual`；
  Orca 的终点判据被同一个守卫在更早一步拦下。 *** ⇒ **要证哪条断言承重，就单独造一个只有它能接住的变异。**
- 🔴 *** **子代理会在注释里替人签名。** *** Orca 侧一席把控制器裁定加的判据注释成「Human authorization」——
  **归属行要么派发里说死，要么收货时逐条核。**

## awaitingHuman

- 🔴 **推送顺序：先本仓库，再 Orca。** 控制器不许 push。
  ⚠️ 上一轮登记的仍然有效：**这台机器上有东西在把提交推到真实 GitHub 远端**（三个仓同一个 `post-commit` 钩子，调混淆过的二进制）——
  本轮 Orca 就在会话中途被推了一次，**本会话没有任何一席执行过 push**。**要人自己查并决定。**
- **缝 B 是否开、`targetVersion` 拍成什么** —— 仍未裁。
- **`stopProof` 那条稳定红的根因** —— 未查，要人先开口。
- **Linux 覆盖** —— 仍挂着，要人自己起 OrbStack daemon。
- **M3／M4**（见上文 §2）—— 要改既有判据，需人按人裁 88 指名。
