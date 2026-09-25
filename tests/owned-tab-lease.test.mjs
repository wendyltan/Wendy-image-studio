import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {
  ensureOwnedTabLease,
  finalizeOwnedTabLease,
  markOwnedTabCleanup,
  markOwnedTabStage,
  ownedTabSessionName,
  prepareOwnedTabCleanup,
  readOwnedTabLease,
  resetOwnedTabLeaseForResume,
  reserveOwnedTabCreate,
} from '../server/owned-tab-lease.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wendi-owned-tab-'));
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  return {dir, runId: path.basename(dir), requestId: crypto.randomUUID()};
}

function appendReadinessEvent(run, {overrides = {}, sourceChecks = {}, eventType = 'item.completed', itemType = 'mcp_tool_call', truncated = false, compactSummary = false, omitEvidence = false, source = '// WENDI_BROWSER_READINESS_GATE_V1\nawait tab.goto("https://chatgpt.com/");'} = {}) {
  const evidence = {
    marker: 'WENDI_BROWSER_READY_V1', schemaVersion: 1, ready: true,
    ownedTabId: 'tab-fixture', runId: run.runId,
    currentUrl: 'https://chatgpt.com/', expectedUrl: 'https://chatgpt.com/',
    imageCreationPath: 'chat-composer',
    checks: {targetUrlMatches: true, loginRequired: false, profileLoaded: true, explicitChatMode: true, chatModeEnabled: true, chatModeSelected: true, chatModeActive: true, composerEnabled: true, attachmentEntryEnabled: true, imageCreationAvailable: true},
    ...overrides,
  };
  const event = {
    type: eventType,
    ...(truncated ? {truncated: true} : {}),
    item: {
      id: 'item-readiness', type: itemType, server: 'cua_repl', tool: 'js',
      ...(compactSummary ? {code: `${source.slice(0,800)}…[truncated]`} : {arguments: {code: source}}),
      ...(!omitEvidence ? {browserReadinessEvidence: {
        complete: true, source: 'cua_completed_result',
        sourceChecks: {gateMarkerPresent: true, gotoCount: 1, createTabCount: 0, checkCount: 0, axReadCount: 1, urlReadCount: 1, getTabCount: 0, setFilesCount: 0, clickCount: 0, pasteCount: 0, setValueCount: 0, typeTextCount: 0, pressKeyCount: 0, ownedHandleReferencePresent: true, scriptMatchesExpected:true,scriptSha256:crypto.createHash('sha256').update(source).digest('hex'),expectedScriptSha256:crypto.createHash('sha256').update(source).digest('hex'), ...sourceChecks},
        ...evidence,
      }} : {}),
    },
  };
  fs.appendFileSync(path.join(run.dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  if (eventType === 'item.completed' && itemType === 'mcp_tool_call') {
    fs.writeFileSync(path.join(run.dir, 'browser-readiness-latest.json'), JSON.stringify({
      schemaVersion: 1, source: 'bridge_cua_completed_item', eventType,
      itemId: 'item-readiness', server: 'cua_repl', tool: 'js',
      browserReadinessEvidence: omitEvidence ? null : event.item.browserReadinessEvidence,
    }));
    const expectedSha256=crypto.createHash('sha256').update(source).digest('hex');
    fs.writeFileSync(path.join(run.dir,'browser-bootstrap-expected.json'),JSON.stringify({schemaVersion:1,runId:run.runId,sha256:expectedSha256,code:source}));
    fs.writeFileSync(path.join(run.dir,'browser-bootstrap-script.json'),JSON.stringify({schemaVersion:1,runId:run.runId,itemId:'item-readiness',sha256:expectedSha256,expectedSha256,matchesExpected:true,code:source}));
  }
}

test('owned tab session names are unique per run/request and never reuse the old group name', () => {
  const one = ownedTabSessionName('run-a', crypto.randomUUID());
  const two = ownedTabSessionName('run-b', crypto.randomUUID());
  assert.match(one, /^🎨 温蒂生图-[a-f0-9]{8}$/);
  assert.match(two, /^🎨 温蒂生图-[a-f0-9]{8}$/);
  assert.notEqual(one, two);
});

test('reserve-create is atomic and a second create attempt is refused', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  const reserved = reserveOwnedTabCreate(run);
  assert.equal(reserved.state, 'creating');
  assert.throws(() => reserveOwnedTabCreate(run), error => error.code === 'OWNED_TAB_ALREADY_CREATED');
  assert.equal(readOwnedTabLease(run.dir, run).state, 'creating');
});

test('the parent reservation is required before stage-created and binds the returned handle', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  assert.throws(() => markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-before-reserve'}), error => error.code === 'OWNED_TAB_CREATE_NOT_RESERVED');
  const reserved = reserveOwnedTabCreate(run);
  assert.equal(reserved.state, 'creating');
  const created = markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-real-returned-by-createBrowserTab'});
  assert.equal(created.state, 'created');
  assert.equal(created.ownedTabId, 'tab-real-returned-by-createBrowserTab');
  assert.throws(() => markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-second-create'}), error => error.code === 'OWNED_TAB_ID_MISMATCH');
});

test('a failed create remains not-observed and never becomes verified closed', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  const failed = markOwnedTabCleanup({...run, status: 'not_observed', error: 'createBrowserTab returned no owned handle'});
  assert.equal(failed.state, 'orphaned');
  assert.equal(failed.cleanupStatus, 'not_observed');
  assert.equal(failed.ownedTabId, null);
  assert.equal(failed.cleanupVerifiedAt, null);
  assert.throws(() => markOwnedTabCleanup({...run, status: 'closed', verification: 'exact-owned-tab-close-returned'}), error => error.code === 'OWNED_TAB_ID_MISSING');
});

test('an audited resume resets a terminal lease and a pre-create reservation before reserving again', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-old'});
  markOwnedTabCleanup({...run, status: 'closed', ownedTabId: 'tab-old', verification: 'exact-owned-tab-close-returned'});
  const reset = resetOwnedTabLeaseForResume(run);
  assert.equal(reset.state, 'not_created');
  assert.equal(reset.cleanupStatus, 'not_attempted');
  assert.equal(reset.ownedTabId, null);
  const reserved = reserveOwnedTabCreate(run);
  assert.equal(reserved.state, 'creating');
  // `creating` without an ownedTabId means the executor stopped before
  // createBrowserTab returned. It is a safe pre-creation reservation, not an
  // ambiguous live tab, so an accepted-before-start quota resume may reuse it.
  const resetPreCreate = resetOwnedTabLeaseForResume(run);
  assert.equal(resetPreCreate.state, 'not_created');
});

