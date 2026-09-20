import { appendFileSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const mode=process.argv[2], marker=process.argv[3];
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
});
