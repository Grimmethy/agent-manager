'use strict';

// Apache-2.0 origin: ported from makecindy/cindy packages/github-client/src/client.ts
// and packages/github-client/src/http-safety.ts (Apache-2.0). Ported the IDEAS (host
// pin, redirect safety, manual redirect following, token redaction, search/repo-overview
// /contents/file/commits endpoints) -- not the TypeScript; core is plain Node CommonJS
// with no new dependencies.

const { URL } = require('url');

const GITHUB_API_BASE = 'https://api.github.com';
const RAW_HOST = 'raw.githubusercontent.com';
const MAX_REDIRECTS = 3;
const ALLOWED_REDIRECT_HOSTS = new Set([new URL(GITHUB_API_BASE).hostname, RAW_HOST]);
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES = 200;
const OUTPUT_CHAR_CAP = 12000;
const READ_FILE_BYTE_CAP = 60000;
const TRUNCATION_MARKER = (n) => `\n[truncated: ${n} chars]`;
const UNTRUSTED_HEADER = '[github data, untrusted]';

// owner/repo/path validation: alphanumeric + . _ - (path allows /)
const IDENT_RE = /^[A-Za-z0-9._-]+$/;
const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function validateOwner(name) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    return `invalid owner: ${JSON.stringify(name)} (must match ^[A-Za-z0-9._-]+$)`;
  }
  return null;
}

function validateRepo(name) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    return `invalid repo: ${JSON.stringify(name)} (must match ^[A-Za-z0-9._-]+$)`;
  }
  return null;
}

function validatePath(p) {
  if (typeof p !== 'string') return `invalid path: ${JSON.stringify(p)}`;
  if (p.includes('..')) return 'path must not contain ".."';
  if (!PATH_RE.test(p)) {
    return `invalid path: ${JSON.stringify(p)} (must match ^[A-Za-z0-9._-]+(\\/[A-Za-z0-9._-]+)*$)`;
  }
  return null;
}

function validateRef(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref !== 'string' || ref.includes('..') || !PATH_RE.test(ref)) {
    return `invalid ref: ${JSON.stringify(ref)} (branch, tag or SHA: letters, digits, . _ - and / between parts)`;
  }
  return null;
}

function encodeSegment(s) {
  return encodeURIComponent(s).replace(/%2F/gi, '/');
}

// ---- In-memory LRU cache ----
class SimpleLRUCache {
  constructor(maxEntries, ttlMs) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxEntries) {
      // Evict oldest (first key in insertion order)
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

// ---- Token redaction helper ----
function redactToken(text, token) {
  if (!token || typeof text !== 'string') return text;
  // Replace the token with [REDACTED] wherever it appears
  return text.split(token).join('[REDACTED]');
}

// ---- Safe fetch with redirect rules ----
async function safeFetch(fetchImpl, url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`unsafe URL protocol: ${parsed.protocol} (must be https)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`unsafe URL: userinfo not allowed in ${url}`);
  }

  let currentUrl = url;
  let redirectsFollowed = 0;

  while (redirectsFollowed <= MAX_REDIRECTS) {
    // redirect:'manual' so THIS loop (not fetch) decides where a redirect may go; the token is sent only to api.github.com, never to a redirect target such as raw.githubusercontent.com.
    const hopOptions = { ...options, redirect: 'manual' };
    if (new URL(currentUrl).hostname !== new URL(GITHUB_API_BASE).hostname && hopOptions.headers) {
      const { authorization, Authorization, ...rest } = hopOptions.headers;
      hopOptions.headers = rest;
    }
    const res = await fetchImpl(currentUrl, hopOptions);

    if (!res.ok && (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308)) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`redirect without Location header from ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl).href;
      const redirectParsed = new URL(redirectUrl);
      if (!ALLOWED_REDIRECT_HOSTS.has(redirectParsed.hostname)) {
        throw new Error(`cross-host redirect refused: ${currentUrl} -> ${redirectUrl} (must stay on api.github.com or raw.githubusercontent.com)`);
      }
      redirectsFollowed++;
      currentUrl = redirectUrl;
      continue;
    }

    return res;
  }

  throw new Error(`too many redirects (max ${MAX_REDIRECTS}) from ${url}`);
}

