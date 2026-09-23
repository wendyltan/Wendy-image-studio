import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const appRoot = path.resolve(import.meta.dirname, '..');
const page = fs.readFileSync(path.join(appRoot, 'app/page.tsx'), 'utf8');
const studioSources = [
  page,
  fs.readFileSync(path.join(appRoot, 'app/studio/project-view.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/project-plan.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/project-samples.tsx'), 'utf8'),
  fs.readFileSync(path.join(appRoot, 'app/studio/project-pictures.tsx'), 'utf8'),
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
  const pictures = fs.readFileSync(path.join(appRoot, 'app/studio/project-pictures.tsx'), 'utf8');
  assert.match(pictures, /aria-label=\{`点击查看第 \$\{page\.number\} 页大图`\}/);
  assert.match(pictures, /qaAction\(page\.qa, true\)/);
  assert.match(pictures, /className="secondary page-layout-button"[\s\S]*?重排本页/);
  assert.match(pictures, /\{!project\.accepted && \([\s\S]*?repair-page-layout/);
  assert.match(pictures, /className="panel-card-heading"[\s\S]*?<QaBadge qa=\{panel\.qa\} \/>[\s\S]*?className="panel-review-row"[\s\S]*?className="primary"[\s\S]*?action\('review-image', \{key\}\)/);
  assert.match(pictures, /\['regenerate', 'recompose'\]\.includes\(issue\.repairAction/);
  assert.match(pictures, /一二三四五六七八九十两/);
  assert.match(pictures, /const sourceIssueGroups =/);
  assert.match(pictures, /const layoutCue = \/文字框/);
  assert.match(pictures, /座椅\|椅子/);
  assert.match(pictures, /groups\.set\(panelKey, \[\.\.\.\(groups\.get\(panelKey\) \|\| \[\]\), issue\]\)/);
  assert.match(pictures, /descriptions\.join\('；'\)/);
  assert.match(pictures, /descriptions\.map\(\(description\) => `- \$\{description\}`\)/);
  assert.match(pictures, /setEditNote\(`成稿校对指出以下分镜问题/);
  assert.match(pictures, /修改分镜 \{panelKey\}/);
  assert.match(pictures, /action\('confirm-page-layout', \{[\s\S]*?projectVersion: page\.projectVersion,[\s\S]*?contentHash: page\.contentHash/);
  assert.match(pictures, /若仍有遮挡，请不要确认，可先重新校对并保留问题记录/);
  assert.match(pictures, /分镜校对只检查这一张原图/);
  assert.match(pictures, /已重排，待人工确认遮挡是否解决/);
  assert.match(pictures, /className="tertiary-action"[\s\S]*?提炼为素材/);
  assert.match(css, /\.inline-actions \.primary,[\s\S]*?min-height:42px/);
  assert.match(css, /\.tertiary-action:focus-visible/);
  assert.match(css, /\.source-grid>div>\.panel-card-meta\{display:flex;flex-direction:column/);
  assert.match(css, /\.source-grid \.panel-review-row\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/);
});

test('pre-submission quota pause explains the zero-upload state and does not retry automatically', () => {
  const cards = fs.readFileSync(path.join(appRoot, 'app/studio/recovery-cards.tsx'), 'utf8');
  const status = fs.readFileSync(path.join(appRoot, 'app/studio/workflow-status.tsx'), 'utf8');
  assert.match(cards, /quotaSnapshotStop/);
  assert.match(cards, /附件上传 0、发送 0，原图未变化/);
  assert.match(cards, /系统不会自动重试/);
  assert.match(cards, /只有在额度已刷新后确认/);
  assert.match(status, /5\\s\*小时创作额度\.\*旧快照/);
});

test('public panel media URL enables review and page review is a separate action', () => {
  const pictures = fs.readFileSync(path.join(appRoot, 'app/studio/project-pictures.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(appRoot, 'server/server.mjs'), 'utf8');
  const engine = fs.readFileSync(path.join(appRoot, 'server/engine.mjs'), 'utf8');
  assert.match(api, /url:media\(displayFile\)/);
  assert.match(api, /action==='confirm-page-layout'\)await confirmPageLayout\(p,\{pageNumber:b\.pageNumber,projectVersion:b\.projectVersion,contentHash:b\.contentHash\}\)/);
  assert.match(pictures, /disabled=\{disabled \|\| !panel\.url\}/);
  assert.match(pictures, /action\('review-image', \{key\}\)/);
  assert.match(pictures, /action\('review-page', \{pageNumber: page\.number\}\)/);
  assert.match(engine, /export function reviewPage\(/);
  assert.match(api, /action==='review-page'\)reviewPage\(p,b\.pageNumber\)/);
  assert.match(engine, /function reviewPageQaOnly\(/);
  assert.match(engine, /qa\(p,pageFile,JSON\.stringify\(pageQaDefinition\(definition\)\)/);
});

test('local page preflight remains pending manual review until page QA runs', () => {
  const pictures = fs.readFileSync(path.join(appRoot, 'app/studio/project-pictures.tsx'), 'utf8');
  const visuals = fs.readFileSync(path.join(appRoot, 'app/studio/visuals.tsx'), 'utf8');
  assert.match(pictures, /pageReviewPending=\{[\s\S]*?page\.qa\.manualReviewRequired === true[\s\S]*?page\.qa\.status === 'local_deterministic_preflight'/);
  assert.match(pictures, /qa\.manualReviewRequired === true \|\| qa\.status === 'local_deterministic_preflight'/);
  assert.match(pictures, /qaAction\(page\.qa, true\)/);
  assert.match(pictures, /qaAction\(panel\.qa, false\)/);
  assert.match(visuals, /pageReviewPending[\s\S]*?待人工复核/);
});

test('completed browser lease does not become the current global warning', () => {
  const status = fs.readFileSync(path.join(appRoot, 'app/studio/workflow-status.tsx'), 'utf8');
  assert.match(status, /project\.pending\?\.ownedTabState/);
  assert.match(status, /const taskLeaseRelevant = \[/);
});

test('formal panel decision keeps its explanation separated from high-contrast actions', () => {
  assert.match(studioSources, /className="approval-card panel-decision-card"/);
  assert.match(studioSources, /<h2>正式分镜需要你来决定<\/h2>/);
  assert.match(studioSources, /className="inline-actions"/);

  const decisionActions = rule('.panel-decision-card>.inline-actions');
  assert.match(
    decisionActions,
    /margin-top:\s*(?:1[8-9]|2\d)px/,
    'the decision actions need a visible vertical gap after the explanation',
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

test('recovery and panel decisions render through one primary card priority', () => {
  assert.match(studioSources, /const primaryCard = unknownResult/);
  assert.match(studioSources, /primaryCard === 'panel'/);
  assert.match(studioSources, /previousAttemptNoOutput=\{noOutput\}/);
  assert.match(studioSources, /本次修改未取得新图，上一版原图仍保留/);
  assert.match(
    studioSources,
    /panelDecisionPrimary=\{primaryCard === 'panel'\}/,
  );
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
