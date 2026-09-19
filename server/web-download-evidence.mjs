import fs from 'node:fs';
import path from 'node:path';

const IAB_UNAVAILABLE_ERROR=/(?:Browser is not available:\s*iab|IAB[_\s-]*(?:UNAVAILABLE|NOT[_\s-]*AVAILABLE)|IAB[_\s-]*SESSION[_\s-]*LOST[_\s-]*BEFORE[_\s-]*SUBMIT|Capability is not available:\s*(?:visibility|browser)|隐藏\s*IAB.*不可用)/i;
const BROWSER_FOCUS_ERROR=/(?:BROWSER_FOCUS_(?:UNAVAILABLE|RESTORE_FAILED|RESTORE_FAILED_AFTER_CLOSE)|Chrome management capability is not advertised|焦点(?:恢复|管理)能力(?:不可用|未提供|未广告)|无法恢复创作室焦点)/i;
const BROWSER_TAB_BACKGROUND_ERROR=/(?:BROWSER_TAB_BACKGROUND_UNAVAILABLE|非前台(?:标签页|tab).*(?:不可用|失败)|后台标签页.*(?:不可用|失败))/i;
const CHROME_UNAVAILABLE_ERROR=/(?:BROWSER_CHROME_UNAVAILABLE|Browser is not available:\s*chrome|Chrome extension.*(?:不可用|unavailable))/i;
const FILE_UPLOAD_CHROME_UNAVAILABLE_ERROR=/(?:^|[^A-Z0-9_])FILE_UPLOAD_CHROME_UNAVAILABLE(?:$|[^A-Z0-9_])|(?:UPLOAD_ERROR[^\n]*(?:file chooser|文件选择器|附件入口|attachment control))/i;
// Prompt text and command arguments are not browser evidence. This matcher is
// intentionally limited to the terminal result returned by the owned browser.
const BROWSER_ORIGIN_PERMISSION_DENIED_ERROR=/(?:^|[^A-Z0-9_])BROWSER_ORIGIN_PERMISSION_DENIED(?:$|[^A-Z0-9_])|Browser use cannot access\s+https?:\/\/chatgpt\.com\b[^\n]*(?:denied permission|permission denied|拒绝)|https?:\/\/chatgpt\.com\b[^\n]*(?:browser security policy|origin permission|访问权限被拒绝)/i;

export function textFromBrowserToolResult(result){
  if(!result||typeof result!=='object')return [];
  const content=Array.isArray(result.content)?result.content:[];
  return content.flatMap(block=>block&&typeof block==='object'&&block.type==='text'&&typeof block.text==='string'?[block.text]:[]);
}

/** Read only terminal results from one owned browser execution. */
export function structuredBrowserToolResultText(dir){
  if(!dir)return '';
  let source='';try{source=fs.readFileSync(path.join(dir,'events.jsonl'),'utf8');}catch{return '';}
  const chunks=[];
  for(const line of source.split('\n')){
    let event;try{event=JSON.parse(line);}catch{continue;}
    const item=event?.item||event;
    if(!item||item.type!=='mcp_tool_call')continue;
    const server=String(item.server||item.serverName||'').toLowerCase();
    const tool=String(item.tool||item.name||'').toLowerCase();
    if(server!=='cua_repl'&&!(server.includes('browser')||tool==='browser'))continue;
    if(tool&&tool!=='js'&&tool!=='browser')continue;
    chunks.push(...textFromBrowserToolResult(item.result));
  }
  return chunks.join('\n');
}

