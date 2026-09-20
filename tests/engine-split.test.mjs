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

test('external completed runs are adopted with an immutable evidence archive',async()=>{
  const sourceProject=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-adopt-source-')),targetProject=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-adopt-target-')),runId='1789874892759-c599ebd4-第1页-第1格',run=path.join(sourceProject,'.制作记录',runId),sourceImage=path.join(sourceProject,'v1','素材','source.png'),targetImage=path.join(targetProject,'v1','素材','adopted.png'),projectId=crypto.randomUUID(),taskId=crypto.randomUUID(),requestId=crypto.randomUUID(),conversationUrl='https://chatgpt.com/c/adopt-fixture';
  fs.mkdirSync(path.dirname(sourceImage),{recursive:true});fs.mkdirSync(run,{recursive:true});fs.writeFileSync(sourceImage,PNG);fs.writeFileSync(path.join(run,'prompt.txt'),'单幅独立原始漫画分镜图。');fs.writeFileSync(path.join(run,'events.jsonl'),'{}\n');fs.writeFileSync(path.join(run,'response.txt'),'fixture');
  const base={schemaVersion:2,provider:PROVIDER,projectId,projectVersion:1,taskId,target:'第1页-第1格',requestId,runId,identitySchemaVersion:2,identityLocked:true},createdAt='2026-09-20T01:00:00.000Z',downloadedAt='2026-09-20T01:05:00.000Z';
  const request={...base,attempt:1,expectedOutput:'v1/素材/source.png',referenceNames:[],promptSha256:'fixture-prompt',promptCharacters:10};
  const worker={...base,role:'browser-executor',executorModel:'gpt-5.6-luna',executorReasoningEffort:'low',outputFile:sourceImage,manifestFile:path.join(run,'web-generation.json'),referenceFiles:[]};
  const manifest={...base,outputFile:sourceImage,artifactPath:sourceImage,state:'downloaded',accepted:true,submitted:true,referenceCount:0,createdAt,acceptedAt:createdAt,readyAt:createdAt,submittedAt:createdAt,downloadedAt,conversationUrl,error:null,errorCode:null};
  const lock={...base,outputFile:sourceImage,expectedOutput:sourceImage,createdAt};
  const execution={schemaVersion:1,role:'browser-executor',model:'gpt-5.6-luna',reasoningEffort:'low',browserMode:'chrome',image:true,runId,startedAt:createdAt,state:'completed',endedAt:downloadedAt,exitCode:0,error:null};
  const output={path:sourceImage,bytes:PNG.length,format:'PNG',contentType:'image/png',width:1,height:1,sha256:crypto.createHash('sha256').update(PNG).digest('hex')};
  const evidence={schemaVersion:2,source:'pageAssets',projectId,projectVersion:1,taskId,requestId,runId,target:'第1页-第1格',conversationUrl,capturedAt:downloadedAt,matchingStrategy:'exact-src',currentResult:{src:'https://chatgpt.com/backend-api/estuary/content?id=file_adopt_fixture',resultId:'file_adopt_fixture',stableFileId:'file_adopt_fixture'},inventory:{id:'inventory-adopt-fixture',assetCount:1},exactMatchCount:1,matchedAssetIds:['asset-adopt-fixture'],matchedAsset:{id:'asset-adopt-fixture',kind:'image',name:'content',contentType:'image/png',url:'https://chatgpt.com/backend-api/estuary/content?id=file_adopt_fixture',sourceUrl:'https://chatgpt.com/backend-api/estuary/content?id=file_adopt_fixture',role:'generated-result',isThumbnail:false,isPreview:false},bundle:{downloadedCount:1,failures:[],requestedCount:1,contentType:'image/png',path:'/tmp/adopt-fixture'},output};
  const result={schemaVersion:2,provider:PROVIDER,projectId,projectVersion:1,taskId,target:'第1页-第1格',requestId,runId,acceptanceState:'downloaded',accepted:true,submitted:true,artifact:'v1/素材/source.png',integrity:{path:sourceImage,bytes:PNG.length,format:'PNG',contentType:'image/png',width:1,height:1,sha256:output.sha256},downloadEvidence:evidence,outcome:'image_path_reported',generationCompletedAt:createdAt,downloadedAt};
  for(const [name,value] of [['request.json',request],['worker-request.json',worker],['web-generation.json',manifest],['run-identity.json',lock],['execution.json',execution],['result.json',result],['download-evidence.json',evidence]])fs.writeFileSync(path.join(run,name),JSON.stringify(value));
  const project={id:projectId,version:1,approved:{version:1},plan:{pages:[{number:1,panels:[{references:[]}]}]},pending:null,panels:{},samples:[],artifacts:[],tasks:[],currentTask:null,pages:[],status:'paused'};let saves=0;
  const recovery=createImageRecovery({webImageProvider:PROVIDER,readGenerationEvidence:()=>({}),generationDiagnosticSummary:()=>({}),readWebManifest:file=>JSON.parse(fs.readFileSync(file,'utf8')),pythonRun:async()=>JSON.stringify({format:'png',width:1,height:1}),jsonWrite:(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));},projectDir:()=>targetProject,inside:(root,value)=>path.resolve(root,value),saveProject:()=>{saves++;},job:()=>{},verifyApproval:()=>{},finishTask:(p,t,status,extra)=>{Object.assign(t,{status,...extra});saves++;},activity:()=>{},invalidatePanelDownstream:()=>{},recordArtifact:(p,id,kind,file,dependsOn,extra)=>{p.artifacts.push({id,kind,file,dependsOn,valid:true,...extra});},attachImageRecord:(p,record)=>{p.panels['1-1']=record;},artifactIdForImageKey:()=> 'image:第1页-第1格',panelKeyFromImageKey:()=> '1-1',sampleIndexFromKey:()=>null,sampleRepairCount:()=>{},definiteImageFailure:()=>null,failureMessage:()=>'',hasActive:()=>false});
  const adopted=await recovery.adoptRecoveredRun(project,{sourceDir:run,sourceFile:sourceImage,targetFile:targetImage,target:'第1页-第1格',expectedSha256:output.sha256});
  assert.equal(adopted.integrity.sha256,output.sha256);assert.equal(adopted.task.status,'recovered_local');assert.equal(adopted.record.qa.status,'manual_review');assert.equal(project.pending,null);assert.equal(project.panels['1-1'].file,path.relative(targetProject,targetImage));assert.equal(project.artifacts[0].file,path.relative(targetProject,targetImage));assert.equal(project.recoveryImports[0].sourceTempPath,run);assert.ok(saves>0);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(targetImage)).digest('hex'),output.sha256);
  const importedRun=path.join(targetProject,'.制作记录',runId),importMeta=JSON.parse(fs.readFileSync(path.join(importedRun,'import.json'),'utf8')),importedEvidence=JSON.parse(fs.readFileSync(path.join(importedRun,'download-evidence.json'),'utf8')),importedManifest=JSON.parse(fs.readFileSync(path.join(importedRun,'web-generation.json'),'utf8'));
  assert.equal(importMeta.sourceTempPath,run);assert.equal(importedEvidence.output.path,targetImage);assert.equal(importedManifest.state,'downloaded');assert.equal(importedManifest.submitted,true);assert.equal(fs.readFileSync(path.join(importedRun,'source-evidence','download-evidence.json'),'utf8'),fs.readFileSync(path.join(run,'download-evidence.json'),'utf8'));
});
