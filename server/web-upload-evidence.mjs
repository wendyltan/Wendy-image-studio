import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Machine-readable evidence for the pre-submission attachment gate.
 *
 * The browser executor may observe DOM semantics, but the provider is the
 * authority that decides whether those observations are sufficient to move a
 * run past upload.  Natural-language prose is deliberately not accepted by
 * this module.
 */
export const UPLOAD_EVIDENCE_SCHEMA_VERSION = 1;
export const UPLOAD_EVIDENCE_FILE = 'upload-evidence.json';

const UPLOAD_METHODS = new Set([
  'direct-button',
  'direct-button-testid',
  'menu-fallback',
  'menu-fallback-testid',
]);
const FAILURE_STAGES = new Set([
  'browser-create',
  'browser-handle',
  'browser-mode-entry',
  'chooser-event',
  'chooser-route',
  'file-set',
  'attachment-verification',
  'submission',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function integer(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolean(value, fallback = null) {
  return typeof value === 'boolean' ? value : fallback;
}

function names(value) {
  return Array.isArray(value) ? value.map(item => text(item)).filter(Boolean) : [];
}

function pendingValue(value) {
  if (Array.isArray(value)) return names(value);
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return null;
  return Boolean(value);
}

export function normalizeUploadEvidence(value, {failureStage = null} = {}) {
  const input = object(value) || {};
  const normalized = {
    schemaVersion: integer(input.schemaVersion, UPLOAD_EVIDENCE_SCHEMA_VERSION),
    source: text(input.source) || 'browser-upload',
    uploadMethod: text(input.uploadMethod) || null,
    chooserEventObserved: boolean(input.chooserEventObserved),
    chooserAttachedBeforeClick: boolean(input.chooserAttachedBeforeClick),
    attachmentExpected: integer(input.attachmentExpected),
    attachmentObserved: integer(input.attachmentObserved),
    attachmentNames: names(input.attachmentNames),
    attachmentPending: pendingValue(input.attachmentPending),
    sendEnabled: boolean(input.sendEnabled),
    failureStage: text(input.failureStage) || failureStage || null,
    capturedAt: text(input.capturedAt) || null,
  };
  for (const key of ['projectId', 'projectVersion', 'taskId', 'target', 'requestId', 'runId']) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') normalized[key] = input[key];
  }
  if (input.errorCode !== undefined && input.errorCode !== null && input.errorCode !== '') normalized.errorCode = text(input.errorCode);
  if (input.error !== undefined && input.error !== null && input.error !== '') normalized.error = text(input.error).slice(0, 1000);
  if (input.alternateRouteUsed !== undefined) normalized.alternateRouteUsed = Boolean(input.alternateRouteUsed);
  if (input.alternateRouteCount !== undefined) normalized.alternateRouteCount = integer(input.alternateRouteCount, null);
  return normalized;
}

function pendingNames(value) {
  return Array.isArray(value) ? value.length > 0 : value === true;
}

/**
 * Validate evidence against the frozen server-side attachment list.  This
 * does not read local files and intentionally has no fs.accessSync path.
 */
export function validateUploadEvidence(value, {expectedCount = null, expectedNames = [], requireComplete = false} = {}) {
  const evidence = normalizeUploadEvidence(value);
  const errors = [];
  if (evidence.schemaVersion !== UPLOAD_EVIDENCE_SCHEMA_VERSION) errors.push('upload evidence schemaVersion 无效。');
  if (!UPLOAD_METHODS.has(evidence.uploadMethod)) errors.push('uploadMethod 无效。');
  if (typeof evidence.chooserEventObserved !== 'boolean') errors.push('chooserEventObserved 缺失。');
  if (typeof evidence.chooserAttachedBeforeClick !== 'boolean') errors.push('chooserAttachedBeforeClick 缺失。');
  if (evidence.chooserEventObserved === true && evidence.chooserAttachedBeforeClick !== true) errors.push('filechooser 事件不是在点击前建立。');
  if (!Number.isInteger(evidence.attachmentExpected) || evidence.attachmentExpected < 0) errors.push('attachmentExpected 无效。');
  if (!Number.isInteger(evidence.attachmentObserved) || evidence.attachmentObserved < 0) errors.push('attachmentObserved 无效。');
  if (evidence.attachmentObserved !== evidence.attachmentNames.length) errors.push('attachmentObserved 与 attachmentNames 数量不一致。');
  if (evidence.attachmentNames.some(name => !name)) errors.push('attachmentNames 含空值。');
  if (evidence.attachmentPending === null) errors.push('attachmentPending 缺失。');
  if (typeof evidence.sendEnabled !== 'boolean') errors.push('sendEnabled 缺失。');
  if (evidence.failureStage !== null && !FAILURE_STAGES.has(evidence.failureStage)) errors.push('failureStage 无效。');
  if (expectedCount !== null && evidence.attachmentExpected !== Number(expectedCount)) errors.push('attachmentExpected 与服务端冻结数量不一致。');
  if (expectedCount !== null && evidence.attachmentObserved > Number(expectedCount)) errors.push('attachmentObserved 超出服务端冻结数量。');
  const expected = names(expectedNames);
  if (expected.length && JSON.stringify(evidence.attachmentNames) !== JSON.stringify(expected)) errors.push('附件名称或顺序与服务端冻结台账不一致。');
  if (requireComplete) {
    if (evidence.attachmentObserved !== evidence.attachmentExpected) errors.push('附件数量未完成。');
    if (pendingNames(evidence.attachmentPending)) errors.push('仍有附件处于上传或处理中。');
    if (evidence.sendEnabled !== true) errors.push('发送按钮未启用。');
    if (evidence.failureStage) errors.push('成功上传证据不能带 failureStage。');
  }
  return {ok: errors.length === 0, errors: [...new Set(errors)], evidence};
}

export function extractUploadEvidence(value) {
  if (object(value)?.uploadEvidence) return normalizeUploadEvidence(value.uploadEvidence);
  if (object(value)?.schemaVersion === UPLOAD_EVIDENCE_SCHEMA_VERSION && text(value?.source) === 'browser-upload') return normalizeUploadEvidence(value);
  const source = typeof value === 'string' ? value : '';
  const match = source.match(/<upload_evidence>\s*([\s\S]*?)\s*<\/upload_evidence>/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return object(parsed) ? normalizeUploadEvidence(parsed) : null;
  } catch {
    return null;
  }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temp, file);
}

export function readUploadEvidence(dir) {
  try {
    return normalizeUploadEvidence(JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_EVIDENCE_FILE), 'utf8')));
  } catch {
    return null;
  }
}

