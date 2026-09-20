import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DATA,REFS,FACE,CHECKS,jsonWrite,inside,rules,digest,validatePlan,PLAN_SCHEMA,QA_SCHEMA,plannerPrompt,planMarkdown} from './workflow.mjs';
import {runCodex,pythonRun,rateLimitSnapshot,readGenerationEvidence,generationDiagnosticSummary,findCodex} from './bridge.mjs';
import {JobStore} from './job-store.mjs';
import {WEB_IMAGE_PROVIDER,WEB_IMAGE_EXECUTOR_ROLE,WEB_IMAGE_EXECUTOR_EFFORT,chatGptWebImagePrompt,dispatchChatGptWebJob,resumeChatGptWebJob,confirmedUnsentWebAudit,readWebManifest,webWorkerStatus} from './chatgpt-web-provider.mjs';
import {IMAGE_OUTCOME,SAVED_ARTIFACT_QA_MESSAGE,SavedArtifactQaUnavailableError,savedArtifactQaUnavailable,applySavedArtifactQaOutcome} from './image-lifecycle.mjs';
import {createTaskState,imageRetryState as deriveImageRetryState,retryableImageFailure as deriveRetryableImageFailure,unknownResultMessage as deriveUnknownResultMessage} from './task-state.mjs';
import {createImageRecovery} from './image-recovery.mjs';
import {readDownloadEvidence} from './web-download-evidence.mjs';
import {buildRevisionPrompt,revisionPromptTelemetry} from './revision-prompt.mjs';
export {buildRevisionPrompt,revisionPromptTelemetry};
export const active = new Map();
export const COMPOSITION_VERSION='no-page-title-v1';
const runningProjects = new Map();
fs.mkdirSync(DATA,{recursive:true});
const jobStore=new JobStore(DATA),queueOwner=`${process.pid}:${crypto.randomUUID()}`;let queueTail=Promise.resolve();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ID=/^[a-f0-9-]{36}$/;
const SCREEN_LOCATION_SCHEMA={type:'object',additionalProperties:false,required:['corners','confidence','screenType'],properties:{corners:{type:'array',minItems:4,maxItems:4,items:{type:'object',additionalProperties:false,required:['x','y'],properties:{x:{type:'number'},y:{type:'number'}}}},confidence:{type:'number',minimum:0,maximum:1},screenType:{type:'string',enum:['phone','computer','car','other']}}};
// Only phrases that explicitly say there was no usable image belong here. A
// connection error by itself is ambiguous: the provider can finish an image
// before the local copy step fails, so it must remain recoverable.
const DEFINITE_NO_IMAGE=/(?:未能生成(?:任何)?(?:替代品|图片)?|没有生成(?:任何)?(?:替代品|图片)?|未(?:产生|产出)(?:任何)?图片|未(?:生成|输出)(?:任何)?图片|没有(?:产生|产出)(?:任何)?图片|目标路径尚不存在|no image (?:was )?(?:generated|produced|created|returned)|(?:did not|didn't) (?:generate|produce|return) (?:an? )?image|image generation (?:produced|returned) no image)/i;
const NETWORK_FAILURE=/(?:network|connection|连接|网络|websocket)/i;
const IAB_UNAVAILABLE=/(?:Browser is not available:\s*iab|IAB[_\s-]*(?:UNAVAILABLE|NOT[_\s-]*AVAILABLE)|IAB[_\s-]*SESSION[_\s-]*LOST[_\s-]*BEFORE[_\s-]*SUBMIT|Capability is not available:\s*(?:visibility|browser)|隐藏\s*IAB.*不可用)/i;
const FILE_UPLOAD_CHROME_UNAVAILABLE=/(?:^|[^A-Z0-9_])FILE_UPLOAD_CHROME_UNAVAILABLE(?:$|[^A-Z0-9_])|(?:UPLOAD_ERROR[^\n]*(?:file chooser|文件选择器|附件入口|attachment control))/i;
const BROWSER_ORIGIN_PERMISSION_DENIED=/(?:^|[^A-Z0-9_])BROWSER_ORIGIN_PERMISSION_DENIED(?:$|[^A-Z0-9_])|Browser use cannot access\s+https?:\/\/chatgpt\.com\b[^\n]*(?:denied permission|permission denied|拒绝)|https?:\/\/chatgpt\.com\b[^\n]*(?:browser security policy|origin permission|访问权限被拒绝)/i;
const BROWSER_FOCUS_UNAVAILABLE=/(?:BROWSER_(?:FOCUS|TAB_BACKGROUND|CHROME)_(?:UNAVAILABLE|RESTORE_FAILED)|Browser is not available:\s*chrome|Chrome management capability is not advertised|焦点(?:恢复|管理)能力(?:不可用|未提供|未广告)|非前台(?:标签页|tab).*(?:不可用|失败)|后台标签页.*(?:不可用|失败)|无法恢复创作室焦点)/i;
const USAGE_LIMIT_ERROR=/(?:you'?ve hit your usage limit|usage limit(?: has been)? reached|rate limit reached|额度(?:已用尽|不足|限制)|使用额度(?:已用尽|不足)|hit your limit)/i;
const USAGE_LIMIT_BEFORE_START='USAGE_LIMIT_BEFORE_START';
const CONFIRMED_PRE_SUBMISSION_KINDS=new Set(['no-output','browser-unavailable','browser-origin-permission-denied','browser-upload-unavailable']);
export function projectDir(id){if(!ID.test(id))throw new Error('作品不存在');return inside(DATA,id);}
function inferredModelAt(p,at){
  const history=(p.modelHistory||[]).filter(item=>Date.parse(item.at)<=at).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  if(history.length)return history.at(-1).to||{};
  const first=(p.modelHistory||[]).slice().sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))[0]?.from;
  return first?.model?first:{model:'历史模型未记录',reasoningEffort:'unknown'};
}
function roleForRun(name,request={}){
  const metadata=request&&typeof request==='object'?request:{};
  if(typeof metadata.role==='string'&&metadata.role.trim())return metadata.role.trim();
  if(metadata.provider===WEB_IMAGE_PROVIDER)return WEB_IMAGE_EXECUTOR_ROLE;
  return /画面校对|内屏位置识别/.test(name)?'qa':'creative';
}
function hydrateMetricBreakdown(p){
  p.metrics=p.metrics||{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalRuns:0};
  if(Array.isArray(p.metrics.byRole))return p;
  const groups=new Map(),records=path.join(projectDir(p.id),'.制作记录'),runs=[];
  if(fs.existsSync(records))for(const name of fs.readdirSync(records)){
    const dir=path.join(records,name),events=path.join(dir,'events.jsonl');if(!fs.existsSync(events))continue;
    let usage=null;for(const line of fs.readFileSync(events,'utf8').split('\n')){try{const event=JSON.parse(line);if(event.type==='turn.completed'&&event.usage)usage=event.usage;}catch{}}
    if(!usage)continue;let request=null,execution=null;try{request=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'));}catch{}try{execution=JSON.parse(fs.readFileSync(path.join(dir,'execution.json'),'utf8'));}catch{}
    const recorded=request||execution,started=Number(name.split('-')[0])||fs.statSync(dir).birthtimeMs||fs.statSync(dir).mtimeMs,hasRecordedSelection=Boolean(recorded&&(['model','reasoningEffort','executorModel','executorReasoningEffort'].some(key=>Object.prototype.hasOwnProperty.call(recorded,key)))),selected=hasRecordedSelection?{model:(recorded.executorModel??recorded.model)||'默认模型',reasoningEffort:(recorded.executorReasoningEffort??recorded.reasoningEffort)||'unknown'}:inferredModelAt(p,started);runs.push({started,usage,selected,role:roleForRun(name,request??execution)});
  }
  runs.sort((a,b)=>a.started-b.started);const total=Number(p.metrics.totalRuns)||0,selectedRuns=total&&runs.length>total?runs.slice(-total):runs;let attributed=0;
  for(const {usage,selected,role} of selectedRuns){
    const model=selected.model||'历史模型未记录',effort=selected.reasoningEffort||'unknown',key=`${model}\u0000${effort}`,current=groups.get(key)||{model,reasoningEffort:effort,runs:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0};
    current.runs++;current.inputTokens+=Number(usage.input_tokens)||0;current.cachedInputTokens+=Number(usage.cached_input_tokens)||0;current.outputTokens+=Number(usage.output_tokens)||0;current.reasoningOutputTokens+=Number(usage.reasoning_output_tokens)||0;groups.set(key,current);attributed++;
    const roleKey=`${role}\u0000${key}`,roleRow=groups.get(roleKey)||null;
    if(!roleRow){groups.set(roleKey,{role,model,reasoningEffort:effort,runs:1,inputTokens:Number(usage.input_tokens)||0,cachedInputTokens:Number(usage.cached_input_tokens)||0,outputTokens:Number(usage.output_tokens)||0,reasoningOutputTokens:Number(usage.reasoning_output_tokens)||0});}
    else if(roleRow.role){roleRow.runs++;roleRow.inputTokens+=Number(usage.input_tokens)||0;roleRow.cachedInputTokens+=Number(usage.cached_input_tokens)||0;roleRow.outputTokens+=Number(usage.output_tokens)||0;roleRow.reasoningOutputTokens+=Number(usage.reasoning_output_tokens)||0;}
  }
  const roleRows=[...groups.values()].filter(row=>row.role);
  if(!Array.isArray(p.metrics.byModel))p.metrics.byModel=[...groups.values()].filter(row=>!row.role).sort((a,b)=>b.runs-a.runs);
  p.metrics.byRole=roleRows.sort((a,b)=>b.runs-a.runs);p.metrics.unattributedRuns=Math.max(0,(Number(p.metrics.totalRuns)||0)-attributed);return p;
}
function normalizeDeferredQA(p){
  for(const record of [...(p.samples||[]),...Object.values(p.panels||{})]){
    if(record?.qa?.status==='deferred'&&record.qa.pass===true){
      record.qa={...record.qa,pass:null,summary:record.qa.summary||'仅完成本地文件检查，尚未完成画面质检。'};
    }
  }
  return p;
}
export function readProject(id){const file=path.join(projectDir(id),'project.json');if(!fs.existsSync(file))throw new Error('作品不存在');return normalizeDeferredQA(hydrateMetricBreakdown(JSON.parse(fs.readFileSync(file,'utf8'))));}
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
const taskState=createTaskState({saveProject});
const {beginTask,finishTask}=taskState;
export function listProjects(){return fs.readdirSync(DATA).filter(id=>ID.test(id)&&fs.existsSync(path.join(DATA,id,'project.json'))).map(readProject).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export function recover(){
  const recoverable=jobStore.recoverable();
  for(const job of recoverable)if(job.status==='queued'){jobStore.cancel(job.id,'interrupted',{reason:'service_restarted_before_start'});job.status='recoverable';}
  const interrupted=new Map(recoverable.map(job=>[job.projectId,job]));
  for(const p of listProjects()){
  if(jobStore.hasLiveWork(p.id))continue;
  let migrated=false;
  if(quarantinePreSubmissionArtifacts(p))migrated=true;
  if(migrateBrowserUploadFailure(p))migrated=true;
  if(migrateOriginPermissionFailure(p))migrated=true;
  if(p.pending){
    const manifest=matchingPendingManifest(p.pending),quota=preAcceptanceQuotaEvidence(p.pending,manifest);
    if(quota){
      const task=(p.tasks||[]).find(item=>item.id===p.pending.taskId)||p.currentTask;
      const message=quotaPauseMessage(p.pending.key,manifest.requestId,p.pending.taskId,p.pending.projectVersion,quota.error);
      p.pending.requestId=manifest.requestId;p.pending.accepted=false;p.pending.submitted=false;p.pending.referenceCount=0;p.pending.quotaPaused=true;p.pending.quotaError=quota.error;
      if(task)Object.assign(task,{status:'paused',errorCode:USAGE_LIMIT_BEFORE_START,providerInvocations:0,webState:'queued',requestId:manifest.requestId,accepted:false,submitted:false,referenceCount:0,error:message});
      if(p.currentTask?.id===p.pending.taskId)Object.assign(p.currentTask,task||{});
      p.lastFailure=null;p.status='paused';p.error=message;p.message=message;migrated=true;
    }
  }
  if(p.lastFailure?.kind==='network'&&p.lastFailure.definiteNoOutput!==false){p.lastFailure.definiteNoOutput=false;migrated=true;}
  if(p.currentTask?.status==='failed_no_output'&&(!CONFIRMED_PRE_SUBMISSION_KINDS.has(p.currentTask.errorCode)||p.lastFailure?.kind==='network')){p.currentTask.status='unknown_result';p.currentTask.errorCode='network';p.status='attention';p.message=unknownResultMessage(p.currentTask.target);p.error=p.message;migrated=true;}
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
  const p={id:crypto.randomUUID(),schemaVersion:3,revision:0,title:clean.idea.slice(0,20),titleLocked:false,brief:clean,status:'draft',message:'需求已保存',createdAt:new Date().toISOString(),version:0,plan:null,approved:null,samplesApproved:false,samples:[],sampleRepairCounts:[0,0],lastFailure:null,currentTask:null,tasks:[],panels:{},pages:[],history:[],revisionNotes:[],accepted:false,progress:{phase:'draft',current:0,total:1,unit:'步骤',startedAt:null,completedAt:null,stages:[],stageSerial:0},metrics:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalRuns:0,byModel:[],byRole:[],unattributedRuns:0,refreshSerial:0}};saveProject(p);return p;
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
      try{await fn(controller.signal);finishProgressStage(p,'completed');jobStore.finish(queued.id,queueOwner,'completed');}
      catch(e){const savedArtifactQA=e instanceof SavedArtifactQaUnavailableError||e?.outcome===IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED||e?.outcome===IMAGE_OUTCOME.REVIEW_REQUIRED;if(savedArtifactQA){p.status='attention';p.error=SAVED_ARTIFACT_QA_MESSAGE;p.message=SAVED_ARTIFACT_QA_MESSAGE;p.progress={...p.progress,completedAt:new Date().toISOString()};finishProgressStage(p,'completed');saveProject(p);jobStore.finish(queued.id,queueOwner,'completed',{outcome:e?.outcome||IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED});}else{const quotaPause=e.code==='LOW_QUOTA'||e.code==='QUOTA_REFRESH_REQUIRED'||e.code===USAGE_LIMIT_BEFORE_START;p.status=controller.signal.aborted||quotaPause?'paused':'attention';p.error=String(e.message||e).slice(0,2000);p.message=p.error;p.progress={...p.progress,completedAt:new Date().toISOString()};finishProgressStage(p,p.status==='paused'?'paused':'failed');if(p.currentTask?.status==='running')finishTask(p,p.currentTask,p.status==='paused'?'paused':'failed',{error:p.error});saveProject(p);jobStore.finish(queued.id,queueOwner,controller.signal.aborted||quotaPause?'paused':'failed',{error:p.error});}}
    }finally{if(beat)clearInterval(beat);p.queueJob=null;try{saveProject(p);}finally{active.delete(p.id);runningProjects.delete(p.id);}}
  };
  queueTail=queueTail.catch(()=>{}).then(run);return p;
}
function checkpoint(signal){if(signal.aborted)throw new Error('已暂停');}
function stageTone(message){if(/失败|中断|需要调整|没有取得/.test(message))return 'error';if(/暂停|等待|准备/.test(message))return 'waiting';if(/绘制|生成|上传|提交/.test(message))return 'creating';if(/排版|文字|合成/.test(message))return 'composing';if(/核对|校对|复核|检查/.test(message))return 'reviewing';if(/完成|备好|保存|恢复/.test(message))return 'complete';return 'working';}
function finishProgressStage(p,state='completed'){
  const progress=p.progress||{};const current=progress.activeStage;if(!current)return;
  const endedAt=new Date().toISOString(),stage={...current,state,completedAt:endedAt,durationMs:Math.max(0,Date.parse(endedAt)-Date.parse(current.startedAt))};
  progress.stages=[...(progress.stages||[]),stage].slice(-24);progress.stageSerial=(Number(progress.stageSerial)||0)+1;progress.activeStage=null;p.progress=progress;
}
function activity(p,message,current=null,total=null,unit=null){
  const now=new Date().toISOString(),progress=p.progress||{};
  if(progress.activeStage?.label!==message){finishProgressStage(p,'completed');progress.activeStage={id:crypto.randomUUID(),label:message,tone:stageTone(message),state:'running',startedAt:now};}
  p.message=message;p.progress={...progress,phase:p.status,current:current??progress.current??0,total:total??progress.total??1,unit:unit??progress.unit??'步骤'};if(p.currentTask?.status==='running')p.currentTask.lastProgressAt=now;saveProject(p);
}
function addUsage(p,usage,{model=p.brief?.model||'默认模型',reasoningEffort=p.brief?.reasoningEffort||'unknown',role='creative'}={}){
  if(!usage)return;hydrateMetricBreakdown(p);p.metrics=p.metrics||{};const names={input_tokens:'inputTokens',cached_input_tokens:'cachedInputTokens',output_tokens:'outputTokens',reasoning_output_tokens:'reasoningOutputTokens'};
  for(const key of Object.keys(names))p.metrics[names[key]]=(p.metrics[names[key]]||0)+(Number(usage[key])||0);p.metrics.totalRuns=(p.metrics.totalRuns||0)+1;
  p.metrics.byModel=Array.isArray(p.metrics.byModel)?p.metrics.byModel:[];let row=p.metrics.byModel.find(item=>item.model===model&&item.reasoningEffort===reasoningEffort);if(!row){row={model,reasoningEffort,runs:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0};p.metrics.byModel.push(row);}row.runs++;row.inputTokens+=Number(usage.input_tokens)||0;row.cachedInputTokens+=Number(usage.cached_input_tokens)||0;row.outputTokens+=Number(usage.output_tokens)||0;row.reasoningOutputTokens+=Number(usage.reasoning_output_tokens)||0;
  p.metrics.byRole=Array.isArray(p.metrics.byRole)?p.metrics.byRole:[];let roleRow=p.metrics.byRole.find(item=>item.role===role&&item.model===model&&item.reasoningEffort===reasoningEffort);if(!roleRow){roleRow={role,model,reasoningEffort,runs:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0};p.metrics.byRole.push(roleRow);}roleRow.runs++;roleRow.inputTokens+=Number(usage.input_tokens)||0;roleRow.cachedInputTokens+=Number(usage.cached_input_tokens)||0;roleRow.outputTokens+=Number(usage.output_tokens)||0;roleRow.reasoningOutputTokens+=Number(usage.reasoning_output_tokens)||0;p.metrics.refreshSerial=(Number(p.metrics.refreshSerial)||0)+1;
}
function modelArgs(p,effort=p.brief.reasoningEffort){return {model:p.brief.model||null,reasoningEffort:effort};}
function browserExecutorArgs(p){return {model:p.brief.model||(process.env.WENDI_TEST_PLAN_FILE?'fixture-model':null),reasoningEffort:WEB_IMAGE_EXECUTOR_EFFORT,role:WEB_IMAGE_EXECUTOR_ROLE};}
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
function imageRecordAt(file){
  try{return JSON.parse(fs.readFileSync(`${file}.json`,'utf8'));}catch{return null;}
}
function preparedCacheFor(p,sourceFiles,prior){
  let versionCache=[];try{versionCache=JSON.parse(fs.readFileSync(path.join(versionDir(p),'上传附件缓存.json'),'utf8')).files||[];}catch{}
  const cache=[...versionCache,...(imageRecordAt(prior)?.telemetry?.preparedAttachments||[])],byHash=new Map(cache.filter(item=>item?.sourceSha256&&item.file).map(item=>[item.sourceSha256,item])),prepared=[],missing=[],sourceSha256s=[];
  for(const [index,source] of sourceFiles.entries()){
    const sourceSha256=checksum(source);sourceSha256s[index]=sourceSha256;const cached=byHash.get(sourceSha256);let cachedFile=null;
    if(cached?.file){try{cachedFile=inside(projectDir(p.id),cached.file);}catch{cachedFile=null;}}
    if(cachedFile&&fs.existsSync(cachedFile))prepared[index]={source,file:cachedFile,optimized:cached.optimized===true,sizeBytes:Number(cached.sizeBytes)||fs.statSync(cachedFile).size,reused:true};
    else missing.push({index,source,sourceSha256});
  }
  return {prepared,missing,sourceSha256s,cacheHits:prepared.filter(Boolean).length};
}
async function prepareWebAttachments(p,dir,sourceFiles,cachePlan){
  const prepared=cachePlan?.prepared||[],missing=cachePlan?.missing||sourceFiles.map((source,index)=>({index,source,sourceSha256:cachePlan?.sourceSha256s?.[index]||checksum(source)}));
  if(missing.length){const spec=path.join(dir,'上传素材.json');jsonWrite(spec,{files:missing.map(item=>item.source),outputDir:path.join(dir,'上传素材'),reusedCount:cachePlan?.cacheHits||0});const fresh=JSON.parse(await pythonRun(['prepare-web',spec]));for(const [index,item] of missing.entries()){const target=fresh[index];if(!target?.file)throw new Error('上传素材准备未完成。');prepared[item.index]={...target,reused:false};}}
  const cacheFile=path.join(versionDir(p),'上传附件缓存.json');let existing=[];try{existing=JSON.parse(fs.readFileSync(cacheFile,'utf8')).files||[];}catch{}const merged=new Map(existing.filter(item=>item?.sourceSha256&&item.file).map(item=>[item.sourceSha256,item]));for(const [index,item] of prepared.entries()){if(!item?.file)continue;let relative;try{relative=path.relative(projectDir(p.id),inside(projectDir(p.id),item.file));}catch{continue;}merged.set(cachePlan?.sourceSha256s?.[index]||checksum(sourceFiles[index]),{sourceSha256:cachePlan?.sourceSha256s?.[index]||checksum(sourceFiles[index]),file:relative,optimized:item.optimized===true,sizeBytes:Number(item.sizeBytes)||fs.statSync(item.file).size,updatedAt:new Date().toISOString()});}jsonWrite(cacheFile,{schemaVersion:1,files:[...merged.values()].slice(-200)});
  return prepared;
}
function executorLimitFor(limits,executorModel){
  if(!executorModel||!limits?.byLimitId||typeof limits.byLimitId!=='object')return null;
  const matches=Object.entries(limits.byLimitId).filter(([id,bucket])=>id!=='codex'&&bucket?.normalModelSlug===executorModel);
  return matches.length===1?{limitId:matches[0][0],...matches[0][1]}:null;
}
async function protectQuota(p,{executorModel=null}={}){
  // This guard runs immediately before a paid image request. A cached account
  // read is fine for ordinary status display, but it must never authorize a
  // new upload/send because the remaining quota may have changed meanwhile.
  const limits=await rateLimitSnapshot(12000,{force:true}),remaining=Number(limits?.primary?.remainingPercent),observedAt=Number(limits?.observedAt),checkedAt=new Date().toISOString(),status=typeof limits?.status==='string'&&limits.status?limits.status:'unavailable',ageMs=Date.now()-observedAt,fresh=status==='fresh'&&Number.isFinite(observedAt)&&observedAt>0&&ageMs>=0&&ageMs<=60_000&&Number.isFinite(remaining);
  const modelLimit=executorLimitFor(limits,executorModel),executorRemaining=Number(modelLimit?.primary?.remainingPercent),executorStatus=modelLimit?'fresh':'unavailable';
  p.lastQuotaCheck={remaining:Number.isFinite(remaining)?remaining:null,resetsAt:limits?.primary?.resetsAt||null,checkedAt,observedAt:Number.isFinite(observedAt)?observedAt:null,status,ageMs:Number.isFinite(observedAt)?ageMs:null,executorModel:executorModel||null,executorLimitId:modelLimit?.limitId||null,executorRemaining:Number.isFinite(executorRemaining)?executorRemaining:null,executorResetsAt:modelLimit?.primary?.resetsAt||null,executorStatus};saveProject(p);
  if(!fresh){const error=new Error(`无法确认最新的 5 小时创作额度（${status==='stale'?'本次读取只有旧快照':status==='unavailable'?'本次读取失败或不可用':'额度快照的新鲜度或数值无效'}），已暂停新的生图。请刷新额度后再点击“继续制作”；本次不会准备、上传或发送附件。`);error.code='QUOTA_REFRESH_REQUIRED';throw error;}
  // Model-specific buckets remain observable telemetry only. The generation
  // guard is intentionally based solely on the fresh account-wide five-hour
  // Codex window, regardless of the selected executor model.
  if(remaining<=10){const when=limits.primary?.resetsAt?new Date(limits.primary.resetsAt*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'下一次额度重置后';const error=new Error(`5小时创作额度只剩 ${Math.floor(remaining)}%。当前工作节点已经保存，并已暂停新的生图。建议在 ${when} 之后点击“继续制作”。`);error.code='LOW_QUOTA';throw error;}
}
export function refreshQuotaPauses(remaining){
  if(!Number.isFinite(Number(remaining))||Number(remaining)<=10)return 0;
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
function recordArtifact(p,id,kind,file,dependsOn=[],extra={}){p.artifacts=Array.isArray(p.artifacts)?p.artifacts:[];p.artifacts=p.artifacts.filter(x=>x.id!==id);p.artifacts.push({id,kind,file,dependsOn,valid:true,at:new Date().toISOString(),...extra});p.artifacts=p.artifacts.slice(-200);}
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
const imageRecovery=createImageRecovery({
  webImageProvider:WEB_IMAGE_PROVIDER,
  readGenerationEvidence,
  generationDiagnosticSummary,
  readWebManifest,
  pythonRun,
  jsonWrite,
  projectDir,
  inside,
  saveProject,
  job,
  verifyApproval,
  finishTask,
  activity,
  invalidatePanelDownstream,
  recordArtifact,
  attachImageRecord,
  artifactIdForImageKey,
  panelKeyFromImageKey,
  sampleIndexFromKey,
  sampleRepairCount,
  definiteImageFailure,
  failureMessage,
});
const {runEvidence,matchingWebRunRecord,matchingPendingManifest,checksum,verifyImage,inspectOrphanImageEvidence,persistImage,writeRunResult,attributableCandidates,recoverImage:recoverImageAction}=imageRecovery;
export {inspectOrphanImageEvidence};
function preAcceptanceQuotaEvidence(pending,manifest,failure=null,made=null){
  if(!pending||pending.provider!==WEB_IMAGE_PROVIDER||!manifest||manifest.state!=='queued'||manifest.accepted===true||manifest.submitted===true||Number(manifest.referenceCount)!==0)return null;
  const record=matchingWebRunRecord(pending);if(!record||record.manifest?.requestId!==manifest.requestId)return null;
  const execution=record.execution||{};if(execution.state!=='failed'||!USAGE_LIMIT_ERROR.test(String(execution.error||'')))return null;
  const evidence=runEvidence(record.dir);if(evidence.browserText.trim())return null;
  const error=String(failure?.message||made?.text||execution.error||manifest.error||'已达到生图执行器额度限制。');if(!USAGE_LIMIT_ERROR.test([failure?.code,error,manifest.errorCode,manifest.error].filter(Boolean).join('\n')))return null;
  return {manifest:record.manifest,execution,error};
}
function confirmedUnsentEvidence(pending,manifest){
  if(!pending||pending.provider!==WEB_IMAGE_PROVIDER||!manifest)return null;
  const record=matchingWebRunRecord(pending);if(!record||record.manifest?.requestId!==manifest.requestId)return null;
  const audit=confirmedUnsentWebAudit({dir:record.dir,expected:{projectId:pending.projectId,projectVersion:pending.projectVersion,taskId:pending.taskId,target:pending.key,requestId:manifest.requestId}});
  return audit?{record,audit}:null;
}
function quotaPauseMessage(target,requestId,taskId,projectVersion,error){
  return `本次${target||'生图'}执行器在接受请求前遇到额度限制，未上传附件或发送消息。已保留同一 requestId、taskId 和方案版本（${requestId||'requestId'} / ${taskId||'taskId'} / v${projectVersion}）；额度恢复后点击“继续制作”将续接原任务，不会创建第二个图片请求。原始错误：${String(error||'已达到生图执行器额度限制。').slice(0,1000)}`;
}
function manifestBrowserUnavailable(manifest){
  return /(?:IAB|WEB_WORKER_ARCHIVED|BROWSER(?:_[A-Z]+)*(?:_UNAVAILABLE|_FAILED)|BROWSER_ORIGIN_PERMISSION_DENIED|FILE_UPLOAD_CHROME_UNAVAILABLE|CHATGPT_LOGIN_REQUIRED|Browser is not available|Chrome management capability is not advertised|焦点(?:恢复|管理)能力)/i.test(String(manifest?.errorCode||manifest?.error||''));
}
function manifestBrowserFailureKind(manifest){
  const text=String(manifest?.errorCode||manifest?.error||'');
  if(FILE_UPLOAD_CHROME_UNAVAILABLE.test(text))return 'browser-upload-unavailable';
  if(BROWSER_ORIGIN_PERMISSION_DENIED.test(text))return 'browser-origin-permission-denied';
  return manifestBrowserUnavailable(manifest)?'browser-unavailable':null;
}
function originPermissionManifestForTask(p,task){
  if(!task||task.status!=='failed_no_output'||task.errorCode!=='browser-unavailable'||Number(task.providerInvocations)!==0)return null;
  if(p.lastFailure?.kind!=='browser-unavailable'||(p.lastFailure.key&&p.lastFailure.key!==task.target)||(p.lastFailure.taskId&&p.lastFailure.taskId!==task.id))return null;
  const expectedVersion=Number(task.projectVersion);if(!Number.isInteger(expectedVersion)||expectedVersion!==Number(p.version))return null;
  const records=path.join(projectDir(p.id),'.制作记录');if(!fs.existsSync(records))return null;
  for(const name of fs.readdirSync(records).reverse()){
    const pending={dir:path.join(records,name),taskId:task.id,projectId:p.id,projectVersion:expectedVersion,key:task.target,file:null};
    const record=matchingWebRunRecord(pending),manifest=record?.manifest;
    if(!record||manifest.state!=='failed'||manifest.accepted!==true||manifest.submitted!==false)continue;
    const evidence=runEvidence(record.dir),explicit=String(manifest.errorCode||'').trim();
    if(explicit&&explicit!=='BROWSER_ORIGIN_PERMISSION_DENIED')continue;
    if(explicit==='BROWSER_ORIGIN_PERMISSION_DENIED'||BROWSER_ORIGIN_PERMISSION_DENIED.test(evidence.browserText))return manifest;
  }
  return null;
}
function uploadUnavailableManifestForTask(p,task){
  if(!task||task.status!=='failed_no_output'||!['browser-origin-permission-denied','browser-unavailable','browser-upload-unavailable'].includes(task.errorCode)||Number(task.providerInvocations)!==0)return null;
  if(!['browser-origin-permission-denied','browser-unavailable','browser-upload-unavailable'].includes(p.lastFailure?.kind)||p.lastFailure?.key!==task.target||(p.lastFailure.taskId&&p.lastFailure.taskId!==task.id))return null;
  const expectedVersion=Number(task.projectVersion);if(!Number.isInteger(expectedVersion)||expectedVersion!==Number(p.version))return null;
  const records=path.join(projectDir(p.id),'.制作记录');if(!fs.existsSync(records))return null;
  for(const name of fs.readdirSync(records).reverse()){
    const pending={dir:path.join(records,name),taskId:task.id,projectId:p.id,projectVersion:expectedVersion,key:task.target,file:null};
    // A modern run must supply its exact output path. The pending file is not
    // available during startup migration, so compare request/worker output
    // only after the run identity has already been checked above.
    let worker;
    try{worker=JSON.parse(fs.readFileSync(path.join(pending.dir,'worker-request.json'),'utf8'));}catch{continue;}
    const outputFile=worker?.outputFile;
    if(!outputFile)continue;
    pending.file=outputFile;
    const record=matchingWebRunRecord(pending),manifest=record?.manifest;if(!record||manifest.state!=='failed'||manifest.accepted!==true||manifest.submitted!==false)continue;
    const evidence=runEvidence(record.dir),explicit=String(manifest.errorCode||'').trim();
    if(explicit==='FILE_UPLOAD_CHROME_UNAVAILABLE'||(!explicit&&FILE_UPLOAD_CHROME_UNAVAILABLE.test(evidence.browserText)))return manifest;
    // A previous bad migration may have stored an origin code; only correct
    // it when this exact run's structured browser result proves upload failure.
    if(explicit==='BROWSER_ORIGIN_PERMISSION_DENIED'&&(FILE_UPLOAD_CHROME_UNAVAILABLE.test(String(manifest.error||''))||FILE_UPLOAD_CHROME_UNAVAILABLE.test(evidence.browserText)))return manifest;
  }
  return null;
}
function migrateBrowserUploadFailure(p){
  const task=p.currentTask,manifest=uploadUnavailableManifestForTask(p,task);if(!manifest)return false;
  if(task.errorCode==='browser-upload-unavailable'&&p.lastFailure?.kind==='browser-upload-unavailable')return false;
  const failure={...p.lastFailure,kind:'browser-upload-unavailable',definiteNoOutput:true,key:task.target,attempts:0,taskId:task.id,at:p.lastFailure?.at||manifest.failedAt||new Date().toISOString(),message:'专用 Chrome 标签页的附件入口未能打开浏览器文件选择器；本次未上传附件或发送消息，上一版原图仍保留。'};
  Object.assign(task,{errorCode:'browser-upload-unavailable',providerInvocations:0});
  const storedTask=(p.tasks||[]).find(item=>item.id===task.id);if(storedTask)Object.assign(storedTask,{errorCode:'browser-upload-unavailable',providerInvocations:0});
  p.currentTask=task;p.lastFailure=failure;p.status='attention';p.message=failureMessage(failure);p.error=p.message;return true;
}
function migrateOriginPermissionFailure(p){
  const task=p.currentTask,manifest=originPermissionManifestForTask(p,task);if(!manifest)return false;
  const failure={...p.lastFailure,kind:'browser-origin-permission-denied',definiteNoOutput:true,key:task.target,attempts:0,taskId:task.id,at:p.lastFailure?.at||manifest.failedAt||new Date().toISOString()};
  Object.assign(task,{errorCode:'browser-origin-permission-denied',providerInvocations:0});
  const storedTask=(p.tasks||[]).find(item=>item.id===task.id);if(storedTask)Object.assign(storedTask,{errorCode:'browser-origin-permission-denied',providerInvocations:0});
  p.currentTask=task;p.lastFailure=failure;p.status='attention';p.message=failureMessage(failure);p.error=p.message;return true;
}
function preSubmissionPanelEvidence(p,panelKey,record,task){
  const records=path.join(projectDir(p.id),'.制作记录');if(!fs.existsSync(records))return null;
  let artifact;try{artifact=inside(projectDir(p.id),record.file);}catch{return null;}
  for(const name of fs.readdirSync(records).reverse()){
    const dir=path.join(records,name);let request,worker,manifest;
    try{
      request=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'));
      worker=JSON.parse(fs.readFileSync(path.join(dir,'worker-request.json'),'utf8'));
      manifest=readWebManifest(path.join(dir,'web-generation.json'));
    }catch{continue;}
    if(request.provider!==WEB_IMAGE_PROVIDER||worker.provider!==WEB_IMAGE_PROVIDER||manifest?.provider!==WEB_IMAGE_PROVIDER)continue;
    if(request.taskId!==task.id||request.projectId!==p.id||Number(request.projectVersion)!==Number(p.version)||request.target!==task.target)continue;
    if(!manifest.requestId||worker.requestId!==manifest.requestId||manifest.state!=='failed'||manifest.submitted===true)continue;
    if(request.expectedOutput&&path.resolve(projectDir(p.id),request.expectedOutput)!==artifact)continue;
    if(panelKeyFromImageKey(request.target)!==panelKey)continue;
    return {dir,manifest};
  }
  return null;
}
function quarantinePreSubmissionArtifacts(p){
  let count=0;
  for(const [panelKey,record] of Object.entries(p.panels||{})){
    if(record?.provider!==WEB_IMAGE_PROVIDER||!record.file)continue;
    let artifact;try{artifact=inside(projectDir(p.id),record.file);}catch{continue;}
    const task=(p.tasks||[]).slice().reverse().find(item=>item.kind==='image'&&panelKeyFromImageKey(item.target)===panelKey&&Number(item.providerInvocations)===0&&['artifact_saved','artifact_saved_unchecked','completed'].includes(item.status)&&(!item.artifact||path.resolve(item.artifact)===path.resolve(artifact)));
    if(!task)continue;
    const evidence=preSubmissionPanelEvidence(p,panelKey,record,task);if(!evidence)continue;
    const kind=manifestBrowserFailureKind(evidence.manifest)||'no-output',at=new Date().toISOString();
    p.quarantinedImages=Array.isArray(p.quarantinedImages)?p.quarantinedImages:[];
    p.quarantinedImages.push({panelKey,image:structuredClone(record),taskId:task.id,reason:'pre-submission-misattribution',runDir:path.relative(projectDir(p.id),evidence.dir),at});p.quarantinedImages=p.quarantinedImages.slice(-40);
    invalidatePanelDownstream(p,panelKey);invalidateArtifacts(p,[artifactIdForImageKey(task.target)]);delete p.panels[panelKey];
    Object.assign(task,{status:'failed_no_output',errorCode:kind,providerInvocations:0,quarantinedArtifact:task.artifact||artifact,completedAt:task.completedAt||at});p.currentTask=task;
    if(p.pending?.taskId===task.id)p.pending=null;
    const message=`${task.target} 的网页任务在上传和提交前已经停止；误挂接的历史图片已解除，原文件与制作记录均已保留。公开 Chrome 焦点管理能力可用后，点击“重试当前图片”只会重新制作这一张。`;
    p.lastFailure={kind,definiteNoOutput:true,key:task.target,attempts:0,inputTokens:0,taskId:task.id,at,message};p.status='attention';p.message=message;p.error=message;count++;
  }
  return count;
}
function definiteImageFailure(pending,extra=''){
  if(!pending?.dir)return null;const evidence=runEvidence(pending.dir),classified=readGenerationEvidence(pending.dir),combined=[extra,evidence.text,evidence.eventText].filter(Boolean).join('\n'),safeFailureText=[extra,evidence.text].filter(Boolean).join('\n');
  const manifest=pending.provider===WEB_IMAGE_PROVIDER?matchingPendingManifest(pending):readWebManifest(path.join(pending.dir,'web-generation.json'));
  if(pending.provider===WEB_IMAGE_PROVIDER&&!manifest&&(fs.existsSync(path.join(pending.dir,'web-generation.json'))||fs.existsSync(path.join(pending.dir,'worker-request.json'))))return null;
  // Once the chat message was sent, absence of a local file is never proof
  // that the provider produced no image. Preserve it for recovery instead.
  if(manifest?.submitted)return null;
  if(manifest?.state==='failed'){
    const kind=manifestBrowserFailureKind(manifest)||'no-output';
    return {kind,definiteNoOutput:true,key:pending.key,attempts:0,inputTokens:Number(evidence.usage?.input_tokens)||0,diagnostics:generationDiagnosticSummary(classified),at:new Date().toISOString(),...(manifest.error?{message:manifest.error}: {})};
  }
  if(NETWORK_FAILURE.test(combined)||classified.connectionRelated)return null;
  const manifestError=[manifest?.errorCode,manifest?.error].filter(Boolean).join(' ');
  if(FILE_UPLOAD_CHROME_UNAVAILABLE.test(manifestError)||FILE_UPLOAD_CHROME_UNAVAILABLE.test(evidence.browserText))return {kind:'browser-upload-unavailable',definiteNoOutput:true,key:pending.key,attempts:0,inputTokens:Number(evidence.usage?.input_tokens)||0,diagnostics:generationDiagnosticSummary(classified),at:new Date().toISOString()};
  if(BROWSER_ORIGIN_PERMISSION_DENIED.test(manifestError)||BROWSER_ORIGIN_PERMISSION_DENIED.test(evidence.browserText))return {kind:'browser-origin-permission-denied',definiteNoOutput:true,key:pending.key,attempts:0,inputTokens:Number(evidence.usage?.input_tokens)||0,diagnostics:generationDiagnosticSummary(classified),at:new Date().toISOString()};
  if(IAB_UNAVAILABLE.test(safeFailureText)||IAB_UNAVAILABLE.test(manifestError)||BROWSER_FOCUS_UNAVAILABLE.test(safeFailureText)||BROWSER_FOCUS_UNAVAILABLE.test(manifestError))return {kind:'browser-unavailable',definiteNoOutput:true,key:pending.key,attempts:0,inputTokens:Number(evidence.usage?.input_tokens)||0,diagnostics:generationDiagnosticSummary(classified),at:new Date().toISOString()};
  if(!DEFINITE_NO_IMAGE.test(combined)&&!DEFINITE_NO_IMAGE.test(manifestError)&&classified.outcome!=='no_image')return null;
  const attempts=Math.max(1,(evidence.eventText.match(/image generation failed/gi)||[]).length);
  return {kind:'no-output',definiteNoOutput:true,key:pending.key,attempts,inputTokens:Number(evidence.usage?.input_tokens)||0,diagnostics:generationDiagnosticSummary(classified),at:new Date().toISOString()};
}
function failureMessage(failure){const usage=failure.inputTokens?`本次后台处理记录约 ${failure.inputTokens.toLocaleString('zh-CN')} 输入 tokens；`:'';const action=String(failure.key||'').includes('样张')?'重试当前样张':'重试当前图片';if(failure.kind==='browser-upload-unavailable')return `专用 Chrome 标签页的附件入口未能打开浏览器文件选择器；本次未上传附件或发送消息，${usage}上一版原图仍保留。修复浏览器附件入口后点击“${action}”，只会重试这一张。`;if(failure.kind==='browser-origin-permission-denied')return `Chrome 已连接，但 chatgpt.com 访问权限被拒绝；下次重试出现浏览器访问询问时请选择“允许”。本次未上传附件或发送消息，${usage}当前节点已经保存；处理权限后点击“${action}”，只会重试这一张。`;if(failure.kind==='browser-unavailable'){const historical=IAB_UNAVAILABLE.test(String(failure.message||''));return `${historical?'历史 Codex 内嵌浏览器 IAB':'专用 Chrome 标签页的公开焦点恢复能力'}暂不可用，本次未提交图片请求。${usage}当前节点已经保存；${historical?'当前生产链路不会退回 IAB，请确认 Chrome Computer Use 与焦点安全能力':'当前公开 CUA 无法保证零焦点切换，请等待支持焦点恢复的能力'}后点击“${action}”，只会重试这一张。`;}if(failure.message)return failure.message;return `${failure.kind==='network'?'生图服务连接失败':'本次生图未完成'}：已发起 ${failure.attempts} 次图片请求，但没有取得图片。${usage}自动重试已停止，上一张样张和当前节点都已保存。实际订阅余额以页面顶部为准；网络稳定后点击“${action}”，只会重试这一张。`;}
function sampleRepairCount(p,index){
  p.sampleRepairCounts=Array.isArray(p.sampleRepairCounts)?p.sampleRepairCounts:[0,0];
  const parsed=Number(/自动修订(\d+)/.exec(p.samples[index]?.key||'')?.[1])||0;
  p.sampleRepairCounts[index]=Math.max(Number(p.sampleRepairCounts[index])||0,parsed);return p.sampleRepairCounts[index];
}
function normalizeQA(result){
  const normalized={...result};
  if(normalized.status==='deferred'){normalized.pass=null;normalized.summary=normalized.summary||'仅完成本地文件检查，尚未完成画面质检。';}
  else if(normalized.pass===true&&!normalized.status)normalized.status='qa_pass';
  else if(normalized.pass===false&&!normalized.status)normalized.status='needs_review';
  else if(normalized.pass!==true&&normalized.status==='qa_pass')normalized.status='needs_review';
  const details=Array.isArray(normalized.issueDetails)?normalized.issueDetails:[];
  if(!details.length&&Array.isArray(normalized.issues))normalized.issueDetails=normalized.issues.map((description,i)=>({id:`legacy-${i+1}`,category:/(?:画幅|比例|竖图)/.test(description)?'aspect_ratio':'uncertain',severity:'review',location:'待确认',description,repairAction:'review'}));
  return normalized;
}
function materialSampleIssues(issues=[],details=[]){if(details.length)return details.filter(x=>x.category!=='aspect_ratio').map(x=>x.description);return issues.filter(x=>!/(?:2\s*[:：]\s*3|3\s*[:：]\s*4).*(?:画幅|比例|竖图)|(?:画幅|比例|竖图).*(?:2\s*[:：]\s*3|3\s*[:：]\s*4)/i.test(x));}
function qaPassed(qa){return qa?.pass===true&&qa?.status!=='deferred';}
function sampleAccepted(sample){return Boolean(qaPassed(sample?.qa)||sample?.userDecision?.action==='accept_current');}
function panelAccepted(panel){return Boolean(qaPassed(panel?.qa)||panel?.userDecision?.action==='accept_current');}
function requirePanelDecision(p,key,record=p.panels?.[key]){
  p.panelDecision={state:'required',panelKey:key,artifactId:artifactIdForImageKey(key),projectVersion:p.version,at:new Date().toISOString(),issueIds:(record?.qa?.issueDetails||[]).filter(issue=>['blocking','review'].includes(issue.severity)).map(issue=>String(issue.id)).filter(Boolean)};
}
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
function latestImageRevision(p,key){
  return [...(p.revisionNotes||[])].reverse().find(item=>item?.mode==='image-delta'&&panelKeyFromImageKey(item.key)===key)||null;
}
function artifactIdForImageKey(key=''){
  const panelKey=panelKeyFromImageKey(key);
  if(panelKey){const [page,panel]=panelKey.split('-');return `image:第${page}页-第${panel}格`;}
  const sample=/^(?:样张|sample)-(\d+)/.exec(key);
  return sample?`image:样张-${sample[1]}`:`image:${key}`;
}
function invalidatePanelDownstream(p,panelKey){
  const [pageNumber]=String(panelKey).split('-').map(Number),oldPage=p.pages?.find(page=>Number(page.number)===pageNumber);
  if(oldPage){
    p.invalidatedPages=Array.isArray(p.invalidatedPages)?p.invalidatedPages:[];
    p.invalidatedPages.push({page:structuredClone(oldPage),panelKey,reason:'panel-replaced',at:new Date().toISOString()});p.invalidatedPages=p.invalidatedPages.slice(-40);
  }
  p.pages=(p.pages||[]).filter(page=>Number(page.number)!==pageNumber);
  invalidateArtifacts(p,[`page:${pageNumber}`,'story:audit','export:bundle']);
  p.storyQA=null;p.bundle=null;p.accepted=false;p.acceptance=null;p.panelDecision=null;
}
function manualPanelRepairPrompt(panelKey,issue){
  const espresso=/(?:咖啡机|意式|萃取|portafilter|萃取头|出液嘴|液流|咖啡)/i.test(String(issue));
  if(espresso)return `只重新生成第${panelKey.split('-')[0]}页第${panelKey.split('-')[1]}格，严格保留当前人物身份、服装、动作、场景、光线、构图和画幅；只修复用户指出的问题：“${issue}”。对照意式咖啡器具参考，确保萃取头与 portafilter 手柄在卡口处真实连接，双出液嘴位于手柄下方且每股咖啡液流都从对应出液嘴自然起始，不悬空、不穿插、不改变其他内容。原始画面不要生成中文、字幕、logo或水印。`;
  return `只重新生成第${panelKey.split('-')[0]}页第${panelKey.split('-')[1]}格，严格保留当前人物身份、服装、动作、场景、光线、构图和画幅；只修复用户指出的问题：“${issue}”。不要自行修改未列出的内容，不生成中文、字幕、logo或水印。`;
}
function manualPanelReviewFingerprint(input){return digest({panelKey:input.panelKey,artifactId:input.artifactId,contentHash:input.contentHash,issue:input.issue,repairPrompt:input.repairPrompt});}
export function rejectPanel(p,decision={}){
  const requestedKey=String(decision.panelKey||decision.key||decision.target||''),panelKey=panelKeyFromImageKey(requestedKey),record=p.panels?.[panelKey];
  if(!panelKey||!record)throw new Error('没有可供人工打回的正式分镜。');
  const artifactId=artifactIdForImageKey(panelKey),artifact=(p.artifacts||[]).find(item=>item.id===artifactId);
  if(!artifact||artifact.file!==record.file||artifact.valid===false)throw new Error('当前图片已经过期，请刷新后再打回。');
  const contentHash=digest({artifactId,file:record.file,at:record.at||artifact.at||null});
  const issue=String(decision.issue||decision.userIssue||decision.problem||decision.note||'').trim();
  if(!issue||issue.length>1000)throw new Error('请描述要打回的具体问题。');
  const repairPrompt=String(decision.repairPrompt||decision.repair||manualPanelRepairPrompt(panelKey,issue)).trim();
  if(!repairPrompt||repairPrompt.length>4000)throw new Error('请提供具体的修复提示。');
  const idempotencyKey=String(decision.idempotencyKey||`manual-panel-review:${p.id}:${panelKey}:${contentHash}`).trim();
  if(idempotencyKey.length>200)throw new Error('这次打回的防重复标识过长。');
  const input={panelKey,artifactId,contentHash,issue,repairPrompt,idempotencyKey},commands=Array.isArray(p.panelReviewCommands)?p.panelReviewCommands:[],existing=commands.find(item=>item.key===idempotencyKey);
  if(existing){if(existing.fingerprint!==manualPanelReviewFingerprint(input))throw new Error('这次打回标识已经用于另一项操作，请刷新后重试。');return p;}
  if(!Object.prototype.hasOwnProperty.call(decision,'expectedRevision')||!Number.isInteger(Number(decision.expectedRevision)))throw new Error('缺少当前作品版本，请刷新页面后再打回。');
  if(Number(decision.expectedRevision)!==Number(p.revision))throw new Error(`作品已更新（当前版本 ${p.revision}），请刷新后再提交这次打回。`);
  if(String(decision.artifactId||'')!==artifactId)throw new Error('当前图片已经过期，请刷新后再打回。');
  if(String(decision.contentHash||'')!==contentHash)throw new Error('当前图片内容已经更新，请重新查看后再打回。');
  if(p.accepted)throw new Error('已收下的成品不能直接打回，请先建立新版本。');
  if(active.has(p.id)||p.pending||jobStore.hasLiveWork(p.id))throw new Error('仍有图片任务正在运行或等待确认，请先完成后再打回。');
  const category=String(decision.category||'').trim()||(/(?:咖啡机|意式|萃取|portafilter|萃取头|出液嘴|液流|连接)/i.test(issue)?'layout':'uncertain');
  if(!['identity','anatomy','text','layout','aspect_ratio','safe_area','noise','continuity','uncertain'].includes(category))throw new Error('人工问题类别无效。');
  const issueId=`manual-${digest({panelKey,artifactId,contentHash,issue}).slice(0,16)}`,detail={id:issueId,category,severity:'blocking',location:`第${panelKey.split('-')[0]}页第${panelKey.split('-')[1]}格`,description:issue,repairAction:'regenerate'};
  invalidatePanelDownstream(p,panelKey);
  record.qa={pass:false,status:'needs_review',summary:`用户人工打回：${issue}`,issues:[issue],issueDetails:[detail],repairPrompt,source:'user_manual_review',userIssue:issue};
  delete record.userDecision;
  const task=[...(p.tasks||[])].reverse().find(item=>item.kind==='image'&&panelKeyFromImageKey(item.target)===panelKey);
  if(task){task.qa='needs_review';task.manualReview='user_rejected';if(p.currentTask?.id===task.id)Object.assign(p.currentTask,{qa:'needs_review',manualReview:'user_rejected'});}
  requirePanelDecision(p,panelKey,record);p.status='attention';p.error=null;p.message=`第 ${panelKey.split('-')[0]} 页第 ${panelKey.split('-')[1]} 格已按你的问题打回，需要修改这一张；不会自动生图。`;
  p.manualPanelReview={state:'needs_review',panelKey,artifactId,projectVersion:p.version,userIssue:issue,repairPrompt,at:new Date().toISOString()};
  p.panelReviewCommands=[...commands,{key:idempotencyKey,fingerprint:manualPanelReviewFingerprint(input),panelKey,artifactId,contentHash,issue,repairPrompt,at:new Date().toISOString(),projectVersion:p.version}].slice(-80);
  saveProject(p);return p;
}
function attachImageRecord(p,record){
  const sampleIndex=sampleIndexFromKey(record.key);
  if(sampleIndex!==null){p.samples=Array.isArray(p.samples)?p.samples:[];p.samples[sampleIndex]=record;return;}
  const panelKey=panelKeyFromImageKey(record.key);
  if(panelKey){p.panels=p.panels||{};p.panels[panelKey]=record;}
}
function sampleNeedsExplicitDecision(sample){
  if(!sample||sampleAccepted(sample))return false;
  if(['pending','unavailable','recovered_pending_review','manual_review'].includes(sample.qa?.status))return true;
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
function archivePlanRevisionState(p){
  const pending=p.pending,now=new Date().toISOString();
  if(pending){
    p.supersededPending=Array.isArray(p.supersededPending)?p.supersededPending:[];
    p.supersededPending.push({...structuredClone(pending),supersededAt:now,reason:'plan_revision',supersededFromVersion:p.version});p.supersededPending=p.supersededPending.slice(-40);
    const task=(p.tasks||[]).find(item=>item.id===pending.taskId);if(task)Object.assign(task,{status:'superseded',completedAt:now,supersededAt:now,reason:'plan_revision'});
    p.pending=null;
  }
  if(p.currentTask){
    const task=(p.tasks||[]).find(item=>item.id===p.currentTask.id);
    if(task&&['failed','failed_no_output','unknown_result','paused','review_failed','running'].includes(task.status))Object.assign(task,{status:'superseded',completedAt:now,supersededAt:now,reason:'plan_revision'});
    p.currentTask=null;
  }
  p.lastFailure=null;p.error=null;p.panelDecision=null;p.samplesDecision=null;p.previewDecisionCommands=[];p.retryCommands=[];
}
export function planProject(p,revision=''){
  if(revision && !p.plan)throw new Error('请先生成完整方案。');
  if(revision && revision.length>6000)throw new Error('修改说明过长。');
  return job(p,'planning',async signal=>{
    activity(p,revision?'正在把修改同步到逐页方案和连续性台账…':'正在构思故事、逐页分镜和文案…');
    const plan=await runCodex({prompt:plannerPrompt(p.brief,p.plan,revision),schema:PLAN_SCHEMA,dir:runDir(p,'故事方案'),images:FACE.map(x=>path.join(REFS,x)),signal,role:'creative',...modelArgs(p)});addUsage(p,plan.__usage,{...modelArgs(p),role:'creative'});
    checkpoint(signal);validatePlan(plan,p.brief);
    if(p.plan)p.history.push({version:p.version,plan:p.plan,approved:p.approved,samples:p.samples,pages:p.pages,panels:p.panels,revisionNotes:p.revisionNotes,pending:p.pending?structuredClone(p.pending):null,currentTask:p.currentTask?structuredClone(p.currentTask):null,lastFailure:p.lastFailure?structuredClone(p.lastFailure):null,artifacts:structuredClone(p.artifacts||[])});
    archivePlanRevisionState(p);p.version++;p.plan=plan;if(!p.titleLocked)p.title=plan.title;p.approved=null;p.samplesApproved=false;p.samples=[];p.sampleRepairCounts=[0,0];p.lastFailure=null;p.panels={};p.pages=[];p.artifacts=[];p.revisionNotes=[];p.storyQA=null;p.accepted=false;p.bundle=null;
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
  const functionalContext=[prompt,...refs].join(' '),hasEspressoReference=refs.length>0&&/(?:咖啡机|意式|萃取|portafilter|萃取头|出液嘴|液流|咖啡)/i.test(functionalContext);
  const functionalRule=hasEspressoReference?'功能器具专项（仅在附件确有意式咖啡机/萃取参考时启用；没有该器具时不要臆造问题）：对照参考检查咖啡机萃取头（group head）、portafilter 手柄与卡口、双出液嘴，以及每股咖啡液流的起点。若萃取头与手柄的连接在几何上不可能、手柄悬空或穿插，或液流没有从对应出液嘴自然起始，必须判为阻断问题（severity=blocking；必要时可用 severity=review 表示需要人工复核），repairAction 必须为 regenerate，并在 repairPrompt 中精确写出连接关系和液流起点的修复。只要功能连接仍然合理，不要把线条、材质、颜色、透视轻微差别等风格差异误报为问题；被遮挡而无法确定时标为 review，不要武断判定。':'功能器具专项：只有附件确实出现相关器具时才检查其功能连接；不要把不存在的器具或纯粹风格差异当成问题。';
  const result=await runCodex({dir:runDir(p,'画面校对'),schema:QA_SCHEMA,images:[file,...refs],signal,role:'qa',...modelArgs(p,'low'),
    prompt:`你是漫画验收编辑。只看附件检查，不使用工具，不修改文件。${kind.startsWith('全套')?'附件是按页码顺序排列的全套成稿，后面才是两张固定温蒂人设参考。检查整套跨页连续性，不把不同页的合理动作差异当成人设变化。':'第一张是待检'+kind+'，其他是固定身份或环境参考。'}逐项检查：${CHECKS.join('；')}；身份以两张温蒂人设为准，检查五官发髻、双肩两臂两手每手五指(只检查可见部分，合理遮挡不算缺失)、两腿两脚；不能无故正视镜头，禁止错误角色；没有明显颗粒彩噪或脏污。${kind==='原始分镜'?'原始分镜不能有中文或字幕，后期会加。':'检查所有中文完整准确、无乱码、紧凑文字框不挡主体、页码一致。'}检查比例构图、头发四肢安全区。不要把合理的风格差别或被遮挡的肢体当成问题。${functionalRule}${sampleRule}每个问题必须返回issueDetails：category只能是 identity/anatomy/text/layout/aspect_ratio/safe_area/noise/continuity/uncertain；severity为 blocking/review/suggestion；repairAction为 regenerate/reletter/recompose/review。冻结要求：${prompt}\n返回pass、summary、issues、issueDetails及精准的repairPrompt。`});addUsage(p,result.__usage,{...modelArgs(p,'low'),role:'qa'});return normalizeQA(result);
}
function layoutOnlyRevision(note){
  const text=String(note||''),hasLayout=/(?:文字|文案|字幕|排字|排版|文字框|内屏|乱码|错字|字样|店招)/.test(text);
  const hasImageChange=/(?:人物|脸|五官|发型|头发|服装|动作|手|脚|姿势|视线|表情|场景|背景|物件|泳包|杯子|电脑|光线|画面|构图|比例|安全区|噪点|颗粒|颜色|色彩)/.test(text);
  return hasLayout&&!hasImageChange;
}
/* Image file inspection, orphan evidence, and explicit recovery live in
 * image-recovery.mjs. Keep the engine's aliases here for the public workflow. */
function writeRunRequest(dir,p,task,pending){
  const summarize=file=>{try{return {name:path.basename(file),sizeBytes:fs.statSync(file).size,sha256:checksum(file)};}catch{return {name:path.basename(file),missing:true};}};
  jsonWrite(path.join(dir,'request.json'),{schemaVersion:2,provider:pending.provider||'legacy',taskId:task.id,attempt:task.attempt,target:pending.key,createdAt:pending.at,projectId:p.id,
    projectVersion:p.version,expectedOutput:path.relative(projectDir(p.id),pending.file),model:pending.executorModel||p.brief.model||null,reasoningEffort:pending.executorReasoningEffort||WEB_IMAGE_EXECUTOR_EFFORT,role:WEB_IMAGE_EXECUTOR_ROLE,
    creativeModel:p.brief.model||null,creativeReasoningEffort:p.brief.reasoningEffort||null,executorModel:pending.executorModel||p.brief.model||null,executorReasoningEffort:pending.executorReasoningEffort||WEB_IMAGE_EXECUTOR_EFFORT,
    promptSha256:pending.telemetry.promptSha256,promptCharacters:pending.telemetry.promptCharacters,revisionPromptVersion:pending.telemetry.revisionPromptVersion||null,revisionPromptSha256:pending.telemetry.revisionPromptSha256||null,revisionPromptCharacters:pending.telemetry.revisionPromptCharacters||null,revisionPromptSource:pending.telemetry.revisionPromptSource||null,revisionPromptSourceSegments:pending.telemetry.revisionPromptSourceSegments||null,basePromptSha256:pending.telemetry.basePromptSha256||null,revisionDeltaSha256:pending.telemetry.revisionDeltaSha256||null,revisionDeltaCharacters:pending.telemetry.revisionDeltaCharacters||0,referenceNames:pending.refs,referenceFiles:pending.inputFiles.map(summarize),editTarget:pending.prior?summarize(pending.prior):null,source:task.source,revisionBase:pending.revisionBase||null,preparation:pending.telemetry.preparation||null});
}
function previousConversation(prior){
  if(!prior)return null;
  try{
    const record=JSON.parse(fs.readFileSync(prior+'.json','utf8'));
    return /^https:\/\/chatgpt\.com\/c\/[^\s?#]+/.test(String(record.conversationUrl||''))?String(record.conversationUrl):null;
  }catch{return null;}
}
async function generate(p,key,prompt,refnames,signal,prior=null,verify=true,qaKind='原始分镜',attempt=1,revisionMeta={}){
  checkpoint(signal);
  // Check that the local Codex executor is available before doing quota work
  // or preparing files.  The public CUA has no focus-restore API, but the
  // direct-Chrome path records that boundary and continues with its one owned
  // tab instead of pretending it can run invisibly.
  if(!process.env.WENDI_TEST_PLAN_FILE){
    const worker=webWorkerStatus();
    if(!worker.ready){
      const error=new Error(worker.message);error.code='BROWSER_CHROME_UNAVAILABLE';throw error;
    }
  }
  const executor=browserExecutorArgs(p);await protectQuota(p,{executorModel:executor.model});checkpoint(signal);const refs=imageRefs(p,refnames);const folder=path.join(versionDir(p),'素材');fs.mkdirSync(folder,{recursive:true});
  if(p.pending)throw new Error('当前图片任务尚未结束，请先检查已有原图。');
  let file=path.join(folder,`${key}-${Date.now()}.png`);const dir=runDir(p,key),sourceFiles=prior?[prior,...refs]:refs;fs.mkdirSync(dir,{recursive:true});
  const basePrompt=String(revisionMeta.basePrompt||prompt),revisionDelta=revisionMeta.revisionDelta?String(revisionMeta.revisionDelta):null,prepStartedAt=new Date().toISOString(),cachePlan=preparedCacheFor(p,sourceFiles,prior);
  activity(p,`正在整理并压缩${cachePlan.missing.length}个上传素材${cachePlan.cacheHits?`，复用${cachePlan.cacheHits}个已准备附件`:''}…`);
  const prepared=await prepareWebAttachments(p,dir,sourceFiles,cachePlan),preparation={startedAt:prepStartedAt,completedAt:new Date().toISOString(),durationMs:Math.max(0,Date.now()-Date.parse(prepStartedAt)),sourceCount:sourceFiles.length,preparedCount:prepared.length,reusedCount:cachePlan.cacheHits,preparedCountThisRun:cachePlan.missing.length};const inputFiles=prepared.map(item=>item.file);checkpoint(signal);
  const revisionTelemetry=revisionDelta?revisionPromptTelemetry(prompt,{basePrompt,note:revisionDelta}):{};
  const telemetry=promptTelemetry(prompt,refs,{requestedReferenceCount:refnames.length,source:prior?'edit':'generate',basePromptSha256:promptHash(basePrompt),revisionDeltaSha256:revisionDelta?promptHash(revisionDelta):null,revisionDeltaCharacters:revisionDelta?.length||0,...revisionTelemetry,preparation,preparedAttachments:prepared.map((item,index)=>({sourceSha256:cachePlan.sourceSha256s[index],file:path.relative(projectDir(p.id),item.file),optimized:item.optimized===true,sizeBytes:Number(item.sizeBytes)||0,reused:item.reused===true})),uploadOriginalBytes:sourceFiles.reduce((n,item)=>n+fs.statSync(item).size,0),uploadPreparedBytes:prepared.reduce((n,item)=>n+Number(item.sizeBytes||0),0),optimizedAttachmentCount:prepared.filter(item=>item.optimized).length});const task=beginTask(p,'image',key,{attempt,provider:WEB_IMAGE_PROVIDER,providerInvocationLimit:1,providerInvocations:0,source:prior?'edit':'generate',role:WEB_IMAGE_EXECUTOR_ROLE,creativeModel:p.brief.model||null,creativeReasoningEffort:p.brief.reasoningEffort||null,executorModel:executor.model,executorReasoningEffort:executor.reasoningEffort,basePrompt,revisionDelta,revisionBase:revisionMeta.revisionBase||null,telemetry});const pending={key,file,dir,prompt,basePrompt,revisionDelta,revisionBase:revisionMeta.revisionBase||null,refs:refnames,inputFiles,sourceFiles,prior,provider:WEB_IMAGE_PROVIDER,executorModel:executor.model,executorReasoningEffort:executor.reasoningEffort,taskId:task.id,projectId:p.id,projectVersion:p.version,telemetry,at:new Date().toISOString()};
  writeRunRequest(dir,p,task,pending);p.pending=pending;p.lastFailure=null;saveProject(p);
  activity(p,`正在打开专用生图页面并上传${inputFiles.length}个素材…`);
  let failure,made=null;const manifestFile=path.join(dir,'web-generation.json'),conversationUrl=previousConversation(prior),capsule=fs.readFileSync(path.join(versionDir(p),'制作提示词胶囊.txt'),'utf8');
  try{
    if(process.env.WENDI_TEST_PLAN_FILE){
      task.providerInvocations=1;saveProject(p);
      made=await runCodex({dir,signal,image:true,browserMode:'chrome',writableDirs:[projectDir(p.id)],...executor,
        prompt:chatGptWebImagePrompt({outputFile:file,manifestFile,prompt,referenceFiles:inputFiles,editTarget:prior,conversationUrl,capsule})});
    }else{
      made=await dispatchChatGptWebJob({codexBin:findCodex(),dir,outputFile:file,prompt,referenceFiles:inputFiles,editTarget:prior,conversationUrl,capsule,signal,...executor});
  }
  addUsage(p,made.usage,executor);
  }catch(e){failure=e;}
  const webManifest=readWebManifest(manifestFile)||failure?.webManifest||made?.manifest||null;
  if(webManifest?.requestId){pending.requestId=webManifest.requestId;task.requestId=webManifest.requestId;task.accepted=webManifest.accepted===true;task.submitted=webManifest.submitted===true;task.referenceCount=Number(webManifest.referenceCount)||0;pending.accepted=webManifest.accepted===true;pending.submitted=webManifest.submitted===true;pending.referenceCount=Number(webManifest.referenceCount)||0;saveProject(p);}
  activity(p,'正在核对网页执行结果并保存原图…');
  if(!process.env.WENDI_TEST_PLAN_FILE&&!matchingPendingManifest(pending)){finishTask(p,task,'unknown_result',{errorCode:'REQUEST_IDENTITY_MISMATCH'});saveProject(p);throw new Error('执行记录与本次图片请求不匹配，原文件已保留，不能自动采用或重试。');}
  task.providerInvocations=webManifest?.submitted?1:(process.env.WENDI_TEST_PLAN_FILE?task.providerInvocations:0);task.webTimings=webManifest?{createdAt:webManifest.createdAt||null,acceptedAt:webManifest.acceptedAt||null,readyAt:webManifest.readyAt||null,submittedAt:webManifest.submittedAt||null,downloadedAt:webManifest.downloadedAt||null,executorModel:webManifest.executorModel||executor.model||null,executorReasoningEffort:webManifest.executorReasoningEffort||executor.reasoningEffort,role:webManifest.role||WEB_IMAGE_EXECUTOR_ROLE}:null;saveProject(p);
  if(preAcceptanceQuotaEvidence(pending,webManifest,failure,made)){
    const usageError=String((failure?.message||webManifest.error||'已达到生图执行器额度限制。')).slice(0,1000),message=`本次生图执行器在接受请求前遇到额度限制，未上传附件或发送消息。已保留同一 requestId、taskId 和方案版本；额度恢复后点击“继续制作”将续接原任务，不会创建第二个图片请求。原始错误：${usageError}`;
    task.providerInvocations=0;task.status='paused';task.errorCode=USAGE_LIMIT_BEFORE_START;task.webState='queued';task.completedAt=new Date().toISOString();task.error=message;task.requestId=webManifest.requestId;pending.quotaPaused=true;pending.quotaError=usageError;p.pending=pending;p.lastFailure=null;p.status='paused';p.error=message;p.message=message;
    writeRunResult(dir,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,requestId:webManifest.requestId,projectId:p.id,projectVersion:p.version,target:key,endedAt:new Date().toISOString(),outcome:'quota_paused_before_acceptance',manifestState:webManifest.state,accepted:webManifest.accepted===true,submitted:webManifest.submitted===true,referenceCount:Number(webManifest.referenceCount)||0,error:usageError});saveProject(p);
    const error=new Error(message);error.code=USAGE_LIMIT_BEFORE_START;error.webManifest=webManifest;throw error;
  }
  // A transport error after download must not trigger a second image request.
  // Prefer the explicit output path, then a path explicitly reported by this
  // browser run. Legacy tasks alone retain the old generated_images fallback.
  // Ambiguous candidates are recorded but never guessed at.
  const {evidence,candidates}=attributableCandidates(pending);
  let persisted=null;
  if(candidates.length===1)persisted=await persistImage(candidates[0],file);
  if(!persisted){
    const candidateNames=candidates.map(candidate=>path.basename(candidate));
    writeRunResult(dir,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,attempt:task.attempt,endedAt:new Date().toISOString(),outcome:'artifact_not_located',diagnostics:generationDiagnosticSummary(evidence),candidateCount:candidateNames.length,candidateNames,error:failure?String(failure.message||failure).slice(0,500):null});
    const known=definiteImageFailure(pending,[made?.text,failure?.message,webManifest?.errorCode,webManifest?.error].filter(Boolean).join('\n'));
    if(known){if(CONFIRMED_PRE_SUBMISSION_KINDS.has(known.kind)&&known.kind!=='no-output')task.providerInvocations=0;p.pending=null;p.lastFailure={...known,taskId:task.id};finishTask(p,task,'failed_no_output',{errorCode:known.kind});saveProject(p);const error=new Error(failureMessage(known));error.code='IMAGE_NO_OUTPUT';throw error;}
    finishTask(p,task,'unknown_result',{errorCode:'unknown_result'});
    throw failure||new Error('连接在保存结果前中断。当前节点已保存，请先检查已有原图，避免重复生成。');
  }
  file=persisted.file;pending.file=file;pending.integrity=persisted.integrity;
  writeRunResult(dir,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,attempt:task.attempt,endedAt:new Date().toISOString(),outcome:'artifact_saved',artifact:path.relative(projectDir(p.id),file),integrity:persisted.integrity,downloadEvidence:readDownloadEvidence(dir),diagnostics:generationDiagnosticSummary(evidence)});
  // Persist the recovered file before asking the model to inspect it. A QA
  // timeout is never evidence that the image did not exist, and must not make
  // the next click repeat a paid image request.
  const record={key,file:path.relative(projectDir(p.id),file),provider:WEB_IMAGE_PROVIDER,conversationUrl:webManifest?.conversationUrl||conversationUrl||null,prompt,basePrompt,revisionDelta,revisionBase:revisionMeta.revisionBase||null,executor:{model:executor.model,reasoningEffort:executor.reasoningEffort,role:WEB_IMAGE_EXECUTOR_ROLE},refs:refnames,telemetry,integrity:persisted.integrity,downloadEvidence:readDownloadEvidence(dir),qa:verify?{pass:null,status:'pending',summary:'原图已保存，等待画面校对。',issues:[],repairPrompt:''}:{pass:null,status:'deferred',summary:'已完成本地文件检查；尚未执行画面质检。',issues:[],repairPrompt:''},at:new Date().toISOString()};
  jsonWrite(file+'.json',record);const panelKey=panelKeyFromImageKey(key);if(panelKey)invalidatePanelDownstream(p,panelKey);recordArtifact(p,artifactIdForImageKey(key),'image',record.file,[],{integrity:persisted.integrity,downloadEvidence:record.downloadEvidence});attachImageRecord(p,record);p.pending=null;p.lastFailure=null;finishTask(p,task,'artifact_saved',{artifact:file,qa:verify?'pending':'deferred'});saveProject(p);
  if(!verify)return record;
  try{
    checkpoint(signal);
    const check=await qa(p,file,prompt,refs,signal,qaKind);
    record.qa=check;jsonWrite(file+'.json',record);finishTask(p,task,'completed',{artifact:file,qa:check.pass?'passed':'needs_review'});saveProject(p);return record;
  }catch(error){
    if(signal.aborted){
      record.qa={...record.qa,status:'unavailable',summary:'原图已保存，但本次任务已暂停，尚未自动校对。',qaError:String(error.message||error).slice(0,500)};
      jsonWrite(file+'.json',record);finishTask(p,task,IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED,{artifact:file,qa:'unavailable',error:record.qa.qaError});saveProject(p);throw error;
    }
    const outcome=savedArtifactQaUnavailable(error,{artifact:file});
    applySavedArtifactQaOutcome({project:p,task,record,artifactFile:file,outcome,saveProject,finishTask,jsonWrite,writeRunResult:result=>writeRunResult(dir,result),runResult:{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,attempt:task.attempt,endedAt:new Date().toISOString(),outcome:outcome.outcome,artifact:path.relative(projectDir(p.id),file),integrity:persisted.integrity,errorCode:outcome.errorCode,error:outcome.detail}});
    throw new SavedArtifactQaUnavailableError(error,{artifact:file});
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
      p.samples[i]=current;saveProject(p);if(current.qa.status==='unavailable'){p.status='attention';p.message=SAVED_ARTIFACT_QA_MESSAGE;p.error=p.message;saveProject(p);return;}if(current.qa.pass)continue;issues=materialSampleIssues(current.qa.issues,current.qa.issueDetails||[]);
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
function panelImagePath(p,record){
  if(typeof record?.file!=='string'||!record.file||path.isAbsolute(record.file))throw new Error('当前图片文件路径无效，不能采用。');
  let file;try{file=inside(projectDir(p.id),record.file);}catch{throw new Error('当前图片文件不属于这篇作品，不能采用。');}
  if(!fs.existsSync(file))throw new Error('当前图片文件不存在，不能采用。');
  return file;
}
function revisionBaseFile(p,old,options={}){
  const explicitlyRequested=Boolean(options.baseFile||options.basePath||options.baseArtifactId),requested=options.baseFile||options.basePath||((options.baseArtifactId&&(p.artifacts||[]).find(item=>item.id===options.baseArtifactId)?.file)||null);
  if(explicitlyRequested&&!requested)throw new Error('你选定的编辑基图不存在，请刷新后重新选择。');
  const stableDraft=old?.qa?.pass===false||old?.qa?.status==='unavailable',fallback=stableDraft&&old?.revisionBase?.file?old.revisionBase.file:(old?.rawFile||old?.file);
  if(!requested&&fallback) {
    let file;try{file=inside(projectDir(p.id),fallback);}catch{throw new Error('当前编辑基图不属于这篇作品。');}
    if(!fs.existsSync(file))throw new Error('当前编辑基图不存在，请刷新后重新选择。');
    const expected=stableDraft&&old?.revisionBase?.file===fallback?old.revisionBase.sha256:null;
    if(expected&&checksum(file)!==expected)throw new Error('当前编辑基图内容已经更新，请重新查看后再选择。');
    return file;
  }
  let file;try{file=inside(projectDir(p.id),requested);}catch{throw new Error('你选定的编辑基图不属于这篇作品。');}
  if(!fs.existsSync(file))throw new Error('你选定的编辑基图不存在，请刷新后重新选择。');
  return file;
}
async function verifyPanelImage(p,record,artifact){
  const file=panelImagePath(p,record);let integrity;
  try{integrity=await verifyImage(file);}catch{throw new Error('当前图片不存在或无法解码，不能采用。');}
  const expected=record.integrity?.sha256||artifact?.integrity?.sha256;
  if(typeof expected!=='string'||!expected)throw new Error('当前图片没有可信的完整性记录，请重新校对后再决定。');
  if(integrity.sha256!==expected)throw new Error('当前图片内容已经更新，请重新查看后再决定。');
  return {file,integrity};
}
export async function decidePanel(p,decision={}){
  verifyApproval(p);if(active.has(p.id))throw new Error('分镜仍在制作中，请等待当前任务结束。');
  const key=String(decision.key||decision.panelKey||''),record=p.panels?.[key],action=String(decision.action||'');
  if(!/^\d+-\d+$/.test(key)||!record)throw new Error('没有可供决定的正式分镜。');
  if(action!=='accept_current')throw new Error('正式分镜只能采用当前图片或修改这一张。');
  if(record.qa?.pass!==false||record.userDecision?.action==='accept_current')throw new Error('当前正式分镜没有等待人工采用的失败质检。');
  if(Object.prototype.hasOwnProperty.call(decision,'expectedRevision')&&Number(decision.expectedRevision)!==Number(p.revision))throw new Error('作品已更新，请刷新后再提交这次决定。');
  if(decision.planHash&&decision.planHash!==p.approved?.hash)throw new Error('方案已更新，请重新查看当前分镜后再决定。');
  const artifactId=artifactIdForImageKey(key),artifact=(p.artifacts||[]).find(item=>item.id===artifactId);
  if(decision.artifactId&&(artifact?.file!==record.file||artifact?.valid===false))throw new Error('当前图片已经过期，请刷新后再决定。');
  if(decision.artifactId&&decision.artifactId!==artifactId)throw new Error('当前图片已经过期，请刷新后再决定。');
  const contentHash=digest({artifactId,file:artifact?.file||record.file,at:record.at||artifact?.at||null});
  if(decision.contentHash&&decision.contentHash!==contentHash)throw new Error('当前图片内容已经更新，请重新查看后再决定。');
  const acknowledgedIssueIds=[...new Set((Array.isArray(decision.acknowledgedIssueIds)?decision.acknowledgedIssueIds:[]).map(String).filter(Boolean))],requiredIssueIds=(record.qa.issueDetails||[]).filter(issue=>['blocking','review'].includes(issue.severity)).map(issue=>String(issue.id)).filter(Boolean);
  if(requiredIssueIds.some(id=>!acknowledgedIssueIds.includes(id)))throw new Error('请先确认正式分镜中列出的待注意问题，再采用当前图片。');
  const expectedRevision=Number(p.revision),expectedVersion=Number(p.version),expectedPlanHash=p.approved.hash,verified=await verifyPanelImage(p,record,artifact),latest=readProject(p.id),latestRecord=latest.panels?.[key],latestArtifact=(latest.artifacts||[]).find(item=>item.id===artifactId);
  if(active.has(p.id)||Number(latest.revision)!==expectedRevision||Number(latest.version)!==expectedVersion||latest.approved?.hash!==expectedPlanHash||!['attention','paused'].includes(latest.status)||latest.panelDecision?.state!=='required'||latest.panelDecision.panelKey!==key||latestRecord?.file!==record.file||latestRecord?.at!==record.at||latestRecord?.qa?.pass!==false||latestRecord?.userDecision?.action==='accept_current'||latestArtifact?.file!==record.file||latestArtifact?.valid===false||latestRecord.integrity?.sha256&&latestRecord.integrity.sha256!==verified.integrity.sha256||latestArtifact.integrity?.sha256&&latestArtifact.integrity.sha256!==verified.integrity.sha256)throw new Error('作品或当前图片已更新，请刷新后再提交这次决定。');
  Object.assign(p,latest);const current=p.panels[key],currentArtifact=(p.artifacts||[]).find(item=>item.id===artifactId);current.integrity=verified.integrity;currentArtifact.integrity=verified.integrity;const decidedAt=new Date().toISOString();current.userDecision={action:'accept_current',at:decidedAt,projectVersion:p.version,artifactId,contentHash,integritySha256:verified.integrity.sha256,acknowledgedIssueIds,issues:current.qa.issues||[]};p.panelDecision={state:'accepted',panelKey:key,artifactId,projectVersion:p.version,at:decidedAt};p.error=null;p.status='paused';p.message=`已明确采用第 ${key.split('-')[0]} 页第 ${key.split('-')[1]} 格当前图片。模型质检结论仍保留；接下来会继续排版和整篇检查。`;saveProject(p);
  return decision.continueProduction===false?p:generatePages(p);
}
function defaultCaptionAnchor(panel,index){return ['time','dialogue'].includes(panel?.captionKind)?'top-right':index%2?'top-left':'bottom-left';}
function nextCaptionAnchor(anchor){return {'bottom-left':'top-right','top-left':'bottom-right','top-right':'bottom-left','bottom-right':'top-left'}[anchor]||'top-right';}
function repairedLayoutHints(page,report,current={}){
  const anchors=page.panels.map((panel,index)=>current.captionAnchors?.[index]||defaultCaptionAnchor(panel,index));
  const widths=page.panels.map((_,index)=>Number(current.captionWidthRatios?.[index])||.62);
  const affected=new Set();
  for(const issue of report?.issueDetails||[]){
    if(!['recompose','reletter'].includes(issue.repairAction)||!/(?:文字|文案|字幕|排字|遮挡)/.test(`${issue.location||''} ${issue.description||''}`))continue;
    const match=/第\s*(\d+)\s*格/.exec(`${issue.location||''} ${issue.description||''}`);if(match)affected.add(Number(match[1])-1);
  }
  for(const index of affected)if(index>=0&&index<anchors.length){if(!current.captionAnchors?.[index]||widths[index]<=.38)anchors[index]=nextCaptionAnchor(anchors[index]);widths[index]=.36;}
  return {style:'floating-v2',captionAnchors:anchors,captionWidthRatios:widths,source:'qa-repair',repairPrompt:report?.repairPrompt||'',at:new Date().toISOString()};
}
function pageQaDefinition(page){
  return {...page,panels:page.panels.map(({prompt:_legacyPrompt,...panel})=>panel),layoutAuthority:'页面实际分格与本地排版器输出为唯一标准；方案页标题仅用于网页方案查看，不绘制到最终漫画页；旧生图提示中的比例措辞不参与成稿验收。'};
}
function invalidatePagePresentation(p,pageNumber,reason){
  const oldPage=p.pages?.find(page=>Number(page.number)===Number(pageNumber));
  if(oldPage){p.invalidatedPages=Array.isArray(p.invalidatedPages)?p.invalidatedPages:[];p.invalidatedPages.push({page:structuredClone(oldPage),reason,at:new Date().toISOString()});p.invalidatedPages=p.invalidatedPages.slice(-40);}
  invalidateArtifacts(p,['story:audit','export:bundle']);p.storyQA=null;p.bundle=null;p.accepted=false;p.acceptance=null;
}
async function composePage(p,page,signal){
  const previous=p.pages?.find(item=>Number(item.number)===Number(page.number));
  const alreadyArchived=(p.invalidatedPages||[]).some(item=>Number(item?.page?.number)===Number(page.number)&&item?.page?.file===previous?.file);
  if(previous&&previous.compositionVersion!==COMPOSITION_VERSION&&!alreadyArchived)invalidatePagePresentation(p,page.number,'composition-version-migration');
  const dir=runDir(p,`第${page.number}页排版`);const output=path.join(versionDir(p),'候选成稿',`${String(page.number).padStart(2,'0')}-${Date.now()}.png`);
  const images=page.panels.map((_,i)=>inside(projectDir(p.id),p.panels[`${page.number}-${i+1}`].file));
  const layoutHints=p.pageLayouts?.[page.number]||{style:'floating-v2'};
  jsonWrite(path.join(dir,'排版.json'),{page,total:p.plan.pages.length,images,output,layoutHints,compositionVersion:COMPOSITION_VERSION});
  await pythonRun(['compose',path.join(dir,'排版.json')]);checkpoint(signal);
  activity(p,`正在核对第 ${page.number} 页的文字、画面和连续性…`);
  const report=await qa(p,output,JSON.stringify(pageQaDefinition(page)),imageRefs(p,[...new Set(page.panels.flatMap(q=>q.references))]),signal,'1080×1440最终漫画页');
  const result={number:page.number,file:path.relative(projectDir(p.id),output),qa:report,layoutHints,compositionVersion:COMPOSITION_VERSION,at:new Date().toISOString(),dependsOn:page.panels.map((_,i)=>artifactIdForImageKey(`${page.number}-${i+1}`))};
  p.pages=p.pages.filter(q=>q.number!==page.number);p.pages.push(result);p.pages.sort((a,b)=>a.number-b.number);recordArtifact(p,`page:${page.number}`,'page',result.file,result.dependsOn,{compositionVersion:COMPOSITION_VERSION});saveProject(p);
  if(!report.pass){
    const actions=[...repairActions(report)],onlyLayout=actions.length>0&&actions.every(action=>['reletter','recompose','review'].includes(action));
    result.nextStep=onlyLayout?(actions.includes('reletter')?'重新排字':'重新排版'):'查看或修订';saveProject(p);
    if(!onlyLayout)throw new Error(`第 ${page.number} 页需要查看或修订：${report.issues.join('；')}`);
  }
  return result;
}
export function repairPageLayout(p,pageNumber){
  verifyApproval(p);if(p.pending)throw new Error('有一张原图结果尚未确认，暂不能调整页面排版。');if(p.accepted)throw new Error('已收下的成品请先建立新版本再调整。');
  const number=Number(pageNumber),page=p.plan.pages.find(item=>item.number===number),current=p.pages.find(item=>item.number===number);
  if(!page||!current)throw new Error('这一页还没有可调整的成稿。');if(page.panels.some((_,index)=>!p.panels[`${number}-${index+1}`]?.file))throw new Error('这一页的原始分镜还不完整。');
  return job(p,'revising',async signal=>{
    activity(p,`正在只调整第 ${number} 页的文字框位置，不会重新生图…`,number,p.plan.pages.length,'页面');
    invalidatePagePresentation(p,number,'layout-repaired');p.pageLayouts=p.pageLayouts||{};p.pageLayouts[number]=repairedLayoutHints(page,current.qa,p.pageLayouts[number]);saveProject(p);
    const result=await composePage(p,page,signal);p.error=null;
    if(result.qa.pass){p.status='paused';activity(p,`第 ${number} 页排版已修复并通过检查；原始分镜没有重新生成。`,number,p.plan.pages.length,'页面');}
    else {p.status='attention';activity(p,`第 ${number} 页已换用新的文字框位置，但仍有排版问题，请查看后再次调整。`,number,p.plan.pages.length,'页面');}
  });
}
export function unifyPageLayouts(p){
  verifyApproval(p);if(p.pending)throw new Error('有一张原图结果尚未确认，暂不能统一页面排版。');if(p.accepted)throw new Error('已收下的成品请先建立新版本再调整。');
  const numbers=(p.pages||[]).map(page=>Number(page.number)).filter(Number.isFinite).sort((a,b)=>a-b);if(numbers.length<2)throw new Error('至少需要两页成稿才能统一全篇排版。');
  return job(p,'revising',async signal=>{
    p.pageLayouts=p.pageLayouts||{};let failed=0;
    for(const [index,number] of numbers.entries()){
      const page=p.plan.pages.find(item=>item.number===number),current=p.pages.find(item=>item.number===number);if(!page||!current)continue;
      checkpoint(signal);activity(p,`正在统一第 ${number} 页的圆角分格、浮动文字框和页码…`,index,numbers.length,'页面');
      invalidatePagePresentation(p,number,'layout-unified');p.pageLayouts[number]=current.qa?.pass?{...p.pageLayouts[number],style:'floating-v2',source:'whole-story-unify',at:new Date().toISOString()}:repairedLayoutHints(page,current.qa,p.pageLayouts[number]);
      const result=await composePage(p,page,signal);if(!result.qa.pass)failed++;
    }
    p.error=null;p.status=failed?'attention':'paused';activity(p,failed?`已有页面已统一为同一版式，其中 ${failed} 页仍需单独调整。`:`已有 ${numbers.length} 页已统一为同一版式，原始分镜均未重新生成。`,numbers.length,numbers.length,'页面');
  });
}
async function addScreen(p,key,panel,signal){
  if(!panel.screenText || p.panels[key].screenApplied)return;
  const record=p.panels[key];const input=inside(projectDir(p.id),record.rawFile||record.file);
  const dir=runDir(p,'内屏文字排版');const output=path.join(dir,'内屏排版.png');
  activity(p,`正在定位第 ${key.split('-')[0]} 页的玻璃内屏…`);
  const sourceSha256=checksum(input);let located=record.screenLocation?.sourceSha256===sourceSha256?record.screenLocation:null;
  if(!located&&process.env.WENDI_TEST_PLAN_FILE){const info=JSON.parse(await pythonRun(['info',input]));located={corners:[{x:2,y:2},{x:info.width-3,y:2},{x:info.width-3,y:info.height-3},{x:2,y:info.height-3}],confidence:1,screenType:'other'};}
  else if(!located){located=await runCodex({dir:runDir(p,'内屏位置识别'),signal,schema:SCREEN_LOCATION_SCHEMA,images:[input],role:'qa',...modelArgs(p,'low'),prompt:`只检查附件中的玻璃内屏位置，不修改文件、不调用工具。返回屏幕内容区域四角的原图像素坐标，严格按左上、右上、右下、左下顺序；排除外壳和边框。识别手机、电脑或车机类型并给出0到1置信度。原图路径：${input}`});addUsage(p,located.__usage,{...modelArgs(p,'low'),role:'qa'});}
  checkpoint(signal);if(Number(located.confidence)<.68)throw new Error('这张内屏的边界还不能可靠定位，原图已保留，请人工查看。');
  record.screenLocation={corners:located.corners,confidence:Number(located.confidence),screenType:located.screenType,sourceSha256,at:located.at||new Date().toISOString()};saveProject(p);
  activity(p,`正在把第 ${key.split('-')[0]} 页的文字排进玻璃内屏…`);const spec=path.join(dir,'内屏排版.json');jsonWrite(spec,{input,output,corners:located.corners,screenType:located.screenType,screenText:panel.screenText,screenDirection:panel.screenDirection});const screenResult=JSON.parse(await pythonRun(['screen',spec]));checkpoint(signal);
  if(!fs.existsSync(output))throw new Error('这张内屏的透视位置还需调整，原图已保留，请补充修改要求。');
  const expected=String(panel.screenText||'').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&line.toLowerCase()!=='codex').join(''),rendered=(screenResult.renderedLines||[]).join('');if(expected!==rendered)throw new Error('内屏冻结文案没有被完整排入，原图已保留。');
  const integrity=await verifyImage(output),report={pass:true,status:'local',summary:`中文由本地排版器逐字绘制，投影字高约 ${screenResult.projectedTextPx} 像素，并限制在玻璃内屏内。`,issues:[],issueDetails:[],repairPrompt:'',confidence:located.confidence,screenType:located.screenType,projectedTextPx:screenResult.projectedTextPx,renderedLines:screenResult.renderedLines};
  const rawFile=record.rawFile||record.file;invalidatePanelDownstream(p,key);record.rawFile=rawFile;record.file=path.relative(projectDir(p.id),output);record.integrity=integrity;record.at=new Date().toISOString();record.screenApplied=true;record.screenQA=report;recordArtifact(p,artifactIdForImageKey(key),'image',record.file,[],{integrity});jsonWrite(output+'.json',record);saveProject(p);
}
function currentImageArtifact(p,key){
  const record=p.panels?.[key],id=artifactIdForImageKey(key);
  return record?.file?(p.artifacts||[]).find(artifact=>artifact.id===id&&artifact.file===record.file&&artifact.valid!==false):null;
}
export function pageIsCurrent(p,page){
  if(page?.compositionVersion!==COMPOSITION_VERSION||!page?.qa?.pass)return false;
  const pageArtifact=(p.artifacts||[]).find(artifact=>artifact.id===`page:${page.number}`&&artifact.file===page.file&&artifact.valid!==false);
  const definition=p.plan?.pages?.find(item=>Number(item.number)===Number(page.number));
  if(!pageArtifact||pageArtifact.compositionVersion!==COMPOSITION_VERSION||!definition||!Array.isArray(page.dependsOn))return false;
  const expected=definition.panels.map((_,index)=>artifactIdForImageKey(`${page.number}-${index+1}`));
  return expected.every(id=>page.dependsOn.includes(id)&&currentImageArtifact(p,`${page.number}-${expected.indexOf(id)+1}`)?.id===id);
}
export function generatePages(p){verifyApproval(p);if(!p.samplesApproved)throw new Error('请先确认人物和场景样张。');return job(p,'generating',async signal=>{
  const totalPanels=p.plan.pages.reduce((n,page)=>n+page.panels.length,0),verifyPanels=p.brief.workflowPreset==='careful';let completed=Object.keys(p.panels).length;
  for(const page of p.plan.pages){
    if(pageIsCurrent(p,p.pages.find(q=>q.number===page.number)))continue;
    const geoFile=path.join(runDir(p,'分镜比例'),'page.json');jsonWrite(geoFile,page);
    const geometry=JSON.parse(await pythonRun(['geometry',geoFile]));
    for(const [i,q] of page.panels.entries()){
      const key=`${page.number}-${i+1}`;
      const existing=p.panels[key];
      if(panelAccepted(existing)){await addScreen(p,key,q,signal);continue;}
      // This may be a file recovered after an interrupted local copy or a QA
      // outage. It is a real retained image, not a signal to spend another
      // generation request when the creator presses Continue.
      if(existing?.file){
        if(existing.qa?.pass===false&&!existing.userDecision){requirePanelDecision(p,key,existing);p.status='attention';p.message=`第 ${page.number} 页第 ${i+1} 格的画面检查未通过，请查看列出的问题后选择“采用当前图片”或“修改这一张”。系统不会自动重画。`;saveProject(p);return;}
        p.status='attention';p.message=`第 ${page.number} 页第 ${i+1} 格的原图已保存，但${['recovered_pending_review','manual_review'].includes(existing.qa?.status)?'尚未完成人工视觉校对':'需要人工查看'}。请在网页中查看后决定修改或继续；继续制作不会自动重生这张图。`;saveProject(p);return;
      }
      checkpoint(signal);activity(p,`正在绘制第 ${page.number}/${p.plan.pages.length} 页 · 第 ${i+1}/${page.panels.length} 格…`,completed,totalPanels,'分镜');
      const g=geometry[i];const prompt=compilePanelPrompt(page.number,i+1,q,g,[]);
      const result=await generate(p,`第${page.number}页-第${i+1}格`,prompt,q.references,signal,null,verifyPanels);
      p.panels[key]=result;saveProject(p);
      if(verifyPanels&&!result.qa.pass){
        // Quality review is advisory. The single source image remains attached
        // and the next paid image request must come from an explicit user edit.
        requirePanelDecision(p,key,result);p.status='attention';p.message=`第 ${page.number} 页第 ${i+1} 格的原图已保存，画面检查建议：${(result.qa.issues||[]).join('；')||'请人工查看'}。系统不会自动重画；请查看后选择“修改这张图”，或确认采用当前图再继续。`;saveProject(p);return;
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
export function reviseImage(p,key,note,options={}){
  verifyApproval(p);if(typeof note!=='string'||note.trim().length<2||note.length>4000)throw new Error('请描述要改动的地方。');
  if(layoutOnlyRevision(note)){const error=new Error('文字或排版问题请使用“修复本页排版”，不会为此重新生图。');error.code='LOCAL_LAYOUT_REQUIRED';throw error;}
  let old,refs,prompt;
  const sample=/^sample-([12])$/.exec(key);const panel=/^(\d+)-(\d+)$/.exec(key);
  if(sample){old=p.samples[+sample[1]-1];const s=p.plan.samples[+sample[1]-1];if(!s)throw new Error('样张不存在');refs=s.references;prompt=old?.basePrompt||s.prompt;}
  else if(panel){old=p.panels[key];const q=p.plan.pages[+panel[1]-1]?.panels[+panel[2]-1];if(!q)throw new Error('分镜不存在');refs=q.references;prompt=old?.basePrompt||q.prompt||old?.prompt;}
  else throw new Error('分镜不存在');if(!old)throw new Error('这张图尚未生成');
  if(typeof prompt!=='string'||!prompt.trim())throw new Error('当前图片缺少冻结的原始提示词，请先查看历史记录后再修改。');
  const prior=revisionBaseFile(p,old,options),baseFile=path.relative(projectDir(p.id),prior),baseSha256=checksum(prior),explicitBase=Boolean(options.baseFile||options.basePath||options.baseArtifactId),stableFallback=!explicitBase&&(old?.qa?.pass===false||old?.qa?.status==='unavailable')&&old?.revisionBase?.file,revisionBase={file:baseFile,sha256:baseSha256,selectedBy:explicitBase?'user':stableFallback?'previous-stable-base':'current-image',selectedAt:new Date().toISOString()};
  const revisionPrompt=buildRevisionPrompt(prompt,note,{key,baseFile});
  return job(p,'revising',async signal=>{
    activity(p,'正在按你的说明修改这一张，原版本会保留；只传本次修改差异…');p.accepted=false;
    p.revisionNotes.push({key,note:note.trim(),mode:'image-delta',basePrompt:prompt,baseFile,baseSha256,selectedBy:revisionBase.selectedBy,at:new Date().toISOString()});
    const result=await generate(p,key+'-局部修订',revisionPrompt,refs,signal,prior,true,'原始分镜',1,{basePrompt:prompt,revisionDelta:note.trim(),revisionBase});
    if(sample){p.samples[+sample[1]-1]=result;p.samplesApproved=false;p.status=p.samples.length===2&&p.samples.every(q=>q.qa.pass)?'samples_review':'attention';}
    else {p.panels[key]=result;const pageId=+panel[1];if(result.qa.pass)await addScreen(p,key,p.plan.pages[pageId-1].panels[+panel[2]-1],signal);if(result.qa.pass)await composePage(p,p.plan.pages[pageId-1],signal);p.status='paused';}
    saveProject(p);if(!result.qa.pass)throw new Error(result.qa.issues.join('；'));activity(p,sample?'样张已更新，请重新确认。':'这一格已修好并更新页面，可以继续制作与整篇校对。');
  });
}
function resumeSameRequestImage(p){
  verifyApproval(p);const pending=p.pending,record=matchingWebRunRecord(pending),manifest=record?.manifest,quota=preAcceptanceQuotaEvidence(pending,manifest),confirmedUnsent=confirmedUnsentEvidence(pending,manifest);
  if(!quota&&!confirmedUnsent)throw new Error('当前图片请求既不是可安全续接的接受前额度暂停，也没有匹配的网页未发送核验；请先检查已有原图。');
  const task=(p.tasks||[]).find(item=>item.id===pending.taskId);
  if(!task||task.projectId!==p.id||Number(task.projectVersion)!==Number(p.version)||task.target!==pending.key)throw new Error('待续接任务与当前作品版本不匹配；原记录已保留。');
  return job(p,'revising',async signal=>{
    const executor={model:pending.executorModel||record.worker.executorModel||null,reasoningEffort:pending.executorReasoningEffort||record.worker.executorReasoningEffort||WEB_IMAGE_EXECUTOR_EFFORT,role:record.worker.role||WEB_IMAGE_EXECUTOR_ROLE};
    await protectQuota(p,{executorModel:executor.model});checkpoint(signal);
    Object.assign(task,{status:'running',errorCode:null,error:null,completedAt:null,lastProgressAt:new Date().toISOString(),resumedAt:new Date().toISOString(),requestId:manifest.requestId,providerInvocations:0});p.currentTask=task;
    activity(p,quota?`额度已恢复，正在按原 requestId 续接 ${pending.key}；不会创建第二个请求…`:`已核实上次网页未实际发送，正在按原 requestId 续接 ${pending.key}；不会创建第二个请求…`);
    let made=null,failure=null;
    const capsule=fs.readFileSync(path.join(versionDir(p),'制作提示词胶囊.txt'),'utf8'),conversationUrl=manifest.conversationUrl||previousConversation(pending.prior),instruction=chatGptWebImagePrompt({outputFile:record.worker.outputFile||pending.file,manifestFile:path.join(pending.dir,'web-generation.json'),prompt:pending.prompt,referenceFiles:record.worker.referenceFiles||pending.inputFiles||[],editTarget:pending.prior,conversationUrl,capsule,requestId:manifest.requestId});
    try{made=await resumeChatGptWebJob({codexBin:findCodex(),dir:pending.dir,signal,...executor,instruction,expected:{projectId:p.id,projectVersion:p.version,taskId:pending.taskId,target:pending.key,requestId:manifest.requestId}});addUsage(p,made.usage,executor);}catch(error){failure=error;}
    const webManifest=readWebManifest(path.join(pending.dir,'web-generation.json'))||failure?.webManifest||made?.manifest||null;
    if(webManifest?.requestId){pending.requestId=webManifest.requestId;pending.accepted=webManifest.accepted===true;pending.submitted=webManifest.submitted===true;pending.referenceCount=Number(webManifest.referenceCount)||0;task.requestId=webManifest.requestId;task.accepted=pending.accepted;task.submitted=pending.submitted;task.referenceCount=pending.referenceCount;}
    task.providerInvocations=webManifest?.submitted?1:0;task.webState=webManifest?.state||null;task.webTimings=webManifest?{createdAt:webManifest.createdAt||null,acceptedAt:webManifest.acceptedAt||null,readyAt:webManifest.readyAt||null,submittedAt:webManifest.submittedAt||null,downloadedAt:webManifest.downloadedAt||null,executorModel:webManifest.executorModel||executor.model||null,executorReasoningEffort:webManifest.executorReasoningEffort||executor.reasoningEffort,role:webManifest.role||executor.role}:null;saveProject(p);
    if(!matchingPendingManifest(pending)){finishTask(p,task,'unknown_result',{errorCode:'REQUEST_IDENTITY_MISMATCH'});throw new Error('续接记录与当前图片请求不匹配，原文件已保留，不能自动采用或重试。');}
    if(preAcceptanceQuotaEvidence(pending,webManifest,failure,made)){
      const usageError=String(failure?.message||webManifest?.error||quota.error||'已达到生图执行器额度限制。').slice(0,1000),message=quotaPauseMessage(pending.key,webManifest.requestId,pending.taskId,pending.projectVersion,usageError);
      Object.assign(task,{status:'paused',errorCode:USAGE_LIMIT_BEFORE_START,providerInvocations:0,webState:'queued',completedAt:new Date().toISOString(),error:message});pending.quotaPaused=true;pending.quotaError=usageError;p.lastFailure=null;p.status='paused';p.error=message;p.message=message;saveProject(p);const error=new Error(message);error.code=USAGE_LIMIT_BEFORE_START;throw error;
    }
    activity(p,'正在核对网页执行结果并保存原图…');
    const {evidence,candidates}=attributableCandidates(pending);let persisted=null;if(candidates.length===1)persisted=await persistImage(candidates[0],pending.file);
    if(!persisted){
      writeRunResult(pending.dir,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,requestId:webManifest?.requestId||manifest.requestId,endedAt:new Date().toISOString(),outcome:'artifact_not_located_after_resume',diagnostics:generationDiagnosticSummary(evidence),candidateCount:candidates.length,candidateNames:candidates.map(candidate=>path.basename(candidate)),error:failure?String(failure.message||failure).slice(0,500):null});
      const known=definiteImageFailure(pending,[made?.text,failure?.message,webManifest?.errorCode,webManifest?.error].filter(Boolean).join('\n'));
      if(known){if(CONFIRMED_PRE_SUBMISSION_KINDS.has(known.kind)&&known.kind!=='no-output')task.providerInvocations=0;p.pending=null;p.lastFailure={...known,taskId:task.id};finishTask(p,task,'failed_no_output',{errorCode:known.kind,webState:webManifest?.state||null});saveProject(p);const error=new Error(failureMessage(known));error.code='IMAGE_NO_OUTPUT';throw error;}
      finishTask(p,task,'unknown_result',{errorCode:'unknown_result',webState:webManifest?.state||null});throw failure||new Error('续接后在保存结果前中断。当前请求记录已保留，不会自动再次发送。');
    }
    const file=persisted.file;pending.file=file;pending.integrity=persisted.integrity;
    writeRunResult(pending.dir,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,requestId:webManifest.requestId,projectId:p.id,projectVersion:p.version,target:pending.key,endedAt:new Date().toISOString(),outcome:'artifact_saved_after_same_request_resume',artifact:path.relative(projectDir(p.id),file),integrity:persisted.integrity,downloadEvidence:readDownloadEvidence(pending.dir),diagnostics:generationDiagnosticSummary(evidence)});
    const imageRecord={key:pending.key,file:path.relative(projectDir(p.id),file),provider:WEB_IMAGE_PROVIDER,conversationUrl:webManifest.conversationUrl||null,prompt:pending.prompt,basePrompt:pending.basePrompt||pending.prompt,revisionDelta:pending.revisionDelta||null,revisionBase:pending.revisionBase||null,executor,refs:pending.refs,telemetry:pending.telemetry,integrity:persisted.integrity,downloadEvidence:readDownloadEvidence(pending.dir),qa:{pass:null,status:'pending',summary:'原图已保存，等待画面校对。',issues:[],repairPrompt:''},at:new Date().toISOString()};
    jsonWrite(file+'.json',imageRecord);const panelKey=panelKeyFromImageKey(pending.key);if(panelKey)invalidatePanelDownstream(p,panelKey);recordArtifact(p,artifactIdForImageKey(pending.key),'image',imageRecord.file,[],{integrity:persisted.integrity,downloadEvidence:imageRecord.downloadEvidence});attachImageRecord(p,imageRecord);p.pending=null;p.lastFailure=null;finishTask(p,task,'artifact_saved',{artifact:file,qa:'pending',webState:'downloaded'});saveProject(p);
    try{
      checkpoint(signal);const check=await qa(p,file,pending.prompt,imageRefs(p,pending.refs||[]),signal,'原始分镜');imageRecord.qa=check;jsonWrite(file+'.json',imageRecord);finishTask(p,task,'completed',{artifact:file,qa:check.pass?'passed':'needs_review',webState:'downloaded'});p.status=check.pass?'paused':'attention';p.error=null;p.message=check.pass?`${pending.key} 已按原请求完成、保存并校对；本次只续接这一张。`:`${pending.key} 原图已保存，画面检查建议：${(check.issues||[]).join('；')||'请人工查看'}。本次不会自动重画。`;if(panelKey&&!check.pass)requirePanelDecision(p,panelKey,imageRecord);saveProject(p);return imageRecord;
    }catch(error){const outcome=savedArtifactQaUnavailable(error,{artifact:file,webState:'downloaded'});applySavedArtifactQaOutcome({project:p,task,record:imageRecord,artifactFile:file,outcome,saveProject,finishTask,jsonWrite,writeRunResult:result=>writeRunResult(pending.dir,result),runResult:{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,taskId:task.id,requestId:webManifest.requestId,endedAt:new Date().toISOString(),outcome:outcome.outcome,artifact:path.relative(projectDir(p.id),file),integrity:persisted.integrity,errorCode:outcome.errorCode,error:outcome.detail},extraTask:{webState:'downloaded'}});return imageRecord;}
  });
}
export function resume(p){if(p.pending){
  const manifest=matchingPendingManifest(p.pending);
  if(preAcceptanceQuotaEvidence(p.pending,manifest)||confirmedUnsentEvidence(p.pending,manifest))return resumeSameRequestImage(p);
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
  return deriveRetryableImageFailure(p,CONFIRMED_PRE_SUBMISSION_KINDS);
}
export function imageRetryState(p){
  return deriveImageRetryState(p,CONFIRMED_PRE_SUBMISSION_KINDS);
}
function unknownResultMessage(target='当前图片'){return deriveUnknownResultMessage(target);}
export function retryMissingImage(p,target,{allowUnknownResult=false}={}){
  verifyApproval(p);const state=imageRetryState(p),failure=state?.failure;
  if(p.pending&&!(allowUnknownResult&&state?.certainty==='unknown_result'))throw new Error('上次生成结果尚未确认，请先检查已保存图片。');
  if(!state||state.target!==target||(state.certainty==='unknown_result'&&!allowUnknownResult))throw new Error('当前没有可安全重试的这张图片。');
  const sampleIndex=sampleIndexFromKey(target),panelKey=panelKeyFromImageKey(target),panelRevision=panelKey?latestImageRevision(p,panelKey):null;
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
    const prompt=compilePanelPrompt(pageNumber,panelNumber,panel,geometry,[]);let prior=null,revisionMeta={};
    if(panelRevision){
      prior=revisionBaseFile(p,p.panels?.[panelKey]||{}, {baseFile:panelRevision.baseFile});const selectedBase=path.relative(projectDir(p.id),prior);if(panelRevision.baseSha256&&checksum(prior)!==panelRevision.baseSha256)throw new Error('原修订基图内容已经更新，请重新选择基图后重试。');
      const basePrompt=String(panelRevision.basePrompt||panel.prompt||prompt),revisionDelta=String(panelRevision.note||'').trim();if(!revisionDelta)throw new Error('原修订说明缺失，请重新提交这次修改。');revisionMeta={basePrompt,revisionDelta,revisionBase:{file:selectedBase,sha256:checksum(prior),selectedBy:panelRevision.selectedBy||'previous-stable-base',selectedAt:new Date().toISOString()}};
    }
    const finalPrompt=panelRevision?buildRevisionPrompt(revisionMeta.basePrompt,revisionMeta.revisionDelta,{key:panelKey,baseFile:revisionMeta.revisionBase.file}):prompt;
    // A user-confirmed single-panel retry is an explicit review boundary. It
    // must run visual QA even when the project predates workflowPreset or was
    // created in quick/balanced mode; batch settings never waive this check.
    const result=await generate(p,`第${pageNumber}页-第${panelNumber}格`,finalPrompt,panel.references,signal,prior,true,'原始分镜',Math.max(1,Number(failure.attempts||0)+1),revisionMeta);
    p.panels[panelKey]=result;p.accepted=false;p.status='paused';const totalPanels=p.plan.pages.reduce((total,item)=>total+item.panels.length,0);activity(p,`${target} 已重新生成并保存；本次不会继续生成其他分镜。`,Object.keys(p.panels).length,totalPanels,'分镜');
  });
}
export function recoverImage(p){return recoverImageAction(p);}
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
      const report=await qa(p,file,prompt,imageRefs(p,refs),signal,kind);record.qa=report;if(panel&&!report.pass){invalidatePanelDownstream(p,key);requirePanelDecision(p,key,record);}else if(panel)p.panelDecision=null;
      jsonWrite(file+'.json',record);finishTask(p,task,'completed',{artifact:file,qa:report.pass?'passed':'needs_review'});
      p.status='paused';p.error=null;p.message=report.pass?'原图已重新校对，可以继续下一步。':'原图已重新校对，请查看建议后决定是否修改。';saveProject(p);return record;
    }catch(error){
      if(signal.aborted){
        record.qa={pass:null,status:'unavailable',summary:'原图仍已保存，但本次任务已暂停，尚未自动校对。',issues:[],repairPrompt:'',qaError:String(error.message||error).slice(0,500)};
        jsonWrite(file+'.json',record);finishTask(p,task,'review_failed',{artifact:file,error:record.qa.qaError});saveProject(p);throw error;
      }
      const outcome=savedArtifactQaUnavailable(error,{artifact:file,taskStatus:IMAGE_OUTCOME.REVIEW_REQUIRED});
      applySavedArtifactQaOutcome({project:p,task,record,artifactFile:file,outcome,saveProject,finishTask,jsonWrite});
      throw new SavedArtifactQaUnavailableError(error,{artifact:file,taskStatus:IMAGE_OUTCOME.REVIEW_REQUIRED});
    }
  });
}
export async function accept(p,checks){
  if(active.has(p.id)||p.status!=='ready'||p.pages.length!==p.plan.pages.length||p.pages.some(q=>!pageIsCurrent(p,q))||!p.storyQA?.pass||(p.artifacts||[]).find(artifact=>artifact.id==='story:audit')?.valid!==true)throw new Error('请先完成全篇制作和校对。');
  if(!Array.isArray(checks)||!CHECKS.every(c=>checks.includes(c)))throw new Error('请先完成成稿验收。');
  const finalDir=path.join(versionDir(p),'成品');fs.mkdirSync(finalDir,{recursive:true});
  for(const q of p.pages){const file=path.join(finalDir,`${String(q.number).padStart(2,'0')}.png`);fs.copyFileSync(inside(projectDir(p.id),q.file),file);q.finalFile=path.relative(projectDir(p.id),file);}
  const dir=runDir(p,'作品打包');const output=path.join(versionDir(p),'温蒂漫画成品.zip');
  jsonWrite(path.join(dir,'zip.json'),{output,files:[...p.pages.map(q=>inside(projectDir(p.id),q.finalFile)),path.join(versionDir(p),'已确认分镜.md')]});
  await pythonRun(['zip',path.join(dir,'zip.json')]);
  p.accepted=true;p.acceptance={at:new Date().toISOString(),checks};p.bundle=path.relative(projectDir(p.id),output);recordArtifact(p,'export:bundle','export',p.bundle,['story:audit']);p.status='complete';activity(p,'成品已保存到本地，可以下载整套图片。');return p;
}
