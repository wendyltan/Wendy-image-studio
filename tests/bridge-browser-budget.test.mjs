import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {dispatchChatGptWebJob} from '../server/chatgpt-web-provider.mjs';
import {BROWSER_CLEANUP_MARKER,BROWSER_TOOL_BUSINESS_CALL_BUDGET,BROWSER_TOOL_CLEANUP_CALL_BUDGET,BROWSER_TOOL_STAGE_BUDGETS,browserToolStage,readBrowserToolBudget,runCodex} from '../server/bridge.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-browser-budget-'));

function fixture(mode,{lease=true}={}){
  const dir=fs.mkdtempSync(path.join(root,`${mode}-`)),bin=path.join(dir,'fixture-worker.mjs'),fifth=path.join(dir,'fifth-business'),closed=path.join(dir,'cleanup-call'),after=path.join(dir,'after-budget'),delayed=path.join(dir,'delayed-completed');
  if(lease)fs.writeFileSync(path.join(dir,'owned-tab-lease.json'),JSON.stringify({schemaVersion:1,runId:path.basename(dir),requestId:'11111111-1111-4111-8111-111111111111',sessionName:'fixture',ownedTabId:'tab-fixture',createdAt:new Date().toISOString(),state:'created',cleanupStatus:'open',cleanupVerifiedAt:null,cleanupError:null,kernelReset:false,updatedAt:new Date().toISOString()}));
  const source=`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const dir=process.cwd();
const runId=path.basename(process.cwd());
const mode=${JSON.stringify(mode)};
let uploadCallNumber=0;
const fifth=${JSON.stringify(fifth)};
const closed=${JSON.stringify(closed)};
const after=${JSON.stringify(after)};
const delayed=${JSON.stringify(delayed)};
const marker=${JSON.stringify(BROWSER_CLEANUP_MARKER)};
const makeItem=(index,code='noop')=>({id:'item_'+index,type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code},result:{content:[{type:'image',data:'data:image/png;base64:'+'A'.repeat(12000)}],_meta:{browser_use:{screenshot:{pageUrl:'https://chatgpt.com',tabId:'fixture',url:'data:image/png;base64:'+'B'.repeat(12000)}}}}});
const emit=(index,code='noop')=>{const item=makeItem(index,code);console.log(JSON.stringify({type:'item.started',item}));console.log(JSON.stringify({type:'item.completed',item}));};
const emitStarted=(index,code='noop')=>{const item=makeItem(index,code);console.log(JSON.stringify({type:'item.started',item}));return item;};
const emitCompleted=item=>console.log(JSON.stringify({type:'item.completed',item}));
const emitIntentHelper=index=>{const item={id:'item_'+index,type:'command_execution',command:'node run-manifest.mjs submission-intent --manifest-file fixture/web-generation.json',aggregated_output:'{"ok":true,"submissionIntent":true}'};console.log(JSON.stringify({type:'item.started',item}));console.log(JSON.stringify({type:'item.completed',item}));};
const calls=mode==='initialization-budget'?['init','create','navigation','entry','upload','upload','intent-helper','submit','download','download']:mode==='repeated-initialization'?['init','init','create','navigation','entry']:mode==='four-business-close'?['bootstrap','bootstrap','bootstrap','upload','close']:mode==='close-abuse'?['bootstrap','bootstrap','bootstrap','abuse','business']:mode==='lifecycle-classification'?['diagnostic-ax','entry-diagnostic','upload','submit','download','close']:mode==='single-select-upload'?['duplicate-action']:mode==='duplicate-upload'?['upload','duplicate-action']:mode==='duplicate-create'?['duplicate-action']:mode==='pre-intent'?['bootstrap','bootstrap','bootstrap','upload','upload','upload']:mode==='post-intent'||mode==='post-intent-delayed'?['bootstrap','bootstrap','bootstrap','intent-helper','submit','submit']:mode==='intent-and-send'?['bootstrap','bootstrap','bootstrap','upload','intent-helper','submit']:['business','business','business','business','business'];
let index=0;
const next=()=>{const kind=calls[index];if(!kind){setTimeout(()=>{fs.writeFileSync(after,'1');process.exit(0)},800);return;}index+=1;if(kind!=='close'){const leaseFile=path.join(dir,'owned-tab-lease.json');const lease=JSON.parse(fs.readFileSync(leaseFile,'utf8'));lease.state=(kind==='upload'?'uploading':kind==='submit'?'uploaded':kind==='download'?'generating':'created');fs.writeFileSync(leaseFile,JSON.stringify(lease));if(mode==='lifecycle-classification'){const manifestFile=path.join(dir,'web-generation.json');let manifest={state:'accepted',submissionIntent:false,submitted:false};try{manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'))}catch{};if(kind==='submit')manifest.state='ready';if(kind==='download'){manifest.state='submitted';manifest.submissionIntent=true;manifest.submitted=true}fs.writeFileSync(manifestFile,JSON.stringify(manifest))}}if((index===5||index===6)&&kind==='business' || (mode==='pre-intent'&&index===6))fs.writeFileSync(fifth,'1');if(kind==='close'){const leaseFile=path.join(dir,'owned-tab-lease.json');const lease=JSON.parse(fs.readFileSync(leaseFile,'utf8'));lease.state='closing';fs.writeFileSync(leaseFile,JSON.stringify(lease));fs.writeFileSync(closed,'1');fs.writeFileSync(after,'1');emit(index,marker+'; await tab.close(); --run-id "'+runId+'" --owned-tab-id "tab-fixture" --state closing;');setTimeout(()=>process.exit(0),120);return;}if(kind==='abuse')emit(index,marker+'; await tab.close(); --run-id "'+runId+'" --owned-tab-id "tab-fixture" --state closing;');else if(kind==='intent-helper')emitIntentHelper(index);else if(kind==='submit'&&mode==='post-intent-delayed'&&index===6){const item=emitStarted(index,'const send=tab.playwright.getByRole("button",{name:/发送提示词/}); await send.click();');setTimeout(()=>{emitCompleted(item);fs.writeFileSync(delayed,'1');next();},700);return;}else if(kind==='submit')emit(index,'const send=tab.playwright.getByRole("button",{name:/发送提示词/}); await send.click();');else if(kind==='duplicate-action'&&mode==='duplicate-upload')emit(index,'await chooser.setFiles(files); await chooser.setFiles(files);');else if(kind==='duplicate-action'&&mode==='duplicate-create')emit(index,'await cua.createBrowserTab("chrome",undefined,{sessionName:"one"}); await cua.createBrowserTab("chrome",undefined,{sessionName:"two"});');else if(kind==='upload'){uploadCallNumber+=1;emit(index,uploadCallNumber===1?'await chooser.setFiles(files); const send=tab.playwright.getByRole("button",{name:/发送提示词/}); const sendEnabled=await send.isEnabled();':'const observed=await tab.getAXState({emit:false}); const sendEnabled=/send/.test(String(observed));')}else if(kind==='init')emit(index,'await cua.getState()');else if(kind==='create')emit(index,'globalThis.__wendiOwnedTab=await cua.createBrowserTab("chrome",undefined,{sessionName:"fixture"})');else if(kind==='navigation')emit(index,'await tab.goto("https://chatgpt.com"); await tab.getAXState({emit:false})');else if(kind==='entry')emit(index,'login chat mode composer 创建图片');else if(kind==='download')emit(index,'const inventory=await pageAssets.list()');else if(kind==='diagnostic-ax')emit(index,'const ax=await tab.getAXState({emit:false}); const copy="prompt-textarea composer uploading"; return {ax,copy};');else if(kind==='entry-diagnostic')emit(index,'const ax=await tab.getAXState({emit:false}); const hasComposer=/prompt-textarea|composer/.test(String(ax));');else emit(index,kind==='business'?'noop':kind);setTimeout(next,60)};
next();
`;
  fs.writeFileSync(bin,source,{mode:0o755});
  return {dir,codexBin:bin,fifth,closed,after,delayed};
}

