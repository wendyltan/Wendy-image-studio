import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {APP} from './workflow.mjs';

export const WEB_IMAGE_PROVIDER='chatgpt-web-iab';
export const WEB_WORKER_CONFIG=path.join(APP,'.runtime','chatgpt-web-worker.json');
export const WEB_WORKER_PROBE_RESULT=path.join(APP,'.runtime','chatgpt-web-worker-probe-result.json');
const THREAD_ID=/^[a-f0-9-]{36}$/;
const REQUEST_ID=/^[a-f0-9-]{36}$/;
const TERMINAL_STATES=new Set(['downloaded','failed']);
const MANIFEST_STATES=new Set(['queued','accepted','ready','submitted','downloaded','failed']);
const ACCEPTED_STATES=new Set(['accepted','ready','submitted']);
const DEFAULT_READY_TTL_MS=15*60*1000;
const PROBE_RESULT_RELATIVE='.runtime/chatgpt-web-worker-probe-result.json';

function savedProbeDescriptor(source='saved-result'){
  return {source,action:source==='saved-result'?'refresh-saved-only':'test-fixture',executionAvailable:false,responseFile:PROBE_RESULT_RELATIVE,message:'当前操作只重读已保存的隔离探针结果；新的探针必须由隔离后台实际写入。'};
}

function listedFiles(files=[]){
  return files.map((file,index)=>`${index+1}. ${JSON.stringify(path.resolve(file))}`).join('\n');
}

export function readWebManifest(file){
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!value||typeof value!=='object')return null;
    const state=String(value.state||'');
    if(!MANIFEST_STATES.has(state))return null;
    const conversationUrl=/^https:\/\/chatgpt\.com\/(?:c\/[^\s?#]+)?(?:[?#][^\s]*)?$/.test(String(value.conversationUrl||''))?String(value.conversationUrl):null;
    const requestId=REQUEST_ID.test(String(value.requestId||''))?String(value.requestId):null;
    return {...value,state,submitted:value.submitted===true,conversationUrl,...(requestId?{requestId}:{}),...(value.accepted===true?{accepted:true}: {})};
  }catch{return null;}
}

export function readWebWorkerConfig(file=process.env.WENDI_CHATGPT_WEB_WORKER_CONFIG||WEB_WORKER_CONFIG){
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!THREAD_ID.test(String(value.threadId||'')))return null;
    return {threadId:String(value.threadId),hostId:String(value.hostId||'local'),verifiedAt:value.verifiedAt||null};
  }catch{return null;}
}

export function readWebWorkerProbe(file=process.env.WENDI_CHATGPT_WEB_WORKER_PROBE_RESULT||WEB_WORKER_PROBE_RESULT){
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    const checkedAt=String(value.checkedAt||'');
    if(!value||typeof value!=='object'||value.schemaVersion!==1||!THREAD_ID.test(String(value.threadId||''))||!String(value.hostId||'')||!Number.isFinite(Date.parse(checkedAt)))return null;
    return {schemaVersion:1,threadId:String(value.threadId),hostId:String(value.hostId),ok:value.ok===true,iabAvailable:value.iabAvailable===true,chatgptLoggedIn:value.chatgptLoggedIn===true,inputAvailable:value.inputAvailable===true,checkedAt,error:value.error?String(value.error):null};
  }catch{return null;}
}

function readyTtlMs(){
  const configured=Number(process.env.WENDI_WEB_WORKER_READY_TTL_MS);
  return Number.isFinite(configured)&&configured>0?configured:DEFAULT_READY_TTL_MS;
}

