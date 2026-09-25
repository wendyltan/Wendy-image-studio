import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wendi-accept-race-'));
process.env.WENDI_DATA_DIR = path.join(temp, 'stories');
const W = await import('../server/workflow.mjs');
const B = await import('../server/bridge.mjs');
const E = await import('../server/engine.mjs');

const python = B.python();

async function makeReadyProject(label) {
  const project = E.createProject({idea: `验收并发测试-${label}`, pageCount: 1, allowXiaolin: false, tangyuan: '不出现'});
  project.version = 1;
  project.plan = {pages: [{number: 1, panels: [{}]}]};
  project.approved = {version: 1, hash: W.digest(project.plan)};
  project.status = 'ready';
  project.storyQA = {pass: true, summary: 'fixture'};

  const projectRoot = E.projectDir(project.id);
  const versionRoot = path.join(projectRoot, 'v1');
  const source = path.join(versionRoot, '素材', 'panel.png');
  const page = path.join(versionRoot, '候选成稿', '01.png');
  fs.mkdirSync(path.dirname(source), {recursive: true});
  fs.mkdirSync(path.dirname(page), {recursive: true});
  execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB",(12,12),(60,90,120)).save(sys.argv[1])', source]);
  fs.copyFileSync(source, page);
  const imageInfo = JSON.parse(await B.pythonRun(['info', source]));
  const integrity = file => ({
    ...imageInfo,
    sizeBytes: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  const relativeSource = path.relative(projectRoot, source);
  const relativePage = path.relative(projectRoot, page);
  const sourceIntegrity = integrity(source);
  const pageIntegrity = integrity(page);
  const imageId = 'image:第1页-第1格';
  project.panels = {'1-1': {file: relativeSource, prompt: 'fixture', basePrompt: 'fixture', references: [], qa: {pass: true}, integrity: sourceIntegrity}};
  project.pages = [{
    number: 1,
    file: relativePage,
    qa: {pass: true},
    compositionVersion: E.COMPOSITION_VERSION,
    projectVersion: project.version,
    integrity: pageIntegrity,
    sourceIntegrity: [{key: '1-1', file: relativeSource, ...sourceIntegrity}],
    dependsOn: [imageId],
  }];
  project.artifacts = [
    {id: imageId, kind: 'image', file: relativeSource, valid: true, integrity: sourceIntegrity},
    {id: 'page:1', kind: 'page', file: relativePage, valid: true, compositionVersion: E.COMPOSITION_VERSION, projectVersion: project.version, integrity: pageIntegrity, sourceIntegrity: [{key: '1-1', file: relativeSource, ...sourceIntegrity}]},
    {id: 'story:audit', kind: 'story-audit', file: null, valid: true, dependsOn: ['page:1']},
  ];
  fs.writeFileSync(path.join(versionRoot, '已确认分镜.md'), 'fixture manifest');
  E.saveProject(project);
  return project;
}

function installVerifyBarrier(label) {
  const started = path.join(temp, `${label}-started`);
  const release = path.join(temp, `${label}-release`);
  const invoked = path.join(temp, `${label}-python-args`);
  const wrapper = path.join(temp, `${label}-python`);
  const compose = path.resolve('server/compose.py');
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(invoked)}\nif [ "$1" = ${JSON.stringify(compose)} ] && [ "$2" = "info" ]; then\n  : > ${JSON.stringify(started)}\n  while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done\nfi\nexec ${JSON.stringify(python)} "$@"\n`, {mode: 0o700});
  const oldPython = process.env.WENDI_PYTHON;
  process.env.WENDI_PYTHON = wrapper;
  return {
    async wait(accepting) {
      for (let i = 0; i < 1000 && !fs.existsSync(started); i++) await new Promise(resolve => setTimeout(resolve, 10));
      if (!fs.existsSync(started)) {
        release();
        let acceptError = null;
        try { await accepting; } catch (error) { acceptError = error?.stack || String(error); }
        assert.fail(`accept did not enter source verification; python args=${fs.existsSync(invoked) ? fs.readFileSync(invoked, 'utf8') : '(not invoked)'}; acceptError=${acceptError || '(none)'}`);
      }
    },
    release() { fs.writeFileSync(release, 'go'); },
    restore() { if (oldPython === undefined) delete process.env.WENDI_PYTHON; else process.env.WENDI_PYTHON = oldPython; },
  };
}

test('accept owns the project lock across verification and blocks competing mutations', async () => {
  const project = await makeReadyProject('lock');
  const barrier = installVerifyBarrier('lock');
  try {
    const accepting = E.accept(project, W.CHECKS);
    await barrier.wait(accepting);
    assert.equal(E.active.has(project.id), true);
    await assert.rejects(E.accept(project, W.CHECKS), /验收.*进行|正在制作|等待/);
    assert.throws(() => E.planProject(project, '并发修改方案'), /正在制作|请等待/);
    assert.throws(() => E.reviseImage(project, '1-1', '请调整人物手部'), /正在制作|请等待/);
    barrier.release();
    await accepting;
    assert.equal(project.accepted, true);
    assert.equal(E.active.has(project.id), false);
  } finally {
    barrier.release();
    barrier.restore();
  }
});

test('accept aborts publication when the durable revision changes during verification', async () => {
  const project = await makeReadyProject('cas');
  const projectRoot = E.projectDir(project.id);
  const versionRoot = path.join(projectRoot, 'v1');
  const barrier = installVerifyBarrier('cas');
  try {
    const accepting = E.accept(project, W.CHECKS);
    await barrier.wait(accepting);
    const concurrent = E.readProject(project.id);
    concurrent.title = '并发请求更新的标题';
    concurrent.titleLocked = true;
    E.saveProject(concurrent);
    barrier.release();
    await assert.rejects(accepting, error => error?.code === 'REVISION_CONFLICT');
    const latest = E.readProject(project.id);
    assert.equal(latest.title, '并发请求更新的标题');
    assert.notEqual(latest.accepted, true);
    assert.equal(latest.bundle, undefined);
    assert.equal(fs.existsSync(path.join(versionRoot, '成品', '01.png')), false);
    assert.equal(fs.existsSync(path.join(versionRoot, '温蒂漫画成品.zip')), false);
    assert.equal(E.active.has(project.id), false);
  } finally {
    barrier.release();
    barrier.restore();
  }
});
