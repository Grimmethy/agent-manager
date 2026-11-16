'''hub_retire_cascade.py -- cascade retire of a coordinating hub and its whole subtree (HUB0478 1/5).

Phase A, plan_cascade(root_id, qdir): read-only walk of subTasks from the root. Returns (blockers, order) and writes nothing.
Phase B, apply_cascade(order, who, reason, qdir): runs only when phase A is clean. Archives deepest-first, appending a 'retired'
history event (type, who, reason, cascadeRoot, blockers) to each hub before it is archived.
refuse_cascade(root_id, blockers, who, reason, qdir): appends one 'refused' event carrying the full blocker list to the root and
increments COUNTERS['hub_retire_refusals'] (declared here: the repo has no shared counter registry).

Verified in this pass: the record label key is 'hubLabel' (app.py); the archive helper is app_task_helpers._archive_task_file(qdir, src),
imported lazily so this module has no import-time dependency on the app; history is the record's 'history' list.
Not here: resolve_hub_ref (HUB0478 2/5) and the route (3/5).
'''

import json
import os
from datetime import datetime, timezone
from pathlib import Path

RETIRABLE_STATES = ('adhoc', 'derived', 'pending', 'blocked', 'needs-clarification', 'awaiting-confirm', 'research')
IN_FLIGHT_STATES = ('review', 'approved')
KNOWN_DIRS = set(RETIRABLE_STATES + IN_FLIGHT_STATES + ('drafting', 'coordinating', 'done'))
COUNTERS = {'hub_retire_refusals': 0}


class CascadeRefused(Exception):
    def __init__(self, blockers):
        super().__init__('; '.join(blockers))
        self.blockers = list(blockers)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _read(path):
    try:
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write(path, data):
    tmp = Path(str(path) + '.' + str(os.getpid()) + '.tmp')
    tmp.write_text(json.dumps(data, indent=2) + chr(10), encoding='utf-8')
    os.replace(tmp, path)


def _event(kind, root_id, who, reason, blockers):
    return {'type': kind, 'who': who, 'reason': reason, 'cascadeRoot': root_id, 'blockers': blockers, 'at': _now()}


def _locate(qdir, node_id):
    '''(state, path) of a cascade node. States: a retirable or in-flight dir, 'drafting', 'hub' (a coordinating hub; path is its record),
    'terminal' (already finished or archived), 'unknown:<dir>' (a record in a dir this module does not classify), or None (no record).'''
    name = node_id + '.json'
    for state in RETIRABLE_STATES + IN_FLIGHT_STATES:
        f = qdir / state / name
        if f.is_file():
            return state, f
    drafting = qdir / 'drafting'
    if drafting.is_dir():
        for lane in sorted(drafting.iterdir()):
            if lane.is_dir() and (lane / name).is_file():
                return 'drafting', lane / name
    coord = qdir / 'coordinating' / name
    if coord.is_file():
        return 'hub', coord
    done = qdir / 'done'
    for d in (done, done / '_archived_no_action', done / '_superseded'):
        if (d / name).is_file():
            return 'terminal', None
    if qdir.is_dir():
        for d in sorted(qdir.iterdir()):
            if d.is_dir() and d.name not in KNOWN_DIRS and (d / name).is_file():
                return 'unknown:' + d.name, d / name
    return None, None


def _problem(state):
    '''Why a node in this state cannot be retired, or None when it can be (retirable, a hub, or already terminal).'''
    if state is None:
        return 'has no record on disk (unlinked child)'
    if state in IN_FLIGHT_STATES or state == 'drafting':
        return 'is in flight (' + state + ')'
    if state.startswith('unknown:'):
        return 'is in an unclassified state (' + state[len('unknown:'):] + ')'
    return None


def _check(qdir, node_id):
    state, path = _locate(qdir, node_id)
    return state, path, _problem(state)


def plan_cascade(root_id, qdir):
    '''Phase A: read-only. Returns (blockers, order). Order is post-order (children before parents) and empty whenever there are blockers.
    Every reach re-checks the node's state, even when the node was already visited; visited only stops re-expansion.'''
    qdir = Path(qdir)
    blockers = {}
    visited = set()
    order = []

    def block(node_id, why):
        blockers.setdefault(node_id, node_id + ' ' + why)

    def visit(node_id, owner):
        state, path, why = _check(qdir, node_id)
        if why:
            block(node_id, why + ('' if owner is None else ' (under ' + owner + ')'))
        if node_id in visited:
            return
        visited.add(node_id)
        if why or state == 'terminal':
            return
        if state == 'hub':
            rec = _read(path)
            if rec is None:
                block(node_id, 'hub record is unreadable')
                return
            for sub in rec.get('subTasks') or []:
                sid = sub.get('id') if isinstance(sub, dict) else None
                if sid:
                    visit(sid, node_id)
        order.append(node_id)

    root_state, _root_path, _root_why = _check(qdir, root_id)
    if root_state != 'hub':
        return ([root_id + ' is not a coordinating hub (' + (root_state or 'no record') + ')'], [])
    visit(root_id, None)

    coord = qdir / 'coordinating'
    if coord.is_dir():
        for f in sorted(coord.glob('*.json')):
            if f.stem in visited:
                continue
            rec = _read(f) or {}
            for sub in rec.get('subTasks') or []:
                sid = sub.get('id') if isinstance(sub, dict) else None
                if sid in visited:
                    block(sid, 'is also a child of coordinating hub ' + f.stem + ', outside this cascade')
                    break

    found = list(blockers.values())
    return found, ([] if found else order)


def refuse_cascade(root_id, blockers, who, reason, qdir):
    '''Record a refusal: one 'refused' history event on the root with the full blocker list, and count it.'''
    COUNTERS['hub_retire_refusals'] += 1
    path = Path(qdir) / 'coordinating' / (root_id + '.json')
    rec = _read(path)
    if rec is not None:
        rec.setdefault('history', []).append(_event('refused', root_id, who, reason, list(blockers)))
        _write(path, rec)
    return {'ok': False, 'cascadeRoot': root_id, 'blockers': list(blockers)}


def _default_archive():
    from app_task_helpers import _archive_task_file
    return _archive_task_file


def apply_cascade(order, who, reason, qdir, archive=None):
    '''Phase B: archive deepest-first. Re-checks each node right before it moves; a change stops the run, writes a refused event on
    the root and raises CascadeRefused. Returns [{'id', 'label'}, ...] in archive order.'''
    if not order:
        return []
    qdir = Path(qdir)
    root_id = order[-1]
    archive = archive or _default_archive()
    done = []
    for node_id in order:
        state, path, why = _check(qdir, node_id)
        rec = None
        if why is None and state != 'terminal':
            rec = _read(path)
            if rec is None:
                why = 'record is unreadable'
        elif why is None:
            why = 'already finished or archived'
        if why is not None:
            text = node_id + ' changed before its archive: ' + why
            refuse_cascade(root_id, [text], who, reason, qdir)
            raise CascadeRefused([text])
        rec.setdefault('history', []).append(_event('retired', root_id, who, reason, []))
        _write(path, rec)
        archive(qdir, path)
        done.append({'id': node_id, 'label': rec.get('hubLabel')})
    return done
