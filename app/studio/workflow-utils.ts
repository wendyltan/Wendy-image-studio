import type { Pending, Project, Task } from './types';

export function timestampMs(value?: string | null) {
  if (!value) return null;
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  const repaired = value.replace(/(\.\d{1,3})N(?=Z$)/, '$1');
  const parsed = Date.parse(repaired);
  return Number.isFinite(parsed) ? parsed : null;
}

export function stageElapsedMs(
  start?: string | null,
  end?: string | null,
  fallbackEnd?: number | null,
) {
  const from = timestampMs(start);
  const to = end ? timestampMs(end) : (fallbackEnd ?? null);
  if (from === null || to === null || to < from) return null;
  return to - from;
}

export function elapsed(
  start?: string | null,
  end?: string | null,
  fallbackEnd?: number | null,
) {
  if (!start) return '尚未开始';
  const measured = stageElapsedMs(start, end, fallbackEnd);
  if (measured === null) return '时间待校准';
  const n = Math.floor(measured / 1000);
  return n < 60 ? `${n} 秒` : `${Math.floor(n / 60)} 分 ${n % 60} 秒`;
}

export function pendingKeepsClockRunning(pending?: Pending | null) {
  return Boolean(
    pending && !['failed', 'downloaded'].includes(pending.webState || ''),
  );
}

export function workflowClockActive(project: Project | null) {
  const taskRunning = project?.currentTask?.status === 'running';
  return Boolean(
    project &&
      (project.busy ||
        (pendingKeepsClockRunning(project.pending) &&
          (!project.currentTask || taskRunning)) ||
        taskRunning ||
        project.progress?.activeStage?.state === 'running'),
  );
}

export function terminalTime(
  task?: Task | null,
  progress?: Project['progress'],
  failureAt?: string | null,
) {
  const candidates = [
    task?.completedAt,
    progress?.completedAt,
    task?.lastProgressAt,
    failureAt,
  ];
  return (
    candidates.find(
      (candidate): candidate is string => timestampMs(candidate) !== null,
    ) || null
  );
}

export function resetText(timestamp?: number) {
  return timestamp
    ? new Date(timestamp * 1000).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '更新时间暂不可用';
}

export function observedAccountText(timestamp?: string | null) {
  return timestamp
    ? new Date(timestamp).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '时间未知';
}
