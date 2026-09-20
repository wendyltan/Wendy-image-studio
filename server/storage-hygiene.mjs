import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Local storage boundaries for a browser image request.
 *
 * There are deliberately two different kinds of local files here:
 *
 *   - a request staging directory, which may be removed after a terminal
 *     result has been proved; and
 *   - a version attachment cache, which is shared by requests by source hash.
 *
 * Nothing in this module scans, writes, or deletes the user's Downloads
 * folder.  The Downloads report below is read-only by design.
 */
export const STORAGE_OWNER = 'wendi-studio';
export const STORAGE_SCHEMA_VERSION = 2;
export const OWNER_MARKER = '.wendi-storage-owner.json';
export const REQUEST_STAGING_NAME = '.staging';
export const VERSION_ATTACHMENT_CACHE = '.附件缓存';
export const ATTACHMENT_CACHE_FILE = '上传附件缓存.json';
export const RECOVERY_TRASH_DIR = '.回收站/存储整理';

const HASH = /^[a-f0-9]{64}$/i;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function statRegular(file, {allowMissing = false} = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`拒绝使用符号链接：${file}`);
    if (!stat.isFile()) throw new Error(`不是普通文件：${file}`);
    return stat;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertDirectory(dir, {allowMissing = false} = {}) {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目录无效：${dir}`);
    return stat;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readableDirectory(dir) {
  const absolute = path.resolve(String(dir || ''));
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const resolved = fs.realpathSync(absolute);
    assertDirectory(resolved);
    return resolved;
  }
  assertDirectory(absolute);
  return absolute;
}

function assertProjectRoot(projectRoot) {
  const root = path.resolve(String(projectRoot || ''));
  if (!root || root === path.parse(root).root) throw new Error('项目存储根目录无效。');
  const stat = assertDirectory(root);
  if (stat.isSymbolicLink()) throw new Error('项目存储根目录不能是符号链接。');
  return root;
}

/**
 * Resolve a path inside a project while checking all existing ancestors for
 * symlinks.  This is intentionally stricter than path.resolve alone: an
 * attacker-controlled link in an old cache must not turn cleanup into a
 * deletion outside the project.
 */
export function projectPath(projectRoot, relativeOrAbsolute, {allowRoot = false, allowMissing = true} = {}) {
  const root = assertProjectRoot(projectRoot);
  const candidate = path.resolve(root, String(relativeOrAbsolute || ''));
  if (candidate === root && !allowRoot) throw new Error('路径不能指向项目根目录。');
  if (!candidate.startsWith(root + path.sep) && candidate !== root) throw new Error('文件路径超出项目目录。');
  let cursor = candidate;
  while (cursor !== root && cursor.startsWith(root + path.sep)) {
    try {
      const item = fs.lstatSync(cursor);
      if (item.isSymbolicLink()) throw new Error('拒绝沿符号链接访问项目文件。');
      // The final component may be a file. Every existing ancestor must be a
      // directory, otherwise a path such as file/child could escape the
      // intended boundary through a confusing ENOTDIR failure.
      if (cursor !== candidate && !item.isDirectory()) throw new Error('路径祖先不是目录。');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    cursor = path.dirname(cursor);
  }
  if (!allowMissing && !fs.existsSync(candidate)) throw new Error(`文件不存在：${candidate}`);
  return candidate;
}

function assertOwnedPath(projectRoot, target, {allowRoot = false, allowMissing = true} = {}) {
  const root = assertProjectRoot(projectRoot);
  const absolute = projectPath(root, target, {allowRoot, allowMissing});
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error('存储路径不属于当前项目。');
  return absolute;
}

function writeAtomic(file, value, {encoding = 'utf8'} = {}) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), {recursive: true});
  const temp = `${absolute}.tmp-${crypto.randomUUID()}`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, value, {encoding});
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, absolute);
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return absolute;
}

function writeJsonAtomic(file, value) {
  return writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function relativeProjectPath(projectRoot, file) {
  const root = assertProjectRoot(projectRoot);
  const absolute = assertOwnedPath(root, file);
  if (absolute === root) return '';
  return path.relative(root, absolute).split(path.sep).join('/');
}

function markerPath(root) {
  return path.join(root, OWNER_MARKER);
}

function readOwnerMarker(root) {
  return readJson(markerPath(root));
}

function markerMatches(marker, identity = {}) {
  if (!marker || marker.owner !== STORAGE_OWNER) return false;
  for (const key of ['projectId', 'projectVersion', 'taskId', 'runId']) {
    if (identity[key] === undefined || identity[key] === null || identity[key] === '') continue;
    if (String(marker[key] ?? '') !== String(identity[key])) return false;
  }
  return true;
}

function ensureNoSymlinkDirectory(dir) {
  const absolute = path.resolve(dir);
  let cursor = absolute;
  const missing = [];
  while (cursor && !fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (cursor && fs.existsSync(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目录无效：${cursor}`);
  }
  for (const item of missing.reverse()) fs.mkdirSync(item, {recursive: false, mode: 0o700});
  return absolute;
}

