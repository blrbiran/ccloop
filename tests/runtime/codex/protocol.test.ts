import { describe, expect, it } from "vitest";
import { decodeCodexResult, parseCodexConfig, phaseJsonSchema } from "../../../src/runtime/codex/protocol.js";

const config = { command: [process.execPath], model: "fixture; touch nope", budgetMode: "soft", sandbox: "read-only", timeoutMs: 1000, killGraceMs: 10 };
const final = JSON.stringify({ summary: "inspect target", primaryTargetPaths: ["answer.txt"] });
const event = (usage: unknown) => JSON.stringify({ type: "turn.completed", usage }) + "\n";
const good = event({ input_tokens: 12, cached_input_tokens: 8, output_tokens: 3 });

describe("Codex protocol", () => {
  it("accepts model as data and validates all config fields", () => expect(parseCodexConfig(config)).toEqual(config));
  it.each([
    {command: []}, {command:["codex"]}, {model:""}, {model:" "}, {budgetMode:"strict"},
    {sandbox:"danger-full-access"}, {timeoutMs:0}, {timeoutMs:1.5}, {killGraceMs:-1}, {extra:"oops"},
  ])("refuses invalid configuration %j", (change) => expect(() => parseCodexConfig({...config,...change})).toThrow("codex-config-invalid"));
  it("counts cached input once, identical repeated completion once, and preserves evidence", () => {
    expect(decodeCodexResult("plan", good + good, final)).toEqual({
      summary: "inspect target", primaryTargetPaths: ["answer.txt"], tokenUsage:15,
      usageEvidence: {usageStatus:"present", fields:{input_tokens:{status:"finite",value:12},output_tokens:{status:"finite",value:3},inputTokens:{status:"absent"},outputTokens:{status:"absent"}}, selectedInputField:"input_tokens",selectedOutputField:"output_tokens",normalizedTotal:15},
    });
  });
  it("refuses synthesized zero usage", () => expect(() => decodeCodexResult("plan", event({input_tokens:0,output_tokens:0}), final)).toThrow("codex-usage-unavailable"));
  it.each([
    null, {}, {input_tokens:1}, {input_tokens:-1,output_tokens:2}, {input_tokens:1.5,output_tokens:2},
    {input_tokens:"1",output_tokens:2}, {input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:2},
    {input_tokens:12,output_tokens:3,cached_input_tokens:13}, {input_tokens:12,output_tokens:3,reasoning_output_tokens:4},
  ])("refuses invalid usage %j", usage => expect(() => decodeCodexResult("plan", event(usage), final)).toThrow("codex-usage-invalid"));
  it("does not accept a payload without completion", () => expect(() => decodeCodexResult("plan", "", final)).toThrow("codex-no-completion"));
  it("rejects conflicting completed totals", () => expect(() => decodeCodexResult("plan", good+event({input_tokens:14,output_tokens:3}),final)).toThrow("codex-conflicting-completion"));
  it.each(["turn.failed","error"])("never hides %s behind later completion", type => expect(() => decodeCodexResult("plan",JSON.stringify({type})+"\n"+good,final)).toThrow("codex-event-error"));
  it.each(["not json\n", "null\n", "{}\n"])("rejects malformed event %s", raw => expect(() => decodeCodexResult("plan",raw+good,final)).toThrow("codex-events-invalid"));
  it("allows unknown typed events", () => expect(decodeCodexResult("plan",'{"type":"future.event"}\n'+good,final).tokenUsage).toBe(15));
  it.each(["oops", "{}", '{"summary":2,"primaryTargetPaths":[]}', JSON.stringify({...JSON.parse(final),tokenUsage:1}),JSON.stringify({...JSON.parse(final),usageEvidence:{}})])("rejects malformed or invented model evidence %s", raw => expect(() => decodeCodexResult("plan",good,raw)).toThrow("codex-result-invalid"));
  it("validates partial execution separately from complete execution", () => {
    const body = {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"log",completionStatus:"partial",failureType:"timeout",failureMessage:"interrupted"};
    expect(decodeCodexResult("execute",good,JSON.stringify(body))).toMatchObject({...body,tokenUsage:15});
    expect(() => decodeCodexResult("execute",good,JSON.stringify({...body,failureMessage:undefined}))).toThrow("codex-result-invalid");
  });
  it("validates the verifier result and rejects another phase", () => {
    const body={approved:false,rejectCategory:"check",primaryTargetPaths:[],failingCommand:null,safeToRetry:false,evidence:[],pauseSignals:[],stopSignals:[]};
    expect(decodeCodexResult("verify",good,JSON.stringify(body))).toMatchObject(body);
    expect(() => decodeCodexResult("verify",good,final)).toThrow("codex-result-invalid");
  });
  it("gives the provider strict business-only schemas", () => {
    expect(phaseJsonSchema("plan")).toEqual({type:"object",properties:{summary:{type:"string"},primaryTargetPaths:{type:"array",items:{type:"string"}}},required:["summary","primaryTargetPaths"],additionalProperties:false});
    expect(phaseJsonSchema("verify")).toMatchObject({additionalProperties:false,properties:{failingCommand:{type:["string","null"]}}});
    expect(phaseJsonSchema("execute")).toHaveProperty("anyOf");
  });
});
