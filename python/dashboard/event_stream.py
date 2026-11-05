"""The dashboard's event channel (ADR-0024 open question "should the dashboard push instead of polling": yes). Piece 1 of 'UI triggers, not polls': the server half.

ONE shared watcher announces what changed; every browser tab that holds GET /api/stream is told by name, instead of each tab re-fetching everything on a 5 s timer.

  counts-changed    a queue state directory gained or lost a record (directory mtimes of <pipelineDir>/queue and each state directory below it)
  workers-changed   an instance heartbeat file changed one of status / currentPass / currentTaskId / stateSince (an EDGE; lastHeartbeat and the file mtime alone never fire it)
  branches-changed  the queue-events journal grew (a verdict was recorded or a branch merged; src/queue-events.js, python/dashboard/queue_events.py)
  plugins-changed   plugins.json changed (inode, size or mtime)
  project-changed   the active pipeline directory changed: the client must re-fetch everything
  <name>-changed    any further fact a caller registers as a PROVIDER (Hub(providers={...})): a callable returning a comparable value, announced when the value changes. The first
                    one is memory-changed (the host-memory chip's state and reason, read from the broker's marker file only when that file's stat key moved).

Why this still reads files once a second: the writers of queue state are bash `mv`, node and python, and Python's standard library has no inotify. One shared watcher doing
a handful of stat() calls (and a read of a heartbeat file only when its mtime moved) replaces N browsers x 5 s x several fetches; it runs only while a client is connected.
The idle cost is stat() calls per second, nothing is read from queue/done.

Reconcile (ADR rule 6): every RECONCILE_S the watcher re-derives the same facts without trusting its mtime cache (directory entry counts, every heartbeat file re-read). A change
it finds that no event announced is announced then AND counted (`corrections`): a count that rises means a writer changes state without moving a directory mtime.

The module imports nothing from agent-manager: the filesystem, the clock and the waiter are arguments, so it can move into the triggers repo unchanged.
"""
import json
import math
import os
import threading
import time
import urllib.request
from collections import deque

ANNOUNCE_EVENTS = ("plugin-changed",)     # events a writer announces itself (Hub.announce), not derived from a file by the watcher
EVENT_NAMES = ("counts-changed", "workers-changed", "branches-changed", "plugins-changed", "project-changed")
WATCH_S = 1.0
RECONCILE_S = 60.0
RING_SIZE = 200
IDLE_EXIT_S = 30.0
EDGE_KEYS = ("status", "currentPass", "currentTaskId", "stateSince")
BUILTIN_CHANGE_EVENTS = EVENT_NAMES[:4]       # the four facts the hub derives itself, in announcement order; providers follow


def enabled(env=None):
    """AGENT_MANAGER_EVENT_STREAM=off turns the channel off (the route answers 404 and the page keeps polling)."""
    env = os.environ if env is None else env
    return str(env.get("AGENT_MANAGER_EVENT_STREAM", "on")).strip().lower() != "off"


def _stat_key(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_ino, st.st_size, st.st_mtime_ns)


def json_file_fact(path_fn, project, stat=None, read=None):
    """A provider for Hub(providers=...): the value `project(parsed JSON)` of the file at path_fn(), re-read only when its stat key moved (or on the reconcile pass, `full`).
    A missing, unreadable or non-object file is the value None, never an error. Quantise what `project` returns: every distinct value is an announcement."""
    stat = stat or _stat_key
    cache = {}

    def fact(full=False):
        path = path_fn()
        if not path:
            return None
        key = stat(path)
        if not full and cache.get("path") == path and cache.get("key") == key:
            return cache["value"]
        value = None
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            value = project(data) if isinstance(data, dict) else None
        except (OSError, ValueError):
            value = None
        cache.update(path=path, key=key, value=value)
        return value
    return fact


def dir_files_fact(specs_fn, extra_files_fn=None, subdirs=False):
    """A provider for Hub(providers=...): a tuple of (path, inode, size, mtime_ns) for the files a page panel reads. specs_fn() -> [(directory, compiled regex)]: every regular file directly in
    `directory` whose NAME matches the regex; extra_files_fn() -> [path, ...] are stat'ed as they are. One scandir per directory and one stat per matching file, nothing is opened or read, a missing
    directory or file simply contributes nothing. A writer that appends to or replaces one of those files changes the tuple, so the panel that shows it is told, instead of asking on a timer.
    subdirs=True also lists each immediate SUBDIRECTORY whose name matches, by its own stat key (its mtime moves when a file in it is added, removed or replaced by rename), without looking inside it."""
    def fact(full=False):
        out = []
        for directory, pattern in specs_fn():
            try:
                with os.scandir(directory) as it:
                    for e in it:
                        if pattern.search(e.name) and (e.is_file(follow_symlinks=False) or (subdirs and e.is_dir(follow_symlinks=False))):
                            st = e.stat(follow_symlinks=False)
                            out.append((e.path, st.st_ino, st.st_size, st.st_mtime_ns))
            except OSError:
                continue
        for path in (extra_files_fn() if extra_files_fn else []):
            key = _stat_key(path) if path else None
            if key:
                out.append((str(path),) + key)
        return tuple(sorted(out))
    return fact


