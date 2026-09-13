import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {dispatchChatGptWebJob,readWebManifest} from '../server/chatgpt-web-provider.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-direct-worker-'));
function setup(mode){
 const dir=fs.mkdtempSync(path.join(root,'run-')),bin=path.join(dir,'worker.mjs');
 fs.writeFileSync(bin,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),dir=process.cwd();
fs.writeFileSync(path.join(dir,'argv.json'),JSON.stringify(args));
 fs.writeFileSync(path.join(dir,'env.json'),JSON.stringify({backend:process.env.BROWSER_USE_AVAILABLE_BACKENDS||null,surfaces:process.env.CUA_REPL_ENABLED_SURFACES||null}));
let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
 const req=JSON.parse(fs.readFileSync(path.join(dir,'worker-request.json'),'utf8'));
 const mode=${JSON.stringify(mode)};
 const base={provider:req.provider,transport:req.transport,browser:req.browser,focusPolicy:req.focusPolicy,requestId:req.requestId,accepted:true,acceptedAt:new Date().toISOString(),submitted:false};
 const write=m=>fs.writeFileSync(req.manifestFile,JSON.stringify(m));
 if(mode==='hang'){setInterval(()=>{},100);return;}
 if(mode==='empty')return;
 if(mode==='focus-unavailable'){process.stderr.write('BROWSER_FOCUS_UNAVAILABLE: Chrome management capability is not advertised');process.exitCode=1;return;}
 if(mode==='failed'){write({...base,state:'failed',errorCode:'CHATGPT_LOGIN_REQUIRED',error:'请在专用 Chrome 页面登录 ChatGPT。'});return;}
 if(mode==='submitted'){write({...base,state:'submitted',submitted:true});process.exitCode=1;return;}
 fs.writeFileSync(req.outputFile,'mock image');
 write({...base,state:'downloaded',submitted:true,requestId:mode==='wrong'?'11111111-1111-4111-8111-111111111111':req.requestId,artifactPath:req.outputFile});
 if(mode==='crash-after-download')process.exitCode=1;
});
`);fs.chmodSync(bin,0o755);return {codexBin:bin,dir,outputFile:path.join(dir,'out.png'),prompt:'fixture',timeoutMs:2000};
}
test('direct execution starts once, retains identity, and records the Chrome focus boundary',async()=>{
 const args=setup('success'),result=await dispatchChatGptWebJob(args);assert.equal(result.manifest.state,'downloaded');
 assert.equal(result.manifest.transport,'direct-chrome');assert.equal(result.manifest.browser,'chrome');assert.equal(result.manifest.focusPolicy,'may-focus-at-create-without-public-focus-api');
 const argv=JSON.parse(fs.readFileSync(path.join(args.dir,'argv.json')));assert.equal(argv[0],'exec');assert(!argv.includes('queue'));assert(!argv.includes('--ignore-user-config'));assert(!argv.includes('browser_use_external'));assert(argv.includes('image_generation'));
 const env=JSON.parse(fs.readFileSync(path.join(args.dir,'env.json')));assert.equal(env.backend,'chrome');assert.equal(env.surfaces,'browser');
 const instruction=fs.readFileSync(path.join(args.dir,'prompt.txt'),'utf8');assert.match(instruction,/createBrowserTab\("chrome","https:\/\/chatgpt\.com",\{sessionName:"🎨 温蒂生图"\}\)/);assert.doesNotMatch(instruction,/createBrowserTab\("chrome"[^\n]*visible:false/);assert.doesNotMatch(instruction,/visible\s*:/);assert.doesNotMatch(instruction,/createBrowserTab\("iab"/);assert.match(instruction,/BROWSER_FOCUS_UNAVAILABLE/);assert.match(instruction,/没有窗口\/标签页 active 或 focused 更新接口/);assert.match(instruction,/可能短暂取得焦点/);assert.match(instruction,/无法严格保证零焦点切换/);assert.match(instruction,/只绑定返回的自有 tab/);assert.doesNotMatch(instruction,/不创建标签页、不上传、不发送/);assert.match(instruction,/tab\.close\(\)/);assert.doesNotMatch(instruction,/cua\.getTab\(/);
 await assert.rejects(dispatchChatGptWebJob(args),/请求已存在/);
});
test('wrong request download is never acknowledged as success',async()=>{await assert.rejects(dispatchChatGptWebJob(setup('wrong')),/没有取得已核实原图/);});
test('login failure is returned immediately as its actual error',async()=>{await assert.rejects(dispatchChatGptWebJob(setup('failed')),e=>e.code==='CHATGPT_LOGIN_REQUIRED'&&e.webManifest.submitted===false);});
test('a reported Chrome focus error stops before upload or submission',async()=>{
 const args=setup('focus-unavailable');await assert.rejects(dispatchChatGptWebJob(args),error=>error.code==='BROWSER_FOCUS_UNAVAILABLE'&&error.webManifest?.submitted===false);
 const manifest=readWebManifest(path.join(args.dir,'web-generation.json'));assert.equal(manifest.state,'failed');assert.equal(manifest.errorCode,'BROWSER_FOCUS_UNAVAILABLE');assert.equal(manifest.submitted,false);assert.equal(manifest.referenceCount,0);assert.equal(fs.existsSync(args.outputFile),false);
});
test('process exit without a result is unknown, not queued forever',async()=>{await assert.rejects(dispatchChatGptWebJob(setup('empty')),/执行已结束/);});
test('submission survives executor failure without a new execution',async()=>{const args=setup('submitted');await assert.rejects(dispatchChatGptWebJob(args));assert.equal(readWebManifest(path.join(args.dir,'web-generation.json')).submitted,true);await assert.rejects(dispatchChatGptWebJob(args),/请求已存在/);});
test('saved matching download survives an executor exit error',async()=>{assert.equal((await dispatchChatGptWebJob(setup('crash-after-download'))).manifest.state,'downloaded');});
test('direct execution has a bounded timeout',async()=>{const args=setup('hang');await assert.rejects(dispatchChatGptWebJob({...args,timeoutMs:100}),/等待时间较长/);});
test('cancelled request never spawns or creates a request',async()=>{const args=setup('success'),controller=new AbortController();controller.abort();await assert.rejects(dispatchChatGptWebJob({...args,signal:controller.signal}),/已暂停/);assert(!fs.existsSync(path.join(args.dir,'worker-request.json')));});
test('worker timestamps are normalized before reaching the timing UI',()=>{
 const dir=fs.mkdtempSync(path.join(root,'timestamps-')),file=path.join(dir,'web-generation.json');
 fs.writeFileSync(file,JSON.stringify({state:'downloaded',requestId:'11111111-1111-4111-8111-111111111111',accepted:true,submitted:true,createdAt:'2026-09-13T02:00:50.032Z',acceptedAt:'2026-09-13T02:02:03.3NZ',readyAt:'not-a-date',submittedAt:'2026-09-13T02:08:22.300Z'}));
 const manifest=readWebManifest(file);
 assert.equal(manifest.acceptedAt,'2026-09-13T02:02:03.300Z');
 assert.equal(manifest.readyAt,null);
 assert.equal(manifest.submittedAt,'2026-09-13T02:08:22.300Z');
});
