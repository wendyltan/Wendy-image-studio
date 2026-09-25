import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {dispatchChatGptWebJob} from '../server/chatgpt-web-provider.mjs';
import {BROWSER_CLEANUP_MARKER,BROWSER_TOOL_BUSINESS_CALL_BUDGET,BROWSER_TOOL_CLEANUP_CALL_BUDGET,BROWSER_TOOL_STAGE_BUDGETS,browserToolStage,readBrowserToolBudget,runCodex} from '../server/bridge.mjs';
import {chatGptWebImagePrompt} from '../server/web-executor-instructions.mjs';

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
const emitFalseIntentHelper=index=>{const item={id:'item_'+index,type:'command_execution',command:'node run-manifest.mjs failed --submission-intent false',aggregated_output:'{"ok":true,"stage":"failed","submissionIntent":false}'};console.log(JSON.stringify({type:'item.started',item}));console.log(JSON.stringify({type:'item.completed',item}));};
const calls=mode==='initialization-budget'?['init','create','navigation','entry','upload','upload','intent-helper','submit','download','download']:mode==='repeated-initialization'?['init','init','create','navigation','entry']:mode==='four-business-close'?['bootstrap','bootstrap','bootstrap','upload','close']:mode==='implicit-cleanup'?['bootstrap','bootstrap','bootstrap','upload','implicit-close']:mode==='implicit-close-abuse'?['bootstrap','bootstrap','bootstrap','upload','abuse']:mode==='marked-close-abuse'?['bootstrap','bootstrap','bootstrap','upload','abuse']:mode==='close-abuse'?['bootstrap','bootstrap','bootstrap','abuse','business']:mode==='lifecycle-classification'?['diagnostic-ax','entry-diagnostic','upload','submit','download','close']:mode==='single-select-upload'?['duplicate-action']:mode==='duplicate-upload'?['upload','duplicate-action']:mode==='duplicate-create'?['duplicate-action']:mode==='pre-intent'?['bootstrap','bootstrap','bootstrap','upload','upload','upload']:mode==='post-intent'||mode==='post-intent-delayed'?['bootstrap','bootstrap','bootstrap','intent-helper','submit','submit']:mode==='intent-and-send'?['bootstrap','bootstrap','bootstrap','upload','intent-helper','submit']:mode==='false-intent-helper'?['bootstrap','bootstrap','bootstrap','false-intent-helper']:['business','business','business','business','business'];
if(mode==='readiness-syntax-error-cleanup'){
  const item={id:'bootstrap-parse-error',type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code:'// WENDI_BROWSER_READINESS_GATE_V1\\nconst broken=(;'},result:{content:[{type:'text',text:"[6:197-6:198]: Expected ')'"}]}};
  console.log(JSON.stringify({type:'item.started',item}));
  console.log(JSON.stringify({type:'item.completed',item}));
  const cleanup={id:'cleanup-after-parse-error',type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code:'await tab.close()'},result:{content:[{type:'text',text:'closed'}]}};
  console.log(JSON.stringify({type:'item.completed',item:cleanup}));
  process.exit(0);
}
if(mode.startsWith('readiness-marker-oversized')){
  const evidence={marker:'WENDI_BROWSER_READY_V1',schemaVersion:1,ready:true,runId,ownedTabId:'tab-fixture',currentUrl:'https://chatgpt.com/',expectedUrl:'https://chatgpt.com/',imageCreationPath:'chat-composer',checks:{targetUrlMatches:true,loginRequired:false,profileLoaded:true,explicitChatMode:true,chatModeEnabled:true,chatModeSelected:true,chatModeActive:true,composerEnabled:true,attachmentEntryEnabled:true,imageCreationAvailable:true}};
  const code='/* '+'X'.repeat(950)+' */ // WENDI_BROWSER_READINESS_GATE_V1\\n globalThis.__wendiOwnedTab; globalThis.__wendiOwnedTabId; await tab.goto("https://chatgpt.com/"); const currentUrl=await tab.url(); await chatMode.check(); const ax=await tab.getAXState({emit:false});';
  const item={id:'readiness',type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{timeout_ms:30000,code},result:{content:[{type:'text',text:'WENDI_BROWSER_READY_V1:'+JSON.stringify(evidence)}],_meta:{browser_use:{largeDiagnostic:'D'.repeat(12000),screenshot:{pageUrl:'https://chatgpt.com/',tabId:'tab-fixture',url:'data:image/png;base64,'+'A'.repeat(12000)}}}}};
  console.log(JSON.stringify({type:'item.completed',item}));
  if(mode==='readiness-marker-oversized-followed-by-unready')console.log(JSON.stringify({type:'item.completed',item:{id:'readiness-unready',type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code:'const ax=await tab.getAXState({emit:false});'},result:{content:[{type:'text',text:'no readiness marker'}]}}}));
  await new Promise(resolve=>setTimeout(resolve,200));process.exit(0);
}
let index=0;
const next=()=>{const kind=calls[index];if(!kind){setTimeout(()=>{fs.writeFileSync(after,'1');process.exit(0)},800);return;}index+=1;if(kind!=='close'){const leaseFile=path.join(dir,'owned-tab-lease.json');const lease=JSON.parse(fs.readFileSync(leaseFile,'utf8'));lease.state=(kind==='upload'?'uploading':kind==='submit'?'uploaded':kind==='download'?'generating':kind==='implicit-close'||(mode==='implicit-close-abuse'&&kind==='abuse')||(mode==='marked-close-abuse'&&kind==='abuse')?'closing':'created');fs.writeFileSync(leaseFile,JSON.stringify(lease));if(mode==='lifecycle-classification'){const manifestFile=path.join(dir,'web-generation.json');let manifest={state:'accepted',submissionIntent:false,submitted:false};try{manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'))}catch{};if(kind==='submit')manifest.state='ready';if(kind==='download'){manifest.state='submitted';manifest.submissionIntent=true;manifest.submitted=true}fs.writeFileSync(manifestFile,JSON.stringify(manifest))}}if((index===5||index===6)&&kind==='business' || (mode==='pre-intent'&&index===6))fs.writeFileSync(fifth,'1');if(kind==='close'){const leaseFile=path.join(dir,'owned-tab-lease.json');const lease=JSON.parse(fs.readFileSync(leaseFile,'utf8'));lease.state='closing';fs.writeFileSync(leaseFile,JSON.stringify(lease));fs.writeFileSync(closed,'1');fs.writeFileSync(after,'1');emit(index,'/* '+marker+' --run-id "'+runId+'" --owned-tab-id "tab-fixture" --state closing */ const tab=globalThis.__wendiOwnedTab; let closed=false; try { await tab.close(); closed=true; } finally { nodeRepl.write(JSON.stringify({cleanupStatus:closed?"closed":"close_failed",ownedTabId:globalThis.__wendiOwnedTabId})); }');setTimeout(()=>process.exit(0),120);return;}if(kind==='implicit-close'){fs.writeFileSync(closed,'1');fs.writeFileSync(after,'1');emit(index,'let tab=globalThis.__wendiOwnedTab;if(!tab)throw new Error("owned tab missing");let closed=false;try{await tab.close();closed=true}finally{nodeRepl.write(JSON.stringify({cleanupStatus:closed?"closed":"close_failed",ownedTabId:globalThis.__wendiOwnedTabId}))}');setTimeout(()=>process.exit(0),120);return;}if(kind==='abuse')emit(index,mode==='implicit-close-abuse'?'let tab=globalThis.__wendiOwnedTab;if(!tab)throw new Error("owned tab missing");await tab.goto("https://chatgpt.com");await tab.close();':mode==='marked-close-abuse'?marker+'; let tab=globalThis.__wendiOwnedTab; await tab.goto("https://chatgpt.com"); await chooser.setFiles(files); await tab.close(); --run-id "'+runId+'" --owned-tab-id "tab-fixture" --state closing;':marker+'; await tab.close(); --run-id "'+runId+'" --owned-tab-id "tab-fixture" --state closing;');else if(kind==='intent-helper')emitIntentHelper(index);else if(kind==='false-intent-helper')emitFalseIntentHelper(index);else if(kind==='submit'&&mode==='post-intent-delayed'&&index===6){const item=emitStarted(index,'const send=tab.playwright.getByRole("button",{name:/发送提示词/}); await send.click();');setTimeout(()=>{emitCompleted(item);fs.writeFileSync(delayed,'1');next();},700);return;}else if(kind==='submit')emit(index,'const send=tab.playwright.getByRole("button",{name:/发送提示词/}); await send.click();');else if(kind==='duplicate-action'&&mode==='duplicate-upload')emit(index,'await chooser.setFiles(files); await chooser.setFiles(files);');else if(kind==='duplicate-action'&&mode==='duplicate-create')emit(index,'await cua.createBrowserTab("chrome",undefined,{sessionName:"one"}); await cua.createBrowserTab("chrome",undefined,{sessionName:"two"});');else if(kind==='upload'){uploadCallNumber+=1;emit(index,uploadCallNumber===1?'await chooser.setFiles(files); const send=tab.playwright.getByRole("button",{name:/发送提示词/}); const sendEnabled=await send.isEnabled();':'const observed=await tab.getAXState({emit:false}); const sendEnabled=/send/.test(String(observed));')}else if(kind==='init')emit(index,'await cua.getState()');else if(kind==='create')emit(index,'globalThis.__wendiOwnedTab=await cua.createBrowserTab("chrome",undefined,{sessionName:"fixture"})');else if(kind==='navigation')emit(index,'await tab.goto("https://chatgpt.com"); await tab.getAXState({emit:false})');else if(kind==='entry')emit(index,'login chat mode composer 创建图片');else if(kind==='download')emit(index,'const inventory=await pageAssets.list()');else if(kind==='diagnostic-ax')emit(index,'const ax=await tab.getAXState({emit:false}); const copy="prompt-textarea composer uploading"; return {ax,copy};');else if(kind==='entry-diagnostic')emit(index,'const ax=await tab.getAXState({emit:false}); const hasComposer=/prompt-textarea|composer/.test(String(ax));');else emit(index,kind==='business'?'noop':kind);setTimeout(next,60)};
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

function readinessContractFixture({drift=false,failed=false,cleanup=false}={}){
  const dir=fs.mkdtempSync(path.join(root,'readiness-contract-')),runId=path.basename(dir),bin=path.join(dir,'fixture-worker.mjs');
  const prompt=chatGptWebImagePrompt({outputFile:path.join(dir,'out.png'),manifestFile:path.join(dir,'web-generation.json'),prompt:'fixture',runId});
  const expected=prompt.match(/<bootstrap_cua_example>\n([\s\S]*?)\n<\/bootstrap_cua_example>/)?.[1];
  assert.ok(expected);
  const actual=drift?expected.replace('return name.toLocaleLowerCase() === label.toLocaleLowerCase();','return name.toLocaleLowerCase().includes(label.toLocaleLowerCase());'):expected;
  if(drift)assert.notEqual(actual,expected);
  const checks={targetUrlMatches:true,loginRequired:false,profileLoaded:true,explicitChatMode:true,chatModeEnabled:true,chatModeSelected:!failed,chatModeActive:!failed,composerEnabled:true,attachmentEntryEnabled:true,imageCreationAvailable:!failed};
  const readiness={marker:'WENDI_BROWSER_READY_V1',schemaVersion:1,ready:!failed,reason:failed?'ui_not_ready':null,currentUrl:'https://chatgpt.com/',expectedUrl:'https://chatgpt.com/',ownedTabId:'tab-fixture',runId,imageCreationPath:failed?null:'chat-composer',checks};
  const ax=failed?'WENDI_BROWSER_AX_V1:'+JSON.stringify({schemaVersion:1,controls:[{kind:'sidebar_filter',label:'筛选聊天和工作',observed:true,selected:false,disabled:false},{kind:'chat_mode',label:'聊天',observed:true,selected:true,disabled:false},{kind:'work_mode',label:'工作',observed:true,selected:false,disabled:false},{kind:'composer',label:'PRIVATE_PROMPT',observed:true,disabled:false},{kind:'attachment',label:'附件按钮',observed:true,disabled:false},{kind:'profile',label:'PRIVATE_ACCOUNT',observed:true,disabled:false}]})+'\n':'';
  const result=ax+'WENDI_BROWSER_READY_V1:'+JSON.stringify(readiness);
  const source=`#!/usr/bin/env node\nconst item=${JSON.stringify({id:'readiness-contract',type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code:actual},result:{content:[{type:'text',text:result}]}})};console.log(JSON.stringify({type:'item.started',item}));console.log(JSON.stringify({type:'item.completed',item}));${cleanup?`const close=${JSON.stringify({id:'cleanup-after-readiness',type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code:'await tab.close()'},result:{content:[{type:'text',text:'closed'}]}})};console.log(JSON.stringify({type:'item.completed',item:close}));`:''}`;
  fs.writeFileSync(bin,source,{mode:0o755});
  fs.writeFileSync(path.join(dir,'owned-tab-lease.json'),JSON.stringify({schemaVersion:1,runId,requestId:'11111111-1111-4111-8111-111111111111',sessionName:'fixture',ownedTabId:'tab-fixture',createdAt:new Date().toISOString(),state:'created',cleanupStatus:'open',cleanupVerifiedAt:null,cleanupError:null,kernelReset:false,updatedAt:new Date().toISOString()}));
  return {dir,codexBin:bin,prompt,expected,actual};
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

test('the known recoverable browser branches fit their bounded stage slots',()=>{
  const replays=[
    {stage:'bootstrap',leaseState:'creating',code:'globalThis.__wendiOwnedTab=await cua.createBrowserTab("chrome")'},
    {stage:'bootstrap',leaseState:'created',code:'try { await tab.goto(target); } catch {} const url=await tab.url(); const ax=await tab.getAXState({emit:false}); return {url,composer:/prompt-textarea/.test(String(ax))};'},
    {stage:'bootstrap',leaseState:'created',code:'const url=await tab.url(); const ax=await tab.getAXState({emit:false}); return {url,composer:/prompt-textarea/.test(String(ax))};'},
    {stage:'upload',leaseState:'uploading',code:'let chooser=await directButton.waitForChooser(); if(!chooser){ await plusButton.click(); const ax=await tab.getAXState({emit:false}); chooser=await uploadMenuItem.waitForChooser(); } if(!chooser) throw Error("no chooser"); for(const file of files) await chooser.setFiles([file]); const ax=await tab.getAXState({emit:false});'},
    {stage:'upload',leaseState:'uploading',code:'const ax=await tab.getAXState({emit:false}); return {attachmentObserved:5,attachmentPending:/uploading|处理中/.test(String(ax)),sendEnabled:false};'},
    {stage:'submit',leaseState:'uploaded',manifestState:'ready',code:'const send=tab.playwright.getByRole("button",{name:/发送提示词/}); await send.click();'},
    {stage:'wait_download',leaseState:'generating',manifestState:'submitted',code:'const inventory=await pageAssets.list(); if(!hasUniqueCurrentImage(inventory)){ await exactCurrentResult.click(); await pageAssets.list(); }'},
    {stage:'wait_download',leaseState:'generating',manifestState:'submitted',code:'const inventory=await pageAssets.list(); const candidate=selectExactCurrentResult(inventory); if(!candidate) throw Error("DOWNLOAD_FAILED");'},
  ];
  const counts={bootstrap:0,upload:0,submit:0,wait_download:0};
  for(const replay of replays){
    const stage=browserToolStage(replay.code,{leaseState:replay.leaseState,manifestState:replay.manifestState});
    assert.equal(stage,replay.stage,replay.code);
    counts[stage]+=1;
  }
  assert.deepEqual(counts,{bootstrap:3,upload:2,submit:1,wait_download:2});
  assert.equal(Object.values(counts).reduce((sum,count)=>sum+count,0),BROWSER_TOOL_STAGE_BUDGETS.total);
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

test('failed helper arguments containing submission-intent false do not prove a send',async()=>{
  const run=fixture('false-intent-helper');
  await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',timeoutMs:5000});
  await flush();
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.submissionIntentObserved,false);
});

test('oversized completed CUA output preserves only validated readiness marker evidence in bounded events',async()=>{
  const run=fixture('readiness-marker-oversized',{lease:false});
  let immediateEvidence=false;
  await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000,onEvent:event=>{if(event.type==='item.completed'&&event.item?.id==='readiness'){const sidecar=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-readiness-latest.json'),'utf8'));immediateEvidence=sidecar.itemId==='readiness'&&sidecar.browserReadinessEvidence?.complete===true;}}});
  assert.equal(immediateEvidence,true);
  const events=persistedEvents(run.dir),event=events.find(value=>value.item?.id==='readiness');
  assert.equal(event.truncated,true);
  assert.equal(event.item.timeout_ms,30000);
  assert.ok(event.item.resultText.length<=800);
  assert.deepEqual(event.item.browserReadinessEvidence,{complete:true,source:'cua_completed_result',marker:'WENDI_BROWSER_READY_V1',schemaVersion:1,ready:true,runId:path.basename(run.dir),ownedTabId:'tab-fixture',currentUrl:'https://chatgpt.com/',expectedUrl:'https://chatgpt.com/',imageCreationPath:'chat-composer',checks:{targetUrlMatches:true,loginRequired:false,profileLoaded:true,explicitChatMode:true,chatModeEnabled:true,chatModeSelected:true,chatModeActive:true,composerEnabled:true,attachmentEntryEnabled:true,imageCreationAvailable:true},sourceChecks:{gateMarkerPresent:true,gotoCount:1,createTabCount:0,axReadCount:1,urlReadCount:1,getTabCount:0,setFilesCount:0,clickCount:0,pasteCount:0,setValueCount:0,typeTextCount:0,pressKeyCount:0,checkCount:1,ownedHandleReferencePresent:true}});
  assert.doesNotMatch(event.item.code,/WENDI_BROWSER_READINESS_GATE_V1/);
  assert.doesNotMatch(JSON.stringify(event),/D{100}|A{100}/);
  assert.equal(fs.statSync(path.join(run.dir,'browser-readiness-latest.json')).mode&0o777,0o600);
});

test('later completed CUA call atomically clears an older readiness sidecar',async()=>{
  const run=fixture('readiness-marker-oversized-followed-by-unready',{lease:false});
  await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  const latest=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-readiness-latest.json'),'utf8'));
  assert.equal(latest.itemId,'readiness-unready');assert.equal(latest.browserReadinessEvidence,null);
  assert.equal(latest.lastReadinessDiagnostic.itemId,'readiness');
  assert.equal(latest.lastReadinessDiagnostic.ready,true);
});

test('bootstrap parse failure keeps its exact dispatched script and diagnostic after cleanup',async()=>{
  const run=fixture('readiness-syntax-error-cleanup',{lease:false});
  await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  const saved=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-bootstrap-script.json'),'utf8'));
  assert.equal(saved.code,'// WENDI_BROWSER_READINESS_GATE_V1\nconst broken=(;');
  assert.equal(saved.itemId,'bootstrap-parse-error');
  const latest=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-readiness-latest.json'),'utf8'));
  assert.equal(latest.itemId,'cleanup-after-parse-error');
  assert.equal(latest.browserReadinessEvidence,null);
  assert.match(latest.lastReadinessDiagnostic.resultText,/Expected '\)'/);
  assert.equal(latest.lastReadinessDiagnostic.itemId,'bootstrap-parse-error');
});

test('the exact dispatched bootstrap script retains its per-run expected hash and readiness evidence',async()=>{
  const run=readinessContractFixture();
  await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:run.prompt,image:true,browserMode:'chrome',role:'browser-executor',timeoutMs:5000});
  const expected=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-bootstrap-expected.json'),'utf8'));
  const actual=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-bootstrap-script.json'),'utf8'));
  const latest=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-readiness-latest.json'),'utf8'));
  assert.equal(expected.code,run.expected);
  assert.equal(expected.sha256,crypto.createHash('sha256').update(run.expected).digest('hex'));
  assert.equal(actual.code,run.actual);
  assert.equal(actual.matchesExpected,true);
  assert.equal(latest.browserReadinessEvidence?.sourceChecks?.scriptMatchesExpected,true);
});

test('a syntax-valid broad checkbox rewrite is recorded as drift and has no uploading evidence',async()=>{
  const run=readinessContractFixture({drift:true});
  await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:run.prompt,image:true,browserMode:'chrome',role:'browser-executor',timeoutMs:5000});
  const actual=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-bootstrap-script.json'),'utf8'));
  const latest=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-readiness-latest.json'),'utf8'));
  assert.equal(actual.code,run.actual);
  assert.equal(actual.matchesExpected,false);
  assert.equal(latest.browserReadinessEvidence,null);
  assert.equal(latest.lastReadinessDiagnostic.scriptMatchesExpected,false);
});

test('readiness failure keeps sanitized controls and hashes after a cleanup call',async()=>{
  const run=readinessContractFixture({failed:true,cleanup:true});
  await runCodex({codexBin:run.codexBin,dir:run.dir,prompt:run.prompt,image:true,browserMode:'chrome',role:'browser-executor',timeoutMs:5000});
  const latest=JSON.parse(fs.readFileSync(path.join(run.dir,'browser-readiness-latest.json'),'utf8'));
  assert.equal(latest.itemId,'cleanup-after-readiness');
  assert.equal(latest.browserReadinessEvidence,null);
  assert.equal(latest.lastReadinessDiagnostic.itemId,'readiness-contract');
  assert.equal(latest.lastReadinessDiagnostic.scriptMatchesExpected,true);
  assert.equal(latest.lastReadinessDiagnostic.runId,path.basename(run.dir));
  assert.equal(latest.lastReadinessDiagnostic.ownedTabId,'tab-fixture');
  assert.equal(latest.lastReadinessDiagnostic.controls[0].kind,'sidebar_filter');
  assert.equal(latest.lastReadinessDiagnostic.controls[1].kind,'chat_mode');
  assert.equal(latest.lastReadinessDiagnostic.controls[1].selected,true);
  assert.equal(latest.lastReadinessDiagnostic.readinessChecks.chatModeActive,false);
  assert.doesNotMatch(JSON.stringify(latest.lastReadinessDiagnostic),/PRIVATE_PROMPT|PRIVATE_ACCOUNT/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run.dir,'browser-bootstrap-expected.json'),'utf8')).code,run.expected);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run.dir,'browser-bootstrap-script.json'),'utf8')).code,run.actual);
  assert.equal(fs.statSync(path.join(run.dir,'browser-readiness-latest.json')).mode&0o777,0o600);
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

