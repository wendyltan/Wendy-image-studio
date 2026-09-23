import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {APP,ROOT,REFS,CHECKS,inside,digest} from './workflow.mjs';
import {connectionStatus,appServerSnapshot,normalizeRateLimits} from './bridge.mjs';
import {WEB_IMAGE_PROVIDER,readWebManifest,webWorkerStatus} from './chatgpt-web-provider.mjs';
import {active,listProjects,readProject,saveProject,createProject,planProject,approvePlan,approveSamples,decideSamples,decidePanel,rejectPanel,resume,reviseImage,repairPageLayout,confirmPageLayout,reviewPage,unifyPageLayouts,recoverImage,adoptNativeDownload,reviewImage,retryMissingImage,imageRetryState,accept,recover,projectDir,syncRunningProject,refreshQuotaPauses,hasLiveWork} from './engine.mjs';
import {CATEGORIES,listDocuments,listAssets,discoverArchiveStories,archiveStory,stageUpload,readCandidate,inspectStagedCandidate,saveManualAsset,searchAssets,analyzeAsset,saveAssetProposal,applyAssetProposal,saveDocument,suggestDocument,deleteProjectFolder,deleteArchiveStory} from './library.mjs';
import {applyProjectStorageCleanup,reportDownloadsRedundancy,reportProjectStorage} from './storage-hygiene.mjs';
import {classifyFailure} from './failure-classifier.mjs';
import {readUploadEvidence} from './web-upload-evidence.mjs';
const PORT=Number(process.env.PORT||4318);const HOST='127.0.0.1';
const INSTANCE_ID=`${process.pid}-${Date.now()}`;let restartRequested=false;
const front=path.join(APP,'dist/client');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.zip':'application/zip','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8'};
let connection=await connectionStatus();
const connectionSnapshot=()=>({...connection,imageWorker:webWorkerStatus()});
const ACCOUNT_CACHE_FILE=path.join(APP,'.runtime','account-cache.json');
function readAccountCache(){try{return JSON.parse(fs.readFileSync(ACCOUNT_CACHE_FILE,'utf8'));}catch{return null;}}
function writeAccountCache(value){try{fs.mkdirSync(path.dirname(ACCOUNT_CACHE_FILE),{recursive:true});fs.writeFileSync(ACCOUNT_CACHE_FILE,JSON.stringify(value),{mode:0o600});}catch{}}
let accountCache={at:0,value:readAccountCache()},accountInFlight=null;
recover();
const fallbackModels=[{id:'gpt-6-astra',label:'GPT-6 Astra',description:'复杂故事与关键成稿',defaultReasoningEffort:'low',reasoningEfforts:['low','medium','high','xhigh','max','ultra']},{id:'gpt-5.6-terra',label:'GPT-5.6 Terra',description:'日常创作的均衡选择',defaultReasoningEffort:'medium',reasoningEfforts:['low','medium','high','xhigh','max','ultra']}];
async function account(force=false){
  if(!force&&accountCache.value&&Date.now()-accountCache.at<120000)return accountCache.value;
  if(accountInFlight)return accountInFlight;
  accountInFlight=(async()=>{
    const raw=await appServerSnapshot();
    const models=(raw.models||[]).map(m=>({id:m.id||m.model,label:m.displayName||m.name||m.id||m.model,description:m.description||'',defaultReasoningEffort:m.defaultReasoningEffort||'medium',reasoningEfforts:(m.supportedReasoningEfforts||m.reasoningEfforts||[]).map(x=>typeof x==='string'?x:x.reasoningEffort||x.value).filter(Boolean),isDefault:m.isDefault===true}));
    const limits=normalizeRateLimits(raw.rateLimits);
    const observed=limits.primary||limits.secondary;
    const fresh=Boolean(observed&&raw.status!=='stale');
    const previous=accountCache.value;
    const clean={models:models.length?models:(previous?.models||fallbackModels),rateLimits:fresh?limits:(previous?.rateLimits||null),usage:raw.usage?{planType:raw.usage.planType||null,credits:raw.usage.credits?{balance:raw.usage.credits.balance}:null}:null,status:fresh?(raw.status||'fresh'):(previous?.rateLimits?'stale':'unavailable'),error:raw.error||(!fresh?'额度暂不可用。':'')||null,updatedAt:fresh?new Date().toISOString():(previous?.updatedAt||null)};
    if(fresh&&!process.env.WENDI_TEST_PLAN_FILE){writeAccountCache(clean);refreshQuotaPauses(limits.primary?.remainingPercent);}
    accountCache={at:Date.now(),value:clean};return clean;
  })();
  try{return await accountInFlight;}finally{accountInFlight=null;}
}
function send(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function publicAsset(asset){
  return {...asset,url:'/media/asset/'+asset.file.split('/').map(encodeURIComponent).join('/')};
}
function publicAssets(assets=listAssets()){return assets.map(publicAsset);}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function writeFailureClassification(dir, value){
  if(!dir||!value)return;
  try{
    fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,'failure-classification.json');
    const temp=`${file}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
    fs.renameSync(temp,file);
  }catch{}
}
function pendingWebEvidence(p,pending){
  if(pending?.provider!==WEB_IMAGE_PROVIDER||!pending.dir)return null;
  const manifest=readWebManifest(path.join(pending.dir,'web-generation.json'));if(!manifest)return null;
  const request=readJson(path.join(pending.dir,'request.json')),workerRequest=readJson(path.join(pending.dir,'worker-request.json'));
  const identityMatches=Boolean(
    manifest.requestId&&request?.provider===WEB_IMAGE_PROVIDER&&request.taskId===pending.taskId&&request.projectId===p.id&&Number(request.projectVersion)===Number(pending.projectVersion??p.version)&&
    workerRequest?.provider===WEB_IMAGE_PROVIDER&&workerRequest.requestId===manifest.requestId,
  );
  const uploadEvidence=readUploadEvidence(pending.dir);
  return {manifest,uploadEvidence,identityMatches};
}
function terminalTaskWebManifest(p,task,lastFailure){
  if(!task?.id)return null;
  const records=path.join(projectDir(p.id),'.制作记录');
  if(!fs.existsSync(records))return null;
  const requestedRunId=String(lastFailure?.diagnostics?.runId||'');
  const names=requestedRunId&&path.basename(requestedRunId)===requestedRunId
    ? [requestedRunId]
    : fs.readdirSync(records).sort().reverse().slice(0,8);
  for(const name of names){
    const dir=path.join(records,name),request=readJson(path.join(dir,'request.json')),worker=readJson(path.join(dir,'worker-request.json')),manifest=readWebManifest(path.join(dir,'web-generation.json'));
    if(!request||!worker||!manifest||request.provider!==WEB_IMAGE_PROVIDER||worker.provider!==WEB_IMAGE_PROVIDER)continue;
    const requestId=String(manifest.requestId||'');
    if(!requestId||request.requestId!==requestId||worker.requestId!==requestId)continue;
    if(request.taskId!==task.id||request.projectId!==p.id||Number(request.projectVersion)!==Number(task.projectVersion??p.version)||request.target!==task.target)continue;
    if(worker.projectId!==p.id||worker.taskId!==task.id||Number(worker.projectVersion)!==Number(task.projectVersion??p.version)||worker.target!==task.target)continue;
    if(request.runId!==path.basename(dir)||worker.runId!==path.basename(dir)||manifest.runId!==path.basename(dir))continue;
    if(path.resolve(String(request.outputFile||''))!==path.resolve(String(worker.outputFile||''))||path.resolve(String(worker.manifestFile||''))!==path.join(dir,'web-generation.json'))continue;
    if(manifest.projectId!==p.id||manifest.taskId!==task.id||Number(manifest.projectVersion)!==Number(task.projectVersion??p.version)||manifest.target!==task.target)continue;
    return manifest;
  }
  return null;
}
function file(res,file,download=false){
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())return send(res,{error:'文件不存在'},404);
  const headers={'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':'no-cache'};
  if(download)headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  res.writeHead(200,headers);fs.createReadStream(file).pipe(res);
}
function publicProject(p){
  const media=f=>f?`/media/project/${p.id}/${f.split(path.sep).map(encodeURIComponent).join('/')}`:null;
  const artifacts=Array.isArray(p.artifacts)?p.artifacts:[];
  const artifactFor=(record,fallbackId)=>artifacts.find(item=>item.file===record?.file)||artifacts.find(item=>item.id===fallbackId)||null;
  const publicImage=(record,fallbackId)=>{
    if(!record)return record;
    const {file,finalFile,rawFile:_rawFile,userDecision,...safe}=record,artifact=artifactFor(record,fallbackId),displayFile=finalFile||file;
    // The file name is deliberately absent from the API. The browser gets a
    // media URL plus a stable content token for an explicit user decision.
    const sampleNumber=Number(/^image:样张-([12])$/.exec(fallbackId)?.[1]);
    const isCurrentSample=Number.isInteger(sampleNumber)&&p.status==='samples_decision'&&p.samplesDecision?.sampleIndexes?.includes(sampleNumber)&&userDecision?.action!=='accept_current';
    return {...safe,url:media(displayFile),artifactId:artifact?.id||fallbackId,contentHash:digest({artifactId:artifact?.id||fallbackId,file,at:record.at||artifact?.at||null}),review:record.qa||null,decision:userDecision||null,availableActions:isCurrentSample?['accept_current','regenerate_current']:[]};
  };
  const publicTask=task=>task?{id:task.id,kind:task.kind,target:task.target,status:task.status,attempt:task.attempt,providerInvocationLimit:task.providerInvocationLimit,providerInvocations:task.providerInvocations,startedAt:task.startedAt,lastProgressAt:task.lastProgressAt,completedAt:task.completedAt,qa:task.qa,errorCode:task.errorCode,webState:task.webState,webTimings:task.webTimings||null,executorExecutionState:task.executorExecutionState??task.webTimings?.executorExecutionState??null,artifactAcceptanceState:task.artifactAcceptanceState??task.webTimings?.artifactAcceptanceState??null,recoveryNotice:task.recoveryNotice??task.webTimings?.recoveryNotice??null,attachmentExpectedCount:task.attachmentExpectedCount??task.webTimings?.attachmentExpectedCount??null,attachmentObservedCount:task.attachmentObservedCount??task.webTimings?.attachmentObservedCount??null,attachmentPending:task.attachmentPending??task.webTimings?.attachmentPending??null,sendEnabled:task.sendEnabled??task.webTimings?.sendEnabled??null,failureStage:task.failureStage??task.webTimings?.failureStage??null,browserStage:task.browserStage??task.webTimings?.browserStage??null,runtimeErrorCategory:task.runtimeErrorCategory??task.webTimings?.runtimeErrorCategory??null,runtimeErrorMessage:task.runtimeErrorMessage??task.webTimings?.runtimeErrorMessage??null,runtimeErrorToolStage:task.webTimings?.runtimeErrorToolStage??task.runtimeErrorToolStage??null,ownedTabId:task.ownedTabId||null,sessionName:task.sessionName||null,ownedTabState:task.ownedTabState||task.webTimings?.ownedTabState||null,cleanupStatus:task.cleanupStatus||task.webTimings?.cleanupStatus||null,cleanupVerifiedAt:task.cleanupVerifiedAt||task.webTimings?.cleanupVerifiedAt||null,cleanupError:task.cleanupError||task.webTimings?.cleanupError||null,kernelReset:task.kernelReset===true||task.webTimings?.kernelReset===true,role:task.role||null,creativeModel:task.creativeModel||null,creativeReasoningEffort:task.creativeReasoningEffort||null,executorModel:task.executorModel||null,executorReasoningEffort:task.executorReasoningEffort||null,revisionBase:task.revisionBase||null}:null;
  const {pending,history=[],samples=[],panels={},pages=[],bundle,artifacts:ignoredArtifacts,tasks:ignoredTasks,currentTask,previewDecisionCommands:ignoredCommands,panelDecisionCommands:ignoredPanelCommands,...safe}=p;
  void ignoredArtifacts;void ignoredTasks;void ignoredCommands;void ignoredPanelCommands;
  const retryState=imageRetryState(p);
  const webEvidence=pendingWebEvidence(p,pending),webManifest=webEvidence?.identityMatches?webEvidence.manifest:null,uploadEvidence=webEvidence?.identityMatches?webEvidence.uploadEvidence:null;
  const publicPending=pending?{key:pending.key,at:pending.at,taskId:pending.taskId,provider:pending.provider||null,webState:webManifest?.state||null,requestId:webManifest?.requestId||null,accepted:webManifest?.accepted===true,acceptedAt:webManifest?.acceptedAt||null,readyAt:webManifest?.readyAt||null,submitted:webManifest?.submitted===true,submittedAt:webManifest?.submittedAt||null,downloadedAt:webManifest?.downloadedAt||null,errorCode:webManifest?.errorCode||null,executorExecutionState:webManifest?.executorExecutionState||null,artifactAcceptanceState:webManifest?.artifactAcceptanceState||null,recoveryNotice:webManifest?.recoveryNotice||null,attachmentExpectedCount:Number.isInteger(Number(webManifest?.attachmentExpectedCount))?Number(webManifest.attachmentExpectedCount):uploadEvidence?.attachmentExpected??null,attachmentObservedCount:Number.isInteger(Number(webManifest?.attachmentObservedCount))?Number(webManifest.attachmentObservedCount):uploadEvidence?.attachmentObserved??null,attachmentPending:webManifest?.attachmentPending??uploadEvidence?.attachmentPending??null,sendEnabled:webManifest?.sendEnabled??uploadEvidence?.sendEnabled??null,failureStage:webManifest?.failureStage||null,browserStage:webManifest?.browserStage||null,runtimeErrorCategory:webManifest?.runtimeErrorCategory||null,runtimeErrorMessage:webManifest?.runtimeErrorMessage||null,runtimeErrorToolStage:webManifest?.runtimeErrorToolStage||null,ownedTabId:webManifest?.ownedTabId||null,sessionName:webManifest?.sessionName||null,ownedTabState:webManifest?.ownedTabState||null,cleanupStatus:webManifest?.cleanupStatus||webManifest?.ownedTabCleanupStatus||null,cleanupVerifiedAt:webManifest?.cleanupVerifiedAt||null,cleanupError:webManifest?.cleanupError||null,kernelReset:webManifest?.kernelReset===true}:null;
  const baseTask=publicTask(currentTask),lateTerminal=Boolean(baseTask&&webEvidence?.identityMatches&&currentTask.id===pending?.taskId&&['failed','downloaded'].includes(webManifest?.state));
  const terminalManifest=!pending?terminalTaskWebManifest(p,currentTask,safe.lastFailure):null;
  const terminalManifestMatchesFailure=Boolean(terminalManifest?.state==='failed'&&terminalManifest.submitted===false&&currentTask?.status==='failed_no_output'&&safe.lastFailure?.key===currentTask.target&&(!safe.lastFailure?.taskId||safe.lastFailure.taskId===currentTask.id));
  const terminalLifecycle=terminalManifest?{ownedTabId:terminalManifest.ownedTabId||null,sessionName:terminalManifest.sessionName||null,ownedTabState:terminalManifest.ownedTabState||null,cleanupStatus:terminalManifest.cleanupStatus||terminalManifest.ownedTabCleanupStatus||null,cleanupVerifiedAt:terminalManifest.cleanupVerifiedAt||null,cleanupError:terminalManifest.cleanupError||null,kernelReset:terminalManifest.kernelReset===true}:{};
  const terminalCode=terminalManifest?.errorCode==='CHATGPT_LOGIN_REQUIRED'?'chatgpt-login-required':terminalManifest?.errorCode==='BROWSER_HANDLE_LOST'?'browser-handle-lost':terminalManifest?.errorCode==='OWNED_TAB_STAGE_WRITE_FAILED'?'owned-tab-stage-write-failed':null;
  const effectiveTask=lateTerminal?{...baseTask,status:webManifest.state==='failed'?'failed':'artifact_saved',errorCode:webManifest.errorCode||baseTask.errorCode,webState:webManifest.state}:baseTask&&terminalManifest?{...baseTask,...terminalLifecycle,...(terminalCode?{errorCode:terminalCode}:{}),webState:terminalManifest.state}:baseTask;
  const terminalFailureText=terminalManifestMatchesFailure&&terminalCode==='chatgpt-login-required'?'请在 Chrome 登录 ChatGPT。登录后可手动只重试这一张；本次附件上传 0、发送 0。系统不会自动登录、自动重试或创建新请求，上一版原图仍保留。':terminalManifestMatchesFailure&&['browser-handle-lost','owned-tab-stage-write-failed'].includes(terminalCode)?`专用标签页创建后，本地执行流程未能继续；本次附件上传 0、发送 0。${terminalManifest.ownedTabState==='closed_verified'||terminalManifest.cleanupStatus==='closed'?'本次专用标签页已确认关闭。':'专用标签页关闭状态尚未确认。'}`:null;
  const effectiveLastFailure=terminalManifestMatchesFailure?{...safe.lastFailure,...terminalLifecycle,...(terminalFailureText?{message:terminalFailureText}:{})}:safe.lastFailure;
  return {...safe,...(terminalManifestMatchesFailure?{message:terminalFailureText||safe.message,error:terminalFailureText||safe.error,lastFailure:effectiveLastFailure}:{}),pending:publicPending,currentTask:effectiveTask,imageRetry:retryState?{certainty:retryState.certainty,target:retryState.target}:null,history:history.map(h=>({version:h.version,title:h.plan.title,at:h.approved?.at,plan:h.plan,pages:(h.pages||[]).map(q=>publicImage(q,`page:${q.number}`))})),
    planHash:p.plan?digest(p.plan):null,busy:active.has(p.id),
    samples:samples.map((sample,index)=>publicImage(sample,`image:样张-${index+1}`)),
    panels:Object.fromEntries(Object.entries(panels).map(([key,panel])=>[key,publicImage(panel,`image:第${key.split('-')[0]}页-第${key.split('-')[1]}格`)])),
    pages:pages.map(page=>publicImage(page,`page:${page.number}`)),bundleURL:media(bundle),outputFolder:p.accepted?'作品已保存到本地作品文件夹':null,
    artifacts:artifacts.map(({file:_file,...artifact})=>artifact)};
}
function allowedProjectFiles(p){
  return new Set([...p.samples.filter(Boolean).map(x=>x.file),...Object.values(p.panels).map(x=>x.file),...p.pages.flatMap(x=>[x.file,x.finalFile]),p.bundle,
    ...p.history.flatMap(h=>[...h.samples.filter(Boolean).map(x=>x.file),...Object.values(h.panels).map(x=>x.file),...h.pages.flatMap(x=>[x.file,x.finalFile])])].filter(Boolean));
}
async function body(req,max=250000){let b='';for await(const c of req){b+=c;if(Buffer.byteLength(b)>max){throw new Error('内容太长，请缩短后再提交。');}}try{return JSON.parse(b||'{}');}catch{throw new Error('提交内容无效');}}
function chooseModel(snapshot,id,effort){const model=snapshot.models.find(m=>m.id===id)||snapshot.models.find(m=>m.isDefault)||snapshot.models[0];if(!model)throw new Error('当前没有可用的创作模型。');const reasoning=model.reasoningEfforts.includes(effort)?effort:model.defaultReasoningEffort;return {model:model.id,reasoningEffort:reasoning};}
function projectSource(p,kind,key){let rel;if(kind==='page')rel=p.pages.find(x=>String(x.number)===String(key))?.finalFile||p.pages.find(x=>String(x.number)===String(key))?.file;else if(kind==='panel')rel=p.panels[key]?.file;else if(kind==='sample')rel=p.samples[Number(key)]?.file;if(!rel||!allowedProjectFiles(p).has(rel))throw new Error('这张作品图片不存在。');return inside(projectDir(p.id),rel);}
function revisionConflict(p,expectedRevision){const error=new Error(`作品已更新（当前版本 ${p.revision}），请刷新后再提交这次决定。`);error.statusCode=409;error.code='REVISION_CONFLICT';error.currentRevision=p.revision;error.expectedRevision=expectedRevision;return error;}
function previewFingerprint(input){return digest({planHash:input.planHash,artifactId:input.artifactId,contentHash:input.contentHash,decision:input.decision,acknowledgedIssueIds:input.acknowledgedIssueIds,continueProduction:input.continueProduction});}
function duplicatePreviewDecision(p,b){
  const key=String(b.idempotencyKey||'').trim();if(!key)return null;
  const existing=(Array.isArray(p.previewDecisionCommands)?p.previewDecisionCommands:[]).find(record=>record.key===key);if(!existing)return null;
  const candidate=previewFingerprint({planHash:String(b.planHash||''),artifactId:String(b.artifactId||''),contentHash:String(b.contentHash||''),decision:String(b.decision||''),acknowledgedIssueIds:Array.isArray(b.acknowledgedIssueIds)?[...new Set(b.acknowledgedIssueIds.map(String).filter(Boolean))]:[],continueProduction:b.continueProduction===true});
  if(existing.fingerprint!==candidate)throw new Error('这次决定的防重复标识已经用于另一项操作，请刷新后重试。');
  return {key,existing};
}
function previewDecisionInput(p,b){
  if(!Object.prototype.hasOwnProperty.call(b,'expectedRevision')||!Number.isInteger(Number(b.expectedRevision)))throw new Error('缺少当前作品版本，请刷新页面后再决定。');
  const expectedRevision=Number(b.expectedRevision);if(expectedRevision!==Number(p.revision))throw revisionConflict(p,expectedRevision);
  const planHash=String(b.planHash||'');if(!planHash||planHash!==p.approved?.hash)throw new Error('方案已更新，请重新查看当前样张后再决定。');
  if(p.status!=='samples_decision')throw new Error('当前没有等待你决定的样张。');
  const artifactId=String(b.artifactId||'');const sampleMatch=/^image:样张-([12])(?:-|$)/.exec(artifactId);
  if(!sampleMatch)throw new Error('当前只能对人物或场景样张作出决定。');
  const sampleIndex=Number(sampleMatch[1]),sample=p.samples?.[sampleIndex-1];if(!sample)throw new Error('对应样张已经更新，请刷新后再决定。');
  const artifact=(p.artifacts||[]).find(item=>item.id===artifactId)||null;
  const actualContentHash=digest({artifactId,file:artifact?.file||sample.file,at:sample.at||artifact?.at||null});
  if(String(b.contentHash||'')!==actualContentHash)throw new Error('样张内容已更新，请重新查看后再决定。');
  const decision=String(b.decision||'');if(!['accept_current','regenerate_current'].includes(decision))throw new Error('请选择采用当前样张或重新生成当前样张。');
  const acknowledgedIssueIds=Array.isArray(b.acknowledgedIssueIds)?[...new Set(b.acknowledgedIssueIds.map(String).filter(Boolean))]:[];
  const requiredIssueIds=(sample.qa?.issueDetails||[]).filter(issue=>['blocking','review'].includes(issue.severity)).map(issue=>String(issue.id)).filter(Boolean);
  if(decision==='accept_current'&&requiredIssueIds.some(id=>!acknowledgedIssueIds.includes(id)))throw new Error('请先确认样张中列出的待注意问题，再采用当前样张。');
  const idempotencyKey=String(b.idempotencyKey||'').trim();if(!idempotencyKey||idempotencyKey.length>200)throw new Error('缺少本次决定的防重复标识，请刷新后再试。');
  return {expectedRevision,planHash,artifactId,contentHash:actualContentHash,decision,acknowledgedIssueIds,continueProduction:b.continueProduction===true,idempotencyKey,sampleIndex};
}
function savedPreviewDecision(p,input){
  const fingerprint=previewFingerprint(input);
  const records=Array.isArray(p.previewDecisionCommands)?p.previewDecisionCommands:[];
  const existing=records.find(record=>record.key===input.idempotencyKey);
  if(existing){if(existing.fingerprint!==fingerprint)throw new Error('这次决定的防重复标识已经用于另一项操作，请刷新后重试。');return {existing,fingerprint};}
  return {existing:null,fingerprint};
}
function panelArtifactId(key){const match=/^(\d+)-(\d+)$/.exec(String(key));return match?`image:第${match[1]}页-第${match[2]}格`:null;}
function panelDecisionFingerprint(input){return digest({planHash:input.planHash,panelKey:input.panelKey,artifactId:input.artifactId,contentHash:input.contentHash,decision:input.decision,acknowledgedIssueIds:input.acknowledgedIssueIds,continueProduction:input.continueProduction});}
function duplicatePanelDecision(p,b){
  const key=String(b.idempotencyKey||'').trim();if(!key)return null;
  const existing=(Array.isArray(p.panelDecisionCommands)?p.panelDecisionCommands:[]).find(record=>record.key===key);if(!existing)return null;
  const candidate=panelDecisionFingerprint({planHash:String(b.planHash||''),panelKey:String(b.panelKey||''),artifactId:String(b.artifactId||''),contentHash:String(b.contentHash||''),decision:String(b.decision||''),acknowledgedIssueIds:Array.isArray(b.acknowledgedIssueIds)?[...new Set(b.acknowledgedIssueIds.map(String).filter(Boolean))]:[],continueProduction:b.continueProduction===true});
  if(existing.fingerprint!==candidate)throw new Error('这次决定的防重复标识已经用于另一项操作，请刷新后重试。');
  return {key,existing};
}
function panelDecisionInput(p,b){
  if(!Object.prototype.hasOwnProperty.call(b,'expectedRevision')||!Number.isInteger(Number(b.expectedRevision)))throw new Error('缺少当前作品版本，请刷新页面后再决定。');
  const expectedRevision=Number(b.expectedRevision);if(expectedRevision!==Number(p.revision))throw revisionConflict(p,expectedRevision);
  const planHash=String(b.planHash||'');if(!planHash||planHash!==p.approved?.hash)throw new Error('方案已更新，请重新查看当前分镜后再决定。');
  if(!['attention','paused'].includes(p.status)||p.panelDecision?.state!=='required')throw new Error('当前没有等待你决定的正式分镜。');
  const panelKey=String(b.panelKey||''),artifactId=panelArtifactId(panelKey),record=p.panels?.[panelKey];if(!artifactId||!record)throw new Error('对应正式分镜已经更新，请刷新后再决定。');
  if(record.qa?.pass!==false||record.userDecision?.action==='accept_current'||p.panelDecision.panelKey!==panelKey)throw new Error('对应正式分镜已经更新，请刷新后再决定。');
  if(String(b.artifactId||'')!==artifactId)throw new Error('当前图片已经过期，请重新查看后再决定。');
  const artifact=(p.artifacts||[]).find(item=>item.id===artifactId);if(!artifact||artifact.file!==record.file||artifact.valid===false)throw new Error('当前图片已经过期，请重新查看后再决定。');
  const actualContentHash=digest({artifactId,file:record.file,at:record.at||artifact.at||null});if(String(b.contentHash||'')!==actualContentHash)throw new Error('当前图片内容已经更新，请重新查看后再决定。');
  const decision=String(b.decision||'');if(decision!=='accept_current')throw new Error('请选择采用当前图片或修改这一张。');
  const acknowledgedIssueIds=Array.isArray(b.acknowledgedIssueIds)?[...new Set(b.acknowledgedIssueIds.map(String).filter(Boolean))]:[],requiredIssueIds=(record.qa.issueDetails||[]).filter(issue=>['blocking','review'].includes(issue.severity)).map(issue=>String(issue.id)).filter(Boolean);if(requiredIssueIds.some(id=>!acknowledgedIssueIds.includes(id)))throw new Error('请先确认正式分镜中列出的待注意问题，再采用当前图片。');
  const idempotencyKey=String(b.idempotencyKey||'').trim();if(!idempotencyKey||idempotencyKey.length>200)throw new Error('缺少本次决定的防重复标识，请刷新后再试。');
  return {expectedRevision,planHash,panelKey,artifactId,contentHash:actualContentHash,decision,acknowledgedIssueIds,continueProduction:b.continueProduction===true,idempotencyKey};
}
function retryCommand(p,b){
  const key=String(b.idempotencyKey||'').trim();
  if(!key||key.length>200)throw new Error('缺少本次重试的防重复标识，请刷新页面后再试。');
  const records=Array.isArray(p.retryCommands)?p.retryCommands:[];
  const existing=records.find(record=>record.key===key);
  const target=existing?.target||imageRetryState(p)?.target||'';
  const fingerprint=digest({target,confirmNoImage:b.confirmNoImage===true,confirmUnknownResult:b.confirmUnknownResult===true});
  if(existing){if(existing.fingerprint!==fingerprint)throw new Error('这次重试标识已经用于另一张图片，请刷新后重试。');return {key,target,existing};}
  return {key,target,fingerprint,existing:null};
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  const host=req.headers.host;
  if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`,`127.0.0.1:5173`,`localhost:5173`].includes(host))return send(res,{error:'仅限本机访问'},403);
  let url;try{url=new URL(req.url,`http://${host}`);}catch{return send(res,{error:'地址无效'},400);}
  try {
    if(!['GET','POST'].includes(req.method))return send(res,{error:'不支持的操作'},405);
    if(req.method==='POST'){
      const origin=req.headers.origin;const allowed=[`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`,'http://127.0.0.1:5173','http://localhost:5173'];
      if(req.headers['x-wendi-request']!=='studio'||!String(req.headers['content-type']).startsWith('application/json')||(origin&&!allowed.includes(origin)))return send(res,{error:'请从本地创作室提交'},403);
    }
    if(url.pathname==='/api/health')return send(res,{app:'wendi-studio',ready:true,connection:connectionSnapshot(),version:'2.2.0',instanceId:INSTANCE_ID});
    if(url.pathname==='/api/restart'&&req.method==='POST'){
      if(restartRequested){const error=new Error('创作室已经在重启，请稍候。');error.statusCode=409;throw error;}
      if(active.size){const error=new Error('还有制作任务正在运行，请先暂停并等待当前步骤保存完成。');error.statusCode=409;throw error;}
      restartRequested=true;send(res,{ok:true,status:'restarting',previousInstanceId:INSTANCE_ID,retryAfterMs:700},202);
      if(process.env.WENDI_TEST_RESTART_NOOP!=='1')setTimeout(()=>{
        const child=spawn(process.execPath,[path.join(APP,'launch.mjs')],{cwd:APP,env:{...process.env,WENDI_PORT:String(PORT),WENDI_NO_OPEN:'1'},stdio:'ignore',detached:true});child.unref();
      },120).unref();
      return;
    }
    if(url.pathname==='/api/bootstrap'){
      const snapshot=await account();const assets=publicAssets();const stories=discoverArchiveStories().map(s=>({...s,coverUrl:`/media/archive-story/${s.id}/0`,pages:s.pages.map((_,i)=>({index:i,url:`/media/archive-story/${s.id}/${i}`}))}));
      return send(res,{connection:connectionSnapshot(),checks:CHECKS,projects:listProjects().map(publicProject),account:snapshot,categories:CATEGORIES,documents:listDocuments(),assets,references:assets.filter(x=>!x.file.startsWith('02-')),archiveStories:stories,hero:stories[0]?.coverUrl||assets[0]?.url});
    }
    if(url.pathname==='/api/account'&&req.method==='POST')return send(res,await account(true));
    if(url.pathname==='/api/connection'&&req.method==='POST'){connection=await connectionStatus();return send(res,connectionSnapshot());}
    if(url.pathname==='/api/projects'&&req.method==='POST'){const b=await body(req),selected=chooseModel(await account(),b.model,b.reasoningEffort);const p=createProject({...b,...selected});planProject(p);return send(res,publicProject(p),201);}
    // The staged-upload route only validates local bytes and keeps the temporary
    // candidate outside the visible library. It intentionally does not select a
    // model or call the analysis workflow.
    if(url.pathname==='/api/assets/stage'&&req.method==='POST'){const candidate=await stageUpload(await body(req,30000000));return send(res,{candidate});}
    const candidateMatch=/^\/api\/assets\/candidates\/([a-f0-9-]{36})$/.exec(url.pathname);
    if(candidateMatch&&req.method==='GET'){return send(res,{candidate:await inspectStagedCandidate(candidateMatch[1])});}
    // Saving a manually classified candidate is local-only. `saveManualAsset`
    // rechecks the content hash, so an existing image is returned without a
    // second copy or another index entry.
    if(url.pathname==='/api/assets/manual-save'&&req.method==='POST'){
      const b=await body(req),result=await saveManualAsset({candidateId:b.candidateId,category:b.category,name:b.name,tags:b.tags,description:b.description,usage:b.usage,sourceLabel:b.sourceLabel});
      return send(res,{...result,asset:result.asset?publicAsset(result.asset):null,assets:publicAssets()});
    }
    if(url.pathname==='/api/assets/search'&&req.method==='GET'){
      const values=(single,plural)=>[...url.searchParams.getAll(single),...url.searchParams.getAll(plural)].flatMap(value=>value.split(',')).map(value=>value.trim()).filter(Boolean);
      const assets=searchAssets({query:url.searchParams.get('query')||'',categories:values('category','categories'),usages:values('usage','usages'),tags:values('tag','tags')});
      return send(res,{assets:publicAssets(assets),total:assets.length});
    }
    if(url.pathname==='/api/assets/upload'&&req.method==='POST'){const b=await body(req,30000000),candidate=await stageUpload(b),meta=readCandidate(candidate.id),selected=chooseModel(await account(),b.model,b.reasoningEffort);const proposal=await analyzeAsset({file:meta.file,sourceLabel:'用户手动上传：'+meta.name,dir:path.join(APP,'.素材候选',candidate.id,'分析'),...selected});return send(res,{candidate,proposal:saveAssetProposal(proposal)});}
    if(url.pathname==='/api/assets/analyze'&&req.method==='POST'){const b=await body(req),p=readProject(b.projectId),source=projectSource(p,b.kind,b.key),selected=chooseModel(await account(),b.model,b.reasoningEffort);const proposal=await analyzeAsset({file:source,sourceLabel:`作品《${p.title}》${b.kind} ${b.key}`,dir:path.join(projectDir(p.id),'.制作记录',`素材分析-${Date.now()}`),...selected});return send(res,{proposal:saveAssetProposal(proposal)});}
    if(url.pathname==='/api/assets/apply'&&req.method==='POST'){const b=await body(req);const result=applyAssetProposal({proposalId:b.proposalId,applyWorld:b.applyWorld===true,applyWorkflow:b.applyWorkflow===true});return send(res,{...result,asset:result.asset?publicAsset(result.asset):null,assets:publicAssets()});}
    if(url.pathname==='/api/documents/suggest'&&req.method==='POST'){const b=await body(req),selected=chooseModel(await account(),b.model,b.reasoningEffort);return send(res,await suggestDocument({docPath:b.docPath,note:b.note,dir:path.join(APP,'.文档提案',`${Date.now()}`),...selected}));}
    if(url.pathname==='/api/documents/save'&&req.method==='POST'){const result=saveDocument(await body(req));return send(res,{...result,documents:listDocuments()});}
    if(url.pathname==='/api/storage/report'&&req.method==='GET'){
      const projectId=String(url.searchParams.get('projectId')||''),p=readProject(projectId);
      return send(res,{storage:reportProjectStorage(projectDir(p.id))});
    }
    if(url.pathname==='/api/storage/cleanup'&&req.method==='POST'){
      const b=await body(req),p=readProject(b.projectId),storage=applyProjectStorageCleanup(projectDir(p.id),{apply:b.apply===true,report:b.report||null});
      return send(res,{storage});
    }
    if(url.pathname==='/api/storage/downloads-report'&&req.method==='GET'){
      const projectId=String(url.searchParams.get('projectId')||''),p=readProject(projectId),downloadsDir=process.env.WENDI_DOWNLOADS_DIR||path.join(process.env.HOME||'/Users/wuwendi','Downloads');
      return send(res,{downloads:reportDownloadsRedundancy({downloadsDir,projectRoot:projectDir(p.id)})});
    }
    const failureClassificationMatch=/^\/api\/projects\/([a-f0-9-]{36})\/failure-classification$/.exec(url.pathname);
    if(failureClassificationMatch&&req.method==='GET'){
      const p=readProject(failureClassificationMatch[1]),pending=p.pending;
      if(!pending?.dir)return send(res,{category:'other',needsHuman:true,classifierSource:'fallback',model:null,confidence:null,probabilities:null,latencyMs:0,cacheHit:false,evidence:{submitted:false,submissionUncertain:false,hasReferences:false,attachmentExpectedKnown:false,attachmentObservedKnown:false,attachmentPending:false,sendEnabled:false,structuredFailureStage:false}});
      const manifest=readWebManifest(path.join(pending.dir,'web-generation.json'))||{};
      const uploadEvidence=readJson(path.join(pending.dir,'upload-evidence.json'))||{};
      const result=await classifyFailure({
        errorCode:manifest.errorCode||null,
        error:manifest.error||null,
        stage:manifest.ownedTabState||null,
        failureStage:uploadEvidence.failureStage||manifest.failureStage||null,
        submitted:manifest.submitted===true,
        submissionUncertain:manifest.submissionUncertain===true,
        referenceCount:Number(manifest.referenceCount),
        attachmentExpected:uploadEvidence.attachmentExpected,
        attachmentObserved:uploadEvidence.attachmentObserved,
        attachmentPending:uploadEvidence.attachmentPending,
        sendEnabled:uploadEvidence.sendEnabled,
      });
      writeFailureClassification(pending.dir,result);
      return send(res,result);
    }
    const archiveDelete=/^\/api\/archive\/([A-Za-z0-9_-]+)\/delete$/.exec(url.pathname);if(archiveDelete&&req.method==='POST'){const b=await body(req);deleteArchiveStory(archiveDelete[1],b.confirmTitle);return send(res,{ok:true,archiveStories:discoverArchiveStories()});}
    const match=/^\/api\/projects\/([a-f0-9-]{36})(?:\/([a-z-]+))?$/.exec(url.pathname);
    if(match){
      const p=readProject(match[1]);const action=match[2];if(req.method==='GET'&&!action)return send(res,publicProject(p));
      if(req.method!=='POST'||!action)return send(res,{error:'操作不存在'},404);
      const b=await body(req);
      if(action==='pause'){active.get(p.id)?.abort();return send(res,{ok:true});}
      if(action==='title'){
        const title=String(b.title||'').trim().replace(/\s+/g,' ');
        if(!title||Array.from(title).length>60)throw new Error('作品名称请控制在 1—60 个字以内。');
        p.title=title;p.titleLocked=true;syncRunningProject(p.id,{title,titleLocked:true});saveProject(p);return send(res,publicProject(p));
      }
      if(action==='preview-decision'){
        const duplicate=duplicatePreviewDecision(p,b);
        // A duplicate click is expected in a slow local UI. Return the latest
        // persisted state before looking at active work, so it can never launch
        // a second paid generation request.
        if(duplicate)return send(res,{...publicProject(p),idempotent:true,command:{key:duplicate.key,acceptedAt:duplicate.existing.at}});
        const input=previewDecisionInput(p,b),saved=savedPreviewDecision(p,input);
        p.previewDecisionCommands=Array.isArray(p.previewDecisionCommands)?p.previewDecisionCommands:[];
        p.previewDecisionCommands.push({key:input.idempotencyKey,fingerprint:saved.fingerprint,at:new Date().toISOString(),revision:p.revision,artifactId:input.artifactId,decision:input.decision,acknowledgedIssueIds:input.acknowledgedIssueIds,continueProduction:input.continueProduction});
        p.previewDecisionCommands=p.previewDecisionCommands.slice(-80);saveProject(p);
        try{decideSamples(p,{action:input.decision,sampleIndex:input.sampleIndex,hash:input.planHash});}
        catch(error){p.previewDecisionCommands=p.previewDecisionCommands.filter(record=>record.key!==input.idempotencyKey);saveProject(p);throw error;}
        return send(res,{...publicProject(p),idempotent:false,command:{key:input.idempotencyKey,acceptedAt:new Date().toISOString(),continueProduction:input.continueProduction}});
      }
      if(action==='panel-decision'){
        const duplicate=duplicatePanelDecision(p,b);if(duplicate)return send(res,{...publicProject(p),idempotent:true,command:{key:duplicate.key,acceptedAt:duplicate.existing.at}});
        const input=panelDecisionInput(p,b),fingerprint=panelDecisionFingerprint(input);p.panelDecisionCommands=Array.isArray(p.panelDecisionCommands)?p.panelDecisionCommands:[];p.panelDecisionCommands.push({key:input.idempotencyKey,fingerprint,at:new Date().toISOString(),revision:p.revision,panelKey:input.panelKey,artifactId:input.artifactId,decision:input.decision,acknowledgedIssueIds:input.acknowledgedIssueIds,continueProduction:input.continueProduction});p.panelDecisionCommands=p.panelDecisionCommands.slice(-80);saveProject(p);
        try{const {expectedRevision:_expectedRevision,...decisionInput}=input;void _expectedRevision;await decidePanel(p,{...decisionInput,key:input.panelKey,action:input.decision});}catch(error){const latest=readProject(p.id);latest.panelDecisionCommands=(latest.panelDecisionCommands||[]).filter(record=>record.key!==input.idempotencyKey);saveProject(latest);throw error;}
        return send(res,{...publicProject(p),idempotent:false,command:{key:input.idempotencyKey,acceptedAt:new Date().toISOString(),continueProduction:input.continueProduction}});
      }
      if(['reject-panel','panel-review','manual-panel-review'].includes(action)){
        const commandKey=String(b.idempotencyKey||'manual-panel-review:'+p.id+':'+String(b.panelKey||b.key||b.target||'')),duplicate=(p.panelReviewCommands||[]).find(item=>item.key===commandKey);
        rejectPanel(p,b);
        return send(res,{...publicProject(p),idempotent:Boolean(duplicate),command:{key:commandKey,acceptedAt:duplicate?.at||new Date().toISOString()}});
      }
      if(action==='retry-missing'){
        const command=retryCommand(p,b);
        // If the response was lost, returning the persisted state is safer than
        // re-entering the workflow and possibly spending another image request.
        if(command.existing)return send(res,{...publicProject(p),idempotent:true,command:{key:command.key,acceptedAt:command.existing.at}});
        if(active.has(p.id)||hasLiveWork(p.id))throw new Error('这篇仍在制作或等待执行，请稍候。');
        const retryState=imageRetryState(p),confirmed=retryState?.certainty==='confirmed_missing'&&b.confirmNoImage===true,unknownApproved=retryState?.certainty==='unknown_result'&&b.confirmUnknownResult===true;
        if(!retryState||retryState.target!==command.target||(!confirmed&&!unknownApproved))throw new Error(retryState?.certainty==='unknown_result'?'请明确确认仍要重新生成这张结果未知的图片。':'请先确认没有生成图片。');
        p.retryCommands=Array.isArray(p.retryCommands)?p.retryCommands:[];
        const decision=unknownApproved?'retry_unknown_result':'confirmed_missing';
        p.retryCommands.push({key:command.key,fingerprint:command.fingerprint,target:command.target,decision,at:new Date().toISOString()});p.retryCommands=p.retryCommands.slice(-80);
        p.revisionNotes.push({key:command.target||'当前图片',note:unknownApproved?'用户知晓结果仍无法确认，明确允许只重新生成这一张':'用户确认本次没有取得图片，允许只重新生成这一张',at:new Date().toISOString()});saveProject(p);
        try{retryMissingImage(p,command.target,{allowUnknownResult:unknownApproved});}catch(error){p.retryCommands=p.retryCommands.filter(record=>record.key!==command.key);saveProject(p);throw error;}
        return send(res,{...publicProject(p),idempotent:false,command:{key:command.key,acceptedAt:new Date().toISOString()}});
      }
      if(active.has(p.id))throw new Error('这篇仍在制作，请稍候。');
      if(action==='revise-plan')planProject(p,b.note);
      else if(action==='approve-plan')approvePlan(p,b.hash);
      else if(action==='approve-samples')approveSamples(p,b.hash);
      else if(action==='resume')resume(p);
      else if(action==='revise-image')reviseImage(p,b.key,b.note,{baseFile:b.baseFile,basePath:b.basePath,baseArtifactId:b.baseArtifactId});
      else if(action==='repair-page-layout')repairPageLayout(p,b.pageNumber);
      else if(action==='confirm-page-layout')await confirmPageLayout(p,{pageNumber:b.pageNumber,projectVersion:b.projectVersion,contentHash:b.contentHash});
      else if(action==='review-page')reviewPage(p,b.pageNumber);
      else if(action==='unify-page-layouts')unifyPageLayouts(p);
      else if(action==='recover-image')recoverImage(p);
      else if(action==='recover-native-download')await adoptNativeDownload(p,{dir:p.pending?.dir,file:p.pending?.file,target:p.pending?.key,evidenceFile:b.evidenceFile});
      else if(action==='review-image')reviewImage(p,b.key);
      else if(action==='accept')await accept(p,b.checks);
      else if(action==='settings'){
        if(p.status==='complete')throw new Error('已完成作品不需要切换制作模型。');
        const selected=chooseModel(await account(true),b.model,b.reasoningEffort),before={model:p.brief.model||null,reasoningEffort:p.brief.reasoningEffort||null};
        p.brief.model=selected.model;p.brief.reasoningEffort=selected.reasoningEffort;syncRunningProject(p.id,{brief:{...p.brief}});p.modelHistory=p.modelHistory||[];
        p.modelHistory.push({from:before,to:selected,at:new Date().toISOString(),status:p.status,version:p.version});
        p.message=`后续步骤将使用 ${selected.model} · ${selected.reasoningEffort} 思考；已有方案和图片保持不变。`;saveProject(p);
      }
      else if(action==='delete'){
        if(!p.accepted||p.status!=='complete')throw new Error('只有已完成作品可以删除。');deleteProjectFolder(projectDir(p.id),p.title,b.confirmTitle);return send(res,{ok:true});
      }
      else if(action==='open-folder'){
        const folder=p.accepted?path.join(projectDir(p.id),`v${p.version}`,'成品'):projectDir(p.id);
        await new Promise((resolve,reject)=>execFile('/usr/bin/open',[folder],err=>err?reject(new Error('无法打开文件夹，请使用页面上的本地路径。')):resolve()));
      }
      else return send(res,{error:'操作不存在'},404);
      return send(res,publicProject(p));
    }
    if(url.pathname.startsWith('/media/reference/')){
      const ref=decodeURIComponent(url.pathname.slice('/media/reference/'.length));
      if(!listAssets().some(x=>x.file===ref&&!x.file.startsWith('02-')))return send(res,{error:'参考不可用'},404);
      return file(res,inside(REFS,ref));
    }
    if(url.pathname.startsWith('/media/asset/')){
      const ref=decodeURIComponent(url.pathname.slice('/media/asset/'.length));
      if(!listAssets().some(x=>x.file===ref))return send(res,{error:'素材不可用'},404);
      return file(res,inside(REFS,ref));
    }
    const archiveMedia=/^\/media\/archive-story\/([A-Za-z0-9_-]+)\/(\d+)$/.exec(url.pathname);if(archiveMedia){const story=archiveStory(archiveMedia[1]),index=Number(archiveMedia[2]);if(!story||!story.pages[index])return send(res,{error:'图片不存在'},404);return file(res,inside(path.join(ROOT,story.folder),story.pages[index]));}
    const media=/^\/media\/project\/([a-f0-9-]{36})\/(.+)$/.exec(url.pathname);
    if(media){const p=readProject(media[1]);const name=decodeURIComponent(media[2]);if(!allowedProjectFiles(p).has(name))return send(res,{error:'图片尚未就绪'},404);return file(res,inside(projectDir(p.id),name),url.searchParams.has('download'));}
    if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/'))return send(res,{error:'内容不存在'},404);
    const filename=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
    const target=inside(front,filename);if(!fs.existsSync(target))return send(res,{error:'页面不存在'},404);return file(res,target);
  }catch(e){if(!res.headersSent)send(res,{error:e.message||'操作未完成',code:e.code||null,currentRevision:e.currentRevision??null},Number(e.statusCode)||400);else res.end();}
});
server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'创作室端口已被使用，请打开已有页面。':err.message);process.exit(1);});
server.listen(PORT,HOST,()=>console.log(`温蒂创作室：http://${HOST}:${PORT}`));
let shuttingDown=false;
function shutdown(){
  if(shuttingDown)return;shuttingDown=true;
  for(const c of active.values())c.abort();
  server.close();
  const deadline=Date.now()+5000;
  const finish=()=>{if(active.size===0||Date.now()>=deadline)process.exit(0);setTimeout(finish,100).unref();};
  finish();
}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,shutdown);
