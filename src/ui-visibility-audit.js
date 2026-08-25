'use strict';

// Deterministic "detector" half of a real hygiene task source (2026-08-24, Grimmethy:
// "How do we look for functions and code that should have a display in the ui?" ->
// "Build it now" for the endpoint-audit half specifically; a second, harder pass --
// auditing whether data an endpoint already returns is FULLY surfaced, not just whether
// the endpoint has any caller at all -- was deliberately deferred as a later
// finishing-touch job, not built here).
//
// Cross-references every Flask route this dashboard defines (python/dashboard/app.py)
// against every place a frontend source file could reference its path (the dashboard's
// own templates/index.html, plus python/visualize_assets/*.js -- the separate JS
// fragments visualize_graph.py injects into the dynamically-rendered project-graph page,
// confirmed live to be a real second frontend surface: /project/positions's only caller
// turned out to live in community-drag.js, not index.html at all).
//
// A route with NO reference anywhere in either surface is a CANDIDATE for "backend logic
// with no UI display" -- not a confirmed gap. Confirmed live on this exact codebase
// while building this: /api/ping and /api/alerts both come back as "unreferenced" by
// this detector, but both are correctly, deliberately UI-less -- their own docstrings
// say they're the companion Android app's health-check/notification-bell feed, not this
// dashboard's concern. /api/hardware/stats, on the other hand, really is a live backend
// endpoint with no dashboard caller anywhere (matches this session's own earlier
// hardware-tab frontend work). Same "candidate, not verdict" discipline as
// pipeline_health_audit and pipeline_self_audit: task-sources.js wires this into a real
// harness-grounded task (propose search queries, ground any fix in real matched file
// content) precisely so a route's own docstring/comment can clear it before anyone
// treats "unreferenced by static text search" as "actually missing".
//
// Detection strategy, deliberately layered to avoid false positives (a missed reference
// is much cheaper than a wrong "should build a UI panel" task) -- confirmed against the
// real codebase's actual JS patterns before writing this, which mixes THREE distinct
// URL-building styles for the same set of routes:
//   1. Template literal, contiguous: `/api/queue/${state}?...` -- dynamic segments
//      collapse to `${...}` right where the route's own `<param>` sits.
//   2. String concatenation: '/api/discuss/' + encodeURIComponent(id) + '/end' -- the
//      trailing static segment(s) end up as their OWN exact quoted string literal,
//      independent of whatever built the dynamic prefix.
//   3. Generic action dispatcher (postTaskAction(state, id, action, ...) building
//      `/api/task/${state}/${id}/${action}` internally): the route's own trailing
//      literal (e.g. "archive", "confirm") never appears IN a URL string at all -- it's
//      passed as a bare quoted argument to the dispatcher instead. Caught by falling
//      back to checking whether the route's last static segment appears as its own
//      exact quoted string ('archive', "archive", `archive`) anywhere in the source.
//   4. Concatenation prefix, for a route whose LAST segment is dynamic with nothing
//      static after it (e.g. /api/deep-dive/projects/<slug>): the literal PREFIX up to
//      and including the trailing slash ('/api/deep-dive/projects/') stands alone as its
//      own exact quoted string right before the `+ encodeURIComponent(...)`.
//
//      Known accepted imprecision from strategy 4: that same quoted prefix literal also
//      appears when the id is only ever used as a stepping-stone to a SUFFIXED sibling
//      route (e.g. '/api/discuss/' + id + '/message') -- there is no way to tell "this
//      exact prefix, bare" from "this prefix, always followed by more" with a text-level
//      regex. Confirmed live: this makes GET /api/discuss/<session_id> read as
//      "referenced" even though the template only ever calls its /message and /end
//      siblings, never the bare session GET. This detector deliberately keeps that
//      false negative rather than tightening strategy 4 to router-precision, since a
//      missed reference costs nothing (silently skipped this pass) while a wrong "no
//      caller" candidate costs a real, needlessly-filed hygiene task.
//
// A route counts as referenced if ANY strategy finds a hit in ANY scanned file.

const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly, same cadence as pipeline_health_audit.