function actionCallsFixture(codes){
  const dir=fs.mkdtempSync(path.join(root,'action-calls-')),bin=path.join(dir,'fixture-worker.mjs'),after=path.join(dir,'after-actions');
  const source=`#!/usr/bin/env node
import fs from 'node:fs';
const codes=${JSON.stringify(codes)};
const after=${JSON.stringify(after)};
for(let i=0;i<codes.length;i++){
  const item={id:'action_'+i,type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code:codes[i]}};
  console.log(JSON.stringify({type:'item.started',item}));
  await new Promise(resolve=>setTimeout(resolve,150));
  console.log(JSON.stringify({type:'item.completed',item}));
}
fs.writeFileSync(after,'1');
process.exit(0);
`;
  fs.writeFileSync(bin,source,{mode:0o755});
  return {dir,codexBin:bin,after};
}

async function flush(){await new Promise(resolve=>setImmediate(resolve));}
function persistedEvents(dir){
  return fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>{assert.ok(Buffer.byteLength(line,'utf8')<=4096,`event exceeds 4096 bytes: ${Buffer.byteLength(line,'utf8')}`);return JSON.parse(line)});
}

test('send-button inspection stays in upload while an actual click is submit',()=>{
  const upload=`await chooser.setFiles(files); const send=tab.playwright.getByRole('button',{name:/发送提示词/}); const sendEnabled=await send.isEnabled();`;
  const menu=`await tab.playwright.locator('#composer-plus-btn').click(); await tab.playwright.getByText(/从电脑上传/).click(); await chooser.setFiles(files);`;
  const send=`const send=tab.playwright.getByRole('button',{name:/发送提示词/}); await send.click();`;
  assert.equal(browserToolStage(upload),'upload');
  assert.equal(browserToolStage(menu),'upload');
  assert.equal(browserToolStage(send),'submit');
});

