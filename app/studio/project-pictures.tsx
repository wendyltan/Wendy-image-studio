import {
  BookOpen,
  Check,
  CircleCheck,
  Download,
  FolderOpen,
  Leaf,
  Pencil,
  RotateCcw,
} from 'lucide-react';
import type { Project } from './types';
import { MeasuredMasonryGrid, QaBadge } from './visuals';
import type { ProjectAction } from './recovery-cards';
import { PanelDecisionCard } from './recovery-cards';

export function ProjectPictures({
  project,
  disabled,
  action,
  setZoom,
  setEdit,
  setEditNote,
  analyze,
  checks,
  setChecks,
  allChecks,
  panelDecisionKey,
  decisionCoverFitNote,
  previousAttemptNoOutput,
}: {
  project: Project;
  disabled: boolean;
  action: ProjectAction;
  setZoom: (value: { url: string; title: string } | null) => void;
  setEdit: (value: { key: string; title: string } | null) => void;
  setEditNote: (value: string) => void;
  analyze: (kind: 'page' | 'panel' | 'sample', key: string | number) => void;
  checks: string[];
  setChecks: (value: string[]) => void;
  allChecks: string[];
  panelDecisionKey: string | null;
  decisionCoverFitNote: string | null;
  previousAttemptNoOutput: boolean;
}) {
  const panelForPageIssue = (
    pageNumber: number,
    issue: NonNullable<Picture['qa']['issueDetails']>[number],
  ) => {
    if (
      !['regenerate', 'recompose'].includes(issue.repairAction || '') ||
      !['blocking', 'review'].includes(issue.severity || '')
    )
      return null;
    const location = String(issue.location || '');
    const explicitPage = location.match(/第\s*(\d+)\s*页/);
    if (explicitPage && Number(explicitPage[1]) !== pageNumber) return null;
    const arabic = location.match(/第\s*(\d+)\s*格/);
    const chinese = location.match(/第?([一二三四五六七八九十两]+)格/);
    const ordinalValue = (word: string) => {
      const digits: Record<string, number> = {
        一: 1,
        二: 2,
        两: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        七: 7,
        八: 8,
        九: 9,
      };
      if (word === '十') return 10;
      if (word.startsWith('十')) return 10 + (digits[word[1]] || 0);
      if (word.endsWith('十')) return (digits[word[0]] || 0) * 10;
      return digits[word] || null;
    };
    const panelNumber = arabic
      ? Number(arabic[1])
      : chinese
        ? ordinalValue(chinese[1])
        : null;
    if (!panelNumber) return null;
    const panelCount =
      project.plan.pages.find((entry) => entry.number === pageNumber)?.panels
        .length || 0;
    return panelNumber > 0 && panelNumber <= panelCount
      ? `${pageNumber}-${panelNumber}`
      : null;
  };
  const sourceIssueGroups = (
    pageNumber: number,
    issues: NonNullable<Picture['qa']['issueDetails']>,
  ) => {
    const groups = new Map<
      string,
      NonNullable<Picture['qa']['issueDetails']>
    >();
    for (const issue of issues) {
      const text = `${issue.location || ''} ${issue.description || ''}`;
      const layoutCue = /文字框|文本框|文案|字幕|排字|排版|气泡|页码/.test(
        text,
      );
      const sourceCue =
        /人物|角色|身份|服装|发型|姿态|动作|视线|座椅|椅子|道具|物件|场景|手部|手脚|连续性|一致性/.test(
          text,
        ) ||
        /^(continuity|anatomy|character|pose|setting|prop|object|appearance)$/i.test(
          issue.category || '',
        );
      if (layoutCue || !sourceCue) continue;
      const panelKey = panelForPageIssue(pageNumber, issue);
      if (!panelKey) continue;
      groups.set(panelKey, [...(groups.get(panelKey) || []), issue]);
    }
    return [...groups.entries()].map(([panelKey, matchingIssues]) => ({
      panelKey,
      issues: matchingIssues,
    }));
  };
  const qaAction = (
    qa: {
      pass: boolean | null;
      status?: string;
      manualReviewRequired?: boolean;
    },
    page: boolean,
  ) => {
    const initial =
      (page &&
        (qa.manualReviewRequired === true ||
          qa.status === 'local_deterministic_preflight')) ||
      qa.pass === null ||
      ['deferred', 'unavailable'].includes(qa.status || '');
    return page
      ? initial
        ? '校对本页'
        : '重新校对'
      : initial
        ? '校对这一格'
        : '重新校对';
  };
  return (
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
          {project.pages.map((page) => (
            <div className="image-card" key={page.number}>
              <button
                className="image-button"
                aria-label={`点击查看第 ${page.number} 页大图`}
                onClick={() =>
                  setZoom({ url: page.url, title: `第 ${page.number} 页` })
                }
              >
                <img
                  src={page.url}
                  alt={`第${page.number}页`}
                  loading="lazy"
                  decoding="async"
                />
              </button>
              <div className="image-meta">
                <h3>
                  第 {page.number} 页{' '}
                  <QaBadge
                    qa={page.qa}
                    pageReviewPending={
                      page.qa.manualReviewRequired === true ||
                      page.qa.status === 'local_deterministic_preflight'
                    }
                  />
                </h3>
                <p>{page.qa.summary}</p>
                {page.layoutVerification?.manualConfirmationRequired && (
                  <p className="muted">
                    已重排，待人工确认遮挡是否解决。可点上方成稿查看大图；若仍有遮挡，请不要确认，可先重新校对并保留问题记录。系统不会自动重排或生图。
                  </p>
                )}
                {sourceIssueGroups(page.number, page.qa.issueDetails || []).map(
                  ({ panelKey, issues }) => {
                    const descriptions = issues
                      .map((issue) => String(issue.description || ''))
                      .filter(Boolean);
                    if (!descriptions.length) return null;
                    return (
                      <div className="page-issue-route" key={panelKey}>
                        <p>成稿问题：{descriptions.join('；')}</p>
                        <button
                          className="secondary"
                          disabled={disabled}
                          onClick={() => {
                            const [pageNumber, panelNumber] =
                              panelKey.split('-');
                            const items = descriptions
                              .map((description) => `- ${description}`)
                              .join('\n');
                            setEditNote(
                              `成稿校对指出以下分镜问题：\n${items}\n\n请只修改第 ${pageNumber} 页第 ${panelNumber} 格，逐项修复以上问题；保留该格其他人物、场景、动作、构图和风格，不改动其他分镜。`,
                            );
                            setEdit({
                              key: panelKey,
                              title: `修改分镜 ${panelKey}`,
                            });
                          }}
                        >
                          修改分镜 {panelKey}
                          {issues.length > 1 ? `（${issues.length}项）` : ''}
                        </button>
                      </div>
                    );
                  },
                )}
                <div className="inline-actions">
                  {project.accepted && (
                    <a href={page.url + '?download=1'}>
                      <Download />
                      保存
                    </a>
                  )}
                  {!project.accepted && (
                    <div className="page-card-actions">
                      <button
                        className="primary"
                        disabled={disabled}
                        onClick={() =>
                          action('review-page', { pageNumber: page.number })
                        }
                      >
                        <Check />
                        {qaAction(page.qa, true)}
                      </button>
                      {page.layoutVerification?.manualConfirmationRequired &&
                        page.qa.pass === true && (
                          <button
                            className="primary"
                            disabled={
                              disabled ||
                              !page.contentHash ||
                              page.projectVersion === undefined
                            }
                            onClick={() =>
                              action('confirm-page-layout', {
                                pageNumber: page.number,
                                projectVersion: page.projectVersion,
                                contentHash: page.contentHash,
                              })
                            }
                          >
                            <Check />
                            确认这一页排版
                          </button>
                        )}
                      <button
                        className="secondary page-layout-button"
                        disabled={disabled}
                        onClick={() =>
                          action('repair-page-layout', {
                            pageNumber: page.number,
                          })
                        }
                      >
                        <RotateCcw />
                        重排本页
                      </button>
                    </div>
                  )}
                  <button
                    className="tertiary-action"
                    aria-label={`将第 ${page.number} 页提炼为长期参考素材`}
                    onClick={() => analyze('page', page.number || 0)}
                  >
                    <Leaf />
                    提炼为素材
                  </button>
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
        <details
          className="source-panels"
          open={!project.pages.length || Boolean(panelDecisionKey)}
        >
          <summary>查看原始分镜 · 单格画面校对与局部修改</summary>
          <p className="muted">
            分镜校对只检查这一张原图的人物、动作和画面内容；成稿校对检查排版后的文字遮挡、页码与跨格连续性。顶部待决定提示会跳到对应分镜卡片，查看原图、质检记录并决定采用或修改。
          </p>
          <MeasuredMasonryGrid className="source-grid">
            {Object.entries(project.panels).map(([key, panel]) => (
              <div key={key} id={`source-panel-${key}`}>
                <button
                  className="image-button"
                  aria-label={`点击查看分镜 ${key} 大图`}
                  onClick={() =>
                    setZoom({ url: panel.url, title: `分镜 ${key}` })
                  }
                >
                  <img
                    src={panel.url}
                    alt={`分镜${key}`}
                    loading="lazy"
                    decoding="async"
                  />
                </button>
                <div className="panel-card-meta">
                  <div className="panel-card-heading">
                    <span>分镜 {key}</span>
                    <QaBadge qa={panel.qa} />
                  </div>
                  <div className="panel-review-row">
                    <button
                      className="primary"
                      disabled={disabled || !panel.url}
                      onClick={() => action('review-image', { key })}
                    >
                      <Check />
                      {qaAction(panel.qa, false)}
                    </button>
                    <button
                      className="secondary"
                      aria-label={`修改分镜 ${key}`}
                      title={`修改分镜 ${key}`}
                      onClick={() => setEdit({ key, title: `分镜 ${key}` })}
                    >
                      <Pencil />
                      修改
                    </button>
                  </div>
                  {panelDecisionKey === key &&
                    project.panelDecision?.state === 'required' && (
                      <PanelDecisionCard
                        project={project}
                        panelKey={key}
                        image={panel}
                        disabled={disabled}
                        action={action}
                        previousAttemptNoOutput={previousAttemptNoOutput}
                        coverFitNote={decisionCoverFitNote}
                        onEdit={(repairPrompt) => {
                          setEditNote(repairPrompt || '');
                          setEdit({ key, title: `分镜 ${key}` });
                        }}
                      />
                    )}
                  <button
                    className="tertiary-action"
                    aria-label={`将分镜 ${key} 提炼为素材`}
                    title={`将分镜 ${key} 提炼为素材`}
                    onClick={() => analyze('panel', key)}
                  >
                    <Leaf />
                    提炼为素材
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
            {allChecks.map((check) => (
              <label className="checkbox" key={check}>
                <input
                  type="checkbox"
                  checked={checks.includes(check)}
                  onChange={(event) =>
                    setChecks(
                      event.target.checked
                        ? [...checks, check]
                        : checks.filter((value) => value !== check),
                    )
                  }
                />
                {check}
              </label>
            ))}
          </div>
          <button
            className="primary"
            disabled={checks.length !== allChecks.length}
            onClick={() => action('accept', { checks })}
          >
            <Check />
            进入成品
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
          <button className="secondary" onClick={() => action('open-folder')}>
            <FolderOpen />
            打开文件夹
          </button>
        </div>
      )}
    </>
  );
}
