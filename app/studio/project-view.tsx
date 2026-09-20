import {
  AlertCircle,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Images,
  Leaf,
} from 'lucide-react';
import type { FailureClassification, Plan, Picture, Project } from './types';
import { ProjectPictures } from './project-pictures';
import { ProjectPlan } from './project-plan';
import { ProjectSamples } from './project-samples';
import {
  ModelUsagePanel,
  WorkflowStatus,
} from './workflow-status';
import {
  NoOutputCard,
  PanelDecisionCard,
  RecoveryCard,
  ReviewCard,
  UnknownResultCard,
} from './recovery-cards';
import type { ProjectAction } from './recovery-cards';

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
  failureClassification,
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
  failureClassification?: FailureClassification | null;
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
        ['pending', 'unavailable', 'recovered_pending_review', 'manual_review'].includes(
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
        failureClassification={failureClassification}
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
        <ProjectPlan
          project={project}
          plan={plan}
          history={history}
          setHistory={setHistory}
          disabled={disabled}
          imageReady={imageReady}
          imageMessage={imageMessage}
          note={note}
          setNote={setNote}
          action={action}
        />
      )}
      {view === 'samples' && (
        <ProjectSamples
          project={project}
          disabled={disabled}
          action={action}
          setZoom={setZoom}
          setEdit={setEdit}
          analyze={analyze}
        />
      )}
      {view === 'pictures' && (
        <ProjectPictures
          project={project}
          disabled={disabled}
          action={action}
          setZoom={setZoom}
          setEdit={setEdit}
          analyze={analyze}
          checks={checks}
          setChecks={setChecks}
          allChecks={allChecks}
        />
      )}
    </>
  );
}
