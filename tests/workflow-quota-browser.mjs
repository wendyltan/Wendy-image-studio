import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {B,E,G,W,brief,callCount,done,temp,plan} from './workflow-fixtures.mjs';

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
  E.retryMissingImage(failed,'样张-1');failed=await done(failed.id);assert.equal(failed.currentTask.attempt,2);assert.equal(failed.progress.current,1);assert.equal(failed.progress.total,2);
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
  assert.ok(!project.pending);assert.equal(project.currentTask.providerInvocations,1);assert.ok(project.panels['1-1']);assert.equal(G.webWorkerStatus().message,'Codex executable ready；Chrome capability 未验证。');
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
