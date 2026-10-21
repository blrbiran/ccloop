import { appendFileSync, existsSync, lstatSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const mode=process.argv[2], marker=process.argv[3];
// Orca agent selection (2026-09-26), spec §4.8: `--version` with no `exec` answers a fixed version and
// writes nothing; every other call appends what the real codex would receive (from `exec` on) as one
// JSON array line to `<marker>.argv`. Every mode below is otherwise unchanged.
// Orca retire-legacy-orca-run (2026-10-01), spec §3.4: mode `frames`, argv `frames <marker> <framesFile>`, plays
// the frame of the attempt number (the working directory's `attempt-<n>`, minus one) from the framesFile list of
// the task named in the prompt (else the `"*"` list); no frame ⇒ stderr `no frame for <task> attempt <n>`, exit 3.
// Every-agent requirement chain (Orca spec 2026-10-15 §9): `--version` appends `version` to `<marker>.version-calls`;
// `debug models` and `features list` answer the catalog and the feature list and append `debug-models` / `features-list`
// to `<marker>.catalog-calls`, before anything below runs, so `<marker>.argv` and `<marker>.calls` never see them.
// `<marker>.catalog.json` ({rows?, sleepMs?, exitCode?, stderr?}) overrides the rows, sleeps first, or fails.
// Task 8 of that plan: its `features?` (a list of flag names) overrides the flags `features list` prints (final-review I4:
// the default is every flag ccloop turns off, as codex-cli 0.160.0 lists them, plus browser_use_full_cdp_access, which
// ccloop does not send). Task 8 fix
// round 2: `mcp list --json` appends `mcp-list` and prints `mcp?` (default []) as codex-cli 0.160.0's JSON array of
// `{name, enabled, ...}` objects; `mcpExitCode?` fails that call alone. Fix round 3 (paid check P1b): `mcp` are the
// servers the linked config.toml defines; `mcpPlugins?` are servers the person's own CODEX_HOME adds (~/.codex/plugins),
// listed only when the call is NOT isolated (its CODEX_HOME/config.toml is not a symlink or `-c features.plugins=false`
// is absent). `mcp list` records {HOME, CODEX_HOME, c} in <marker>.mcp-env.json. A single call that turns off a server
// `mcp` does not define fails as the real codex-cli 0.160.0 does: stderr "invalid transport in `mcp_servers.<name>`", exit 1.
// Codex phase isolation (ccloop spec 2026-10-18, Orca session 3d229487, 2026-10-20): a phase call also writes
// {HOME, CODEX_HOME} it ran with to <marker>.phase-env.json, right after <marker>.
if(process.argv.at(-1)==="--version"&&!process.argv.includes("exec")) {appendFileSync(marker+".version-calls","version\n");await new Promise(resolve=>process.stdout.write("9.9.9-fake\n",resolve));process.exit(0);}
const catalogCall=process.argv.includes("debug")&&process.argv.includes("models")?"debug-models":process.argv.includes("features")&&process.argv.includes("list")?"features-list":process.argv.includes("mcp")&&process.argv.includes("list")?"mcp-list":null;
if(catalogCall!==null&&!process.argv.includes("exec")) {
  appendFileSync(marker+".catalog-calls",catalogCall+"\n");
  const script=existsSync(marker+".catalog.json")?JSON.parse(readFileSync(marker+".catalog.json","utf8")):{};
  if(script.sleepMs!==undefined) await new Promise(resolve=>setTimeout(resolve,script.sleepMs));
  if(script.stderr!==undefined) await new Promise(resolve=>process.stderr.write(script.stderr,resolve));
  if(script.exitCode!==undefined) process.exit(script.exitCode);
  if(catalogCall==="mcp-list") {
    if(script.mcpExitCode!==undefined) process.exit(script.mcpExitCode);
    const c=process.argv.flatMap((arg,i)=>arg==="-c"?[process.argv[i+1]]:[]);
    let linked=false; try{linked=lstatSync(`${process.env.CODEX_HOME}/config.toml`).isSymbolicLink();}catch{}
    const isolated=linked&&c.includes("features.plugins=false");
    writeFileSync(marker+".mcp-env.json",JSON.stringify({HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,c}));
    await new Promise(resolve=>process.stdout.write(JSON.stringify([...(script.mcp??[]),...(isolated?[]:script.mcpPlugins??[])])+"\n",resolve));
  } else if(catalogCall==="debug-models") {
    const rows=script.rows??[{slug:"gpt-6-sol",context_window:272000,visibility:"list"},{slug:"gpt-6-luna",context_window:272000,visibility:"list"},{slug:"gpt-reserve",context_window:272000,visibility:"hide"}];
    await new Promise(resolve=>process.stdout.write(JSON.stringify({models:rows})+"\n",resolve));
  } else {
    const flags=script.features??["apps","browser_use","browser_use_external","browser_use_full_cdp_access","code_mode_host","computer_use","goals","hooks","image_generation","in_app_browser","multi_agent","plugins","realtime_conversation","remote_plugin","shell_tool","skill_search","skip_host_skill_discovery","sleep_tool","tool_suggest","unified_exec","view_image"];
    await new Promise(resolve=>process.stdout.write(flags.map(flag=>`${flag.padEnd(40)} stable             true`).join("\n")+"\n",resolve));
  }
  process.exit(0);
}
appendFileSync(marker+".argv",JSON.stringify(process.argv.slice(process.argv.indexOf("exec")))+"\n");
const P1_ERROR_ITEMS=[
  {"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n  user (/private/tmp/p1-pJnD/cache/codex-home/6c50abddd3e7b8e015da354e559a9f48f1b2d2bac85d91aaee0a9509b61ec74c/codex-home/config.toml): `features.rmcp_client` is ignored."}},
  {"type":"item.completed","item":{"id":"item_1","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n  user (/private/tmp/p1-pJnD/cache/codex-home/6c50abddd3e7b8e015da354e559a9f48f1b2d2bac85d91aaee0a9509b61ec74c/codex-home/config.toml): `features.rmcp_client` is ignored."}},
  {"type":"item.completed","item":{"id":"item_2","type":"error","message":"Under-development features enabled: skip_host_skill_discovery. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in /private/tmp/p1-pJnD/cache/codex-home/6c50abddd3e7b8e015da354e559a9f48f1b2d2bac85d91aaee0a9509b61ec74c/codex-home/config.toml."}},
];
const CONTINUATION="Treat continuation input fields unfinished, pendingDecisions, and awaitingHuman as required planning inputs.";
const REPORTED={decisions:[
  {question:"Retry inside the client or the caller?",chose:"caller",alternatives:[{option:"client",why_not:"hides failures"}],because:"the caller owns the budget",undo:{how:"restore the retry loop in src/client.ts",cost:"small",blast_radius:"src/client.ts"},scope:"repo",kind:"interface",importance:"major"},
  {question:"Name the helper?",chose:"retryOnce",alternatives:[{option:"retry",why_not:"too generic"}],because:"says what it does",undo:{how:"rename retryOnce back in src/client.ts",cost:"trivial",blast_radius:"src/client.ts"},scope:"file",kind:"implementation",importance:"minor"}],
  debug:{choseInstead:"fix the parser",reproTests:["tests/parser.test.ts"],reproCommand:"npx vitest run tests/parser.test.ts",reproduction:null,reproductionReason:null}};
