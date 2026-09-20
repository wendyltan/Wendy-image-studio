import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {runCodex,findCodex} from './bridge.mjs';
import {identityFields,sameIdentityValue,readJsonObject as readRunJson,readRunIdentity,compareRunIdentity} from './run-identity.mjs';
import {patchManifest} from './run-manifest.mjs';
import {chatGptWebImagePrompt} from './web-executor-instructions.mjs';
import {browserFailurePrefix,browserPreSubmissionUnavailableText,browserRunEvidenceText,structuredBrowserToolResultText,browserOriginPermissionDeniedEvidence,fileUploadChromeUnavailableEvidence,iabUnavailableEvidence,browserTabBackgroundEvidence,chromeUnavailableEvidence,browserFocusEvidence,completeDownloadEvidence,extractDownloadEvidence,inspectDownloadArtifact,readDownloadEvidence,validateDownloadEvidence,writeDownloadEvidence} from './web-download-evidence.mjs';
// Keep the durable provider id for existing project records. The production
// transport is direct Chrome; older IAB manifests remain readable for
// recovery, but IAB is never a fallback for a new request.
export const WEB_IMAGE_PROVIDER='chatgpt-web-iab';
export const WEB_IMAGE_TRANSPORT='direct-chrome';
export const WEB_IMAGE_BROWSER='chrome';
// Browser execution is a mechanical upload/send/download step after the
// creative prompt has already been frozen. Keep it observable and cheap; the
// creator's selected model and effort remain unchanged for planning and QA.
export const WEB_IMAGE_EXECUTOR_ROLE='browser-executor';
export const WEB_IMAGE_EXECUTOR_EFFORT='low';
// The public CUA surface currently cannot activate a tab/window or restore a
// previously-focused tab. Keep this explicit: creating the owned tab may
// briefly take focus, and the worker must never claim a background guarantee.
export const WEB_IMAGE_FOCUS_POLICY='may-focus-at-create-without-public-focus-api';
const REQUEST_ID=/^[a-f0-9-]{36}$/;
const MANIFEST_STATES=new Set(['queued','accepted','ready','submitted','downloaded','failed']);
const MANIFEST_TIMES=['createdAt','acceptedAt','readyAt','submittedAt','downloadedAt'];

function normalizeTimestamp(value){
  if(typeof value!=='string'||!value.trim())return null;
  const raw=value.trim(),direct=Date.parse(raw);
  if(Number.isFinite(direct))return raw;
  // Older browser workers occasionally inserted a stray "N" before the UTC
  // suffix (for example `.3NZ`). Recover that one known typo, but do not guess
  // at any other malformed clock value.
  const repaired=raw.replace(/(\.\d{1,3})N(?=Z$)/,'$1'),parsed=Date.parse(repaired);
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}

export function webWorkerStatus(){
  const available=Boolean(findCodex());
  return {ready:available,state:available?'available':'unavailable',transport:WEB_IMAGE_TRANSPORT,browser:WEB_IMAGE_BROWSER,focusPolicy:WEB_IMAGE_FOCUS_POLICY,focusSafe:false,focusRestoration:'unsupported',message:available?'执行器可用，站点访问权限将在任务中验证。':'请先安装 Codex 并登录。'};
}
export function readWebManifest(file){
  try{
    const value=readRunJson(file,{strict:true});
    const state=String(value.state||'');
    if(!MANIFEST_STATES.has(state))return null;
    const conversationUrl=/^https:\/\/chatgpt\.com\/(?:c\/[^\s?#]+)?(?:[?#][^\s]*)?$/.test(String(value.conversationUrl||''))?String(value.conversationUrl):null;
    const requestId=REQUEST_ID.test(String(value.requestId||''))?String(value.requestId):null;
    const times=Object.fromEntries(MANIFEST_TIMES.map(key=>[key,normalizeTimestamp(value[key])]));
    return {...value,...times,state,submitted:value.submitted===true,conversationUrl,...(requestId?{requestId}:{}),...(value.accepted===true?{accepted:true}: {})};
  }catch{return null;}
}

export {chatGptWebImagePrompt};
function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(temp,file);
}

function patchManifestState(manifestFile,stage,args={}){
  return patchManifest({stage,manifestFile,args}).manifest;
}

function readJsonObject(file){
  return readRunJson(file);
}

/**
 * Keep browser evidence tied to this exact request and CLI run. A stale event
 * file or worker from another task must never rewrite the current manifest.
 */
function browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest}={}){
  try{
    const record=readRunIdentity(dir,{strict:true}),expected={requestId,runId:record.runId};
    if(outputFile)expected.outputFile=path.resolve(String(outputFile));
    const comparison=compareRunIdentity({record,expected});
    if(!comparison.ok)return false;
    if(record.request?.provider!==undefined&&record.request.provider!==WEB_IMAGE_PROVIDER)return false;
    if(record.worker?.provider!==WEB_IMAGE_PROVIDER||record.manifest?.provider!==WEB_IMAGE_PROVIDER)return false;
    if(record.worker?.manifestFile&&path.resolve(String(record.worker.manifestFile))!==path.resolve(String(manifestFile||'')))return false;
    if(manifest?.requestId!==requestId)return false;
    return true;
  }catch{return false;}
}

