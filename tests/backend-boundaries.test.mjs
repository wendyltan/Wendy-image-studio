import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createProjectStore} from '../server/project-store.mjs';
import {createJobRunner} from '../server/job-runner.mjs';
import {createImageWorkflow} from '../server/image-workflow.mjs';

function atomicJsonWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

test('project store keeps revision-safe persistence in one boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wendi-project-store-'));
  const running = new Map();
  const store = createProjectStore({
    dataDir: root,
    idPattern: /^[a-f0-9-]{36}$/,
    inside: (base, name) => path.resolve(base, name),
    jsonWrite: atomicJsonWrite,
    runningProjects: running,
    webImageProvider: 'test-provider',
    webImageExecutorRole: 'browser-executor',
    randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  const project = store.createProject({idea: '持久化边界测试', pageCount: 1});
  assert.equal(project.revision, 1);
  assert.equal(store.readProject(project.id).brief.pageCount, 1);
  running.set(project.id, project);
  const latest = store.readProject(project.id);
  latest.title = '用户标题';
  store.saveProject(latest);
  assert.equal(store.readProject(project.id).title, '用户标题');
  assert.equal(store.readProject(project.id).revision, 2);
});

test('job runner owns queue lifecycle without changing task policy', async () => {
  const records = new Map();
  const fakeJobStore = {
    enqueue(input) {
      const record = {id: 'job-1', status: 'queued', queuedAt: new Date().toISOString(), ...input};
      records.set(record.id, record);
      return record;
    },
    read(id) { return records.get(id); },
    claim(id, owner) { const record = records.get(id); if (record.status !== 'queued') return null; Object.assign(record, {status: 'running', owner, startedAt: new Date().toISOString()}); return record; },
    heartbeat() {},
    finish(id, owner, status, extra) { Object.assign(records.get(id), {status, owner, ...extra}); },
    cancel(id, status, extra) { Object.assign(records.get(id), {status, ...extra}); },
    reclaimOrphanedLock() {},
  };
  const active = new Map();
  const runningProjects = new Map();
  const saved = [];
  const runner = createJobRunner({
    active,
    runningProjects,
    jobStore: fakeJobStore,
    queueOwner: 'test-owner',
    saveProject: project => saved.push(project.status),
    finishTask: () => {},
    finishProgressStage: () => {},
  });
  const project = {id: 'project-1', progress: {}};
  let ran = false;
  runner.job(project, 'testing', async () => { ran = true; });
  for (let attempt = 0; attempt < 50 && active.has(project.id); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(ran, true);
  assert.equal(active.has(project.id), false);
  assert.equal(runningProjects.has(project.id), false);
  assert.equal(records.get('job-1').status, 'completed');
  assert(saved.includes('testing'));
});

test('image workflow quota boundary records account and executor telemetry separately', async () => {
  const workflow = createImageWorkflow({
    rateLimitSnapshot: async () => ({
      status: 'fresh', observedAt: Date.now(),
      primary: {remainingPercent: 80, resetsAt: 123},
      byLimitId: {codex: {}, image: {normalModelSlug: 'gpt-5.1', primary: {remainingPercent: 5, resetsAt: 456}}},
    }),
    saveProject: () => {},
  });
  const project = {};
  await workflow.protectQuota(project, {executorModel: 'gpt-5.1'});
  assert.equal(project.lastQuotaCheck.remaining, 80);
  assert.equal(project.lastQuotaCheck.executorRemaining, 5);
  assert.equal(project.lastQuotaCheck.executorLimitId, 'image');

  const blocked = createImageWorkflow({
    rateLimitSnapshot: async () => ({status: 'fresh', observedAt: Date.now(), primary: {remainingPercent: 10, resetsAt: 123}}),
    saveProject: () => {},
  });
  await assert.rejects(() => blocked.protectQuota({}, {}), error => error.code === 'LOW_QUOTA');
});
