#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {RUN_LOCKED_FIELDS,readRunIdentity,compareRunIdentity} from './run-identity.mjs';
import {inspectDownloadArtifact,readDownloadEvidence,validateDownloadEvidence} from './web-download-evidence.mjs';

const MANIFEST_STATES=new Set(['queued','accepted','ready','submitted','downloaded','failed']);
const URL_RE=/^https:\/\/chatgpt\.com\/(?:c\/[^\s?#]+)?(?:[?#][^\s]*)?$/;
const VALUE_KEYS=new Set(['conversationUrl','referenceCount','errorCode','error','submissionConfirmedBy','artifactPath','accepted','submitted','submissionIntent','submissionUncertain','preSubmissionFailure','resumeCount','resumedAt','lastPreAcceptanceAttempt','lastConfirmedUnsentAttempt','confirmedUnsentAudit','role','executorModel','executorReasoningEffort','focusPolicy']);

function now(){return new Date().toISOString();}
function usageError(message){const error=new Error(message);error.code='MANIFEST_PATCH_REJECTED';return error;}
function parseArgs(argv){
  const [stage,...rest]=argv,values={stage};
  for(let i=0;i<rest.length;i++){
    const arg=rest[i];
    if(!arg.startsWith('--'))throw usageError(`不支持的 manifest 参数：${arg}`);
    const key=arg.slice(2).replace(/-([a-z])/g,(_,char)=>char.toUpperCase());
    if(RUN_LOCKED_FIELDS.includes(key))throw usageError(`manifest 身份字段 ${key} 已锁定，不能由网页执行器传入。`);
    if(key!=='manifestFile'&&!VALUE_KEYS.has(key)&&key!=='submissionIntent'&&key!=='submissionUncertain'&&key!=='preSubmissionFailure')throw usageError(`不支持的 manifest 参数：${arg}`);
    const value=rest[i+1];
    if(value===undefined||value.startsWith('--'))throw usageError(`manifest 参数 ${arg} 缺少值。`);
    values[key]=value;i++;
  }
  return values;
}

function bool(value,key){
  if(typeof value==='boolean')return value;
  if(value==='true')return true;
  if(value==='false')return false;
  throw usageError(`${key} 必须是 true 或 false。`);
}
function integer(value,key){const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<0)throw usageError(`${key} 必须是非负整数。`);return parsed;}
function outputPath(record){return record.workerOutput||record.expectedOutput||record.manifestOutput;}
function manifestFileFrom(args){
  const file=String(args.manifestFile||'');
  if(!file)throw usageError('缺少 --manifest-file。');
  return path.resolve(file);
}
function lockFile(file){return `${file}.lock`;}
function acquire(file){
  try{const fd=fs.openSync(lockFile(file),'wx',0o600);return ()=>{try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(lockFile(file));}catch{}};}
  catch(error){if(error.code==='EEXIST')throw usageError('manifest 正在被另一项网页状态更新占用。');throw error;}
}
function writeAtomic(file,value){
  const temp=`${file}.tmp-${crypto.randomUUID()}`,text=JSON.stringify(value,null,2)+'\n';
  let fd;
  try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,text,{encoding:'utf8'});fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(temp,file);}
  catch(error){if(fd!==undefined&&fd!==null)try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(temp);}catch{}throw error;}
}
function ensureState(currentManifest,next){
  const current=currentManifest?.state;
  if(!MANIFEST_STATES.has(next))throw usageError(`非法 manifest 状态：${next}`);
  if(current==='downloaded'&&next!=='downloaded')throw usageError('已下载的 manifest 不允许回退状态。');
  if(current==='failed'&&next!=='failed'&&currentManifest?.submitted===true)throw usageError('提交后的失败结果不允许被重置。');
}
function validateUrl(value){if(!URL_RE.test(String(value||'')))throw usageError('conversationUrl 必须是 chatgpt.com 会话地址。');return String(value);}
function validateLockedPatch(patch){
  for(const key of Object.keys(patch))if(RUN_LOCKED_FIELDS.includes(key))throw usageError(`manifest 身份字段 ${key} 已锁定，不能由网页执行器改写。`);
}
function failureFlags(args,current){
  const submitted=args.submitted===undefined?current.submitted===true:bool(args.submitted,'submitted');
  const submissionIntent=args.submissionIntent===undefined?current.submissionIntent===true:bool(args.submissionIntent,'submissionIntent');
  const submissionUncertain=args.submissionUncertain===undefined
    ? submitted&&(current.submissionUncertain===true||String(args.errorCode||'')==='SUBMISSION_UNCERTAIN')
    : bool(args.submissionUncertain,'submissionUncertain');
  const preSubmissionFailure=args.preSubmissionFailure===undefined?!submitted:bool(args.preSubmissionFailure,'preSubmissionFailure');
  if(!submitted){
    if(submissionUncertain)throw usageError('未提交的失败不能标记为 submissionUncertain。');
    if(!preSubmissionFailure)throw usageError('未提交的失败必须标记为 preSubmissionFailure。');
  }else{
    if(!submissionIntent)throw usageError('submitted 前必须已经记录 submissionIntent。');
    if(preSubmissionFailure)throw usageError('已提交或提交不确定的请求不能标记为 preSubmissionFailure。');
    if(String(args.errorCode||'')==='SUBMISSION_UNCERTAIN'&&!submissionUncertain)throw usageError('SUBMISSION_UNCERTAIN 必须标记为 submissionUncertain。');
  }
  return {submitted,submissionIntent,submissionUncertain,preSubmissionFailure};
}
function readRecords(file){
  const dir=path.dirname(file),record=readRunIdentity(dir,{strict:true});
  if(record.files.manifest!==file)throw usageError('manifestFile 不属于当前执行目录。');
  if(!record.request||!record.worker||!record.manifest||!record.execution)throw usageError('执行记录不完整，拒绝更新 manifest。');
  const comparison=compareRunIdentity({record,requireModern:true});
  if(!comparison.ok)throw Object.assign(usageError(`执行记录身份不一致：${comparison.issues.join('；')}`),{code:'REQUEST_IDENTITY_MISMATCH',identity:comparison});
  return record;
}
function stagePatch(stage,args,record){
  for(const key of Object.keys(args||{}))if(RUN_LOCKED_FIELDS.includes(key))throw usageError(`manifest 身份字段 ${key} 已锁定，不能由网页执行器改写。`);
  const current=record.manifest;
  const patch={};
  if(stage==='accepted'){
    if(current.state!=='queued'||current.accepted===true)throw usageError('accepted 只能从 queued 且未接单状态写入。');
    patch.state='accepted';patch.accepted=true;patch.acceptedAt=now();
  }else if(stage==='ready'){
    if(!['accepted','ready'].includes(current.state)||current.accepted!==true)throw usageError('ready 前必须已经 accepted。');
    patch.state='ready';patch.accepted=true;patch.submitted=false;patch.conversationUrl=validateUrl(args.conversationUrl);patch.referenceCount=integer(args.referenceCount,'referenceCount');patch.readyAt=now();
  }else if(stage==='submission-intent'){
    if(!['ready','submitted'].includes(current.state)||current.accepted!==true)throw usageError('submission-intent 前必须已经 ready。');
    if(current.submitted===true)throw usageError('已提交的请求不能再次写入 submission-intent。');
    patch.state='ready';patch.submissionIntent=true;patch.submitted=false;patch.submissionAttemptAt=now();
  }else if(stage==='submitted'){
    if(current.accepted!==true||current.submissionIntent!==true)throw usageError('submitted 前必须先写入 submission-intent。');
    patch.state='submitted';patch.accepted=true;patch.submitted=true;patch.submittedAt=now();patch.submissionConfirmedBy=String(args.submissionConfirmedBy||'positive_browser_evidence');
    if(args.conversationUrl)patch.conversationUrl=validateUrl(args.conversationUrl);
  }else if(stage==='downloaded'){
    if(current.submitted!==true)throw usageError('downloaded 前必须已经 submitted。');
    const artifact=outputPath(record);
    if(!artifact||!fs.existsSync(artifact)||!fs.statSync(artifact).isFile()||fs.statSync(artifact).size===0)throw usageError('目标原图不存在或为空，不能写入 downloaded。');
    if(current.transport==='direct-chrome'){
      let actual=null;try{actual=inspectDownloadArtifact(artifact);}catch(error){throw usageError(`原始图片完整性检查失败：${error.message}`);}
      const evidence=readDownloadEvidence(record.dir),validation=validateDownloadEvidence(evidence,{conversationUrl:String(args.conversationUrl||current.conversationUrl||''),requestId:current.requestId,runId:record.runId,outputFile:artifact,actual});
      if(!validation.ok)throw usageError(`结构化 pageAssets 下载证据未通过校验：${validation.errors.slice(0,4).join('；')}`);
    }
    patch.state='downloaded';patch.accepted=true;patch.submitted=true;patch.artifactPath=artifact;patch.downloadedAt=now();patch.errorCode=null;patch.error=null;patch.failedAt=null;
    if(args.conversationUrl)patch.conversationUrl=validateUrl(args.conversationUrl);
  }else if(stage==='failed'){
    const flags=failureFlags(args,current),{submitted,submissionIntent,submissionUncertain,preSubmissionFailure}=flags;
    patch.state='failed';patch.accepted=current.accepted===true;patch.submitted=submitted;patch.errorCode=String(args.errorCode||'WEB_IMAGE_FAILED').slice(0,120);patch.error=String(args.error||'网页生图未完成。').slice(0,2000);patch.failedAt=now();
    if(!submitted)patch.referenceCount=0;
    patch.submissionIntent=submissionIntent;
    patch.submissionUncertain=submissionUncertain;
    patch.preSubmissionFailure=preSubmissionFailure;
    if(args.conversationUrl)patch.conversationUrl=validateUrl(args.conversationUrl);
  }else if(stage==='resume'){
    const confirmedUnsent=Boolean(args.confirmedUnsentAudit);
    if(!['queued','failed'].includes(current.state)||current.submitted===true&&!confirmedUnsent)throw usageError('只有未提交或确认未发送的请求可以续接。');
    patch.state='queued';patch.accepted=false;patch.submitted=false;patch.submissionIntent=false;patch.submissionUncertain=false;patch.preSubmissionFailure=false;patch.referenceCount=0;patch.acceptedAt=null;patch.readyAt=null;patch.submissionAttemptAt=null;patch.submittedAt=null;patch.downloadedAt=null;patch.artifactPath=null;patch.errorCode=null;patch.error=null;
    if(args.resumeCount!==undefined)patch.resumeCount=integer(args.resumeCount,'resumeCount');
    if(args.resumedAt!==undefined)patch.resumedAt=String(args.resumedAt);
    if(args.lastPreAcceptanceAttempt!==undefined)patch.lastPreAcceptanceAttempt=String(args.lastPreAcceptanceAttempt);
    if(args.lastConfirmedUnsentAttempt!==undefined)patch.lastConfirmedUnsentAttempt=String(args.lastConfirmedUnsentAttempt);
    if(args.confirmedUnsentAudit!==undefined)patch.confirmedUnsentAudit=String(args.confirmedUnsentAudit);
  }else if(stage==='metadata'){
    patch.state=current.state;
    for(const key of ['role','executorModel','executorReasoningEffort','focusPolicy','resumeCount','resumedAt','lastPreAcceptanceAttempt','lastConfirmedUnsentAttempt','confirmedUnsentAudit']){
      if(args[key]!==undefined)patch[key]=args[key]===null?null:String(args[key]);
    }
    if(args.resumeCount!==undefined)patch.resumeCount=integer(args.resumeCount,'resumeCount');
  }else throw usageError(`不支持的 manifest 阶段：${stage}`);
  validateLockedPatch(patch);
  ensureState(current.state,patch.state);
  return patch;
}

