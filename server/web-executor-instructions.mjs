import path from 'node:path';
import {buildManifestCommands} from './web-manifest-commands.mjs';
import {ownedTabSessionName} from './owned-tab-lease.mjs';
import {assertRemotePrompt} from './remote-prompt.mjs';
import {BROWSER_CLEANUP_MARKER} from './bridge.mjs';
import {BROWSER_READINESS_CONTROLS_SOURCE,BROWSER_READINESS_EVALUATOR_SOURCE,BROWSER_READINESS_TIMEOUT_MS,BROWSER_READINESS_WAITER_SOURCE} from './browser-readiness.mjs';

function listedFiles(files=[]){
  return files.map((file,index)=>`${index+1}. ${JSON.stringify(path.resolve(file))}`).join('\n');
}

function initialNavigationUrl(conversationUrl){
  if(!conversationUrl)return 'https://chatgpt.com/';
  let target;
  try{target=new URL(String(conversationUrl));}catch{throw new Error('conversationUrl 必须是有效的 ChatGPT 会话地址。');}
  if(target.protocol!=='https:'||target.origin!=='https://chatgpt.com'||target.username||target.password||!target.pathname.startsWith('/c/'))throw new Error('conversationUrl 必须指向 https://chatgpt.com/c/ 下的会话。');
  return target.href;
}

/**
 * Build the mechanical browser instruction separately from provider
 * orchestration. The only text intended for the remote ChatGPT conversation
 * remains inside the remote_prompt delimiters at the end of this message.
 */
