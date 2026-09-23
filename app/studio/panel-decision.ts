import type { Plan, Picture } from './types';

function panelBoxSize(layout: string, index: number, count: number) {
  const width = 1036;
  const height = 1360;
  const gutter = 12;
  if (layout === 'solo') return index === 0 ? { width, height } : null;
  if (layout === 'duo') {
    const first = Math.round((height - gutter) * 0.63);
    return index === 0
      ? { width, height: first }
      : index === 1
        ? { width, height: height - first - gutter }
        : null;
  }
  if (layout === 'montage') {
    const heights = [0.4, 0.27, 0.33].map((part) =>
      Math.round((height - 2 * gutter) * part),
    );
    heights[2] = height - 2 * gutter - heights[0] - heights[1];
    return heights[index] ? { width, height: heights[index] } : null;
  }
  if (layout === 'trio' || layout === 'four') {
    const columns = layout === 'trio' ? 2 : 3;
    const first = Math.round((height - gutter) * 0.58);
    const lowerHeight = height - first - gutter;
    if (index === 0) return { width, height: first };
    const lowerIndex = index - 1;
    if (lowerIndex < 0 || lowerIndex >= columns || count <= index) return null;
    const columnWidth = Math.floor((width - (columns - 1) * gutter) / columns);
    const panelWidth =
      lowerIndex === columns - 1
        ? width - lowerIndex * (columnWidth + gutter)
        : columnWidth;
    return { width: panelWidth, height: lowerHeight };
  }
  return null;
}

export function panelCoverFitNote(
  plan: Plan | null | undefined,
  panelKey: string,
  image: Picture,
) {
  const pageNumber = Number(panelKey.split('-')[0]);
  const panelNumber = Number(panelKey.split('-')[1]);
  const page = plan?.pages.find((item) => item.number === pageNumber);
  const panel = page?.panels[panelNumber - 1];
  const integrity = image.integrity;
  const details = image.qa.issueDetails || [];
  if (
    !page ||
    !panel ||
    !Number.isInteger(panelNumber) ||
    image.qa.issues.length === 0 ||
    details.length !== image.qa.issues.length ||
    details.some((issue) => issue.category !== 'aspect_ratio') ||
    !integrity?.sha256 ||
    !/^[a-f\d]{64}$/i.test(integrity.sha256) ||
    !Number.isFinite(integrity.width) ||
    !Number.isFinite(integrity.height) ||
    (integrity.width || 0) <= 0 ||
    (integrity.height || 0) <= 0
  ) {
    return null;
  }
  const box = panelBoxSize(page.layout, panelNumber - 1, page.panels.length);
  if (!box) return null;
  const sourceRatio = (integrity.width || 0) / (integrity.height || 1);
  const targetRatio = (box.width - 2) / (box.height - 2);
  const differencePercent = Math.abs(sourceRatio / targetRatio - 1) * 100;
  if (!Number.isFinite(differencePercent) || differencePercent > 1) return null;
  return `原图与目标画幅仅差约 ${differencePercent.toFixed(2)}%，在本地 cover 裁切容差内，无需重生；仍请你决定是否采用这一张。`;
}
