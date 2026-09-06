import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DATA,ROOT,REFS,FACE,GUIDES,CHECKS,jsonWrite,inside,rules,digest,validatePlan,PLAN_SCHEMA,QA_SCHEMA,plannerPrompt,planMarkdown} from './workflow.mjs';
import {runCodex,pythonRun,rateLimitSnapshot} from './bridge.mjs';
export const active = new Map();
const runningProjects = new Map();
fs.mkdirSync(DATA,{recursive:true});
const ID=/^[a-f0-9-]{36}$/;
const SAMPLE_AUTO_RETRIES=2;
const DEFINITE_NO_IMAGE=/(?:未能生成|没有生成(?:替代品|图片)|目标路径尚不存在|no image (?:was )?(?:generated|produced))/i;
const NETWORK_FAILURE=/(?:network|connection|连接|网络|websocket)/i;
export function projectDir(id){if(!ID.test(id))throw new Error('作品不存在');return inside(DATA,id);}
export function readProject(id){const p=path.join(projectDir(id),'project.json');if(!fs.existsSync(p))throw new Error('作品不存在');return JSON.parse(fs.readFileSync(p,'utf8'));}
export function syncRunningProject(id,patch){const running=runningProjects.get(id);if(!running)return;Object.assign(running,patch);if(patch.brief)running.brief={...running.brief,...patch.brief};}
export function saveProject(p){
  const file=path.join(projectDir(p.id),'project.json');
  // A running task keeps an in-memory snapshot. Preserve user changes made from
  // another request before that task writes its next progress checkpoint.
  if(fs.existsSync(file)){
    const latest=JSON.parse(fs.readFileSync(file,'utf8'));
    if(runningProjects.has(p.id)&&Number(latest.revision)>Number(p.revision)){
      if(latest.titleLocked&&latest.title!==p.title){p.title=latest.title;p.titleLocked=true;}
      if(latest.brief?.model&&latest.brief.model!==p.brief?.model)p.brief={...p.brief,model:latest.brief.model,reasoningEffort:latest.brief.reasoningEffort};
    }
    p.revision=Math.max(Number(p.revision)||0,Number(latest.revision)||0);
  }
  p.schemaVersion=3;p.revision=(Number(p.revision)||0)+1;p.updatedAt=new Date().toISOString();jsonWrite(file,p);
}
export function listProjects(){return fs.readdirSync(DATA).filter(id=>ID.test(id)&&fs.existsSync(path.join(DATA,id,'project.json'))).map(readProject).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export function recover(){for(const p of listProjects()){
  let migrated=false;
  if(p.lastFailure?.definiteNoOutput&&!p.currentTask){
    const task={id:p.lastFailure.taskId||crypto.randomUUID(),kind:'image',target:p.lastFailure.key,status:'failed_no_output',attempt:1,providerInvocationLimit:1,providerInvocations:p.lastFailure.attempts||1,startedAt:p.lastFailure.at,completedAt:p.lastFailure.at};
    p.tasks=Array.isArray(p.tasks)?p.tasks:[];p.tasks.push(task);p.currentTask=task;migrated=true;
  }
  if(p.pending&&!fs.existsSync(p.pending.file)){
    const failure=definiteImageFailure(p.pending);
    if(failure){
      const sample=/(?:样张-|sample-)([12])/.exec(p.pending.key||'');
      if(sample)sampleRepairCount(p,Number(sample[1])-1);
      p.pending=null;p.lastFailure=failure;p.status='attention';p.message=failureMessage(failure);p.error=p.message;saveProject(p);continue;
    }
  }
  if(p.lastFailure?.definiteNoOutput&&!p.pending&&p.status==='attention'){
    const message=failureMessage(p.lastFailure);
    if(p.message!==message){p.message=message;p.error=message;migrated=true;}
  }
  if(['attention','paused'].includes(p.status)&&p.progress?.startedAt&&!p.progress.completedAt){p.progress.completedAt=p.lastFailure?.at||p.updatedAt||new Date().toISOString();migrated=true;}
  if(migrated)saveProject(p);
  if(['planning','sampling','generating','revising'].includes(p.status)){p.status='paused';p.message='上次制作已暂停，已完成的内容都保留了。';saveProject(p);}
}}
export function createProject(brief){
  if(typeof brief.idea!=='string'||brief.idea.trim().length<4||brief.idea.length>12000)throw new Error('请用至少四个字描述想画的故事。');
  if(!Number.isInteger(brief.pageCount)||brief.pageCount<1||brief.pageCount>12)throw new Error('每篇请选择1—12页。');
  const clean={idea:brief.idea.trim(),pageCount:brief.pageCount,special:String(brief.special||'').slice(0,6000),allowXiaolin:brief.allowXiaolin===true,tangyuan:['按剧情','自然出现','不出现'].includes(brief.tangyuan)?brief.tangyuan:'按剧情',model:String(brief.model||''),reasoningEffort:String(brief.reasoningEffort||'medium'),workflowPreset:['quick','balanced','careful'].includes(brief.workflowPreset)?brief.workflowPreset:'balanced'};
  const p={id:crypto.randomUUID(),schemaVersion:3,revision:0,title:clean.idea.slice(0,20),titleLocked:false,brief:clean,status:'draft',message:'需求已保存',createdAt:new Date().toISOString(),version:0,plan:null,approved:null,samplesApproved:false,samples:[],sampleRepairCounts:[0,0],lastFailure:null,currentTask:null,tasks:[],panels:{},pages:[],history:[],revisionNotes:[],accepted:false,progress:{phase:'draft',current:0,total:1,unit:'步骤',startedAt:null,completedAt:null},metrics:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalRuns:0}};saveProject(p);return p;
}
export function job(p,phase,fn){
  if(active.has(p.id))throw new Error('这篇正在制作，请等待或先暂停。');
  const controller=new AbortController();active.set(p.id,controller);runningProjects.set(p.id,p);p.status=phase;p.error=null;p.progress={...(p.progress||{}),phase,startedAt:new Date().toISOString(),completedAt:null};saveProject(p);
  Promise.resolve().then(()=>fn(controller.signal)).catch(e=>{
    p.status=controller.signal.aborted||e.code==='LOW_QUOTA'?'paused':'attention';p.error=String(e.message||e).slice(0,2000);p.message=p.error;p.progress={...p.progress,completedAt:new Date().toISOString()};if(p.currentTask?.status==='running')finishTask(p,p.currentTask,p.status==='paused'?'paused':'failed',{error:p.error});saveProject(p);
  }).finally(()=>{active.delete(p.id);runningProjects.delete(p.id);});return p;
}
function checkpoint(signal){if(signal.aborted)throw new Error('已暂停');}
function activity(p,message,current=null,total=null,unit=null){p.message=message;p.progress={...(p.progress||{}),phase:p.status,current:current??p.progress?.current??0,total:total??p.progress?.total??1,unit:unit??p.progress?.unit??'步骤'};if(p.currentTask?.status==='running')p.currentTask.lastProgressAt=new Date().toISOString();saveProject(p);}
function addUsage(p,usage){if(!usage)return;p.metrics=p.metrics||{};for(const key of ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'])p.metrics[{input_tokens:'inputTokens',cached_input_tokens:'cachedInputTokens',output_tokens:'outputTokens',reasoning_output_tokens:'reasoningOutputTokens'}[key]]=(p.metrics[{input_tokens:'inputTokens',cached_input_tokens:'cachedInputTokens',output_tokens:'outputTokens',reasoning_output_tokens:'reasoningOutputTokens'}[key]]||0)+(Number(usage[key])||0);p.metrics.totalRuns=(p.metrics.totalRuns||0)+1;}
function modelArgs(p,effort=p.brief.reasoningEffort){return {model:p.brief.model||null,reasoningEffort:effort};}
async function protectQuota(p){
  const limits=await rateLimitSnapshot(),remaining=Number(limits?.primary?.remainingPercent);
  if(!Number.isFinite(remaining)){p.lastQuotaCheck={remaining:null,checkedAt:new Date().toISOString(),status:'unavailable'};saveProject(p);return;}
  p.lastQuotaCheck={remaining,resetsAt:limits.primary?.resetsAt,checkedAt:new Date().toISOString(),status:'fresh'};saveProject(p);
  if(remaining<10){const when=limits.primary?.resetsAt?new Date(limits.primary.resetsAt*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'下一次额度重置后';const error=new Error(`5小时创作额度只剩 ${Math.floor(remaining)}%。当前工作节点已经保存，并已暂停新的生图。建议在 ${when} 之后点击“继续制作”。`);error.code='LOW_QUOTA';throw error;}
}
function runDir(p,label){return path.join(projectDir(p.id),'.制作记录',`${Date.now()}-${crypto.randomUUID().slice(0,8)}-${label}`);}
function beginTask(p,kind,target,detail={}){const now=new Date().toISOString(),task={id:crypto.randomUUID(),kind,target,status:'running',attempt:1,startedAt:now,lastProgressAt:now,...detail};p.tasks=Array.isArray(p.tasks)?p.tasks:[];p.tasks.push(task);p.tasks=p.tasks.slice(-80);p.currentTask=task;saveProject(p);return task;}
function finishTask(p,task,status,extra={}){if(!task)return;Object.assign(task,{status,completedAt:new Date().toISOString(),...extra});if(p.currentTask?.id===task.id)p.currentTask=task;saveProject(p);}
function recordArtifact(p,id,kind,file,dependsOn=[]){p.artifacts=Array.isArray(p.artifacts)?p.artifacts:[];p.artifacts=p.artifacts.filter(x=>x.id!==id);p.artifacts.push({id,kind,file,dependsOn,valid:true,at:new Date().toISOString()});p.artifacts=p.artifacts.slice(-200);}
function invalidateArtifacts(p,ids){
  // A panel can feed a page, which in turn feeds the story audit and export.
  // Walk the graph until it stops changing so a later export can never look valid
  // after one of its source images was replaced.
  const invalid=new Set(ids),artifacts=p.artifacts||[];let changed=true;
  while(changed){
    changed=false;
    for(const artifact of artifacts){
      if(!invalid.has(artifact.id)&&artifact.dependsOn?.some(dep=>invalid.has(dep))){invalid.add(artifact.id);changed=true;}
    }
  }
  for(const artifact of artifacts)if(invalid.has(artifact.id))artifact.valid=false;
  return [...invalid];
}
function repairActions(report){return new Set((report?.issueDetails||[]).filter(x=>x.severity==='blocking'||x.severity==='review').map(x=>x.repairAction));}
function runEvidence(dir){
  const response=path.join(dir||'','response.txt'),events=path.join(dir||'','events.jsonl');let text='',eventText='',usage=null;
  if(response&&fs.existsSync(response))text=fs.readFileSync(response,'utf8');
  if(events&&fs.existsSync(events)){
    eventText=fs.readFileSync(events,'utf8');
    for(const line of eventText.split('\n')){try{const e=JSON.parse(line);if(e.type==='turn.completed'&&e.usage)usage=e.usage;}catch{}}
  }
  return {text,eventText,usage};
}
function definiteImageFailure(pending,extra=''){
  if(!pending?.dir)return null;const evidence=runEvidence(pending.dir),combined=[extra,evidence.text,evidence.eventText].filter(Boolean).join('\n');
  if(!DEFINITE_NO_IMAGE.test(combined))return null;
  const attempts=Math.max(1,(evidence.eventText.match(/image generation failed/gi)||[]).length);
  return {kind:NETWORK_FAILURE.test(combined)?'network':'no-output',definiteNoOutput:true,key:pending.key,attempts,inputTokens:Number(evidence.usage?.input_tokens)||0,at:new Date().toISOString()};
}
function failureMessage(failure){const usage=failure.inputTokens?`本次后台处理记录约 ${failure.inputTokens.toLocaleString('zh-CN')} 输入 tokens；`:'';const action=String(failure.key||'').includes('样张')?'重试当前样张':'重试当前图片';return `${failure.kind==='network'?'生图服务连接失败':'本次生图未完成'}：已发起 ${failure.attempts} 次图片请求，但没有取得图片。${usage}自动重试已停止，上一张样张和当前节点都已保存。实际订阅余额以页面顶部为准；网络稳定后点击“${action}”，只会重试这一张。`;}
function sampleRepairCount(p,index){
  p.sampleRepairCounts=Array.isArray(p.sampleRepairCounts)?p.sampleRepairCounts:[0,0];
  const parsed=Number(/自动修订(\d+)/.exec(p.samples[index]?.key||'')?.[1])||0;
  p.sampleRepairCounts[index]=Math.max(Number(p.sampleRepairCounts[index])||0,parsed);return p.sampleRepairCounts[index];
}
function normalizeQA(result){const details=Array.isArray(result.issueDetails)?result.issueDetails:[];if(!details.length&&Array.isArray(result.issues))result.issueDetails=result.issues.map((description,i)=>({id:`legacy-${i+1}`,category:/(?:画幅|比例|竖图)/.test(description)?'aspect_ratio':'uncertain',severity:'review',location:'待确认',description,repairAction:'review'}));return result;}
function materialSampleIssues(issues=[],details=[]){if(details.length)return details.filter(x=>x.category!=='aspect_ratio').map(x=>x.description);return issues.filter(x=>!/(?:2\s*[:：]\s*3|3\s*[:：]\s*4).*(?:画幅|比例|竖图)|(?:画幅|比例|竖图).*(?:2\s*[:：]\s*3|3\s*[:：]\s*4)/i.test(x));}
export function planProject(p,revision=''){
  if(revision && !p.plan)throw new Error('请先生成完整方案。');
  if(revision && revision.length>6000)throw new Error('修改说明过长。');
  return job(p,'planning',async signal=>{
    activity(p,revision?'正在把修改同步到逐页方案和连续性台账…':'正在构思故事、逐页分镜和文案…');
    const plan=await runCodex({prompt:plannerPrompt(p.brief,p.plan,revision),schema:PLAN_SCHEMA,dir:runDir(p,'故事方案'),images:FACE.map(x=>path.join(REFS,x)),signal,...modelArgs(p)});addUsage(p,plan.__usage);
    checkpoint(signal);validatePlan(plan,p.brief);
    if(p.plan)p.history.push({version:p.version,plan:p.plan,approved:p.approved,samples:p.samples,pages:p.pages,panels:p.panels,revisionNotes:p.revisionNotes});
    p.version++;p.plan=plan;if(!p.titleLocked)p.title=plan.title;p.approved=null;p.samplesApproved=false;p.samples=[];p.sampleRepairCounts=[0,0];p.lastFailure=null;p.panels={};p.pages=[];p.artifacts=[];p.revisionNotes=[];p.storyQA=null;p.accepted=false;p.bundle=null;
    p.status='review';activity(p,'逐页方案已备好。看过并确认后，才会开始生图。');
    fs.writeFileSync(path.join(projectDir(p.id),`方案-v${p.version}.md`),planMarkdown(plan,p.brief,p.version));
  });
}
function versionDir(p){return path.join(projectDir(p.id),`v${p.version}`);}
function promptCapsule(p){return `《温蒂的日常》固定制作胶囊\n- 温蒂身份以两张固定人设为准；默认高丸子头、脸部与体型连续。本篇已确认分镜若明确写出游泳、洗发、睡前等发型变化，以本篇分镜为准。\n- 小林：${p.brief.allowXiaolin?'本篇按已确认分镜出现':'禁止出现或暗示'}。汤圆：${p.brief.tangyuan}。\n- 风格、住宅、服装和物件以本版本参考附件为准。\n- 单格生图不含中文、字幕、分格线、logo或水印；文字统一后期排版。\n- 动作、视线、手脚和关键物件自然完整，保留8%安全区。\n- 画面干净清晰，无明显噪点。\n连续性：${JSON.stringify(p.plan.continuity)}`;}
function requiredRefs(p){return new Set([...FACE,...p.plan.samples.flatMap(q=>q.references),...p.plan.pages.flatMap(q=>q.panels.flatMap(r=>r.references))]);}
// Older projects can predate the complete version snapshot. Restore only missing
// files from the approved plan, keeping every existing per-version record intact.
function ensureVersionFiles(p){
  if(!p.plan||!p.version)throw new Error('当前作品没有可用于恢复的已确认方案。');
  const dir=versionDir(p);fs.mkdirSync(dir,{recursive:true});
  const files=[
    ['工作要求快照.md',()=>rules()],
    ['制作提示词胶囊.txt',()=>promptCapsule(p)],
    ['已确认分镜.md',()=>planMarkdown(p.plan,p.brief,p.version)],
    ['已确认方案.json',()=>JSON.stringify(p.plan,null,2)],
  ];
  for(const [name,content] of files){const file=path.join(dir,name);if(!fs.existsSync(file))fs.writeFileSync(file,content());}
  for(const ref of requiredRefs(p)){
    const source=inside(REFS,ref);if(!fs.existsSync(source))throw new Error(`固定参考素材缺失：${ref}。请在“人物与世界”中恢复该素材后再试。`);
    const target=inside(path.join(dir,'参考'),ref);if(!fs.existsSync(target)){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
  }
}
export function approvePlan(p,hash){
  if(active.has(p.id))throw new Error('方案仍在整理中。');
  if(p.status!=='review'||!p.plan||digest(p.plan)!==hash)throw new Error('方案已更新，请重新查看并确认当前版本。');
  validatePlan(p.plan,p.brief);
  const text=rules();ensureVersionFiles(p);
  p.approved={version:p.version,hash,rulesHash:digest(text),at:new Date().toISOString()};p.accepted=false;
  saveProject(p);return sampleProject(p);
}
function verifyApproval(p){if(!p.approved||p.approved.version!==p.version||p.approved.hash!==digest(p.plan))throw new Error('请先确认当前完整方案。');}
function imageRefs(p,refnames){ensureVersionFiles(p);return [...new Set([...FACE,...refnames])].map(x=>inside(path.join(versionDir(p),'参考'),x));}
async function qa(p,file,prompt,refs,signal,kind='原始分镜'){
  const sampleRule=kind==='方向样张'?'本次只是锁定人物与场景方向的样张，标准2:3或3:4竖幅都可接受；不要仅因它是2:3竖幅而判失败或要求再次生图。正式漫画页才要求统一3:4。':'';
  const result=await runCodex({dir:runDir(p,'画面校对'),schema:QA_SCHEMA,images:[file,...refs],signal,...modelArgs(p,'low'),
    prompt:`你是漫画验收编辑。只看附件检查，不使用工具，不修改文件。${kind.startsWith('全套')?'附件是按页码顺序排列的全套成稿，后面才是两张固定人设参考。检查整套跨页连续性，不把不同页的合理动作差异当成人设变化。':'第一张是待检'+kind+'，其他是固定身份或环境参考。'}逐项检查：${CHECKS.join('；')}；身份以两张温蒂人设为准，检查五官发髻、双肩两臂两手每手五指(只检查可见部分，合理遮挡不算缺失)、两腿两脚；不能无故正视镜头，禁止错误角色；没有明显颗粒彩噪或脏污。${kind==='原始分镜'?'原始分镜不能有中文或字幕，后期会加。':'检查所有中文完整准确、无乱码、紧凑文字框不挡主体、页码一致。'}检查比例构图、头发四肢安全区。不要把合理的风格差别或被遮挡的肢体当成问题。${sampleRule}每个问题必须返回issueDetails：category只能是 identity/anatomy/text/layout/aspect_ratio/safe_area/noise/continuity/uncertain；severity为 blocking/review/suggestion；repairAction为 regenerate/reletter/recompose/review。冻结要求：${prompt}\n返回pass、summary、issues、issueDetails及精准的repairPrompt。`});addUsage(p,result.__usage);return normalizeQA(result);
}
function findGenerated(dir,after){
  const events=path.join(dir,'events.jsonl');if(!fs.existsSync(events))return null;
  let thread;
  for(const line of fs.readFileSync(events,'utf8').split('\n')){try{const e=JSON.parse(line);if(e.type==='thread.started')thread=e.thread_id;}catch{}}
  if(!thread||!/^[a-f0-9-]{36}$/.test(thread))return null;
  const home=process.env.CODEX_HOME||path.join(process.env.HOME,'.codex');
  const folder=path.join(home,'generated_images',thread);if(!fs.existsSync(folder))return null;
  const files=fs.readdirSync(folder).filter(x=>/\.(png|webp|jpe?g)$/i.test(x)).map(x=>path.join(folder,x)).filter(x=>fs.statSync(x).mtimeMs>=after-5000);
  return files.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]||null;
}
async function generate(p,key,prompt,refnames,signal,prior=null,verify=true,qaKind='原始分镜'){
  checkpoint(signal);await protectQuota(p);checkpoint(signal);const refs=imageRefs(p,refnames);const folder=path.join(versionDir(p),'素材');fs.mkdirSync(folder,{recursive:true});
  if(p.pending)throw new Error('当前图片任务尚未结束，请先检查已有原图。');
  const file=path.join(folder,`${key}-${Date.now()}.png`);const dir=runDir(p,key);const task=beginTask(p,'image',key,{providerInvocationLimit:1,providerInvocations:0,source:prior?'edit':'generate'});const pending={key,file,dir,prompt,refs:refnames,taskId:task.id,at:new Date().toISOString()};
  p.pending=pending;p.lastFailure=null;saveProject(p);
  let failure,made=null;
  try{task.providerInvocations=1;saveProject(p);made=await runCodex({dir,signal,image:true,writableDirs:[folder],images:prior?[prior,...refs]:refs,...modelArgs(p),
    prompt:`你在本地温蒂漫画创作室后台执行已经由用户在网页明确确认的单张生图。用户已授权使用内置 image_gen，无需再次提问。只做这一张，不调用浏览器或API，不发布任何内容，不改任何既有文件。只允许调用一次 image_gen；若工具返回网络或连接错误，立即结束并明确说明没有产出，不要在同一次任务中第二次调用 image_gen。附件中的两张温蒂人设必须同时参考，其余附件仅锁定所需环境或物件；${prior?'第一张为编辑目标，只修订指定问题，保留其余正确内容。':'创建新的独立分镜。'}\n${fs.readFileSync(path.join(versionDir(p),'制作提示词胶囊.txt'),'utf8')}\n本次要求：${prompt}\n使用内置image_gen生成${prior?'或编辑':''}后，复制到准确路径 ${file}。不得用截屏或程序绘制代替。最后返回真实原图绝对路径。`,
    });addUsage(p,made.usage);}catch(e){failure=e;}
  checkpoint(signal);
  // A transport error after download must not trigger a second image request.
  if(!fs.existsSync(file)){
    const result=path.join(dir,'response.txt');
    if(fs.existsSync(result)){
      const text=fs.readFileSync(result,'utf8');
      const match=text.match(/\/Users\/[^\n<>"`]+\/\.codex\/generated_images\/[^\n<>"`]+\.(?:png|webp|jpe?g)/i);
      if(match && fs.existsSync(match[0]))fs.copyFileSync(match[0],file);
    }
  }
  if(!fs.existsSync(file)){const recovered=findGenerated(dir,Date.parse(pending.at));if(recovered)fs.copyFileSync(recovered,file);}
  if(!fs.existsSync(file)){
    const known=definiteImageFailure(pending,made?.text||'');
    if(known){p.pending=null;p.lastFailure={...known,taskId:task.id};finishTask(p,task,'failed_no_output',{errorCode:known.kind});saveProject(p);const error=new Error(failureMessage(known));error.code='IMAGE_NO_OUTPUT';throw error;}
    finishTask(p,task,'unknown_result',{errorCode:'unknown_result'});
    throw failure||new Error('连接在保存结果前中断。当前节点已保存，请先检查已有原图，避免重复生成。');
  }
  await pythonRun(['info',file]);
  const check=verify?await qa(p,file,prompt,refs,signal,qaKind):{pass:true,summary:'已完成本地文件检查；将在整页成稿中统一校对。',issues:[],repairPrompt:''};
  const record={key,file:path.relative(projectDir(p.id),file),prompt,refs:refnames,qa:check,at:new Date().toISOString()};
  jsonWrite(file+'.json',record);recordArtifact(p,`image:${key}`, 'image',record.file,prior?[`image:${key.replace(/-局部修订$/,'')}`]:[]);p.pending=null;p.lastFailure=null;finishTask(p,task,'completed',{artifact:file,qa:check.pass?'passed':'needs_review'});saveProject(p);return record;
}
export function sampleProject(p){verifyApproval(p);return job(p,'sampling',async signal=>{
  for(const [i,sample] of p.plan.samples.entries()){
    let current=p.samples[i]||null;
    if(current?.qa.pass)continue;
    const label=i===0?'人物脸部':'主场景';let repairs=sampleRepairCount(p,i),issues=materialSampleIssues(current?.qa?.issues||[],current?.qa?.issueDetails||[]);
    if(current&&!issues.length){current.qa={...current.qa,pass:true,issues:[],repairPrompt:'',summary:`${current.qa.summary}；该图为方向样张，标准2:3竖幅可直接用于确认。`};saveProject(p);continue;}
    if(!current){
      activity(p,`正在绘制${label}样张（${i+1}/2）…`);
      current=await generate(p,`样张-${i+1}`,`${sample.prompt}。单幅竖图，优先3:4；若内置生图返回标准2:3竖幅，保留原图，不裁切，也不要因此再次生图。`,sample.references,signal,null,true,'方向样张');
      p.samples[i]=current;saveProject(p);if(current.qa.pass)continue;issues=materialSampleIssues(current.qa.issues,current.qa.issueDetails||[]);
      if(!issues.length){current.qa={...current.qa,pass:true,issues:[],repairPrompt:'',summary:`${current.qa.summary}；该图为方向样张，标准2:3竖幅可直接用于确认。`};saveProject(p);continue;}
    }
    while(!current.qa.pass&&repairs<SAMPLE_AUTO_RETRIES){
      const attempt=repairs+1,prior=inside(projectDir(p.id),current.file);
      activity(p,`正在根据校对意见修正${label}样张（自动修订 ${attempt}/${SAMPLE_AUTO_RETRIES}）…`);
      const repair=`\n上一版样张的明确问题：${issues.join('；')}。只修正这些问题，保持人物身份、场景、构图和其余正确部分不变；手脚、提带等遮挡关系必须自然，关键物件与画面边缘保留8%安全区。`;
      current=await generate(p,`样张-${i+1}-自动修订${attempt}`,`${sample.prompt}。单幅竖图，2:3或3:4均可；不要只为改变比例重新绘制。${repair}`,sample.references,signal,prior,true,'方向样张');
      repairs=attempt;p.sampleRepairCounts[i]=repairs;p.samples[i]=current;saveProject(p);
      if(current.qa.pass)break;issues=materialSampleIssues(current.qa.issues,current.qa.issueDetails||[]);
      if(!issues.length){current.qa={...current.qa,pass:true,issues:[],repairPrompt:'',summary:`${current.qa.summary}；该图为方向样张，标准2:3竖幅可直接用于确认。`};saveProject(p);break;}
    }
    if(!current.qa.pass)throw new Error(`样张累计自动修订 ${repairs} 次，仍有需要你查看的地方：${issues.join('；')}。已停止继续生图，请先查看当前样张。`);
  }
  p.status='samples_review';activity(p,'两张样张已备好，请确认人物和主场景，再继续整篇。');
});}
export function approveSamples(p,hash){verifyApproval(p);if(p.status!=='samples_review'||p.approved.hash!==hash||p.samples.length!==2||p.samples.some(s=>!s?.qa.pass))throw new Error('两张样张尚未通过检查。');p.samplesApproved=true;saveProject(p);return generatePages(p);}
async function composePage(p,page,signal){
  const dir=runDir(p,`第${page.number}页排版`);const output=path.join(versionDir(p),'候选成稿',`${String(page.number).padStart(2,'0')}-${Date.now()}.png`);
  const images=page.panels.map((_,i)=>inside(projectDir(p.id),p.panels[`${page.number}-${i+1}`].file));
  jsonWrite(path.join(dir,'排版.json'),{page,total:p.plan.pages.length,images,output});
  await pythonRun(['compose',path.join(dir,'排版.json')]);checkpoint(signal);
  activity(p,`正在核对第 ${page.number} 页的文字、画面和连续性…`);
  const report=await qa(p,output,JSON.stringify(page),imageRefs(p,[...new Set(page.panels.flatMap(q=>q.references))]),signal,'1080×1440最终漫画页');
  const result={number:page.number,file:path.relative(projectDir(p.id),output),qa:report,at:new Date().toISOString(),dependsOn:page.panels.map((_,i)=>`image:第${page.number}页-第${i+1}格`)};
  p.pages=p.pages.filter(q=>q.number!==page.number);p.pages.push(result);p.pages.sort((a,b)=>a.number-b.number);recordArtifact(p,`page:${page.number}`,'page',result.file,result.dependsOn);saveProject(p);
  if(!report.pass){
    const actions=[...repairActions(report)],onlyLayout=actions.length>0&&actions.every(action=>['reletter','recompose','review'].includes(action));
    result.nextStep=onlyLayout?(actions.includes('reletter')?'重新排字':'重新排版'):'查看或修订';saveProject(p);
    if(!onlyLayout)throw new Error(`第 ${page.number} 页需要查看或修订：${report.issues.join('；')}`);
  }
  return result;
}
async function addScreen(p,key,panel,signal){
  if(!panel.screenText || p.panels[key].screenApplied)return;
  const record=p.panels[key];const input=inside(projectDir(p.id),record.rawFile||record.file);
  const dir=runDir(p,'内屏文字排版');const output=path.join(dir,'内屏排版.png');
  activity(p,`正在把第 ${key.split('-')[0]} 页的文字排进玻璃内屏…`);
  const composed=await runCodex({dir,signal,image:true,images:[input],...modelArgs(p,'low'),
    prompt:`执行已经授权的确定性漫画中文后期排版。这不是生图任务，不调用image_gen，不调用浏览器，不覆盖原图。原图 ${input} 已附上，请视觉检查原始尺寸，识别手机或车机的玻璃内屏四角、圆角、边框、刘海、手指遮挡和反光。用本机Python与Pillow、STHeiti字体，绘制正确中文界面并透视变换到内屏坐标系，圆角遮罩、手指遮挡必须保留，反光融合而非不透明平面截图浮贴。不要修改屏幕外任何像素。内屏逐字内容：${panel.screenText}。界面状态与要求：${panel.screenDirection}。有输入、删除、灰色不可发送等状态时准确表现差异。写出布局数据与可复用脚本到本次目录，再输出 ${output}。完成后查看局部放大及全图核对，若无法可靠定位内屏不要猜测，不生成假完成图片，说明原因。最终仅返回真实输出路径。`});addUsage(p,composed.usage);
  checkpoint(signal);if(!fs.existsSync(output))throw new Error('这张内屏的透视位置还需调整，原图已保留，请补充修改要求。');
  await pythonRun(['info',output]);
  const report=await qa(p,output,JSON.stringify(panel),[input,...imageRefs(p,panel.references)],signal,'已添加内屏中文的单分镜；必须核对内屏逐字文案、透视、手指遮挡及屏幕外保持不变');
  if(!report.pass)throw new Error('内屏文字需要调整：'+report.issues.join('；'));
  record.rawFile=record.rawFile||record.file;record.file=path.relative(projectDir(p.id),output);record.screenApplied=true;record.screenQA=report;saveProject(p);
}
export function generatePages(p){verifyApproval(p);if(!p.samplesApproved)throw new Error('请先确认人物和场景样张。');return job(p,'generating',async signal=>{
  const totalPanels=p.plan.pages.reduce((n,page)=>n+page.panels.length,0),verifyPanels=p.brief.workflowPreset==='careful';let completed=Object.keys(p.panels).length;
  for(const page of p.plan.pages){
    if(p.pages.find(q=>q.number===page.number)?.qa.pass)continue;
    const geoFile=path.join(runDir(p,'分镜比例'),'page.json');jsonWrite(geoFile,page);
    const geometry=JSON.parse(await pythonRun(['geometry',geoFile]));
    for(const [i,q] of page.panels.entries()){
      const key=`${page.number}-${i+1}`;
      if(p.panels[key]?.qa.pass){await addScreen(p,key,q,signal);continue;}
      checkpoint(signal);activity(p,`正在绘制第 ${page.number}/${p.plan.pages.length} 页 · 第 ${i+1}/${page.panels.length} 格…`,completed,totalPanels,'分镜');
      const g=geometry[i];let prompt=`第${page.number}页第${i+1}格。目标原始画面宽高比 ${g.width}:${g.height}（${g.ratio}），必须严格匹配，不能以默认方形代替。\n${JSON.stringify(q)}\ncaption仅作故事理解，绝对不要画入原图。当前修订记录：${JSON.stringify(p.revisionNotes.filter(x=>x.key===key))}`;
      let result=await generate(p,`第${page.number}页-第${i+1}格`,prompt,q.references,signal,null,verifyPanels);
      p.panels[key]=result;saveProject(p);
      if(verifyPanels&&!result.qa.pass&&repairActions(result.qa).has('regenerate')){
        activity(p,`第 ${page.number} 页有一处画面问题，正在修正…`);
        result=await generate(p,`第${page.number}页-第${i+1}格-修订`,prompt+'\n只修正：'+result.qa.repairPrompt,q.references,signal,inside(projectDir(p.id),result.file));
        p.panels[key]=result;saveProject(p);
        if(!result.qa.pass)throw new Error(`第 ${page.number} 页第 ${i+1} 格需要你查看：${result.qa.issues.join('；')}`);
      }else if(verifyPanels&&!result.qa.pass)activity(p,`第 ${page.number} 页的分镜无需重生图，将交由后续排版或人工复核。`);
      await addScreen(p,key,q,signal);completed++;activity(p,`已完成 ${completed}/${totalPanels} 个分镜`,completed,totalPanels,'分镜');
    }
    const composed=await composePage(p,page,signal);
    if(!composed.qa.pass){
      p.status='attention';p.message=`第 ${page.number} 页原图已保留；质检建议${composed.nextStep}，无需重新生图。请查看成稿后决定是否修改分镜或文案。`;saveProject(p);return;
    }
    activity(p,`已完成并校对：${p.pages.filter(x=>x.qa.pass).length}/${p.plan.pages.length} 页`);
  }
  // Whole-story review catches errors invisible in isolated page checks.
  if(p.brief.workflowPreset!=='quick'){
    activity(p,'整篇已排好，正在按页码复核连续性…',totalPanels,totalPanels,'分镜');
    const audit=await qa(p,inside(projectDir(p.id),p.pages[0].file),JSON.stringify(p.plan),[...p.pages.slice(1).map(q=>inside(projectDir(p.id),q.file)),...imageRefs(p,[])],signal,'全套漫画，按附件顺序检查跨页服装、场景、物件、文案与阅读节奏');
    p.storyQA=audit;recordArtifact(p,'story:audit','story-audit',null,p.pages.map(page=>`page:${page.number}`));saveProject(p);if(!audit.pass)throw new Error('整篇连续性需要调整：'+audit.issues.join('；'));
  }else {p.storyQA={pass:true,summary:'快速模式：已逐页校对，整篇连续性由最终人工验收确认。',issues:[],repairPrompt:''};recordArtifact(p,'story:audit','story-audit',null,p.pages.map(page=>`page:${page.number}`));}
  p.status='ready';p.progress.completedAt=new Date().toISOString();activity(p,'整篇已完成检查。请浏览全套，满意后收下成品。',totalPanels,totalPanels,'分镜');
});}
export function reviseImage(p,key,note){
  verifyApproval(p);if(typeof note!=='string'||note.trim().length<2||note.length>4000)throw new Error('请描述要改动的地方。');
  let old,refs,prompt;
  const sample=/^sample-([12])$/.exec(key);const panel=/^(\d+)-(\d+)$/.exec(key);
  if(sample){old=p.samples[+sample[1]-1];const s=p.plan.samples[+sample[1]-1];refs=s.references;prompt=s.prompt;}
  else if(panel){old=p.panels[key];const q=p.plan.pages[+panel[1]-1]?.panels[+panel[2]-1];if(!q)throw new Error('分镜不存在');refs=q.references;prompt=old?.prompt;}
  else throw new Error('分镜不存在');if(!old)throw new Error('这张图尚未生成');
  return job(p,'revising',async signal=>{
    activity(p,'正在按你的说明修改这一张，原版本会保留…');p.accepted=false;
    p.revisionNotes.push({key,note,at:new Date().toISOString()});
    const result=await generate(p,key+'-局部修订',prompt+'\n用户已确认本次修改：'+note+'\n只改指定内容，其余保持。',refs,signal,inside(projectDir(p.id),old.file));
    if(sample){p.samples[+sample[1]-1]=result;p.samplesApproved=false;p.status=p.samples.length===2&&p.samples.every(q=>q.qa.pass)?'samples_review':'attention';}
    else {p.panels[key]=result;const pageId=+panel[1];p.pages=p.pages.filter(q=>q.number!==pageId);invalidateArtifacts(p,[`image:${key}`,`page:${pageId}`]);p.storyQA=null;p.bundle=null;if(result.qa.pass)await addScreen(p,key,p.plan.pages[pageId-1].panels[+panel[2]-1],signal);if(result.qa.pass)await composePage(p,p.plan.pages[pageId-1],signal);p.status='paused';}
    saveProject(p);if(!result.qa.pass)throw new Error(result.qa.issues.join('；'));activity(p,sample?'样张已更新，请重新确认。':'这一格已修好并更新页面，可以继续制作与整篇校对。');
  });
}
export function resume(p){if(p.pending){
  if(fs.existsSync(p.pending.file))throw new Error('上次已收到原图但尚未校对，请先使用“找回已生成图片”。');
  throw new Error('上次生成结果尚未确认，请先使用“找回已生成图片”，避免重复生成。');
}if(!p.approved)return planProject(p);
  if(!p.samplesApproved){
    const blocked=p.samples.findIndex((sample,index)=>sample&&!sample.qa?.pass&&sampleRepairCount(p,index)>=SAMPLE_AUTO_RETRIES);
    if(blocked>=0){
      const knownIssues=p.samples.flatMap((sample,index)=>sample&&!sample.qa?.pass?[{sample:index+1,issues:sample.qa.issues||[]}]:[]);
      p.samplesApproved=true;p.sampleAcceptance={mode:'manual_after_auto_limit',at:new Date().toISOString(),knownIssues};
      p.message='已按你的确认采用当前样张。已知问题会保留在作品记录中，接下来开始整篇制作。';p.error=null;saveProject(p);
      return generatePages(p);
    }
    return sampleProject(p);
  }
  return generatePages(p);
}
export function recoverImage(p){verifyApproval(p);if(!p.pending)throw new Error('没有待找回的图片');return job(p,'revising',async signal=>{
  const pending=p.pending;
  let file=pending.file;
  if(!fs.existsSync(file)&&pending.dir){const recovered=findGenerated(pending.dir,Date.parse(pending.at));if(recovered)fs.copyFileSync(recovered,file);}
  if(!fs.existsSync(file)){
    const known=definiteImageFailure(pending);
    if(known){p.pending=null;p.lastFailure=known;saveProject(p);throw new Error(failureMessage(known));}
    throw new Error('连接在保存结果前中断，系统仍无法确认是否已经生成。稍后可再次检查已有原图；检查本身不会重新生图。');
  }
  const sample=/(?:样张-|sample-)([12])/.exec(pending.key);const report=await qa(p,file,pending.prompt,imageRefs(p,pending.refs),signal,sample?'方向样张':'原始分镜');
  const record={key:pending.key,file:path.relative(projectDir(p.id),file),prompt:pending.prompt,refs:pending.refs,qa:report,at:new Date().toISOString()};
  const q=/第(\d+)页-第(\d+)格/.exec(pending.key)||/^(\d+)-(\d+)-/.exec(pending.key);
  if(sample){const index=+sample[1]-1;p.samples[index]=record;sampleRepairCount(p,index);}else if(q)p.panels[`${q[1]}-${q[2]}`]=record;
  p.pending=null;p.lastFailure=null;p.status='paused';activity(p,'原图已找回并校对，可以继续制作。');
});}
export async function accept(p,checks){
  if(active.has(p.id)||p.status!=='ready'||p.pages.length!==p.plan.pages.length||p.pages.some(q=>!q.qa.pass)||!p.storyQA?.pass)throw new Error('请先完成全篇制作和校对。');
  if(!Array.isArray(checks)||!CHECKS.every(c=>checks.includes(c)))throw new Error('请先完成成稿验收。');
  const finalDir=path.join(versionDir(p),'成品');fs.mkdirSync(finalDir,{recursive:true});
  for(const q of p.pages){const file=path.join(finalDir,`${String(q.number).padStart(2,'0')}.png`);fs.copyFileSync(inside(projectDir(p.id),q.file),file);q.finalFile=path.relative(projectDir(p.id),file);}
  const dir=runDir(p,'作品打包');const output=path.join(versionDir(p),'温蒂漫画成品.zip');
  jsonWrite(path.join(dir,'zip.json'),{output,files:[...p.pages.map(q=>inside(projectDir(p.id),q.finalFile)),path.join(versionDir(p),'已确认分镜.md')]});
  await pythonRun(['zip',path.join(dir,'zip.json')]);
  p.accepted=true;p.acceptance={at:new Date().toISOString(),checks};p.bundle=path.relative(projectDir(p.id),output);recordArtifact(p,'export:bundle','export',p.bundle,['story:audit']);p.status='complete';activity(p,'成品已保存到本地，可以下载整套图片。');return p;
}
