import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {parseJsonObject,readRunIdentity,compareRunIdentity} from '../server/run-identity.mjs';
import {patchManifest} from '../server/run-manifest.mjs';
import {inspectOrphanImageEvidence} from '../server/engine.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-manifest-identity-'));
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
function fixture({tamperManifest=false,legacy=false}={}){
  const project=path.join(root,crypto.randomUUID()),dir=path.join(project,'.制作记录','run-'+crypto.randomUUID()),output=path.join(project,'v1','素材','out.png'),runId=path.basename(dir),requestId=crypto.randomUUID(),identity={projectId:crypto.randomUUID(),projectVersion:1,taskId:crypto.randomUUID(),target:'第1页-第1格'};
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,PNG);const common=legacy?{}:{identitySchemaVersion:2,identityLocked:true};
  const outputFile=output;
  write(path.join(dir,'request.json'),{schemaVersion:2,provider:'chatgpt-web-iab',...common,...identity,requestId,runId,outputFile,expectedOutput:path.relative(path.resolve(dir,'..','..'),output)});
  write(path.join(dir,'worker-request.json'),{schemaVersion:2,provider:'chatgpt-web-iab',...common,...identity,requestId,runId,outputFile,manifestFile:path.join(dir,'web-generation.json')});
  write(path.join(dir,'execution.json'),{schemaVersion:1,runId,state:'completed'});
  write(path.join(dir,'run-identity.json'),{schemaVersion:1,identitySchemaVersion:2,identityLocked:true,...identity,requestId,runId,outputFile});
  write(path.join(dir,'web-generation.json'),{schemaVersion:2,provider:'chatgpt-web-iab',...common,...identity,requestId,runId,outputFile,state:'queued',accepted:false,submitted:false,referenceCount:0,unknownField:{keep:'yes'}});
  if(tamperManifest){const file=path.join(dir,'web-generation.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));delete manifest.runId;manifest.requestId=crypto.randomUUID();fs.writeFileSync(file,JSON.stringify(manifest)+'\n');}
  return {dir,manifestFile:path.join(dir,'web-generation.json'),output,identity,requestId,runId};
}

test('strict parser rejects invalid JSON and a literal backslash-newline suffix',()=>{
  assert.throws(()=>parseJsonObject('{"state":"queued"}\\n','manifest'),/反斜杠换行/);
  assert.throws(()=>parseJsonObject('{"state":','manifest'),/合法 JSON/);
});

test('atomic lifecycle patch preserves unknown fields and locks identity',()=>{
  const run=fixture(),result=patchManifest({stage:'accepted',manifestFile:run.manifestFile,args:{}}),manifest=result.manifest;
  assert.equal(result.ok,true);assert.equal(manifest.state,'accepted');assert.equal(manifest.accepted,true);assert.deepEqual(manifest.unknownField,{keep:'yes'});
  assert.equal(manifest.requestId,run.requestId);assert.equal(manifest.runId,run.runId);assert.equal(manifest.outputFile,run.output);
  assert.throws(()=>patchManifest({stage:'accepted',manifestFile:run.manifestFile,args:{requestId:crypto.randomUUID()}}),/身份字段 requestId/);
  const record=readRunIdentity(run.dir,{strict:true});assert.equal(compareRunIdentity({record,requireModern:true}).ok,true);
});

test('failed lifecycle records explicit intent for a pre-submission failure and rejects post-submit pre-submit labeling',()=>{
  const run=fixture();
  patchManifest({stage:'accepted',manifestFile:run.manifestFile,args:{}});
  patchManifest({stage:'ready',manifestFile:run.manifestFile,args:{conversationUrl:'https://chatgpt.com/c/fixture',referenceCount:1}});
  patchManifest({stage:'submission-intent',manifestFile:run.manifestFile,args:{}});
  const pre=patchManifest({stage:'failed',manifestFile:run.manifestFile,args:{submitted:'false',submissionIntent:'true',submissionUncertain:'false',preSubmissionFailure:'true',errorCode:'FILE_UPLOAD_CHROME_UNAVAILABLE',error:'fixture'}}).manifest;
  assert.equal(pre.submitted,false);assert.equal(pre.submissionIntent,true);assert.equal(pre.submissionUncertain,false);assert.equal(pre.preSubmissionFailure,true);

  const submitted=fixture();
  patchManifest({stage:'accepted',manifestFile:submitted.manifestFile,args:{}});
  patchManifest({stage:'ready',manifestFile:submitted.manifestFile,args:{conversationUrl:'https://chatgpt.com/c/fixture',referenceCount:1}});
  patchManifest({stage:'submission-intent',manifestFile:submitted.manifestFile,args:{}});
  patchManifest({stage:'submitted',manifestFile:submitted.manifestFile,args:{submissionConfirmedBy:'fixture'}});
  assert.throws(()=>patchManifest({stage:'failed',manifestFile:submitted.manifestFile,args:{submitted:'true',submissionIntent:'true',submissionUncertain:'true',preSubmissionFailure:'true',errorCode:'SUBMISSION_UNCERTAIN',error:'fixture'}}),/preSubmissionFailure/);
  const uncertain=patchManifest({stage:'failed',manifestFile:submitted.manifestFile,args:{submitted:'true',submissionIntent:'true',submissionUncertain:'true',preSubmissionFailure:'false',errorCode:'SUBMISSION_UNCERTAIN',error:'fixture'}}).manifest;
  assert.equal(uncertain.submitted,true);assert.equal(uncertain.submissionUncertain,true);assert.equal(uncertain.preSubmissionFailure,false);
});

test('tampered request identity is rejected before any manifest write',()=>{
  const run=fixture({tamperManifest:true}),before=fs.readFileSync(run.manifestFile);
  assert.throws(()=>patchManifest({stage:'accepted',manifestFile:run.manifestFile,args:{}}),/身份不一致/);
  assert.deepEqual(fs.readFileSync(run.manifestFile),before);
});

test('orphan original is reportable only with matching request worker execution output and decodable bytes',async()=>{
  const run=fixture(),manifest=JSON.parse(fs.readFileSync(run.manifestFile,'utf8'));manifest.state='downloaded';manifest.accepted=true;manifest.submitted=true;manifest.artifactPath=run.output;write(run.manifestFile,manifest);
  const recovered=await inspectOrphanImageEvidence({dir:run.dir,expected:run.identity});
  assert.equal(recovered.status,'recoverable_orphan');assert.equal(recovered.requiresUserAction,true);assert.equal(recovered.canAutoAdopt,false);assert.equal(recovered.file,run.output);assert.equal(typeof recovered.integrity.sha256,'string');
  const requestFile=path.join(run.dir,'request.json'),request=JSON.parse(fs.readFileSync(requestFile,'utf8'));request.requestId=crypto.randomUUID();write(requestFile,request);
  const requestRejected=await inspectOrphanImageEvidence({dir:run.dir,expected:run.identity});assert.equal(requestRejected.status,'not_recoverable');assert.equal(requestRejected.canAutoAdopt,false);assert(requestRejected.reasons.some(reason=>/request\.requestId|不匹配/.test(reason)));
  request.requestId=run.requestId;write(requestFile,request);
  const tampered=JSON.parse(fs.readFileSync(path.join(run.dir,'worker-request.json'),'utf8'));tampered.requestId=crypto.randomUUID();write(path.join(run.dir,'worker-request.json'),tampered);
  const rejected=await inspectOrphanImageEvidence({dir:run.dir,expected:run.identity});assert.equal(rejected.status,'not_recoverable');assert.equal(rejected.canAutoAdopt,false);assert(rejected.reasons.some(reason=>/requestId|不匹配/.test(reason)));
});
