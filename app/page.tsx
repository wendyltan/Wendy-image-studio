'use client';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleCheck,
  FileText,
  Images,
  Leaf,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  Asset,
  AssetCandidate,
  Bootstrap,
  Doc,
  Project,
  Proposal,
  StagedAssetCandidate,
  Story,
} from './studio/types';
import { effortLabels, presets, statuses } from './studio/constants';
import { ProjectView } from './studio/project-view';
import {
  observedAccountText,
  resetText,
  workflowClockActive,
} from './studio/workflow-utils';
async function request<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(
    url,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Wendi-Request': 'studio',
          },
          body: JSON.stringify(body),
        },
  );
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error || '暂时无法连接创作室');
  return data;
}
export default function Studio() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [section, setSection] = useState<'create' | 'library' | 'setting'>(
      'create',
    ),
    [current, setCurrent] = useState<string | null>(null),
    [project, setProject] = useState<Project | null>(null);
  const [idea, setIdea] = useState(''),
    [pages, setPages] = useState(4),
    [special, setSpecial] = useState(''),
    [cat, setCat] = useState('按剧情'),
    [xiaolin, setXiaolin] = useState(false),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState('medium'),
    [preset, setPreset] = useState('balanced');
  const [waiting, setWaiting] = useState(false),
    [restarting, setRestarting] = useState(false),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [note, setNote] = useState(''),
    [checks, setChecks] = useState<string[]>([]),
    [view, setView] = useState('plan'),
    [history, setHistory] = useState<number | null>(null),
    [now, setNow] = useState(0);
  const [zoom, setZoom] = useState<{ url: string; title: string } | null>(null),
    [edit, setEdit] = useState<{ key: string; title: string } | null>(null),
    [editNote, setEditNote] = useState(''),
    [story, setStory] = useState<Story | null>(null),
    [settingTab, setSettingTab] = useState<'documents' | 'assets'>('documents'),
    [assetGroup, setAssetGroup] = useState('人物与服装');
  const [doc, setDoc] = useState<Doc | null>(null),
    [docText, setDocText] = useState(''),
    [suggestNote, setSuggestNote] = useState(''),
    [proposal, setProposal] = useState<Proposal | null>(null),
    [applyWorld, setApplyWorld] = useState(false),
    [applyWorkflow, setApplyWorkflow] = useState(false),
    [uploadOpen, setUploadOpen] = useState(false),
    [modelOpen, setModelOpen] = useState(false),
    [titleOpen, setTitleOpen] = useState(false),
    [titleDraft, setTitleDraft] = useState(''),
    [deleteTarget, setDeleteTarget] = useState<{
      kind: 'project' | 'archive';
      id: string;
      title: string;
    } | null>(null),
    [confirmTitle, setConfirmTitle] = useState('');
  const [manualCandidate, setManualCandidate] = useState<AssetCandidate | null>(
      null,
    ),
    [manualFile, setManualFile] = useState<File | null>(null),
    [manualCategory, setManualCategory] = useState(''),
    [manualName, setManualName] = useState(''),
    [manualTags, setManualTags] = useState(''),
    [manualDescription, setManualDescription] = useState(''),
    [manualUsage, setManualUsage] = useState<'本篇' | '常用参考' | '正式基线'>(
      '常用参考',
    ),
    [assetSearch, setAssetSearch] = useState(''),
    [assetCategoryFilter, setAssetCategoryFilter] = useState(''),
    [assetUsageFilter, setAssetUsageFilter] = useState(''),
    [assetResults, setAssetResults] = useState<Asset[] | null>(null);
  const lastMessage = useRef(''),
    quotaStageSeen = useRef(0),
    quotaRefreshInFlight = useRef(false),
    quotaRefreshPending = useRef(false),
    modelInitialized = useRef(false),
    models = data?.account.models || [],
    selectedModel = models.find((m) => m.id === model) || models[0],
    limits = data?.account.rateLimits,
    clockActive = workflowClockActive(project),
    assets = useMemo(
      () =>
        (assetResults || data?.assets || []).filter(
          (a) => a.group === assetGroup,
        ),
      [data, assetGroup, assetResults],
    );
  const refresh = useCallback(async () => {
    try {
      const d = await request<Bootstrap>('/api/bootstrap');
      setData(d);
      if (!modelInitialized.current) {
        const m =
          d.account.models.find((x) => x.isDefault) || d.account.models[0];
        if (m) {
          modelInitialized.current = true;
          setModel(m.id);
          setEffort(m.defaultReasoningEffort);
        }
      }
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const refreshAccount = useCallback(async () => {
    if (quotaRefreshInFlight.current) {
      quotaRefreshPending.current = true;
      return;
    }
    quotaRefreshInFlight.current = true;
    try {
      do {
        quotaRefreshPending.current = false;
        const account = await request<Bootstrap['account']>('/api/account', {});
        setData((value) => (value ? { ...value, account } : value));
      } while (quotaRefreshPending.current);
    } finally {
      quotaRefreshInFlight.current = false;
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
      const saved = localStorage.getItem('wendi-brief');
      if (saved)
        try {
          const b = JSON.parse(saved);
          setIdea(b.idea || '');
          setSpecial(b.special || '');
          setPages(b.pages || 4);
          setCat(b.cat || '按剧情');
          setXiaolin(b.xiaolin === true);
          setPreset(b.preset || 'balanced');
        } catch {}
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    const t = setTimeout(
      () =>
        localStorage.setItem(
          'wendi-brief',
          JSON.stringify({ idea, special, pages, cat, xiaolin, preset }),
        ),
      400,
    );
    return () => clearTimeout(t);
  }, [idea, special, pages, cat, xiaolin, preset]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    if (!clockActive) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [clockActive]);
  useEffect(() => {
    if (!current) return;
    let gone = false,
      timer: number | undefined,
      delay = 2200,
      inFlight = false;
    async function poll() {
      if (inFlight || gone) return;
      inFlight = true;
      try {
        const p = await request<Project>('/api/projects/' + current);
        if (!gone) {
          setProject((previous) =>
            !previous || (p.revision ?? 0) >= (previous.revision ?? 0)
              ? p
              : previous,
          );
          setData((d) =>
            d
              ? {
                  ...d,
                  projects: [p, ...d.projects.filter((x) => x.id !== p.id)],
                }
              : d,
          );
          if (
            lastMessage.current &&
            lastMessage.current !== p.message &&
            !p.busy
          ) {
            setToast(p.message);
            if (
              'Notification' in window &&
              Notification.permission === 'granted'
            )
              new Notification('温蒂创作室', { body: p.message });
          }
          lastMessage.current = p.message;
          delay = 2200;
        }
      } catch (e) {
        if (!gone) {
          setError((e as Error).message);
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
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [current]);
  useEffect(() => {
    if (!project) return;
    const serial =
      (project.progress?.stageSerial || 0) +
      (project.metrics?.refreshSerial || 0);
    if (serial <= quotaStageSeen.current) return;
    quotaStageSeen.current = serial;
    void refreshAccount().catch((e) => setError((e as Error).message));
  }, [project, refreshAccount]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  function select(p: Project) {
    quotaStageSeen.current =
      (p.progress?.stageSerial || 0) + (p.metrics?.refreshSerial || 0);
    setCurrent(p.id);
    setProject(p);
    setSection('create');
    setView(
      p.pages.length ? 'pictures' : p.samples.length ? 'samples' : 'plan',
    );
    setHistory(null);
    setChecks([]);
    setError('');
  }
  async function create() {
    setWaiting(true);
    try {
      select(
        await request<Project>('/api/projects', {
          idea,
          pageCount: pages,
          special,
          allowXiaolin: xiaolin,
          tangyuan: cat,
          model,
          reasoningEffort: effort,
          workflowPreset: preset,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function restartStudio() {
    if (restarting) return;
    if (
      !window.confirm(
        '确定重启创作室后台吗？不会自动继续制作或重新生图；正在运行的任务必须先暂停。',
      )
    )
      return;
    setRestarting(true);
    setError('');
    try {
      const accepted = await request<{
        previousInstanceId: string;
        retryAfterMs?: number;
      }>('/api/restart', {});
      setToast('正在安全重启创作室…');
      await new Promise((resolve) =>
        window.setTimeout(resolve, accepted.retryAfterMs || 700),
      );
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const health = await request<{ ready: boolean; instanceId: string }>(
            '/api/health',
          );
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
    } catch (e) {
      setError((e as Error).message);
      setRestarting(false);
    }
  }
  async function action(name: string, body: unknown = {}) {
    if (!project) return;
    setWaiting(true);
    try {
      const p = await request<Project>(
        `/api/projects/${project.id}/${name}`,
        body,
      );
      if (p.id) setProject(p);
      if (name === 'approve-plan' || name === 'preview-decision')
        setView('samples');
      if (name === 'approve-samples') setView('pictures');
      if (
        [
          'retry-missing',
          'recover-image',
          'review-image',
          'resume',
          'repair-page-layout',
          'unify-page-layouts',
        ].includes(name)
      )
        setView(p.samplesApproved ? 'pictures' : 'samples');
      if (name === 'revise-image') {
        setEdit(null);
        setEditNote('');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function switchProjectModel() {
    if (!project) return;
    setWaiting(true);
    try {
      const p = await request<Project>(`/api/projects/${project.id}/settings`, {
        model,
        reasoningEffort: effort,
      });
      setProject(p);
      setModelOpen(false);
      setToast('模型已切换，只影响后续步骤。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function renameProject() {
    if (!project) return;
    setWaiting(true);
    try {
      const p = await request<Project>(`/api/projects/${project.id}/title`, {
        title: titleDraft,
      });
      setProject(p);
      setData((d) =>
        d
          ? { ...d, projects: [p, ...d.projects.filter((x) => x.id !== p.id)] }
          : d,
      );
      setTitleOpen(false);
      setToast('作品名称已更新。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function analyze(
    kind: 'page' | 'panel' | 'sample',
    key: string | number,
  ) {
    if (!project) return;
    setWaiting(true);
    try {
      setProposal(
        (
          await request<{ proposal: Proposal }>('/api/assets/analyze', {
            projectId: project.id,
            kind,
            key,
            model,
            reasoningEffort: 'low',
          })
        ).proposal,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function upload(file: File) {
    if (file.size > 20_000_000) return setError('图片不能超过 20MB。');
    setWaiting(true);
    try {
      const dataUrl = await new Promise<string>((ok, bad) => {
        const r = new FileReader();
        r.onload = () =>
          typeof r.result === 'string'
            ? ok(r.result)
            : bad(new Error('无法读取图片'));
        r.onerror = bad;
        r.readAsDataURL(file);
      });
      setProposal(
        (
          await request<{ proposal: Proposal }>('/api/assets/upload', {
            name: file.name,
            type: file.type,
            data: dataUrl,
            model,
            reasoningEffort: 'low',
          })
        ).proposal,
      );
      setUploadOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function readImageFile(file: File) {
    return await new Promise<string>((ok, bad) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === 'string'
          ? ok(reader.result)
          : bad(new Error('无法读取图片'));
      reader.onerror = bad;
      reader.readAsDataURL(file);
    });
  }
  async function stageManualAsset(file: File) {
    if (file.size > 20_000_000) {
      setError('图片不能超过 20MB。');
      return;
    }
    setWaiting(true);
    try {
      const result = await request<{ candidate: StagedAssetCandidate }>(
          '/api/assets/stage',
          { name: file.name, type: file.type, data: await readImageFile(file) },
        ),
        candidate = {
          ...result.candidate.inspection,
          id: result.candidate.id,
          name: result.candidate.name,
        };
      setManualFile(file);
      setManualCandidate(candidate);
      setManualName(file.name.replace(/\.(png|jpe?g|webp)$/i, ''));
      setManualCategory(
        (category) => category || data?.categories[0]?.id || '',
      );
      setManualTags('');
      setManualDescription('');
      if (candidate.duplicate)
        setToast('这张图已在素材库中，已显示已有素材位置。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function inspectManualAsset() {
    if (!manualCandidate) return;
    setWaiting(true);
    try {
      const result = await request<{ candidate: AssetCandidate }>(
        `/api/assets/candidates/${manualCandidate.id}`,
      );
      setManualCandidate(result.candidate);
      setToast(
        result.candidate.duplicate
          ? '已找到相同素材，不会重复保存。'
          : '本地检查完成，可以填写入库信息。',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  function closeManualUpload() {
    setUploadOpen(false);
    setManualCandidate(null);
    setManualFile(null);
  }
  async function saveManualAsset() {
    if (!manualCandidate || manualCandidate.duplicate) return;
    setWaiting(true);
    try {
      const result = await request<{
        duplicate?: boolean;
        asset?: Asset | null;
        assets?: Asset[];
      }>('/api/assets/manual-save', {
        candidateId: manualCandidate.id,
        category: manualCategory,
        name: manualName,
        tags: manualTags
          .split(/[，,]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        description: manualDescription,
        usage: manualUsage,
      });
      if (result.assets)
        setData((previous) =>
          previous
            ? { ...previous, assets: result.assets || previous.assets }
            : previous,
        );
      if (result.duplicate) {
        setManualCandidate((candidate) =>
          candidate
            ? {
                ...candidate,
                duplicate: result.asset
                  ? { file: result.asset.file, asset: result.asset }
                  : candidate.duplicate,
              }
            : candidate,
        );
        setToast('这张图已在素材库中，未重复保存。');
        return;
      }
      setToast('素材已按你的分类加入素材库，未调用模型。');
      closeManualUpload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function searchLibraryAssets() {
    setWaiting(true);
    try {
      const params = new URLSearchParams();
      if (assetSearch.trim()) params.set('query', assetSearch.trim());
      if (assetCategoryFilter) params.set('category', assetCategoryFilter);
      if (assetUsageFilter) params.set('usage', assetUsageFilter);
      const result = await request<{ assets: Asset[]; total: number }>(
        `/api/assets/search?${params.toString()}`,
      );
      setAssetResults(result.assets);
      setToast(`本地找到 ${result.total} 项素材。`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  function clearAssetSearch() {
    setAssetSearch('');
    setAssetCategoryFilter('');
    setAssetUsageFilter('');
    setAssetResults(null);
  }
  async function applyProposal() {
    if (!proposal) return;
    setWaiting(true);
    try {
      const result = await request<{ duplicate?: boolean }>(
        '/api/assets/apply',
        { proposalId: proposal.id, applyWorld, applyWorkflow },
      );
      setProposal(null);
      setToast(
        result.duplicate
          ? '这张图已在长期素材库中，未重复添加。'
          : '素材已加入长期素材库。',
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function suggestDoc() {
    if (!doc) return;
    setWaiting(true);
    try {
      const r = await request<{ revisedText: string }>(
        '/api/documents/suggest',
        {
          docPath: doc.path,
          note: suggestNote,
          model,
          reasoningEffort: effort,
        },
      );
      setDocText(r.revisedText);
      setToast('修改建议已填入编辑区，请检查后保存。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function saveDoc() {
    if (
      !doc ||
      !confirm('保存后会更新长期设定，并自动保留旧版本。确定保存吗？')
    )
      return;
    setWaiting(true);
    try {
      await request('/api/documents/save', {
        docPath: doc.path,
        content: docText,
        expectedHash: doc.hash,
        confirm: true,
      });
      setDoc(null);
      setToast('长期设定已保存，旧版本已备份。');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  async function remove() {
    if (!deleteTarget) return;
    setWaiting(true);
    try {
      await request(
        deleteTarget.kind === 'project'
          ? `/api/projects/${deleteTarget.id}/delete`
          : `/api/archive/${deleteTarget.id}/delete`,
        { confirmTitle },
      );
      if (deleteTarget.id === current) {
        setCurrent(null);
        setProject(null);
      }
      setDeleteTarget(null);
      setStory(null);
      setToast('作品已移入本地废纸篓。');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWaiting(false);
    }
  }
  const plan =
      history !== null
        ? project?.history.find((h) => h.version === history)?.plan
        : project?.plan,
    primary = limits?.primary || null,
    secondary = limits?.secondary || null,
    used = primary ? Math.round(primary.usedPercent) : null,
    remaining = primary
      ? Math.max(0, Math.round(primary.remainingPercent))
      : null,
    weeklyUsed = secondary ? Math.round(secondary.usedPercent) : null,
    weeklyRemaining = secondary
      ? Math.max(0, Math.round(secondary.remainingPercent))
      : null;
  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark">
            w<span>✦</span>
          </span>
          <span>
            温蒂的日常<small>WENDI’S LITTLE STUDIO</small>
          </span>
        </Link>
        <button
          className="new-story"
          onClick={() => {
            setCurrent(null);
            setProject(null);
            setSection('create');
          }}
        >
          <Plus size={18} />
          写一个新故事
        </button>
        <nav>
          <button
            className={section === 'create' ? 'active' : ''}
            onClick={() => setSection('create')}
          >
            <Pencil size={18} />
            创作桌
          </button>
          <button
            className={section === 'library' ? 'active' : ''}
            onClick={() => setSection('library')}
          >
            <BookOpen size={18} />
            我的作品
            <span>
              {(data?.projects.length || 0) +
                (data?.archiveStories.length || 0)}
            </span>
          </button>
          <button
            className={section === 'setting' ? 'active' : ''}
            onClick={() => setSection('setting')}
          >
            <Leaf size={18} />
            人物与世界
          </button>
        </nav>
        <div className="recent">
          <p className="eyebrow">最近的故事</p>
          {data?.projects.slice(0, 7).map((p) => (
            <button
              key={p.id}
              onClick={() => select(p)}
              className={current === p.id ? 'selected' : ''}
            >
              <span className={'dot ' + (p.accepted ? 'done' : '')} />
              <span>
                {p.title}
                <small>
                  {statuses[p.status]} · {p.brief.pageCount} 页
                </small>
              </span>
            </button>
          ))}
        </div>
        <div className="sidebar-foot"><small>作品保存在这台电脑</small></div>
      </aside>
      <main>
        <header className="topbar">
          <span>一间只属于你的漫画创作室</span>
          <div className="topbar-actions">
            <div
              className={
                'quota-mini ' +
                (remaining !== null && remaining < 10 ? 'low' : '')
              }
            >
              <span>订阅实际剩余</span>
              <b>5小时 {remaining === null ? '暂不可用' : `${remaining}%`}</b>
              {remaining !== null && (
                <i>
                  <em style={{ width: `${remaining}%` }} />
                </i>
              )}
              <b>
                1周{' '}
                {weeklyRemaining === null
                  ? '暂不可用'
                  : `${weeklyRemaining}%`}
              </b>
              {data?.account.updatedAt && (
                <small>
                  {data.account.status === 'stale' ? '上次读取' : '更新于'}{' '}
                  {observedAccountText(data.account.updatedAt)}
                </small>
              )}
              <button
                title="刷新实际额度"
                onClick={() =>
                  void refreshAccount().catch((e) =>
                    setError((e as Error).message),
                  )
                }
              >
                <RotateCcw size={13} />
              </button>
            </div>
            <button
              className="restart-studio"
              disabled={
                restarting ||
                waiting ||
                project?.busy === true ||
                data?.projects.some((item) => item.busy) === true
              }
              title={
                project?.busy || data?.projects.some((item) => item.busy)
                  ? '请先暂停当前制作任务'
                  : '安全重启后台服务'
              }
              onClick={() => void restartStudio()}
            >
              {restarting ? <LoaderCircle className="spin" /> : <Power />}
              <span>{restarting ? '重启中…' : '重启创作室'}</span>
            </button>
          </div>
        </header>
        <div className="workspace">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {section === 'create'
                  ? 'A LITTLE STORY, A LITTLE LIGHT'
                  : section === 'library'
                    ? 'STORIES TO KEEP'
                    : 'THE WORLD OF WENDI'}
              </p>
              <div className="project-title-row">
                <h1>
                  {section === 'library'
                    ? '一篇故事，一张封面'
                    : section === 'setting'
                      ? '让温蒂的世界继续生长'
                      : project
                        ? project.title
                        : '今天，想画一个怎样的故事？'}
                </h1>
                {section === 'create' && project && (
                  <button
                    className="title-edit"
                    onClick={() => {
                      setTitleDraft(project.title);
                      setTitleOpen(true);
                    }}
                  >
                    <Pencil />
                    修改名称
                  </button>
                )}
              </div>
              <p className="muted">
                {section === 'library'
                  ? '点开作品，才展开它的每一页。'
                  : section === 'setting'
                    ? '文字设定与图片素材分开整理，每次变更都有旧版本。'
                    : '从想法、方案到成品，都在这里完成。'}
              </p>
            </div>
          </div>
          {error && (
            <div className="error">
              <AlertCircle />
              <span>{error}</span>
              <button aria-label="关闭错误提示" onClick={() => setError('')}>
                <X />
              </button>
            </div>
          )}
          {!data && (
            <div className="loading">
              <LoaderCircle className="spin" />
              正在打开创作室…
            </div>
          )}
          {section === 'create' && !project && data && (
            <div className="new-grid">
              <section className="brief-card">
                <div className="card-title">
                  <span className="step-badge">01</span>
                  <div>
                    <h2>从一点小小的灵感开始</h2>
                    <p>方案模型、思考力度和制作速度都由你决定。</p>
                  </div>
                </div>
                <label htmlFor="story-idea">这次想画什么？</label>
                <textarea
                  id="story-idea"
                  className="idea-input"
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  placeholder="比如：周六下了一整天的雨。温蒂留在家里，给自己做了一杯咖啡……"
                />
                <div className="form-row">
                  <div>
                    <label htmlFor="story-pages">计划页数</label>
                    <div className="page-picker">
                      <button
                        onClick={() => setPages((x) => Math.max(1, x - 1))}
                      >
                        −
                      </button>
                      <input
                        id="story-pages"
                        type="number"
                        value={pages}
                        onChange={(e) =>
                          setPages(
                            Math.max(1, Math.min(12, +e.target.value || 1)),
                          )
                        }
                      />
                      <span>页</span>
                      <button
                        onClick={() => setPages((x) => Math.min(12, x + 1))}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="story-cat">汤圆</label>
                    <select
                      id="story-cat"
                      value={cat}
                      onChange={(e) => setCat(e.target.value)}
                    >
                      <option>按剧情</option>
                      <option>自然出现</option>
                      <option>不出现</option>
                    </select>
                  </div>
                </div>
                <div className="model-panel">
                  <div>
                    <label htmlFor="story-model">故事与方案模型</label>
                    <select
                      id="story-model"
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        const m = models.find((x) => x.id === e.target.value);
                        if (m) setEffort(m.defaultReasoningEffort);
                      }}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <small>{selectedModel?.description}</small>
                  </div>
                  <div>
                    <label htmlFor="story-effort">思考力度</label>
                    <select
                      id="story-effort"
                      value={effort}
                      onChange={(e) => setEffort(e.target.value)}
                    >
                      {(
                        selectedModel?.reasoningEfforts || [
                          'low',
                          'medium',
                          'high',
                        ]
                      ).map((x) => (
                        <option key={x} value={x}>
                          {effortLabels[x] || x}
                        </option>
                      ))}
                    </select>
                    <small>越高越仔细，也会更慢</small>
                  </div>
                </div>
                <span className="field-label">制作方式</span>
                <div className="preset-grid">
                  {Object.entries(presets).map(([id, x]) => (
                    <button
                      key={id}
                      className={preset === id ? 'chosen' : ''}
                      onClick={() => setPreset(id)}
                    >
                      <b>{x.name}</b>
                      <span>{x.note}</span>
                    </button>
                  ))}
                </div>
                <details className="more">
                  <summary>
                    补充特别要求
                    <Plus />
                  </summary>
                  <textarea
                    value={special}
                    onChange={(e) => setSpecial(e.target.value)}
                    placeholder="季节、服装、指定文案或不想出现的内容"
                  />
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={xiaolin}
                      onChange={(e) => setXiaolin(e.target.checked)}
                    />
                    <span>
                      本篇明确允许小林出场
                      <small>默认不出现，也不通过消息、照片或回忆暗示。</small>
                    </span>
                  </label>
                </details>
                <div className="brief-footer">
                  <p>
                    <Check />
                    固定设定和参考图会自动带上
                  </p>
                  <button
                    className="primary"
                    disabled={
                      waiting ||
                      idea.trim().length < 4 ||
                      !data.connection.ready
                    }
                    onClick={create}
                  >
                    {waiting ? <LoaderCircle className="spin" /> : <Sparkles />}
                    整理成创作方案
                    <ArrowRight />
                  </button>
                  <small>先看完整方案，确认后才开始生图。</small>
                </div>
              </section>
              <aside className="right-column">
                <div className="usage-card">
                  <span className="eyebrow">本次创作状态</span>
                  <h2>
                    {remaining === null
                      ? '额度暂不可用'
                      : `约剩余 ${remaining}%`}
                  </h2>
                  {remaining !== null && (
                    <div className="usage-track">
                      <i style={{ width: `${remaining}%` }} />
                    </div>
                  )}
                  <p>
                    {used === null
                      ? '尚未取得账户额度，请稍后刷新。'
                      : `当前窗口已用 ${used}% · ${resetText(primary?.resetsAt || undefined)}`}
                  </p>
                  <p>
                    {weeklyUsed === null
                      ? '较长周期额度暂不可用'
                      : `较长周期已用 ${weeklyUsed}%`}
                  </p>
                  <small>
                    {data.account.status === 'stale'
                      ? `显示 ${observedAccountText(data.account.updatedAt)} 成功读取的额度；本次刷新失败，不把它当作实时额度。`
                      : '显示账户提供的实际额度，不把图片张数误当成固定次数。'}
                  </small>
                </div>
                <div className="flow-card">
                  <p className="eyebrow">更省时的制作顺序</p>
                  {[
                    '一次整理全篇方案',
                    '两张样张先锁定方向',
                    '逐页落图与统一排版',
                    '整页校对后再做全篇复核',
                  ].map((x, i) => (
                    <div key={x}>
                      <span>{i + 1}</span>
                      {x}
                    </div>
                  ))}
                </div>
              </aside>
            </div>
          )}
          {section === 'create' && project && (
            <>
              <div className="project-model-bar">
                <span>
                  <b>{project.brief.model || '尚未绑定模型'}</b>
                  <small>
                    {project.brief.reasoningEffort
                      ? `${effortLabels[project.brief.reasoningEffort] || project.brief.reasoningEffort}思考`
                      : '旧任务尚未记录思考力度'}
                  </small>
                </span>
                <button
                  className="secondary"
                  disabled={project.busy || project.status === 'complete'}
                  onClick={() => {
                    const m =
                      models.find((x) => x.id === project.brief.model) ||
                      models.find((x) => x.isDefault) ||
                      models[0];
                    if (m) {
                      setModel(m.id);
                      setEffort(
                        project.brief.reasoningEffort ||
                          m.defaultReasoningEffort,
                      );
                    }
                    setModelOpen(true);
                  }}
                >
                  <Pencil />
                  更换后续步骤使用的模型
                </button>
              </div>
              <ProjectView
                project={project}
                plan={plan || null}
                view={view}
                setView={setView}
                history={history}
                setHistory={setHistory}
                disabled={waiting || project.busy}
                imageReady={data?.connection.imageWorker?.ready !== false}
                imageMessage={data?.connection.imageWorker?.message || ''}
                note={note}
                setNote={setNote}
                checks={checks}
                setChecks={setChecks}
                allChecks={data?.checks || []}
                action={action}
                setZoom={setZoom}
                setEdit={setEdit}
                setEditNote={setEditNote}
                analyze={analyze}
                now={now}
              />
            </>
          )}
          {section === 'library' && data && (
            <div className="library-grid">
              {data.projects.map((p) => (
                <article className="work-card" key={p.id}>
                  <button className="cover-button" onClick={() => select(p)}>
                    {p.pages[0] ? (
                      <img
                        src={p.pages[0].url}
                        alt={p.title}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="work-placeholder">
                        <BookOpen />
                        <b>{p.title}</b>
                      </span>
                    )}
                  </button>
                  <div>
                    <span className="eyebrow">
                      {statuses[p.status]} · {p.brief.pageCount} PAGES
                    </span>
                    <h2>{p.title}</h2>
                    <button className="text-button" onClick={() => select(p)}>
                      查看作品 <ArrowUpRight />
                    </button>
                    {p.accepted && (
                      <button
                        className="danger-link"
                        onClick={() =>
                          setDeleteTarget({
                            kind: 'project',
                            id: p.id,
                            title: p.title,
                          })
                        }
                      >
                        <Trash2 />
                        删除
                      </button>
                    )}
                  </div>
                </article>
              ))}
              {data.archiveStories.map((s) => (
                <article className="work-card" key={s.id}>
                  <button className="cover-button" onClick={() => setStory(s)}>
                    <img
                      src={s.coverUrl}
                      alt={s.title}
                      loading="lazy"
                      decoding="async"
                    />
                  </button>
                  <div>
                    <span className="eyebrow">
                      往期作品 · {s.pages.length} PAGES
                    </span>
                    <h2>{s.title}</h2>
                    <button className="text-button" onClick={() => setStory(s)}>
                      展开每一页 <ArrowUpRight />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {section === 'setting' && data && (
            <>
              <div className="setting-note">
                <Leaf />
                <p>
                  智能整理只给出提案。长期素材、世界观和工作指引都要经过你的确认才会写入，并自动保留旧版本。
                </p>
                <button
                  className="primary small-action"
                  onClick={() => {
                    setManualCategory(data.categories[0]?.id || '');
                    setUploadOpen(true);
                  }}
                >
                  <Upload />
                  手动添加素材
                </button>
              </div>
              <div className="subtabs">
                <button
                  className={settingTab === 'documents' ? 'chosen' : ''}
                  onClick={() => setSettingTab('documents')}
                >
                  <FileText />
                  文字设定
                </button>
                <button
                  className={settingTab === 'assets' ? 'chosen' : ''}
                  onClick={() => setSettingTab('assets')}
                >
                  <Images />
                  图片素材
                </button>
              </div>
              {settingTab === 'documents' ? (
                <div className="document-groups">
                  {[...new Set(data.documents.map((d) => d.group))].map(
                    (group) => (
                      <section key={group}>
                        <h2>{group}</h2>
                        <div className="document-grid">
                          {data.documents
                            .filter((d) => d.group === group)
                            .map((d) => (
                              <button
                                key={d.path}
                                onClick={() => {
                                  setDoc(d);
                                  setDocText(d.text);
                                  setSuggestNote('');
                                }}
                              >
                                <FileText />
                                <span>
                                  <b>{d.label}</b>
                                  <small>
                                    {new Date(d.updatedAt).toLocaleDateString(
                                      'zh-CN',
                                    )}{' '}
                                    更新
                                  </small>
                                </span>
                                <ChevronRight />
                              </button>
                            ))}
                        </div>
                      </section>
                    ),
                  )}
                </div>
              ) : (
                <>
                  <section className="setting-note">
                    <Images />
                    <div>
                      <b>本地素材检索</b>
                      <p>
                        搜索、分类和用途筛选只读取本地素材索引，不调用模型。
                      </p>
                    </div>
                    <div className="form-row">
                      <input
                        value={assetSearch}
                        onChange={(e) => setAssetSearch(e.target.value)}
                        placeholder="按名称、标签或说明搜索"
                      />
                      <select
                        value={assetCategoryFilter}
                        onChange={(e) => setAssetCategoryFilter(e.target.value)}
                      >
                        <option value="">全部分类</option>
                        {data.categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={assetUsageFilter}
                        onChange={(e) => setAssetUsageFilter(e.target.value)}
                      >
                        <option value="">全部用途</option>
                        <option>本篇</option>
                        <option>常用参考</option>
                        <option>正式基线</option>
                      </select>
                      <button
                        className="secondary"
                        disabled={waiting}
                        onClick={searchLibraryAssets}
                      >
                        本地搜索
                      </button>
                      {assetResults && (
                        <button
                          className="text-button"
                          onClick={clearAssetSearch}
                        >
                          清除筛选
                        </button>
                      )}
                    </div>
                  </section>
                  <div className="group-switch">
                    <button
                      className={assetGroup === '人物与服装' ? 'chosen' : ''}
                      onClick={() => setAssetGroup('人物与服装')}
                    >
                      人物与服装
                    </button>
                    <button
                      className={assetGroup === '场景与物品' ? 'chosen' : ''}
                      onClick={() => setAssetGroup('场景与物品')}
                    >
                      场景与物品
                    </button>
                  </div>
                  {assetResults && !assets.length && (
                    <div className="empty-state">
                      <Images />
                      <h2>没有符合条件的本地素材</h2>
                      <p>可以清除筛选，或调整名称、分类和用途。</p>
                    </div>
                  )}
                  <div className="asset-sections">
                    {[...new Set(assets.map((a) => a.category))].map((c) => (
                      <section key={c}>
                        <h2>
                          {assets.find((a) => a.category === c)?.categoryLabel}
                        </h2>
                        <div className="reference-grid">
                          {assets
                            .filter((a) => a.category === c)
                            .map((a) => (
                              <button
                                key={a.file}
                                onClick={() =>
                                  setZoom({
                                    url: a.url,
                                    title: a.displayName || a.name,
                                  })
                                }
                              >
                                <img
                                  src={a.url}
                                  alt={a.displayName || a.name}
                                  loading="lazy"
                                  decoding="async"
                                />
                                <span>
                                  {a.displayName ||
                                    a.name.replace(/\.(png|jpe?g|webp)$/i, '')}
                                  {a.usage && <small> · {a.usage}</small>}
                                </span>
                              </button>
                            ))}
                        </div>
                      </section>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <Leaf />
            把普通的日子，画成值得记住的样子。
          </footer>
        </div>
      </main>
      {toast && (
        <div className="toast">
          <CircleCheck />
          {toast}
        </div>
      )}
      {zoom && (
        <dialog open className="modal" aria-label={zoom.title}>
          <header>
            <span>{zoom.title} · 原始尺寸</span>
            <button aria-label="关闭图片预览" onClick={() => setZoom(null)}>
              <X />
            </button>
          </header>
          <div className="zoom-scroll">
            <img src={zoom.url} alt={zoom.title} />
          </div>
        </dialog>
      )}
      {edit && (
        <Dialog close={() => setEdit(null)}>
          <h2>{edit.title}，想改哪里？</h2>
          <p>只修改你指出的部分，旧图不会覆盖。</p>
          <textarea
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
          />
          <button
            className="primary"
            onClick={() =>
              action('revise-image', { key: edit.key, note: editNote })
            }
          >
            <Pencil />
            按这个要求修改
          </button>
        </Dialog>
      )}
      {story && (
        <dialog open className="modal story-modal" aria-label={story.title}>
          <header>
            <span>
              {story.title} · 共 {story.pages.length} 页
            </span>
            <div>
              <button
                className="danger-link"
                onClick={() =>
                  setDeleteTarget({
                    kind: 'archive',
                    id: story.id,
                    title: story.title,
                  })
                }
              >
                <Trash2 />
                删除作品
              </button>
              <button aria-label="关闭作品预览" onClick={() => setStory(null)}>
                <X />
              </button>
            </div>
          </header>
          <div className="story-pages">
            {story.pages.map((p, i) => (
              <button
                key={p.url}
                onClick={() =>
                  setZoom({
                    url: p.url,
                    title: `${story.title} · 第 ${i + 1} 页`,
                  })
                }
              >
                <img
                  src={p.url}
                  alt={`第${i + 1}页`}
                  loading="lazy"
                  decoding="async"
                />
                <span>第 {i + 1} 页</span>
              </button>
            ))}
          </div>
        </dialog>
      )}
      {doc && (
        <Dialog wide close={() => setDoc(null)}>
          <h2>{doc.label}</h2>
          <p>
            可以直接编辑，也可以让创作助手先给出完整修订建议；保存时自动备份旧版。
          </p>
          <div className="suggest-row">
            <textarea
              value={suggestNote}
              onChange={(e) => setSuggestNote(e.target.value)}
              placeholder="想完善什么？"
            />
            <button className="secondary" onClick={suggestDoc}>
              <Sparkles />
              智能完善
            </button>
          </div>
          <textarea
            className="doc-editor"
            value={docText}
            onChange={(e) => setDocText(e.target.value)}
          />
          <button className="primary" onClick={saveDoc}>
            <Save />
            检查后保存长期设定
          </button>
        </Dialog>
      )}
      {uploadOpen && (
        <Dialog close={closeManualUpload}>
          <h2>手动添加素材</h2>
          <p>
            上传、查重、分类和保存都在本地完成，不调用模型。需要智能建议时再主动选择。
          </p>
          {!manualCandidate ? (
            <label className="upload-box">
              <Upload />
              <span>
                {waiting ? '正在检查…' : '选择 PNG、JPG 或 WebP（20MB 内）'}
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) =>
                  e.target.files?.[0] && stageManualAsset(e.target.files[0])
                }
              />
            </label>
          ) : (
            <div className="manual-asset-form">
              <p>
                <b>{manualCandidate.name}</b> · {manualCandidate.width}×
                {manualCandidate.height} ·{' '}
                {(manualCandidate.sizeBytes / 1024 / 1024).toFixed(1)} MB
              </p>
              {manualCandidate.duplicate ? (
                <div className="recovery-card">
                  <p>这张图已存在于素材库，不会重复保存。</p>
                  <button className="secondary" onClick={closeManualUpload}>
                    完成
                  </button>
                </div>
              ) : (
                <>
                  <div className="form-row">
                    <label>
                      分类
                      <select
                        value={manualCategory}
                        onChange={(e) => setManualCategory(e.target.value)}
                      >
                        {data?.categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      用途
                      <select
                        value={manualUsage}
                        onChange={(e) =>
                          setManualUsage(e.target.value as typeof manualUsage)
                        }
                      >
                        <option>本篇</option>
                        <option>常用参考</option>
                        <option>正式基线</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    素材名称
                    <input
                      value={manualName}
                      maxLength={80}
                      onChange={(e) => setManualName(e.target.value)}
                    />
                  </label>
                  <label>
                    标签（用逗号分隔）
                    <input
                      value={manualTags}
                      onChange={(e) => setManualTags(e.target.value)}
                      placeholder="例如：高丸子头、通勤、咖啡"
                    />
                  </label>
                  <label>
                    说明
                    <textarea
                      value={manualDescription}
                      maxLength={500}
                      onChange={(e) => setManualDescription(e.target.value)}
                      placeholder="这张素材适合在什么情况下复用？"
                    />
                  </label>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={
                        waiting || !manualCategory || !manualName.trim()
                      }
                      onClick={saveManualAsset}
                    >
                      <Save />
                      保存到素材库（本地，不调用模型）
                    </button>
                    <button
                      className="secondary"
                      disabled={waiting}
                      onClick={inspectManualAsset}
                    >
                      重新本地检查
                    </button>
                    {manualFile && (
                      <button
                        className="text-button"
                        disabled={waiting}
                        onClick={() => upload(manualFile)}
                      >
                        {' '}
                        <Sparkles />
                        智能分析建议
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </Dialog>
      )}
      {proposal && (
        <Dialog close={() => setProposal(null)}>
          <h2>
            {proposal.decision === 'keep'
              ? '建议加入长期素材库'
              : '建议只留在本篇作品中'}
          </h2>
          <div className={'proposal-score ' + proposal.decision}>
            {proposal.confidence}% 可信度
          </div>
          <p>{proposal.reason}</p>
          {proposal.decision === 'keep' && (
            <>
              <dl className="proposal-detail">
                <dt>归类</dt>
                <dd>
                  {
                    data?.categories.find((c) => c.id === proposal.category)
                      ?.label
                  }
                </dd>
                <dt>文件名</dt>
                <dd>{proposal.filename}</dd>
                <dt>索引说明</dt>
                <dd>{proposal.indexEntry}</dd>
              </dl>
              {proposal.worldSettingAddition && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={applyWorld}
                    onChange={(e) => setApplyWorld(e.target.checked)}
                  />
                  <span>
                    同时补充世界观<small>{proposal.worldSettingAddition}</small>
                  </span>
                </label>
              )}
              {proposal.workflowAddition && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={applyWorkflow}
                    onChange={(e) => setApplyWorkflow(e.target.checked)}
                  />
                  <span>
                    同时补充工作指引<small>{proposal.workflowAddition}</small>
                  </span>
                </label>
              )}
              <button className="primary" onClick={applyProposal}>
                <Check />
                确认加入素材库
              </button>
            </>
          )}
        </Dialog>
      )}
      {modelOpen && project && (
        <Dialog close={() => setModelOpen(false)}>
          <h2>更换后续步骤使用的模型</h2>
          <p>
            已有方案、样张和成稿保持不变。切换记录会保存到本篇项目；正在执行某一步时不能更换。
          </p>
          <div className="model-panel switch">
            <div>
              <label htmlFor="project-model">模型</label>
              <select
                id="project-model"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  const m = models.find((x) => x.id === e.target.value);
                  if (m) setEffort(m.defaultReasoningEffort);
                }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <small>{selectedModel?.description}</small>
            </div>
            <div>
              <label htmlFor="project-effort">思考力度</label>
              <select
                id="project-effort"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                {(selectedModel?.reasoningEfforts || []).map((x) => (
                  <option key={x} value={x}>
                    {effortLabels[x] || x}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            className="primary"
            disabled={waiting || project.busy}
            onClick={switchProjectModel}
          >
            <Check />
            确认，从下一步开始使用
          </button>
        </Dialog>
      )}
      {titleOpen && project && (
        <Dialog close={() => setTitleOpen(false)}>
          <h2>修改作品名称</h2>
          <p>名称会同步到首页、作品列表和本地项目记录。</p>
          <input
            value={titleDraft}
            maxLength={60}
            onChange={(e) => setTitleDraft(e.target.value)}
          />
          <button
            className="primary"
            disabled={waiting || !titleDraft.trim()}
            onClick={renameProject}
          >
            <Check />
            保存名称
          </button>
        </Dialog>
      )}
      {deleteTarget && (
        <Dialog close={() => setDeleteTarget(null)}>
          <h2>确认删除《{deleteTarget.title}》</h2>
          <p>作品会移入本地废纸篓。请输入完整作品名进行二次确认。</p>
          <input
            value={confirmTitle}
            onChange={(e) => setConfirmTitle(e.target.value)}
            placeholder={deleteTarget.title}
          />
          <button
            className="danger-button"
            disabled={confirmTitle !== deleteTarget.title}
            onClick={remove}
          >
            <Trash2 />
            确认移入废纸篓
          </button>
        </Dialog>
      )}
    </div>
  );
}
function Dialog({
  children,
  close,
  wide = false,
}: {
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  useEffect(() => {
    const node = dialog.current,
      previous =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    if (node && !node.open) node.showModal();
    const first = node?.querySelector<HTMLElement>(
      'input, textarea, select, button:not(.close):not(.modal-dismiss)',
    );
    first?.focus();
    return () => {
      if (node?.open) node.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal-scrim"
      aria-label="操作对话框"
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      <button
        className="modal-dismiss"
        aria-label="关闭对话框"
        onClick={close}
      />
      <div className={'edit-modal ' + (wide ? 'wide' : '')}>
        <button className="close" aria-label="关闭对话框" onClick={close}>
          <X />
        </button>
        {children}
      </div>
    </dialog>
  );
}
