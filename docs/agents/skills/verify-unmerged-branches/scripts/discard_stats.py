#!/usr/bin/env python3
"""Discard / merge / needs-work rates per task family, from the branch-verdict stores of every pipeline.

usage: discard_stats.py [--since YYYY-MM-DD] [--root /media/model-cache/github] [--causes] [--compute] [--json]

Reads <root>/*-pipeline/queue/branch-verdicts.json plus the core pipeline's (/media/wok/model-cache/agent-manager/queue). Only the LATEST chat/manual
verdict per branch counts (deterministic verdicts are ignored, so automatic triage-queue discards do not inflate the numbers).
Families: brain-dump adhoc, other adhoc, decompose, arch-review, obs/perf-fix, other. For brain-dump adhoc it also splits by executedVerification
status of the done record. --causes buckets the discard reasons (false premise, duplicate/superseded, inert, wrong repo/retired, other).
--compute joins each counted branch to the model_calls rows of its task (<pipeline>/model-stats.db, task_id = the branch name without 'agent/', and for
'decompose-<id>' also <id>) and prints model-hours and tokens per family and verdict. A decompose hub branch is priced only by its own parent task's calls: the
calls of the hub's pieces are recorded under their own ids and are not joined here.
Target (2026-10-24 analysis): brain-dump adhoc discard rate <= 10% (was 24%, n=277; other adhoc 4%).
"""
import argparse, collections, glob, json, os, re, sqlite3

CORE = "/media/wok/model-cache/agent-manager"
CAUSES = collections.OrderedDict([
    ("false premise / already handled", r"premise|already (wraps|calls|writes|records|handled|surfac|catches|done|pushes|persist)|never existed|not silent|already has|already covers|master already"),
    ("duplicate / superseded", r"redundant|supersed|duplicate|identical|same (fix|change)|rival|already on master|patch-id|rescued copy|recurring"),
    ("inert / nothing consumes it", r"inert|dead on arrival|nothing (sets|reads|calls)|no (producer|consumer)|unused|orphan"),
    ("wrong repo / retired", r"wrong (repo|place)|retired|archive|invented"),
    ("breaks main", r"break|broken|reproduced|regress|fails"),
])


def family(name):
    n = name.replace("agent/", "")
    if n.startswith("adhoc-brain-dump"): return "brain-dump adhoc"
    if n.startswith("decompose"): return "decompose"
    if "observability-fix" in n or "performance-fix" in n: return "obs/perf-fix"
    if "arch-review" in n: return "arch-review"
    if n.startswith("adhoc"): return "other adhoc"
    return "other"


def task_ids(br):
    n = br.replace("agent/", "")
    return [n] + ([n[len("decompose-"):]] if n.startswith("decompose-") else [])


def calls_by_task(q):
    """{task_id: {"calls", "ms", "ptok", "etok"}} from <pipeline>/model-stats.db (q is the pipeline's queue dir); {} when the file or table is missing."""
    db = os.path.join(os.path.dirname(q), "model-stats.db")
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            cols = {r[1] for r in con.execute("PRAGMA table_info(model_calls)")}
            if "task_id" not in cols: return {}
            pick = lambda c: f"COALESCE(SUM({c}), 0)" if c in cols else "0"
            sql = f"SELECT task_id, COUNT(*), {pick('latency_ms')}, {pick('prompt_eval_count')}, {pick('eval_count')} FROM model_calls GROUP BY task_id"
            return {t: {"calls": n, "ms": ms, "ptok": p, "etok": e} for t, n, ms, p, e in con.execute(sql)}
        finally:
            con.close()
    except sqlite3.Error:
        return {}


def add_compute(acc, per_task, br):
    """Adds the branch's recorded calls to acc (a Counter) and counts it matched or unmatched."""
    found = [per_task[t] for t in task_ids(br) if t in per_task]
    if not found:
        acc["unmatched"] += 1
        return
    acc["matched"] += 1
    for k in ("calls", "ms", "ptok", "etok"): acc[k] += sum(f[k] for f in found)


def compute_row(acc):
    m = acc["matched"]
    return {"matched": m, "unmatched": acc["unmatched"], "calls": acc["calls"], "model_hours": round(acc["ms"] / 3.6e6, 2),
            "prompt_tokens_m": round(acc["ptok"] / 1e6, 2), "eval_tokens_m": round(acc["etok"] / 1e6, 2),
            "avg_model_hours": round(acc["ms"] / 3.6e6 / m, 2) if m else 0}


