#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {patchManifest} from './run-manifest.mjs';

/**
 * The Chrome extension owns the actual browser handle.  Node cannot safely
 * discover or close arbitrary tabs, so this file is the durable ownership
 * boundary between the local runner and the remote CUA executor.  A lease is
 * created before the child starts and can be claimed exactly once.  Every
 * later transition is append-safe and identity-bound to this run.
 */

export const OWNED_TAB_LEASE_FILE = 'owned-tab-lease.json';
export const OWNED_TAB_LEASE_LOCK = 'owned-tab-lease.json.lock';
export const OWNED_TAB_STATES = Object.freeze([
  'not_created',
  'creating',
  'created',
  'uploading',
  'uploaded',
  'sent',
  'generating',
  'downloaded',
  'closing',
  'closed_verified',
  'close_unconfirmed',
  'orphaned',
]);
export const OWNED_TAB_CLEANUP_STATUSES = Object.freeze([
  'not_attempted',
  'open',
  'closed',
  'close_failed',
  'not_observed',
  'orphaned',
]);

const TERMINAL_STATES = new Set(['closed_verified', 'close_unconfirmed', 'orphaned']);
const CREATED_OR_LATER_STATES = new Set(['created', 'uploading', 'uploaded', 'sent', 'generating', 'downloaded', 'closing']);
const STATE_ORDER = new Map(OWNED_TAB_STATES.map((state, index) => [state, index]));
const ID_RE = /^[a-f0-9-]{36}$/i;

function now() {
  return new Date().toISOString();
}

function text(value) {
  return String(value ?? '').trim();
}

function leaseFileFor(dir) {
  return path.join(path.resolve(String(dir || '')), OWNED_TAB_LEASE_FILE);
}

function manifestFileFor(dir, file) {
  return path.resolve(String(file || path.join(path.resolve(String(dir || '')), 'web-generation.json')));
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined && fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function readLeaseFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function acquire(file) {
  const lock = `${file}.lock`;
  try {
    const fd = fs.openSync(lock, 'wx', 0o600);
    return () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lock); } catch {}
    };
  } catch (error) {
    if (error.code === 'EEXIST') {
      const busy = new Error('owned tab lease 正在被另一项状态更新占用。');
      busy.code = 'OWNED_TAB_LEASE_BUSY';
      throw busy;
    }
    throw error;
  }
}

function validateIdentity(value, expected = {}) {
  const lease = value || {};
  const runId = text(expected.runId || lease.runId);
  const requestId = text(expected.requestId || lease.requestId);
  if (!runId) throw Object.assign(new Error('owned tab lease 缺少 runId。'), {code: 'OWNED_TAB_IDENTITY_INVALID'});
  if (!requestId || !ID_RE.test(requestId)) throw Object.assign(new Error('owned tab lease 缺少有效 requestId。'), {code: 'OWNED_TAB_IDENTITY_INVALID'});
  if (lease.runId && text(lease.runId) !== runId) throw Object.assign(new Error('owned tab lease 的 runId 不匹配。'), {code: 'REQUEST_IDENTITY_MISMATCH'});
  if (lease.requestId && text(lease.requestId) !== requestId) throw Object.assign(new Error('owned tab lease 的 requestId 不匹配。'), {code: 'REQUEST_IDENTITY_MISMATCH'});
  return {runId, requestId};
}

function normalizeLease(value, expected = {}) {
  const input = value || {};
  const {runId, requestId} = validateIdentity(input, expected);
  const state = OWNED_TAB_STATES.includes(input.state) ? input.state : 'not_created';
  const cleanupStatus = OWNED_TAB_CLEANUP_STATUSES.includes(input.cleanupStatus)
    ? input.cleanupStatus
    : 'not_attempted';
  return {
    schemaVersion: 1,
    runId,
    requestId,
    sessionName: text(input.sessionName) || null,
    ownedTabId: text(input.ownedTabId) || null,
    createdAt: input.createdAt || null,
    state,
    cleanupStatus,
    cleanupVerifiedAt: input.cleanupVerifiedAt || null,
    cleanupError: input.cleanupError ? text(input.cleanupError).slice(0, 1000) : null,
    kernelReset: input.kernelReset === true,
    updatedAt: input.updatedAt || now(),
    ...(input.createdBy ? {createdBy: text(input.createdBy).slice(0, 120)} : {}),
  };
}

