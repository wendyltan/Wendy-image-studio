import fs from 'node:fs';
import path from 'node:path';
import {
  createRequestStaging,
  materializeVersionAttachment,
  readAttachmentCache,
  updateRequestStagingMarker,
  writeAttachmentCache,
} from './storage-hygiene.mjs';

/**
 * Preparation and quota boundary for a paid image request.
 *
 * The image workflow owns request state and result adoption; this module owns
 * only local attachment reuse, executor quota protection, and durable request
 * metadata written before a browser job starts.
 */
export function createImagePreparation({
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
}) {
  function imageRecordAt(file) {
    try {
      return JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
    } catch {
      return null;
    }
  }

  function preparedCacheFor(project, sourceFiles, prior) {
    let versionCache = [];
    try {
      versionCache = readAttachmentCache({
        projectRoot: projectDir(project.id),
        versionRoot: versionDir(project),
      }).entries;
    } catch {}
    const cache = [
      ...versionCache,
      ...(imageRecordAt(prior)?.telemetry?.preparedAttachments || []),
    ];
    const byHash = new Map(
      cache
        .filter((item) => item?.sourceSha256 && item.file)
        .map((item) => [item.sourceSha256, item]),
    );
    const prepared = [];
    const missing = [];
    const sourceSha256s = [];
    for (const [index, source] of sourceFiles.entries()) {
      const sourceSha256 = checksum(source);
      sourceSha256s[index] = sourceSha256;
      const cached = byHash.get(sourceSha256);
      let cachedFile = null;
      if (cached?.file) {
        try {
          cachedFile = inside(projectDir(project.id), cached.file);
        } catch {
          cachedFile = null;
        }
      }
      if (cachedFile && fs.existsSync(cachedFile)) {
        prepared[index] = {
          source,
          file: cachedFile,
          optimized: cached.optimized === true,
          sizeBytes:
            Number(cached.sizeBytes) || fs.statSync(cachedFile).size,
          reused: true,
        };
      } else {
        missing.push({index, source, sourceSha256});
      }
    }
    return {
      prepared,
      missing,
      sourceSha256s,
      cacheHits: prepared.filter(Boolean).length,
    };
  }

  async function prepareWebAttachments(project, dir, sourceFiles, cachePlan) {
    const prepared = cachePlan?.prepared || [];
    const missing =
      cachePlan?.missing ||
      sourceFiles.map((source, index) => ({
        index,
        source,
        sourceSha256:
          cachePlan?.sourceSha256s?.[index] || checksum(source),
      }));
    const staging = createRequestStaging({
      projectRoot: projectDir(project.id),
      runDir: dir,
      projectId: project.id,
      projectVersion: project.version,
      taskId: project.currentTask?.id || null,
      runId: path.basename(dir),
      sourceFiles,
    });
    if (missing.length) {
      const spec = path.join(dir, '上传素材.json');
      jsonWrite(spec, {
        files: missing.map((item) => item.source),
        outputDir: staging.attachmentsDir,
        reusedCount: cachePlan?.cacheHits || 0,
      });
      try {
        const fresh = JSON.parse(await pythonRun(['prepare-web', spec]));
        for (const [index, item] of missing.entries()) {
          const target = fresh[index];
          if (!target?.file) throw new Error('上传素材准备未完成。');
          prepared[item.index] = {...target, reused: false};
        }
      } catch (error) {
        updateRequestStagingMarker(staging, {state: 'prepare_failed', preparationError: String(error.message || error).slice(0, 500)});
        throw error;
      }
    }
    const existing = readAttachmentCache({
      projectRoot: projectDir(project.id),
      versionRoot: versionDir(project),
    });
    const merged = new Map(existing.entries.map((item) => [item.sourceSha256, item]));
    for (const [index, item] of prepared.entries()) {
      if (!item?.file) continue;
      const sourceSha256 =
        cachePlan?.sourceSha256s?.[index] || checksum(sourceFiles[index]);
      const shared = materializeVersionAttachment({
        projectRoot: projectDir(project.id),
        versionRoot: versionDir(project),
        sourceFile: item.file,
        sourceSha256,
        optimized: item.optimized === true,
        sizeBytes: Number(item.sizeBytes) || fs.statSync(item.file).size,
      });
      prepared[index] = {
        ...item,
        file: shared.file,
        sizeBytes: shared.sizeBytes,
        sourceSha256,
        reused: item.reused === true || shared.reused,
      };
      merged.set(sourceSha256, {
        sourceSha256,
        fileSha256: shared.fileSha256,
        file: shared.relativePath,
        optimized: item.optimized === true,
        sizeBytes: shared.sizeBytes,
        updatedAt: new Date().toISOString(),
      });
    }
    writeAttachmentCache({
      projectRoot: projectDir(project.id),
      versionRoot: versionDir(project),
      entries: [...merged.values()].slice(-500),
      migratedFrom: existing.schemaVersion,
    });
    updateRequestStagingMarker(staging, {
      state: 'prepared',
      preparedFiles: prepared.filter(Boolean).map((item) => path.relative(projectDir(project.id), item.file).split(path.sep).join('/')),
      preparedAt: new Date().toISOString(),
    });
    // Optimized upload copies have already been promoted into the shared
    // version cache. Remove only this request's own disposable preparation
    // directory; request metadata and browser evidence stay in the run dir.
    try { fs.rmSync(staging.attachmentsDir, {recursive: true, force: true}); } catch {}
    return prepared;
  }

  function executorLimitFor(limits, executorModel) {
    if (
      !executorModel ||
      !limits?.byLimitId ||
      typeof limits.byLimitId !== 'object'
    )
      return null;
    const matches = Object.entries(limits.byLimitId).filter(
      ([id, bucket]) =>
        id !== 'codex' && bucket?.normalModelSlug === executorModel,
    );
    return matches.length === 1
      ? {limitId: matches[0][0], ...matches[0][1]}
      : null;
  }

  async function protectQuota(project, {executorModel = null} = {}) {
    const limits = await rateLimitSnapshot(12000, {force: true});
    const remaining = Number(limits?.primary?.remainingPercent);
    const observedAt = Number(limits?.observedAt);
    const checkedAt = new Date().toISOString();
    const status =
      typeof limits?.status === 'string' && limits.status
        ? limits.status
        : 'unavailable';
    const ageMs = Date.now() - observedAt;
    const fresh =
      status === 'fresh' &&
      Number.isFinite(observedAt) &&
      observedAt > 0 &&
      ageMs >= 0 &&
      ageMs <= 60_000 &&
      Number.isFinite(remaining);
    const modelLimit = executorLimitFor(limits, executorModel);
    const executorRemaining = Number(modelLimit?.primary?.remainingPercent);
    const executorStatus = modelLimit ? 'fresh' : 'unavailable';
    project.lastQuotaCheck = {
      remaining: Number.isFinite(remaining) ? remaining : null,
      resetsAt: limits?.primary?.resetsAt || null,
      checkedAt,
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
      status,
      ageMs: Number.isFinite(observedAt) ? ageMs : null,
      executorModel: executorModel || null,
      executorLimitId: modelLimit?.limitId || null,
      executorRemaining: Number.isFinite(executorRemaining)
        ? executorRemaining
        : null,
      executorResetsAt: modelLimit?.primary?.resetsAt || null,
      executorStatus,
    };
    saveProject(project);
    if (!fresh) {
      const error = new Error(
        `无法确认最新的 5 小时创作额度（${
          status === 'stale'
            ? '本次读取只有旧快照'
            : status === 'unavailable'
              ? '本次读取失败或不可用'
              : '额度快照的新鲜度或数值无效'
        }），已暂停新的生图。请刷新额度后再点击“继续制作”；本次不会准备、上传或发送附件。`,
      );
      error.code = 'QUOTA_REFRESH_REQUIRED';
      throw error;
    }
    if (remaining <= 10) {
      const when = limits.primary?.resetsAt
        ? new Date(limits.primary.resetsAt * 1000).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '下一次额度重置后';
      const error = new Error(
        `5小时创作额度只剩 ${Math.floor(remaining)}%。当前工作节点已经保存，并已暂停新的生图。建议在 ${when} 之后点击“继续制作”。`,
      );
      error.code = 'LOW_QUOTA';
      throw error;
    }
  }

  function writeRunRequest(dir, project, task, pending) {
    const summarize = (file) => {
      try {
        return {
          name: path.basename(file),
          sizeBytes: fs.statSync(file).size,
          sha256: checksum(file),
        };
      } catch {
        return {name: path.basename(file), missing: true};
      }
    };
    jsonWrite(path.join(dir, 'request.json'), {
      schemaVersion: 2,
      provider: pending.provider || 'legacy',
      taskId: task.id,
      attempt: task.attempt,
      target: pending.key,
      createdAt: pending.at,
      projectId: project.id,
      projectVersion: project.version,
      expectedOutput: path.relative(projectDir(project.id), pending.file),
      model: pending.executorModel || project.brief.model || null,
      reasoningEffort: pending.executorReasoningEffort || webImageExecutorEffort,
      role: webImageExecutorRole,
      creativeModel: project.brief.model || null,
      creativeReasoningEffort: project.brief.reasoningEffort || null,
      executorModel: pending.executorModel || project.brief.model || null,
      executorReasoningEffort:
        pending.executorReasoningEffort || webImageExecutorEffort,
      promptSha256: pending.telemetry.promptSha256,
      promptCharacters: pending.telemetry.promptCharacters,
      revisionPromptVersion: pending.telemetry.revisionPromptVersion || null,
      revisionPromptSha256: pending.telemetry.revisionPromptSha256 || null,
      revisionPromptCharacters:
        pending.telemetry.revisionPromptCharacters || null,
      revisionPromptSource: pending.telemetry.revisionPromptSource || null,
      revisionPromptSourceSegments:
        pending.telemetry.revisionPromptSourceSegments || null,
      basePromptSha256: pending.telemetry.basePromptSha256 || null,
      revisionDeltaSha256: pending.telemetry.revisionDeltaSha256 || null,
      revisionDeltaCharacters: pending.telemetry.revisionDeltaCharacters || 0,
      referenceNames: pending.refs,
      referenceFiles: pending.inputFiles.map(summarize),
      editTarget: pending.prior ? summarize(pending.prior) : null,
      source: task.source,
      revisionBase: pending.revisionBase || null,
      preparation: pending.telemetry.preparation || null,
    });
  }

  function previousConversation(prior) {
    if (!prior) return null;
    try {
      const record = JSON.parse(fs.readFileSync(`${prior}.json`, 'utf8'));
      return /^https:\/\/chatgpt\.com\/c\/[^\s?#]+/.test(
        String(record.conversationUrl || ''),
      )
        ? String(record.conversationUrl)
        : null;
    } catch {
      return null;
    }
  }

  return Object.freeze({
    preparedCacheFor,
    prepareWebAttachments,
    executorLimitFor,
    protectQuota,
    writeRunRequest,
    previousConversation,
  });
}
