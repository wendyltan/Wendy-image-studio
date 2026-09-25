import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import {
  buildRevisionPrompt,
  normalizeChangeList,
} from '../server/revision-prompt.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const page = fs.readFileSync(path.join(appRoot, 'app/page.tsx'), 'utf8');
const projectPicturesSource = fs.readFileSync(
  path.join(appRoot, 'app/studio/project-pictures.tsx'),
  'utf8',
);
const studioDialogsSource = fs.readFileSync(
  path.join(appRoot, 'app/studio/studio-dialogs.tsx'),
  'utf8',
);
const projectControllerSource = fs.readFileSync(
  path.join(appRoot, 'app/studio/use-project-controller.ts'),
  'utf8',
);
const studioSources = [
  page,
  fs.readFileSync(path.join(appRoot, 'app/studio/project-view.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/panel-decision.ts'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/project-plan.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/project-samples.tsx'), 'utf8'),
  fs.readFileSync(
    path.join(appRoot, 'app/studio/project-pictures.tsx'),
    'utf8',
  ),
  fs.readFileSync(path.join(appRoot, 'app/studio/workflow-status.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/recovery-cards.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/visuals.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/workflow-utils.ts'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/studio-dialogs.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/asset-dialogs.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/document-dialog.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/dialog.tsx'), 'utf8'),
  fs.readFileSync(
    path.join(appRoot, 'app/studio/use-studio-controller.ts'),
    'utf8',
  ),
  fs.readFileSync(
    path.join(appRoot, 'app/studio/use-project-controller.ts'),
    'utf8',
  ),
].join('\n');
const css = fs.readFileSync(path.join(appRoot, 'app/globals.css'), 'utf8');
const panelDecisionModule = { exports: {} };
vm.runInNewContext(
  ts.transpile(
    fs.readFileSync(path.join(appRoot, 'app/studio/panel-decision.ts'), 'utf8'),
    { module: ts.ModuleKind.CommonJS },
  ),
  { exports: panelDecisionModule.exports },
);
const { panelCoverFitNote } = panelDecisionModule.exports;
const revisionPrefillModule = { exports: {} };
vm.runInNewContext(
  ts.transpile(
    fs.readFileSync(
      path.join(appRoot, 'app/studio/revision-prefill.ts'),
      'utf8',
    ),
    { module: ts.ModuleKind.CommonJS },
  ),
  { exports: revisionPrefillModule.exports },
);
const { sourcedPageRepairPrompt } = revisionPrefillModule.exports;
const visualsModule = { exports: {} };
vm.runInNewContext(
  ts.transpile(
    fs.readFileSync(path.join(appRoot, 'app/studio/visuals.tsx'), 'utf8'),
    { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  ),
  { exports: visualsModule.exports, require: () => ({}) },
);
const { qaLabel } = visualsModule.exports;

test('adopted recovered storyboard image stays explicitly awaiting proofing', () => {
  const manualReview = { pass: null, status: 'manual_review', summary: '', issues: [] };
  assert.equal(
    qaLabel(manualReview, { action: 'adopt_recovered' }).text,
    '已人工采用 · 待校对',
  );
  assert.equal(qaLabel(manualReview).text, '待修订');
  assert.equal(
    qaLabel({ ...manualReview, pass: true }, { action: 'adopt_recovered' }).text,
    '已校对',
  );
});

test('finished-card repair route uses a sourced single target and keeps failures in the dialog', () => {
  const oldPrefill = [
    '成稿校对指出以下分镜问题：',
    '- 咖啡机出液口不对',
    '',
    '请只修改第 5 页第 1 格，逐项修复以上问题；保留该格其他内容。',
  ].join('\n');
  assert.throws(
    () => normalizeChangeList(oldPrefill),
    (error) => error.code === 'UNRESOLVED_REVIEW_CRITIQUE',
    'the old finished-card prefill must reproduce the fail-closed critique error',
  );
  assert.match(
    projectPicturesSource,
    /page\.qa\.repairPrompt/,
    'a unique issue must be able to use the page QA repair prompt as its source',
  );
  assert.match(
    studioDialogsSource,
    /editError[\s\S]*role="alert"/,
    'revision failures must be visible inside the edit dialog',
  );
  assert.match(
    projectControllerSource,
    /name === 'revise-image'[\s\S]*setEditError/,
    'revision failures must stay attached to the open edit dialog',
  );
});

test('finished-card repair prefill is executable only for one sourced issue', () => {
  const issue = {
    description: '咖啡机出液口不对',
    repairAction: 'regenerate',
  };
  const group = { panelKey: '5-1', issues: [issue] };
  const repairPrompt = '修正咖啡机出液口：双出液嘴、两股独立液流、杯柄朝右。';
  const selected = sourcedPageRepairPrompt([group], [issue], repairPrompt);
  assert.equal(selected, repairPrompt);
  const prompt = buildRevisionPrompt(
    `单幅 3:2\n故事与连续性要求：${JSON.stringify({
      scene: '原木厨房咖啡角',
      characters: '温蒂',
      creatorPrompt: '日系生活插画',
    })}`,
    selected,
    { key: '5-1' },
  );
  assert.match(prompt, /双出液嘴/);
  assert.match(prompt, /两股独立液流/);
  assert.equal(
    sourcedPageRepairPrompt(
      [group, { panelKey: '5-2', issues: [{ description: '人物动作僵硬' }] }],
      [issue, { description: '人物动作僵硬', repairAction: 'regenerate' }],
      repairPrompt,
    ),
    '',
    'a page prompt must not be assumed to cover multiple issue groups',
  );
  assert.equal(
    sourcedPageRepairPrompt(
      [{ issues: [issue, { description: '人物动作僵硬' }] }],
      [issue],
      repairPrompt,
    ),
    '',
    'a page prompt must not be assumed to cover multiple defects',
  );
  assert.equal(sourcedPageRepairPrompt([group], [issue], ''), '');
  assert.equal(
    sourcedPageRepairPrompt(
      [group],
      [
        issue,
        { description: '排版文字遮挡主体', repairAction: 'recompose' },
      ],
      repairPrompt,
    ),
    '',
    'a hidden layout issue must prevent page-level repair prompt reuse',
  );
});

function rule(selector) {
  const start = css.indexOf(`${selector}{`);
  assert.notEqual(start, -1, `missing CSS rule: ${selector}`);
  const bodyStart = start + selector.length + 1;
  const end = css.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `unterminated CSS rule: ${selector}`);
  return css.slice(bodyStart, end);
}

test('source storyboard cards keep mixed-ratio images at natural card height', () => {
  const grid = rule('.source-grid');
  const card = rule('.source-grid>div');
  const image = rule('.image-button img');

  assert.match(studioSources, /className="source-grid"/);
  assert.match(grid, /display:grid/);
  assert.match(
    grid,
    /align-items:start/,
    'without an explicit start alignment, CSS Grid stretches cards to the row height',
  );
  assert.match(card, /align-self:start/);
  assert.match(image, /width:100%/);
  assert.match(image, /height:auto/);
  assert.doesNotMatch(image, /aspect-ratio/);
});

test('page and storyboard cards expose one clear action hierarchy with accessible routes', () => {
  const pictures = fs.readFileSync(
    path.join(appRoot, 'app/studio/project-pictures.tsx'),
    'utf8',
  );
  assert.match(
    pictures,
    /aria-label=\{`点击查看第 \$\{page\.number\} 页大图`\}/,
  );
  assert.match(pictures, /qaAction\(page\.qa, true\)/);
  assert.match(
    pictures,
    /className="secondary page-layout-button"[\s\S]*?重排本页/,
  );
  assert.match(
    pictures,
    /\{!project\.accepted && \([\s\S]*?repair-page-layout/,
  );
  assert.match(
    pictures,
    /className="panel-card-heading"[\s\S]*?<QaBadge qa=\{panel\.qa\} decision=\{panel\.decision\} \/>[\s\S]*?className="panel-review-row"[\s\S]*?className="primary"[\s\S]*?action\('review-image',\s*\{\s*key\s*\}\)/,
  );
  assert.match(
    pictures,
    /\['regenerate', 'recompose'\]\.includes\(issue\.repairAction/,
  );
  assert.match(pictures, /一二三四五六七八九十两/);
  assert.match(pictures, /const sourceIssueGroups =/);
  assert.match(pictures, /const layoutCue = \/文字框/);
  assert.match(pictures, /座椅\|椅子/);
  assert.match(
    pictures,
    /groups\.set\(panelKey, \[\.\.\.\(groups\.get\(panelKey\) \|\| \[\]\), issue\]\)/,
  );
  assert.match(pictures, /descriptions\.join\('；'\)/);
  assert.match(
    pictures,
    /descriptions\s*\.map\(\(description\)\s*=> `- \$\{description\}`\)/,
  );
  assert.match(pictures, /sourcedPageRepairPrompt\([\s\S]*page\.qa\.repairPrompt/);
  assert.match(
    pictures,
    /setEditNote\(\s*singleIssueRepairPrompt\s*\|\|\s*`成稿校对指出以下分镜问题/,
  );
  assert.match(pictures, /修改分镜 \{panelKey\}/);
  assert.match(
    pictures,
    /action\('confirm-page-layout', \{[\s\S]*?projectVersion: project\.version,[\s\S]*?contentHash: page\.contentHash/,
  );
  assert.match(pictures, /page\.qa\.manualReviewRequired === true[\s\S]*?确认这一页排版/);
  assert.match(pictures, /待人工复核：请先查看页面大图/);
  assert.match(pictures, /分镜校对只检查这一张原图/);
  assert.match(pictures, /核对本页当前文件及分镜来源无误/);
  assert.match(pictures, /className="tertiary-action"[\s\S]*?提炼为素材/);
  assert.match(css, /\.inline-actions \.primary,[\s\S]*?min-height:42px/);
  assert.match(css, /\.tertiary-action:focus-visible/);
  assert.match(
    css,
    /\.source-grid>div>\.panel-card-meta\{display:flex;flex-direction:column/,
  );
  assert.match(
    css,
    /\.source-grid \.panel-review-row\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/,
  );
  assert.match(
    css,
    /\.page-issue-route\{display:grid;gap:10px;margin:14px 0 16px/,
  );
  assert.match(
    css,
    /\.page-card-actions\{display:grid;grid-template-columns:minmax\(0,1fr\)/,
  );
  assert.match(css, /@media\(max-width:760px\)\{\.page-issue-route/);
});

test('pre-submission quota pause explains the zero-upload state and does not retry automatically', () => {
  const cards = fs.readFileSync(
    path.join(appRoot, 'app/studio/recovery-cards.tsx'),
    'utf8',
  );
  const status = fs.readFileSync(
    path.join(appRoot, 'app/studio/workflow-status.tsx'),
    'utf8',
  );
  assert.match(cards, /quotaSnapshotStop/);
  assert.match(cards, /附件上传 0、发送 0，原图未变化/);
  assert.match(cards, /系统不会自动重试/);
  assert.match(cards, /只有在额度已刷新后确认/);
  assert.match(status, /5\\s\*小时创作额度\.\*旧快照/);
});

test('login failures tell the user to log in manually and retry only the existing image', () => {
  const engine = fs.readFileSync(
    path.join(appRoot, 'server/engine.mjs'),
    'utf8',
  );
  const status = fs.readFileSync(
    path.join(appRoot, 'app/studio/workflow-status.tsx'),
    'utf8',
  );
  assert.match(engine, /CHATGPT_LOGIN_REQUIRED.{0,70}chatgpt-login-required/);
  assert.match(status, /请在 Chrome 登录 ChatGPT/);
  assert.match(status, /附件上传 0、发送 0/);
  assert.match(status, /不会自动登录、自动重试或创建新请求/);
  assert.match(
    status,
    /webFailureMessages\[String\(task\?\.errorCode \|\| project\.lastFailure\?\.kind/,
  );
  assert.match(
    status,
    /noOutput\s*\?\s*webFailureMessages\[webFailureCode\]\s*\|\|/,
  );
});

test('public panel media URL enables review and page review is a separate action', () => {
  const pictures = fs.readFileSync(
    path.join(appRoot, 'app/studio/project-pictures.tsx'),
    'utf8',
  );
  const api = fs.readFileSync(path.join(appRoot, 'server/server.mjs'), 'utf8');
  const engine = fs.readFileSync(
    path.join(appRoot, 'server/engine.mjs'),
    'utf8',
  );
  assert.match(api, /url:media\(displayFile\)/);
  assert.match(
    api,
    /action==='confirm-page-layout'\)await confirmPageLayout\(p,\{pageNumber:b\.pageNumber,projectVersion:b\.projectVersion,contentHash:b\.contentHash\}\)/,
  );
  assert.match(pictures, /disabled=\{disabled \|\| !panel\.url\}/);
  assert.match(pictures, /action\('review-image',\s*\{\s*key\s*\}\)/);
  assert.match(
    pictures,
    /action\('review-page',\s*\{\s*pageNumber: page\.number\s*\}\)/,
  );
  assert.match(engine, /export function reviewPage\(/);
  assert.match(api, /action==='review-page'\)reviewPage\(p,b\.pageNumber\)/);
  assert.match(engine, /function reviewPageQaOnly\(/);
  assert.match(
    engine,
    /qa\(p,pageFile,JSON\.stringify\(pageQaDefinition\(definition\)\)/,
  );
});

test('local page preflight remains pending manual review until page QA runs', () => {
  const pictures = fs.readFileSync(
    path.join(appRoot, 'app/studio/project-pictures.tsx'),
    'utf8',
  );
  const visuals = fs.readFileSync(
    path.join(appRoot, 'app/studio/visuals.tsx'),
    'utf8',
  );
  assert.match(
    pictures,
    /pageReviewPending=\{[\s\S]*?page\.qa\.manualReviewRequired === true[\s\S]*?page\.qa\.status === 'local_deterministic_preflight'/,
  );
  assert.match(
    pictures,
    /qa\.manualReviewRequired === true \|\|\s*qa\.status === 'local_deterministic_preflight'/,
  );
  assert.match(pictures, /qaAction\(page\.qa, true\)/);
  assert.match(pictures, /qaAction\(panel\.qa, false\)/);
  assert.match(visuals, /pageReviewPending[\s\S]*?待人工复核/);
});

test('completed browser lease does not become the current global warning', () => {
  const status = fs.readFileSync(
    path.join(appRoot, 'app/studio/workflow-status.tsx'),
    'utf8',
  );
  const server = fs.readFileSync(
    path.join(appRoot, 'server/server.mjs'),
    'utf8',
  );
  assert.match(status, /project\.pending\?\.ownedTabState/);
  assert.match(status, /const taskLeaseRelevant = \[/);
  assert.match(
    server,
    /function terminalTaskWebManifest\(p,task,lastFailure\)/,
  );
  assert.match(
    server,
    /request\.taskId!==task\.id\|\|request\.projectId!==p\.id/,
  );
  assert.match(
    server,
    /terminalManifest\.ownedTabState==='closed_verified'\|\|terminalManifest\.cleanupStatus==='closed'/,
  );
});

test('orphaned and cleanup-pending tabs remain explicitly unconfirmed', () => {
  const status = fs.readFileSync(
    path.join(appRoot, 'app/studio/workflow-status.tsx'),
    'utf8',
  );
  assert.match(
    status,
    /orphaned:\s*'专用标签页关闭未确认，可能仍留在 Chrome；本次没有自动接管或关闭其他标签页'/,
  );
  assert.match(status, /cleanup_pending:\s*'专用标签页关闭未确认/);
  assert.match(status, /\['close_unconfirmed', 'cleanup_pending', 'orphaned'\]/);
  assert.match(status, /pendingCleanupState === 'cleanup_pending'/);
  assert.doesNotMatch(status, /orphaned:\s*'[^']*已关闭并核实/);
});

test('retry UI requires a separate tab-closure acknowledgement and sends the exact id', () => {
  const recovery = fs.readFileSync(
    path.join(appRoot, 'app/studio/recovery-cards.tsx'),
    'utf8',
  );
  const server = fs.readFileSync(path.join(appRoot, 'server/server.mjs'), 'utf8');
  assert.match(recovery, /confirmOwnedTabClosed:\s*true/);
  assert.match(recovery, /ownedTabId:\s*oldOwnedTabId/);
  assert.match(recovery, /这只记录人工确认，不会标记系统已核实关闭/);
  assert.match(recovery, /oldOwnedTabName/);
  assert.match(recovery, /oldOwnedTabId\.slice\(-6\)/);
  assert.match(server, /decision:'user_ack'/);
  assert.match(server, /confirmOwnedTabClosed,ownedTabId/);
});

test('formal panel decision stays beside its source image and collapses when local cover can absorb a tiny ratio gap', () => {
  assert.match(studioSources, /className="panel-decision-card compact"/);
  assert.match(studioSources, /panel-decision-card urgent/);
  assert.match(studioSources, /panel-decision-strip/);
  assert.match(studioSources, /source-panel-\$\{key\}/);
  assert.match(studioSources, /查看原图与决定/);
  assert.match(studioSources, /原图质检记录/);
  assert.match(studioSources, /采用上一版/);
  assert.match(studioSources, /继续修改这一张/);
  assert.match(studioSources, /panelCoverFitNote/);
  assert.match(studioSources, /differencePercent > 1/);

  assert.match(
    css,
    /\.panel-decision-content \.inline-actions[^{]*\{[^}]*margin-top:10px/,
  );

  assert.match(
    css,
    /\.primary\{[^}]*background:var\(--button-primary\)[^}]*color:#fffdf6/,
  );
  assert.match(
    css,
    /\.secondary\{[^}]*background:#fffdf8[^}]*color:var\(--button-secondary-ink\)/,
  );
  assert.match(
    css,
    /\.danger-button\{[^}]*background:var\(--button-danger\)[^}]*color:#fffdf6/,
  );
  assert.match(
    css,
    /\.primary:focus-visible,\.secondary:focus-visible,\.danger-button:focus-visible\{/,
    'button focus styles must remain visible after the contrast adjustment',
  );
  assert.match(
    css,
    /\.primary:disabled,\.secondary:disabled,\.danger-button:disabled\{/,
    'disabled button states must remain explicit',
  );
});

test('small aspect warnings require file identity evidence and use the actual image dimensions', () => {
  const plan = { pages: [{ number: 2, layout: 'trio', panels: [{}, {}, {}] }] };
  const image = {
    integrity: { sha256: 'a'.repeat(64), width: 1193, height: 1319 },
    qa: {
      issues: ['rounded QA dimensions'],
      issueDetails: [{ category: 'aspect_ratio' }],
    },
  };
  assert.match(panelCoverFitNote(plan, '2-3', image), /0\.02%/);
  assert.equal(
    panelCoverFitNote(plan, '2-3', {
      ...image,
      integrity: { ...image.integrity, sha256: '' },
    }),
    null,
  );
  assert.equal(
    panelCoverFitNote(plan, '2-3', {
      ...image,
      integrity: { ...image.integrity, width: 1400 },
    }),
    null,
  );
  assert.equal(
    panelCoverFitNote(plan, '2-3', {
      ...image,
      qa: {
        issues: ['ratio', 'hand'],
        issueDetails: [{ category: 'aspect_ratio' }, { category: 'anatomy' }],
      },
    }),
    null,
  );
});

test('storyboard grids use measured row spans instead of CSS columns', () => {
  assert.match(studioSources, /function MeasuredMasonryGrid/);
  assert.match(studioSources, /new ResizeObserver/);
  assert.match(studioSources, /requestAnimationFrame/);
  assert.match(studioSources, /className="finished-grid"/);
  assert.match(studioSources, /className="source-grid"/);
  assert.match(
    css,
    /grid-auto-rows:\s*var\(--masonry-row-size\)/,
    'masonry grids need a fixed row unit for measured spans',
  );
  assert.match(
    css,
    /grid-row-end:\s*span var\(--masonry-row-span/,
    'each card needs its measured row span applied by CSS Grid',
  );
  assert.match(
    css,
    /\.source-grid\{[^}]*grid-template-columns:repeat\(3/,
    'desktop storyboard layout should retain three columns',
  );
  assert.match(
    css,
    /@media\(max-width:1150px\)\{\.source-grid\{grid-template-columns:repeat\(2/,
    'tablet storyboard layout should use two columns',
  );
  assert.match(
    css,
    /@media\(max-width:640px\)\{\.source-grid\{grid-template-columns:1fr/,
    'mobile storyboard layout should use one column',
  );
  assert.doesNotMatch(css, /\.source-grid\{[^}]*column-count:/);
});

test('deferred QA is visible as a non-passing state on finished cards', () => {
  assert.match(studioSources, /qa\.status\s*===\s*['"]deferred['"]/);
  assert.match(studioSources, /待检查\/未校对/);
  assert.match(css, /\.qa-label\.deferred\{/);
});

test('panel decisions prefill the manual repair prompt into image revision', () => {
  assert.match(
    studioSources,
    /onEdit=\{\(repairPrompt\) => \{\s*setEditNote\(repairPrompt \|\| ''\)/,
    'manual panel repair instructions should be shown in the existing edit dialog',
  );
  assert.match(
    studioSources,
    /onClick=\{\(\) => onEdit\(image\.qa\.repairPrompt\)\}/,
    'the panel decision must pass its precise repair prompt to the edit handler',
  );
  assert.match(
    studioSources,
    /action\('revise-image', \{ key: edit\.key, note: editNote \}\)/,
    'the prefilled repair instructions must be sent as the revision note',
  );
});

test('terminal workflow timing freezes safely and marks unreached browser stages', () => {
  assert.match(studioSources, /function terminalTime\(/);
  assert.match(
    studioSources,
    /task\?\.completedAt,[\s\S]*progress\?\.completedAt,[\s\S]*task\?\.lastProgressAt/,
    'terminal timing should prefer task completion and safe progress timestamps',
  );
  assert.match(studioSources, /state: 'not_reached'/);
  assert.match(studioSources, /stage\.state === 'not_reached'[\s\S]*'未到达'/);
  assert.doesNotMatch(
    studioSources,
    /fallbackEnd\s*=\s*Date\.now\(\)/,
    'terminal stage durations must not default to the wall clock',
  );
  assert.match(studioSources, /stageFallbackEnd/);
});

test('recovery and panel decisions use a compact locator while retaining the one-primary-action priority', () => {
  assert.match(studioSources, /const primaryCard = unknownResult/);
  assert.match(studioSources, /primaryCard === 'panel'/);
  assert.match(studioSources, /panelDecisionPrimary=\{panelDecisionRequired\}/);
  assert.match(studioSources, /previousAttemptNoOutput=\{noOutput\}/);
  assert.match(studioSources, /本次修改未取得新图，上一版原图仍保留/);
  assert.match(studioSources, /采用上一版/);
  assert.match(studioSources, /继续修改这一张/);
  assert.match(
    studioSources,
    /primaryCard === 'no-output'[\s\S]*NoOutputCard/,
    'known missing output should remain available when no previous panel decision exists',
  );
});

test('model usage details are collapsed while the aggregate remains visible', () => {
  assert.match(studioSources, /<section className="metrics-panel"/);
  assert.match(studioSources, /<details className="model-usage-details">/);
  assert.match(studioSources, /<summary>查看模型明细<\/summary>/);
  assert.doesNotMatch(
    studioSources,
    /<details className="model-usage-details" open>/,
    'model detail rows should be collapsed by default',
  );
  assert.match(css, /\.model-usage-details>summary\{/);
});

test('idle wall-clock updates are conditional and storyboard images are lazy decoded', () => {
  assert.match(studioSources, /function workflowClockActive\(/);
  assert.match(studioSources, /project\.busy/);
  assert.match(
    studioSources,
    /taskRunning = project\?\.currentTask\?\.status === 'running'/,
  );
  assert.match(
    studioSources,
    /project\.progress\?\.activeStage\?\.state === 'running'/,
  );
  assert.match(studioSources, /if \(!clockActive\) return;/);
  assert.match(
    studioSources,
    /alt="样张"[\s\S]{0,180}loading="lazy"[\s\S]{0,80}decoding="async"/,
  );
  assert.match(
    studioSources,
    /alt=\{`第\$\{(?:p|page)\.number\}页`\}[\s\S]{0,180}loading="lazy"[\s\S]{0,80}decoding="async"/,
  );
  assert.match(
    studioSources,
    /alt=\{`分镜\$\{(?:k|key)\}`\}[\s\S]{0,180}loading="lazy"[\s\S]{0,80}decoding="async"/,
  );
  assert.match(studioSources, /className="reference-grid"/);
  assert.match(
    studioSources,
    /src=\{a\.url\}[\s\S]*loading="lazy"[\s\S]*decoding="async"/,
  );
});
