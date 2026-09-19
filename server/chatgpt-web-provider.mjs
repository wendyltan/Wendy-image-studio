import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {runCodex,findCodex} from './bridge.mjs';
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
const IAB_UNAVAILABLE_ERROR=/(?:Browser is not available:\s*iab|IAB[_\s-]*(?:UNAVAILABLE|NOT[_\s-]*AVAILABLE)|IAB[_\s-]*SESSION[_\s-]*LOST[_\s-]*BEFORE[_\s-]*SUBMIT|Capability is not available:\s*(?:visibility|browser)|隐藏\s*IAB.*不可用)/i;
const BROWSER_FOCUS_ERROR=/(?:BROWSER_FOCUS_(?:UNAVAILABLE|RESTORE_FAILED|RESTORE_FAILED_AFTER_CLOSE)|Chrome management capability is not advertised|焦点(?:恢复|管理)能力(?:不可用|未提供|未广告)|无法恢复创作室焦点)/i;
const BROWSER_TAB_BACKGROUND_ERROR=/(?:BROWSER_TAB_BACKGROUND_UNAVAILABLE|非前台(?:标签页|tab).*(?:不可用|失败)|后台标签页.*(?:不可用|失败))/i;
const CHROME_UNAVAILABLE_ERROR=/(?:BROWSER_CHROME_UNAVAILABLE|Browser is not available:\s*chrome|Chrome extension.*(?:不可用|unavailable))/i;
const FILE_UPLOAD_CHROME_UNAVAILABLE_ERROR=/(?:^|[^A-Z0-9_])FILE_UPLOAD_CHROME_UNAVAILABLE(?:$|[^A-Z0-9_])|(?:UPLOAD_ERROR[^\n]*(?:file chooser|文件选择器|附件入口|attachment control))/i;
// This matcher is intentionally narrow. Prompt text, agent messages and
// command arguments are not browser evidence; only a result returned by the
// current browser tool may establish a site-origin permission denial.
const BROWSER_ORIGIN_PERMISSION_DENIED_ERROR=/(?:^|[^A-Z0-9_])BROWSER_ORIGIN_PERMISSION_DENIED(?:$|[^A-Z0-9_])|Browser use cannot access\s+https?:\/\/chatgpt\.com\b[^\n]*(?:denied permission|permission denied|拒绝)|https?:\/\/chatgpt\.com\b[^\n]*(?:browser security policy|origin permission|访问权限被拒绝)/i;

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
function listedFiles(files=[]){
  return files.map((file,index)=>`${index+1}. ${JSON.stringify(path.resolve(file))}`).join('\n');
}

export function readWebManifest(file){
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!value||typeof value!=='object')return null;
    const state=String(value.state||'');
    if(!MANIFEST_STATES.has(state))return null;
    const conversationUrl=/^https:\/\/chatgpt\.com\/(?:c\/[^\s?#]+)?(?:[?#][^\s]*)?$/.test(String(value.conversationUrl||''))?String(value.conversationUrl):null;
    const requestId=REQUEST_ID.test(String(value.requestId||''))?String(value.requestId):null;
    const times=Object.fromEntries(MANIFEST_TIMES.map(key=>[key,normalizeTimestamp(value[key])]));
    return {...value,...times,state,submitted:value.submitted===true,conversationUrl,...(requestId?{requestId}:{}),...(value.accepted===true?{accepted:true}: {})};
  }catch{return null;}
}

