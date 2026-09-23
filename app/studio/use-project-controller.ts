import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { studioApi, type CreateProjectInput } from './api';
import type { Bootstrap, FailureClassification, Project, Story } from './types';

export type StudioStatus = {
  setWaiting: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setToast: Dispatch<SetStateAction<string>>;
};

type ProjectControllerOptions = {
  status: StudioStatus;
  brief: CreateProjectInput;
  model: string;
  effort: string;
  setModel: Dispatch<SetStateAction<string>>;
  setEffort: Dispatch<SetStateAction<string>>;
  setSection: Dispatch<SetStateAction<'create' | 'library' | 'setting'>>;
  setView: Dispatch<SetStateAction<string>>;
  setHistory: Dispatch<SetStateAction<number | null>>;
  setChecks: Dispatch<SetStateAction<string[]>>;
  setEdit: Dispatch<SetStateAction<{ key: string; title: string } | null>>;
  setEditNote: Dispatch<SetStateAction<string>>;
  setModelOpen: Dispatch<SetStateAction<boolean>>;
  setTitleOpen: Dispatch<SetStateAction<boolean>>;
  setDeleteTarget: Dispatch<
    SetStateAction<{
      kind: 'project' | 'archive';
      id: string;
      title: string;
    } | null>
  >;
  setStory: Dispatch<SetStateAction<Story | null>>;
  titleDraft: string;
  deleteTarget: {
    kind: 'project' | 'archive';
    id: string;
    title: string;
  } | null;
  confirmTitle: string;
};

