# Architecture Import Candidates

### AC-1 · Slug Generation Pattern Not Found in Agent-Manager
Strength: Speculative
Source: hatchet-dev-Hatchet — "Pure slug generation with random suffix"
Files: (no real matches found)

Problem:
The search queries proposed to locate analogous slug-generation logic in agent-manager's own codebase returned zero results. This indicates that agent-manager does not currently implement a `generateTenantSlug`-style function, nor does it use patterns like `runId`, `randomSuffix`, or `uniqueId` for deriving slugs from user-provided names in its task pipeline.

Solution:
Since no matching code exists in agent-manager's real files, the original finding cannot be directly adapted here. If agent-manager later introduces slug generation for workflow run IDs or worker group identifiers derived from user input, the recommendation to use crypto-secure randomness instead of `Math.random()` would apply at that point.

Benefits:
No immediate benefit can be realized because there is no corresponding code in agent-manager to improve. Forcing this candidate onto unrelated files would violate the constraint against inventing matches.

### AC-2 · Provider-aware base URL defaults in model-provider routing
Strength: Strong
Source: contrix — "Base URL defaults per provider type"
Files: src/model-provider.js, src/model-provider.test.js

Problem:
`model-provider.js` currently implements a two-way backend selection (ornith vs. claude) with no concept of endpoint configuration beyond what each client module independently resolves. The routing logic (`providerFor()`) and the base URL resolution are decoupled — there is no single source of truth for which endpoint a given provider maps to, so adding support for additional backends requires patching every consumer rather than registering them alongside the routing table.

Solution:
Extend `model-provider.js` with a provider-specific base URL mapping that lives alongside the existing routing logic. Add a `getEndpoint(source)` helper (internal, not exported) that resolves endpoint configuration by looking up the selected provider in a centralized map, falling back to documented defaults for each backend. The function should accept an optional override parameter so callers can inject per-request endpoints when needed. Update `model-provider.test.js` with coverage for every branch: known providers returning their default endpoints, unknown sources returning `null`, and explicit overrides taking precedence over defaults.

Benefits:
Adding new providers becomes a matter of registering them in one lookup table plus implementing their client module, without touching routing logic or duplicating configuration patterns. Operators can override base URLs per-provider via environment variables without modifying source code — the override path flows through the same helper already tested. The model-stats labeling already distinguishes ornith vs. claude; extending this to capture endpoint metadata (region, API version) becomes natural when the provider selection layer owns that information.

NOTE: Flag 2 was not fully applied because its reasoning appeared incomplete and I cannot confirm whether `configFor` was intended as exported or internal without the full critique text -- the corrected draft uses an internal helper instead to avoid any ambiguity about public surface area.

### AC-3 · Extract Pure Describe from Event Store
Strength: Strong

**Strength:** Worth exploring  
**Source:** konjoai-lopi — "Pure describe() function for event-to-display mapping"  
**Files:** `internal/events/types.go`, `internal/store/event_store.go`

---

#### Problem
Agent-manager defines event types (e.g. `draft_status_changed`, `review_gate_passed`) in its event package and persists them through the store, but any human-readable summary or status label is likely generated inline within store operations or handlers — mixing display formatting with persistence concerns. This makes it difficult to unit-test the user-facing representation independently of database side-effects, and couples presentation logic to the storage layer.

---

#### Solution

**Design decision: package-level function over receiver method.**  
The TypeScript source uses standalone functions (`describe(ev)`) that take an event object and return a string. In Go, this maps cleanly to a **package-level function** on `internal/events/`, not a receiver method — the describe logic is stateless and depends only on input fields, so a receiver would imply unnecessary coupling to a concrete type or interface. No `Describable` interface is needed; keep it as a simple `func Describe(ev Event) string`.

**Concrete changes:**

1. **Add `Describe()` to `internal/events/types.go`:**
   ```go
   // Describe returns a human-readable summary of the event's semantic meaning.
   // It is pure: no side effects, no store access, deterministic for equal inputs.
   func Describe(ev Event) string {
       switch ev.Type {
       case EventTypeDraftStatusChanged:
           return fmt.Sprintf("Draft %s changed status to %q", ev.DraftID, ev.Status)
       case EventTypeReviewGatePassed:
           return fmt.Sprintf("Review gate passed for draft %s", ev.DraftID)
       // ... cover all event types in the package
       default:
           return fmt.Sprintf("Event %q occurred at %s", ev.Type, ev.Timestamp.Format(time.RFC3339))
       }
   }
   ```

2. **Remove inline describe logic from `internal/store/event_store.go`:**  
   Replace any ad-hoc string formatting that constructs user-facing summaries with a call to `events.Describe(ev)`. If the store currently builds display strings during persistence or retrieval, extract those branches into the pure function above.

3. **Update all callers:**  
   Search for any other location in agent-manager that produces human-readable event summaries (handlers, UI formatters, loggers with user-facing intent) and route them through `events.Describe()` instead of duplicating format logic.

---

#### Target Event Types (scope)

The following events defined in `internal/events/types.go` require a `Describe()` case:

| Event Type Constant | Example Fields Used |
|---------------------|---------------------|
| `EventTypeDraftStatusChanged` | `DraftID`, `Status` |
| `EventTypeReviewGatePassed` | `DraftID` |
| `EventTypeDraftCreated` | `DraftID`, `AuthorID` |
| `EventTypeDraftDeleted` | `DraftID` |
| `EventTypeCommentAdded` | `DraftID`, `CommenterID` |
| `EventTypeAssignmentChanged` | `DraftID`, `AssigneeID` |

(Verify against the actual enum in `types.go`; add cases for any event type not listed above.)

---

#### Test Strategy (Go)

**Structure:** Table-driven test in `internal/events/types_test.go`. The function is pure, so no mocks or store fixtures are needed — only input events and expected output strings.

```go
func TestDescribe(t *testing.T) {
    tests := []struct {
        name     string
        event    Event
        want     string
    }{
        {
            name: "draft status changed",
            event: Event{
                Type:      EventTypeDraftStatusChanged,
                DraftID:   "d-123",
                Status:    "approved",
                Timestamp: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
            },
            want: `Draft d-123 changed status to "approved"`,
        },
        {
            name: "review gate passed",
            event: Event{
                Type:      EventTypeReviewGatePassed,
                DraftID:   "d-456",
                Timestamp: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
            },
            want: `Review gate passed for draft d-456`,
        },
        {
            name: "unknown event type falls through to default",
            event: Event{
                Type:      "custom_event_xyz",
                Timestamp: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
            },
            want: `Event "custom_event_xyz" occurred at 20
