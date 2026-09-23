import { Check, FolderOpen, Pencil, RotateCcw } from 'lucide-react';
import type { Picture, Project } from './types';

export type ProjectAction = (name: string, body?: unknown) => void;

export function RecoveryCard({ action }: { action: ProjectAction }) {
  return (
    <div className="recovery-card">
      <div>
        <h3>先检查已保存图片</h3>
        <p>
          这个检查只在本地查找并挂接已经保存的图片，不调用模型、不重新生图，也不会消耗一次生图机会。
        </p>
      </div>
      <div>
        <button className="secondary" onClick={() => action('recover-image')}>
          检查已保存图片（本地，不调用模型）
        </button>
      </div>
    </div>
  );
}

export function NoOutputCard({
  project,
  disabled,
  action,
}: {
  project: Project;
  disabled: boolean;
  action: ProjectAction;
}) {
  const target =
      project.lastFailure?.key || project.currentTask?.target || '当前图片',
    retryToken =
      project.currentTask?.id ||
      `${project.revision ?? project.version}:${target}`;
  const uploadUnavailable =
    project.lastFailure?.kind === 'browser-upload-unavailable' ||
    project.currentTask?.errorCode === 'browser-upload-unavailable';
  const attachmentExpected =
    project.currentTask?.attachmentExpectedCount ?? null;
  const attachmentObserved =
    project.currentTask?.attachmentObservedCount ?? null;
  const postUploadPreSubmit =
    attachmentExpected !== null &&
    attachmentObserved === attachmentExpected &&
    project.currentTask?.attachmentPending === false &&
    project.currentTask?.sendEnabled === true &&
    project.currentTask?.status === 'failed_no_output';
  const quotaSnapshotStop =
    project.currentTask?.errorCode === 'USAGE_LIMIT_BEFORE_START' ||
    (project.currentTask?.accepted === true &&
      project.currentTask?.submitted === false &&
      project.currentTask?.referenceCount === 0 &&
      /5\s*小时创作额度.*旧快照|额度快照/.test(project.message || ''));
  return (
    <div className="recovery-card">
      <div>
        <h3>
          {quotaSnapshotStop
            ? '额度检查未完成，原分镜仍保留'
            : postUploadPreSubmit
              ? '附件已核实，但发送前失败，上一版原图仍保留'
              : uploadUnavailable
                ? '附件上传未完成，上一版原图仍保留'
                : '本次没有取得图片，可重试这一张'}
        </h3>
        <p>
          {quotaSnapshotStop
            ? `${target} 本次修改停在额度检查：5 小时额度只返回旧快照，附件上传 0、发送 0，原图未变化。系统不会自动重试；先确认额度已刷新，再由你决定是否发起新的单格修改。`
            : postUploadPreSubmit
              ? `${target} 已观察到 ${attachmentObserved}/${attachmentExpected} 个附件，发送前失败，未发送消息，也未生成新图。系统不会自行重发；修复发送阶段后可只重试这一张。`
              : uploadUnavailable
                ? `${target} 的附件入口没有打开浏览器文件选择器；本次未上传附件、未发送消息，也未生成新图。系统不会自行重试，修复附件入口后可只重试这一张。`
                : `${target} 没有保存到本地，也没有可找回的原图。系统不会自行重试；重新生成会发起一次新的生图并消耗创作额度。`}
        </p>
      </div>
      <div>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => {
            if (
              confirm(
                quotaSnapshotStop
                  ? '本次没有上传附件或发送图片请求，原图仍保留。只有在额度已刷新后确认，才会发起一条新的单格修改请求。继续吗？'
                  : '确认重新生成这一张吗？这会发起一次新的生图，并消耗创作额度。',
              )
            )
              action('retry-missing', {
                confirmNoImage: true,
                idempotencyKey: `retry:${project.id}:${retryToken}:${target}`,
              });
          }}
        >
          <RotateCcw />
          {quotaSnapshotStop ? '额度刷新后再决定是否修改' : '重新生成这一张'}
        </button>
      </div>
    </div>
  );
}