export function browserRunEvidenceText(dir,{manifest=null,failure=null}={}){
  const browserResult=structuredBrowserToolResultText(dir);
  let stderr='';
  try{stderr=fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').split('\n').flatMap(line=>{try{const event=JSON.parse(line);return typeof event?.stderr==='string'?[event.stderr]:[];}catch{return [];}}).join('\n');}catch{}
  return [manifest?.errorCode,manifest?.error,manifest?.message,failure?.code,failure?.message,stderr,browserResult].filter(Boolean).join('\n');
}

export function browserPreSubmissionUnavailableText(value){
  const text=String(value||'');
  return IAB_UNAVAILABLE_ERROR.test(text)||FILE_UPLOAD_CHROME_UNAVAILABLE_ERROR.test(text)||BROWSER_ORIGIN_PERMISSION_DENIED_ERROR.test(text)||BROWSER_FOCUS_ERROR.test(text)||BROWSER_TAB_BACKGROUND_ERROR.test(text)||CHROME_UNAVAILABLE_ERROR.test(text);
}

export function browserOriginPermissionDeniedEvidence(value){
  return BROWSER_ORIGIN_PERMISSION_DENIED_ERROR.test(String(value||''));
}

export function fileUploadChromeUnavailableEvidence(value){
  return FILE_UPLOAD_CHROME_UNAVAILABLE_ERROR.test(String(value||''));
}

export function iabUnavailableEvidence(value){
  return IAB_UNAVAILABLE_ERROR.test(String(value||''));
}

export function browserTabBackgroundEvidence(value){
  return BROWSER_TAB_BACKGROUND_ERROR.test(String(value||''));
}

export function chromeUnavailableEvidence(value){
  return CHROME_UNAVAILABLE_ERROR.test(String(value||''));
}

export function browserFocusEvidence(value){
  return BROWSER_FOCUS_ERROR.test(String(value||''));
}

export function browserFailureCode({explicitCode=null,uploadUnavailable=false,originPermissionDenied=false,failure=null,detail=''}={}){
  if(explicitCode)return explicitCode;
  const source=String(failure?.code||failure?.message||'');
  if(uploadUnavailable)return 'FILE_UPLOAD_CHROME_UNAVAILABLE';
  if(originPermissionDenied)return 'BROWSER_ORIGIN_PERMISSION_DENIED';
  if(IAB_UNAVAILABLE_ERROR.test(source))return 'IAB_UNAVAILABLE';
  if(BROWSER_TAB_BACKGROUND_ERROR.test(detail))return 'BROWSER_TAB_BACKGROUND_UNAVAILABLE';
  if(CHROME_UNAVAILABLE_ERROR.test(detail))return 'BROWSER_CHROME_UNAVAILABLE';
  if(BROWSER_FOCUS_ERROR.test(detail)&&/RESTORE_FAILED_AFTER_CLOSE/i.test(detail))return 'BROWSER_FOCUS_RESTORE_FAILED_AFTER_CLOSE';
  if(BROWSER_FOCUS_ERROR.test(detail)&&/RESTORE_FAILED/i.test(detail))return 'BROWSER_FOCUS_RESTORE_FAILED';
  return 'BROWSER_FOCUS_UNAVAILABLE';
}

export function browserFailurePrefix(errorCode){
  if(errorCode==='FILE_UPLOAD_CHROME_UNAVAILABLE')return '专用 Chrome 标签页的附件入口未能打开浏览器文件选择器';
  if(errorCode==='BROWSER_ORIGIN_PERMISSION_DENIED')return 'Chrome 已连接，但 chatgpt.com 访问权限被拒绝；下次重试出现浏览器访问询问时请选择“允许”';
  if(errorCode==='IAB_UNAVAILABLE')return '历史 Codex 内嵌浏览器 IAB 不可用';
  if(errorCode==='BROWSER_TAB_BACKGROUND_UNAVAILABLE')return 'Chrome 专用标签页的非前台操作能力不可用';
  if(errorCode==='BROWSER_CHROME_UNAVAILABLE')return 'Chrome extension 不可用';
  if(errorCode==='BROWSER_FOCUS_RESTORE_FAILED_AFTER_CLOSE')return 'Chrome 专用标签页关闭后无法安全恢复创作室焦点';
  if(errorCode==='BROWSER_FOCUS_RESTORE_FAILED')return 'Chrome 专用标签页无法安全恢复创作室焦点';
  return 'Chrome 专用标签页无法安全保持温蒂创作室焦点，无法零焦点切换';
}
