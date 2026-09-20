import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const api = read('app/studio/api.ts');
const project = read('app/studio/use-project-controller.ts');
const assets = read('app/studio/use-assets-controller.ts');
const documents = read('app/studio/use-document-controller.ts');
const controller = read('app/studio/use-studio-controller.ts');
const page = read('app/page.tsx');

test('studio API keeps browser requests in one typed boundary', () => {
  assert.match(api, /export async function request<T>\(/);
  assert.match(api, /signal\?: AbortSignal/);
  assert.match(api, /cache: 'no-store', signal/);
  assert.match(api, /X-Wendi-Request/);
  for (const route of [
    "'/api/bootstrap'",
    "'/api/account'",
    "'/api/projects'",
    "'/api/restart'",
    "'/api/health'",
    "'/api/assets/analyze'",
    "'/api/assets/stage'",
    "'/api/assets/manual-save'",
    "'/api/documents/suggest'",
    "'/api/documents/save'",
  ])
    assert.match(api, new RegExp(route.replaceAll('/', '\\/')));
  assert.doesNotMatch(page, /fetch\(/);
});

test('project controller owns bootstrap, polling, quota refresh, and workflow actions', () => {
  assert.match(project, /studioApi\.bootstrap\(\)/);
  assert.match(project, /studioApi\.project\(current/);
  assert.match(project, /const requestController = new AbortController\(\)/);
  assert.match(project, /requestController\.abort\(\)/);
  assert.match(project, /actionInFlight\.current/);
  assert.match(project, /window\.setTimeout\(poll, delay\)/);
  assert.match(project, /quotaRefreshInFlight/);
  assert.match(project, /studioApi\.projectAction\(project\.id, name, body\)/);
  assert.match(project, /studioApi\.deleteProject/);
  assert.match(project, /studioApi\.deleteArchive/);
  assert.doesNotMatch(page, /setInterval\(/);
});

test('assets and documents keep their state and remote actions out of the page shell', () => {
  assert.match(assets, /studioApi\.stageAsset/);
  assert.match(assets, /studioApi\.saveManualAsset/);
  assert.match(assets, /studioApi\.searchAssets/);
  assert.match(assets, /studioApi\.applyProposal/);
  assert.match(documents, /studioApi\.suggestDocument/);
  assert.match(documents, /studioApi\.saveDocument/);
  assert.match(controller, /useProjectController\(/);
  assert.match(controller, /useAssetsController\(/);
  assert.match(controller, /useDocumentController\(/);
  assert.match(page, /<StudioDialogs/);
  assert.doesNotMatch(
    page,
    /async function (upload|saveDoc|suggestDoc|action)\(/,
  );
});

test('controller extraction leaves the shell below the phase-two size budget', () => {
  const lines = page.split('\n').length;
  assert.ok(lines <= 1200, `page.tsx remains ${lines} lines`);
});
