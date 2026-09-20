import { useEffect, useMemo, useState } from 'react';
import type { Story } from './types';
import { workflowClockActive } from './workflow-utils';
import {
  useProjectController,
  type StudioStatus,
} from './use-project-controller';
import { useAssetsController } from './use-assets-controller';
import { useDocumentController } from './use-document-controller';

export function useStudioController() {
  const [section, setSection] = useState<'create' | 'library' | 'setting'>(
    'create',
  );
  const [idea, setIdea] = useState('');
  const [pages, setPages] = useState(4);
  const [special, setSpecial] = useState('');
  const [cat, setCat] = useState('按剧情');
  const [xiaolin, setXiaolin] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('medium');
  const [preset, setPreset] = useState('balanced');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [note, setNote] = useState('');
  const [checks, setChecks] = useState<string[]>([]);
  const [view, setView] = useState('plan');
  const [history, setHistory] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [zoom, setZoom] = useState<{ url: string; title: string } | null>(null);
  const [edit, setEdit] = useState<{ key: string; title: string } | null>(null);
  const [editNote, setEditNote] = useState('');
  const [story, setStory] = useState<Story | null>(null);
  const [settingTab, setSettingTab] = useState<'documents' | 'assets'>(
    'documents',
  );
  const [modelOpen, setModelOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: 'project' | 'archive';
    id: string;
    title: string;
  } | null>(null);
  const [confirmTitle, setConfirmTitle] = useState('');
  const status = useMemo<StudioStatus>(
    () => ({ setWaiting, setError, setToast }),
    [],
  );

  const projectController = useProjectController({
    status,
    brief: {
      idea,
      pageCount: pages,
      special,
      allowXiaolin: xiaolin,
      tangyuan: cat,
      model,
      reasoningEffort: effort,
      workflowPreset: preset,
    },
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
  });

  const assetsController = useAssetsController({
    status,
    data: projectController.data,
    project: projectController.project,
    model,
    updateData: projectController.updateData,
    refresh: projectController.refresh,
  });

  const documentController = useDocumentController({
    status,
    model,
    effort,
    refresh: projectController.refresh,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem('wendi-brief');
      if (!saved) return;
      try {
        const brief = JSON.parse(saved) as {
          idea?: string;
          special?: string;
          pages?: number;
          cat?: string;
          xiaolin?: boolean;
          preset?: string;
        };
        setIdea(brief.idea || '');
        setSpecial(brief.special || '');
        setPages(brief.pages || 4);
        setCat(brief.cat || '按剧情');
        setXiaolin(brief.xiaolin === true);
        setPreset(brief.preset || 'balanced');
      } catch {}
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        window.localStorage.setItem(
          'wendi-brief',
          JSON.stringify({ idea, special, pages, cat, xiaolin, preset }),
        ),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [cat, idea, pages, preset, special, xiaolin]);

  const clockActive = workflowClockActive(projectController.project);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    if (!clockActive) return;
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [clockActive]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const data = projectController.data;
  const project = projectController.project;
  const models = data?.account.models || [];
  const selectedModel = models.find((item) => item.id === model) || models[0];
  const limits = data?.account.rateLimits;
  const plan =
    history !== null
      ? project?.history.find((item) => item.version === history)?.plan
      : project?.plan;
  const primary = limits?.primary || null;
  const secondary = limits?.secondary || null;
  const used = primary ? Math.round(primary.usedPercent) : null;
  const remaining = primary
    ? Math.max(0, Math.round(primary.remainingPercent))
    : null;
  const weeklyUsed = secondary ? Math.round(secondary.usedPercent) : null;
  const weeklyRemaining = secondary
    ? Math.max(0, Math.round(secondary.remainingPercent))
    : null;

  return {
    section,
    setSection,
    idea,
    setIdea,
    pages,
    setPages,
    special,
    setSpecial,
    cat,
    setCat,
    xiaolin,
    setXiaolin,
    model,
    setModel,
    effort,
    setEffort,
    preset,
    setPreset,
    waiting,
    error,
    setError,
    toast,
    note,
    setNote,
    checks,
    setChecks,
    view,
    setView,
    history,
    setHistory,
    now,
    zoom,
    setZoom,
    edit,
    setEdit,
    editNote,
    setEditNote,
    story,
    setStory,
    settingTab,
    setSettingTab,
    modelOpen,
    setModelOpen,
    titleOpen,
    setTitleOpen,
    titleDraft,
    setTitleDraft,
    deleteTarget,
    setDeleteTarget,
    confirmTitle,
    setConfirmTitle,
    models,
    selectedModel,
    plan,
    primary,
    used,
    remaining,
    weeklyUsed,
    weeklyRemaining,
    ...projectController,
    ...assetsController,
    ...documentController,
  };
}
