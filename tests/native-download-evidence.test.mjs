import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {inspectDownloadArtifact} from '../server/web-download-evidence.mjs';
import {NATIVE_DOWNLOAD_EVIDENCE_FILE,validateNativeDownloadEvidence,writeNativeDownloadEvidence} from '../server/native-download-evidence.mjs';
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

test('native Chrome download evidence promotes one submitted unknown result',()=>{
  const run=fixture(),check=validateNativeDownloadEvidence(run.evidence,{expectedIdentity:run.identity,projectRoot:run.projectRoot,request:JSON.parse(fs.readFileSync(path.join(run.runDir,'request.json'))),worker:JSON.parse(fs.readFileSync(path.join(run.runDir,'worker-request.json'))),manifest:JSON.parse(fs.readFileSync(run.manifestFile)),execution:JSON.parse(fs.readFileSync(path.join(run.runDir,'execution.json'))),outputFile:run.output,actual:run.actual});
  assert.equal(check.ok,true,check.errors.join('; '));
  const result=promote(run).manifest;assert.equal(result.state,'downloaded');assert.equal(result.submitted,true);assert.equal(result.recoveredFrom,'native-download');assert.equal(result.priorState,'failed');assert.equal(result.priorErrorCode,'SUBMISSION_UNCERTAIN');assert.equal(result.artifactPath,run.output);assert.equal(result.downloadedAt,DOWNLOADED);
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
