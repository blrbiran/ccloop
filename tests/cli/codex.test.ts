import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import type { AgentSelectionV1, AgentsTableV1 } from "../../src/agents/types.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
describe("Codex CLI",()=>{
  // Consolidation step 4 (spec 2026-10-01-retire-old-cli-entry-design.md §3.2, controller ruling C-2): the parse rows of
  // the removed `--adapter codex --adapter-config` form were replaced by the removal criterion in cli.test.ts. This one
  // is migrated: codex is reached from the CLI through `run --agents --agent-selection`, the installation carrying the
  // budgetMode the old adapter config carried. The selection file always holds the soft table's configHash, so for
  // `strict` the budgetMode is the only thing wrong on the command line.
  it.each(["soft","strict"])("executes the real CLI with %s config",async budgetMode=>{
    const f=await codexFixture();dirs.push(f.dir);const contract=join(f.dir,"contract.json"),tablePath=join(f.dir,"agents.json"),selectionPath=join(f.dir,"selection.json");
    const table=(mode:string)=>({schema:"ccloop-agents-table-v1",installations:{"codex-fake":{kind:"codex",command:[...f.config.command],version:"9.9.9-fake",configDir:null,timeoutMs:f.config.timeoutMs,killGraceMs:f.config.killGraceMs,sandbox:"workspace-write",budgetMode:mode}}});
    const selection:AgentSelectionV1={agent:"codex-fake",model:f.config.model,contextWindow:"agent-default"};
    const {resolution}=await resolveAgent(table("soft") as unknown as AgentsTableV1,selection);
    await writeFile(tablePath,JSON.stringify(table(budgetMode)),{mode:0o600});await writeFile(selectionPath,JSON.stringify({selection,configHash:resolution.configHash}),{mode:0o600});await writeFile(contract,JSON.stringify(f.contract));
    const cli=fileURLToPath(new URL("../../src/cli.ts",import.meta.url));
    const loader=fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs",import.meta.url));
    const result=await exec(process.execPath,["--import",loader,cli,"run","--contract",contract,"--run-dir",f.runDir,"--agents",tablePath,"--agent-selection",selectionPath],{cwd:f.dir,timeout:15000}).then(r=>({...r,code:0}),e=>({stdout:e.stdout,stderr:e.stderr,code:e.code}));
    if(budgetMode==="strict") {expect(result.code).toBe(1);await expect(readFile(f.marker)).rejects.toThrow();}
    else {expect(result.code).toBe(0);expect(result.stderr).toContain("soft");expect(JSON.parse(await readFile(join(f.runDir,"loop-state.json"),"utf8")).status).toBe("succeeded");expect((await readFile(f.marker+".calls","utf8")).trim().split("\n")).toEqual(["plan","execute","verify"]);}
  },30000);
});