function explicitManifestErrorCode(manifest){
  const code=String(manifest?.errorCode||'').trim();
  return code||null;
}

function originPermissionDeniedForRun({dir,manifestFile,outputFile,requestId,manifest}={}){
  if(!manifest||manifest.state!=='failed'||!Object.prototype.hasOwnProperty.call(manifest,'submitted')||manifest.submitted!==false)return false;
  if(!browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest}))return false;
  const explicit=explicitManifestErrorCode(manifest);
  // A concrete manifest code is authoritative. A stale/incorrect origin code
  // may be retained as-is; it is not inferred from unrelated event text.
  if(explicit)return explicit==='BROWSER_ORIGIN_PERMISSION_DENIED';
  return browserOriginPermissionDeniedEvidence(structuredBrowserToolResultText(dir));
}

function uploadUnavailableForRun({dir,manifestFile,outputFile,requestId,manifest}={}){
  if(!manifest||manifest.state!=='failed'||manifest.submitted!==false)return false;
  if(!browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest}))return false;
  const explicit=explicitManifestErrorCode(manifest);
  if(explicit)return explicit==='FILE_UPLOAD_CHROME_UNAVAILABLE';
  return fileUploadChromeUnavailableEvidence(structuredBrowserToolResultText(dir));
}

function recordBrowserPreSubmissionFailure(manifestFile,requestId,failure,dir){
  const manifest=readWebManifest(manifestFile);
  if(manifest?.requestId!==requestId||manifest.submitted===true)return manifest;
  const worker=readJsonObject(path.join(dir,'worker-request.json'));
  const modern=Number(worker?.schemaVersion||0)>=2||Number(manifest?.schemaVersion||0)>=2;
  if(modern&&!browserRunIdentityMatches({dir,manifestFile,outputFile:worker?.outputFile,requestId,manifest}))return manifest;
  const detail=String(browserRunEvidenceText(dir,{manifest,failure})||'Chrome 专用标签页的焦点管理能力不可用。').slice(0,1000);
  const explicit=explicitManifestErrorCode(manifest);
  // Once a worker wrote a concrete errorCode, never replace it by scanning
  // event text. This is what prevents prompt/command words like "permission"
  // from turning a real attachment failure into an origin denial.
  const identity={dir,manifestFile,outputFile:worker?.outputFile,requestId,manifest};
  const structured=structuredBrowserToolResultText(dir);
  const originPermissionDenied=!explicit&&browserRunIdentityMatches(identity)&&browserOriginPermissionDeniedEvidence(structured);
  const uploadUnavailable=!explicit&&uploadUnavailableForRun({dir,manifestFile,outputFile:worker?.outputFile,requestId,manifest});
  const historicalIab=!explicit&&iabUnavailableEvidence(String(failure?.code||failure?.message||''));
  const errorCode=explicit|| (uploadUnavailable?'FILE_UPLOAD_CHROME_UNAVAILABLE':originPermissionDenied?'BROWSER_ORIGIN_PERMISSION_DENIED':historicalIab?'IAB_UNAVAILABLE':browserTabBackgroundEvidence(detail)?'BROWSER_TAB_BACKGROUND_UNAVAILABLE':chromeUnavailableEvidence(detail)?'BROWSER_CHROME_UNAVAILABLE':browserFocusEvidence(detail)&&/RESTORE_FAILED_AFTER_CLOSE/i.test(detail)?'BROWSER_FOCUS_RESTORE_FAILED_AFTER_CLOSE':browserFocusEvidence(detail)&&/RESTORE_FAILED/i.test(detail)?'BROWSER_FOCUS_RESTORE_FAILED':'BROWSER_FOCUS_UNAVAILABLE');
  const prefix=browserFailurePrefix(errorCode);
  try{
    patchManifestState(manifestFile,'failed',{submitted:'false',submissionIntent:manifest.submissionIntent===true?'true':'false',preSubmissionFailure:'true',errorCode,error:`${prefix}；未上传附件或发送消息。原始错误：${detail}`});
    return readWebManifest(manifestFile);
  }catch{return manifest;}
}

