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

export function ProjectPictures({
  project,
  disabled,
  action,
  setZoom,
  setEdit,
  analyze,
  checks,
  setChecks,
  allChecks,
}: {
  project: Project;
  disabled: boolean;
  action: ProjectAction;
  setZoom: (value: { url: string; title: string } | null) => void;
  setEdit: (value: { key: string; title: string } | null) => void;
  analyze: (kind: 'page' | 'panel' | 'sample', key: string | number) => void;
  checks: string[];
  setChecks: (value: string[]) => void;
  allChecks: string[];
}) {
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
                onClick={() =>
                  setZoom({url: page.url, title: `第 ${page.number} 页`})
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
                  第 {page.number} 页 <QaBadge qa={page.qa} />
                </h3>
                <p>{page.qa.summary}</p>
                <div className="inline-actions">
                  {project.accepted && (
                    <a href={page.url + '?download=1'}>
                      <Download />
                      保存
                    </a>
                  )}
                  <button onClick={() => analyze('page', page.number || 0)}>
                    <Leaf />
                    提炼为素材
                  </button>
                  {!page.qa.pass &&
                    ['重新排版', '重新排字'].includes(page.nextStep || '') && (
                      <button
                        disabled={disabled}
                        onClick={() =>
                          action('repair-page-layout', {
                            pageNumber: page.number,
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
            {Object.entries(project.panels).map(([key, panel]) => (
              <div key={key}>
                <button
                  className="image-button"
                  onClick={() => setZoom({url: panel.url, title: `分镜 ${key}`})}
                >
                  <img
                    src={panel.url}
                    alt={`分镜${key}`}
                    loading="lazy"
                    decoding="async"
                  />
                </button>
                <div>
                  <span>分镜 {key}</span>
                  <QaBadge qa={panel.qa} />
                  <button
                    aria-label={`修改分镜 ${key}`}
                    title={`修改分镜 ${key}`}
                    onClick={() => setEdit({key, title: `分镜 ${key}`})}
                  >
                    <Pencil />
                  </button>
                  <button
                    aria-label={`将分镜 ${key} 提炼为素材`}
                    title={`将分镜 ${key} 提炼为素材`}
                    onClick={() => analyze('panel', key)}
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
            onClick={() => action('accept', {checks})}
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
          <button className="secondary" onClick={() => action('open-folder')}>
            <FolderOpen />
            打开文件夹
          </button>
        </div>
      )}
    </>
  );
}
