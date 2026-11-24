export function deriveLeaderLabel(id, profile) {
  const title = profile && typeof profile === 'object' ? profile.title : undefined;
  if (typeof title === 'string' && title.trim() !== '') {
    return title.trim();
  }
  const raw = String(id ?? '');
  const stripped = raw.startsWith('queen_') ? raw.slice('queen_'.length) : raw;
  return stripped
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
