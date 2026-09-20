import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ATTACHMENT_CACHE_FILE,
  RECOVERY_TRASH_DIR,
  createRequestStaging,
  cleanupRequestStaging,
  hashFile,
  migrateAttachmentCache,
  ownedStagingPath,
  projectPath,
  reportDownloadsRedundancy,
  reportProjectStorage,
  applyProjectStorageCleanup,
  materializeVersionAttachment,
  readAttachmentCache,
  writeAttachmentCache,
} from '../server/storage-hygiene.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wendi-storage-'));
  const version = path.join(root, 'v1');
  const run = path.join(root, '.制作记录', `run-${crypto.randomUUID()}`);
  const source = path.join(version, '参考', 'ref.png');
  fs.mkdirSync(run, {recursive: true});
  fs.mkdirSync(path.dirname(source), {recursive: true});
  fs.writeFileSync(source, PNG);
  return {root, version, run, source};
}

function manifest(run, value) {
  fs.writeFileSync(path.join(run, 'web-generation.json'), JSON.stringify(value, null, 2));
}

test('version attachment cache de-duplicates by source SHA and keeps one shared file', () => {
  const {root, version, source} = fixture();
  const sha = hashFile(source);
  const first = materializeVersionAttachment({projectRoot: root, versionRoot: version, sourceFile: source, sourceSha256: sha, optimized: false});
  const second = materializeVersionAttachment({projectRoot: root, versionRoot: version, sourceFile: source, sourceSha256: sha, optimized: false});
  assert.equal(first.relativePath, second.relativePath);
  assert.equal(second.reused, true);
  assert.equal(fs.readdirSync(path.join(version, '.附件缓存')).filter(name => name !== '.wendi-storage-owner.json').length, 1);
  const saved = writeAttachmentCache({projectRoot: root, versionRoot: version, entries: [{sourceSha256: sha, file: first.relativePath}]});
  assert.equal(saved.files.length, 1);
  assert.equal(readAttachmentCache({projectRoot: root, versionRoot: version}).entries[0].sourceSha256, sha);
});

test('same bytes with a different extension still use one SHA cache entry', () => {
  const {root, version, source} = fixture();
  const alternate = path.join(version, '参考', 'same.jpg');
  fs.copyFileSync(source, alternate);
  const sha = hashFile(source);
  const first = materializeVersionAttachment({projectRoot: root, versionRoot: version, sourceFile: source, sourceSha256: sha});
  const second = materializeVersionAttachment({projectRoot: root, versionRoot: version, sourceFile: alternate, sourceSha256: sha});
  assert.equal(second.file, first.file);
  assert.equal(fs.readdirSync(path.join(version, '.附件缓存')).filter(name => name !== '.wendi-storage-owner.json').length, 1);
});

test('cache identity uses source SHA while validating the optimized file with its own file SHA', () => {
  const {root, version, source} = fixture();
  const optimized = path.join(root, '.制作记录', 'run-optimized', '上传素材', '01-ref.jpg');
  fs.mkdirSync(path.dirname(optimized), {recursive: true});
  fs.writeFileSync(optimized, Buffer.concat([PNG, Buffer.from('optimized')]));
  const sourceSha256 = hashFile(source), fileSha256 = hashFile(optimized);
  fs.writeFileSync(path.join(version, ATTACHMENT_CACHE_FILE), JSON.stringify({schemaVersion: 1, files: [{sourceSha256, file: path.relative(root, optimized), optimized: true}]}));
  const legacy = readAttachmentCache({projectRoot: root, versionRoot: version});
  assert.equal(legacy.entries[0].sourceSha256, sourceSha256);
  assert.equal(legacy.entries[0].fileSha256, fileSha256);
  assert.equal(migrateAttachmentCache({projectRoot: root, versionRoot: version}).migrated.length, 1);
});

test('legacy per-run cache entries are promoted without deleting the old reference', () => {
  const {root, version, source} = fixture();
  const old = path.join(root, '.制作记录', 'old-run', '上传素材', '01-ref.jpg');
  fs.mkdirSync(path.dirname(old), {recursive: true});
  fs.copyFileSync(source, old);
  const sha = hashFile(old);
  fs.writeFileSync(path.join(version, ATTACHMENT_CACHE_FILE), JSON.stringify({schemaVersion: 1, files: [{sourceSha256: sha, file: path.relative(root, old)}]}));
  const result = migrateAttachmentCache({projectRoot: root, versionRoot: version});
  assert.equal(result.migrated.length, 1);
  assert(fs.existsSync(old), 'migration must be reversible and keep the old run copy');
  assert(fs.existsSync(path.join(root, result.migrated[0].to)));
  assert.equal(readAttachmentCache({projectRoot: root, versionRoot: version}).schemaVersion, 2);
});

test('legacy attachment folders without an owner marker are visible but never safe to remove', () => {
  const {root, run} = fixture();
  const legacy = path.join(run, '上传素材');
  fs.mkdirSync(legacy, {recursive: true});
  fs.writeFileSync(path.join(legacy, '01-old.jpg'), 'legacy');
  const row = reportProjectStorage(root).candidates.find(item => item.kind === 'legacy-unmarked-attachment-staging');
  assert(row);
  assert.equal(row.safeToRemove, false);
  assert.match(row.reasons.join('；'), /owner marker/);
});

