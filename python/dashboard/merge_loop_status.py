'''Read-only merge-loop status from the checker and merger ledgers.

Each ledger is <state dir>/<name>-ledger.jsonl, where the state dir is ~/.local/state/pipeline-ops. The ledgers are append-only and written by the pipeline-ops workers (see routes/pipeline_ops_workers.py). A row is one JSON object with at, key, phase, result, outcome and other fields. For each ledger the reader keeps the latest 'result' row whose key equals the branch. Latest means greatest 'at' (ISO-8601 string order), and a tie goes to the later line in append order.

read_merge_loop_status returns {'checker': entry, 'merger': entry}, where each entry is {'status': 'found' | 'no_row_for_branch' | 'file_missing', 'row': dict or None, 'skipped_malformed': int}. Malformed lines are non-JSON lines, non-object lines, and lines missing key, phase or at. Blank lines are ignored. One WARNING is logged per call when any malformed lines were skipped.

This module never writes, creates, renames or deletes either ledger.
'''
import json
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

REQUIRED_KEYS = ('at', 'key', 'phase')
RESULT_PHASE = 'result'
LEDGER_NAMES = ('checker', 'merger')


def _default_path(name):
    return str(Path.home() / '.local' / 'state' / 'pipeline-ops' / (name + '-ledger.jsonl'))


def _read_ledger(path, branch):
    if not os.path.isfile(path):
        return {'status': 'file_missing', 'row': None, 'skipped_malformed': 0}
    skipped = 0
    best = None
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except ValueError:
                skipped += 1
                continue
            if not isinstance(row, dict) or any(k not in row for k in REQUIRED_KEYS) or not isinstance(row['at'], str):
                skipped += 1
                continue
            if row['key'] != branch or row['phase'] != RESULT_PHASE:
                continue
            if best is None or row['at'] >= best['at']:
                best = row
    status = 'found' if best is not None else 'no_row_for_branch'
    return {'status': status, 'row': best, 'skipped_malformed': skipped}


def read_merge_loop_status(branch, checker_path=None, merger_path=None):
    paths = {
        'checker': _default_path('checker') if checker_path is None else checker_path,
        'merger': _default_path('merger') if merger_path is None else merger_path,
    }
    out = {name: _read_ledger(paths[name], branch) for name in LEDGER_NAMES}
    skipped = {name: out[name]['skipped_malformed'] for name in LEDGER_NAMES}
    if sum(skipped.values()) > 0:
        log.warning('merge-loop ledgers: skipped malformed lines for branch %s (checker=%d, merger=%d)', branch, skipped['checker'], skipped['merger'])
    return out