// Route paths this audit should never flag even when genuinely unreferenced by any
// frontend source file -- documented, deliberate non-dashboard consumers.
const KNOWN_NON_UI_PATHS = new Set([
  '/api/ping', // companion Android app's health check (api_ping's own docstring).
  '/api/alerts', // companion Android app's notification-bell feed (api_alerts's own docstring).
]);

function schedulePath(instancesDir) {
  return path.join(instancesDir, '.ui-visibility-audit-schedule.json');
}

function isDue(instancesDir, now = new Date()) {
  let schedule;
  try {
    schedule = JSON.parse(fs.readFileSync(schedulePath(instancesDir), 'utf8'));
  } catch {
    return true;
  }
  const last = schedule.lastCheckedAt;
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() >= CHECK_INTERVAL_MS;
}

function markChecked(instancesDir, now = new Date()) {
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(schedulePath(instancesDir), JSON.stringify({ lastCheckedAt: now.toISOString() }, null, 2));
}

// Parses every @app.route(...) decorator in a Flask source file. Deliberately simple
// (one regex, no real Python parsing) -- this file's whole job is a text-level
// cross-reference, matching the level of rigor pipeline-health-audit.js's own
// process/log scanning already uses.
function extractFlaskRoutes(appPySource) {
  const routes = [];
  const re = /@app\.route\(\s*["']([^"']+)["'](?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?\s*\)/g;
  let m;
  while ((m = re.exec(appPySource))) {
    const routePath = m[1];
    const methodsRaw = m[2];
    const methods = methodsRaw
      ? methodsRaw.split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean)
      : ['GET'];
    const line = appPySource.slice(0, m.index).split('\n').length;
    routes.push({ path: routePath, methods, line });
  }
  return routes;
}

// A plain GET route outside /api/ is a PAGE (navigated to via a link/redirect, not
// fetched) -- e.g. "/" and "/project/visualization" both render_template/render full
// HTML documents rather than JSON. Those don't belong in an endpoint-usage audit; a
// mutating route (POST/PUT/DELETE) is always a real action endpoint regardless of its
// path prefix.
function isAuditableRoute(route) {
  if (route.path.startsWith('/api/')) return true;
  return route.methods.some((mm) => mm !== 'GET' && mm !== 'HEAD' && mm !== 'OPTIONS');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strategy 1: contiguous template-literal-style match, dynamic <param> segments allowed
// to be either a real ${...} interpolation or (defensively) a bare token.
function templateLiteralPattern(routePath) {
  const segments = routePath.split('/').filter((s) => s.length > 0);
  const parts = segments.map((seg) => {
    if (seg.startsWith('<') && seg.endsWith('>')) {
      return '(?:\\$\\{[^}]+\\}|[A-Za-z0-9_.\\-]+)';
    }
    return escapeRegex(seg);
  });
  const body = parts.join('\\/');
  return new RegExp("(?<=['\"`])\\/" + body + "(?=['\"`?]|$)");
}

// Strategy 2/3: the route's own trailing static segment(s), as an exact quoted string
// literal on their own -- catches both string-concatenation suffixes ('/end') and
// generic-dispatcher action arguments ('archive'). Only meaningful for a route that HAS
// at least one static (non-<param>) segment; a route that's entirely dynamic segments
// has nothing to anchor this on and relies on strategy 1 alone.
function trailingStaticLiteralPatterns(routePath) {
  const segments = routePath.split('/').filter((s) => s.length > 0);
  const patterns = [];
  // Longest trailing run of static segments, e.g. ['discuss', 'latest'] for
  // /api/task/<id>/discuss/latest -- tried as "/discuss/latest" first (most specific),
  // then just the final segment ("latest") as a looser fallback.
  let trailingStatic = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].startsWith('<') && segments[i].endsWith('>')) break;
    trailingStatic.unshift(segments[i]);
  }
  if (trailingStatic.length === 0) return patterns;
  if (trailingStatic.length > 1) {
    const joined = escapeRegex('/' + trailingStatic.join('/'));
    patterns.push(new RegExp("['\"`]" + joined + "['\"`]"));
  }
  // Bare last-segment literal ('hotlist') AND its slash-prefixed form ('/hotlist') --
  // confirmed live this codebase's own concatenation style always quotes the leading
  // slash together with the segment (e.g. '/message', '/hotlist'), never the segment
  // alone; the bare form stays as a defensive fallback for a differently-styled caller.
  const last = escapeRegex(trailingStatic[trailingStatic.length - 1]);
  patterns.push(new RegExp("['\"`]" + last + "['\"`]"));
  patterns.push(new RegExp("['\"`]\\/" + last + "['\"`]"));
  return patterns;
}