def load(root, since):
    dirs = glob.glob(os.path.join(root, "*-pipeline")) + ([CORE] if os.path.isdir(CORE) else [])
    for pdir in dirs:
        q = os.path.join(pdir, "queue")
        try: store = json.load(open(os.path.join(q, "branch-verdicts.json")))
        except (OSError, ValueError): continue
        for br, shas in store.items():
            if not isinstance(shas, dict) or not shas: continue
            best = sorted(shas.values(), key=lambda v: v.get("verifiedAt", ""))[-1]
            if best.get("source") not in ("chat", "manual"): continue
            if since and best.get("verifiedAt", "")[:10] < since: continue
            yield q, br, best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since"); ap.add_argument("--root", default="/media/model-cache/github")
    ap.add_argument("--causes", action="store_true"); ap.add_argument("--json", action="store_true")
    ap.add_argument("--compute", action="store_true")
    a = ap.parse_args()
    fam = collections.defaultdict(collections.Counter); ev = collections.defaultdict(collections.Counter)
    causes = collections.Counter(); out = {}
    comp = collections.defaultdict(lambda: collections.defaultdict(collections.Counter)); db_cache = {}
    for q, br, v in load(a.root, a.since):
        f = family(br); fam[f][v["verdict"]] += 1
        if a.compute:
            if q not in db_cache: db_cache[q] = calls_by_task(q)
            add_compute(comp[f][v["verdict"]], db_cache[q], br)
        if f == "brain-dump adhoc":
            n = br.replace("agent/", "")
            rec = next(iter(glob.glob(f"{q}/done/{n}.json") + glob.glob(f"{q}/done/_archived_no_action/{n}.json")), None)
            if rec:
                try: ev[((json.load(open(rec)).get("executedVerification") or {}).get("status", "none"))][v["verdict"]] += 1
                except (OSError, ValueError): pass
        if v["verdict"] == "discard":
            text = " ".join(v.get("reasons") or [])
            causes[next((k for k, rx in CAUSES.items() if re.search(rx, text, re.I)), "other")] += 1
    def row(c):
        t = sum(c.values()); return {"n": t, **{k: round(c[k] / t, 3) for k in ("discard", "merge", "needs-work")}}
    out["families"] = {k: row(v) for k, v in fam.items()}
    out["brain_dump_by_exec_status"] = {k: row(v) for k, v in ev.items()}
    out["discard_causes"] = dict(causes)
    if a.compute: out["compute"] = {f: {vd: compute_row(c) for vd, c in vs.items()} for f, vs in comp.items()}
    if a.json: print(json.dumps(out, indent=1)); return
    print(f"verdicts counted: {sum(sum(c.values()) for c in fam.values())}" + (f" (since {a.since})" if a.since else ""))
    for k, r in sorted(out["families"].items(), key=lambda kv: -kv[1]["discard"]):
        print(f"  {k:18} n={r['n']:4}  discard={r['discard']:.0%}  merge={r['merge']:.0%}  needs-work={r['needs-work']:.0%}")
    if out["brain_dump_by_exec_status"]:
        print("brain-dump adhoc by executedVerification status:")
        for k, r in out["brain_dump_by_exec_status"].items(): print(f"  {k:14} n={r['n']:4}  discard={r['discard']:.0%}  merge={r['merge']:.0%}")
    if a.causes:
        print("discard causes (all families):")
        for k, c in causes.most_common(): print(f"  {c:4} {k}")
    if a.compute:
        print("compute (model_calls joined to the branch's task id; a decompose hub counts only its parent task's calls):")
        for f, vs in sorted(out["compute"].items()):
            for vd, r in sorted(vs.items()):
                print(f"  {f:18} {vd:11} matched={r['matched']:4} unmatched={r['unmatched']:4} calls={r['calls']:6} model-h={r['model_hours']:8.2f} "
                      f"prompt={r['prompt_tokens_m']:7.2f}M eval={r['eval_tokens_m']:6.2f}M avg-h/branch={r['avg_model_hours']:.2f}")


if __name__ == "__main__":
    main()
