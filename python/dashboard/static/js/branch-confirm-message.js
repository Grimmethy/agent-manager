// Pure builder for the merge/discard confirm text. No DOM access, no imports.
// An unknown action throws rather than returning a guessed confirm, so a typo fails loudly.
export function branchConfirmMessage({ action, branch, mainBranch, projectLabel, repoRoot, active, isDashboardRepo, extraWarnings = [] } = {}) {
  const projectLine = active
    ? `Project: ${projectLabel} (active)`
    : `Project: ${projectLabel} (not the active project, runs in ${repoRoot}).`;
  const lines = [projectLine];
  if (action === 'merge') {
    lines.push(`Merge "${branch}" into ${mainBranch}?` + (isDashboardRepo ? ' and sync the live dashboard' : ''));
  } else if (action === 'discard') {
    // Discard never carries sync wording.
    lines.push(`Discard "${branch}"?`);
  } else {
    throw new Error(`branchConfirmMessage: unknown action "${action}"`);
  }
  if (!isDashboardRepo) lines.push('This does not change the running dashboard.');
  for (const warning of extraWarnings) lines.push(warning);
  return lines.join('\n');
}