export function useProjectController({
  status,
  brief,
  model,
  effort,
  setModel,
  setEffort,
  setSection,
  setView,
  setHistory,
  setChecks,
  setEdit,
  setEditNote,
  setModelOpen,
  setTitleOpen,
  setDeleteTarget,
  setStory,
  titleDraft,
  deleteTarget,
  confirmTitle,
}: ProjectControllerOptions) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [failureClassification, setFailureClassification] =
    useState<FailureClassification | null>(null);
  const [restarting, setRestarting] = useState(false);
  const modelInitialized = useRef(false);
  const lastMessage = useRef('');
  const actionInFlight = useRef(false);
  const quotaStageSeen = useRef(0);
  const quotaRefreshInFlight = useRef(false);
  const quotaRefreshPending = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await studioApi.bootstrap();
      setData(next);
      if (!modelInitialized.current) {
        const defaultModel =
          next.account.models.find((item) => item.isDefault) ||
          next.account.models[0];
        if (defaultModel) {
          modelInitialized.current = true;
          setModel(defaultModel.id);
          setEffort(defaultModel.defaultReasoningEffort);
        }
      }
      status.setError('');
    } catch (error) {
      status.setError((error as Error).message);
    }
  }, [setEffort, setModel, status]);

  const refreshAccount = useCallback(async () => {
    if (quotaRefreshInFlight.current) {
      quotaRefreshPending.current = true;
      return;
    }
    quotaRefreshInFlight.current = true;
    try {
      do {
        quotaRefreshPending.current = false;
        const account = await studioApi.account();
        setData((value) => (value ? { ...value, account } : value));
      } while (quotaRefreshPending.current);
    } finally {
      quotaRefreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!current) return;
    let gone = false;
    const requestController = new AbortController();
    let timer: number | undefined;
    let delay = 2200;
    let inFlight = false;

    async function poll() {
      if (inFlight || gone) return;
      inFlight = true;
      try {
        const next = await studioApi.project(current as string, requestController.signal);
        if (!gone) {
          setProject((previous) =>
            !previous || (next.revision ?? 0) >= (previous.revision ?? 0)
              ? next
              : previous,
          );
          setData((value) =>
            value
              ? {
                  ...value,
                  projects: [
                    next,
                    ...value.projects.filter((item) => item.id !== next.id),
                  ],
                }
              : value,
          );
          if (
            lastMessage.current &&
            lastMessage.current !== next.message &&
            !next.busy
          ) {
            status.setToast(next.message);
            if (
              'Notification' in window &&
              Notification.permission === 'granted'
            )
              new Notification('温蒂创作室', { body: next.message });
          }
          lastMessage.current = next.message;
          delay = 2200;
        }
      } catch (error) {
        if (!gone) {
          status.setError((error as Error).message);
          delay = Math.min(15000, Math.max(2200, delay * 2));
        }
      } finally {
        inFlight = false;
        if (!gone) timer = window.setTimeout(poll, delay);
      }
    }

    void poll();
    return () => {
      gone = true;
      requestController.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [current, status]);

  const failureClassificationKey = project?.pending?.webState === 'failed'
    ? [
        project.id,
        project.pending.requestId || project.pending.taskId || '',
        project.pending.errorCode || '',
      ].join(':')
    : '';

  useEffect(() => {
    if (!current || !failureClassificationKey) {
      return;
    }
    let gone = false;
    const controller = new AbortController();
    void studioApi
      .failureClassification(current, controller.signal)
      .then((result) => {
        if (!gone) setFailureClassification(result);
      })
      .catch(() => {
        // Classification is optional UI metadata. A failure here must never
        // replace or delay the persisted workflow error.
      });
    return () => {
      gone = true;
      controller.abort();
    };
  }, [current, failureClassificationKey]);

  useEffect(() => {
    if (!project) return;
    const serial =
      (project.progress?.stageSerial || 0) +
      (project.metrics?.refreshSerial || 0);
    if (serial <= quotaStageSeen.current) return;
    quotaStageSeen.current = serial;
    void refreshAccount().catch((error) =>
      status.setError((error as Error).message),
    );
  }, [project, refreshAccount, status]);

  const updateData = useCallback(
    (updater: (value: Bootstrap | null) => Bootstrap | null) =>
      setData(updater),
    [],
  );

  const select = useCallback(
    (next: Project) => {
      quotaStageSeen.current =
        (next.progress?.stageSerial || 0) + (next.metrics?.refreshSerial || 0);
      setCurrent(next.id);
      setProject(next);
      setSection('create');
      setView(
        next.pages.length
          ? 'pictures'
          : next.samples.length
            ? 'samples'
            : 'plan',
      );
      setHistory(null);
      setChecks([]);
      status.setError('');
    },
    [setChecks, setHistory, setSection, setView, status],
  );

  const create = useCallback(async () => {
    status.setWaiting(true);
    try {
      select(await studioApi.createProject(brief));
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [brief, select, status]);

  const restartStudio = useCallback(async () => {
    if (restarting) return;
    if (
      !window.confirm(
        '确定重启创作室后台吗？不会自动继续制作或重新生图；正在运行的任务必须先暂停。',
      )
    )
      return;
    setRestarting(true);
    status.setError('');
    try {
      const accepted = await studioApi.restart();
      status.setToast('正在安全重启创作室…');
      await new Promise((resolve) =>
        window.setTimeout(resolve, accepted.retryAfterMs || 700),
      );
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const health = await studioApi.health();
          if (
            health.ready &&
            health.instanceId !== accepted.previousInstanceId
          ) {
            window.location.reload();
            return;
          }
        } catch {}
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      throw new Error('后台重启等待超时，请再点一次桌面快捷方式。');
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      setRestarting(false);
    }
  }, [restarting, status]);

  const action = useCallback(
    async (name: string, body: unknown = {}) => {
      if (!project || actionInFlight.current) return;
      actionInFlight.current = true;
      status.setWaiting(true);
      try {
        const next = await studioApi.projectAction(project.id, name, body);
        if (next.id) setProject(next);
        if (name === 'approve-plan' || name === 'preview-decision')
          setView('samples');
        if (name === 'approve-samples') setView('pictures');
        if (
          [
            'retry-missing',
            'recover-image',
            'review-image',
            'review-page',
            'resume',
            'repair-page-layout',
            'unify-page-layouts',
          ].includes(name)
        )
          setView(next.samplesApproved ? 'pictures' : 'samples');
        if (name === 'revise-image') {
          setEdit(null);
          setEditNote('');
        }
      } catch (error) {
        status.setError((error as Error).message);
      } finally {
        actionInFlight.current = false;
        status.setWaiting(false);
      }
    },
    [project, setEdit, setEditNote, setView, status],
  );

  const switchProjectModel = useCallback(async () => {
    if (!project) return;
    status.setWaiting(true);
    try {
      const next = await studioApi.projectSettings(project.id, model, effort);
      setProject(next);
      setModelOpen(false);
      status.setToast('模型已切换，只影响后续步骤。');
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [effort, model, project, setModelOpen, status]);

  const renameProject = useCallback(async () => {
    if (!project) return;
    status.setWaiting(true);
    try {
      const next = await studioApi.projectTitle(project.id, titleDraft);
      setProject(next);
      setData((value) =>
        value
          ? {
              ...value,
              projects: [
                next,
                ...value.projects.filter((item) => item.id !== next.id),
              ],
            }
          : value,
      );
      setTitleOpen(false);
      status.setToast('作品名称已更新。');
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [project, setTitleOpen, status, titleDraft]);

  const remove = useCallback(async () => {
    if (!deleteTarget) return;
    status.setWaiting(true);
    try {
      if (deleteTarget.kind === 'project')
        await studioApi.deleteProject(deleteTarget.id, confirmTitle);
      else await studioApi.deleteArchive(deleteTarget.id, confirmTitle);
      if (deleteTarget.id === current) {
        setCurrent(null);
        setProject(null);
      }
      setDeleteTarget(null);
      setStory(null);
      status.setToast('作品已移入本地废纸篓。');
      await refresh();
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [
    confirmTitle,
    current,
    deleteTarget,
    refresh,
    setDeleteTarget,
    setStory,
    status,
  ]);

  const newStory = useCallback(() => {
    setCurrent(null);
    setProject(null);
    setSection('create');
  }, [setSection]);

  return {
    data,
    project,
    failureClassification: failureClassificationKey ? failureClassification : null,
    current,
    restarting,
    refresh,
    refreshAccount,
    updateData,
    select,
    create,
    restartStudio,
    action,
    switchProjectModel,
    renameProject,
    remove,
    newStory,
  };
}