test('stage transitions expose upload and send boundaries and reject regressions', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-fixture'});
  appendReadinessEvent(run);
  markOwnedTabStage({...run, state: 'uploading'});
  markOwnedTabStage({...run, state: 'uploaded'});
  assert.equal(readOwnedTabLease(run.dir, run).state, 'uploaded');
  assert.throws(() => markOwnedTabStage({...run, state: 'created'}), error => error.code === 'OWNED_TAB_STAGE_REGRESSION');
});

test('uploading requires fresh complete readiness from this run own CUA bootstrap result', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-fixture'});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');

  appendReadinessEvent(run, {eventType: 'agent_message'});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
  appendReadinessEvent(run, {truncated: true, omitEvidence: true});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
  appendReadinessEvent(run, {overrides: {ownedTabId: 'tab-someone-else'}});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
  appendReadinessEvent(run, {overrides: {runId: 'another-run'}});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
  appendReadinessEvent(run, {overrides: {ready: false, checks: {targetUrlMatches: true, loginRequired: false, profileLoaded: false, chatModeActive: false, composerEnabled: false, attachmentEntryEnabled: false, imageCreationAvailable: false}}});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
  appendReadinessEvent(run, {sourceChecks: {gotoCount: 2}, source: '// WENDI_BROWSER_READINESS_GATE_V1\nawait tab.goto("https://chatgpt.com/"); await tab.goto("https://chatgpt.com/c/other");'});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
  appendReadinessEvent(run, {sourceChecks: {setFilesCount: 1}, source: '// WENDI_BROWSER_READINESS_GATE_V1\nawait tab.goto("https://chatgpt.com/"); await chooser.setFiles(files);'});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
  appendReadinessEvent(run, {sourceChecks: {checkCount: 2}});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
  appendReadinessEvent(run, {sourceChecks: {checkCount: 1}, truncated: true, compactSummary: true});
  const uploading = markOwnedTabStage({...run, state: 'uploading'});
  assert.equal(uploading.browserReadiness.ready, true);
  assert.equal(uploading.browserReadiness.runId, run.runId);
  assert.equal(uploading.browserReadiness.ownedTabId, 'tab-fixture');
});

test('a retained readiness diagnostic never authorizes uploading after cleanup', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-fixture'});
  appendReadinessEvent(run);
  const file=path.join(run.dir,'browser-readiness-latest.json');
  const latest=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...latest,itemId:'item-cleanup',browserReadinessEvidence:null,lastReadinessDiagnostic:{itemId:'item-readiness',ready:true}}));
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading'}), error => error.code === 'OWNED_TAB_READINESS_REQUIRED');
});

