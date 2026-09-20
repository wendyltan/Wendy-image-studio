import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {chatGptWebImagePrompt,validateFrozenReferenceFiles} from '../server/chatgpt-web-provider.mjs';
import {patchManifest} from '../server/run-manifest.mjs';
import {buildManifestCommands} from '../server/web-manifest-commands.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-provider-failure-matrix-'));
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
function fixture(){
  const dir=path.join(root,crypto.randomUUID()),output=path.join(dir,'out.png'),requestId=crypto.randomUUID(),runId=path.basename(dir);
  const identity={projectId:crypto.randomUUID(),projectVersion:2,taskId:crypto.randomUUID(),target:'第5页-第1格'};
  fs.mkdirSync(dir,{recursive:true});
  const common={schemaVersion:2,identitySchemaVersion:2,identityLocked:true,provider:'chatgpt-web-iab',...identity,requestId,runId,outputFile:output};
  write(path.join(dir,'request.json'),{...common,expectedOutput:output});
  write(path.join(dir,'worker-request.json'),{...common,manifestFile:path.join(dir,'web-generation.json'),referenceFiles:[]});
  write(path.join(dir,'execution.json'),{schemaVersion:1,runId,state:'running'});
  write(path.join(dir,'run-identity.json'),{schemaVersion:1,identitySchemaVersion:2,identityLocked:true,provider:'chatgpt-web-iab',...identity,requestId,runId,outputFile:output});
  write(path.join(dir,'web-generation.json'),{...common,state:'queued',accepted:false,submitted:false,referenceCount:0});
  return {dir,manifestFile:path.join(dir,'web-generation.json')};
}
function readyRun(){
  const run=fixture();
  patchManifest({stage:'accepted',manifestFile:run.manifestFile});
  patchManifest({stage:'ready',manifestFile:run.manifestFile,args:{conversationUrl:'https://chatgpt.com/c/failure-matrix',referenceCount:5}});
  return run;
}
function manifest(run){return JSON.parse(fs.readFileSync(run.manifestFile,'utf8'));}

test('every explicit pre-submission browser failure gets a complete false/false/true matrix',()=>{
  for(const errorCode of ['CHATGPT_LOGIN_REQUIRED','CHATGPT_NAVIGATION_FAILED','FILE_UPLOAD_CHROME_UNAVAILABLE','BROWSER_ORIGIN_PERMISSION_DENIED','BROWSER_CHROME_UNAVAILABLE','BROWSER_FOCUS_UNAVAILABLE']){
    const run=fixture();
    patchManifest({stage:'accepted',manifestFile:run.manifestFile});
    patchManifest({stage:'failed',manifestFile:run.manifestFile,args:{submitted:'false',errorCode,error:`${errorCode} fixture`}});
    const value=manifest(run);
    assert.equal(value.submitted,false,errorCode);
    assert.equal(value.submissionIntent,false,errorCode);
    assert.equal(value.submissionUncertain,false,errorCode);
    assert.equal(value.preSubmissionFailure,true,errorCode);
  }
});

test('a proven no-send failure after submission intent keeps intent but remains certain pre-submission',()=>{
  const run=readyRun();
  patchManifest({stage:'submission-intent',manifestFile:run.manifestFile});
  patchManifest({stage:'failed',manifestFile:run.manifestFile,args:{submitted:'false',submissionIntent:'true',errorCode:'FILE_UPLOAD_CHROME_UNAVAILABLE',error:'fixture'}});
  const value=manifest(run);
  assert.equal(value.submitted,false);
  assert.equal(value.submissionIntent,true);
  assert.equal(value.submissionUncertain,false);
  assert.equal(value.preSubmissionFailure,true);
});

test('post-submit uncertainty is persisted as submitted and never as pre-submission failure',()=>{
  const run=readyRun();
  patchManifest({stage:'submission-intent',manifestFile:run.manifestFile});
  patchManifest({stage:'submitted',manifestFile:run.manifestFile,args:{submissionConfirmedBy:'fixture'}});
  patchManifest({stage:'failed',manifestFile:run.manifestFile,args:{submitted:'true',errorCode:'SUBMISSION_UNCERTAIN',error:'fixture'}});
  const value=manifest(run);
  assert.equal(value.submitted,true);
  assert.equal(value.submissionIntent,true);
  assert.equal(value.submissionUncertain,true);
  assert.equal(value.preSubmissionFailure,false);
});