function normalizeOriginPermissionDenied({manifestFile,requestId,dir,outputFile,manifest,failure}={}){
  if(!originPermissionDeniedForRun({dir,manifestFile,outputFile,requestId,manifest,failure}))return null;
  const detail=String(browserRunEvidenceText(dir,{manifest,failure})).slice(0,1000);
  const explicit=explicitManifestErrorCode(manifest),errorCode=explicit||'BROWSER_ORIGIN_PERMISSION_DENIED';
  try{
    patchManifestState(manifestFile,'failed',{submitted:'false',submissionIntent:manifest.submissionIntent===true?'true':'false',preSubmissionFailure:'true',errorCode,error:`${browserFailurePrefix(errorCode)}；未上传附件或发送消息。原始错误：${detail}`});
    return readWebManifest(manifestFile);
  }catch{return manifest;}
}

function browserPreSubmissionFailureObserved(dir,failure,manifest=null){
  return browserPreSubmissionUnavailableText(browserRunEvidenceText(dir,{failure,manifest}));
}

function downloadEvidenceFromRun({dir,result,manifestFile,outputFile,requestId}={}){
  const manifest=readWebManifest(manifestFile),texts=[result?.text,readDownloadEvidence(dir)];
  try{texts.push(fs.readFileSync(path.join(dir,'response.txt'),'utf8'));}catch{}
  texts.push(structuredBrowserToolResultText(dir));
  let raw=null;for(const value of texts){raw=extractDownloadEvidence(value);if(raw)break;}
  let actual=null;try{if(fs.existsSync(outputFile))actual=inspectDownloadArtifact(outputFile);}catch(error){return {ok:false,errors:[`原始图片无法读取：${error.message}`],evidence:raw,actual:null};}
  if(!raw)return {ok:false,errors:['执行器没有返回结构化 pageAssets 下载证据。'],evidence:null,actual};
  const evidence=completeDownloadEvidence(raw,{actual}),validation=validateDownloadEvidence(evidence,{conversationUrl:manifest?.conversationUrl||null,requestId,runId:path.basename(dir),outputFile,actual});
  try{writeDownloadEvidence(dir,evidence);}catch(error){validation.ok=false;validation.errors=[...validation.errors,`download-evidence.json 写入失败：${error.message}`];}
  return {...validation,evidence,actual};
}

