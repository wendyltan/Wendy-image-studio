import { Check, Leaf, Pencil } from 'lucide-react';
import type { Project } from './types';
import { QaBadge } from './visuals';
import {
  SampleDecisionActions,
  SampleDecisionNotice,
  type ProjectAction,
} from './recovery-cards';

export function ProjectSamples({
  project,
  disabled,
  action,
  setZoom,
  setEdit,
  analyze,
}: {
  project: Project;
  disabled: boolean;
  action: ProjectAction;
  setZoom: (value: { url: string; title: string } | null) => void;
  setEdit: (value: { key: string; title: string } | null) => void;
  analyze: (kind: 'page' | 'panel' | 'sample', key: string | number) => void;
}) {
  return (
    <>
      <div className="section-intro">
        <h2>先确认人物和主场景</h2>
        <p>样张通过后再画整篇，避免方向错误造成重复生图。</p>
      </div>
      <div className="sample-grid">
        {[0, 1].map((index) => {
          const sample = project.samples[index];
          const needsDecision =
            project.status === 'samples_decision' &&
            (project.samplesDecision?.sampleIndexes.includes(index + 1) ||
              sample?.qa.pass !== true);
          return (
            <div className="image-card" key={index}>
              {sample ? (
                <>
                  <button
                    className="image-button"
                    onClick={() => setZoom({url: sample.url, title: '样张'})}
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
                      {index ? '02 · 主场景' : '01 · 人物脸部'}{' '}
                      <QaBadge qa={sample.qa} />
                    </h3>
                    <p>{sample.qa.summary}</p>
                    {needsDecision ? (
                      <SampleDecisionActions
                        project={project}
                        sample={sample}
                        sampleIndex={index + 1}
                        disabled={disabled}
                        action={action}
                      />
                    ) : (
                      <div className="inline-actions">
                        <button
                          onClick={() =>
                            setEdit({key: `sample-${index + 1}`, title: '样张'})
                          }
                        >
                          <Pencil />
                          修改
                        </button>
                        <button onClick={() => analyze('sample', index)}>
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
      )}
      {project.status === 'samples_review' && (
        <div className="approval-card">
          <h2>样张都已准备好</h2>
          <p>确认后才会开始正式画稿。</p>
          <button
            className="primary"
            disabled={disabled}
            onClick={() => action('approve-samples', {hash: project.planHash})}
          >
            <Check />
            样张确认，继续整篇
          </button>
        </div>
      )}
    </>
  );
}
