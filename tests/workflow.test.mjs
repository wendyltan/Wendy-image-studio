import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-studio-tests-'));
process.env.WENDI_DATA_DIR=path.join(temp,'stories');
const fake=path.join(temp,'fixture-cli');
process.env.WENDI_CODEX_BIN=fake;
process.env.WENDI_TEST_CALLS=path.join(temp,'calls.txt');
const W=await import('../server/workflow.mjs');
const E=await import('../server/engine.mjs');
const B=await import('../server/bridge.mjs');
const panel={scene:'原木客厅',characters:'温蒂',costume:'轻薄夏装',action:'翻书',gaze:'书页',expression:'专注',lighting:'左侧日光',layers:'桌子、人物、窗外',objects:'一本书',caption:'停一会儿，也很好。',captionKind:'narration',screenText:'',screenDirection:'',prompt:'看书，手脚完整',references:['04-住宅环境/原木客厅参考.png'],anchors:['高丸子头'],forbidden:['无关文字']};
const plan={title:'流程测试专用',synopsis:'测试夹具',arc:'拿起书、停下、望向窗外。',continuity:{characters:['1页1格 温蒂'],scenes:['原木客厅'],objects:['书'],copy:['1页1格 停一会儿，也很好。']},samples:[{title:'脸部',prompt:'脸部近景',references:[]},{title:'场景',prompt:'原木客厅',references:panel.references}],pages:[{number:1,title:'仅用于流程测试',purpose:'测试排版',time:'夏末午后',layout:'solo',panels:[panel]}]};
const planFile=path.join(temp,'fixture-plan.json');fs.writeFileSync(planFile,JSON.stringify(plan));process.env.WENDI_TEST_PLAN_FILE=planFile;
// Deliberately labelled fixture images; this executable is used only inside this isolated test.
fs.writeFileSync(fake,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const a=process.argv.slice(2);if(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}let p='';for await(const c of process.stdin)p+=c;
fs.appendFileSync(process.env.WENDI_TEST_CALLS,'call\\n');
const out=a[a.indexOf('-o')+1];let text='';
if(a.includes('--output-schema')){const s=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1]));const marker=process.env.WENDI_TEST_FAIL_SAMPLE_ONCE,crash=process.env.WENDI_TEST_CRASH_QA_ONCE;if(!s.properties.pages&&crash&&p.includes('脸部近景')&&!fs.existsSync(crash)){fs.writeFileSync(crash,'1');process.exit(42);}else if(!s.properties.pages&&marker&&p.includes('脸部近景')&&!fs.existsSync(marker)){fs.writeFileSync(marker,'1');text=JSON.stringify({pass:false,summary:'TEST FIXTURE REPAIR',issues:['前臂与提带关系不自然'],issueDetails:[{id:'arm-strap',category:'anatomy',severity:'blocking',location:'左前臂',description:'前臂与提带关系不自然',repairAction:'regenerate'}],repairPrompt:'修正前臂与提带关系'});}else text=JSON.stringify(s.properties.pages?JSON.parse(fs.readFileSync(process.env.WENDI_TEST_PLAN_FILE)): {pass:true,summary:'TEST FIXTURE CHECK ONLY',issues:[],issueDetails:[],repairPrompt:''});}
else {const noImage=process.env.WENDI_TEST_NO_IMAGE_ONCE;if(noImage&&!fs.existsSync(noImage)){fs.writeFileSync(noImage,'1');text=process.env.WENDI_TEST_NO_IMAGE_TEXT||'未能生成：内置 image_gen 连接错误，目标路径尚不存在。';}else{const m=p.match(/复制到准确路径 ([^\\n]+?\\.png)/);if(!m)process.exit(2);const file=m[1];fs.mkdirSync(path.dirname(file),{recursive:true});const r=p.match(/目标原始画面宽高比 (\\d+):(\\d+)/);const w=r?+r[1]:750,h=r?+r[2]:1000;execFileSync('/Library/Frameworks/Python.framework/Versions/3.10/bin/python3',['-c','from PIL import Image,ImageDraw; import sys; im=Image.new("RGB",(int(sys.argv[2]),int(sys.argv[3])),"#d8dfce"); ImageDraw.Draw(im).text((20,20),"PIPELINE TEST ONLY",fill="black"); im.save(sys.argv[1])',file,String(w),String(h)]);text=file;}}
fs.writeFileSync(out,text);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));console.log(JSON.stringify({type:'turn.completed'}));
`,{mode:0o700});
async function done(id){for(let i=0;i<200;i++){if(!E.active.has(id))return E.readProject(id);await new Promise(r=>setTimeout(r,50));}throw new Error('test job timed out');}
function callCount(){return fs.existsSync(process.env.WENDI_TEST_CALLS)?fs.readFileSync(process.env.WENDI_TEST_CALLS,'utf8').split('\n').filter(Boolean).length:0;}
const brief={idea:'测试这一个完整故事流程',pageCount:1,allowXiaolin:false,tangyuan:'不出现'};
let p;
test('input validation and restricted references',()=>{
  assert.equal(B.extractRateLimits({rateLimits:{rateLimitsByLimitId:{codex:{primary:{usedPercent:64}}}}}).primary.usedPercent,64);
  const normalized=B.normalizeRateLimits({rateLimits:{primary:{usedPercent:64,windowDurationMins:300,resetsAt:123},secondary:{usedPercent:42,windowDurationMins:10080}}});
  assert.deepEqual(normalized.primary,{usedPercent:64,remainingPercent:36,windowDurationMins:300,resetsAt:123});assert.equal(normalized.secondary.remainingPercent,58);
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
  assert.equal(request.schemaVersion,1);assert.equal(request.target.startsWith('样张-'),true);assert.equal(result.outcome,'artifact_saved');assert.equal(typeof result.integrity.sha256,'string');
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
test('known image network failure stops without a misleading recovery state',async()=>{
  const marker=path.join(temp,'no-image-once');process.env.WENDI_TEST_NO_IMAGE_ONCE=marker;
  let failed=E.createProject(brief);E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  delete process.env.WENDI_TEST_NO_IMAGE_ONCE;
  assert.equal(failed.status,'attention');assert.equal(failed.pending,null);assert.equal(failed.lastFailure.kind,'network');assert.equal(failed.lastFailure.attempts,1);
  assert.match(failed.message,/没有取得图片/);assert.match(failed.message,/自动重试已停止/);assert.match(failed.message,/重试当前样张/);
  assert.equal(failed.currentTask.status,'failed_no_output');assert.equal(failed.currentTask.providerInvocationLimit,1);assert.equal(failed.currentTask.providerInvocations,1);
});
test('explicit no-image evidence never falls into the uncertain recovery path',async()=>{
  for(const text of ['生成工具返回网络连接错误，未产生任何图片，也未写入目标路径。','本次请求未产出任何图片。']){
    const marker=path.join(temp,`no-output-${Buffer.from(text).toString('hex').slice(0,12)}`);process.env.WENDI_TEST_NO_IMAGE_ONCE=marker;process.env.WENDI_TEST_NO_IMAGE_TEXT=text;
    let failed=E.createProject(brief);E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
    assert.equal(failed.status,'attention',text);assert.equal(failed.pending,null,text);assert(['network','no-output'].includes(failed.lastFailure.kind),text);assert.equal(failed.currentTask.status,'failed_no_output',text);assert.doesNotMatch(failed.message,/检查已有原图|找回已生成图片/,text);
  }
  delete process.env.WENDI_TEST_NO_IMAGE_ONCE;delete process.env.WENDI_TEST_NO_IMAGE_TEXT;
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
  restored.samples=[];restored.pending={key:'样张-1',file,dir:path.join(E.projectDir(restored.id),'.制作记录','已找到原图'),prompt:'脸部近景',refs:[],at:new Date().toISOString()};restored.status='attention';E.saveProject(restored);
  const before=callCount();E.recoverImage(restored);restored=await done(restored.id);
  assert.equal(callCount(),before);assert.equal(restored.pending,null);assert.equal(restored.samples[0].file,path.relative(E.projectDir(restored.id),file));assert(fs.existsSync(W.inside(E.projectDir(restored.id),restored.samples[0].file)));assert(restored.artifacts.some(x=>x.id==='image:样张-1'));
});
test('an image artifact and its record survive a QA transport failure',async()=>{
  const marker=path.join(temp,'qa-transport-failure');process.env.WENDI_TEST_CRASH_QA_ONCE=marker;
  let failed=E.createProject(brief);E.planProject(failed);failed=await done(failed.id);E.approvePlan(failed,W.digest(failed.plan));failed=await done(failed.id);
  delete process.env.WENDI_TEST_CRASH_QA_ONCE;
  const image=failed.artifacts.find(x=>x.id==='image:样张-1');assert(image);assert(fs.existsSync(W.inside(E.projectDir(failed.id),image.file)));assert.equal(failed.samples[0].file,image.file);assert.notEqual(failed.samples[0].qa?.pass,true);
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
  await assert.rejects(B.pythonRun(['compose',spec]),/比例/);
  const q=structuredClone(plan.pages[0]);q.panels[0].caption='太长的文案'.repeat(150);W.jsonWrite(spec,q);await assert.rejects(B.pythonRun(['geometry',spec]),/文案过长/);
});
test('HTTP service serves built app and blocks foreign writes and unlisted files',async()=>{
  const port=44918;const child=spawn(process.execPath,[path.join(W.APP,'server/server.mjs')],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',c=>output+=c);
  try{
    let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
    assert(ready,output);const base=`http://127.0.0.1:${port}`;
    const boot=await (await fetch(base+'/api/bootstrap')).json();assert(boot.connection.ready);assert(boot.references.length>=20);
    assert.equal((await fetch(base+'/')).status,200);
    const switched=await (await fetch(base+`/api/projects/${p.id}/settings`,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify({model:'fixture-model',reasoningEffort:'low'})})).json();assert.equal(switched.brief.model,'fixture-model');assert.equal(switched.modelHistory.at(-1).to.model,'fixture-model');
    const renamed=await (await fetch(base+`/api/projects/${p.id}/title`,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify({title:'已改名的流程测试'})})).json();assert.equal(renamed.title,'已改名的流程测试');
    let retryable=E.createProject(brief);retryable.plan=structuredClone(plan);retryable.version=1;retryable.approved={version:1,hash:W.digest(retryable.plan)};retryable.samplesApproved=true;retryable.status='attention';retryable.pending=null;retryable.lastFailure={kind:'network',definiteNoOutput:true,key:'第1页-第1格',attempts:1,at:new Date().toISOString()};E.saveProject(retryable);
    const retryBody={confirmNoImage:true,idempotencyKey:`retry:${retryable.id}:fixture`},retryURL=base+`/api/projects/${retryable.id}/retry-missing`;
    const retried=await fetch(retryURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(retryBody)});assert.equal(retried.status,200);const retriedProject=await retried.json();assert.notEqual(retriedProject.error,'请先确认没有生成图片。');
    const replay=await (await fetch(retryURL,{method:'POST',headers:{'Content-Type':'application/json','X-Wendi-Request':'studio'},body:JSON.stringify(retryBody)})).json();assert.equal(replay.idempotent,true);
    assert.equal((await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example','X-Wendi-Request':'studio'},body:JSON.stringify(brief)})).status,403);
    assert.equal((await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(brief)})).status,403);
    assert.equal((await fetch(base+'/media/project/'+p.id+'/project.json')).status,404);
    assert.equal((await fetch(base+'/media/reference/'+encodeURIComponent('02-小林人设/小林人设1.png'))).status,404);
    const hostStatus=await new Promise((resolve,reject)=>{const r=http.get(base+'/api/health',{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);});assert.equal(hostStatus,403);
    const response=await fetch(base+'/media/reference/'+W.FACE[0].split('/').map(encodeURIComponent).join('/'));assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');
  }finally{
    if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>{const timer=setTimeout(r,3000);child.once('close',()=>{clearTimeout(timer);r();});});}
  }
});
test.after(()=>{console.log('Isolated fixture evidence:',temp);});