function fileExtension(file, fallback = '.jpg') {
  const ext = path.extname(String(file || '')).toLowerCase();
  return IMAGE_EXT.has(ext) ? ext : fallback;
}

function ownerRecord({kind, projectRoot, ...identity}) {
  return {
    schemaVersion: 1,
    owner: STORAGE_OWNER,
    kind,
    createdAt: new Date().toISOString(),
    projectRoot: path.resolve(projectRoot),
    ...identity,
  };
}

/** Create or reopen the request-owned staging boundary for one run. */
export function createRequestStaging({projectRoot, runDir, projectId = null, projectVersion = null, taskId = null, runId = null, requestId = null, sourceFiles = []} = {}) {
  const root = assertProjectRoot(projectRoot);
  const run = assertOwnedPath(root, runDir, {allowMissing: false});
  assertDirectory(run);
  const stagingRoot = assertOwnedPath(root, path.join(run, REQUEST_STAGING_NAME));
  const existing = readOwnerMarker(stagingRoot);
  if (existing && (!markerMatches(existing, {projectId, projectVersion, taskId, runId}) || existing.kind !== 'request-staging')) {
    throw new Error('请求 staging owner marker 与当前执行身份不一致。');
  }
  ensureNoSymlinkDirectory(stagingRoot);
  for (const name of ['attachments', 'download', 'partial', 'verify']) ensureNoSymlinkDirectory(path.join(stagingRoot, name));
  const marker = existing || ownerRecord({kind: 'request-staging', projectRoot: root, projectId, projectVersion, taskId, runId: runId || path.basename(run), requestId, sourceFiles: sourceFiles.map(file => relativeProjectPath(root, file)), state: 'open', reconstructible: sourceFiles.length > 0});
  if (requestId && marker.requestId !== requestId) marker.requestId = requestId;
  if (Array.isArray(sourceFiles) && sourceFiles.length) marker.sourceFiles = sourceFiles.map(file => relativeProjectPath(root, file));
  marker.state = marker.state || 'open';
  writeJsonAtomic(markerPath(stagingRoot), marker);
  return Object.freeze({
    root,
    runDir: run,
    stagingRoot,
    markerFile: markerPath(stagingRoot),
    attachmentsDir: path.join(stagingRoot, 'attachments'),
    downloadDir: path.join(stagingRoot, 'download'),
    partialDir: path.join(stagingRoot, 'partial'),
    verifyDir: path.join(stagingRoot, 'verify'),
    marker,
  });
}