export function webWorkerStatus(){
  const worker=readWebWorkerConfig();
  if(!worker)return {ready:false,state:'unavailable',configured:false,historical:false,probe:savedProbeDescriptor(),message:'网页生图后台尚未初始化；当前入口只重读已保存结果，无法执行新的隔离探针。'};
  if(process.env.WENDI_TEST_PLAN_FILE)return {ready:true,state:'verified-ready',configured:true,historical:false,probe:savedProbeDescriptor('test-fixture'),message:'网页生图后台已就绪。',threadId:worker.threadId,hostId:worker.hostId,verifiedAt:worker.verifiedAt};
  const sessions=path.join(process.env.CODEX_HOME||path.join(process.env.HOME||'','.codex'),'sessions');
  let localSession=false;
  try{localSession=fs.globSync(`**/*${worker.threadId}.jsonl`,{cwd:sessions}).length>0;}catch{}
  const probe=readWebWorkerProbe();
  const base={ready:false,state:'unknown',configured:true,historical:localSession,threadId:worker.threadId,hostId:worker.hostId,configuredAt:worker.verifiedAt||null,probe:savedProbeDescriptor()};
  if(!probe)return {...base,evidence:'missing',message:'网页生图后台已配置，但还没有当前身份匹配的隔离就绪证据；历史会话不能代替验证。当前入口只重读已保存结果，新的探针必须由隔离后台实际写入。'};
  if(probe.threadId!==worker.threadId||probe.hostId!==worker.hostId)return {...base,evidence:'identity-mismatch',message:'网页生图后台就绪记录属于其他会话或宿主，不能用于当前后台。',probeThreadId:probe.threadId,probeHostId:probe.hostId};
  const age=Date.now()-Date.parse(probe.checkedAt);
  if(!Number.isFinite(age)||age<0)return {...base,evidence:'invalid-time',message:'网页生图后台就绪记录的时间无效，不能放行。'};
  if(age>readyTtlMs())return {...base,evidence:'stale',message:'网页生图后台就绪记录已过期，请通过隔离探针重新核对；不会自动唤醒旧任务。',verifiedAt:probe.checkedAt,expiresAt:new Date(Date.parse(probe.checkedAt)+readyTtlMs()).toISOString()};
  if(!(probe.ok&&probe.iabAvailable&&probe.chatgptLoggedIn&&probe.inputAvailable))return {...base,evidence:'probe-failed',message:probe.error||'网页生图后台最近一次隔离就绪检查未通过。',verifiedAt:probe.checkedAt};
  return {ready:true,state:'verified-ready',configured:true,historical:localSession,threadId:worker.threadId,hostId:worker.hostId,probe:savedProbeDescriptor(),evidence:'fresh-probe',message:'网页生图后台已通过最近的隔离就绪检查。',verifiedAt:probe.checkedAt,expiresAt:new Date(Date.parse(probe.checkedAt)+readyTtlMs()).toISOString()};
}

export function chatGptWebImagePrompt({outputFile,manifestFile,prompt,referenceFiles=[],editTarget=null,conversationUrl=null,capsule='',requestId=null}){
  const action=editTarget
    ? '第一项附件是待编辑原图。请只修订明确指出的问题，保持其他正确内容。'
    : '创建一张新的独立分镜图。';
  const conversation=conversationUrl
    ? `优先继续这个既有对话以保持编辑上下文：${String(conversationUrl)}`
    : '新建一个 ChatGPT 对话；创建后把实际会话 URL 记录到执行清单。';
  return `你是温蒂创作室的后台网页生图执行器。用户已经在温蒂创作室网页执行带防重复标识的确认动作，明确授权本次单张生图和把下列参考图片上传到 chatgpt.com。worker-request.json 中的 authorization 是该操作发生后的持久证据。它已经满足发送前确认，不得再次询问；上传、发送、等待和下载必须在当前同一个回合完成。

强制执行边界：
- 禁止调用 image_gen 或任何图片生成 API。
- 禁止使用 Chrome、Edge、Safari 或其他用户浏览器，也禁止接管用户浏览器标签页。
- 只能使用本任务的 Codex 内嵌浏览器 IAB。浏览器界面可以显示在 Codex 客户端内；若 IAB 不可用，必须在提交前写入失败状态并停止，不得回退。
- 只在 https://chatgpt.com/ 中通过正常聊天界面提交一次生图请求。不得重复提交，不发布或分享会话。
- 参考文件必须作为彼此独立的附件上传并逐项确认。不得用截图代替附件。
- 完成后必须下载网页生成的原始图片。网页截图、屏幕截图和程序绘制图片都不能作为结果。
- 除写入下列目标图片和执行记录外，不修改本地文件。

执行步骤：
1. 真正开始处理本次 requestId（${requestId||'从 worker-request.json 读取'}）并核对 worker-request.json 中的 manifestFile、instructionFile 和 outputFile 后，先原子更新 ${JSON.stringify(path.resolve(manifestFile))} 为 provider=${WEB_IMAGE_PROVIDER}、state=accepted、accepted=true、requestId（必须完全匹配）、acceptedAt。这个状态是后台接单凭据，不是 CLI 排队成功；若无法写入，写 state=failed、submitted=false、errorCode 和 error 后停止。未写入 accepted 前不得打开或准备网页、登录、上传附件。
2. 通过 accepted 后，复用本任务已有的 chatgpt.com IAB 标签页。空标签列表只是没有现存页面，不表示 IAB 后端不可用；没有可复用页面时，必须用当前工具公开的 createBrowserTab("iab", "https://chatgpt.com", {visible:false}) 或等价受支持 IAB 新建入口尝试创建一次，并读取页面状态。不得仅因外部 Chrome 出现在列表或 IAB 无标签就报 IAB_UNAVAILABLE；只有实际 IAB 选择或创建失败才记录该错误，并保留失败原因。登录或页面加载问题单独记录，不伪装成后端缺失。${conversation}
3. 确认已登录且聊天输入框可用。把所有参考文件逐一上传，并确认每个文件都显示为独立附件。
4. 在发送聊天消息前，原子更新同一清单为 state=ready、conversationUrl、referenceCount、submitted=false、requestId 和 acceptedAt。若此时失败，写 state=failed、submitted=false、requestId、acceptedAt、errorCode 和 error 后停止。
5. 一次性提交下面的冻结提示词；消息发送成功后立刻更新同一清单为 state=submitted、submitted=true、conversationUrl、requestId、acceptedAt 和 submittedAt。页面显示生成中时只等待，绝不再次发送。
6. 页面显示生成完成后，从下载控件取得原始 PNG/JPG/WebP，复制到准确路径 ${path.resolve(outputFile)}。不得把缩略图或截图当成原图。
7. 验证目标文件存在且可读取，把清单更新为 state=downloaded、submitted=true、artifactPath、conversationUrl、requestId、acceptedAt 和 downloadedAt。最后只返回真实原图绝对路径和会话 URL。
8. 如果提交后发生任何错误，仍须更新清单为 state=failed、submitted=true、requestId、acceptedAt、conversationUrl、errorCode 和 error。不要重发。

附件绝对路径（按此顺序上传）：
${listedFiles(referenceFiles)}

附件规则：两张温蒂人设必须同时作为身份参考；其他附件只锁定对应环境、物件或编辑目标。${action}

冻结制作要求：
${capsule}

本次单张要求：
${prompt}`;
}

