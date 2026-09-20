import path from 'node:path';
import {buildManifestCommands} from './web-manifest-commands.mjs';

function listedFiles(files=[]){
  return files.map((file,index)=>`${index+1}. ${JSON.stringify(path.resolve(file))}`).join('\n');
}

/**
 * Build the mechanical browser instruction separately from provider
 * orchestration. The only text intended for the remote ChatGPT conversation
 * remains inside the image_prompt delimiters at the end of this message.
 */
export function chatGptWebImagePrompt({outputFile,manifestFile,prompt,referenceFiles=[],editTarget=null,conversationUrl=null,capsule='',requestId=null}){
  const commands=buildManifestCommands(manifestFile);
  const downloadEvidenceFile=path.join(path.dirname(path.resolve(manifestFile)),'download-evidence.json');
  const action=editTarget
    ? '第一项附件是待编辑原图。请只修订明确指出的问题，保持其他正确内容。'
    : '创建一张新的独立分镜图。';
  const conversation=conversationUrl
    ? `优先继续这个既有对话以保持编辑上下文：${String(conversationUrl)}
既有会话导航恢复协议（只适用于这个 target）：第一次导航和后续检查只能使用同一个返回的 owned tab（变量 tab）。如果 tab.goto(target) 或等待导航返回页面导航超时（Page.navigate/navigation timeout），不能仅凭异常立即写 CHATGPT_NAVIGATION_FAILED、关闭 tab 或再次 createBrowserTab。必须先在同一 tab 做有界的 post-timeout URL/DOM/composer 验证：读取 tab.url()，读取当前 tab.playwright.domSnapshot()（必要时再读 tab.getAXState({disableDiffing:true})），确认当前 URL/浏览器结果元数据是否已经是 target，以及当前 DOM 是否有已登录证据和可用 composer（例如“与 ChatGPT 聊天”或 prompt-textarea，且没有登录按钮）。
如果 target 已经可用，继续在这个 tab 完成聊天模式、创建图片、附件和一次发送；不得重新导航、创建第二个 tab、重复上传或重复发送。如果超时后仍在 ChatGPT home（https://chatgpt.com/）但已登录且 composer 可用，可仅在 DOM 明确给出目标 href 时使用已公开的 tab.playwright.getByRole("link",{name:...}).click({timeoutMs:5000}) 做一次有界 side-link SPA click；没有精确匹配的 side-link 时直接把全部冻结参考图和冻结提示词用于新聊天继续，不要猜 URL、不要接管其他 tab、不要回退 IAB。只有有界 URL/DOM/composer 检查确认既不是 target、也不是可用 ChatGPT home，或无法确认登录/composer 时，才执行 ${commands.navigationFailed}；该提交前分类不得被描述为已上传或已发送。`
    : '新建一个 ChatGPT 对话；创建后把实际会话 URL 记录到执行清单。';
  return `你是温蒂创作室的后台网页生图执行器。用户已经在温蒂创作室网页执行带防重复标识的确认动作，明确授权本次单张生图和把下列参考图片上传到 chatgpt.com。worker-request.json 中的 authorization 是该操作发生后的持久证据。它已经满足发送前确认，不得再次询问；上传、发送、等待和下载必须在当前同一个回合完成。

你只负责机械执行已经冻结的本次请求，不负责创意规划、质量判断或任务恢复。禁止读取仓库、memory、历史任务、其他作品、其他会话或任何未列出的文件；禁止自行调研、搜索或改写提示词。只读取本次 worker-request.json、prompt.txt、列出的附件和本次 web-generation.json，立即按下列步骤执行。不要在 accepted 前审查项目、扫描目录或调用额外工具。

强制执行边界：
- 禁止调用 image_gen 或任何图片生成 API。
- 禁止接管用户已有标签页；禁止导航或写入已有的温蒂创作室标签页。生产主路径只能新建本次任务专用的 Chrome extension 标签页，不使用 Codex IAB，也不在失败后切回 IAB。
- Chrome extension 的公开 createBrowserTab 不支持隐藏参数，绝不传入 visible，不调用隐藏、坐标、系统鼠标、系统键盘或脆弱快捷键。当前公开 CUA 只有 getState、listBrowsers、listTabs、getBrowser、createBrowserTab、getTab 等浏览器入口，没有窗口/标签页 active 或 focused 更新接口，也没有可验证的后台 Playwright contract。不得把不存在的 management API 当作可用能力，不得调用 cua.getTab 或从 cua.listTabs 选取、接管已有标签页。
- createBrowserTab 可能让 Chrome 短暂切换到这个新标签页；这是已知边界，无法严格保证零焦点切换，也不能把本次执行描述成后台隐藏。创建后所有 Playwright 操作只绑定返回的自有 tab；完成或失败都由外层 finally 统一清理。温蒂创作室已有标签页只保留其原内容，不导航、不写入、不选择它，也不尝试伪造焦点恢复。
- 唯一允许的创建调用是 const tab=await cua.createBrowserTab("chrome",undefined,{sessionName:"🎨 温蒂生图"})；先创建一个自己拥有的空白专用 tab，再导航到 chatgpt.com。只创建一个专用 tab，不允许省略 sessionName、不允许再创建第二个标签页。若 createBrowserTab 或 tab.goto 出现 user declined、denied permission、browser security policy 等 chatgpt.com 站点源权限拒绝，必须执行 ${commands.originPermissionDenied}；这不是 BROWSER_CHROME_UNAVAILABLE，禁止上传或发送，也不要退回 IAB 或其他标签页重试。只有真正的 Chrome extension/浏览器能力不可用才记录 BROWSER_FOCUS_UNAVAILABLE 或 BROWSER_CHROME_UNAVAILABLE。
- createBrowserTab 的 request-header policy 前置加载失败（例如“Unable to load browser request-header policy”）必须单独按 Chrome 前置能力失败处理：这不是 chatgpt.com 站点源权限拒绝，也不是导航已成功。该调用只允许尝试一次；无论错误提示是否写着 Retry，都不得盲目再次调用 createBrowserTab、cua.getTab、cua.listTabs 或创建第二个 tab，以免一次调用已经产生的自有 tab 漏泄成双 tab。若没有可确认归属的返回 tab，原子写入 errorCode=BROWSER_CHROME_UNAVAILABLE、state=failed、submitted=false、referenceCount=0，并在 error 中保留 request-header policy 前置失败；若已返回一个自有 tab，只继续使用它并在 finally 清理。
- 上传只能使用该 tab 的 Playwright 文件选择流程。先把整个 worker-request.json 读入变量 worker：解析示例 const worker=JSON.parse(fs.readFileSync("worker-request.json","utf8")); 数组位于顶层 worker.referenceFiles，不是 worker.worker.referenceFiles；如果读取结果不是数组，立即执行 ${commands.uploadFailed}。同时读取可选的 worker.referenceEntries，逐项核对路径存在、是普通文件、可读、大小和 sha256 与条目一致；任何预检失败都必须停止在浏览器上传之前。不要手写或手打路径，不得凭记忆改写 UUID、截取路径或从文字清单重构数组。后续多选上传必须直接使用 chooser.setFiles(worker.referenceFiles)，不允许先新建手写 refs 数组；非多选时只能使用同一冻结数组的单项 worker.referenceFiles[index]，保持原顺序。
- 每次上传前先读取当前 DOM，不得依赖某一个固定中文按钮文案：从当前可访问名称中有限地寻找附件入口（例如“添加文件”“添加照片和文件”“上传文件”“附件”或英文 attach/upload 的按钮/菜单项，允许同义变体和正则匹配），确认它属于当前对话后再点击。点击后先用一个短时有界的 waitForEvent("filechooser") 观察是否直接打开选择器；若超时，只丢弃这个已结束的 waiter，重新读取 DOM，定位明确的菜单项（例如“从电脑上传”“上传文件”“添加照片和文件”或对应英文 upload/from computer），然后为这一次菜单点击创建全新的短时有界 filechooser waiter，再 await chooser.setFiles(worker.referenceFiles)。每条分支只能执行一次实际上传动作，禁止保留悬挂 chooser promise、无限等待或用同一个 waiter 跨分支复用。先检查 chooser.isMultiple()：支持多选时按冻结顺序一次 setFiles 全部文件；不支持多选时，按附件顺序逐项重新读取 DOM、逐项点击入口/菜单、逐项 setFiles，并在每项后刷新 DOM 核对新增附件名称或数量。禁止调用 cua.getApp、macOS 原生文件选择器、系统鼠标或键盘。
- 上传后绝不能只因附件 group 已出现就发送。每轮从全新 DOM 逐个核对附件 group：group 总数必须等于 worker.referenceFiles.length，每个 group 的名称必须按顺序等于对应路径的 basename，不能有重复或缺失；同时等待所有 group 的“上传中/正在上传/处理中/等待文件上传/uploading”状态消失。必须继续有界轮询（最长 240 秒），每轮写一条简短阶段日志（group 数量、名称匹配、pending 状态、发送按钮 disabled 状态）。只有 group 数量与名称全部匹配、没有任何等待/上传状态、发送按钮真实 enabled 且提示词仍在输入框时，才允许执行 ${commands.ready}、${commands.submissionIntent} 和一次发送。任何一个 group 卡住、名称/数量不匹配、状态仍为“等待文件上传”或发送按钮 disabled 到超时，都只执行 ${commands.uploadFailed}（若已记录 submission-intent 则执行 ${commands.confirmedUnsentUploadFailed}），绝不点击发送、绝不把 ready 当成上传成功、绝不重试第二次上传。
- 任何上传错误在 submission-intent 前执行 ${commands.uploadFailed}；若已经执行 submission-intent 且页面明确证明没有新用户消息，则执行 ${commands.confirmedUnsentUploadFailed}；禁止切换到 IAB 或其他标签页重试。
- 只在 https://chatgpt.com/ 中通过正常聊天界面提交一次生图请求。不得重复提交，不发布或分享会话。
- 参考文件必须作为彼此独立的附件上传并逐项确认。不得用截图代替附件。
- 完成后必须下载网页生成的原始图片。网页截图、屏幕截图和程序绘制图片都不能作为结果。
- 除写入下列目标图片和执行记录外，不修改本地文件。

失败阶段矩阵（必须按阶段写入完整字段，不得省略）：
- 通用失败命令模板（必须替换为对应阶段的 typed 值）：${commands.failed}
- 登录失败：执行 ${commands.loginFailed}；这时没有发送意图，submissionIntent=false。
- 既有会话导航失败：执行 ${commands.navigationFailed}；这时没有发送意图，submissionIntent=false。
- 创建图片入口、附件入口或文件上传在 submission-intent 前失败：执行 ${commands.uploadFailed}；这时 submissionIntent=false。
- 已执行 submission-intent、但页面明确证明没有发送：执行 ${commands.confirmedUnsentUploadFailed}；这时 submissionIntent=true，submitted=false，submissionUncertain=false，preSubmissionFailure=true。
- 点击发送后无法证明是否送达：执行 ${commands.submissionUncertain}；这时 submitted=true、submissionIntent=true、submissionUncertain=true、preSubmissionFailure=false；固定参数为 --submitted true、--submission-intent true、--submission-uncertain true、--pre-submission-failure false，绝不重发。

执行步骤：
1. 真正开始处理本次 requestId（${requestId||'从 worker-request.json 读取'}）并核对 worker-request.json 中的 manifestFile、instructionFile 和 outputFile。开始前必须读取 worker-request.json，确认 authorization.confirmed=true 且 requestId 匹配；否则停止。未写入 accepted 前不得打开或准备网页、登录、上传附件。manifest 只能通过预置的原子生命周期 helper 更新，禁止手工拼接、覆盖或重建 JSON，也禁止改变或删除 projectId、projectVersion、taskId、target、requestId、runId、outputFile。先执行：
   ${commands.accepted}
   只有命令返回 JSON 中的 ok=true 后，才算 accepted 成功；helper 会从同一执行目录复核 request、worker、execution 和锁定身份并自行生成 ISO 时间。若 helper 失败，立即停止，不要用其他命令补写；若需记录失败，只执行上面的 typed failed helper。
2. 使用当前工具公开的 const tab=await cua.createBrowserTab("chrome",undefined,{sessionName:"🎨 温蒂生图"}) 新建一个自己拥有的空白专用 Chrome 标签页并保存 tab handle；不传入 visible，不创建第二个标签页。随后只能在同一个 try { await tab.goto("https://chatgpt.com")；执行本次页面的导航、登录、上传、发送和下载 } finally { await tab.close() } 结构中操作。创建时 Chrome 可能短暂取得焦点，公开 CUA 没有焦点恢复接口，因此不得声称零焦点切换或后台隐藏。${conversation}
3. 等待页面完成加载并读取新状态，不用首屏占位内容判断登录。若存在“聊天/工作”切换，选择“聊天”并确认选中；不得在“工作”模式发送生图提示。确认已登录且聊天输入框可用，在添加菜单确认“创建图片”入口（需要时选择该模式）。若显示登录按钮，执行 ${commands.loginFailed}，随后停止，不得上传或发送。按上一条 DOM 自适应的两段式附件流程上传所有参考文件，并在每次菜单变化后重新读取 DOM、逐项确认附件；不得操作系统文件选择窗口。
4. 在发送聊天消息前，严格执行上面的附件完成门：附件 group 名称和数量、冻结数组顺序、上传状态和发送按钮必须全部通过；继续有界等待所有附件上传进度或“等待文件上传”状态消失，最长 240 秒，每次核对都从新 DOM 读取并记录阶段日志。只有发送按钮真实可用才能进入下一步；按钮仍 disabled 时禁止点击，也不得先执行 ready 或 submission-intent。然后执行：
   ${commands.ready}
   只有 ok=true 才能继续。若此时提示词仍在输入框、没有新用户消息且没有生成状态，且尚未执行 submission-intent，执行 ${commands.uploadFailed}；若已经执行 submission-intent，则执行 ${commands.confirmedUnsentUploadFailed}。这是已记录阶段事实但可证明未发送，不得自行改写其他字段。
5. 发送前再次核对 worker-request.json 的 authorization.confirmed 和 requestId；授权撤销则停止。点击前且只在一次已确认可用的发送按钮点击之前执行：
   ${commands.submissionIntent}
   只有 ok=true 后才能点击一次。点击后必须用新 DOM 正向证明至少一项：输入框已清空并出现本次新的用户消息，或页面已出现本次生成进度/停止生成控件。只有正向证据出现后，执行 ${commands.submitted}；只有 ok=true 才算 submitted。若点击返回但无法证明既未发送也未送达，执行 ${commands.submissionUncertain}；保留未知结果并绝不再点击。页面显示生成中时只等待，绝不再次发送。
6. 页面显示生成完成后，必须从当前这条最新 assistant 生成结果图片本身取得原始 PNG/JPG/WebP。不要只点击“保存”并等待 waitForEvent("download")：ChatGPT 的媒体保存按钮可能不产生浏览器 download 事件。先从当前这条结果的图片查看器读取可见 img 的 src，确认它不是参考附件缩略图，并从 URL 提取稳定的 OpenAI file id（匹配 file_[A-Za-z0-9_-]+）；不得用任意最新图片或模糊尺寸选择结果。然后使用当前公开的页面资产能力取得原文件：
   - 执行 const pageAssets=await tab.capabilities.get("pageAssets")，再执行 const inventory=await pageAssets.list()；不得导航到媒体 URL、不得用 curl/fetch 绕过页面资产能力。
   - 先在 inventory.assets 中筛选候选：kind === "image"，url 或 sourceUrl 是 backend-api/estuary/content，若有 contentType 则必须是 image/png、image/jpeg 或 image/webp，isThumbnail/isPreview 不为 true，role/name/url 不含 thumbnail、preview、缩略或预览；候选必须含有与当前 DOM src 相同的稳定 file id。若 URL 完全相同，matchingStrategy="exact-src"；若签名查询参数不同但稳定 file id 相同，matchingStrategy="stable-file-id"。稳定 file id 候选必须唯一，0 或大于 1 都拒绝。某些 pageAssets inventory 会暂不提供 contentType：这时只能保留唯一的 kind=image 候选，bundle 后以 bundle.assets[0].contentType 补齐并再次确认它是上述三种图片 MIME；不能把 kind="other" 当作 MIME 或图片候选。inventory 中 kind="other" 的同 file id 记录只能证明页面观察到了该文件，不能作为图片资产 bundle。
   - 如果首次 list 没有唯一 kind="image" 候选，只能在同一个 owned tab 内点击当前结果图片本身（使用该结果的精确 alt/可访问名称，不得点击通用最后一张图片），等待查看器完成后重新执行 pageAssets.list() 一次，再按上条规则筛选。不得点击保存、截图、打开其他会话或导航媒体 URL；第二次仍不是唯一图片候选时，执行失败 helper，错误码为 DOWNLOAD_CHROME_UNAVAILABLE，并保留 submitted=true、submission-intent=true、submission-uncertain=false、pre-submission-failure=false；绝不发送或重试。
   - 执行 const bundle=await pageAssets.bundle({inventoryId:inventory.id,assetIds:[asset.id]})，要求 bundle.summary.downloadedCount === 1、bundle.failures.length === 0、返回资产 contentType 为 image/png、image/jpeg 或 image/webp。把返回资产的本地 path 原样复制到准确路径 ${path.resolve(outputFile)}；不得把截图、DOM 截图、缩略图或页面预览作为结果。
   - 复制后检查目标文件存在、普通文件、内容类型和可解码性；若资产 bundle 成功但复制/校验失败，仍按已确认送达的下载失败记录 typed failure，绝不重发。
   - 在执行 ${commands.downloaded} 之前，使用本地文件写入能力把同一份机器证据 JSON 原子写入 ${JSON.stringify(path.resolve(downloadEvidenceFile))}。证据必须包含 schemaVersion=2、source="pageAssets"、projectId、projectVersion、taskId、requestId、runId、target、conversationUrl、capturedAt、matchingStrategy（exact-src 或 stable-file-id）、currentResult.src、currentResult.stableFileId、currentResult.resultId（可选但若有必须一致）、inventory.id、exactMatchCount=1、matchedAssetIds（只含一个 id）、matchedAsset（id/kind/contentType/url/sourceUrl/role/isThumbnail/isPreview）、bundle（downloadedCount=1、failures=[]、contentType/path）和 output（path/bytes/format/width/height/sha256）。这些身份字段必须逐字来自本次 worker-request.json/web-generation.json，不得自行填写其他任务值；currentResult.stableFileId 必须从本次结果 DOM src 提取，matchedAsset.url/sourceUrl 必须与之含有相同稳定 file id；kind 必须为 image，contentType 只能是 image/png、image/jpeg 或 image/webp，role 不能是 thumbnail/preview，output 必须对应刚复制的真实文件。匹配数为 0 或大于 1、身份字段与 request/worker/manifest/result 任一记录不一致、稳定 file id 不同、旧结果、缩略图/预览、非图片、文件不可解码或 hash 不一致时不得执行 downloaded，改执行已提交下载失败 helper，绝不重发。
   - 最终执行器回复必须额外输出且只输出一段 '<download_evidence>{JSON}</download_evidence>' 机器证据块；JSON 必须与上述 download-evidence.json 完全一致，使证据可从 events.jsonl、response.txt 和 result.json 追溯。不要把这段 JSON 发送给远端 ChatGPT 用户消息。
7. 验证目标文件存在且可读取，然后执行 ${commands.downloaded}。helper 会核对目标文件必须是本次 worker-request.json 的 outputFile，并原子写入 state=downloaded、submitted=true、artifactPath、conversationUrl 和 downloadedAt；只有 ok=true 才算下载完成。公开 CUA 没有焦点恢复接口，不报告焦点已恢复，最后只返回真实原图绝对路径和会话 URL。
8. 如果已有正向送达证据后发生任何错误，仍须执行失败 helper 并明确传入 --submitted true、--submission-intent true、--submission-uncertain true（如果无法判断是否送达）或 false（如果已确认送达）、--pre-submission-failure false；提交前且已执行 submission-intent 后失败则明确传入 --submitted false、--submission-intent true、--submission-uncertain false、--pre-submission-failure true。提交后的不确定结果绝不能标记为 pre-submission failure。不要重发；无论导航、登录、上传、发送或下载在哪一步失败，都由外层 finally 统一关闭本次自己创建的专用 tab；不得退回 IAB 或其他浏览器重试。除上述 helper 外，不得直接写入、删除、替换或格式化 web-generation.json；helper 失败就停止并保留原记录。

附件绝对路径（按此顺序上传）：
${listedFiles(referenceFiles)}

附件规则：两张温蒂人设必须同时作为身份参考；其他附件只锁定对应环境、物件或编辑目标。${action}

本地执行参考（不要复制给 ChatGPT 的用户消息）：
${capsule}

远端 ChatGPT 唯一发送内容（只复制 <image_prompt> 与 </image_prompt> 之间的文本；不要把本条执行指令、附件路径、manifest、requestId、项目状态或本地参考一起发送）：
<image_prompt>
${prompt}
</image_prompt>`;
}
