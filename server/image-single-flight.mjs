import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Durable per-panel generation reservation.  The in-memory project queue is
 * still the first line of defence; this small file-backed guard closes the
 * gap when two HTTP requests or two service instances operate on the same
 * project at nearly the same time.
 */
const LOCK_DIR = '.single-flight';

function text(value) {
  return String(value ?? '').trim();
}

export function canonicalPanelKey(value) {
  const raw = text(value);
  if (!raw) return null;
  const sample = raw.match(/(?:样张|sample)[-_ ]*([12])(?:\D|$)/i);
  if (sample) return `sample-${sample[1]}`;
  const match = raw.match(/(?:第\s*)?(\d+)\s*(?:页\s*[-_/]?|[-_/])\s*(?:第\s*)?(\d+)\s*(?:格)?/i);
  if (match) return `${Number(match[1])}-${Number(match[2])}`;
  const compact = raw.match(/第\s*(\d+)\s*页\s*第\s*(\d+)\s*格/i);
  if (compact) return `${Number(compact[1])}-${Number(compact[2])}`;
  return raw
    .replace(/(?:-?局部修订|-?自动修订\d*|-?revision\d*)$/i, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || null;
}

function safeName(value) {
  return encodeURIComponent(String(value || 'unknown')).replace(/%/g, '_').slice(0, 180);
}

export function imageFlightFile({projectDir, projectVersion, panelKey} = {}) {
  const canonical = canonicalPanelKey(panelKey);
  if (!projectDir || !canonical) throw Object.assign(new Error('缺少可归一化的图片目标。'), {code: 'IMAGE_TARGET_INVALID'});
  return path.join(path.resolve(projectDir), LOCK_DIR, `v${Number(projectVersion) || 0}-${safeName(canonical)}.json`);
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temp, file);
}

function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function claimFile(file) {
  const claim = `${file}.claim`;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  try {
    const fd = fs.openSync(claim, 'wx', 0o600);
    return {fd, claim};
  } catch (error) {
    if (error?.code === 'EEXIST') {
      let stale = false;
      try { stale = fs.statSync(claim).mtimeMs < Date.now() - 120000; } catch { stale = true; }
      if (stale) {
        try { fs.rmSync(claim, {force: true}); } catch {}
        try { const fd = fs.openSync(claim, 'wx', 0o600); return {fd, claim}; } catch {}
      }
      const busy = new Error('当前图片目标正在被另一个执行器占用；不会创建第二个请求。');
      busy.code = 'IMAGE_SINGLE_FLIGHT_BUSY';
      throw busy;
    }
    throw error;
  }
}

function releaseFileClaim(handle) {
  if (!handle) return;
  try { fs.closeSync(handle.fd); } catch {}
  try { fs.rmSync(handle.claim, {force: true}); } catch {}
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function activeReservation(value) {
  if (value?.status !== 'active') return false;
  // New reservations carry their owner process.  If that process is gone,
  // the reservation is recoverable after the exclusive claim is acquired;
  // records from older versions remain conservative and continue to block.
  return !Number.isInteger(Number(value.ownerPid)) || processAlive(Number(value.ownerPid));
}

/** Reserve exactly one active image operation for a canonical panel. */
export function acquireImageFlight({projectId, projectDir, projectVersion, panelKey, taskId = null, requestId = null, runId = null, mode = 'generate'} = {}) {
  const canonical = canonicalPanelKey(panelKey);
  const file = imageFlightFile({projectDir, projectVersion, panelKey: canonical});
  const current = read(file);
  if (activeReservation(current)) {
    const error = new Error(`当前图片目标 ${canonical} 已有生图任务在执行；不会创建第二个请求。`);
    error.code = 'IMAGE_SINGLE_FLIGHT_ACTIVE';
    error.flight = current;
    throw error;
  }
  const claim = claimFile(file);
  try {
    // Re-read after taking the exclusive claim: another process may have
    // published an active reservation between the first read and this claim.
    const latest = read(file);
    if (activeReservation(latest)) {
      const error = new Error(`当前图片目标 ${canonical} 已有生图任务在执行；不会创建第二个请求。`);
      error.code = 'IMAGE_SINGLE_FLIGHT_ACTIVE';
      error.flight = latest;
      throw error;
    }
  const value = {
    schemaVersion: 1,
    status: 'active',
    projectId: projectId || null,
    projectVersion: Number(projectVersion) || null,
    panelKey: canonical,
    taskId,
    requestId,
    runId,
    mode,
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
    atomicWrite(file, value);
    return {file, value};
  } finally {
    releaseFileClaim(claim);
  }
}

export function releaseImageFlight(handle, {status = 'released', outcome = null, requestId = null, runId = null} = {}) {
  if (!handle?.file) return null;
  const current = read(handle.file) || handle.value || {};
  const next = {
    ...current,
    status,
    outcome,
    requestId: requestId ?? current.requestId ?? null,
    runId: runId ?? current.runId ?? null,
    releasedAt: new Date().toISOString(),
  };
  try {
    atomicWrite(handle.file, next);
  } catch {}
  return next;
}

export function readImageFlight({projectDir, projectVersion, panelKey} = {}) {
  return read(imageFlightFile({projectDir, projectVersion, panelKey}));
}

export function clearImageFlight(handle) {
  return releaseImageFlight(handle, {status: 'released'});
}