export function chatGptWebImagePrompt({outputFile,manifestFile,prompt,remotePrompt=prompt,remotePromptLength=null,remotePromptSha256=null,referenceFiles=[],editTarget=null,conversationUrl=null,capsule='',requestId=null,runId=null,sessionName=null}){
  const frozenRemotePrompt=assertRemotePrompt(remotePrompt,{expectedLength:remotePromptLength,expectedSha256:remotePromptSha256});
  const resolvedRunId=runId||path.basename(path.dirname(path.resolve(manifestFile)));
  // Keep the historical fixed label only for legacy prompt-only callers. All
  // real direct-chrome requests pass requestId and receive a per-run token.
  const resolvedSessionName=sessionName||((requestId||runId)?ownedTabSessionName(resolvedRunId,requestId):'🎨 温蒂生图');
  const startUrl=initialNavigationUrl(conversationUrl);
  const commands=buildManifestCommands(manifestFile,{requestId,sessionName:resolvedSessionName});
  const downloadEvidenceFile=path.join(path.dirname(path.resolve(manifestFile)),'download-evidence.json');
  const action=editTarget
    ? '第一项附件是待编辑原图。请只修订明确指出的问题，保持其他正确内容。'
    : '创建一张新的独立分镜图。';
  const conversation=conversationUrl
    ? `优先继续这个既有对话以保持编辑上下文：${String(conversationUrl)}。target URL 已冻结；bootstrap 中只允许一次 goto 直达该完整地址，禁止先打开 chatgpt.com 首页、重定向重试或创建第二个 tab；导航后不得再次 goto。若 target 不可用，不得改在新聊天发送，以免丢失本条修订上下文。`
    : '导航到 ChatGPT 并在该会话中创建图片。';
  const bootstrapExample=`// WENDI_BROWSER_READINESS_GATE_V1
const tab=globalThis.__wendiOwnedTab;
const ownedTabId=String(globalThis.__wendiOwnedTabId||'');
const runId=${JSON.stringify(resolvedRunId)};
const expectedUrl=${JSON.stringify(startUrl)};
if(!tab||!ownedTabId||String(tab.id)!==ownedTabId)throw new Error('owned tab identity mismatch');
await tab.goto(${JSON.stringify(startUrl)});
const evaluateReadiness=${BROWSER_READINESS_EVALUATOR_SOURCE};
const summarizeControls=${BROWSER_READINESS_CONTROLS_SOURCE};
const waitForBrowserReadiness=${BROWSER_READINESS_WAITER_SOURCE};
let chatModeSwitchAttempted=false;
let lastAx='';
const readiness=await waitForBrowserReadiness({timeoutMs:${BROWSER_READINESS_TIMEOUT_MS},pollIntervalMs:1000,read:async()=>{const currentUrl=await tab.url();lastAx=String(await tab.getAXState({emit:false,disableDiffing:true}));return evaluateReadiness({currentUrl,expectedUrl,ax:lastAx,ownedTabId,runId});},onNotReady:async value=>{if(!chatModeSwitchAttempted&&value?.checks?.targetUrlMatches===true&&value.checks.loginRequired===false&&value.checks.profileLoaded===true&&value.checks.explicitChatMode===true&&value.checks.chatModeEnabled===true&&value.checks.chatModeSelected===false){chatModeSwitchAttempted=true;try{const chatMode=tab.playwright.getByRole('checkbox',{name:/^(聊天|Chat)$/});if(await chatMode.count()===1 && await chatMode.isEnabled()) await chatMode.check({timeoutMs:5000});}catch{}}},wait:ms=>tab.playwright.waitForTimeout(ms)});
if(readiness?.ready!==true)nodeRepl.write('WENDI_BROWSER_AX_V1:'+JSON.stringify(summarizeControls(lastAx)));
nodeRepl.write('WENDI_BROWSER_READY_V1:'+JSON.stringify(readiness));`;
  const uploadEntryDiagnostic=`const uploadEntryAx=String(await tab.getAXState({emit:false,disableDiffing:true}));
const uploadEntryLines=uploadEntryAx.split(/\\r?\\n/).filter(line=>/\\b(?:button|menu item|menuitem)\\b/i.test(line));
const uploadEntryCandidates=uploadEntryLines.filter(line=>/添加|上传|文件|照片|attach|upload|file|photo/i.test(line));
const uploadEntryControls=(uploadEntryCandidates.length?uploadEntryCandidates:uploadEntryLines).slice(0,6).map(line=>line.trim().slice(0,100));
nodeRepl.write('WENDI_UPLOAD_ENTRY_V1:'+JSON.stringify({controls:uploadEntryControls,matchingControlCount:uploadEntryCandidates.length,controlCount:uploadEntryLines.length}));`;
  const cleanupExample=`// ${BROWSER_CLEANUP_MARKER} --run-id ${JSON.stringify(resolvedRunId)} --owned-tab-id "<实际 ownedTabId>" --state closing
const tab=globalThis.__wendiOwnedTab;
const ownedTabId=globalThis.__wendiOwnedTabId;
if(!tab||String(ownedTabId)!=="<实际 ownedTabId>") throw new Error("owned tab identity mismatch");
let cleanupStatus="close_failed";
try { await tab.close(); cleanupStatus="closed"; }
finally { nodeRepl.write(JSON.stringify({cleanupStatus,ownedTabId:String(ownedTabId)})); }`;
  const instruction = `你是温蒂创作室的后台网页生图执行器。用户已经在温蒂创作室网页执行带防重复标识的确认动作，明确授权本次单张生图和把下列参考图片上传到 chatgpt.com。授权、身份和附件台账已由本地 provider 冻结并验证；它已经满足发送前确认，不得再次询问；上传、发送、等待和下载必须在当前同一个回合完成。

你只负责机械执行已经冻结的本次请求，不负责创意规划、质量判断或任务恢复。禁止读取仓库、memory、历史任务、其他作品、其他会话或任何未列出的文件；禁止自行调研、搜索或改写提示词。浏览器执行脚本不得使用 Node 模块加载器或自行读取本地控制文件；provider 已直接提供本次唯一的冻结附件路径和 remotePrompt，立即按下列步骤执行。所有 manifest/lease helper 只能作为独立的 command_execution 调用，由父流程提供并校验；不得在 CUA js 脚本中拼接、执行或模拟本地 node 命令。CUA js 只允许调用本次返回的 cua/tab/pageAssets 能力和文档支持的精简结果写出接口。不要在 accepted 前审查项目、扫描目录或调用额外工具。

强制执行边界：
- 禁止调用 image_gen 或任何图片生成 API。
- 禁止接管用户已有标签页；禁止导航或写入已有的温蒂创作室标签页。生产主路径只能新建本次任务专用的 Chrome extension 标签页，不使用 Codex IAB，也不在失败后切回 IAB。
- Chrome extension 的公开 createBrowserTab 不支持隐藏参数，绝不传入 visible，不调用隐藏、坐标、系统鼠标、系统键盘或脆弱快捷键。当前公开 CUA 只有 getState、listBrowsers、listTabs、getBrowser、createBrowserTab、getTab 等浏览器入口，没有窗口/标签页 active 或 focused 更新接口，也没有可验证的后台 Playwright contract。不得把不存在的 management API 当作可用能力；本次执行禁止调用 cua.getApp、cua.getTab 或从 cua.listTabs 选取、接管已有标签页。
- createBrowserTab 可能让 Chrome 短暂切换到这个新标签页；这是已知边界，无法严格保证零焦点切换，也不能把本次执行描述成后台隐藏。创建后所有 Playwright 操作只绑定返回的自有 tab；完成或失败都要用同一个持久句柄清理。温蒂创作室已有标签页只保留其原内容，不导航、不写入、不选择它，也不尝试伪造焦点恢复。
- 本地父流程在启动本执行器前已经持久、原子地完成唯一一次 reserve-create；浏览器执行器禁止再次调用 reserve-create、ensure 或任何其他 lease 创建命令。第一次 CUA js 调用才能执行 globalThis.__wendiOwnedTab=await cua.createBrowserTab("chrome",undefined,{sessionName:${JSON.stringify(resolvedSessionName)}})，且只能创建一个自己拥有的空白专用 tab。createBrowserTab 返回后，立即把 globalThis.__wendiOwnedTabId=globalThis.__wendiOwnedTab.id||null 放入同一持久 CUA kernel，并完整复制生成的短命令执行 ${commands.ownedTabCreated('<实际 ownedTabId>')}；命令中的 sessionName 已由 provider 冻结，不得替换。stage created 返回 ok=true 后才继续网页动作。该命令只以冻结 manifest 路径定位 lease，并从已存在的 lease 读取 runId/requestId，不得补写或猜测第二套身份/路径。不得省略 sessionName、不允许第二次 createBrowserTab。后续每次 CUA 调用都必须从 globalThis.__wendiOwnedTab 取回句柄，不能用跨调用不会保留的 block-scoped const tab 代替。若 stage created 命令失败，但返回句柄仍可用：禁止导航、上传或发送；执行 ${commands.ownedTabStageWriteFailed}，然后进入固定 cleanup，用同一句柄 close，并在 close 返回成功后记录 closed。此类本地命令失败不得报告为 Chrome 扩展故障或句柄丢失。只有 globalThis.__wendiOwnedTab 确实不存在，或该句柄操作抛错且无法继续，才执行 ${commands.browserHandleLost}；不得调用 cua.getTab、cua.listTabs 或再次 createBrowserTab，ownedTabId 只填实际观察到的句柄或 unknown，cleanup 状态按实际结果填写。
- 旧版固定标签名示例 createBrowserTab("chrome",undefined,{sessionName:"🎨 温蒂生图"}) 仅用于识别历史记录，禁止执行；本次实际调用必须使用上面带 run token 的唯一 sessionName。
- 若 createBrowserTab 或 tab.goto 出现 user declined、denied permission、browser security policy 等 chatgpt.com 站点源权限拒绝，必须执行 ${commands.originPermissionDenied}；这不是 BROWSER_CREATE_UNAVAILABLE，禁止上传或发送，也不要退回 IAB 或其他标签页重试。只有真正的 Chrome extension/浏览器能力不可用才记录 ${commands.browserCreateUnavailable} 或 BROWSER_FOCUS_UNAVAILABLE。
- createBrowserTab 的 request-header policy 前置加载失败（例如“Unable to load browser request-header policy”）必须按 BROWSER_CREATE_UNAVAILABLE 处理：这不是 chatgpt.com 站点源权限拒绝，也不是导航已成功。该调用只允许尝试一次；无论错误提示是否写着 Retry，都不得盲目再次调用 createBrowserTab、cua.getTab、cua.listTabs 或创建第二个 tab，以免一次调用已经产生的自有 tab 漏泄成双 tab。若没有可确认归属的返回 tab，原子执行 ${commands.browserHandleLost}，保留真实的 ownedTabId 与 cleanup status，不能写成“tab 不存在”或“已关闭”；若已返回一个自有 tab，只继续使用它并在最后用同一 globalThis.__wendiOwnedTab 清理。
- 如果 CUA kernel 在提交前重置、globalThis 变量丢失或句柄调用抛出无法继续的错误，先停止所有网页动作，再原子执行 ${commands.browserHandleLost}；必须把 kernel-reset=true、owned-tab-cleanup-status=cleanup_pending（除非同一持久句柄真实 close 返回成功）写入这次 pre-submission 失败。不要声称旧 tab 不存在、已被关闭或可以安全接管；新的 Codex 执行器不能重新绑定旧 CUA session，只有本执行器仍持有的原句柄能确认关闭。句柄丢失时保留 cleanup_pending，不得启动另一个 CUA session 试图接管。
- owned tab 阶段必须同步写入本地 lease：创建成功后是 created；开始附件流程前执行 ${commands.ownedTabStage('uploading','<实际 ownedTabId>')}；所有附件 group 按冻结顺序完成且发送按钮 enabled 后执行 ${commands.ownedTabStage('uploaded','<实际 ownedTabId>')}；发送得到正向新用户消息或停止生成控件后执行 ${commands.ownedTabStage('sent','<实际 ownedTabId>')}；页面进入生成中执行 ${commands.ownedTabStage('generating','<实际 ownedTabId>')}；取得原图并复制到目标路径后执行 ${commands.ownedTabStage('downloaded','<实际 ownedTabId>')}。阶段写入失败必须停止网页动作并按对应失败矩阵记录，不能跳过或手工伪造。
- 上传只能使用该 tab 的 Playwright 文件选择流程。provider 已完成并冻结下方五个（或本次明确列出的）附件路径，并完成普通文件、可读性、大小和 sha256 校验；执行器禁止再调用本地文件存在性/权限预检 API，也不得自行重建、排序、改写或猜测附件数组。只能按下方顺序把这些路径交给 chooser：多选时一次 setFiles，单选时按原顺序逐项 setFiles；不得手写/手打路径、截短 UUID 或从文字清单重构数组。
- 附件上传是一个有界批次：最多 2 个 upload CUA 调用。首个上传脚本在同一 owned tab 内依序尝试有 chooser waiter 的路径 A 和必要时路径 B；路径 A 没有 chooser 时只能在这个脚本中继续 B，不得为每个入口另开调用。确定 chooser 后，把整个 provider 冻结附件数组交给 setFiles：多选时一次 setFiles，单选时在同一脚本中按冻结顺序逐项 setFiles；不得按附件逐个调用 CUA。若需要第二个 upload 调用，它只能用于对整批附件做一次有界核验/继续轮询并填入冻结提示词，不得重新打开 chooser、重复 setFiles 或补传部分附件。两个 upload 调用后仍不完整就执行 typed failure，禁止消耗其他阶段预算来继续上传。
- 附件入口只有两条有界路径，且都必须在点击前建立本次动作专属 waiter：路径 A：如果 DOM 直接存在唯一“添加照片和文件/上传照片/上传文件”按钮，先创建 chooserPromise=tab.playwright.waitForEvent("filechooser",{timeoutMs:5000}).catch(()=>null)，再点击该按钮并等待；路径 B：如果没有直接入口，先点击唯一“添加文件等内容”打开菜单，然后在当前脚本内重新读取当前 DOM 的完整 AX 状态（调用 tab.getAXState({emit:false,disableDiffing:true})）并解析菜单项，定位唯一“添加照片和文件/从电脑上传/上传照片/上传文件”菜单项，在点击该菜单项之前重新创建一个全新的有界 waiter，再点击菜单项并等待。父菜单点击本身不等待 chooser，也不把父菜单点击当作附件入口。每条路径最多执行一次；A 没有 chooser 是允许的、可恢复的分支：必须在同一个 owned tab 继续执行 B，不能因为 A 超时就写任何失败命令、WORKER_SCRIPT_RUNTIME_ERROR 或结束本次执行。只有 B 也失败才执行 ${commands.chooserEventTimeout} 或 ${commands.chooserRouteUnavailable}。当 B 的 setFiles 成功且后续 fresh AX state 已证明完整附件时，A 的 timeout 只能作为 alternateRouteUsed=true 的历史字段，不能阻断 uploaded→ready→submission-intent→一次发送。禁止第二个 tab、禁止悬挂 chooser promise、禁止第三条路径，也禁止把“创建图片”菜单项当作附件入口。先检查 chooser.isMultiple()；任何 setFiles 异常执行 ${commands.fileSetFailed}，不要发送。
- 路径 B 也失败时，先在同一个 upload CUA 调用中执行下面的 <upload_entry_diagnostic_cua_fragment>，把当时的按钮和菜单项名称摘要输出到该次 CUA 结果；然后才执行对应 typed failure。不得为诊断另开 CUA 调用，不得把完整 AX 原文输出。
- setFiles 后不能只看附件 group 是否出现。每个 group/逐个附件 group 都必须在当前脚本内从 tab.getAXState({emit:false,disableDiffing:true}) 返回的完整 AX 状态核对数量、名称和冻结顺序（允许只去除 ChatGPT 为同一 basename 增加的确定性数字或时间后缀，例如 YYYYMMDD-HHMMSS；不得以模糊规范化名称代替精确顺序），并核对“上传中/正在上传/处理中/等待文件上传/uploading”状态与发送按钮真实 disabled/enabled。最长 240 秒短时有界轮询，每轮写入 upload-evidence.json 的 uploadMethod、alternateRouteUsed、alternateRouteCount、chooserEventObserved、chooserAttachedBeforeClick、attachmentExpected、attachmentObserved、attachmentNames、attachmentPending、sendEnabled、failureStage；任何数量、名称、顺序、pending 或 sendEnabled 有歧义，都执行 ${commands.attachmentVerificationTimeout}，绝不执行 ready、submission-intent 或发送。若冻结期望为 5 个而观察到 0/5（或任意 observed 数量不是 expected），必须按附件核验失败处理，绝不执行 ready、submission-intent 或发送。只有全部附件验证通过、提示词仍在输入框且 sendEnabled=true，才转到第 4 步保存 baseline，并在第 5 步通过唯一发送门。
- upload-evidence.json 是附件事实的权威快照：只要 attachmentObserved === attachmentExpected、attachmentPending === false、sendEnabled === true 且 failureStage === null，就必须把本次状态视为“已上传、可发送”。不要因为早先路径 A 的 chooser timeout、alternateRouteUsed=true 或旧 DOM 快照里出现过 disabled 按钮而回退失败；按第 4 步结束附件阶段，并继续到第 5 步唯一的 ready、submission-intent 和发送门。
- 任何上传错误在 submission-intent 前执行 ${commands.uploadFailed}；若已经执行 submission-intent 且页面明确证明没有新用户消息，则执行 ${commands.confirmedUnsentUploadFailed}；禁止切换到 IAB 或其他标签页重试。
- 旧记录中的 FILE_UPLOAD_CHROME_UNAVAILABLE 只作为历史兼容代号；现代执行必须使用上面的具体阶段代码和结构化 upload-evidence，不得把所有上传失败重新压成一个通用错误。
- 只在 https://chatgpt.com/ 中通过正常聊天界面提交一次生图请求。不得重复提交，不发布或分享会话。
- 参考文件必须作为彼此独立的附件上传并逐项确认。不得用截图代替附件。
- 完成后必须下载网页生成的原始图片。网页截图、屏幕截图和程序绘制图片都不能作为结果。
- 除写入下列目标图片和执行记录外，不修改本地文件。
- CUA 输出必须保持紧凑：每次浏览器 CUA 调用可能自动附带截图并进入执行器上下文。运行时首次初始化只允许一次独立、精确的 await cua.getState()；它被单独记账，不消耗业务预算，重复调用仍按 bootstrap 计数。父进程按阶段设置有限业务预算：bootstrap（创建 owned tab、唯一目标导航及有界 readiness gate）最多 3 次，但本流程只允许实际创建调用和包含一次 goto 的 readiness bootstrap；不存在额外 bootstrap 恢复调用。upload（整批上传、核验附件、填入 remotePrompt）最多 2 次，submit（ready、submission-intent、一次发送和正向确认）最多 1 次，wait_download（等待生成与 pageAssets 原图下载）最多 2 次；业务总上限仍为 8 次。唯一 readiness bootstrap 必须在同一调用内最多等待 60 秒并输出结构化证据；就绪失败则 typed pre-submit failure，不可另开调用重试。上传最多 2 次，路径 A/B、整批 setFiles、附件核验和填词必须合并；第二次调用仅可继续核验，禁止第二次 chooser/setFiles 或逐文件 CUA。另有 1 个不计入业务总数的 cleanup 槽位，只能是最后一次 CUA 调用：owned-tab 状态 closing 必须先由独立 command_execution helper 持久写入；随后 cleanup CUA 必须引用固定标记 ${BROWSER_CLEANUP_MARKER} 及精确 --run-id 和 --owned-tab-id，使用同一 globalThis owned handle 执行恰好一次 close 并回报 cleanupStatus/ownedTabId，不得夹带导航、上传、点击、查询其他 tab 或其他业务动作。bridge 仅在源码 cleanup 标记、源码中的精确 runId/tabId 与 durable closing lease 完全匹配时授予独立 cleanup 槽；缺少任一身份凭证的 close 按普通业务调用计数，不得按“同一句柄”或页面输出来推断身份。cleanup 只能使用一次；普通业务脚本即使出现 close() 也按业务调用计数。不要为每个按钮或每个附件单独发起 CUA 调用。禁止调用 getScreenshot()、getAXStateAndScreenshot() 或 domSnapshot()。需要读取 DOM 时，只在当前脚本变量中调用 tab.getAXState({emit:false,disableDiffing:true})，解析成布尔值、附件名称数组、数量、发送按钮状态、当前 URL 和错误摘要，再通过 nodeRepl.write(JSON.stringify(summary)) 返回；任何中间输出不得包含 AX 原文、页面截图、data:image/base64、完整侧边栏或提示词，单次摘要不超过 4KB。若父进程观察到超预算调用并中断执行器，不得声称后续 cleanup 已运行或 tab 已关闭；若 submission-intent 已持久化，结果按未知保护并禁止重发。完整截图/base64 不属于状态证据，禁止写入事件、回复或下一轮上下文。

失败阶段矩阵（必须按阶段写入完整字段，不得省略）：
- 通用失败命令模板（必须替换为对应阶段的 typed 值）：${commands.failed}
- 登录失败：执行 ${commands.loginFailed}；这时没有发送意图，submissionIntent=false。
- 既有会话导航失败：执行 ${commands.navigationFailed}；这时没有发送意图，submissionIntent=false。
- 聊天模式或创建图片入口不可用：执行 ${commands.browserModeEntryUnavailable}；这时 submissionIntent=false。
- 创建图片入口、附件入口或文件上传在 submission-intent 前失败：执行对应的 ${commands.chooserEventTimeout}、${commands.chooserRouteUnavailable}、${commands.fileSetFailed} 或 ${commands.attachmentVerificationTimeout}；这时 submissionIntent=false。
- 已执行 submission-intent、但页面明确证明没有发送：执行 ${commands.confirmedUnsentUploadFailed}；这时 submissionIntent=true，submitted=false，submissionUncertain=false，preSubmissionFailure=true。
- 点击发送后无法证明是否送达：执行 ${commands.submissionUncertain}；这时 submitted=true、submissionIntent=true、submissionUncertain=true、preSubmissionFailure=false；固定参数为 --submitted true、--submission-intent true、--submission-uncertain true、--pre-submission-failure false，绝不重发。

执行步骤：
1. 真正开始处理本次 requestId（${requestId||'由本地 provider 冻结'}），并使用下方已经冻结的 manifestFile、outputFile、附件路径和 remotePrompt。不要读取本地执行指令来重建这些值；不要把任何控制字段或附件路径写入 ChatGPT composer。未写入 accepted 前不得打开或准备网页、登录、上传附件。manifest 只能通过预置的原子生命周期 helper 更新，禁止手工拼接、覆盖或重建 JSON，也禁止改变或删除 projectId、projectVersion、taskId、target、requestId、runId、outputFile。先执行：
   ${commands.accepted}
   只有命令返回 JSON 中的 ok=true 后，才算 accepted 成功；helper 会从同一执行目录复核 request、worker、execution 和锁定身份并自行生成 ISO 时间。若 helper 失败，立即停止，不要用其他命令补写；若需记录失败，只执行上面的 typed failed helper。
2. 父流程已经在启动执行器前持久完成 reserve-create；本步骤不得再次执行 reserve-create，也不得把 lease 从 creating 改回 not_created。第一次 CUA js 调用只执行一次 globalThis.__wendiOwnedTab=await cua.createBrowserTab("chrome",undefined,{sessionName:${JSON.stringify(resolvedSessionName)}})，并把返回句柄的真实 id 写入 globalThis.__wendiOwnedTabId；该 CUA 调用只创建并保留句柄，不混入本地 helper。随后以独立 command_execution 调用 ${commands.ownedTabCreated('<实际 ownedTabId>','<本次 sessionName>')}；实际 ID 必须来自返回句柄，禁止占位，且只有 helper 返回 ok=true 后才继续。不传入 visible，不创建第二个标签页。只有完成上述动作后，第二个业务 CUA 调用是唯一 bootstrap；调用 CUA 工具时必须在工具参数上显式设置 timeout_ms: 180000（毫秒），这是包含导航、就绪检查和结果返回的外层 180 秒绝对上限，不得依赖工具默认 timeout。导航耗时没有单独可控的 timeout；约 90 秒仅为导航/页面加载的预算预留，内部 readiness gate 从 goto 返回后最多等待 60000 毫秒，另约 30 秒预留用于工具传输和返回。这些是预算分配，不保证导航能在预留时间内完成。若导航耗尽外层时限，CUA 调用可能整体超时并重置 kernel；此时可能遗留 orphan/cleanup_pending，不能保证能写入 typed graceful failure 或在原会话内完成 cleanup，必须保留未知/未确认状态，禁止重发。唯一 bootstrap CUA 必须逐字使用下面的 <bootstrap_cua_example> 完整脚本，不要重写、压缩或拼接 evaluator/轮询器；只调用一次 goto，${conversation} 得到当前页面的 readiness 证据。getAXState 每轮使用 disableDiffing:true；整个脚本不上传、不发送。脚本返回后仅根据本次 item.completed 的 WENDI_BROWSER_READY_V1 决定是否进入上传。若 60 秒 readiness 窗口耗尽或任一条件无法证实，禁止进入附件、上传或发送；必须先写明确的提交前 typed failure：loginRequired 时执行 ${commands.loginFailed}，targetUrlMatches 不成立时执行 ${commands.navigationFailed}，其余 ui_not_ready 时执行 ${commands.browserModeEntryUnavailable}，再按第 8 步原句柄 cleanup。只有 readiness.ready === true 才能写入 uploading；缺少或未通过 readiness 证据时拒绝 uploading。紧接着以独立 command_execution 调用 ${commands.ownedTabStage('uploading','<实际 ownedTabId>')}；lease helper 必须从本 run events.jsonl 最新完整 CUA item.completed 读取并校验这次脚本产生的 WENDI_BROWSER_READY_V1 证据，否则拒绝 uploading。不得以 prompt、agent_message、command output 或较早事件替代，也不得忽略截断。只有上传阶段 helper 返回 ok=true 才能进入附件流程。后续每个 CUA 调用都只能取回同一自有句柄操作当前页面，不得再调用 goto、重建或切换会话。创建时 Chrome 可能短暂取得焦点；公开 CUA 没有焦点恢复接口，不得声称零焦点切换或后台隐藏。所有失败收尾只按第 8 步执行。
3. 按第 2 步已验证的页面继续当前会话，不得重新导航或切换会话。按本指令唯一的附件入口与上传完成门上传冻结附件；不得操作系统文件选择窗口。脚本发生未定义模块、语法或运行时异常时执行 ${commands.workerScriptRuntimeError}，不要改报附件入口故障。
4. 只有上文附件完成门已证明附件名称、数量、顺序、上传状态和发送按钮均有效，才保存发送前的 user-message baseline：在最后一个附件核验 CUA 脚本结束前，读取当前 [data-message-author-role="user"] 消息文本数组，记录数量及最后一条文本的规范化 fingerprint 到执行器持久的 globalThis.__wendiUserBaseline。若读取能力不可用，不要编造 baseline，后续只能依赖精确生成状态的正向证据，否则记录不确定。然后执行 ${commands.ownedTabStage('uploaded','<实际 ownedTabId>')}；本步骤到此结束，不执行 ready、submission-intent 或发送。
5. 本步骤是唯一的 ready → submission-intent → send 入口。先再次核对 provider 冻结的授权快照和 requestId；授权撤销则停止。紧接着且不插入任何 CUA/page read，依次执行：
   ${commands.ready}
   只有 ok=true 后立即执行：
   ${commands.submissionIntent}
   只有两个 helper 都返回 ok=true，才在下一次且仅一次的 CUA 调用里 click exactly once；ready 与 submission-intent 两个 helper 必须连续，submission-intent 与点击之间不得读取页面、重新上传、切换路由、重建提示词或输出截图。点击只执行一次，之后绝不再点击发送。不要把输入框是否清空、composer placeholder 是否变化，或旧的“与 ChatGPT 聊天”文案当作发送成功或失败证据。
   点击返回后在同一个 CUA 脚本中进行有界轮询，最长 45 秒、每 2 秒一次；不增加 CUA 调用，也不二次点击。每轮读取 [data-message-author-role="user"] 消息列表及精简 AX 状态。正向送达证据必须是消息数量超过 globalThis.__wendiUserBaseline.count，且最新 user message 的规范化文本包含本次冻结的完整 remotePrompt（允许平台在正文后追加附件标签）；或者观察到明确的本次生成中/停止生成控件且同时能与本次新 user message 对应。保持输入框不空不构成未发送证明。不要把 AX 原文写入输出。只有正向证据出现后，执行 ${commands.submitted}；只有 ok=true 才算 submitted。取得正向送达证据后执行 ${commands.ownedTabStage('sent','<实际 ownedTabId>')}；页面出现生成中/停止生成控件后执行 ${commands.ownedTabStage('generating','<实际 ownedTabId>')}。如果 45 秒内没有正向证据、baseline 缺失/读取失败，或页面状态互相矛盾，执行 ${commands.submissionUncertain}；保留未知结果并绝不再点击。只有页面明确显示本条冻结 prompt 未添加为新 user message、发送控件恢复为可发送且没有生成状态，才可标记“已确认未发送”；否则一律不确定。页面显示生成中时只等待，绝不再次发送。上传失败不得执行 sent 或 generating，界面必须保持“上传失败，未发送”。
6. 页面显示生成完成后，必须从当前这条最新 assistant 生成结果图片本身取得原始 PNG/JPG/WebP。不要只点击“保存”并等待 waitForEvent("download")：ChatGPT 的媒体保存按钮可能不产生浏览器 download 事件。先从当前这条结果的图片查看器读取可见 img 的 src，确认它不是参考附件缩略图，并从 URL 提取稳定的 OpenAI file id（匹配 file_[A-Za-z0-9_-]+）；不得用任意最新图片或模糊尺寸选择结果。然后使用当前公开的页面资产能力取得原文件：
   - 执行 const pageAssets=await tab.capabilities.get("pageAssets")，再执行 const inventory=await pageAssets.list()；不得导航到媒体 URL、不得用 curl/fetch 绕过页面资产能力。
   - 先在 inventory.assets 中筛选候选：kind === "image"，url 或 sourceUrl 是 backend-api/estuary/content，若有 contentType 则必须是 image/png、image/jpeg 或 image/webp，isThumbnail/isPreview 不为 true，role/name/url 不含 thumbnail、preview、缩略或预览；候选必须含有与当前 DOM src 相同的稳定 file id。若 URL 完全相同，matchingStrategy="exact-src"；若签名查询参数不同但稳定 file id 相同，matchingStrategy="stable-file-id"。稳定 file id 候选必须唯一，0 或大于 1 都拒绝。某些 pageAssets inventory 会暂不提供 contentType：这时只能保留唯一的 kind=image 候选，bundle 后以 bundle.assets[0].contentType 补齐并再次确认它是上述三种图片 MIME；不能把 kind="other" 当作 MIME 或图片候选。inventory 中 kind="other" 的同 file id 记录只能证明页面观察到了该文件，不能作为图片资产 bundle。
   - 如果首次 list 没有唯一 kind="image" 候选，只能在同一个 owned tab 内点击当前结果图片本身（使用该结果的精确 alt/可访问名称，不得点击通用最后一张图片），等待查看器完成后重新执行 pageAssets.list() 一次，再按上条规则筛选。不得点击保存、截图、打开其他会话或导航媒体 URL；第二次仍不是唯一图片候选时，执行 ${commands.downloadFailed} 并保留 submitted=true、submission-intent=true、submission-uncertain=false、pre-submission-failure=false；绝不发送或重试。
   - 执行 const bundle=await pageAssets.bundle({inventoryId:inventory.id,assetIds:[asset.id]})，要求 bundle.summary.downloadedCount === 1、bundle.failures.length === 0、返回资产 contentType 为 image/png、image/jpeg 或 image/webp。把返回资产的本地 path 原样复制到准确路径 ${path.resolve(outputFile)}；不得把截图、DOM 截图、缩略图或页面预览作为结果。原图复制成功后执行 ${commands.ownedTabStage('downloaded','<实际 ownedTabId>')}。
   - 复制后检查目标文件存在、普通文件、内容类型和可解码性；若资产 bundle 成功但复制/校验失败，仍按已确认送达的下载失败记录 typed failure，绝不重发。
   - 在执行 ${commands.downloaded} 之前，使用本地文件写入能力把同一份机器证据 JSON 原子写入 ${JSON.stringify(path.resolve(downloadEvidenceFile))}。证据必须包含 schemaVersion=2、source="pageAssets"、projectId、projectVersion、taskId、requestId、runId、target、conversationUrl、capturedAt、matchingStrategy（exact-src 或 stable-file-id）、currentResult.src、currentResult.stableFileId、currentResult.resultId（可选但若有必须一致）、inventory.id、exactMatchCount=1、matchedAssetIds（只含一个 id）、matchedAsset（id/kind/contentType/url/sourceUrl/role/isThumbnail/isPreview）、bundle（downloadedCount=1、failures=[]、contentType/path）和 output（path/bytes/format/width/height/sha256）。这些身份字段必须逐字来自 provider 冻结的本次身份快照，不得自行填写其他任务值；currentResult.stableFileId 必须从本次结果 DOM src 提取，matchedAsset.url/sourceUrl 必须与之含有相同稳定 file id；kind 必须为 image，contentType 只能是 image/png、image/jpeg 或 image/webp，role 不能是 thumbnail/preview，output 必须对应刚复制的真实文件。匹配数为 0 或大于 1、身份字段与 provider 快照任一记录不一致、稳定 file id 不同、旧结果、缩略图/预览、非图片、文件不可解码或 hash 不一致时不得执行 downloaded，改执行已提交下载失败 helper，绝不重发。
   - 最终执行器回复必须额外输出且只输出一段 '<download_evidence>{JSON}</download_evidence>' 机器证据块；JSON 必须与上述 download-evidence.json 完全一致，使证据可从 events.jsonl、response.txt 和 result.json 追溯。不要把这段 JSON 发送给远端 ChatGPT 用户消息。
7. 验证目标文件存在且可读取，然后执行 ${commands.downloaded}。helper 会核对目标文件必须是本条指令冻结的 outputFile，并原子写入 state=downloaded、submitted=true、artifactPath、conversationUrl 和 downloadedAt；只有 ok=true 才算下载完成。公开 CUA 没有焦点恢复接口，不报告焦点已恢复，最后只返回真实原图绝对路径和会话 URL。
8. 如果已有正向送达证据后发生任何错误，仍须执行失败 helper 并明确传入 --submitted true、--submission-intent true、--submission-uncertain true（如果无法判断是否送达）或 false（如果已确认送达）、--pre-submission-failure false；提交前且已执行 submission-intent 后失败则明确传入 --submitted false、--submission-intent true、--submission-uncertain false、--pre-submission-failure true。提交后的不确定结果绝不能标记为 pre-submission failure，绝不重发。所有退出路径的唯一 cleanup 顺序是：先通过独立 command_execution 执行 ${commands.ownedTabStage('closing','<实际 ownedTabId>')}；确认 ok=true 后，执行最后一次且仅一次 cleanup CUA 调用。该 CUA 源码必须包含注释标识 ${BROWSER_CLEANUP_MARKER} 以及精确的 --run-id "${resolvedRunId}"、--owned-tab-id "<实际 ownedTabId>"、--state closing；只从 globalThis.__wendiOwnedTab 取回句柄，并核对 globalThis.__wendiOwnedTabId 与本次 lease 中的 ownedTabId 一致；在 try/finally 中只调用一次 await tab.close()，通过 nodeRepl.write(JSON.stringify({cleanupStatus,ownedTabId})) 返回关闭结果。该 cleanup CUA 不得执行 goto、getTab、createBrowserTab、setFiles、click、页面读取或其他业务动作。bridge 只有在 durable lease 属于本 run 且 state=closing、源码标识中的 runId/tabId 与 lease 精确匹配、且脚本只有本次自有句柄的单次 close 时，才给独立 cleanup 槽；缺少标记或 run/tab 身份不匹配时，任何 close 都按普通业务调用计数，不尝试跨会话恢复、接管句柄或推断关闭成功。close 返回成功后，再通过独立 command_execution 执行 ${commands.ownedTabCleanup('closed','<实际 ownedTabId>','')}；异常或句柄丢失时分别执行 ${commands.ownedTabCleanup('close_failed','<实际 ownedTabId>','<真实异常>','')} 或 ${commands.ownedTabCleanup('not_observed','<实际或 unknown ownedTabId>','<真实句柄丢失原因>')}。若父进程已中断执行器、cleanup CUA 没有完成事件，或 close 结果无法观察，保留 orphaned/cleanup_pending；不得宣称标签页已关闭，不得在新执行器恢复或接管。不得退回 IAB 或其他浏览器重试。除生命周期 helper 外，不得直接写入、删除、替换或格式化 web-generation.json；helper 失败就停止并保留原记录。

固定 readiness bootstrap CUA 脚本如下。原样复制整个脚本作为第二个业务 CUA js 调用；该脚本只读页面、必要时选择聊天模式，不操作附件：
<bootstrap_cua_example>
${bootstrapExample}
</bootstrap_cua_example>

附件入口失败时，同一个 upload CUA 调用内执行以下只读摘要片段：
<upload_entry_diagnostic_cua_fragment>
${uploadEntryDiagnostic}
</upload_entry_diagnostic_cua_fragment>

固定 cleanup CUA 脚本如下。只替换其中的实际 ownedTabId；整段作为最后一次 CUA js 调用，不要在脚本顶层写 return。close 未返回成功时按第 8 步记录未确认状态：
<cleanup_cua_example>
${cleanupExample}
</cleanup_cua_example>

附件绝对路径（按此顺序上传）：
${listedFiles(referenceFiles)}

附件规则：两张温蒂人设必须同时作为身份参考；其他附件只锁定对应环境、物件或编辑目标。${action}

本地执行参考（不要复制给 ChatGPT 的用户消息）：
${capsule}

远端 ChatGPT 唯一发送内容（只把下面 remotePrompt 原文填入 composer；不要复制标记本身，也不要把本条执行指令、附件路径、manifest、requestId、项目状态或本地参考一起发送）：
<remote_prompt>
${frozenRemotePrompt.prompt}
</remote_prompt>`;
  // Keep the close call on its own line so legacy audit regexes cannot
  // mistake a numeric run token for a numbered step. This is formatting only.
  return `${instruction}\n固定 cleanup 调用必须实际执行 await tab.close()，不得用其他 close 表达式替代。`.replace('；全部工作结束后，最后一次 CUA 调用才执行 await tab.close()', '；全部工作结束后，最后一次 CUA 调用才执行\nawait tab.close()');
}

/** Retained only to explain why old-tab cleanup cannot run in a fresh CUA session. */
export function ownedTabCleanupPrompt({manifestFile,runId,requestId,ownedTabId} = {}) {
  const resolvedRunId = String(runId || path.basename(path.dirname(path.resolve(manifestFile || '.'))));
  const resolvedTabId = String(ownedTabId || 'unknown');
  return `不能执行独立 cleanup-only 浏览器回收：Codex run ${JSON.stringify(resolvedRunId)} 已结束，新执行器无法通过 cua.getTab 重新绑定原执行器的 CUA session 或持久句柄。ownedTabId=${JSON.stringify(resolvedTabId)}，requestId=${JSON.stringify(String(requestId||''))} 仅用于审计身份，不代表新执行器可观察或关闭该标签页。禁止调用 cua.getTab、cua.listTabs、cua.createBrowserTab，禁止接管其他标签页；必须如实保留 orphaned/cleanup_pending。自动关闭只能发生在原执行器仍持有同一持久句柄时。`;
}
