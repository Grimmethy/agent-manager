// Shared "assign a task" picker (HUB0325 piece W-B4a): the type select and, once a type is chosen, the task select of a worker. Moved out of renderWorkers in workers-tab.js; the body below is the
// original code (comments included) apart from its two inputs: `items` (that instance's assignable tasks) and `selectedType` (the type picked so far, '' for none) are parameters now instead of being
// read from assignableByInstance and selectedWorkerTaskType. Used by the Workers tab cards and, later, the Graph node panel.
// A plain global <script> holding only declarations, loaded by index.html before workers-tab.js; uses escapeHtml, escapeAttr and hubTag from the shared global scope.
function buildTaskPickerHtml(inst, items, selectedType) {
          items = items || [];
          // Grouped by source (task TYPE) so the picker shows "pipeline_debrief (7)"
          // etc first, rather than one flat list where a deep single-type backlog
          // buries everything else (see selectedWorkerTaskType's own header comment).
          const bySource = {};
          items.forEach((t) => {
            const key = t.source || 'unknown';
            (bySource[key] = bySource[key] || []).push(t);
          });
          const sourceKeys = Object.keys(bySource).sort();
          selectedType = selectedType || '';
          // Keep the previously-picked type visible even if its bucket happens to be
          // empty on THIS particular poll (its last task just got claimed elsewhere, or
          // this instance's own assignable-tasks fetch above hit its catch and fell back
          // to [] for one cycle) -- 2026-09-07, same complaint as isPoll above: a
          // transient empty bucket used to collapse the whole drill-down back to the
          // type-only picker, which looked identical to "your selection got reset" even
          // though selectedWorkerTaskType was never actually cleared.
          if (selectedType && !sourceKeys.includes(selectedType)) sourceKeys.push(selectedType);
          sourceKeys.sort();
          const typeSelect = `<select class="worker-type-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()" title="Assign a specific task to this worker, overriding the automated priority/tier claim order -- includes tasks already claimed by other workers, tier-filtered for this worker type">
            <option value="">(assign a task…)</option>
            ${sourceKeys.map(k => `<option value="${escapeAttr(k)}" ${k === selectedType ? 'selected' : ''}>${escapeHtml(k)} (${(bySource[k] || []).length})</option>`).join('')}
          </select>`;
          if (!selectedType) return typeSelect;
          const tasksOfSelectedType = bySource[selectedType] || [];
          // A native <select> sizes itself to its widest <option> text -- an untruncated
          // task title (adhoc/decompose titles especially routinely run 80-100+ chars)
          // pushed this whole control off the right edge of the worker card (2026-09-07,
          // Grimmethy: "when I open the manual task that has long task names it sets the
          // selector to the size of the largest... names should be truncated"). Truncate
          // what's SHOWN; the option's own `title` attribute (native hover tooltip) and
          // `data-title` (read by setWorkerTask's confirm-dialog text) both still carry
          // the full, untruncated title -- nothing is actually lost, just not rendered
          // into the control's own width.
          const OPTION_LABEL_MAX = 70;
          const truncateLabel = (s) => (s.length > OPTION_LABEL_MAX ? `${s.slice(0, OPTION_LABEL_MAX - 1)}…` : s);
          const optionLabel = (t) => {
            // A hub member leads with its HUB#### slot (2026-09-20) so a hub in progress is recognisable in this list.
            const rawTitle = t.title || t.id;
            const base = t.hub && !/^HUB\d/.test(rawTitle) ? `${hubTag(t.hub)} · ${rawTitle}` : rawTitle;
            // pinnedTo (2026-09-07, Grimmethy: "why do the 2 reasoning workers have
            // different lists? they really should share the same task list") -- a task
            // pending but already pinned to a SIBLING lane (same tier) now shows here
            // too instead of being invisible; picking it just re-pins it to this lane
            // instead (no kill needed, nothing is running on it yet, unlike the
            // "⚠ running on" case below).
            let full = base;
            if (t.location && t.location !== 'pending') full = `⚠ running on ${t.location.replace(/^drafting:/, '')} — ${base}`;
            else if (t.pinnedTo) full = `📌 pinned to ${t.pinnedTo} — ${base}`;
            // premiumPriority (2026-09-07, Grimmethy: "I am getting tired of manually
            // selecting it for the worker queue every pass") -- surfaces here so the
            // operator can SEE this task is already set to always-claim-first and
            // doesn't need to keep re-picking it via this very dropdown.
            if (t.premiumPriority) full = `★ ${full}`;
            return truncateLabel(full);
          };
          const taskSelect = `<select class="worker-task-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()" title="Pick a specific ${escapeAttr(selectedType)} task to assign to this worker">
            <option value="">${tasksOfSelectedType.length ? `(choose a ${escapeHtml(selectedType)} task…)` : `(no ${escapeHtml(selectedType)} tasks right now)`}</option>
            ${tasksOfSelectedType.map(t => `<option value="${escapeAttr(t.id)}" data-title="${escapeAttr(t.title || t.id)}" data-source-lane="${escapeAttr(t.location && t.location !== 'pending' ? t.location.replace(/^drafting:/, '') : '')}" title="${escapeAttr(t.title || t.id)}">${escapeHtml(optionLabel(t))}</option>`).join('')}
          </select>`;
          return typeSelect + taskSelect;

}

if (typeof module !== 'undefined') module.exports = { buildTaskPickerHtml };
