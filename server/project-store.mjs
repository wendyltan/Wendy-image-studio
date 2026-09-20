import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Durable project storage boundary.
 *
 * The workflow engine owns decisions and orchestration; this module owns the
 * filesystem shape, revision-safe atomic writes, and compatibility hydration
 * performed when an older project is read.  Keeping those concerns together
 * makes it harder for a new workflow stage to accidentally bypass the
 * project-level revision guard.
 */
export function createProjectStore({
  dataDir,
  idPattern,
  inside,
  jsonWrite,
  runningProjects,
  webImageProvider,
  webImageExecutorRole,
  randomUUID = () => crypto.randomUUID(),
}) {
  if (!dataDir || !(idPattern instanceof RegExp) || typeof inside !== 'function' || typeof jsonWrite !== 'function') {
    throw new TypeError('project store requires dataDir, idPattern, inside, and jsonWrite');
  }

  fs.mkdirSync(dataDir, {recursive: true});

  function projectDir(id) {
    if (!idPattern.test(id)) throw new Error('作品不存在');
    return inside(dataDir, id);
  }

  function inferredModelAt(project, at) {
    const history = (project.modelHistory || [])
      .filter(item => Date.parse(item.at) <= at)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (history.length) return history.at(-1).to || {};
    const first = (project.modelHistory || []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.from;
    return first?.model ? first : {model: '历史模型未记录', reasoningEffort: 'unknown'};
  }

  function roleForRun(name, request = {}) {
    const metadata = request && typeof request === 'object' ? request : {};
    if (typeof metadata.role === 'string' && metadata.role.trim()) return metadata.role.trim();
    if (metadata.provider === webImageProvider) return webImageExecutorRole;
    return /画面校对|内屏位置识别/.test(name) ? 'qa' : 'creative';
  }

  function hydrateMetricBreakdown(project) {
    project.metrics = project.metrics || {inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalRuns: 0};
    if (Array.isArray(project.metrics.byRole)) return project;
    const groups = new Map();
    const records = path.join(projectDir(project.id), '.制作记录');
    const runs = [];
    if (fs.existsSync(records)) {
      for (const name of fs.readdirSync(records)) {
        const dir = path.join(records, name);
        const events = path.join(dir, 'events.jsonl');
        if (!fs.existsSync(events)) continue;
        let usage = null;
        for (const line of fs.readFileSync(events, 'utf8').split('\n')) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'turn.completed' && event.usage) usage = event.usage;
          } catch {
            // A partially written event log should not make a project unreadable.
          }
        }
        if (!usage) continue;
        let request = null;
        let execution = null;
        try { request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')); } catch {}
        try { execution = JSON.parse(fs.readFileSync(path.join(dir, 'execution.json'), 'utf8')); } catch {}
        const recorded = request || execution;
        const started = Number(name.split('-')[0]) || fs.statSync(dir).birthtimeMs || fs.statSync(dir).mtimeMs;
        const hasRecordedSelection = Boolean(recorded && ['model', 'reasoningEffort', 'executorModel', 'executorReasoningEffort']
          .some(key => Object.prototype.hasOwnProperty.call(recorded, key)));
        const selected = hasRecordedSelection
          ? {model: (recorded.executorModel ?? recorded.model) || '默认模型', reasoningEffort: (recorded.executorReasoningEffort ?? recorded.reasoningEffort) || 'unknown'}
          : inferredModelAt(project, started);
        runs.push({started, usage, selected, role: roleForRun(name, request ?? execution)});
      }
    }
    runs.sort((a, b) => a.started - b.started);
    const total = Number(project.metrics.totalRuns) || 0;
    const selectedRuns = total && runs.length > total ? runs.slice(-total) : runs;
    let attributed = 0;
    for (const {usage, selected, role} of selectedRuns) {
      const model = selected.model || '历史模型未记录';
      const effort = selected.reasoningEffort || 'unknown';
      const key = `${model}\u0000${effort}`;
      const current = groups.get(key) || {model, reasoningEffort: effort, runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0};
      current.runs++;
      current.inputTokens += Number(usage.input_tokens) || 0;
      current.cachedInputTokens += Number(usage.cached_input_tokens) || 0;
      current.outputTokens += Number(usage.output_tokens) || 0;
      current.reasoningOutputTokens += Number(usage.reasoning_output_tokens) || 0;
      groups.set(key, current);
      attributed++;
      const roleKey = `${role}\u0000${key}`;
      const roleRow = groups.get(roleKey) || null;
      if (!roleRow) {
        groups.set(roleKey, {role, model, reasoningEffort: effort, runs: 1, inputTokens: Number(usage.input_tokens) || 0, cachedInputTokens: Number(usage.cached_input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0, reasoningOutputTokens: Number(usage.reasoning_output_tokens) || 0});
      } else if (roleRow.role) {
        roleRow.runs++;
        roleRow.inputTokens += Number(usage.input_tokens) || 0;
        roleRow.cachedInputTokens += Number(usage.cached_input_tokens) || 0;
        roleRow.outputTokens += Number(usage.output_tokens) || 0;
        roleRow.reasoningOutputTokens += Number(usage.reasoning_output_tokens) || 0;
      }
    }
    const roleRows = [...groups.values()].filter(row => row.role);
    if (!Array.isArray(project.metrics.byModel)) project.metrics.byModel = [...groups.values()].filter(row => !row.role).sort((a, b) => b.runs - a.runs);
    project.metrics.byRole = roleRows.sort((a, b) => b.runs - a.runs);
    project.metrics.unattributedRuns = Math.max(0, (Number(project.metrics.totalRuns) || 0) - attributed);
    return project;
  }

  function normalizeDeferredQA(project) {
    for (const record of [...(project.samples || []), ...Object.values(project.panels || {})]) {
      if (record?.qa?.status === 'deferred' && record.qa.pass === true) {
        record.qa = {...record.qa, pass: null, summary: record.qa.summary || '仅完成本地文件检查，尚未完成画面质检。'};
      }
    }
    return project;
  }

  function readProject(id) {
    const file = path.join(projectDir(id), 'project.json');
    if (!fs.existsSync(file)) throw new Error('作品不存在');
    return normalizeDeferredQA(hydrateMetricBreakdown(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }

  function syncRunningProject(id, patch) {
    const running = runningProjects.get(id);
    if (!running) return;
    const brief = patch.brief ? {...running.brief, ...patch.brief} : running.brief;
    Object.assign(running, patch);
    running.brief = brief;
  }

  function saveProject(project) {
    const file = path.join(projectDir(project.id), 'project.json');
    // A running task keeps an in-memory snapshot. Preserve user changes made
    // from another request before that task writes its next progress checkpoint.
    if (fs.existsSync(file)) {
      const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (runningProjects.has(project.id) && Number(latest.revision) > Number(project.revision)) {
        if (latest.titleLocked && latest.title !== project.title) {
          project.title = latest.title;
          project.titleLocked = true;
        }
        if (latest.brief?.model && latest.brief.model !== project.brief?.model) {
          project.brief = {...project.brief, model: latest.brief.model, reasoningEffort: latest.brief.reasoningEffort};
        }
      }
      project.revision = Math.max(Number(project.revision) || 0, Number(latest.revision) || 0);
    }
    project.schemaVersion = 3;
    project.revision = (Number(project.revision) || 0) + 1;
    project.updatedAt = new Date().toISOString();
    jsonWrite(file, project);
  }

  function listProjects() {
    return fs.readdirSync(dataDir)
      .filter(id => idPattern.test(id) && fs.existsSync(path.join(dataDir, id, 'project.json')))
      .map(readProject)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function createProject(brief) {
    if (typeof brief.idea !== 'string' || brief.idea.trim().length < 4 || brief.idea.length > 12000) throw new Error('请用至少四个字描述想画的故事。');
    if (!Number.isInteger(brief.pageCount) || brief.pageCount < 1 || brief.pageCount > 12) throw new Error('每篇请选择1—12页。');
    const clean = {
      idea: brief.idea.trim(),
      pageCount: brief.pageCount,
      special: String(brief.special || '').slice(0, 6000),
      allowXiaolin: brief.allowXiaolin === true,
      tangyuan: ['按剧情', '自然出现', '不出现'].includes(brief.tangyuan) ? brief.tangyuan : '按剧情',
      model: String(brief.model || ''),
      reasoningEffort: String(brief.reasoningEffort || 'medium'),
      workflowPreset: ['quick', 'balanced', 'careful'].includes(brief.workflowPreset) ? brief.workflowPreset : 'balanced',
    };
    const project = {
      id: randomUUID(), schemaVersion: 3, revision: 0, title: clean.idea.slice(0, 20), titleLocked: false,
      brief: clean, status: 'draft', message: '需求已保存', createdAt: new Date().toISOString(), version: 0,
      plan: null, approved: null, samplesApproved: false, samples: [], sampleRepairCounts: [0, 0], lastFailure: null,
      currentTask: null, tasks: [], panels: {}, pages: [], history: [], revisionNotes: [], accepted: false,
      progress: {phase: 'draft', current: 0, total: 1, unit: '步骤', startedAt: null, completedAt: null, stages: [], stageSerial: 0},
      metrics: {inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalRuns: 0, byModel: [], byRole: [], unattributedRuns: 0, refreshSerial: 0},
    };
    saveProject(project);
    return project;
  }

  return Object.freeze({projectDir, readProject, syncRunningProject, saveProject, listProjects, createProject, hydrateMetricBreakdown});
}
