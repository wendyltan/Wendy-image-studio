import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {dispatchChatGptWebJob,resumeChatGptWebJob,readWebManifest,WEB_IMAGE_PROVIDER} from '../server/chatgpt-web-provider.mjs';
import {patchManifest} from '../server/run-manifest.mjs';
import {readExecutorRuntimeError} from '../server/bridge.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-direct-worker-'));
const latest61RemotePrompt=fs.readFileSync(new URL('./fixtures/latest-6-1-remote-prompt.txt',import.meta.url),'utf8').replace(/\n$/,'');
function setup(mode){
 const dir=fs.mkdtempSync(path.join(root,'run-')),bin=path.join(dir,'worker.mjs');
 fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({projectId:'11111111-1111-4111-8111-111111111111',projectVersion:3,taskId:'22222222-2222-4222-8222-222222222222',target:'第5页-第1格'}));
 fs.writeFileSync(bin,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const args=process.argv.slice(2),dir=process.cwd(),out=args[args.indexOf('-o')+1];
fs.writeFileSync(path.join(dir,'argv.json'),JSON.stringify(args));
 fs.writeFileSync(path.join(dir,'env.json'),JSON.stringify({backend:process.env.BROWSER_USE_AVAILABLE_BACKENDS||null,surfaces:process.env.CUA_REPL_ENABLED_SURFACES||null}));
let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
 const req=JSON.parse(fs.readFileSync(path.join(dir,'worker-request.json'),'utf8'));
 const mode=${JSON.stringify(mode)};
 const base={schemaVersion:2,identitySchemaVersion:2,identityLocked:true,provider:req.provider,transport:req.transport,browser:req.browser,focusPolicy:req.focusPolicy,requestId:req.requestId,runId:req.runId,projectId:req.projectId,projectVersion:req.projectVersion,taskId:req.taskId,target:req.target,outputFile:req.outputFile,accepted:true,acceptedAt:new Date().toISOString(),submitted:false};
 const write=m=>fs.writeFileSync(req.manifestFile,JSON.stringify(m));
 if(mode==='hang'){setInterval(()=>{},100);return;}
 if(mode==='empty')return;
 if(mode==='usage-limit-once'){const marker=path.join(dir,'usage-limit-once');if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');console.log(JSON.stringify({type:'error',message:"You've hit your usage limit. Try again later."}));process.exitCode=1;return;}}
 if(mode==='legacy-confirmed-unsent-once'){const marker=path.join(dir,'legacy-confirmed-unsent-once');if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');write({...base,state:'failed',submitted:true,submissionIntent:true,referenceCount:2,readyAt:new Date().toISOString(),submittedAt:new Date().toISOString(),conversationUrl:'https://chatgpt.com/c/fixture-conversation',errorCode:'FILE_UPLOAD_CHROME_UNAVAILABLE',error:'upload wait remained disabled; no user message appeared'});process.exitCode=1;return;}}
 if(mode==='home-confirmed-unsent-once'){const marker=path.join(dir,'home-confirmed-unsent-once');if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');write({...base,state:'failed',submitted:false,submissionIntent:false,referenceCount:0,conversationUrl:'https://chatgpt.com/',errorCode:'FILE_UPLOAD_CHROME_UNAVAILABLE',error:'chooser failed before submission; no user message appeared'});process.exitCode=1;return;}}
 if(mode==='owned-tab-handle-loss-once'){const marker=path.join(dir,'owned-tab-handle-loss-once');if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');write({...base,state:'failed',submitted:false,submissionIntent:false,referenceCount:0,errorCode:'BROWSER_CHROME_UNAVAILABLE',error:'owned tab handle was lost before navigation'});process.exitCode=1;return;}}
 if(mode==='worker-runtime'){console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'cua_repl.js',aggregated_output:'ReferenceError: require is not defined'}}));write({...base,state:'accepted',accepted:true,submitted:false,referenceCount:0});process.exitCode=1;return;}
 if(mode==='event-with-image-data'){console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'cua_repl',tool:'js',result:{content:[{type:'image',data:'data:image/png;base64,${'A'.repeat(4096)}'}],_meta:{browser_use:{screenshot:{pageUrl:'https://chatgpt.com',tabId:'fixture',url:'data:image/png;base64,${'B'.repeat(4096)}'}}}}}}));}
 if(mode==='focus-unavailable'){process.stderr.write('BROWSER_FOCUS_UNAVAILABLE: Chrome management capability is not advertised');process.exitCode=1;return;}
 if(mode==='origin-permission-denied'){console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'cua_repl',tool:'js',result:{content:[{type:'text',text:'The user declined permission for this action. Browser use cannot access https://chatgpt.com because the user denied permission for this request.'}]}}}));write({...base,state:'accepted'});process.stderr.write('The user declined permission for this action. Browser use cannot access https://chatgpt.com because the user denied permission for this request.');process.exitCode=1;return;}
 if(mode==='origin-permission-denied-exit0'){write({...base,state:'failed',errorCode:'BROWSER_CHROME_UNAVAILABLE',error:'Chrome extension unavailable'});process.stderr.write('The user declined permission for this action. Browser use cannot access https://chatgpt.com because the user denied permission for this request.');return;}
 if(mode==='origin-permission-denied-exit0-mismatch'){write({...base,state:'failed',projectId:'different-project',errorCode:'BROWSER_CHROME_UNAVAILABLE',error:'Chrome extension unavailable'});process.stderr.write('The user declined permission for this action. Browser use cannot access https://chatgpt.com because the user denied permission for this request.');return;}
 if(mode==='structured-origin-permission-denied'){console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'cua_repl',tool:'js',result:{content:[{type:'text',text:'The user declined permission for this action. Browser use cannot access https://chatgpt.com because the user denied permission for this request.'}]}}}));write({...base,state:'accepted'});process.exitCode=1;return;}
 if(mode==='explicit-upload-with-permission-noise'){console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'permission denied browser security policy'}}));console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'echo user declined permission',aggregated_output:'browser security policy denied'}}));write({...base,state:'failed',errorCode:'FILE_UPLOAD_CHROME_UNAVAILABLE',error:'FILE_UPLOAD_CHROME_UNAVAILABLE: attachment control did not open file chooser'});return;}
 if(mode==='failed'){write({...base,state:'failed',errorCode:'CHATGPT_LOGIN_REQUIRED',error:'请在专用 Chrome 页面登录 ChatGPT。'});return;}
 if(mode==='submitted'){write({...base,state:'submitted',submitted:true});process.exitCode=1;return;}
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');fs.writeFileSync(req.outputFile,png);const conversationUrl='https://chatgpt.com/c/fixture-conversation',src='https://chatgpt.com/backend-api/estuary/content?id=file_fixture_result&sig=fixture',sha256=crypto.createHash('sha256').update(png).digest('hex'),downloadEvidence={schemaVersion:2,source:'pageAssets',projectId:req.projectId,projectVersion:req.projectVersion,taskId:req.taskId,target:req.target,conversationUrl,requestId:req.requestId,runId:req.runId,matchingStrategy:'exact-src',currentResult:{src,resultId:'file_fixture_result',stableFileId:'file_fixture_result',marker:'fixture-result'},inventory:{id:'inventory-fixture',assetCount:1},exactMatchCount:1,matchedAssetIds:['asset-fixture'],matchedAsset:{id:'asset-fixture',kind:'image',contentType:'image/png',url:src,sourceUrl:src,role:'generated-result',isThumbnail:false,isPreview:false},bundle:{downloadedCount:1,failures:[],contentType:'image/png',path:'/tmp/fixture-bundle.png'},output:{path:req.outputFile,bytes:png.length,format:'PNG',width:1,height:1,sha256},capturedAt:new Date().toISOString()},evidenceText='<download_evidence>'+JSON.stringify(downloadEvidence)+'</download_evidence>';
 write({...base,state:'downloaded',submitted:true,requestId:mode==='wrong'?'11111111-1111-4111-8111-111111111111':req.requestId,artifactPath:req.outputFile,conversationUrl});fs.writeFileSync(out,evidenceText);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:evidenceText}}));
 if(mode==='crash-after-download')process.exitCode=1;
});
`);fs.chmodSync(bin,0o755);return {codexBin:bin,dir,outputFile:path.join(dir,'out.png'),prompt:'fixture',timeoutMs:5000};
}
test('direct execution persists validated page-assets evidence for the exact original',async()=>{
 const args=setup('success'),result=await dispatchChatGptWebJob(args);assert.equal(result.manifest.state,'downloaded');assert.equal(result.downloadEvidence.exactMatchCount,1);assert.equal(result.downloadEvidence.bundle.downloadedCount,1);
 const evidence=JSON.parse(fs.readFileSync(path.join(args.dir,'download-evidence.json'),'utf8'));assert.equal(evidence.schemaVersion,2);assert.equal(evidence.projectId,'11111111-1111-4111-8111-111111111111');assert.equal(evidence.projectVersion,3);assert.equal(evidence.taskId,'22222222-2222-4222-8222-222222222222');assert.equal(evidence.target,'第5页-第1格');assert.equal(evidence.conversationUrl,'https://chatgpt.com/c/fixture-conversation');assert.equal(evidence.matchedAsset.kind,'image');assert.equal(evidence.output.sha256,result.downloadEvidence.output.sha256);
 assert.equal(result.manifest.transport,'direct-chrome');assert.equal(result.manifest.browser,'chrome');assert.equal(result.manifest.focusPolicy,'may-focus-at-create-without-public-focus-api');assert.equal(result.manifest.role,'browser-executor');assert.equal(result.manifest.executorReasoningEffort,'low');
 const request=JSON.parse(fs.readFileSync(path.join(args.dir,'worker-request.json')));assert.equal(request.role,'browser-executor');assert.equal(request.executorReasoningEffort,'low');assert.equal(request.remotePromptLength,args.prompt.length);assert.match(request.remotePromptSha256,/^[a-f0-9]{64}$/);assert.equal(fs.statSync(path.join(args.dir,'remote-prompt.txt')).size,request.remotePromptLength);
 const argv=JSON.parse(fs.readFileSync(path.join(args.dir,'argv.json')));assert.equal(argv[0],'exec');assert(!argv.includes('queue'));assert(!argv.includes('--ignore-user-config'));assert(!argv.includes('browser_use_external'));assert(argv.includes('image_generation'));
 const env=JSON.parse(fs.readFileSync(path.join(args.dir,'env.json')));assert.equal(env.backend,'chrome');assert.equal(env.surfaces,'browser');
 const instruction=fs.readFileSync(path.join(args.dir,'prompt.txt'),'utf8');assert.match(instruction,/createBrowserTab\("chrome",undefined,\{sessionName:"🎨 温蒂生图-[a-f0-9]{8}"\}\)/);assert.match(instruction,/tab\.goto\("https:\/\/chatgpt\.com"\)/);assert.match(instruction,/try\s*\{/);assert.match(instruction,/finally\s*\{/);assert.doesNotMatch(instruction,/createBrowserTab\("chrome"[^\n]*visible:false/);assert.doesNotMatch(instruction,/visible\s*:/);assert.doesNotMatch(instruction,/createBrowserTab\("iab"/);assert.match(instruction,/BROWSER_FOCUS_UNAVAILABLE/);assert.match(instruction,/没有窗口\/标签页 active 或 focused 更新接口/);assert.match(instruction,/可能短暂取得焦点/);assert.match(instruction,/无法严格保证零焦点切换/);assert.match(instruction,/只绑定返回的自有 tab/);assert.doesNotMatch(instruction,/不创建标签页、不上传、不发送/);assert.equal((instruction.match(/await tab\.close\(\)/g)||[]).length,1);assert.doesNotMatch(instruction,/第?7\.?.*tab\.close\(\)/);assert.doesNotMatch(instruction,/第?8\.?.*tab\.close\(\)/);assert.doesNotMatch(instruction,/cua\.getTab\(/);assert.match(instruction,/禁止读取仓库、memory、历史任务/);assert.match(instruction,/禁止自行调研、搜索或改写提示词/);assert.match(instruction,/立即按下列步骤执行/);assert.match(instruction,/读取当前 DOM/);assert.match(instruction,/添加照片和文件/);assert.match(instruction,/从电脑上传/);assert.match(instruction,/filechooser/);assert.match(instruction,/短时有界/);assert.match(instruction,/chooser\.isMultiple\(\)/);assert.match(instruction,/逐项/);assert.match(instruction,/悬挂 chooser promise/);assert.doesNotMatch(instruction,/fs\.readFileSync|require\(|worker-request\.json|prompt\.txt/);assert.match(instruction,/0\/5|observed 数量不是 expected/);
 assert.doesNotMatch(instruction,/worker\.referenceFiles|worker-request\.json|fs\.readFileSync|require\(|prompt\.txt/);assert.match(instruction,/附件绝对路径/);
 assert.match(instruction,/submissionIntent=true[^\n]*submitted=false/);
 assert.match(instruction,/failed .*--submitted <true或false>.*--submission-intent <true或false>.*--submission-uncertain <true或false>.*--pre-submission-failure <true或false>/);
 assert.match(instruction,/--submitted false、--submission-intent true、--submission-uncertain false、--pre-submission-failure true/);
 assert.match(instruction,/--submitted true、--submission-intent true、--submission-uncertain true、--pre-submission-failure false/);
 assert.match(instruction,/新的用户消息|输入框已清空/);
 assert.doesNotMatch(instruction,/先原子记录 state=submitted、submitted=true[^\n]*再一次性提交/);
 const execution=JSON.parse(fs.readFileSync(path.join(args.dir,'execution.json')));assert.equal(execution.role,'browser-executor');assert.equal(execution.reasoningEffort,'low');assert.equal(execution.state,'completed');
 await assert.rejects(dispatchChatGptWebJob(args),/请求已存在/);
});
test('latest 6-1 fixture keeps the 1329-character remote prompt out of the executor control payload',async()=>{
 const args=setup('success');args.prompt=latest61RemotePrompt;args.capsule='X'.repeat(62*1024);const result=await dispatchChatGptWebJob(args);assert.equal(result.manifest.state,'downloaded');
 const request=JSON.parse(fs.readFileSync(path.join(args.dir,'worker-request.json'),'utf8'));assert.equal(request.remotePromptLength,1329);assert.equal(request.remotePromptSha256,'496dcd3fc948fa98cc06fa83a17e1a062d7fc1254fc6708f3b1f99de13f17984');
 const instruction=fs.readFileSync(path.join(args.dir,'prompt.txt'),'utf8'),match=instruction.match(/<remote_prompt>\n([\s\S]*?)\n<\/remote_prompt>/);assert(match);assert.equal(match[1],latest61RemotePrompt);assert.doesNotMatch(match[1],/X{1024}/);assert.doesNotMatch(instruction,/fs\.readFileSync|require\(|worker-request\.json/);
});
test('existing conversation navigation timeout is checked before pre-submission failure',async()=>{
 const args={...setup('success'),timeoutMs:5000};
 await dispatchChatGptWebJob({...args,conversationUrl:'https://chatgpt.com/c/existing-conversation'});
 const instruction=fs.readFileSync(path.join(args.dir,'prompt.txt'),'utf8');
 assert.match(instruction,/既有会话.*导航.*超时/);
 assert.match(instruction,/同一.*owned tab.*URL.*DOM.*composer|同一.*自有 tab.*URL.*DOM.*composer/);
 assert.match(instruction,/Page\.navigate|navigation timeout/i);
 assert.match(instruction,/CHATGPT_NAVIGATION_FAILED/);
 assert.match(instruction,/这个 tab.*完成聊天模式/);
 assert.match(instruction,/新聊天继续/);
 assert.match(instruction,/不得再次 createBrowserTab|不得盲目再次调用 createBrowserTab/);
});
test('a proven pre-acceptance usage limit resumes the same request and archives the first attempt',async()=>{
 const args=setup('usage-limit-once'),identity={provider:WEB_IMAGE_PROVIDER,projectId:'11111111-1111-4111-8111-111111111111',projectVersion:3,taskId:'22222222-2222-4222-8222-222222222222',target:'第5页-第1格'};
 fs.writeFileSync(path.join(args.dir,'request.json'),JSON.stringify(identity));
 await assert.rejects(dispatchChatGptWebJob({...args,model:'gpt-5.6-luna'}),/usage limit/i);
 const before=readWebManifest(path.join(args.dir,'web-generation.json')),requestId=before.requestId;
 assert.equal(before.state,'queued');assert.equal(before.accepted,false);assert.equal(before.submitted,false);assert.equal(before.referenceCount,0);
 const result=await resumeChatGptWebJob({...args,model:'gpt-5.6-luna',expected:{...identity,requestId}});
 assert.equal(result.manifest.requestId,requestId);assert.equal(result.manifest.state,'downloaded');assert.equal(result.manifest.submitted,true);assert.equal(result.manifest.resumeCount,1);
 const archives=fs.readdirSync(path.join(args.dir,'attempts'));assert.deepEqual(archives,['001-preaccept-usage-limit']);
 const attempt=JSON.parse(fs.readFileSync(path.join(args.dir,'attempts',archives[0],'attempt.json'),'utf8'));assert.equal(attempt.requestId,requestId);assert.equal(attempt.accepted,false);assert.equal(attempt.submitted,false);assert.match(attempt.error,/usage limit/i);
});
test('a separately audited legacy false submission resumes the same request only once',async()=>{
 const args=setup('legacy-confirmed-unsent-once'),identity={provider:WEB_IMAGE_PROVIDER,projectId:'33333333-3333-4333-8333-333333333333',projectVersion:4,taskId:'44444444-4444-4444-8444-444444444444',target:'第5页-第1格'};
 fs.writeFileSync(path.join(args.dir,'request.json'),JSON.stringify(identity));
 await assert.rejects(dispatchChatGptWebJob({...args,model:'gpt-5.6-luna'}));
 const before=readWebManifest(path.join(args.dir,'web-generation.json')),requestId=before.requestId;
 assert.equal(before.submitted,true);assert.equal(before.submissionIntent,true);
 fs.writeFileSync(path.join(args.dir,'web-audit.json'),JSON.stringify({schemaVersion:1,...identity,requestId,result:'confirmed_unsent',conversationUrl:before.conversationUrl,auditedAt:new Date(Date.now()+1000).toISOString(),evidence:{composerContainsPrompt:true,newUserMessagePresent:false,generatedResultPresent:false,sendButtonPresent:true,executorOwnedTabClosed:true}}));
 const instruction=fs.readFileSync(path.join(args.dir,'prompt.txt'),'utf8');
 const result=await resumeChatGptWebJob({...args,model:'gpt-5.6-luna',instruction,expected:{...identity,requestId}});
 assert.equal(result.manifest.requestId,requestId);assert.equal(result.manifest.state,'downloaded');assert.equal(result.manifest.submitted,true);assert.equal(result.manifest.resumeCount,1);
 assert.equal(result.manifest.lastConfirmedUnsentAttempt,'attempts/001-confirmed-unsent');
 const attempt=JSON.parse(fs.readFileSync(path.join(args.dir,'attempts','001-confirmed-unsent','attempt.json'),'utf8'));assert.equal(attempt.requestId,requestId);assert.equal(attempt.auditResult,'confirmed_unsent');
});
test('a separately audited home pre-intent upload failure resumes the same request',async()=>{
 const args=setup('home-confirmed-unsent-once'),identity={provider:WEB_IMAGE_PROVIDER,projectId:'55555555-5555-4555-8555-555555555555',projectVersion:5,taskId:'66666666-6666-4666-8666-666666666666',target:'第6页-第1格'};
 fs.writeFileSync(path.join(args.dir,'request.json'),JSON.stringify(identity));
 await assert.rejects(dispatchChatGptWebJob({...args,model:'gpt-5.6-luna'}));
 const before=readWebManifest(path.join(args.dir,'web-generation.json')),requestId=before.requestId;
 assert.equal(before.conversationUrl,'https://chatgpt.com/');assert.equal(before.submitted,false);assert.equal(before.submissionIntent,false);assert.equal(before.preSubmissionFailure,true);
 fs.writeFileSync(path.join(args.dir,'web-audit.json'),JSON.stringify({schemaVersion:1,...identity,requestId,result:'confirmed_unsent',conversationUrl:before.conversationUrl,auditedAt:new Date(Date.now()+1000).toISOString(),evidence:{composerContainsPrompt:true,newUserMessagePresent:false,generatedResultPresent:false,sendButtonPresent:true,executorOwnedTabClosed:true}}));
 const instruction=fs.readFileSync(path.join(args.dir,'prompt.txt'),'utf8');
 const result=await resumeChatGptWebJob({...args,model:'gpt-5.6-luna',instruction,expected:{...identity,requestId}});
 assert.equal(result.manifest.requestId,requestId);assert.equal(result.manifest.state,'downloaded');assert.equal(result.manifest.submitted,true);assert.equal(result.manifest.resumeCount,1);
});
test('a separately audited owned-tab handle loss resumes the same request only with boundary evidence',async()=>{
 const args=setup('owned-tab-handle-loss-once'),identity={provider:WEB_IMAGE_PROVIDER,projectId:'77777777-7777-4777-8777-777777777777',projectVersion:6,taskId:'88888888-8888-4888-8888-888888888888',target:'第6页-第1格'};
 fs.writeFileSync(path.join(args.dir,'request.json'),JSON.stringify(identity));
 await assert.rejects(dispatchChatGptWebJob({...args,model:'gpt-5.6-luna'}));
 const before=readWebManifest(path.join(args.dir,'web-generation.json')),requestId=before.requestId;
 assert.equal(before.errorCode,'BROWSER_CHROME_UNAVAILABLE');assert.equal(before.preSubmissionFailure,true);assert.equal(before.submitted,false);
 patchManifest({stage:'failed',manifestFile:path.join(args.dir,'web-generation.json'),args:{submitted:'false',submissionIntent:'false',submissionUncertain:'false',preSubmissionFailure:'true',errorCode:'BROWSER_CHROME_UNAVAILABLE',error:'owned tab handle was lost before navigation',ownedTabId:'fixture-owned-tab',ownedTabCleanupStatus:'not_observed',kernelReset:'false'}});
 fs.writeFileSync(path.join(args.dir,'web-audit.json'),JSON.stringify({schemaVersion:2,...identity,requestId,result:'confirmed_unsent',failureStage:'owned-tab-handle-loss',ownedTabId:'fixture-owned-tab',ownedTabCleanupStatus:'not_observed',cleanupVerification:'exact-owned-tab-getTab-not-found',kernelReset:false,conversationUrl:null,auditedAt:new Date(Date.now()+1000).toISOString(),evidence:{ownedTabHandleLost:true,composerContainsPrompt:false,newUserMessagePresent:false,generatedResultPresent:false,sendButtonPresent:false,executorOwnedTabClosed:false}}));
 const instruction=fs.readFileSync(path.join(args.dir,'prompt.txt'),'utf8');
 const result=await resumeChatGptWebJob({...args,model:'gpt-5.6-luna',instruction,expected:{...identity,requestId}});
 assert.equal(result.manifest.requestId,requestId);assert.equal(result.manifest.state,'downloaded');assert.equal(result.manifest.submitted,true);assert.equal(result.manifest.resumeCount,1);
});
test('wrong request download is never acknowledged as success',async()=>{await assert.rejects(dispatchChatGptWebJob(setup('wrong')),/没有取得已核实原图/);});
test('login failure is returned immediately as its actual error',async()=>{await assert.rejects(dispatchChatGptWebJob(setup('failed')),e=>e.code==='CHATGPT_LOGIN_REQUIRED'&&e.webManifest.submitted===false);});
test('a reported Chrome focus error stops before upload or submission',async()=>{
 const args=setup('focus-unavailable');await assert.rejects(dispatchChatGptWebJob(args),error=>error.code==='BROWSER_FOCUS_UNAVAILABLE'&&error.webManifest?.submitted===false);
 const manifest=readWebManifest(path.join(args.dir,'web-generation.json'));assert.equal(manifest.state,'failed');assert.equal(manifest.errorCode,'BROWSER_FOCUS_UNAVAILABLE');assert.equal(manifest.submitted,false);assert.equal(manifest.referenceCount,0);assert.equal(fs.existsSync(args.outputFile),false);
});
test('origin permission denial is distinct, explicit, and safely pre-submission',async()=>{
 const args=setup('origin-permission-denied');await assert.rejects(dispatchChatGptWebJob(args),error=>error.code==='BROWSER_ORIGIN_PERMISSION_DENIED'&&error.webManifest?.accepted===true&&error.webManifest?.submitted===false);
 const manifest=readWebManifest(path.join(args.dir,'web-generation.json'));assert.equal(manifest.state,'failed');assert.equal(manifest.errorCode,'BROWSER_ORIGIN_PERMISSION_DENIED');assert.equal(manifest.accepted,true);assert.equal(manifest.submitted,false);assert.equal(manifest.submissionIntent,false);assert.equal(manifest.preSubmissionFailure,true);assert.equal(manifest.referenceCount,0);assert.match(manifest.error,/Chrome 已连接，但 chatgpt\.com 访问权限被拒绝/);assert.match(manifest.error,/选择“允许”/);assert.equal(fs.existsSync(args.outputFile),false);
});
test('explicit Chrome error code is not overwritten by unstructured permission text',async()=>{
 const args=setup('origin-permission-denied-exit0');await assert.rejects(dispatchChatGptWebJob(args),error=>error.code==='BROWSER_CHROME_UNAVAILABLE'&&error.webManifest?.submitted===false);
 const manifest=readWebManifest(path.join(args.dir,'web-generation.json'));assert.equal(manifest.state,'failed');assert.equal(manifest.errorCode,'BROWSER_CHROME_UNAVAILABLE');assert.equal(manifest.submitted,false);assert.equal(manifest.submissionIntent,false);assert.equal(manifest.preSubmissionFailure,true);assert.equal(manifest.referenceCount,0);assert.equal(fs.existsSync(args.outputFile),false);
 const calls=JSON.parse(fs.readFileSync(path.join(args.dir,'argv.json')));assert.equal(calls.filter(item=>item==='exec').length,1);await assert.rejects(dispatchChatGptWebJob(args),/请求已存在/);
});
test('structured terminal browser origin denial is still classified',async()=>{
 const args=setup('structured-origin-permission-denied');await assert.rejects(dispatchChatGptWebJob(args),error=>error.code==='BROWSER_ORIGIN_PERMISSION_DENIED'&&error.webManifest?.submitted===false);
 const manifest=readWebManifest(path.join(args.dir,'web-generation.json'));assert.equal(manifest.errorCode,'BROWSER_ORIGIN_PERMISSION_DENIED');assert.equal(manifest.submitted,false);assert.equal(manifest.referenceCount,0);
});
test('explicit file-upload failure wins over permission words in prompt and commands',async()=>{
 const args=setup('explicit-upload-with-permission-noise');await assert.rejects(dispatchChatGptWebJob(args),error=>error.code==='FILE_UPLOAD_CHROME_UNAVAILABLE'&&error.webManifest?.submitted===false);
 const manifest=readWebManifest(path.join(args.dir,'web-generation.json'));assert.equal(manifest.errorCode,'FILE_UPLOAD_CHROME_UNAVAILABLE');assert.equal(manifest.submitted,false);assert.equal(manifest.referenceCount,0);assert.match(manifest.error,/附件入口未能打开|FILE_UPLOAD_CHROME_UNAVAILABLE/);
});
test('cua require runtime failure is classified before upload and never as chooser failure',async()=>{
 const args=setup('worker-runtime');await assert.rejects(dispatchChatGptWebJob(args),error=>error.code==='WORKER_SCRIPT_RUNTIME_ERROR'&&error.webManifest?.submitted===false);
 const manifest=readWebManifest(path.join(args.dir,'web-generation.json'));assert.equal(manifest.errorCode,'WORKER_SCRIPT_RUNTIME_ERROR');assert.equal(manifest.submitted,false);assert.equal(manifest.referenceCount,0);assert.equal(manifest.preSubmissionFailure,true);assert.match(manifest.error,/浏览器执行脚本发生运行时错误/);assert.doesNotMatch(manifest.error,/chooser|文件选择器|附件入口/i);
 const runtime=readExecutorRuntimeError(args.dir);assert.equal(runtime.category,'javascript_runtime');assert.match(runtime.message,/ReferenceError/);assert.match(runtime.stack,/require is not defined/);assert.equal(runtime.toolStage,'executor');assert.equal(manifest.runtimeErrorCategory,'javascript_runtime');assert.match(manifest.runtimeErrorMessage,/ReferenceError/);
});
test('executor event logs redact image payloads while retaining compact evidence',async()=>{
 const args=setup('event-with-image-data');await dispatchChatGptWebJob(args);
 const events=fs.readFileSync(path.join(args.dir,'events.jsonl'),'utf8');assert.doesNotMatch(events,/A{100}|B{100}/);assert.match(events,/image-data-redacted/);assert.ok(fs.statSync(path.join(args.dir,'events.jsonl')).size<10000);
});
test('exit-zero origin evidence from another project cannot be normalized',async()=>{
 const args=setup('origin-permission-denied-exit0-mismatch');fs.writeFileSync(path.join(args.dir,'request.json'),JSON.stringify({provider:'chatgpt-web-iab',projectId:'current-project',projectVersion:3,taskId:'current-task',target:'第1页-第1格'}));
 await assert.rejects(dispatchChatGptWebJob(args),error=>error.code==='REQUEST_IDENTITY_MISMATCH'&&error.webManifest?.errorCode==='BROWSER_CHROME_UNAVAILABLE');
 const manifest=readWebManifest(path.join(args.dir,'web-generation.json'));assert.equal(manifest.errorCode,'BROWSER_CHROME_UNAVAILABLE');assert.equal(manifest.submitted,false);assert.equal(manifest.preSubmissionFailure,undefined);assert.equal(fs.existsSync(args.outputFile),false);
});
test('process exit without a result is unknown, not queued forever',async()=>{await assert.rejects(dispatchChatGptWebJob(setup('empty')),/执行已结束/);});
test('submission survives executor failure without a new execution',async()=>{const args=setup('submitted');await assert.rejects(dispatchChatGptWebJob(args));assert.equal(readWebManifest(path.join(args.dir,'web-generation.json')).submitted,true);await assert.rejects(dispatchChatGptWebJob(args),/请求已存在/);});
test('saved matching download survives an executor exit error',async()=>{assert.equal((await dispatchChatGptWebJob(setup('crash-after-download'))).manifest.state,'downloaded');});
test('direct execution has a bounded timeout',async()=>{const args=setup('hang');await assert.rejects(dispatchChatGptWebJob({...args,timeoutMs:100}),/等待时间较长/);});
test('invalid frozen references stop before the browser executor is spawned',async()=>{
 const args=setup('success'),missing=path.join(args.dir,'missing-reference.jpg');
 await assert.rejects(dispatchChatGptWebJob({...args,referenceFiles:[missing]}),error=>error.code==='REFERENCE_FILES_INVALID'&&/不存在或不可读/.test(error.message));
 assert.equal(fs.existsSync(path.join(args.dir,'worker-request.json')),false);
 assert.equal(fs.existsSync(path.join(args.dir,'argv.json')),false);
});
test('cancelled request never spawns or creates a request',async()=>{const args=setup('success'),controller=new AbortController();controller.abort();await assert.rejects(dispatchChatGptWebJob({...args,signal:controller.signal}),/已暂停/);assert(!fs.existsSync(path.join(args.dir,'worker-request.json')));});
test('worker timestamps are normalized before reaching the timing UI',()=>{
 const dir=fs.mkdtempSync(path.join(root,'timestamps-')),file=path.join(dir,'web-generation.json');
 fs.writeFileSync(file,JSON.stringify({state:'downloaded',requestId:'11111111-1111-4111-8111-111111111111',accepted:true,submitted:true,createdAt:'2026-09-13T02:00:50.032Z',acceptedAt:'2026-09-13T02:02:03.3NZ',readyAt:'not-a-date',submittedAt:'2026-09-13T02:08:22.300Z'}));
 const manifest=readWebManifest(file);
 assert.equal(manifest.acceptedAt,'2026-09-13T02:02:03.300Z');
 assert.equal(manifest.readyAt,null);
 assert.equal(manifest.submittedAt,'2026-09-13T02:08:22.300Z');
});
