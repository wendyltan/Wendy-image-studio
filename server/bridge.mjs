import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import readline from 'node:readline';
import {APP} from './workflow.mjs';
import {finalizeOwnedTabLease,readOwnedTabLease,syncOwnedTabLeaseToManifest} from './owned-tab-lease.mjs';

const IMAGE_PATH = /(?:^|[\s"'`(])((?:\/[^\n<>"'`]+?)\.(?:png|webp|jpe?g))(?:$|[\s"'`,)])/gi;
const EXECUTOR_RUNTIME_ERROR_FILE = 'executor-runtime-error.json';
const BROWSER_TOOL_BUDGET_FILE = 'browser-tool-budget.json';
export const BROWSER_TOOL_CLEANUP_CALL_BUDGET = 1;
// The browser executor needs a small, explicit budget for each lifecycle
// phase.  A single total counter used to kill the normal attachment
// verification call before submission.  Keep the limits finite, but let the
// normal create -> upload -> send -> download path finish without making
// every page observation compete with every other phase.
export const BROWSER_TOOL_STAGE_BUDGETS = Object.freeze({
  bootstrap: 3,
  upload: 2,
  submit: 1,
  wait_download: 2,
  total: 8,
});
// Kept as the compatibility name for callers that only need the business
// budget.  The cleanup slot is tracked separately and is never a ninth
// business call.
export const BROWSER_TOOL_BUSINESS_CALL_BUDGET = BROWSER_TOOL_STAGE_BUDGETS.total;
export const BROWSER_TOOL_CALL_BUDGET = BROWSER_TOOL_BUSINESS_CALL_BUDGET;
export const BROWSER_CLEANUP_MARKER = 'WENDI_OWNED_TAB_CLEANUP_V1';
const MAX_EVENT_TEXT = 4096;
const MAX_ERROR_TEXT = 1200;
const CLEAR_NO_IMAGE = /(?:未产生(?:任何)?图片|未产出(?:任何)?图片|未能生成(?:图片)?|没有生成(?:替代品|图片)|没有(?:任何)?图片(?:产出|生成)?|目标路径尚不存在|未写入目标路径|Browser is not available:\s*(?:iab|chrome)|隐藏\s*IAB.*不可用|BROWSER_(?:FOCUS|TAB_BACKGROUND|CHROME)_(?:UNAVAILABLE|RESTORE_FAILED)|BROWSER_ORIGIN_PERMISSION_DENIED|The user declined permission(?: for this action)?|Browser use cannot access\s+https?:\/\/chatgpt\.com\b[^\n]*(?:denied permission|permission denied)|https?:\/\/chatgpt\.com\b[^\n]*browser security policy|browser security policy[^\n]*https?:\/\/chatgpt\.com\b|browser security policy|Chrome management capability is not advertised|焦点(?:恢复|管理)能力(?:不可用|未提供|未广告)|无法恢复创作室焦点|no image (?:was )?(?:generated|produced|created)|image generation (?:did not|failed to) (?:produce|create))/i;
const NETWORK_INTERRUPTION = /(?:network|connection|connect(?:ion)? (?:reset|refused|failed|closed)|websocket|tls|ssl|tunnel|econn(?:reset|refused|timeout)|enotfound|连接(?:错误|中断|失败|超时)?|网络(?:错误|中断|失败|超时)?|代理|隧道)/i;

function eventObjects(value){
  if(Array.isArray(value))return value.flatMap(eventObjects);
  if(typeof value==='string')return value.split('\n').flatMap(line=>{try{return line.trim()?eventObjects(JSON.parse(line)):[];}catch{return line.trim()?[{message:line}]:[];}});
  return value&&typeof value==='object'?[value]:[];
}
function eventText(events=[]){
  return eventObjects(events).map(event=>{
    try{return JSON.stringify(event);}catch{return '';}
  }).filter(Boolean).join('\n');
}
function stringFields(value, out=[]){
  if(Array.isArray(value)){for(const item of value)stringFields(item,out);return out;}
  if(!value||typeof value!=='object')return out;
  for(const [key,item] of Object.entries(value)){
    if(typeof item==='string'&&/(?:path|file|image|output|text|message|error|content)$/i.test(key))out.push(item);
    else if(item&&typeof item==='object')stringFields(item,out);
  }
  return out;
}
function imagePathsFromText(text=''){
  const paths=[];IMAGE_PATH.lastIndex=0;
  for(const match of String(text).matchAll(IMAGE_PATH))paths.push(match[1]);
  return [...new Set(paths)];
}
function identifier(events, keys){
  for(const event of eventObjects(events)){
    for(const key of keys){
      const value=event?.[key]??event?.item?.[key]??event?.result?.[key];
      if(typeof value==='string'&&value.length<=200)return value;
    }
  }
  return null;
}

function redactRuntimeText(value, max=MAX_ERROR_TEXT){
  return String(value ?? '')
    .replace(/[\r\n\t]+/g,' ')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,'[image-data-redacted]')
    .replace(/(?:file:\/\/|https?:\/\/|\/Volumes\/|\/Users\/|\/private\/|[A-Za-z]:[\\/])[^\s"'<>]+/g,'[path-redacted]')
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'[id-redacted]')
    .replace(/\s{2,}/g,' ')
    .trim()
    .slice(0,max);
}

function compactEvent(value){
  if(typeof value==='string'){
    if(/data:image\/[a-z0-9.+-]+;base64,/i.test(value))return redactRuntimeText(value,MAX_EVENT_TEXT).replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,'[image-data-redacted]');
    if(value.length>MAX_EVENT_TEXT)return `${value.slice(0,MAX_EVENT_TEXT)}…[truncated ${value.length-MAX_EVENT_TEXT} chars]`;
    return value;
  }
  if(Array.isArray(value))return value.map(item=>compactEvent(item));
  if(!value||typeof value!=='object')return value;
  const output={};
  for(const [name,item] of Object.entries(value)){
    if(['resultText','error','message','stderr'].includes(name)&&typeof item==='string'){
      output[name]=redactRuntimeText(item,MAX_EVENT_TEXT);
      continue;
    }
    if(name==='screenshot'&&item&&typeof item==='object'){
      const pageUrl=item.pageUrl||item.url||null;
      output[name]={pageUrl:typeof pageUrl==='string'&&/^data:image\//i.test(pageUrl)?`[image-data-redacted:${pageUrl.length} chars]`:pageUrl,tabId:item.tabId||null,omitted:true};
      continue;
    }
    if(name==='url'&&typeof item==='string'&&/^data:image\//i.test(item)){
      output[name]=`[image-data-redacted:${item.length} chars]`;
      continue;
    }
    output[name]=compactEvent(item);
  }
  return output;
}

const READINESS_CHECK_KEYS=['targetUrlMatches','loginRequired','profileLoaded','chatModeActive','composerEnabled','attachmentEntryEnabled','imageCreationAvailable'];
function extractBrowserReadinessEvidence(event){
  const item=event?.item;
  if(event?.type!=='item.completed'||item?.type!=='mcp_tool_call'||item.server!=='cua_repl'||item.tool!=='js')return null;
  const texts=[];
  if(typeof item.resultText==='string')texts.push(item.resultText);
  for(const block of item.result?.content||[])if(block?.type==='text'&&typeof block.text==='string')texts.push(block.text);
  const lines=texts.flatMap(text=>text.split(/\r?\n/));
  const markerLines=lines.filter(line=>line.includes('WENDI_BROWSER_READY_V1'));
  if(markerLines.length!==1)return null;
  const markerLine=markerLines[0].trim(),match=markerLine.match(/^WENDI_BROWSER_READY_V1:(\{[^\n]*\})$/);
  if(!match||Buffer.byteLength(match[1],'utf8')>1800)return null;
  let value;
  try{value=JSON.parse(match[1]);}catch{return null;}
  const safeUrl=input=>{
    if(typeof input!=='string'||input.length>500)return null;
    try{const url=new URL(input);return url.protocol==='https:'&&url.hostname==='chatgpt.com'&&!url.username&&!url.password?url.href:null;}catch{return null;}
  };
  const currentUrl=safeUrl(value?.currentUrl),expectedUrl=safeUrl(value?.expectedUrl);
  if(value?.marker!=='WENDI_BROWSER_READY_V1'||value?.schemaVersion!==1||value?.ready!==true||typeof value?.runId!=='string'||!value.runId||value.runId.length>200||typeof value?.ownedTabId!=='string'||!value.ownedTabId||value.ownedTabId.length>200||!currentUrl||!expectedUrl||value.imageCreationPath!=='chat-composer')return null;
  if(!value.checks||READINESS_CHECK_KEYS.some(key=>typeof value.checks[key]!=='boolean'))return null;
  const checks=Object.fromEntries(READINESS_CHECK_KEYS.map(key=>[key,value.checks[key]]));
  const code=typeof item.arguments?.code==='string'?item.arguments.code:'';
  const count=pattern=>(code.match(pattern)||[]).length;
  const sourceChecks={gateMarkerPresent:code.includes('WENDI_BROWSER_READINESS_GATE_V1'),gotoCount:count(/\.goto\s*\(/g),createTabCount:count(/\bcua\.createBrowserTab\s*\(/g),axReadCount:count(/\.getAXState\s*\(/g),urlReadCount:count(/\.url\s*\(/g),getTabCount:count(/\bcua\.getTab\s*\(/g),setFilesCount:count(/\.setFiles\s*\(/g),clickCount:count(/\.click\s*\(/g),pasteCount:count(/\.paste\s*\(/g),setValueCount:count(/\.setValue\s*\(/g),typeTextCount:count(/\.typeText\s*\(/g),pressKeyCount:count(/\.pressKey\s*\(/g),checkCount:count(/\.check\s*\(/g),ownedHandleReferencePresent:code.includes('globalThis.__wendiOwnedTab')&&code.includes('globalThis.__wendiOwnedTabId')};
  return {complete:true,source:'cua_completed_result',marker:'WENDI_BROWSER_READY_V1',schemaVersion:1,ready:true,runId:value.runId,ownedTabId:value.ownedTabId,currentUrl,expectedUrl,imageCreationPath:'chat-composer',checks,sourceChecks};
}

function boundedEvent(value){
  const compact=compactEvent(value);
  const readiness=extractBrowserReadinessEvidence(value);
  if(readiness&&compact?.item&&typeof compact.item==='object')compact.item.browserReadinessEvidence=readiness;
  const serialized=JSON.stringify(compact);
  if(Buffer.byteLength(serialized||'null','utf8')<=MAX_EVENT_TEXT)return compact;
  const item=compact&&typeof compact==='object'&&!Array.isArray(compact)?compact.item:null;
  const summary={type:compact&&typeof compact==='object'&&!Array.isArray(compact)?compact.type:null,truncated:true,originalBytes:Buffer.byteLength(serialized||'null','utf8')};
  if(item&&typeof item==='object'){
    summary.item={id:item.id||null,type:item.type||null,server:item.server||null,tool:item.tool||item.name||null};
    const timeoutMs=item.arguments?.timeout_ms;
    if(Number.isSafeInteger(timeoutMs)&&timeoutMs>=0&&timeoutMs<=300000)summary.item.timeout_ms=timeoutMs;
    if(item.browserReadinessEvidence?.complete===true&&item.browserReadinessEvidence?.source==='cua_completed_result')summary.item.browserReadinessEvidence=item.browserReadinessEvidence;
    const code=item.arguments?.code||item.arguments?.command;
    if(code)summary.item.code=redactRuntimeText(code,800);
    const text=(typeof item.resultText==='string'?item.resultText:(item.result?.content||[]).filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join(' '));
    const boundedText=redactRuntimeText(text,800);
    if(boundedText)summary.item.resultText=boundedText;
  } else if(compact&&typeof compact==='object'&&!Array.isArray(compact)){
    for(const key of ['message','error','stderr','text'])if(compact[key])summary[key]=redactRuntimeText(compact[key],800);
  }
  if(Buffer.byteLength(JSON.stringify(summary),'utf8')<=MAX_EVENT_TEXT)return summary;
  return {type:summary.type||'event',truncated:true,originalBytes:summary.originalBytes};
}

function persistLatestBrowserReadiness(dir,event){
  const item=event?.item;
  if(event?.type!=='item.completed'||item?.type!=='mcp_tool_call'||item.server!=='cua_repl'||item.tool!=='js')return true;
  const file=path.join(path.resolve(String(dir||'')),'browser-readiness-latest.json');
  const temp=`${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const record={schemaVersion:1,source:'bridge_cua_completed_item',eventType:'item.completed',itemId:String(item.id||event.item_id||''),server:'cua_repl',tool:'js',browserReadinessEvidence:extractBrowserReadinessEvidence(event)};
  try{
    fs.writeFileSync(temp,JSON.stringify(record),{mode:0o600,flag:'wx'});
    fs.renameSync(temp,file);
    fs.chmodSync(file,0o600);
    return true;
  }catch{
    try{fs.unlinkSync(temp);}catch{}
    try{fs.unlinkSync(file);}catch{}
    return false;
  }
}

function boundedEventLine(value){
  const line=JSON.stringify(boundedEvent(value));
  // boundedEvent always returns a small object, but keep the invariant local
  // to the persistence boundary in case a future summary adds a large field.
  if(Buffer.byteLength(line,'utf8')<=MAX_EVENT_TEXT)return line;
  return JSON.stringify({type:'event',truncated:true,originalBytes:Buffer.byteLength(line,'utf8')});
}

function compactResponseFile(file){
  if(!file||!fs.existsSync(file))return '';
  const original=fs.readFileSync(file,'utf8');
  const compact=original
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,match=>`[image-data-redacted:${match.length} chars]`)
    .replace(/[A-Za-z0-9+/=]{1024,}/g,match=>`[binary-data-redacted:${match.length} chars]`);
  if(compact!==original)fs.writeFileSync(file,compact,{mode:0o600});
  return compact;
}

function browserToolCallInfo(event,{dir,cleanupCallUsed=false,runIdOverride=null}={}){
  const item=event?.item&&typeof event.item==='object'?event.item:event&&typeof event==='object'?event:{};
  if(item.type!=='mcp_tool_call')return null;
  const namespace=[item.server,item.serverName,event?.server,event?.serverName,item.tool,item.name,event?.tool].filter(Boolean).join(' ');
  const tool=String(item.tool||item.name||event?.tool||'').toLowerCase();
  const isBrowserNamespace=/(?:mcp__)?cua[_-]?repl|browser(?:[_-]?use)?|computer[_-]?use/i.test(namespace);
  const isBrowserTool=/^(?:js|browser|computer(?:[_-]?use)?)$/i.test(tool);
  if(!isBrowserNamespace||!isBrowserTool)return null;
  const type=String(event?.type||'').toLowerCase();
  const source=String(item.arguments?.code||item.arguments?.command||'');
  // cua_repl requires its first call after a reset to initialize the runtime
  // with one standalone getState(). It reads surface metadata but performs no
  // browser action, so give exactly one such call a separately audited slot.
  // Repeated getState calls are charged to the normal bootstrap budget.
  const runtimeInitialization= /^\s*await\s+cua\.getState\(\)\s*;?\s*$/.test(source);
  // A CUA namespace can also be used by the executor to run a local manifest
  // helper.  That helper is an accounting/state write, not a browser action;
  // do not spend a browser slot on a call which contains no CUA/tab operation.
  // If the same script also touches the owned tab, it remains a real browser
  // call and is counted normally.
  const manifestOnly=/(?:nodeRepl\.(?:exec|write)|run-manifest\.mjs|owned-tab-lease\.mjs)/i.test(source)
    && !/(?:\bcua\.[A-Za-z_$][\w$]*|\b(?:tab|globalThis\.__wendiOwnedTab)\s*\.|createBrowserTab|filechooser|pageAssets|\.getByRole\(|\.locator\()/i.test(source);
  if(manifestOnly)return null;
  const closeLike=/(?:globalThis\.__wendiOwnedTab|__wendiOwnedTab|\btab)\s*\.\s*close\s*\(/i.test(source);
  const singleClose=(source.match(/\.\s*close\s*\(/gi)||[]).length===1;
  const currentOwnedHandle=/(?:const|let|var)\s+tab\s*=\s*globalThis\.__wendiOwnedTab\b/.test(source)
    ||/globalThis\.__wendiOwnedTab\s*\.\s*close\s*\(/.test(source);
  const reportsOwnedId=/globalThis\.__wendiOwnedTabId\b/.test(source);
  const mixedBrowserAction=/(?:\bcua\s*\.|\b(?:createBrowserTab|getTab|listTabs)\s*\(|\btab\s*\.\s*(?:goto|click|reload|back|forward|url|playwright|capabilities)\b|\.\s*(?:setFiles|waitForChooser|waitForEvent|click)\s*\(|pageAssets|filechooser)/i.test(source);
  const closeOnlySource=closeLike&&singleClose&&currentOwnedHandle&&reportsOwnedId&&!mixedBrowserAction;
  const fixedCleanup=source.includes(BROWSER_CLEANUP_MARKER)&&closeOnlySource&&/(?:--state[^\n]{0,120}closing|ownedTabStage[^\n]*closing|cleanup-status|\bfinally\b)/i.test(source);
  let lease=null;
  try{lease=dir?readOwnedTabLease(dir):null;}catch{}
  const runId=String(runIdOverride||path.basename(path.resolve(String(dir||''))));
  const leaseRunMatches=Boolean(lease?.runId)&&lease.runId===runId;
  const sourceRunId=source.match(/--run-id\s+(?:"([^"]+)"|'([^']+)'|([^\s;,)]+))/i)?.slice(1).find(Boolean)||source.match(/--run-id["']\s*,\s*["']([^"']+)/i)?.[1]||source.match(/\b(?:const|let)\s+runId\s*=\s*["']([^"']+)["']/)?.[1]||null;
  const sourceRunMatches=Boolean(sourceRunId&&sourceRunId===runId);
  const leaseOwnedTabId=String(lease?.ownedTabId||'');
  const sourceOwnedTabId=source.match(/--owned-tab-id\s+(?:"([^"]+)"|'([^']+)'|([^\s;,)]+))/i)?.slice(1).find(Boolean)||source.match(/--owned-tab-id["']\s*,\s*["']([^"']+)/i)?.[1]||source.match(/\bownedTabId\s*!==\s*["']([^"']+)["']/)?.[1]||null;
  const ownedTabMatches=Boolean(leaseOwnedTabId&&sourceOwnedTabId&&leaseOwnedTabId===sourceOwnedTabId);
  const cleanupCandidate=fixedCleanup&&closeLike;
  const leaseIsClosing=lease?.state==='closing'&&leaseRunMatches&&Boolean(leaseOwnedTabId);
  const explicitCleanupIdentity=sourceRunMatches&&ownedTabMatches;
  const cleanupAuthorized=cleanupCandidate&&leaseIsClosing&&explicitCleanupIdentity&&!cleanupCallUsed;
  const manifestState=manifestBrowserState(dir);
  return {id:String(item.id||event?.item_id||event?.id||''),phase:type.includes('started')?'started':type.includes('completed')?'completed':'other',kind:runtimeInitialization?'initialization':cleanupAuthorized?'cleanup':cleanupCandidate?'deferred_cleanup':'business',stage:browserToolBusinessStage(source,'bootstrap',{leaseState:lease?.state||null,manifestState,submissionIntentObserved:manifestHasSubmissionIntent(dir)}),closeLike,fixedCleanup,cleanupCandidate,leaseState:lease?.state||null,manifestState,leaseRunMatches,sourceRunMatches,ownedTabMatches,ownedTabId:leaseOwnedTabId||null};
}

function eventContainsSubmissionIntent(event){
  if(!String(event?.type||'').includes('completed'))return false;
  const item=event?.item&&typeof event.item==='object'?event.item:{};
  const command=String(item.command||item.arguments?.command||'');
  if(item.type!=='command_execution'||!/\brun-manifest\.mjs\s+submission-intent\b/.test(command))return false;
  const fields=[item.result?.structured_content,item.aggregated_output,...(item.result?.content||[]).filter(block=>block?.type==='text').map(block=>block.text)].filter(Boolean);
  for(const field of fields){
    if(field&&typeof field==='object'&&(field.submissionIntent===true||field.manifest?.submissionIntent===true))return true;
    if(typeof field==='string'){
      try{const parsed=JSON.parse(field);if(parsed?.submissionIntent===true||parsed?.manifest?.submissionIntent===true)return true;}catch{}
      if(/submission_intent_recorded\s*[:=]\s*true/i.test(field))return true;
    }
  }
  return false;
}

function manifestHasSubmissionIntent(dir){
  try{
    const value=JSON.parse(fs.readFileSync(path.join(dir,'web-generation.json'),'utf8'));
    return value?.submissionIntent===true||value?.state==='submitted'||value?.submitted===true;
  }catch{return false;}
}

function manifestBrowserState(dir){
  try{return String(JSON.parse(fs.readFileSync(path.join(dir,'web-generation.json'),'utf8'))?.state||'');}
  catch{return '';}
}

function sourceCallCount(source,pattern){return (String(source||'').match(pattern)||[]).length;}

function writeBrowserToolBudget(dir,value={}){
  if(!dir||!value)return null;
  const record={schemaVersion:2,errorCode:'BROWSER_TOOL_BUDGET_EXCEEDED',limit:BROWSER_TOOL_BUSINESS_CALL_BUDGET,businessLimit:BROWSER_TOOL_BUSINESS_CALL_BUDGET,cleanupLimit:BROWSER_TOOL_CLEANUP_CALL_BUDGET,stageBudgets:BROWSER_TOOL_STAGE_BUDGETS,observed:Number(value.observed)||0,observedBusiness:Number(value.observedBusiness)||0,observedCleanup:Number(value.observedCleanup)||0,stageCounts:value.stageCounts&&typeof value.stageCounts==='object'?{...value.stageCounts}:{},budgetKind:value.budgetKind||'business',stageName:value.stageName||null,stageLimit:Number(value.stageLimit)||null,stageCount:Number(value.stageCount)||null,protectedAction:value.protectedAction||null,submissionIntentObserved:value.submissionIntentObserved===true,stage:value.submissionIntentObserved===true?'post_submission_intent':'pre_submission_intent',terminationDeferred:value.terminationDeferred===true,terminationRequestedAt:new Date().toISOString()};
  try{
    const file=path.join(dir,BROWSER_TOOL_BUDGET_FILE),temp=`${file}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(temp,JSON.stringify(record,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);return record;
  }catch{return null;}
}

export function readBrowserToolBudget(dir){
  try{return JSON.parse(fs.readFileSync(path.join(dir,BROWSER_TOOL_BUDGET_FILE),'utf8'));}catch{return null;}
}

export function browserToolStage(value,lifecycle={}){
  const source=typeof value==='string'?value:JSON.stringify(value||{});
  if(/close\(\)/i.test(source))return 'cleanup';
  // Only a real send action outranks the persisted lifecycle stage. Text in
  // diagnostics, AX matchers, and the frozen prompt is not an action.
  const enterSubmit=/(?:pressKey|press)\([^)]*(?:Enter|Return)\)/i.test(source);
  // Do not treat an arbitrary locator click as sending.  Upload fallback
  // necessarily clicks the plus button and the menu item before it receives a
  // filechooser.  Only a named send control (or an explicitly named submit
  // handle) is a submission action.
  const namedSendHandle=/(?:\b(?:send|submit|sendButton|submitButton|composerSubmit)\b\s*\.\s*(?:click|press)\s*\()/i.test(source);
  const roleSendClick=/getByRole\(\s*['"]button['"][^)]*(?:发送提示词|composer-submit-button)[^)]*\)\s*\.\s*(?:click|press)\s*\(/i.test(source);
  const locatorSendClick=/locator\(\s*['"]#(?:composer-submit-button|send-button)['"]\s*\)\s*\.\s*(?:click|press)\s*\(/i.test(source);
  const sendButtonClick=namedSendHandle||roleSendClick||locatorSendClick;
  if(enterSubmit||sendButtonClick)return 'submit';
  const leaseState=String(lifecycle?.leaseState||'');
  const manifestState=String(lifecycle?.manifestState||'');
  // Durable stages own normal business-call classification. This prevents
  // words in read-only page checks (for example prompt-textarea/composer or
  // an uploading label) from spending the later upload/send budgets.
  if(['sent','generating','downloaded'].includes(leaseState)||['submitted','downloaded'].includes(manifestState))return 'wait_download';
  if(manifestState==='ready'||lifecycle?.submissionIntentObserved===true)return 'submit';
  if(['uploading','uploaded'].includes(leaseState))return 'upload';
  if(['creating','created'].includes(leaseState))return 'bootstrap';
  if(/pageAssets|\.bundle\(|\.list\(\)|download-evidence|下载原图|生成结果|停止生成|等待生成/i.test(source))return 'wait_download';
  if(/setFiles\s*\(|waitForEvent\s*\(\s*["']filechooser["']|filechooser|\.fill\s*\(|\.paste\s*\(/i.test(source))return 'upload';
  if(/createBrowserTab|\.goto\(|waitForLoadState|getAXState|聊天模式|创建图片|composer|登录/i.test(source))return 'bootstrap';
  return 'bootstrap';
}

function browserToolBusinessStage(source, fallback='bootstrap',lifecycle={}){
  const stage=browserToolStage(source,lifecycle);
  return stage==='cleanup'?'bootstrap':(Object.prototype.hasOwnProperty.call(BROWSER_TOOL_STAGE_BUDGETS,stage)?stage:fallback);
}

function runtimeCandidate(event){
  const item=event?.item||{};
  if(String(event?.type||'').includes('completed')&&item.type==='command_execution'){
    const helperOutput=String(item.aggregated_output||item.output||'');
    try{if(JSON.parse(helperOutput)?.ok===true)return null;}catch{}
  }
  const rawError=item.error||event.error||event.message||event.error?.message;
  const textCandidates=[];
  if(rawError)textCandidates.push(typeof rawError==='string'?rawError:rawError.message||rawError.stack||JSON.stringify(rawError));
  if(String(event?.type||'').includes('completed')&&item.server==='cua_repl'&&item.tool==='js'&&typeof item.resultText==='string')textCandidates.push(item.resultText);
  for(const key of ['aggregated_output','output','stdout','stderr'])if(typeof item[key]==='string')textCandidates.push(item[key]);
  for(const block of item.result?.content||[])if(block?.type==='text'&&typeof block.text==='string')textCandidates.push(block.text);
  const raw=textCandidates.find(value=>/(?:ReferenceError|TypeError|SyntaxError|RangeError|Playwright selector deadline exceeded|js execution timed out|kernel reset|is not defined|not a function|WORKER_SCRIPT_RUNTIME_ERROR|EXECUTOR_RUNTIME_ERROR|BROWSER_HANDLE_LOST)/i.test(String(value)))||'';
  if(!raw)return null;
  const source=String(raw);
  const match=source.match(/(ReferenceError|TypeError|SyntaxError|RangeError|Error)\s*:\s*([^\n]+)/i);
  const category=/Playwright selector deadline exceeded|js execution timed out|kernel reset/i.test(source)?'browser_action_failure':match?.[1] ? 'javascript_runtime' : 'executor_error';
  const browserBudgetStage=browserToolBusinessStage(source);
  return {
    schemaVersion:1,
    category,
    message:redactRuntimeText(match?`${match[1]}: ${match[2]}`:source),
    stack:redactRuntimeText(raw,2400),
    // Keep the historical runtime-error contract: this is an executor
    // failure, not a browser lifecycle stage. The budget classifier gets its
    // own field so diagnostics can still say which phase was active.
    toolStage:'executor',
    browserBudgetStage,
    source:item.server||item.type||event.type||'executor',
  };
}

export function writeExecutorRuntimeError(dir,value={}){
  if(!dir||!value)return null;
  const record={schemaVersion:1,category:redactRuntimeText(value.category,120),message:redactRuntimeText(value.message),stack:redactRuntimeText(value.stack,2400),toolStage:redactRuntimeText(value.toolStage||'executor',120),...(value.browserBudgetStage?{browserBudgetStage:redactRuntimeText(value.browserBudgetStage,120)}:{}),source:redactRuntimeText(value.source,120),capturedAt:new Date().toISOString()};
  try{
    const file=path.join(dir,EXECUTOR_RUNTIME_ERROR_FILE),temp=`${file}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(temp,JSON.stringify(record,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);return record;
  }catch{return null;}
}

export function readExecutorRuntimeError(dir){
  try{return JSON.parse(fs.readFileSync(path.join(dir,EXECUTOR_RUNTIME_ERROR_FILE),'utf8'));}catch{return null;}
}

/**
 * Classify only the evidence returned by one CLI run. Callers must still check
 * that a reported image path exists before treating it as a saved artifact.
 */
export function classifyGenerationEvidence({events=[],responseText='',runId=null,startedAt=null,endedAt=null,exitCode=null}={}){
  const normalizedEvents=eventObjects(events);
  const evidenceText=[responseText,eventText(normalizedEvents),...normalizedEvents.flatMap(event=>stringFields(event))].filter(Boolean).join('\n');
  const imagePaths=[...new Set([
    ...imagePathsFromText(responseText),
    ...normalizedEvents.flatMap(event=>imagePathsFromText(stringFields(event).join('\n'))),
  ])];
  const threadId=identifier(normalizedEvents,['thread_id','threadId','thread']);
  const eventRunId=identifier(normalizedEvents,['run_id','runId','turn_id','turnId']);
  const clearNoImage=CLEAR_NO_IMAGE.test(evidenceText);
  const networkInterrupted=NETWORK_INTERRUPTION.test(evidenceText);
  // A connection error can arrive after the provider has completed the image.
  // Natural-language claims about "no image" do not make that state certain.
  const outcome=imagePaths.length?'image_path_reported':networkInterrupted?'network_interrupted':clearNoImage?'no_image':'unknown';
  const reason=outcome==='image_path_reported'?'reported_image_path':outcome==='no_image'?'reported_no_image':outcome==='network_interrupted'?'connection_interrupted':'insufficient_evidence';
  return {
    outcome,
    reason,
    imagePaths,
    connectionRelated:networkInterrupted,
    runId:eventRunId||runId||null,
    threadId,
    startedAt:startedAt||null,
    endedAt:endedAt||null,
    exitCode:Number.isInteger(exitCode)?exitCode:null,
  };
}

/** A concise, path-free record suitable for project task diagnostics. */
export function generationDiagnosticSummary(evidence={}){
  return {
    outcome:evidence.outcome||'unknown',
    reason:evidence.reason||'insufficient_evidence',
    connectionRelated:Boolean(evidence.connectionRelated),
    reportedImageCount:Array.isArray(evidence.imagePaths)?evidence.imagePaths.length:0,
    runId:evidence.runId||null,
    threadId:evidence.threadId||null,
    startedAt:evidence.startedAt||null,
    endedAt:evidence.endedAt||null,
    exitCode:Number.isInteger(evidence.exitCode)?evidence.exitCode:null,
  };
}

export function readGenerationEvidence(dir){
  const eventsFile=path.join(dir,'events.jsonl'),responseFile=path.join(dir,'response.txt');
  const events=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,'utf8'):'';
  const responseText=fs.existsSync(responseFile)?fs.readFileSync(responseFile,'utf8'):'';
  return classifyGenerationEvidence({events,responseText,runId:path.basename(dir)});
}
export function findCodex() {
  if (process.env.WENDI_CODEX_BIN && fs.existsSync(process.env.WENDI_CODEX_BIN)) return process.env.WENDI_CODEX_BIN;
  for (const p of ['/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex']) if(fs.existsSync(p))return p;
  try { return execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim(); } catch {return null;}
}
export function python() {
  for(const p of [process.env.WENDI_PYTHON,'/Library/Frameworks/Python.framework/Versions/3.10/bin/python3','/opt/homebrew/bin/python3','/usr/bin/python3'].filter(Boolean)) if(fs.existsSync(p))return p;
  throw new Error('没有找到本地图像排版工具。');
}
export function pythonRun(args) {
  return new Promise((resolve,reject)=>{
    const p=spawn(python(),[path.join(APP,'server/compose.py'),...args],{stdio:['ignore','pipe','pipe']});
    let out='',err=''; p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);
    p.on('error',reject);p.on('close',code=>{
      if(code===0){resolve(out);return;}
      const last=err.trim().split('\n').map(line=>line.trim()).filter(Boolean).at(-1)||'图片排版未完成';
      reject(new Error(last.replace(/^[\w.]+(?:Error|Exception):\s*/,'')||'图片排版未完成'));
    });
  });
}
export async function connectionStatus() {
  const bin=findCodex();
  if(!bin)return {ready:false,message:'请先打开 Codex 并登录一次。'};
  return new Promise(resolve=>{
    const p=spawn(bin,['login','status'],{stdio:['ignore','pipe','pipe']});let out='';
    const timer=setTimeout(()=>{p.kill();resolve({ready:false,message:'暂时无法确认登录，请重新打开 Codex。'});},10000);
    for(const stream of [p.stdout,p.stderr])stream.on('data',c=>out+=c);
    p.on('error',()=>{clearTimeout(timer);resolve({ready:false,message:'创作连接暂不可用。'});});
    p.on('close',code=>{clearTimeout(timer);resolve({ready:code===0 && /Logged in/i.test(out),message:code===0?'已连接你的创作账号':'请先打开 Codex 并登录一次。'});});
  });
}
export function appServerSnapshot(timeoutMs=8000) {
  if(process.env.WENDI_TEST_PLAN_FILE)return Promise.resolve({models:[{id:'fixture-model',displayName:'Fixture Model',defaultReasoningEffort:'low',supportedReasoningEfforts:['low'],isDefault:true}],rateLimits:{primary:{usedPercent:1}},usage:null});
  const bin=findCodex();
  if(!bin)return Promise.resolve({models:[],rateLimits:null,usage:null,error:'请先打开 Codex 并登录一次。'});
  return new Promise(resolve=>{
    const child=spawn(bin,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],env:{...process.env,NO_COLOR:'1'}});
    const rl=readline.createInterface({input:child.stdout});
    const found={models:null,rateLimits:null,usage:null};let settled=false;
    const finish=(extra={})=>{if(settled)return;settled=true;clearTimeout(timer);rl.close();child.kill('SIGTERM');resolve({...found,...extra});};
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    rl.on('line',line=>{try{
      const msg=JSON.parse(line);
      if(msg.id===0&&msg.result){
        send({method:'initialized',params:{}});
        send({method:'model/list',id:1,params:{limit:50,includeHidden:false}});
        send({method:'account/rateLimits/read',id:2});
        send({method:'account/usage/read',id:3});
      } else if(msg.id===1) found.models=msg.result?.data||[];
      else if(msg.id===2) found.rateLimits=msg.result||null;
      else if(msg.id===3) found.usage=msg.result||null;
      if(found.models!==null&&found.rateLimits!==null&&found.usage!==null)finish({status:'fresh'});
    }catch{}});
    child.on('error',err=>finish({error:'无法读取创作账户：'+err.message}));
    child.on('close',code=>{if(!settled)finish({error:code===0?'创作账户信息暂不可用。':'创作账户连接中断。'});});
    const timer=setTimeout(()=>finish({status:'stale',error:'读取创作账户信息超时，可稍后刷新。'}),timeoutMs);
    send({method:'initialize',id:0,params:{clientInfo:{name:'wendi_studio',title:'温蒂创作室',version:'2.0.0'}}});
  });
}
export function extractRateLimits(value){
  const response=value?.rateLimits??value;
  if(response?.rateLimitsByLimitId?.codex)return response.rateLimitsByLimitId.codex;
  if(response?.rateLimits)return response.rateLimits;
  if(response?.primary||response?.secondary)return response;
  return response&&typeof response==='object'&&Object.values(response).some(item=>item&&typeof item==='object'&&('usedPercent' in item||'windowDurationMins' in item))?response:null;
}
function rawRateLimitBuckets(value){
  if(!value||typeof value!=='object')return {};
  const response=value.rateLimits&&typeof value.rateLimits==='object'?value.rateLimits:value;
  const byLimitId=value.rateLimitsByLimitId||value.byLimitId||response.rateLimitsByLimitId||response.byLimitId;
  if(byLimitId&&typeof byLimitId==='object'&&!Array.isArray(byLimitId))return byLimitId;
  const selected=value.rateLimits&&typeof value.rateLimits==='object'?value.rateLimits:value;
  const limitId=typeof selected.limitId==='string'&&selected.limitId?selected.limitId:'codex';
  return selected&&typeof selected==='object'&&(selected.primary||selected.secondary)?{[limitId]:selected}:{};
}
export function normalizeRateLimits(value){
  const buckets=rawRateLimitBuckets(value),raw=buckets.codex||extractRateLimits(value)||{};
  const clean=window=>{
    if(!window||typeof window!=='object'||Array.isArray(window))return null;
    const parseNumber=value=>{
      if(typeof value==='number')return Number.isFinite(value)?value:null;
      if(typeof value==='string'&&value.trim()!==''){const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;}
      return null;
    };
    const usedValue=parseNumber(window.usedPercent);if(usedValue===null)return null;
    const used=Math.min(100,Math.max(0,usedValue)),durationValue=parseNumber(window.windowDurationMins),resetValue=parseNumber(window.resetsAt);
    return {usedPercent:used,remainingPercent:Math.max(0,100-used),windowDurationMins:durationValue&&durationValue>0?durationValue:null,resetsAt:resetValue};
  };
  const normalizeBucket=bucket=>{
    const windows=Object.entries(bucket||{}).map(([key,source])=>({key,source,value:clean(source)})).filter(x=>x.value);
    const explicitPrimary=windows.find(x=>x.key==='primary')||null,explicitSecondary=windows.find(x=>x.key==='secondary')||null;
    const primaryEntry=explicitPrimary||(!explicitSecondary?windows.find(x=>x.value.windowDurationMins&&x.value.windowDurationMins<=360)||(!windows.some(x=>x.value.windowDurationMins&&x.value.windowDurationMins>360)?windows[0]||null:null):null);
    const primary=primaryEntry?.value||null;
    const secondaryEntry=(explicitSecondary&&explicitSecondary!==primaryEntry&&explicitSecondary.source!==primaryEntry?.source?explicitSecondary:null)||windows.find(x=>x!==primaryEntry&&x.source!==primaryEntry?.source&&x.value.windowDurationMins&&x.value.windowDurationMins>360)||(!primaryEntry?windows.find(x=>x.key!=='primary'&&x.source!==explicitPrimary?.source)||null:windows.find(x=>x!==primaryEntry&&x.source!==primaryEntry?.source)||null);
    return {primary,secondary:secondaryEntry?.value||null,planType:bucket?.planType||null,credits:bucket?.credits?{balance:bucket.credits.balance,hasCredits:bucket.credits.hasCredits}:null};
  };
  const normalized=normalizeBucket(raw),primary=normalized.primary,secondary=normalized.secondary;
  const byLimitId=Object.fromEntries(Object.entries(buckets).map(([id,bucket])=>{
    const normalizedBucket=normalizeBucket(bucket);
    return [id,{...normalizedBucket,limitId:bucket?.limitId||id,limitName:bucket?.limitName||null,normalModelSlug:bucket?.normalModelSlug||null}];
  }));
  return {...normalized,primary,secondary,byLimitId};
}
const rateLimitCache={value:null,observedAt:0,inFlight:null};
/**
 * Account reads start a short-lived app-server process. Coalesce requests from
 * adjacent image tasks so the quota guard itself does not add a second slow
 * operation for every panel. The caller still receives null when no observed
 * value exists; an unavailable read is never converted into a made-up quota.
 */
export function rateLimitSnapshot(timeoutMs=12000,{force=false}={}){
  const bin=findCodex();if(!bin)return Promise.resolve(null);
  if(process.env.WENDI_TEST_PLAN_FILE)return Promise.resolve({primary:{usedPercent:1,remainingPercent:99,windowDurationMins:300},secondary:{usedPercent:2,remainingPercent:98,windowDurationMins:10080},byLimitId:{codex:{limitId:'codex',primary:{usedPercent:1,remainingPercent:99,windowDurationMins:300},secondary:{usedPercent:2,remainingPercent:98,windowDurationMins:10080}},base_model_inference:{limitId:'base_model_inference',normalModelSlug:'fixture-model',primary:{usedPercent:1,remainingPercent:99,windowDurationMins:10080}}},status:'fresh',observedAt:Date.now()});
  const age=Date.now()-rateLimitCache.observedAt;
  if(!force&&rateLimitCache.value&&age<60_000)return Promise.resolve({...rateLimitCache.value,status:'cached',observedAt:rateLimitCache.observedAt});
  if(rateLimitCache.inFlight)return rateLimitCache.inFlight;
  rateLimitCache.inFlight=new Promise(resolve=>{
    const child=spawn(bin,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],env:{...process.env,NO_COLOR:'1'}});
    const rl=readline.createInterface({input:child.stdout});let settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);rl.close();child.kill('SIGTERM');if(value){rateLimitCache.observedAt=Date.now();rateLimitCache.value={...value,status:'fresh',observedAt:rateLimitCache.observedAt};resolve(rateLimitCache.value);}else if(rateLimitCache.value)resolve({...rateLimitCache.value,status:'stale',observedAt:rateLimitCache.observedAt});else resolve(null);};
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    rl.on('line',line=>{try{const msg=JSON.parse(line);if(msg.id===0&&msg.result){send({method:'initialized',params:{}});send({method:'account/rateLimits/read',id:1});}else if(msg.id===1)finish(normalizeRateLimits(msg.result));}catch{}});
    child.on('error',()=>finish(null));child.on('close',()=>finish(null));const timer=setTimeout(()=>finish(null),timeoutMs);
    send({method:'initialize',id:0,params:{clientInfo:{name:'wendi_studio_guard',title:'温蒂创作室额度保护',version:'2.1.0'}}});
  });
  return rateLimitCache.inFlight.finally(()=>{rateLimitCache.inFlight=null;});
}
export function runCodex({prompt,dir,schema,images=[],signal,onEvent=()=>{},image=false,browserMode=null,writableDirs=[],model=null,reasoningEffort='low',timeoutMs=900000,codexBin=null,role='creative',leaseDir=null,runIdOverride=null}) {
  const bin=codexBin||findCodex();if(!bin)throw new Error('请先打开 Codex 并登录。');
  fs.mkdirSync(dir,{recursive:true});
  const resultPath=path.join(dir,'response.txt');
  const runId=String(runIdOverride||path.basename(path.resolve(dir))),leaseRoot=path.resolve(leaseDir||dir),startedAt=new Date().toISOString();
  const readinessLatestFile=path.join(leaseRoot,'browser-readiness-latest.json');
  if(browserMode==='chrome'){
    try{fs.unlinkSync(readinessLatestFile);}catch(err){if(err?.code!=='ENOENT')throw Object.assign(new Error('无法清除旧浏览器 readiness 证据，已阻止执行。'),{code:'BROWSER_READINESS_EVIDENCE_PERSIST_FAILED',cause:err});}
  }
  const executionFile=path.join(dir,'execution.json');
  const execution={schemaVersion:1,role,model:model||null,reasoningEffort,browserMode:browserMode||null,image:Boolean(image),runId,startedAt};
  const saveExecution=patch=>{try{fs.writeFileSync(executionFile,JSON.stringify({...execution,...patch},null,2),{mode:0o600});}catch{}};
  saveExecution({state:'running'});
  const args=['exec','--ephemeral','--skip-git-repo-check'];
  if(browserMode==='chrome')args.push('--disable','image_generation','--approve-for-me');
  else args.push('--ignore-user-config','--disable','plugins','--disable','apps','--disable','multi_agent');
  args.push('-c',`model_reasoning_effort="${reasoningEffort}"`);
  // --approve-for-me is intentionally incompatible with the sandbox. Browser
  // workers need the explicit non-interactive permission approval, while every
  // other execution keeps the existing read-only/workspace-write sandbox.
  if(browserMode!=='chrome')args.push('-s',image?'workspace-write':'read-only');
  args.push('--json','-o',resultPath);
  if(model)args.push('-m',model);
  if(schema){const s=path.join(dir,'response.schema.json');fs.writeFileSync(s,JSON.stringify(schema));args.push('--output-schema',s);}
  for(const dir of writableDirs)args.push('--add-dir',dir);
  for(const img of images)args.push('-i',img);
  args.push('-');
  fs.writeFileSync(path.join(dir,'prompt.txt'),prompt,{mode:0o600});
  return new Promise((resolve,reject)=>{
    // Never copy account secrets or call private endpoints: the official CLI owns authentication.
    const browserEnv=browserMode==='chrome'?{BROWSER_USE_AVAILABLE_BACKENDS:'chrome',CUA_REPL_ENABLED_SURFACES:'browser'}:{};
    const child=spawn(bin,args,{cwd:dir,env:{...process.env,...browserEnv,NO_COLOR:'1'},detached:true,stdio:['pipe','pipe','pipe']});
    const log=fs.createWriteStream(path.join(dir,'events.jsonl'),{mode:0o600});
    let buf='',last='',error='',settled=false,timedOut=false,usage=null;
    const capturedEvents=[];
    let runtimeError=null;
    let browserToolCalls=0,browserBusinessCalls=0,browserCleanupCalls=0,browserInitializationCalls=0,browserTabCreateAttempts=0,browserSetFilesCallCount=0,submissionIntentObserved=false,budgetFailure=null,anonymousCallSequence=0;
    const browserBusinessStageCounts={};
    const browserToolCallIds=new Set();
    const deferredCleanupCallIds=new Set(),anonymousActiveCallIds=[];
    const persistRuntimeError=(candidate)=>{
      if(!candidate||runtimeError)return;
      runtimeError=writeExecutorRuntimeError(dir,candidate);
    };
    const evidence=(responseText='',exitCode=null)=>classifyGenerationEvidence({events:capturedEvents,responseText,runId,startedAt,endedAt:new Date().toISOString(),exitCode});
    const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{} setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500).unref();};
    const abort=()=>stop(); signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    const finish=(err,result,{responseText='',exitCode=null}={})=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);log.end();
      try{compactResponseFile(resultPath);}catch{}
      saveExecution({state:err?'failed':'completed',endedAt:new Date().toISOString(),exitCode,durationMs:Math.max(0,Date.now()-Date.parse(startedAt)),error:err?String(err.message||err).slice(0,500):null,browserToolCallCount:browserToolCalls,browserBusinessCallCount:browserBusinessCalls,browserInitializationCallCount:browserInitializationCalls,browserCleanupCallCount:browserCleanupCalls,browserToolCallBudget:BROWSER_TOOL_BUSINESS_CALL_BUDGET,browserToolCleanupBudget:BROWSER_TOOL_CLEANUP_CALL_BUDGET,browserToolStageBudgets:BROWSER_TOOL_STAGE_BUDGETS,browserBusinessStageCounts,browserToolBudgetExceeded:Boolean(budgetFailure),submissionIntentObserved});
      // The CUA executor is the only component allowed to close its tab.  If
      // it exited before writing verified close evidence, persist an explicit
      // unconfirmed/orphaned lease instead of claiming that the tab vanished.
      // Runs without a lease (creative/fixture executions) are untouched.
      try{
        const lease=readOwnedTabLease(leaseRoot,{runId});
        if(lease){
          const browserFailure=[String(err?.message||error||''),...capturedEvents.filter(event=>event?.type==='item.completed'&&event?.item?.server==='cua_repl'&&event?.item?.tool==='js').map(event=>event.item.resultText||'')].join(' ');
          const kernelReset=/kernel\s*reset|globalThis[^\n]*(?:lost|undefined)|owned.?tab[^\n]*(?:lost|handle)/i.test(browserFailure);
          const finalized=finalizeOwnedTabLease({dir:leaseRoot,runId,requestId:lease.requestId,reason:err?'executor-exit':'executor-finished',kernelReset});
          if(finalized){
            const manifestFile=path.join(leaseRoot,'web-generation.json');
            syncOwnedTabLeaseToManifest({dir:leaseRoot,manifestFile,lease:finalized});
          }
        }
      }catch{}
      const runEvidence=evidence(responseText,exitCode);
      if(err){Object.defineProperty(err,'generationEvidence',{value:runEvidence,enumerable:false});return reject(err);}
      if(result&&typeof result==='object'){
        Object.defineProperty(result,'__generationEvidence',{value:runEvidence,enumerable:false});
        if(!Object.prototype.hasOwnProperty.call(result,'diagnostics'))Object.defineProperty(result,'diagnostics',{value:generationDiagnosticSummary(runEvidence),enumerable:true});
      }
      resolve(result);
    };
    const registerBrowserToolCall=(callKey,kind,event,stageHint=null)=>{
      if(browserToolCallIds.has(callKey))return;
      browserToolCallIds.add(callKey);browserToolCalls+=1;
      const source=String(event?.item?.arguments?.code||event?.item?.arguments?.command||'');
      let protectedAction=null;
      if(kind!=='cleanup'){
        const creates=sourceCallCount(source,/\bcua\s*\.\s*createBrowserTab\s*\(/gi);
        const uploads=sourceCallCount(source,/\.\s*setFiles\s*\(/gi);
        // A single setFiles CUA batch may legitimately invoke setFiles once per
        // frozen file when the chooser is single-select. This guard only blocks
        // a later CUA call that re-enters setFiles; it does not claim to count
        // dynamic loop iterations or verify attachment identity/order.
        if(browserTabCreateAttempts+creates>1)protectedAction='createBrowserTab';
        else if(uploads>0&&browserSetFilesCallCount>0)protectedAction='setFiles';
        browserTabCreateAttempts+=creates;browserSetFilesCallCount+=uploads>0?1:0;
      }
      const effectiveKind=kind==='initialization'&&browserInitializationCalls>0?'business':kind;
      if(effectiveKind==='initialization')browserInitializationCalls+=1;
      if(effectiveKind==='cleanup')browserCleanupCalls+=1;else if(effectiveKind!=='initialization'){
        browserBusinessCalls+=1;
        const stage=stageHint||browserToolBusinessStage(event?.item?.arguments?.code||event?.item?.arguments?.command||'');
        browserBusinessStageCounts[stage]=(browserBusinessStageCounts[stage]||0)+1;
      }
      submissionIntentObserved=submissionIntentObserved||eventContainsSubmissionIntent(event)||manifestHasSubmissionIntent(leaseRoot);
      const stage=stageHint||browserToolBusinessStage(event?.item?.arguments?.code||event?.item?.arguments?.command||'');
      const stageCount=browserBusinessStageCounts[stage]||0;
      const stageLimit=BROWSER_TOOL_STAGE_BUDGETS[stage]||BROWSER_TOOL_BUSINESS_CALL_BUDGET;
      if(kind!=='cleanup'&&(protectedAction||browserBusinessCalls>BROWSER_TOOL_BUSINESS_CALL_BUDGET||stageCount>stageLimit)&&!budgetFailure){
        // Budget enforcement interrupts the executor as soon as the over-limit
        // item.started event is observed. Tool dispatch and browser side effects
        // may race this event, so this cannot prove the call did not execute.
        // Persisted submission intent therefore makes the outcome unknown and
        // non-retryable; never defer termination to allow another send.
        const terminationDeferred=false;
        const record=writeBrowserToolBudget(dir,{observed:browserToolCalls,observedBusiness:browserBusinessCalls,observedCleanup:browserCleanupCalls,budgetKind:'business',stageName:stage,stageLimit,stageCount,stageCounts:browserBusinessStageCounts,protectedAction,submissionIntentObserved,terminationDeferred});
        const reason=protectedAction?`${protectedAction} 只允许一次，本调用触发重复动作保护`:stageCount>stageLimit?`${stage} 阶段已达到 ${stageLimit} 次上限（第 ${stageCount} 次）`:`浏览器业务 CUA 调用已达到 ${BROWSER_TOOL_BUSINESS_CALL_BUDGET} 次总上限`;
        const intentNotice=submissionIntentObserved?'已记录发送意图，结果按未知保护且禁止重发':'尚未记录发送意图';
        budgetFailure={code:'BROWSER_TOOL_BUDGET_EXCEEDED',observed:browserToolCalls,observedBusiness:browserBusinessCalls,observedCleanup:browserCleanupCalls,limit:BROWSER_TOOL_BUSINESS_CALL_BUDGET,stageName:stage,stageLimit,stageCount,stageCounts:{...browserBusinessStageCounts},protectedAction,submissionIntentObserved,terminationDeferred,message:`BROWSER_TOOL_BUDGET_EXCEEDED: ${reason}；${intentNotice}；父进程在观察到超限工具调用后请求中断执行器；工具分发与浏览器副作用可能存在竞态，不能据此证明该调用未执行。`};
        const budgetEvent={type:'browser_tool_budget_exceeded',errorCode:budgetFailure.code,observed:browserToolCalls,observedBusiness:browserBusinessCalls,observedCleanup:browserCleanupCalls,limit:BROWSER_TOOL_BUSINESS_CALL_BUDGET,cleanupLimit:BROWSER_TOOL_CLEANUP_CALL_BUDGET,submissionIntentObserved,stage:record?.stage||(budgetFailure.submissionIntentObserved?'post_submission_intent':'pre_submission_intent')};
        budgetEvent.stageName=stage;budgetEvent.stageLimit=stageLimit;budgetEvent.stageCount=stageCount;budgetEvent.stageCounts={...browserBusinessStageCounts};
        budgetEvent.protectedAction=protectedAction;
        budgetEvent.terminationDeferred=terminationDeferred;
        capturedEvents.push(budgetEvent);log.write(boundedEventLine(budgetEvent)+'\n');
        if(!terminationDeferred)stop();
      }
    };
    child.stdout.on('data',c=>{
      buf+=c;
      const lines=buf.split('\n');buf=lines.pop();
      for(const line of lines){
        if(!line.trim())continue;
        try{
          const e=JSON.parse(line);
          // Submission intent is a persisted lifecycle fact, not a browser
          // call.  Observe it from command/helper events as well as from the
          // next CUA call, so a budget failure immediately after the helper
          // still gets the correct post-intent safety classification.
          submissionIntentObserved=submissionIntentObserved||eventContainsSubmissionIntent(e)||manifestHasSubmissionIntent(leaseRoot);
          const browserCall=browserToolCallInfo(e,{dir:leaseRoot,runIdOverride:runId,cleanupCallUsed:browserCleanupCalls>=BROWSER_TOOL_CLEANUP_CALL_BUDGET});
          if(browserCall){
            let callKey=browserCall.id;
            if(!callKey){
              if(browserCall.phase==='started'){callKey=`anonymous-${++anonymousCallSequence}`;anonymousActiveCallIds.push(callKey);}
              else if(browserCall.phase==='completed')callKey=anonymousActiveCallIds.shift()||`anonymous-${++anonymousCallSequence}`;
              else callKey=`anonymous-${++anonymousCallSequence}`;
            }
            if(browserCall.phase==='started'&&browserCall.kind==='deferred_cleanup')deferredCleanupCallIds.add(callKey);
            else if(deferredCleanupCallIds.has(callKey)){
              deferredCleanupCallIds.delete(callKey);
              const completed=browserToolCallInfo(e,{dir:leaseRoot,runIdOverride:runId,cleanupCallUsed:browserCleanupCalls>=BROWSER_TOOL_CLEANUP_CALL_BUDGET});
              registerBrowserToolCall(callKey,completed?.kind==='cleanup'?'cleanup':'business',e,completed?.stage||browserCall.stage,{deferTermination:browserCall.phase==='started'});
            } else if(browserCall.kind==='deferred_cleanup'){
              const completed=browserToolCallInfo(e,{dir:leaseRoot,runIdOverride:runId,cleanupCallUsed:browserCleanupCalls>=BROWSER_TOOL_CLEANUP_CALL_BUDGET});
              registerBrowserToolCall(callKey,completed?.kind==='cleanup'?'cleanup':'business',e,completed?.stage||browserCall.stage,{deferTermination:browserCall.phase==='started'});
            } else registerBrowserToolCall(callKey,browserCall.kind,e,browserCall.stage,{deferTermination:browserCall.phase==='started'});
          }
          const compact=boundedEvent(e);
          if(browserMode==='chrome'&&!persistLatestBrowserReadiness(leaseRoot,e)){error='BROWSER_READINESS_EVIDENCE_PERSIST_FAILED';stop();}
          capturedEvents.push(compact);
          const candidate=runtimeCandidate(e);if(candidate)persistRuntimeError(candidate);
          if(e.type==='item.completed'&&e.item?.type==='agent_message')last=e.item.text;
          if(e.type==='turn.completed'&&e.usage)usage=e.usage;
          if(e.type==='error'||e.type==='turn.failed')error=e.message||e.error?.message||'创作连接中断';
          log.write(boundedEventLine(compact)+'\n');onEvent(e);
        }catch{
          log.write(boundedEventLine({type:'unparsed',text:redactRuntimeText(line,MAX_EVENT_TEXT)})+'\n');
        }
      }
    });
    child.stderr.on('data',c=>{
      const text=String(c),event={stderr:redactRuntimeText(text,MAX_EVENT_TEXT)};
      const compact=boundedEvent(event);capturedEvents.push(compact);log.write(boundedEventLine(compact)+'\n');
      if(/(?:ReferenceError|TypeError|SyntaxError|RangeError|runtime|运行时|WORKER_SCRIPT|EXECUTOR_RUNTIME)/i.test(text))persistRuntimeError({category:'executor_stderr',message:text,stack:text,toolStage:'executor',source:'stderr'});
    });
    child.on('error',err=>{persistRuntimeError({category:'process',message:err.message,stack:err.stack,toolStage:'executor',source:'child'});finish(new Error('无法启动创作连接：'+err.message));});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      if(signal?.aborted)return finish(new Error('已暂停，已保存完成部分。'),null,{exitCode:code});
      if(timedOut)return finish(new Error('本次等待时间较长，已暂停。已收到的图片保留在本地，可检查后继续。'),null,{exitCode:code});
      if(budgetFailure){
        const budgetError=new Error(budgetFailure.message);Object.assign(budgetError,budgetFailure);
        return finish(budgetError,null,{exitCode:code});
      }
      if(code!==0){
        const message=error||'创作连接中断，请确认账号可用后继续。';
        persistRuntimeError({category:'executor_exit',message,stack:'',toolStage:'executor',source:'process'});
        return finish(new Error(message),null,{exitCode:code});
      }
      const text=fs.existsSync(resultPath)?fs.readFileSync(resultPath,'utf8'):last;
      if(schema){try{const parsed=JSON.parse(text);Object.defineProperty(parsed,'__usage',{value:usage,enumerable:false});return finish(null,parsed,{responseText:text,exitCode:code});}catch{return finish(new Error('未收到完整方案，需求已保留，请重新整理。'),null,{responseText:text,exitCode:code});}}
      finish(null,{text,usage},{responseText:text,exitCode:code});
    });
    if(signal?.aborted)stop(); else child.stdin.end(prompt);
  });
}
