import {
  AlertCircle,
  CircleCheck,
  Clock,
  LoaderCircle,
  Pause,
  RotateCcw,
} from 'lucide-react';
import { effortLabels } from './constants';
import type { ProgressStage, Project, Task } from './types';
import {
  elapsed,
  stageElapsedMs,
  terminalTime,
  timestampMs,
  workflowClockActive,
} from './workflow-utils';

export function ModelUsagePanel({ project }: { project: Project }) {
  const metrics = project.metrics!;
  const rows = metrics.byModel || [];
  return (
    <section className="metrics-panel" aria-label="本篇模型与 token 用量">
      <header>
        <b>本篇模型用量</b>
        <span>
          {metrics.totalRuns || 0} 次调用 · 输入{' '}
          {(metrics.inputTokens || 0).toLocaleString()} · 输出{' '}
          {(metrics.outputTokens || 0).toLocaleString()} tokens
        </span>
      </header>
      <details className="model-usage-details">
        <summary>查看模型明细</summary>
        <div className="model-usage-rows">
          {rows.map((row) => (
            <div key={`${row.model}:${row.reasoningEffort}`}>
              <span>
                <b>{row.model}</b>
                <small>
                  {effortLabels[row.reasoningEffort] || row.reasoningEffort}思考
                </small>
              </span>
              <strong>{row.runs} 次</strong>
              <span>
                输入 {row.inputTokens.toLocaleString()}
                {!!row.cachedInputTokens && (
                  <small>其中缓存 {row.cachedInputTokens.toLocaleString()}</small>
                )}
              </span>
              <span>
                输出 {row.outputTokens.toLocaleString()}
                {!!row.reasoningOutputTokens && (
                  <small>
                    其中思考 {row.reasoningOutputTokens.toLocaleString()}
                  </small>
                )}
              </span>
            </div>
          ))}
          {!!metrics.unattributedRuns && (
            <p>另有 {metrics.unattributedRuns} 次旧记录缺少可核对的模型明细。</p>
          )}
        </div>
      </details>
    </section>
  );
}

