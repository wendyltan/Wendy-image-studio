import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createProjectStore} from '../server/project-store.mjs';
import {createImageRecovery} from '../server/image-recovery.mjs';
import {dispatchChatGptWebJob,readWebManifest,WEB_IMAGE_PROVIDER} from '../server/chatgpt-web-provider.mjs';
import {generationDiagnosticSummary,readGenerationEvidence,pythonRun} from '../server/bridge.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-r6-offline-'));
const projectData=path.join(root,'projects');
const idPattern=/^[a-f0-9-]{36}$/;
const inside=(base,relative)=>{const rootPath=path.resolve(base),target=path.resolve(rootPath,String(relative));if(target!==rootPath&&!target.startsWith(rootPath+path.sep))throw new Error('path escapes root');return target;};
const jsonWrite=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=`${file}.tmp-${crypto.randomUUID()}`;fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,file);};

function fixtureExecutor(){
  const bin=path.join(root,'fixture-browser-executor.mjs');
  const script=`#!${process.execPath}
import crypto from 'node:crypto';
import fs from 'node:fs';
const args=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;
if(args[0]==='app-server'){process.exit(0)}
const out=args[args.indexOf('-o')+1],worker=JSON.parse(fs.readFileSync('worker-request.json','utf8'));
const manifest={schemaVersion:2,provider:worker.provider,transport:'direct-chrome',browser:'chrome',identitySchemaVersion:2,identityLocked:true,projectId:worker.projectId,projectVersion:worker.projectVersion,taskId:worker.taskId,target:worker.target,requestId:worker.requestId,runId:worker.runId,outputFile:worker.outputFile,state:'downloaded',accepted:true,submitted:true,submissionIntent:true,submissionUncertain:false,referenceCount:worker.referenceEntries.length,attachmentExpectedCount:worker.referenceEntries.length,attachmentObservedCount:worker.referenceEntries.length,attachmentPending:false,sendEnabled:true,conversationUrl:'https://chatgpt.com/c/r6-offline-fixture',artifactPath:worker.outputFile,createdAt:new Date().toISOString(),acceptedAt:new Date().toISOString(),readyAt:new Date().toISOString(),submittedAt:new Date().toISOString(),downloadedAt:new Date().toISOString()};
fs.writeFileSync(worker.outputFile,Buffer.from(${JSON.stringify(PNG.toString('base64'))},'base64'));
fs.writeFileSync(worker.manifestFile,JSON.stringify(manifest));
const bytes=fs.readFileSync(worker.outputFile),sha256=crypto.createHash('sha256').update(bytes).digest('hex'),src='https://chatgpt.com/backend-api/estuary/content?id=file_r6_fixture&sig=local-test';
const evidence={schemaVersion:2,source:'pageAssets',projectId:worker.projectId,projectVersion:worker.projectVersion,taskId:worker.taskId,target:worker.target,requestId:worker.requestId,runId:worker.runId,conversationUrl:manifest.conversationUrl,capturedAt:new Date().toISOString(),matchingStrategy:'exact-src',currentResult:{src,resultId:'file_r6_fixture',stableFileId:'file_r6_fixture',marker:'fixture-image'},inventory:{id:'inventory-r6-fixture',assetCount:1},exactMatchCount:1,matchedAssetIds:['asset-r6-fixture'],matchedAsset:{id:'asset-r6-fixture',kind:'image',contentType:'image/png',url:src,sourceUrl:src,role:'generated-result',isThumbnail:false,isPreview:false},bundle:{downloadedCount:1,failures:[],contentType:'image/png',path:'/mock/pageAssets/r6-fixture.png'},output:{path:worker.outputFile,bytes:bytes.length,format:'PNG',width:1,height:1,sha256}};
const text='<download_evidence>'+JSON.stringify(evidence)+'</download_evidence>';fs.writeFileSync(out,text);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
`;
  fs.writeFileSync(bin,script,{mode:0o755});fs.chmodSync(bin,0o755);return bin;
}

