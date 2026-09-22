## Task 3: 在 `unlock` 命令这一层钉住「锁没有被删」

**Files:**
- Test: `tests/unlock/unlockCommand.test.ts`（**只加判据，不动生产代码**）

**Interfaces:**
- Consumes: Task 2 的 `LockInspection.holder` 新语义；Task 1 的 `parsePid` 守卫。
- Produces: 无。

⚠️ 这一条与 Task 2 的 N1 **不是重复**：N1 在库层钉分类，本条在命令层钉**后果** ——
只有它能看见「锁文件还在盘上」和「退出码是 1」。

- [ ] **Step 1: 写判据**

在 `tests/unlock/unlockCommand.test.ts` 最外层 `describe` 末尾（最后一个 `});` 之前）加入：

```ts
  it("refuses an ARRAY holder that String()s into a dead pid, and leaves the lock exactly where it was", async () => {
    // HUMAN RULING 127 (2026-09-23), I-2. This cell used to exit 0 and DELETE, with no --force and
    // no --expect digest, because the inspection answered "dead" for a holder nobody could
    // attribute. This file's header says it plainly: this file is the only thing standing between
    // a new delete surface and no supervision.
    const runDir = await makeRunDir();
    const contents = JSON.stringify({
      holderProcessInstanceId: [`pid:${DEAD_PID}`],
      acquiredAt: "2026-09-23T00:00:00.000Z",
    });
    await seedLock(runDir, contents);

    // The existence assertion this file requires before every deletion assertion: without it,
    // "the lock is still there" would pass against a run directory where it was never created.
    expect(await lockExists(runDir)).toBe(true);

    const { code, out, err } = await run(runDir);

    expect(await lockExists(runDir), "an unattributable holder's lock was deleted").toBe(true);
    // Byte-for-byte, not merely present.
    expect(await readFile(join(runDir, OWNER_TRANSFER_LOCK_FILE), "utf8")).toBe(contents);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    // The PREFIX only. The holder's rendering has its own criterion in inspectLock.test.ts, and
    // pinning the whole line here would make the rendering mutation go red in two places, so
    // neither place could be shown to carry its own branch.
    expect(err[0]).toMatch(/^refused  unrecognized holder identity: /);
  });
```

- [ ] **Step 2: 跑它，确认【绿】—— 并解释为什么这次不先红**

```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/unlock/unlockCommand.test.ts > /tmp/i2-t3.txt 2>&1; echo "RC=$?"
```
Expected: `RC=0`，**33 tests**（原 32 ＋ 新 1）。

⚠️ *** **这一条是在生产改动【之后】写的，所以它现在就绿 —— 光凭这次跑，它【不是】判据。** ***
它的红证由 **Task 5 的 M1** 提供：删掉 `parsePid` 的守卫，这一条必须变红。
**Task 5 没看到它红之前，不许在任何地方说它钉住了什么。**

- [ ] **Step 3: 提交**

```bash
/usr/bin/git add tests/unlock/unlockCommand.test.ts
/usr/bin/git commit -m "test(unlock): pin that an unattributable holder's lock survives the default path

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```

---

