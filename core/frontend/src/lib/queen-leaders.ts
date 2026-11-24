import { deriveLeaderLabel } from './queen-leaders-label.mjs';

export interface LeaderProfile {
  id: string | number;
  title?: string;
}

export function getLeaderLabel(id: string | number, profile?: LeaderProfile | null): string {
  const leaderProfile = profile ? { title: profile.title } : undefined;
  return deriveLeaderLabel(id, leaderProfile);
}

export function formatLeaderLabel(id: string | number, profile?: LeaderProfile | null): string {
  return getLeaderLabel(id, profile);
}
