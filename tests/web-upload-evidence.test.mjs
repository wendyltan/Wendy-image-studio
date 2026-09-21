import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeUploadEvidence,validateUploadEvidence,writeUploadEvidence,readUploadEvidence,uploadEvidenceFailureCode} from '../server/web-upload-evidence.mjs';
import {patchManifest} from '../server/run-manifest.mjs';
import {buildManifestCommands} from '../server/web-manifest-commands.mjs';
import {chatGptWebImagePrompt} from '../server/web-executor-instructions.mjs';

const names=['01-wendi.png','02-face.png'];
const complete={schemaVersion:1,source:'browser-upload',uploadMethod:'direct-button-testid',chooserEventObserved:true,chooserAttachedBeforeClick:true,attachmentExpected:2,attachmentObserved:2,attachmentNames:names,attachmentPending:false,sendEnabled:true,failureStage:null};

test('structured upload evidence accepts a complete ordered attachment gate',()=>{
  const result=validateUploadEvidence(complete,{expectedCount:2,expectedNames:names,requireComplete:true});
  assert.equal(result.ok,true);
  assert.deepEqual(result.evidence.attachmentNames,names);
});

test('upload evidence rejects a chooser waiter installed after the click',()=>{
  const result=validateUploadEvidence({...complete,chooserAttachedBeforeClick:false},{expectedCount:2,expectedNames:names,requireComplete:true});
  assert.equal(result.ok,false);
  assert(result.errors.some(error=>/点击前/.test(error)));
});

test('upload evidence rejects chip count, order, pending, or send ambiguity',()=>{
  const result=validateUploadEvidence({...complete,attachmentObserved:1,attachmentNames:[names[1]],attachmentPending:true,sendEnabled:false},{expectedCount:2,expectedNames:names,requireComplete:true});
  assert.equal(result.ok,false);
  assert(result.errors.some(error=>/数量|顺序|上传|发送/.test(error)));
});

test('upload evidence persists only normalized structured fields',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-upload-evidence-'));
  const written=writeUploadEvidence(dir,{...complete,attachmentNames:[...names,'']});
  const read=readUploadEvidence(dir);
  assert.deepEqual(read.attachmentNames,names);
  assert.equal(written.uploadMethod,'direct-button-testid');
  assert.equal(uploadEvidenceFailureCode(normalizeUploadEvidence({...complete,failureStage:'file-set'})),'FILE_SET_FAILED');
});

test('route A timeout plus route B 5/5 evidence unlocks ready, intent, and exactly one send transition',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-upload-fallback-state-'));
  const identity={projectId:'11111111-1111-4111-8111-111111111111',projectVersion:2,taskId:'22222222-2222-4222-8222-222222222222',target:'第6页-第1格',requestId:'33333333-3333-4333-8333-333333333333',runId:path.basename(dir),outputFile:path.join(dir,'out.png')};
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
  const record={schemaVersion:2,provider:'chatgpt-web-iab',transport:'direct-chrome',browser:'chrome',identitySchemaVersion:2,identityLocked:true,...identity};
  write(path.join(dir,'request.json'),{...record,expectedOutput:path.relative(path.resolve(dir,'..','..'),identity.outputFile)});
  write(path.join(dir,'worker-request.json'),{...record,manifestFile:path.join(dir,'web-generation.json'),referenceEntries:['01-wendi.png','02-face.png','03-scene.png','04-machine.png','05-base.png'].map(name=>({name,sizeBytes:1,sha256:'a'.repeat(64)}))});
  write(path.join(dir,'execution.json'),{schemaVersion:1,runId:identity.runId,state:'completed'});
  write(path.join(dir,'run-identity.json'),{schemaVersion:1,identitySchemaVersion:2,identityLocked:true,...identity});
  write(path.join(dir,'web-generation.json'),{...record,state:'queued',accepted:false,submitted:false,referenceCount:0});
  const manifestFile=path.join(dir,'web-generation.json');patchManifest({stage:'accepted',manifestFile,args:{}});
  const names5=['01-wendi.png','02-face.png','03-scene.png','04-machine.png','05-base.png'];
  const recovered={schemaVersion:1,source:'browser-upload',uploadMethod:'menu-fallback',chooserEventObserved:true,chooserAttachedBeforeClick:true,alternateRouteUsed:true,alternateRouteCount:1,attachmentExpected:5,attachmentObserved:5,attachmentNames:names5,attachmentPending:false,sendEnabled:true,failureStage:null};
  const gate=validateUploadEvidence(recovered,{expectedCount:5,expectedNames:names5,requireComplete:true});
  assert.equal(gate.ok,true);assert.equal(gate.evidence.failureStage,null);
  writeUploadEvidence(dir,recovered);
  const ready=patchManifest({stage:'ready',manifestFile,args:{conversationUrl:'https://chatgpt.com/c/fallback',referenceCount:5,attachmentExpectedCount:5,attachmentObservedCount:5,attachmentPending:false,sendEnabled:true,browserStage:'ready_to_send'}}).manifest;
  assert.equal(ready.state,'ready');assert.equal(ready.browserStage,'ready_to_send');assert.equal(ready.submissionIntent,undefined);
  const intent=patchManifest({stage:'submission-intent',manifestFile,args:{}}).manifest;
  assert.equal(intent.state,'ready');assert.equal(intent.submissionIntent,true);assert.equal(intent.submitted,false);assert.equal(intent.browserStage,'submission_intent_recorded');
  const commands=buildManifestCommands(manifestFile,{requestId:identity.requestId,sessionName:'🎨 温蒂生图-fallback'});
  const instruction=chatGptWebImagePrompt({outputFile:identity.outputFile,manifestFile,prompt:'fixture',referenceFiles:names5});
  assert(instruction.indexOf(commands.ready)<instruction.indexOf(commands.submissionIntent));
  assert.match(instruction,/紧接着的一个独立、最短 CUA 动作中点击一次/);
  assert.doesNotMatch(instruction,/A 的 timeout[^\n]*失败/);
  const sent=patchManifest({stage:'submitted',manifestFile,args:{conversationUrl:'https://chatgpt.com/c/fallback',submissionConfirmedBy:'fixture-positive-browser-evidence'}}).manifest;
  assert.equal(sent.state,'submitted');assert.equal(sent.submitted,true);assert.equal(sent.submissionIntent,true);
  assert.equal(JSON.parse(fs.readFileSync(manifestFile,'utf8')).submissionIntent,true);
});
