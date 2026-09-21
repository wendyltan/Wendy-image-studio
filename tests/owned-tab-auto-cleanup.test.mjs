import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {autoRecoverOwnedTabCleanup} from '../server/chatgpt-web-provider.mjs';
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

test('automatic cleanup uses an isolated executor directory and the exact lease identity',async()=>{
  const run=fixture();
  let invocation=null;
  const result=await autoRecoverOwnedTabCleanup({dir:run.dir,timeoutMs:1000,runCodexImpl:async args=>{
    invocation=args;
    assert.notEqual(path.resolve(args.dir),path.resolve(run.dir));
    assert.equal(path.resolve(args.leaseDir),path.resolve(run.dir));
    assert.equal(args.runIdOverride,run.runId);
    const script=args.prompt.slice(args.prompt.indexOf('WENDI_OWNED_TAB_CLEANUP_V1'));
    assert.match(script,/cua\.getTab\("tab-owned"/);
    assert.doesNotMatch(script,/cua\.createBrowserTab|cua\.listTabs|tab\.goto|setFiles|filechooser|pageAssets|tab\.playwright/);
    markOwnedTabCleanup({dir:run.dir,runId:run.runId,requestId:run.requestId,status:'closed',ownedTabId:'tab-owned',verification:'exact-owned-tab-close-returned'});
  }});
  assert.equal(result.attempted,true);
  assert.equal(result.ok,true);
  assert.ok(invocation);
  assert.equal(readOwnedTabLease(run.dir,{runId:run.runId,requestId:run.requestId}).state,'closed_verified');
  const record=JSON.parse(fs.readFileSync(path.join(run.dir,'cleanup-recovery.json'),'utf8'));
  assert.equal(record.ok,true);
  assert.equal(record.ownedTabId,'tab-owned');
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
