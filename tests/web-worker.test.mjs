import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {
  chatGptWebImagePrompt,
  dispatchChatGptWebJob,
  readWebManifest,
  webWorkerStatus,
} from '../server/chatgpt-web-provider.mjs';

const threadId='11111111-1111-4111-8111-111111111111';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-web-worker-'));
const previousConfig=process.env.WENDI_CHATGPT_WEB_WORKER_CONFIG;
const previousProbe=process.env.WENDI_CHATGPT_WEB_WORKER_PROBE_RESULT;
const previousCodexHome=process.env.CODEX_HOME;
const previousPlan=process.env.WENDI_TEST_PLAN_FILE;

function configFile(dir){
  const file=path.join(dir,'worker.json');
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,threadId,hostId:'local',verifiedAt:'2026-09-09T18:57:11+08:00'}));
  return file;
}

function installFakeCodex(dir,defaultMode=null){
  const file=path.join(dir,'fake-codex.mjs');
  if(defaultMode)fs.writeFileSync(path.join(dir,'mock-mode.txt'),defaultMode);
  fs.writeFileSync(file,`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='--mock-slow-browser'){
  const manifestFile=args[1],outputFile=args[2],traceFile=args[3],requestId=args[4];
  const base={schemaVersion:1,provider:'chatgpt-web-iab',requestId,conversationUrl:'https://chatgpt.com/c/mock',submitted:false};
  const write=value=>fs.writeFileSync(manifestFile,JSON.stringify(value));
  const acceptedAt=JSON.parse(fs.readFileSync(manifestFile,'utf8')).acceptedAt;
  const trace=fs.existsSync(traceFile)?JSON.parse(fs.readFileSync(traceFile,'utf8')):[];
  const traceStep=step=>{trace.push(step);if(traceFile)fs.writeFileSync(traceFile,JSON.stringify(trace));};
  setTimeout(()=>{traceStep('browser_prepare');write({...base,state:'submitted',accepted:true,submitted:true,acceptedAt,submittedAt:new Date().toISOString()});},120);
  setTimeout(()=>{fs.mkdirSync(path.dirname(outputFile),{recursive:true});fs.writeFileSync(outputFile,Buffer.from('mock-original-image'));traceStep('downloaded');write({...base,state:'downloaded',accepted:true,submitted:true,acceptedAt,artifactPath:path.resolve(outputFile),downloadedAt:new Date().toISOString()});process.exit(0);},150);
}else if(args[0]==='--mock-late-worker'){
  const manifestFile=args[1],requestId=args[2];
  const base={schemaVersion:1,provider:'chatgpt-web-iab',requestId,conversationUrl:'https://chatgpt.com/c/mock',submitted:false};
  setTimeout(()=>fs.writeFileSync(manifestFile,JSON.stringify({...base,state:'accepted',accepted:true,acceptedAt:new Date().toISOString()})),120);
  setTimeout(()=>process.exit(0),150);
}else{
const message=args[args.indexOf('--message')+1]||'';
const requestPath=message.match(/(\\/[^\\n ]+worker-request\\.json)/)?.[1];
if(!requestPath)process.exit(2);
const request=JSON.parse(fs.readFileSync(requestPath,'utf8'));
const manifestFile=request.manifestFile;
const workerDir=path.dirname(process.argv[1]);
const modeFile=path.join(workerDir,'mock-mode.txt');
const mode=fs.existsSync(modeFile)?fs.readFileSync(modeFile,'utf8').trim():(process.env.MOCK_WEB_WORKER_MODE||'no-accept');
const countFile=mode==='late-accept'?path.join(workerDir,'queue-count.txt'):process.env.MOCK_WEB_WORKER_COUNT;
if(countFile)fs.appendFileSync(countFile,'queue\\n');
const write=value=>fs.writeFileSync(manifestFile,JSON.stringify(value));
const base={schemaVersion:1,provider:'chatgpt-web-iab',requestId:request.requestId,conversationUrl:'https://chatgpt.com/c/mock',submitted:false};
if(mode==='slow-prep'){
  const instruction=fs.readFileSync(request.instructionFile,'utf8');
  const acceptedAt=instruction.indexOf('state=accepted');
  const browserPrepAt=instruction.indexOf('复用本任务已有的 chatgpt.com IAB 标签页');
  const traceFile=process.env.MOCK_WEB_WORKER_TRACE||path.join(workerDir,'protocol-trace.json');
  if(acceptedAt<0||browserPrepAt<0||acceptedAt>browserPrepAt){if(traceFile)fs.writeFileSync(traceFile,JSON.stringify(['invalid-order']));process.exit(3);}
  fs.writeFileSync(traceFile,JSON.stringify(['accepted']));
  write({...base,state:'accepted',accepted:true,acceptedAt:new Date().toISOString()});
  const worker=spawn(process.execPath,[process.argv[1],'--mock-slow-browser',manifestFile,request.outputFile,traceFile||'',request.requestId],{detached:true,stdio:'ignore'});
  worker.unref();
  process.exit(0);
}
if(mode==='wrong-order'){
  const traceFile=process.env.MOCK_WEB_WORKER_TRACE||path.join(workerDir,'protocol-trace.json');
  fs.writeFileSync(traceFile,JSON.stringify(['browser_prepare']));
  write({...base,state:'ready',accepted:false,submitted:false});
  process.exit(0);
}
if(mode==='late-accept'){
  const worker=spawn(process.execPath,[process.argv[1],'--mock-late-worker',manifestFile,request.requestId],{detached:true,stdio:'ignore'});
  worker.unref();
  process.exit(0);
}
if(mode==='no-accept')process.exit(0);
if(mode==='stale-accept'){
  write({...base,state:'accepted',requestId:'22222222-2222-4222-8222-222222222222',accepted:true,acceptedAt:new Date().toISOString()});
  process.exit(0);
}
if(mode==='accepted-only'){
  write({...base,state:'accepted',accepted:true,acceptedAt:new Date().toISOString()});
  process.exit(0);
}
if(mode==='matching'){
  write({...base,state:'accepted',accepted:true,acceptedAt:new Date().toISOString()});
  setTimeout(()=>write({...base,state:'submitted',accepted:true,acceptedAt:JSON.parse(fs.readFileSync(manifestFile,'utf8')).acceptedAt,submitted:true,submittedAt:new Date().toISOString()}),10);
  setTimeout(()=>{
    fs.mkdirSync(path.dirname(request.outputFile),{recursive:true});
    fs.writeFileSync(request.outputFile,Buffer.from('mock-original-image'));
    write({...base,state:'downloaded',accepted:true,acceptedAt:JSON.parse(fs.readFileSync(manifestFile,'utf8')).acceptedAt,submitted:true,artifactPath:path.resolve(request.outputFile),downloadedAt:new Date().toISOString()});
  },25);
  setTimeout(()=>process.exit(0),40);
}
}`);
  fs.chmodSync(file,0o755);
  return file;
}