function finalizeWorkerResult({dir,manifestFile,outputFile,requestId,result,failure,model,reasoningEffort,role,downloadEvidence=null}){
  let manifest=readWebManifest(manifestFile);
  const normalizedOrigin=normalizeOriginPermissionDenied({manifestFile,requestId,dir,outputFile,manifest,failure});
  if(normalizedOrigin)manifest=normalizedOrigin;
  else if((failure||explicitManifestErrorCode(manifest))&&browserPreSubmissionFailureObserved(dir,failure,manifest))manifest=recordBrowserPreSubmissionFailure(manifestFile,requestId,failure,dir);
  if(manifest?.requestId===requestId&&(!manifest.role||!manifest.executorReasoningEffort)){
    try{
      patchManifestState(manifestFile,'metadata',{role:manifest.role||role,executorModel:(manifest.executorModel??model)||null,executorReasoningEffort:manifest.executorReasoningEffort||reasoningEffort,focusPolicy:manifest.focusPolicy||WEB_IMAGE_FOCUS_POLICY});
      manifest=readWebManifest(manifestFile);
    }catch{}
  }
  const matches=manifest?.requestId===requestId&&browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest});
  if(matches&&manifest.state==='downloaded'&&manifest.accepted===true&&manifest.submitted===true&&path.resolve(manifest.artifactPath||'')===path.resolve(outputFile)&&fs.existsSync(outputFile)){
    if(!downloadEvidence?.ok){const error=new Error(`网页原图已送达但结构化下载证据未通过校验：${(downloadEvidence?.errors||['未知证据错误']).slice(0,3).join('；')}`);error.code='DOWNLOAD_EVIDENCE_INVALID';error.webManifest=manifest;error.downloadEvidence=downloadEvidence;throw error;}
    return {...result,text:outputFile,manifest,downloadEvidence:downloadEvidence.evidence};
  }
  if(matches&&manifest.state==='failed'){
    const error=new Error(manifest.error||'网页生成未完成。');error.code=manifest.errorCode||'WEB_IMAGE_FAILED';error.webManifest=manifest;throw error;
  }
  if(manifest?.requestId===requestId&&!browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest})){
    const error=new Error('执行记录身份不一致，原文件已保留，不能自动采用或重试。');error.code='REQUEST_IDENTITY_MISMATCH';error.webManifest=manifest;throw error;
  }
  const error=failure||new Error('执行已结束，但没有取得已核实原图。记录已保留，请检查已有图片；不会自动重试。');error.webManifest=manifest;throw error;
}

function archivePreAcceptanceAttempt(dir,manifest,execution){
  const attemptsDir=path.join(dir,'attempts');fs.mkdirSync(attemptsDir,{recursive:true});
  const serial=String(fs.readdirSync(attemptsDir).filter(name=>/^\d{3}-preaccept-usage-limit$/.test(name)).length+1).padStart(3,'0');
  const archive=path.join(attemptsDir,`${serial}-preaccept-usage-limit`);fs.mkdirSync(archive,{recursive:false});
  for(const name of ['execution.json','events.jsonl','response.txt','result.json','prompt.txt','web-generation.json','run-identity.json']){
    const source=path.join(dir,name);if(fs.existsSync(source))fs.copyFileSync(source,path.join(archive,name));
  }
  writeJson(path.join(archive,'attempt.json'),{schemaVersion:1,requestId:manifest.requestId,state:manifest.state,accepted:manifest.accepted===true,submitted:manifest.submitted===true,referenceCount:Number(manifest.referenceCount)||0,executionState:execution.state,error:execution.error||null,archivedAt:new Date().toISOString()});
  return path.relative(dir,archive);
}

function archiveConfirmedUnsentAttempt(dir,manifest,execution,audit){
  const attemptsDir=path.join(dir,'attempts');fs.mkdirSync(attemptsDir,{recursive:true});
  const serial=String(fs.readdirSync(attemptsDir).filter(name=>/^\d{3}-/.test(name)).length+1).padStart(3,'0');
  const archive=path.join(attemptsDir,`${serial}-confirmed-unsent`);fs.mkdirSync(archive,{recursive:false});
  for(const name of ['execution.json','events.jsonl','response.txt','result.json','prompt.txt','web-generation.json','run-identity.json','web-audit.json']){
    const source=path.join(dir,name);if(fs.existsSync(source))fs.copyFileSync(source,path.join(archive,name));
  }
  writeJson(path.join(archive,'attempt.json'),{schemaVersion:1,requestId:manifest.requestId,state:manifest.state,accepted:manifest.accepted===true,submitted:manifest.submitted===true,submissionIntent:manifest.submissionIntent===true,referenceCount:Number(manifest.referenceCount)||0,executionState:execution.state,errorCode:manifest.errorCode||null,error:manifest.error||execution.error||null,auditResult:audit.result,archivedAt:new Date().toISOString()});
  return path.relative(dir,archive);
}