function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(temp,file);
}

function queueMessage(requestFile){
  return `执行温蒂创作室网页生图作业。用户已经在创作室执行本次 action-time 确认，request.authorization 是确认凭据，不得再次询问。只读取 ${requestFile}，再读取其中 instructionFile 的完整指令并严格执行。真正开始处理后先按 request.requestId 原子写入 manifestFile 的 accepted 接单凭据；CLI 返回成功不等于已接单。在当前同一个回合内新建或复用 Codex IAB，完成附件上传、唯一一次发送、等待和原图下载；回合结束会清理标签页，所以不得在 accepted 或 ready 后停下。禁止 image_gen 和外部浏览器。每个阶段都按 instructionFile 原子更新 manifestFile；聊天消息最多发送一次。不要浏览或修改其他项目文件。`;
}

export function queueOnce(bin,args,{cwd,logFile,signal,timeoutMs=30000,killGraceMs=1500}){
  if(signal?.aborted){const error=new Error('已暂停，网页生图任务尚未开始。');error.code='WEB_WORKER_QUEUE_ABORTED';return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{cwd,env:{...process.env,NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false,termination=null,killTimer=null;
    const log=code=>fs.appendFileSync(logFile,JSON.stringify({at:new Date().toISOString(),kind:'queue',code,termination,stdout:stdout.slice(-4000),stderr:stderr.slice(-4000)})+'\n',{mode:0o600});
    const stop=(kind,message,code)=>{
      if(settled||termination)return;
      termination={kind,message,code};child.kill('SIGTERM');killTimer=setTimeout(()=>{if(!settled)child.kill('SIGKILL');},killGraceMs);killTimer.unref?.();
    };
    const timer=setTimeout(()=>stop('timeout','唤醒网页生图后台超时。任务记录已保留，不会自动重复提交。','WEB_WORKER_QUEUE_TIMEOUT'),timeoutMs);timer.unref?.();
    const onAbort=()=>stop('aborted','已暂停等待；网页后台若已收到任务仍会继续，完成的原图将保留。','WEB_WORKER_QUEUE_ABORTED');signal?.addEventListener('abort',onAbort,{once:true});
    const finish=callback=>{if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',onAbort);callback();};
    child.stdout.on('data',chunk=>stdout+=chunk);
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',error=>finish(()=>reject(error)));
    child.on('close',code=>{
      finish(()=>{log(code);if(termination){const error=new Error(termination.message);error.code=termination.code;return reject(error);}if(code===0)return resolve({stdout,stderr});const error=new Error(stderr.trim()||stdout.trim()||'无法唤醒 Codex 网页生图后台。');error.code='WEB_WORKER_QUEUE_FAILED';reject(error);});
    });
  });
}

/** Queue exactly one turn on the dedicated Codex task, then observe its durable manifest. */
export async function dispatchChatGptWebJob({codexBin,dir,outputFile,prompt,referenceFiles=[],editTarget=null,conversationUrl=null,capsule='',signal,timeoutMs=900000,queueTimeoutMs=30000,acceptTimeoutMs=60000,pollIntervalMs=1000,workerConfigFile=null}){
  if(!codexBin){const error=new Error('请先打开 Codex 并登录。');error.code='WEB_WORKER_QUEUE_FAILED';throw error;}
  const worker=workerConfigFile?readWebWorkerConfig(workerConfigFile):readWebWorkerConfig();
  if(!worker){const error=new Error('Browser is not available: iab。Codex 网页生图后台尚未完成初始化，没有提交图片请求。');error.code='IAB_UNAVAILABLE';throw error;}
  fs.mkdirSync(dir,{recursive:true});
  const manifestFile=path.join(dir,'web-generation.json'),instructionFile=path.join(dir,'prompt.txt'),requestFile=path.join(dir,'worker-request.json'),eventsFile=path.join(dir,'events.jsonl');
  const requestId=crypto.randomUUID(),createdAt=new Date().toISOString();
  fs.writeFileSync(instructionFile,chatGptWebImagePrompt({outputFile,manifestFile,prompt,referenceFiles,editTarget,conversationUrl,capsule,requestId}),{mode:0o600});
  writeJson(manifestFile,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,state:'queued',requestId,accepted:false,submitted:false,createdAt});
  writeJson(requestFile,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,requestId,authorization:{confirmed:true,scope:'one_chatgpt_web_image_submission',confirmedAt:createdAt},instructionFile,manifestFile,outputFile:path.resolve(outputFile),referenceFiles:referenceFiles.map(file=>path.resolve(file)),editTarget:editTarget?path.resolve(editTarget):null,conversationUrl,createdAt});
  const args=['queue','--thread',worker.threadId,'--message',queueMessage(requestFile),'-C',APP,'-s','workspace-write','--disable','image_generation','--disable','browser_use_external'];
  const matchesRequest=manifest=>manifest?.requestId===requestId;
  const hasAcceptance=manifest=>matchesRequest(manifest)&&manifest?.accepted===true&&ACCEPTED_STATES.has(manifest?.state);
  const hasDownloadedArtifact=manifest=>matchesRequest(manifest)&&manifest?.state==='downloaded'&&manifest?.accepted===true&&manifest?.submitted===true;
  try{await queueOnce(codexBin,args,{cwd:APP,logFile:eventsFile,signal,timeoutMs:Math.min(queueTimeoutMs,timeoutMs)});}
  catch(error){
    const manifest=readWebManifest(manifestFile);error.webManifest=manifest;
    if(hasDownloadedArtifact(manifest))return {text:[manifest.artifactPath,manifest.conversationUrl].filter(Boolean).join('\n'),usage:null,manifest};
    if(manifest?.state==='failed'&&matchesRequest(manifest)){error.message=String(manifest.error||error.message);error.code=manifest.errorCode||error.code;throw error;}
    // The browser may submit after the local queue client disconnects. Once the
    // matching worker receipt exists, keep observing durable state instead of
    // guessing no image. A queued task remains recoverable and is never requeued.
    if(!hasAcceptance(manifest))throw error;
    if(signal?.aborted){error.code='WEB_IMAGE_WAIT_PAUSED';throw error;}
  }
  const queuedAt=Date.now(),acceptDeadline=queuedAt+Math.max(0,Number(acceptTimeoutMs)||0),generationDeadline=queuedAt+Math.max(0,Number(timeoutMs)||0);
  while(true){
    const manifest=readWebManifest(manifestFile);
    if(manifest&&TERMINAL_STATES.has(manifest.state)){
      if(hasDownloadedArtifact(manifest))return {text:[manifest.artifactPath,manifest.conversationUrl].filter(Boolean).join('\n'),usage:null,manifest};
      if(manifest.state==='failed'&&matchesRequest(manifest)){
        const error=new Error(String(manifest.error||'网页生图后台未取得图片。'));error.code=manifest.errorCode||'WEB_IMAGE_FAILED';error.webManifest=manifest;throw error;
      }
    }
    const accepted=hasAcceptance(manifest);
    if(signal?.aborted){const error=new Error('已暂停等待；网页后台若已提交仍会继续，完成的原图将保留。');error.code='WEB_IMAGE_WAIT_PAUSED';error.webManifest=manifest;throw error;}
    if(!accepted&&Date.now()>=acceptDeadline){const error=new Error('Codex CLI 已排队，但网页生图后台尚未写入本次 requestId 的接单凭据。已停止本机等待，不会自动重复提交。');error.code='WEB_WORKER_NOT_ACCEPTED';error.webManifest=manifest;throw error;}
    if(accepted&&Date.now()>=generationDeadline){const error=new Error('网页生图等待超时。当前记录已保留，不会自动重新提交。');error.code='WEB_IMAGE_WAIT_TIMEOUT';error.webManifest=manifest;throw error;}
    if(!accepted&&Date.now()>=generationDeadline){const error=new Error('网页生图后台尚未接单，当前记录已保留，不会自动重新提交。');error.code='WEB_WORKER_NOT_ACCEPTED';error.webManifest=manifest;throw error;}
    await new Promise(resolve=>setTimeout(resolve,Math.max(1,Number(pollIntervalMs)||1000)));
  }
}