test('production provider evidence persists and identity-bound recovery attaches the original artifact',async t=>{
  const priorPlanFile=process.env.WENDI_TEST_PLAN_FILE;
  t.after(()=>{if(priorPlanFile!==undefined)process.env.WENDI_TEST_PLAN_FILE=priorPlanFile;});
  delete process.env.WENDI_TEST_PLAN_FILE;
  const store=createProjectStore({dataDir:projectData,idPattern,inside,jsonWrite,runningProjects:new Map(),webImageProvider:WEB_IMAGE_PROVIDER,webImageExecutorRole:'browser-executor'});
  const project=store.createProject({idea:'R6 隔离恢复整链测试',pageCount:1,workflowPreset:'balanced'});
  project.version=1;project.plan={title:'R6 fixture'};project.approved={version:1,hash:'fixture-plan-hash'};project.status='attention';project.lastFailure=null;
  const taskId=crypto.randomUUID(),target='第1页-第1格',runDir=path.join(store.projectDir(project.id),'.制作记录',`1790209999000-${crypto.randomUUID().slice(0,8)}-${target}`),outputFile=path.join(store.projectDir(project.id),'v1','素材',`${target}-source.png`),reference=path.join(store.projectDir(project.id),'v1','参考','reference.png');
  fs.mkdirSync(path.dirname(reference),{recursive:true});fs.writeFileSync(reference,PNG);fs.mkdirSync(path.dirname(outputFile),{recursive:true});
  const referenceBytes=fs.readFileSync(reference),referenceFiles=[{name:path.basename(reference),sizeBytes:referenceBytes.length,sha256:crypto.createHash('sha256').update(referenceBytes).digest('hex')}];
  fs.mkdirSync(runDir,{recursive:true});jsonWrite(path.join(runDir,'request.json'),{schemaVersion:2,provider:WEB_IMAGE_PROVIDER,projectId:project.id,projectVersion:project.version,taskId,target,expectedOutput:path.relative(store.projectDir(project.id),outputFile),referenceFiles});
  const task={id:taskId,kind:'image',target,status:'running',attempt:1,providerInvocationLimit:1,providerInvocations:1,projectVersion:project.version,startedAt:new Date().toISOString()};
  project.currentTask=task;project.tasks=[task];project.pending={key:target,file:outputFile,dir:runDir,prompt:'offline fixture prompt',refs:['reference.png'],inputFiles:[reference],provider:WEB_IMAGE_PROVIDER,taskId,projectId:project.id,projectVersion:project.version,at:new Date().toISOString()};
  store.saveProject(project);

  const codexBin=fixtureExecutor();
  const providerResult=await dispatchChatGptWebJob({codexBin,dir:runDir,outputFile,prompt:'为本地集成测试生成一张图',referenceFiles:[reference],timeoutMs:10000,model:'gpt-5.6-luna',reasoningEffort:'low'});
  const manifest=readWebManifest(path.join(runDir,'web-generation.json'));
  const downloadEvidence=JSON.parse(fs.readFileSync(path.join(runDir,'download-evidence.json'),'utf8'));
  assert.equal(manifest.state,'downloaded');assert.equal(manifest.submitted,true);assert.equal(manifest.requestId,providerResult.manifest.requestId);
  assert.equal(downloadEvidence.requestId,manifest.requestId);assert.equal(downloadEvidence.projectId,project.id);assert.equal(downloadEvidence.projectVersion,project.version);assert.equal(downloadEvidence.taskId,taskId);assert.equal(downloadEvidence.target,target);assert.equal(downloadEvidence.output.sha256,crypto.createHash('sha256').update(fs.readFileSync(outputFile)).digest('hex'));
  project.pending={...project.pending,requestId:manifest.requestId,accepted:true,submitted:true,referenceCount:manifest.referenceCount};project.currentTask={...task,requestId:manifest.requestId,accepted:true,submitted:true};project.tasks=[project.currentTask];store.saveProject(project);

  const panelKey='1-1',recordArtifact=(p,id,kind,file,dependsOn=[],extra={})=>{p.artifacts=[...(p.artifacts||[]).filter(item=>item.id!==id),{id,kind,file,dependsOn,valid:true,...extra}];},attachImageRecord=(p,record)=>{p.panels={...p.panels,[panelKey]:record};};
  const recovery=createImageRecovery({webImageProvider:WEB_IMAGE_PROVIDER,readGenerationEvidence,generationDiagnosticSummary,readWebManifest,pythonRun,jsonWrite,projectDir:store.projectDir,inside,saveProject:store.saveProject,job:async(p,_phase,run)=>run(),verifyApproval:p=>{if(p.approved?.version!==p.version)throw new Error('approval identity mismatch');},finishTask:(p,current,status,extra={})=>{if(current)Object.assign(current,{status,...extra,completedAt:new Date().toISOString()});if(p.currentTask?.id===current?.id)p.currentTask=current;},activity:(p,message)=>{p.message=message;store.saveProject(p);},invalidatePanelDownstream:()=>{},recordArtifact,attachImageRecord,artifactIdForImageKey:key=>`image:${key}`,panelKeyFromImageKey:()=>panelKey,sampleIndexFromKey:()=>null,sampleRepairCount:()=>{},definiteImageFailure:()=>null,failureMessage:()=>'',hasActive:()=>false});
  const reloaded=store.readProject(project.id);await recovery.recoverImage(reloaded);
  const persisted=store.readProject(project.id),panel=persisted.panels[panelKey],savedFile=inside(store.projectDir(project.id),panel.file);
  assert.equal(persisted.pending,null);assert.equal(persisted.currentTask.status,'recovered_local');assert.equal(panel.qa.status,'manual_review');assert.equal(panel.downloadEvidence.requestId,manifest.requestId);assert.equal(fs.existsSync(savedFile),true);
  const inspected=JSON.parse(await pythonRun(['info',savedFile]));assert.equal(inspected.width,1);assert.equal(inspected.height,1);assert.equal(downloadEvidence.output.sha256,crypto.createHash('sha256').update(fs.readFileSync(savedFile)).digest('hex'));
  const recoveryRecord=JSON.parse(fs.readFileSync(path.join(runDir,'result.json'),'utf8'));
  assert.equal(recoveryRecord.requestId,manifest.requestId);assert.equal(recoveryRecord.artifact,panel.file);assert.equal(recoveryRecord.projectId,project.id);
});