export function chatGptWebImagePrompt({outputFile,manifestFile,prompt,referenceFiles=[],editTarget=null,conversationUrl=null,capsule='',requestId=null}){
  const action=editTarget
    ? '第一项附件是待编辑原图。请只修订明确指出的问题，保持其他正确内容。'
    : '创建一张新的独立分镜图。';
  const conversation=conversationUrl
    ? `优先继续这个既有对话以保持编辑上下文：${String(conversationUrl)}
既有会话导航恢复协议（只适用于这个 target）：第一次导航和后续检查只能使用同一个返回的 owned tab（变量 tab）。如果 tab.goto(target) 或等待导航返回 Page.navigate/navigation timeout，不能仅凭异常立即写 CHATGPT_NAVIGATION_FAILED、关闭 tab 或再次 createBrowserTab。必须先在同一 tab 做有界的 post-timeout URL/DOM/composer 验证：读取 tab.url()，读取当前 tab.playwright.domSnapshot()（必要时再读 tab.getAXState({disableDiffing:true})），确认当前 URL/浏览器结果元数据是否已经是 target，以及当前 DOM 是否有已登录证据和可用 composer（例如“与 ChatGPT 聊天”或 prompt-textarea，且没有登录按钮）。
如果 target 已经可用，继续在这个 tab 完成聊天模式、创建图片、附件和一次发送；不得重新导航、创建第二个 tab、重复上传或重复发送。如果超时后仍在 ChatGPT home（https://chatgpt.com/）但已登录且 composer 可用，可仅在 DOM 明确给出目标 href 时使用已公开的 tab.playwright.getByRole("link",{name:...}).click({timeoutMs:5000}) 做一次有界 side-link SPA click；没有精确匹配的 side-link 时直接把全部冻结参考图和冻结提示词用于新聊天继续，不要猜 URL、不要接管其他 tab、不要回退 IAB。只有有界 URL/DOM/composer 检查确认既不是 target、也不是可用 ChatGPT home，或无法确认登录/composer 时，才原子写入 state=failed、submitted=false、referenceCount=0、errorCode=CHATGPT_NAVIGATION_FAILED，并在 error 中写明“既有会话导航超时后，同一专用标签页复查未发现可用目标或已登录聊天输入框”；该提交前分类不得被描述为已上传或已发送。`
    : '新建一个 ChatGPT 对话；创建后把实际会话 URL 记录到执行清单。';
  return `你是温蒂创作室的后台网页生图执行器。用户已经在温蒂创作室网页执行带防重复标识的确认动作，明确授权本次单张生图和把下列参考图片上传到 chatgpt.com。worker-request.json 中的 authorization 是该操作发生后的持久证据。它已经满足发送前确认，不得再次询问；上传、发送、等待和下载必须在当前同一个回合完成。

你只负责机械执行已经冻结的本次请求，不负责创意规划、质量判断或任务恢复。禁止读取仓库、memory、历史任务、其他作品、其他会话或任何未列出的文件；禁止自行调研、搜索或改写提示词。只读取本次 worker-request.json、prompt.txt、列出的附件和本次 web-generation.json，立即按下列步骤执行。不要在 accepted 前审查项目、扫描目录或调用额外工具。

强制执行边界：
- 禁止调用 image_gen 或任何图片生成 API。
- 禁止接管用户已有标签页；禁止导航或写入已有的温蒂创作室标签页。生产主路径只能新建本次任务专用的 Chrome extension 标签页，不使用 Codex IAB，也不在失败后切回 IAB。
- Chrome extension 的公开 createBrowserTab 不支持隐藏参数，绝不传入 visible，不调用隐藏、坐标、系统鼠标、系统键盘或脆弱快捷键。当前公开 CUA 只有 getState、listBrowsers、listTabs、getBrowser、createBrowserTab、getTab 等浏览器入口，没有窗口/标签页 active 或 focused 更新接口，也没有可验证的后台 Playwright contract。不得把不存在的 management API 当作可用能力，不得调用 cua.getTab 或从 cua.listTabs 选取、接管已有标签页。
- createBrowserTab 可能让 Chrome 短暂切换到这个新标签页；这是已知边界，无法严格保证零焦点切换，也不能把本次执行描述成后台隐藏。创建后所有 Playwright 操作只绑定返回的自有 tab；完成或失败都由外层 finally 统一清理。温蒂创作室已有标签页只保留其原内容，不导航、不写入、不选择它，也不尝试伪造焦点恢复。
- 唯一允许的创建调用是 const tab=await cua.createBrowserTab("chrome",undefined,{sessionName:"🎨 温蒂生图"})；先创建一个自己拥有的空白专用 tab，再导航到 chatgpt.com。只创建一个专用 tab，不允许省略 sessionName、不允许再创建第二个标签页。若 createBrowserTab 或 tab.goto 出现 user declined、denied permission、browser security policy 等 chatgpt.com 站点源权限拒绝，必须原子写入 errorCode=BROWSER_ORIGIN_PERMISSION_DENIED、state=failed、submitted=false；这不是 BROWSER_CHROME_UNAVAILABLE，禁止上传或发送，也不要退回 IAB 或其他标签页重试。只有真正的 Chrome extension/浏览器能力不可用才记录 BROWSER_FOCUS_UNAVAILABLE 或 BROWSER_CHROME_UNAVAILABLE。
- createBrowserTab 的 request-header policy 前置加载失败（例如“Unable to load browser request-header policy”）必须单独按 Chrome 前置能力失败处理：这不是 chatgpt.com 站点源权限拒绝，也不是导航已成功。该调用只允许尝试一次；无论错误提示是否写着 Retry，都不得盲目再次调用 createBrowserTab、cua.getTab、cua.listTabs 或创建第二个 tab，以免一次调用已经产生的自有 tab 漏泄成双 tab。若没有可确认归属的返回 tab，原子写入 errorCode=BROWSER_CHROME_UNAVAILABLE、state=failed、submitted=false、referenceCount=0，并在 error 中保留 request-header policy 前置失败；若已返回一个自有 tab，只继续使用它并在 finally 清理。
- 上传只能使用该 tab 的 Playwright 文件选择流程。必须从 worker-request.json 解析出 worker.referenceFiles，并把这个完整数组原样传给 chooser.setFiles(worker.referenceFiles)；不得凭记忆、重新手打、改写 UUID 或从文字清单重构路径。每次上传前先读取当前 DOM，不得依赖某一个固定中文按钮文案：从当前可访问名称中有限地寻找附件入口（例如“添加文件”“添加照片和文件”“上传文件”“附件”或英文 attach/upload 的按钮/菜单项，允许同义变体和正则匹配），确认它属于当前对话后再点击。点击后先用一个短时有界的 waitForEvent("filechooser") 观察是否直接打开选择器；若超时，只丢弃这个已结束的 waiter，重新读取 DOM，定位明确的菜单项（例如“从电脑上传”“上传文件”“添加照片和文件”或对应英文 upload/from computer），然后为这一次菜单点击创建全新的短时有界 filechooser waiter，再 await chooser.setFiles(worker.referenceFiles)。每条分支只能执行一次实际上传动作，禁止保留悬挂 chooser promise、无限等待或用同一个 waiter 跨分支复用。先检查 chooser.isMultiple()：支持多选时按冻结顺序一次 setFiles 全部文件；不支持多选时，按附件顺序逐项重新读取 DOM、逐项点击入口/菜单、逐项 setFiles，并在每项后刷新 DOM 核对新增附件名称或数量。禁止调用 cua.getApp、macOS 原生文件选择器、系统鼠标或键盘。任何上传错误记录 FILE_UPLOAD_CHROME_UNAVAILABLE、submitted=false、referenceCount=0 并交给外层 finally 清理，禁止切换到 IAB 或其他标签页重试。
- 只在 https://chatgpt.com/ 中通过正常聊天界面提交一次生图请求。不得重复提交，不发布或分享会话。
- 参考文件必须作为彼此独立的附件上传并逐项确认。不得用截图代替附件。
- 完成后必须下载网页生成的原始图片。网页截图、屏幕截图和程序绘制图片都不能作为结果。
- 除写入下列目标图片和执行记录外，不修改本地文件。

执行步骤：
1. 真正开始处理本次 requestId（${requestId||'从 worker-request.json 读取'}）并核对 worker-request.json 中的 manifestFile、instructionFile 和 outputFile 后，先原子更新 ${JSON.stringify(path.resolve(manifestFile))} 为 provider=${WEB_IMAGE_PROVIDER}、transport=${WEB_IMAGE_TRANSPORT}、focusPolicy=${WEB_IMAGE_FOCUS_POLICY}、state=accepted、accepted=true、requestId（必须完全匹配）、acceptedAt。所有时间只能由 new Date().toISOString() 取得，禁止手写、缩写或插入占位字符。这个状态是执行器开始处理的凭据；若无法写入，写 state=failed、submitted=false、errorCode 和 error 后停止。未写入 accepted 前不得打开或准备网页、登录、上传附件。开始前必须读取 worker-request.json，确认 authorization.confirmed=true 且 requestId 匹配；否则停止。
2. 使用当前工具公开的 const tab=await cua.createBrowserTab("chrome",undefined,{sessionName:"🎨 温蒂生图"}) 新建一个自己拥有的空白专用 Chrome 标签页并保存 tab handle；不传入 visible，不创建第二个标签页。随后只能在同一个 try { await tab.goto("https://chatgpt.com")；执行本次页面的导航、登录、上传、发送和下载 } finally { await tab.close() } 结构中操作。创建时 Chrome 可能短暂取得焦点，公开 CUA 没有焦点恢复接口，因此不得声称零焦点切换或后台隐藏。${conversation}
3. 等待页面完成加载并读取新状态，不用首屏占位内容判断登录。若存在“聊天/工作”切换，选择“聊天”并确认选中；不得在“工作”模式发送生图提示。确认已登录且聊天输入框可用，在添加菜单确认“创建图片”入口（需要时选择该模式）。若显示登录按钮，写 failed、submitted=false、referenceCount=0、errorCode=CHATGPT_LOGIN_REQUIRED；随后停止，不得上传或发送。按上一条 DOM 自适应的两段式附件流程上传所有参考文件，并在每次菜单变化后重新读取 DOM、逐项确认附件；不得操作系统文件选择窗口。
4. 在发送聊天消息前，原子更新同一清单为 state=ready、conversationUrl、referenceCount、submitted=false、requestId、acceptedAt 和 readyAt。附件名和数量匹配后，继续有界等待所有附件上传进度或“等待文件上传”状态消失，最长 180 秒；每次核对都从新 DOM 读取。只有发送按钮真实可用才能进入下一步；按钮仍 disabled 时禁止点击。若超时后提示词仍在输入框、没有新用户消息且没有生成状态，写 state=failed、submitted=false、submissionIntent=true、preSubmissionFailure=true、errorCode=FILE_UPLOAD_CHROME_UNAVAILABLE 后停止；这是可证明的未发送，不得写 submittedAt。
5. 发送前再次核对 worker-request.json 的 authorization.confirmed 和 requestId；授权撤销则停止。点击前只原子记录 state=ready、submissionIntent=true、submitted=false、conversationUrl、requestId 和 submissionAttemptAt，然后且只然后点击一次已确认可用的发送按钮。点击后必须用新 DOM 正向证明至少一项：输入框已清空并出现本次新的用户消息，或页面已出现本次生成进度/停止生成控件。只有这个正向证据出现后，才原子更新 state=submitted、submitted=true、submittedAt、submissionConfirmedBy。如果点击返回但无法证明既未发送也未送达，为安全起见写 submitted=true、submissionUncertain=true、state=failed，保留未知结果并绝不再点击。页面显示生成中时只等待，绝不再次发送。
6. 页面显示生成完成后，从下载控件取得原始 PNG/JPG/WebP，复制到准确路径 ${path.resolve(outputFile)}。不得把缩略图或截图当成原图。
7. 验证目标文件存在且可读取，把清单更新为 state=downloaded、submitted=true、artifactPath、conversationUrl、requestId、acceptedAt 和 downloadedAt。公开 CUA 没有焦点恢复接口，不报告焦点已恢复，最后只返回真实原图绝对路径和会话 URL。
8. 如果已有正向送达证据后发生任何错误，仍须更新清单为 state=failed、submitted=true、requestId、acceptedAt、conversationUrl、errorCode 和 error。不要重发；无论导航、登录、上传、发送或下载在哪一步失败，都由外层 finally 统一关闭本次自己创建的专用 tab；提交前若失败，写 submitted=false；不得退回 IAB 或其他浏览器重试。

附件绝对路径（按此顺序上传）：
${listedFiles(referenceFiles)}

附件规则：两张温蒂人设必须同时作为身份参考；其他附件只锁定对应环境、物件或编辑目标。${action}

冻结制作要求：
${capsule}

本次单张要求：
${prompt}`;
}