function setTestEnv(dir){
  const config=configFile(dir);
  process.env.WENDI_CHATGPT_WEB_WORKER_CONFIG=config;
  process.env.WENDI_CHATGPT_WEB_WORKER_PROBE_RESULT=path.join(dir,'probe.json');
  process.env.CODEX_HOME=path.join(dir,'codex-home');
  delete process.env.WENDI_TEST_PLAN_FILE;
  return config;
}

function restoreEnv(){
  if(previousConfig===undefined)delete process.env.WENDI_CHATGPT_WEB_WORKER_CONFIG;
  else process.env.WENDI_CHATGPT_WEB_WORKER_CONFIG=previousConfig;
  if(previousProbe===undefined)delete process.env.WENDI_CHATGPT_WEB_WORKER_PROBE_RESULT;
  else process.env.WENDI_CHATGPT_WEB_WORKER_PROBE_RESULT=previousProbe;
  if(previousCodexHome===undefined)delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME=previousCodexHome;
  if(previousPlan===undefined)delete process.env.WENDI_TEST_PLAN_FILE;
  else process.env.WENDI_TEST_PLAN_FILE=previousPlan;
}

test.after(()=>{restoreEnv();fs.rmSync(root,{recursive:true,force:true});});

test('historical config and session evidence are not current worker readiness',()=>{
  const dir=fs.mkdtempSync(path.join(root,'status-'));
  setTestEnv(dir);
  const sessionDir=path.join(process.env.CODEX_HOME,'sessions','2026','09');
  fs.mkdirSync(sessionDir,{recursive:true});
  fs.writeFileSync(path.join(sessionDir,`${threadId}.jsonl`),'historical session only');
  const status=webWorkerStatus();
  assert.equal(status.ready,false);
  assert.equal(status.configured,true);
  assert.equal(status.historical,true);
});