test('browser call stages follow persisted lease lifecycle, not diagnostic source words',()=>{
  const readOnlyReady=`const ax=await tab.getAXState({emit:false}); const hasComposer=/prompt-textarea|composer/.test(String(ax)); const copy="uploading attachmentObserved prompt-textarea"; return {hasComposer,copy};`;
  const attach=`await chooser.setFiles(files); const observed=await tab.getAXState({emit:false});`;
  const readyCheck=`const ax=await tab.getAXState({emit:false}); return /prompt-textarea|composer/.test(String(ax));`;
  const generationPoll=`const ax=await tab.getAXState({emit:false}); return {composer:/composer/.test(String(ax)),text:"uploading"};`;
  assert.equal(browserToolStage(readOnlyReady,{leaseState:'created',manifestState:'accepted'}),'bootstrap');
  assert.equal(browserToolStage(attach,{leaseState:'uploading',manifestState:'accepted'}),'upload');
  assert.equal(browserToolStage(readyCheck,{leaseState:'uploaded',manifestState:'ready'}),'submit');
  assert.equal(browserToolStage(generationPoll,{leaseState:'generating',manifestState:'submitted'}),'wait_download');
  assert.equal(browserToolStage(`const send=tab.playwright.getByRole('button',{name:/发送提示词/}); await send.click();`,{leaseState:'uploading',manifestState:'accepted'}),'submit');
});

test('manifest submission-intent helper is not a browser budget call',async()=>{
  const run=fixture('intent-and-send');
  const result=await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  await flush();
  assert.equal(result.text,'');
  assert.equal(readBrowserToolBudget(run.dir),null);
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.browserToolCallCount,5);
  assert.equal(execution.browserBusinessCallCount,5);
  assert.deepEqual(execution.browserBusinessStageCounts,{bootstrap:3,upload:1,submit:1});
  assert.equal(execution.submissionIntentObserved,true);
});

test('required one-time CUA environment initialization does not consume bootstrap slots',async()=>{
  const run=fixture('initialization-budget');
  const result=await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  await flush();
  assert.equal(result.text,'');
  assert.equal(readBrowserToolBudget(run.dir),null);
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.browserToolCallCount,9);
  assert.equal(execution.browserBusinessCallCount,8);
  assert.equal(execution.browserInitializationCallCount,1);
  assert.deepEqual(execution.browserBusinessStageCounts,{bootstrap:3,upload:2,submit:1,wait_download:2});
});