function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(temp,file);
}

function readJsonObject(file){
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
  }catch{return null;}
}

function textFromBrowserToolResult(result){
  if(!result||typeof result!=='object')return [];
  const content=Array.isArray(result.content)?result.content:[];
  return content.flatMap(block=>block&&typeof block==='object'&&block.type==='text'&&typeof block.text==='string'?[block.text]:[]);
}

/**
 * Read only terminal results from the owned browser tool. In particular, do
 * not search the complete events.jsonl: it also contains the frozen prompt,
 * agent messages, command arguments and command output, all of which can
 * repeat words such as "permission" without describing the browser result.
 */
function structuredBrowserToolResultText(dir){
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

function identityFields(value){
  if(!value||typeof value!=='object')return {};
  const fields={};
  for(const key of ['projectId','projectVersion','taskId','target']){
    if(value[key]!==undefined&&value[key]!==null&&value[key]!=='')fields[key]=value[key];
  }
  return fields;
}

function sameIdentityValue(left,right,key){
  if(left===undefined||left===null||left===''||right===undefined||right===null||right==='')return true;
  return key==='projectVersion'?Number(left)===Number(right):String(left)===String(right);
}

/**
 * Keep a terminal permission error tied to this exact request and CLI run.
 * A stale event file or a worker from another task must never rewrite the
 * current manifest into a different failure category.
 */
function browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest}={}){
  const runId=path.basename(path.resolve(dir||''));
  const worker=readJsonObject(path.join(dir,'worker-request.json'));
  const request=readJsonObject(path.join(dir,'request.json'));
  const execution=readJsonObject(path.join(dir,'execution.json'));
  if(!worker||worker.provider!==WEB_IMAGE_PROVIDER||worker.requestId!==requestId)return false;
  if(request?.provider!==undefined&&request.provider!==WEB_IMAGE_PROVIDER)return false;
  if(manifest?.provider!==WEB_IMAGE_PROVIDER)return false;
  if(manifest?.requestId!==requestId)return false;
  if(worker.manifestFile&&path.resolve(String(worker.manifestFile))!==path.resolve(String(manifestFile||'')))return false;
  if(outputFile&&path.resolve(String(worker.outputFile||''))!==path.resolve(String(outputFile)))return false;
  const modern=Boolean(worker.runId||worker.outputFile||manifest.runId||execution?.runId);
  if(modern&&(!worker.manifestFile||!worker.outputFile||!worker.runId||!manifest.runId||!execution))return false;
  if(worker.manifestFile&&path.resolve(String(worker.manifestFile))!==path.resolve(String(manifestFile||'')))return false;
  if(worker.outputFile&&outputFile&&path.resolve(String(worker.outputFile))!==path.resolve(String(outputFile)))return false;
  if(!execution||String(execution.runId||'')!==runId)return false;
  if(request?.requestId!==undefined&&String(request.requestId)!==requestId)return false;
  if(request?.runId!==undefined&&String(request.runId)!==runId)return false;
  if(request?.run_id!==undefined&&String(request.run_id)!==runId)return false;
  if(manifest?.runId!==undefined&&String(manifest.runId)!==runId)return false;
  if(manifest?.run_id!==undefined&&String(manifest.run_id)!==runId)return false;
  if(worker.runId!==undefined&&String(worker.runId)!==runId)return false;
  if(request?.expectedOutput){
    const projectRoot=path.resolve(dir,'..','..');
    if(path.resolve(projectRoot,String(request.expectedOutput))!==path.resolve(String(outputFile||worker.outputFile||'')))return false;
  }
  const sources=[request,worker,manifest];
  for(const key of ['projectId','projectVersion','taskId','target']){
    if(request?.[key]!==undefined&&!sameIdentityValue(request[key],worker?.[key],key))return false;
    for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++){
      if(!sameIdentityValue(sources[i]?.[key],sources[j]?.[key],key))return false;
    }
  }
  return true;
}

