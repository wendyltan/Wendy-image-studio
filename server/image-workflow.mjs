import fs from 'node:fs';
import path from 'node:path';
import {readDownloadEvidence} from './web-download-evidence.mjs';
import {IMAGE_OUTCOME,SavedArtifactQaUnavailableError,savedArtifactQaUnavailable,applySavedArtifactQaOutcome} from './image-lifecycle.mjs';
import {createImagePreparation} from './image-preparation.mjs';
import {cleanupRequestStaging} from './storage-hygiene.mjs';
import {acquireImageFlight,releaseImageFlight} from './image-single-flight.mjs';

const USAGE_LIMIT_ERROR=/(?:you'?ve hit your usage limit|usage limit(?: has been)? reached|rate limit reached|额度(?:已用尽|不足|限制)|使用额度(?:已用尽|不足)|hit your limit)/i;

function ownedTabLifecycle(manifest) {
  if (!manifest) return {};
  return {
    ownedTabId: manifest.ownedTabId || null,
    sessionName: manifest.sessionName || null,
    ownedTabState: manifest.ownedTabState || null,
    cleanupStatus: manifest.cleanupStatus || manifest.ownedTabCleanupStatus || null,
    cleanupVerifiedAt: manifest.cleanupVerifiedAt || null,
    cleanupError: manifest.cleanupError || null,
    kernelReset: manifest.kernelReset === true,
  };
}

/**
 * The paid image path is a sequence of evidence-bearing stages.  This factory
 * keeps filesystem/provider details behind injected callbacks while leaving
 * project/page policy in engine.mjs.
 */
export function createImageWorkflow({
  projectDir,
  inside,
  versionDir,
  runDir,
  jsonWrite,
  pythonRun,
  runCodex,
  rateLimitSnapshot,
  generationDiagnosticSummary,
  findCodex,
  webWorkerStatus,
  webImageProvider,
  webImageExecutorRole,
  webImageExecutorEffort,
  chatGptWebImagePrompt,
  dispatchChatGptWebJob,
  resumeChatGptWebJob,
  readWebManifest,
  browserExecutorArgs,
  promptTelemetry,
  promptHash,
  revisionPromptTelemetry,
  checkpoint,
  activity,
  saveProject,
  beginTask,
  addUsage,
  finishTask,
  job,
  verifyApproval,
  imageRefs,
  qa,
  requirePanelDecision,
  invalidatePanelDownstream,
  recordArtifact,
  attachImageRecord,
  artifactIdForImageKey,
  panelKeyFromImageKey,
  definiteImageFailure,
  failureMessage,
  preAcceptanceQuotaEvidence,
  confirmedUnsentEvidence,
  quotaPauseMessage,
  matchingPendingManifest,
  matchingWebRunRecord,
  attributableCandidates,
  persistImage,
  writeRunResult,
  checksum,
}) {
  const preparation = createImagePreparation({
    projectDir,
    inside,
    versionDir,
    jsonWrite,
    pythonRun,
    rateLimitSnapshot,
    webImageExecutorRole,
    webImageExecutorEffort,
    checksum,
    saveProject,
  });
  const {preparedCacheFor,prepareWebAttachments,executorLimitFor,protectQuota,writeRunRequest,previousConversation}=preparation;

  function cleanupOwnStaging(project, dir, outcome, extra = {}) {
    if (!project || !dir) return {status: 'not_attempted', removed: false};
    try {
      return cleanupRequestStaging({root: projectDir(project.id), stagingRoot: path.join(dir, '.staging')}, {outcome, ...extra});
    } catch (error) {
      // Cleanup must never turn a recoverable image result into a different
      // workflow outcome. The run directory remains the durable evidence and
      // the storage report will surface an owner-marked orphan for review.
      return {status: 'error', removed: false, error: String(error.message || error)};
    }
  }

  async function generateLocked(project, key, prompt, refnames, signal, prior = null, verify = true, qaKind = '原始分镜', attempt = 1, revisionMeta = {}) {
    checkpoint(signal);
    if (!process.env.WENDI_TEST_PLAN_FILE) {
      const worker = webWorkerStatus();
      if (!worker.ready) {
        const error = new Error(worker.message);
        error.code = 'BROWSER_CHROME_UNAVAILABLE';
        throw error;
      }
    }
    const executor = browserExecutorArgs(project);
    await protectQuota(project, {executorModel: executor.model});
    checkpoint(signal);
    const refs = imageRefs(project, refnames);
    const folder = path.join(versionDir(project), '素材');
    fs.mkdirSync(folder, {recursive: true});
    if (project.pending) throw new Error('当前图片任务尚未结束，请先检查已有原图。');
    let file = path.join(folder, `${key}-${Date.now()}.png`);
    const dir = runDir(project, key);
    const sourceFiles = prior ? [prior, ...refs] : refs;
    fs.mkdirSync(dir, {recursive: true});
    const basePrompt = String(revisionMeta.basePrompt || prompt);
    const revisionDelta = revisionMeta.revisionDelta ? String(revisionMeta.revisionDelta) : null;
    const prepStartedAt = new Date().toISOString();
    const cachePlan = preparedCacheFor(project, sourceFiles, prior);
    activity(project, `正在整理并压缩${cachePlan.missing.length}个上传素材${cachePlan.cacheHits ? `，复用${cachePlan.cacheHits}个已准备附件` : ''}…`);
    let prepared;
    try {
      prepared = await prepareWebAttachments(project, dir, sourceFiles, cachePlan);
    } catch (error) {
      cleanupOwnStaging(project, dir, 'pre_submission_failure', {submitted: false, submissionUncertain: false, reason: 'attachment_preparation_failed'});
      throw error;
    }
    const preparation = {startedAt: prepStartedAt, completedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(prepStartedAt)), sourceCount: sourceFiles.length, preparedCount: prepared.length, reusedCount: cachePlan.cacheHits, preparedCountThisRun: cachePlan.missing.length};
    const inputFiles = prepared.map(item => item.file);
    checkpoint(signal);
    const revisionTelemetry = revisionDelta ? revisionPromptTelemetry(prompt, {basePrompt, note: revisionDelta}) : {};
    const telemetry = promptTelemetry(prompt, refs, {
      requestedReferenceCount: refnames.length,
      source: prior ? 'edit' : 'generate',
      basePromptSha256: promptHash(basePrompt),
      revisionDeltaSha256: revisionDelta ? promptHash(revisionDelta) : null,
      revisionDeltaCharacters: revisionDelta?.length || 0,
      ...revisionTelemetry,
      preparation,
      preparedAttachments: prepared.map((item, index) => ({sourceSha256: cachePlan.sourceSha256s[index], file: path.relative(projectDir(project.id), item.file), optimized: item.optimized === true, sizeBytes: Number(item.sizeBytes || 0), reused: item.reused === true})),
      uploadOriginalBytes: sourceFiles.reduce((n, item) => n + fs.statSync(item).size, 0),
      uploadPreparedBytes: prepared.reduce((n, item) => n + Number(item.sizeBytes || 0), 0),
      optimizedAttachmentCount: prepared.filter(item => item.optimized).length,
    });
    const lifecycleDefaults = {ownedTabId: null, ownedTabState: 'not_created', cleanupStatus: 'not_attempted', cleanupVerifiedAt: null, cleanupError: null, kernelReset: false};
    const task = beginTask(project, 'image', key, {attempt, provider: webImageProvider, providerInvocationLimit: 1, providerInvocations: 0, source: prior ? 'edit' : 'generate', role: webImageExecutorRole, creativeModel: project.brief.model || null, creativeReasoningEffort: project.brief.reasoningEffort || null, executorModel: executor.model, executorReasoningEffort: executor.reasoningEffort, basePrompt, revisionDelta, revisionBase: revisionMeta.revisionBase || null, telemetry, ...lifecycleDefaults});
    const pending = {key, file, dir, prompt, basePrompt, revisionDelta, revisionBase: revisionMeta.revisionBase || null, refs: refnames, inputFiles, sourceFiles, prior, provider: webImageProvider, executorModel: executor.model, executorReasoningEffort: executor.reasoningEffort, taskId: task.id, projectId: project.id, projectVersion: project.version, telemetry, ...lifecycleDefaults, at: new Date().toISOString()};
    writeRunRequest(dir, project, task, pending);
    project.pending = pending;
    project.lastFailure = null;
    saveProject(project);
    activity(project, `正在打开专用生图页面并上传${inputFiles.length}个素材…`);
    let failure;
    let made = null;
    const manifestFile = path.join(dir, 'web-generation.json');
    const conversationUrl = previousConversation(prior);
    const capsule = fs.readFileSync(path.join(versionDir(project), '制作提示词胶囊.txt'), 'utf8');
    try {
      if (process.env.WENDI_TEST_PLAN_FILE) {
        task.providerInvocations = 1;
        saveProject(project);
        made = await runCodex({dir, signal, image: true, browserMode: 'chrome', writableDirs: [projectDir(project.id)], ...executor, prompt: chatGptWebImagePrompt({outputFile: file, manifestFile, prompt, referenceFiles: inputFiles, editTarget: prior, conversationUrl, capsule})});
      } else {
        made = await dispatchChatGptWebJob({codexBin: findCodex(), dir, outputFile: file, prompt, referenceFiles: inputFiles, editTarget: prior, conversationUrl, capsule, signal, ...executor});
      }
      if (made?.usage) addUsage(project, made.usage, executor);
    } catch (error) { failure = error; }
    const webManifest = readWebManifest(manifestFile) || failure?.webManifest || made?.manifest || null;
    // The provider validates the frozen attachment ledger before creating the
    // browser request. That deterministic failure therefore has no manifest
    // to match; do not let the later identity guard downgrade it to an
    // unknown result (or leave a live pending task behind).
    if (failure?.code === 'REFERENCE_FILES_INVALID') {
      const message = String(failure.message || '服务端冻结附件台账无效；本次未打开浏览器、上传附件或发送消息。').slice(0, 1000);
      const known = {kind: 'reference-files-invalid', definiteNoOutput: true, key, attempts: 0, inputTokens: 0, at: new Date().toISOString(), message};
      writeRunResult(dir, {schemaVersion: 2, provider: webImageProvider, projectId: project.id, projectVersion: project.version, taskId: task.id, target: key, attempt: task.attempt, endedAt: new Date().toISOString(), outcome: 'pre_submission_failure', errorCode: 'REFERENCE_FILES_INVALID', error: message});
      project.pending = null;
      project.lastFailure = {...known, taskId: task.id};
      cleanupOwnStaging(project, dir, 'pre_submission_failure', {submitted: false, submissionUncertain: false, reason: known.kind});
      finishTask(project, task, 'failed_no_output', {errorCode: known.kind, providerInvocations: 0});
      saveProject(project);
      const error = new Error(message);
      error.code = 'IMAGE_NO_OUTPUT';
      error.referenceValidation = failure.referenceValidation || null;
      throw error;
    }
    if (webManifest?.requestId) {
      pending.requestId = webManifest.requestId;
      task.requestId = webManifest.requestId;
      task.accepted = webManifest.accepted === true;
      task.submitted = webManifest.submitted === true;
      task.referenceCount = Number(webManifest.referenceCount) || 0;
      pending.accepted = webManifest.accepted === true;
      pending.submitted = webManifest.submitted === true;
      pending.referenceCount = Number(webManifest.referenceCount) || 0;
      Object.assign(pending, ownedTabLifecycle(webManifest));
      Object.assign(task, ownedTabLifecycle(webManifest));
      saveProject(project);
    }
    activity(project, '正在核对网页执行结果并保存原图…');
    if (!process.env.WENDI_TEST_PLAN_FILE && !matchingPendingManifest(pending)) {
      cleanupOwnStaging(project, dir, 'unknown', {submitted: webManifest?.submitted === true, submissionUncertain: webManifest?.submissionUncertain === true, reason: 'request_identity_mismatch'});
      finishTask(project, task, 'unknown_result', {errorCode: 'REQUEST_IDENTITY_MISMATCH'});
      saveProject(project);
      throw new Error('执行记录与本次图片请求不匹配，原文件已保留，不能自动采用或重试。');
    }
    task.providerInvocations = webManifest?.submitted ? 1 : (process.env.WENDI_TEST_PLAN_FILE ? task.providerInvocations : 0);
    task.webTimings = webManifest ? {createdAt: webManifest.createdAt || null, acceptedAt: webManifest.acceptedAt || null, readyAt: webManifest.readyAt || null, submittedAt: webManifest.submittedAt || null, downloadedAt: webManifest.downloadedAt || null, executorModel: webManifest.executorModel || executor.model || null, executorReasoningEffort: webManifest.executorReasoningEffort || executor.reasoningEffort, role: webManifest.role || webImageExecutorRole, ...ownedTabLifecycle(webManifest)} : null;
    saveProject(project);
    if (preAcceptanceQuotaEvidence(pending, webManifest, failure, made)) {
      const usageError = String(failure?.message || webManifest.error || '已达到生图执行器额度限制。').slice(0, 1000);
      const message = quotaPauseMessage(key, webManifest.requestId, task.id, project.version, usageError);
      task.providerInvocations = 0;
      task.status = 'paused';
      task.errorCode = 'USAGE_LIMIT_BEFORE_START';
      task.webState = 'queued';
      task.completedAt = new Date().toISOString();
      task.error = message;
      task.requestId = webManifest.requestId;
      pending.quotaPaused = true;
      pending.quotaError = usageError;
      project.pending = pending;
      project.lastFailure = null;
      project.status = 'paused';
      project.error = message;
      project.message = message;
      writeRunResult(dir, {schemaVersion: 2, provider: webImageProvider, taskId: task.id, requestId: webManifest.requestId, projectId: project.id, projectVersion: project.version, target: key, endedAt: new Date().toISOString(), outcome: 'quota_paused_before_acceptance', manifestState: webManifest.state, accepted: webManifest.accepted === true, submitted: webManifest.submitted === true, referenceCount: Number(webManifest.referenceCount) || 0, error: usageError});
      cleanupOwnStaging(project, dir, 'pre_submission_failure', {submitted: false, submissionUncertain: false, reason: 'quota_before_acceptance'});
      saveProject(project);
      const error = new Error(message);
      error.code = 'USAGE_LIMIT_BEFORE_START';
      error.webManifest = webManifest;
      throw error;
    }
    const {evidence, candidates} = attributableCandidates(pending);
    let persisted = null;
    if (candidates.length === 1) persisted = await persistImage(candidates[0], file);
    if (!persisted) {
      const candidateNames = candidates.map(candidate => path.basename(candidate));
      writeRunResult(dir, {schemaVersion: 2, provider: webImageProvider, taskId: task.id, attempt: task.attempt, endedAt: new Date().toISOString(), outcome: 'artifact_not_located', diagnostics: generationDiagnosticSummary(evidence), candidateCount: candidateNames.length, candidateNames, error: failure ? String(failure.message || failure).slice(0, 500) : null});
      const known = definiteImageFailure(pending, [made?.text, failure?.message, webManifest?.errorCode, webManifest?.error].filter(Boolean).join('\n'));
      if (known) {
        if (new Set(['no-output', 'browser-unavailable', 'browser-origin-permission-denied', 'browser-upload-unavailable', 'browser-create-unavailable', 'browser-handle-lost', 'browser-mode-entry-unavailable', 'file-chooser-event-timeout', 'file-chooser-route-unavailable', 'file-set-failed', 'attachment-verification-timeout', 'reference-files-invalid']).has(known.kind) && known.kind !== 'no-output') task.providerInvocations = 0;
        project.pending = null;
        project.lastFailure = {...known, taskId: task.id};
        cleanupOwnStaging(project, dir, 'pre_submission_failure', {submitted: webManifest?.submitted === true, submissionUncertain: webManifest?.submissionUncertain === true, reason: known.kind});
        finishTask(project, task, 'failed_no_output', {errorCode: known.kind});
        saveProject(project);
        const error = new Error(failureMessage(known));
        error.code = 'IMAGE_NO_OUTPUT';
        throw error;
      }
      cleanupOwnStaging(project, dir, 'unknown', {submitted: webManifest?.submitted === true, submissionUncertain: webManifest?.submissionUncertain === true, reason: 'artifact_not_located'});
      finishTask(project, task, 'unknown_result', {errorCode: 'unknown_result'});
      throw failure || new Error('连接在保存结果前中断。当前节点已保存，请先检查已有原图，避免重复生成。');
    }
    file = persisted.file;
    pending.file = file;
    pending.integrity = persisted.integrity;
    cleanupOwnStaging(project, dir, 'success', {submitted: webManifest?.submitted === true, submissionUncertain: false, reason: 'artifact_saved'});
    writeRunResult(dir, {schemaVersion: 2, provider: webImageProvider, projectId: project.id, projectVersion: project.version, taskId: task.id, target: key, requestId: webManifest?.requestId || null, attempt: task.attempt, endedAt: new Date().toISOString(), outcome: 'artifact_saved', artifact: path.relative(projectDir(project.id), file), integrity: persisted.integrity, downloadEvidence: readDownloadEvidence(dir), diagnostics: generationDiagnosticSummary(evidence)});
    const record = {key, file: path.relative(projectDir(project.id), file), provider: webImageProvider, conversationUrl: webManifest?.conversationUrl || conversationUrl || null, prompt, basePrompt, revisionDelta, revisionBase: revisionMeta.revisionBase || null, executor: {model: executor.model, reasoningEffort: executor.reasoningEffort, role: webImageExecutorRole}, refs: refnames, telemetry, integrity: persisted.integrity, downloadEvidence: readDownloadEvidence(dir), qa: verify ? {pass: null, status: 'pending', summary: '原图已保存，等待画面校对。', issues: [], repairPrompt: ''} : {pass: null, status: 'deferred', summary: '已完成本地文件检查；尚未执行画面质检。', issues: [], repairPrompt: ''}, at: new Date().toISOString()};
    jsonWrite(`${file}.json`, record);
    const panelKey = panelKeyFromImageKey(key);
    if (panelKey) invalidatePanelDownstream(project, panelKey);
    recordArtifact(project, artifactIdForImageKey(key), 'image', record.file, [], {integrity: persisted.integrity, downloadEvidence: record.downloadEvidence});
    attachImageRecord(project, record);
    project.pending = null;
    project.lastFailure = null;
    finishTask(project, task, 'artifact_saved', {artifact: file, qa: verify ? 'pending' : 'deferred'});
    saveProject(project);
    if (!verify) return record;
    try {
      checkpoint(signal);
      const check = await qa(project, file, prompt, refs, signal, qaKind);
      record.qa = check;
      jsonWrite(`${file}.json`, record);
      finishTask(project, task, 'completed', {artifact: file, qa: check.pass ? 'passed' : 'needs_review'});
      saveProject(project);
      return record;
    } catch (error) {
      if (signal.aborted) {
        record.qa = {...record.qa, status: 'unavailable', summary: '原图已保存，但本次任务已暂停，尚未自动校对。', qaError: String(error.message || error).slice(0, 500)};
        jsonWrite(`${file}.json`, record);
        finishTask(project, task, IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED, {artifact: file, qa: 'unavailable', error: record.qa.qaError});
        saveProject(project);
        throw error;
      }
      const outcome = savedArtifactQaUnavailable(error, {artifact: file});
      applySavedArtifactQaOutcome({project, task, record, artifactFile: file, outcome, saveProject, finishTask, jsonWrite, writeRunResult: result => writeRunResult(dir, result), runResult: {schemaVersion: 2, provider: webImageProvider, taskId: task.id, attempt: task.attempt, endedAt: new Date().toISOString(), outcome: outcome.outcome, artifact: path.relative(projectDir(project.id), file), integrity: persisted.integrity, errorCode: outcome.errorCode, error: outcome.detail}});
      throw new SavedArtifactQaUnavailableError(error, {artifact: file});
    }
  }

  async function generate(project, key, prompt, refnames, signal, prior = null, verify = true, qaKind = '原始分镜', attempt = 1, revisionMeta = {}) {
    const flight = acquireImageFlight({projectId: project.id, projectDir: projectDir(project.id), projectVersion: project.version, panelKey: key, mode: prior ? 'revise' : 'generate'});
    try {
      return await generateLocked(project, key, prompt, refnames, signal, prior, verify, qaKind, attempt, revisionMeta);
    } finally {
      releaseImageFlight(flight, {outcome: 'workflow-finished'});
    }
  }

  function resumeSameRequestImage(project) {
    verifyApproval(project);
    const pending = project.pending;
    const record = matchingWebRunRecord(pending);
    const manifest = record?.manifest;
    const quota = preAcceptanceQuotaEvidence(pending, manifest);
    const confirmedUnsent = confirmedUnsentEvidence(pending, manifest);
    if (!quota && !confirmedUnsent) throw new Error('当前图片请求既不是可安全续接的接受前额度暂停，也没有匹配的网页未发送核验；请先检查已有原图。');
    const task = (project.tasks || []).find(item => item.id === pending.taskId);
    if (!task || task.projectId !== project.id || Number(task.projectVersion) !== Number(project.version) || task.target !== pending.key) throw new Error('待续接任务与当前作品版本不匹配；原记录已保留。');
    return job(project, 'revising', async signal => {
      const flight = acquireImageFlight({projectId: project.id, projectDir: projectDir(project.id), projectVersion: project.version, panelKey: pending.key, taskId: pending.taskId, requestId: manifest.requestId, mode: 'resume'});
      try {
      const executor = {model: pending.executorModel || record.worker.executorModel || null, reasoningEffort: pending.executorReasoningEffort || record.worker.executorReasoningEffort || webImageExecutorEffort, role: record.worker.role || webImageExecutorRole};
      await protectQuota(project, {executorModel: executor.model});
      checkpoint(signal);
      Object.assign(task, {status: 'running', errorCode: null, error: null, completedAt: null, lastProgressAt: new Date().toISOString(), resumedAt: new Date().toISOString(), requestId: manifest.requestId, providerInvocations: 0});
      project.currentTask = task;
      activity(project, quota ? `额度已恢复，正在按原 requestId 续接 ${pending.key}；不会创建第二个请求…` : `已核实上次网页未实际发送，正在按原 requestId 续接 ${pending.key}；不会创建第二个请求…`);
      let made = null;
      let failure = null;
      const capsule = fs.readFileSync(path.join(versionDir(project), '制作提示词胶囊.txt'), 'utf8');
      const conversationUrl = manifest.conversationUrl || previousConversation(pending.prior);
      const instruction = chatGptWebImagePrompt({outputFile: record.worker.outputFile || pending.file, manifestFile: path.join(pending.dir, 'web-generation.json'), prompt: pending.prompt, remotePrompt: pending.prompt, referenceFiles: record.worker.referenceFiles || pending.inputFiles || [], editTarget: pending.prior, conversationUrl, capsule, requestId: manifest.requestId});
      try { made = await resumeChatGptWebJob({codexBin: findCodex(), dir: pending.dir, signal, ...executor, instruction, expected: {projectId: project.id, projectVersion: project.version, taskId: pending.taskId, target: pending.key, requestId: manifest.requestId}}); if (made?.usage) addUsage(project, made.usage, executor); } catch (error) { failure = error; }
      const webManifest = readWebManifest(path.join(pending.dir, 'web-generation.json')) || failure?.webManifest || made?.manifest || null;
      if (webManifest?.requestId) {
        pending.requestId = webManifest.requestId;
        pending.accepted = webManifest.accepted === true;
        pending.submitted = webManifest.submitted === true;
        pending.referenceCount = Number(webManifest.referenceCount) || 0;
        Object.assign(pending, ownedTabLifecycle(webManifest));
        Object.assign(task, ownedTabLifecycle(webManifest));
        task.requestId = webManifest.requestId;
        task.accepted = pending.accepted;
        task.submitted = pending.submitted;
        task.referenceCount = pending.referenceCount;
      }
      task.providerInvocations = webManifest?.submitted ? 1 : 0;
      task.webState = webManifest?.state || null;
      task.webTimings = webManifest ? {createdAt: webManifest.createdAt || null, acceptedAt: webManifest.acceptedAt || null, readyAt: webManifest.readyAt || null, submittedAt: webManifest.submittedAt || null, downloadedAt: webManifest.downloadedAt || null, executorModel: webManifest.executorModel || executor.model || null, executorReasoningEffort: webManifest.executorReasoningEffort || executor.reasoningEffort, role: webManifest.role || executor.role, ...ownedTabLifecycle(webManifest)} : null;
      saveProject(project);
      if (!matchingPendingManifest(pending)) { cleanupOwnStaging(project, pending.dir, 'unknown', {submitted: webManifest?.submitted === true, submissionUncertain: webManifest?.submissionUncertain === true, reason: 'resume_identity_mismatch'}); finishTask(project, task, 'unknown_result', {errorCode: 'REQUEST_IDENTITY_MISMATCH'}); throw new Error('续接记录与当前图片请求不匹配，原文件已保留，不能自动采用或重试。'); }
      if (preAcceptanceQuotaEvidence(pending, webManifest, failure, made)) {
        const usageError = String(failure?.message || webManifest?.error || quota.error || '已达到生图执行器额度限制。').slice(0, 1000);
        const message = quotaPauseMessage(pending.key, webManifest.requestId, pending.taskId, pending.projectVersion, usageError);
        Object.assign(task, {status: 'paused', errorCode: 'USAGE_LIMIT_BEFORE_START', providerInvocations: 0, webState: 'queued', completedAt: new Date().toISOString(), error: message});
        pending.quotaPaused = true;
        pending.quotaError = usageError;
        project.lastFailure = null;
        project.status = 'paused';
        project.error = message;
        project.message = message;
        cleanupOwnStaging(project, pending.dir, 'pre_submission_failure', {submitted: false, submissionUncertain: false, reason: 'quota_before_acceptance_resume'});
        saveProject(project);
        const error = new Error(message);
        error.code = 'USAGE_LIMIT_BEFORE_START';
        throw error;
      }
      activity(project, '正在核对网页执行结果并保存原图…');
      const {evidence, candidates} = attributableCandidates(pending);
      let persisted = null;
      if (candidates.length === 1) persisted = await persistImage(candidates[0], pending.file);
      if (!persisted) {
        writeRunResult(pending.dir, {schemaVersion: 2, provider: webImageProvider, taskId: task.id, requestId: webManifest?.requestId || manifest.requestId, endedAt: new Date().toISOString(), outcome: 'artifact_not_located_after_resume', diagnostics: generationDiagnosticSummary(evidence), candidateCount: candidates.length, candidateNames: candidates.map(candidate => path.basename(candidate)), error: failure ? String(failure.message || failure).slice(0, 500) : null});
        const known = definiteImageFailure(pending, [made?.text, failure?.message, webManifest?.errorCode, webManifest?.error].filter(Boolean).join('\n'));
        if (known) {
          if (new Set(['no-output', 'browser-unavailable', 'browser-origin-permission-denied', 'browser-upload-unavailable', 'browser-create-unavailable', 'browser-handle-lost', 'browser-mode-entry-unavailable', 'file-chooser-event-timeout', 'file-chooser-route-unavailable', 'file-set-failed', 'attachment-verification-timeout', 'reference-files-invalid']).has(known.kind) && known.kind !== 'no-output') task.providerInvocations = 0;
          project.pending = null;
          project.lastFailure = {...known, taskId: task.id};
          cleanupOwnStaging(project, pending.dir, 'pre_submission_failure', {submitted: webManifest?.submitted === true, submissionUncertain: webManifest?.submissionUncertain === true, reason: known.kind});
          finishTask(project, task, 'failed_no_output', {errorCode: known.kind, webState: webManifest?.state || null});
          saveProject(project);
          const error = new Error(failureMessage(known));
          error.code = 'IMAGE_NO_OUTPUT';
          throw error;
        }
        cleanupOwnStaging(project, pending.dir, 'unknown', {submitted: webManifest?.submitted === true, submissionUncertain: webManifest?.submissionUncertain === true, reason: 'artifact_not_located_after_resume'});
        finishTask(project, task, 'unknown_result', {errorCode: 'unknown_result', webState: webManifest?.state || null});
        throw failure || new Error('续接后在保存结果前中断。当前请求记录已保留，不会自动再次发送。');
      }
      const file = persisted.file;
      pending.file = file;
      pending.integrity = persisted.integrity;
      cleanupOwnStaging(project, pending.dir, 'success', {submitted: webManifest?.submitted === true, submissionUncertain: false, reason: 'artifact_saved_after_resume'});
      writeRunResult(pending.dir, {schemaVersion: 2, provider: webImageProvider, taskId: task.id, requestId: webManifest.requestId, projectId: project.id, projectVersion: project.version, target: pending.key, endedAt: new Date().toISOString(), outcome: 'artifact_saved_after_same_request_resume', artifact: path.relative(projectDir(project.id), file), integrity: persisted.integrity, downloadEvidence: readDownloadEvidence(pending.dir), diagnostics: generationDiagnosticSummary(evidence)});
      const imageRecord = {key: pending.key, file: path.relative(projectDir(project.id), file), provider: webImageProvider, conversationUrl: webManifest.conversationUrl || null, prompt: pending.prompt, basePrompt: pending.basePrompt || pending.prompt, revisionDelta: pending.revisionDelta || null, revisionBase: pending.revisionBase || null, executor, refs: pending.refs, telemetry: pending.telemetry, integrity: persisted.integrity, downloadEvidence: readDownloadEvidence(pending.dir), qa: {pass: null, status: 'pending', summary: '原图已保存，等待画面校对。', issues: [], repairPrompt: ''}, at: new Date().toISOString()};
      jsonWrite(`${file}.json`, imageRecord);
      const panelKey = panelKeyFromImageKey(pending.key);
      if (panelKey) invalidatePanelDownstream(project, panelKey);
      recordArtifact(project, artifactIdForImageKey(pending.key), 'image', imageRecord.file, [], {integrity: persisted.integrity, downloadEvidence: imageRecord.downloadEvidence});
      attachImageRecord(project, imageRecord);
      project.pending = null;
      project.lastFailure = null;
      finishTask(project, task, 'artifact_saved', {artifact: file, qa: 'pending', webState: 'downloaded'});
      saveProject(project);
      try {
        checkpoint(signal);
        const check = await qa(project, file, pending.prompt, imageRefs(project, pending.refs || []), signal, '原始分镜');
        imageRecord.qa = check;
        jsonWrite(`${file}.json`, imageRecord);
        finishTask(project, task, 'completed', {artifact: file, qa: check.pass ? 'passed' : 'needs_review', webState: 'downloaded'});
        project.status = check.pass ? 'paused' : 'attention';
        project.error = null;
        project.message = check.pass ? `${pending.key} 已按原请求完成、保存并校对；本次只续接这一张。` : `${pending.key} 原图已保存，画面检查建议：${(check.issues || []).join('；') || '请人工查看'}。本次不会自动重画。`;
        if (panelKey && !check.pass) requirePanelDecision(project, panelKey, imageRecord);
        saveProject(project);
        return imageRecord;
      } catch (error) {
        const outcome = savedArtifactQaUnavailable(error, {artifact: file, webState: 'downloaded'});
        applySavedArtifactQaOutcome({project, task, record: imageRecord, artifactFile: file, outcome, saveProject, finishTask, jsonWrite, writeRunResult: result => writeRunResult(pending.dir, result), runResult: {schemaVersion: 2, provider: webImageProvider, taskId: task.id, requestId: webManifest.requestId, endedAt: new Date().toISOString(), outcome: outcome.outcome, artifact: path.relative(projectDir(project.id), file), integrity: persisted.integrity, errorCode: outcome.errorCode, error: outcome.detail}, extraTask: {webState: 'downloaded'}});
        return imageRecord;
      }
      } finally {
        releaseImageFlight(flight, {outcome: 'resume-finished', requestId: manifest.requestId});
      }
    });
  }

  return Object.freeze({preparedCacheFor, prepareWebAttachments, executorLimitFor, protectQuota, writeRunRequest, previousConversation, generate, resumeSameRequestImage});
}

