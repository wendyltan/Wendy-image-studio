import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
  const helper=path.resolve(helperFile||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'owned-tab-lease.mjs'));
  // The helper resolves its lease directory from this manifest and obtains
  // run/request identity from the durable lease itself.  Passing a second
  // hand-copied absolute lease path was redundant and made the worker's
  // critical created-stage command unnecessarily fragile.
  const args=[stage,'--manifest-file',path.resolve(manifestFile),...(runId?['--run-id',runId]:[]),...(requestId?['--request-id',requestId]:[]),...(sessionName?['--session-name',sessionName]:[]),...(ownedTabId?['--owned-tab-id',ownedTabId]:[]),...(state?['--state',state]:[]),...(status?['--status',status]:[]),...(error?['--error',error]:[]),...(verification?['--verification',verification]:[])];
  return `node ${quote(helper)} ${args.map(quote).join(' ')}`;
}

export function failureArguments({submitted,submissionIntent,submissionUncertain,preSubmissionFailure,errorCode='<错误代码>',error='<简短原始错误>'}={}){
  return ` --error-code ${quote(errorCode)} --error ${quote(error)} --submitted ${flag(Boolean(submitted))} --submission-intent ${flag(Boolean(submissionIntent))} --submission-uncertain ${flag(Boolean(submissionUncertain))} --pre-submission-failure ${flag(Boolean(preSubmissionFailure))}`;
}

export function failureCommand(manifestFile,flags){
  return manifestCommand('failed',{manifestFile,args:failureArguments(flags)});
}

export function browserHandleLostCommand(manifestFile){
  return manifestCommand('failed',{manifestFile,args:` --error-code "BROWSER_HANDLE_LOST" --error "Chrome 专用标签页句柄未能保留，无法继续执行本次上传" --submitted false --submission-intent false --submission-uncertain false --pre-submission-failure true --owned-tab-id "<returned ownedTabId or unknown>" --owned-tab-cleanup-status "<closed|close_failed|cleanup_pending|not_observed>" --kernel-reset "<true或false>"`});
}

export function buildManifestCommands(manifestFile,{helperFile=DEFAULT_HELPER,requestId=null,sessionName=null}={}){
  const command=(stage,args='')=>manifestCommand(stage,{manifestFile,helperFile,args});
  const dir=path.dirname(path.resolve(manifestFile));
  const runId=path.basename(dir);
  return Object.freeze({
    accepted:command('accepted'),
    ready:command('ready',' --conversation-url "<当前会话地址>" --reference-count <已确认附件数> --attachment-expected-count <冻结附件数> --attachment-observed-count <实际附件数> --attachment-pending false --send-enabled true --browser-stage "ready_to_send"'),
    submissionIntent:command('submission-intent'),
    submitted:command('submitted',' --conversation-url "<当前会话地址>" --submission-confirmed-by "new_user_message_and_stop_generation_control"'),
    downloaded:command('downloaded',' --conversation-url "<当前会话地址>"'),
    nativeDownloadRecovery:command('native-download-recovery',' --native-evidence-file "<当前制作记录目录>/native-download-evidence.json"'),
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
    workerScriptRuntimeError:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'WORKER_SCRIPT_RUNTIME_ERROR',error:'浏览器执行脚本发生运行时错误'}),
    executorRuntimeError:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'EXECUTOR_RUNTIME_ERROR',error:'网页执行器发生运行时错误'}),
    downloadFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.submittedKnown,errorCode:'DOWNLOAD_FAILED',error:'网页原图下载或校验失败'}),
    originPermissionDenied:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'BROWSER_ORIGIN_PERMISSION_DENIED',error:'chatgpt.com 站点源访问权限被拒绝'}),
    chromeUnavailable:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'BROWSER_CHROME_UNAVAILABLE',error:'Chrome extension 不可用'}),
    browserHandleLost:browserHandleLostCommand(manifestFile),
    ownedTabStageWriteFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'OWNED_TAB_STAGE_WRITE_FAILED',error:'本地 owned tab lease 阶段记录命令失败；已停止网页动作'}),
    ownedTabEnsure:leaseCommand('ensure',{manifestFile,runId,requestId,sessionName}),
    ownedTabReserveCreate:leaseCommand('reserve-create',{manifestFile,runId,requestId,sessionName}),
    ownedTabCreated:(ownedTabId,tabSessionName=sessionName)=>leaseCommand('stage',{manifestFile,state:'created',ownedTabId,sessionName:tabSessionName}),
    ownedTabStage:(state,ownedTabId)=>leaseCommand('stage',{manifestFile,state,ownedTabId}),
    ownedTabCleanup:(status,ownedTabId,error,verification)=>leaseCommand('cleanup',{manifestFile,status,ownedTabId,error,verification:verification??(status==='closed'?'exact-owned-tab-close-returned':'')}),
    focusUnavailable:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.preSubmission,errorCode:'BROWSER_FOCUS_UNAVAILABLE',error:'Chrome 专用标签页焦点能力不可用'}),
    confirmedUnsentUploadFailed:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.confirmedUnsent,errorCode:'ATTACHMENT_VERIFICATION_TIMEOUT',error:'已记录发送意图但页面确认未发送'}),
    submissionUncertain:failureCommand(manifestFile,{...SUBMISSION_FAILURE_MATRIX.uncertain,errorCode:'SUBMISSION_UNCERTAIN',error:'点击发送后无法确认是否送达'}),
  });
}