function browserRunEvidenceText(dir,{manifest=null,failure=null}={}){
  const browserResult=structuredBrowserToolResultText(dir);
  let stderr='';
  try{stderr=fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').split('\n').flatMap(line=>{try{const event=JSON.parse(line);return typeof event?.stderr==='string'?[event.stderr]:[];}catch{return [];}}).join('\n');}catch{}
  return [manifest?.errorCode,manifest?.error,manifest?.message,failure?.code,failure?.message,stderr,browserResult].filter(Boolean).join('\n');
}

function explicitManifestErrorCode(manifest){
  const code=String(manifest?.errorCode||'').trim();
  return code||null;
}

function browserFailurePrefix(errorCode){
  if(errorCode==='FILE_UPLOAD_CHROME_UNAVAILABLE')return '专用 Chrome 标签页的附件入口未能打开浏览器文件选择器';
  if(errorCode==='BROWSER_ORIGIN_PERMISSION_DENIED')return 'Chrome 已连接，但 chatgpt.com 访问权限被拒绝；下次重试出现浏览器访问询问时请选择“允许”';
  if(errorCode==='IAB_UNAVAILABLE')return '历史 Codex 内嵌浏览器 IAB 不可用';
  if(errorCode==='BROWSER_TAB_BACKGROUND_UNAVAILABLE')return 'Chrome 专用标签页的非前台操作能力不可用';
  if(errorCode==='BROWSER_CHROME_UNAVAILABLE')return 'Chrome extension 不可用';
  if(errorCode==='BROWSER_FOCUS_RESTORE_FAILED_AFTER_CLOSE')return 'Chrome 专用标签页关闭后无法安全恢复创作室焦点';
  if(errorCode==='BROWSER_FOCUS_RESTORE_FAILED')return 'Chrome 专用标签页无法安全恢复创作室焦点';
  return 'Chrome 专用标签页无法安全保持温蒂创作室焦点，无法零焦点切换';
}

function originPermissionDeniedForRun({dir,manifestFile,outputFile,requestId,manifest}={}){
  if(!manifest||manifest.state!=='failed'||!Object.prototype.hasOwnProperty.call(manifest,'submitted')||manifest.submitted!==false)return false;
  if(!browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest}))return false;
  const explicit=explicitManifestErrorCode(manifest);
  // A concrete manifest code is authoritative. A stale/incorrect origin code
  // may be retained as-is; it is not inferred from unrelated event text.
  if(explicit)return explicit==='BROWSER_ORIGIN_PERMISSION_DENIED';
  return BROWSER_ORIGIN_PERMISSION_DENIED_ERROR.test(structuredBrowserToolResultText(dir));
}