function assertExpectedIdentity(expected,request,worker,manifest,{dir=null,outputFile=null}={}){
  if(dir){
    const record=readRunIdentity(dir,{strict:true}),comparison=compareRunIdentity({record,expected:{...expected,...(outputFile?{outputFile}: {})}});
    if(!comparison.ok){const error=new Error(`待续接图片请求身份不匹配；原记录已保留，不会重新执行：${comparison.issues.join('；')}`);error.code='REQUEST_IDENTITY_MISMATCH';throw error;}
  }
  for(const key of ['projectId','projectVersion','taskId','target','requestId']){
    if(expected?.[key]===undefined||expected?.[key]===null||expected?.[key]==='')continue;
    const sources=key==='requestId'?[worker,manifest]:[request,worker,manifest];
    for(const source of sources)if(source?.[key]===undefined||!sameIdentityValue(expected[key],source[key],key))throw new Error(`待续接图片请求的 ${key} 不匹配；原记录已保留，不会重新执行。`);
  }
}

function matchingConfirmedUnsentAudit({dir,request,worker,manifest,expected={}}={}){
  const audit=readJsonObject(path.join(dir,'web-audit.json'));
  if(!audit||audit.result!=='confirmed_unsent'||manifest?.state!=='failed'||manifest?.submissionIntent!==true)return null;
  if(manifest.errorCode!=='FILE_UPLOAD_CHROME_UNAVAILABLE'||!/^https:\/\/chatgpt\.com\/c\/[\w-]+/.test(String(manifest.conversationUrl||'')))return null;
  if(String(audit.conversationUrl||'')!==String(manifest.conversationUrl||''))return null;
  for(const key of ['projectId','projectVersion','taskId','target','requestId']){
    const wanted=expected?.[key]??manifest?.[key]??worker?.[key]??request?.[key];
    for(const source of [request,worker,manifest,audit])if(wanted!==undefined&&source?.[key]!==undefined&&!sameIdentityValue(wanted,source[key],key))return null;
  }
  const evidence=audit.evidence||{};
  if(evidence.composerContainsPrompt!==true||evidence.newUserMessagePresent!==false||evidence.generatedResultPresent!==false||evidence.sendButtonPresent!==true||evidence.executorOwnedTabClosed!==true)return null;
  const auditedAt=Date.parse(audit.auditedAt||'');if(!Number.isFinite(auditedAt)||auditedAt<Date.parse(manifest.submittedAt||manifest.readyAt||manifest.acceptedAt||manifest.createdAt||''))return null;
  return audit;
}

export function confirmedUnsentWebAudit({dir,expected={}}={}){
  try{
    const manifestFile=path.join(dir,'web-generation.json'),request=readJsonObject(path.join(dir,'request.json')),worker=readJsonObject(path.join(dir,'worker-request.json')),manifest=readWebManifest(manifestFile);
    if(!request||!worker||!manifest||!browserRunIdentityMatches({dir,manifestFile,outputFile:worker.outputFile,requestId:manifest.requestId,manifest}))return null;
    assertExpectedIdentity(expected,request,worker,manifest);
    return matchingConfirmedUnsentAudit({dir,request,worker,manifest,expected});
  }catch{return null;}
}


