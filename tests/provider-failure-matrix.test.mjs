import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {chatGptWebImagePrompt,validateFrozenReferenceFiles} from '../server/chatgpt-web-provider.mjs';
import {patchManifest} from '../server/run-manifest.mjs';
import {buildManifestCommands} from '../server/web-manifest-commands.mjs';
import {ensureOwnedTabLease,readOwnedTabLease,reserveOwnedTabCreate} from '../server/owned-tab-lease.mjs';

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

test('owned-tab lifecycle boundary is recorded atomically without claiming a lost tab is closed',()=>{
  const run=fixture();
  patchManifest({stage:'accepted',manifestFile:run.manifestFile});
  const value=patchManifest({stage:'failed',manifestFile:run.manifestFile,args:{submitted:'false',submissionIntent:'false',submissionUncertain:'false',preSubmissionFailure:'true',errorCode:'BROWSER_CHROME_UNAVAILABLE',error:'owned tab handle lost',ownedTabId:'unknown',ownedTabCleanupStatus:'not_observed',kernelReset:'true'}}).manifest;
  assert.equal(value.preSubmissionFailure,true);
  assert.equal(value.ownedTabId,null);
  assert.equal(value.ownedTabCleanupStatus,'not_observed');
  assert.equal(value.kernelReset,true);
  assert.throws(()=>patchManifest({stage:'failed',manifestFile:run.manifestFile,args:{submitted:'false',errorCode:'BROWSER_CHROME_UNAVAILABLE',ownedTabCleanupStatus:'missing'}}),/ownedTabCleanupStatus/);
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

test('executor instructions carry explicit stage flags and only remote_prompt is remote content',()=>{
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
  assert.equal((instruction.match(/\n<remote_prompt>\n/g)||[]).length,1);
  assert.equal((instruction.match(/\n<\/remote_prompt>/g)||[]).length,1);
  assert.match(instruction,/只把下面 remotePrompt 原文填入 composer/);
  assert.match(instruction,/filechooser[\s\S]*catch\(\(\)=>null\)/);
  assert.match(instruction,/node "[^"]+server\/run-manifest\.mjs"/);
  assert.match(instruction,/globalThis\.__wendiOwnedTab/);
  assert.match(instruction,/globalThis\.__wendiOwnedTabId/);
  assert.match(instruction,/owned-tab-cleanup-status/);
  assert.match(instruction,/kernel-reset/);
  assert.match(instruction,/此类本地命令失败不得报告为 Chrome 扩展故障或句柄丢失/);
  assert.match(instruction,/OWNED_TAB_STAGE_WRITE_FAILED/);
  const browserCommands=buildManifestCommands('/tmp/run/web-generation.json');
  assert.doesNotMatch(instruction,/随后每次独立 CUA 调用都必须[\s\S]{0,160}await tab\.goto/);
  assert.equal((instruction.match(/await tab\.goto\(/g)||[]).length,1);
  assert.equal(instruction.split(browserCommands.ready).length-1,1);
  assert.equal(instruction.split(browserCommands.submissionIntent).length-1,1);
  assert.match(instruction,/owned-tab 状态 closing 必须先由独立 command_execution[\s\S]*最后一次且仅一次 cleanup CUA 调用[\s\S]*WENDI_OWNED_TAB_CLEANUP_V1/);
  assert.match(instruction,/--run-id[\s\S]*--owned-tab-id/);
  assert.doesNotMatch(instruction,/--state closing[\s\S]*await tab\.goto/);
  assert.match(instruction,/user-message baseline[\s\S]*globalThis\.__wendiUserBaseline/i);
  assert.match(instruction,/有界轮询，最长 45 秒、每 2 秒一次/);
  assert.match(instruction,/click exactly once/i);
  assert.match(instruction,/本次冻结的完整 remotePrompt/);
  assert.match(instruction,/本次新 user message/);
  assert.match(instruction,/之后绝不再点击发送/);
  assert.doesNotMatch(instruction,/only after (?:the )?input box (?:is )?cleared/i);
});

test('created-stage command derives its lease identity from the manifest and can close from creating',()=>{
  const run=fixture(),requestId=manifest(run).requestId,runId=path.basename(run.dir);
  ensureOwnedTabLease({dir:run.dir,runId,requestId,sessionName:'fixture-session'});
  reserveOwnedTabCreate({dir:run.dir,runId,requestId,sessionName:'fixture-session'});
  const commands=buildManifestCommands(run.manifestFile,{requestId,sessionName:'fixture-session'});
  const created=commands.ownedTabCreated('owned-tab-fixture','fixture-session');
  assert.ok(created.length<400,`created-stage helper command should stay compact (${created.length})`);
  assert.doesNotMatch(created,/--lease-file|--run-dir|--request-id/);
  const helper=path.resolve('server/owned-tab-lease.mjs');
  const result=spawnSync(process.execPath,[helper,'stage','--manifest-file',run.manifestFile,'--state','created','--owned-tab-id','owned-tab-fixture','--session-name','fixture-session'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readOwnedTabLease(run.dir,{runId,requestId}).state,'created');

  const unrecorded=fixture(),unrecordedId=manifest(unrecorded).requestId,unrecordedRun=path.basename(unrecorded.dir);
  ensureOwnedTabLease({dir:unrecorded.dir,runId:unrecordedRun,requestId:unrecordedId});
  reserveOwnedTabCreate({dir:unrecorded.dir,runId:unrecordedRun,requestId:unrecordedId});
  const close=spawnSync(process.execPath,[helper,'cleanup','--manifest-file',unrecorded.manifestFile,'--status','closed','--owned-tab-id','observed-tab','--verification','exact-owned-tab-close-returned'],{encoding:'utf8'});
  assert.equal(close.status,0,close.stderr);
  assert.equal(readOwnedTabLease(unrecorded.dir,{runId:unrecordedRun,requestId:unrecordedId}).state,'closed_verified');
  assert.equal(manifest(unrecorded).cleanupStatus,'closed');
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

test('executor instructions bind provider-frozen references and gate send on every upload group',()=>{
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',referenceFiles:['/tmp/a.png','/tmp/b.png']});
  assert.doesNotMatch(instruction,/fs\.readFileSync|require\(|worker-request\.json|prompt\.txt/);
  assert.doesNotMatch(instruction,/worker\.referenceFiles/);
  assert.match(instruction,/附件绝对路径/);
  assert.match(instruction,/不得手写|不得手打|不要手写|不要手打|完整数组原样/);
  assert.match(instruction,/每个 group|逐个附件 group|group.*数量/);
  assert.match(instruction,/重复后缀|YYYYMMDD-HHMMSS|规范化名称/);
  assert.match(instruction,/上传中\/正在上传\/处理中\/等待文件上传\/uploading/);
  assert.match(instruction,/发送按钮.*disabled|disabled.*发送按钮/);
  assert.match(instruction,/禁止.*submission-intent|submission-intent.*禁止/);
  assert.match(instruction,/0\/5|observed 数量不是 expected/);
  assert.match(instruction,/从电脑上传[\s\S]*重新创建一个全新的有界 waiter/);
});

test('existing conversation is the sole initial navigation target and readiness is bounded in-call',()=>{
  const target='https://chatgpt.com/c/existing-conversation';
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',conversationUrl:target});
  assert.match(instruction,/await tab\.goto\("https:\/\/chatgpt\.com\/c\/existing-conversation"\)/);
  assert.doesNotMatch(instruction,/await tab\.goto\("https:\/\/chatgpt\.com"\)/);
  assert.match(instruction,/第二个业务 CUA 调用[\s\S]*timeout_ms\s*[:=]\s*180000[\s\S]*外层 180 秒绝对上限/);
  assert.match(instruction,/导航耗时没有单独可控的 timeout[\s\S]*约 90 秒仅为导航\/页面加载的预算预留[\s\S]*内部 readiness gate 从 goto 返回后最多等待 60000 毫秒[\s\S]*另约 30 秒预留用于工具传输和返回/);
  assert.match(instruction,/导航耗尽外层时限[\s\S]*orphan\/cleanup_pending[\s\S]*不能保证能写入 typed graceful failure[\s\S]*保留未知\/未确认状态，禁止重发/);
  assert.match(instruction,/WENDI_BROWSER_READINESS_GATE_V1[\s\S]*只调用一次 goto[\s\S]*timeoutMs:60000[\s\S]*WENDI_BROWSER_READY_V1/);
  assert.match(instruction,/bootstrap.*最多 3 次/);
});

test('bounded page-landing, attachment-fallback, upload-pending, and download-candidate recovery branches remain explicit',()=>{
  const instruction=chatGptWebImagePrompt({
    outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',
    requestId:'11111111-1111-4111-8111-111111111111',runId:'run-fixture',
    conversationUrl:'https://chatgpt.com/c/replay-target',
    referenceFiles:['/tmp/a.png','/tmp/b.png'],
  });
  const navigationStart=instruction.indexOf('WENDI_BROWSER_READINESS_GATE_V1'),navigationEnd=instruction.indexOf('紧接着以独立 command_execution',navigationStart);
  const navigation=instruction.slice(navigationStart,navigationEnd>navigationStart?navigationEnd:undefined);
  assert.match(navigation,/WENDI_BROWSER_READINESS_GATE_V1/);
  assert.match(navigation,/只调用一次 goto/);
  assert.match(navigation,/在最多 60000 毫秒内/);
  assert.match(navigation,/WENDI_BROWSER_READY_V1/);
  assert.match(navigation,/缺少或未通过 readiness 证据时拒绝 uploading/);
  assert.match(navigation,/禁止先打开 chatgpt\.com 首页/);

  const attachments=instruction.slice(instruction.indexOf('附件入口只有两条'),instruction.indexOf('只在 https://chatgpt.com/'));
  assert.match(attachments,/A 没有 chooser 是允许的、可恢复的分支/);
  assert.match(attachments,/必须在同一个 owned tab 继续执行 B/);
  assert.match(attachments,/上传中\/正在上传\/处理中\/等待文件上传\/uploading/);
  assert.match(attachments,/attachmentPending/);
  assert.match(attachments,/绝不执行 ready、submission-intent 或发送/);

  const download=instruction.slice(instruction.indexOf('如果首次 list 没有唯一'),instruction.indexOf('执行 const bundle='));
  assert.match(download,/点击当前结果图片本身/);
  assert.match(download,/重新执行 pageAssets\.list\(\) 一次/);
  assert.match(download,/第二次仍不是唯一图片候选时，执行 .*--error-code "DOWNLOAD_FAILED"/);
  assert.match(download,/绝不发送或重试/);
});

test('conversationUrl rejects non-ChatGPT origins, non-conversation paths, HTTP, and lookalike domains',()=>{
  const invalidUrls=[
    'https://example.com/c/conversation',
    'https://chatgpt.com/',
    'http://chatgpt.com/c/conversation',
    'https://chatgpt.com.evil.example/c/conversation',
    'https://notchatgpt.com/c/conversation',
  ];
  for(const conversationUrl of invalidUrls){
    assert.throws(()=>chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',conversationUrl}),/conversationUrl/);
  }
});

test('all frozen references are attached and verified in a bounded upload batch',()=>{
  const refs=['/tmp/a.png','/tmp/b.png','/tmp/c.png','/tmp/d.png','/tmp/e.png'];
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',referenceFiles:refs});
  assert.match(instruction,/多选时一次 setFiles/);
  assert.match(instruction,/首个上传脚本[\s\S]*整个 provider 冻结附件数组/);
  assert.match(instruction,/不得按附件逐个调用 CUA/);
  assert.match(instruction,/upload.*最多 2 次/);
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