function uploadUnavailableForRun({dir,manifestFile,outputFile,requestId,manifest}={}){
  if(!manifest||manifest.state!=='failed'||manifest.submitted!==false)return false;
  if(!browserRunIdentityMatches({dir,manifestFile,outputFile,requestId,manifest}))return false;
  const explicit=explicitManifestErrorCode(manifest);
  if(explicit)return explicit==='FILE_UPLOAD_CHROME_UNAVAILABLE';
  return FILE_UPLOAD_CHROME_UNAVAILABLE_ERROR.test(structuredBrowserToolResultText(dir));
}

function browserPreSubmissionUnavailableText(value){
  const text=String(value||'');
  return IAB_UNAVAILABLE_ERROR.test(text)||FILE_UPLOAD_CHROME_UNAVAILABLE_ERROR.test(text)||BROWSER_ORIGIN_PERMISSION_DENIED_ERROR.test(text)||BROWSER_FOCUS_ERROR.test(text)||BROWSER_TAB_BACKGROUND_ERROR.test(text)||CHROME_UNAVAILABLE_ERROR.test(text);
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
  const originPermissionDenied=!explicit&&browserRunIdentityMatches(identity)&&BROWSER_ORIGIN_PERMISSION_DENIED_ERROR.test(structured);
  const uploadUnavailable=!explicit&&uploadUnavailableForRun({dir,manifestFile,outputFile:worker?.outputFile,requestId,manifest});
  const historicalIab=!explicit&&IAB_UNAVAILABLE_ERROR.test(String(failure?.code||failure?.message||''));
  const errorCode=explicit|| (uploadUnavailable?'FILE_UPLOAD_CHROME_UNAVAILABLE':originPermissionDenied?'BROWSER_ORIGIN_PERMISSION_DENIED':historicalIab?'IAB_UNAVAILABLE':BROWSER_TAB_BACKGROUND_ERROR.test(detail)?'BROWSER_TAB_BACKGROUND_UNAVAILABLE':CHROME_UNAVAILABLE_ERROR.test(detail)?'BROWSER_CHROME_UNAVAILABLE':BROWSER_FOCUS_ERROR.test(detail)&&/RESTORE_FAILED_AFTER_CLOSE/i.test(detail)?'BROWSER_FOCUS_RESTORE_FAILED_AFTER_CLOSE':BROWSER_FOCUS_ERROR.test(detail)&&/RESTORE_FAILED/i.test(detail)?'BROWSER_FOCUS_RESTORE_FAILED':'BROWSER_FOCUS_UNAVAILABLE');
  const prefix=browserFailurePrefix(errorCode);
  writeJson(manifestFile,{...manifest,state:'failed',accepted:manifest.accepted===true,submitted:false,submissionIntent:false,preSubmissionFailure:true,referenceCount:0,errorCode,focusPolicy:WEB_IMAGE_FOCUS_POLICY,error:`${prefix}；未上传附件或发送消息。原始错误：${detail}`,failedAt:new Date().toISOString()});
  return readWebManifest(manifestFile);
}

