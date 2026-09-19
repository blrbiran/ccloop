import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { codexFixture } from "./fixture.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
it("uses an object root for execute's structured output union",async()=>{
  const f=await codexFixture("partial");dirs.push(f.dir);
  expect(await new CodexAdapter(f.config).execute(f.context)).toMatchObject({completionStatus:"partial",tokenUsage:15});
  const dir=join(f.runDir,"codex","1","execute"),[call]=await readdir(dir);
  const schema=JSON.parse(await readFile(join(dir,call!,"schema.json"),"utf8"));
  expect(schema.type).toBe("object");expect(schema.anyOf).toBeUndefined();expect(schema.required).toEqual(["result"]);expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.result.anyOf).toHaveLength(2);
});
it("rejects extra envelope fields rather than discarding model usage",async()=>{
  const f=await codexFixture("envelope-extra");dirs.push(f.dir);
  await expect(new CodexAdapter(f.config).execute(f.context)).rejects.toThrow();
});