// Strategy 4: a route whose LAST segment is dynamic (e.g. /api/deep-dive/projects/<slug>,
// nothing static after the id) with no trailing suffix to anchor strategy 2/3 on. This
// codebase's own concatenation style ('/api/deep-dive/projects/' + encodeURIComponent(
// slug)) leaves the literal PREFIX -- everything up to and including the trailing slash
// right before the final <param> -- as its own exact quoted string. Only fires when the
// path's final segment is actually dynamic; a route with a static tail already has
// stronger anchors from strategy 2/3.
function concatenationPrefixPattern(routePath) {
  const segments = routePath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const lastSeg = segments[segments.length - 1];
  if (!(lastSeg.startsWith('<') && lastSeg.endsWith('>'))) return null;
  const prefixSegments = segments.slice(0, -1);
  const prefix = '/' + prefixSegments.map(escapeRegex).join('/') + (prefixSegments.length > 0 ? '\\/' : '\\/');
  return new RegExp("['\"`]" + prefix + "['\"`]");
}

function isRouteReferenced(route, sourceTexts) {
  const patterns = [
    templateLiteralPattern(route.path),
    ...trailingStaticLiteralPatterns(route.path),
  ];
  const prefixPattern = concatenationPrefixPattern(route.path);
  if (prefixPattern) patterns.push(prefixPattern);
  return sourceTexts.some((text) => patterns.some((re) => re.test(text)));
}

// Reads every file this audit scans as frontend source: the dashboard's own template,
// plus every python/visualize_assets/*.js fragment (the project-graph page's own
// separate frontend surface -- see this file's header). Missing paths are skipped, not
// fatal (mirrors every other best-effort fs read in pipeline-health-audit.js).
function readFrontendSources(repoRoot) {
  const texts = [];
  const templatePath = path.join(repoRoot, 'python', 'dashboard', 'templates', 'index.html');
  try {
    texts.push(fs.readFileSync(templatePath, 'utf8'));
  } catch { /* not present in this checkout */ }

  const assetsDir = path.join(repoRoot, 'python', 'visualize_assets');
  try {
    for (const name of fs.readdirSync(assetsDir)) {
      if (!name.endsWith('.js') && !name.endsWith('.html')) continue;
      try {
        texts.push(fs.readFileSync(path.join(assetsDir, name), 'utf8'));
      } catch { /* vanished mid-scan */ }
    }
  } catch { /* dir not present in this checkout */ }

  return texts;
}

/**
 * Runs the full audit. Returns { candidates: [{path, methods, line}], evidence }.
 * candidates is empty when every auditable route has at least one real reference.
 */
function auditUiVisibility({ repoRoot, appPyPath } = {}) {
  const resolvedAppPyPath = appPyPath || path.join(repoRoot, 'python', 'dashboard', 'app.py');
  let appPySource;
  try {
    appPySource = fs.readFileSync(resolvedAppPyPath, 'utf8');
  } catch {
    return { candidates: [], evidence: { routesScanned: 0, note: 'app.py not found' } };
  }

  const allRoutes = extractFlaskRoutes(appPySource);
  const auditable = allRoutes.filter(isAuditableRoute).filter((r) => !KNOWN_NON_UI_PATHS.has(r.path));
  const sourceTexts = readFrontendSources(repoRoot);

  const candidates = auditable.filter((r) => !isRouteReferenced(r, sourceTexts));

  return {
    candidates,
    evidence: {
      routesScanned: allRoutes.length,
      auditableRoutes: auditable.length,
      frontendFilesScanned: sourceTexts.length,
    },
  };
}

module.exports = {
  auditUiVisibility, isDue, markChecked,
  extractFlaskRoutes, isAuditableRoute, isRouteReferenced, readFrontendSources,
  CHECK_INTERVAL_MS, KNOWN_NON_UI_PATHS,
};