function normalizeOriginPermissionDenied({manifestFile,requestId,dir,outputFile,manifest,failure}={}){
  if(!originPermissionDeniedForRun({dir,manifestFile,outputFile,requestId,manifest,failure}))return null;
  const detail=String(browserRunEvidenceText(dir,{manifest,failure})).slice(0,1000);
  const explicit=explicitManifestErrorCode(manifest),errorCode=explicit||'BROWSER_ORIGIN_PERMISSION_DENIED';
  writeJson(manifestFile,{...manifest,state:'failed',accepted:manifest.accepted===true,submitted:false,submissionIntent:false,preSubmissionFailure:true,referenceCount:0,errorCode,focusPolicy:WEB_IMAGE_FOCUS_POLICY,error:`${browserFailurePrefix(errorCode)}；未上传附件或发送消息。原始错误：${detail}`,failedAt:manifest.failedAt||new Date().toISOString()});
  return readWebManifest(manifestFile);
}

function browserPreSubmissionFailureObserved(dir,failure,manifest=null){
  return browserPreSubmissionUnavailableText(browserRunEvidenceText(dir,{failure,manifest}));
}

function finalizeWorkerResult({dir,manifestFile,outputFile,requestId,result,failure,model,reasoningEffort,role}){
  let manifest=readWebManifest(manifestFile);
  const normalizedOrigin=normalizeOriginPermissionDenied({manifestFile,requestId,dir,outputFile,manifest,failure});
  if(normalizedOrigin)manifest=normalizedOrigin;
  else if((failure||explicitManifestErrorCode(manifest))&&browserPreSubmissionFailureObserved(dir,failure,manifest))manifest=recordBrowserPreSubmissionFailure(manifestFile,requestId,failure,dir);
  if(manifest?.requestId===requestId&&(!manifest.role||!manifest.executorReasoningEffort)){
    writeJson(manifestFile,{...manifest,role:manifest.role||role,executorModel:(manifest.executorModel??model)||null,executorReasoningEffort:manifest.executorReasoningEffort||reasoningEffort});
    manifest=readWebManifest(manifestFile);
  }
  const matches=manifest?.requestId===requestId;
  if(matches&&manifest.state==='downloaded'&&manifest.accepted===true&&manifest.submitted===true&&path.resolve(manifest.artifactPath||'')===path.resolve(outputFile)&&fs.existsSync(outputFile))return {...result,text:outputFile,manifest};
  if(matches&&manifest.state==='failed'){
    const error=new Error(manifest.error||'网页生成未完成。');error.code=manifest.errorCode||'WEB_IMAGE_FAILED';error.webManifest=manifest;throw error;
  }
  const error=failure||new Error('执行已结束，但没有取得已核实原图。记录已保留，请检查已有图片；不会自动重试。');error.webManifest=manifest;throw error;
}