/** One owned CLI execution per image. No dormant thread queue or saved readiness probe. */
export async function dispatchChatGptWebJob({codexBin,dir,outputFile,prompt,referenceFiles=[],editTarget=null,conversationUrl=null,capsule='',signal,timeoutMs=900000,model=null,reasoningEffort=WEB_IMAGE_EXECUTOR_EFFORT,role=WEB_IMAGE_EXECUTOR_ROLE}){
  if(signal?.aborted)throw new Error('已暂停，尚未启动图片任务。');
  fs.mkdirSync(dir,{recursive:true});
  const manifestFile=path.join(dir,'web-generation.json'),instructionFile=path.join(dir,'prompt.txt'),requestFile=path.join(dir,'worker-request.json'),requestMetadataFile=path.join(dir,'request.json');
  if(fs.existsSync(requestFile))throw new Error('这个图片请求已存在，请检查已有结果，不会再次执行。');
  const requestId=crypto.randomUUID(),createdAt=new Date().toISOString(),absoluteOutput=path.resolve(outputFile);
  const runId=path.basename(path.resolve(dir)),requestIdentity=identityFields(readJsonObject(path.join(dir,'request.json'))),lockedIdentity={...requestIdentity,requestId,runId,outputFile:absoluteOutput};
  const commonIdentity={identitySchemaVersion:2,identityLocked:true,...lockedIdentity};
  writeJson(manifestFile,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,transport:WEB_IMAGE_TRANSPORT,browser:WEB_IMAGE_BROWSER,focusPolicy:WEB_IMAGE_FOCUS_POLICY,role,executorModel:model||null,executorReasoningEffort:reasoningEffort,...commonIdentity,state:'queued',accepted:false,submitted:false,referenceCount:0,createdAt});
  const previousRequest=readJsonObject(requestMetadataFile)||{};
  writeJson(requestMetadataFile,{...previousRequest,schemaVersion:Number(previousRequest.schemaVersion||2),provider:previousRequest.provider||WEB_IMAGE_PROVIDER,identitySchemaVersion:2,identityLocked:true,...lockedIdentity,expectedOutput:previousRequest.expectedOutput||path.relative(path.resolve(dir,'..','..'),absoluteOutput)});
  writeJson(requestFile,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,transport:WEB_IMAGE_TRANSPORT,browser:WEB_IMAGE_BROWSER,focusPolicy:WEB_IMAGE_FOCUS_POLICY,role,executorModel:model||null,executorReasoningEffort:reasoningEffort,...commonIdentity,expectedOutput:path.relative(path.resolve(dir,'..','..'),absoluteOutput),authorization:{confirmed:true,scope:'one_chatgpt_web_image_submission',confirmedAt:createdAt},instructionFile,manifestFile,referenceFiles:referenceFiles.map(file=>path.resolve(file)),createdAt});
  writeJson(path.join(dir,'run-identity.json'),{schemaVersion:1,identitySchemaVersion:2,identityLocked:true,provider:WEB_IMAGE_PROVIDER,...lockedIdentity,expectedOutput:absoluteOutput,createdAt});
  let result,failure;
  try{result=await runCodex({codexBin,dir,image:true,browserMode:'chrome',signal,timeoutMs,model,reasoningEffort,role,writableDirs:[path.dirname(path.resolve(outputFile))],prompt:chatGptWebImagePrompt({outputFile,manifestFile,prompt,referenceFiles,editTarget,conversationUrl,capsule,requestId})});}catch(error){failure=error;}
  const downloadEvidence=downloadEvidenceFromRun({dir,result,manifestFile,outputFile,requestId});
  return finalizeWorkerResult({dir,manifestFile,outputFile,requestId,result,failure,model,reasoningEffort,role,downloadEvidence});
}

/** Resume only a proven pre-acceptance quota stop or a separately audited,
 * definite no-send browser attempt, preserving the original requestId. */
