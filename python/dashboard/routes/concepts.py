import uuid
from datetime import datetime, timezone

from flask import Blueprint, abort, jsonify, request

# NOTE: `GHOST_CONCEPT_ID`, `read_concepts`, `write_concepts` and friends live in app.py,
# which imports this module to register the blueprint -- importing them at module top is
# a circular import that only fails when app.py is the entrypoint (`python app.py`, i.e.
# how the dashboard actually runs), because then `from app import ...` here triggers a
# *second*, re-entrant import of app.py. Pull them in lazily inside each view instead:
# by the time any view runs, app.py is fully initialised and `from app import ...` is
# just a dict lookup. (Same pattern as routes/reports.py.)

concepts_bp = Blueprint("concepts-bp", __name__)


@concepts_bp.route("/api/concepts/<concept_id>/ghost-telemetry")
def api_concept_ghost_telemetry(concept_id):
    """Audit surface for concept-ghost-in-the-machine-0dbeea: how often the pipeline
    recovered a task itself vs. how often a human/agent hand-fixed it (a requeue click).
    404 for any other concept -- this data isn't per-concept, the route is just that
    concept's dashboard hook."""
    from app import GHOST_CONCEPT_ID, _ghost_telemetry
    if concept_id != GHOST_CONCEPT_ID:
        abort(404)
    try:
        days = max(1, min(365, int(request.args.get("days", 30))))
    except (TypeError, ValueError):
        days = 30
    return jsonify({"conceptId": concept_id, **_ghost_telemetry(days)})


@concepts_bp.route("/api/concepts")
def api_concepts():
    """Concept Chart tab's list view -- see AGENTS.md's "Concept research" section for
    what a concept is and why this stays a manually/organically populated registry, not
    an autonomous task source."""
    from app import read_concepts
    return jsonify(read_concepts())


@concepts_bp.route("/api/concepts", methods=["POST"])
def api_concepts_create():
    """Manual concept creation (the dashboard's "+ New Concept" action). Idempotent on
    the slugified name -- matches src/concepts.js's createConcept(), since an organic
    creation from a research fork can race a human creating the same concept by hand."""
    from app import read_concepts, slugify_concept_name, write_concepts
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, description="name is required")
    description = (body.get("description") or "").strip()

    concepts = read_concepts()
    slug = slugify_concept_name(name)
    existing = next((c for c in concepts if c.get("slug") == slug), None)
    if existing:
        return jsonify(existing)

    concept = {
        "id": f"concept-{slug}-{uuid.uuid4().hex[:6]}",
        "slug": slug,
        "name": name,
        "description": description,
        "status": "open",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "createdBy": "manual",
        "researchForkCount": 0,
        "lastResearchedAt": None,
        "builtFromScratchCount": 0,
        "adaptedFromResourceCount": 0,
    }
    # kind (2026-09-08, Grimmethy: "a blank template that can be viewed in the concepts
    # tab" -- see src/concepts.js's own createConcept() comment): distinguishes a
    # reference/template document from every existing concept's narrative finding, so
    # the frontend can render it with real markdown instead of plain escaped text.
    # Mirrors the Node side's own behavior: omitted entirely unless explicitly
    # 'reference', so an ordinary create (and every existing concept) is unaffected.
    if body.get("kind") == "reference":
        concept["kind"] = "reference"
    concepts.append(concept)
    write_concepts(concepts)
    return jsonify(concept)