test('fresh identity-bound verification is ready while stale or invalid evidence is not',()=>{
  const dir=fs.mkdtempSync(path.join(root,'readiness-'));
  const config=setTestEnv(dir);
  fs.writeFileSync(config,JSON.stringify({schemaVersion:1,threadId,hostId:'local',verifiedAt:new Date(Date.now()-1000).toISOString()}));
  const probe=process.env.WENDI_CHATGPT_WEB_WORKER_PROBE_RESULT;
  fs.writeFileSync(probe,JSON.stringify({schemaVersion:1,threadId,hostId:'local',ok:true,iabAvailable:true,chatgptLoggedIn:true,inputAvailable:true,checkedAt:new Date(Date.now()-1000).toISOString()}));
  let status=webWorkerStatus();
  assert.equal(status.ready,true);
  assert.equal(status.state,'verified-ready');
  assert.equal(status.threadId,threadId);
  assert.equal(status.probe?.source,'saved-result');
  assert.equal(status.probe?.action,'refresh-saved-only');
  assert.equal(status.probe?.executionAvailable,false);
  fs.writeFileSync(probe,JSON.stringify({schemaVersion:1,threadId,hostId:'local',ok:true,iabAvailable:true,chatgptLoggedIn:true,inputAvailable:true,checkedAt:new Date(Date.now()-16*60*1000).toISOString()}));
  status=webWorkerStatus();
  assert.equal(status.ready,false);
  assert.equal(status.state,'unknown');
  assert.equal(status.evidence,'stale');
  fs.writeFileSync(probe,JSON.stringify({schemaVersion:1,threadId:'22222222-2222-4222-8222-222222222222',hostId:'local',ok:true,iabAvailable:true,chatgptLoggedIn:true,inputAvailable:true,checkedAt:new Date().toISOString()}));
  status=webWorkerStatus();
  assert.equal(status.ready,false);
  assert.equal(status.state,'unknown');
  assert.equal(status.evidence,'identity-mismatch');
  fs.writeFileSync(probe,JSON.stringify({schemaVersion:1,threadId,hostId:'local',ok:false,iabAvailable:false,chatgptLoggedIn:true,inputAvailable:false,checkedAt:new Date().toISOString(),error:'IAB unavailable'}));
  status=webWorkerStatus();
  assert.equal(status.ready,false);
  assert.equal(status.evidence,'probe-failed');
  fs.writeFileSync(probe,JSON.stringify({schemaVersion:1,threadId,hostId:'local',ok:true,iabAvailable:true,chatgptLoggedIn:true,inputAvailable:true,checkedAt:new Date(Date.now()+60*1000).toISOString()}));
  status=webWorkerStatus();
  assert.equal(status.ready,false);
  assert.equal(status.evidence,'invalid-time');
  fs.writeFileSync(probe,JSON.stringify({schemaVersion:1,hostId:'local',ok:true,iabAvailable:true,chatgptLoggedIn:true,inputAvailable:true,checkedAt:new Date().toISOString()}));
  status=webWorkerStatus();
  assert.equal(status.ready,false);
  assert.equal(status.evidence,'missing');
});

