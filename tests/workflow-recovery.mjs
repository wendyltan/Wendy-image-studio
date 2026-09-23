import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {E,G,W,brief,callCount,done,panel,panelDecisionFixture,sha256File,temp,plan} from './workflow-fixtures.mjs';

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
test('a pre-intent browser budget interruption is unknown and cannot surface a safe-retry claim',()=>{
  let project=E.createProject({...brief,idea:'预算中断的浏览器状态不得误判为无图'});const runId='budget-interrupted-run',requestId=crypto.randomUUID(),dir=path.join(E.projectDir(project.id),'.制作记录',runId),outputFile=path.join(E.projectDir(project.id),'v1','素材','预算中断.png');fs.mkdirSync(dir,{recursive:true});
  const task={id:'budget-unknown-task',kind:'image',target:'第1页-第1格',requestId,status:'failed_no_output',errorCode:'browser-tool-budget-exceeded',providerInvocations:0,completedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,runId,requestId,state:'failed',accepted:true,submitted:false,submissionIntent:false,submissionUncertain:false,errorCode:'BROWSER_TOOL_BUDGET_EXCEEDED',ownedTabId:'1514999999',ownedTabCreatedAt:new Date().toISOString(),outputFile}));
  fs.writeFileSync(path.join(dir,'browser-tool-budget.json'),JSON.stringify({observedBusiness:4,submissionIntentObserved:false}));fs.writeFileSync(path.join(dir,'events.jsonl'),JSON.stringify({type:'item.started',item:{id:'item_x',type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code:'await tab.playwright.getByRole("button").click()'}}})+'\n');
  project.tasks=[task];project.currentTask=task;project.lastFailure={kind:'browser-tool-budget-exceeded',definiteNoOutput:true,key:task.target,attempts:0,taskId:task.id,diagnostics:{runId},message:'未记录发送意图，可安全重试'};project.status='attention';E.saveProject(project);
  E.recover();project=E.readProject(project.id);
  assert.equal(project.currentTask.status,'unknown_result');assert.equal(project.currentTask.errorCode,'browser-tool-budget-unknown');assert.equal(project.lastFailure,null);
  assert.equal(E.imageRetryState(project).certainty,'unknown_result');assert.equal(E.retryableImageFailure(project),null);
  assert.match(project.message,/竞态|无法确认/);assert.match(project.message,/不要自动重试|不会自动重试/);assert.doesNotMatch(project.message,/可安全重试/);
});
test('a budget record with only initialization and no owned tab remains confirmed pre-submit',()=>{
  let project=E.createProject({...brief,idea:'纯初始化额度证据可确认无浏览器副作用'});const dir=path.join(E.projectDir(project.id),'.制作记录',`budget-safe-proof-${crypto.randomUUID()}`),requestId=crypto.randomUUID(),outputFile=path.join(dir,'not-created.png'),task={id:'budget-safe-task',kind:'image',target:'第1页-第1格',status:'unknown_result',errorCode:'unknown_result',providerInvocations:0};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,state:'failed',requestId,errorCode:'BROWSER_TOOL_BUDGET_EXCEEDED',outputFile}));
  fs.writeFileSync(path.join(dir,'browser-tool-budget.json'),JSON.stringify({observedBusiness:0}));
  const init={type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code:'await cua.getState()'}};fs.writeFileSync(path.join(dir,'events.jsonl'),JSON.stringify({type:'item.started',item:{id:'init-start',...init}})+'\n'+JSON.stringify({type:'item.completed',item:{id:'init-done',...init}})+'\n');
  project.tasks=[task];project.currentTask=task;project.pending={key:task.target,file:outputFile,dir,provider:'test-provider',taskId:task.id,projectId:project.id,projectVersion:project.version,requestId,at:new Date().toISOString()};E.saveProject(project);
  E.recover();project=E.readProject(project.id);
  assert.equal(project.currentTask.status,'failed_no_output');assert.equal(project.currentTask.errorCode,'browser-tool-budget-exceeded');assert.equal(project.lastFailure.kind,'browser-tool-budget-exceeded');assert.equal(E.imageRetryState(project).certainty,'confirmed_missing');
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
test('re-reviewing a storyboard panel never removes or invalidates its existing page artifact',async()=>{
  const fixture=panelDecisionFixture('分镜校对只读保留成稿'),project=fixture.project,artifactId=fixture.artifactId;
  project.panels['1-1'].qa={pass:null,status:'unavailable',summary:'等待单格校对',issues:[],issueDetails:[],repairPrompt:''};
  project.pages=[{number:1,file:fixture.relative,qa:{pass:true,status:'qa_pass',summary:'成稿已校对',issues:[],issueDetails:[]},at:fixture.at,projectVersion:1,dependsOn:[artifactId]}];
  project.artifacts.push({id:'page:1',kind:'page',file:fixture.relative,dependsOn:[artifactId],valid:true,at:fixture.at});project.panelDecision=null;project.status='paused';E.saveProject(project);
  const marker=path.join(temp,'single-panel-review-finds-issue'),priorCalls=callCount();process.env.WENDI_TEST_FAIL_PANEL_QA_ONCE=marker;
  E.reviewImage(project,'1-1');const reviewed=await done(project.id);delete process.env.WENDI_TEST_FAIL_PANEL_QA_ONCE;
  assert.equal(reviewed.panels['1-1'].qa.pass,false);assert.equal(reviewed.pages.length,1);assert.equal(reviewed.pages[0].file,fixture.relative);
  assert.equal(reviewed.artifacts.find(item=>item.id==='page:1').valid,true);assert.equal(callCount(),priorCalls+1);
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
  write('request.json',{schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,identitySchemaVersion:2,identityLocked:true,...identity,expectedOutput:relative});write('worker-request.json',{schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,identitySchemaVersion:2,identityLocked:true,...identity,manifestFile});write('execution.json',{schemaVersion:1,runId,state:'completed',endedAt:'2026-09-20T00:00:00.000Z'});write('result.json',{schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,projectId:project.id,projectVersion:1,taskId,target:'样张-1',requestId,runId,endedAt:'2026-09-20T00:10:00.000Z',outcome:'artifact_saved'});write('run-identity.json',{schemaVersion:1,identitySchemaVersion:2,identityLocked:true,...identity});write('web-generation.json',{schemaVersion:2,provider:G.WEB_IMAGE_PROVIDER,identitySchemaVersion:2,identityLocked:true,...identity,state:'downloaded',accepted:true,submitted:true,artifactPath:file,referenceCount:0,downloadedAt:'2026-09-20T00:11:00.000Z'});
  project.pending={key:'样张-1',file,dir,provider:G.WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:1,prompt:'脸部近景',refs:[],inputFiles:[],at:new Date().toISOString()};project.tasks=[{id:taskId,kind:'image',target:'样张-1',status:'artifact_saved',projectId:project.id,projectVersion:1,providerInvocations:1}];project.currentTask=project.tasks[0];E.saveProject(project);E.recoverImage(project);const recovered=await done(project.id);
  assert.equal(recovered.pending,null);assert.equal(recovered.samples[0].file,relative);assert.notEqual(recovered.samples[0].qa.status,'recovered_pending_review');assert.equal(recovered.samples[0].qa.status,'manual_review');assert.equal(recovered.currentTask.status,'recovered_local');assert.equal(recovered.currentTask.qa,'manual_review');assert.equal(recovered.currentTask.errorCode,null);assert.equal(recovered.currentTask.qaStatus,'manual_review');assert.equal(recovered.currentTask.generationCompletedAt,'2026-09-20T00:00:00.000Z');assert.equal(recovered.currentTask.priorCompletedAt,'2026-09-20T00:10:00.000Z');assert.equal(recovered.currentTask.webTimings.downloadedAt,'2026-09-20T00:11:00.000Z');assert.equal(recovered.currentTask.completedAt,recovered.currentTask.recoveryCompletedAt);const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));assert.equal(result.generationCompletedAt,'2026-09-20T00:00:00.000Z');assert.equal(result.priorCompletedAt,'2026-09-20T00:10:00.000Z');assert.equal(result.downloadedAt,'2026-09-20T00:11:00.000Z');assert.equal(result.endedAt,result.recoveryCompletedAt);assert(Date.parse(result.recoveryCompletedAt)>=Date.parse(result.downloadedAt));
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