test('downloaded recovery clears stale failure markers from the durable manifest',()=>{
  const run=readyRun();
  patchManifest({stage:'submission-intent',manifestFile:run.manifestFile});
  patchManifest({stage:'submitted',manifestFile:run.manifestFile,args:{submissionConfirmedBy:'fixture'}});
  const before=manifest(run);
  write(run.manifestFile,{...before,errorCode:'DOWNLOAD_CHROME_UNAVAILABLE',error:'fixture download failure',failedAt:'2026-01-01T00:00:00.000Z'});
  fs.writeFileSync(before.outputFile,'fixture-original-image');
  patchManifest({stage:'downloaded',manifestFile:run.manifestFile,args:{conversationUrl:'https://chatgpt.com/c/failure-matrix'}});
  const value=manifest(run);
  assert.equal(value.state,'downloaded');
  assert.equal(value.errorCode,null);
  assert.equal(value.error,null);
  assert.equal(value.failedAt,null);
  assert.equal(value.submissionIntent,true);
  assert.equal(value.submissionUncertain,false);
  assert.equal(value.preSubmissionFailure,false);
  assert.equal(value.artifactPath,before.outputFile);
});

test('contradictory failure flags are rejected before they can corrupt the manifest',()=>{
  const run=readyRun();
  assert.throws(()=>patchManifest({stage:'failed',manifestFile:run.manifestFile,args:{submitted:'false',submissionUncertain:'true',preSubmissionFailure:'true',errorCode:'CHATGPT_LOGIN_REQUIRED'}}),/submissionUncertain/);
  const after=manifest(run);
  assert.equal(after.state,'ready');
  assert.equal(after.submitted,false);
});

test('executor instructions carry explicit stage flags and only the image_prompt is remote content',()=>{
  const instruction=chatGptWebImagePrompt({
    outputFile:'/tmp/out.png',
    manifestFile:'/tmp/run/web-generation.json',
    prompt:'必须修改：fixture',
    referenceFiles:['/tmp/a.png','/tmp/b.png'],
  });
  assert.match(instruction,/--error-code "CHATGPT_LOGIN_REQUIRED"/);
  assert.match(instruction,/CHATGPT_NAVIGATION_FAILED/);
  assert.match(instruction,/CHATGPT_LOGIN_REQUIRED[\s\S]*--submitted false[\s\S]*--submission-intent false[\s\S]*--submission-uncertain false[\s\S]*--pre-submission-failure true/);
  assert.match(instruction,/CHATGPT_NAVIGATION_FAILED[\s\S]*--submitted false[\s\S]*--submission-intent false[\s\S]*--submission-uncertain false[\s\S]*--pre-submission-failure true/);
  assert.match(instruction,/FILE_UPLOAD_CHROME_UNAVAILABLE[\s\S]*--submitted false[\s\S]*--submission-intent false[\s\S]*--submission-uncertain false[\s\S]*--pre-submission-failure true/);
  assert.equal((instruction.match(/\n<image_prompt>\n/g)||[]).length,1);
  assert.equal((instruction.match(/\n<\/image_prompt>/g)||[]).length,1);
  assert.match(instruction,/只复制 <image_prompt> 与 <\/image_prompt> 之间的文本/);
  assert.match(instruction,/filechooser[\s\S]*catch\(\(\)=>null\)/);
  assert.match(instruction,/node "[^"]+server\/run-manifest\.mjs"/);
});