// ---- Rate limit / auth helpers ----
function readToken() {
  return process.env.AGENT_MANAGER_GITHUB_TOKEN || null;
}

function buildHeaders(token) {
  const headers = {
    accept: 'application/vnd.github.v3+json',
    'user-agent': 'agent-manager-chat',
  };
  if (token) {
    headers.authorization = `token ${token}`;
  }
  return headers;
}

// A 429 is always a rate limit; a 403 is one only when GitHub says the quota is used up (x-ratelimit-remaining: 0). Any other 403 (private repo, blocked) is an ordinary error.
function isRateLimited(res) {
  if (res.status === 429) return true;
  return res.status === 403 && String(res.headers.get('x-ratelimit-remaining')) === '0';
}

function rateLimitError(res) {
  const reset = res.headers.get('x-ratelimit-reset');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const err = new Error(formatRateLimitMessage(res));
  err.status = res.status;
  err.rateLimitReset = reset ? Number(reset) : null;
  err.rateLimitRemaining = remaining ? Number(remaining) : null;
  return err;
}

function formatRateLimitMessage(res) {
  const reset = res.headers.get('x-ratelimit-reset');
  const resetTime = reset ? new Date(Number(reset) * 1000).toISOString() : 'unknown';
  return `GitHub API rate limit exceeded (HTTP ${res.status}). Reset at: ${resetTime}. Without a token, unauthenticated requests are limited to 60/hour. Set AGENT_MANAGER_GITHUB_TOKEN to raise the limit.`;
}

