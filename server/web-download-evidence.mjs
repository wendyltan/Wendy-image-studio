import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DOWNLOAD_EVIDENCE_FILE='download-evidence.json';
export const DOWNLOAD_EVIDENCE_SCHEMA_VERSION=2;
const DOWNLOAD_EVIDENCE_IDENTITY_FIELDS=['projectId','projectVersion','taskId','requestId','runId','target'];
const IMAGE_CONTENT_TYPES=new Set(['image/png','image/jpeg','image/webp']);
const MEDIA_URL=/^https:\/\/chatgpt\.com\/backend-api\/estuary\/content(?:[?#/]|$)/i;
const HASH=/^[a-f0-9]{64}$/i;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const STABLE_FILE_ID=/\b(file_[A-Za-z0-9_-]+)\b/;

function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}
function text(value){return typeof value==='string'?value.trim():'';}
function samePath(left,right){return path.resolve(String(left||''))===path.resolve(String(right||''));}
/**
 * ChatGPT may expose the same generated file through URLs with different
 * signed query strings.  The file id is the stable source identity; query
 * parameters are transport metadata and must not decide whether an asset is
 * the current result.
 */
export function stableFileId(value){
  const match=text(value).match(STABLE_FILE_ID);
  return match?.[1]||null;
}
export function stableFileIdsForAsset(asset){
  const value=object(asset);
  return [...new Set([value?.url,value?.sourceUrl,value?.name].map(stableFileId).filter(Boolean))];
}
export function pageAssetMatchesResult(asset,{src=null,stableId=null}={}){
  const value=object(asset),url=text(value?.url||value?.sourceUrl),wanted=stableId||stableFileId(src);
  if(!value||value.kind!=='image'||!MEDIA_URL.test(url)||!wanted)return false;
  if(!IMAGE_CONTENT_TYPES.has(text(value.contentType).toLowerCase()))return false;
  if(value.isThumbnail===true||value.isPreview===true)return false;
  if(/(?:thumbnail|preview|缩略|预览)/i.test([value.role,url,value.name].map(text).join(' ')))return false;
  return stableFileIdsForAsset(value).includes(wanted);
}
function formatForContentType(value){
  const type=text(value).toLowerCase();
  if(type==='image/png')return 'PNG';
  if(type==='image/jpeg')return 'JPEG';
  if(type==='image/webp')return 'WEBP';
  return null;
}
function contentTypeForFormat(value){
  const format=text(value).toUpperCase();
  return format==='PNG'?'image/png':format==='JPEG'||format==='JPG'?'image/jpeg':format==='WEBP'?'image/webp':null;
}
function parsePng(buffer){
  if(buffer.length<24||buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return null;
  return {format:'PNG',contentType:'image/png',width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
}
function parseJpeg(buffer){
  if(buffer.length<4||buffer[0]!==0xff||buffer[1]!==0xd8)return null;
  let offset=2;
  while(offset+8<buffer.length){
    while(offset<buffer.length&&buffer[offset]!==0xff)offset++;
    while(offset<buffer.length&&buffer[offset]===0xff)offset++;
    const marker=buffer[offset++];
    if(!marker||marker===0xda||marker===0xd9)break;
    if(offset+2>buffer.length)break;
    const length=buffer.readUInt16BE(offset);
    if(length<2||offset+length>buffer.length)break;
    const sof=(marker>=0xc0&&marker<=0xc3)||(marker>=0xc5&&marker<=0xc7)||(marker>=0xc9&&marker<=0xcb)||(marker>=0xcd&&marker<=0xcf);
    if(sof&&length>=7)return {format:'JPEG',contentType:'image/jpeg',height:buffer.readUInt16BE(offset+3),width:buffer.readUInt16BE(offset+5)};
    offset+=length;
  }
  return null;
}
function parseWebp(buffer){
  if(buffer.length<16||buffer.subarray(0,4).toString('ascii')!=='RIFF'||buffer.subarray(8,12).toString('ascii')!=='WEBP')return null;
  let offset=12;
  while(offset+8<=buffer.length){
    const chunk=buffer.subarray(offset,offset+4).toString('ascii'),size=buffer.readUInt32LE(offset+4),data=offset+8;
    if(data+size>buffer.length)break;
    if(chunk==='VP8X'&&size>=10)return {format:'WEBP',contentType:'image/webp',width:1+buffer.readUIntLE(data+4,3),height:1+buffer.readUIntLE(data+7,3)};
    if(chunk==='VP8 '&&size>=10){
      for(let i=data;i+9<data+size;i++)if(buffer[i]===0x9d&&buffer[i+1]===0x01&&buffer[i+2]===0x2a)return {format:'WEBP',contentType:'image/webp',width:buffer.readUInt16LE(i+3)&0x3fff,height:buffer.readUInt16LE(i+5)&0x3fff};
    }
    if(chunk==='VP8L'&&size>=5&&buffer[data]===0x2f){
      const b1=buffer[data+2],b2=buffer[data+3],b3=buffer[data+4],b4=buffer[data+5];
      return {format:'WEBP',contentType:'image/webp',width:1+(((b2&0x3f)<<8)|b1),height:1+(((b4&0xf)<<10)|(b3<<2)|((b2&0xc0)>>6))};
    }
    offset+=8+size+(size%2);
  }
  return null;
}
function parseImage(buffer){return parsePng(buffer)||parseJpeg(buffer)||parseWebp(buffer);}

/** Inspect the actual bytes copied from the page-assets bundle. */
export function inspectDownloadArtifact(file){
  const absolute=path.resolve(String(file||'')),buffer=fs.readFileSync(absolute),parsed=parseImage(buffer);
  if(!parsed)throw new Error('目标文件不是可识别的 PNG、JPG 或 WebP 原图。');
  return {path:absolute,bytes:buffer.length,...parsed,sha256:crypto.createHash('sha256').update(buffer).digest('hex')};
}

/** Extract only the executor's explicit machine-readable evidence block. */
export function extractDownloadEvidence(value){
  if(object(value)?.downloadEvidence)return object(value.downloadEvidence);
  if(object(value)?.schemaVersion===DOWNLOAD_EVIDENCE_SCHEMA_VERSION&&text(value?.source)==='pageAssets')return value;
  const source=text(value),match=source.match(/<download_evidence>\s*([\s\S]*?)\s*<\/download_evidence>/i);
  if(!match)return null;
  try{const parsed=JSON.parse(match[1]);return object(parsed)?.schemaVersion===DOWNLOAD_EVIDENCE_SCHEMA_VERSION?parsed:null;}catch{return null;}
}

/** Fill only locally verifiable artifact fields before the strict validation. */
export function completeDownloadEvidence(evidence,{actual=null}={}){
  const value=structuredClone(object(evidence)||{}),output=object(value.output)||(value.output={});
  if(actual){for(const key of ['path','bytes','format','width','height','sha256'])if(output[key]===undefined||output[key]===null||output[key]==='')output[key]=actual[key];}
  const result=object(value.currentResult),src=text(result?.src),asset=object(value.matchedAsset),assetUrl=text(asset?.url||asset?.sourceUrl),id=text(result?.stableFileId)||stableFileId(src)||stableFileId(result?.resultId);
  if(result&&id&&!result.stableFileId)result.stableFileId=id;
  if(!value.matchingStrategy&&assetUrl&&src)value.matchingStrategy=assetUrl===src?'exact-src':'stable-file-id';
  return value;
}

export function enrichDownloadEvidenceIdentity(evidence,identity={}){
  const value=structuredClone(object(evidence)||{});
  for(const key of DOWNLOAD_EVIDENCE_IDENTITY_FIELDS){
    if(value[key]===undefined||value[key]===null||value[key]===''){
      const candidate=identity[key];
      if(candidate!==undefined&&candidate!==null&&candidate!=='')value[key]=candidate;
    }
  }
  value.schemaVersion=DOWNLOAD_EVIDENCE_SCHEMA_VERSION;
  return value;
}

function normalizedIdentityValue(key,value){
  if(value===undefined||value===null||value==='')return null;
  if(key==='projectVersion')return Number.isFinite(Number(value))?Number(value):String(value);
  if(key==='outputFile')return path.resolve(String(value));
  return String(value);
}
function sourceIdentityValues(source,key){
  const value=object(source),nested=object(value?.downloadEvidence);
  if(!value&&!nested)return [];
  const primary=key==='outputFile'?(value?.outputFile??value?.artifactPath??null):value?.[key],nestedValue=key==='outputFile'?nested?.output?.path:nested?.[key];
  return [primary,nestedValue].filter(item=>item!==undefined&&item!==null&&item!=='');
}

/**
 * Validate the page-assets chain and the bytes copied to outputFile.  This is
 * deliberately independent of executor prose: every accepted field is
 * compared with the current run and the local artifact.
 */
export function validateDownloadEvidence(value,{conversationUrl=null,requestId=null,runId=null,outputFile=null,actual=null,expectedIdentity=null,request=null,worker=null,result:resultRecord=null,manifest=null}={}){
  const evidence=object(value),errors=[];
  if(!evidence)errors.push('缺少结构化 pageAssets 下载证据。');
  if(Number(evidence?.schemaVersion)!==DOWNLOAD_EVIDENCE_SCHEMA_VERSION)errors.push('download evidence schemaVersion 无效。');
  const expected={...object(expectedIdentity),...(conversationUrl?{conversationUrl}:{}),...(requestId?{requestId}:{}),...(runId?{runId}:{}),...(outputFile?{outputFile}: {})};
  const observedConversation=text(evidence?.conversationUrl);
  if(!/^https:\/\/chatgpt\.com\/c\/[^\s?#]+(?:[?#][^\s]*)?$/.test(observedConversation))errors.push('conversationUrl 不是 ChatGPT 会话地址。');
  if(expected.conversationUrl&&observedConversation!==String(expected.conversationUrl))errors.push('download evidence conversationUrl 与当前会话不一致。');
  for(const key of DOWNLOAD_EVIDENCE_IDENTITY_FIELDS){
    const observed=normalizedIdentityValue(key,evidence?.[key]);
    if(observed===null)errors.push(`download evidence ${key} 缺失。`);
    const wanted=normalizedIdentityValue(key,expected[key]);
    if(wanted!==null&&observed!==null&&observed!==wanted)errors.push(`download evidence ${key} 与当前执行身份不一致。`);
  }
  const sources=[['request',request],['worker',worker],['result',resultRecord],['manifest',manifest]];
  for(const [sourceName,source] of sources){
    if(!object(source))continue;
    for(const key of DOWNLOAD_EVIDENCE_IDENTITY_FIELDS){
      const observed=normalizedIdentityValue(key,evidence?.[key]);
      for(const sourceItem of sourceIdentityValues(source,key)){
        const sourceValue=normalizedIdentityValue(key,sourceItem);
        if(sourceValue!==null&&observed!==null&&sourceValue!==observed)errors.push(`download evidence ${key} 与 ${sourceName} 不一致。`);
      }
    }
    for(const sourceConversation of sourceIdentityValues(source,'conversationUrl').map(text))if(sourceConversation&&observedConversation&&sourceConversation!==observedConversation)errors.push(`download evidence conversationUrl 与 ${sourceName} 不一致。`);
  }
  if(text(evidence?.source)!=='pageAssets')errors.push('download evidence source 必须是 pageAssets。');
  if(!ISO.test(text(evidence?.capturedAt))||!Number.isFinite(Date.parse(evidence?.capturedAt)))errors.push('download evidence capturedAt 无效。');
  const result=object(evidence?.currentResult),src=text(result?.src),stableId=text(result?.stableFileId)||stableFileId(src);
  if(!MEDIA_URL.test(src))errors.push('当前结果 src 不是会话内原始媒体 URL。');
  if(!stableId)errors.push('当前结果缺少稳定 file id。');
  if(result?.stableFileId&&stableFileId(result.stableFileId)!==result.stableFileId)errors.push('当前结果 stableFileId 无效。');
  if(result?.resultId&&stableFileId(result.resultId)!==result.resultId)errors.push('当前结果 resultId 无效。');
  if(result?.resultId&&stableId&&result.resultId!==stableId)errors.push('当前结果 resultId 与 stableFileId 不一致。');
  const matchingStrategy=text(evidence?.matchingStrategy);
  if(!['exact-src','stable-file-id'].includes(matchingStrategy))errors.push('matchingStrategy 无效。');
  const inventory=object(evidence?.inventory);
  if(!text(inventory?.id))errors.push('缺少 pageAssets inventory id。');
  const exact=Number(evidence?.exactMatchCount);
  if(exact!==1)errors.push(`当前结果精确匹配资产数量必须为 1，实际为 ${String(evidence?.exactMatchCount)}。`);
  const matchedIds=Array.isArray(evidence?.matchedAssetIds)?evidence.matchedAssetIds.filter(item=>text(item)) : null;
  if(!matchedIds||matchedIds.length!==1)errors.push('matchedAssetIds 必须只包含一个精确匹配资产。');
  const asset=object(evidence?.matchedAsset);
  if(!asset)errors.push('缺少 matchedAsset。');
  else{
    if(text(asset.kind)!=='image')errors.push('matchedAsset.kind 必须是 image。');
    const contentType=text(asset.contentType).toLowerCase();
    if(!IMAGE_CONTENT_TYPES.has(contentType))errors.push('matchedAsset.contentType 不是允许的图片类型。');
    const assetUrl=text(asset.url||asset.sourceUrl),assetStableIds=stableFileIdsForAsset(asset);
    if(!MEDIA_URL.test(assetUrl))errors.push('matchedAsset URL 不是会话内原始媒体 URL。');
    if(!stableId||!assetStableIds.includes(stableId))errors.push('matchedAsset 稳定 file id 与当前结果不一致，可能是旧图或缩略图。');
    if(matchingStrategy==='exact-src'&&assetUrl!==src)errors.push('exact-src 匹配的 matchedAsset URL 与当前结果 src 不一致。');
    if(matchingStrategy==='stable-file-id'&&assetUrl===src)errors.push('stable-file-id 匹配不应在 URL 完全相同时使用。');
    const sourceUrl=text(asset.sourceUrl);
    if(sourceUrl&&!MEDIA_URL.test(sourceUrl))errors.push('matchedAsset sourceUrl 不是会话内原始媒体 URL。');
    if(sourceUrl&&stableId&&!stableFileIdsForAsset({url:sourceUrl}).includes(stableId))errors.push('matchedAsset sourceUrl 稳定 file id 与当前结果不一致。');
    const descriptor=[asset.role,assetUrl].map(text).join(' ');
    if(asset.isThumbnail===true||asset.isPreview===true||/(?:thumbnail|preview|缩略|预览)/i.test(descriptor))errors.push('matchedAsset 被标记为 thumbnail/preview，拒绝作为原图。');
    if(matchedIds&&matchedIds[0]!==text(asset.id))errors.push('matchedAsset.id 不在唯一精确匹配资产中。');
  }
  const bundle=object(evidence?.bundle);
  if(!bundle)errors.push('缺少 pageAssets bundle 结果。');
  else{
    if(Number(bundle.downloadedCount)!==1)errors.push('bundle.downloadedCount 必须为 1。');
    if(!Array.isArray(bundle.failures)||bundle.failures.length!==0)errors.push('bundle.failures 必须为空。');
    if(!IMAGE_CONTENT_TYPES.has(text(bundle.contentType).toLowerCase()))errors.push('bundle contentType 不是允许的图片类型。');
    if(!text(bundle.path))errors.push('bundle path 缺失。');
    if(formatForContentType(bundle.contentType)!==formatForContentType(asset?.contentType))errors.push('bundle contentType 与资产类型不一致。');
  }
  const output=object(evidence?.output);
  if(!output)errors.push('缺少最终原图 output 证据。');
  else{
    if(expected.outputFile&&!samePath(output.path,expected.outputFile))errors.push('output.path 与当前 worker outputFile 不一致。');
    if(!Number.isInteger(Number(output.bytes))||Number(output.bytes)<=0)errors.push('output.bytes 无效。');
    if(!contentTypeForFormat(output.format))errors.push('output.format 不是 PNG、JPEG 或 WEBP。');
    if(!Number.isInteger(Number(output.width))||Number(output.width)<=0||!Number.isInteger(Number(output.height))||Number(output.height)<=0)errors.push('output dimensions 无效。');
    if(!HASH.test(text(output.sha256)))errors.push('output.sha256 无效。');
  }
  if(actual&&output){
    for(const key of ['bytes','width','height','sha256'])if(String(output[key])!==String(actual[key]))errors.push(`output.${key} 与实际文件不一致。`);
    if(text(output.format).toUpperCase()!==text(actual.format).toUpperCase())errors.push('output.format 与实际文件不一致。');
    if(!samePath(output.path,actual.path))errors.push('output.path 与实际文件不一致。');
  }
  return {ok:errors.length===0,errors:[...new Set(errors)],evidence:evidence||null};
}

export function readDownloadEvidence(dir){
  try{const value=JSON.parse(fs.readFileSync(path.join(dir,DOWNLOAD_EVIDENCE_FILE),'utf8'));return object(value);}catch{return null;}
}

export function writeDownloadEvidence(dir,evidence){
  if(!object(evidence))throw new TypeError('download evidence must be an object');
  const file=path.join(dir,DOWNLOAD_EVIDENCE_FILE),temp=`${file}.tmp-${crypto.randomUUID()}`;
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(temp,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);return file;
}

/** Append a durable audit event for evidence recovered after the executor turn. */
export function appendDownloadEvidenceTrace(dir,evidence,{validation=null,appendResponse=true,eventType='download.evidence',metadataOnly=false}={}){
  if(!object(evidence))throw new TypeError('download evidence must be an object');
  const marker=`<download_evidence>${JSON.stringify(evidence)}</download_evidence>`,event={type:eventType,schemaVersion:1,metadataOnly:Boolean(metadataOnly),capturedAt:evidence.capturedAt||null,requestId:evidence.requestId||null,runId:evidence.runId||null,downloadEvidence:evidence,validation:validation?{ok:validation.ok===true,errors:Array.isArray(validation.errors)?validation.errors:[]}:null};
  const eventsFile=path.join(dir,'events.jsonl');fs.appendFileSync(eventsFile,JSON.stringify(event)+'\n',{mode:0o600});
  if(appendResponse)fs.appendFileSync(path.join(dir,'response.txt'),`\n${marker}\n`,{encoding:'utf8',mode:0o600});
  return event;
}

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
