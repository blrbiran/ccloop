# 包 2 修复环第二轮 —— scoped 再评审 brief（**又换一个人**）

> 你是**第三个人**：既没实施、也没做第一轮评审。**scoped** = 只看第二轮 `c2db9c7..HEAD`，
> 外加「有没有把第一轮已 ADDRESSED 的东西弄坏」。
> *** **不接受实施者自证。** *** 实施报告「第二轮」那节的每条承重结论都是待检验的断言。

## 0. 工作区与落盘协议（先做，做完再检索）
- `/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-wbfix`（分支 `feat/pkg2-wb-fixes`，已 `npm ci`）。
  ⛔ 不碰主仓库；⛔ 不 commit / push / 建删分支 / 合并；⛔ **不得留下未还原的改动**
  （变异后同时验 `git diff` 与 `git diff --cached` 为 0 字节）。⛔ **你不修任何东西，只报。**
- 报告：`.superpowers/sdd/2026-08-07-pkg2-data-loss/wbfix-rereview.md`。
  **立刻** `Write` 骨架落盘，之后每次 `Edit` 只填一节，**结论最先填**。

## 1. 你必须自己实测的七件事

1. **C-1 的三条硬条件**（实施者自报：基线 140 lost updates / 修后 0 / 修后构建上的必命中对照 10 / 必不命中 0）。
   探针在 `.superpowers/sdd/2026-08-07-pkg2-data-loss/probe-c1/`。**自己跑，并且自己判断这个探针测的到底是不是互斥**
   —— 实施者**自己丢弃过第一版探针**，因为它的必不命中对照开火 4364 次（测成了调用交错）。
   *** **第二版是不是也测错了？这是你最该怀疑的一格。** ***
2. **退回两步发布的那条判据**：是否**红在断言**（不是异常/超时）？还原是否绿？
3. **人裁 50 的红线**：`tryRecoverStaleOwnerTransferLock` 与 `release()` 相对 `c2db9c7` 是否**逐字节未动**？
   （控制器已验为真，**你独立再验一次**。）
4. *** **任务 2 的举证** ***：gaps 05–13 在两个夹具里是否**真的**都落到完全提交的三文件终态、
   且与套件本来就接受的 gap 14 **同形**？**自己造证据，不要引用实施者的快照。**
   ⚠️ **这是本轮最贵的一格**：改那 18 行 = 断言「accepted 是正确行为」。
   本仓库 2026-08-02 那次 Human ruling 杀掉的就是「把一条 damaged trajectory 钉成正确行为」。
5. **9+9 拆分**（9 行是缺陷自产的假拒绝、9 行是真正的新增许可）与 **S-3 的逐句指认**是否成立？
   立场原文在 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`。
   实施者称本次**只**动「只增加拒绝，绝不新增许可」，**不**动「reconciliation 缺失即拒绝的 fail-closed 必须保留」。**核它。**
6. **人裁 55 的回退**：`fileStore.test.ts` 的 `vi.mock("node:fs/promises")` 工厂是否**真的**回到基线原样？
   新的局部 `doMock` seam 是否**行为中性**？2.2 那两条判据 `3→1` 是否仍**红在断言**、还原是否绿？
7. **零新破坏**：全套件 ＋ typecheck ＋ build（`rtk proxy`、未过滤、整份落盘整份读回、核 `RUN` 路径）。
   实施者自报 `31 files / 531 tests / 三个退出码 0`。**不继承。**
   **并逐文件比对计数**（相对基线 `dbac288` 的 31/524），确认没有既有测试被删。

## 2. 两件要你专门判的

**(A) 一个待人裁的夹具改动**：`fileStore.test.ts > … two concurrent unlocked readers racing the same marker`
原本 hook `open(lockPath)` 来暂停 reader A；原子发布之后**永远不会 open 锁路径**，该测试遂按自己的超时红掉。
实施者把 hook 移到 `link`，**声称没改任何断言、原 hook 与原理由逐字引在旁**。
⇒ **你判**：移位之后它**还在测同一个不变量**吗？暂停点是不是同一时刻（锁已完整落盘、A 仍在自己的临界区内）？
**有没有实质上放松了它？** ⚠️ 本仓库有 **人裁 17 的先例：改夹具 ≠ 改判据**，但那是**具名**授权的。**这一处尚未授权，人正在裁。**
⚠️ 顺带：这条测试正是 Lane 2 查出「夹具明文绕开 0 字节窗口、注释称其 unrelated」的那一条。

**(B) 控制器读出的一处边角，实施者没提**：`link(stagingPath, lockPath)` 成功之后那句
`await safeUnlink(stagingPath)` —— `safeUnlink` 只吞 ENOENT。若它抛别的 errno，
**锁已经发布，但函数带着异常出去，调用方拿不到 release** ⇒ **泄漏一把锁**。
而泄漏的锁在生产侧是静默的（`ensureFreshRunDir` 的 `blockingPaths` 不含 `.owner-transfer.lock`）。
⇒ **你判**：这条路径可达吗？是新引入的还是既有形状？该不该本轮修？**给可构造场景或说明为什么不可达。**

## 3. 铁律
**验证跑绝不过滤**（`grep`/`tail`/`sed` 同罪，过滤显示与过滤落盘同罪）／**坏探针不能证明「不存在」**（放必命中 sanity 探针）／
*** **读代码的机械论证不等于实测** ***／`rtk proxy` ＋ `ECC_GATEGUARD=off DISABLE_OMC=1`／
**锚点用符号名或完整测试名，不用行号**／*** **finding 与处置建议分开写** ***，并明说是否应本轮修／**Rule 12 fail loud**。
允许的红只有 flake (B)/(F) 与三条已挂账项（人裁 10 那条、`waits for close before interrupting…`、`rejects unknown verdicts and diagnoses`）。**其余一律按新缺陷处理。**

## 4. 骨架
```
# 包 2 修复环第二轮 —— scoped 再评审
## 0. 结论（最先填：ADDRESSED / NOT ADDRESSED / 有无新破坏 / 有无越界）
## 1. 我自己的全套件与逐文件计数比对
## 2. C-1 三条硬条件的独立复现（含"这个探针到底测的是不是互斥"的判断）
## 3. 人裁 50 红线核验
## 4. 任务 2：逐 gap 举证的独立复核 ＋ 9+9 拆分 ＋ S-3 逐句核
## 5. 人裁 55 回退与新 seam 的行为中性
## 6. 专判 (A) 夹具 hook 移位　(B) staging unlink 的泄漏路径
## 7. Findings（分级，finding 与处置建议分开）
## 8. 变异与还原证明
## 9. 没验到的
## 10. 预算：可数事实（不要自报估计）
```
