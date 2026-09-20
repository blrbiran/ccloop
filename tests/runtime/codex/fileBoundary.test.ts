import { closeSync, constants, openSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runCodexPhase } from "../../../src/runtime/codex/runCodexPhase.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { codexFixture } from "./fixture.js";

it("refuses a FIFO final without waiting for a writer after phase exit", async () => {
  const f = await codexFixture();
  const fake = join(f.dir, "fifo.cjs");
  await writeFile(fake, 'const {unlinkSync}=require("node:fs");const {execFileSync}=require("node:child_process");const out=process.argv[process.argv.indexOf("-o")+1];process.stdin.resume();process.stdin.on("end",()=>{unlinkSync(out);execFileSync("/usr/bin/mkfifo",[out]);process.stdout.write(\'{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}\\n\');});');
  const config = parseCodexConfig({...f.config, command:[process.execPath, fake], timeoutMs:500});
  const pending = runCodexPhase(config, {phase:"plan",prompt:"p",context:f.context});
  let timer:NodeJS.Timeout|undefined;
  try {
    const result = await Promise.race([pending.then(r=>r.reason), new Promise(resolve=>{timer=setTimeout(()=>resolve("test-watchdog"),1500);})]);
    if (result === "test-watchdog") {
      // Unblock the deliberate pre-fix FIFO read only after recording the failure.
      const root=join(f.runDir,"codex","1","plan"),[call]=await readdir(root);
      const fd=openSync(join(root,call!,"final.json"),constants.O_WRONLY|constants.O_NONBLOCK);closeSync(fd);
      await pending;
    }
    expect(result).toBe("io-error");
  } finally {clearTimeout(timer);await rm(f.dir,{recursive:true,force:true});}
},10000);
