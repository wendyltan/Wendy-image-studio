import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {dispatchChatGptWebJob} from '../server/chatgpt-web-provider.mjs';
import {BROWSER_CLEANUP_MARKER,BROWSER_TOOL_BUSINESS_CALL_BUDGET,BROWSER_TOOL_CLEANUP_CALL_BUDGET,readBrowserToolBudget,runCodex} from '../server/bridge.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-browser-budget-'));

function fixture(mode){
  const dir=fs.mkdtempSync(path.join(root,`${mode}-`)),bin=path.join(dir,'fixture-worker.mjs'),fifth=path.join(dir,'fifth-business'),closed=path.join(dir,'cleanup-call'),after=path.join(dir,'after-budget');
  if(mode==='four-business-close'||mode==='close-abuse')fs.writeFileSync(path.join(dir,'owned-tab-lease.json'),JSON.stringify({schemaVersion:1,runId:path.basename(dir),requestId:'11111111-1111-4111-8111-111111111111',sessionName:'fixture',ownedTabId:'tab-fixture',createdAt:new Date().toISOString(),state:mode==='four-business-close'?'closing':'created',cleanupStatus:'open',cleanupVerifiedAt:null,cleanupError:null,kernelReset:false,updatedAt:new Date().toISOString()}));
  const source=`#!/usr/bin/env node
import fs from 'node:fs';
const mode=${JSON.stringify(mode)};
const fifth=${JSON.stringify(fifth)};
const closed=${JSON.stringify(closed)};
const after=${JSON.stringify(after)};
const marker=${JSON.stringify(BROWSER_CLEANUP_MARKER)};
const emit=(index,code='noop')=>{const item={id:'item_'+index,type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code},result:{content:[{type:'image',data:'data:image/png;base64:'+'A'.repeat(12000)}],_meta:{browser_use:{screenshot:{pageUrl:'https://chatgpt.com',tabId:'fixture',url:'data:image/png;base64:'+'B'.repeat(12000)}}}}};console.log(JSON.stringify({type:'item.started',item}));console.log(JSON.stringify({type:'item.completed',item}));};
const businessCode=index=>index===1&&mode==='post-intent'?'submission-intent':'noop';
const calls=mode==='four-business-close'?['business','business','business','business','close']:mode==='close-abuse'?['abuse','business','business','business','business']:['business','business','business','business','business'];
let index=0;
const next=()=>{const kind=calls[index];if(!kind){setTimeout(()=>{fs.writeFileSync(after,'1');process.exit(0)},800);return;}index+=1;if(index===5&&kind==='business')fs.writeFileSync(fifth,'1');if(kind==='close'){fs.writeFileSync(closed,'1');fs.writeFileSync(after,'1');emit(index,marker+'; await tab.close(); await execFile("owned-tab-lease","--state","closing");');setTimeout(()=>process.exit(0),120);return;}if(kind==='abuse')emit(index,'await tab.close();');else emit(index,businessCode(index));setTimeout(next,60)};
next();
`;
  fs.writeFileSync(bin,source,{mode:0o755});
  return {dir,codexBin:bin,fifth,closed,after};
}

async function flush(){await new Promise(resolve=>setImmediate(resolve));}
function persistedEvents(dir){
  return fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>{assert.ok(Buffer.byteLength(line,'utf8')<=4096,`event exceeds 4096 bytes: ${Buffer.byteLength(line,'utf8')}`);return JSON.parse(line)});
}

test('four business calls plus one audited cleanup call pass and remain within separate slots',async()=>{
  const run=fixture('four-business-close');
  const result=await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  await flush();
  assert.equal(result.text,'');
  assert.equal(fs.existsSync(run.fifth),false);assert.equal(fs.existsSync(run.closed),true);assert.equal(fs.existsSync(run.after),true);
  assert.equal(readBrowserToolBudget(run.dir),null);
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.browserToolCallCount,5);assert.equal(execution.browserBusinessCallCount,4);assert.equal(execution.browserCleanupCallCount,1);assert.equal(execution.browserToolCallBudget,BROWSER_TOOL_BUSINESS_CALL_BUDGET);assert.equal(execution.browserToolCleanupBudget,BROWSER_TOOL_CLEANUP_CALL_BUDGET);assert.equal(execution.browserToolBudgetExceeded,false);
  persistedEvents(run.dir);
});

