'use strict';

// Build evidence pack for brain_dump_resolution_check
// Capped at ~3000 characters total
// Includes: entry text, cited paths with existence/commits, cited identifiers with grep hits, recent commits

const { execSync } = require('child_process');

function buildEvidencePack(entry, masterSha, cap) {
  const pack = {
    entryText: truncate(entry.rawText || '', 500),
    citedPaths: [],
    citedIdentifiers: [],
    recentCommits: [],
  };

  const paths = extractPaths(entry.rawText);
  const identifiers = extractIdentifiers(entry.rawText);

  // Check each cited path
  for (const filePath of paths) {
    const exists = checkPathExists(filePath, masterSha);
    const commits = getRecentCommitsForPath(filePath, masterSha);
    pack.citedPaths.push({ path: filePath, exists, commits });
  }

  // Check each cited identifier
  for (const identifier of identifiers) {
    const hits = getGitGrepHits(identifier, masterSha);
    pack.citedIdentifiers.push({ identifier, hits });
  }

  // Get commits since entry's capturedAt that touched cited files
  if (entry.capturedAt && paths.length > 0) {
    const sinceCommits = getCommitsSince(entry.capturedAt, paths, masterSha);
    pack.recentCommits = sinceCommits;
  }

  // Cap at specified length
  return capEvidencePack(pack, cap);
}

function extractPaths(text) {
  const matches = (text || '').match(/`([^`]+)`/g) || [];
  return matches.map(m => m.slice(1, -1).trim()).filter(Boolean);
}

function extractIdentifiers(text) {
  const matches = (text || '').match(/`([^`]+)`/g) || [];
  return matches.map(m => m.slice(1, -1).trim()).filter(Boolean);
}

function checkPathExists(filePath, masterSha) {
  try {
    execSync(`git cat-file -e ${masterSha}:${filePath}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getRecentCommitsForPath(filePath, masterSha) {
  try {
    const result = execSync(`git log --format=%h %s -3 -- ${filePath}`, { encoding: 'utf8' });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getGitGrepHits(identifier, masterSha) {
  try {
    const result = execSync(`git grep -n "${identifier}" ${masterSha}`, { encoding: 'utf8' });
    return result.trim().split('\n').slice(0, 3).filter(Boolean);
  } catch {
    return [];
  }
}

function getCommitsSince(capturedAt, paths, masterSha) {
  try {
    const since = new Date(capturedAt).toISOString();
    const result = execSync(`git log --format=%h %s --since="${since}" -- ${paths.join(' ')}`, { encoding: 'utf8' });
    return result.trim().split('\n').slice(0, 5).filter(Boolean);
  } catch {
    return [];
  }
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function capEvidencePack(pack, cap) {
  const json = JSON.stringify(pack);
  if (json.length <= cap) return pack;

  // Truncate strategically
  pack.entryText = truncate(pack.entryText, 200);
  pack.citedPaths = pack.citedPaths.slice(0, 2);
  pack.citedIdentifiers = pack.citedIdentifiers.slice(0, 2);
  pack.recentCommits = pack.recentCommits.slice(0, 3);

  return pack;
}

module.exports = { buildEvidencePack };
