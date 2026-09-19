import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronRight,
  CircleCheck,
  Download,
  FileText,
  FolderOpen,
  Images,
  Leaf,
  LoaderCircle,
  Pencil,
  RotateCcw,
} from 'lucide-react';
import { layouts } from './constants';
import type { Plan, Picture, Project } from './types';
import { MeasuredMasonryGrid, QaBadge } from './visuals';
import {
  ModelUsagePanel,
  WorkflowStatus,
} from './workflow-status';
import {
  NoOutputCard,
  PanelDecisionCard,
  ProjectAction,
  RecoveryCard,
  ReviewCard,
  SampleDecisionActions,
  SampleDecisionNotice,
  UnknownResultCard,
} from './recovery-cards';

export function ProjectView({
  project,
  plan,
  view,
  setView,
  history,
  setHistory,
  disabled,
  imageReady,
  imageMessage,
  note,
  setNote,
  checks,
  setChecks,
  allChecks,
  action,
  setZoom,
  setEdit,
  setEditNote,
  analyze,
  now,
}: {
  project: Project;
  plan: Plan | null;
  view: string;
  setView: (x: string) => void;
  history: number | null;
  setHistory: (x: number | null) => void;
  disabled: boolean;
  imageReady: boolean;
  imageMessage: string;
  note: string;
  setNote: (x: string) => void;
  checks: string[];
  setChecks: (x: string[]) => void;
  allChecks: string[];
  action: ProjectAction;
  setZoom: (x: { url: string; title: string } | null) => void;
  setEdit: (x: { key: string; title: string } | null) => void;
  setEditNote: (x: string) => void;
  analyze: (kind: 'page' | 'panel' | 'sample', key: string | number) => void;
  now: number;
}) {
  const progress = project.progress;
  const task = project.currentTask;
  const percent = progress?.total
    ? Math.round((100 * (progress.current || 0)) / progress.total)
    : 0;
  const noOutput = project.imageRetry?.certainty === 'confirmed_missing';
  const unknownResult = project.imageRetry?.certainty === 'unknown_result';
  const reviewable = [
    ...project.samples.map((image, index) =>
      image
        ? { key: `sample-${index + 1}`, title: `第 ${index + 1} 张样张`, image }
        : null,
    ),
    ...Object.entries(project.panels).map(([key, image]) => ({
      key,
      title: `第 ${key} 格原始分镜`,
      image,
    })),
  ].find(
    (item): item is { key: string; title: string; image: Picture } =>
      item !== null &&
      ((item.image.qa.pass === null &&
        ['pending', 'unavailable', 'recovered_pending_review'].includes(
          item.image.qa.status || '',
        )) ||
        (item.image.qa.pass === false &&
          item.key === project.panelDecision?.panelKey)),
  );
  const panelDecisionKey = project.panelDecision?.panelKey;
  const panelDecisionTarget = panelDecisionKey
    ? project.panels[panelDecisionKey]
    : null;
  const panelDecisionRequired = Boolean(
    panelDecisionTarget &&
      project.panelDecision?.state === 'required' &&
      !project.busy,
  );
  // One recovery/decision card is the primary action. Unknown results keep
  // their safety boundary; a known missing result yields to an existing panel
  // decision so the previous image remains the only actionable surface.
  const primaryCard = unknownResult
    ? 'unknown'
    : panelDecisionRequired
      ? 'panel'
      : noOutput
        ? 'no-output'
        : reviewable
          ? 'review'
          : project.pending && !project.busy
            ? 'recovery'
            : null;
  return (
    <>
      <div className="steps">
        {['故事与方案', '人物和场景样张', '整篇绘制与校对', '成品'].map(
          (t, i) => {
            const n = project.accepted
              ? 3
              : project.samplesApproved
                ? 2
                : project.approved
                  ? 1
                  : 0;
            return (
              <span
                key={t}
                className={i === n ? 'current' : i < n ? 'passed' : ''}
              >
                <b>{i < n ? <Check /> : i + 1}</b>
                {t}
                {i < 3 && <ChevronRight />}
              </span>
            );
          },
        )}
      </div>
      {!imageReady && project.status === 'review' && (
        <div className="recovery-card">
          <AlertCircle />
          <div>
            <h3>网页生图当前不可用</h3>
            <p>{imageMessage || '请先连接 Codex 和 Chrome Computer Use。'}</p>
          </div>
        </div>
      )}
      <WorkflowStatus
        project={project}
        progress={progress}
        task={task}
        percent={percent}
        disabled={disabled}
        action={action}
        noOutput={noOutput}
        panelDecisionPrimary={primaryCard === 'panel'}
        recoveryPending={Boolean(project.imageRetry)}
        now={now}
      />
      {primaryCard === 'recovery' && <RecoveryCard action={action} />}
      {primaryCard === 'no-output' && (
        <NoOutputCard project={project} disabled={disabled} action={action} />
      )}
      {primaryCard === 'unknown' && (
        <UnknownResultCard
          project={project}
          disabled={disabled}
          action={action}
        />
      )}
      {primaryCard === 'review' && reviewable && (
        <ReviewCard target={reviewable} disabled={disabled} action={action} />
      )}
      {primaryCard === 'panel' && panelDecisionTarget && panelDecisionKey && (
        <PanelDecisionCard
          project={project}
          panelKey={panelDecisionKey}
          image={panelDecisionTarget}
          disabled={disabled}
          action={action}
          previousAttemptNoOutput={noOutput}
          onEdit={(repairPrompt) => {
            setEditNote(repairPrompt || '');
            setEdit({
              key: panelDecisionKey,
              title: `分镜 ${panelDecisionKey}`,
            });
          }}
        />
      )}
      {project.metrics && <ModelUsagePanel project={project} />}
      <div className="tabs">
        <button
          className={view === 'plan' ? 'chosen' : ''}
          onClick={() => setView('plan')}
        >
          <FileText />
          逐页方案
        </button>
        <button
          className={view === 'samples' ? 'chosen' : ''}
          onClick={() => setView('samples')}
        >
          <Leaf />
          样张 <span>{project.samples.length}/2</span>
        </button>
        <button
          className={view === 'pictures' ? 'chosen' : ''}
          onClick={() => setView('pictures')}
        >
          <Images />
          漫画与成品 <span>{project.pages.length}</span>
        </button>
        <button className="folder-tab" onClick={() => action('open-folder')}>
          <FolderOpen />
          本地文件夹
        </button>
      </div>
      {view === 'plan' && (
        <div className="plan-area">
          {project.history.length > 0 && (
            <label className="history-select">
              方案版本
              <select
                value={history ?? 'current'}
                onChange={(e) =>
                  setHistory(
                    e.target.value === 'current' ? null : +e.target.value,
                  )
                }
              >
                <option value="current">当前 v{project.version}</option>
                {project.history.map((h) => (
                  <option key={h.version} value={h.version}>
                    历史 v{h.version}
                  </option>
                ))}
              </select>
            </label>
          )}
          {plan ? (
            <>
              <div className="arc-card">
                <span className="eyebrow">故事弧线</span>
                <p>{plan.arc}</p>
                <details>
                  <summary>本篇连续性台账</summary>
                  <div className="ledger-grid">
                    {Object.entries(plan.continuity).map(([k, v]) => (
                      <div key={k}>
                        <h3>{k}</h3>
                        <ul>
                          {v.map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
              {plan.pages.map((p) => (
                <article className="plan-page" key={p.number}>
                  <header>
                    <span className="page-number">
                      {String(p.number).padStart(2, '0')}
                    </span>
                    <div>
                      <h2>{p.title}</h2>
                      <p>{p.purpose}</p>
                    </div>
                    <span className="layout-label">{layouts[p.layout]}</span>
                  </header>
                  <div className="time-note">{p.time}</div>
                  <div className="panels">
                    {p.panels.map((q, i) => (
                      <div className="panel-plan" key={i}>
                        <span className="panel-label">第 {i + 1} 格</span>
                        <h3>{q.scene}</h3>
                        <p>{q.action}</p>
                        <dl>
                          <dt>人物与服装</dt>
                          <dd>
                            {q.characters} · {q.costume}
                          </dd>
                          <dt>视线与表情</dt>
                          <dd>
                            {q.gaze} · {q.expression}
                          </dd>
                        </dl>
                        {q.caption && <blockquote>{q.caption}</blockquote>}
                        <details>
                          <summary>查看画面细节</summary>
                          <p>{q.prompt}</p>
                          <p>参考：{q.references.join('、')}</p>
                        </details>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
              {history === null && (
                <div className="approval-card">
                  <h2>这一篇，是你想画的故事吗？</h2>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="写下要调整的页码、剧情或文案…"
                  />
                  <div className="actions">
                    <button
                      className="secondary"
                      disabled={disabled || note.trim().length < 2}
                      onClick={() => action('revise-plan', { note })}
                    >
                      <Pencil />
                      按意见修改
                    </button>
                    {project.status === 'review' && (
                      <button
                        className="primary"
                        disabled={disabled || !imageReady}
                        onClick={() =>
                          action('approve-plan', { hash: project.planHash })
                        }
                      >
                        <Check />
                        方案确认，可以开始生图
                      </button>
                    )}
                    {!imageReady && (
                      <small>{imageMessage || '请先连接 Codex 和 Chrome Computer Use。'}</small>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <LoaderCircle className="spin" />
              <h2>正在给故事一点形状</h2>
            </div>
          )}
        </div>
      )}
      {view === 'samples' && (
        <>
          <div className="section-intro">
            <h2>先确认人物和主场景</h2>
            <p>样张通过后再画整篇，避免方向错误造成重复生图。</p>
          </div>
          <div className="sample-grid">
            {[0, 1].map((i) => {
              const sample = project.samples[i],
                needsDecision =
                  project.status === 'samples_decision' &&
                  (project.samplesDecision?.sampleIndexes.includes(i + 1) ||
                    sample?.qa.pass !== true);
              return (
                <div className="image-card" key={i}>
                  {sample ? (
                    <>
                      <button
                        className="image-button"
                        onClick={() =>
                          setZoom({ url: sample.url, title: '样张' })
                        }
                      >
                        <img
                          src={sample.url}
                          alt="样张"
                          loading="lazy"
                          decoding="async"
                        />
                      </button>
                      <div className="image-meta">
                        <h3>
                          {i ? '02 · 主场景' : '01 · 人物脸部'}{' '}
                          <QaBadge qa={sample.qa} />
                        </h3>
                        <p>{sample.qa.summary}</p>
                        {needsDecision ? (
                          <SampleDecisionActions
                            project={project}
                            sample={sample}
                            sampleIndex={i + 1}
                            disabled={disabled}
                            action={action}
                          />
                        ) : (
                          <div className="inline-actions">
                            <button
                              onClick={() =>
                                setEdit({
                                  key: `sample-${i + 1}`,
                                  title: '样张',
                                })
                              }
                            >
                              <Pencil />
                              修改
                            </button>
                            <button onClick={() => analyze('sample', i)}>
                              <Leaf />
                              设为常用素材
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="waiting-image">
                      <Leaf />
                      <p>等待绘制</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {project.status === 'samples_decision' && (
            <SampleDecisionNotice project={project} />
          )}{' '}
          {project.status === 'samples_review' && (
            <div className="approval-card">
              <h2>样张都已准备好</h2>
              <p>确认后才会开始正式画稿。</p>
              <button
                className="primary"
                disabled={disabled}
                onClick={() =>
                  action('approve-samples', { hash: project.planHash })
                }
              >
                <Check />
                样张确认，继续整篇
              </button>
            </div>
          )}
        </>
      )}
      {view === 'pictures' && (
        <>
          <div className="section-intro section-intro-actions">
            <div>
              <h2>
                {project.accepted
                  ? '这一篇，可以好好收起来了。'
                  : '一页一页，故事正在发生。'}
              </h2>
              <p>任何一页都可以提炼成长期参考素材。</p>
            </div>
            {!project.accepted && project.pages.length >= 2 && (
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => action('unify-page-layouts')}
              >
                <RotateCcw />
                统一已有页面排版
              </button>
            )}
          </div>
          {project.pages.length ? (
            <MeasuredMasonryGrid className="finished-grid">
              {project.pages.map((p) => (
                <div className="image-card" key={p.number}>
                  <button
                    className="image-button"
                    onClick={() =>
                      setZoom({ url: p.url, title: `第 ${p.number} 页` })
                    }
                  >
                    <img
                      src={p.url}
                      alt={`第${p.number}页`}
                      loading="lazy"
                      decoding="async"
                    />
                  </button>
                  <div className="image-meta">
                    <h3>
                      第 {p.number} 页 <QaBadge qa={p.qa} />
                    </h3>
                    <p>{p.qa.summary}</p>
                    <div className="inline-actions">
                      {project.accepted && (
                        <a href={p.url + '?download=1'}>
                          <Download />
                          保存
                        </a>
                      )}
                      <button onClick={() => analyze('page', p.number || 0)}>
                        <Leaf />
                        提炼为素材
                      </button>
                      {!p.qa.pass &&
                        ['重新排版', '重新排字'].includes(p.nextStep || '') && (
                          <button
                            disabled={disabled}
                            onClick={() =>
                              action('repair-page-layout', {
                                pageNumber: p.number,
                              })
                            }
                          >
                            <RotateCcw />
                            修复本页排版
                          </button>
                        )}
                    </div>
                  </div>
                </div>
              ))}
            </MeasuredMasonryGrid>
          ) : Object.keys(project.panels).length === 0 ? (
            <div className="empty-state">
              <BookOpen />
              <h2>成稿会在这里陆续出现</h2>
            </div>
          ) : null}
          {Object.keys(project.panels).length > 0 && (
            <details className="source-panels" open={!project.pages.length}>
              <summary>查看原始分镜 · 局部修改</summary>
              <MeasuredMasonryGrid className="source-grid">
                {Object.entries(project.panels).map(([k, p]) => (
                  <div key={k}>
                    <button
                      className="image-button"
                      onClick={() =>
                        setZoom({ url: p.url, title: `分镜 ${k}` })
                      }
                    >
                      <img
                        src={p.url}
                        alt={`分镜${k}`}
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                    <div>
                      <span>分镜 {k}</span>
                      <QaBadge qa={p.qa} />
                      <button
                        aria-label={`修改分镜 ${k}`}
                        title={`修改分镜 ${k}`}
                        onClick={() =>
                          setEdit({ key: k, title: `分镜 ${k}` })
                        }
                      >
                        <Pencil />
                      </button>
                      <button
                        aria-label={`将分镜 ${k} 提炼为素材`}
                        title={`将分镜 ${k} 提炼为素材`}
                        onClick={() => analyze('panel', k)}
                      >
                        <Leaf />
                      </button>
                    </div>
                  </div>
                ))}
              </MeasuredMasonryGrid>
            </details>
          )}
          {project.status === 'ready' && (
            <div className="approval-card">
              <h2>最后，按你的标准看一遍。</h2>
              <div className="check-grid">
                {allChecks.map((c) => (
                  <label className="checkbox" key={c}>
                    <input
                      type="checkbox"
                      checked={checks.includes(c)}
                      onChange={(e) =>
                        setChecks(
                          e.target.checked
                            ? [...checks, c]
                            : checks.filter((x) => x !== c),
                        )
                      }
                    />
                    {c}
                  </label>
                ))}
              </div>
              <button
                className="primary"
                disabled={checks.length !== allChecks.length}
                onClick={() => action('accept', { checks })}
              >
                <Check />
                我已检查，收下成品
              </button>
            </div>
          )}
          {project.accepted && (
            <div className="delivery">
              <CircleCheck />
              <div>
                <h2>整套成品已保存到本地</h2>
                <small>{project.outputFolder}</small>
              </div>
              <a className="primary" href={project.bundleURL + '?download=1'}>
                <Download />
                下载整套
              </a>
              <button
                className="secondary"
                onClick={() => action('open-folder')}
              >
                <FolderOpen />
                打开文件夹
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
