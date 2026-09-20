import { Check, LoaderCircle, Pencil } from 'lucide-react';
import { layouts } from './constants';
import type { Plan, Project } from './types';
import type { ProjectAction } from './recovery-cards';

export function ProjectPlan({
  project,
  plan,
  history,
  setHistory,
  disabled,
  imageReady,
  imageMessage,
  note,
  setNote,
  action,
}: {
  project: Project;
  plan: Plan | null;
  history: number | null;
  setHistory: (value: number | null) => void;
  disabled: boolean;
  imageReady: boolean;
  imageMessage: string;
  note: string;
  setNote: (value: string) => void;
  action: ProjectAction;
}) {
  return (
    <div className="plan-area">
      {project.history.length > 0 && (
        <label className="history-select">
          方案版本
          <select
            value={history ?? 'current'}
            onChange={(event) =>
              setHistory(
                event.target.value === 'current' ? null : +event.target.value,
              )
            }
          >
            <option value="current">当前 v{project.version}</option>
            {project.history.map((item) => (
              <option key={item.version} value={item.version}>
                历史 v{item.version}
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
                {Object.entries(plan.continuity).map(([key, values]) => (
                  <div key={key}>
                    <h3>{key}</h3>
                    <ul>
                      {values.map((value, index) => (
                        <li key={index}>{value}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          </div>
          {plan.pages.map((page) => (
            <article className="plan-page" key={page.number}>
              <header>
                <span className="page-number">
                  {String(page.number).padStart(2, '0')}
                </span>
                <div>
                  <h2>{page.title}</h2>
                  <p>{page.purpose}</p>
                </div>
                <span className="layout-label">{layouts[page.layout]}</span>
              </header>
              <div className="time-note">{page.time}</div>
              <div className="panels">
                {page.panels.map((panel, index) => (
                  <div className="panel-plan" key={index}>
                    <span className="panel-label">第 {index + 1} 格</span>
                    <h3>{panel.scene}</h3>
                    <p>{panel.action}</p>
                    <dl>
                      <dt>人物与服装</dt>
                      <dd>
                        {panel.characters} · {panel.costume}
                      </dd>
                      <dt>视线与表情</dt>
                      <dd>
                        {panel.gaze} · {panel.expression}
                      </dd>
                    </dl>
                    {panel.caption && <blockquote>{panel.caption}</blockquote>}
                    <details>
                      <summary>查看画面细节</summary>
                      <p>{panel.prompt}</p>
                      <p>参考：{panel.references.join('、')}</p>
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
                onChange={(event) => setNote(event.target.value)}
                placeholder="写下要调整的页码、剧情或文案…"
              />
              <div className="actions">
                <button
                  className="secondary"
                  disabled={disabled || note.trim().length < 2}
                  onClick={() => action('revise-plan', {note})}
                >
                  <Pencil />
                  按意见修改
                </button>
                {project.status === 'review' && (
                  <button
                    className="primary"
                    disabled={disabled || !imageReady}
                    onClick={() =>
                      action('approve-plan', {hash: project.planHash})
                    }
                  >
                    <Check />
                    方案确认，可以开始生图
                  </button>
                )}
                {!imageReady && (
                  <small>
                    {imageMessage || '请先连接 Codex 和 Chrome Computer Use。'}
                  </small>
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
  );
}