export function writeUploadEvidence(dir, value) {
  const evidence = normalizeUploadEvidence(value);
  atomicWrite(path.join(dir, UPLOAD_EVIDENCE_FILE), evidence);
  return evidence;
}

/** Read only structured evidence emitted by this run's browser tool. */
export function uploadEvidenceFromRun(dir) {
  const persisted = readUploadEvidence(dir);
  if (persisted) return persisted;
  const files = ['response.txt', 'events.jsonl', 'result.json'];
  for (const name of files) {
    try {
      const found = extractUploadEvidence(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (found) return found;
    } catch {}
  }
  return null;
}

export function uploadEvidenceFailureCode(value) {
  const evidence = normalizeUploadEvidence(value);
  if (!evidence.failureStage) return null;
  if (evidence.failureStage === 'browser-create') return 'BROWSER_CREATE_UNAVAILABLE';
  if (evidence.failureStage === 'browser-handle') return 'BROWSER_HANDLE_LOST';
  if (evidence.failureStage === 'browser-mode-entry') return 'BROWSER_MODE_ENTRY_UNAVAILABLE';
  if (evidence.failureStage === 'chooser-event') return 'FILE_CHOOSER_EVENT_TIMEOUT';
  if (evidence.failureStage === 'chooser-route') return 'FILE_CHOOSER_ROUTE_UNAVAILABLE';
  if (evidence.failureStage === 'file-set') return 'FILE_SET_FAILED';
  if (evidence.failureStage === 'attachment-verification') return 'ATTACHMENT_VERIFICATION_TIMEOUT';
  if (evidence.failureStage === 'submission') return 'SUBMISSION_UNCERTAIN';
  return null;
}

export const UPLOAD_EVIDENCE_FAILURE_STAGES = Object.freeze([...FAILURE_STAGES]);