test('persisted owned-tab lifecycle keeps AX diagnostics in their current stage and setFiles in upload',async()=>{
  const run=fixture('lifecycle-classification');
  const result=await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  await flush();
  assert.equal(result.text,'');
  assert.equal(readBrowserToolBudget(run.dir),null);
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.browserBusinessCallCount,5);
  assert.equal(execution.browserCleanupCallCount,1);
  assert.deepEqual(execution.browserBusinessStageCounts,{bootstrap:2,upload:1,submit:1,wait_download:1});
});

test('a repeated environment initialization call remains charged to bootstrap',async()=>{
  const run=fixture('repeated-initialization');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.stageName==='bootstrap'&&error.stageCount===4&&error.observedBusiness===4);
  const budget=readBrowserToolBudget(run.dir);
  assert.equal(budget.observedBusiness,4);
  assert.equal(budget.stageName,'bootstrap');
  assert.deepEqual(budget.stageCounts,{bootstrap:4});
});

test('four business calls plus one audited cleanup call pass and remain within separate slots',async()=>{
  const run=fixture('four-business-close');
  const result=await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  await flush();
  assert.equal(result.text,'');
  assert.equal(fs.existsSync(run.fifth),false);assert.equal(fs.existsSync(run.closed),true);assert.equal(fs.existsSync(run.after),true);
  assert.equal(readBrowserToolBudget(run.dir),null);
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.browserToolCallCount,5);assert.equal(execution.browserBusinessCallCount,4);assert.equal(execution.browserCleanupCallCount,1);assert.equal(execution.browserToolCallBudget,BROWSER_TOOL_BUSINESS_CALL_BUDGET);assert.equal(execution.browserToolCleanupBudget,BROWSER_TOOL_CLEANUP_CALL_BUDGET);assert.deepEqual(execution.browserToolStageBudgets,BROWSER_TOOL_STAGE_BUDGETS);assert.deepEqual(execution.browserBusinessStageCounts,{bootstrap:3,upload:1});assert.equal(execution.browserToolBudgetExceeded,false);
  persistedEvents(run.dir);
});

test('the fifth business call is terminated while cleanup is not counted as business',async()=>{
  const run=fixture('pre-intent');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.submissionIntentObserved===false&&error.observedBusiness===6&&error.stageName==='upload'&&error.stageCount===3);
  await flush();
  assert.equal(fs.existsSync(run.fifth),true);assert.equal(fs.existsSync(run.after),false);
  const budget=readBrowserToolBudget(run.dir);assert.deepEqual({errorCode:budget.errorCode,businessLimit:budget.businessLimit,cleanupLimit:budget.cleanupLimit,observedBusiness:budget.observedBusiness,observedCleanup:budget.observedCleanup,budgetKind:budget.budgetKind,stage:budget.stage,stageName:budget.stageName,stageCount:budget.stageCount,stageCounts:budget.stageCounts},{errorCode:'BROWSER_TOOL_BUDGET_EXCEEDED',businessLimit:8,cleanupLimit:1,observedBusiness:6,observedCleanup:0,budgetKind:'business',stage:'pre_submission_intent',stageName:'upload',stageCount:3,stageCounts:{bootstrap:3,upload:3}});
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));assert.equal(execution.browserToolCallCount,6);assert.equal(execution.browserBusinessCallCount,6);assert.equal(execution.browserCleanupCallCount,0);assert.equal(execution.browserToolBudgetExceeded,true);
  const events=persistedEvents(run.dir);assert.doesNotMatch(JSON.stringify(events),/A{100}|B{100}/);assert.ok(events.some(event=>event.type==='browser_tool_budget_exceeded'));
});

test('a close without the fixed marker and closing phase cannot use the cleanup slot',async()=>{
  const run=fixture('close-abuse');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.observedBusiness===4&&error.observedCleanup===0&&error.stageName==='bootstrap');
  const budget=readBrowserToolBudget(run.dir);assert.equal(budget.observedCleanup,0);assert.equal(budget.budgetKind,'business');assert.equal(budget.stageName,'bootstrap');
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));assert.equal(execution.browserCleanupCallCount,0);
});

