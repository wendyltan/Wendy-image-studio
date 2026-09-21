import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {chatGptWebImagePrompt} from '../server/web-executor-instructions.mjs';
import {validateRemotePrompt,remotePromptMetadata} from '../server/remote-prompt.mjs';
import {validateUploadEvidence} from '../server/web-upload-evidence.mjs';

const remotePrompt=fs.readFileSync(new URL('./fixtures/latest-6-1-remote-prompt.txt',import.meta.url),'utf8').replace(/\n$/,'');
const expectedSha='496dcd3fc948fa98cc06fa83a17e1a062d7fc1254fc6708f3b1f99de13f17984';

test('latest 6-1 remote prompt fixture is exactly the frozen 1329-character payload',()=>{
  assert.equal(remotePrompt.length,1329);
  assert.equal(crypto.createHash('sha256').update(remotePrompt).digest('hex'),expectedSha);
  assert.deepEqual(remotePromptMetadata(remotePrompt),{remotePromptLength:1329,remotePromptSha256:expectedSha});
  assert.equal(validateRemotePrompt(remotePrompt,{expectedLength:1329,expectedSha256:expectedSha}).ok,true);
});

test('control fields, paths, and tags are rejected before a browser can start',()=>{
  for(const value of ['requestId: abc','/Volumes/private/reference.png','<submissionIntent>true</submissionIntent>','taskId=abc']){
    const result=validateRemotePrompt(value);
    assert.equal(result.ok,false,value);
  }
});

test('executor prompt contains only the remote payload between composer delimiters',()=>{
  const control='X'.repeat(62*1024);
  const instruction=chatGptWebImagePrompt({
    outputFile:'/tmp/result.png',
    manifestFile:'/tmp/web-generation.json',
    prompt:remotePrompt,
    remotePrompt,
    remotePromptLength:1329,
    remotePromptSha256:expectedSha,
    capsule:control,
    requestId:'11111111-1111-4111-8111-111111111111',
    runId:'fixture-run',
    referenceFiles:['/tmp/01.png','/tmp/02.png','/tmp/03.png','/tmp/04.png','/tmp/05.png'],
  });
  const match=instruction.match(/<remote_prompt>\n([\s\S]*?)\n<\/remote_prompt>/);
  assert(match);
  assert.equal(match[1],remotePrompt);
  assert.doesNotMatch(match[1],/X{1024}/);
  assert.doesNotMatch(instruction,/fs\.readFileSync|require\(|worker-request\.json|prompt\.txt/);
});

test('executor prompt keeps local helper commands outside CUA and uses no unavailable Node APIs',()=>{
  const instruction=chatGptWebImagePrompt({
    outputFile:'/tmp/result.png',
    manifestFile:'/tmp/web-generation.json',
    prompt:remotePrompt,
    remotePrompt,
    remotePromptLength:1329,
    remotePromptSha256:expectedSha,
    requestId:'11111111-1111-4111-8111-111111111111',
    runId:'fixture-run',
    referenceFiles:['/tmp/01.png'],
  });
  assert.doesNotMatch(instruction,/nodeRepl\.exec|require\s*\(/);
  assert.match(instruction,/manifest\/lease helper.*独立的 command_execution/);
  assert.match(instruction,/不得在 CUA js 脚本中拼接、执行或模拟本地 node 命令/);
  assert.match(instruction,/文档支持的精简结果写出接口/);
});

test('menu fallback waits for the chooser only after clicking 从电脑上传',()=>{
  const instruction=chatGptWebImagePrompt({
    outputFile:'/tmp/result.png',
    manifestFile:'/tmp/web-generation.json',
    prompt:'fixture',
    referenceFiles:['/tmp/01.png','/tmp/02.png'],
  });
  const route=instruction.slice(instruction.indexOf('路径 B：'),instruction.indexOf('setFiles 后'));
  const parentClick=route.indexOf('点击唯一“添加文件等”');
  const reread=route.indexOf('重新读取当前 DOM');
  const childWaiter=route.indexOf('重新创建一个全新的有界 waiter');
  const childClick=route.indexOf('点击菜单项并等待');
  assert(parentClick>=0&&reread>parentClick&&childWaiter>reread&&childClick>childWaiter);
  assert.match(route,/父菜单点击本身不等待 chooser/);
  assert.match(route,/禁止第二个 tab/);
});

test('chooser timeout on route A is recoverable when route B completes the attachment gate',()=>{
  const instruction=chatGptWebImagePrompt({
    outputFile:'/tmp/result.png',
    manifestFile:'/tmp/web-generation.json',
    prompt:'fixture',
    referenceFiles:['/tmp/01.png','/tmp/02.png'],
  });
  const route=instruction.slice(instruction.indexOf('路径 A：'),instruction.indexOf('setFiles 后'));
  assert.match(route,/A 没有 chooser 是允许的、可恢复的分支/);
  assert.match(route,/不能因为 A 超时就写任何失败命令、WORKER_SCRIPT_RUNTIME_ERROR 或结束本次执行/);
  assert.match(route,/B 的 setFiles 成功.*完整附件.*不能阻断 uploaded→ready→submission-intent→一次发送/);
  const expectedNames=['01.png','02.png'];
  const recovered={schemaVersion:1,source:'browser-upload',uploadMethod:'menu-fallback',chooserEventObserved:true,chooserAttachedBeforeClick:true,attachmentExpected:2,attachmentObserved:2,attachmentNames:expectedNames,attachmentPending:false,sendEnabled:true,alternateRouteUsed:true,alternateRouteCount:1,failureStage:null};
  const gate=validateUploadEvidence(recovered,{expectedCount:2,expectedNames,requireComplete:true});
  assert.equal(gate.ok,true);
  assert.equal(gate.evidence.failureStage,null);
});

test('zero of five attachments cannot pass the send gate',()=>{
  const result=validateUploadEvidence({
    schemaVersion:1,
    source:'browser-upload',
    uploadMethod:'menu-fallback',
    chooserEventObserved:true,
    chooserAttachedBeforeClick:true,
    attachmentExpected:5,
    attachmentObserved:0,
    attachmentNames:[],
    attachmentPending:false,
    sendEnabled:true,
    failureStage:null,
  },{expectedCount:5,expectedNames:['01.png','02.png','03.png','04.png','05.png'],requireComplete:true});
  assert.equal(result.ok,false);
  assert(result.errors.some(error=>/数量|名称|顺序/.test(error)));
});
