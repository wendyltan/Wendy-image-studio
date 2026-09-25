import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {BROWSER_READINESS_EVALUATOR_SOURCE,BROWSER_READINESS_TIMEOUT_MS,BROWSER_READINESS_WAITER_SOURCE,evaluateBrowserReadiness,waitForBrowserReadiness} from '../server/browser-readiness.mjs';
import {chatGptWebImagePrompt} from '../server/web-executor-instructions.mjs';

const home='https://chatgpt.com';
const loadingAx=`Browser tab: 1514709776, URL: "https://chatgpt.com/".
14 pop up button (disabled, collapsed) Description: 打开个人资料菜单
15 text Loading profile
19 container 撰写器模式
20 checkbox (disabled) 聊天, Value: 1
21 checkbox (disabled) 工作, Value: 0
28 button (disabled, collapsed) Description: 添加文件等内容
29 text entry area (settable) Description: 给 ChatGPT 发消息
30 button (disabled) 发送`;
const readyAx=`Browser tab: 1514708902, URL: "https://chatgpt.com/".
34 button "Wu Wendi Plus，打开“个人资料”菜单":
  - generic: Wu Wendi
  - generic: Plus
45 button "添加文件等"
46 textbox "与 ChatGPT 聊天" [active]:
  - /placeholder: 问问 ChatGPT`;
const workModeAx=`Browser tab: 1514708902, URL: "https://chatgpt.com/".
34 button "另一个账号，打开“个人资料”菜单"
19 container 撰写器模式
20 checkbox 聊天, Value: 0
21 checkbox 工作, Value: 1
28 button 添加文件等
29 textbox 与 ChatGPT 聊天 [active]`;
const observedReadyAx=`36 checkbox (collapsed) Description: 筛选聊天和工作, Value: 0, ID: radix-_r_e0_
192 pop up button (collapsed) Description: 打开个人资料菜单
199 checkbox 聊天, Value: 1
200 checkbox 工作, Value: 0
214 button (collapsed) Description: 添加文件等内容
215 text entry area (settable) Description: 给 ChatGPT 发消息, Value: `;

test('loading profile and disabled chat/attachment controls fail the browser readiness gate',()=>{
  const result=evaluateBrowserReadiness({currentUrl:'https://chatgpt.com/',expectedUrl:home,ax:loadingAx,ownedTabId:'1514709776',runId:'run-loading'});
  assert.equal(result.ready,false);
  assert.equal(result.reason,'ui_not_ready');
  assert.equal(result.checks.profileLoaded,false);
  assert.equal(result.checks.chatModeActive,false);
  assert.equal(result.checks.attachmentEntryEnabled,false);
  assert.equal(result.checks.imageCreationAvailable,false);
});

test('a completed signed-in chat composer with enabled attachment entry is ready without a separate image-menu label',()=>{
  const result=evaluateBrowserReadiness({currentUrl:'https://chatgpt.com/',expectedUrl:home,ax:readyAx,ownedTabId:'1514708902',runId:'run-ready'});
  assert.equal(result.ready,true);
  assert.equal(result.imageCreationPath,'chat-composer');
  assert.deepEqual(result.checks,{targetUrlMatches:true,loginRequired:false,profileLoaded:true,explicitChatMode:false,chatModeEnabled:true,chatModeSelected:true,chatModeActive:true,composerEnabled:true,attachmentEntryEnabled:true,imageCreationAvailable:true});
  assert.match(BROWSER_READINESS_EVALUATOR_SOURCE,/function evaluateBrowserReadiness/);
});

test('a sidebar filter checkbox never shadows the exact selected chat-mode checkbox',()=>{
  const result=evaluateBrowserReadiness({currentUrl:'https://chatgpt.com/',expectedUrl:home,ax:observedReadyAx,ownedTabId:'diagnostic-tab',runId:'run-observed-ready'});
  assert.equal(result.ready,true);
  assert.equal(result.checks.chatModeSelected,true);
  assert.equal(result.checks.attachmentEntryEnabled,true);
  assert.equal(result.checks.imageCreationAvailable,true);
  const workResult=evaluateBrowserReadiness({currentUrl:'https://chatgpt.com/',expectedUrl:home,ax:observedReadyAx.replace('199 checkbox 聊天, Value: 1','199 checkbox 聊天, Value: 0').replace('200 checkbox 工作, Value: 0','200 checkbox 工作, Value: 1'),ownedTabId:'diagnostic-tab',runId:'run-observed-work'});
  assert.equal(workResult.checks.chatModeSelected,false);
  assert.equal(workResult.checks.chatModeEnabled,true);
});

