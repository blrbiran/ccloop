import { describe, expect, it } from "vitest";
import { normalizeExecutionFinal } from "../../src/runtime/executionNormalizer.js";
const complete = { changedFiles:["answer.txt"], diffPatch:"patch", commandOutputs:["ran"], stdoutStderrLog:"ok" };
const partial = {...complete,completionStatus:"partial",failureType:"error",failureMessage:"stopped"};
describe("strict execution normalization",()=>{
  for (const body of [complete, partial]) for (const wrapped of [false,true]) for (const decorated of [false,true]) {
    it(`accepts ${body===partial?"partial":"complete"} ${wrapped?"envelope":"direct"} ${decorated?"decorated":"whole"}`,()=>{
      const text=JSON.stringify(wrapped?{result:body}:body);
      expect(normalizeExecutionFinal(decorated?`Done: ${text}`:text)).toMatchObject({status:"available",execution:body});
    });
  }
  it.each([
    JSON.stringify({...complete,extra:1}), JSON.stringify({result:complete,extra:1}), JSON.stringify([complete]),
    `Answer ${JSON.stringify(complete)} then {"changedFiles":"bad"}`,
    `Answer ${JSON.stringify({result:complete})} then {"result":{}}`,
    `Answer ${JSON.stringify(complete)} then {`,
    `Answer ${JSON.stringify(complete)} then {broken}`,
    JSON.stringify({result:{...complete,diffPatch:undefined}}),
  ])("refuses ambiguous, hidden, incompatible or incomplete output %#",text=>expect(normalizeExecutionFinal(text).status).toBe("unavailable"));
  it("counts an envelope and direct repeated body as one semantic answer",()=>{
    expect(normalizeExecutionFinal(`One ${JSON.stringify({result:complete})} again ${JSON.stringify(complete)}`).status).toBe("available");
  });
  it("treats established reports as opaque but retains original lossy identity",()=>{
    const a={...complete,taskResult:{changedFiles:"opaque",bad:"a".repeat(200000)}};
    const b={...complete,taskResult:{changedFiles:"opaque",bad:"b".repeat(200000)}};
    expect(normalizeExecutionFinal(`Done ${JSON.stringify(a)}`).status).toBe("available");
    expect(normalizeExecutionFinal(`One ${JSON.stringify(a)} two ${JSON.stringify({result:b})}`).status).toBe("unavailable");
  });
  it("fails closed on scanner depth overflow",()=>{
    expect(normalizeExecutionFinal(`Done {"result":${'{"a":'.repeat(1001)}{}${'}'.repeat(1001)}}`)).toMatchObject({status:"unavailable",diagnostic:{hidden:true}});
  });
});