test('frozen reference validation rejects missing, unreadable, reordered, or tampered attachments before Chrome',()=>{
  const dir=fs.mkdtempSync(path.join(root,'reference-validation-'));
  const first=path.join(dir,'01-base.jpg'),second=path.join(dir,'02-face.jpg');
  fs.writeFileSync(first,'first-reference');fs.writeFileSync(second,'second-reference');
  const expected=[
    {name:path.basename(first),sizeBytes:fs.statSync(first).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(first)).digest('hex')},
    {name:path.basename(second),sizeBytes:fs.statSync(second).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(second)).digest('hex')},
  ];
  const valid=validateFrozenReferenceFiles({referenceFiles:[first,second],expectedEntries:expected});
  assert.equal(valid.ok,true);assert.deepEqual(valid.files.map(item=>item.name),expected.map(item=>item.name));
  const missing=validateFrozenReferenceFiles({referenceFiles:[first,path.join(dir,'missing.jpg')],expectedEntries:expected});
  assert.equal(missing.ok,false);assert(missing.errors.some(error=>/不存在|不可读/.test(error)));
  const reordered=validateFrozenReferenceFiles({referenceFiles:[second,first],expectedEntries:expected});
  assert.equal(reordered.ok,false);assert(reordered.errors.some(error=>/顺序|name|名称/.test(error)));
  fs.writeFileSync(second,'tampered-reference');
  const tampered=validateFrozenReferenceFiles({referenceFiles:[first,second],expectedEntries:expected});
  assert.equal(tampered.ok,false);assert(tampered.errors.some(error=>/sha256|哈希|大小/.test(error)));
});

test('executor instructions bind the top-level worker reference array and gate send on every upload group',()=>{
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',referenceFiles:['/tmp/a.png','/tmp/b.png']});
  assert.match(instruction,/const worker=JSON\.parse\(fs\.readFileSync\(['"]worker-request\.json['"],['"]utf8['"]\)\)/);
  assert.match(instruction,/worker\.referenceFiles/);
  assert.match(instruction,/不是 worker\.worker\.referenceFiles/);
  assert.match(instruction,/不要手写|不要手打|完整数组原样/);
  assert.match(instruction,/每个 group|逐个附件 group|group.*数量/);
  assert.match(instruction,/重复后缀|YYYYMMDD-HHMMSS|规范化名称/);
  assert.match(instruction,/等待.*等待文件上传.*消失|等待文件上传.*消失/);
  assert.match(instruction,/发送按钮.*disabled|disabled.*发送按钮/);
  assert.match(instruction,/禁止.*submission-intent|submission-intent.*禁止/);
});

test('executor retrieves the original generated media through page assets',()=>{
  const instruction=chatGptWebImagePrompt({
    outputFile:'/tmp/out.png',
    manifestFile:'/tmp/run/web-generation.json',
    prompt:'fixture',
  });
  assert.match(instruction,/tab\.capabilities\.get\("pageAssets"\)/);
  assert.match(instruction,/pageAssets\.list\(\)/);
  assert.match(instruction,/pageAssets\.bundle\(/);
  assert.match(instruction,/contentType/);
  assert.match(instruction,/downloadedCount/);
  assert.match(instruction,/stable file id|稳定.*file id/);
  assert.match(instruction,/matchingStrategy/);
  assert.match(instruction,/重新执行 pageAssets\.list\(\)/);
  assert.match(instruction,/kind="other"/);
  assert.match(instruction,/contentType.*暂不提供|bundle\.assets\[0\]\.contentType/);
  assert.doesNotMatch(instruction,/tab\.playwright\.waitForEvent\("download"\)/);
});

test('manifest command matrix uses the absolute helper and typed login failure flags',()=>{
  const commands=buildManifestCommands('/tmp/wendi/run/web-generation.json');
  assert.match(commands.accepted,/^node "[^"]+server\/run-manifest\.mjs" accepted/);
  assert.ok(commands.accepted.includes(' --manifest-file "/tmp/wendi/run/web-generation.json"'));
  assert.match(commands.loginFailed,/CHATGPT_LOGIN_REQUIRED/);
  assert.match(commands.loginFailed,/--submitted false --submission-intent false --submission-uncertain false --pre-submission-failure true/);
  assert.match(commands.confirmedUnsentUploadFailed,/--submitted false --submission-intent true --submission-uncertain false --pre-submission-failure true/);
  assert.match(commands.submissionUncertain,/--submitted true --submission-intent true --submission-uncertain true --pre-submission-failure false/);
});
