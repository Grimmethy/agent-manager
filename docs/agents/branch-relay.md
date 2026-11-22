# Relaying a node branch

Part of the multi-node plan (see `docs/agents/nodes.md` and `docs/agents/leases.md`). A node builds a lent task on a branch under `agent/` in its own repository. Wok fetches that branch over the LAN and pushes it to origin (GitHub), so the dashboard, the verifier and the merge route see an ordinary branch and nothing downstream changes.

`relayBranch({branch, sha, nodeUrl, repoRoot})` in `src/branch-relay.js` returns `{ok, reason}` and never throws. In `repoRoot` (wok's checkout of the project) it:

1. fetches `refs/heads/<branch>` from `nodeUrl` into the private ref `refs/relay/<branch>` (`git fetch --no-tags`);
2. refuses unless that head is exactly `sha` (the sha from the node's review package);
3. pushes `<sha>:refs/heads/<branch>` to `origin`. The push is never forced and never a delete, so a branch that already exists on origin at a different commit stays rejected and is reported;
4. proves it with `git ls-remote origin refs/heads/<branch>`;
5. removes the private ref, also after a refusal.

Only branches under `agent/` are relayed. `nodeUrl` must be an `ssh://` or `git://` url or an absolute path; `http(s)` urls, scp-style `user@host:path` and values that start with `-` are refused. Git runs with prompts off and a 60 second timeout per command.

Nothing calls the relay by itself. The sha comes from a package that arrived at the package intake (`docs/agents/nodes.md`, `src/package-intake-server.js`); the owner or a later piece decides when to relay it.
