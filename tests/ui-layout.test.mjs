import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const appRoot = path.resolve(import.meta.dirname, '..');
const page = fs.readFileSync(path.join(appRoot, 'app/page.tsx'), 'utf8');
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

  assert.match(page, /className="source-grid"/);
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

test('formal panel decision keeps its explanation separated from high-contrast actions', () => {
  assert.match(page, /className="approval-card panel-decision-card"/);
  assert.match(page, /<h2>正式分镜需要你来决定<\/h2>/);
  assert.match(page, /className="inline-actions"/);

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
  assert.match(page, /function MeasuredMasonryGrid/);
  assert.match(page, /new ResizeObserver/);
  assert.match(page, /requestAnimationFrame/);
  assert.match(page, /className="finished-grid"/);
  assert.match(page, /className="source-grid"/);
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
  assert.match(page, /qa\.status\s*===\s*['"]deferred['"]/);
  assert.match(page, /待检查\/未校对/);
  assert.match(css, /\.qa-label\.deferred\{/);
});

test('panel decisions prefill the manual repair prompt into image revision', () => {
  assert.match(
    page,
    /onEdit=\{\(repairPrompt\) => \{\s*setEditNote\(repairPrompt \|\| ''\)/,
    'manual panel repair instructions should be shown in the existing edit dialog',
  );
  assert.match(
    page,
    /onClick=\{\(\) => onEdit\(image\.qa\.repairPrompt\)\}/,
    'the panel decision must pass its precise repair prompt to the edit handler',
  );
  assert.match(
    page,
    /action\('revise-image', \{ key: edit\.key, note: editNote \}\)/,
    'the prefilled repair instructions must be sent as the revision note',
  );
});

test('terminal workflow timing freezes safely and marks unreached browser stages', () => {
  assert.match(page, /function terminalTime\(/);
  assert.match(
    page,
    /task\?\.completedAt,[\s\S]*progress\?\.completedAt,[\s\S]*task\?\.lastProgressAt/,
    'terminal timing should prefer task completion and safe progress timestamps',
  );
  assert.match(page, /state: 'not_reached'/);
  assert.match(page, /stage\.state === 'not_reached'[\s\S]*'未到达'/);
  assert.doesNotMatch(
    page,
    /fallbackEnd\s*=\s*Date\.now\(\)/,
    'terminal stage durations must not default to the wall clock',
  );
  assert.match(page, /stageFallbackEnd/);
});

test('recovery and panel decisions render through one primary card priority', () => {
  assert.match(page, /const primaryCard = unknownResult/);
  assert.match(page, /primaryCard === 'panel'/);
  assert.match(page, /previousAttemptNoOutput=\{noOutput\}/);
  assert.match(page, /本次修改未取得新图，上一版原图仍保留/);
  assert.match(page, /panelDecisionPrimary=\{primaryCard === 'panel'\}/);
  assert.match(page, /采用上一版/);
  assert.match(page, /继续修改这一张/);
  assert.match(
    page,
    /primaryCard === 'no-output'[\s\S]*NoOutputCard/,
    'known missing output should remain available when no previous panel decision exists',
  );
});

test('model usage details are collapsed while the aggregate remains visible', () => {
  assert.match(page, /<section className="metrics-panel"/);
  assert.match(page, /<details className="model-usage-details">/);
  assert.match(page, /<summary>查看模型明细<\/summary>/);
  assert.doesNotMatch(
    page,
    /<details className="model-usage-details" open>/,
    'model detail rows should be collapsed by default',
  );
  assert.match(css, /\.model-usage-details>summary\{/);
});

test('idle wall-clock updates are conditional and storyboard images are lazy decoded', () => {
  assert.match(page, /function workflowClockActive\(/);
  assert.match(page, /project\.busy/);
  assert.match(page, /taskRunning = project\?\.currentTask\?\.status === 'running'/);
  assert.match(page, /project\.progress\?\.activeStage\?\.state === 'running'/);
  assert.match(page, /if \(!clockActive\) return;/);
  assert.match(
    page,
    /alt="样张"[\s\S]{0,180}loading="lazy"[\s\S]{0,80}decoding="async"/,
  );
  assert.match(
    page,
    /alt=\{`第\$\{p\.number\}页`\}[\s\S]{0,180}loading="lazy"[\s\S]{0,80}decoding="async"/,
  );
  assert.match(
    page,
    /alt=\{`分镜\$\{k\}`\}[\s\S]{0,180}loading="lazy"[\s\S]{0,80}decoding="async"/,
  );
  assert.match(page, /className="reference-grid"/);
  assert.match(
    page,
    /src=\{a\.url\}[\s\S]*loading="lazy"[\s\S]*decoding="async"/,
  );
});