const args=process.argv.slice(process.argv.indexOf("exec")+1);
const value=flag=>args[args.indexOf(flag)+1];
let prompt="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",c=>{prompt+=c;});
process.stdin.on("end",()=>{
  // Every-agent requirement chain (Orca spec 2026-10-15 §6.1, §9): a single call is the only codex call with
  // --skip-git-repo-check. It records HOME, CODEX_HOME and whether auth.json there is a symlink in <marker>.single-env.json,
  // appends `single-call` to <marker>.calls, then plays <marker>.single.json ({rows?, final?, exitCode?, hang?}) or one
  // complete {"answer":"42"} with usage input 20 (5 cached) and output 4. Task 8 fix round 2: the default rows carry the
// three `error` items the real codex-cli 0.160.0 printed in paid check P1 (Orca session a852f96a, 2026-10-16;
// /private/tmp/p1-pJnD events.jsonl, item lines copied verbatim), as a real single call does.
  if(args.includes("--skip-git-repo-check")) {
    appendFileSync(marker+".calls","single-call\n");
    const catalogScript=existsSync(marker+".catalog.json")?JSON.parse(readFileSync(marker+".catalog.json","utf8")):{};
    const defined=new Set((catalogScript.mcp??[]).map(server=>server.name));
    const undefinedServer=args.flatMap((arg,i)=>arg==="-c"?[args[i+1]]:[]).map(value=>/^mcp_servers\.(.+)\.enabled=false$/.exec(value)?.[1]).find(name=>name!==undefined&&!defined.has(name));
    if(undefinedServer!==undefined){process.stderr.write(`Error: failed to load bootstrap configuration\n\nCaused by:\n    invalid transport\n    in \`mcp_servers.${undefinedServer}\`\n`,()=>{process.exitCode=1;});return;}
    let authIsLink=null; try{authIsLink=lstatSync(`${process.env.CODEX_HOME}/auth.json`).isSymbolicLink();}catch{}
    writeFileSync(marker+".single-env.json",JSON.stringify({HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,authIsLink}));
    const script=existsSync(marker+".single.json")?JSON.parse(readFileSync(marker+".single.json","utf8")):{};
    if(script.hang===true){setInterval(()=>{},1000);return;}
    const rows=script.rows??[{type:"thread.started",thread_id:"t"},...P1_ERROR_ITEMS,{type:"turn.started"},{type:"item.completed",item:{id:"item_0",type:"agent_message",text:"{\"answer\":\"42\"}"}},{type:"turn.completed",usage:{input_tokens:20,cached_input_tokens:5,output_tokens:4}}];
    writeFileSync(value("-o"),script.final??"{\"answer\":\"42\"}");
    process.stdout.write(rows.map(row=>JSON.stringify(row)).join("\n")+"\n",()=>{process.exitCode=script.exitCode??0;});
    return;
  }
  writeFileSync(marker,JSON.stringify({args,cwd:process.cwd(),prompt,pid:process.pid}));
  writeFileSync(marker+".phase-env.json",JSON.stringify({HOME:process.env.HOME??null,CODEX_HOME:process.env.CODEX_HOME??null}));
  // Orca session 7f37d261 (2026-10-13), codex rate-limit spec §4: modes `rate-limit-1` (the first call of this marker is
  // rejected, later calls behave as `integration`), `rate-limit-all`, `rate-limit-all-exit0` and `rate-limit-after-item`
  // replay the tester's real 429 stdout (Orca orca_archived_files/recommendations-1-events.jsonl), exit 1 unless exit0.
  // `rate-limit-hang` prints the same rows and then hangs (a phase that times out); `rate-limit-1-hang` rejects the first
  // call and hangs on every later one.
  // Failure causes (ccloop spec 2026-10-21 §8): `error-503-1` fails the first call of this marker with codex's own
  // "exceeded retry limit, last status: 503" rows (later calls behave as `integration`); `error-503-all` on every call;
  // `error-503-after-item` prints an item.started first (work observed) on every call.
  if(mode.startsWith("error-503")) {
    const call=readFileSync(marker+".argv","utf8").trim().split("\n").length;
    if(mode!=="error-503-1"||call===1) {
      const message="exceeded retry limit, last status: 503 Service Unavailable";
      const rows=[{type:"thread.started",thread_id:"01a13431-3db4-73a1-afd1-154f0477282d"},{type:"turn.started"},
        ...(mode==="error-503-after-item"?[{type:"item.started",item:{id:"item_0",type:"command_execution",command:"ls",status:"in_progress"}}]:[]),
        {type:"error",message},{type:"turn.failed",error:{message}}];
      process.stdout.write(rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
      process.exitCode=1;return;
    }
  }
  if(mode.startsWith("rate-limit")) {
    const call=readFileSync(marker+".argv","utf8").trim().split("\n").length;
    if(mode==="rate-limit-1-hang"&&call>1) {setInterval(()=>{},1000);return;}
    if(!mode.startsWith("rate-limit-1")||call===1) {
      const message="exceeded retry limit, last status: 429 Too Many Requests";
      const rows=[{type:"thread.started",thread_id:"01a13431-3db4-73a1-afd1-154f0477282d"},{type:"turn.started"},
        ...(mode==="rate-limit-after-item"?[{type:"item.started",item:{id:"item_0",type:"command_execution",command:"ls",status:"in_progress"}}]:[]),
        {type:"error",message},{type:"turn.failed",error:{message}}];
      process.stdout.write(rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
      if(mode==="rate-limit-hang") {setInterval(()=>{},1000);return;}
      process.exitCode=mode.endsWith("exit0")?0:1;return;
    }
  }
  process.stderr.write("fixture stderr 中文\n");
  if(mode==="skill-integration") appendFileSync(marker+".skills",readFileSync(".agents/skills/selected/SKILL.md","utf8")+"\n");
  if(process.env.FAKE_CODEX_SKILL_PATH) {
    appendFileSync(marker+".skills",readFileSync(process.env.FAKE_CODEX_SKILL_PATH,"utf8"));
    if(process.env.FAKE_CODEX_REPLACE_SKILL==="1") {
      const leaf=process.env.FAKE_CODEX_SKILL_PATH.replace(/\/SKILL\.md$/,"");unlinkSync(leaf);writeFileSync(leaf,"foreign");
    }
  }
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
  if(mode==="frames") {
    const task={plan:/^Plan one isolated L2 attempt for task (.+)\.$/m,execute:/^Execute one isolated attempt for task (.+)\.$/m,verify:/^Verify task (.+)\.$/m}[phase].exec(prompt)?.[1];
    const frames=JSON.parse(readFileSync(process.argv[4],"utf8"));
    const attempt=Number(/attempt-(\d+)$/.exec(process.cwd())?.[1]);
    const frame=(frames[task]??frames["*"])?.[attempt-1];
    if(frame===undefined) {process.stderr.write(`fake-codex frames: no frame for ${task} attempt ${attempt}\n`);process.exitCode=3;return;}
    if(phase==="plan") body={summary:"frames",primaryTargetPaths:[]};
    if(phase==="execute") body={changedFiles:frame.changedFiles??[],diffPatch:"",commandOutputs:[],stdoutStderrLog:""};
    if(phase==="verify") body={approved:frame.approved??true,rejectCategory:"",primaryTargetPaths:[],failingCommand:null,safeToRetry:frame.safeToRetry??false,evidence:[],pauseSignals:[],stopSignals:frame.stopSignals??[]};
  }
  const respond=()=>{
  if(mode==="script" && phase==="execute") for(const [path,content] of Object.entries(entry.files)) writeFileSync(path,content);
  if(phase==="execute" && ["skill-integration","integration","write-hang","no-usage","false-answer","high-usage","reported"].includes(mode)) writeFileSync("answer.txt","42\n");
  // Reported decisions and debug (ccloop spec 2026-10-20 §5): mode `reported` behaves as `integration` and its execute
  // answer also carries `decisions` and `debug`: the fields of <marker>.reported.json when present, else one major and one
  // minor decision and a debug whose two unreported members are null, as codex's strict wire schema makes them.
  if(phase==="execute" && mode==="reported") Object.assign(body,existsSync(marker+".reported.json")?JSON.parse(readFileSync(marker+".reported.json","utf8")):REPORTED);
  if(phase==="verify" && mode==="false-answer") writeFileSync("answer.txt","0\n");
  if(mode==="quota") {process.stdout.write(JSON.stringify({type:"turn.failed",error:{message:"quota exhausted"}})+"\n");return;}
  if(phase==="execute" && mode==="write-hang") {setInterval(()=>{},1000);return;}
  // Optional report channel paired build fixture: the same execute invocation writes both product and metadata.
  if(phase==="execute" && mode==="task-result") {writeFileSync("answer.txt","42\n");body.taskResult={schema:"task-result-v1",goal:"Produce answer",completedWork:["Wrote answer"],conclusions:["Agent claim"],limitations:[],outputs:[{path:"answer.txt",label:"Answer"}]};}
  if(phase==="execute" && mode==="partial") Object.assign(body,{completionStatus:"partial",failureType:"error",failureMessage:"fixture partial"});
  if(mode!=="missing-final") writeFileSync(value("-o"),JSON.stringify(wireSchema.properties?.result?{result:body,...(mode==="envelope-extra"?{tokenUsage:0}:{})}:body));
  // Codex phase output hardening (2026-10-08): mode `final-text`, argv `final-text <marker> <finalsFile>`, writes the
  // finalsFile's string for this phase (`{"plan"?, "execute"?, "verify"?}`) as the final message verbatim, replacing the
  // JSON answer above; a phase without an entry answers as mode `ok` does.
  if(mode==="final-text"){const text=JSON.parse(readFileSync(process.argv[4],"utf8"))[phase];if(typeof text==="string")writeFileSync(value("-o"),text);}
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
