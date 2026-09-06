import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import readline from 'node:readline';
import {APP} from './workflow.mjs';
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
    p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(new Error(err.trim()||'图片排版未完成')));
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
    const found={models:null,rateLimits:null,usage:null};let settled=false,timer;
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
    timer=setTimeout(()=>finish({status:'stale',error:'读取创作账户信息超时，可稍后刷新。'}),timeoutMs);
    send({method:'initialize',id:0,params:{clientInfo:{name:'wendi_studio',title:'温蒂创作室',version:'2.0.0'}}});
  });
}
export function extractRateLimits(value){
  const response=value?.rateLimits??value;
  return response?.rateLimitsByLimitId?.codex||response?.rateLimits||((response?.primary||response?.secondary)?response:null);
}
export function normalizeRateLimits(value){
  const raw=extractRateLimits(value)||{};
  const clean=window=>{
    if(!window||!Number.isFinite(Number(window.usedPercent)))return null;
    const used=Math.min(100,Math.max(0,Number(window.usedPercent)));
    return {usedPercent:used,remainingPercent:Math.max(0,100-used),windowDurationMins:Number(window.windowDurationMins)||null,resetsAt:Number(window.resetsAt)||null};
  };
  const windows=Object.entries(raw).map(([key,value])=>({key,value:clean(value)})).filter(x=>x.value);
  const primary=clean(raw.primary)||windows.find(x=>x.value.windowDurationMins&&x.value.windowDurationMins<=360)?.value||windows[0]?.value||null;
  const secondary=clean(raw.secondary)||windows.find(x=>x.value!==primary&&x.value.windowDurationMins&&x.value.windowDurationMins>360)?.value||windows.find(x=>x.value!==primary)?.value||null;
  return {primary,secondary,planType:raw.planType||null,credits:raw.credits?{balance:raw.credits.balance,hasCredits:raw.credits.hasCredits}:null};
}
export function rateLimitSnapshot(timeoutMs=12000){
  const bin=findCodex();if(!bin)return Promise.resolve(null);
  if(process.env.WENDI_TEST_PLAN_FILE)return Promise.resolve({primary:{usedPercent:1,windowDurationMins:300},secondary:{usedPercent:2,windowDurationMins:10080}});
  return new Promise(resolve=>{
    const child=spawn(bin,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],env:{...process.env,NO_COLOR:'1'}});
    const rl=readline.createInterface({input:child.stdout});let settled=false,timer;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);rl.close();child.kill('SIGTERM');resolve(value);};
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    rl.on('line',line=>{try{const msg=JSON.parse(line);if(msg.id===0&&msg.result){send({method:'initialized',params:{}});send({method:'account/rateLimits/read',id:1});}else if(msg.id===1)finish(normalizeRateLimits(msg.result));}catch{}});
    child.on('error',()=>finish(null));child.on('close',()=>finish(null));timer=setTimeout(()=>finish(null),timeoutMs);
    send({method:'initialize',id:0,params:{clientInfo:{name:'wendi_studio_guard',title:'温蒂创作室额度保护',version:'2.1.0'}}});
  });
}
export function runCodex({prompt,dir,schema,images=[],signal,onEvent=()=>{},image=false,writableDirs=[],model=null,reasoningEffort='low',timeoutMs=900000}) {
  const bin=findCodex();if(!bin)throw new Error('请先打开 Codex 并登录。');
  fs.mkdirSync(dir,{recursive:true});
  const resultPath=path.join(dir,'response.txt');
  const args=['exec','--ephemeral','--skip-git-repo-check','--ignore-user-config','--disable','plugins','--disable','apps','--disable','multi_agent','-c',`model_reasoning_effort="${reasoningEffort}"`,'-s',image?'workspace-write':'read-only','--json','-o',resultPath];
  if(model)args.push('-m',model);
  if(schema){const s=path.join(dir,'response.schema.json');fs.writeFileSync(s,JSON.stringify(schema));args.push('--output-schema',s);}
  for(const dir of writableDirs)args.push('--add-dir',dir);
  for(const img of images)args.push('-i',img);
  args.push('-');
  fs.writeFileSync(path.join(dir,'prompt.txt'),prompt,{mode:0o600});
  return new Promise((resolve,reject)=>{
    // Never copy account secrets or call private endpoints: the official CLI owns authentication.
    const child=spawn(bin,args,{cwd:dir,env:{...process.env,NO_COLOR:'1'},detached:true,stdio:['pipe','pipe','pipe']});
    const log=fs.createWriteStream(path.join(dir,'events.jsonl'),{mode:0o600});
    let buf='',last='',error='',settled=false,timedOut=false,usage=null;
    const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{} setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500).unref();};
    const abort=()=>stop(); signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);log.end();err?reject(err):resolve(result);};
    child.stdout.on('data',c=>{
      log.write(c);buf+=c;
      const lines=buf.split('\n');buf=lines.pop();
      for(const line of lines){try{const e=JSON.parse(line);if(e.type==='item.completed'&&e.item?.type==='agent_message')last=e.item.text;if(e.type==='turn.completed'&&e.usage)usage=e.usage;if(e.type==='error'||e.type==='turn.failed')error=e.message||e.error?.message||'创作连接中断';onEvent(e);}catch{}}
    });
    child.stderr.on('data',c=>log.write(JSON.stringify({stderr:String(c)})+'\n'));
    child.on('error',err=>finish(new Error('无法启动创作连接：'+err.message)));
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      if(signal?.aborted)return finish(new Error('已暂停，已保存完成部分。'));
      if(timedOut)return finish(new Error('本次等待时间较长，已暂停。已收到的图片保留在本地，可检查后继续。'));
      if(code!==0)return finish(new Error(error||'创作连接中断，请确认账号可用后继续。'));
      const text=fs.existsSync(resultPath)?fs.readFileSync(resultPath,'utf8'):last;
      if(schema){try{const parsed=JSON.parse(text);Object.defineProperty(parsed,'__usage',{value:usage,enumerable:false});return finish(null,parsed);}catch{return finish(new Error('未收到完整方案，需求已保留，请重新整理。'));}}
      finish(null,{text,usage});
    });
    if(signal?.aborted)stop(); else child.stdin.end(prompt);
  });
}
