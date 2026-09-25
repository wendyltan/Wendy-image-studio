'use client';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Images,
  Leaf,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { effortLabels, presets, statuses } from './studio/constants';
import { ProjectView } from './studio/project-view';
import { StudioDialogs } from './studio/studio-dialogs';
import { observedAccountText, resetText } from './studio/workflow-utils';
import { useStudioController } from './studio/use-studio-controller';

export default function Studio() {
  const {
    data,
    section,
    setSection,
    current,
    project,
    failureClassification,
    idea,
    setIdea,
    pages,
    setPages,
    special,
    setSpecial,
    cat,
    setCat,
    xiaolin,
    setXiaolin,
    model,
    setModel,
    effort,
    setEffort,
    preset,
    setPreset,
    waiting,
    restarting,
    error,
    setError,
    toast,
    note,
    setNote,
    checks,
    setChecks,
    view,
    setView,
    history,
    setHistory,
    now,
    zoom,
    setZoom,
    edit,
    setEdit,
    editError,
    editNote,
    setEditNote,
    story,
    setStory,
    settingTab,
    setSettingTab,
    modelOpen,
    setModelOpen,
    titleOpen,
    setTitleOpen,
    titleDraft,
    setTitleDraft,
    deleteTarget,
    setDeleteTarget,
    confirmTitle,
    setConfirmTitle,
    models,
    selectedModel,
    plan,
    primary,
    used,
    remaining,
    weeklyUsed,
    weeklyRemaining,
    refreshAccount,
    select,
    newStory,
    create,
    restartStudio,
    action,
    switchProjectModel,
    renameProject,
    remove,
    proposal,
    setProposal,
    applyWorld,
    setApplyWorld,
    applyWorkflow,
    setApplyWorkflow,
    uploadOpen,
    setUploadOpen,
    manualCandidate,
    manualFile,
    manualCategory,
    setManualCategory,
    manualName,
    setManualName,
    manualTags,
    setManualTags,
    manualDescription,
    setManualDescription,
    manualUsage,
    setManualUsage,
    assetSearch,
    setAssetSearch,
    assetCategoryFilter,
    setAssetCategoryFilter,
    assetUsageFilter,
    setAssetUsageFilter,
    assetResults,
    assetGroup,
    setAssetGroup,
    assets,
    analyze,
    upload,
    stageManualAsset,
    inspectManualAsset,
    closeManualUpload,
    saveManualAsset,
    searchLibraryAssets,
    clearAssetSearch,
    applyProposal,
    doc,
    setDoc,
    docText,
    setDocText,
    suggestNote,
    setSuggestNote,
    openDoc,
    suggestDoc,
    saveDoc,
  } = useStudioController();
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
        <button className="new-story" onClick={newStory}>
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
        <div className="sidebar-foot">
          <small>作品保存在这台电脑</small>
        </div>
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
                {weeklyRemaining === null ? '暂不可用' : `${weeklyRemaining}%`}
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
                failureClassification={failureClassification}
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
                              <button key={d.path} onClick={() => openDoc(d)}>
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
      <StudioDialogs
        data={data}
        toast={toast}
        zoom={zoom}
        setZoom={setZoom}
        edit={edit}
        setEdit={setEdit}
        editError={editError}
        editNote={editNote}
        setEditNote={setEditNote}
        action={action}
        story={story}
        setStory={setStory}
        setDeleteTarget={setDeleteTarget}
        doc={doc}
        setDoc={setDoc}
        docText={docText}
        setDocText={setDocText}
        suggestNote={suggestNote}
        setSuggestNote={setSuggestNote}
        suggestDoc={suggestDoc}
        saveDoc={saveDoc}
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
        modelOpen={modelOpen}
        setModelOpen={setModelOpen}
        project={project}
        model={model}
        setModel={setModel}
        models={models}
        selectedModel={selectedModel}
        effort={effort}
        setEffort={setEffort}
        switchProjectModel={switchProjectModel}
        titleOpen={titleOpen}
        setTitleOpen={setTitleOpen}
        titleDraft={titleDraft}
        setTitleDraft={setTitleDraft}
        renameProject={renameProject}
        deleteTarget={deleteTarget}
        confirmTitle={confirmTitle}
        setConfirmTitle={setConfirmTitle}
        remove={remove}
      />
    </div>
  );
}
