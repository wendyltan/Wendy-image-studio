import {IMAGE_OUTCOME, SAVED_ARTIFACT_QA_MESSAGE, SavedArtifactQaUnavailableError} from './image-lifecycle.mjs';

/**
 * Serialize project work without hiding the queue boundary in image or page
 * orchestration.  The runner is deliberately dependency-injected so tests can
 * supply the real durable JobStore while the engine retains its public `job`
 * helper for compatibility.
 */
export function createJobRunner({
  active,
  runningProjects,
  jobStore,
  queueOwner,
  saveProject,
  finishTask,
  finishProgressStage,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  if (!active || !runningProjects || !jobStore || typeof saveProject !== 'function' || typeof finishTask !== 'function' || typeof finishProgressStage !== 'function') {
    throw new TypeError('job runner requires project state, queue store, persistence, and progress callbacks');
  }
  let queueTail = Promise.resolve();

  function job(project, phase, fn) {
    if (active.has(project.id)) throw new Error('这篇正在制作，请等待或先暂停。');
    const controller = new AbortController();
    const queued = jobStore.enqueue({projectId: project.id, phase, submitter: queueOwner});
    active.set(project.id, controller);
    runningProjects.set(project.id, project);
    project.queueJob = {id: queued.id, status: 'queued', phase, queuedAt: queued.queuedAt};
    project.error = null;
    project.message = '正在等待前一项本地创作任务完成…';
    project.progress = {...project.progress, phase: 'queued', startedAt: queued.queuedAt, completedAt: null};
    saveProject(project);

    const run = async () => {
      let claimed = null;
      let beat = null;
      try {
        while (!controller.signal.aborted && !claimed) {
          if (jobStore.read(queued.id)?.status !== 'queued') break;
          claimed = jobStore.claim(queued.id, queueOwner);
          if (!claimed) {
            jobStore.reclaimOrphanedLock();
            await wait(200);
          }
        }
        if (!claimed) {
          jobStore.cancel(queued.id, 'paused', {reason: 'cancelled_before_start'});
          project.status = 'paused';
          project.message = '已暂停，尚未开始这一步。';
          project.progress = {...project.progress, completedAt: new Date().toISOString()};
          return;
        }
        project.queueJob = {id: queued.id, status: 'running', phase, queuedAt: queued.queuedAt, startedAt: claimed.startedAt};
        project.status = phase;
        project.progress = {...project.progress, phase, startedAt: claimed.startedAt, completedAt: null};
        saveProject(project);
        beat = setInterval(() => jobStore.heartbeat(queued.id, queueOwner), 5000);
        try {
          await fn(controller.signal);
          finishProgressStage(project, 'completed');
          jobStore.finish(queued.id, queueOwner, 'completed');
        } catch (error) {
          const savedArtifactQA = error instanceof SavedArtifactQaUnavailableError || error?.outcome === IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED || error?.outcome === IMAGE_OUTCOME.REVIEW_REQUIRED;
          if (savedArtifactQA) {
            project.status = 'attention';
            project.error = SAVED_ARTIFACT_QA_MESSAGE;
            project.message = SAVED_ARTIFACT_QA_MESSAGE;
            project.progress = {...project.progress, completedAt: new Date().toISOString()};
            finishProgressStage(project, 'completed');
            saveProject(project);
            jobStore.finish(queued.id, queueOwner, 'completed', {outcome: error?.outcome || IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED});
          } else {
            const quotaPause = error.code === 'LOW_QUOTA' || error.code === 'QUOTA_REFRESH_REQUIRED' || error.code === 'USAGE_LIMIT_BEFORE_START';
            project.status = controller.signal.aborted || quotaPause ? 'paused' : 'attention';
            project.error = String(error.message || error).slice(0, 2000);
            project.message = project.error;
            project.progress = {...project.progress, completedAt: new Date().toISOString()};
            finishProgressStage(project, project.status === 'paused' ? 'paused' : 'failed');
            if (project.currentTask?.status === 'running') finishTask(project, project.currentTask, project.status === 'paused' ? 'paused' : 'failed', {error: project.error});
            saveProject(project);
            jobStore.finish(queued.id, queueOwner, controller.signal.aborted || quotaPause ? 'paused' : 'failed', {error: project.error});
          }
        }
      } finally {
        if (beat) clearInterval(beat);
        project.queueJob = null;
        try { saveProject(project); } finally {
          active.delete(project.id);
          runningProjects.delete(project.id);
        }
      }
    };
    queueTail = queueTail.catch(() => {}).then(run);
    return project;
  }

  return Object.freeze({job});
}