test('submitted or unknown request staging is preserved with evidence', () => {
  const {root, run, source} = fixture();
  const staging = createRequestStaging({projectRoot: root, runDir: run, projectId: 'p', projectVersion: 1, taskId: 't', runId: path.basename(run), sourceFiles: [source]});
  fs.writeFileSync(path.join(staging.downloadDir, 'result.png'), PNG);
  manifest(run, {state: 'failed', submitted: true, submissionUncertain: true});
  const report = reportProjectStorage(root);
  const candidate = report.candidates.find(item => item.kind === 'request-staging');
  assert.equal(candidate.state, 'unknown');
  assert.equal(candidate.safeToRemove, false);
  const cleanup = cleanupRequestStaging(staging, {outcome: 'download_failed', submitted: true, submissionUncertain: true});
  assert.equal(cleanup.status, 'preserved');
  assert(fs.existsSync(staging.stagingRoot));
});

test('a verified downloaded result removes only its own staging even when submitted', () => {
  const {root, run, source} = fixture();
  const staging = createRequestStaging({projectRoot: root, runDir: run, projectId: 'p', projectVersion: 1, taskId: 't', runId: path.basename(run), sourceFiles: [source]});
  fs.writeFileSync(path.join(staging.downloadDir, 'result.png'), PNG);
  const cleanup = cleanupRequestStaging(staging, {outcome: 'success', submitted: true, submissionUncertain: false});
  assert.equal(cleanup.status, 'removed');
  assert(!fs.existsSync(staging.stagingRoot));
});

test('dry-run reports only owner-marked reconstructible staging; apply moves it to recoverable trash', () => {
  const {root, run, source} = fixture();
  const staging = createRequestStaging({projectRoot: root, runDir: run, projectId: 'p', projectVersion: 1, taskId: 't', runId: path.basename(run), sourceFiles: [source]});
  fs.writeFileSync(path.join(staging.partialDir, 'partial.bin'), 'temporary');
  manifest(run, {state: 'failed', submitted: false, preSubmissionFailure: true});
  const dry = applyProjectStorageCleanup(root, {apply: false});
  const candidate = dry.candidates.find(item => item.kind === 'request-staging');
  assert.equal(candidate.safeToRemove, true);
  assert(fs.existsSync(staging.stagingRoot));
  const applied = applyProjectStorageCleanup(root, {apply: true, report: dry});
  assert.equal(applied.applied, true);
  assert.equal(applied.moved.length, 1);
  assert(!fs.existsSync(staging.stagingRoot));
  assert(fs.existsSync(path.join(root, RECOVERY_TRASH_DIR, path.basename(applied.moved[0].to))));
});

test('staging path traversal and symlink paths are rejected', () => {
  const {root, run, source} = fixture();
  const staging = createRequestStaging({projectRoot: root, runDir: run, sourceFiles: [source]});
  assert.throws(() => ownedStagingPath(staging, '../outside.png'), /路径|staging/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wendi-outside-'));
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => projectPath(root, 'link/file.png'), /符号链接/);
});

test('Downloads report is read-only and never classifies an unmatched image as safe to delete', () => {
  const {root, version, source} = fixture();
  const archived = path.join(version, '素材', 'saved.png');
  fs.mkdirSync(path.dirname(archived), {recursive: true});
  fs.copyFileSync(source, archived);
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wendi-downloads-'));
  const duplicate = path.join(downloads, 'duplicate.png');
  const unknown = path.join(downloads, 'unknown.png');
  fs.copyFileSync(archived, duplicate);
  fs.writeFileSync(unknown, Buffer.concat([PNG, Buffer.from('unknown')]));
  const before = fs.readdirSync(downloads).sort();
  const report = reportDownloadsRedundancy({downloadsDir: downloads, projectRoot: root});
  assert.equal(report.mutated, false);
  assert.equal(report.items.find(item => item.relativePath === 'duplicate.png').category, 'archived');
  assert.equal(report.items.find(item => item.relativePath === 'unknown.png').category, 'unknown');
  assert.deepEqual(fs.readdirSync(downloads).sort(), before);
});

test('Downloads report may read a user-level symlink but still performs no writes', () => {
  const {root, version} = fixture();
  const realDownloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wendi-downloads-real-'));
  fs.writeFileSync(path.join(realDownloads, 'unknown.png'), PNG);
  const link = path.join(root, 'Downloads-link');
  fs.symlinkSync(realDownloads, link, 'dir');
  const report = reportDownloadsRedundancy({downloadsDir: link, projectRoot: root});
  assert.equal(report.mutated, false);
  assert.equal(report.items.length, 1);
  assert.equal(fs.existsSync(path.join(version, '参考', 'ref.png')), true);
});

test('Downloads report ignores hidden application data directories', () => {
  const {root} = fixture();
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wendi-downloads-hidden-'));
  fs.writeFileSync(path.join(downloads, 'visible.png'), PNG);
  fs.mkdirSync(path.join(downloads, '.minecraft', 'journeymap'), {recursive: true});
  fs.writeFileSync(path.join(downloads, '.minecraft', 'journeymap', 'tile.png'), PNG);
  const report = reportDownloadsRedundancy({downloadsDir: downloads, projectRoot: root});
  assert.deepEqual(report.items.map(item => item.relativePath), ['visible.png']);
});
