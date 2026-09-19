import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import readline from 'node:readline';
import {APP} from './workflow.mjs';

const IMAGE_PATH = /(?:^|[\s"'`(])((?:\/[^\n<>"'`]+?)\.(?:png|webp|jpe?g))(?:$|[\s"'`,)])/gi;
const CLEAR_NO_IMAGE = /(?:未产生(?:任何)?图片|未产出(?:任何)?图片|未能生成(?:图片)?|没有生成(?:替代品|图片)|没有(?:任何)?图片(?:产出|生成)?|目标路径尚不存在|未写入目标路径|Browser is not available:\s*(?:iab|chrome)|隐藏\s*IAB.*不可用|BROWSER_(?:FOCUS|TAB_BACKGROUND|CHROME)_(?:UNAVAILABLE|RESTORE_FAILED)|BROWSER_ORIGIN_PERMISSION_DENIED|The user declined permission(?: for this action)?|Browser use cannot access\s+https?:\/\/chatgpt\.com\b[^\n]*(?:denied permission|permission denied)|https?:\/\/chatgpt\.com\b[^\n]*browser security policy|browser security policy[^\n]*https?:\/\/chatgpt\.com\b|browser security policy|Chrome management capability is not advertised|焦点(?:恢复|管理)能力(?:不可用|未提供|未广告)|无法恢复创作室焦点|no image (?:was )?(?:generated|produced|created)|image generation (?:did not|failed to) (?:produce|create))/i;
const NETWORK_INTERRUPTION = /(?:network|connection|connect(?:ion)? (?:reset|refused|failed|closed)|websocket|tls|ssl|tunnel|econn(?:reset|refused|timeout)|enotfound|连接(?:错误|中断|失败|超时)?|网络(?:错误|中断|失败|超时)?|代理|隧道)/i;

function eventObjects(value){
  if(Array.isArray(value))return value.flatMap(eventObjects);
  if(typeof value==='string')return value.split('\n').flatMap(line=>{try{return line.trim()?eventObjects(JSON.parse(line)):[];}catch{return line.trim()?[{message:line}]:[];}});
  return value&&typeof value==='object'?[value]:[];
}
function eventText(events=[]){
  return eventObjects(events).map(event=>{
    try{return JSON.stringify(event);}catch{return '';}
  }).filter(Boolean).join('\n');
}
function stringFields(value, out=[]){
  if(Array.isArray(value)){for(const item of value)stringFields(item,out);return out;}
  if(!value||typeof value!=='object')return out;
  for(const [key,item] of Object.entries(value)){
    if(typeof item==='string'&&/(?:path|file|image|output|text|message|error|content)$/i.test(key))out.push(item);
    else if(item&&typeof item==='object')stringFields(item,out);
  }
  return out;
}
function imagePathsFromText(text=''){
  const paths=[];IMAGE_PATH.lastIndex=0;
  for(const match of String(text).matchAll(IMAGE_PATH))paths.push(match[1]);
  return [...new Set(paths)];
}
function identifier(events, keys){
  for(const event of eventObjects(events)){
    for(const key of keys){
      const value=event?.[key]??event?.item?.[key]??event?.result?.[key];
      if(typeof value==='string'&&value.length<=200)return value;
    }
  }
  return null;
}

/**
 * Classify only the evidence returned by one CLI run. Callers must still check
 * that a reported image path exists before treating it as a saved artifact.
 */
export function classifyGenerationEvidence({events=[],responseText='',runId=null,startedAt=null,endedAt=null,exitCode=null}={}){
  const normalizedEvents=eventObjects(events);
  const evidenceText=[responseText,eventText(normalizedEvents),...normalizedEvents.flatMap(event=>stringFields(event))].filter(Boolean).join('\n');
  const imagePaths=[...new Set([
    ...imagePathsFromText(responseText),
    ...normalizedEvents.flatMap(event=>imagePathsFromText(stringFields(event).join('\n'))),
  ])];
  const threadId=identifier(normalizedEvents,['thread_id','threadId','thread']);
  const eventRunId=identifier(normalizedEvents,['run_id','runId','turn_id','turnId']);
  const clearNoImage=CLEAR_NO_IMAGE.test(evidenceText);
  const networkInterrupted=NETWORK_INTERRUPTION.test(evidenceText);
  // A connection error can arrive after the provider has completed the image.
  // Natural-language claims about "no image" do not make that state certain.
  const outcome=imagePaths.length?'image_path_reported':networkInterrupted?'network_interrupted':clearNoImage?'no_image':'unknown';
  const reason=outcome==='image_path_reported'?'reported_image_path':outcome==='no_image'?'reported_no_image':outcome==='network_interrupted'?'connection_interrupted':'insufficient_evidence';
  return {
    outcome,
    reason,
    imagePaths,
    connectionRelated:networkInterrupted,
    runId:eventRunId||runId||null,
    threadId,
    startedAt:startedAt||null,
    endedAt:endedAt||null,
    exitCode:Number.isInteger(exitCode)?exitCode:null,
  };
}

/** A concise, path-free record suitable for project task diagnostics. */
export function generationDiagnosticSummary(evidence={}){
  return {
    outcome:evidence.outcome||'unknown',
    reason:evidence.reason||'insufficient_evidence',
    connectionRelated:Boolean(evidence.connectionRelated),
    reportedImageCount:Array.isArray(evidence.imagePaths)?evidence.imagePaths.length:0,
    runId:evidence.runId||null,
    threadId:evidence.threadId||null,
    startedAt:evidence.startedAt||null,
    endedAt:evidence.endedAt||null,
    exitCode:Number.isInteger(evidence.exitCode)?evidence.exitCode:null,
  };
}

export function readGenerationEvidence(dir){
  const eventsFile=path.join(dir,'events.jsonl'),responseFile=path.join(dir,'response.txt');
  const events=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,'utf8'):'';
  const responseText=fs.existsSync(responseFile)?fs.readFileSync(responseFile,'utf8'):'';
  return classifyGenerationEvidence({events,responseText,runId:path.basename(dir)});
}
export function findCodex() {
  if (process.env.WENDI_CODEX_BIN && fs.existsSync(process.env.WENDI_CODEX_BIN)) return process.env.WENDI_CODEX_BIN;
  for (const p of ['/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex']) if(fs.existsSync(p))return p;
  try { return execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim(); } catch {return null;}
}
export function python() {
  for(const p of [process.env.WENDI_PYTHON,'/Library/Frameworks/Python.framework/Versions/3.10/bin/python3','/opt/homebrew/bin/python3','/usr/bin/python3'].filter(Boolean)) if(fs.existsSync(p))return p;
  throw new Error('没有找到本地图像排版工具。');
}
export function pythonRun(args) {
  return new Promise((resolve,reject)=>{
    const p=spawn(python(),[path.join(APP,'server/compose.py'),...args],{stdio:['ignore','pipe','pipe']});
    let out='',err=''; p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);
    p.on('error',reject);p.on('close',code=>{
      if(code===0){resolve(out);return;}
      const last=err.trim().split('\n').map(line=>line.trim()).filter(Boolean).at(-1)||'图片排版未完成';
      reject(new Error(last.replace(/^[\w.]+(?:Error|Exception):\s*/,'')||'图片排版未完成'));
    });
  });
}
export async function connectionStatus() {
  const bin=findCodex();
  if(!bin)return {ready:false,message:'请先打开 Codex 并登录一次。'};
  return new Promise(resolve=>{
    const p=spawn(bin,['login','status'],{stdio:['ignore','pipe','pipe']});let out='';
    const timer=setTimeout(()=>{p.kill();resolve({ready:false,message:'暂时无法确认登录，请重新打开 Codex。'});},10000);
    for(const stream of [p.stdout,p.stderr])stream.on('data',c=>out+=c);
    p.on('error',()=>{clearTimeout(timer);resolve({ready:false,message:'创作连接暂不可用。'});});
    p.on('close',code=>{clearTimeout(timer);resolve({ready:code===0 && /Logged in/i.test(out),message:code===0?'已连接你的创作账号':'请先打开 Codex 并登录一次。'});});
  });
}
export function appServerSnapshot(timeoutMs=8000) {
  if(process.env.WENDI_TEST_PLAN_FILE)return Promise.resolve({models:[{id:'fixture-model',displayName:'Fixture Model',defaultReasoningEffort:'low',supportedReasoningEfforts:['low'],isDefault:true}],rateLimits:{primary:{usedPercent:1}},usage:null});
  const bin=findCodex();
  if(!bin)return Promise.resolve({models:[],rateLimits:null,usage:null,error:'请先打开 Codex 并登录一次。'});
  return new Promise(resolve=>{
    const child=spawn(bin,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],env:{...process.env,NO_COLOR:'1'}});
    const rl=readline.createInterface({input:child.stdout});
    const found={models:null,rateLimits:null,usage:null};let settled=false;
    const finish=(extra={})=>{if(settled)return;settled=true;clearTimeout(timer);rl.close();child.kill('SIGTERM');resolve({...found,...extra});};
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    rl.on('line',line=>{try{
      const msg=JSON.parse(line);
      if(msg.id===0&&msg.result){
        send({method:'initialized',params:{}});
        send({method:'model/list',id:1,params:{limit:50,includeHidden:false}});
        send({method:'account/rateLimits/read',id:2});
        send({method:'account/usage/read',id:3});
      } else if(msg.id===1) found.models=msg.result?.data||[];
      else if(msg.id===2) found.rateLimits=msg.result||null;
      else if(msg.id===3) found.usage=msg.result||null;
      if(found.models!==null&&found.rateLimits!==null&&found.usage!==null)finish({status:'fresh'});
    }catch{}});
    child.on('error',err=>finish({error:'无法读取创作账户：'+err.message}));
    child.on('close',code=>{if(!settled)finish({error:code===0?'创作账户信息暂不可用。':'创作账户连接中断。'});});
    const timer=setTimeout(()=>finish({status:'stale',error:'读取创作账户信息超时，可稍后刷新。'}),timeoutMs);
    send({method:'initialize',id:0,params:{clientInfo:{name:'wendi_studio',title:'温蒂创作室',version:'2.0.0'}}});
  });
}
export function extractRateLimits(value){
  const response=value?.rateLimits??value;
  if(response?.rateLimitsByLimitId?.codex)return response.rateLimitsByLimitId.codex;
  if(response?.rateLimits)return response.rateLimits;
  if(response?.primary||response?.secondary)return response;
  return response&&typeof response==='object'&&Object.values(response).some(item=>item&&typeof item==='object'&&('usedPercent' in item||'windowDurationMins' in item))?response:null;
}
function rawRateLimitBuckets(value){
  if(!value||typeof value!=='object')return {};
  const response=value.rateLimits&&typeof value.rateLimits==='object'?value.rateLimits:value;
  const byLimitId=value.rateLimitsByLimitId||value.byLimitId||response.rateLimitsByLimitId||response.byLimitId;
  if(byLimitId&&typeof byLimitId==='object'&&!Array.isArray(byLimitId))return byLimitId;
  const selected=value.rateLimits&&typeof value.rateLimits==='object'?value.rateLimits:value;
  const limitId=typeof selected.limitId==='string'&&selected.limitId?selected.limitId:'codex';
  return selected&&typeof selected==='object'&&(selected.primary||selected.secondary)?{[limitId]:selected}:{};
}
export function normalizeRateLimits(value){
  const buckets=rawRateLimitBuckets(value),raw=buckets.codex||extractRateLimits(value)||{};
  const clean=window=>{
    if(!window||typeof window!=='object'||Array.isArray(window))return null;
    const parseNumber=value=>{
      if(typeof value==='number')return Number.isFinite(value)?value:null;
      if(typeof value==='string'&&value.trim()!==''){const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;}
      return null;
    };
    const usedValue=parseNumber(window.usedPercent);if(usedValue===null)return null;
    const used=Math.min(100,Math.max(0,usedValue)),durationValue=parseNumber(window.windowDurationMins),resetValue=parseNumber(window.resetsAt);
    return {usedPercent:used,remainingPercent:Math.max(0,100-used),windowDurationMins:durationValue&&durationValue>0?durationValue:null,resetsAt:resetValue};
  };
  const normalizeBucket=bucket=>{
    const windows=Object.entries(bucket||{}).map(([key,source])=>({key,source,value:clean(source)})).filter(x=>x.value);
    const explicitPrimary=windows.find(x=>x.key==='primary')||null,explicitSecondary=windows.find(x=>x.key==='secondary')||null;
    const primaryEntry=explicitPrimary||(!explicitSecondary?windows.find(x=>x.value.windowDurationMins&&x.value.windowDurationMins<=360)||(!windows.some(x=>x.value.windowDurationMins&&x.value.windowDurationMins>360)?windows[0]||null:null):null);
    const primary=primaryEntry?.value||null;
    const secondaryEntry=(explicitSecondary&&explicitSecondary!==primaryEntry&&explicitSecondary.source!==primaryEntry?.source?explicitSecondary:null)||windows.find(x=>x!==primaryEntry&&x.source!==primaryEntry?.source&&x.value.windowDurationMins&&x.value.windowDurationMins>360)||(!primaryEntry?windows.find(x=>x.key!=='primary'&&x.source!==explicitPrimary?.source)||null:windows.find(x=>x!==primaryEntry&&x.source!==primaryEntry?.source)||null);
    return {primary,secondary:secondaryEntry?.value||null,planType:bucket?.planType||null,credits:bucket?.credits?{balance:bucket.credits.balance,hasCredits:bucket.credits.hasCredits}:null};
  };
  const normalized=normalizeBucket(raw),primary=normalized.primary,secondary=normalized.secondary;
  const byLimitId=Object.fromEntries(Object.entries(buckets).map(([id,bucket])=>{
    const normalizedBucket=normalizeBucket(bucket);
    return [id,{...normalizedBucket,limitId:bucket?.limitId||id,limitName:bucket?.limitName||null,normalModelSlug:bucket?.normalModelSlug||null}];
  }));
  return {...normalized,primary,secondary,byLimitId};
}
const rateLimitCache={value:null,observedAt:0,inFlight:null};
/**
 * Account reads start a short-lived app-server process. Coalesce requests from
 * adjacent image tasks so the quota guard itself does not add a second slow
 * operation for every panel. The caller still receives null when no observed
 * value exists; an unavailable read is never converted into a made-up quota.
 */
export function rateLimitSnapshot(timeoutMs=12000,{force=false}={}){
  const bin=findCodex();if(!bin)return Promise.resolve(null);
  if(process.env.WENDI_TEST_PLAN_FILE)return Promise.resolve({primary:{usedPercent:1,remainingPercent:99,windowDurationMins:300},secondary:{usedPercent:2,remainingPercent:98,windowDurationMins:10080},byLimitId:{codex:{limitId:'codex',primary:{usedPercent:1,remainingPercent:99,windowDurationMins:300},secondary:{usedPercent:2,remainingPercent:98,windowDurationMins:10080}},base_model_inference:{limitId:'base_model_inference',normalModelSlug:'fixture-model',primary:{usedPercent:1,remainingPercent:99,windowDurationMins:10080}}},status:'fresh',observedAt:Date.now()});
  const age=Date.now()-rateLimitCache.observedAt;
  if(!force&&rateLimitCache.value&&age<60_000)return Promise.resolve({...rateLimitCache.value,status:'cached',observedAt:rateLimitCache.observedAt});
  if(rateLimitCache.inFlight)return rateLimitCache.inFlight;
  rateLimitCache.inFlight=new Promise(resolve=>{
    const child=spawn(bin,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],env:{...process.env,NO_COLOR:'1'}});
    const rl=readline.createInterface({input:child.stdout});let settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);rl.close();child.kill('SIGTERM');if(value){rateLimitCache.observedAt=Date.now();rateLimitCache.value={...value,status:'fresh',observedAt:rateLimitCache.observedAt};resolve(rateLimitCache.value);}else if(rateLimitCache.value)resolve({...rateLimitCache.value,status:'stale',observedAt:rateLimitCache.observedAt});else resolve(null);};
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    rl.on('line',line=>{try{const msg=JSON.parse(line);if(msg.id===0&&msg.result){send({method:'initialized',params:{}});send({method:'account/rateLimits/read',id:1});}else if(msg.id===1)finish(normalizeRateLimits(msg.result));}catch{}});
    child.on('error',()=>finish(null));child.on('close',()=>finish(null));const timer=setTimeout(()=>finish(null),timeoutMs);
    send({method:'initialize',id:0,params:{clientInfo:{name:'wendi_studio_guard',title:'温蒂创作室额度保护',version:'2.1.0'}}});
  });
  return rateLimitCache.inFlight.finally(()=>{rateLimitCache.inFlight=null;});
}
export function runCodex({prompt,dir,schema,images=[],signal,onEvent=()=>{},image=false,browserMode=null,writableDirs=[],model=null,reasoningEffort='low',timeoutMs=900000,codexBin=null,role='creative'}) {
  const bin=codexBin||findCodex();if(!bin)throw new Error('请先打开 Codex 并登录。');
  fs.mkdirSync(dir,{recursive:true});
  const resultPath=path.join(dir,'response.txt');
  const runId=path.basename(dir),startedAt=new Date().toISOString();
  const executionFile=path.join(dir,'execution.json');
  const execution={schemaVersion:1,role,model:model||null,reasoningEffort,browserMode:browserMode||null,image:Boolean(image),runId,startedAt};
  const saveExecution=patch=>{try{fs.writeFileSync(executionFile,JSON.stringify({...execution,...patch},null,2),{mode:0o600});}catch{}};
  saveExecution({state:'running'});
  const args=['exec','--ephemeral','--skip-git-repo-check'];
  if(browserMode==='chrome')args.push('--disable','image_generation','--approve-for-me');
  else args.push('--ignore-user-config','--disable','plugins','--disable','apps','--disable','multi_agent');
  args.push('-c',`model_reasoning_effort="${reasoningEffort}"`);
  // --approve-for-me is intentionally incompatible with the sandbox. Browser
  // workers need the explicit non-interactive permission approval, while every
  // other execution keeps the existing read-only/workspace-write sandbox.
  if(browserMode!=='chrome')args.push('-s',image?'workspace-write':'read-only');
  args.push('--json','-o',resultPath);
  if(model)args.push('-m',model);
  if(schema){const s=path.join(dir,'response.schema.json');fs.writeFileSync(s,JSON.stringify(schema));args.push('--output-schema',s);}
  for(const dir of writableDirs)args.push('--add-dir',dir);
  for(const img of images)args.push('-i',img);
  args.push('-');
  fs.writeFileSync(path.join(dir,'prompt.txt'),prompt,{mode:0o600});
  return new Promise((resolve,reject)=>{
    // Never copy account secrets or call private endpoints: the official CLI owns authentication.
    const browserEnv=browserMode==='chrome'?{BROWSER_USE_AVAILABLE_BACKENDS:'chrome',CUA_REPL_ENABLED_SURFACES:'browser'}:{};
    const child=spawn(bin,args,{cwd:dir,env:{...process.env,...browserEnv,NO_COLOR:'1'},detached:true,stdio:['pipe','pipe','pipe']});
    const log=fs.createWriteStream(path.join(dir,'events.jsonl'),{mode:0o600});
    let buf='',last='',error='',settled=false,timedOut=false,usage=null;
    const capturedEvents=[];
    const evidence=(responseText='',exitCode=null)=>classifyGenerationEvidence({events:capturedEvents,responseText,runId,startedAt,endedAt:new Date().toISOString(),exitCode});
    const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{} setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500).unref();};
    const abort=()=>stop(); signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    const finish=(err,result,{responseText='',exitCode=null}={})=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);log.end();
      saveExecution({state:err?'failed':'completed',endedAt:new Date().toISOString(),exitCode,durationMs:Math.max(0,Date.now()-Date.parse(startedAt)),error:err?String(err.message||err).slice(0,500):null});
      const runEvidence=evidence(responseText,exitCode);
      if(err){Object.defineProperty(err,'generationEvidence',{value:runEvidence,enumerable:false});return reject(err);}
      if(result&&typeof result==='object'){
        Object.defineProperty(result,'__generationEvidence',{value:runEvidence,enumerable:false});
        if(!Object.prototype.hasOwnProperty.call(result,'diagnostics'))Object.defineProperty(result,'diagnostics',{value:generationDiagnosticSummary(runEvidence),enumerable:true});
      }
      resolve(result);
    };
    child.stdout.on('data',c=>{
      log.write(c);buf+=c;
      const lines=buf.split('\n');buf=lines.pop();
      for(const line of lines){try{const e=JSON.parse(line);capturedEvents.push(e);if(e.type==='item.completed'&&e.item?.type==='agent_message')last=e.item.text;if(e.type==='turn.completed'&&e.usage)usage=e.usage;if(e.type==='error'||e.type==='turn.failed')error=e.message||e.error?.message||'创作连接中断';onEvent(e);}catch{}}
    });
    child.stderr.on('data',c=>{const event={stderr:String(c)};capturedEvents.push(event);log.write(JSON.stringify(event)+'\n');});
    child.on('error',err=>finish(new Error('无法启动创作连接：'+err.message)));
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      if(signal?.aborted)return finish(new Error('已暂停，已保存完成部分。'),null,{exitCode:code});
      if(timedOut)return finish(new Error('本次等待时间较长，已暂停。已收到的图片保留在本地，可检查后继续。'),null,{exitCode:code});
      if(code!==0)return finish(new Error(error||'创作连接中断，请确认账号可用后继续。'),null,{exitCode:code});
      const text=fs.existsSync(resultPath)?fs.readFileSync(resultPath,'utf8'):last;
      if(schema){try{const parsed=JSON.parse(text);Object.defineProperty(parsed,'__usage',{value:usage,enumerable:false});return finish(null,parsed,{responseText:text,exitCode:code});}catch{return finish(new Error('未收到完整方案，需求已保留，请重新整理。'),null,{responseText:text,exitCode:code});}}
      finish(null,{text,usage},{responseText:text,exitCode:code});
    });
    if(signal?.aborted)stop(); else child.stdin.end(prompt);
  });
}
