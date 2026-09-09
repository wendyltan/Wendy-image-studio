import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DATA,REFS,FACE,CHECKS,jsonWrite,inside,rules,digest,validatePlan,PLAN_SCHEMA,QA_SCHEMA,plannerPrompt,planMarkdown} from './workflow.mjs';
import {runCodex,pythonRun,rateLimitSnapshot,readGenerationEvidence,generationDiagnosticSummary,findCodex} from './bridge.mjs';
import {JobStore} from './job-store.mjs';
import {WEB_IMAGE_PROVIDER,chatGptWebImagePrompt,dispatchChatGptWebJob,readWebManifest,webWorkerStatus} from './chatgpt-web-provider.mjs';
export const active = new Map();
const runningProjects = new Map();
fs.mkdirSync(DATA,{recursive:true});
const jobStore=new JobStore(DATA),queueOwner=`${process.pid}:${crypto.randomUUID()}`;let queueTail=Promise.resolve();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ID=/^[a-f0-9-]{36}$/;
// Only phrases that explicitly say there was no usable image belong here. A
// connection error by itself is ambiguous: the provider can finish an image
// before the local copy step fails, so it must remain recoverable.
const DEFINITE_NO_IMAGE=/(?:未能生成(?:任何)?(?:替代品|图片)?|没有生成(?:任何)?(?:替代品|图片)?|未(?:产生|产出)(?:任何)?图片|未(?:生成|输出)(?:任何)?图片|没有(?:产生|产出)(?:任何)?图片|目标路径尚不存在|no image (?:was )?(?:generated|produced|created|returned)|(?:did not|didn't) (?:generate|produce|return) (?:an? )?image|image generation (?:produced|returned) no image)/i;
const NETWORK_FAILURE=/(?:network|connection|连接|网络|websocket)/i;
const IAB_UNAVAILABLE=/(?:Browser is not available:\s*iab|隐藏\s*IAB.*不可用)/i;
export function projectDir(id){if(!ID.test(id))throw new Error('作品不存在');return inside(DATA,id);}
export function readProject(id){const p=path.join(projectDir(id),'project.json');if(!fs.existsSync(p))throw new Error('作品不存在');return JSON.parse(fs.readFileSync(p,'utf8'));}
export function syncRunningProject(id,patch){const running=runningProjects.get(id);if(!running)return;const brief=patch.brief?{...running.brief,...patch.brief}:running.brief;Object.assign(running,patch);running.brief=brief;}
export function saveProject(p){
  const file=path.join(projectDir(p.id),'project.json');
  // A running task keeps an in-memory snapshot. Preserve user changes made from
  // another request before that task writes its next progress checkpoint.
  if(fs.existsSync(file)){
    const latest=JSON.parse(fs.readFileSync(file,'utf8'));
    if(runningProjects.has(p.id)&&Number(latest.revision)>Number(p.revision)){
      if(latest.titleLocked&&latest.title!==p.title){p.title=latest.title;p.titleLocked=true;}
      if(latest.brief?.model&&latest.brief.model!==p.brief?.model)p.brief={...p.brief,model:latest.brief.model,reasoningEffort:latest.brief.reasoningEffort};
    }
    p.revision=Math.max(Number(p.revision)||0,Number(latest.revision)||0);
  }
  p.schemaVersion=3;p.revision=(Number(p.revision)||0)+1;p.updatedAt=new Date().toISOString();jsonWrite(file,p);
}
export function listProjects(){return fs.readdirSync(DATA).filter(id=>ID.test(id)&&fs.existsSync(path.join(DATA,id,'project.json'))).map(readProject).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export function recover(){
  const recoverable=jobStore.recoverable();
  for(const job of recoverable)if(job.status==='queued'){jobStore.cancel(job.id,'interrupted',{reason:'service_restarted_before_start'});job.status='recoverable';}
  const interrupted=new Map(recoverable.map(job=>[job.projectId,job]));
  for(const p of listProjects()){
  if(jobStore.hasLiveWork(p.id))continue;
  let migrated=false;
  if(p.lastFailure?.kind==='network'&&p.lastFailure.definiteNoOutput!==false){p.lastFailure.definiteNoOutput=false;migrated=true;}
  if(p.currentTask?.status==='failed_no_output'&&(!['no-output','browser-unavailable'].includes(p.currentTask.errorCode)||p.lastFailure?.kind==='network')){p.currentTask.status='unknown_result';p.currentTask.errorCode='network';p.status='attention';p.message=unknownResultMessage(p.currentTask.target);p.error=p.message;migrated=true;}
  if(!p.lastFailure&&p.currentTask?.status==='failed_no_output'&&!p.pending){
    const state=imageRetryState(p);
    if(state?.certainty==='confirmed_missing')p.lastFailure={...state.failure,taskId:p.currentTask.id};
    else {p.currentTask.status='unknown_result';p.currentTask.errorCode='network';p.status='attention';p.message=unknownResultMessage(state?.target||p.currentTask.target);p.error=p.message;}
    migrated=true;
  }
  if(p.lastFailure&&!p.currentTask){
    const state=imageRetryState(p),confirmed=state?.certainty==='confirmed_missing';
    const task={id:p.lastFailure.taskId||crypto.randomUUID(),kind:'image',target:p.lastFailure.key,status:confirmed?'failed_no_output':'unknown_result',errorCode:confirmed?p.lastFailure.kind:'network',attempt:1,providerInvocationLimit:1,providerInvocations:p.lastFailure.attempts||0,startedAt:p.lastFailure.at,completedAt:p.lastFailure.at};
    p.tasks=Array.isArray(p.tasks)?p.tasks:[];p.tasks.push(task);p.currentTask=task;migrated=true;
  }
  if(p.pending&&!fs.existsSync(p.pending.file)){
    const failure=definiteImageFailure(p.pending);
    if(failure){
      const sample=/(?:样张-|sample-)([12])/.exec(p.pending.key||'');
      if(sample)sampleRepairCount(p,Number(sample[1])-1);
      const task=(p.tasks||[]).find(item=>item.id===p.pending.taskId);
      const taskPatch={status:'failed_no_output',errorCode:failure.kind,providerInvocations:failure.attempts||0,completedAt:new Date().toISOString()};
      if(task)Object.assign(task,taskPatch);
      if(p.currentTask?.id===p.pending.taskId)Object.assign(p.currentTask,taskPatch);
      p.pending=null;p.lastFailure=failure;p.status='attention';p.message=failureMessage(failure);p.error=p.message;saveProject(p);continue;
    }
  }
  const retryState=imageRetryState(p);
  if(retryState&&!p.pending&&['attention','paused'].includes(p.status)){
    const message=retryState.certainty==='confirmed_missing'?failureMessage(retryState.failure):unknownResultMessage(retryState.target);
    if(p.status!=='attention'||p.message!==message){p.status='attention';p.message=message;p.error=message;migrated=true;}
  }
  if(['attention','paused'].includes(p.status)&&p.progress?.startedAt&&!p.progress.completedAt){p.progress.completedAt=p.lastFailure?.at||p.updatedAt||new Date().toISOString();migrated=true;}
  if(migrated)saveProject(p);
  const queued=interrupted.get(p.id);
  if(queued?.status==='recoverable'){p.status='paused';p.message='上次有一步尚未开始，已安全保留。点击“继续制作”后会重新进入队列。';p.queueJob={id:queued.id,status:'recoverable',phase:queued.phase,queuedAt:queued.queuedAt};saveProject(p);}
  else if(['planning','sampling','generating','revising'].includes(p.status)||queued?.status==='interrupted'){p.status='paused';p.message='上次制作已暂停，已完成的内容都保留了。执行中的图片会先保留并核对，不会自动重生。';p.queueJob=queued?{id:queued.id,status:'interrupted',phase:queued.phase}:null;saveProject(p);}
}}
export function createProject(brief){
  if(typeof brief.idea!=='string'||brief.idea.trim().length<4||brief.idea.length>12000)throw new Error('请用至少四个字描述想画的故事。');
  if(!Number.isInteger(brief.pageCount)||brief.pageCount<1||brief.pageCount>12)throw new Error('每篇请选择1—12页。');
  const clean={idea:brief.idea.trim(),pageCount:brief.pageCount,special:String(brief.special||'').slice(0,6000),allowXiaolin:brief.allowXiaolin===true,tangyuan:['按剧情','自然出现','不出现'].includes(brief.tangyuan)?brief.tangyuan:'按剧情',model:String(brief.model||''),reasoningEffort:String(brief.reasoningEffort||'medium'),workflowPreset:['quick','balanced','careful'].includes(brief.workflowPreset)?brief.workflowPreset:'balanced'};
  const p={id:crypto.randomUUID(),schemaVersion:3,revision:0,title:clean.idea.slice(0,20),titleLocked:false,brief:clean,status:'draft',message:'需求已保存',createdAt:new Date().toISOString(),version:0,plan:null,approved:null,samplesApproved:false,samples:[],sampleRepairCounts:[0,0],lastFailure:null,currentTask:null,tasks:[],panels:{},pages:[],history:[],revisionNotes:[],accepted:false,progress:{phase:'draft',current:0,total:1,unit:'步骤',startedAt:null,completedAt:null},metrics:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalRuns:0}};saveProject(p);return p;
}
export function job(p,phase,fn){
  if(active.has(p.id))throw new Error('这篇正在制作，请等待或先暂停。');
  const controller=new AbortController(),queued=jobStore.enqueue({projectId:p.id,phase,submitter:queueOwner});active.set(p.id,controller);runningProjects.set(p.id,p);
  p.queueJob={id:queued.id,status:'queued',phase,queuedAt:queued.queuedAt};p.error=null;p.message='正在等待前一项本地创作任务完成…';p.progress={...p.progress,phase:'queued',startedAt:queued.queuedAt,completedAt:null};saveProject(p);
  const run=async()=>{
    let claimed=null,beat=null;
    try{
      while(!controller.signal.aborted&&!claimed){if(jobStore.read(queued.id)?.status!=='queued')break;claimed=jobStore.claim(queued.id,queueOwner);if(!claimed){jobStore.reclaimOrphanedLock();await wait(200);}}
      if(!claimed){jobStore.cancel(queued.id,'paused',{reason:'cancelled_before_start'});p.status='paused';p.message='已暂停，尚未开始这一步。';p.progress={...p.progress,completedAt:new Date().toISOString()};return;}
      p.queueJob={id:queued.id,status:'running',phase,queuedAt:queued.queuedAt,startedAt:claimed.startedAt};p.status=phase;p.progress={...p.progress,phase,startedAt:claimed.startedAt,completedAt:null};saveProject(p);
      beat=setInterval(()=>jobStore.heartbeat(queued.id,queueOwner),5000);
      try{await fn(controller.signal);jobStore.finish(queued.id,queueOwner,'completed');}
      catch(e){p.status=controller.signal.aborted||e.code==='LOW_QUOTA'?'paused':'attention';p.error=String(e.message||e).slice(0,2000);p.message=p.error;p.progress={...p.progress,completedAt:new Date().toISOString()};if(p.currentTask?.status==='running')finishTask(p,p.currentTask,p.status==='paused'?'paused':'failed',{error:p.error});saveProject(p);jobStore.finish(queued.id,queueOwner,controller.signal.aborted?'paused':'failed',{error:p.error});}
    }finally{if(beat)clearInterval(beat);p.queueJob=null;try{saveProject(p);}finally{active.delete(p.id);runningProjects.delete(p.id);}}
  };
  queueTail=queueTail.catch(()=>{}).then(run);return p;
}
function checkpoint(signal){if(signal.aborted)throw new Error('已暂停');}
function activity(p,message,current=null,total=null,unit=null){p.message=message;p.progress={...p.progress,phase:p.status,current:current??p.progress?.current??0,total:total??p.progress?.total??1,unit:unit??p.progress?.unit??'步骤'};if(p.currentTask?.status==='running')p.currentTask.lastProgressAt=new Date().toISOString();saveProject(p);}
function addUsage(p,usage){if(!usage)return;p.metrics=p.metrics||{};for(const key of ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'])p.metrics[{input_tokens:'inputTokens',cached_input_tokens:'cachedInputTokens',output_tokens:'outputTokens',reasoning_output_tokens:'reasoningOutputTokens'}[key]]=(p.metrics[{input_tokens:'inputTokens',cached_input_tokens:'cachedInputTokens',output_tokens:'outputTokens',reasoning_output_tokens:'reasoningOutputTokens'}[key]]||0)+(Number(usage[key])||0);p.metrics.totalRuns=(p.metrics.totalRuns||0)+1;}
function modelArgs(p,effort=p.brief.reasoningEffort){return {model:p.brief.model||null,reasoningEffort:effort};}
function promptHash(value){return crypto.createHash('sha256').update(String(value),'utf8').digest('hex');}
// Panel plans are authored for a whole comic page, while this call produces one
// source image for a fixed local slot. Keep narrative details intact, but make
// the slot geometry the only layout instruction sent to the image task.
function compilePanelText(value){
  return String(value||'')
    .replace(/\d+(?:\.\d+)?\s*[:：xX×]\s*\d+(?:\.\d+)?/g,'本地分镜比例')
    .replace(/(?:横|竖)(?:版|幅|构图|画面)|(?:正方形|方形)(?:画幅|构图|画面)?/g,'本地分镜画幅')
    .replace(/(?:四宫格|三宫格|九宫格|双联画|三联画|多格(?:漫画)?|分格(?:漫画)?|拼贴(?:画面)?|一页\s*\d+\s*格|\d+\s*格(?:漫画|画面))/g,'单幅独立画面');
}
function compilePanelPrompt(pageNumber,panelNumber,panel,geometry,revisionNotes=[]){
  const narrative={
    scene:panel.scene,characters:panel.characters,costume:panel.costume,action:panel.action,
    gaze:panel.gaze,expression:panel.expression,lighting:panel.lighting,layers:panel.layers,
    objects:panel.objects,anchors:panel.anchors,forbidden:panel.forbidden,
    captionForStory:panel.caption,captionKind:panel.captionKind,
    creatorPrompt:compilePanelText(panel.prompt),
  };
  const localLayout={
    width:geometry.width,height:geometry.height,ratio:geometry.ratio,
    instruction:`仅生成一张独立原始分镜；画面宽高比必须严格为 ${geometry.width}:${geometry.height}（${geometry.ratio}）。不要添加分格线、拼贴、多格布局、字幕或文字。`,
  };
  return `第${pageNumber}页第${panelNumber}格。\n本地排版唯一布局（优先级最高）：${JSON.stringify(localLayout)}\n故事与连续性要求：${JSON.stringify(narrative)}\ncaption仅供理解故事，绝对不要画入原图；内屏文字由后期单独处理。\n当前修订记录：${JSON.stringify(revisionNotes)}`;
}
function promptTelemetry(prompt,refs,extra={}){
  return {promptSha256:promptHash(prompt),promptCharacters:String(prompt).length,referenceAttachmentCount:refs.length,recordedAt:new Date().toISOString(),...extra};
}
async function protectQuota(p){
  let limits=await rateLimitSnapshot(),remaining=Number(limits?.primary?.remainingPercent);
  // Close to the stop threshold, refresh once instead of relying on a short
  // cache. This keeps the guard conservative without paying an account-read
  // startup cost before every normal panel.
  if(Number.isFinite(remaining)&&remaining<=12){limits=await rateLimitSnapshot(12000,{force:true});remaining=Number(limits?.primary?.remainingPercent);}
  if(!Number.isFinite(remaining)){p.lastQuotaCheck={remaining:null,checkedAt:new Date().toISOString(),status:'unavailable'};saveProject(p);return;}
  p.lastQuotaCheck={remaining,resetsAt:limits.primary?.resetsAt,checkedAt:new Date().toISOString(),status:'fresh'};saveProject(p);
  if(remaining<10){const when=limits.primary?.resetsAt?new Date(limits.primary.resetsAt*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'下一次额度重置后';const error=new Error(`5小时创作额度只剩 ${Math.floor(remaining)}%。当前工作节点已经保存，并已暂停新的生图。建议在 ${when} 之后点击“继续制作”。`);error.code='LOW_QUOTA';throw error;}
}
export function refreshQuotaPauses(remaining){
  if(!Number.isFinite(Number(remaining))||Number(remaining)<10)return 0;
  let changed=0;
  for(const p of listProjects()){
    if(active.has(p.id)||!/5小时创作额度只剩\s*\d+%/.test(String(p.message||p.error||'')))continue;
    const retry=imageRetryState(p);
    p.status=retry?'attention':'paused';
    p.message=retry?(retry.certainty==='confirmed_missing'?failureMessage(retry.failure):unknownResultMessage(retry.target)):'额度已恢复，可以继续制作。';
    p.error=retry?p.message:null;
    p.lastQuotaCheck={remaining:Number(remaining),checkedAt:new Date().toISOString(),status:'fresh'};
    saveProject(p);changed++;
  }
  return changed;
}
function runDir(p,label){return path.join(projectDir(p.id),'.制作记录',`${Date.now()}-${crypto.randomUUID().slice(0,8)}-${label}`);}
function beginTask(p,kind,target,detail={}){
  const now=new Date().toISOString();p.tasks=Array.isArray(p.tasks)?p.tasks:[];
  // A user-requested retry is a new attempt, never an invisible continuation
  // of the failed provider call.  Keeping this number makes the on-disk run
  // history useful after a restart without pretending it is a provider count.
  const attempt=p.tasks.filter(item=>item.kind===kind&&item.target===target).length+1;
  const task={id:crypto.randomUUID(),kind,target,status:'running',attempt,startedAt:now,lastProgressAt:now,...detail};
  p.tasks.push(task);p.tasks=p.tasks.slice(-80);p.currentTask=task;saveProject(p);return task;
}
function finishTask(p,task,status,extra={}){if(!task)return;Object.assign(task,{status,completedAt:new Date().toISOString(),...extra});if(p.currentTask?.id===task.id)p.currentTask=task;saveProject(p);}
function recordArtifact(p,id,kind,file,dependsOn=[]){p.artifacts=Array.isArray(p.artifacts)?p.artifacts:[];p.artifacts=p.artifacts.filter(x=>x.id!==id);p.artifacts.push({id,kind,file,dependsOn,valid:true,at:new Date().toISOString()});p.artifacts=p.artifacts.slice(-200);}
function invalidateArtifacts(p,ids){
  // A panel can feed a page, which in turn feeds the story audit and export.
  // Walk the graph until it stops changing so a later export can never look valid
  // after one of its source images was replaced.
  const invalid=new Set(ids),artifacts=p.artifacts||[];let changed=true;
  while(changed){
    changed=false;
    for(const artifact of artifacts){
      if(!invalid.has(artifact.id)&&artifact.dependsOn?.some(dep=>invalid.has(dep))){invalid.add(artifact.id);changed=true;}
    }
  }
  for(const artifact of artifacts)if(invalid.has(artifact.id))artifact.valid=false;
  return [...invalid];
}
function repairActions(report){return new Set((report?.issueDetails||[]).filter(x=>x.severity==='blocking'||x.severity==='review').map(x=>x.repairAction));}
function runEvidence(dir){
  const response=path.join(dir||'','response.txt'),events=path.join(dir||'','events.jsonl');let text='',eventText='',usage=null;
  if(response&&fs.existsSync(response))text=fs.readFileSync(response,'utf8');
  if(events&&fs.existsSync(events)){
    eventText=fs.readFileSync(events,'utf8');
    for(const line of eventText.split('\n')){try{const e=JSON.parse(line);if(e.type==='turn.completed'&&e.usage)usage=e.usage;}catch{}}
  }
  return {text,eventText,usage};
}
function definiteImageFailure(pending,extra=''){
  if(!pending?.dir)return null;const evidence=runEvidence(pending.dir),classified=readGenerationEvidence(pending.dir),combined=[extra,evidence.text,evidence.eventText].filter(Boolean).join('\n');
  const manifest=readWebManifest(path.join(pending.dir,'web-generation.json'));
  // Once the chat message was sent, absence of a local file is never proof
  // that the provider produced no image. Preserve it for recovery instead.
  if(manifest?.submitted)return null;
  if(manifest?.state==='failed'){
    const unavailable=/(?:IAB|Browser is not available)/i.test(String(manifest.errorCode||manifest.error||''));
    return {kind:unavailable?'browser-unavailable':'no-output',definiteNoOutput:true,key:pending.key,attempts:0,inputTokens:Number(evidence.usage?.input_tokens)||0,diagnostics:generationDiagnosticSummary(classified),at:new Date().toISOString()};
  }
  if(NETWORK_FAILURE.test(combined)||classified.connectionRelated)return null;
  const manifestError=[manifest?.errorCode,manifest?.error].filter(Boolean).join(' ');
  if(IAB_UNAVAILABLE.test(combined)||IAB_UNAVAILABLE.test(manifestError))return {kind:'browser-unavailable',definiteNoOutput:true,key:pending.key,attempts:0,inputTokens:Number(evidence.usage?.input_tokens)||0,diagnostics:generationDiagnosticSummary(classified),at:new Date().toISOString()};
  if(!DEFINITE_NO_IMAGE.test(combined)&&!DEFINITE_NO_IMAGE.test(manifestError)&&classified.outcome!=='no_image')return null;
  const attempts=Math.max(1,(evidence.eventText.match(/image generation failed/gi)||[]).length);
  return {kind:'no-output',definiteNoOutput:true,key:pending.key,attempts,inputTokens:Number(evidence.usage?.input_tokens)||0,diagnostics:generationDiagnosticSummary(classified),at:new Date().toISOString()};
}
function failureMessage(failure){const usage=failure.inputTokens?`本次后台处理记录约 ${failure.inputTokens.toLocaleString('zh-CN')} 输入 tokens；`:'';const action=String(failure.key||'').includes('样张')?'重试当前样张':'重试当前图片';if(failure.kind==='browser-unavailable')return `Codex 网页后台暂不可用，没有打开你的浏览器，也没有提交图片请求。${usage}当前节点已经保存；Codex 内嵌浏览器可用后点击“${action}”，只会重试这一张。`;return `${failure.kind==='network'?'生图服务连接失败':'本次生图未完成'}：已发起 ${failure.attempts} 次图片请求，但没有取得图片。${usage}自动重试已停止，上一张样张和当前节点都已保存。实际订阅余额以页面顶部为准；网络稳定后点击“${action}”，只会重试这一张。`;}
function sampleRepairCount(p,index){
  p.sampleRepairCounts=Array.isArray(p.sampleRepairCounts)?p.sampleRepairCounts:[0,0];
  const parsed=Number(/自动修订(\d+)/.exec(p.samples[index]?.key||'')?.[1])||0;
  p.sampleRepairCounts[index]=Math.max(Number(p.sampleRepairCounts[index])||0,parsed);return p.sampleRepairCounts[index];
}
function normalizeQA(result){const details=Array.isArray(result.issueDetails)?result.issueDetails:[];if(!details.length&&Array.isArray(result.issues))result.issueDetails=result.issues.map((description,i)=>({id:`legacy-${i+1}`,category:/(?:画幅|比例|竖图)/.test(description)?'aspect_ratio':'uncertain',severity:'review',location:'待确认',description,repairAction:'review'}));return result;}
function materialSampleIssues(issues=[],details=[]){if(details.length)return details.filter(x=>x.category!=='aspect_ratio').map(x=>x.description);return issues.filter(x=>!/(?:2\s*[:：]\s*3|3\s*[:：]\s*4).*(?:画幅|比例|竖图)|(?:画幅|比例|竖图).*(?:2\s*[:：]\s*3|3\s*[:：]\s*4)/i.test(x));}
function sampleAccepted(sample){return Boolean(sample?.qa?.pass||sample?.userDecision?.action==='accept_current');}
function sampleIndexFromKey(key=''){
  const match=/(?:样张-|sample-)([12])/.exec(key);
  return match?Number(match[1])-1:null;
}
function panelKeyFromImageKey(key=''){
  const chinese=/第(\d+)页-第(\d+)格/.exec(key);
  if(chinese)return `${chinese[1]}-${chinese[2]}`;
  const legacy=/^(\d+)-(\d+)(?:-|$)/.exec(key);
  return legacy?`${legacy[1]}-${legacy[2]}`:null;
}
function attachImageRecord(p,record){
  const sampleIndex=sampleIndexFromKey(record.key);
  if(sampleIndex!==null){p.samples=Array.isArray(p.samples)?p.samples:[];p.samples[sampleIndex]=record;return;}
  const panelKey=panelKeyFromImageKey(record.key);
  if(panelKey){p.panels=p.panels||{};p.panels[panelKey]=record;}
}
function sampleNeedsExplicitDecision(sample){
  if(!sample||sampleAccepted(sample))return false;
  if(['pending','unavailable','recovered_pending_review'].includes(sample.qa?.status))return true;
  return materialSampleIssues(sample.qa?.issues||[],sample.qa?.issueDetails||[]).length>0;
}
function blockedSampleIndexes(p){
  return (p.samples||[]).flatMap((sample,index)=>sampleNeedsExplicitDecision(sample)?[index]:[]);
}
function requireSampleDecision(p,indexes=blockedSampleIndexes(p)){
  const blocked=indexes.filter(index=>p.samples?.[index]&&!sampleAccepted(p.samples[index]));
  if(!blocked.length)return false;
  p.samplesApproved=false;
  p.samplesDecision={state:'required',sampleIndexes:blocked.map(index=>index+1),at:new Date().toISOString(),issues:blocked.map(index=>({sample:index+1,issues:p.samples[index]?.qa?.issues||[]}))};
  p.status='samples_decision';p.error=null;
  p.message=`样张已停止自动修订。请查看第 ${blocked.map(index=>index+1).join('、')} 张样张，并明确选择“采用当前样张”或“重新生成当前样张”。在你决定前不会开始正式画稿。`;
  saveProject(p);return true;
}
export function planProject(p,revision=''){
  if(revision && !p.plan)throw new Error('请先生成完整方案。');
  if(revision && revision.length>6000)throw new Error('修改说明过长。');
  return job(p,'planning',async signal=>{
    activity(p,revision?'正在把修改同步到逐页方案和连续性台账…':'正在构思故事、逐页分镜和文案…');
    const plan=await runCodex({prompt:plannerPrompt(p.brief,p.plan,revision),schema:PLAN_SCHEMA,dir:runDir(p,'故事方案'),images:FACE.map(x=>path.join(REFS,x)),signal,...modelArgs(p)});addUsage(p,plan.__usage);
    checkpoint(signal);validatePlan(plan,p.brief);
    if(p.plan)p.history.push({version:p.version,plan:p.plan,approved:p.approved,samples:p.samples,pages:p.pages,panels:p.panels,revisionNotes:p.revisionNotes});
    p.version++;p.plan=plan;if(!p.titleLocked)p.title=plan.title;p.approved=null;p.samplesApproved=false;p.samples=[];p.sampleRepairCounts=[0,0];p.lastFailure=null;p.panels={};p.pages=[];p.artifacts=[];p.revisionNotes=[];p.storyQA=null;p.accepted=false;p.bundle=null;
    p.status='review';activity(p,'逐页方案已备好。看过并确认后，才会开始生图。');
    fs.writeFileSync(path.join(projectDir(p.id),`方案-v${p.version}.md`),planMarkdown(plan,p.brief,p.version));
  });
}
function versionDir(p){return path.join(projectDir(p.id),`v${p.version}`);}
function promptCapsule(p){return `《温蒂的日常》固定制作胶囊\n- 温蒂身份以两张固定人设为准；默认高丸子头、脸部与体型连续。本篇已确认分镜若明确写出游泳、洗发、睡前等发型变化，以本篇分镜为准。\n- 小林：${p.brief.allowXiaolin?'本篇按已确认分镜出现':'禁止出现或暗示'}。汤圆：${p.brief.tangyuan}。\n- 风格、住宅、服装和物件以本版本参考附件为准。\n- 单格生图不含中文、字幕、分格线、logo或水印；文字统一后期排版。\n- 动作、视线、手脚和关键物件自然完整，保留8%安全区。\n- 画面干净清晰，无明显噪点。\n连续性：${JSON.stringify(p.plan.continuity)}`;}
function requiredRefs(p){return new Set([...FACE,...p.plan.samples.flatMap(q=>q.references),...p.plan.pages.flatMap(q=>q.panels.flatMap(r=>r.references))]);}
// Older projects can predate the complete version snapshot. Restore only missing
// files from the approved plan, keeping every existing per-version record intact.
function ensureVersionFiles(p){
  if(!p.plan||!p.version)throw new Error('当前作品没有可用于恢复的已确认方案。');
  const dir=versionDir(p);fs.mkdirSync(dir,{recursive:true});
  const files=[
    ['工作要求快照.md',()=>rules()],
    ['制作提示词胶囊.txt',()=>promptCapsule(p)],
    ['已确认分镜.md',()=>planMarkdown(p.plan,p.brief,p.version)],
    ['已确认方案.json',()=>JSON.stringify(p.plan,null,2)],
  ];
  for(const [name,content] of files){const file=path.join(dir,name);if(!fs.existsSync(file))fs.writeFileSync(file,content());}
  for(const ref of requiredRefs(p)){
    const source=inside(REFS,ref);if(!fs.existsSync(source))throw new Error(`固定参考素材缺失：${ref}。请在“人物与世界”中恢复该素材后再试。`);
    const target=inside(path.join(dir,'参考'),ref);if(!fs.existsSync(target)){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
  }
}
export function approvePlan(p,hash){
  if(active.has(p.id))throw new Error('方案仍在整理中。');
  if(p.status!=='review'||!p.plan||digest(p.plan)!==hash)throw new Error('方案已更新，请重新查看并确认当前版本。');
  const worker=webWorkerStatus();if(!worker.ready)throw new Error(worker.message);
  validatePlan(p.plan,p.brief);
  const text=rules();ensureVersionFiles(p);
  p.approved={version:p.version,hash,rulesHash:digest(text),at:new Date().toISOString()};p.accepted=false;
  saveProject(p);return sampleProject(p);
}
function verifyApproval(p){if(!p.approved||p.approved.version!==p.version||p.approved.hash!==digest(p.plan))throw new Error('请先确认当前完整方案。');}
function imageRefs(p,refnames){ensureVersionFiles(p);return [...new Set([...FACE,...refnames])].map(x=>inside(path.join(versionDir(p),'参考'),x));}
async function qa(p,file,prompt,refs,signal,kind='原始分镜'){
  const sampleRule=kind==='方向样张'?'本次只是锁定人物与场景方向的样张，标准2:3或3:4竖幅都可接受；不要仅因它是2:3竖幅而判失败或要求再次生图。正式漫画页才要求统一3:4。':'';
  const result=await runCodex({dir:runDir(p,'画面校对'),schema:QA_SCHEMA,images:[file,...refs],signal,...modelArgs(p,'low'),
    prompt:`你是漫画验收编辑。只看附件检查，不使用工具，不修改文件。${kind.startsWith('全套')?'附件是按页码顺序排列的全套成稿，后面才是两张固定人设参考。检查整套跨页连续性，不把不同页的合理动作差异当成人设变化。':'第一张是待检'+kind+'，其他是固定身份或环境参考。'}逐项检查：${CHECKS.join('；')}；身份以两张温蒂人设为准，检查五官发髻、双肩两臂两手每手五指(只检查可见部分，合理遮挡不算缺失)、两腿两脚；不能无故正视镜头，禁止错误角色；没有明显颗粒彩噪或脏污。${kind==='原始分镜'?'原始分镜不能有中文或字幕，后期会加。':'检查所有中文完整准确、无乱码、紧凑文字框不挡主体、页码一致。'}检查比例构图、头发四肢安全区。不要把合理的风格差别或被遮挡的肢体当成问题。${sampleRule}每个问题必须返回issueDetails：category只能是 identity/anatomy/text/layout/aspect_ratio/safe_area/noise/continuity/uncertain；severity为 blocking/review/suggestion；repairAction为 regenerate/reletter/recompose/review。冻结要求：${prompt}\n返回pass、summary、issues、issueDetails及精准的repairPrompt。`});addUsage(p,result.__usage);return normalizeQA(result);
}
function generatedCandidates(dir,after){
  if(!dir)return [];
  const events=path.join(dir,'events.jsonl');if(!fs.existsSync(events))return null;
  let thread;
  for(const line of fs.readFileSync(events,'utf8').split('\n')){try{const e=JSON.parse(line);if(e.type==='thread.started')thread=e.thread_id;}catch{}}
  if(!thread||!/^[a-f0-9-]{36}$/.test(thread))return null;
  const home=process.env.CODEX_HOME||path.join(process.env.HOME,'.codex');
  const folder=path.join(home,'generated_images',thread);if(!fs.existsSync(folder))return null;
  return fs.readdirSync(folder).filter(x=>/\.(png|webp|jpe?g)$/i.test(x)).map(x=>path.join(folder,x)).filter(file=>{
    try{return fs.statSync(file).isFile()&&fs.statSync(file).mtimeMs>=after-5000;}catch{return false;}
  }).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
}
function extensionForImage(info,file){
  const format=String(info?.format||'').toLowerCase();
  if(format==='jpeg')return '.jpg';if(['png','webp'].includes(format))return `.${format}`;
  const ext=path.extname(file).toLowerCase();return ['.png','.webp','.jpg','.jpeg'].includes(ext)?ext:null;
}
function checksum(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
async function verifyImage(file){
  const info=JSON.parse(await pythonRun(['info',file]));const extension=extensionForImage(info,file);
  if(!extension)throw new Error('已找到的文件不是可用的 PNG、JPG 或 WebP 图片。');
  return {...info,extension,sizeBytes:fs.statSync(file).size,sha256:checksum(file)};
}
async function persistImage(source,target){
  if(!fs.existsSync(source))return null;
  const temp=`${target}.partial-${crypto.randomUUID()}`;fs.copyFileSync(source,temp);
  try{
    const integrity=await verifyImage(temp);const finalFile=target.replace(/\.[^.]+$/,integrity.extension);
    fs.renameSync(temp,finalFile);if(source===target&&finalFile!==target)fs.unlinkSync(target);return {file:finalFile,integrity};
  }catch(error){try{fs.unlinkSync(temp);}catch{}throw error;}
}
function writeRunResult(dir,result){if(dir)jsonWrite(path.join(dir,'result.json'),result);}
function writeRunRequest(dir,p,task,pending){
  const summarize=file=>{try{return {name:path.basename(file),sizeBytes:fs.statSync(file).size,sha256:checksum(file)};}catch{return {name:path.basename(file),missing:true};}};
  jsonWrite(path.join(dir,'request.json'),{schemaVersion:2,provider:pending.provider||'legacy',taskId:task.id,attempt:task.attempt,target:pending.key,createdAt:pending.at,
    projectVersion:p.version,expectedOutput:path.relative(projectDir(p.id),pending.file),model:p.brief.model||null,reasoningEffort:p.brief.reasoningEffort,
    promptSha256:pending.telemetry.promptSha256,promptCharacters:pending.telemetry.promptCharacters,referenceNames:pending.refs,referenceFiles:pending.inputFiles.map(summarize),editTarget:pending.prior?summarize(pending.prior):null,source:task.source});
}
function previousConversation(prior){
  if(!prior)return null;
  try{
    const record=JSON.parse(fs.readFileSync(prior+'.json','utf8'));
    return /^https:\/\/chatgpt\.com\/c\/[^\s?#]+/.test(String(record.conversationUrl||''))?String(record.conversationUrl):null;
  }catch{return null;}
}
function attributableCandidates(pending){
  const evidence=readGenerationEvidence(pending.dir||''),inputs=new Set((pending.inputFiles||[]).map(file=>path.resolve(file)));
  const target=fs.existsSync(pending.file)?[pending.file]:[];
  const reported=(evidence.imagePaths||[]).filter(file=>path.isAbsolute(file)&&fs.existsSync(file));
  const legacy=pending.provider===WEB_IMAGE_PROVIDER?[]:(generatedCandidates(pending.dir,Date.parse(pending.at))||[]);
  const candidates=[...new Set([...target,...reported,...legacy].map(file=>path.resolve(file)).filter(file=>!inputs.has(file)))];
  return {evidence,candidates};
}
async function generate(p,key,prompt,refnames,signal,prior=null,verify=true,qaKind='原始分镜',attempt=1){
  checkpoint(signal);await protectQuota(p);checkpoint(signal);const refs=imageRefs(p,refnames);const folder=path.join(versionDir(p),'素材');fs.mkdirSync(folder,{recursive:true});
  if(p.pending)throw new Error('当前图片任务尚未结束，请先检查已有原图。');
  let file=path.join(folder,`${key}-${Date.now()}.png`);const dir=runDir(p,key);const inputFiles=prior?[prior,...refs]:refs;const telemetry=promptTelemetry(prompt,refs,{requestedReferenceCount:refnames.length,source:prior?'edit':'generate'});const task=beginTask(p,'image',key,{attempt,provider:WEB_IMAGE_PROVIDER,providerInvocationLimit:1,providerInvocations:0,source:prior?'edit':'generate',telemetry});const pending={key,file,dir,prompt,refs:refnames,inputFiles,prior,provider:WEB_IMAGE_PROVIDER,taskId:task.id,telemetry,at:new Date().toISOString()};
  writeRunRequest(dir,p,task,pending);p.pending=pending;p.lastFailure=null;saveProject(p);
  let failure,made=null;const manifestFile=path.join(dir,'web-generation.json'),conversationUrl=previousConversation(prior),capsule=fs.readFileSync(path.join(versionDir(p),'制作提示词胶囊.txt'),'utf8');
  try{
    if(process.env.WENDI_TEST_PLAN_FILE){
      task.providerInvocations=1;saveProject(p);
      made=await runCodex({dir,signal,image:true,browserMode:'iab',writableDirs:[projectDir(p.id)],...modelArgs(p),
        prompt:chatGptWebImagePrompt({outputFile:file,manifestFile,prompt,referenceFiles:inputFiles,editTarget:prior,conversationUrl,capsule})});
    }else{
      made=await dispatchChatGptWebJob({codexBin:findCodex(),dir,outputFile:file,prompt,referenceFiles:inputFiles,editTarget:prior,conversationUrl,capsule,signal});
    }
    addUsage(p,made.usage);
  }catch(e){failure=e;}
  const webManifest=readWebManifest(manifestFile)||failure?.webManifest||made?.manifest||null;
  task.providerInvocations=webManifest?.submitted?1:(process.env.WENDI_TEST_PLAN_FILE?task.providerInvocations:0);saveProject(p);
  // A transport error after download must not trigger a second image request.
  // Prefer the explicit output path, then a path explicitly reported by this
  // browser run. Legacy tasks alone retain the old generated_images fallback.
  // Ambiguous candidates are recorded but never guessed at.
  const {evidence,candidates}=attributableCandidates(pending);
  let persisted=null;
  if(fs.existsSync(file))persisted=await persistImage(file,file);
  else if(candidates.length===1)persisted=await persistImage(candidates[0],file);
  if(!persisted){
    const candidateNames=candidates.map(candidate=>path.basename(candidate));
    writeRunResult(dir,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,attempt:task.attempt,endedAt:new Date().toISOString(),outcome:'artifact_not_located',diagnostics:generationDiagnosticSummary(evidence),candidateCount:candidateNames.length,candidateNames,error:failure?String(failure.message||failure).slice(0,500):null});
    const known=definiteImageFailure(pending,[made?.text,failure?.message,webManifest?.errorCode,webManifest?.error].filter(Boolean).join('\n'));
    if(known){if(known.kind==='browser-unavailable')task.providerInvocations=0;p.pending=null;p.lastFailure={...known,taskId:task.id};finishTask(p,task,'failed_no_output',{errorCode:known.kind});saveProject(p);const error=new Error(failureMessage(known));error.code='IMAGE_NO_OUTPUT';throw error;}
    finishTask(p,task,'unknown_result',{errorCode:'unknown_result'});
    throw failure||new Error('连接在保存结果前中断。当前节点已保存，请先检查已有原图，避免重复生成。');
  }
  file=persisted.file;pending.file=file;pending.integrity=persisted.integrity;
  writeRunResult(dir,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,attempt:task.attempt,endedAt:new Date().toISOString(),outcome:'artifact_saved',artifact:path.relative(projectDir(p.id),file),integrity:persisted.integrity,diagnostics:generationDiagnosticSummary(evidence)});
  // Persist the recovered file before asking the model to inspect it. A QA
  // timeout is never evidence that the image did not exist, and must not make
  // the next click repeat a paid image request.
  const record={key,file:path.relative(projectDir(p.id),file),provider:WEB_IMAGE_PROVIDER,conversationUrl:webManifest?.conversationUrl||conversationUrl||null,prompt,refs:refnames,telemetry,integrity:persisted.integrity,qa:verify?{pass:null,status:'pending',summary:'原图已保存，等待画面校对。',issues:[],repairPrompt:''}:{pass:true,status:'deferred',summary:'已完成本地文件检查；将在整页成稿中统一校对。',issues:[],repairPrompt:''},at:new Date().toISOString()};
  jsonWrite(file+'.json',record);recordArtifact(p,`image:${key}`,'image',record.file,prior?[`image:${key.replace(/-局部修订$/,'')}`]:[]);attachImageRecord(p,record);p.pending=null;p.lastFailure=null;finishTask(p,task,'artifact_saved',{artifact:file,qa:verify?'pending':'deferred'});saveProject(p);
  if(!verify)return record;
  try{
    checkpoint(signal);
    const check=await qa(p,file,prompt,refs,signal,qaKind);
    record.qa=check;jsonWrite(file+'.json',record);finishTask(p,task,'completed',{artifact:file,qa:check.pass?'passed':'needs_review'});saveProject(p);return record;
  }catch(error){
    record.qa={...record.qa,status:'unavailable',summary:'原图已保存，但自动画面校对没有完成。可在网页中查看并决定下一步。',qaError:String(error.message||error).slice(0,500)};
    jsonWrite(file+'.json',record);finishTask(p,task,'artifact_saved_unchecked',{artifact:file,qa:'unavailable',error:String(error.message||error).slice(0,500)});saveProject(p);throw error;
  }
}
export function sampleProject(p){verifyApproval(p);return job(p,'sampling',async signal=>{
  for(const [i,sample] of p.plan.samples.entries()){
    let current=p.samples[i]||null;
    if(sampleAccepted(current))continue;
    // A file can be safely saved while a separate QA request is interrupted.
    // Do not silently treat an unavailable QA report as a pass or regenerate
    // the image; let the creator decide after seeing the retained original.
    if(current?.qa?.status==='pending'||current?.qa?.status==='unavailable'){
      requireSampleDecision(p,[i]);return;
    }
    const label=i===0?'人物脸部':'主场景';let issues=materialSampleIssues(current?.qa?.issues||[],current?.qa?.issueDetails||[]);
    if(current&&!issues.length){current.qa={...current.qa,pass:true,issues:[],repairPrompt:'',summary:`${current.qa.summary}；该图为方向样张，标准2:3竖幅可直接用于确认。`};saveProject(p);continue;}
    if(!current){
      activity(p,`正在绘制${label}样张（${i+1}/2）…`);
      current=await generate(p,`样张-${i+1}`,`${sample.prompt}。单幅竖图，优先3:4；若内置生图返回标准2:3竖幅，保留原图，不裁切，也不要因此再次生图。`,sample.references,signal,null,true,'方向样张');
      p.samples[i]=current;saveProject(p);if(current.qa.pass)continue;issues=materialSampleIssues(current.qa.issues,current.qa.issueDetails||[]);
      if(!issues.length){current.qa={...current.qa,pass:true,issues:[],repairPrompt:'',summary:`${current.qa.summary}；该图为方向样张，标准2:3竖幅可直接用于确认。`};saveProject(p);continue;}
    }
    if(!current.qa.pass){requireSampleDecision(p,[i]);return;}
  }
  p.status='samples_review';activity(p,'两张样张已备好，请确认人物和主场景，再继续整篇。');
});}
export function approveSamples(p,hash){verifyApproval(p);if(p.status!=='samples_review'||p.approved.hash!==hash||p.samples.length!==2||p.samples.some(sample=>!sampleAccepted(sample)))throw new Error('两张样张尚未通过检查或明确确认。');p.samplesApproved=true;p.sampleAcceptance={mode:p.samples.some(sample=>sample?.userDecision?.action==='accept_current')?'explicit_user_decision':'qa_pass',at:new Date().toISOString()};saveProject(p);return generatePages(p);}
// HTTP/UI contract: decision.action is either `accept_current` or
// `regenerate_current`; sampleIndex is one-based and optional when only one
// sample is awaiting a decision. `hash`, when provided, must be the currently
// approved plan hash. Acceptance applies only to the displayed sample and then
// resumes the sample stage, never starts formal panels without a later final
// samples approval.
export function decideSamples(p,decision={}){
  verifyApproval(p);if(active.has(p.id))throw new Error('样张仍在制作中，请等待当前任务结束。');
  const action=typeof decision==='string'?decision:decision.action;
  const hash=typeof decision==='object'?decision.hash:null;
  if(hash&&hash!==p.approved.hash)throw new Error('方案已更新，请重新查看当前样张后再决定。');
  if(!['accept_current','regenerate_current'].includes(action))throw new Error('请选择采用当前样张或重新生成当前样张。');
  const blocked=blockedSampleIndexes(p);
  const requested=Number(typeof decision==='object'?decision.sampleIndex:NaN);
  const index=Number.isInteger(requested)&&requested>=1&&requested<=p.plan.samples.length?requested-1:blocked[0];
  const current=p.samples?.[index];
  if(index===undefined||!current)throw new Error('没有可供决定的当前样张。');
  if(action==='accept_current'){
    current.userDecision={action:'accept_current',at:new Date().toISOString(),issues:current.qa?.issues||[]};
    p.samplesApproved=false;p.samplesDecision=null;p.status='paused';p.error=null;p.message=`已明确采用第 ${index+1} 张当前样张。`;saveProject(p);
    return sampleProject(p);
  }
  p.sampleDecisionHistory=Array.isArray(p.sampleDecisionHistory)?p.sampleDecisionHistory:[];
  p.sampleDecisionHistory.push({action:'regenerate_current',sample:index+1,at:new Date().toISOString(),previousKey:current.key,issues:current.qa?.issues||[]});
  p.samples[index]=null;p.sampleRepairCounts=Array.isArray(p.sampleRepairCounts)?p.sampleRepairCounts:[0,0];p.sampleRepairCounts[index]=0;p.samplesApproved=false;p.samplesDecision=null;p.status='paused';p.error=null;p.message=`将重新生成第 ${index+1} 张样张；旧图仍保留在作品文件中。`;saveProject(p);
  return sampleProject(p);
}
async function composePage(p,page,signal){
  const dir=runDir(p,`第${page.number}页排版`);const output=path.join(versionDir(p),'候选成稿',`${String(page.number).padStart(2,'0')}-${Date.now()}.png`);
  const images=page.panels.map((_,i)=>inside(projectDir(p.id),p.panels[`${page.number}-${i+1}`].file));
  jsonWrite(path.join(dir,'排版.json'),{page,total:p.plan.pages.length,images,output});
  await pythonRun(['compose',path.join(dir,'排版.json')]);checkpoint(signal);
  activity(p,`正在核对第 ${page.number} 页的文字、画面和连续性…`);
  const report=await qa(p,output,JSON.stringify(page),imageRefs(p,[...new Set(page.panels.flatMap(q=>q.references))]),signal,'1080×1440最终漫画页');
  const result={number:page.number,file:path.relative(projectDir(p.id),output),qa:report,at:new Date().toISOString(),dependsOn:page.panels.map((_,i)=>`image:第${page.number}页-第${i+1}格`)};
  p.pages=p.pages.filter(q=>q.number!==page.number);p.pages.push(result);p.pages.sort((a,b)=>a.number-b.number);recordArtifact(p,`page:${page.number}`,'page',result.file,result.dependsOn);saveProject(p);
  if(!report.pass){
    const actions=[...repairActions(report)],onlyLayout=actions.length>0&&actions.every(action=>['reletter','recompose','review'].includes(action));
    result.nextStep=onlyLayout?(actions.includes('reletter')?'重新排字':'重新排版'):'查看或修订';saveProject(p);
    if(!onlyLayout)throw new Error(`第 ${page.number} 页需要查看或修订：${report.issues.join('；')}`);
  }
  return result;
}
async function addScreen(p,key,panel,signal){
  if(!panel.screenText || p.panels[key].screenApplied)return;
  const record=p.panels[key];const input=inside(projectDir(p.id),record.rawFile||record.file);
  const dir=runDir(p,'内屏文字排版');const output=path.join(dir,'内屏排版.png');
  activity(p,`正在把第 ${key.split('-')[0]} 页的文字排进玻璃内屏…`);
  const composed=await runCodex({dir,signal,image:true,images:[input],...modelArgs(p,'low'),
    prompt:`执行已经授权的确定性漫画中文后期排版。这不是生图任务，不触发任何新的图片生成，不调用浏览器，不覆盖原图。原图 ${input} 已附上，请视觉检查原始尺寸，识别手机或车机的玻璃内屏四角、圆角、边框、刘海、手指遮挡和反光。用本机Python与Pillow、STHeiti字体，绘制正确中文界面并透视变换到内屏坐标系，圆角遮罩、手指遮挡必须保留，反光融合而非不透明平面截图浮贴。不要修改屏幕外任何像素。内屏逐字内容：${panel.screenText}。界面状态与要求：${panel.screenDirection}。有输入、删除、灰色不可发送等状态时准确表现差异。写出布局数据与可复用脚本到本次目录，再输出 ${output}。完成后查看局部放大及全图核对，若无法可靠定位内屏不要猜测，不生成假完成图片，说明原因。最终仅返回真实输出路径。`});addUsage(p,composed.usage);
  checkpoint(signal);if(!fs.existsSync(output))throw new Error('这张内屏的透视位置还需调整，原图已保留，请补充修改要求。');
  await pythonRun(['info',output]);
  const report=await qa(p,output,JSON.stringify(panel),[input,...imageRefs(p,panel.references)],signal,'已添加内屏中文的单分镜；必须核对内屏逐字文案、透视、手指遮挡及屏幕外保持不变');
  if(!report.pass)throw new Error('内屏文字需要调整：'+report.issues.join('；'));
  record.rawFile=record.rawFile||record.file;record.file=path.relative(projectDir(p.id),output);record.screenApplied=true;record.screenQA=report;saveProject(p);
}
export function generatePages(p){verifyApproval(p);if(!p.samplesApproved)throw new Error('请先确认人物和场景样张。');return job(p,'generating',async signal=>{
  const totalPanels=p.plan.pages.reduce((n,page)=>n+page.panels.length,0),verifyPanels=p.brief.workflowPreset==='careful';let completed=Object.keys(p.panels).length;
  for(const page of p.plan.pages){
    if(p.pages.find(q=>q.number===page.number)?.qa.pass)continue;
    const geoFile=path.join(runDir(p,'分镜比例'),'page.json');jsonWrite(geoFile,page);
    const geometry=JSON.parse(await pythonRun(['geometry',geoFile]));
    for(const [i,q] of page.panels.entries()){
      const key=`${page.number}-${i+1}`;
      const existing=p.panels[key];
      if(existing?.qa?.pass){await addScreen(p,key,q,signal);continue;}
      // This may be a file recovered after an interrupted local copy or a QA
      // outage. It is a real retained image, not a signal to spend another
      // generation request when the creator presses Continue.
      if(existing?.file){
        p.status='attention';p.message=`第 ${page.number} 页第 ${i+1} 格的原图已保存，但${existing.qa?.status==='recovered_pending_review'?'尚未自动校对':'需要人工查看'}。请在网页中查看后决定修改或继续；继续制作不会自动重生这张图。`;saveProject(p);return;
      }
      checkpoint(signal);activity(p,`正在绘制第 ${page.number}/${p.plan.pages.length} 页 · 第 ${i+1}/${page.panels.length} 格…`,completed,totalPanels,'分镜');
      const g=geometry[i];const prompt=compilePanelPrompt(page.number,i+1,q,g,p.revisionNotes.filter(x=>x.key===key));
      const result=await generate(p,`第${page.number}页-第${i+1}格`,prompt,q.references,signal,null,verifyPanels);
      p.panels[key]=result;saveProject(p);
      if(verifyPanels&&!result.qa.pass){
        // Quality review is advisory. The single source image remains attached
        // and the next paid image request must come from an explicit user edit.
        p.status='attention';p.message=`第 ${page.number} 页第 ${i+1} 格的原图已保存，画面检查建议：${(result.qa.issues||[]).join('；')||'请人工查看'}。系统不会自动重画；请查看后选择“修改这张图”，或确认采用当前图再继续。`;saveProject(p);return;
      }
      await addScreen(p,key,q,signal);completed++;activity(p,`已完成 ${completed}/${totalPanels} 个分镜`,completed,totalPanels,'分镜');
    }
    const composed=await composePage(p,page,signal);
    if(!composed.qa.pass){
      p.status='attention';p.message=`第 ${page.number} 页原图已保留；质检建议${composed.nextStep}，无需重新生图。请查看成稿后决定是否修改分镜或文案。`;saveProject(p);return;
    }
    activity(p,`已完成并校对：${p.pages.filter(x=>x.qa.pass).length}/${p.plan.pages.length} 页`);
  }
  // Whole-story review catches errors invisible in isolated page checks.
  if(p.brief.workflowPreset!=='quick'){
    activity(p,'整篇已排好，正在按页码复核连续性…',totalPanels,totalPanels,'分镜');
    const audit=await qa(p,inside(projectDir(p.id),p.pages[0].file),JSON.stringify(p.plan),[...p.pages.slice(1).map(q=>inside(projectDir(p.id),q.file)),...imageRefs(p,[])],signal,'全套漫画，按附件顺序检查跨页服装、场景、物件、文案与阅读节奏');
    p.storyQA=audit;recordArtifact(p,'story:audit','story-audit',null,p.pages.map(page=>`page:${page.number}`));saveProject(p);if(!audit.pass)throw new Error('整篇连续性需要调整：'+audit.issues.join('；'));
  }else {p.storyQA={pass:true,summary:'快速模式：已逐页校对，整篇连续性由最终人工验收确认。',issues:[],repairPrompt:''};recordArtifact(p,'story:audit','story-audit',null,p.pages.map(page=>`page:${page.number}`));}
  p.status='ready';p.progress.completedAt=new Date().toISOString();activity(p,'整篇已完成检查。请浏览全套，满意后收下成品。',totalPanels,totalPanels,'分镜');
});}
export function reviseImage(p,key,note){
  verifyApproval(p);if(typeof note!=='string'||note.trim().length<2||note.length>4000)throw new Error('请描述要改动的地方。');
  let old,refs,prompt;
  const sample=/^sample-([12])$/.exec(key);const panel=/^(\d+)-(\d+)$/.exec(key);
  if(sample){old=p.samples[+sample[1]-1];const s=p.plan.samples[+sample[1]-1];refs=s.references;prompt=s.prompt;}
  else if(panel){old=p.panels[key];const q=p.plan.pages[+panel[1]-1]?.panels[+panel[2]-1];if(!q)throw new Error('分镜不存在');refs=q.references;prompt=old?.prompt;}
  else throw new Error('分镜不存在');if(!old)throw new Error('这张图尚未生成');
  return job(p,'revising',async signal=>{
    activity(p,'正在按你的说明修改这一张，原版本会保留…');p.accepted=false;
    p.revisionNotes.push({key,note,at:new Date().toISOString()});
    const result=await generate(p,key+'-局部修订',prompt+'\n用户已确认本次修改：'+note+'\n只改指定内容，其余保持。',refs,signal,inside(projectDir(p.id),old.file));
    if(sample){p.samples[+sample[1]-1]=result;p.samplesApproved=false;p.status=p.samples.length===2&&p.samples.every(q=>q.qa.pass)?'samples_review':'attention';}
    else {p.panels[key]=result;const pageId=+panel[1];p.pages=p.pages.filter(q=>q.number!==pageId);invalidateArtifacts(p,[`image:${key}`,`page:${pageId}`]);p.storyQA=null;p.bundle=null;if(result.qa.pass)await addScreen(p,key,p.plan.pages[pageId-1].panels[+panel[2]-1],signal);if(result.qa.pass)await composePage(p,p.plan.pages[pageId-1],signal);p.status='paused';}
    saveProject(p);if(!result.qa.pass)throw new Error(result.qa.issues.join('；'));activity(p,sample?'样张已更新，请重新确认。':'这一格已修好并更新页面，可以继续制作与整篇校对。');
  });
}
export function resume(p){if(p.pending){
  if(fs.existsSync(p.pending.file))throw new Error('上次已收到原图但尚未校对，请先使用“找回已生成图片”。');
  throw new Error('上次生成结果尚未确认，请先使用“找回已生成图片”，避免重复生成。');
}if(!p.approved)return planProject(p);
  if(!p.samplesApproved){
    if(requireSampleDecision(p))return p;
    return sampleProject(p);
  }
  return generatePages(p);
}
export function retryableImageFailure(p){
  const state=imageRetryState(p);return state?.certainty==='confirmed_missing'?state.failure:null;
}
export function imageRetryState(p){
  const task=p.currentTask;
  if(p.pending){
    if(task?.status==='unknown_result'&&task.target===p.pending.key)return {certainty:'unknown_result',target:task.target,failure:{kind:'network',definiteNoOutput:false,key:task.target,attempts:task.providerInvocations||1,taskId:task.id,at:task.completedAt||p.updatedAt||new Date().toISOString()}};
    return null;
  }
  const failure=p.lastFailure;
  if(failure?.key){
    if(['no-output','browser-unavailable'].includes(failure.kind)&&failure.definiteNoOutput===true)return {certainty:'confirmed_missing',target:failure.key,failure};
    if(failure.kind==='network')return {certainty:'unknown_result',target:failure.key,failure};
  }
  if(!task?.target||!['failed_no_output','unknown_result'].includes(task.status))return null;
  if(task.status==='failed_no_output'&&['no-output','browser-unavailable'].includes(task.errorCode))return {certainty:'confirmed_missing',target:task.target,failure:{kind:task.errorCode,definiteNoOutput:true,key:task.target,attempts:task.errorCode==='browser-unavailable'?0:(task.providerInvocations||1),taskId:task.id,at:task.completedAt||p.updatedAt||new Date().toISOString()}};
  return {certainty:'unknown_result',target:task.target,failure:{kind:'network',definiteNoOutput:false,key:task.target,attempts:task.providerInvocations||1,taskId:task.id,at:task.completedAt||p.updatedAt||new Date().toISOString()}};
}
function unknownResultMessage(target='当前图片'){return `${target} 的连接在结果确认前中断，无法证明远端是否已经生成。系统不会自行重试；你可以先检查本地记录，或明确选择重新生成这一张。`;}
export function retryMissingImage(p,target,{allowUnknownResult=false}={}){
  verifyApproval(p);const state=imageRetryState(p),failure=state?.failure;
  if(p.pending&&!(allowUnknownResult&&state?.certainty==='unknown_result'))throw new Error('上次生成结果尚未确认，请先检查已保存图片。');
  if(!state||state.target!==target||(state.certainty==='unknown_result'&&!allowUnknownResult))throw new Error('当前没有可安全重试的这张图片。');
  const sampleIndex=sampleIndexFromKey(target),panelKey=panelKeyFromImageKey(target);
  if(sampleIndex===null&&!panelKey)throw new Error('无法识别需要重试的图片。');
  if(p.pending){
    p.supersededPending=Array.isArray(p.supersededPending)?p.supersededPending:[];
    p.supersededPending.push({...p.pending,supersededAt:new Date().toISOString(),reason:'explicit_unknown_result_retry'});p.supersededPending=p.supersededPending.slice(-20);p.pending=null;
  }
  p.lastFailure=null;p.error=null;
  return job(p,'revising',async signal=>{
    activity(p,`正在只重新生成 ${target}…`);
    if(sampleIndex!==null){
      const sample=p.plan.samples[sampleIndex];if(!sample)throw new Error('对应样张不存在。');
      const result=await generate(p,`样张-${sampleIndex+1}`,`${sample.prompt}。单幅竖图，优先3:4；若内置生图返回标准2:3竖幅，保留原图，不裁切，也不要因此再次生图。`,sample.references,signal,null,true,'方向样张',Math.max(1,Number(failure.attempts||0)+1));
      p.samples[sampleIndex]=result;p.samplesApproved=false;p.samplesDecision=null;p.status='paused';activity(p,`${target} 已重新生成并保存，请查看后继续。`,p.samples.filter(Boolean).length,2,'样张');return;
    }
    const [pageNumber,panelNumber]=panelKey.split('-').map(Number),page=p.plan.pages[pageNumber-1],panel=page?.panels[panelNumber-1];if(!panel)throw new Error('对应分镜不存在。');
    const geoFile=path.join(runDir(p,'分镜比例'),'page.json');jsonWrite(geoFile,page);const geometry=JSON.parse(await pythonRun(['geometry',geoFile]))[panelNumber-1];
    const prompt=compilePanelPrompt(pageNumber,panelNumber,panel,geometry,p.revisionNotes.filter(x=>x.key===panelKey||x.key===target));
    const result=await generate(p,`第${pageNumber}页-第${panelNumber}格`,prompt,panel.references,signal,null,p.brief.workflowPreset==='careful','原始分镜',Math.max(1,Number(failure.attempts||0)+1));
    p.panels[panelKey]=result;p.pages=p.pages.filter(item=>item.number!==pageNumber);invalidateArtifacts(p,[`image:${panelKey}`,`page:${pageNumber}`]);p.storyQA=null;p.bundle=null;p.accepted=false;p.status='paused';const totalPanels=p.plan.pages.reduce((total,item)=>total+item.panels.length,0);activity(p,`${target} 已重新生成并保存；本次不会继续生成其他分镜。`,Object.keys(p.panels).length,totalPanels,'分镜');
  });
}
export function recoverImage(p){verifyApproval(p);if(!p.pending)throw new Error('没有待找回的图片');return job(p,'revising',async()=>{
  const pending=p.pending;
  let file=pending.file;
  const {evidence,candidates}=attributableCandidates(pending);
  let persisted=null;
  if(fs.existsSync(file))persisted=await persistImage(file,file);
  else if(candidates.length===1)persisted=await persistImage(candidates[0],file);
  if(!persisted){
    writeRunResult(pending.dir,{schemaVersion:2,provider:pending.provider||'legacy',taskId:pending.taskId||null,endedAt:new Date().toISOString(),outcome:'artifact_still_unknown',diagnostics:generationDiagnosticSummary(evidence),candidateCount:candidates.length,candidateNames:candidates.map(candidate=>path.basename(candidate))});
    const known=definiteImageFailure(pending);
    if(known){p.pending=null;p.lastFailure=known;const task=(p.tasks||[]).find(item=>item.id===pending.taskId);finishTask(p,task,'failed_no_output',{errorCode:known.kind});saveProject(p);throw new Error(failureMessage(known));}
    throw new Error('连接在保存结果前中断，系统仍无法确认是否已经生成。稍后可再次检查已有原图；检查本身不会重新生图。');
  }
  file=persisted.file;pending.file=file;
  writeRunResult(pending.dir,{schemaVersion:2,provider:pending.provider||'legacy',taskId:pending.taskId||null,endedAt:new Date().toISOString(),outcome:'artifact_recovered',artifact:path.relative(projectDir(p.id),file),integrity:persisted.integrity,diagnostics:generationDiagnosticSummary(evidence)});
  // Recovery is deliberately local-only. It attaches a verified file to the
  // project but does not run the model QA again and therefore never consumes a
  // new model call or image opportunity.
  const record={key:pending.key,file:path.relative(projectDir(p.id),file),provider:pending.provider||'legacy',prompt:pending.prompt,refs:pending.refs,integrity:persisted.integrity,qa:{pass:null,status:'recovered_pending_review',summary:'原图已找回，尚未自动校对。请查看图片后选择继续或修改。',issues:[],repairPrompt:''},at:new Date().toISOString()};
  jsonWrite(file+'.json',record);recordArtifact(p,`image:${pending.key}`,'image',record.file);attachImageRecord(p,record);
  const sampleIndex=sampleIndexFromKey(pending.key);if(sampleIndex!==null)sampleRepairCount(p,sampleIndex);
  p.pending=null;p.lastFailure=null;p.status='paused';const task=(p.tasks||[]).find(item=>item.id===pending.taskId);finishTask(p,task,'recovered_local',{artifact:file,qa:'not_run'});activity(p,'原图已找回并挂接到作品。未重新生图，也没有再次自动校对。');
});}
export function reviewImage(p,key){
  verifyApproval(p);if(p.pending)throw new Error('请先完成这次原图找回，再重新校对。');
  const sample=/^sample-([12])$/.exec(key);const panel=/^(\d+)-(\d+)$/.exec(key);let record,refs,prompt,kind;
  if(sample){record=p.samples?.[Number(sample[1])-1];const definition=p.plan.samples?.[Number(sample[1])-1];refs=definition?.references;prompt=definition?.prompt;kind='方向样张';}
  else if(panel){record=p.panels?.[key];const definition=p.plan.pages?.[Number(panel[1])-1]?.panels?.[Number(panel[2])-1];refs=definition?.references;prompt=record?.prompt||definition?.prompt;kind='原始分镜';}
  else throw new Error('请选择已保存的样张或原始分镜。');
  if(!record?.file||!refs||!prompt)throw new Error('这张图片没有可用于重新校对的完整记录。');
  return job(p,'revising',async signal=>{
    const file=inside(projectDir(p.id),record.file);const integrity=await verifyImage(file);
    const task=beginTask(p,'review',record.key||key,{artifact:record.file,source:'manual_review'});
    record.integrity=integrity;record.qa={pass:null,status:'pending',summary:'原图已保存，正在重新校对。',issues:[],repairPrompt:''};saveProject(p);
    try{
      const report=await qa(p,file,prompt,imageRefs(p,refs),signal,kind);record.qa=report;
      jsonWrite(file+'.json',record);finishTask(p,task,'completed',{artifact:file,qa:report.pass?'passed':'needs_review'});
      p.status='paused';p.error=null;p.message=report.pass?'原图已重新校对，可以继续下一步。':'原图已重新校对，请查看建议后决定是否修改。';saveProject(p);return record;
    }catch(error){
      record.qa={pass:null,status:'unavailable',summary:'原图仍已保存，但这次自动画面校对没有完成。',issues:[],repairPrompt:'',qaError:String(error.message||error).slice(0,500)};
      jsonWrite(file+'.json',record);finishTask(p,task,'review_failed',{artifact:file,error:record.qa.qaError});saveProject(p);throw error;
    }
  });
}
export async function accept(p,checks){
  if(active.has(p.id)||p.status!=='ready'||p.pages.length!==p.plan.pages.length||p.pages.some(q=>!q.qa.pass)||!p.storyQA?.pass)throw new Error('请先完成全篇制作和校对。');
  if(!Array.isArray(checks)||!CHECKS.every(c=>checks.includes(c)))throw new Error('请先完成成稿验收。');
  const finalDir=path.join(versionDir(p),'成品');fs.mkdirSync(finalDir,{recursive:true});
  for(const q of p.pages){const file=path.join(finalDir,`${String(q.number).padStart(2,'0')}.png`);fs.copyFileSync(inside(projectDir(p.id),q.file),file);q.finalFile=path.relative(projectDir(p.id),file);}
  const dir=runDir(p,'作品打包');const output=path.join(versionDir(p),'温蒂漫画成品.zip');
  jsonWrite(path.join(dir,'zip.json'),{output,files:[...p.pages.map(q=>inside(projectDir(p.id),q.finalFile)),path.join(versionDir(p),'已确认分镜.md')]});
  await pythonRun(['zip',path.join(dir,'zip.json')]);
  p.accepted=true;p.acceptance={at:new Date().toISOString(),checks};p.bundle=path.relative(projectDir(p.id),output);recordArtifact(p,'export:bundle','export',p.bundle,['story:audit']);p.status='complete';activity(p,'成品已保存到本地，可以下载整套图片。');return p;
}