test('pre-intent budget exhaustion becomes a safe retryable manifest failure',async()=>{
  const run=fixture('pre-intent',{lease:false}),reference=path.join(run.dir,'reference.png'),output=path.join(run.dir,'out.png');
  fs.writeFileSync(reference,'fixture-reference');
  await assert.rejects(dispatchChatGptWebJob({codexBin:run.codexBin,dir:run.dir,outputFile:output,prompt:'fixture',referenceFiles:[reference],timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.webManifest?.submitted===false&&error.webManifest?.preSubmissionFailure===true);
  const manifest=JSON.parse(fs.readFileSync(path.join(run.dir,'web-generation.json'),'utf8'));
  assert.equal(manifest.errorCode,'BROWSER_TOOL_BUDGET_EXCEEDED');assert.equal(manifest.submissionIntent,false);assert.equal(manifest.submitted,false);assert.equal(manifest.submissionUncertain,false);assert.equal(manifest.preSubmissionFailure,true);assert.equal(manifest.failureStage,'pre_submission_browser_budget');
});

test('budget exhaustion after submission intent is persisted as unknown and never as pre-submission failure',async()=>{
  const run=fixture('post-intent',{lease:false}),reference=path.join(run.dir,'reference.png'),output=path.join(run.dir,'out.png');
  fs.writeFileSync(reference,'fixture-reference');
  await assert.rejects(dispatchChatGptWebJob({codexBin:run.codexBin,dir:run.dir,outputFile:output,prompt:'fixture',referenceFiles:[reference],timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.webManifest?.submitted===true&&error.webManifest?.submissionUncertain===true);
  const manifest=JSON.parse(fs.readFileSync(path.join(run.dir,'web-generation.json'),'utf8'));
  assert.equal(manifest.errorCode,'BROWSER_TOOL_BUDGET_EXCEEDED');assert.equal(manifest.submissionIntent,true);assert.equal(manifest.submitted,true);assert.equal(manifest.submissionUncertain,true);assert.equal(manifest.preSubmissionFailure,false);assert.equal(manifest.failureStage,'post_submit_unknown');
  const budget=readBrowserToolBudget(run.dir);assert.equal(budget.submissionIntentObserved,true);assert.equal(budget.stage,'post_submission_intent');
});

test('an over-budget submit triggers parent interruption, with post-intent result treated as unknown',async()=>{
  const run=fixture('post-intent-delayed');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.terminationDeferred===false&&error.submissionIntentObserved===true&&/竞态.*不能据此证明该调用未执行/.test(error.message));
  assert.equal(fs.existsSync(run.delayed),false);
  assert.equal(fs.existsSync(run.after),false);
  const budget=readBrowserToolBudget(run.dir);
  assert.equal(budget.terminationDeferred,false);
  const events=persistedEvents(run.dir);
  assert.ok(events.some(event=>event.type==='browser_tool_budget_exceeded'&&event.terminationDeferred===false&&event.submissionIntentObserved===true));
});

test('one batch may call setFiles repeatedly for the single-select attachment path',async()=>{
  const run=actionCallsFixture(['const multiple=await chooser.isMultiple(); if(!multiple){for(const file of files) await chooser.setFiles([file]);}']);
  const result=await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  assert.equal(result.text,'');
  assert.equal(fs.existsSync(run.after),true);
  assert.equal(readBrowserToolBudget(run.dir),null);
});

test('a later CUA call cannot re-enter setFiles after the batch began',async()=>{
  const run=actionCallsFixture(['await chooser.setFiles(files);','await chooser.setFiles(files);']);
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.protectedAction==='setFiles'&&error.submissionIntentObserved===false);
  assert.equal(fs.existsSync(run.after),false);
  assert.equal(readBrowserToolBudget(run.dir).protectedAction,'setFiles');
});

test('one browser script cannot create more than one owned tab',async()=>{
  const run=fixture('duplicate-create');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.protectedAction==='createBrowserTab');
  assert.equal(fs.existsSync(run.after),false);
  assert.equal(readBrowserToolBudget(run.dir).protectedAction,'createBrowserTab');
});