test('the observed owned-tab close script uses the cleanup slot',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'observed-close-'));
  const runId=path.basename(dir),ownedTabId='tab-fixture';
  fs.writeFileSync(path.join(dir,'owned-tab-lease.json'),JSON.stringify({schemaVersion:1,runId,requestId:'11111111-1111-4111-8111-111111111111',ownedTabId,state:'closing'}));
  const code=`// ${BROWSER_CLEANUP_MARKER}\nconst tab=globalThis.__wendiOwnedTab; const ownedTabId=globalThis.__wendiOwnedTabId; const runId="${runId}"; if(!tab||ownedTabId!=="${ownedTabId}") throw new Error("owned tab cleanup handle unavailable"); let cleanupStatus="close_failed"; try { await tab.close(); cleanupStatus="closed"; } finally { nodeRepl.write(JSON.stringify({cleanupStatus,ownedTabId})); }`;
  const bin=path.join(dir,'fixture-worker.mjs');
  fs.writeFileSync(bin,`#!/usr/bin/env node\nconst item=${JSON.stringify({id:'observed-close',type:'mcp_tool_call',server:'cua_repl',tool:'js',arguments:{code}})};\nconsole.log(JSON.stringify({type:'item.started',item}));\nconsole.log(JSON.stringify({type:'item.completed',item}));\n`);
  fs.chmodSync(bin,0o755);
  const result=await runCodex({codexBin:bin,dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000});
  assert.equal(result.text,'');
  const execution=JSON.parse(fs.readFileSync(path.join(dir,'execution.json'),'utf8'));
  assert.equal(execution.browserBusinessCallCount,0);
  assert.equal(execution.browserCleanupCallCount,1);
});

