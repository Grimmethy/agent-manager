#!/usr/bin/env bash
# Tests apply-task.sh failure routing. A stub node replaces only src/apply-task.js.
# TypeError -> blockedStage apply-failed (never requeued); git timeout -> blockedStage apply
# (old requeue path); no output (SIGKILL-like) -> old generic backstop text.
# Runs against a COPY of scripts/ and src/ so the real agent-manager.env and queues are never touched.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SRC="$(cd "${SCRIPT_DIR}/.." && pwd)"
REAL_NODE="$(command -v node)"
FAILS=0

run_case() {
  local name="$1" body="$2" want_stage="$3" want_text="$4" want_hist="$5"
  local tmp tid f info
  tmp="$(mktemp -d)"
  tid="TEST-${name}"
  mkdir -p "$tmp/bin" "$tmp/home" "$tmp/repo" "$tmp/pipe/queue/approved" "$tmp/pipe/queue/blocked" "$tmp/pipe/queue/done" "$tmp/pipe/queue/pending"
  cp -r "$REPO_SRC/scripts" "$REPO_SRC/src" "$tmp/repo/"
  if [[ -d "$REPO_SRC/node_modules" ]]; then ln -s "$REPO_SRC/node_modules" "$tmp/repo/node_modules"; fi
  cat > "$tmp/pipe/queue/approved/$tid.json" <<JSON
{"id":"$tid","status":"approved","title":"apply-blocked-reason test","history":[]}
JSON
  cat > "$tmp/bin/node" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *"/src/apply-task.js --partition"*) exec "$REAL_NODE" "\$@" ;;
  *"/src/apply-task.js"*)
$body
    ;;
  *) exec "$REAL_NODE" "\$@" ;;
esac
STUB
  chmod +x "$tmp/bin/node"
  env -i PATH="$tmp/bin:$PATH" HOME="$tmp/home" NO_COLOR=1 \
    AGENT_MANAGER_REPO_ROOT="$tmp/repo" AGENT_MANAGER_PIPELINE_DIR="$tmp/pipe" \
    bash "$tmp/repo/scripts/apply-task.sh" > "$tmp/out.log" 2>&1
  f="$tmp/pipe/queue/blocked/$tid.json"
  if [[ -f "$f" ]]; then
    info="$("$REAL_NODE" -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("stage="+(t.blockedStage||""));console.log("reason="+(t.blockedReason||""));console.log("hist="+(t.history||[]).map((h)=>h.stage).join(","));' "$f")"
  else
    info="(not in queue/blocked)"
  fi
  if [[ "$info" == *"stage=$want_stage"* && "$info" == *"$want_text"* && "$info" == *"hist=$want_hist"* ]]; then
    echo "PASS: $name"
    echo "$info" | sed 's/^/    /'
  else
    echo "FAIL: $name"
    echo "$info" | sed 's/^/    /'
    tail -n 15 "$tmp/out.log" | sed 's/^/    log: /'
    FAILS=$((FAILS+1))
  fi
  rm -rf "$tmp"
}

run_case typeerror 'echo "TypeError: registerTaskSource is not a function" >&2
    echo "    at load (register.js:3:9)" >&2
    exit 1' apply-failed 'reason=TypeError: registerTaskSource is not a function' apply-failed

run_case gittimeout 'echo "fatal: unable to access remote: Connection timed out" >&2
    exit 128' apply 'Connection timed out' blocked

run_case sigkill 'exit 137' apply 'no output was captured either' blocked

if [[ $FAILS -eq 0 ]]; then echo 'ALL PASS'; exit 0; fi
echo "$FAILS case(s) failed"
exit 1
