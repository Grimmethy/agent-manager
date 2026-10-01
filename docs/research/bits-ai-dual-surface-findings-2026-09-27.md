# Bits AI dual-surface mechanism — research findings (HUB0002 · 1/2)

Date of this pass: 2026-09-27. Method: `curl` (server-rendered fetch only; no JS execution available).
Scope: how Datadog Bits AI posts the same investigation to a Slack thread AND appears on the incident timeline.

## Answers to Q1/Q2/Q3 (honest state)

- **Q1 (single-event-two-projection vs dual-write-with-cross-links): UNDETERMINED from public sources.** No server-rendered public page exposes the internal write model. Datadog's docs article on the incident timeline (confirmed live, HTTP 200) is client-side rendered; `curl` cannot extract its body, so the field-level evidence (timeline-entry `actor`/`created_by`, Slack cross-link fields) was not extractable in this pass. Not fabricated.
- **Q2 (cross-link direction): UNDETERMINED.** Same cause as Q1.
- **Q3 (named responder vs system log line): UNDETERMINED at the field level.** What IS verified: Bits is marketed and positioned as an *agent* that "Coordinate[s] response and simplify[es] on-call handoffs" alongside human workflows (see verbatim quote below), which is consistent with a named-responder presentation, but the enum/actor evidence was not extractable without a JS-executing fetch.

## Verified verbatim evidence

From **https://www.datadoghq.com/product/bits-ai/** (fetched 2026-09-27, HTTP 200, redirects to canonical **https://www.datadoghq.com/product/ai/bits-ai-agents/**), server-rendered HTML, exact text:

> "Coordinate response and simplify on-call handoffs with AI-generated summaries, postmortems, and integrations with Slack, MS Teams, Jira, ServiceNow, GitHub, and more"

Context on the same page: "Explore Bits Investigation — Bits Code — Resolve production issues faster with AI-generated, production-ready code fixes and unit tests, grounded in your observability data" — i.e. Bits Investigation is a distinct agent product whose output surfaces include Slack. No sentence on this page describes the timeline↔Slack relationship directionally; that level of detail lives only in the (JS-rendered) docs.

## URL log (this pass + prior pass 2026-09-18)

| URL | Status | Date | Finding |
|---|---|---|---|
| https://www.datadoghq.com/product/bits-ai/ | 200 (redirect → /product/ai/bits-ai-agents/) | 2026-09-27 | Server-rendered; verbatim quote above; Slack named as integration surface |
| https://api.datadoghq.com/api/v2/openapi.json | 404 `{"errors":["Not found"]}` (application/json) | 2026-09-27 | OpenAPI spec not public at this path |
| https://api.datadoghq.com/openapi.json | 404 `{"errors":["Not found"]}` | 2026-09-27 | ditto |
| https://api.datadoghq.com/spec.json | 404 `{"errors":["Not found"]}` | 2026-09-27 | ditto |
| https://api.datadoghq.com/api/v1/openapi.json | 404 `{"errors":["Not found"]}` | 2026-09-27 | ditto |
| https://docs.datadoghq.com/api/openapi.json | 404 (HTML) | 2026-09-27 | not served |
| https://www.datadoghq.com/api/openapi.json | 404 (HTML) | 2026-09-27 | not served |
| https://community.datadoghq.com/search.json?q=… | 404 (returns SPA HTML shell) | 2026-09-27 | community forum is a JS SPA; JSON endpoint not at that path |
| https://docs.datadoghq.com/incident_response/incident_management/investigate/timeline/ | 200 (body not extractable) | 2026-09-18 | authoritative article, live, but client-side rendered |
| https://docs.datadoghq.com/getting_started/incident_management/ | 200 (body not extractable) | 2026-09-18 | ditto |
| https://docs.datadoghq.com/integrations/slack/ | 200 (body not extractable) | 2026-09-18 | ditto |
| https://www.datadoghq.com/blog/ | 200 | 2026-09-27 | index fetched; no Bits-AI Slack/timeline content extracted |
| https://api.github.com/search/repositories?q=org%3ADatadog+documentation | 200 | 2026-09-27 (this pass) | GitHub search works unauthenticated; confirms public repo **DataDog/documentation** (default branch `master`) |
| https://raw.githubusercontent.com/DataDog/documentation/master/content/incident_response/incident_management/investigate/timeline.md | 404 | 2026-09-27 (this pass) | wrong content path guessed; repo + branch correct, file path not confirmed this pass |
| https://raw.githubusercontent.com/DataDog/ddapi/master/spec/datadog.json | 404 | 2026-09-27 (this pass) | repo/branch/path not confirmed this pass (search `org:Datadog api spec` returned 0 repos, suggesting the spec repo was renamed/moved) |
| https://docs.datadoghq.com/sitemap.xml | 200 (gzip, 188 B compressed) | 2026-09-27 (this pass) | sitemap index is static and reachable; decompress with `curl --compressed` to enumerate canonical doc URLs for the Bits AI / timeline / Slack articles |

## Static-mirror route discovered this pass (replaces the JS-execution requirement)

The prior passes concluded the Q1/Q2/Q3 field-level evidence was reachable only via a JS-executing fetch. That is **not fully correct**: the *rendered* docs site (`docs.datadoghq.com`) is an SPA, but the underlying sources are **public static files on GitHub**, fetchable with plain `curl`:

1. **Docs article source (Markdown)** — `DataDog/documentation` (default branch `master`), confirmed public this pass via `api.github.com/search/repositories?q=org:Datadog+documentation` (total_count 8, first hit `DataDog/documentation master`). Article body for https://docs.datadoghq.com/incident_response/incident_management/investigate/timeline/ lives at `content/…/timeline.md` inside that repo. Exact path not confirmed this pass (direct raw guess 404'd); resolve it with either:
   - `curl -sS "https://api.github.com/repos/DataDog/documentation/git/trees/master?recursive=1" | grep -i timeline` (may be large), or
   - `curl -sS --compressed "https://docs.datadoghq.com/sitemap.xml"` → child sitemaps → pick the canonical `/bits-ai`/`timeline`/`slack` URLs (docs URL = `content/` path + `.md`).
2. **API spec** — the incident-timeline OpenAPI spec is public on GitHub (historically `DataDog/ddapi`; repo appears renamed — org search `api spec` returned 0, so re-search `org:Datadog spec` / `org:Datadog openapi` first). The `timeline` endpoint object gives the verbatim Q1/Q2/Q3 field names (actor/creator fields, any slack/message cross-reference fields).
3. **Follow-up commands (exact, to close the Q1/Q2/Q3 gap):**
   ```bash
   curl -sS "https://api.github.com/search/repositories?q=org%3ADatadog+spec&per_page=10"
   curl -sS --compressed "https://docs.datadoghq.com/sitemap.xml"   # then the child sitemaps it lists
   # once path known:
   curl -sS "https://raw.githubusercontent.com/DataDog/documentation/master/content/<confirmed-path>/timeline.md"
   ```

## State of the field-level gap

Q1/Q2/Q3 remain honestly marked **undetermined** (not fabricated) — verbatim field-level evidence (timeline-entry actor/creator enums, Slack↔timeline cross-link fields) was **not extractable in this pass** because the static-mirror paths above are leads, not yet-confirmed URLs. The blocker is now a *bounded fetch task* (one confirmed file from each of the two public repos), not a JS-execution infra constraint.

> **Follow-up:** See `dspy-chain-of-thought.md` (this directory) for the DSPy ChainOfThought comparison and the three structural reasons agent-manager's two-call shape is the correct fit for this codebase's constraints.
