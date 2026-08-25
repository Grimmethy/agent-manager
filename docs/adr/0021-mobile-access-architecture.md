# ADR-0021 — Mobile access: responsive web + Tailscale serve, not a PWA or native app

**Status:** Accepted

## Context

The original request was a "Mobile App Control Center": monitor and drive the Agent
Manager pipeline remotely from a phone. Three candidate architectures were considered,
with very different scope:

1. **PWA** — wrap the existing dashboard in an installable Progressive Web App (manifest
   + service worker).
2. **Native app** — a separate iOS/Android app talking to a new, versioned REST API,
   with push notifications and its own build/deploy pipeline.
3. **Responsive web + secure tunnel** — keep the existing responsive dashboard as-is,
   reachable from a phone over a secure tunnel, no new application code at all.

## Decision

**Option 3.** The dashboard (`python/dashboard/app.py`, a responsive Flask app already
bound to loopback on port 7420) is exposed over **Tailscale serve**:

```
tailscale serve --bg http://127.0.0.1:7420
```

The dashboard itself stays on loopback (`AGENT_MANAGER_DASHBOARD_HOST` unset) — Tailscale
terminates HTTPS and handles tailnet authentication. `AGENT_MANAGER_DASHBOARD_TOKEN`
remains as a defense-in-depth layer for the mutating-request gate: a non-loopback caller
(i.e. anything arriving over the tailnet) still needs the shared secret for any request
that changes state, regardless of tailnet membership.

No PWA manifest/service worker, no native app, no new API contract.

## Rationale

- **No new application code.** The dashboard is already responsive and already reachable
  from a phone via Tailscale — this reuses the existing API surface with zero new code,
  zero new build/deploy pipeline, and zero new API contract to version.
- **Auth and TLS are handled by the tunnel.** Tailscale provides HTTPS termination and
  tailnet-scoped access, exactly the security boundary remote access needs. The existing
  dashboard token gate remains as a second layer for mutating requests specifically.
- **Minimal scope.** Options 1 and 2 each introduce real new surface area (a PWA's
  offline/caching semantics for a dashboard that's inherently live; a native app's own
  versioned API, push notifications, and separate codebase) not justified by the actual
  requirement — reach the existing dashboard from a phone.

## Alternatives Considered

- **PWA:** would add a manifest and service worker, plus offline/caching semantics for a
  dashboard that's inherently live data. Adds a maintenance surface for a benefit
  (installability) Tailscale already provides via a stable, authenticated URL. Rejected.
- **Native app:** would require designing and versioning a stable mobile-facing REST API,
  push notifications for task alerts, and a separate app codebase with its own build and
  deploy pipeline — by far the largest scope, not needed for the stated goal. Rejected.

## Consequences

- **Positive:** zero new application code; the existing responsive dashboard and its auth
  model are reused as-is; remote access is secured by Tailscale's HTTPS + tailnet auth
  with the existing token gate as defense-in-depth.
- **Positive:** trivially reproducible on a fresh install — see the README's "Mobile /
  remote access" section.
- **Negative:** mobile access depends on the Tailscale daemon running on the host and the
  phone being on the same tailnet. Accepted operational requirement, not a defect.
- **Negative:** no offline access, no push notifications. Out of scope for the current
  requirement; revisit if a real future need emerges.
