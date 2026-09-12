import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {runCodex,findCodex} from './bridge.mjs';
// Keep the durable provider id for existing project records; browser transport is now Chrome.
export const WEB_IMAGE_PROVIDER='chatgpt-web-iab';
const REQUEST_ID=/^[a-f0-9-]{36}$/;
const MANIFEST_STATES=new Set(['queued','accepted','ready','submitted','downloaded','failed']);

export function webWorkerStatus(){
  const available=Boolean(findCodex());
  return {ready:available,state:available?'available':'unavailable',transport:'direct-chrome',message:available?'使用专用 Chrome 页面生成，开始时检查登录状态。':'请先安装 Codex 并登录。'};
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
    return {...value,state,submitted:value.submitted===true,conversationUrl,...(requestId?{requestId}:{}),...(value.accepted===true?{accepted:true}: {})};
  }catch{return null;}
}

export function chatGptWebImagePrompt({outputFile,manifestFile,prompt,referenceFiles=[],editTarget=null,conversationUrl=null,capsule='',requestId=null}){
  const action=editTarget
    ? '第一项附件是待编辑原图。请只修订明确指出的问题，保持其他正确内容。'
    : '创建一张新的独立分镜图。';
  const conversation=conversationUrl
    ? `优先继续这个既有对话以保持编辑上下文：${String(conversationUrl)}`
    : '新建一个 ChatGPT 对话；创建后把实际会话 URL 记录到执行清单。';
  return `你是温蒂创作室的后台网页生图执行器。用户已经在温蒂创作室网页执行带防重复标识的确认动作，明确授权本次单张生图和把下列参考图片上传到 chatgpt.com。worker-request.json 中的 authorization 是该操作发生后的持久证据。它已经满足发送前确认，不得再次询问；上传、发送、等待和下载必须在当前同一个回合完成。

强制执行边界：
- 禁止调用 image_gen 或任何图片生成 API。
- 禁止接管用户已有标签页；只能新建本次任务的专用 Chrome 会话。
- 使用公开 Computer Use API 新建 Chrome 标签页，sessionName="🎨 温蒂生图"；不使用 IAB、不接管现有标签页。若 Chrome 无法连接，记录 BROWSER_UNAVAILABLE 后停止。
- 只在 https://chatgpt.com/ 中通过正常聊天界面提交一次生图请求。不得重复提交，不发布或分享会话。
- 参考文件必须作为彼此独立的附件上传并逐项确认。不得用截图代替附件。
- 完成后必须下载网页生成的原始图片。网页截图、屏幕截图和程序绘制图片都不能作为结果。
- 除写入下列目标图片和执行记录外，不修改本地文件。

执行步骤：
1. 真正开始处理本次 requestId（${requestId||'从 worker-request.json 读取'}）并核对 worker-request.json 中的 manifestFile、instructionFile 和 outputFile 后，先原子更新 ${JSON.stringify(path.resolve(manifestFile))} 为 provider=${WEB_IMAGE_PROVIDER}、state=accepted、accepted=true、requestId（必须完全匹配）、acceptedAt。这个状态是执行器开始处理的凭据；若无法写入，写 state=failed、submitted=false、errorCode 和 error 后停止。未写入 accepted 前不得打开或准备网页、登录、上传附件。开始前必须读取 worker-request.json，确认 authorization.confirmed=true 且 requestId 匹配；否则停止。
2. 使用当前工具公开的 createBrowserTab("chrome", "https://chatgpt.com", {sessionName:"🎨 温蒂生图"}) 或等价受支持入口新建专用标签页，读取页面状态。只操作本次新建的标签页。${conversation}
3. 等待页面完成加载并读取新状态，不用首屏占位内容判断登录。若存在“聊天/工作”切换，选择“聊天”并确认选中；不得在“工作”模式发送生图提示。确认已登录且聊天输入框可用，在添加菜单确认“创建图片”入口（需要时选择该模式）。若显示登录按钮，写 failed、submitted=false、errorCode=CHATGPT_LOGIN_REQUIRED 并保留专用标签供用户登录后停止；不得上传或发送。把所有参考文件逐一上传，并确认每个文件都显示为独立附件。
4. 在发送聊天消息前，原子更新同一清单为 state=ready、conversationUrl、referenceCount、submitted=false、requestId 和 acceptedAt。若此时失败，写 state=failed、submitted=false、requestId、acceptedAt、errorCode 和 error 后停止。
5. 发送前再次核对 worker-request.json 的 authorization.confirmed 和 requestId；授权撤销则停止。先原子记录 state=submitted、submitted=true、submissionIntent=true、conversationUrl、requestId、acceptedAt 和 submittedAt，再一次性提交下面的冻结提示词；此记录表示发送已开始，发送状态不确定也绝不再次点击。页面显示生成中时只等待，绝不再次发送。
6. 页面显示生成完成后，从下载控件取得原始 PNG/JPG/WebP，复制到准确路径 ${path.resolve(outputFile)}。不得把缩略图或截图当成原图。
7. 验证目标文件存在且可读取，把清单更新为 state=downloaded、submitted=true、artifactPath、conversationUrl、requestId、acceptedAt 和 downloadedAt。最后只返回真实原图绝对路径和会话 URL。
8. 如果提交后发生任何错误，仍须更新清单为 state=failed、submitted=true、requestId、acceptedAt、conversationUrl、errorCode 和 error。不要重发。

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


/** One owned CLI execution per image. No dormant thread queue or saved readiness probe. */
export async function dispatchChatGptWebJob({codexBin,dir,outputFile,prompt,referenceFiles=[],editTarget=null,conversationUrl=null,capsule='',signal,timeoutMs=900000,model=null,reasoningEffort='low'}){
  if(signal?.aborted)throw new Error('已暂停，尚未启动图片任务。');
  fs.mkdirSync(dir,{recursive:true});
  const manifestFile=path.join(dir,'web-generation.json'),instructionFile=path.join(dir,'prompt.txt'),requestFile=path.join(dir,'worker-request.json');
  if(fs.existsSync(requestFile))throw new Error('这个图片请求已存在，请检查已有结果，不会再次执行。');
  const requestId=crypto.randomUUID(),createdAt=new Date().toISOString();
  writeJson(manifestFile,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,transport:'direct-chrome',state:'queued',requestId,accepted:false,submitted:false,createdAt});
  writeJson(requestFile,{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,requestId,authorization:{confirmed:true,scope:'one_chatgpt_web_image_submission',confirmedAt:createdAt},instructionFile,manifestFile,outputFile:path.resolve(outputFile),referenceFiles:referenceFiles.map(file=>path.resolve(file)),createdAt});
  let result,failure;
  try{result=await runCodex({codexBin,dir,image:true,browserMode:'chrome',signal,timeoutMs,model,reasoningEffort,writableDirs:[path.dirname(path.resolve(outputFile))],prompt:chatGptWebImagePrompt({outputFile,manifestFile,prompt,referenceFiles,editTarget,conversationUrl,capsule,requestId})});}catch(error){failure=error;}
  const manifest=readWebManifest(manifestFile),matches=manifest?.requestId===requestId;
  if(matches&&manifest.state==='downloaded'&&manifest.accepted===true&&manifest.submitted===true&&path.resolve(manifest.artifactPath||'')===path.resolve(outputFile)&&fs.existsSync(outputFile))return {...result,text:outputFile,manifest};
  if(matches&&manifest.state==='failed'){
    const error=new Error(manifest.error||'网页生成未完成。');error.code=manifest.errorCode||'WEB_IMAGE_FAILED';error.webManifest=manifest;throw error;
  }
  const error=failure||new Error('执行已结束，但没有取得已核实原图。记录已保留，请检查已有图片；不会自动重试。');error.webManifest=manifest;throw error;
}