/**
 * Atomically update one allowed lifecycle state while preserving every
 * unknown field.  Identity is read again immediately before and after the
 * update, so a browser worker can never replace the manifest with a partial
 * object or alter its binding to the project/run/output.
 */
export function patchManifest({stage,manifestFile,args={}}={}){
  const rawFile=String(manifestFile||'').trim();
  if(!rawFile)throw usageError('缺少 manifestFile。');
  const file=path.resolve(rawFile);
  const release=acquire(file);
  try{
    const record=readRecords(file),patch=stagePatch(stage,args,record),next={...record.manifest,...patch};
    validateLockedPatch(patch);
    const nextRecord={...record,manifest:next,manifestOutput:next.outputFile||next.artifactPath||record.manifestOutput};
    const identity=compareRunIdentity({record:nextRecord,requireModern:true});
    if(!identity.ok)throw Object.assign(usageError(`manifest 更新会破坏执行身份：${identity.issues.join('；')}`),{code:'REQUEST_IDENTITY_MISMATCH',identity});
    writeAtomic(file,next);
    // Re-read the actual file after rename; success is not reported until the
    // durable bytes still parse and retain the same locked identity.
    const after=readRecords(file);
    return {ok:true,stage,manifest:after.manifest,identity:compareRunIdentity({record:after,requireModern:true}).identity};
  }finally{release();}
}

function main(){
  const args=parseArgs(process.argv.slice(2)),manifestFile=manifestFileFrom(args),{stage}=args;
  if(!stage)throw usageError('缺少 manifest 阶段。');
  const result=patchManifest({stage,manifestFile,args});process.stdout.write(JSON.stringify(result)+'\n');
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))){
  try{main();}
  catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