export function updateRequestStagingMarker(staging, patch = {}) {
  const root = assertProjectRoot(staging?.root || staging?.projectRoot);
  const stagingRoot = assertOwnedPath(root, staging?.stagingRoot, {allowMissing: false});
  const current = readOwnerMarker(stagingRoot);
  if (!markerMatches(current, {} ) || current.kind !== 'request-staging') throw new Error('请求 staging owner marker 无效。');
  const next = {...current, ...structuredClone(patch), updatedAt: new Date().toISOString()};
  writeJsonAtomic(markerPath(stagingRoot), next);
  return next;
}

export function ownedStagingPath(staging, relativePath) {
  const root = assertProjectRoot(staging?.root || staging?.projectRoot);
  const stagingRoot = assertOwnedPath(root, staging?.stagingRoot, {allowMissing: false});
  const value = String(relativePath || '');
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).some(part => part === '..' || part === '')) throw new Error('staging 相对路径无效。');
  const target = assertOwnedPath(root, path.join(stagingRoot, value));
  if (!target.startsWith(stagingRoot + path.sep)) throw new Error('staging 路径越界。');
  return target;
}

export function copyIntoRequestStaging(staging, sourceFile, relativePath) {
  const source = path.resolve(String(sourceFile || ''));
  const sourceStat = statRegular(source);
  const target = ownedStagingPath(staging, relativePath);
  const targetDir = path.dirname(target);
  ensureNoSymlinkDirectory(targetDir);
  const temp = `${target}.partial-${crypto.randomUUID()}`;
  fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
  try {
    const integrity = {sha256: hashFile(temp), sizeBytes: fs.statSync(temp).size};
    fs.renameSync(temp, target);
    return {file: target, relativePath: path.relative(staging.stagingRoot, target).split(path.sep).join('/'), sourceSizeBytes: sourceStat.size, ...integrity};
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

export function atomicCopyIntoProject({projectRoot, sourceFile, targetFile, expectedSha256 = null} = {}) {
  const root = assertProjectRoot(projectRoot);
  const source = path.resolve(String(sourceFile || ''));
  const sourceStat = statRegular(source);
  const target = assertOwnedPath(root, targetFile);
  if (path.resolve(source) === target) return {file: target, sha256: hashFile(target), sizeBytes: sourceStat.size, reused: true};
  const expected = expectedSha256 ? String(expectedSha256).toLowerCase() : null;
  const actualSourceHash = hashFile(source);
  if (expected && actualSourceHash !== expected) throw new Error('源文件 SHA-256 与预期不一致。');
  ensureNoSymlinkDirectory(path.dirname(target));
  const temp = `${target}.partial-${crypto.randomUUID()}`;
  fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
  try {
    const hash = hashFile(temp);
    if (expected && hash !== expected) throw new Error('临时文件 SHA-256 校验失败。');
    fs.renameSync(temp, target);
    return {file: target, sha256: hash, sizeBytes: fs.statSync(target).size, reused: false};
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function versionCacheRoot(projectRoot, versionRoot) {
  const root = assertProjectRoot(projectRoot);
  const version = assertOwnedPath(root, versionRoot, {allowMissing: true});
  ensureNoSymlinkDirectory(version);
  const cacheRoot = assertOwnedPath(root, path.join(version, VERSION_ATTACHMENT_CACHE), {allowMissing: true});
  const marker = readOwnerMarker(cacheRoot);
  if (marker && (marker.owner !== STORAGE_OWNER || marker.kind !== 'version-attachment-cache')) throw new Error('版本附件缓存 owner marker 不匹配。');
  ensureNoSymlinkDirectory(cacheRoot);
  if (!marker) writeJsonAtomic(markerPath(cacheRoot), ownerRecord({kind: 'version-attachment-cache', projectRoot: root, projectVersion: path.basename(version).replace(/^v/, '')}));
  return {root, versionRoot: version, cacheRoot};
}

export function materializeVersionAttachment({projectRoot, versionRoot, sourceFile, sourceSha256, optimized = false, sizeBytes = null} = {}) {
  const cache = versionCacheRoot(projectRoot, versionRoot);
  const source = path.resolve(String(sourceFile || ''));
  statRegular(source);
  const hash = String(sourceSha256 || hashFile(source)).toLowerCase();
  if (!HASH.test(hash)) throw new Error('附件 sourceSha256 无效。');
  const extension = fileExtension(source);
  // Extension is presentation metadata; the source SHA is the cache key.
  // Reuse an existing hash entry even when an old run used .jpg and the next
  // run presents the same bytes as .png.
  const existingName = fs.readdirSync(cache.cacheRoot).find(name => name.startsWith(`${hash}.`) && IMAGE_EXT.has(path.extname(name).toLowerCase()));
  const target = path.join(cache.cacheRoot, existingName || `${hash}${extension}`);
  const relativeToProject = path.relative(cache.root, target).split(path.sep).join('/');
  const existing = statRegular(target, {allowMissing: true});
  if (existing) {
    const fileSha256 = hashFile(target);
    return {file: target, relativePath: relativeToProject, sourceSha256: hash, fileSha256, optimized: Boolean(optimized), sizeBytes: existing.size, reused: true};
  }
  const copied = atomicCopyIntoProject({projectRoot: cache.root, sourceFile: source, targetFile: target, expectedSha256: null});
  return {file: target, relativePath: relativeToProject, sourceSha256: hash, fileSha256: copied.sha256, optimized: Boolean(optimized), sizeBytes: Number(sizeBytes) || copied.sizeBytes, reused: false};
}

export function readAttachmentCache({projectRoot, versionRoot} = {}) {
  const root = assertProjectRoot(projectRoot);
  const version = assertOwnedPath(root, versionRoot, {allowMissing: true});
  const cacheFile = path.join(version, ATTACHMENT_CACHE_FILE);
  const value = readJson(cacheFile) || {};
  const files = Array.isArray(value.files) ? value.files : [];
  const entries = [];
  const invalid = [];
  const seen = new Set();
  for (const item of files) {
    const hash = String(item?.sourceSha256 || '').toLowerCase();
    const relative = text(item?.file);
    if (!HASH.test(hash) || !relative) { invalid.push({item,reason:'invalid-entry'}); continue; }
    if (seen.has(hash)) continue;
    let file;
    try { file = assertOwnedPath(root, relative, {allowMissing: false}); statRegular(file); }
    catch (error) { invalid.push({item,reason:error.message}); continue; }
    const fileSha256 = hashFile(file);
    if (item.fileSha256 && String(item.fileSha256).toLowerCase() !== fileSha256) { invalid.push({item,reason:'file-sha256-mismatch'}); continue; }
    seen.add(hash);
    entries.push({...item, sourceSha256: hash, fileSha256, file: path.relative(root, file).split(path.sep).join('/'), sizeBytes: Number(item.sizeBytes) || fs.statSync(file).size});
  }
  return {file: cacheFile, schemaVersion: Number(value.schemaVersion) || 1, raw: value, entries, invalid, legacy: Number(value.schemaVersion) < STORAGE_SCHEMA_VERSION || entries.some(item => !item.file.startsWith(`${path.relative(root, path.join(version, VERSION_ATTACHMENT_CACHE)).split(path.sep).join('/')}/`))};
}

export function writeAttachmentCache({projectRoot, versionRoot, entries = [], migratedFrom = null} = {}) {
  const root = assertProjectRoot(projectRoot);
  const version = assertOwnedPath(root, versionRoot, {allowMissing: true});
  const cache = versionCacheRoot(root, version);
  const map = new Map();
  for (const item of entries) {
    const hash = String(item?.sourceSha256 || '').toLowerCase();
    if (!HASH.test(hash) || !item?.file) continue;
    const file = assertOwnedPath(root, item.file, {allowMissing: false});
    statRegular(file);
    const fileSha256 = hashFile(file);
    if (item.fileSha256 && String(item.fileSha256).toLowerCase() !== fileSha256) throw new Error(`缓存文件 ${item.file} 的文件 hash 不一致。`);
    map.set(hash, {...item, sourceSha256: hash, fileSha256, file: path.relative(root, file).split(path.sep).join('/'), sizeBytes: Number(item.sizeBytes) || fs.statSync(file).size, updatedAt: item.updatedAt || new Date().toISOString()});
  }
  const value = {schemaVersion: STORAGE_SCHEMA_VERSION, cacheRoot: path.relative(root, cache.cacheRoot).split(path.sep).join('/'), migratedFromSchemaVersion: migratedFrom === null ? undefined : Number(migratedFrom) || 1, files: [...map.values()].slice(-500), updatedAt: new Date().toISOString()};
  writeJsonAtomic(path.join(version, ATTACHMENT_CACHE_FILE), value);
  return value;
}

/**
 * Promote legacy per-run cache entries to the version cache.  This never
 * removes the old file; callers can safely update the manifest first and
 * reclaim old copies later after a dry-run review.
 */
export function migrateAttachmentCache({projectRoot, versionRoot} = {}) {
  const root = assertProjectRoot(projectRoot);
  const version = assertOwnedPath(root, versionRoot, {allowMissing: true});
  const existing = readAttachmentCache({projectRoot: root, versionRoot: version});
  const merged = new Map(existing.entries.map(item => [item.sourceSha256, item]));
  const migrated = [];
  for (const item of Array.isArray(existing.raw?.files) ? existing.raw.files : []) {
    const hash = String(item?.sourceSha256 || '').toLowerCase(), relative = text(item?.file);
    if (!HASH.test(hash) || !relative || merged.has(hash) && merged.get(hash).file.startsWith(`${path.relative(root, path.join(version, VERSION_ATTACHMENT_CACHE)).split(path.sep).join('/')}/`)) continue;
    let legacy;
    try { legacy = assertOwnedPath(root, relative, {allowMissing: false}); statRegular(legacy); }
    catch { continue; }
    const promoted = materializeVersionAttachment({projectRoot: root, versionRoot: version, sourceFile: legacy, sourceSha256: hash, optimized: item.optimized === true, sizeBytes: item.sizeBytes});
    const next = {sourceSha256: hash, fileSha256: promoted.fileSha256, file: promoted.relativePath, optimized: promoted.optimized, sizeBytes: promoted.sizeBytes, updatedAt: new Date().toISOString(), migratedFrom: relative};
    merged.set(hash, next); migrated.push({from: relative, to: promoted.relativePath, sourceSha256: hash});
  }
  const value = writeAttachmentCache({projectRoot: root, versionRoot: version, entries: [...merged.values()], migratedFrom: existing.schemaVersion});
  return {cacheFile: path.join(version, ATTACHMENT_CACHE_FILE), entries: value.files, migrated, invalid: existing.invalid, changed: migrated.length > 0 || Number(existing.schemaVersion) < STORAGE_SCHEMA_VERSION};
}

function statusForRun(projectRoot, stagingRoot, marker) {
  const runDir = path.dirname(stagingRoot);
  const manifest = readJson(path.join(runDir, 'web-generation.json'));
  if (manifest?.state === 'downloaded' && manifest?.submitted === true) return {state: 'success', manifest};
  if (manifest?.submitted === true || manifest?.submissionUncertain === true || manifest?.state === 'submitted') return {state: 'unknown', manifest};
  if (manifest?.state === 'failed' && manifest?.submitted !== true) return {state: 'pre_submission_failure', manifest};
  return {state: marker?.state || 'open', manifest};
}

function walkFiles(root, {maxFiles = 20_000, skip = () => false} = {}) {
  const files = [], stack = [path.resolve(root)];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop();
    let names;
    try { names = fs.readdirSync(dir, {withFileTypes: true}); } catch { continue; }
    for (const entry of names) {
      const file = path.join(dir, entry.name);
      if (skip(file, entry)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  return files;
}

function collectLiveReferences(projectRoot) {
  const root = assertProjectRoot(projectRoot), refs = new Set();
  const files = walkFiles(root, {skip: (file, entry) => entry.isDirectory() && (file.includes(`${path.sep}.制作记录${path.sep}`) || file.endsWith(`${path.sep}.制作记录`))});
  for (const file of files) {
    if (path.basename(file) !== 'project.json' && path.basename(file) !== ATTACHMENT_CACHE_FILE) continue;
    const value = readJson(file);
    const values = [];
    const collect = item => {
      if (typeof item === 'string') values.push(item);
      else if (Array.isArray(item)) item.forEach(collect);
      else if (item && typeof item === 'object') Object.values(item).forEach(collect);
    };
    collect(value);
    for (const valueText of values) {
      if (path.isAbsolute(valueText)) {
        try { const candidate = projectPath(root, valueText); if (candidate.startsWith(root + path.sep)) refs.add(candidate); } catch {}
      } else if (/[\\/]/.test(valueText) && /\.(?:png|jpe?g|webp|json|txt)$/i.test(valueText)) {
        try { const candidate = projectPath(root, valueText); if (candidate.startsWith(root + path.sep)) refs.add(candidate); } catch {}
      }
    }
  }
  return refs;
}

function ownerRecords(projectRoot) {
  const root = assertProjectRoot(projectRoot), records = [];
  for (const file of walkFiles(root, {skip: (candidate, entry) => entry.isDirectory() && (candidate.includes(`${path.sep}.回收站${path.sep}`) || candidate.endsWith(`${path.sep}.回收站`))})) {
    if (path.basename(file) !== OWNER_MARKER) continue;
    const ownerRoot = path.dirname(file), marker = readJson(file);
    if (!marker || marker.owner !== STORAGE_OWNER) continue;
    if (marker.kind !== 'request-staging' && marker.kind !== 'version-attachment-cache') continue;
    records.push({root: ownerRoot, marker, markerFile: file});
  }
  return records;
}

function legacyUnmarkedAttachmentDirs(projectRoot) {
  const root = assertProjectRoot(projectRoot), dirs = new Map();
  for (const file of walkFiles(root, {skip: (candidate, entry) => entry.isDirectory() && candidate.includes(`${path.sep}.回收站${path.sep}`)})) {
    const relative = path.relative(root, file).split(path.sep);
    const recordsIndex = relative.indexOf('.制作记录');
    if (recordsIndex < 0 || relative.length <= recordsIndex + 2 || relative[recordsIndex + 2] !== '上传素材') continue;
    const candidate = path.join(root, ...relative.slice(0, recordsIndex + 3));
    if (readOwnerMarker(candidate)) continue;
    dirs.set(candidate, true);
  }
  return [...dirs.keys()];
}

export function reportProjectStorage(projectRoot) {
  const root = assertProjectRoot(projectRoot), liveRefs = collectLiveReferences(root), candidates = [];
  for (const record of ownerRecords(root)) {
    const status = record.marker.kind === 'request-staging' ? statusForRun(root, record.root, record.marker) : {state: 'cache'};
    const files = walkFiles(record.root).filter(file => file !== record.markerFile);
    const bytes = files.reduce((sum, file) => { try { return sum + fs.statSync(file).size; } catch { return sum; } }, 0);
    const relative = path.relative(root, record.root).split(path.sep).join('/');
    const referenced = [...liveRefs].some(ref => ref === record.root || ref.startsWith(record.root + path.sep));
    const reconstructible = record.marker.kind === 'request-staging' && record.marker.reconstructible === true && Array.isArray(record.marker.sourceFiles) && record.marker.sourceFiles.every(source => {
      try { const file = projectPath(root, source, {allowMissing: false}); statRegular(file); return true; } catch { return false; }
    });
    const safeState = status.state === 'success' || status.state === 'pre_submission_failure';
    const safeToRemove = record.marker.kind === 'request-staging' && safeState && reconstructible && !referenced;
    candidates.push({path: record.root, relativePath: relative, kind: record.marker.kind, state: status.state, bytes, fileCount: files.length, referenced, reconstructible, safeToRemove, reasons: [
      ...(referenced ? ['仍被项目控制记录引用'] : []),
      ...(!reconstructible ? ['缺少可重建来源或来源不可读'] : []),
      ...(!safeState ? ['提交后未知或仍在进行，必须保留证据'] : []),
      ...(record.marker.kind === 'version-attachment-cache' ? ['版本共享缓存默认保留'] : []),
    ], marker: {...record.marker, projectRoot: undefined}, manifest: status.manifest ? {state: status.manifest.state, submitted: status.manifest.submitted === true, submissionUncertain: status.manifest.submissionUncertain === true} : null});
  }
  // Historical runs predate owner markers. Surface them as protected report
  // rows so the user can see where the clutter is, but never make them
  // eligible for automatic or `apply` cleanup.
  for (const legacyDir of legacyUnmarkedAttachmentDirs(root)) {
    const files = walkFiles(legacyDir), bytes = files.reduce((sum, file) => { try { return sum + fs.statSync(file).size; } catch { return sum; } }, 0);
    candidates.push({path: legacyDir, relativePath: path.relative(root, legacyDir).split(path.sep).join('/'), kind: 'legacy-unmarked-attachment-staging', state: 'legacy_unmarked', bytes, fileCount: files.length, referenced: true, reconstructible: false, safeToRemove: false, reasons: ['历史目录没有 owner marker，不能自动清理', '需先完成共享缓存迁移并人工确认'], marker: null, manifest: null});
  }
  const removableBytes = candidates.filter(item => item.safeToRemove).reduce((sum, item) => sum + item.bytes, 0);
  return {schemaVersion: 1, projectRoot: root, generatedAt: new Date().toISOString(), candidates, summary: {ownerRecords: candidates.length, safeCandidateCount: candidates.filter(item => item.safeToRemove).length, safeCandidateBytes: removableBytes, referencedCount: candidates.filter(item => item.referenced).length, unknownOrActiveCount: candidates.filter(item => !['success', 'pre_submission_failure', 'cache'].includes(item.state)).length}, downloadsTouched: false};
}

export function applyProjectStorageCleanup(projectRoot, {apply = false, report = null} = {}) {
  const snapshot = report || reportProjectStorage(projectRoot);
  if (apply !== true) return {...snapshot, applied: false, moved: []};
  const root = assertProjectRoot(projectRoot), trash = assertOwnedPath(root, RECOVERY_TRASH_DIR);
  ensureNoSymlinkDirectory(trash);
  const liveRefs = collectLiveReferences(root);
  const moved = [];
  for (const candidate of snapshot.candidates || []) {
    if (!candidate.safeToRemove) continue;
    const target = assertOwnedPath(root, candidate.path, {allowMissing: false});
    const marker = readOwnerMarker(target);
    if (!marker || marker.owner !== STORAGE_OWNER || marker.kind !== 'request-staging') continue;
    const currentStatus = statusForRun(root, target, marker).state;
    if (!['success', 'pre_submission_failure'].includes(currentStatus)) continue;
    const referenced = [...liveRefs].some(ref => ref === target || ref.startsWith(target + path.sep));
    if (referenced || marker.reconstructible !== true || !Array.isArray(marker.sourceFiles) || !marker.sourceFiles.every(source => {
      try { statRegular(projectPath(root, source, {allowMissing: false})); return true; } catch { return false; }
    })) continue;
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(path.dirname(target))}`;
    let destination = path.join(trash, name), index = 2;
    while (fs.existsSync(destination)) destination = path.join(trash, `${name}-${index++}`);
    fs.renameSync(target, destination);
    moved.push({from: target, to: destination, bytes: candidate.bytes});
  }
  return {...reportProjectStorage(root), applied: true, moved, downloadsTouched: false};
}

function imageFiles(root, options = {}) {
  return walkFiles(root, options).filter(file => IMAGE_EXT.has(path.extname(file).toLowerCase()));
}

/** Read-only redundancy report for Downloads.  This function never mutates it. */
export function reportDownloadsRedundancy({downloadsDir, projectRoot} = {}) {
  const downloads = readableDirectory(downloadsDir);
  const root = assertProjectRoot(projectRoot);
  const projectImages = imageFiles(root), archived = new Map(), sources = new Map();
  for (const file of projectImages) {
    let hash; try { hash = hashFile(file); } catch { continue; }
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (/(?:^|\/)(?:素材|成品|候选成稿|原图|页面|成稿)(?:\/|$)/.test(relative) || relative.includes('.制作记录')) archived.set(hash, relative);
    if (relative.startsWith('v') && relative.includes('/参考/')) sources.set(hash, relative);
  }
  // Downloads can contain application-owned hidden data directories (for
  // example game map tiles) that are not browser downloads. Keep this report
  // focused on user-visible downloads while remaining strictly read-only.
  const items = imageFiles(downloads, {
    skip: (file, entry) => entry.isDirectory() && entry.name.startsWith('.'),
  }).map(file => {
    let hash = null; try { hash = hashFile(file); } catch {}
    const relative = path.relative(downloads, file).split(path.sep).join('/');
    const archivedPath = hash && archived.get(hash), sourcePath = hash && sources.get(hash);
    const category = archivedPath ? 'archived' : sourcePath ? 'must_keep' : 'unknown';
    return {path: file, relativePath: relative, bytes: fs.statSync(file).size, sha256: hash, category, matchingProjectPath: archivedPath || sourcePath || null};
  });
  const summary = Object.fromEntries(['archived', 'must_keep', 'unknown'].map(category => [category, {count: items.filter(item => item.category === category).length, bytes: items.filter(item => item.category === category).reduce((sum, item) => sum + item.bytes, 0)}]));
  return {schemaVersion: 1, downloadsDir: downloads, projectRoot: root, generatedAt: new Date().toISOString(), items, summary, mutated: false};
}

/** Runtime cleanup is only for this request's own staging after its outcome. */
export function cleanupRequestStaging(staging, {outcome = 'unknown', submitted = false, submissionUncertain = false, reason = null} = {}) {
  const root = assertProjectRoot(staging?.root || staging?.projectRoot);
  const stagingRoot = assertOwnedPath(root, staging?.stagingRoot, {allowMissing: true});
  if (!fs.existsSync(stagingRoot)) return {status: 'missing', removed: false, path: stagingRoot};
  const marker = readOwnerMarker(stagingRoot);
  if (!marker || marker.owner !== STORAGE_OWNER || marker.kind !== 'request-staging') throw new Error('不会清理没有 owner marker 的 staging。');
  const normalized = String(outcome || '').toLowerCase();
  const terminalSuccess = ['success', 'downloaded'].includes(normalized);
  const preserve = !terminalSuccess && (submitted === true || submissionUncertain === true || ['unknown', 'submitted', 'download_failed'].includes(normalized));
  if (preserve) {
    updateRequestStagingMarker(staging, {state: 'preserved', preservationReason: reason || normalized || 'unknown', preservedAt: new Date().toISOString()});
    return {status: 'preserved', removed: false, path: stagingRoot};
  }
  if (!['success', 'downloaded', 'pre_submission_failure', 'no_output'].includes(normalized)) return {status: 'not_attempted', removed: false, path: stagingRoot};
  // Only remove a directory that still has the exact owner marker.  This is a
  // request-local ephemeral area; durable request/evidence records stay in the
  // parent run directory.
  fs.rmSync(stagingRoot, {recursive: true, force: false});
  return {status: 'removed', removed: true, path: stagingRoot};
}

export {hashFile};
