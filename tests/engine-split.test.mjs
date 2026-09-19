import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {applySavedArtifactQaOutcome,IMAGE_OUTCOME,SAVED_ARTIFACT_QA_MESSAGE,savedArtifactQaUnavailable} from '../server/image-lifecycle.mjs';
import {createTaskState,imageRetryState,retryableImageFailure} from '../server/task-state.mjs';
import {createImageRecovery} from '../server/image-recovery.mjs';

const PROVIDER='chatgpt-web-iab';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');

test('task state transitions keep currentTask and durable history aligned',()=>{
  const saved=[];const state=createTaskState({saveProject:project=>saved.push(structuredClone(project)),randomUUID:()=>`task-${saved.length+1}`,now:()=>`2026-09-20T00:00:0${saved.length}Z`});
  const project={id:'project-1',version:2,tasks:[],currentTask:null};
  const task=state.beginTask(project,'image','第1页-第1格',{provider:'test'});
  assert.equal(project.currentTask,task);assert.equal(task.projectVersion,2);assert.equal(project.tasks.length,1);
  state.markUnknown(project,task,{errorCode:'unknown_result'});
  assert.equal(project.currentTask.status,'unknown_result');assert.equal(project.currentTask.errorCode,'unknown_result');
  const next=state.beginTask(project,'review','第1页-第1格');state.markReviewRequired(project,next,{errorCode:'QA_UNAVAILABLE'});
  assert.equal(project.currentTask.status,'review_required');assert.equal(project.currentTask.errorCode,'QA_UNAVAILABLE');assert.equal(saved.length,4);
  state.applyProjectState(project,{status:'attention',message:'需要人工查看',pending:null});assert.equal(project.status,'attention');assert.equal(project.message,'需要人工查看');assert.equal(project.pending,null);
});

test('retry certainty never upgrades an unknown result to confirmed missing',()=>{
  const confirmed=new Set(['browser-unavailable','no-output']);
  const unknown={pending:{key:'第1页-第1格'},currentTask:{id:'t',target:'第1页-第1格',status:'unknown_result',providerInvocations:1},lastFailure:null};
  assert.equal(imageRetryState(unknown,confirmed).certainty,'unknown_result');assert.equal(retryableImageFailure(unknown,confirmed),null);
  const missing={pending:null,currentTask:{id:'t',target:'第1页-第1格',status:'failed_no_output',errorCode:'browser-unavailable',providerInvocations:0},lastFailure:null};
  assert.equal(imageRetryState(missing,confirmed).certainty,'confirmed_missing');assert.equal(retryableImageFailure(missing,confirmed).kind,'browser-unavailable');
});

test('saved artifact QA outcome is terminal and does not discard the original',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-lifecycle-')),file=path.join(temp,'image.png');fs.writeFileSync(file,PNG);
  const project={status:'generating',message:'生成中',error:null};const task={status:'running'};const record={file:'image.png',qa:{pass:null,status:'pending'}};let saved=0,finished=0;
  const outcome=savedArtifactQaUnavailable(new Error('QA transport stopped'),{artifact:file});
  applySavedArtifactQaOutcome({project,task,record,artifactFile:file,outcome,saveProject:()=>{saved++;},finishTask:(p,t,status,extra)=>{finished++;Object.assign(t,{status,...extra});},jsonWrite:(target,value)=>fs.writeFileSync(target,JSON.stringify(value)),});
  assert.equal(project.status,'attention');assert.equal(project.message,SAVED_ARTIFACT_QA_MESSAGE);assert.equal(task.status,IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED);assert.equal(record.qa.status,'unavailable');assert.equal(fs.existsSync(file),true);assert.equal(saved,1);assert.equal(finished,1);
});

test('orphan evidence requires the complete identity chain before explicit adoption',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-recovery-')),run=path.join(root,'.制作记录','run-1'),output=path.join(root,'v1','素材','image.png'),runId=path.basename(run),requestId=crypto.randomUUID(),taskId=crypto.randomUUID(),identity={projectId:crypto.randomUUID(),projectVersion:1,taskId,target:'样张-1',requestId,runId};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(run,{recursive:true});fs.writeFileSync(output,PNG);
  const base={schemaVersion:2,provider:PROVIDER,...identity};fs.writeFileSync(path.join(run,'request.json'),JSON.stringify({...base,expectedOutput:'v1/素材/image.png'}));fs.writeFileSync(path.join(run,'worker-request.json'),JSON.stringify({...base,outputFile:output,manifestFile:path.join(run,'web-generation.json')}));fs.writeFileSync(path.join(run,'execution.json'),JSON.stringify({runId}));fs.writeFileSync(path.join(run,'web-generation.json'),JSON.stringify({...base,state:'downloaded',accepted:true,submitted:true,artifactPath:output}));
  const recovery=createImageRecovery({webImageProvider:PROVIDER,readGenerationEvidence:()=>({}),generationDiagnosticSummary:()=>({}),readWebManifest:file=>JSON.parse(fs.readFileSync(file,'utf8')),pythonRun:async()=>JSON.stringify({format:'png',width:1,height:1}),jsonWrite:(file,value)=>fs.writeFileSync(file,JSON.stringify(value)),projectDir:()=>root,inside:(projectRoot,value)=>path.resolve(projectRoot,value)});
  const accepted=await recovery.inspectOrphanImageEvidence({dir:run,file:output,expected:identity});assert.equal(accepted.status,'recoverable_orphan');assert.equal(accepted.canAutoAdopt,false);assert.equal(accepted.integrity.format,'png');
  fs.writeFileSync(path.join(run,'request.json'),JSON.stringify({...base,expectedOutput:'v1/素材/image.png',requestId:crypto.randomUUID()}));const rejected=await recovery.inspectOrphanImageEvidence({dir:run,file:output,expected:identity});assert.equal(rejected.status,'not_recoverable');assert.equal(rejected.canAutoAdopt,false);assert(rejected.reasons.some(reason=>/requestId|不匹配/.test(reason)));
});
