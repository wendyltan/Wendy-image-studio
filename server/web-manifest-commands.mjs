import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {OWNED_TAB_LEASE_FILE} from './owned-tab-lease.mjs';

const DEFAULT_HELPER=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'run-manifest.mjs');

export const SUBMISSION_FAILURE_MATRIX=Object.freeze({
  preSubmission:Object.freeze({submitted:false,submissionIntent:false,submissionUncertain:false,preSubmissionFailure:true}),
  confirmedUnsent:Object.freeze({submitted:false,submissionIntent:true,submissionUncertain:false,preSubmissionFailure:true}),
  uncertain:Object.freeze({submitted:true,submissionIntent:true,submissionUncertain:true,preSubmissionFailure:false}),
  submittedKnown:Object.freeze({submitted:true,submissionIntent:true,submissionUncertain:false,preSubmissionFailure:false}),
});

function quote(value){return JSON.stringify(String(value));}
function flag(value){return value?'true':'false';}

export function manifestCommand(stage,{manifestFile,helperFile=DEFAULT_HELPER,args=''}={}){
  if(!manifestFile)throw new Error('manifestFile is required');
  return `node ${quote(path.resolve(helperFile))} ${stage} --manifest-file ${quote(path.resolve(manifestFile))}${args}`;
}

function leaseCommand(stage,{manifestFile,runId,requestId,sessionName,ownedTabId,state,status,error,verification,helperFile}={}){
  if(!manifestFile)throw new Error('manifestFile is required');
  const dir=path.dirname(path.resolve(manifestFile));
  const helper=path.resolve(helperFile||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'owned-tab-lease.mjs'));
  const args=[stage,'--run-dir',dir,'--lease-file',path.join(dir,OWNED_TAB_LEASE_FILE),'--manifest-file',path.resolve(manifestFile),'--run-id',runId||path.basename(dir),...(requestId?['--request-id',requestId]:[]),...(sessionName?['--session-name',sessionName]:[]),...(ownedTabId?['--owned-tab-id',ownedTabId]:[]),...(state?['--state',state]:[]),...(status?['--status',status]:[]),...(error?['--error',error]:[]),...(verification?['--verification',verification]:[])];
  return `node ${quote(helper)} ${args.map(quote).join(' ')}`;
}

export function failureArguments({submitted,submissionIntent,submissionUncertain,preSubmissionFailure,errorCode='<错误代码>',error='<简短原始错误>'}={}){
  return ` --error-code ${quote(errorCode)} --error ${quote(error)} --submitted ${flag(Boolean(submitted))} --submission-intent ${flag(Boolean(submissionIntent))} --submission-uncertain ${flag(Boolean(submissionUncertain))} --pre-submission-failure ${flag(Boolean(preSubmissionFailure))}`;
}

export function failureCommand(manifestFile,flags){
  return manifestCommand('failed',{manifestFile,args:failureArguments(flags)});
}

export function browserHandleLostCommand(manifestFile){
  return manifestCommand('failed',{manifestFile,args:` --error-code "BROWSER_HANDLE_LOST" --error "Chrome 专用标签页句柄未能保留，无法继续执行本次上传" --submitted false --submission-intent false --submission-uncertain false --pre-submission-failure true --owned-tab-id "<returned ownedTabId or unknown>" --owned-tab-cleanup-status "<closed|close_failed|not_observed>" --kernel-reset "<true或false>"`});
}

export function buildManifestCommands(manifestFile,{helperFile=DEFAULT_HELPER,requestId=null,sessionName=null}={}){
  const command=(stage,args='')=>manifestCommand(stage,{manifestFile,helperFile,args});
  const dir=path.dirname(path.resolve(manifestFile));
  const runId=path.basename(dir);
  return Object.freeze({
    accepted:command('accepted'),
    ready:command('ready',' --conversation-url "<当前会话地址>" --reference-count <已确认附件数>'),
    submissionIntent:command('submission-intent'),
    submitted:command('submitted',' --conversation-url "<当前会话地址>" --submission-confirmed-by "new_user_message_and_stop_generation_control"'),
    downloaded:command('downloaded',' --conversation-url "<当前会话地址>"'),
    failed:command('failed',' --error-code "<错误代码>" --error "<简短原始错误>" --submitted <true或false> --submission-intent <true或false> --submission-uncertain <true或false> --pre-submission-failure <true或false>'),
    loginFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'CHATGPT_LOGIN_REQUIRED',error:'ChatGPT 登录状态不可用'}),
    navigationFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'CHATGPT_NAVIGATION_FAILED',error:'既有会话导航和同一标签页复查均未确认可用聊天输入框'}),
    uploadFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'FILE_CHOOSER_ROUTE_UNAVAILABLE',error:'附件入口或文件选择器未能完成'}),
    referenceFilesInvalid:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'REFERENCE_FILES_INVALID',error:'服务端冻结附件台账无效'}),
    browserCreateUnavailable:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'BROWSER_CREATE_UNAVAILABLE',error:'createBrowserTab 未能创建专用标签页'}),
    browserModeEntryUnavailable:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'BROWSER_MODE_ENTRY_UNAVAILABLE',error:'聊天或创建图片入口不可用'}),
    chooserEventTimeout:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'FILE_CHOOSER_EVENT_TIMEOUT',error:'filechooser 事件未在有界时间内出现'}),
    chooserRouteUnavailable:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'FILE_CHOOSER_ROUTE_UNAVAILABLE',error:'上传照片按钮和菜单 fallback 均不可用'}),
    fileSetFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'FILE_SET_FAILED',error:'文件选择器未能接收冻结附件'}),
    attachmentVerificationTimeout:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'ATTACHMENT_VERIFICATION_TIMEOUT',error:'附件数量、名称、顺序或上传状态未能核实'}),
    downloadFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.submittedKnown,errorCode:'DOWNLOAD_FAILED',error:'网页原图下载或校验失败'}),
    originPermissionDenied:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'BROWSER_ORIGIN_PERMISSION_DENIED',error:'chatgpt.com 站点源访问权限被拒绝'}),
    chromeUnavailable:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'BROWSER_CHROME_UNAVAILABLE',error:'Chrome extension 不可用'}),
    browserHandleLost:browserHandleLostCommand(manifestFile),
    ownedTabEnsure:leaseCommand('ensure',{manifestFile,runId,requestId,sessionName}),
    ownedTabReserveCreate:leaseCommand('reserve-create',{manifestFile,runId,requestId,sessionName}),
    ownedTabCreated:(ownedTabId,tabSessionName=sessionName)=>leaseCommand('stage',{manifestFile,runId,requestId,state:'created',ownedTabId,sessionName:tabSessionName}),
    ownedTabStage:(state,ownedTabId)=>leaseCommand('stage',{manifestFile,runId,requestId,state,ownedTabId}),
    ownedTabCleanup:(status,ownedTabId,error,verification='exact-owned-tab-close-returned')=>leaseCommand('cleanup',{manifestFile,runId,requestId,status,ownedTabId,error,verification}),
    focusUnavailable:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'BROWSER_FOCUS_UNAVAILABLE',error:'Chrome 专用标签页焦点能力不可用'}),
    confirmedUnsentUploadFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.confirmedUnsent,errorCode:'ATTACHMENT_VERIFICATION_TIMEOUT',error:'已记录发送意图但页面确认未发送'}),
    submissionUncertain:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.uncertain,errorCode:'SUBMISSION_UNCERTAIN',error:'点击发送后无法确认是否送达'}),
  });
}
