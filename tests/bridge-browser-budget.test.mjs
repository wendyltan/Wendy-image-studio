import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {dispatchChatGptWebJob} from '../server/chatgpt-web-provider.mjs';
import {BROWSER_TOOL_CALL_BUDGET,readBrowserToolBudget,runCodex} from '../server/bridge.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-browser-budget-'));

function fixture(mode){
  const dir=fs.mkdtempSync(path.join(root,`${mode}-`)),bin=path.join(dir,'fixture-worker.mjs'),third=path.join(dir,'third-call'),fourth=path.join(dir,'fourth-call'),after=path.join(dir,'after-budget');
  const source=`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const dir=process.cwd();
const mode=${JSON.stringify(mode)};
const third=${JSON.stringify(third)};
const fourth=${JSON.stringify(fourth)};
const after=${JSON.stringify(after)};
const emit=(index,code='noop')=>{const item={id:'item_'+index,type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code},result:{content:[{type:'image',data:'data:image/png;base64,'+'A'.repeat(12000)}],_meta:{browser_use:{screenshot:{pageUrl:'https://chatgpt.com',tabId:'fixture',url:'data:image/png;base64,'+'B'.repeat(12000)}}}}};console.log(JSON.stringify({type:'item.started',item}));console.log(JSON.stringify({type:'item.completed',item}));};
const preparePostIntent=()=>{const req=JSON.parse(fs.readFileSync(path.join(dir,'worker-request.json'),'utf8')),manifest=JSON.parse(fs.readFileSync(req.manifestFile,'utf8'));fs.writeFileSync(req.manifestFile,JSON.stringify({...manifest,state:'ready',accepted:true,submitted:false,submissionIntent:true,submissionUncertain:false,preSubmissionFailure:false,conversationUrl:'https://chatgpt.com/c/budget-fixture',referenceCount:1,attachmentExpectedCount:1,attachmentObservedCount:1,attachmentPending:false,sendEnabled:true,browserStage:'submission_intent_recorded'}));};
let index=0;
const next=()=>{index+=1;if(mode==='post-intent'&&index===1)preparePostIntent();if(index===3)fs.writeFileSync(third,'1');if(index===4)fs.writeFileSync(fourth,'1');emit(index,index===1&&mode==='post-intent'?'submission-intent':'noop');if(index<4)setTimeout(next,60);else setTimeout(()=>{fs.writeFileSync(after,'1');process.exit(0)},800)};
next();
`;
  fs.writeFileSync(bin,source,{mode:0o755});
  return {dir,codexBin:bin,third,fourth,after};
}

async function flush(){await new Promise(resolve=>setImmediate(resolve));}

test('parent hard-stops the fourth browser js call and persists compact nested tool evidence',async()=>{
  const run=fixture('pre-intent');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.submissionIntentObserved===false&&error.observed===BROWSER_TOOL_CALL_BUDGET+1);
  await flush();
  assert.equal(fs.existsSync(run.third),true);
  assert.equal(fs.existsSync(run.fourth),true);
  assert.equal(fs.existsSync(run.after),false);
  const budget=readBrowserToolBudget(run.dir);assert.deepEqual({errorCode:budget.errorCode,limit:budget.limit,observed:budget.observed,submissionIntentObserved:budget.submissionIntentObserved,stage:budget.stage},{errorCode:'BROWSER_TOOL_BUDGET_EXCEEDED',limit:3,observed:4,submissionIntentObserved:false,stage:'pre_submission_intent'});
  const events=fs.readFileSync(path.join(run.dir,'events.jsonl'),'utf8');
  assert.doesNotMatch(events,/A{100}|B{100}/);
  assert.match(events,/browser_tool_budget_exceeded/);
  assert.ok(fs.statSync(path.join(run.dir,'events.jsonl')).size<30000);
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));assert.equal(execution.browserToolCallCount,4);assert.equal(execution.browserToolCallBudget,3);assert.equal(execution.browserToolBudgetExceeded,true);
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