test('the fifth business call is terminated while cleanup is not counted as business',async()=>{
  const run=fixture('pre-intent');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.submissionIntentObserved===false&&error.observedBusiness===BROWSER_TOOL_BUSINESS_CALL_BUDGET+1);
  await flush();
  assert.equal(fs.existsSync(run.fifth),true);assert.equal(fs.existsSync(run.after),false);
  const budget=readBrowserToolBudget(run.dir);assert.deepEqual({errorCode:budget.errorCode,businessLimit:budget.businessLimit,cleanupLimit:budget.cleanupLimit,observedBusiness:budget.observedBusiness,observedCleanup:budget.observedCleanup,budgetKind:budget.budgetKind,stage:budget.stage},{errorCode:'BROWSER_TOOL_BUDGET_EXCEEDED',businessLimit:4,cleanupLimit:1,observedBusiness:5,observedCleanup:0,budgetKind:'business',stage:'pre_submission_intent'});
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));assert.equal(execution.browserToolCallCount,5);assert.equal(execution.browserBusinessCallCount,5);assert.equal(execution.browserCleanupCallCount,0);assert.equal(execution.browserToolBudgetExceeded,true);
  const events=persistedEvents(run.dir);assert.doesNotMatch(JSON.stringify(events),/A{100}|B{100}/);assert.ok(events.some(event=>event.type==='browser_tool_budget_exceeded'));
});

test('a close without the fixed marker and closing phase cannot use the cleanup slot',async()=>{
  const run=fixture('close-abuse');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.observedBusiness===5&&error.observedCleanup===0);
  const budget=readBrowserToolBudget(run.dir);assert.equal(budget.observedCleanup,0);assert.equal(budget.budgetKind,'business');
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));assert.equal(execution.browserCleanupCallCount,0);
});

test('pre-intent budget exhaustion becomes a safe retryable manifest failure',async()=>{
  const run=fixture('pre-intent'),reference=path.join(run.dir,'reference.png'),output=path.join(run.dir,'out.png');
  fs.writeFileSync(reference,'fixture-reference');
  await assert.rejects(dispatchChatGptWebJob({codexBin:run.codexBin,dir:run.dir,outputFile:output,prompt:'fixture',referenceFiles:[reference],timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.webManifest?.submitted===false&&error.webManifest?.preSubmissionFailure===true);
  const manifest=JSON.parse(fs.readFileSync(path.join(run.dir,'web-generation.json'),'utf8'));
  assert.equal(manifest.errorCode,'BROWSER_TOOL_BUDGET_EXCEEDED');assert.equal(manifest.submissionIntent,false);assert.equal(manifest.submitted,false);assert.equal(manifest.submissionUncertain,false);assert.equal(manifest.preSubmissionFailure,true);assert.equal(manifest.failureStage,'pre_submission_browser_budget');
});

test('budget exhaustion after submission intent is persisted as unknown and never as pre-submission failure',async()=>{
  const run=fixture('post-intent'),reference=path.join(run.dir,'reference.png'),output=path.join(run.dir,'out.png');
  fs.writeFileSync(reference,'fixture-reference');
  await assert.rejects(dispatchChatGptWebJob({codexBin:run.codexBin,dir:run.dir,outputFile:output,prompt:'fixture',referenceFiles:[reference],timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.webManifest?.submitted===true&&error.webManifest?.submissionUncertain===true);
  const manifest=JSON.parse(fs.readFileSync(path.join(run.dir,'web-generation.json'),'utf8'));
  assert.equal(manifest.errorCode,'BROWSER_TOOL_BUDGET_EXCEEDED');assert.equal(manifest.submissionIntent,true);assert.equal(manifest.submitted,true);assert.equal(manifest.submissionUncertain,true);assert.equal(manifest.preSubmissionFailure,false);assert.equal(manifest.failureStage,'post_submit_unknown');
  const budget=readBrowserToolBudget(run.dir);assert.equal(budget.submissionIntentObserved,true);assert.equal(budget.stage,'post_submission_intent');
});
