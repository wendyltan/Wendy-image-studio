import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {inspectDownloadArtifact} from '../server/web-download-evidence.mjs';
import {NATIVE_DOWNLOAD_EVIDENCE_FILE,validateNativeDownloadEvidence,inspectNativeDownloadEvidence,writeNativeDownloadEvidence,writePageAssetsAudit} from '../server/native-download-evidence.mjs';
import {patchManifest} from '../server/run-manifest.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-native-download-'));
const CONVERSATION='https://chatgpt.com/c/native-download-fixture';
const SUBMITTED='2026-09-21T07:09:55.033Z';
const DOWNLOADED='2026-09-21T07:21:20.000Z';

function json(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
function fixture({manifestState='failed',submitted=true,submissionUncertain=true}={}){
  const projectRoot=fs.mkdtempSync(path.join(ROOT,'project-')),runId=`run-${crypto.randomUUID()}`,runDir=path.join(projectRoot,'.制作记录',runId),output=path.join(projectRoot,'v2','素材','第6页-第1格.png');
  const identity={projectId:crypto.randomUUID(),projectVersion:2,taskId:crypto.randomUUID(),target:'第6页-第1格',requestId:crypto.randomUUID(),runId};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(runDir,{recursive:true});fs.writeFileSync(output,PNG);
  const common={schemaVersion:2,provider:'chatgpt-web-iab',transport:'direct-chrome',browser:'chrome',identitySchemaVersion:2,identityLocked:true,...identity};
  const request={...common,attempt:1,expectedOutput:path.relative(projectRoot,output),outputFile:output,createdAt:'2026-09-21T07:07:51.000Z'};
  const worker={...common,role:'browser-executor',executorModel:'gpt-5.6-luna',executorReasoningEffort:'low',outputFile:output,manifestFile:path.join(runDir,'web-generation.json'),ownedTabId:'native-tab-1'};
  const manifest={...common,outputFile:output,state:manifestState,accepted:manifestState!=='queued',submitted,submissionIntent:submitted,submissionUncertain:submitted&&submissionUncertain,preSubmissionFailure:!submitted,referenceCount:5,ownedTabId:'native-tab-1',conversationUrl:CONVERSATION,submittedAt:submitted?SUBMITTED:null,acceptedAt:'2026-09-21T07:08:12.000Z',readyAt:'2026-09-21T07:09:54.000Z',errorCode:manifestState==='failed'?'SUBMISSION_UNCERTAIN':null,error:manifestState==='failed'?'提交后的结果未知':null,failedAt:manifestState==='failed'?'2026-09-21T07:10:00.000Z':null};
  const execution={schemaVersion:1,runId,state:manifestState==='failed'?'failed':'completed',startedAt:'2026-09-21T07:07:51.000Z',endedAt:'2026-09-21T07:10:00.000Z'};
  const lock={schemaVersion:1,identitySchemaVersion:2,identityLocked:true,...identity,outputFile:output};
  json(path.join(runDir,'request.json'),request);json(path.join(runDir,'worker-request.json'),worker);json(path.join(runDir,'web-generation.json'),manifest);json(path.join(runDir,'execution.json'),execution);json(path.join(runDir,'run-identity.json'),lock);json(path.join(runDir,'result.json'),{schemaVersion:2,provider:common.provider,...identity,outcome:'artifact_not_located'});fs.writeFileSync(path.join(runDir,'events.jsonl'),'');
  const actual=inspectDownloadArtifact(output),evidence={schemaVersion:1,source:'chrome-native-download',transport:'direct-chrome',browser:'chrome',...identity,conversationUrl:CONVERSATION,submittedAt:SUBMITTED,downloadedAt:DOWNLOADED,capturedAt:DOWNLOADED,native:{method:'chrome-download',ownedTabId:'native-tab-1',fileName:path.basename(output),downloadedAt:DOWNLOADED},output:{path:output,bytes:actual.bytes,format:actual.format,contentType:actual.contentType,width:actual.width,height:actual.height,sha256:actual.sha256}};
  writeNativeDownloadEvidence(runDir,evidence);
  return {projectRoot,runDir,output,identity,manifestFile:path.join(runDir,'web-generation.json'),evidence,actual};
}

function promote(run){return patchManifest({stage:'native-download-recovery',manifestFile:run.manifestFile,args:{nativeEvidenceFile:path.join(run.runDir,NATIVE_DOWNLOAD_EVIDENCE_FILE)}});}

function pageAssetsEvidence(run){
  const requestFile=path.join(run.runDir,'request.json'),manifestFile=run.manifestFile;
  const request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const attachmentNames=['character-a.jpg','character-b.jpg','room.jpg','continuity-a.jpg','continuity-b.jpg','edit-base.jpg'];
  Object.assign(request,{remotePromptLength:1651,remotePromptSha256:'a'.repeat(64)});
  Object.assign(manifest,{attachmentExpectedCount:6,attachmentObservedCount:6,referenceCount:6});
  json(requestFile,request);json(manifestFile,manifest);
  const assetId='file_00000000e3b0820a8a31dbe23391a343',assetUrl=`https://chatgpt.com/backend-api/estuary/content?id=${assetId}&ts=497280&p=fs&cid=1&sig=proof&v=0`;
  run.evidence={...run.evidence,source:'chrome-page-assets',remoteResult:{buttonLabel:'已生成图片：夜灯下的温馨书桌时光',assetId,assetUrl,width:run.actual.width,height:run.actual.height,bytes:run.actual.bytes,sha256:run.actual.sha256,observedAt:DOWNLOADED,observedInTabId:'recovery-tab-1',userMessage:{promptLength:1651,promptSha256:'a'.repeat(64),attachmentCount:6,attachmentNames,assistantResultImmediatelyAfter:true}},native:{method:'page-assets',ownedTabId:'recovery-tab-1',recoveryTabId:'recovery-tab-1',originalOwnedTabId:'native-tab-1',recoveryTabClosed:true,closedAt:DOWNLOADED,fileName:path.basename(run.output),downloadedAt:DOWNLOADED,sourceAssetId:assetId,sourceAssetUrl:assetUrl},pageAssets:{inventoryId:'baea2ab7-47f2-4d97-ba3a-2a56cc4dd2c4',matchedAsset:{id:'471042be8a7bc510',kind:'image',name:'content',sourceUrl:assetUrl,unavailableFields:['isThumbnail','isPreview','role']},bundle:{requestedCount:1,downloadedCount:1,failedCount:0,failures:[],assetId:'471042be8a7bc510',assetUrl,contentType:'image/png',bytes:run.actual.bytes,sha256:run.actual.sha256}}};
  writeNativeDownloadEvidence(run.runDir,run.evidence);
  return run;
}

test('native Chrome download evidence promotes one submitted unknown result',()=>{
  const run=fixture(),check=validateNativeDownloadEvidence(run.evidence,{expectedIdentity:run.identity,projectRoot:run.projectRoot,request:JSON.parse(fs.readFileSync(path.join(run.runDir,'request.json'))),worker:JSON.parse(fs.readFileSync(path.join(run.runDir,'worker-request.json'))),manifest:JSON.parse(fs.readFileSync(run.manifestFile)),execution:JSON.parse(fs.readFileSync(path.join(run.runDir,'execution.json'))),outputFile:run.output,actual:run.actual});
  assert.equal(check.ok,true,check.errors.join('; '));
  const result=promote(run).manifest;assert.equal(result.state,'downloaded');assert.equal(result.submitted,true);assert.equal(result.recoveredFrom,'native-download');assert.equal(result.priorState,'failed');assert.equal(result.priorErrorCode,'SUBMISSION_UNCERTAIN');assert.equal(result.artifactPath,run.output);assert.equal(result.downloadedAt,DOWNLOADED);
});

test('page-assets recovery binds a new closed tab to the exact submitted result',()=>{
  const run=pageAssetsEvidence(fixture()),request=JSON.parse(fs.readFileSync(path.join(run.runDir,'request.json'))),manifest=JSON.parse(fs.readFileSync(run.manifestFile)),execution=JSON.parse(fs.readFileSync(path.join(run.runDir,'execution.json')));
  const check=validateNativeDownloadEvidence(run.evidence,{expectedIdentity:run.identity,projectRoot:run.projectRoot,request,worker:JSON.parse(fs.readFileSync(path.join(run.runDir,'worker-request.json'))),manifest,execution,outputFile:run.output,actual:run.actual});
  assert.equal(check.ok,true,check.errors.join('; '));
  assert.notEqual(run.evidence.native.recoveryTabId,run.evidence.native.originalOwnedTabId);
});

test('page-assets recovery requires the durable inventory and bundle summary',()=>{
  const run=pageAssetsEvidence(fixture()),request=JSON.parse(fs.readFileSync(path.join(run.runDir,'request.json'))),manifest=JSON.parse(fs.readFileSync(run.manifestFile)),execution=JSON.parse(fs.readFileSync(path.join(run.runDir,'execution.json'))),worker=JSON.parse(fs.readFileSync(path.join(run.runDir,'worker-request.json')));
  delete run.evidence.pageAssets.bundle;writeNativeDownloadEvidence(run.runDir,run.evidence);
  const check=validateNativeDownloadEvidence(run.evidence,{expectedIdentity:run.identity,projectRoot:run.projectRoot,request,worker,manifest,execution,outputFile:run.output,actual:run.actual});
  assert.equal(check.ok,false);assert.match(check.errors.join('; '),/bundle 摘要/);
});

test('page-assets audit cross-checks bundle bytes and MIME',()=>{
  const run=pageAssetsEvidence(fixture()),request=JSON.parse(fs.readFileSync(path.join(run.runDir,'request.json'))),manifest=JSON.parse(fs.readFileSync(run.manifestFile)),execution=JSON.parse(fs.readFileSync(path.join(run.runDir,'execution.json'))),worker=JSON.parse(fs.readFileSync(path.join(run.runDir,'worker-request.json')));
  run.evidence.pageAssets.bundle.contentType='image/jpeg';run.evidence.pageAssets.bundle.bytes+=1;writeNativeDownloadEvidence(run.runDir,run.evidence);
  const check=validateNativeDownloadEvidence(run.evidence,{expectedIdentity:run.identity,projectRoot:run.projectRoot,request,worker,manifest,execution,outputFile:run.output,actual:run.actual});
  assert.equal(check.ok,false);assert.match(check.errors.join('; '),/bundle\.(bytes|contentType)/);
});

test('page-assets metadata accepts explicit non-preview flags and rejects preview flags',()=>{
  const checkRun=(mutate)=>{
    const run=pageAssetsEvidence(fixture()),request=JSON.parse(fs.readFileSync(path.join(run.runDir,'request.json'))),manifest=JSON.parse(fs.readFileSync(run.manifestFile)),execution=JSON.parse(fs.readFileSync(path.join(run.runDir,'execution.json'))),worker=JSON.parse(fs.readFileSync(path.join(run.runDir,'worker-request.json')));
    mutate(run.evidence.pageAssets.matchedAsset);
    return validateNativeDownloadEvidence(run.evidence,{expectedIdentity:run.identity,projectRoot:run.projectRoot,request,worker,manifest,execution,outputFile:run.output,actual:run.actual});
  };
  const accepted=checkRun(asset=>{asset.isThumbnail=false;asset.isPreview=false;asset.role='generated-result';delete asset.unavailableFields;});
  assert.equal(accepted.ok,true,accepted.errors.join('; '));
  for(const mutate of [asset=>{asset.isThumbnail=true;delete asset.unavailableFields;},asset=>{asset.isPreview=true;delete asset.unavailableFields;},asset=>{asset.role='preview';delete asset.unavailableFields;}]){
    const rejected=checkRun(mutate);assert.equal(rejected.ok,false);assert.match(rejected.errors.join('; '),/非预览|缩略|preview|isThumbnail|isPreview/);
  }
});

test('inspect reads a same-run external page-assets audit without rewriting history',()=>{
  const run=pageAssetsEvidence(fixture()),pageAssets=run.evidence.pageAssets,evidence=structuredClone(run.evidence);delete evidence.pageAssets;
  const evidenceFile=writeNativeDownloadEvidence(run.runDir,evidence),sourceEvidenceSha256=crypto.createHash('sha256').update(fs.readFileSync(evidenceFile)).digest('hex');
  writePageAssetsAudit(run.runDir,{schemaVersion:1,source:'chrome-page-assets-audit',transport:'direct-chrome',browser:'chrome',...run.identity,conversationUrl:evidence.conversationUrl,sourceEvidenceFile:NATIVE_DOWNLOAD_EVIDENCE_FILE,sourceEvidenceSha256,pageAssets});
  const checked=inspectNativeDownloadEvidence(evidenceFile,{expectedIdentity:run.identity,projectRoot:run.projectRoot,request:JSON.parse(fs.readFileSync(path.join(run.runDir,'request.json'))),worker:JSON.parse(fs.readFileSync(path.join(run.runDir,'worker-request.json'))),manifest:JSON.parse(fs.readFileSync(run.manifestFile)),execution:JSON.parse(fs.readFileSync(path.join(run.runDir,'execution.json'))),outputFile:run.output});
  assert.equal(checked.ok,true,checked.errors.join('; '));assert.equal(checked.pageAssetsAudit.sourceEvidenceSha256,sourceEvidenceSha256);
});

test('page-assets recovery rejects an unbound result or original-tab spoof',()=>{
  const run=pageAssetsEvidence(fixture());run.evidence.remoteResult.userMessage.assistantResultImmediatelyAfter=false;writeNativeDownloadEvidence(run.runDir,run.evidence);
  assert.throws(()=>promote(run),/紧跟|绑定/);assert.equal(JSON.parse(fs.readFileSync(run.manifestFile)).state,'failed');
  const run2=pageAssetsEvidence(fixture());run2.evidence.native.originalOwnedTabId=run2.evidence.native.recoveryTabId;writeNativeDownloadEvidence(run2.runDir,run2.evidence);
  assert.throws(()=>promote(run2),/冒充|原执行 tab/);assert.equal(JSON.parse(fs.readFileSync(run2.manifestFile)).state,'failed');
});

test('native recovery rejects a hash mismatch',()=>{
  const run=fixture();run.evidence.output.sha256='0'.repeat(64);writeNativeDownloadEvidence(run.runDir,run.evidence);assert.throws(()=>promote(run),/sha256|SHA-256|output\.sha256|实际文件/);assert.equal(JSON.parse(fs.readFileSync(run.manifestFile)).state,'failed');
});

for(const field of ['conversationUrl','requestId','projectVersion'])test(`native recovery rejects mismatched ${field}`,()=>{
  const run=fixture();const tampered=structuredClone(run.evidence);if(field==='conversationUrl')tampered[field]='https://chatgpt.com/c/other';else if(field==='projectVersion')tampered[field]=3;else tampered[field]=crypto.randomUUID();writeNativeDownloadEvidence(run.runDir,tampered);assert.throws(()=>promote(run),/不一致|一致/);assert.equal(JSON.parse(fs.readFileSync(run.manifestFile)).state,'failed');
});

test('a pre-submission file can never be promoted by native download recovery',()=>{
  const run=fixture({manifestState:'accepted',submitted:false,submissionUncertain:false});assert.throws(()=>promote(run),/已提交|submitted|failed\/submitted/);assert.equal(JSON.parse(fs.readFileSync(run.manifestFile)).state,'accepted');
});

test('an existing downloaded result cannot be promoted twice',()=>{
  const run=fixture({manifestState:'downloaded',submitted:true,submissionUncertain:false});assert.throws(()=>promote(run),/已有下载|重复|failed\/submitted|downloaded/);assert.equal(JSON.parse(fs.readFileSync(run.manifestFile)).state,'downloaded');
});