test('the readiness polling window fails at 30 seconds but accepts the same page after 35 seconds',async()=>{
  async function simulate(timeoutMs){
    let elapsed=0,reads=0;
    const result=await waitForBrowserReadiness({timeoutMs,pollIntervalMs:5000,now:()=>elapsed,wait:async ms=>{elapsed+=ms;},read:async()=>{reads++;return {ready:elapsed>=35000};}});
    return {result,elapsed,reads};
  }
  const early=await simulate(30000),extended=await simulate(BROWSER_READINESS_TIMEOUT_MS);
  assert.equal(early.result.ready,false);
  assert.equal(early.elapsed,30000);
  assert.equal(extended.result.ready,true);
  assert.equal(extended.elapsed,35000);
  assert.match(BROWSER_READINESS_WAITER_SOURCE,/if\s*\(readiness\?\.ready === true/);
});

test('profile readiness is based on the account-menu control, not a particular account name',()=>{
  const otherAccountAx=readyAx.replace('Wu Wendi Plus，打开“个人资料”菜单','另一个账号，打开“个人资料”菜单');
  const result=evaluateBrowserReadiness({currentUrl:'https://chatgpt.com/',expectedUrl:home,ax:otherAccountAx,ownedTabId:'tab-other-account',runId:'run-other-account'});
  assert.equal(result.ready,true);
  assert.equal(result.checks.profileLoaded,true);
});

test('an enabled but unchecked chat mode remains not-ready until switched and observed again',()=>{
  const result=evaluateBrowserReadiness({currentUrl:'https://chatgpt.com/',expectedUrl:home,ax:workModeAx,ownedTabId:'tab-work',runId:'run-work'});
  assert.equal(result.ready,false);
  assert.equal(result.checks.explicitChatMode,true);
  assert.equal(result.checks.chatModeEnabled,true);
  assert.equal(result.checks.chatModeSelected,false);
  assert.equal(result.checks.chatModeActive,false);
});

test('generated executor performs a same-call, bounded readiness gate before uploading',()=>{
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',referenceFiles:[],requestId:'11111111-1111-4111-8111-111111111111',runId:'run-fixture'});
  assert.match(instruction,/WENDI_BROWSER_READINESS_GATE_V1/);
  assert.match(instruction,/WENDI_BROWSER_READY_V1:/);
  assert.match(instruction,/timeoutMs:60000/);
  assert.match(instruction,/timeout_ms: 180000/);
  assert.match(instruction,/导航耗时没有单独可控的 timeout/);
  assert.match(instruction,/约 90 秒仅为导航\/页面加载的预算预留，内部 readiness gate 从 goto 返回后最多等待 60000 毫秒，另约 30 秒预留用于工具传输和返回/);
  assert.doesNotMatch(instruction,/内部 readiness gate 仍最多 30000 毫秒|最多等待 30 秒/);
  assert.match(instruction,/只调用一次 goto/);
  assert.match(instruction,/只有 readiness\.ready === true 才能写入 uploading/);
  assert.match(instruction,/缺少或未通过 readiness 证据时拒绝 uploading/);
  assert.match(instruction,/CHATGPT_LOGIN_REQUIRED/);
  assert.match(instruction,/BROWSER_MODE_ENTRY_UNAVAILABLE/);
  assert.match(instruction,/let chatModeSwitchAttempted=false/);
  assert.match(instruction,/chatMode\.count\(\)===1 && await chatMode\.isEnabled\(\).*chatMode\.check/);
  assert.match(instruction,/chatModeSwitchAttempted=true/);
  assert.match(instruction,/getByRole\('checkbox',\{name:\/\^\(聊天\|Chat\)\$\/\}\)/);
  const readinessFailureIndex=instruction.indexOf('其余 ui_not_ready 时执行');
  const uploadingIndex=instruction.indexOf('lease helper 必须从本 run');
  assert.ok(readinessFailureIndex>=0 && uploadingIndex>readinessFailureIndex,'typed readiness failure must be instructed before uploading');
});

test('generated readiness poll reads a full AX tree after the page changes',async()=>{
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',referenceFiles:[],requestId:'11111111-1111-4111-8111-111111111111',runId:'run-fixture'});
  const source=instruction.match(/read:async\(\)=>\{[\s\S]*?\},onNotReady:/)?.[0].replace(/,onNotReady:$/,'');
  assert.ok(source,'generated readiness poll must be present');
  const tab={
    url:async()=>home+'/',
    getAXState:async options=>options.disableDiffing?observedReadyAx:'Browser tab: 1514708902, URL: "https://chatgpt.com/".\nThere has been no change in the accessibility tree.\nThe focused UI element is 215 text entry area (settable) Description: 给 ChatGPT 发消息',
  };
  const read=runInNewContext(`({${source}}).read`,{tab,evaluateReadiness:evaluateBrowserReadiness,expectedUrl:home+'/',ownedTabId:'diagnostic-tab',runId:'run-fixture'});
  assert.equal((await read()).ready,true);
});

test('home navigation target matches the browser canonical URL',()=>{
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',referenceFiles:[],requestId:'11111111-1111-4111-8111-111111111111',runId:'run-fixture'});
  const goto=instruction.match(/await tab\.goto\("(https:\/\/chatgpt\.com\/?)"\)/)?.[1];
  const expected=instruction.match(/expectedUrl="(https:\/\/chatgpt\.com\/?)"/)?.[1];
  assert.ok(goto&&expected,'generated prompt must freeze both navigation and expected URL');
  assert.equal(goto,new URL(goto).href,'browser URL must not gain an unanticipated trailing slash');
  assert.equal(expected,goto);
});

test('generated cleanup CUA example parses as a top-level module and closes once',()=>{
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/out.png',manifestFile:'/tmp/run/web-generation.json',prompt:'fixture',referenceFiles:[],requestId:'11111111-1111-4111-8111-111111111111',runId:'run-fixture'});
  const example=instruction.match(/<cleanup_cua_example>\n([\s\S]*?)\n<\/cleanup_cua_example>/)?.[1];
  assert.ok(example,'generated prompt must include an exact cleanup script');
  assert.equal((example.match(/await tab\.close\(\)/g)||[]).length,1);
  const syntax=spawnSync(process.execPath,['--check','--input-type=module'],{input:example,encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
});