function archivePreAcceptanceAttempt(dir,manifest,execution){
  const attemptsDir=path.join(dir,'attempts');fs.mkdirSync(attemptsDir,{recursive:true});
  const serial=String(fs.readdirSync(attemptsDir).filter(name=>/^\d{3}-preaccept-usage-limit$/.test(name)).length+1).padStart(3,'0');
  const archive=path.join(attemptsDir,`${serial}-preaccept-usage-limit`);fs.mkdirSync(archive,{recursive:false});
  for(const name of ['execution.json','events.jsonl','response.txt','result.json','prompt.txt','web-generation.json']){
    const source=path.join(dir,name);if(fs.existsSync(source))fs.copyFileSync(source,path.join(archive,name));
  }
  writeJson(path.join(archive,'attempt.json'),{schemaVersion:1,requestId:manifest.requestId,state:manifest.state,accepted:manifest.accepted===true,submitted:manifest.submitted===true,referenceCount:Number(manifest.referenceCount)||0,executionState:execution.state,error:execution.error||null,archivedAt:new Date().toISOString()});
  return path.relative(dir,archive);
}

function archiveConfirmedUnsentAttempt(dir,manifest,execution,audit){
  const attemptsDir=path.join(dir,'attempts');fs.mkdirSync(attemptsDir,{recursive:true});
  const serial=String(fs.readdirSync(attemptsDir).filter(name=>/^\d{3}-/.test(name)).length+1).padStart(3,'0');
  const archive=path.join(attemptsDir,`${serial}-confirmed-unsent`);fs.mkdirSync(archive,{recursive:false});
  for(const name of ['execution.json','events.jsonl','response.txt','result.json','prompt.txt','web-generation.json','web-audit.json']){
    const source=path.join(dir,name);if(fs.existsSync(source))fs.copyFileSync(source,path.join(archive,name));
  }
  writeJson(path.join(archive,'attempt.json'),{schemaVersion:1,requestId:manifest.requestId,state:manifest.state,accepted:manifest.accepted===true,submitted:manifest.submitted===true,submissionIntent:manifest.submissionIntent===true,referenceCount:Number(manifest.referenceCount)||0,executionState:execution.state,errorCode:manifest.errorCode||null,error:manifest.error||execution.error||null,auditResult:audit.result,archivedAt:new Date().toISOString()});
  return path.relative(dir,archive);
}