export function UnknownResultCard({
  project,
  disabled,
  action,
}: {
  project: Project;
  disabled: boolean;
  action: ProjectAction;
}) {
  const target =
      project.imageRetry?.target || project.currentTask?.target || '当前图片',
    retryToken =
      project.currentTask?.id ||
      `${project.revision ?? project.version}:${target}`;
  return (
    <div className="recovery-card">
      <div>
        <h3>这张图片的结果仍无法确认</h3>
        <p>
          {target}{' '}
          在连接中断前可能已经由远端生成，但本地没有可用原图。系统不会把它当成明确失败，也不会自行重试。
        </p>
      </div>
      <div>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => {
            if (
              confirm(
                '这张图片的远端结果仍无法确认。仍然重新生成可能产生重复图片并消耗创作额度，确定继续吗？',
              )
            )
              action('retry-missing', {
                confirmUnknownResult: true,
                idempotencyKey: `retry-unknown:${project.id}:${retryToken}:${target}`,
              });
          }}
        >
          <RotateCcw />
          仍然重新生成这一张
        </button>
      </div>
    </div>
  );
}

export function ReviewCard({
  target,
  disabled,
  action,
}: {
  target: { key: string; title: string; image: Picture };
  disabled: boolean;
  action: ProjectAction;
}) {
  return (
    <div className="recovery-card">
      <img
        className="recovery-preview"
        src={target.image.url}
        alt={`${target.title}已保存的原图`}
      />
      <div>
        <h3>原图已保存，可以只重新校对</h3>
        <p>{target.title} 不会重新生图；只使用已保存原图重新进行画面检查。</p>
      </div>
      <div>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => action('review-image', { key: target.key })}
        >
          <Check />
          重新检查这张图
        </button>
      </div>
    </div>
  );
}

export function PanelDecisionCard({
  project,
  panelKey,
  image,
  disabled,
  action,
  previousAttemptNoOutput = false,
  coverFitNote = null,
  onEdit,
}: {
  project: Project;
  panelKey: string;
  image: Picture;
  disabled: boolean;
  action: ProjectAction;
  previousAttemptNoOutput?: boolean;
  coverFitNote?: string | null;
  onEdit: (repairPrompt?: string) => void;
}) {
  const revision = project.revision ?? project.version,
    issueIds = (image.qa.issueDetails || [])
      .filter(
        (issue) =>
          issue.id && ['blocking', 'review'].includes(issue.severity || ''),
      )
      .map((issue) => String(issue.id)),
    ready = Boolean(project.planHash && image.artifactId && image.contentHash);
  const content = (
    <>
      <p>
        {previousAttemptNoOutput &&
          '本次修改未取得新图，上一版原图仍保留。'}{' '}
        {coverFitNote ||
          (previousAttemptNoOutput
            ? '请查看原图和问题，再决定是否采用。'
            : `第 ${panelKey.split('-')[0]} 页第 ${panelKey.split('-')[1]} 格的模型质检没有通过。请查看原图和问题，再决定是否采用或修改。`)}
      </p>
      <div className="panel-decision-review">
        <img
          src={image.url}
          alt={`分镜 ${panelKey} 当前保留的原图`}
          loading="lazy"
          decoding="async"
        />
        <div>
          <strong>原图质检记录</strong>
          <p>{image.qa.summary}</p>
          {image.qa.issues.length > 0 && (
            <small>检查问题：{image.qa.issues.join('；')}</small>
          )}
        </div>
      </div>
      <div className="inline-actions">
        <button
          className="primary"
          disabled={disabled || !ready}
          onClick={() => {
            if (
              confirm(
                '确认采用当前正式分镜？模型质检失败结论会保留；这不会重新生图，之后仍会继续页面和整篇校对。',
              )
            )
              action('panel-decision', {
                panelKey,
                expectedRevision: revision,
                planHash: project.planHash,
                artifactId: image.artifactId,
                contentHash: image.contentHash,
                decision: 'accept_current',
                acknowledgedIssueIds: issueIds,
                continueProduction: true,
                idempotencyKey: `panel:${project.id}:${revision}:${image.artifactId}:accept_current`,
              });
          }}
        >
          <Check />
          {previousAttemptNoOutput ? '采用上一版' : '采用当前图片'}
        </button>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => onEdit(image.qa.repairPrompt)}
        >
          <Pencil />
          {previousAttemptNoOutput ? '继续修改这一张' : '修改这一张'}
        </button>
      </div>
      {!ready && (
        <small>当前图片版本信息尚未刷新，请重新打开这篇作品后再决定。</small>
      )}
    </>
  );
  return coverFitNote ? (
    <details className="panel-decision-card compact">
      <summary>
        {previousAttemptNoOutput
          ? '修改未取得新图 · 查看原图与决定'
          : `分镜 ${panelKey} 待你决定 · 查看原图与质检`}
      </summary>
      <div className="panel-decision-content">{content}</div>
    </details>
  ) : (
    <div className="approval-card panel-decision-card urgent">
      <h3>分镜 {panelKey} 需要你来决定</h3>
      {content}
    </div>
  );
}

