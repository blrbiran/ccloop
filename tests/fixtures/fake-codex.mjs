import { appendFileSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const mode=process.argv[2], marker=process.argv[3];
const CONTINUATION="Treat continuation input fields unfinished, pendingDecisions, and awaitingHuman as required planning inputs.";
const args=process.argv.slice(process.argv.indexOf("exec")+1);
const value=flag=>args[args.indexOf(flag)+1];
let prompt="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",c=>{prompt+=c;});
process.stdin.on("end",()=>{
  writeFileSync(marker,JSON.stringify({args,cwd:process.cwd(),prompt,pid:process.pid}));
  process.stderr.write("fixture stderr 中文\n");
  if(mode==="hang" || mode==="ignore-term") {
    if(mode==="ignore-term") process.on("SIGTERM",()=>appendFileSync(marker+".term","TERM\n"));
    setInterval(()=>{},1000); return;
  }
  if(mode==="output-limit") {process.stdout.write("x".repeat(17*1024*1024)); return;}
  if(mode==="symlink") {unlinkSync(value("-o"));symlinkSync(marker,value("-o"));return;}
  const wireSchema=JSON.parse(readFileSync(value("--output-schema"),"utf8"));
  const schema=wireSchema.properties?.result??wireSchema;
  let body={summary:"fixture",primaryTargetPaths:["answer.txt"]};
  if(schema.anyOf) body={changedFiles:["answer.txt"],diffPatch:"fixture patch",commandOutputs:["changed answer"],stdoutStderrLog:"fixture execution"};
  if(schema.properties?.approved) body={approved:true,rejectCategory:"",primaryTargetPaths:["answer.txt"],failingCommand:null,safeToRetry:false,evidence:[],pauseSignals:[],stopSignals:[]};
  const phase=schema.anyOf?"execute":schema.properties?.approved?"verify":"plan";
  appendFileSync(marker+".calls",phase+"\n");
  // Orca handoff delivery (2026-09-25), C5 and I-7: a script entry is looked up for the task named in
  // this phase's prompt, `<task>#continuation` first when the prompt carries ccloop's continuation
  // constraint, and may carry `delayMs: {plan?, execute?, verify?}`: that phase then sleeps before it
  // writes anything (script files, the final answer, stdout events). Only a missing execute entry is an
  // error, as before. Each script-mode call also appends `<phase> <entry key or ->` to `<marker>.tasks`
  // (`<marker>.calls` keeps its format).
  let entry;
  if(mode==="script") {
    const task={plan:/^Plan one isolated L2 attempt for task (.+)\.$/m,execute:/^Execute one isolated attempt for task (.+)\.$/m,verify:/^Verify task (.+)\.$/m}[phase].exec(prompt)?.[1];
    const script=task===undefined?{}:JSON.parse(readFileSync(process.argv[4],"utf8"));
    const key=prompt.includes(CONTINUATION)&&script[`${task}#continuation`]!==undefined?`${task}#continuation`:script[task]!==undefined?task:undefined;
    entry=key===undefined?undefined:script[key];
    appendFileSync(marker+".tasks",`${phase} ${key??"-"}\n`);
    if(phase==="execute" && entry===undefined) {process.stderr.write(`fake-codex script has no entry for task ${task}\n`);process.exitCode=3;return;}
  }
  const respond=()=>{
  if(mode==="script" && phase==="execute") for(const [path,content] of Object.entries(entry.files)) writeFileSync(path,content);
  if(phase==="execute" && ["integration","write-hang","no-usage","false-answer","high-usage"].includes(mode)) writeFileSync("answer.txt","42\n");
  if(phase==="verify" && mode==="false-answer") writeFileSync("answer.txt","0\n");
  if(mode==="quota") {process.stdout.write(JSON.stringify({type:"turn.failed",error:{message:"quota exhausted"}})+"\n");return;}
  if(phase==="execute" && mode==="write-hang") {setInterval(()=>{},1000);return;}
  if(phase==="execute" && mode==="partial") Object.assign(body,{completionStatus:"partial",failureType:"error",failureMessage:"fixture partial"});
  if(mode!=="missing-final") writeFileSync(value("-o"),JSON.stringify(wireSchema.properties?.result?{result:body,...(mode==="envelope-extra"?{tokenUsage:0}:{})}:body));
  if(phase==="execute" && mode==="no-usage") return;
  const events=JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"中文"}})+"\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:mode==="high-usage"?39997:12,output_tokens:3}})+"\n";
  if(mode==="child-holds-pipe") {
    const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:["ignore","inherit","inherit"]});
    writeFileSync(marker+".child",String(child.pid));
    process.stdout.write(events,()=>process.exit(0));return;
  }
  if(mode==="split-utf8") {
    const b=Buffer.from(events),i=b.indexOf(Buffer.from("中文"))+1;
    process.stdout.write(b.subarray(0,i));setTimeout(()=>process.stdout.write(b.subarray(i)),10);return;
  }
  process.stdout.write(mode==="bad-json" ? "not JSON\n" : events);
  if(mode==="nonzero") process.exitCode=7;
  };
  const delay=entry?.delayMs?.[phase];
  if(delay===undefined) respond(); else {
    // Orca handoff delivery C-3: `usageBeforeDelay: true` reports this call's usage before sleeping, so a
    // phase stopped during the delay has an observation to report.
    if(entry.usageBeforeDelay===true) process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:12,output_tokens:3}})+"\n");
    setTimeout(respond,delay);
  }
});