function assertExpectedIdentity(expected,request,worker,manifest){
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
  const manifestFile=path.join(dir,'web-generation.json'),instructionFile=path.join(dir,'prompt.txt'),requestFile=path.join(dir,'worker-request.json');
  if(fs.existsSync(requestFile))throw new Error('这个图片请求已存在，请检查已有结果，不会再次执行。');
  const requestId=crypto.randomUUID(),createdAt=new Date().toISOString();
  const runId=path.basename(path.resolve(dir)),requestIdentity=identityFields(readJsonObject(path.join(dir,'request.json')));
  writeJson(manifestFile,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,transport:WEB_IMAGE_TRANSPORT,browser:WEB_IMAGE_BROWSER,focusPolicy:WEB_IMAGE_FOCUS_POLICY,role,executorModel:model||null,executorReasoningEffort:reasoningEffort,...requestIdentity,runId,state:'queued',requestId,accepted:false,submitted:false,referenceCount:0,createdAt});
  writeJson(requestFile,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,transport:WEB_IMAGE_TRANSPORT,browser:WEB_IMAGE_BROWSER,focusPolicy:WEB_IMAGE_FOCUS_POLICY,role,executorModel:model||null,executorReasoningEffort:reasoningEffort,...requestIdentity,runId,requestId,authorization:{confirmed:true,scope:'one_chatgpt_web_image_submission',confirmedAt:createdAt},instructionFile,manifestFile,outputFile:path.resolve(outputFile),referenceFiles:referenceFiles.map(file=>path.resolve(file)),createdAt});
  let result,failure;
  try{result=await runCodex({codexBin,dir,image:true,browserMode:'chrome',signal,timeoutMs,model,reasoningEffort,role,writableDirs:[path.dirname(path.resolve(outputFile))],prompt:chatGptWebImagePrompt({outputFile,manifestFile,prompt,referenceFiles,editTarget,conversationUrl,capsule,requestId})});}catch(error){failure=error;}
  return finalizeWorkerResult({dir,manifestFile,outputFile,requestId,result,failure,model,reasoningEffort,role});
}

/** Resume only a proven pre-acceptance quota stop or a separately audited,
 * definite no-send browser attempt, preserving the original requestId. */
export async function resumeChatGptWebJob({codexBin,dir,signal,timeoutMs=900000,model=null,reasoningEffort=WEB_IMAGE_EXECUTOR_EFFORT,role=WEB_IMAGE_EXECUTOR_ROLE,expected={},instruction=null}){
  if(signal?.aborted)throw new Error('已暂停，尚未续接图片任务。');
  const manifestFile=path.join(dir,'web-generation.json'),requestFile=path.join(dir,'request.json'),workerFile=path.join(dir,'worker-request.json'),executionFile=path.join(dir,'execution.json'),eventsFile=path.join(dir,'events.jsonl');
  const manifest=readWebManifest(manifestFile),request=readJsonObject(requestFile),worker=readJsonObject(workerFile),execution=readJsonObject(executionFile);
  if(!manifest||!request||!worker||!execution)throw new Error('待续接图片请求缺少完整执行记录；不会创建第二个请求。');
  assertExpectedIdentity(expected,request,worker,manifest);
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
  const resumePatch={...manifest,state:'queued',accepted:false,submitted:false,submissionIntent:false,submissionUncertain:false,preSubmissionFailure:false,referenceCount:0,acceptedAt:null,readyAt:null,submissionAttemptAt:null,submittedAt:null,downloadedAt:null,artifactPath:null,errorCode:null,error:null,resumeCount:Number(manifest.resumeCount||0)+1,resumedAt};
  if(preAcceptance)resumePatch.lastPreAcceptanceAttempt=archive;else {resumePatch.lastConfirmedUnsentAttempt=archive;resumePatch.confirmedUnsentAudit='web-audit.json';}
  writeJson(manifestFile,resumePatch);
  let result,failure;
  try{result=await runCodex({codexBin,dir,image:true,browserMode:'chrome',signal,timeoutMs,model:model||worker.executorModel||null,reasoningEffort:reasoningEffort||worker.executorReasoningEffort||WEB_IMAGE_EXECUTOR_EFFORT,role:role||worker.role||WEB_IMAGE_EXECUTOR_ROLE,writableDirs:[path.dirname(outputFile)],prompt:nextInstruction});}catch(error){failure=error;}
  const after=readWebManifest(manifestFile);if(after?.requestId===requestId&&!after.resumeCount)writeJson(manifestFile,{...after,resumeCount:Number(manifest.resumeCount||0)+1,resumedAt,...(preAcceptance?{lastPreAcceptanceAttempt:archive}:{lastConfirmedUnsentAttempt:archive,confirmedUnsentAudit:'web-audit.json'})});
  return finalizeWorkerResult({dir,manifestFile,outputFile,requestId,result,failure,model:model||worker.executorModel||null,reasoningEffort:reasoningEffort||worker.executorReasoningEffort||WEB_IMAGE_EXECUTOR_EFFORT,role:role||worker.role||WEB_IMAGE_EXECUTOR_ROLE});
}
