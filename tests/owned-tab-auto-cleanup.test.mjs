import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {autoRecoverOwnedTabCleanup} from '../server/chatgpt-web-provider.mjs';
import {ownedTabCleanupPrompt} from '../server/web-executor-instructions.mjs';
import {ensureOwnedTabLease,finalizeOwnedTabLease,markOwnedTabCleanup,markOwnedTabStage,reserveOwnedTabCreate,readOwnedTabLease} from '../server/owned-tab-lease.mjs';

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-auto-cleanup-'));
  const runId=path.basename(dir),requestId='11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(dir,'web-generation.json'),JSON.stringify({schemaVersion:2,state:'failed',runId,requestId,ownedTabId:'tab-owned',projectId:'project',projectVersion:2,taskId:'task',target:'第1页-第1格'}));
  ensureOwnedTabLease({dir,runId,requestId});
  reserveOwnedTabCreate({dir,runId,requestId});
  markOwnedTabStage({dir,runId,requestId,state:'created',ownedTabId:'tab-owned'});
  finalizeOwnedTabLease({dir,runId,requestId,reason:'fixture'});
  return {dir,runId,requestId};
}

test('automatic cleanup does not launch a new executor that cannot rebind the old CUA session',async()=>{
  const run=fixture();
  let called=false;
  const result=await autoRecoverOwnedTabCleanup({dir:run.dir,timeoutMs:1000,runCodexImpl:async()=>{called=true;}});
  assert.equal(result.attempted,false);
  assert.equal(result.blocked,true);
  assert.equal(result.reason,'cross_executor_session_cannot_rebind');
  assert.equal(called,false);
  assert.equal(readOwnedTabLease(run.dir,{runId:run.runId,requestId:run.requestId}).state,'orphaned');
  const record=JSON.parse(fs.readFileSync(path.join(run.dir,'cleanup-recovery.json'),'utf8'));
  assert.equal(record.blocked,true);
  assert.equal(record.ownedTabId,'tab-owned');
});

test('cleanup-only prompt does not attempt cross-session tab discovery',()=>{
  const prompt=ownedTabCleanupPrompt({manifestFile:'/tmp/fixture/web-generation.json',runId:'fixture-run',requestId:'11111111-1111-4111-8111-111111111111',ownedTabId:'tab-owned'});
  assert.match(prompt,/原执行器仍持有同一持久句柄/);
  assert.match(prompt,/新执行器无法通过 cua\.getTab 重新绑定/);
  assert.doesNotMatch(prompt,/cua\.(?:getTab|listTabs|createBrowserTab)\s*\(/);
});

test('a non-orphaned lease does not start cleanup-only',async()=>{
  const run=fixture();
  markOwnedTabCleanup({dir:run.dir,runId:run.runId,requestId:run.requestId,status:'closed',ownedTabId:'tab-owned',verification:'exact-owned-tab-close-returned'});
  let called=false;
  const result=await autoRecoverOwnedTabCleanup({dir:run.dir,runCodexImpl:async()=>{called=true;}});
  assert.equal(result.attempted,false);
  assert.equal(called,false);
  assert.equal(fs.existsSync(path.join(run.dir,'cleanup-recovery.json')),false);
});
