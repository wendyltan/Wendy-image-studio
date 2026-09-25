type RevisionIssue = {
  description?: string | null;
  repairAction?: string | null;
};

type RevisionIssueGroup = {
  panelKey?: string | null;
  issues: RevisionIssue[];
};

/**
 * A page-level repair prompt is safe to prefill only when the page has one
 * source issue and that issue has an explicit description.  A page prompt
 * must never be assumed to cover several issue groups or several defects.
 */
export function sourcedPageRepairPrompt(
  issueGroups: RevisionIssueGroup[],
  pageIssues: RevisionIssue[],
  pageRepairPrompt?: string | null,
) {
  if (pageIssues.length !== 1 || pageIssues[0].repairAction !== 'regenerate')
    return '';
  if (issueGroups.length !== 1 || issueGroups[0].issues.length !== 1) return '';
  if (!issueGroups[0].panelKey || issueGroups[0].issues[0] !== pageIssues[0])
    return '';
  if (!String(issueGroups[0].issues[0].description || '').trim()) return '';
  return String(pageRepairPrompt || '').trim();
}
