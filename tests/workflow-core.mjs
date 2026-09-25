import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {B,E,G,J,W,brief,callCount,done,panel,panelDecisionBody,panelDecisionFixture,plan,sha256File,temp} from './workflow-fixtures.mjs';

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
  const text=G.chatGptWebImagePrompt({outputFile:'/tmp/result.png',manifestFile:'/tmp/web-generation.json',prompt:'单格测试',referenceFiles:['/tmp/wendi-1.png','/tmp/wendi-2.png'],requestId:'11111111-1111-4111-8111-111111111111',runId:'workflow-core-fixture'});
  assert.equal(G.WEB_IMAGE_PROVIDER,'chatgpt-web-iab');
  assert.equal(G.WEB_IMAGE_TRANSPORT,'direct-chrome');
  assert.equal(G.webWorkerStatus().browser,'chrome');
  assert.match(text,/只能新建本次任务专用的 Chrome extension 标签页/);
  assert.match(text,/https:\/\/chatgpt\.com\//);
  assert.match(text,/复制到准确路径 \/tmp\/result\.png/);
  assert.match(text,/web-generation\.json/);
  assert.match(text,/禁止调用 image_gen/);
  assert.match(text,/禁止接管用户已有标签页/);
  assert.match(text,/createBrowserTab\("chrome",undefined,\{sessionName:"🎨 温蒂生图-[a-f0-9]{8}"\}\)/);
  assert.match(text,/tab\.goto\("https:\/\/chatgpt\.com\/"\)/);
  assert.match(text,/try\/finally 中只调用一次 await tab\.close\(\)/);
  assert.match(text,/必须包含注释标识 WENDI_OWNED_TAB_CLEANUP_V1[\s\S]*精确的 --run-id[\s\S]*--owned-tab-id/);
  assert.match(text,/bridge 只有在 durable lease 属于本 run 且 state=closing、源码标识中的 runId\/tabId 与 lease 精确匹配/);
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
  assert.match(text,/waitForEvent\("filechooser"/);
  assert.match(text,/附件绝对路径/);
  assert.doesNotMatch(text,/chooser\.setFiles\(worker\.referenceFiles\)|worker-request\.json|fs\.readFileSync|require\(/);
  assert.match(text,/禁止调用 cua\.getApp/);
  assert.match(text,/不得重复提交/);
  assert.match(text,/授权、身份和附件台账已由本地 provider 冻结并验证/);
  assert.match(text,/当前同一个回合完成/);
});
test('web executor availability reports the direct Chrome focus boundary',()=>{
  const worker=G.webWorkerStatus();assert.equal(worker.transport,'direct-chrome');assert.equal(worker.browser,'chrome');assert.equal(worker.state,'available');assert.equal(worker.focusRestoration,'unsupported');assert.equal(worker.focusSafe,false);assert.equal(worker.ready,true);assert.equal(worker.executableReady,true);assert.equal(worker.chromeCapabilityVerified,false);assert.equal(worker.message,'Codex executable ready；Chrome capability 未验证。');
});
test('UI keeps real image errors and removes the non-blocking Chrome focus notice',()=>{
  const text=['app/page.tsx','app/studio/project-view.tsx','app/studio/recovery-cards.tsx','app/studio/workflow-status.tsx'].map(file=>fs.readFileSync(path.join(W.APP,file),'utf8')).join('\\n');
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
  const legacy=structuredClone(layout);delete legacy.pages[0].projectVersion;delete legacy.pages[0].sourceIntegrity;const legacyPageArtifact=legacy.artifacts.find(item=>item.id==='page:1');delete legacyPageArtifact.projectVersion;delete legacyPageArtifact.sourceIntegrity;
  assert.equal((await E.validatePageReviewEvidence(legacy,1)).legacySourceIntegrity,true);
  legacy.pages[0].projectVersion=99;await assert.rejects(E.validatePageReviewEvidence(legacy,1),/其他作品版本/);delete legacy.pages[0].projectVersion;
  legacy.pages[0].integrity.sha256='0'.repeat(64);await assert.rejects(E.validatePageReviewEvidence(legacy,1),/完整性核对失败/);legacy.pages[0].integrity.sha256=layout.pages[0].integrity.sha256;
  legacy.pages[0].sourceIntegrity=structuredClone(layout.pages[0].sourceIntegrity);legacy.pages[0].sourceIntegrity[0].sha256='0'.repeat(64);await assert.rejects(E.validatePageReviewEvidence(legacy,1),/分镜来源已变化/);delete legacy.pages[0].sourceIntegrity;
  legacyPageArtifact.sourceIntegrity=structuredClone(layout.pages[0].sourceIntegrity);legacyPageArtifact.sourceIntegrity[0].sha256='0'.repeat(64);await assert.rejects(E.validatePageReviewEvidence(legacy,1),/分镜来源已变化/);delete legacyPageArtifact.sourceIntegrity;
  const legacyPanelArtifact=legacy.artifacts.find(item=>item.id==='image:第1页-第1格');legacyPanelArtifact.file+='-mismatch';await assert.rejects(E.validatePageReviewEvidence(legacy,1),/当前分镜 artifact 不完整/);
  legacy.pages[0].dependsOn.pop();await assert.rejects(E.validatePageReviewEvidence(legacy,1),/分镜来源一致/);
  const reviewPageFile=layout.pages[0].file,reviewPageHash=sha256File(W.inside(E.projectDir(layout.id),reviewPageFile)),reviewImageTasks=layout.tasks.filter(task=>task.kind==='image').length,reviewCalls=callCount();
  E.reviewPage(layout,1);layout=await done(layout.id);assert.equal(layout.status,'paused');assert.equal(layout.pages[0].file,reviewPageFile);assert.equal(sha256File(W.inside(E.projectDir(layout.id),reviewPageFile)),reviewPageHash);assert.equal(layout.tasks.filter(task=>task.kind==='image').length,reviewImageTasks);assert.equal(callCount(),reviewCalls+1);
  const savedSourceHash=layout.pages[0].sourceIntegrity[0].sha256;layout.pages[0].sourceIntegrity[0].sha256='0'.repeat(64);E.saveProject(layout);E.reviewPage(layout,1);layout=await done(layout.id);assert.match(layout.error,/分镜来源已变化/);assert.equal(layout.pages[0].file,reviewPageFile);layout.pages[0].sourceIntegrity[0].sha256=savedSourceHash;E.saveProject(layout);
  const originalPage=layout.pages[0],originalPageFile=W.inside(E.projectDir(layout.id),originalPage.file),imageTasks=layout.tasks.filter(task=>task.kind==='image').length;
  originalPage.qa={pass:false,summary:'文字框遮挡主体',issues:['第1格文字框遮挡人物'],issueDetails:[{id:'layout-1',category:'layout',severity:'blocking',location:'第1格下方文字框',description:'第1格文字框遮挡人物',repairAction:'recompose'}],repairPrompt:'把文字框移到对侧'};originalPage.nextStep='重新排版';layout.status='attention';E.saveProject(layout);
  E.repairPageLayout(layout,1);layout=await done(layout.id);assert.equal(layout.status,'attention');assert.equal(layout.pages[0].qa.pass,true);assert.equal(layout.pages[0].qa.manualReviewRequired,true);assert.equal(layout.pages[0].layoutVerification.automatedVisualProof,false);assert.deepEqual(layout.pageLayouts[1].captionAnchors,['top-right']);assert.equal(layout.tasks.filter(task=>task.kind==='image').length,imageTasks);assert(fs.existsSync(originalPageFile));assert.notEqual(layout.pages[0].file,originalPage.file);
  const secondPlan={...structuredClone(layout.plan.pages[0]),number:2,title:'第二页'};layout.plan.pages.push(secondPlan);layout.brief.pageCount=2;layout.approved.hash=W.digest(layout.plan);layout.panels['2-1']={...structuredClone(layout.panels['1-1']),key:'第2页-第1格'};layout.pages.push({...structuredClone(layout.pages[0]),number:2});layout.artifacts.push({...structuredClone(layout.artifacts.find(item=>item.id==='page:1')),id:'page:2'});E.saveProject(layout);
  E.unifyPageLayouts(layout);layout=await done(layout.id);assert.equal(layout.status,'attention');assert.equal(layout.pages.length,2);assert(layout.pages.every(page=>page.qa.pass&&page.layoutHints.style==='floating-v2'));assert.equal(layout.pages[0].qa.manualReviewRequired,true);assert.equal(layout.tasks.filter(task=>task.kind==='image').length,imageTasks);
  const unconfirmed=layout.pages.find(page=>page.number===1),unconfirmedFile=unconfirmed.file,taskCount=layout.tasks.length,verificationBefore=structuredClone(unconfirmed.layoutVerification);
  assert.equal(E.pageIsCurrent(layout,unconfirmed),false);
  E.generatePages(layout);assert.equal(layout.status,'attention');assert.match(layout.message,/还没有人工确认/);assert.equal(layout.tasks.length,taskCount);assert.equal(layout.pages.find(page=>page.number===1).file,unconfirmedFile);
  const artifact=layout.artifacts.find(item=>item.id==='page:1'),contentHash=W.digest({artifactId:'page:1',file:unconfirmed.file,at:unconfirmed.at||artifact.at||null});
  await assert.rejects(E.confirmPageLayout(layout,{pageNumber:1,projectVersion:layout.version+1,contentHash}),/版本已变化/);
  await assert.rejects(E.confirmPageLayout(layout,{pageNumber:1,projectVersion:layout.version,contentHash:'stale'}),/内容已更新/);
  const sourceHash=unconfirmed.sourceIntegrity[0].sha256;unconfirmed.sourceIntegrity[0].sha256='0'.repeat(64);await assert.rejects(E.confirmPageLayout(layout,{pageNumber:1,projectVersion:layout.version,contentHash}),/分镜来源已变化/);unconfirmed.sourceIntegrity[0].sha256=sourceHash;
  await E.confirmPageLayout(layout,{pageNumber:1,projectVersion:layout.version,contentHash});
  assert.equal(unconfirmed.layoutVerification.manualConfirmationRequired,false);assert.ok(unconfirmed.layoutVerification.confirmedAt);assert.equal(unconfirmed.layoutVerification.confirmedFileSha256,unconfirmed.integrity.sha256);assert.equal(unconfirmed.qa.manualReviewRequired,false);assert.equal(unconfirmed.qa.status,'human_confirmed_layout');assert.deepEqual(unconfirmed.layoutVerification.beforeQa,verificationBefore.beforeQa);assert.deepEqual(unconfirmed.layoutVerification.afterQa,verificationBefore.afterQa);assert.equal(E.pageIsCurrent(layout,unconfirmed),true);
});
test('legacy manual layout confirmation remains explicit and requires current source evidence',async()=>{
  let layout=E.createProject({...brief,idea:'旧页面人工确认门禁'});layout.plan=structuredClone(plan);layout.version=1;layout.approved={version:1,hash:W.digest(layout.plan)};layout.samplesApproved=true;layout.status='paused';E.saveProject(layout);
  E.generatePages(layout);layout=await done(layout.id);const page=layout.pages[0],artifact=layout.artifacts.find(item=>item.id==='page:1');
  page.qa={...page.qa,pass:true,status:'manual_layout_review',manualReviewRequired:true};delete page.layoutVerification;delete page.projectVersion;delete page.sourceIntegrity;delete artifact.projectVersion;delete artifact.sourceIntegrity;
  const contentHash=W.digest({artifactId:'page:1',file:page.file,at:page.at||artifact.at||null});
  const sourceHash=page.integrity.sha256;
  await assert.rejects(E.confirmPageLayout(layout,{pageNumber:1,projectVersion:layout.version,contentHash:'stale'}),/内容已更新/);
  assert.equal(page.qa.manualReviewRequired,true);assert.equal(page.integrity.sha256,sourceHash);
  const sourceArtifact=layout.artifacts.find(item=>item.id==='image:第1页-第1格'),sourceFile=sourceArtifact.file;sourceArtifact.file+='-mismatch';
  await assert.rejects(E.confirmPageLayout(layout,{pageNumber:1,projectVersion:layout.version,contentHash}),/当前分镜 artifact 不完整/);sourceArtifact.file=sourceFile;
  await E.confirmPageLayout(layout,{pageNumber:1,projectVersion:layout.version,contentHash});
  assert.equal(page.qa.manualReviewRequired,false);assert.equal(page.qa.status,'human_confirmed_layout');assert.equal(page.layoutVerification.confirmedFileSha256,sourceHash);
});
test('panel revision only freezes same-page originals when continuity is explicitly requested',async()=>{
  const p=E.createProject({...brief,idea:'局部修订连续性附件选择'});p.version=1;p.plan=structuredClone(plan);p.approved={version:1,hash:W.digest(p.plan)};
  assert.deepEqual(E.revisionContinuityKeys(p,'1-1','只改人物表情，不涉及其他画面'),[]);
  p.plan.pages[0].panels=[structuredClone(panel),structuredClone(panel),structuredClone(panel)];
  p.plan.pages[0].layout='montage';
  p.approved.hash=W.digest(p.plan);
  assert.deepEqual(E.revisionContinuityKeys(p,'1-3','请和同页前两格保持椅子款式一致'),['1-1','1-2']);
  const root=E.projectDir(p.id),source=W.inside(W.REFS,W.FACE[0]),at=new Date().toISOString();fs.mkdirSync(path.join(root,'v1','素材'),{recursive:true});
  p.panels={};p.artifacts=[];
  for(const key of ['1-1','1-2','1-3']){const file=path.join(root,'v1','素材',`${key}.png`);fs.copyFileSync(source,file);const relative=path.relative(root,file),integrity={sha256:sha256File(file),sizeBytes:fs.statSync(file).size};p.panels[key]={key,file:relative,basePrompt:panel.prompt,integrity,qa:{pass:true,status:'passed',issueDetails:[]},at};p.artifacts.push({id:`image:第1页-第${key.split('-')[1]}格`,kind:'image',file:relative,valid:true,integrity,at});}
  E.saveProject(p);E.reviseImage(p,'1-3','请和同页前两格保持椅子款式一致');const revised=await done(p.id);
  assert.equal(revised.revisionNotes.at(-1).continuityAttachments.length,2);
  const note=revised.revisionNotes.at(-1);for(const item of note.continuityAttachments){assert.equal(sha256File(W.inside(root,item.file)),item.sha256);assert.equal(sha256File(path.join(root,'v1','参考',item.reference)),item.sha256);}
  const run=fs.readdirSync(path.join(root,'.制作记录')).map(name=>path.join(root,'.制作记录',name)).find(dir=>dir.includes('1-3-局部修订')),request=JSON.parse(fs.readFileSync(path.join(run,'request.json'),'utf8'));
  assert.equal(request.referenceNames.length,3);assert(request.referenceNames.includes(note.continuityAttachments[0].reference));assert(request.referenceNames.includes(note.continuityAttachments[1].reference));assert.equal(request.referenceFiles.length,6);
  const remotePrompt=fs.readFileSync(path.join(run,'prompt.txt'),'utf8');assert.match(remotePrompt,/编辑基图/);assert.match(remotePrompt,/末尾追加的 2 张同页参考/);assert.match(remotePrompt,/椅子款式与书房环境连续性/);assert.match(remotePrompt,/不要拼接或合成多格/);
  revised.currentTask={id:'failed-continuity-revision',kind:'image',target:'第1页-第3格',status:'failed_no_output',errorCode:'no-output',providerInvocations:0};revised.lastFailure={kind:'no-output',definiteNoOutput:true,key:'第1页-第3格',attempts:0};revised.status='attention';
  E.retryMissingImage(revised,'1-3');const retried=await done(p.id);assert.equal(retried.currentTask.target,'第1页-第3格',retried.error||retried.message);
  const retryDirs=fs.readdirSync(path.join(root,'.制作记录')).map(name=>path.join(root,'.制作记录',name)).filter(dir=>fs.existsSync(path.join(dir,'request.json'))),retryRequests=retryDirs.map(dir=>({dir,request:JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'))})).filter(item=>item.request.target==='第1页-第3格'),retryRun=retryRequests.at(-1),retryRequest=retryRun?.request;
  assert(retryRequest);assert(retryRequest.referenceNames.includes(note.continuityAttachments[0].reference));assert(retryRequest.referenceNames.includes(note.continuityAttachments[1].reference));assert.equal(retryRequest.referenceFiles.length,6);assert.match(fs.readFileSync(path.join(retryRun.dir,'prompt.txt'),'utf8'),/末尾追加的 2 张同页参考/);
  const newestNote=retried.revisionNotes.at(-1),snapshotPath=path.join(root,'v1','参考',newestNote.continuityAttachments[0].reference),snapshotBytes=fs.readFileSync(snapshotPath);fs.chmodSync(snapshotPath,0o644);fs.copyFileSync(W.inside(W.REFS,W.FACE[1]),snapshotPath);fs.chmodSync(snapshotPath,0o444);
  retried.currentTask={id:'tampered-continuity-revision',kind:'image',target:'第1页-第3格',status:'failed_no_output',errorCode:'no-output',providerInvocations:0};retried.lastFailure={kind:'no-output',definiteNoOutput:true,key:'第1页-第3格',attempts:0};E.retryMissingImage(retried,'1-3');const tampered=await done(p.id);assert.match(tampered.error,/哈希已变化/);
  fs.chmodSync(snapshotPath,0o644);fs.writeFileSync(snapshotPath,snapshotBytes);fs.chmodSync(snapshotPath,0o444);
  const restored=E.readProject(p.id),restoredNote=restored.revisionNotes.at(-1);restoredNote.projectVersion=99;restored.currentTask={id:'stale-continuity-revision',kind:'image',target:'第1页-第3格',status:'failed_no_output',errorCode:'no-output',providerInvocations:0};restored.lastFailure={kind:'no-output',definiteNoOutput:true,key:'第1页-第3格',attempts:0};E.retryMissingImage(restored,'1-3');const rejected=await done(p.id);assert.match(rejected.error,/其他作品版本/);
  const legacy=E.readProject(p.id),legacyNote=legacy.revisionNotes.at(-1);delete legacyNote.projectVersion;delete legacyNote.continuityAttachments;delete legacyNote.baseSha256;legacy.currentTask={id:'legacy-no-base-sha',kind:'image',target:'第1页-第3格',status:'failed_no_output',errorCode:'no-output',providerInvocations:0};legacy.lastFailure={kind:'no-output',definiteNoOutput:true,key:'第1页-第3格',attempts:0};E.retryMissingImage(legacy,'1-3');const rejectedLegacy=await done(p.id);assert.match(rejectedLegacy.error,/SHA-256/);
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
  const records=path.join(root,'.制作记录'),firstDir=fs.readdirSync(records).map(name=>path.join(records,name)).find(dir=>dir.includes('1-1-局部修订'));assert(firstDir);const firstRequest=JSON.parse(fs.readFileSync(path.join(firstDir,'request.json'),'utf8')),firstPrompt=fs.readFileSync(path.join(firstDir,'prompt.txt'),'utf8');assert.equal(firstRequest.executorReasoningEffort,'low');assert.equal(firstRequest.referenceFiles.length,4);assert.doesNotMatch(firstPrompt,/BASE_PROMPT/);assert.match(firstPrompt,/仅保持未涉及内容不变/);assert.match(firstPrompt,/把书放下并看向窗外/);assert.doesNotMatch(firstPrompt,/LEGACY_PROMPT_WITH_OLD_DELTA/);
  E.reviseImage(first,'1-1','把咖啡杯移到右侧。');const second=await done(first.id);assert.equal(second.status,'paused');assert.equal(second.panels['1-1'].revisionBase.selectedBy,'previous-stable-base');
  const revisionDirs=fs.readdirSync(records).filter(name=>name.includes('1-1-局部修订')).map(name=>path.join(records,name)).sort(),secondDir=revisionDirs.at(-1),secondRequest=JSON.parse(fs.readFileSync(path.join(secondDir,'request.json'),'utf8')),secondPrompt=fs.readFileSync(path.join(secondDir,'prompt.txt'),'utf8');assert.equal(revisionDirs.length,2);assert.equal(secondRequest.editTarget.sha256,firstRequest.editTarget.sha256);assert.equal(secondRequest.preparation.reusedCount,4);assert.doesNotMatch(secondPrompt,/BASE_PROMPT/);assert.match(secondPrompt,/仅保持未涉及内容不变/);assert.match(secondPrompt,/把咖啡杯移到右侧/);assert.doesNotMatch(secondPrompt,/把书放下并看向窗外/);assert.doesNotMatch(secondPrompt,/LEGACY_PROMPT_WITH_OLD_DELTA/);
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

function recoveredAdoptionFixture(idea='恢复图采用测试'){
  const fixture=panelDecisionFixture(idea),project=fixture.project,key='2-3',taskId=crypto.randomUUID(),requestId=crypto.randomUUID(),runDir=path.join(E.projectDir(project.id),'.制作记录',`run-${crypto.randomUUID()}`),file=path.join(E.projectDir(project.id),'v2','素材','recovered.png'),relative=path.relative(E.projectDir(project.id),file),artifactId='image:第2页-第3格';
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(W.inside(W.REFS,W.FACE[0]),file);const integrity={sha256:sha256File(file),sizeBytes:fs.statSync(file).size},runId=path.basename(runDir),target='第2页-第3格',provider=G.WEB_IMAGE_PROVIDER,at=new Date().toISOString();
  project.version=2;project.approved={version:2,hash:W.digest(project.plan)};project.status='paused';project.pending=null;project.panels={[key]:{key:target,file:relative,prompt:'fixture',integrity,qa:{pass:null,status:'manual_review',summary:'等待人工校对',issues:[],repairPrompt:''},at}};
  const task={id:taskId,kind:'image',target,status:'recovered_local',projectId:project.id,projectVersion:2,requestId,provider,qa:'manual_review'};project.tasks=[task];project.currentTask=structuredClone(task);project.artifacts=[{id:artifactId,kind:'image',file:relative,valid:true,projectVersion:2,at,integrity}];project.pages=[{number:2,file:'v2/候选成稿/02-old.png',dependsOn:[artifactId],qa:{pass:null,status:'unavailable'}}];
  fs.mkdirSync(runDir,{recursive:true});const outputFile=file,common={identitySchemaVersion:2,identityLocked:true,projectId:project.id,projectVersion:2,taskId,target,requestId,runId,outputFile};
  fs.writeFileSync(path.join(runDir,'request.json'),JSON.stringify({schemaVersion:2,provider,...common,expectedOutput:relative}));fs.writeFileSync(path.join(runDir,'worker-request.json'),JSON.stringify({schemaVersion:2,provider,...common,manifestFile:path.join(runDir,'web-generation.json')}));fs.writeFileSync(path.join(runDir,'execution.json'),JSON.stringify({schemaVersion:1,runId,state:'completed'}));fs.writeFileSync(path.join(runDir,'run-identity.json'),JSON.stringify({schemaVersion:1,...common}));fs.writeFileSync(path.join(runDir,'web-generation.json'),JSON.stringify({schemaVersion:2,provider,...common,state:'downloaded',accepted:true,submitted:true,artifactPath:file}));
  E.saveProject(project);return {project,key,taskId,requestId,artifactId,file,integrity,action:{panelKey:key,projectVersion:2,taskId,requestId,artifactId,expectedSha256:integrity.sha256,expectedRevision:project.revision,planHash:project.approved.hash,continueProduction:false}};
}
test('recovered manual-review image can be locally adopted without passing QA or resuming production',async()=>{
  const accepted=recoveredAdoptionFixture('原图恢复后仅记录人工采用'),project=accepted.project,beforeCalls=callCount(),beforeTaskCount=project.tasks.length,beforePages=structuredClone(project.pages);
  await E.adoptRecoveredPanel(project,accepted.action);
  assert.equal(project.panels[accepted.key].userDecision.action,'adopt_recovered');assert.equal(project.panels[accepted.key].userDecision.requestId,accepted.requestId);assert.equal(project.panels[accepted.key].qa.pass,null);assert.equal(project.panels[accepted.key].qa.status,'manual_review');assert.equal(E.panelAccepted(project.panels[accepted.key]),true);assert.equal(project.status,'paused');assert.equal(project.pending,null);assert.deepEqual(project.pages,beforePages);assert.equal(project.tasks.length,beforeTaskCount);assert.equal(callCount(),beforeCalls);assert.equal(E.active.has(project.id),false);
  for(const [name,extra] of Object.entries({request:{requestId:crypto.randomUUID()},task:{taskId:crypto.randomUUID()},version:{projectVersion:1},hash:{expectedSha256:'0'.repeat(64)},nonCurrent:{panelKey:'2-2'}})){
    const rejected=recoveredAdoptionFixture(`不可信采用拒绝-${name}`);await assert.rejects(()=>E.adoptRecoveredPanel(rejected.project,{...rejected.action,...extra}),/身份|当前|哈希|图片|匹配|版本|目标/);
  }
  const rejected=recoveredAdoptionFixture('已经人工拒绝的恢复图不得采用');rejected.project.panels[rejected.key].qa={pass:false,status:'needs_review',issues:['用户打回']};rejected.project.panels[rejected.key].userDecision={action:'reject_current'};E.saveProject(rejected.project);await assert.rejects(()=>E.adoptRecoveredPanel(rejected.project,rejected.action),/人工|校对|拒绝/);
  const corrupt=recoveredAdoptionFixture('损坏恢复图片不能采用');fs.writeFileSync(corrupt.file,'not an image');await assert.rejects(()=>E.adoptRecoveredPanel(corrupt.project,corrupt.action),/解码|图片/);
  const unsafe=recoveredAdoptionFixture('不允许采用后自动继续');await assert.rejects(()=>E.adoptRecoveredPanel(unsafe.project,{...unsafe.action,continueProduction:true}),/继续制作/);
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