test('worker readiness exposes saved-result refresh separately from a new probe',()=>{
  const dir=fs.mkdtempSync(path.join(root,'probe-contract-'));
  setTestEnv(dir);
  const status=webWorkerStatus();
  assert.equal(status.probe?.source,'saved-result');
  assert.equal(status.probe?.action,'refresh-saved-only');
  assert.equal(status.probe?.executionAvailable,false);
  assert.match(status.probe?.message||'',/只重读已保存/);
});

test('accepted manifests carry the request identity and prompt records worker acceptance',()=>{
  const dir=fs.mkdtempSync(path.join(root,'manifest-'));
  const manifest=path.join(dir,'web-generation.json');
  const requestId=crypto.randomUUID();
  fs.writeFileSync(manifest,JSON.stringify({provider:'chatgpt-web-iab',state:'accepted',requestId,accepted:true,submitted:false}));
  const parsed=readWebManifest(manifest);
  assert.equal(parsed.state,'accepted');
  assert.equal(parsed.requestId,requestId);
  assert.equal(parsed.accepted,true);
  assert.equal(parsed.submitted,false);
  const prompt=chatGptWebImagePrompt({outputFile:path.join(dir,'out.png'),manifestFile:manifest,prompt:'mock'});
  assert.match(prompt,/state=accepted/);
  assert.match(prompt,/requestId/);
});

test('CLI exit 0 without matching worker acceptance stops at the acceptance boundary',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'no-accept-'));
  setTestEnv(dir);
  const codexBin=installFakeCodex(dir);
  process.env.MOCK_WEB_WORKER_MODE='no-accept';
  await assert.rejects(
    dispatchChatGptWebJob({
      codexBin,
      workerConfigFile:path.join(dir,'worker.json'),
      dir:path.join(dir,'run'),
      outputFile:path.join(dir,'run','out.png'),
      prompt:'mock',
      timeoutMs:2000,
      queueTimeoutMs:1000,
      acceptTimeoutMs:50,
      pollIntervalMs:5,
    }),
    error=>error.code==='WEB_WORKER_NOT_ACCEPTED',
  );
  const manifest=readWebManifest(path.join(dir,'run','web-generation.json'));
  assert.equal(manifest.state,'queued');
  assert.equal(manifest.submitted,false);
});

test('late matching acceptance is retained without a second queue notification',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'late-accept-'));
  setTestEnv(dir);
  const codexBin=installFakeCodex(dir,'late-accept'),count=path.join(dir,'queue-count.txt');
  await assert.rejects(
    dispatchChatGptWebJob({
      codexBin,
      workerConfigFile:path.join(dir,'worker.json'),
      dir:path.join(dir,'run'),
      outputFile:path.join(dir,'run','out.png'),
      prompt:'mock',
      timeoutMs:2000,
      queueTimeoutMs:1000,
      acceptTimeoutMs:50,
      pollIntervalMs:5,
    }),
    error=>error.code==='WEB_WORKER_NOT_ACCEPTED',
  );
  await new Promise(resolve=>setTimeout(resolve,180));
  const manifest=readWebManifest(path.join(dir,'run','web-generation.json'));
  assert.equal(manifest.state,'accepted');
  assert.equal(manifest.submitted,false);
  assert.equal(fs.readFileSync(count,'utf8').trim().split('\n').length,1);
});