export function SampleDecisionNotice({ project }: { project: Project }) {
  const waiting = project.samplesDecision?.sampleIndexes || [];
  return (
    <div className="approval-card">
      <h2>样张需要你来决定</h2>
      <p>
        {waiting.length
          ? `第 ${waiting.join('、')} 张样张仍有检查建议。你可以采用当前图片，或只重新生成这一张。`
          : '请明确决定当前样张是否采用。'}{' '}
        这里不会自行继续制作正式画稿。
      </p>
      <small>
        “采用当前图片”只记录你的决定，不调用模型；“修改这一张”会开始一次新的样张生图，并消耗相应创作额度。
      </small>
    </div>
  );
}

export function SampleDecisionActions({
  project,
  sample,
  sampleIndex,
  disabled,
  action,
}: {
  project: Project;
  sample: Picture;
  sampleIndex: number;
  disabled: boolean;
  action: ProjectAction;
}) {
  const revision = project.revision ?? project.version,
    issueIds = (sample.qa.issueDetails || [])
      .filter(
        (issue) =>
          issue.id && ['blocking', 'review'].includes(issue.severity || ''),
      )
      .map((issue) => String(issue.id)),
    base = {
      expectedRevision: revision,
      planHash: project.planHash,
      artifactId: sample.artifactId,
      contentHash: sample.contentHash,
      sampleIndex,
      continueProduction: true,
    };
  const command = (decision: 'accept_current' | 'regenerate_current') => ({
    ...base,
    decision,
    acknowledgedIssueIds: issueIds,
    idempotencyKey: `preview:${project.id}:${revision}:${sample.artifactId || sampleIndex}:${decision}`,
  });
  return (
    <div>
      <small>
        {sample.qa.issues.length
          ? `检查建议：${sample.qa.issues.join('；')}`
          : '请查看当前图片后，再决定是否采用。'}
      </small>
      <div className="inline-actions">
        <button
          className="primary"
          disabled={disabled}
          onClick={() => {
            if (
              confirm(
                '确认采用当前图片？这会记录你已查看的检查建议，不会调用模型或开始正式画稿。',
              )
            )
              action('preview-decision', command('accept_current'));
          }}
        >
          <Check />
          采用当前图片
        </button>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => {
            if (
              confirm(
                '重新生成这一张样张会发起一次新的生图，并消耗创作额度。确定继续吗？',
              )
            )
              action('preview-decision', command('regenerate_current'));
          }}
        >
          <Pencil />
          修改这一张
        </button>
        <button
          aria-label="查看本地原图"
          onClick={() => action('open-folder')}
          title="查看本地原图"
        >
          <FolderOpen />
        </button>
      </div>
    </div>
  );
}