// ---- Core request function ----
async function githubRequest(fetchImpl, path, token, cache) {
  const url = `${GITHUB_API_BASE}${path}`;
  
  // Check cache first
  const cached = cache.get(url);
  if (cached) {
    return cached;
  }

  const headers = buildHeaders(token);
  const res = await safeFetch(fetchImpl, url, { headers });
  
  if (!res.ok && isRateLimited(res)) {
    throw rateLimitError(res);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error (HTTP ${res.status}): ${redactToken(text, token)}`);
  }

  const data = await res.json();
  cache.set(url, data);
  return data;
}

// ---- Output formatting ----
function formatOutput(data, isJson = false) {
  let text;
  if (isJson) {
    text = JSON.stringify(data, null, 2);
  } else if (typeof data === 'string') {
    text = data;
  } else {
    text = JSON.stringify(data, null, 2);
  }

  // Cap at OUTPUT_CHAR_CAP
  if (text.length > OUTPUT_CHAR_CAP) {
    text = text.slice(0, OUTPUT_CHAR_CAP) + TRUNCATION_MARKER(text.length - OUTPUT_CHAR_CAP);
  }

  return `${UNTRUSTED_HEADER}\n${text}`;
}

// ---- Public API ----
function createGithubClient({ fetch, baseUrl }) {
  if (baseUrl && baseUrl !== GITHUB_API_BASE) {
    throw new Error(`invalid baseUrl: ${baseUrl} (must be ${GITHUB_API_BASE})`);
  }

  const cache = new SimpleLRUCache(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

  async function githubSearchRepos(query, options = {}) {
    const { sort = 'stars', perPage = 10 } = options;
    const validatedPerPage = Math.min(Math.max(1, Math.floor(perPage)), 15);
    
    const path = `/search/repositories?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}&per_page=${validatedPerPage}`;
    const token = readToken();
    const data = await githubRequest(fetch, path, token, cache);
    
    return formatOutput({
      query,
      total_count: data.total_count,
      items: (data.items || []).map(item => ({
        full_name: item.full_name,
        description: item.description,
        stars: item.stargazers_count,
        forks: item.forks_count,
        html_url: item.html_url,
      })),
    }, true);
  }

  async function githubRepoOverview(owner, repo) {
    const vOwner = validateOwner(owner);
    if (vOwner) return formatOutput({ error: vOwner });
    const vRepo = validateRepo(repo);
    if (vRepo) return formatOutput({ error: vRepo });

    const token = readToken();
    
    // Get repo info
    const repoPath = `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}`;
    const repoData = await githubRequest(fetch, repoPath, token, cache);
    
    // Get topics
    let topics = [];
    try {
      const topicsRes = await safeFetch(fetch, `${GITHUB_API_BASE}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/topics`, {
        headers: buildHeaders(token),
      });
      if (topicsRes.ok) {
        const topicsData = await topicsRes.json();
        topics = topicsData.names || [];
      }
    } catch (e) {
      // Ignore topic fetch errors
    }
    
    // Get languages
    let languages = [];
    try {
      const langRes = await safeFetch(fetch, `${GITHUB_API_BASE}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/languages`, {
        headers: buildHeaders(token),
      });
      if (langRes.ok) {
        const langData = await langRes.json();
        languages = Object.entries(langData)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, bytes]) => ({ name, bytes }));
      }
    } catch (e) {
      // Ignore language fetch errors
    }
    
    // Get latest release
    let latestRelease = null;
    try {
      const releaseRes = await safeFetch(fetch, `${GITHUB_API_BASE}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/releases/latest`, {
        headers: buildHeaders(token),
      });
      if (releaseRes.ok) {
        const releaseData = await releaseRes.json();
        latestRelease = releaseData.tag_name;
      }
    } catch (e) {
      // Ignore release fetch errors
    }
    
    // Get open issues count
    let openIssues = 0;
    try {
      const issuesRes = await safeFetch(fetch, `${GITHUB_API_BASE}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues?state=open&per_page=1`, {
        headers: buildHeaders(token),
      });
      if (issuesRes.ok) {
        const link = issuesRes.headers.get('link');
        if (link) {
          const match = link.match(/<[^>]*page=(\d+)>.*rel="last"/);
          if (match) {
            openIssues = (parseInt(match[1], 10) - 1) * 1 + 1;
          }
        }
      }
    } catch (e) {
      // Ignore issues count errors
    }
    
    // Get README
    let readme = '';
    try {
      const readmeRes = await safeFetch(fetch, `${GITHUB_API_BASE}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/readme`, {
        headers: buildHeaders(token),
      });
      if (readmeRes.ok) {
        const readmeData = await readmeRes.json();
        if (readmeData.content) {
          const decoded = Buffer.from(readmeData.content, 'base64').toString('utf8');
          readme = decoded.slice(0, 3000);
        }
      }
    } catch (e) {
      // Ignore readme fetch errors
    }

    const license = repoData.license ? {
      name: repoData.license.spdx_id,
      url: repoData.license.html_url,
    } : null;

    return formatOutput({
      full_name: repoData.full_name,
      description: repoData.description,
      stars: repoData.stargazers_count,
      forks: repoData.forks_count,
      license,
      default_branch: repoData.default_branch,
      pushed_at: repoData.pushed_at,
      topics,
      languages,
      latest_release: latestRelease,
      open_issues: openIssues,
      readme: readme,
    });
  }

  // Both use GET /repos/{owner}/{repo}/contents/{path}?ref= (git/trees and git/blobs take SHAs, not paths). A directory answers with an array, a file with an object.
  function contentsPath(owner, repo, p, ref) {
    const tail = p ? `/${p.split('/').map(encodeURIComponent).join('/')}` : '';
    return `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/contents${tail}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  }

  async function githubListContents(owner, repo, path = '', ref) {
    const vOwner = validateOwner(owner);
    if (vOwner) return formatOutput({ error: vOwner });
    const vRepo = validateRepo(repo);
    if (vRepo) return formatOutput({ error: vRepo });
    const vPath = path ? validatePath(path) : null;
    if (vPath) return formatOutput({ error: vPath });
    const vRef = validateRef(ref);
    if (vRef) return formatOutput({ error: vRef });

    const data = await githubRequest(fetch, contentsPath(owner, repo, path, ref), readToken(), cache);
    const entries = Array.isArray(data) ? data : [data];
    return formatOutput({
      path: path || '/',
      items: entries.map((item) => ({ name: item.name, path: item.path, type: item.type, size: item.size, sha: item.sha })),
    }, true);
  }

  async function githubReadFile(owner, repo, path, ref) {
    const vOwner = validateOwner(owner);
    if (vOwner) return formatOutput({ error: vOwner });
    const vRepo = validateRepo(repo);
    if (vRepo) return formatOutput({ error: vRepo });
    const vPath = validatePath(path);
    if (vPath) return formatOutput({ error: vPath });
    const vRef = validateRef(ref);
    if (vRef) return formatOutput({ error: vRef });

    const data = await githubRequest(fetch, contentsPath(owner, repo, path, ref), readToken(), cache);
    if (Array.isArray(data)) return formatOutput({ error: `${path} is a directory: use github_list_contents` });
    if (data.type && data.type !== 'file') return formatOutput({ error: `${path} is a ${data.type}, not a file` });
    if (data.encoding !== 'base64' || typeof data.content !== 'string' || !data.content) {
      return formatOutput({ error: `file content not available inline (size ${data.size}; GitHub does not inline files over 1 MB)` });
    }
    const bytes = Buffer.from(data.content, 'base64');
    if (bytes.subarray(0, 8000).includes(0)) return formatOutput({ error: 'binary file refused' });
    if (bytes.length > READ_FILE_BYTE_CAP) {
      return formatOutput(`${bytes.subarray(0, READ_FILE_BYTE_CAP).toString('utf8')}${TRUNCATION_MARKER(bytes.length - READ_FILE_BYTE_CAP)}`);
    }
    return formatOutput(bytes.toString('utf8'));
  }

  async function githubRecentCommits(owner, repo, options = {}) {
    const { perPage = 10, path } = options;
    const validatedPerPage = Math.min(Math.max(1, Math.floor(perPage)), 20);
    
    let requestPath = `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/commits?per_page=${validatedPerPage}`;
    if (path) {
      requestPath += `&path=${encodeURIComponent(path)}`;
    }

    const token = readToken();
    const data = await githubRequest(fetch, requestPath, token, cache);
    
    return formatOutput({
      items: data.map(commit => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.commit.author ? commit.commit.author.name : null,
        date: commit.commit.author ? commit.commit.author.date : null,
        html_url: commit.html_url,
      })),
    }, true);
  }

  async function githubSearchCode(query) {
    const token = readToken();
    if (!token) {
      return formatOutput({ 
        error: 'code search needs AGENT_MANAGER_GITHUB_TOKEN set in the environment; no request was made.',
        needs_auth: true,
      });
    }

    const requestPath = `/search/code?q=${encodeURIComponent(query)}&per_page=10`;
    const data = await githubRequest(fetch, requestPath, token, cache);
    
    return formatOutput({
      total_count: data.total_count,
      items: (data.items || []).map(item => ({
        name: item.name,
        path: item.path,
        html_url: item.html_url,
        repository: item.repository ? item.repository.full_name : null,
        text_matches: item.text_matches ? item.text_matches.map(match => ({
          fragment: match.fragment,
          matches: match.matches ? match.matches.map(m => ({
            text: m.text,
            highlights: m.highlights,
          })) : [],
        })) : [],
      })),
    }, true);
  }

  // Every tool answers with text: an API failure, a rate limit or a refused redirect comes back as { error } with the token removed, not as a thrown exception.
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return formatOutput({ error: redactToken(String((e && e.message) || e), readToken()) });
    }
  };
  return {
    githubSearchRepos: guard(githubSearchRepos),
    githubRepoOverview: guard(githubRepoOverview),
    githubListContents: guard(githubListContents),
    githubReadFile: guard(githubReadFile),
    githubRecentCommits: guard(githubRecentCommits),
    githubSearchCode: guard(githubSearchCode),
  };
}

module.exports = {
  createGithubClient,
  validateOwner,
  validateRepo,
  validatePath,
  validateRef,
  SimpleLRUCache,
};