def coarse(value, digits=2):
    """`value` with every number rounded to `digits` significant figures (JSON-like structures, recursively; bools and None are untouched, anything else that is not a number or a container becomes its text). A live metric (a GPU utilisation, a VRAM figure, a
    token count) then changes this value only when it moves by a visible amount, so a provider built on it announces real change and not every wobble."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value == 0:
            return value
        exponent = math.floor(math.log10(abs(value)))
        step = 10 ** (exponent - digits + 1)
        rounded = round(value / step) * step
        return int(rounded) if isinstance(value, int) or float(rounded).is_integer() else float("%.*g" % (digits, rounded))
    if isinstance(value, dict):
        return {str(k): coarse(v, digits) for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, (list, tuple)):
        return [coarse(v, digits) for v in value]
    return str(value)


def http_json_fact(url_fn, project=None, timeout=3.0, opener=None, digits=2):
    """A provider for Hub(providers={name: (fact, interval_s)}): GET url_fn() (None means not configured), parse the JSON, apply project(data), round every number with coarse() and return the result as
    a canonical JSON string. ANY failure (no URL, refused connection, timeout, bad JSON) is the value None, never an error: an unavailable service is a state, and its coming back is a change."""
    def fact(full=False):
        url = url_fn()
        if not url:
            return None
        try:
            with (opener or urllib.request.urlopen)(url, timeout=timeout) as r:
                data = json.loads(r.read().decode())
            if project is not None:
                data = project(data)
            return json.dumps(coarse(data, digits), sort_keys=True, separators=(",", ":"))
        except Exception:   # noqa: BLE001
            return None
    return fact


def counts_signature(queue_dir, full=False):
    """((name, mtime_ns[, entry count]), ...) for the queue directory and each state directory below it. `full` counts entries too (the reconcile pass)."""
    if not queue_dir:
        return ()
    out = []
    try:
        with os.scandir(queue_dir) as it:
            subs = sorted((e.name for e in it if e.is_dir(follow_symlinks=False) and not e.name.startswith(".")))
    except OSError:
        return ()
    for name in [""] + subs:
        path = os.path.join(queue_dir, name) if name else str(queue_dir)
        try:
            mtime = os.stat(path).st_mtime_ns
        except OSError:
            continue
        item = (name, mtime)
        if full and name:
            try:
                with os.scandir(path) as it:
                    item = (name, mtime, sum(1 for _ in it))
            except OSError:
                pass
        out.append(item)
    return tuple(out)


def _read_edge(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("instanceId"):
        return None
    return (str(data["instanceId"]),) + tuple(data.get(k) if isinstance(data.get(k), (str, int, float, bool, type(None))) else str(data.get(k)) for k in EDGE_KEYS)


def workers_signature(instances_dir, cache, full=False):
    """Sorted tuple of per-instance edge tuples. `cache` maps path -> (stat key, edge) so an unchanged file is not re-read; `full` ignores it (the reconcile pass)."""
    if not instances_dir:
        return ()
    try:
        with os.scandir(instances_dir) as it:
            files = sorted(e.path for e in it if e.name.endswith(".json") and e.is_file(follow_symlinks=False))
    except OSError:
        cache.clear()
        return ()
    edges = []
    live = set()
    for path in files:
        live.add(path)
        key = _stat_key(path)
        hit = cache.get(path)
        if not full and hit and hit[0] == key:
            edge = hit[1]
        else:
            edge = _read_edge(path)
            cache[path] = (key, edge)
        if edge:
            edges.append(edge)
    for gone in [p for p in cache if p not in live]:
        del cache[gone]
    return tuple(sorted(edges))


class Hub:
    """Shared change announcer. resolve() -> {"queue": path|None, "instances": path|None, "plugins": path|None}, called every pass (the active project can change)."""

    def __init__(self, resolve, watch_s=WATCH_S, reconcile_s=RECONCILE_S, clock=time.monotonic, idle_exit_s=IDLE_EXIT_S, providers=None):
        self._resolve = resolve
        self._providers = {}                         # event name -> fact(full) callable; announced in registration order after the built-in four
        self._intervals = {}                         # event name -> seconds between evaluations (the single clock: a sampled provider is not asked every pass)
        self._prov_cache = {}                        # event name -> (clock time, last value)
        for name, spec in (providers or {}).items():
            fact, interval = spec if isinstance(spec, tuple) else (spec, None)
            if interval is not None and (isinstance(interval, bool) or not isinstance(interval, (int, float)) or interval <= 0):
                raise ValueError("a provider interval must be a positive number of seconds: %r" % (interval,))
            self._providers[name] = fact
            if interval is not None:
                self._intervals[name] = interval
        for name in self._providers:
            if not (isinstance(name, str) and name.endswith("-changed")) or name in EVENT_NAMES:
                raise ValueError("a provider event name must end in -changed and not be a built-in one: %r" % (name,))
        self._watch_s = watch_s
        self._reconcile_s = reconcile_s
        self._clock = clock
        self._idle_exit_s = idle_exit_s
        self._cond = threading.Condition()
        self._ring = deque(maxlen=RING_SIZE)
        self._seq = 0
        self._clients = 0
        self._gen = {}               # event name -> how many times it was announced (lets a cache notice that its data is older than the last announcement)
        self._thread = None
        self._wcache = {}
        self._last = None            # the last facts announced: dict of name -> value
        self._last_counts_full = None
        self._next_reconcile = None
        self._corrections = {"total": 0, "byEvent": {}}
        self._last_reconcile_at = None

    # ---- facts --------------------------------------------------------------------------------------------------------------------------------------------
    def _facts(self, full):
        paths = self._resolve() or {}
        queue, inst, plugins = paths.get("queue"), paths.get("instances"), paths.get("plugins")
        journal = os.path.join(os.path.dirname(os.path.abspath(str(queue))), "queue-events", "journal.jsonl") if queue else None
        counts = counts_signature(queue, full=full)
        extra = {}
        for name, fact in self._providers.items():
            interval = self._intervals.get(name)
            cached = self._prov_cache.get(name)
            if interval is not None and not full and cached is not None and self._clock() - cached[0] < interval:
                extra[name] = cached[1]
                continue
            try:
                extra[name] = fact(full)
            except Exception:   # noqa: BLE001 -- one broken provider must not silence the others
                extra[name] = None
            if interval is not None:
                self._prov_cache[name] = (self._clock(), extra[name])
        return {
            **extra,
            "project": str(queue) if queue else None,
            "counts-changed": tuple(x[:2] for x in counts),     # what the cheap pass can see: names and mtimes
            "counts-full": counts if full else None,           # the reconcile pass also counts entries

            "workers-changed": workers_signature(inst, self._wcache, full=full),
            "branches-changed": _stat_key(journal) if journal else None,
            "plugins-changed": _stat_key(plugins) if plugins else None,
        }

    def _publish(self, names, why):
        with self._cond:
            for name in names:
                self._seq += 1
                self._ring.append({"id": self._seq, "event": name, "data": {"seq": self._seq, "why": why}})
                self._gen[name] = self._gen.get(name, 0) + 1
            self._cond.notify_all()

    def announce(self, name, **data):
        """A WRITER's own announcement (ADR-0024: the party that changes something says so). Only the names in ANNOUNCE_EVENTS are accepted, so a request cannot invent an event;
        `data` rides along (the plugin's name) under the hub's own `seq` and `why`. Works whether or not a client is connected (the ring replays it). Returns the sequence number."""
        if name not in ANNOUNCE_EVENTS:
            raise ValueError("not an announceable event: %r" % (name,))
        with self._cond:
            self._seq += 1
            self._ring.append({"id": self._seq, "event": name, "data": {**data, "seq": self._seq, "why": "announce"}})
            self._gen[name] = self._gen.get(name, 0) + 1
            self._cond.notify_all()
            return self._seq

    def poll_once(self, full=False):
        """One watcher pass -> the list of event names announced. The first pass only records the baseline (a client's snapshot covers it)."""
        facts = self._facts(full)
        if self._last is None:
            self._last = facts          # the baseline; nothing to compare yet, so nothing is announced
        if facts["project"] != self._last["project"]:
            self._last = facts
            self._publish(["project-changed"], "pipeline")
            return ["project-changed"]
        changed = [n for n in self.change_events() if facts[n] != self._last[n]]
        if full:
            if "counts-changed" not in changed and self._last_counts_full is not None and facts["counts-full"] != self._last_counts_full:
                changed.insert(0, "counts-changed")
            self._last_counts_full = facts["counts-full"]
        self._last = facts
        if changed:
            self._publish(changed, "reconcile" if full else "watch")
        return changed

    def reconcile(self):
        """The slow safety net: re-derive from the source of truth. Anything it finds that the cheap pass missed is announced and counted."""
        found = self.poll_once(full=True)
        self._last_reconcile_at = time.time()
        if found and "project-changed" not in found:
            with self._cond:
                self._corrections["total"] += len(found)
                for n in found:
                    self._corrections["byEvent"][n] = self._corrections["byEvent"].get(n, 0) + 1
        return found

    def generation(self, name):
        with self._cond:
            return self._gen.get(name, 0)

    def change_events(self):
        return list(BUILTIN_CHANGE_EVENTS) + list(self._providers)

    def event_names(self):
        """Every event name this hub can announce (what a snapshot tells the client to re-fetch)."""
        return self.change_events() + ["project-changed"]

    # ---- clients ------------------------------------------------------------------------------------------------------------------------------------------
    def status(self):
        with self._cond:
            return {"enabled": True, "clients": self._clients, "seq": self._seq, "corrections": {"total": self._corrections["total"], "byEvent": dict(self._corrections["byEvent"])},
                    "lastReconcileAt": self._last_reconcile_at}

    def subscribe(self):
        """-> the current seq. Starts the shared watcher if it is not running."""
        if self._last is None:
            self._last = self._facts(False)     # the baseline is taken BEFORE the client's snapshot, so nothing between the two is lost
        with self._cond:
            self._clients += 1
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="event-stream-watcher", daemon=True)
                self._thread.start()
            return self._seq

    def unsubscribe(self):
        with self._cond:
            self._clients = max(0, self._clients - 1)
            self._cond.notify_all()

    def events_after(self, last_id, timeout):
        """-> (events with id > last_id, resync). Waits up to `timeout` s for news. resync is True when last_id is ahead of this process (a server restart reset the counter) or
        older than the ring holds: the caller must send a snapshot instead."""
        with self._cond:
            if last_id > self._seq or (self._ring and last_id < self._ring[0]["id"] - 1):
                return [], True
            if not any(e["id"] > last_id for e in self._ring):
                self._cond.wait(timeout)
            return [e for e in self._ring if e["id"] > last_id], False

    # ---- watcher ------------------------------------------------------------------------------------------------------------------------------------------
    def _run(self):
        idle_since = None
        self._next_reconcile = self._clock() + self._reconcile_s
        while True:
            with self._cond:
                if self._clients == 0:
                    idle_since = idle_since if idle_since is not None else self._clock()
                    if self._clock() - idle_since >= self._idle_exit_s:
                        self._last = None      # the next client starts from a fresh baseline
                        self._last_counts_full = None
                        return
                else:
                    idle_since = None
            try:
                if self._clock() >= self._next_reconcile:
                    self._next_reconcile = self._clock() + self._reconcile_s
                    self.reconcile()
                else:
                    self.poll_once()
            except Exception:   # noqa: BLE001 -- the watcher must outlive one bad pass
                pass
            time.sleep(self._watch_s)


_hub = None
_hub_lock = threading.Lock()


def get_hub(resolve, providers=None):
    global _hub
    with _hub_lock:
        if _hub is None:
            _hub = Hub(resolve, providers=providers)
        return _hub


def generation(name):
    """How many times the shared hub announced `name` (0 before the hub exists). A cache stores this beside its payload and drops the payload when it moved."""
    h = _hub
    if h is None:
        return 0
    try:
        return h.generation(name)
    except Exception:   # noqa: BLE001
        return 0


def hub_status():
    """For /api/summary: never raises; {"enabled": bool, ...}."""
    if not enabled():
        return {"enabled": False}
    h = _hub
    if h is None:
        return {"enabled": True, "clients": 0, "seq": 0, "corrections": {"total": 0, "byEvent": {}}, "lastReconcileAt": None}
    try:
        return h.status()
    except Exception:   # noqa: BLE001
        return {"enabled": True, "clients": 0, "seq": 0, "corrections": {"total": 0, "byEvent": {}}, "lastReconcileAt": None}


def sse(event, data, event_id=None):
    head = ("id: %s\n" % event_id) if event_id is not None else ""
    return "%sevent: %s\ndata: %s\n\n" % (head, event, json.dumps(data, separators=(",", ":")))