test('a syntactically valid broadened chat checkbox script cannot authorize uploading', () => {
  const run=fixture();ensureOwnedTabLease(run);reserveOwnedTabCreate(run);
  markOwnedTabStage({...run,state:'created',ownedTabId:'tab-fixture'});
  appendReadinessEvent(run);
  const file=path.join(run.dir,'browser-bootstrap-script.json');
  const actual=JSON.parse(fs.readFileSync(file,'utf8'));
  actual.code=actual.code.replace('await tab.goto','const broadChatMode=/\\bcheckbox\\b[^\\n]*(?:聊天|Chat)/; await tab.goto');
  actual.sha256=crypto.createHash('sha256').update(actual.code).digest('hex');
  actual.matchesExpected=false;
  fs.writeFileSync(file,JSON.stringify(actual));
  assert.throws(()=>markOwnedTabStage({...run,state:'uploading'}),error=>error.code==='OWNED_TAB_READINESS_REQUIRED');
});

test('ready true missing any required readiness contract field cannot authorize uploading', () => {
  for(const key of ['targetUrlMatches','loginRequired','profileLoaded','explicitChatMode','chatModeEnabled','chatModeSelected','chatModeActive','composerEnabled','attachmentEntryEnabled','imageCreationAvailable']){
    const run=fixture();ensureOwnedTabLease(run);reserveOwnedTabCreate(run);
    markOwnedTabStage({...run,state:'created',ownedTabId:'tab-fixture'});
    appendReadinessEvent(run);
    const file=path.join(run.dir,'browser-readiness-latest.json');
    const latest=JSON.parse(fs.readFileSync(file,'utf8'));
    delete latest.browserReadinessEvidence.checks[key];
    fs.writeFileSync(file,JSON.stringify(latest));
    assert.throws(()=>markOwnedTabStage({...run,state:'uploading'}),error=>error.code==='OWNED_TAB_READINESS_REQUIRED',key);
  }
});

test('created and verified close both require the reserved real handle', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  assert.throws(() => markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-without-reservation'}), error => error.code === 'OWNED_TAB_CREATE_NOT_RESERVED');
  reserveOwnedTabCreate(run);
  assert.throws(() => markOwnedTabCleanup({...run, status: 'closed', verification: 'exact-owned-tab-close-returned'}), error => error.code === 'OWNED_TAB_ID_MISSING');
  assert.throws(() => markOwnedTabCleanup({...run, status: 'close_failed', error: 'close threw'}), error => error.code === 'OWNED_TAB_ID_MISSING');
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-close-throw'});
  const failed = markOwnedTabCleanup({...run, status: 'close_failed', ownedTabId: 'tab-close-throw', error: 'close threw'});
  assert.equal(failed.state, 'close_unconfirmed');
  assert.equal(failed.cleanupStatus, 'close_failed');
  assert.throws(() => markOwnedTabCleanup({...run, status: 'closed', ownedTabId: 'tab-close-throw', verification: 'exact-owned-tab-close-returned'}), error => error.code === 'OWNED_TAB_LEASE_TERMINAL');
});

test('stage and cleanup reject a handle that differs from the reserved tab', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-reserved'});
  assert.throws(() => markOwnedTabStage({...run, state: 'uploading', ownedTabId: 'tab-other'}), error => error.code === 'OWNED_TAB_ID_MISMATCH');
  assert.throws(() => markOwnedTabCleanup({...run, status: 'closed', ownedTabId: 'tab-other', verification: 'exact-owned-tab-close-returned'}), error => error.code === 'OWNED_TAB_ID_MISMATCH');
  const closed = markOwnedTabCleanup({...run, status: 'closed', ownedTabId: 'tab-reserved', verification: 'exact-owned-tab-close-returned'});
  assert.equal(closed.state, 'closed_verified');
});