export function preAcceptanceQuotaEvidence({pending, manifest, failure = null, made = null, provider, matchingWebRunRecord, runEvidence} = {}) {
  if (!pending || pending.provider !== provider || !manifest || manifest.state !== 'queued' || manifest.accepted === true || manifest.submitted === true || Number(manifest.referenceCount) !== 0) return null;
  const record = matchingWebRunRecord(pending);
  if (!record || record.manifest?.requestId !== manifest.requestId) return null;
  const execution = record.execution || {};
  if (execution.state !== 'failed' || !USAGE_LIMIT_ERROR.test(String(execution.error || ''))) return null;
  const evidence = runEvidence(record.dir);
  if (evidence.browserText.trim()) return null;
  const error = String(failure?.message || made?.text || execution.error || manifest.error || '已达到生图执行器额度限制。');
  if (!USAGE_LIMIT_ERROR.test([failure?.code, error, manifest.errorCode, manifest.error].filter(Boolean).join('\n'))) return null;
  return {manifest: record.manifest, execution, error};
}

export function confirmedUnsentEvidence({pending, manifest, provider, matchingWebRunRecord, confirmedUnsentWebAudit} = {}) {
  if (!pending || pending.provider !== provider || !manifest) return null;
  const record = matchingWebRunRecord(pending);
  if (!record || record.manifest?.requestId !== manifest.requestId) return null;
  const audit = confirmedUnsentWebAudit({dir: record.dir, expected: {projectId: pending.projectId, projectVersion: pending.projectVersion, taskId: pending.taskId, target: pending.key, requestId: manifest.requestId}});
  return audit ? {record, audit} : null;
}

export function quotaPauseMessage(target, requestId, taskId, projectVersion, error) {
  return `本次${target || '生图'}执行器在接受请求前遇到额度限制，未上传附件或发送消息。已保留同一 requestId、taskId 和方案版本（${requestId || 'requestId'} / ${taskId || 'taskId'} / v${projectVersion}）；额度恢复后点击“继续制作”将续接原任务，不会创建第二个图片请求。原始错误：${String(error || '已达到生图执行器额度限制。').slice(0, 1000)}`;
}
