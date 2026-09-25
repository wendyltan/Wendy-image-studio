import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {inspectDownloadArtifact} from './web-download-evidence.mjs';

export const NATIVE_DOWNLOAD_EVIDENCE_FILE='native-download-evidence.json';
export const PAGE_ASSETS_AUDIT_FILE='page-assets-audit.json';
export const NATIVE_DOWNLOAD_EVIDENCE_SCHEMA_VERSION=1;

const IDENTITY_FIELDS=['projectId','projectVersion','taskId','requestId','runId','target'];
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CHATGPT_CONVERSATION=/^https:\/\/chatgpt\.com\/c\/[^\s?#]+(?:[?#][^\s]*)?$/i;
const HASH=/^[a-f0-9]{64}$/i;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}
function text(value){return typeof value==='string'?value.trim():'';}
function normalized(key,value){
  if(value===undefined||value===null||value==='')return null;
  if(key==='projectVersion')return Number.isFinite(Number(value))?Number(value):String(value);
  return String(value);
}
function sourceValue(source,key){
  const value=object(source);if(!value)return null;
  if(key==='outputFile')return value.outputFile??value.artifactPath??value.expectedOutput??null;
  return value[key]??null;
}
function sameIdentity(evidence,source,name,errors){
  for(const key of IDENTITY_FIELDS){
    const left=normalized(key,evidence?.[key]),right=normalized(key,sourceValue(source,key));
    if(right!==null&&left!==right)errors.push(`native download evidence ${key} 与 ${name} 不一致。`);
  }
}
function realPathInside(file,root){
  const absolute=path.resolve(String(file||'')),base=path.resolve(String(root||''));
  try{
    const realFile=fs.realpathSync(absolute),realRoot=fs.realpathSync(base);
    return realFile===realRoot||realFile.startsWith(realRoot+path.sep);
  }catch{return false;}
}
function materialPath(file,{projectRoot=null,projectVersion=null}={}){
  if(!projectRoot||!Number.isInteger(Number(projectVersion)))return false;
  const root=path.resolve(projectRoot),absolute=path.resolve(String(file||''));
  const prefix=path.join(root,`v${Number(projectVersion)}`,'素材')+path.sep;
  return absolute.startsWith(prefix)&&realPathInside(absolute,root);
}
function validTime(value,label,errors){
  if(!ISO.test(text(value))||!Number.isFinite(Date.parse(value)))errors.push(`${label} 无效。`);
}

