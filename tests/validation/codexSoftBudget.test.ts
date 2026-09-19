import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// @ts-expect-error Standalone JavaScript harness.
import { runValidation } from "../../scripts/validate-codex-adapter.mjs";
it("accepts the controller's zero-clamped soft budget and records the overrun",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"codex-soft-budget-"));
  try {
    const bin=join(dir,"fake-codex"),output=join(dir,"evidence");
    const fake=new URL("../fixtures/fake-codex.mjs",import.meta.url);
    await writeFile(bin,`#!${process.execPath}\nif(process.argv.includes("--version")){console.log("fixture");}else{process.argv=[process.execPath,${JSON.stringify(fileURLToPath(fake))},"high-usage",${JSON.stringify(join(dir,"marker"))},...process.argv.slice(2)];await import(${JSON.stringify(fake.href)});}\n`);await chmod(bin,0o700);
    expect(await runValidation({codex:bin,model:"fixture",output})).toBe(0);
    expect(JSON.parse(await readFile(join(output,"summary.json"),"utf8"))).toMatchObject({tokenUsage:120000,softBudgetOverrun:20000});
  }finally{await rm(dir,{recursive:true,force:true});}
},30000);
