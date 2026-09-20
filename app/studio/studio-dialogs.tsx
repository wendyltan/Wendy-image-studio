'use client';
import {
  Check,
  CircleCheck,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { effortLabels } from './constants';
import type {
  AssetCandidate,
  Bootstrap,
  Doc,
  Model,
  Project,
  Proposal,
  Story,
} from './types';
import { AssetDialogs } from './asset-dialogs';
import {
  Dialog,
  type DeleteTarget,
  type DialogSet,
  type EditTarget,
  type Zoom,
} from './dialog';
import { DocumentDialog } from './document-dialog';
import type { ProjectAction } from './recovery-cards';

export function StudioDialogs({
  data,
  toast,
  zoom,
  setZoom,
  edit,
  setEdit,
  editNote,
  setEditNote,
  action,
  story,
  setStory,
  setDeleteTarget,
  doc,
  setDoc,
  docText,
  setDocText,
  suggestNote,
  setSuggestNote,
  suggestDoc,
  saveDoc,
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
  modelOpen,
  setModelOpen,
  project,
  model,
  setModel,
  models,
  selectedModel,
  effort,
  setEffort,
  switchProjectModel,
  titleOpen,
  setTitleOpen,
  titleDraft,
  setTitleDraft,
  renameProject,
  deleteTarget,
  confirmTitle,
  setConfirmTitle,
  remove,
}: {
  data: Bootstrap | null;
  toast: string;
  zoom: Zoom | null;
  setZoom: DialogSet<Zoom | null>;
  edit: EditTarget | null;
  setEdit: DialogSet<EditTarget | null>;
  editNote: string;
  setEditNote: DialogSet<string>;
  action: ProjectAction;
  story: Story | null;
  setStory: DialogSet<Story | null>;
  setDeleteTarget: DialogSet<DeleteTarget | null>;
  doc: Doc | null;
  setDoc: DialogSet<Doc | null>;
  docText: string;
  setDocText: DialogSet<string>;
  suggestNote: string;
  setSuggestNote: DialogSet<string>;
  suggestDoc: () => void | Promise<void>;
  saveDoc: () => void | Promise<void>;
  uploadOpen: boolean;
  closeManualUpload: () => void;
  waiting: boolean;
  stageManualAsset: (file: File) => void | Promise<void>;
  manualCandidate: AssetCandidate | null;
  manualFile: File | null;
  manualCategory: string;
  setManualCategory: DialogSet<string>;
  manualUsage: '本篇' | '常用参考' | '正式基线';
  setManualUsage: DialogSet<'本篇' | '常用参考' | '正式基线'>;
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
  modelOpen: boolean;
  setModelOpen: DialogSet<boolean>;
  project: Project | null;
  model: string;
  setModel: DialogSet<string>;
  models: Model[];
  selectedModel?: Model;
  effort: string;
  setEffort: DialogSet<string>;
  switchProjectModel: () => void | Promise<void>;
  titleOpen: boolean;
  setTitleOpen: DialogSet<boolean>;
  titleDraft: string;
  setTitleDraft: DialogSet<string>;
  renameProject: () => void | Promise<void>;
  deleteTarget: DeleteTarget | null;
  confirmTitle: string;
  setConfirmTitle: DialogSet<string>;
  remove: () => void | Promise<void>;
}) {
  return (
    <>
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
            onChange={(event) => setEditNote(event.target.value)}
          />
          <button
            className="primary"
            onClick={() => action('revise-image', { key: edit.key, note: editNote })}
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
            {story.pages.map((page, index) => (
              <button
                key={page.url}
                onClick={() =>
                  setZoom({
                    url: page.url,
                    title: `${story.title} · 第 ${index + 1} 页`,
                  })
                }
              >
                <img
                  src={page.url}
                  alt={`第${index + 1}页`}
                  loading="lazy"
                  decoding="async"
                />
                <span>第 {index + 1} 页</span>
              </button>
            ))}
          </div>
        </dialog>
      )}
      <DocumentDialog
        doc={doc}
        setDoc={setDoc}
        docText={docText}
        setDocText={setDocText}
        suggestNote={suggestNote}
        setSuggestNote={setSuggestNote}
        suggestDoc={suggestDoc}
        saveDoc={saveDoc}
      />
      <AssetDialogs
        data={data}
        uploadOpen={uploadOpen}
        closeManualUpload={closeManualUpload}
        waiting={waiting}
        stageManualAsset={stageManualAsset}
        manualCandidate={manualCandidate}
        manualFile={manualFile}
        manualCategory={manualCategory}
        setManualCategory={setManualCategory}
        manualUsage={manualUsage}
        setManualUsage={setManualUsage}
        manualName={manualName}
        setManualName={setManualName}
        manualTags={manualTags}
        setManualTags={setManualTags}
        manualDescription={manualDescription}
        setManualDescription={setManualDescription}
        saveManualAsset={saveManualAsset}
        inspectManualAsset={inspectManualAsset}
        upload={upload}
        proposal={proposal}
        setProposal={setProposal}
        applyWorld={applyWorld}
        setApplyWorld={setApplyWorld}
        applyWorkflow={applyWorkflow}
        setApplyWorkflow={setApplyWorkflow}
        applyProposal={applyProposal}
      />
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
                onChange={(event) => {
                  setModel(event.target.value);
                  const selected = models.find((item) => item.id === event.target.value);
                  if (selected) setEffort(selected.defaultReasoningEffort);
                }}
              >
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
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
                onChange={(event) => setEffort(event.target.value)}
              >
                {(selectedModel?.reasoningEfforts || []).map((value) => (
                  <option key={value} value={value}>
                    {effortLabels[value] || value}
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
            onChange={(event) => setTitleDraft(event.target.value)}
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
            onChange={(event) => setConfirmTitle(event.target.value)}
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
    </>
  );
}