export function shortRunToken(runId, requestId = '') {
  const seed = `${text(runId)}:${text(requestId)}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
}

export function ownedTabSessionName(runId, requestId = '') {
  return `🎨 温蒂生图-${shortRunToken(runId, requestId)}`;
}

export function readOwnedTabLease(dir, expected = {}) {
  const file = leaseFileFor(dir);
  const value = readLeaseFile(file);
  if (!value) return null;
  return normalizeLease(value, expected);
}

function writeLease(file, current, next) {
  const normalized = normalizeLease({...current, ...next}, {runId: next.runId || current.runId, requestId: next.requestId || current.requestId});
  atomicWrite(file, {...normalized, updatedAt: now()});
  return normalized;
}

function withLease(dir, expected, callback) {
  const file = leaseFileFor(dir);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const release = acquire(file);
  try {
    const current = readLeaseFile(file);
    if (current) validateIdentity(current, expected);
    return callback(file, current ? normalizeLease(current, expected) : null);
  } finally {
    release();
  }
}

/** Ensure the run has one durable not-created lease before the child starts. */
export function ensureOwnedTabLease({dir, runId, requestId, sessionName = null} = {}) {
  const expected = {runId: text(runId) || path.basename(path.resolve(String(dir || ''))), requestId};
  return withLease(dir, expected, (file, current) => {
    if (current) {
      if (current.state !== 'not_created') {
        const error = new Error(`本次 run 已经尝试创建 owned tab（${current.state}），禁止第二次 createBrowserTab。`);
        error.code = 'OWNED_TAB_ALREADY_CREATED';
        error.lease = current;
        throw error;
      }
      const nextSession = current.sessionName || sessionName || ownedTabSessionName(expected.runId, expected.requestId);
      return writeLease(file, current, {sessionName: nextSession, state: 'not_created'});
    }
    const initial = normalizeLease({
      runId: expected.runId,
      requestId: expected.requestId,
      sessionName: sessionName || ownedTabSessionName(expected.runId, expected.requestId),
      state: 'not_created',
      cleanupStatus: 'not_attempted',
    }, expected);
    atomicWrite(file, initial);
    return initial;
  });
}

/** Atomically reserve the one and only createBrowserTab attempt. */
export function reserveOwnedTabCreate({dir, runId, requestId, sessionName = null} = {}) {
  const expected = {runId: text(runId) || path.basename(path.resolve(String(dir || ''))), requestId};
  return withLease(dir, expected, (file, current) => {
    const lease = current || normalizeLease({
      runId: expected.runId,
      requestId: expected.requestId,
      sessionName: sessionName || ownedTabSessionName(expected.runId, expected.requestId),
      state: 'not_created',
      cleanupStatus: 'not_attempted',
    }, expected);
    if (lease.state !== 'not_created') {
      const error = new Error(`本次 run 已经尝试创建 owned tab（${lease.state}），禁止第二次 createBrowserTab。`);
      error.code = 'OWNED_TAB_ALREADY_CREATED';
      error.lease = lease;
      throw error;
    }
    return writeLease(file, lease, {
      state: 'creating',
      sessionName: lease.sessionName || sessionName || ownedTabSessionName(expected.runId, expected.requestId),
    });
  });
}

const ALLOWED_STAGES = new Set(['created', 'uploading', 'uploaded', 'sent', 'generating', 'downloaded', 'closing']);

export function markOwnedTabStage({dir, runId, requestId, state, ownedTabId, sessionName, createdAt} = {}) {
  const expected = {runId: text(runId) || path.basename(path.resolve(String(dir || ''))), requestId};
  const nextState = text(state);
  if (!ALLOWED_STAGES.has(nextState)) throw Object.assign(new Error(`不支持的 owned tab 阶段：${nextState}`), {code: 'OWNED_TAB_STAGE_INVALID'});
  return withLease(dir, expected, (file, current) => {
    const lease = current || normalizeLease({runId: expected.runId, requestId: expected.requestId}, expected);
    if (TERMINAL_STATES.has(lease.state)) {
      const error = new Error(`owned tab lease 已进入终态 ${lease.state}，不能回写 ${nextState}。`);
      error.code = 'OWNED_TAB_LEASE_TERMINAL';
      throw error;
    }
    if (STATE_ORDER.get(nextState) < STATE_ORDER.get(lease.state)) {
      const error = new Error(`owned tab lease 阶段不能回退：${lease.state} -> ${nextState}。`);
      error.code = 'OWNED_TAB_STAGE_REGRESSION';
      throw error;
    }
    if (nextState === 'created' && lease.state !== 'creating') {
      const error = new Error(`owned tab 必须先原子预留创建：${lease.state} -> created。`);
      error.code = 'OWNED_TAB_CREATE_NOT_RESERVED';
      throw error;
    }
    if (CREATED_OR_LATER_STATES.has(nextState) && !text(ownedTabId) && !lease.ownedTabId) {
      const error = new Error(`${nextState} 阶段必须保留实际 ownedTabId。`);
      error.code = 'OWNED_TAB_ID_MISSING';
      throw error;
    }
    if (nextState === 'created' && !text(ownedTabId)) throw Object.assign(new Error('created 阶段必须记录实际 ownedTabId。'), {code: 'OWNED_TAB_ID_MISSING'});
    const next = {
      state: nextState,
      ownedTabId: text(ownedTabId) || lease.ownedTabId,
      sessionName: text(sessionName) || lease.sessionName,
      createdAt: createdAt || lease.createdAt || (nextState === 'created' ? now() : null),
      cleanupStatus: nextState === 'created' || nextState === 'closing' ? 'open' : lease.cleanupStatus,
    };
    return writeLease(file, lease, next);
  });
}

export function markOwnedTabCleanup({dir, runId, requestId, status, ownedTabId, error: cleanupError = null, kernelReset = false, verification = null} = {}) {
  const expected = {runId: text(runId) || path.basename(path.resolve(String(dir || ''))), requestId};
  const cleanupStatus = text(status);
  if (!OWNED_TAB_CLEANUP_STATUSES.includes(cleanupStatus) || cleanupStatus === 'not_attempted' || cleanupStatus === 'open') {
    throw Object.assign(new Error(`不支持的 cleanupStatus：${cleanupStatus}`), {code: 'OWNED_TAB_CLEANUP_INVALID'});
  }
  if (cleanupStatus === 'closed' && text(verification) !== 'exact-owned-tab-close-returned') {
    throw Object.assign(new Error('closed 必须携带同一 owned tab close 返回成功的验证证据。'), {code: 'OWNED_TAB_CLOSE_EVIDENCE_REQUIRED'});
  }
  return withLease(dir, expected, (file, current) => {
    const lease = current || normalizeLease({runId: expected.runId, requestId: expected.requestId}, expected);
    const closed = cleanupStatus === 'closed';
    const observed = cleanupStatus === 'not_observed' || cleanupStatus === 'orphaned';
    if (TERMINAL_STATES.has(lease.state)) {
      const error = new Error(`owned tab lease 已进入终态 ${lease.state}，不能再次写入 cleanup。`);
      error.code = 'OWNED_TAB_LEASE_TERMINAL';
      throw error;
    }
    if (closed && !text(ownedTabId) && !lease.ownedTabId) {
      throw Object.assign(new Error('closed 必须携带实际 ownedTabId。'), {code: 'OWNED_TAB_ID_MISSING'});
    }
    if (cleanupStatus === 'close_failed' && !text(ownedTabId) && !lease.ownedTabId) {
      throw Object.assign(new Error('close_failed 必须携带实际 ownedTabId。'), {code: 'OWNED_TAB_ID_MISSING'});
    }
    if ((closed || cleanupStatus === 'close_failed') && ['not_created', 'creating'].includes(lease.state)) {
      throw Object.assign(new Error(`owned tab 尚未创建，不能记录 ${cleanupStatus}。`), {code: 'OWNED_TAB_NOT_CREATED'});
    }
    const next = {
      ownedTabId: text(ownedTabId) || lease.ownedTabId,
      state: closed ? 'closed_verified' : observed ? 'orphaned' : 'close_unconfirmed',
      cleanupStatus,
      cleanupVerifiedAt: closed ? now() : null,
      cleanupError: cleanupError ? text(cleanupError).slice(0, 1000) : null,
      kernelReset: Boolean(kernelReset),
    };
    return writeLease(file, lease, next);
  });
}

/** Best-effort local close handshake when the child exits, aborts, or times out. */
export function finalizeOwnedTabLease({dir, runId, requestId, reason = 'executor-exit', kernelReset = false} = {}) {
  const lease = readOwnedTabLease(dir, {runId, requestId});
  if (!lease || lease.state === 'not_created' || TERMINAL_STATES.has(lease.state)) return lease;
  // The Node parent cannot call CUA close.  A known handle therefore still
  // needs an explicit not_observed result; close_failed is reserved for the
  // executor reporting that the same handle's close() actually threw.
  const status = 'not_observed';
  return markOwnedTabCleanup({
    dir,
    runId: lease.runId,
    requestId: lease.requestId,
    status,
    ownedTabId: lease.ownedTabId,
    error: `${reason}：Node 外层无法直接调用 CUA close；保留为未确认，不接管任何其他标签页。`,
    kernelReset,
  });
}

function manifestArgsFromLease(lease) {
  const args = {
    ownedTabCleanupStatus: lease.cleanupStatus,
    ownedTabState: lease.state,
    sessionName: lease.sessionName,
    ownedTabCreatedAt: lease.createdAt,
    cleanupStatus: lease.cleanupStatus,
  };
  // A prompt can observe a handle before the local lease helper gets to
  // persist it. Never overwrite that stronger manifest evidence with null.
  if (lease.ownedTabId) args.ownedTabId = lease.ownedTabId;
  if (lease.cleanupVerifiedAt) args.cleanupVerifiedAt = lease.cleanupVerifiedAt;
  if (lease.cleanupError) args.cleanupError = lease.cleanupError;
  if (lease.kernelReset) args.kernelReset = true;
  return args;
}

/** Mirror lease evidence into the manifest without allowing identity changes. */
export function syncOwnedTabLeaseToManifest({dir, manifestFile, lease = null, stage = 'cleanup'} = {}) {
  const current = lease || readOwnedTabLease(dir);
  if (!current) return null;
  const file = manifestFileFor(dir, manifestFile);
  if (!fs.existsSync(file)) return current;
  try {
    return patchManifest({stage, manifestFile: file, args: manifestArgsFromLease(current)}).manifest;
  } catch {
    // The executor may have written a legacy manifest.  The lease remains the
    // source of truth and the caller still gets a durable cleanup record.
    return current;
  }
}

function parseArgs(argv) {
  const [stage, ...rest] = argv;
  const args = {stage};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`不支持的参数：${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} 缺少值。`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function cli() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.dirname(path.resolve(args.leaseFile || path.join(args.runDir || '', OWNED_TAB_LEASE_FILE)));
  const common = {dir, runId: args.runId || path.basename(dir), requestId: args.requestId};
  let lease;
  if (args.stage === 'ensure') lease = ensureOwnedTabLease({...common, sessionName: args.sessionName});
  else if (args.stage === 'reserve-create') lease = reserveOwnedTabCreate({...common, sessionName: args.sessionName});
  else if (args.stage === 'stage') lease = markOwnedTabStage({...common, state: args.state, ownedTabId: args.ownedTabId, sessionName: args.sessionName, createdAt: args.createdAt});
  else if (args.stage === 'cleanup') lease = markOwnedTabCleanup({...common, status: args.status, ownedTabId: args.ownedTabId, error: args.error, kernelReset: args.kernelReset === 'true', verification: args.verification});
  else throw new Error(`不支持的 owned tab lease 阶段：${args.stage}`);
  const manifest = args.manifestFile ? syncOwnedTabLeaseToManifest({dir, manifestFile: args.manifestFile, lease}) : null;
  process.stdout.write(JSON.stringify({ok: true, lease, manifest}) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
