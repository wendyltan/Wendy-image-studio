import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-studio-tests-'));
process.env.WENDI_DATA_DIR=path.join(temp,'stories');
const fake=path.join(temp,'fixture-cli');
process.env.WENDI_CODEX_BIN=fake;
process.env.WENDI_TEST_CALLS=path.join(temp,'calls.txt');
const W=await import('../server/workflow.mjs');
const E=await import('../server/engine.mjs');
const B=await import('../server/bridge.mjs');
const J=await import('../server/job-store.mjs');
const G=await import('../server/chatgpt-web-provider.mjs');
const panel={scene:'原木客厅',characters:'温蒂',costume:'轻薄夏装',action:'翻书',gaze:'书页',expression:'专注',lighting:'左侧日光',layers:'桌子、人物、窗外',objects:'一本书',caption:'停一会儿，也很好。',captionKind:'narration',screenText:'',screenDirection:'',prompt:'看书，手脚完整',references:['04-住宅环境/原木客厅参考.png'],anchors:['高丸子头'],forbidden:['无关文字']};
const plan={title:'流程测试专用',synopsis:'测试夹具',arc:'拿起书、停下、望向窗外。',continuity:{characters:['1页1格 温蒂'],scenes:['原木客厅'],objects:['书'],copy:['1页1格 停一会儿，也很好。']},samples:[{title:'脸部',prompt:'脸部近景',references:[]},{title:'场景',prompt:'原木客厅',references:panel.references}],pages:[{number:1,title:'仅用于流程测试',purpose:'测试排版',time:'夏末午后',layout:'solo',panels:[panel]}]};
const planFile=path.join(temp,'fixture-plan.json');fs.writeFileSync(planFile,JSON.stringify(plan));process.env.WENDI_TEST_PLAN_FILE=planFile;
// Deliberately labelled fixture images; this executable is used only inside this isolated test.
fs.writeFileSync(fake,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const a=process.argv.slice(2);if(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}if(a[0]==='app-server'){if(process.env.WENDI_TEST_RATE_LIMIT_FAIL==='1')process.exit(7);const response=JSON.parse(process.env.WENDI_TEST_RATE_LIMIT_RESPONSE||'{}');let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop();for(const line of lines){try{const message=JSON.parse(line);if(message.id===0)console.log(JSON.stringify({id:0,result:{}}));else if(message.method==='account/rateLimits/read')console.log(JSON.stringify({id:message.id,result:response}));}catch{}}});await new Promise(()=>{});}let p='';for await(const c of process.stdin)p+=c;
if(process.env.WENDI_TEST_ARGV)fs.writeFileSync(process.env.WENDI_TEST_ARGV,JSON.stringify(a));
fs.appendFileSync(process.env.WENDI_TEST_CALLS,'call\\n');
const out=a[a.indexOf('-o')+1];let text='';
if(a.includes('--output-schema')){const s=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1]));const marker=process.env.WENDI_TEST_FAIL_SAMPLE_ONCE,crash=process.env.WENDI_TEST_CRASH_QA_ONCE,panelCrash=process.env.WENDI_TEST_CRASH_PANEL_QA_ONCE,panelFailure=process.env.WENDI_TEST_FAIL_PANEL_QA_ONCE;const shouldCrash=!s.properties.pages&&((crash&&p.includes('脸部近景')&&!fs.existsSync(crash))||(panelCrash&&p.includes('用户已确认本次修改')&&!fs.existsSync(panelCrash)));if(shouldCrash){fs.writeFileSync(crash||panelCrash,'1');process.exit(42);}else if(!s.properties.pages&&panelFailure&&p.includes('待检原始分镜')&&!fs.existsSync(panelFailure)){fs.writeFileSync(panelFailure,'1');text=JSON.stringify({pass:false,summary:'TEST FORMAL PANEL FAILURE',issues:['手部需要调整'],issueDetails:[{id:'formal-hand',category:'anatomy',severity:'review',location:'右手',description:'手部需要调整',repairAction:'review'}],repairPrompt:'请人工确认是否采用当前图'});}else if(!s.properties.pages&&marker&&p.includes('脸部近景')&&!fs.existsSync(marker)){fs.writeFileSync(marker,'1');text=JSON.stringify({pass:false,summary:'TEST FIXTURE REPAIR',issues:['前臂与提带关系不自然'],issueDetails:[{id:'arm-strap',category:'anatomy',severity:'blocking',location:'左前臂',description:'前臂与提带关系不自然',repairAction:'regenerate'}],repairPrompt:'修正前臂与提带关系'});}else text=JSON.stringify(s.properties.pages?JSON.parse(fs.readFileSync(process.env.WENDI_TEST_PLAN_FILE)): {pass:true,summary:'TEST FIXTURE CHECK ONLY',issues:[],issueDetails:[],repairPrompt:''});}
else {const noImage=process.env.WENDI_TEST_NO_IMAGE_ONCE;if(noImage&&!fs.existsSync(noImage)){fs.writeFileSync(noImage,'1');text=process.env.WENDI_TEST_NO_IMAGE_TEXT||'未能生成：ChatGPT 网页连接错误，目标路径尚不存在。';}else{const m=p.match(/复制到准确路径 ([^\\n]+?\\.png)/)||p.match(/再输出 ([^\\n]+?\\.png)/);if(!m)process.exit(2);const file=m[1];fs.mkdirSync(path.dirname(file),{recursive:true});const r=p.match(/目标原始画面宽高比 (\\d+):(\\d+)/);const w=r?+r[1]:750,h=r?+r[2]:1000;execFileSync('/Library/Frameworks/Python.framework/Versions/3.10/bin/python3',['-c','from PIL import Image,ImageDraw; import sys; im=Image.new("RGB",(int(sys.argv[2]),int(sys.argv[3])),"#d8dfce"); ImageDraw.Draw(im).text((20,20),"PIPELINE TEST ONLY",fill="black"); im.save(sys.argv[1])',file,String(w),String(h)]);text=file;const pause=process.env.WENDI_TEST_PAUSE_AFTER_IMAGE;if(pause&&!fs.existsSync(pause)){fs.writeFileSync(pause,'1');await new Promise(resolve=>setTimeout(resolve,10000));}}}
const usageLimit=process.env.WENDI_TEST_USAGE_LIMIT_ONCE;if(usageLimit&&!fs.existsSync(usageLimit)){fs.writeFileSync(usageLimit,'1');console.log(JSON.stringify({type:'error',message:text}));process.exit(1);}if(usageLimit&&fs.existsSync(usageLimit)&&fs.existsSync(path.join(process.cwd(),'worker-request.json'))){const req=JSON.parse(fs.readFileSync(path.join(process.cwd(),'worker-request.json'),'utf8'));const manifest=JSON.parse(fs.readFileSync(req.manifestFile,'utf8'));fs.writeFileSync(req.manifestFile,JSON.stringify({...manifest,state:'downloaded',accepted:true,acceptedAt:new Date().toISOString(),readyAt:new Date().toISOString(),submitted:true,submittedAt:new Date().toISOString(),referenceCount:req.referenceFiles.length,downloadedAt:new Date().toISOString(),artifactPath:req.outputFile,conversationUrl:'https://chatgpt.com/c/test-resume'}));}fs.writeFileSync(out,text);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));if(/Browser use cannot access\\s+https:\\/\\/chatgpt\\.com|FILE_UPLOAD_CHROME_UNAVAILABLE|UPLOAD_ERROR/i.test(text))console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'cua_repl',tool:'js',result:{content:[{type:'text',text}]}}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:10,reasoning_output_tokens:2}}));
`,{mode:0o700});
// Keep the QA interruption fixture tied to the public revision-prompt shape,
// not to an internal sentence that the remote executor must never receive.
fs.writeFileSync(fake,fs.readFileSync(fake,'utf8').replace("panelCrash&&p.includes('用户已确认本次修改')","panelCrash&&p.includes('必须修改：')&&p.includes('可观察结果：')&&p.includes('把书放下并看向窗外')"),{mode:0o700});
async function done(id){for(let i=0;i<200;i++){if(!E.active.has(id))return E.readProject(id);await new Promise(r=>setTimeout(r,50));}throw new Error('test job timed out');}
function callCount(){return fs.existsSync(process.env.WENDI_TEST_CALLS)?fs.readFileSync(process.env.WENDI_TEST_CALLS,'utf8').split('\n').filter(Boolean).length:0;}
function sha256File(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function panelDecisionFixture(idea='正式分镜采用完整性测试'){
  const project=E.createProject({...brief,idea,workflowPreset:'careful'});project.plan=structuredClone(plan);project.version=1;project.approved={version:1,hash:W.digest(project.plan)};project.samplesApproved=true;project.status='attention';
  const file=path.join(E.projectDir(project.id),'v1','素材','采用测试.png'),relative=path.relative(E.projectDir(project.id),file),at=new Date().toISOString(),artifactId='image:第1页-第1格';fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(W.inside(W.REFS,W.FACE[0]),file);const integrity={sha256:sha256File(file),sizeBytes:fs.statSync(file).size};
  project.panels={'1-1':{key:'第1页-第1格',file:relative,prompt:'看书，手脚完整',refs:[],integrity,qa:{pass:false,status:'needs_review',summary:'测试失败质检',issues:['手部需要调整'],issueDetails:[{id:'formal-hand',category:'anatomy',severity:'review',description:'手部需要调整',repairAction:'review'}],repairPrompt:'人工确认'},at}};project.artifacts=[{id:artifactId,kind:'image',file:relative,dependsOn:[],valid:true,at,integrity}];project.panelDecision={state:'required',panelKey:'1-1',artifactId,projectVersion:1,at};E.saveProject(project);return {project,file,relative,at,artifactId,integrity};
}
function panelDecisionBody(fixture,extra={}){const {project,relative,at,artifactId}=fixture;return {key:'1-1',action:'accept_current',panelKey:'1-1',expectedRevision:project.revision,planHash:project.approved.hash,artifactId,contentHash:W.digest({artifactId,file:relative,at}),decision:'accept_current',acknowledgedIssueIds:['formal-hand'],continueProduction:false,idempotencyKey:`panel:${project.id}:accept`,...extra};}
const brief={idea:'测试这一个完整故事流程',pageCount:1,allowXiaolin:false,tangyuan:'不出现'};
let p;
test('input validation and restricted references',()=>{
  assert.equal(B.extractRateLimits({rateLimits:{rateLimitsByLimitId:{codex:{primary:{usedPercent:64}}}}}).primary.usedPercent,64);
  const normalized=B.normalizeRateLimits({rateLimits:{primary:{usedPercent:64,windowDurationMins:300,resetsAt:123},secondary:{usedPercent:42,windowDurationMins:10080}}});
  assert.deepEqual(normalized.primary,{usedPercent:64,remainingPercent:36,windowDurationMins:300,resetsAt:123});assert.equal(normalized.secondary.remainingPercent,58);
  const modelBuckets=B.normalizeRateLimits({rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:4,windowDurationMins:300}},base_model_inference:{limitId:'base_model_inference',normalModelSlug:'gpt-5.6-luna',primary:{usedPercent:65,windowDurationMins:10080}}}});assert.equal(modelBuckets.byLimitId.base_model_inference.normalModelSlug,'gpt-5.6-luna');assert.equal(modelBuckets.byLimitId.base_model_inference.primary.remainingPercent,35);
  assert.equal(B.normalizeRateLimits({rateLimits:{primary:{usedPercent:'unknown'}}}).primary,null);
  assert.throws(()=>E.createProject({...brief,pageCount:99}),/1—12/);
  assert.throws(()=>E.createProject({...brief,idea:'x'}));
  assert.throws(()=>W.inside(W.APP,'../设定'),/路径/);
  assert(!W.references(false).some(x=>x.startsWith('02-')));
  assert(W.references(true).some(x=>x.startsWith('02-')));
  assert.equal(W.validatePlan(structuredClone(plan),brief).pages.length,1);
  const bad=structuredClone(plan);bad.pages[0].panels[0].references=['02-小林人设/小林人设1.png'];assert.throws(()=>W.validatePlan(bad,brief),/未获准/);
  bad.pages[0].panels[0].references=[];bad.pages[0].panels[0].caption='小林发来消息';assert.throws(()=>W.validatePlan(bad,brief),/小林/);
});
test('web image provider records the dedicated Chrome focus boundary',()=>{
  const text=G.chatGptWebImagePrompt({outputFile:'/tmp/result.png',manifestFile:'/tmp/web-generation.json',prompt:'单格测试',referenceFiles:['/tmp/wendi-1.png','/tmp/wendi-2.png']});
  assert.equal(G.WEB_IMAGE_PROVIDER,'chatgpt-web-iab');
  assert.equal(G.WEB_IMAGE_TRANSPORT,'direct-chrome');
  assert.equal(G.webWorkerStatus().browser,'chrome');
  assert.match(text,/只能新建本次任务专用的 Chrome extension 标签页/);
  assert.match(text,/https:\/\/chatgpt\.com\//);
  assert.match(text,/复制到准确路径 \/tmp\/result\.png/);
  assert.match(text,/web-generation\.json/);
  assert.match(text,/禁止调用 image_gen/);
  assert.match(text,/禁止接管用户已有标签页/);
  assert.match(text,/createBrowserTab\("chrome",undefined,\{sessionName:"🎨 温蒂生图"\}\)/);
  assert.match(text,/tab\.goto\("https:\/\/chatgpt\.com"\)/);
  assert.match(text,/try\s*\{/);
  assert.match(text,/finally\s*\{/);
  assert.doesNotMatch(text,/createBrowserTab\("chrome"[^\n]*visible:false/);
  assert.doesNotMatch(text,/visible\s*:/);
  assert.doesNotMatch(text,/createBrowserTab\("iab"/);
  assert.match(text,/BROWSER_FOCUS_UNAVAILABLE/);
  assert.match(text,/没有窗口\/标签页 active 或 focused 更新接口/);
  assert.doesNotMatch(text,/browser\.capabilities\.list\(|management\.windows|getAll\(\{populate:true\}\)|management\.tabs\.update|management\.windows\.update/);
  assert.match(text,/可能短暂取得焦点/);
  assert.match(text,/无法严格保证零焦点切换/);
  assert.match(text,/只绑定返回的自有 tab/);
  assert.doesNotMatch(text,/不创建标签页、不上传、不发送/);
  assert.doesNotMatch(text,/cua\.getTab\(/);
  assert.match(text,/tab\.close\(\)/);
  assert.match(text,/waitForEvent\("filechooser"\)/);
  assert.match(text,/chooser\.setFiles\(worker\.referenceFiles\)/);
  assert.match(text,/禁止调用 cua\.getApp/);
  assert.match(text,/不得重复提交/);
  assert.match(text,/authorization 是该操作发生后的持久证据/);
  assert.match(text,/当前同一个回合完成/);
});
test('web executor availability reports the direct Chrome focus boundary',()=>{
  const worker=G.webWorkerStatus();assert.equal(worker.transport,'direct-chrome');assert.equal(worker.browser,'chrome');assert.equal(worker.state,'available');assert.equal(worker.focusRestoration,'unsupported');assert.equal(worker.focusSafe,false);assert.equal(worker.ready,true);assert.equal(worker.message,'执行器可用，站点访问权限将在任务中验证。');
});
test('UI keeps real image errors and removes the non-blocking Chrome focus notice',()=>{
  const text=fs.readFileSync(path.join(W.APP,'app/page.tsx'),'utf8');
  assert.match(text,/IAB_UNAVAILABLE/);
  assert.match(text,/BROWSER_FOCUS_UNAVAILABLE/);
  assert.match(text,/BROWSER_ORIGIN_PERMISSION_DENIED/);
  assert.match(text,/FILE_UPLOAD_CHROME_UNAVAILABLE/);
  assert.match(text,/附件上传没有完成/);
  assert.match(text,/上一版原图仍保留/);
  assert.match(text,/chatgpt\.com 访问权限被拒绝/);
  assert.match(text,/公开 CUA 没有 Chrome/);
  assert.match(text,/无法零焦点切换/);
  assert.match(text,/当前生产链路使用专用 Chrome 标签页/);
  assert.match(text,/imageReady=\{data\?\.connection\.imageWorker\?\.ready !== false\}/);
  assert.doesNotMatch(text,/imageWorker\?\.focusSafe !== false/);
  assert.match(text,/网页生图当前不可用/);
  assert.match(text,/原图已保存，自动校对未完成，请人工查看；不会自动重生/);
  assert.match(text,/artifact_saved_unchecked: '原图已保存，自动校对未完成'/);
  assert.match(text,/review_required: '原图已保存，等待人工查看'/);
  assert.match(text,/!imageReady && project\.status === 'review'/);
  assert.doesNotMatch(text,/专用 Chrome 标签页会短暂取得焦点/);
  assert.doesNotMatch(text,/隐藏网页浏览器能力不可用；没有上传附件或发送消息。请恢复 Codex 内嵌浏览器 IAB/);
});
test('missing hidden IAB is definite pre-submission no-output evidence',()=>{
  const evidence=B.classifyGenerationEvidence({responseText:'Browser is not available: iab',exitCode:0});
  assert.equal(evidence.outcome,'no_image');
  assert.equal(evidence.connectionRelated,false);
});
test('browser generation enables Chrome while disabling image API',async()=>{
  const argvFile=path.join(temp,'browser-argv.json'),dir=path.join(temp,'browser-run');process.env.WENDI_TEST_ARGV=argvFile;
  const output=path.join(temp,'browser-result.png');await B.runCodex({dir,image:true,browserMode:'chrome',prompt:`复制到准确路径 ${output}`});delete process.env.WENDI_TEST_ARGV;
  const argv=JSON.parse(fs.readFileSync(argvFile,'utf8'));
  assert(argv.includes('image_generation'));assert(argv.includes('--approve-for-me'));assert(!argv.includes('-s'));assert(!argv.includes('--sandbox'));assert(!argv.includes('browser_use_external'));
  assert.equal(argv.includes('--ignore-user-config'),false);
});
test('non-browser execution keeps its existing sandbox mode',async()=>{
  const argvFile=path.join(temp,'non-browser-argv.json'),dir=path.join(temp,'non-browser-run');process.env.WENDI_TEST_ARGV=argvFile;
  await B.runCodex({dir,schema:{type:'object',properties:{},additionalProperties:false},prompt:'只返回测试 JSON，不调用工具。'});delete process.env.WENDI_TEST_ARGV;
  const argv=JSON.parse(fs.readFileSync(argvFile,'utf8')),sandboxIndex=argv.indexOf('-s');
  assert(sandboxIndex>=0);assert.equal(argv[sandboxIndex+1],'read-only');assert.equal(argv.includes('--approve-for-me'),false);
});
test('manual title is retained when a later plan is saved',async()=>{
  let named=E.createProject(brief);named.title='用户指定名称';named.titleLocked=true;E.saveProject(named);
  E.planProject(named);named=await done(named.id);
  assert.equal(named.title,'用户指定名称');assert.equal(named.schemaVersion,3);assert(named.revision>0);
});
test('the durable local queue runs separate projects one at a time',async()=>{
  let first=E.createProject(brief),second=E.createProject({...brief,idea:'第二个并发的队列流程'});const events=[];
  E.job(first,'planning',async()=>{events.push('first-start');await new Promise(resolve=>setTimeout(resolve,80));events.push('first-end');});
  E.job(second,'planning',async()=>{events.push('second-start');events.push('second-end');});
  first=await done(first.id);second=await done(second.id);
  assert.deepEqual(events,['first-start','first-end','second-start','second-end']);assert.equal(first.queueJob,null);assert.equal(second.queueJob,null);
  const queue=path.join(process.env.WENDI_DATA_DIR,'.任务队列','jobs');const records=fs.readdirSync(queue).map(name=>JSON.parse(fs.readFileSync(path.join(queue,name),'utf8'))).filter(job=>[first.id,second.id].includes(job.projectId));assert.equal(records.length,2);assert(records.every(job=>job.status==='completed'&&job.heartbeatAt));
});
test('a queued job waits for an external executor lock and then runs',async()=>{
  const external=new J.JobStore(process.env.WENDI_DATA_DIR),held=external.enqueue({projectId:'external',phase:'planning'}),owner=`${process.pid}:external-test`;assert(external.claim(held.id,owner));
  let queued=E.createProject({...brief,idea:'等待外部执行锁的流程'}),invoked=false;E.job(queued,'planning',async()=>{invoked=true;});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(invoked,false);assert.equal(E.active.has(queued.id),true);
  external.finish(held.id,owner,'completed');queued=await done(queued.id);assert.equal(invoked,true);assert.equal(E.active.has(queued.id),false);assert.equal(queued.queueJob,null);
});
test('cancelled queue records release active state without running',async()=>{
  const store=new J.JobStore(process.env.WENDI_DATA_DIR);let queued=E.createProject(brief),invoked=false;
  E.job(queued,'planning',async()=>{invoked=true;});store.cancel(queued.queueJob.id,'interrupted');
  queued=await done(queued.id);assert.equal(invoked,false);assert.equal(queued.status,'paused');assert.equal(queued.queueJob,null);
});
test('partial running brief updates preserve the story requirements',async()=>{
  let queued=E.createProject(brief);E.job(queued,'planning',async()=>{});
  E.syncRunningProject(queued.id,{brief:{model:'updated-model',reasoningEffort:'low'}});
  queued=await done(queued.id);assert.equal(queued.brief.idea,brief.idea);assert.equal(queued.brief.pageCount,1);assert.equal(queued.brief.model,'updated-model');
});
test('restart consumes a queued record once and marks the project recoverable',()=>{
  const store=new J.JobStore(process.env.WENDI_DATA_DIR);let queued=E.createProject({...brief,idea:'重启恢复待执行任务'});const record=store.enqueue({projectId:queued.id,phase:'planning'});queued.status='planning';E.saveProject(queued);
  E.recover();queued=E.readProject(queued.id);assert.equal(queued.status,'paused');assert.equal(queued.queueJob.status,'recoverable');assert.equal(store.read(record.id).status,'interrupted');
  E.recover();queued=E.readProject(queued.id);assert.equal(store.recoverable().some(job=>job.id===record.id),false);assert.equal(queued.queueJob.status,'recoverable');
});
test('restart recovery leaves a project owned by another live process untouched',async()=>{
  let live=E.createProject({...brief,idea:'跨进程存活任务恢复测试'});live.status='generating';E.saveProject(live);
  const moduleURL=pathToFileURL(path.join(W.APP,'server/job-store.mjs')).href,script=`import {JobStore} from ${JSON.stringify(moduleURL)};const store=new JobStore(process.argv[1]),owner=process.pid+':live-project';store.enqueue({projectId:process.argv[2],phase:'generating',submitter:owner});console.log('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,process.env.WENDI_DATA_DIR,live.id],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors||'live owner did not start')),3000);child.stdout.on('data',chunk=>{if(String(chunk).includes('ready')){clearTimeout(timer);resolve();}});child.on('error',reject);});
  try{E.recover();live=E.readProject(live.id);assert.equal(live.status,'generating');assert.equal(live.queueJob,undefined);}
  finally{child.kill('SIGTERM');await new Promise(resolve=>child.once('close',resolve));}
});
test('planning, frozen approval, samples gate and production',async()=>{
  p=E.createProject(brief);assert.throws(()=>E.generatePages(p),/确认/);
  E.planProject(p);p=await done(p.id);assert.equal(p.status,'review');assert.equal(p.pages.length,0);
  assert.throws(()=>E.approvePlan(p,'old-hash'),/更新/);
  E.approvePlan(p,W.digest(p.plan));p=await done(p.id);assert.equal(p.status,'samples_review');assert.equal(p.samples.length,2);assert.equal(p.pages.length,0);
  const version=path.join(E.projectDir(p.id),'v1');assert(fs.existsSync(path.join(version,'工作要求快照.md')));
  assert(fs.existsSync(path.join(version,'参考',W.FACE[0])));assert(fs.existsSync(path.join(version,'参考',W.FACE[1])));
  const imageRuns=fs.readdirSync(path.join(E.projectDir(p.id),'.制作记录')).filter(name=>name.includes('样张-'));
  assert(imageRuns.length>=2);const manifestDir=path.join(E.projectDir(p.id),'.制作记录',imageRuns[0]);
  const request=JSON.parse(fs.readFileSync(path.join(manifestDir,'request.json'),'utf8')),result=JSON.parse(fs.readFileSync(path.join(manifestDir,'result.json'),'utf8'));
  assert.equal(request.schemaVersion,2);assert.equal(request.provider,G.WEB_IMAGE_PROVIDER);assert.equal(request.target.startsWith('样张-'),true);assert.equal(request.role,'browser-executor');assert.equal(request.executorReasoningEffort,'low');assert.equal(request.creativeReasoningEffort,p.brief.reasoningEffort);assert.equal(result.provider,G.WEB_IMAGE_PROVIDER);assert.equal(result.outcome,'artifact_saved');assert.equal(typeof result.integrity.sha256,'string');assert(p.metrics.byRole.some(item=>item.role==='browser-executor'&&item.reasoningEffort==='low'));
  assert.throws(()=>E.generatePages(p),/样张/);
  E.approveSamples(p,p.approved.hash);p=await done(p.id);assert.equal(p.status,'ready');assert.equal(p.pages.length,1);assert.equal(p.accepted,false);
  const file=W.inside(E.projectDir(p.id),p.pages[0].file);const info=JSON.parse(await B.pythonRun(['info',file]));assert.deepEqual(info,{width:1080,height:1440,mode:'RGB',format:'PNG'});
  await assert.rejects(E.accept(p,[]),/验收/);
  await E.accept(p,W.CHECKS);assert.equal(p.status,'complete');assert(fs.existsSync(W.inside(E.projectDir(p.id),p.bundle)));
  assert.equal(p.artifacts.find(x=>x.id==='page:1')?.valid,true);
  assert.equal(p.artifacts.find(x=>x.id==='story:audit')?.valid,true);
  assert.equal(p.artifacts.find(x=>x.id==='export:bundle')?.valid,true);
  execFileSync('/usr/bin/unzip',['-t',W.inside(E.projectDir(p.id),p.bundle)]);
});
test('page layout repair and whole-story unification never regenerate source images',async()=>{
  let layout=E.createProject({...brief,idea:'本地排版修复不重新生图'});layout.plan=structuredClone(plan);layout.version=1;layout.approved={version:1,hash:W.digest(layout.plan)};layout.samplesApproved=true;layout.status='paused';E.saveProject(layout);
  E.generatePages(layout);layout=await done(layout.id);assert.equal(layout.status,'ready');
  const originalPage=layout.pages[0],originalPageFile=W.inside(E.projectDir(layout.id),originalPage.file),imageTasks=layout.tasks.filter(task=>task.kind==='image').length;
  originalPage.qa={pass:false,summary:'文字框遮挡主体',issues:['第1格文字框遮挡人物'],issueDetails:[{id:'layout-1',category:'layout',severity:'blocking',location:'第1格下方文字框',description:'第1格文字框遮挡人物',repairAction:'recompose'}],repairPrompt:'把文字框移到对侧'};originalPage.nextStep='重新排版';layout.status='attention';E.saveProject(layout);
  E.repairPageLayout(layout,1);layout=await done(layout.id);assert.equal(layout.status,'paused');assert.equal(layout.pages[0].qa.pass,true);assert.deepEqual(layout.pageLayouts[1].captionAnchors,['top-right']);assert.equal(layout.tasks.filter(task=>task.kind==='image').length,imageTasks);assert(fs.existsSync(originalPageFile));assert.notEqual(layout.pages[0].file,originalPage.file);
  const secondPlan={...structuredClone(layout.plan.pages[0]),number:2,title:'第二页'};layout.plan.pages.push(secondPlan);layout.brief.pageCount=2;layout.approved.hash=W.digest(layout.plan);layout.panels['2-1']={...structuredClone(layout.panels['1-1']),key:'第2页-第1格'};layout.pages.push({...structuredClone(layout.pages[0]),number:2});layout.artifacts.push({...structuredClone(layout.artifacts.find(item=>item.id==='page:1')),id:'page:2'});E.saveProject(layout);
  E.unifyPageLayouts(layout);layout=await done(layout.id);assert.equal(layout.status,'paused');assert.equal(layout.pages.length,2);assert(layout.pages.every(page=>page.qa.pass&&page.layoutHints.style==='floating-v2'));assert.equal(layout.tasks.filter(task=>task.kind==='image').length,imageTasks);
});
test('panel revision invalidates stale page before QA resume and export',async()=>{
  let revised=E.createProject({...brief,idea:'正式分镜修订失效边界测试',workflowPreset:'careful'});E.planProject(revised);revised=await done(revised.id);E.approvePlan(revised,W.digest(revised.plan));revised=await done(revised.id);E.approveSamples(revised,revised.approved.hash);revised=await done(revised.id);
  assert.equal(revised.status,'ready');
  const oldPage=revised.pages[0],oldPanel=revised.panels['1-1'],oldPageFile=W.inside(E.projectDir(revised.id),oldPage.file),oldPanelFile=W.inside(E.projectDir(revised.id),oldPanel.file),marker=path.join(temp,'panel-qa-interrupted');
  process.env.WENDI_TEST_CRASH_PANEL_QA_ONCE=marker;E.reviseImage(revised,'1-1','把书放下并看向窗外。');revised=await done(revised.id);delete process.env.WENDI_TEST_CRASH_PANEL_QA_ONCE;
  assert.equal(revised.status,'attention');assert(fs.existsSync(oldPageFile));assert(fs.existsSync(oldPanelFile));
  assert.equal(revised.pages.length,0);assert.equal(revised.storyQA,null);assert.equal(revised.accepted,false);assert.equal(revised.bundle,null);
  assert.equal(revised.artifacts.find(x=>x.id==='page:1')?.valid,false);assert.equal(revised.artifacts.find(x=>x.id==='story:audit')?.valid,false);assert.equal(revised.invalidatedPages?.[0]?.page.number,1);
  const currentPanel=revised.panels['1-1'];assert(currentPanel);assert.notEqual(currentPanel.file,oldPanel.file);assert.equal(currentPanel.qa.status,'unavailable');
  E.reviewImage(revised,'1-1');revised=await done(revised.id);assert.equal(revised.panels['1-1'].qa.pass,true);
  E.resume(revised);revised=await done(revised.id);assert.equal(revised.status,'ready');assert.equal(revised.pages.length,1);assert.notEqual(revised.pages[0].file,oldPage.file);
  await E.accept(revised,W.CHECKS);const exported=W.inside(E.projectDir(revised.id),revised.pages[0].finalFile);assert.deepEqual(fs.readFileSync(exported),fs.readFileSync(W.inside(E.projectDir(revised.id),revised.pages[0].file)));
});
test('panel revisions keep an independent delta and return to the selected stable base after a failed draft',async()=>{
  const revised=E.createProject({...brief,idea:'独立修订差异与稳定基图测试',workflowPreset:'quick'});revised.plan=structuredClone(plan);revised.version=1;revised.approved={version:1,hash:W.digest(revised.plan)};revised.samplesApproved=true;revised.status='ready';
  const root=E.projectDir(revised.id),file=path.join(root,'v1','素材','稳定基图.png'),relative=path.relative(root,file),at=new Date().toISOString(),integrity={sha256:sha256File(W.inside(W.REFS,W.FACE[0])),sizeBytes:fs.statSync(W.inside(W.REFS,W.FACE[0])).size};fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(W.inside(W.REFS,W.FACE[0]),file);integrity.sha256=sha256File(file);integrity.sizeBytes=fs.statSync(file).size;
  revised.panels={'1-1':{key:'第1页第1格',file:relative,prompt:'LEGACY_PROMPT_WITH_OLD_DELTA',basePrompt:'BASE_PROMPT',refs:panel.references,integrity,qa:{pass:true,status:'passed',summary:'fixture',issues:[],issueDetails:[],repairPrompt:''},at}};revised.artifacts=[{id:'image:第1页-第1格',kind:'image',file:relative,dependsOn:[],valid:true,at,integrity}];E.saveProject(revised);
  const marker=path.join(temp,'revision-qa-failure-once');process.env.WENDI_TEST_FAIL_PANEL_QA_ONCE=marker;E.reviseImage(revised,'1-1','把书放下并看向窗外。');const first=await done(revised.id);delete process.env.WENDI_TEST_FAIL_PANEL_QA_ONCE;
  assert.equal(first.status,'attention');assert.equal(first.panels['1-1'].qa.pass,false);assert.equal(first.panels['1-1'].revisionBase.selectedBy,'current-image');
  const records=path.join(root,'.制作记录'),firstDir=fs.readdirSync(records).map(name=>path.join(records,name)).find(dir=>dir.includes('1-1-局部修订'));assert(firstDir);const firstRequest=JSON.parse(fs.readFileSync(path.join(firstDir,'request.json'),'utf8')),firstPrompt=fs.readFileSync(path.join(firstDir,'prompt.txt'),'utf8');assert.equal(firstRequest.executorReasoningEffort,'low');assert.equal(firstRequest.referenceFiles.length,4);assert.match(firstPrompt,/BASE_PROMPT/);assert.match(firstPrompt,/把书放下并看向窗外/);assert.doesNotMatch(firstPrompt,/LEGACY_PROMPT_WITH_OLD_DELTA/);
  E.reviseImage(first,'1-1','把咖啡杯移到右侧。');const second=await done(first.id);assert.equal(second.status,'paused');assert.equal(second.panels['1-1'].revisionBase.selectedBy,'previous-stable-base');
  const revisionDirs=fs.readdirSync(records).filter(name=>name.includes('1-1-局部修订')).map(name=>path.join(records,name)).sort(),secondDir=revisionDirs.at(-1),secondRequest=JSON.parse(fs.readFileSync(path.join(secondDir,'request.json'),'utf8')),secondPrompt=fs.readFileSync(path.join(secondDir,'prompt.txt'),'utf8');assert.equal(revisionDirs.length,2);assert.equal(secondRequest.editTarget.sha256,firstRequest.editTarget.sha256);assert.equal(secondRequest.preparation.reusedCount,4);assert.match(secondPrompt,/BASE_PROMPT/);assert.match(secondPrompt,/把咖啡杯移到右侧/);assert.doesNotMatch(secondPrompt,/把书放下并看向窗外/);assert.doesNotMatch(secondPrompt,/LEGACY_PROMPT_WITH_OLD_DELTA/);
});
test('layout-only panel edits stop at the local recompose path',()=>{
  const fixture=panelDecisionFixture('文字问题不消耗生图额度'),before=fixture.project.tasks.length;assert.throws(()=>E.reviseImage(fixture.project,'1-1','把旁白文字框移到右上角，重新排版。'),error=>error.code==='LOCAL_LAYOUT_REQUIRED');assert.equal(fixture.project.tasks.length,before);assert.equal(E.active.has(fixture.project.id),false);
});
test('inner-screen postprocess becomes the page dependency without repeating on resume',async()=>{
  const screenPlan=structuredClone(plan);screenPlan.pages[0].panels[0].screenText='现在播放';screenPlan.pages[0].panels[0].screenDirection='输入框可发送';
  let screened=E.createProject({...brief,idea:'内屏后期实际依赖与恢复测试',workflowPreset:'balanced'});screened.plan=screenPlan;screened.version=1;screened.approved={version:1,hash:W.digest(screenPlan)};screened.samplesApproved=true;screened.status='paused';E.saveProject(screened);
  E.generatePages(screened);screened=await done(screened.id);assert.equal(screened.status,'ready');
  const panelRecord=screened.panels['1-1'],rawFile=W.inside(E.projectDir(screened.id),panelRecord.rawFile),screenFile=W.inside(E.projectDir(screened.id),panelRecord.file);assert(panelRecord.screenApplied);assert(panelRecord.rawFile);assert.notEqual(panelRecord.file,panelRecord.rawFile);assert(fs.existsSync(rawFile));assert(fs.existsSync(screenFile));
  assert.equal(panelRecord.screenQA.status,'local');assert.equal(panelRecord.screenQA.pass,true);assert(panelRecord.screenQA.projectedTextPx>=15);assert.deepEqual(panelRecord.screenQA.renderedLines,['现在播放']);assert.equal(panelRecord.screenLocation.sourceSha256,sha256File(rawFile));
  const imageArtifact=screened.artifacts.find(item=>item.id==='image:第1页-第1格'),pageArtifact=screened.artifacts.find(item=>item.id==='page:1');assert.equal(imageArtifact.file,panelRecord.file);assert.equal(imageArtifact.valid,true);assert.equal(pageArtifact.valid,true);assert.deepEqual(screened.pages[0].dependsOn,['image:第1页-第1格']);
  const layoutRun=fs.readdirSync(path.join(E.projectDir(screened.id),'.制作记录')).find(name=>name.includes('第1页排版'));assert(layoutRun);const layout=JSON.parse(fs.readFileSync(path.join(E.projectDir(screened.id),'.制作记录',layoutRun,'排版.json'),'utf8'));assert.deepEqual(layout.images,[screenFile]);
  const screenRunDir=path.join(E.projectDir(screened.id),'.制作记录',fs.readdirSync(path.join(E.projectDir(screened.id),'.制作记录')).find(name=>name.includes('内屏文字排版')));const screenSpec=JSON.parse(fs.readFileSync(path.join(screenRunDir,'内屏排版.json'),'utf8'));assert.equal(screenSpec.screenText,'现在播放');assert.equal(fs.existsSync(path.join(screenRunDir,'render_screen.py')),false);
  const imageTaskCount=screened.tasks.filter(task=>task.kind==='image').length,screenRuns=fs.readdirSync(path.join(E.projectDir(screened.id),'.制作记录')).filter(name=>name.includes('内屏文字排版')).length;
  screened.status='paused';E.saveProject(screened);E.resume(screened);screened=await done(screened.id);assert.equal(screened.status,'ready');assert.equal(screened.tasks.filter(task=>task.kind==='image').length,imageTaskCount);assert.equal(fs.readdirSync(path.join(E.projectDir(screened.id),'.制作记录')).filter(name=>name.includes('内屏文字排版')).length,screenRuns);
  await E.accept(screened,W.CHECKS);assert.equal(screened.status,'complete');const exported=W.inside(E.projectDir(screened.id),screened.pages[0].finalFile);assert.deepEqual(fs.readFileSync(exported),fs.readFileSync(W.inside(E.projectDir(screened.id),screened.pages[0].file)));
});
test('panel adoption validates the actual file and rechecks async state',async()=>{
  const missing=panelDecisionFixture('缺失正式分镜不能采用');fs.unlinkSync(missing.file);await assert.rejects(()=>E.decidePanel(missing.project,panelDecisionBody(missing)),/图片|文件/);let saved=E.readProject(missing.project.id);assert.equal(saved.panels['1-1'].userDecision,undefined);assert.equal(saved.panelDecision.state,'required');
  const corrupt=panelDecisionFixture('损坏正式分镜不能采用');fs.writeFileSync(corrupt.file,'not an image');await assert.rejects(()=>E.decidePanel(corrupt.project,panelDecisionBody(corrupt)),/图片|文件/);saved=E.readProject(corrupt.project.id);assert.equal(saved.panels['1-1'].userDecision,undefined);assert.equal(saved.panelDecision.state,'required');
  const replaced=panelDecisionFixture('替换正式分镜不能沿用旧身份');const oldDecision=panelDecisionBody(replaced);fs.copyFileSync(W.inside(W.REFS,W.FACE[1]),replaced.file);await assert.rejects(()=>E.decidePanel(replaced.project,oldDecision),/内容|更新|完整性/);saved=E.readProject(replaced.project.id);assert.equal(saved.panels['1-1'].userDecision,undefined);
  const stale=panelDecisionFixture('异步校验期间过期决定');const staleDecision=panelDecisionBody(stale);const pendingDecision=E.decidePanel(stale.project,staleDecision);const changed=E.readProject(stale.project.id);changed.message='另一个本地操作已更新作品';E.saveProject(changed);await assert.rejects(()=>pendingDecision,/更新|刷新|过期/);saved=E.readProject(stale.project.id);assert.equal(saved.panels['1-1'].userDecision,undefined);
  const valid=panelDecisionFixture('完整图片可以人工采用');const beforeImages=valid.project.tasks.filter(task=>task.kind==='image').length;await E.decidePanel(valid.project,panelDecisionBody(valid));assert.equal(valid.project.panels['1-1'].userDecision.action,'accept_current');assert.equal(valid.project.panels['1-1'].qa.pass,false);assert.equal(valid.project.tasks.filter(task=>task.kind==='image').length,beforeImages);assert.equal(valid.project.pages.length,0);
});
test('pending recovery stays bound to its plan version across a plan revision',async()=>{
  let switched=E.createProject({...brief,idea:'方案版本隔离与迟到原图测试'});E.planProject(switched);switched=await done(switched.id);E.approvePlan(switched,W.digest(switched.plan));switched=await done(switched.id);
  const oldSource=W.inside(E.projectDir(switched.id),switched.samples[0].file),oldFile=path.join(E.projectDir(switched.id),'v1','素材','旧版本待恢复.png'),oldDir=path.join(E.projectDir(switched.id),'.制作记录','旧版本待恢复');fs.copyFileSync(oldSource,oldFile);fs.mkdirSync(oldDir,{recursive:true});
  const oldTask={id:'old-version-pending',kind:'image',target:'样张-1',status:'unknown_result',providerInvocations:1,projectVersion:switched.version};switched.pending={key:'样张-1',file:oldFile,dir:oldDir,prompt:'旧版图',refs:[],inputFiles:[],taskId:oldTask.id,projectId:switched.id,projectVersion:switched.version,at:new Date().toISOString()};switched.tasks=[...(switched.tasks||[]),oldTask];switched.currentTask=oldTask;switched.status='attention';E.saveProject(switched);
  E.planProject(switched,'把最后一格改成新版方案。');switched=await done(switched.id);
  assert.equal(switched.version,2);assert.equal(switched.pending,null);assert.equal(switched.currentTask,null);assert.equal(switched.tasks.find(task=>task.id===oldTask.id).status,'superseded');assert.equal(switched.supersededPending.at(-1).projectVersion,1);assert.equal(switched.supersededPending.at(-1).file,oldFile);assert.equal(switched.history.at(-1).pending.file,oldFile);assert(fs.existsSync(oldFile));
  E.approvePlan(switched,W.digest(switched.plan));switched=await done(switched.id);assert.equal(switched.samples.length,2);assert.throws(()=>E.recoverImage(switched),/没有待找回/);assert(fs.existsSync(oldFile));assert.notEqual(switched.samples[0].file,path.relative(E.projectDir(switched.id),oldFile));
  let same=E.createProject({...brief,idea:'同版本原图恢复测试'});E.planProject(same);same=await done(same.id);E.approvePlan(same,W.digest(same.plan));same=await done(same.id);const sameSource=W.inside(E.projectDir(same.id),same.samples[0].file),sameFile=path.join(E.projectDir(same.id),'v1','素材','同版本找回.png');fs.copyFileSync(sameSource,sameFile);same.samples=[];same.pending={key:'样张-1',file:sameFile,dir:path.join(E.projectDir(same.id),'.制作记录','同版本找回'),prompt:'脸部近景',refs:[],inputFiles:[],projectId:same.id,projectVersion:same.version,at:new Date().toISOString()};same.status='attention';E.saveProject(same);E.recoverImage(same);same=await done(same.id);assert.equal(same.samples[0].file,path.relative(E.projectDir(same.id),sameFile));
  let legacy=E.createProject({...brief,idea:'缺少版本字段的恢复测试'});legacy.plan=structuredClone(plan);legacy.version=1;legacy.approved={version:1,hash:W.digest(legacy.plan)};const legacyFile=path.join(E.projectDir(legacy.id),'v1','素材','缺少版本字段.png');fs.mkdirSync(path.dirname(legacyFile),{recursive:true});fs.copyFileSync(oldSource,legacyFile);legacy.pending={key:'样张-1',file:legacyFile,dir:path.join(E.projectDir(legacy.id),'.制作记录','缺少版本字段'),prompt:'旧记录',refs:[],inputFiles:[]};legacy.status='attention';E.saveProject(legacy);E.recoverImage(legacy);legacy=await done(legacy.id);assert.match(legacy.message,/版本归属/);assert.equal(legacy.pending.key,'样张-1');assert(fs.existsSync(legacyFile));assert.equal(legacy.samples.length,0);
});
test('failed formal panel QA has a manual adoption exit without image regeneration',async()=>{
  const marker=path.join(temp,'formal-panel-failure');process.env.WENDI_TEST_FAIL_PANEL_QA_ONCE=marker;let failed=E.createProject({...brief,idea:'正式分镜人工采用出口测试',workflowPreset:'careful'});E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);E.approveSamples(failed,failed.approved.hash);failed=await done(failed.id);delete process.env.WENDI_TEST_FAIL_PANEL_QA_ONCE;
  assert.equal(failed.status,'attention');assert.equal(failed.panels['1-1'].qa.pass,false);assert.equal(failed.pages.length,0);assert.equal(failed.panelDecision?.state,'required');
  const beforeImages=failed.tasks.filter(task=>task.kind==='image').length,beforeFile=failed.panels['1-1'].file,beforeCalls=callCount();E.resume(failed);failed=await done(failed.id);assert.equal(failed.status,'attention');assert.equal(failed.panelDecision?.state,'required');assert.equal(failed.tasks.filter(task=>task.kind==='image').length,beforeImages);assert.equal(callCount(),beforeCalls);
  const artifact=failed.artifacts.find(item=>item.id==='image:第1页-第1格'),contentHash=W.digest({artifactId:artifact.id,file:artifact.file,at:failed.panels['1-1'].at||artifact.at});await E.decidePanel(failed,{key:'1-1',action:'accept_current',artifactId:artifact.id,contentHash,planHash:failed.approved.hash,expectedRevision:failed.revision,acknowledgedIssueIds:['formal-hand'],continueProduction:true});failed=await done(failed.id);
  assert.equal(failed.panels['1-1'].file,beforeFile);assert.equal(failed.panels['1-1'].qa.pass,false);assert.equal(failed.panels['1-1'].userDecision.action,'accept_current');assert.equal(failed.pages.length,1);assert.equal(failed.status,'ready');assert.equal(failed.tasks.filter(task=>task.kind==='image').length,beforeImages);await E.accept(failed,W.CHECKS);assert.equal(failed.status,'complete');
});
test('formal panel failure can be rechecked without creating a new image task',async()=>{
  let reviewed=E.createProject({...brief,idea:'正式分镜重新校对不重生测试',workflowPreset:'careful'});E.planProject(reviewed);reviewed=await done(reviewed.id);E.approvePlan(reviewed,W.digest(reviewed.plan));reviewed=await done(reviewed.id);E.approveSamples(reviewed,reviewed.approved.hash);reviewed=await done(reviewed.id);
  const beforeFile=reviewed.panels['1-1'].file,beforeImages=reviewed.tasks.filter(task=>task.kind==='image').length;reviewed.panels['1-1'].qa={pass:false,status:'needs_review',summary:'测试失败分镜',issues:['手部需要调整'],issueDetails:[{id:'formal-hand',category:'anatomy',severity:'review',description:'手部需要调整',repairAction:'review'}],repairPrompt:'人工确认'};reviewed.status='attention';E.saveProject(reviewed);E.reviewImage(reviewed,'1-1');reviewed=await done(reviewed.id);
  assert.equal(reviewed.panels['1-1'].file,beforeFile);assert.equal(reviewed.panels['1-1'].qa.pass,true);assert.equal(reviewed.tasks.filter(task=>task.kind==='image').length,beforeImages);
});
test('unknown quota values stay unknown and stale reads keep their observation time',async()=>{
  for(const value of [null,'','   ',undefined,true,[],{}])assert.equal(B.normalizeRateLimits({rateLimits:{primary:{usedPercent:value}}}).primary,null);
  assert.deepEqual(B.normalizeRateLimits({rateLimits:{primary:{usedPercent:0,windowDurationMins:300}}}).primary,{usedPercent:0,remainingPercent:100,windowDurationMins:300,resetsAt:null});
  assert.equal(B.normalizeRateLimits({rateLimits:{primary:{usedPercent:' 42 ',windowDurationMins:300}}}).primary.usedPercent,42);assert.equal(B.normalizeRateLimits({rateLimits:{primary:{usedPercent:-5}}}).primary.usedPercent,0);assert.equal(B.normalizeRateLimits({rateLimits:{primary:{usedPercent:101}}}).primary.usedPercent,100);
  assert.equal(B.normalizeRateLimits({rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}}).secondary,null);assert.equal(B.normalizeRateLimits({rateLimits:{secondary:{usedPercent:10,windowDurationMins:10080}}}).primary,null);assert.equal(B.normalizeRateLimits({rateLimits:{secondary:{usedPercent:10,windowDurationMins:10080}}}).secondary.remainingPercent,90);assert.equal(B.normalizeRateLimits({rateLimits:{short:{usedPercent:10,windowDurationMins:300},long:{usedPercent:20,windowDurationMins:10080}}}).secondary.usedPercent,20);assert.equal(B.normalizeRateLimits({rateLimits:{}}).primary,null);assert.equal(B.normalizeRateLimits({rateLimits:{}}).secondary,null);
  const previousPlan=process.env.WENDI_TEST_PLAN_FILE;delete process.env.WENDI_TEST_PLAN_FILE;process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=JSON.stringify({primary:{usedPercent:20,windowDurationMins:300,resetsAt:123}});delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;const fresh=await B.rateLimitSnapshot(1000,{force:true});assert.equal(fresh.status,'fresh');const observedAt=fresh.observedAt;assert.equal(fresh.secondary,null);process.env.WENDI_TEST_RATE_LIMIT_FAIL='1';const stale=await B.rateLimitSnapshot(1000,{force:true});assert.equal(stale.status,'stale');assert.equal(stale.observedAt,observedAt);assert.equal(stale.primary.remainingPercent,80);if(previousPlan)process.env.WENDI_TEST_PLAN_FILE=previousPlan;else delete process.env.WENDI_TEST_PLAN_FILE;delete process.env.WENDI_TEST_RATE_LIMIT_RESPONSE;delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;
});
test('paid image quota guard refreshes cached-high limits before any upload',async()=>{
  const previousPlan=process.env.WENDI_TEST_PLAN_FILE,previousResponse=process.env.WENDI_TEST_RATE_LIMIT_RESPONSE,previousFailure=process.env.WENDI_TEST_RATE_LIMIT_FAIL;
  try{
    delete process.env.WENDI_TEST_PLAN_FILE;delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;
    process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=JSON.stringify({primary:{usedPercent:20,windowDurationMins:300,resetsAt:123},byLimitId:{codex:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:123}},base_model_inference:{limitId:'base_model_inference',normalModelSlug:'fixture-model',primary:{usedPercent:20,windowDurationMins:10080,resetsAt:456}}}});
    const cachedHigh=await B.rateLimitSnapshot(1000,{force:true});assert.equal(cachedHigh.status,'fresh');assert.equal(cachedHigh.primary.remainingPercent,80);
    process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=JSON.stringify({primary:{usedPercent:90,windowDurationMins:300,resetsAt:456},byLimitId:{codex:{limitId:'codex',primary:{usedPercent:90,windowDurationMins:300,resetsAt:456}},base_model_inference:{limitId:'base_model_inference',normalModelSlug:'fixture-model',primary:{usedPercent:20,windowDurationMins:10080,resetsAt:789}}}});
    let guarded=E.createProject({...brief,idea:'额度强制刷新停止上传测试',model:'fixture-model'});guarded.plan=structuredClone(plan);guarded.version=1;guarded.approved={version:1,hash:W.digest(guarded.plan)};guarded.samplesApproved=true;guarded.status='ready';E.saveProject(guarded);
    const beforeCalls=callCount();E.generatePages(guarded);guarded=await done(guarded.id);
    assert.equal(guarded.status,'paused');assert.match(guarded.message,/5小时创作额度只剩 10%/);assert.equal(guarded.lastQuotaCheck.status,'fresh');assert.notEqual(guarded.lastQuotaCheck.observedAt,cachedHigh.observedAt);
    assert.equal(guarded.tasks.filter(task=>task.kind==='image').length,0);assert.equal(callCount(),beforeCalls);
    const records=path.join(E.projectDir(guarded.id),'.制作记录');const sent=fs.existsSync(records)&&fs.readdirSync(records).some(name=>fs.existsSync(path.join(records,name,'worker-request.json')));assert.equal(sent,false);
  }finally{
    if(previousPlan===undefined)delete process.env.WENDI_TEST_PLAN_FILE;else process.env.WENDI_TEST_PLAN_FILE=previousPlan;
    if(previousResponse===undefined)delete process.env.WENDI_TEST_RATE_LIMIT_RESPONSE;else process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=previousResponse;
    if(previousFailure===undefined)delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;else process.env.WENDI_TEST_RATE_LIMIT_FAIL=previousFailure;
  }
});
test('paid image quota guard fails closed when forced refresh is stale',async()=>{
  const previousPlan=process.env.WENDI_TEST_PLAN_FILE,previousResponse=process.env.WENDI_TEST_RATE_LIMIT_RESPONSE,previousFailure=process.env.WENDI_TEST_RATE_LIMIT_FAIL;
  try{
    delete process.env.WENDI_TEST_PLAN_FILE;delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;
    process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=JSON.stringify({primary:{usedPercent:20,windowDurationMins:300,resetsAt:123},byLimitId:{codex:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:123}},base_model_inference:{limitId:'base_model_inference',normalModelSlug:'fixture-model',primary:{usedPercent:20,windowDurationMins:10080,resetsAt:456}}}});
    const cachedHigh=await B.rateLimitSnapshot(1000,{force:true});assert.equal(cachedHigh.status,'fresh');assert.equal(cachedHigh.primary.remainingPercent,80);
    process.env.WENDI_TEST_RATE_LIMIT_FAIL='1';
    let guarded=E.createProject({...brief,idea:'额度旧缓存失败关闭测试'});guarded.plan=structuredClone(plan);guarded.version=1;guarded.approved={version:1,hash:W.digest(guarded.plan)};guarded.samplesApproved=true;guarded.status='ready';E.saveProject(guarded);
    const beforeCalls=callCount();E.generatePages(guarded);guarded=await done(guarded.id);
    assert.equal(guarded.status,'paused');assert.match(guarded.message,/无法确认最新的 5 小时创作额度/);assert.equal(guarded.lastQuotaCheck.status,'stale');assert.equal(guarded.lastQuotaCheck.remaining,80);assert.equal(guarded.lastQuotaCheck.observedAt,cachedHigh.observedAt);
    assert.equal(guarded.tasks.filter(task=>task.kind==='image').length,0);assert.equal(callCount(),beforeCalls);
    const records=path.join(E.projectDir(guarded.id),'.制作记录'),prepared=fs.existsSync(records)&&fs.readdirSync(records).some(name=>fs.existsSync(path.join(records,name,'上传素材.json'))),sent=fs.existsSync(records)&&fs.readdirSync(records).some(name=>fs.existsSync(path.join(records,name,'worker-request.json')));assert.equal(prepared,false);assert.equal(sent,false);
  }finally{
    if(previousPlan===undefined)delete process.env.WENDI_TEST_PLAN_FILE;else process.env.WENDI_TEST_PLAN_FILE=previousPlan;
    if(previousResponse===undefined)delete process.env.WENDI_TEST_RATE_LIMIT_RESPONSE;else process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=previousResponse;
    if(previousFailure===undefined)delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;else process.env.WENDI_TEST_RATE_LIMIT_FAIL=previousFailure;
  }
});
test('image quota guard uses only the fresh five-hour Codex window',async()=>{
  const previousPlan=process.env.WENDI_TEST_PLAN_FILE,previousResponse=process.env.WENDI_TEST_RATE_LIMIT_RESPONSE,previousFailure=process.env.WENDI_TEST_RATE_LIMIT_FAIL;
  try{
    delete process.env.WENDI_TEST_PLAN_FILE;delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;
    process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=JSON.stringify({primary:{usedPercent:20,windowDurationMins:300,resetsAt:123},byLimitId:{codex:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:123}},base_model_inference:{limitId:'base_model_inference',normalModelSlug:'gpt-5.6-luna',primary:{usedPercent:95,windowDurationMins:10080,resetsAt:789}}}});
    let low=E.createProject({...brief,idea:'模型额度仅作信息展示',model:'gpt-5.6-luna'});low.plan=structuredClone(plan);low.version=1;low.approved={version:1,hash:W.digest(low.plan)};low.samplesApproved=true;low.status='ready';E.saveProject(low);const before=callCount();E.generatePages(low);low=await done(low.id);assert.equal(low.lastQuotaCheck.remaining,80);assert.equal(low.lastQuotaCheck.executorLimitId,'base_model_inference');assert.equal(low.lastQuotaCheck.executorRemaining,5);assert(low.tasks.some(task=>task.kind==='image'));assert(callCount()>before);assert.doesNotMatch(String(low.message||''),/生图执行器.*额度/);
    process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=JSON.stringify({primary:{usedPercent:20,windowDurationMins:300,resetsAt:123},byLimitId:{codex:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:123}}}});
    let unknown=E.createProject({...brief,idea:'模型额度桶缺失不阻断生图',model:'gpt-5.6-luna'});unknown.plan=structuredClone(plan);unknown.version=1;unknown.approved={version:1,hash:W.digest(unknown.plan)};unknown.samplesApproved=true;unknown.status='ready';E.saveProject(unknown);const beforeUnknown=callCount();E.generatePages(unknown);unknown=await done(unknown.id);assert.equal(unknown.lastQuotaCheck.remaining,80);assert.equal(unknown.lastQuotaCheck.executorLimitId,null);assert.equal(unknown.lastQuotaCheck.executorRemaining,null);assert(unknown.tasks.some(task=>task.kind==='image'));assert(callCount()>beforeUnknown);assert.doesNotMatch(String(unknown.message||''),/无法确认生图执行器/);
  }finally{
    if(previousPlan===undefined)delete process.env.WENDI_TEST_PLAN_FILE;else process.env.WENDI_TEST_PLAN_FILE=previousPlan;
    if(previousResponse===undefined)delete process.env.WENDI_TEST_RATE_LIMIT_RESPONSE;else process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=previousResponse;
    if(previousFailure===undefined)delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;else process.env.WENDI_TEST_RATE_LIMIT_FAIL=previousFailure;
  }
});
test('legacy version snapshots restore missing prompt capsule and references before retrying',async()=>{
  let legacy=E.createProject(brief);E.planProject(legacy);legacy=await done(legacy.id);E.approvePlan(legacy,W.digest(legacy.plan));legacy=await done(legacy.id);
  const version=path.join(E.projectDir(legacy.id),'v1');const reference=path.join(version,'参考',W.FACE[0]);
  fs.rmSync(path.join(version,'制作提示词胶囊.txt'));fs.rmSync(reference);
  legacy.samples=[];legacy.samplesApproved=false;legacy.pending=null;legacy.status='attention';E.saveProject(legacy);
  E.resume(legacy);legacy=await done(legacy.id);
  assert.equal(legacy.status,'samples_review');
  assert(fs.existsSync(path.join(version,'制作提示词胶囊.txt')));
  assert(fs.existsSync(reference));
});
test('sample QA stops at an explicit decision instead of automatically redrawing',async()=>{
  const marker=path.join(temp,'failed-sample-once');process.env.WENDI_TEST_FAIL_SAMPLE_ONCE=marker;
  let automatic=E.createProject(brief);E.planProject(automatic);automatic=await done(automatic.id);E.approvePlan(automatic,W.digest(automatic.plan));automatic=await done(automatic.id);
  delete process.env.WENDI_TEST_FAIL_SAMPLE_ONCE;
  assert.equal(automatic.status,'samples_decision');
  assert(fs.existsSync(marker));
  assert.equal(automatic.samples[0].key,'样张-1');
  assert.equal(automatic.sampleRepairCounts[0],0);
});
test('a network interruption remains recoverable instead of becoming definite no-output',async()=>{
  const marker=path.join(temp,'no-image-once');process.env.WENDI_TEST_NO_IMAGE_ONCE=marker;
  let failed=E.createProject(brief);E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  delete process.env.WENDI_TEST_NO_IMAGE_ONCE;
  assert.equal(failed.status,'attention');assert.equal(failed.lastFailure,null);assert.equal(failed.pending.key,'样张-1');
  assert.match(failed.message,/检查已有原图|保存结果前中断/);assert.equal(failed.currentTask.status,'unknown_result');assert.equal(failed.currentTask.providerInvocations,1);
});
test('a usage limit before accepted keeps the same queued request resumable',async()=>{
  const previousPlan=process.env.WENDI_TEST_PLAN_FILE,previousResponse=process.env.WENDI_TEST_RATE_LIMIT_RESPONSE,previousNoImage=process.env.WENDI_TEST_NO_IMAGE_ONCE,previousNoImageText=process.env.WENDI_TEST_NO_IMAGE_TEXT,previousUsage=process.env.WENDI_TEST_USAGE_LIMIT_ONCE;
  const noImage=path.join(temp,'usage-limit-no-image'),usage=path.join(temp,'usage-limit-execution');
  try{
    delete process.env.WENDI_TEST_PLAN_FILE;delete process.env.WENDI_TEST_RATE_LIMIT_FAIL;process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=JSON.stringify({rateLimits:{primary:{usedPercent:20,windowDurationMins:300,resetsAt:123},secondary:{usedPercent:1,windowDurationMins:10080,resetsAt:456}},rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:123},secondary:{usedPercent:1,windowDurationMins:10080,resetsAt:456}},base_model_inference:{limitId:'base_model_inference',normalModelSlug:'gpt-5.6-luna',primary:{usedPercent:65,windowDurationMins:10080,resetsAt:789}}}});
    process.env.WENDI_TEST_NO_IMAGE_ONCE=noImage;process.env.WENDI_TEST_NO_IMAGE_TEXT="You've hit your usage limit before image submission.";process.env.WENDI_TEST_USAGE_LIMIT_ONCE=usage;
    let limited=E.createProject({...brief,idea:'接受前额度限制续接测试',model:'gpt-5.6-luna'});limited.plan=structuredClone(plan);limited.version=1;limited.approved={version:1,hash:W.digest(limited.plan)};limited.samplesApproved=true;limited.status='ready';E.saveProject(limited);E.generatePages(limited);limited=await done(limited.id);
    const pending=limited.pending,dir=pending?.dir,manifest=pending&&JSON.parse(fs.readFileSync(path.join(dir,'web-generation.json'),'utf8')),worker=JSON.parse(fs.readFileSync(path.join(dir,'worker-request.json'),'utf8')),request=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'));
    assert.equal(limited.status,'paused');assert.equal(limited.currentTask.status,'paused');assert.notEqual(limited.currentTask.status,'unknown_result');assert.equal(limited.currentTask.errorCode,'USAGE_LIMIT_BEFORE_START');assert.equal(limited.currentTask.providerInvocations,0);assert.equal(limited.currentTask.projectId,limited.id);assert.equal(limited.currentTask.projectVersion,1);assert.equal(pending.taskId,limited.currentTask.id);assert.equal(pending.projectId,limited.id);assert.equal(pending.projectVersion,1);assert.equal(pending.requestId,worker.requestId);assert.equal(worker.requestId,manifest.requestId);assert.equal(request.taskId,pending.taskId);assert.equal(request.projectId,limited.id);assert.equal(request.projectVersion,1);assert.equal(manifest.state,'queued');assert.equal(manifest.accepted,false);assert.equal(manifest.submitted,false);assert.equal(manifest.referenceCount,0);assert.match(limited.message,/不会创建第二个图片请求/);
    const originalRequestId=manifest.requestId,originalTaskId=limited.currentTask.id,imageTaskCount=limited.tasks.filter(task=>task.kind==='image').length,runDir=limited.pending.dir;
    E.resume(limited);limited=await done(limited.id);
    const resumed=JSON.parse(fs.readFileSync(path.join(runDir,'web-generation.json'),'utf8'));
    assert.equal(limited.pending,null);assert.equal(limited.currentTask.id,originalTaskId);assert.equal(limited.tasks.filter(task=>task.kind==='image').length,imageTaskCount);assert.equal(resumed.requestId,originalRequestId);assert.equal(resumed.state,'downloaded');assert.equal(resumed.accepted,true);assert.equal(resumed.submitted,true);assert.equal(resumed.resumeCount,1);assert(limited.panels['1-1']);assert.equal(limited.currentTask.status,'completed');assert.equal(limited.currentTask.webState,'downloaded');assert.equal(fs.readdirSync(path.join(runDir,'attempts')).length,1);
  }finally{
    if(previousPlan===undefined)delete process.env.WENDI_TEST_PLAN_FILE;else process.env.WENDI_TEST_PLAN_FILE=previousPlan;
    if(previousResponse===undefined)delete process.env.WENDI_TEST_RATE_LIMIT_RESPONSE;else process.env.WENDI_TEST_RATE_LIMIT_RESPONSE=previousResponse;
    if(previousNoImage===undefined)delete process.env.WENDI_TEST_NO_IMAGE_ONCE;else process.env.WENDI_TEST_NO_IMAGE_ONCE=previousNoImage;
    if(previousNoImageText===undefined)delete process.env.WENDI_TEST_NO_IMAGE_TEXT;else process.env.WENDI_TEST_NO_IMAGE_TEXT=previousNoImageText;
    if(previousUsage===undefined)delete process.env.WENDI_TEST_USAGE_LIMIT_ONCE;else process.env.WENDI_TEST_USAGE_LIMIT_ONCE=previousUsage;
  }
});
test('only non-connection no-image evidence becomes retryable',async()=>{
  const text='本次请求未产出任何图片。',marker=path.join(temp,'pure-no-output');process.env.WENDI_TEST_NO_IMAGE_ONCE=marker;process.env.WENDI_TEST_NO_IMAGE_TEXT=text;
  let failed=E.createProject(brief);E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  assert.equal(failed.status,'attention');assert.equal(failed.pending,null);assert.equal(failed.lastFailure.kind,'no-output');assert.equal(failed.currentTask.status,'failed_no_output');
  delete process.env.WENDI_TEST_NO_IMAGE_ONCE;delete process.env.WENDI_TEST_NO_IMAGE_TEXT;
});
test('an unavailable hidden IAB stops before any provider submission',async()=>{
  const marker=path.join(temp,'iab-unavailable');process.env.WENDI_TEST_NO_IMAGE_ONCE=marker;process.env.WENDI_TEST_NO_IMAGE_TEXT='Browser is not available: iab';
  let failed=E.createProject({...brief,idea:'隐藏网页不可用测试'});E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  assert.equal(failed.pending,null);assert.equal(failed.lastFailure.kind,'browser-unavailable');assert.equal(failed.lastFailure.attempts,0);
  assert.equal(failed.currentTask.providerInvocations,0);assert.equal(failed.currentTask.status,'failed_no_output');assert.match(failed.message,/未提交图片请求/);
  delete process.env.WENDI_TEST_NO_IMAGE_ONCE;delete process.env.WENDI_TEST_NO_IMAGE_TEXT;
  E.retryMissingImage(failed,'样张-1');failed=await done(failed.id);assert.equal(failed.currentTask.attempt,1);assert.equal(failed.progress.current,1);assert.equal(failed.progress.total,2);
});
test('an unavailable Chrome focus capability stops before any provider submission',async()=>{
  const marker=path.join(temp,'chrome-focus-unavailable');process.env.WENDI_TEST_NO_IMAGE_ONCE=marker;process.env.WENDI_TEST_NO_IMAGE_TEXT='BROWSER_FOCUS_UNAVAILABLE: Chrome management capability is not advertised';
  let failed=E.createProject({...brief,idea:'Chrome 焦点能力不可用测试'});E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  assert.equal(failed.pending,null);assert.equal(failed.lastFailure.kind,'browser-unavailable');assert.equal(failed.lastFailure.attempts,0);assert.equal(failed.currentTask.providerInvocations,0);assert.equal(failed.currentTask.status,'failed_no_output');assert.match(failed.message,/公开 Chrome 焦点恢复能力|未提交图片请求/);
  delete process.env.WENDI_TEST_NO_IMAGE_ONCE;delete process.env.WENDI_TEST_NO_IMAGE_TEXT;
});
test('origin permission denial is a confirmed pre-submission failure with a safe retry boundary',async()=>{
  const marker=path.join(temp,'chrome-origin-permission-denied');process.env.WENDI_TEST_NO_IMAGE_ONCE=marker;process.env.WENDI_TEST_NO_IMAGE_TEXT='The user declined permission for this action. Browser use cannot access https://chatgpt.com because the user denied permission for this request.';
  let failed=E.createProject({...brief,idea:'Chrome 站点访问权限拒绝测试'});E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  assert.equal(failed.pending,null);assert.equal(failed.lastFailure.kind,'browser-origin-permission-denied');assert.equal(failed.lastFailure.attempts,0);assert.equal(failed.currentTask.providerInvocations,0);assert.equal(failed.currentTask.status,'failed_no_output');assert.match(failed.message,/Chrome 已连接，但 chatgpt\.com 访问权限被拒绝/);assert.match(failed.message,/选择“允许”/);assert.equal(E.imageRetryState(failed).certainty,'confirmed_missing');
  delete process.env.WENDI_TEST_NO_IMAGE_ONCE;delete process.env.WENDI_TEST_NO_IMAGE_TEXT;
});
test('file chooser failure is a distinct confirmed pre-submission kind',async()=>{
  const marker=path.join(temp,'chrome-upload-unavailable');process.env.WENDI_TEST_NO_IMAGE_ONCE=marker;process.env.WENDI_TEST_NO_IMAGE_TEXT='FILE_UPLOAD_CHROME_UNAVAILABLE: attachment control did not open a browser file chooser; user declined permission text is only prompt noise';
  let failed=E.createProject({...brief,idea:'Chrome 附件选择器不可用测试'});E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  assert.equal(failed.pending,null);assert.equal(failed.lastFailure.kind,'browser-upload-unavailable');assert.equal(failed.lastFailure.attempts,0);assert.equal(failed.currentTask.providerInvocations,0);assert.equal(failed.currentTask.status,'failed_no_output');assert.match(failed.message,/附件入口未能打开浏览器文件选择器/);assert.match(failed.message,/未上传附件或发送消息/);assert.equal(E.imageRetryState(failed).certainty,'confirmed_missing');
  delete process.env.WENDI_TEST_NO_IMAGE_ONCE;delete process.env.WENDI_TEST_NO_IMAGE_TEXT;
});
test('restart migrates only an identity-matched legacy browser permission failure',()=>{
  const make=(idea,match)=>{
    const project=E.createProject({...brief,idea}),task={id:crypto.randomUUID(),kind:'image',target:'样张-1',projectId:project.id,projectVersion:project.version,status:'failed_no_output',errorCode:'browser-unavailable',providerInvocations:0,startedAt:new Date().toISOString(),completedAt:new Date().toISOString()};
    const dir=path.join(E.projectDir(project.id),'.制作记录','legacy-origin-permission'),requestId=crypto.randomUUID(),runId=path.basename(dir),outputFile=path.join(E.projectDir(project.id),'v0','素材','样张-1.png');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,taskId:task.id,projectId:project.id,projectVersion:project.version,target:task.target,expectedOutput:path.relative(E.projectDir(project.id),outputFile)}));
    fs.writeFileSync(path.join(dir,'worker-request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,requestId,runId,projectId:project.id,projectVersion:project.version,taskId:task.id,target:task.target,outputFile,manifestFile:path.join(dir,'web-generation.json')}));
    fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({schemaVersion:1,runId,state:'completed'}));
    fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,state:'failed',accepted:true,requestId,runId,projectId:project.id,projectVersion:project.version,taskId:task.id,target:task.target,submitted:false,referenceCount:0,errorCode:match?'BROWSER_ORIGIN_PERMISSION_DENIED':'BROWSER_CHROME_UNAVAILABLE',error:match?'Chrome 已连接，但 chatgpt.com 访问权限被拒绝':'Chrome extension unavailable'}));
    const browserResult=match?{type:'item.completed',item:{type:'mcp_tool_call',server:'cua_repl',tool:'js',result:{content:[{type:'text',text:'The user declined permission for this action. Browser use cannot access https://chatgpt.com because the user denied permission for this request.'}]}}}:{type:'item.completed',item:{type:'mcp_tool_call',server:'cua_repl',tool:'js',result:{content:[{type:'text',text:'BROWSER_CHROME_UNAVAILABLE'}]}}};fs.writeFileSync(path.join(dir,'events.jsonl'),JSON.stringify(browserResult)+'\n');
    project.tasks=[task];project.currentTask=task;project.lastFailure={kind:'browser-unavailable',definiteNoOutput:true,key:task.target,attempts:0,taskId:task.id,at:task.completedAt};project.status='attention';E.saveProject(project);return project;
  };
  let migrated=make('重启迁移站点权限拒绝',true),untouched=make('重启不误迁移扩展失败',false);const beforeCalls=callCount();E.recover();migrated=E.readProject(migrated.id);untouched=E.readProject(untouched.id);
  assert.ok(!migrated.pending);assert.equal(migrated.currentTask.errorCode,'browser-origin-permission-denied');assert.equal(migrated.tasks[0].errorCode,'browser-origin-permission-denied');assert.equal(migrated.lastFailure.kind,'browser-origin-permission-denied');assert.equal(migrated.lastFailure.attempts,0);assert.match(migrated.message,/Chrome 已连接，但 chatgpt\.com 访问权限被拒绝/);assert.equal(untouched.currentTask.errorCode,'browser-unavailable');assert.equal(untouched.lastFailure.kind,'browser-unavailable');assert.equal(callCount(),beforeCalls);
});
test('manual retry keeps the direct Chrome path when focus restoration is unavailable',async()=>{
  let project=E.createProject({...brief,idea:'手动重试允许已知焦点边界'});project.plan=structuredClone(plan);project.version=1;project.approved={version:1,hash:W.digest(project.plan)};project.samplesApproved=true;project.status='attention';project.currentTask={id:'focus-retry-task',kind:'image',target:'第1页-第1格',status:'failed_no_output',errorCode:'browser-unavailable',providerInvocations:0};project.lastFailure={kind:'browser-unavailable',definiteNoOutput:true,key:'第1页-第1格',attempts:0,taskId:'focus-retry-task',at:new Date().toISOString()};E.saveProject(project);
  E.retryMissingImage(project,'第1页-第1格');project=await done(project.id);
  assert.ok(!project.pending);assert.equal(project.currentTask.providerInvocations,1);assert.ok(project.panels['1-1']);assert.match(G.webWorkerStatus().message,/站点访问权限将在任务中验证/);
});
test('a durable pre-submission web failure is safely retryable after restart',()=>{
  let failed=E.createProject({...brief,idea:'网页提交前失败恢复测试'});const dir=path.join(E.projectDir(failed.id),'.制作记录','pre-submit');
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,state:'failed',submitted:false,errorCode:'IAB_SESSION_LOST_BEFORE_SUBMIT',error:'IAB unavailable'}));
  failed.pending={key:'第1页-第1格',file:path.join(E.projectDir(failed.id),'missing.png'),dir,provider:G.WEB_IMAGE_PROVIDER,taskId:'pre-submit-task',at:new Date().toISOString()};
  const requestId=crypto.randomUUID();failed.pending.projectId=failed.id;failed.pending.projectVersion=failed.version;
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,taskId:failed.pending.taskId,projectId:failed.id,projectVersion:failed.version,target:failed.pending.key}));
  fs.writeFileSync(path.join(dir,'worker-request.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,requestId}));
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'web-generation.json'),'utf8'));manifest.requestId=requestId;fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify(manifest));
  failed.tasks=[{id:'pre-submit-task',kind:'image',target:'第1页-第1格',status:'unknown_result',providerInvocations:0}];failed.currentTask=failed.tasks[0];failed.status='attention';E.saveProject(failed);
  E.recover();failed=E.readProject(failed.id);
  assert.equal(failed.pending,null);assert.equal(failed.lastFailure.kind,'browser-unavailable');assert.equal(failed.lastFailure.attempts,0);
  assert.equal(failed.currentTask.status,'failed_no_output');assert.equal(failed.currentTask.providerInvocations,0);assert.equal(E.imageRetryState(failed).certainty,'confirmed_missing');
});
test('legacy network failures migrate to unknown results instead of confirmed no-output',()=>{
  let legacy=E.createProject({...brief,idea:'旧网络失败迁移测试'});legacy.status='attention';legacy.currentTask={id:'legacy-network',kind:'image',target:'第1页-第1格',status:'failed_no_output',errorCode:'network',providerInvocations:1,completedAt:new Date().toISOString()};E.saveProject(legacy);
  E.recover();legacy=E.readProject(legacy.id);
  assert.equal(legacy.currentTask.status,'unknown_result');assert.equal(legacy.lastFailure,null);assert.equal(E.retryableImageFailure(legacy),null);assert.equal(E.imageRetryState(legacy).certainty,'unknown_result');
});
test('legacy usage records with null or non-object request metadata remain readable during startup recovery',()=>{
  const legacy=E.createProject({...brief,idea:'缺少执行元数据的旧记录读取测试'}),records=path.join(E.projectDir(legacy.id),'.制作记录');
  for(const [suffix,metadata] of [['null',null],['scalar',42]]){
    const dir=path.join(records,`178000000000${suffix==='null'?'0':'1'}-legacy-${suffix}`);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'events.jsonl'),JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}})+'\n');
    fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify(metadata));
  }
  legacy.metrics={inputTokens:2,cachedInputTokens:0,outputTokens:4,reasoningOutputTokens:0,totalRuns:2};E.saveProject(legacy);
  assert.doesNotThrow(()=>E.recover());
  const restored=E.readProject(legacy.id),creative=restored.metrics.byRole.find(item=>item.role==='creative');assert(creative);assert.equal(creative.runs,2);
});
test('a legacy network lastFailure also remains an unknown result',()=>{
  let legacy=E.createProject({...brief,idea:'旧网络记录迁移测试'});legacy.status='paused';legacy.message='旧额度提示';legacy.lastFailure={kind:'network',definiteNoOutput:true,key:'第1页-第1格',attempts:1,at:new Date().toISOString()};legacy.currentTask={id:'legacy-network-record',kind:'image',target:'第1页-第1格',status:'failed_no_output',errorCode:'network',providerInvocations:1,completedAt:new Date().toISOString()};E.saveProject(legacy);
  E.recover();legacy=E.readProject(legacy.id);
  assert.equal(legacy.status,'attention');assert.match(legacy.message,/无法证明/);assert.equal(legacy.currentTask.status,'unknown_result');assert.equal(E.retryableImageFailure(legacy),null);assert.equal(E.imageRetryState(legacy).certainty,'unknown_result');
  legacy.status='paused';legacy.message='第二次启动前残留提示';E.saveProject(legacy);E.recover();legacy=E.readProject(legacy.id);assert.equal(legacy.status,'attention');assert.match(legacy.message,/无法证明/);
});
test('an explicitly approved unknown pending image is archived before one retry',async()=>{
  let unknown=E.createProject({...brief,idea:'保留未知旧请求后只重试一张'});unknown.plan=structuredClone(plan);unknown.version=1;unknown.approved={version:1,hash:W.digest(unknown.plan)};unknown.samplesApproved=true;unknown.status='attention';
  const oldFile=path.join(E.projectDir(unknown.id),'v1','素材','旧请求.png'),oldDir=path.join(E.projectDir(unknown.id),'.制作记录','旧请求');
  unknown.pending={key:'第1页-第1格',file:oldFile,dir:oldDir,prompt:'旧请求',refs:[],inputFiles:[],taskId:'unknown-pending',at:new Date().toISOString()};unknown.currentTask={id:'unknown-pending',kind:'image',target:'第1页-第1格',status:'unknown_result',errorCode:'network',providerInvocations:1,completedAt:new Date().toISOString()};E.saveProject(unknown);
  assert.equal(E.imageRetryState(unknown).certainty,'unknown_result');E.retryMissingImage(unknown,'第1页-第1格',{allowUnknownResult:true});unknown=await done(unknown.id);
  assert.equal(unknown.pending,null);assert.equal(unknown.supersededPending.length,1);assert.equal(unknown.supersededPending[0].file,oldFile);assert(unknown.panels['1-1']);assert.equal(unknown.status,'paused');
});
test('retrying a failed panel stops after that one panel',async()=>{
  let single=E.createProject({...brief,idea:'只重试一个分镜的流程'});const duo=structuredClone(plan);duo.pages[0].layout='duo';duo.pages[0].panels=[structuredClone(panel),structuredClone(panel)];single.plan=duo;single.version=1;single.approved={version:1,hash:W.digest(duo)};single.samplesApproved=true;single.status='attention';single.lastFailure={kind:'no-output',definiteNoOutput:true,key:'第1页-第1格',attempts:1,at:new Date().toISOString()};E.saveProject(single);
  E.retryMissingImage(single,'第1页-第1格');single=await done(single.id);
  assert.deepEqual(Object.keys(single.panels),['1-1']);assert.equal(single.pages.length,0);assert.equal(single.status,'paused');assert.equal(single.tasks.filter(task=>task.kind==='image').length,1);assert.equal(single.panels['1-1'].qa.pass,true);assert.equal(single.panels['1-1'].qa.status,'qa_pass');assert.match(single.message,/不会继续生成其他分镜/);
});
test('deferred file checks are not visual QA passes',()=>{
  const fixture=panelDecisionFixture('区分延迟文件检查与真实质检');fixture.project.panels['1-1'].qa={pass:true,status:'deferred',summary:'仅文件检查',issues:[],repairPrompt:''};E.saveProject(fixture.project);
  const restored=E.readProject(fixture.project.id);assert.equal(restored.panels['1-1'].qa.pass,null);assert.equal(restored.panels['1-1'].qa.status,'deferred');assert.equal(restored.panels['1-1'].qa.summary,'仅文件检查');
});
test('manual panel rejection is local, identity-checked, and idempotent',()=>{
  const fixture=panelDecisionFixture('人工打回不触发生图');const project=fixture.project,artifactId=fixture.artifactId,oldPage={number:1,file:fixture.relative,qa:{pass:true,status:'qa_pass',issues:[],issueDetails:[],repairPrompt:''},at:fixture.at,dependsOn:[artifactId]};project.panels['1-1'].qa={pass:true,status:'deferred',summary:'仅文件检查',issues:[],repairPrompt:''};project.pages=[oldPage];project.artifacts.push({id:'page:1',kind:'page',file:fixture.relative,dependsOn:[artifactId],valid:true,at:fixture.at},{id:'story:audit',kind:'story-audit',file:null,dependsOn:['page:1'],valid:true,at:fixture.at},{id:'export:bundle',kind:'export',file:'v1/温蒂漫画成品.zip',dependsOn:['story:audit'],valid:true,at:fixture.at});project.status='paused';E.saveProject(project);
  const expectedRevision=project.revision,issue='意式机萃取头、手柄与出液口/液流位置关系不正确',repairPrompt='只修正萃取头、portafilter 手柄卡口、双出液嘴与液流起点的功能连接，其他内容保持不变。',body={panelKey:'1-1',expectedRevision,artifactId,contentHash:W.digest({artifactId,file:fixture.relative,at:fixture.at}),issue,repairPrompt,idempotencyKey:`manual:${project.id}:1-1`},beforeBytes=fs.readFileSync(fixture.file),beforeCalls=callCount();
  E.rejectPanel(project,body);assert.equal(project.panels['1-1'].qa.pass,false);assert.equal(project.panels['1-1'].qa.status,'needs_review');assert.deepEqual(project.panels['1-1'].qa.issues,[issue]);assert.equal(project.panels['1-1'].qa.repairPrompt,repairPrompt);assert.equal(project.panelDecision.state,'required');assert.equal(project.panelDecision.panelKey,'1-1');assert.equal(project.manualPanelReview.userIssue,issue);assert.equal(project.pages.length,0);assert.equal(project.artifacts.find(item=>item.id==='page:1').valid,false);assert.equal(project.artifacts.find(item=>item.id==='story:audit').valid,false);assert.equal(project.artifacts.find(item=>item.id==='export:bundle').valid,false);assert.deepEqual(fs.readFileSync(fixture.file),beforeBytes);assert.equal(callCount(),beforeCalls);
  const revisionAfter=project.revision,commandCount=project.panelReviewCommands.length;E.rejectPanel(project,body);assert.equal(project.revision,revisionAfter);assert.equal(project.panelReviewCommands.length,commandCount);assert.equal(project.panels['1-1'].qa.pass,false);
  assert.throws(()=>E.rejectPanel(project,{...body,idempotencyKey:`manual:${project.id}:stale`,expectedRevision:expectedRevision}),/作品已更新|当前版本/);
});
test('QA prompt calls out impossible espresso connections without flagging style differences',async()=>{
  const coffeePlan=structuredClone(plan);coffeePlan.pages[0].panels[0].references=['08-咖啡与器具参考/05-萃取出液.png'];coffeePlan.pages[0].panels[0].objects='意式咖啡机、portafilter 手柄、双出液嘴与咖啡液流';
  const coffee=E.createProject({...brief,idea:'意式器具功能连接质检提示测试'});coffee.plan=coffeePlan;coffee.version=1;coffee.approved={version:1,hash:W.digest(coffeePlan)};coffee.samplesApproved=true;coffee.status='paused';const file=path.join(E.projectDir(coffee.id),'v1','素材','coffee-qa.png'),relative=path.relative(E.projectDir(coffee.id),file),at=new Date().toISOString();fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(W.inside(W.REFS,W.FACE[0]),file);const integrity={sha256:sha256File(file),sizeBytes:fs.statSync(file).size};coffee.panels={'1-1':{key:'第1页第1格',file:relative,prompt:'意式咖啡机正在萃取，portafilter 手柄连接萃取头，双出液嘴流出咖啡',refs:coffeePlan.pages[0].panels[0].references,integrity,qa:{pass:null,status:'unavailable',issues:[],issueDetails:[],repairPrompt:''},at}};coffee.artifacts=[{id:'image:第1页-第1格',kind:'image',file:relative,dependsOn:[],valid:true,at,integrity}];E.saveProject(coffee);E.reviewImage(coffee,'1-1');await done(coffee.id);
  const reviewDir=fs.readdirSync(path.join(E.projectDir(coffee.id),'.制作记录')).map(name=>path.join(E.projectDir(coffee.id),'.制作记录',name)).find(dir=>dir.includes('画面校对'));assert(reviewDir);const promptText=fs.readFileSync(path.join(reviewDir,'prompt.txt'),'utf8');assert.match(promptText,/萃取头/);assert.match(promptText,/portafilter/);assert.match(promptText,/出液嘴/);assert.match(promptText,/液流.*起点/);assert.match(promptText,/severity=blocking/);assert.match(promptText,/repairAction.*regenerate/);assert.match(promptText,/风格差异/);
});
test('sample resume never redraws a failed sample without an explicit decision',async()=>{
  let continued=E.createProject(brief);E.planProject(continued);continued=await done(continued.id);E.approvePlan(continued,W.digest(continued.plan));continued=await done(continued.id);
  continued.samples[0].key='样张-1-自动修订1';continued.samples[0].qa={pass:false,summary:'TEST MATERIAL ISSUE',issues:['前臂与提带关系不自然'],repairPrompt:'修正前臂与提带关系'};continued.sampleRepairCounts=[1,0];continued.status='attention';E.saveProject(continued);
  const before=callCount();E.resume(continued);continued=await done(continued.id);
  assert.equal(continued.status,'samples_decision');assert.equal(continued.samples[0].key,'样张-1-自动修订1');assert.equal(callCount(),before);
});
test('sample-only 2:3 ratio issue is accepted without another image request',async()=>{
  let ratio=E.createProject(brief);E.planProject(ratio);ratio=await done(ratio.id);E.approvePlan(ratio,W.digest(ratio.plan));ratio=await done(ratio.id);
  ratio.samples[0].qa={pass:false,summary:'TEST RATIO ONLY',issues:['画面为约2:3竖幅，不是单幅3:4竖图。'],repairPrompt:'改为3:4'};ratio.status='attention';E.saveProject(ratio);
  const before=fs.readFileSync(process.env.WENDI_TEST_CALLS,'utf8');E.resume(ratio);ratio=await done(ratio.id);
  assert.equal(ratio.status,'samples_review');assert.equal(ratio.samples[0].qa.pass,true);assert.equal(fs.readFileSync(process.env.WENDI_TEST_CALLS,'utf8'),before);
});
test('resume never accepts a blocked sample or starts formal production without an explicit decision',async()=>{
  let blocked=E.createProject(brief);E.planProject(blocked);blocked=await done(blocked.id);E.approvePlan(blocked,W.digest(blocked.plan));blocked=await done(blocked.id);
  blocked.samples[0].qa={pass:false,summary:'需要人工决定',issues:['手部需要调整'],issueDetails:[{category:'anatomy',severity:'review',repairAction:'regenerate',description:'手部需要调整'}]};blocked.sampleRepairCounts=[2,0];blocked.status='attention';E.saveProject(blocked);
  const before=callCount();E.resume(blocked);blocked=await done(blocked.id);
  assert.equal(blocked.status,'samples_decision');assert.equal(blocked.samplesApproved,false);assert.equal(blocked.pages.length,0);assert.equal(callCount(),before);assert.notEqual(blocked.sampleAcceptance?.mode,'manual_after_auto_limit');assert.throws(()=>E.generatePages(blocked),/确认/);
});
test('recovering an existing original is local and restores a viewable sample record',async()=>{
  let restored=E.createProject(brief);E.planProject(restored);restored=await done(restored.id);E.approvePlan(restored,W.digest(restored.plan));restored=await done(restored.id);
  const original=W.inside(E.projectDir(restored.id),restored.samples[0].file),file=path.join(E.projectDir(restored.id),'v1','素材','找回测试原图.png');fs.copyFileSync(original,file);
  restored.samples=[];restored.pending={key:'样张-1',file,dir:path.join(E.projectDir(restored.id),'.制作记录','已找到原图'),prompt:'脸部近景',refs:[],projectId:restored.id,projectVersion:restored.version,at:new Date().toISOString()};restored.status='attention';E.saveProject(restored);
  const before=callCount();E.recoverImage(restored);restored=await done(restored.id);
  assert.equal(callCount(),before);assert.equal(restored.pending,null);assert.equal(restored.samples[0].file,path.relative(E.projectDir(restored.id),file));assert(fs.existsSync(W.inside(E.projectDir(restored.id),restored.samples[0].file)));assert(restored.artifacts.some(x=>x.id==='image:样张-1'));
});
test('explicit web original recovery uses the full identity and integrity gate',async()=>{
  const project=E.createProject({...brief,idea:'网页原图显式找回身份核验'});project.plan=structuredClone(plan);project.version=1;project.approved={version:1,hash:W.digest(project.plan)};project.status='attention';
  const dir=path.join(E.projectDir(project.id),'.制作记录','完整网页原图找回'),file=path.join(E.projectDir(project.id),'v1','素材','完整网页找回.png'),relative=path.relative(E.projectDir(project.id),file),taskId='orphan-recovery-task',requestId=crypto.randomUUID(),runId=path.basename(dir),manifestFile=path.join(dir,'web-generation.json');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(W.inside(W.REFS,W.FACE[0]),file);
  const identity={projectId:project.id,projectVersion:1,taskId,target:'样张-1',requestId,runId,outputFile:file},write=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2)+'\n');
  write('request.json',{schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,identitySchemaVersion:2,identityLocked:true,...identity,expectedOutput:relative});write('worker-request.json',{schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,identitySchemaVersion:2,identityLocked:true,...identity,manifestFile});write('execution.json',{schemaVersion:1,runId,state:'completed'});write('run-identity.json',{schemaVersion:1,identitySchemaVersion:2,identityLocked:true,...identity});write('web-generation.json',{schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,identitySchemaVersion:2,identityLocked:true,...identity,state:'downloaded',accepted:true,submitted:true,artifactPath:file,referenceCount:0});
  project.pending={key:'样张-1',file,dir,provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,prompt:'脸部近景',refs:[],inputFiles:[],at:new Date().toISOString()};project.tasks=[{id:taskId,kind:'image',target:'样张-1',status:'artifact_saved',projectId:project.id,projectVersion:1,providerInvocations:1}];project.currentTask=project.tasks[0];E.saveProject(project);E.recoverImage(project);const recovered=await done(project.id);
  assert.equal(recovered.pending,null);assert.equal(recovered.samples[0].file,relative);assert.equal(recovered.samples[0].qa.status,'recovered_pending_review');assert.equal(recovered.currentTask.status,'recovered_local');
});
test('a historical not-accepted task cannot swallow a later unknown recovery failure',async()=>{
  const failed=E.createProject({...brief,idea:'历史未接单不能吞掉找回异常'});failed.plan=structuredClone(plan);failed.version=1;failed.approved={version:1,hash:W.digest(failed.plan)};failed.samplesApproved=true;failed.status='attention';
  const dir=path.join(E.projectDir(failed.id),'.制作记录','找回仍未知'),file=path.join(E.projectDir(failed.id),'v1','素材','仍未知.png'),taskId='historical-not-accepted';fs.mkdirSync(dir,{recursive:true});
  failed.pending={key:'样张-1',file,dir,prompt:'脸部近景',refs:[],inputFiles:[],taskId:taskId,projectId:failed.id,projectVersion:1,at:new Date().toISOString()};
  failed.currentTask={id:taskId,kind:'image',target:'样张-1',status:'not_accepted',errorCode:'WEB_WORKER_NOT_ACCEPTED',providerInvocations:0,completedAt:new Date().toISOString()};
  failed.message='正在等待前一项本地创作任务完成…';failed.error=failed.message;E.saveProject(failed);
  E.recoverImage(failed);const saved=await done(failed.id);
  assert.match(saved.message,/无法确认/);assert.match(saved.error,/无法确认/);assert.doesNotMatch(saved.message,/等待前一项/);
  const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));assert.equal(result.outcome,'artifact_still_unknown');assert.equal(saved.pending.key,'样张-1');
});
test('late accepted web failure preserves terminal identity during explicit recovery',async()=>{
  const project=E.createProject({...brief,idea:'迟到接单终态身份保留测试'});project.plan=structuredClone(plan);project.version=1;project.approved={version:1,hash:W.digest(project.plan)};project.samplesApproved=true;project.status='attention';
  const dir=path.join(E.projectDir(project.id),'.制作记录','迟到接单失败'),file=path.join(E.projectDir(project.id),'v1','素材','迟到失败.png'),taskId='late-terminal-task',requestId=crypto.randomUUID(),acceptedAt='2026-09-11T09:36:41+08:00';fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,target:'第1页-第1格'}));
  fs.writeFileSync(path.join(dir,'worker-request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,requestId,projectId:project.id,projectVersion:1}));
  fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,state:'failed',accepted:true,requestId,acceptedAt,submitted:false,errorCode:'IAB_UNAVAILABLE',error:'Codex IAB unavailable'}));
  project.pending={key:'第1页-第1格',file,dir,prompt:'待恢复的分镜',refs:[],inputFiles:[],provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,at:new Date().toISOString()};
  project.currentTask={id:taskId,kind:'image',target:'第1页-第1格',status:'not_accepted',errorCode:'WEB_WORKER_NOT_ACCEPTED',webState:'queued',providerInvocations:0};project.tasks=[project.currentTask];E.saveProject(project);
  E.recoverImage(project);const saved=await done(project.id),result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
  assert.equal(result.outcome,'artifact_still_unknown');assert.equal(result.requestId,requestId);assert.equal(result.acceptanceState,'failed');assert.equal(result.accepted,true);assert.equal(result.acceptedAt,acceptedAt);assert.equal(result.submitted,false);assert.equal(result.projectId,project.id);assert.equal(result.projectVersion,1);
  assert.equal(saved.pending,null);assert.equal(saved.lastFailure.kind,'browser-unavailable');assert.equal(saved.currentTask.status,'failed_no_output');assert.equal(saved.currentTask.webState,'failed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'web-generation.json'),'utf8')).requestId,requestId);
});
test('a pre-submission web failure never adopts an unrelated image path from run output',async()=>{
  const project=E.createProject({...brief,idea:'提交前失败不得串用历史图片'});project.plan=structuredClone(plan);project.version=1;project.approved={version:1,hash:W.digest(project.plan)};project.samplesApproved=true;project.status='attention';
  const dir=path.join(E.projectDir(project.id),'.制作记录','提交前串图防护'),target=path.join(E.projectDir(project.id),'v1','素材','第1页-第1格.png'),oldFile=path.join(E.projectDir(project.id),'v1','素材','历史旧图.png'),taskId='pre-submit-path-leak',requestId=crypto.randomUUID();fs.mkdirSync(path.dirname(target),{recursive:true});fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(W.inside(W.REFS,W.FACE[0]),oldFile);const oldHash=sha256File(oldFile);
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,target:'第1页-第1格',expectedOutput:path.relative(E.projectDir(project.id),target)}));
  fs.writeFileSync(path.join(dir,'worker-request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,requestId,projectId:project.id,projectVersion:1}));
  fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,state:'failed',accepted:true,requestId,submitted:false,errorCode:'BROWSER_BACKGROUND_UNAVAILABLE',error:'hidden Chrome unavailable'}));
  fs.writeFileSync(path.join(dir,'response.txt'),`历史记录里曾出现 \`${oldFile}\`。本次没有上传、提交或下载图片。`);
  project.pending={key:'第1页-第1格',file:target,dir,prompt:'新分镜',refs:[],inputFiles:[],provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,at:new Date().toISOString()};project.currentTask={id:taskId,kind:'image',target:'第1页-第1格',status:'unknown_result',providerInvocations:0};project.tasks=[project.currentTask];E.saveProject(project);
  E.recoverImage(project);const saved=await done(project.id);
  assert.equal(saved.pending,null);assert.equal(saved.lastFailure.kind,'browser-unavailable');assert.equal(saved.currentTask.status,'failed_no_output');assert.equal(saved.panels['1-1'],undefined);assert.equal(fs.existsSync(target),false);assert.equal(sha256File(oldFile),oldHash);
});
test('restart quarantines a web image that was attached despite pre-submission failure',()=>{
  let project=E.createProject({...brief,idea:'重启清理提交前误挂图片'});project.plan=structuredClone(plan);project.version=1;project.approved={version:1,hash:W.digest(project.plan)};project.samplesApproved=true;project.status='attention';
  const dir=path.join(E.projectDir(project.id),'.制作记录','已误挂的旧图'),file=path.join(E.projectDir(project.id),'v1','素材','第1页-第1格.png'),relative=path.relative(E.projectDir(project.id),file),taskId='attached-before-submit',requestId=crypto.randomUUID();fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(W.inside(W.REFS,W.FACE[0]),file);const originalHash=sha256File(file);
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,target:'第1页-第1格',expectedOutput:relative}));
  fs.writeFileSync(path.join(dir,'worker-request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,requestId,projectId:project.id,projectVersion:1}));
  fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,state:'failed',accepted:true,requestId,submitted:false,errorCode:'BROWSER_BACKGROUND_UNAVAILABLE',error:'hidden Chrome unavailable'}));
  const record={key:'第1页-第1格',file:relative,provider:G.WEB_IMAGE_PROVIDER,qa:{pass:true},at:new Date().toISOString()};project.panels={'1-1':record};project.artifacts=[{id:'image:第1页-第1格',kind:'image',file:relative,dependsOn:[],valid:true,at:record.at}];project.tasks=[{id:taskId,kind:'image',target:'第1页-第1格',status:'artifact_saved',providerInvocations:0,artifact:file}];project.currentTask=project.tasks[0];E.saveProject(project);
  E.recover();project=E.readProject(project.id);
  assert.equal(project.panels['1-1'],undefined);assert.equal(project.quarantinedImages.length,1);assert.equal(project.quarantinedImages[0].image.file,relative);assert.equal(project.artifacts[0].valid,false);assert.equal(project.currentTask.status,'failed_no_output');assert.equal(project.lastFailure.kind,'browser-unavailable');assert.equal(E.imageRetryState(project).certainty,'confirmed_missing');assert.equal(fs.existsSync(file),true);assert.equal(sha256File(file),originalHash);
});
test('mismatched web failure cannot clear pending during explicit recovery',async()=>{
  const project=E.createProject({...brief,idea:'迟到接单终态身份保留测试'});project.plan=structuredClone(plan);project.version=1;project.approved={version:1,hash:W.digest(project.plan)};project.samplesApproved=true;project.status='attention';
  const dir=path.join(E.projectDir(project.id),'.制作记录','迟到接单失败'),file=path.join(E.projectDir(project.id),'v1','素材','迟到失败.png'),taskId='late-terminal-task',requestId=crypto.randomUUID(),acceptedAt='2026-09-11T09:36:41+08:00';fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,target:'第1页-第1格'}));
  fs.writeFileSync(path.join(dir,'worker-request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,requestId,projectId:project.id,projectVersion:1}));
  fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,state:'failed',accepted:true,requestId,acceptedAt,submitted:false,errorCode:'IAB_UNAVAILABLE',error:'Codex IAB unavailable'}));
  project.pending={key:'第1页-第1格',file,dir,prompt:'待恢复的分镜',refs:[],inputFiles:[],provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,at:new Date().toISOString()};
  project.currentTask={id:taskId,kind:'image',target:'第1页-第1格',status:'not_accepted',errorCode:'WEB_WORKER_NOT_ACCEPTED',webState:'queued',providerInvocations:0};project.tasks=[project.currentTask];E.saveProject(project);
  fs.writeFileSync(path.join(dir,'worker-request.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,requestId:crypto.randomUUID()}));
  E.recoverImage(project);const saved=await done(project.id),result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
  assert(saved.pending);assert.notEqual(saved.currentTask.status,'failed_no_output');assert.equal(result.requestId,undefined);
});
test('an image artifact and its record survive a QA transport failure',async()=>{
  const marker=path.join(temp,'qa-transport-failure');process.env.WENDI_TEST_CRASH_QA_ONCE=marker;
  let failed=E.createProject(brief);E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  delete process.env.WENDI_TEST_CRASH_QA_ONCE;
  const image=failed.artifacts.find(x=>x.id==='image:样张-1');assert(image);assert(fs.existsSync(W.inside(E.projectDir(failed.id),image.file)));assert.equal(failed.samples[0].file,image.file);assert.notEqual(failed.samples[0].qa?.pass,true);
});
test('QA unavailable after saving an original is an explicit non-regenerating terminal state',async()=>{
  const marker=path.join(temp,'qa-terminal-state');process.env.WENDI_TEST_CRASH_QA_ONCE=marker;
  let failed=E.createProject({...brief,idea:'QA 不可用终态回归'});E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  delete process.env.WENDI_TEST_CRASH_QA_ONCE;
  const image=failed.artifacts.find(x=>x.id==='image:样张-1');assert(image);
  assert(fs.existsSync(W.inside(E.projectDir(failed.id),image.file)));
  assert.equal(failed.pending,null);
  assert.equal(failed.currentTask.status,'artifact_saved_unchecked');
  assert.equal(failed.status,'attention');
  assert.equal(failed.message,'原图已保存，自动校对未完成，请人工查看；不会自动重生');
  assert.equal(failed.error,failed.message);
  const qaRun=fs.readdirSync(path.join(E.projectDir(failed.id),'.制作记录')).map(name=>path.join(E.projectDir(failed.id),'.制作记录',name)).find(dir=>{try{return JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8')).outcome==='artifact_saved_unchecked';}catch{return false;}});
  assert(qaRun);assert.equal(JSON.parse(fs.readFileSync(path.join(qaRun,'result.json'),'utf8')).errorCode,'QA_UNAVAILABLE');
});
test('manual QA unavailable remains a review-required terminal state',async()=>{
  let reviewed=E.createProject({...brief,idea:'人工复核 QA 不可用终态回归'});E.planProject(reviewed);reviewed=await done(reviewed.id);E.approvePlan(reviewed,W.digest(reviewed.plan));reviewed=await done(reviewed.id);
  const marker=path.join(temp,'qa-review-terminal-state');process.env.WENDI_TEST_CRASH_QA_ONCE=marker;const beforeImageTasks=reviewed.tasks.filter(task=>task.kind==='image').length;E.reviewImage(reviewed,'sample-1');reviewed=await done(reviewed.id);delete process.env.WENDI_TEST_CRASH_QA_ONCE;
  assert.equal(reviewed.status,'attention');assert.equal(reviewed.pending,null);assert.equal(reviewed.currentTask.kind,'review');assert.equal(reviewed.currentTask.status,'review_required');assert.equal(reviewed.currentTask.errorCode,'QA_UNAVAILABLE');assert.equal(reviewed.samples[0].qa.status,'unavailable');assert.equal(reviewed.tasks.filter(task=>task.kind==='image').length,beforeImageTasks);assert.equal(reviewed.message,'原图已保存，自动校对未完成，请人工查看；不会自动重生');
});
test('pausing after image write still records the verified original',async()=>{
  const marker=path.join(temp,'pause-after-image');process.env.WENDI_TEST_PAUSE_AFTER_IMAGE=marker;
  let paused=E.createProject(brief);E.planProject(paused);paused=await done(paused.id);E.approvePlan(paused,W.digest(paused.plan));
  for(let i=0;i<100&&!fs.existsSync(marker);i++)await new Promise(resolve=>setTimeout(resolve,20));assert(fs.existsSync(marker));E.active.get(paused.id).abort();paused=await done(paused.id);delete process.env.WENDI_TEST_PAUSE_AFTER_IMAGE;
  assert.equal(paused.status,'paused');assert.equal(paused.pending,null);assert(paused.samples[0]);assert(fs.existsSync(W.inside(E.projectDir(paused.id),paused.samples[0].file)));assert.equal(paused.samples[0].qa.status,'unavailable');
});
test('rechecking a saved image adds only a review task and preserves the original',async()=>{
  let reviewed=E.createProject(brief);E.planProject(reviewed);reviewed=await done(reviewed.id);E.approvePlan(reviewed,W.digest(reviewed.plan));reviewed=await done(reviewed.id);
  const beforeFile=reviewed.samples[0].file,beforeImageTasks=reviewed.tasks.filter(task=>task.kind==='image').length;
  reviewed.samples[0].qa={pass:null,status:'unavailable',summary:'校对连接中断',issues:[],repairPrompt:''};reviewed.status='paused';E.saveProject(reviewed);
  E.reviewImage(reviewed,'sample-1');reviewed=await done(reviewed.id);
  assert.equal(reviewed.samples[0].file,beforeFile);assert.equal(reviewed.samples[0].qa.pass,true);assert.equal(reviewed.tasks.filter(task=>task.kind==='image').length,beforeImageTasks);assert.equal(reviewed.currentTask.kind,'review');
});
test('ambiguous thread candidates stay recoverable instead of being claimed as the newest image',async()=>{
  let ambiguous=E.createProject(brief);ambiguous.plan=structuredClone(plan);ambiguous.version=1;ambiguous.approved={version:1,hash:W.digest(ambiguous.plan)};
  const run=path.join(E.projectDir(ambiguous.id),'.制作记录','ambiguous');const thread='11111111-1111-4111-8111-111111111111',home=path.join(temp,'codex-home');process.env.CODEX_HOME=home;
  fs.mkdirSync(run,{recursive:true});fs.writeFileSync(path.join(run,'events.jsonl'),JSON.stringify({type:'thread.started',thread_id:thread})+'\n');
  const generated=path.join(home,'generated_images',thread);fs.mkdirSync(generated,{recursive:true});const source=path.join(W.REFS,W.FACE[0]);fs.copyFileSync(source,path.join(generated,'first.png'));fs.copyFileSync(source,path.join(generated,'second.png'));
  ambiguous.pending={key:'样张-1',file:path.join(E.projectDir(ambiguous.id),'v1','素材','missing.png'),dir:run,prompt:'脸部近景',refs:[],at:new Date().toISOString()};ambiguous.status='attention';E.saveProject(ambiguous);
  E.recoverImage(ambiguous);ambiguous=await done(ambiguous.id);
  assert.equal(ambiguous.status,'attention');assert.equal(ambiguous.pending.key,'样张-1');assert.equal(ambiguous.samples.length,0);
  delete process.env.CODEX_HOME;
});
test('a reported input reference path is never claimed as generated output',async()=>{
  let inputOnly=E.createProject(brief);inputOnly.plan=structuredClone(plan);inputOnly.version=1;inputOnly.approved={version:1,hash:W.digest(inputOnly.plan)};
  const run=path.join(E.projectDir(inputOnly.id),'.制作记录','input-only'),source=path.join(W.REFS,W.FACE[0]);fs.mkdirSync(run,{recursive:true});fs.writeFileSync(path.join(run,'response.txt'),`检查了参考图 ${source}`);
  inputOnly.pending={key:'样张-1',file:path.join(E.projectDir(inputOnly.id),'v1','素材','missing.png'),dir:run,prompt:'脸部近景',refs:[],inputFiles:[source],at:new Date().toISOString()};inputOnly.status='attention';E.saveProject(inputOnly);
  E.recoverImage(inputOnly);inputOnly=await done(inputOnly.id);assert.equal(inputOnly.pending.key,'样张-1');assert.equal(inputOnly.samples.length,0);
});
test('revisions invalidate approval but preserve history and accepted files',async()=>{
  const previous=p.pages[0].finalFile;
  E.planProject(p,'把最后一格文案改短一些。');p=await done(p.id);
  assert.equal(p.version,2);assert.equal(p.approved,null);assert.equal(p.samplesApproved,false);assert.equal(p.accepted,false);assert.equal(p.pages.length,0);
  assert.equal(p.history.length,1);assert(fs.existsSync(W.inside(E.projectDir(p.id),previous)));
  assert.equal(p.artifacts.length,0);
});
test('restart pauses jobs, and pending image never triggers a blind retry',()=>{
  p.status='generating';p.pending={key:'example',file:path.join(temp,'missing.png')};E.saveProject(p);const before=fs.readFileSync(process.env.WENDI_TEST_CALLS,'utf8');E.recover();p=E.readProject(p.id);
  assert.equal(p.status,'paused');assert.throws(()=>E.resume(p),/找回/);assert.equal(fs.readFileSync(process.env.WENDI_TEST_CALLS,'utf8'),before);
});
test('composition rejects bad aspect ratios and oversized copy',async()=>{
  const image=path.join(temp,'wide.png');execFileSync(B.python(),['-c','from PIL import Image; import sys; Image.new("RGB",(1800,500)).save(sys.argv[1])',image]);
  const spec=path.join(temp,'bad-layout.json');W.jsonWrite(spec,{page:plan.pages[0],total:1,images:[image],output:path.join(temp,'bad.png')});
  await assert.rejects(B.pythonRun(['compose',spec]),error=>{assert.match(error.message,/比例/);assert.doesNotMatch(error.message,/Traceback|ValueError/);return true;});
  const q=structuredClone(plan.pages[0]);q.panels[0].caption='太长的文案'.repeat(150);W.jsonWrite(spec,q);await assert.rejects(B.pythonRun(['geometry',spec]),/文案过长/);
});
test('web upload preparation shrinks large references without changing originals',async()=>{
  const source=W.inside(W.REFS,W.FACE[0]),before=sha256File(source),spec=path.join(temp,'prepare-web.json'),output=path.join(temp,'web-refs');W.jsonWrite(spec,{files:[source],outputDir:output});
  const result=JSON.parse(await B.pythonRun(['prepare-web',spec]));assert.equal(result.length,1);assert.equal(result[0].optimized,true);assert(fs.existsSync(result[0].file));assert(fs.statSync(result[0].file).size<fs.statSync(source).size);assert.equal(sha256File(source),before);
});
test('HTTP service serves built app and blocks foreign writes and unlisted files',async()=>{
  const port=44918;const child=spawn(process.execPath,[path.join(W.APP,'server/server.mjs')],{env:{...process.env,PORT:String(port),WENDI_TEST_RESTART_NOOP:'1'},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',c=>output+=c);
  try{
    let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
    assert(ready,output);const base=`http://127.0.0.1:${port}`;
    const health=await (await fetch(base+'/api/health')).json();assert.equal(typeof health.instanceId,'string');assert(health.instanceId.length>3);
    const boot=await (await fetch(base+'/api/bootstrap')).json();assert(boot.connection.ready);assert(boot.references.length>=20);
    assert.equal(boot.connection.imageWorker.transport,'direct-chrome');assert.equal(boot.connection.imageWorker.browser,'chrome');assert.equal(boot.connection.imageWorker.state,'available');assert.equal(boot.connection.imageWorker.focusRestoration,'unsupported');assert.equal(boot.connection.imageWorker.focusSafe,false);assert.match(boot.connection.imageWorker.message,/站点访问权限将在任务中验证/);
    const refreshed=await (await fetch(base+'/api/connection',{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:'{}'})).json();assert.equal(refreshed.imageWorker.state,'available');assert.equal(refreshed.imageWorker.transport,'direct-chrome');assert.equal(refreshed.imageWorker.browser,'chrome');
    const terminalProject=E.createProject({...brief,idea:'HTTP 迟到接单终态一致性测试'});terminalProject.plan=structuredClone(plan);terminalProject.version=2;terminalProject.approved={version:2,hash:W.digest(terminalProject.plan)};terminalProject.samplesApproved=true;terminalProject.status='attention';
    const terminalDir=path.join(E.projectDir(terminalProject.id),'.制作记录','迟到终态'),terminalFile=path.join(E.projectDir(terminalProject.id),'v2','素材','终态占位.png'),terminalTaskId='http-late-terminal-task',terminalRequestId=crypto.randomUUID(),terminalAcceptedAt='2026-09-11T09:36:41+08:00';fs.mkdirSync(terminalDir,{recursive:true});fs.mkdirSync(path.dirname(terminalFile),{recursive:true});fs.writeFileSync(terminalFile,'fixture placeholder');
    fs.writeFileSync(path.join(terminalDir,'request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,taskId:terminalTaskId,projectId:terminalProject.id,projectVersion:2,target:'第1页-第1格'}));fs.writeFileSync(path.join(terminalDir,'worker-request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,requestId:terminalRequestId,projectId:terminalProject.id,projectVersion:2}));fs.writeFileSync(path.join(terminalDir,'web-generation.json'),JSON.stringify({provider:G.WEB_IMAGE_PROVIDER,state:'failed',accepted:true,requestId:terminalRequestId,acceptedAt:terminalAcceptedAt,submitted:false,errorCode:'IAB_UNAVAILABLE',error:'Codex IAB unavailable'}));
    terminalProject.pending={key:'第1页-第1格',file:terminalFile,dir:terminalDir,prompt:'终态一致性',refs:[],inputFiles:[],provider:G.WEB_IMAGE_PROVIDER,taskId:terminalTaskId,projectId:terminalProject.id,projectVersion:2,at:new Date().toISOString()};terminalProject.currentTask={id:terminalTaskId,kind:'image',target:'第1页-第1格',status:'not_accepted',errorCode:'WEB_WORKER_NOT_ACCEPTED',webState:'queued',providerInvocations:0};E.saveProject(terminalProject);
    const terminalBody=await (await fetch(base+`/api/projects/${terminalProject.id}`)).json();assert.equal(terminalBody.pending.requestId,terminalRequestId);assert.equal(terminalBody.pending.accepted,true);assert.equal(terminalBody.pending.webState,'failed');assert.equal(terminalBody.pending.errorCode,'IAB_UNAVAILABLE');assert.equal(terminalBody.currentTask.status,'failed');assert.equal(terminalBody.currentTask.webState,'failed');assert.equal(terminalBody.currentTask.errorCode,'IAB_UNAVAILABLE');
    fs.writeFileSync(path.join(terminalDir,'worker-request.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,requestId:crypto.randomUUID(),projectId:terminalProject.id,projectVersion:2}));const mismatchedBody=await (await fetch(base+`/api/projects/${terminalProject.id}`)).json();assert.equal(mismatchedBody.pending.webState,null);assert.equal(mismatchedBody.currentTask.status,'not_accepted');assert.equal(mismatchedBody.currentTask.webState,'queued');
    const qaSaved=E.createProject({...brief,idea:'HTTP QA 已保存终态文案测试'});qaSaved.status='attention';qaSaved.message='原图已保存，自动校对未完成，请人工查看；不会自动重生';qaSaved.error=qaSaved.message;qaSaved.currentTask={id:'qa-saved-task',kind:'image',target:'样张-1',status:'artifact_saved_unchecked',errorCode:'QA_UNAVAILABLE',providerInvocations:1,webState:'downloaded'};E.saveProject(qaSaved);
    const qaSavedBody=await (await fetch(base+`/api/projects/${qaSaved.id}`)).json();assert.equal(qaSavedBody.pending,null);assert.equal(qaSavedBody.status,'attention');assert.equal(qaSavedBody.message,qaSaved.message);assert.equal(qaSavedBody.error,qaSaved.message);assert.equal(qaSavedBody.currentTask.status,'artifact_saved_unchecked');assert.equal(qaSavedBody.currentTask.errorCode,'QA_UNAVAILABLE');
    assert.equal((await fetch(base+'/')).status,200);
    const switched=await (await fetch(base+`/api/projects/${p.id}/settings`,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify({model:'fixture-model',reasoningEffort:'low'})})).json();assert.equal(switched.brief.model,'fixture-model');assert.equal(switched.modelHistory.at(-1).to.model,'fixture-model');
    const renamed=await (await fetch(base+`/api/projects/${p.id}/title`,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify({title:'已改名的流程测试'})})).json();assert.equal(renamed.title,'已改名的流程测试');
    const panelAPI=E.createProject({...brief,idea:'正式分镜决定 API 幂等测试'});panelAPI.plan=structuredClone(plan);panelAPI.version=1;panelAPI.approved={version:1,hash:W.digest(panelAPI.plan)};panelAPI.samplesApproved=true;panelAPI.status='attention';const panelFile=path.join(E.projectDir(panelAPI.id),'v1','素材','api-panel.png'),panelRel=path.relative(E.projectDir(panelAPI.id),panelFile),panelAt=new Date().toISOString();fs.mkdirSync(path.dirname(panelFile),{recursive:true});fs.copyFileSync(W.inside(W.REFS,W.FACE[0]),panelFile);const panelIntegrity={sha256:sha256File(panelFile),sizeBytes:fs.statSync(panelFile).size};panelAPI.panels={'1-1':{key:'1-1',file:panelRel,prompt:'看书，手脚完整',refs:[],integrity:panelIntegrity,qa:{pass:false,status:'needs_review',summary:'API 测试失败质检',issues:['手部需要调整'],issueDetails:[{id:'formal-hand',category:'anatomy',severity:'review',description:'手部需要调整',repairAction:'review'}],repairPrompt:'人工确认'},at:panelAt}};panelAPI.artifacts=[{id:'image:第1页-第1格',kind:'image',file:panelRel,dependsOn:[],valid:true,at:panelAt,integrity:panelIntegrity}];panelAPI.panelDecision={state:'required',panelKey:'1-1',artifactId:'image:第1页-第1格',projectVersion:1,at:panelAt};E.saveProject(panelAPI);const panelBody={panelKey:'1-1',expectedRevision:panelAPI.revision,planHash:panelAPI.approved.hash,artifactId:'image:第1页-第1格',contentHash:W.digest({artifactId:'image:第1页-第1格',file:panelRel,at:panelAt}),decision:'accept_current',acknowledgedIssueIds:['formal-hand'],continueProduction:true,idempotencyKey:`panel:${panelAPI.id}:accept`},panelURL=base+`/api/projects/${panelAPI.id}/panel-decision`,panelResponse=await fetch(panelURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(panelBody)}),panelResponseBody=await panelResponse.json();assert.equal(panelResponse.status,200,JSON.stringify(panelResponseBody));const adopted=panelResponseBody;assert.equal(adopted.panels['1-1'].decision.action,'accept_current');const panelReplay=await fetch(panelURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(panelBody)});assert.equal(panelReplay.status,200);assert.equal((await panelReplay.json()).idempotent,true);const stale=await fetch(panelURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify({...panelBody,idempotencyKey:`panel:${panelAPI.id}:stale`})});assert.equal(stale.status,409);
    const manualAPI=panelDecisionFixture('人工打回 API 本地幂等测试');manualAPI.project.panels['1-1'].qa={pass:true,status:'deferred',summary:'仅文件检查',issues:[],repairPrompt:''};E.saveProject(manualAPI.project);const manualIssue='意式机萃取头、手柄与出液口/液流位置关系不正确',manualBody={panelKey:'1-1',expectedRevision:manualAPI.project.revision,artifactId:manualAPI.artifactId,contentHash:W.digest({artifactId:manualAPI.artifactId,file:manualAPI.relative,at:manualAPI.at}),issue:manualIssue,repairPrompt:'只修正萃取头、portafilter 手柄卡口、双出液嘴与液流起点的功能连接，其他内容保持不变。',idempotencyKey:`manual:${manualAPI.project.id}:reject`},manualURL=base+`/api/projects/${manualAPI.project.id}/panel-review`,manualResponse=await fetch(manualURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(manualBody)}),manualResponseBody=await manualResponse.json();assert.equal(manualResponse.status,200,JSON.stringify(manualResponseBody));assert.equal(manualResponseBody.panels['1-1'].review.pass,false);assert.equal(manualResponseBody.panels['1-1'].review.status,'needs_review');assert.equal(manualResponseBody.panelDecision.state,'required');const manualReplay=await fetch(manualURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(manualBody)});assert.equal(manualReplay.status,200);assert.equal((await manualReplay.json()).idempotent,true);
    const missingHTTP=panelDecisionFixture('HTTP 缺失文件拒绝采用');fs.unlinkSync(missingHTTP.file);const missingHTTPResponse=await fetch(base+`/api/projects/${missingHTTP.project.id}/panel-decision`,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify({...panelDecisionBody(missingHTTP),idempotencyKey:`panel:${missingHTTP.project.id}:missing`})});assert.equal(missingHTTPResponse.status,400);assert.equal(E.readProject(missingHTTP.project.id).panelDecisionCommands?.length||0,0);assert.equal(E.readProject(missingHTTP.project.id).panels['1-1'].userDecision,undefined);
    const corruptHTTP=panelDecisionFixture('HTTP 损坏文件拒绝采用');fs.writeFileSync(corruptHTTP.file,'not an image');const corruptHTTPResponse=await fetch(base+`/api/projects/${corruptHTTP.project.id}/panel-decision`,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify({...panelDecisionBody(corruptHTTP),idempotencyKey:`panel:${corruptHTTP.project.id}:corrupt`})});assert.equal(corruptHTTPResponse.status,400);assert.equal(E.readProject(corruptHTTP.project.id).panelDecisionCommands?.length||0,0);assert.equal(E.readProject(corruptHTTP.project.id).panels['1-1'].userDecision,undefined);
    const retryable=E.createProject(brief);retryable.plan=structuredClone(plan);retryable.version=1;retryable.approved={version:1,hash:W.digest(retryable.plan)};retryable.samplesApproved=true;retryable.status='attention';retryable.pending=null;retryable.lastFailure=null;retryable.currentTask={id:'legacy-failed-task',kind:'image',target:'第1页-第1格',status:'failed_no_output',errorCode:'no-output',providerInvocations:1,completedAt:new Date().toISOString()};E.saveProject(retryable);
    const retryBody={confirmNoImage:true,idempotencyKey:`retry:${retryable.id}:fixture`},retryURL=base+`/api/projects/${retryable.id}/retry-missing`;
    const retried=await fetch(retryURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(retryBody)});assert.equal(retried.status,200);const retriedProject=await retried.json();assert.notEqual(retriedProject.error,'请先确认没有生成图片。');
    const replay=await (await fetch(retryURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(retryBody)})).json();assert.equal(replay.idempotent,true);
    const unknown=E.createProject({...brief,idea:'HTTP 未知结果重试测试'});unknown.plan=structuredClone(plan);unknown.version=1;unknown.approved={version:1,hash:W.digest(unknown.plan)};unknown.samplesApproved=true;unknown.status='attention';unknown.currentTask={id:'legacy-network-task',kind:'image',target:'第1页-第1格',status:'unknown_result',errorCode:'network',providerInvocations:1,completedAt:new Date().toISOString()};E.saveProject(unknown);
    const unknownURL=base+`/api/projects/${unknown.id}/retry-missing`,wrong=await fetch(unknownURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify({confirmNoImage:true,idempotencyKey:`retry-unknown:${unknown.id}:wrong`})});assert.notEqual(wrong.status,200);assert.match((await wrong.json()).error,/明确确认/);
    const unknownBody={confirmUnknownResult:true,idempotencyKey:`retry-unknown:${unknown.id}:approved`},approved=await fetch(unknownURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(unknownBody)});assert.equal(approved.status,200);const approvedProject=await approved.json();assert.equal(approvedProject.retryCommands.at(-1).decision,'retry_unknown_result');
    assert.equal((await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example','X-Wendi-Request':'studio'},body:JSON.stringify(brief)})).status,403);
    assert.equal((await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(brief)})).status,403);
    assert.equal((await fetch(base+'/media/project/'+p.id+'/project.json')).status,404);
    assert.equal((await fetch(base+'/media/reference/'+encodeURIComponent('02-小林人设/小林人设1.png'))).status,404);
    const hostStatus=await new Promise((resolve,reject)=>{const r=http.get(base+'/api/health',{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);});assert.equal(hostStatus,403);
    const response=await fetch(base+'/media/reference/'+W.FACE[0].split('/').map(encodeURIComponent).join('/'));assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');
    const busyRestart=await fetch(base+'/api/restart',{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:'{}'});assert.equal(busyRestart.status,409);
    let idle=false;for(let i=0;i<100;i++){const snapshot=await (await fetch(base+'/api/bootstrap')).json();if(snapshot.projects.every(project=>!project.busy)){idle=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}assert(idle,'restart fixture jobs did not become idle');
    const restart=await fetch(base+'/api/restart',{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:'{}'}),restartBody=await restart.json();assert.equal(restart.status,202);assert.equal(restartBody.previousInstanceId,health.instanceId);
    const duplicateRestart=await fetch(base+'/api/restart',{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:'{}'});assert.equal(duplicateRestart.status,409);
  }finally{
    if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>{const timer=setTimeout(r,3000);child.once('close',()=>{clearTimeout(timer);r();});});}
  }
});
test.after(()=>{console.log('Isolated fixture evidence:',temp);});