test('stale acceptance cannot advance a different request',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'stale-'));
  setTestEnv(dir);
  const codexBin=installFakeCodex(dir);
  process.env.MOCK_WEB_WORKER_MODE='stale-accept';
  await assert.rejects(
    dispatchChatGptWebJob({
      codexBin,
      workerConfigFile:path.join(dir,'worker.json'),
      dir:path.join(dir,'run'),
      outputFile:path.join(dir,'run','out.png'),
      prompt:'mock',
      timeoutMs:2000,
      queueTimeoutMs:1000,
      acceptTimeoutMs:50,
      pollIntervalMs:5,
    }),
    error=>error.code==='WEB_WORKER_NOT_ACCEPTED' && error.webManifest?.requestId==='22222222-2222-4222-8222-222222222222',
  );
});

test('accepted work gets the generation timeout instead of the acceptance timeout',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'accepted-only-'));
  setTestEnv(dir);
  const codexBin=installFakeCodex(dir);
  process.env.MOCK_WEB_WORKER_MODE='accepted-only';
  await assert.rejects(
    dispatchChatGptWebJob({
      codexBin,
      workerConfigFile:path.join(dir,'worker.json'),
      dir:path.join(dir,'run'),
      outputFile:path.join(dir,'run','out.png'),
      prompt:'mock',
      timeoutMs:300,
      queueTimeoutMs:1000,
      acceptTimeoutMs:100,
      pollIntervalMs:5,
    }),
    error=>error.code==='WEB_IMAGE_WAIT_TIMEOUT' && error.webManifest?.state==='accepted' && error.webManifest?.accepted===true,
  );
});

test('ready without an accepted receipt stays at the acceptance boundary',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'wrong-order-'));
  setTestEnv(dir);
  const codexBin=installFakeCodex(dir);
  process.env.MOCK_WEB_WORKER_MODE='wrong-order';
  await assert.rejects(
    dispatchChatGptWebJob({
      codexBin,
      workerConfigFile:path.join(dir,'worker.json'),
      dir:path.join(dir,'run'),
      outputFile:path.join(dir,'run','out.png'),
      prompt:'mock',
      timeoutMs:1000,
      queueTimeoutMs:1000,
      acceptTimeoutMs:100,
      pollIntervalMs:5,
    }),
    error=>error.code==='WEB_WORKER_NOT_ACCEPTED' && error.webManifest?.state==='ready' && error.webManifest?.accepted===false,
  );
});

test('matching acceptance advances through submission to the isolated downloaded artifact',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'matching-'));
  setTestEnv(dir);
  const codexBin=installFakeCodex(dir);
  process.env.MOCK_WEB_WORKER_MODE='matching';
  const result=await dispatchChatGptWebJob({
    codexBin,
    workerConfigFile:path.join(dir,'worker.json'),
    dir:path.join(dir,'run'),
    outputFile:path.join(dir,'run','out.png'),
    prompt:'mock',
    timeoutMs:2000,
    queueTimeoutMs:1000,
    acceptTimeoutMs:100,
    pollIntervalMs:5,
  });
  assert.equal(result.manifest.state,'downloaded');
  assert.equal(result.manifest.submitted,true);
  assert.equal(fs.existsSync(path.join(dir,'run','out.png')),true);
  assert.match(result.text,/out\.png/);
});

test('timely acceptance precedes slow browser preparation and continues past the acceptance boundary',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'slow-prep-'));
  setTestEnv(dir);
  const codexBin=installFakeCodex(dir,'slow-prep'),trace=path.join(dir,'protocol-trace.json');
  const result=await dispatchChatGptWebJob({
    codexBin,
    workerConfigFile:path.join(dir,'worker.json'),
    dir:path.join(dir,'run'),
    outputFile:path.join(dir,'run','out.png'),
    prompt:'mock',
    timeoutMs:2000,
    queueTimeoutMs:1000,
    acceptTimeoutMs:50,
    pollIntervalMs:5,
  });
  assert.equal(result.manifest.state,'downloaded');
  assert.deepEqual(JSON.parse(fs.readFileSync(trace,'utf8')).slice(0,2),['accepted','browser_prepare']);
});