@concepts_bp.route("/api/concepts/<concept_id>/shelve", methods=["POST"])
def api_concepts_shelve(concept_id):
    """Parks a concept deliberately -- mirrors src/concepts.js's shelveConcept() exactly
    (this dashboard's concept CRUD is a parallel Python-native implementation, same as
    api_concepts_create above, not a Node subprocess call). Requires a real reason: the
    whole point is capturing WHY a future session shouldn't have to re-derive the same
    judgment call from scratch (2026-09-06, real incident: Task Atomization was scoped
    as "a job for a whole day of work" and shelved for exactly that reason, with no way
    to record it before this)."""
    from app import CONCEPT_STABLE_STATUSES, _find_concept_or_404, read_concepts, write_concepts
    body = request.get_json(silent=True) or {}
    reason = (body.get("reason") or "").strip()
    if not reason:
        abort(400, description="reason is required")
    revisit_condition = (body.get("revisitCondition") or "").strip() or None

    concepts = read_concepts()
    concept = _find_concept_or_404(concepts, concept_id)
    if concept.get("status") in CONCEPT_STABLE_STATUSES:
        abort(409, description=f"concept is already {concept.get('status')} -- reopen it first")

    concept["statusBeforeShelve"] = concept.get("status")
    concept["status"] = "shelved"
    concept["shelvedAt"] = datetime.now(timezone.utc).isoformat()
    concept["shelvedReason"] = reason
    concept["revisitCondition"] = revisit_condition
    write_concepts(concepts)
    return jsonify(concept)


@concepts_bp.route("/api/concepts/<concept_id>/reopen", methods=["POST"])
def api_concepts_reopen(concept_id):
    """The only way out of 'shelved' (or 'shipped', for the rare "actually, more to do
    here" case) -- restores whatever status the concept held right before it was
    shelved, defaulting to 'researched' for a shipped concept reopened with no prior
    shelve on record. Mirrors src/concepts.js's reopenConcept()."""
    from app import CONCEPT_STABLE_STATUSES, _find_concept_or_404, read_concepts, write_concepts
    concepts = read_concepts()
    concept = _find_concept_or_404(concepts, concept_id)
    if concept.get("status") not in CONCEPT_STABLE_STATUSES:
        abort(409, description="concept is not shelved or shipped")

    concept["status"] = concept.pop("statusBeforeShelve", None) or "researched"
    concept.pop("shelvedAt", None)
    concept.pop("shelvedReason", None)
    concept.pop("revisitCondition", None)
    write_concepts(concepts)
    return jsonify(concept)


@concepts_bp.route("/api/concepts/<concept_id>/ship", methods=["POST"])
def api_concepts_ship(concept_id):
    """The concept's work is genuinely done, not just "some work happened" (which
    'in-progress' already means) -- mirrors src/concepts.js's shipConcept()."""
    from app import CONCEPT_STABLE_STATUSES, _find_concept_or_404, read_concepts, write_concepts
    concepts = read_concepts()
    concept = _find_concept_or_404(concepts, concept_id)
    if concept.get("status") in CONCEPT_STABLE_STATUSES:
        abort(409, description=f"concept is already {concept.get('status')}")

    concept["status"] = "shipped"
    concept["shippedAt"] = datetime.now(timezone.utc).isoformat()
    write_concepts(concepts)
    return jsonify(concept)


@concepts_bp.route("/api/concepts/<concept_id>/timeline")
def api_concept_timeline(concept_id):
    """On-demand merge of a concept's research findings (brain-dump entries whose
    raisedBy.conceptId matches) and implementation task history, sorted chronologically --
    a query over existing data, never a duplicated log, so it can't drift from the
    source (see src/concepts.js's getConceptTimeline, this route's Node-side
    equivalent). Task-history coverage is time-budgeted -- see
    _concept_task_history_rows's own header for the 73s live incident this closes --
    so `truncated: true` means the done/-archive history may be incomplete, not that
    nothing was found."""
    from app import _concept_task_history_rows, get_pipeline_dir, read_brain_dump_entries
    pipeline_dir = get_pipeline_dir()
    if not pipeline_dir:
        abort(500, description="no active project configured")

    rows = []
    for entry in read_brain_dump_entries():
        raised_by = entry.get("raisedBy") or {}
        if raised_by.get("conceptId") != concept_id:
            continue
        raw_text = entry.get("rawText") or ""
        rows.append({
            "at": entry.get("capturedAt") or entry.get("lastSeenAt"),
            "kind": "research-finding",
            "ref": entry.get("id"),
            "summary": raw_text.split("\n")[0][:120],
        })
    task_rows, truncated = _concept_task_history_rows(pipeline_dir, concept_id)
    rows.extend(task_rows)
    rows.sort(key=lambda r: r.get("at") or "")
    return jsonify({"rows": rows, "truncated": truncated})
