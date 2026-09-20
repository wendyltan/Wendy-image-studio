import { Check, Save, Sparkles, Upload } from 'lucide-react';
import type { AssetCandidate, Bootstrap, Proposal } from './types';
import { Dialog, type DialogSet } from './dialog';

type Usage = '本篇' | '常用参考' | '正式基线';

export function AssetDialogs({
  data,
  uploadOpen,
  closeManualUpload,
  waiting,
  stageManualAsset,
  manualCandidate,
  manualFile,
  manualCategory,
  setManualCategory,
  manualUsage,
  setManualUsage,
  manualName,
  setManualName,
  manualTags,
  setManualTags,
  manualDescription,
  setManualDescription,
  saveManualAsset,
  inspectManualAsset,
  upload,
  proposal,
  setProposal,
  applyWorld,
  setApplyWorld,
  applyWorkflow,
  setApplyWorkflow,
  applyProposal,
}: {
  data: Bootstrap | null;
  uploadOpen: boolean;
  closeManualUpload: () => void;
  waiting: boolean;
  stageManualAsset: (file: File) => void | Promise<void>;
  manualCandidate: AssetCandidate | null;
  manualFile: File | null;
  manualCategory: string;
  setManualCategory: DialogSet<string>;
  manualUsage: Usage;
  setManualUsage: DialogSet<Usage>;
  manualName: string;
  setManualName: DialogSet<string>;
  manualTags: string;
  setManualTags: DialogSet<string>;
  manualDescription: string;
  setManualDescription: DialogSet<string>;
  saveManualAsset: () => void | Promise<void>;
  inspectManualAsset: () => void | Promise<void>;
  upload: (file: File) => void | Promise<void>;
  proposal: Proposal | null;
  setProposal: DialogSet<Proposal | null>;
  applyWorld: boolean;
  setApplyWorld: DialogSet<boolean>;
  applyWorkflow: boolean;
  setApplyWorkflow: DialogSet<boolean>;
  applyProposal: () => void | Promise<void>;
}) {
  return (
    <>
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
                onChange={(event) =>
                  event.target.files?.[0] && stageManualAsset(event.target.files[0])
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
                        onChange={(event) => setManualCategory(event.target.value)}
                      >
                        {data?.categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      用途
                      <select
                        value={manualUsage}
                        onChange={(event) =>
                          setManualUsage(event.target.value as Usage)
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
                      onChange={(event) => setManualName(event.target.value)}
                    />
                  </label>
                  <label>
                    标签（用逗号分隔）
                    <input
                      value={manualTags}
                      onChange={(event) => setManualTags(event.target.value)}
                      placeholder="例如：高丸子头、通勤、咖啡"
                    />
                  </label>
                  <label>
                    说明
                    <textarea
                      value={manualDescription}
                      maxLength={500}
                      onChange={(event) => setManualDescription(event.target.value)}
                      placeholder="这张素材适合在什么情况下复用？"
                    />
                  </label>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={waiting || !manualCategory || !manualName.trim()}
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
                  {data?.categories.find((category) => category.id === proposal.category)?.label}
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
                    onChange={(event) => setApplyWorld(event.target.checked)}
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
                    onChange={(event) => setApplyWorkflow(event.target.checked)}
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
    </>
  );
}
