import fs from 'node:fs';
import path from 'node:path';
import {inspectDownloadArtifact} from './web-download-evidence.mjs';

export const NATIVE_DOWNLOAD_EVIDENCE_FILE='native-download-evidence.json';
export const NATIVE_DOWNLOAD_EVIDENCE_SCHEMA_VERSION=1;

const IDENTITY_FIELDS=['projectId','projectVersion','taskId','requestId','runId','target'];
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CHATGPT_CONVERSATION=/^https:\/\/chatgpt\.com\/c\/[^\s?#]+(?:[?#][^\s]*)?$/i;
const HASH=/^[a-f0-9]{64}$/i;

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

/**
 * Validate evidence produced by a Chrome native download/save path.  This is
 * deliberately separate from pageAssets evidence: a local file alone is not
 * enough; it must be bound to the exact submitted run and the exact project
 * material output path.
 */
export function validateNativeDownloadEvidence(value,{
  expectedIdentity={},projectRoot=null,request=null,worker=null,manifest=null,execution=null,
  outputFile=null,actual=null,
}={}){
  const evidence=object(value),errors=[];
  if(!evidence)errors.push('缺少结构化 Chrome 原生下载证据。');
  if(Number(evidence?.schemaVersion)!==NATIVE_DOWNLOAD_EVIDENCE_SCHEMA_VERSION)errors.push('native download evidence schemaVersion 无效。');
  if(text(evidence?.source)!=='chrome-native-download')errors.push('native download evidence source 无效。');
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
  const native=object(evidence?.native);
  if(!native)errors.push('缺少 native 下载信息。');
  if(native&&!text(native.ownedTabId))errors.push('native 下载缺少 ownedTabId。');
  if(native&&manifest?.ownedTabId&&text(native.ownedTabId)!==text(manifest.ownedTabId))errors.push('native 下载 ownedTabId 与 manifest 不一致。');
  if(native&&!text(native.fileName))errors.push('native 下载缺少 fileName。');
  if(native&&artifact&&text(native.fileName)!==path.basename(artifact))errors.push('native 下载 fileName 与输出文件不一致。');
  if(native&&native.method!=='chrome-download')errors.push('native 下载 method 必须是 chrome-download。');
  const submittedAt=manifest?.submittedAt||evidence?.submittedAt,downloadedAt=evidence?.downloadedAt||native?.downloadedAt;
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
  let evidence;
  try{evidence=JSON.parse(fs.readFileSync(path.resolve(String(file)),'utf8'));}
  catch(error){return {ok:false,evidence:null,actual:null,errors:[`无法读取 native download evidence：${error.message}`]};}
  let actual=null;
  try{actual=inspectDownloadArtifact(evidence?.output?.path||options.outputFile);}catch(error){return {ok:false,evidence,actual:null,errors:[`原始下载文件无法解码：${error.message}`]};}
  const validation=validateNativeDownloadEvidence(evidence,{...options,actual,outputFile:options.outputFile||evidence?.output?.path});
  return {...validation,evidence,actual};
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