test('unmarked close with no source run/tab identity cannot use the cleanup exemption',async()=>{
  const run=fixture('implicit-cleanup');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.stageName==='bootstrap');
  await flush();
  assert.equal(readBrowserToolBudget(run.dir).observedCleanup,0);
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.browserBusinessCallCount,5);
  assert.equal(execution.browserCleanupCallCount,0);
  assert.deepEqual(execution.browserBusinessStageCounts,{bootstrap:4,upload:1});
});

test('closing lease does not authorize navigation mixed into an owned-tab close',async()=>{
  const run=fixture('implicit-close-abuse');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.observedBusiness===5&&error.observedCleanup===0);
  const budget=readBrowserToolBudget(run.dir);
  assert.equal(budget.observedCleanup,0);
  assert.equal(budget.budgetKind,'business');
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.browserCleanupCallCount,0);
});

test('fixed cleanup marker does not exempt scripts mixed with navigation or upload',async()=>{
  const run=fixture('marked-close-abuse');
  await assert.rejects(runCodex({codexBin:run.codexBin,dir:run.dir,prompt:'fixture',browserMode:'chrome',timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.observedBusiness===5&&error.observedCleanup===0);
  const budget=readBrowserToolBudget(run.dir);
  assert.equal(budget.observedCleanup,0);
  assert.equal(budget.budgetKind,'business');
  const execution=JSON.parse(fs.readFileSync(path.join(run.dir,'execution.json'),'utf8'));
  assert.equal(execution.browserCleanupCallCount,0);
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

test('pre-intent budget exhaustion keeps submission facts but does not claim a safe retry',async()=>{
  const run=fixture('pre-intent',{lease:false}),reference=path.join(run.dir,'reference.png'),output=path.join(run.dir,'out.png');
  fs.writeFileSync(reference,'fixture-reference');
  await assert.rejects(dispatchChatGptWebJob({codexBin:run.codexBin,dir:run.dir,outputFile:output,prompt:'fixture',referenceFiles:[reference],timeoutMs:5000}),error=>error.code==='BROWSER_TOOL_BUDGET_EXCEEDED'&&error.webManifest?.submitted===false&&error.webManifest?.preSubmissionFailure===true);
  const manifest=JSON.parse(fs.readFileSync(path.join(run.dir,'web-generation.json'),'utf8'));
  assert.equal(manifest.errorCode,'BROWSER_TOOL_BUDGET_EXCEEDED');assert.equal(manifest.submissionIntent,false);assert.equal(manifest.submitted,false);assert.equal(manifest.submissionUncertain,false);assert.equal(manifest.preSubmissionFailure,true);assert.equal(manifest.failureStage,'pre_submission_browser_budget');
  assert.match(manifest.error,/未记录发送意图.*竞态.*附件或发送状态无法核实.*禁止自动重试/);assert.doesNotMatch(manifest.error,/可安全重试/);
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