export async function resumeChatGptWebJob({codexBin,dir,signal,timeoutMs=900000,model=null,reasoningEffort=WEB_IMAGE_EXECUTOR_EFFORT,role=WEB_IMAGE_EXECUTOR_ROLE,expected={},instruction=null}){
  if(signal?.aborted)throw new Error('已暂停，尚未续接图片任务。');
  const manifestFile=path.join(dir,'web-generation.json'),requestFile=path.join(dir,'request.json'),workerFile=path.join(dir,'worker-request.json'),executionFile=path.join(dir,'execution.json'),eventsFile=path.join(dir,'events.jsonl');
  const manifest=readWebManifest(manifestFile),request=readJsonObject(requestFile),worker=readJsonObject(workerFile),execution=readJsonObject(executionFile);
  if(!manifest||!request||!worker||!execution)throw new Error('待续接图片请求缺少完整执行记录；不会创建第二个请求。');
  assertExpectedIdentity(expected,request,worker,manifest,{dir,outputFile:worker.outputFile});
  const requestId=manifest.requestId,outputFile=path.resolve(String(worker.outputFile||''));
  if(!requestId||worker.requestId!==requestId||!outputFile||!browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest}))throw new Error('待续接图片请求身份不一致；原记录已保留，不会重新执行。');
  const preAcceptance=manifest.state==='queued'&&manifest.accepted!==true&&manifest.submitted!==true&&Number(manifest.referenceCount)===0&&!manifest.acceptedAt&&!manifest.readyAt&&!manifest.submittedAt&&!manifest.downloadedAt&&!manifest.artifactPath;
  const audit=matchingConfirmedUnsentAudit({dir,request,worker,manifest,expected});
  if(!preAcceptance&&!audit)throw new Error('这次请求既不是接受前额度暂停，也没有严格匹配的网页未发送核验；不会上传或发送。');
  const usageText=`${execution.error||''}\n${fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,'utf8'):''}`;
  if(preAcceptance&&execution.state!=='failed'||preAcceptance&&!/(?:you'?ve hit your usage limit|usage limit(?: has been)? reached|rate limit reached|额度(?:已用尽|不足|限制)|使用额度(?:已用尽|不足)|hit your limit)/i.test(usageText))throw new Error('没有找到本次请求在接受前被额度限制拦下的证据；不会上传或发送。');
  if(preAcceptance&&(/"type"\s*:\s*"mcp_tool_call"/.test(usageText)||fs.existsSync(outputFile)))throw new Error('本次请求可能已经开始浏览器操作或已有输出，不能自动续接。');
  if(worker.executorModel&&model&&worker.executorModel!==model)throw new Error('待续接请求的执行器模型已变化；不会重新执行。');
  if(worker.executorReasoningEffort&&reasoningEffort&&worker.executorReasoningEffort!==reasoningEffort)throw new Error('待续接请求的执行器思考力度已变化；不会重新执行。');
  if(worker.role&&role&&worker.role!==role)throw new Error('待续接请求的执行器角色已变化；不会重新执行。');
  const instructionFile=String(worker.instructionFile||path.join(dir,'prompt.txt')),nextInstruction=typeof instruction==='string'&&instruction.trim()?instruction:fs.readFileSync(instructionFile,'utf8'),archive=preAcceptance?archivePreAcceptanceAttempt(dir,manifest,execution):archiveConfirmedUnsentAttempt(dir,manifest,execution,audit),resumedAt=new Date().toISOString();
  if(audit&&!(typeof instruction==='string'&&instruction.trim()))throw new Error('已确认未发送的续接缺少更新后执行指令；原记录已保留。');
  fs.writeFileSync(instructionFile,nextInstruction,{mode:0o600});
  const resumeArgs={resumeCount:Number(manifest.resumeCount||0)+1,resumedAt,...(preAcceptance?{lastPreAcceptanceAttempt:archive}:{lastConfirmedUnsentAttempt:archive,confirmedUnsentAudit:'web-audit.json'})};
  patchManifestState(manifestFile,'resume',resumeArgs);
  let result,failure;
  try{result=await runCodex({codexBin,dir,image:true,browserMode:'chrome',signal,timeoutMs,model:model||worker.executorModel||null,reasoningEffort:reasoningEffort||worker.executorReasoningEffort||WEB_IMAGE_EXECUTOR_EFFORT,role:role||worker.role||WEB_IMAGE_EXECUTOR_ROLE,writableDirs:[path.dirname(outputFile)],prompt:nextInstruction});}catch(error){failure=error;}
  const downloadEvidence=downloadEvidenceFromRun({dir,result,manifestFile,outputFile,requestId});
  const finalResult=finalizeWorkerResult({dir,manifestFile,outputFile,requestId,result,failure,model:model||worker.executorModel||null,reasoningEffort:reasoningEffort||worker.executorReasoningEffort||WEB_IMAGE_EXECUTOR_EFFORT,role:role||worker.role||WEB_IMAGE_EXECUTOR_ROLE,downloadEvidence});
  try{
    patchManifestState(manifestFile,'metadata',resumeArgs);
    const restored=readWebManifest(manifestFile);
    if(restored)finalResult.manifest=restored;
  }catch{}
  return finalResult;
}