test('verified close is distinct from close failure and handle loss', () => {
  const closed = fixture();
  ensureOwnedTabLease(closed);
  reserveOwnedTabCreate(closed);
  markOwnedTabStage({...closed, state: 'created', ownedTabId: 'tab-closed'});
  const result = markOwnedTabCleanup({...closed, status: 'closed', ownedTabId: 'tab-closed', verification: 'exact-owned-tab-close-returned'});
  assert.equal(result.state, 'closed_verified');
  assert.equal(result.cleanupStatus, 'closed');
  assert.ok(result.cleanupVerifiedAt);
  assert.throws(() => markOwnedTabCleanup({...closed, status: 'closed', ownedTabId: 'tab-closed', verification: 'guess'}), error => error.code === 'OWNED_TAB_CLOSE_EVIDENCE_REQUIRED');

  const lost = fixture();
  ensureOwnedTabLease(lost);
  reserveOwnedTabCreate(lost);
  markOwnedTabStage({...lost, state: 'created', ownedTabId: 'tab-lost'});
  const orphaned = markOwnedTabCleanup({...lost, status: 'not_observed', ownedTabId: 'tab-lost', error: 'kernel reset', kernelReset: true});
  assert.equal(orphaned.state, 'orphaned');
  assert.equal(orphaned.cleanupStatus, 'not_observed');
  assert.equal(orphaned.kernelReset, true);
  assert.equal(orphaned.cleanupVerifiedAt, null);
});

test('a downloaded run still records verified cleanup evidence', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-downloaded'});
  appendReadinessEvent(run, {overrides: {ownedTabId: 'tab-downloaded'}});
  for (const state of ['uploading', 'uploaded', 'sent', 'generating', 'downloaded']) {
    markOwnedTabStage({...run, state});
  }
  const downloaded = readOwnedTabLease(run.dir, run);
  assert.equal(downloaded.state, 'downloaded');
  const closed = markOwnedTabCleanup({...run, status: 'closed', ownedTabId: 'tab-downloaded', verification: 'exact-owned-tab-close-returned'});
  assert.equal(closed.state, 'closed_verified');
  assert.equal(closed.cleanupStatus, 'closed');
  assert.ok(closed.cleanupVerifiedAt);
  assert.equal(closed.kernelReset, false);
});

test('executor exit records pending cleanup and never claims a tab closed', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-exit'});
  const result = finalizeOwnedTabLease({...run, reason: 'timeout'});
  assert.equal(result.state, 'orphaned');
  assert.equal(result.cleanupStatus, 'cleanup_pending');
  assert.equal(result.cleanupVerifiedAt, null);
  assert.match(result.cleanupError, /无法直接调用 CUA close/);
});

test('approval, abort, timeout, and CLI exit all use the same conservative finalizer', () => {
  for (const reason of ['approval-failure', 'abort', 'timeout', 'cli-exit']) {
    const run = fixture();
    ensureOwnedTabLease(run);
    reserveOwnedTabCreate(run);
    markOwnedTabStage({...run, state: 'created', ownedTabId: `tab-${reason}`});
    const result = finalizeOwnedTabLease({...run, reason});
    assert.equal(result.state, 'orphaned');
    assert.equal(result.cleanupStatus, 'cleanup_pending');
    assert.equal(result.ownedTabId, `tab-${reason}`);
    assert.match(result.cleanupError, new RegExp(reason));
  }
});

test('executor exit before a handle is observed keeps the pre-create reservation clean', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  const result = finalizeOwnedTabLease({...run, reason: 'kernel-reset', kernelReset: true});
  assert.equal(result.state, 'creating');
  assert.equal(result.cleanupStatus, 'not_attempted');
  assert.equal(result.ownedTabId, null);
  assert.equal(result.kernelReset, false);
});

test('orphaned lease cannot be converted to closing by cross-executor bookkeeping', () => {
  const run = fixture();
  ensureOwnedTabLease(run);
  reserveOwnedTabCreate(run);
  markOwnedTabStage({...run, state: 'created', ownedTabId: 'tab-orphan'});
  finalizeOwnedTabLease({...run, reason: 'budget'});
  assert.throws(() => markOwnedTabStage({...run, state: 'closing', ownedTabId: 'tab-orphan'}), error => error.code === 'OWNED_TAB_ORPHANED_RECOVERY_REQUIRED');
  assert.throws(() => markOwnedTabStage({...run, state: 'uploaded'}), error => error.code === 'OWNED_TAB_ORPHANED_RECOVERY_REQUIRED');
  const lease = readOwnedTabLease(run.dir, run);
  assert.equal(lease.state, 'orphaned');
  assert.equal(lease.cleanupStatus, 'cleanup_pending');
  assert.throws(() => prepareOwnedTabCleanup({...run, ownedTabId: 'tab-orphan'}), error => error.code === 'OWNED_TAB_CROSS_SESSION_UNAVAILABLE');
  assert.throws(() => prepareOwnedTabCleanup({...run, ownedTabId: 'tab-other'}), error => error.code === 'OWNED_TAB_ID_MISMATCH');
  assert.equal(readOwnedTabLease(run.dir, run).state, 'orphaned');
});