export function WorkflowStatus({
  project,
  progress,
  task,
  percent,
  disabled,
  action,
  noOutput,
  panelDecisionPrimary,
  recoveryPending,
  now,
}: {
  project: Project;
  progress: Project['progress'];
  task: Task | null | undefined;
  percent: number;
  disabled: boolean;
  action: (name: string, body?: unknown) => void;
  noOutput: boolean;
  panelDecisionPrimary: boolean;
  recoveryPending: boolean;
  now: number;
}) {
  const taskLabels: Record<string, string> = {
    unknown_result: '结果尚未确认',
    failed_no_output: '本次没有取得图片',
    running: '进行中',
    artifact_saved: '原图已保存',
    artifact_saved_unchecked: '原图已保存，自动校对未完成',
    review_required: '原图已保存，等待人工查看',
    completed: '已完成',
    recovered_local: '已找回原图',
    review_failed: '检查未完成',
    paused: '已暂停',
    not_accepted: '后台尚未接单',
    failed: '需要查看',
  };
  const taskState = task?.status ? taskLabels[task.status] || '需要查看' : '';
  const taskText = task?.target
    ? `当前：${task.target}${taskState ? `（${taskState}）` : ''}`
    : '';
  const webStateLabels: Record<string, string> = {
    queued: '等待后台接单',
    accepted: '后台已接单，开始处理',
    ready: '已准备提交',
    submitted: '已提交生成，等待原图',
    downloaded: '原图已保存',
    failed: '网页生图阶段失败',
  };
  const webText = project.pending?.webState
    ? webStateLabels[project.pending.webState] || '网页后台处理中'
    : '';
  const webFailureMessages: Record<string, string> = {
    IAB_UNAVAILABLE:
      '这是旧请求记录中的 Codex 内嵌浏览器 IAB 失败；没有上传附件或发送消息。当前生产链路使用专用 Chrome 标签页，当前请求已失败，记录仍保留。',
    IAB_SESSION_LOST_BEFORE_SUBMIT:
      '这是旧请求记录中的 Codex 内嵌浏览器 IAB 断开；没有上传附件或发送消息。当前生产链路使用专用 Chrome 标签页，当前请求已失败，记录仍保留。',
    FILE_UPLOAD_IAB_UNAVAILABLE:
      '这是旧请求记录中的 IAB 附件上传失败；没有发送消息。当前生产链路使用专用 Chrome 标签页，当前请求已失败，记录仍保留。',
    BROWSER_FOCUS_UNAVAILABLE:
      '后台已接单，但公开 CUA 没有 Chrome 窗口或标签页焦点恢复能力，无法零焦点切换；为保护温蒂创作室页面，没有创建标签页、上传附件或发送消息。当前请求已失败，记录仍保留。',
    BROWSER_FOCUS_RESTORE_FAILED:
      '后台已接单，但专用 Chrome 标签页创建后无法验证已恢复温蒂创作室焦点；没有上传附件或发送消息。当前请求已失败，记录仍保留。',
    BROWSER_FOCUS_RESTORE_FAILED_AFTER_CLOSE:
      '网页生图已停止，但关闭专用 Chrome 标签页后无法验证温蒂创作室焦点；请求记录仍保留，不会自动重试。',
    BROWSER_TAB_BACKGROUND_UNAVAILABLE:
      '后台已接单，但专用 Chrome 标签页在恢复创作室焦点后无法继续读取；没有上传附件或发送消息。当前请求已失败，记录仍保留。',
    BROWSER_CHROME_UNAVAILABLE:
      '后台已接单，但 Chrome Computer Use 扩展不可用；没有上传附件或发送消息。当前请求已失败，记录仍保留。',
    FILE_UPLOAD_CHROME_UNAVAILABLE:
      '专用 Chrome 标签页的附件入口未能打开浏览器文件选择器；本次未上传附件或发送消息，上一版原图仍保留。修复附件入口后只重试这一张。',
    BROWSER_ORIGIN_PERMISSION_DENIED:
      'Chrome 已连接，但 chatgpt.com 访问权限被拒绝；下次重试出现浏览器访问询问时请选择“允许”。本次没有上传附件或发送消息，当前请求已失败，记录仍保留。',
    BROWSER_BACKGROUND_UNAVAILABLE:
      '这是旧请求记录中的后台浏览器能力失败；没有上传附件或发送消息。当前生产链路不会使用隐藏 IAB，请确认 Chrome 焦点管理能力后再重试。',
  };
  const webFailureCode = String(project.pending?.errorCode || '');
  const webFailureText =
    project.pending?.webState === 'failed'
      ? webFailureMessages[webFailureCode] ||
        (project.pending.accepted
          ? '后台已接单，但当前网页生图请求已失败；请求记录和原图找回入口仍保留。'
          : '网页生图请求已失败；请求记录和原图找回入口仍保留。')
      : '';
  const savedArtifactQaUnavailable =
    task?.status === 'artifact_saved_unchecked' ||
    task?.status === 'review_required' ||
    task?.errorCode === 'QA_UNAVAILABLE';
  const statusMessage =
    webFailureText ||
    (savedArtifactQaUnavailable
      ? '原图已保存，自动校对未完成，请人工查看；不会自动重生'
      : task?.status === 'not_accepted'
        ? '后台尚未确认接单，已停止本机等待；请求已保留，不会自动重试。'
        : webText || project.message);
  const uploadUnavailable =
    project.lastFailure?.kind === 'browser-upload-unavailable' ||
    task?.errorCode === 'browser-upload-unavailable' ||
    project.pending?.errorCode === 'FILE_UPLOAD_CHROME_UNAVAILABLE';
  const layoutPage = project.pages.find(
    (page) =>
      !page.qa.pass &&
      ['重新排版', '重新排字'].includes(page.nextStep || ''),
  );
  const canResume =
    !project.pending &&
    !recoveryPending &&
    !layoutPage &&
    ['attention', 'paused', 'draft'].includes(project.status);
  const clockActive = workflowClockActive(project);
  const terminalAt = clockActive
    ? null
    : terminalTime(task, progress, project.lastFailure?.at);
  const terminalAtMs = timestampMs(terminalAt);
  const stageFallbackEnd = clockActive ? now : terminalAtMs;
  const taskFailed =
    [
      'failed',
      'failed_no_output',
      'unknown_result',
      'paused',
      'review_failed',
      'not_accepted',
    ].includes(task?.status || '') || project.pending?.webState === 'failed';
  const liveTone =
    project.error || recoveryPending || taskFailed
      ? 'error'
      : project.pending?.webState === 'submitted'
        ? 'creating'
        : project.pending?.webState === 'ready'
          ? 'composing'
          : progress?.activeStage?.tone || (project.busy ? 'working' : 'complete');
  const browserClock = project.pending
    ? {
        createdAt: project.pending.at,
        acceptedAt: project.pending.acceptedAt,
        readyAt: project.pending.readyAt,
        submittedAt: project.pending.submittedAt,
        downloadedAt: project.pending.downloadedAt,
      }
    : task?.webTimings
      ? {
          createdAt: task.webTimings.createdAt || task.startedAt,
          acceptedAt: task.webTimings.acceptedAt,
          readyAt: task.webTimings.readyAt,
          submittedAt: task.webTimings.submittedAt,
          downloadedAt: task.webTimings.downloadedAt,
        }
      : null;
  const browserStages: ProgressStage[] = [];
  const addBrowserStage = (
    id: string,
    label: string,
    tone: string,
    startedAt?: string | null,
    completedAt?: string | null,
  ) => {
    if (!startedAt) {
      browserStages.push({ id, label, tone, state: 'not_reached' });
      return;
    }
    const stageEnd = completedAt || (!clockActive ? terminalAt : null);
    const measured = stageElapsedMs(startedAt, stageEnd);
    const failed = !completedAt && !clockActive && taskFailed;
    browserStages.push({
      id,
      label,
      tone: failed ? 'error' : tone,
      state: completedAt
        ? 'completed'
        : failed
          ? 'failed'
          : clockActive
            ? 'running'
            : 'completed',
      startedAt,
      ...(stageEnd
        ? {
            completedAt: stageEnd,
            ...(measured === null ? {} : { durationMs: measured }),
          }
        : {}),
    });
  };
  if (browserClock) {
    addBrowserStage(
      'browser-accepted',
      '打开页面并接单',
      'waiting',
      browserClock.createdAt,
      browserClock.acceptedAt,
    );
    addBrowserStage(
      'browser-ready',
      '上传并核对附件',
      'working',
      browserClock.acceptedAt,
      browserClock.readyAt ||
        (!browserClock.readyAt ? browserClock.submittedAt : null),
    );
    addBrowserStage(
      'browser-submitted',
      '发送生图请求',
      'creating',
      browserClock.readyAt,
      browserClock.submittedAt,
    );
    addBrowserStage(
      'browser-downloaded',
      '等待生成并下载原图',
      'creating',
      browserClock.submittedAt,
      browserClock.downloadedAt,
    );
  }
  const timingStages = [
    ...(progress?.stages || []).slice(browserStages.length ? -3 : -4),
    ...browserStages.slice(-4),
    ...(progress?.activeStage ? [progress.activeStage] : []),
  ];
  const stageDurations = timingStages
    .map((stage) =>
      stage.durationMs !== undefined && Number.isFinite(stage.durationMs)
        ? Math.max(0, stage.durationMs)
        : stageElapsedMs(stage.startedAt, stage.completedAt, stageFallbackEnd),
    )
    .filter((duration): duration is number => duration !== null);
  const maxDuration = Math.max(1, ...stageDurations);
  return (
    <>
      <div className={`status-banner tone-${liveTone}`}>
        <div>
          {project.busy ? (
            <LoaderCircle className="spin" />
          ) : project.error || recoveryPending || taskFailed ? (
            <AlertCircle />
          ) : (
            <CircleCheck />
          )}
          <span>
            {noOutput
              ? panelDecisionPrimary
                ? '本次修改未取得新图，上一版原图仍保留。'
                : uploadUnavailable
                  ? '附件上传没有完成，未上传附件、未发送消息；上一版原图仍保留。'
                  : '本次没有取得图片，可重试这一张。'
              : statusMessage}
            <small>
              <Clock /> 已用时{' '}
              {elapsed(
                progress?.startedAt,
                progress?.completedAt || terminalAt,
                stageFallbackEnd,
              )}{' '}
              · {progress?.current || 0}/{progress?.total || 1}{' '}
              {progress?.unit || '步骤'} · {project.brief.model} /{' '}
              {effortLabels[project.brief.reasoningEffort] ||
                project.brief.reasoningEffort}
              思考{taskText && ` · ${taskText}`}
            </small>
          </span>
        </div>
        {project.busy ? (
          <button className="text-button" onClick={() => action('pause')}>
            <Pause />
            暂停
          </button>
        ) : layoutPage ? (
          <button
            className="primary"
            disabled={disabled}
            onClick={() =>
              action('repair-page-layout', { pageNumber: layoutPage.number })
            }
          >
            <RotateCcw />
            修复第 {layoutPage.number} 页排版
          </button>
        ) : (
          canResume && (
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => action('resume')}
            >
              继续制作
            </button>
          )
        )}
        <div className="progress-line">
          <i style={{ width: `${percent}%` }} />
        </div>
      </div>
      {!!timingStages.length && (
        <div className="stage-timings" aria-label="步骤耗时">
          {timingStages.map((stage) => {
            const duration =
              stage.durationMs !== undefined && Number.isFinite(stage.durationMs)
                ? Math.max(0, stage.durationMs)
                : stageElapsedMs(
                    stage.startedAt,
                    stage.completedAt,
                    stageFallbackEnd,
                  );
            return (
              <div key={stage.id} className={`tone-${stage.tone}`}>
                <span title={stage.label}>{stage.label}</span>
                <i>
                  <em
                    style={{
                      width: `${duration === null ? 8 : Math.max(8, Math.round((duration / maxDuration) * 100))}%`,
                    }}
                  />
                </i>
                <b>
                  {stage.state === 'not_reached'
                    ? '未到达'
                    : elapsed(
                        stage.startedAt,
                        stage.completedAt,
                        stageFallbackEnd,
                      )}
                </b>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