function validatePageAssetsAudit(audit,{evidence,remote,output,evidenceSha256=null,errors}={}){
  const value=object(audit),summary=object(value?.pageAssets)||value;
  if(!value){errors.push('page-assets evidence 缺少持久化 inventory/bundle 审计摘要。');return;}
  if(value!==summary){
    if(Number(value.schemaVersion)!==1)errors.push('page-assets audit schemaVersion 无效。');
    if(text(value.source)!=='chrome-page-assets-audit')errors.push('page-assets audit source 无效。');
    for(const key of IDENTITY_FIELDS){
      if(normalized(key,value[key])!==normalized(key,evidence?.[key]))errors.push(`page-assets audit ${key} 与 evidence 不一致。`);
    }
    if(text(value.conversationUrl)!==text(evidence?.conversationUrl))errors.push('page-assets audit conversationUrl 与 evidence 不一致。');
    if(text(value.sourceEvidenceFile)!==NATIVE_DOWNLOAD_EVIDENCE_FILE)errors.push('page-assets audit sourceEvidenceFile 不指向同 run native evidence。');
    if(!HASH.test(text(value.sourceEvidenceSha256)))errors.push('page-assets audit sourceEvidenceSha256 无效。');
    if(evidenceSha256&&text(value.sourceEvidenceSha256)!==text(evidenceSha256))errors.push('page-assets audit 未绑定当前 native evidence 文件。');
  }
  const inventoryId=text(summary.inventoryId),matched=object(summary.matchedAsset),bundle=object(summary.bundle);
  if(!UUID.test(inventoryId))errors.push('page-assets inventoryId 无效。');
  if(!matched)errors.push('page-assets audit 缺少匹配 asset 摘要。');
  if(matched&&!text(matched.id))errors.push('page-assets matchedAsset.id 缺失。');
  if(matched&&text(matched.kind)!=='image')errors.push('page-assets matchedAsset.kind 必须是 image。');
  if(matched&&text(matched.name)!=='content')errors.push('page-assets matchedAsset.name 必须是 content。');
  if(matched&&!/^https:\/\/chatgpt\.com\/backend-api\/estuary\/content(?:[?#/]|$)/i.test(text(matched.sourceUrl||matched.url)))errors.push('page-assets matchedAsset.sourceUrl 不是 ChatGPT content 资源。');
  if(matched){
    const unavailable=Array.isArray(matched.unavailableFields)?matched.unavailableFields:[];
    for(const key of ['isThumbnail','isPreview','role']){
      const provided=Object.prototype.hasOwnProperty.call(matched,key);
      if(provided){
        if(unavailable.includes(key))errors.push(`page-assets matchedAsset.${key} 同时被标记为 unavailable。`);
        if(key==='isThumbnail'&&matched[key]!==false)errors.push('page-assets matchedAsset.isThumbnail 必须明确为 false。');
        if(key==='isPreview'&&matched[key]!==false)errors.push('page-assets matchedAsset.isPreview 必须明确为 false。');
        if(key==='role'&&(!text(matched[key])||/(?:thumbnail|preview|缩略|预览)/i.test(text(matched[key]))))errors.push('page-assets matchedAsset.role 不能是预览或缩略图角色。');
      }else if(!unavailable.includes(key))errors.push(`page-assets matchedAsset.${key} 缺失且未记录为 unavailable。`);
    }
  }
  if(matched&&remote&&text(matched.sourceUrl||matched.url)!==text(remote.assetUrl))errors.push('page-assets matchedAsset.sourceUrl 与当前结果不一致。');
  if(matched&&bundle&&text(matched.id)!==text(bundle.assetId))errors.push('page-assets matchedAsset.id 与 bundle.assetId 不一致。');
  if(!bundle)errors.push('page-assets audit 缺少 bundle 摘要。');
  if(bundle){
    for(const [key,wanted] of [['requestedCount',1],['downloadedCount',1],['failedCount',0]])if(Number(bundle[key])!==wanted)errors.push(`page-assets bundle.${key} 不符合单资产成功 bundle。`);
    if(!Array.isArray(bundle.failures)||bundle.failures.length!==0)errors.push('page-assets bundle.failures 必须为空。');
    if(!['image/png','image/jpeg','image/webp'].includes(text(bundle.contentType).toLowerCase()))errors.push('page-assets bundle.contentType 不是支持的图片 MIME。');
    if(!HASH.test(text(bundle.sha256))||Number(bundle.bytes)<=0)errors.push('page-assets bundle 原图完整性摘要无效。');
    if(!text(bundle.assetId))errors.push('page-assets bundle.assetId 缺失。');
    if(!/^https:\/\/chatgpt\.com\/backend-api\/estuary\/content(?:[?#/]|$)/i.test(text(bundle.assetUrl)))errors.push('page-assets bundle.assetUrl 不是 ChatGPT content 资源。');
    if(matched&&text(bundle.assetId)!==text(matched.id))errors.push('page-assets bundle.assetId 与 matchedAsset 不一致。');
    if(remote&&text(bundle.assetUrl)!==text(remote.assetUrl))errors.push('page-assets bundle.assetUrl 与当前结果不一致。');
    if(output){
      for(const key of ['bytes','sha256'])if(bundle[key]!==undefined&&String(bundle[key])!==String(output[key]))errors.push(`page-assets bundle.${key} 与输出不一致。`);
      if(bundle.contentType&&text(bundle.contentType).toLowerCase()!==text(output.contentType).toLowerCase())errors.push('page-assets bundle.contentType 与输出不一致。');
    }
  }
}

/**
 * Validate evidence produced by Chrome native download or an audited
 * page-assets recovery. A local file alone is not enough: it must be bound to
 * the exact submitted run and the exact project material output path.
 */
export function validateNativeDownloadEvidence(value,{
  expectedIdentity={},projectRoot=null,request=null,worker=null,manifest=null,execution=null,
  outputFile=null,actual=null,pageAssetsAudit=null,evidenceSha256=null,
}={}){
  const evidence=object(value),errors=[];
  if(!evidence)errors.push('缺少结构化 Chrome 原生下载证据。');
  if(Number(evidence?.schemaVersion)!==NATIVE_DOWNLOAD_EVIDENCE_SCHEMA_VERSION)errors.push('native download evidence schemaVersion 无效。');
  const source=text(evidence?.source);
  if(!['chrome-native-download','chrome-page-assets'].includes(source))errors.push('native download evidence source 无效。');
  if(text(evidence?.transport)!=='direct-chrome'||text(evidence?.browser)!=='chrome')errors.push('native download evidence 必须来自 direct-chrome Chrome。');
  if(!CHATGPT_CONVERSATION.test(text(evidence?.conversationUrl)))errors.push('native download evidence conversationUrl 不是 ChatGPT 会话地址。');
  for(const key of IDENTITY_FIELDS){
    const observed=normalized(key,evidence?.[key]),wanted=normalized(key,expectedIdentity?.[key]);
    if(observed===null)errors.push(`native download evidence ${key} 缺失。`);
    if(wanted!==null&&observed!==wanted)errors.push(`native download evidence ${key} 与当前执行身份不一致。`);
  }
  for(const [name,source] of [['request',request],['worker',worker],['manifest',manifest],['execution',execution]])sameIdentity(evidence,source,name,errors);
  for(const [name,source] of [['request',request],['worker',worker],['manifest',manifest],['execution',execution]]){
    const sourceConversation=text(sourceValue(source,'conversationUrl'));
    // The bootstrap URL (`https://chatgpt.com/`) is only an origin and is
    // not a session identity.  Older runs may have persisted it before the
    // executor reached the real conversation; a specific `/c/...` URL is
    // authoritative and must still match exactly.
    if(CHATGPT_CONVERSATION.test(sourceConversation)&&sourceConversation!==text(evidence?.conversationUrl))errors.push(`native download evidence conversationUrl 与 ${name} 不一致。`);
  }
  const expectedOutput=path.resolve(String(outputFile||sourceValue(worker,'outputFile')||sourceValue(request,'outputFile')||''));
  const output=object(evidence?.output),artifact=path.resolve(String(output?.path||''));
  if(!expectedOutput||expectedOutput===path.resolve('.')||artifact!==expectedOutput)errors.push('native download evidence output.path 与本次 expectedOutput 不一致。');
  if(!materialPath(artifact,{projectRoot,projectVersion:expectedIdentity?.projectVersion??evidence?.projectVersion}))errors.push('native download evidence 输出文件不在匹配版本的素材目录内。');
  try{
    const stat=fs.lstatSync(artifact);
    if(!stat.isFile()||stat.isSymbolicLink())errors.push('native download evidence 输出必须是普通文件，不能是符号链接。');
  }catch{errors.push('native download evidence 输出文件不存在。');}
  if(!output||!Number.isInteger(Number(output.bytes))||Number(output.bytes)<=0)errors.push('native download evidence output.bytes 无效。');
  if(!output||!HASH.test(text(output.sha256)))errors.push('native download evidence output.sha256 无效。');
  if(!output||!['PNG','JPEG','WEBP'].includes(text(output.format).toUpperCase()))errors.push('native download evidence output.format 无效。');
  if(!output||!Number.isInteger(Number(output.width))||Number(output.width)<=0||!Number.isInteger(Number(output.height))||Number(output.height)<=0)errors.push('native download evidence 输出尺寸无效。');
  const native=object(evidence?.native),nativeMethod=text(native?.method);
  if(!native)errors.push('缺少 native 下载信息。');
  if(native&&!text(native.ownedTabId))errors.push('native 下载缺少 ownedTabId。');
  if(nativeMethod&&!['chrome-download','page-assets'].includes(nativeMethod))errors.push('native 下载 method 无效。');
  if(source==='chrome-native-download'&&nativeMethod!=='chrome-download')errors.push('native download evidence source 与 method 不一致。');
  if(source==='chrome-page-assets'&&nativeMethod!=='page-assets')errors.push('page-assets evidence source 与 method 不一致。');
  if(native&&nativeMethod==='chrome-download'&&manifest?.ownedTabId&&text(native.ownedTabId)!==text(manifest.ownedTabId))errors.push('native 下载 ownedTabId 与 manifest 不一致。');
  if(native&&nativeMethod==='page-assets'){
    if(text(native.recoveryTabId)!==text(native.ownedTabId))errors.push('page-assets evidence recoveryTabId 与 ownedTabId 不一致。');
    if(!text(native.originalOwnedTabId)||text(native.originalOwnedTabId)!==text(manifest?.ownedTabId||''))errors.push('page-assets evidence originalOwnedTabId 与原执行 manifest 不一致。');
    if(text(native.recoveryTabId)===text(native.originalOwnedTabId))errors.push('page-assets evidence 恢复 tab 不能冒充原执行 tab。');
    if(native.recoveryTabClosed!==true)errors.push('page-assets evidence 未证明恢复 tab 已关闭。');
    validTime(native.closedAt,'page-assets recovery tab closedAt',errors);
    const remote=object(evidence?.remoteResult);
    if(!remote)errors.push('page-assets evidence 缺少远端生成结果绑定。');
    if(remote&&!/^已生成图片：.+/.test(text(remote.buttonLabel)))errors.push('page-assets evidence 生成结果按钮标题无效。');
    if(remote&&!/^file_[a-z0-9_-]+$/i.test(text(remote.assetId)))errors.push('page-assets evidence assetId 无效。');
    let assetUrl=null;
    try{assetUrl=new URL(text(remote?.assetUrl));}catch{}
    if(!assetUrl||assetUrl.protocol!=='https:'||assetUrl.host!=='chatgpt.com'||assetUrl.pathname!=='/backend-api/estuary/content'||assetUrl.searchParams.get('id')!==text(remote?.assetId))errors.push('page-assets evidence assetUrl 不是对应的 ChatGPT 原始 content asset。');
    if(remote&&text(native.sourceAssetId)!==text(remote.assetId))errors.push('page-assets evidence sourceAssetId 与远端结果不一致。');
    if(remote&&text(native.sourceAssetUrl)!==text(remote.assetUrl))errors.push('page-assets evidence sourceAssetUrl 与远端结果不一致。');
    if(remote&&(!Number.isInteger(Number(remote.width))||!Number.isInteger(Number(remote.height))))errors.push('page-assets evidence 远端结果尺寸无效。');
    const user=object(remote?.userMessage);
    if(!user)errors.push('page-assets evidence 缺少用户消息绑定。');
    if(user&&(!Number.isInteger(Number(user.promptLength))||!HASH.test(text(user.promptSha256))))errors.push('page-assets evidence 用户消息摘要无效。');
    if(user&&request?.remotePromptLength!==undefined&&Number(user.promptLength)!==Number(request.remotePromptLength))errors.push('page-assets evidence 用户消息长度与冻结请求不一致。');
    if(user&&request?.remotePromptSha256&&text(user.promptSha256)!==text(request.remotePromptSha256))errors.push('page-assets evidence 用户消息摘要与冻结请求不一致。');
    if(user&&(!Number.isInteger(Number(user.attachmentCount))||!Array.isArray(user.attachmentNames)))errors.push('page-assets evidence 用户附件台账无效。');
    if(user&&Number(user.attachmentCount)!==user.attachmentNames.length)errors.push('page-assets evidence 用户附件数量与名称台账不一致。');
    if(user&&manifest?.attachmentExpectedCount!==undefined&&Number(user.attachmentCount)!==Number(manifest.attachmentExpectedCount))errors.push('page-assets evidence 用户附件数量与 manifest 不一致。');
    if(user&&manifest?.attachmentObservedCount!==undefined&&Number(user.attachmentCount)!==Number(manifest.attachmentObservedCount))errors.push('page-assets evidence 用户附件观察数量与 manifest 不一致。');
    if(user&&user.assistantResultImmediatelyAfter!==true)errors.push('page-assets evidence 未证明生成结果紧跟在该用户消息之后。');
    validTime(remote?.observedAt,'page-assets result observedAt',errors);
    if(native&&native.recoveryTabId&&remote&&text(native.recoveryTabId)!==text(remote.observedInTabId))errors.push('page-assets evidence 结果观察 tab 不一致。');
    if(remote&&output){
      for(const key of ['bytes','width','height','sha256'])if(remote[key]!==undefined&&String(remote[key])!==String(output[key]))errors.push(`page-assets evidence remoteResult.${key} 与输出不一致。`);
    }
    const embeddedAudit=object(evidence?.pageAssets),externalAudit=object(pageAssetsAudit);
    if(embeddedAudit&&externalAudit?.pageAssets&&JSON.stringify(embeddedAudit)!==JSON.stringify(externalAudit.pageAssets))errors.push('page-assets embedded audit 与外部 audit 不一致。');
    validatePageAssetsAudit(embeddedAudit||externalAudit,{evidence,remote,output,evidenceSha256,errors});
  }
  if(native&&!text(native.fileName))errors.push('native 下载缺少 fileName。');
  if(native&&artifact&&text(native.fileName)!==path.basename(artifact))errors.push('native 下载 fileName 与输出文件不一致。');
  const submittedAt=manifest?.submittedAt||manifest?.submissionAttemptAt||evidence?.submittedAt,downloadedAt=evidence?.downloadedAt||native?.downloadedAt;
  validTime(submittedAt,'submittedAt',errors);validTime(downloadedAt,'downloadedAt',errors);
  if(Number.isFinite(Date.parse(submittedAt))&&Number.isFinite(Date.parse(downloadedAt))&&Date.parse(downloadedAt)<=Date.parse(submittedAt))errors.push('downloadedAt 必须晚于 submittedAt。');
  if(!manifest||manifest.accepted!==true||manifest.submitted!==true)errors.push('当前 manifest 不是已接单且已提交状态。');
  if(manifest?.state==='downloaded')errors.push('当前 manifest 已有 downloaded 结果，拒绝重复恢复。');
  if(manifest?.state!=='failed'&&manifest?.state!=='submitted')errors.push('当前 manifest 只能从 failed 或 submitted 恢复。');
  if(manifest?.state==='failed'&&manifest.submissionUncertain!==true)errors.push('failed manifest 必须明确标记 submissionUncertain。');
  if(actual){
    const pairs=[['bytes',actual.bytes],['format',String(actual.format||'').toUpperCase()],['width',actual.width],['height',actual.height],['sha256',actual.sha256]];
    for(const [key,observed] of pairs)if(String(output?.[key])!==String(observed))errors.push(`native download evidence output.${key} 与实际文件不一致。`);
  }
  if(evidence?.downloadedAt&&native?.downloadedAt&&text(evidence.downloadedAt)!==text(native.downloadedAt))errors.push('downloadedAt 与 native.downloadedAt 不一致。');
  if(evidence?.capturedAt)validTime(evidence.capturedAt,'capturedAt',errors);
  if(!Number.isFinite(Date.parse(evidence?.downloadedAt||'')))errors.push('native download evidence downloadedAt 缺失。');
  return {ok:errors.length===0,errors:[...new Set(errors)]};
}

export function inspectNativeDownloadEvidence(file,{...options}={}){
  const evidencePath=path.resolve(String(file));let evidence,rawEvidence;
  try{rawEvidence=fs.readFileSync(evidencePath);evidence=JSON.parse(rawEvidence.toString('utf8'));}
  catch(error){return {ok:false,evidence:null,actual:null,errors:[`无法读取 native download evidence：${error.message}`]};}
  let actual=null;
  try{actual=inspectDownloadArtifact(evidence?.output?.path||options.outputFile);}catch(error){return {ok:false,evidence,actual:null,errors:[`原始下载文件无法解码：${error.message}`]};}
  let pageAssetsAudit=null;
  if(text(evidence?.source)==='chrome-page-assets'){
    const auditFile=path.resolve(String(options.pageAssetsAuditFile||path.join(path.dirname(evidencePath),PAGE_ASSETS_AUDIT_FILE)));
    try{pageAssetsAudit=JSON.parse(fs.readFileSync(auditFile,'utf8'));}catch(error){if(!evidence?.pageAssets)return {ok:false,evidence,actual,pageAssetsAudit:null,errors:[`无法读取 page-assets audit：${error.message}`]};}
  }
  const evidenceSha256=crypto.createHash('sha256').update(rawEvidence).digest('hex');
  const validation=validateNativeDownloadEvidence(evidence,{...options,actual,evidenceSha256,pageAssetsAudit,outputFile:options.outputFile||evidence?.output?.path});
  return {...validation,evidence,actual,pageAssetsAudit};
}

export function readNativeDownloadEvidence(dir){
  const file=path.join(path.resolve(String(dir||'')),NATIVE_DOWNLOAD_EVIDENCE_FILE);
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}
}

export function writeNativeDownloadEvidence(dir,evidence){
  if(!object(evidence))throw new TypeError('native download evidence must be an object');
  const folder=path.resolve(String(dir||''));fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,NATIVE_DOWNLOAD_EVIDENCE_FILE),temp=`${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp,JSON.stringify(evidence,null,2)+'\n',{encoding:'utf8',mode:0o600});fs.renameSync(temp,file);return file;
}

export function writePageAssetsAudit(dir,audit){
  if(!object(audit))throw new TypeError('page-assets audit must be an object');
  const folder=path.resolve(String(dir||''));fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,PAGE_ASSETS_AUDIT_FILE),temp=`${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp,JSON.stringify(audit,null,2)+'\n',{encoding:'utf8',mode:0o600});fs.renameSync(temp,file);return file;
}
