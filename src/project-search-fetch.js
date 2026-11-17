'use strict';

// Harness-side search execution for the project_search task source (see ADR-0018,
// docs/project-search-pipeline.md). The local model has no internet access -- confirmed neither
// local-client.js's /api/generate nor local-tool-client.js's /api/chat call path can
// reach the network -- so the Node harness does the actual GitHub/Hugging Face API calls
// and hands the local model pre-fetched text, the same split every other source uses for local file
// content (see get-grounding-source.js).
//
// v1 scope: GitHub Search API (repos) and Hugging Face API (models/datasets) only, both
// public/unauthenticated. GitHub's unauthenticated core-API limit is 60 req/hr, but the
// search endpoint specifically is throttled tighter (documented ~10 req/min) -- MAX_QUERIES
// below is deliberately conservative and a fixed delay separates each GitHub call.
//
// CLI: node project-search-fetch.js <queries.json>   where queries.json is {"queries": [...]}
// Writes a JSON array of results to stdout: [{query, source, name, url, description, stat}]
// Never throws on an individual query's failure -- a rate-limit or network error for one
// query is swallowed and that query just contributes zero results, so one bad call can't
// blank out results a caller already has from the others.

const https = require('https');

const MAX_QUERIES = 3;
const RESULTS_PER_QUERY = 4;
const GITHUB_CALL_DELAY_MS = 2500;

function httpsGetJson(urlString, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: Object.assign({ 'User-Agent': 'agent-manager-project-search' }, headers || {}),
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Unparseable JSON: ${e.message}`)); }
      });
      // See ollama-http.js's postJson for why this matters: a stream error arriving after
      // headers but mid-body has no listener without this, and Node throws it as an
      // uncaught exception instead of a caught, reportable rejection.
      res.on('error', reject);
    });
    req.on('timeout', () => {
      const err = new Error('request timed out');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchGitHub(query) {
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${RESULTS_PER_QUERY}`;
    const body = await httpsGetJson(url, { Accept: 'application/vnd.github+json' });
    const items = Array.isArray(body.items) ? body.items : [];
    return items.map((repo) => ({
      query,
      source: 'github',
      name: repo.full_name,
      url: repo.html_url,
      description: repo.description || '',
      stat: `${repo.stargazers_count} stars`,
    }));
  } catch (e) {
    return [{ query, source: 'github', error: e.message, kind: classifyFetchError(e) }];
  }
}

async function searchHuggingFace(query) {
  try {
    const [modelsBody, datasetsBody] = await Promise.all([
      httpsGetJson(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=${RESULTS_PER_QUERY}`),
      httpsGetJson(`https://huggingface.co/api/datasets?search=${encodeURIComponent(query)}&limit=${RESULTS_PER_QUERY}`),
    ]);
    const models = (Array.isArray(modelsBody) ? modelsBody : []).map((m) => ({
      query,
      source: 'huggingface',
      name: m.id,
      url: `https://huggingface.co/${m.id}`,
      description: '(model)',
      stat: `${m.downloads || 0} downloads`,
    }));
    const datasets = (Array.isArray(datasetsBody) ? datasetsBody : []).map((d) => ({
      query,
      source: 'huggingface',
      name: d.id,
      url: `https://huggingface.co/datasets/${d.id}`,
      description: '(dataset)',
      stat: `${d.downloads || 0} downloads`,
    }));
    return models.concat(datasets);
  } catch (e) {
    return [{ query, source: 'huggingface', error: e.message, kind: classifyFetchError(e) }];
  }
}

async function runSearches(queries) {
  const capped = queries.slice(0, MAX_QUERIES);
  const results = [];
  for (let i = 0; i < capped.length; i++) {
    const query = capped[i];
    if (i > 0) await sleep(GITHUB_CALL_DELAY_MS); // conservative pacing for GitHub's tighter search-endpoint limit
    const [ghResults, hfResults] = await Promise.all([searchGitHub(query), searchHuggingFace(query)]);
    results.push(...ghResults, ...hfResults);
  }
  return results;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stdout.write(JSON.stringify([{ error: 'usage: node project-search-fetch.js <queries.json>' }]));
    return;
  }
  const fs = require('fs');
  let queries;
  try {
    const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    queries = Array.isArray(parsed.queries) ? parsed.queries.filter((q) => typeof q === 'string' && q.trim()) : [];
  } catch (e) {
    process.stdout.write(JSON.stringify([{ error: `Could not read/parse queries file: ${e.message}` }]));
    return;
  }
  const results = await runSearches(queries);
  process.stdout.write(JSON.stringify(results));
}

const NETWORK_ERROR_CODES = new Set(['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);

// Classifies a fetch error as 'network' | 'rate-limit' | 'http' | 'parse'.
// Unrecognized errors fall back to 'http' rather than 'network': the search breaker only
// counts 'network', so an error we cannot identify must never cause a source to be skipped.
// Parse errors are recognized by the 'Unparseable JSON' message prefix set in httpsGetJson.
// GitHub signals some rate limits as 403 with a rate-limit message, so that case is included.
function classifyFetchError(e) {
  const message = String((e && e.message) || '');
  if (e && e.statusCode === 429) return 'rate-limit';
  if (e && e.statusCode === 403 && /rate limit/i.test(message)) return 'rate-limit';
  if (e && e.statusCode !== undefined && e.statusCode !== null) return 'http';
  if (e && NETWORK_ERROR_CODES.has(e.code)) return 'network';
  if (message.startsWith('Unparseable JSON')) return 'parse';
  return 'http';
}

module.exports = { runSearches, searchGitHub, searchHuggingFace, classifyFetchError };

if (require.main === module) {
  main();
}
