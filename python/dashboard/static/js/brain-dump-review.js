// Brain Dump Review: entries the detector flags as request-shaped despite being
// sorted as notes. Shows a "Needs a look" section in the Brain Dump tab with
// three actions per entry: Make task, Keep as note, Dismiss.
//
// The review list is fetched from /api/brain-dump/review (GET). Each entry has:
//   id, serial, capturedAt, rawText, rationale, project, flagReasons
//
// Actions:
//   - Make task: POST /api/brain-dump/<id>/prioritize (reuses existing path)
//   - Keep: POST /api/brain-dump/<id>/keep (records sortReview.resolved='kept')
//   - Dismiss: POST /api/brain-dump/<id>/dismiss (records sortReview.resolved='dismissed')
//
// All actions update the card in place. Make task shows a confirmation dialog
// with the proposed project and title first.

let brainDumpReviewEntries = [];
let brainDumpReviewInterval = null;

async function loadBrainDumpReview() {
  try {
    const resp = await fetch('/api/brain-dump/review');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    brainDumpReviewEntries = await resp.json();
    renderBrainDumpReview();
  } catch (e) {
    const el = document.getElementById('bd-review-section');
    if (el) el.innerHTML = `<div class="empty">Could not load review: ${e.message}</div>`;
  }
}

function renderBrainDumpReview() {
  const section = document.getElementById('bd-review-section');
  if (!section) return;

  if (brainDumpReviewEntries.length === 0) {
    section.innerHTML = '';
    return;
  }

  section.innerHTML = `
    <div class="field-label" style="display:flex; justify-content:space-between; align-items:center; margin-top:16px;">
      <span>Needs a look (${brainDumpReviewEntries.length})</span>
      <span class="muted" style="font-size:11px">Detector flagged these as feature requests / bug reports, but the sorter filed them as notes</span>
    </div>
    <div id="bd-review-entries"></div>
  `;

  const container = document.getElementById('bd-review-entries');
  container.innerHTML = brainDumpReviewEntries.map(entry => renderReviewCard(entry)).join('');
  wireReviewCardHandlers(container);
}

function renderReviewCard(entry) {
  const serialBadge = entry.serial ? `<span class="bd-serial" title="Reference this entry as #${entry.serial}">#${entry.serial}</span> ` : '';
  const projectBadge = entry.project
    ? `<span class="badge idle" style="margin-left:6px" title="Proposed destination">${escapeHtml(entry.project)}</span>`
    : '';
  const reasons = entry.flagReasons && entry.flagReasons.length
    ? `<div class="muted" style="font-size:11px;margin-top:4px">Flagged for: ${entry.flagReasons.map(escapeHtml).join(', ')}</div>`
    : '';
  const rationale = entry.rationale
    ? `<div class="muted" style="font-size:11px;margin-top:2px">Sorter rationale: ${escapeHtml(entry.rationale)}</div>`
    : '';

  return `
    <div class="bd-entry bd-review-entry" data-id="${escapeAttr(entry.id)}">
      <div class="row">
        <span class="text">${serialBadge}${escapeHtmlBright(entry.rawText)}${projectBadge}</span>
      </div>
      <div class="row meta">${reasons}${rationale}</div>
      <div class="row" style="margin-top:8px">
        <span></span>
        <span>
          <button class="action" data-review-make-task="${escapeAttr(entry.id)}" title="Create a task for this entry (shows confirmation first)">Make task</button>
          <button class="secondary" data-review-keep="${escapeAttr(entry.id)}" title="Keep as note -- no task, never flagged again">Keep as note</button>
          <button class="secondary" data-review-dismiss="${escapeAttr(entry.id)}" title="Dismiss -- entry is done or stale">Dismiss</button>
        </span>
      </div>
    </div>
  `;
}

function wireReviewCardHandlers(el) {
  el.querySelectorAll('[data-review-make-task]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.reviewMakeTask;
      const entry = brainDumpReviewEntries.find(e => e.id === id);
      if (!entry) return;

      // Show confirmation with proposed project and title
      const project = entry.project || 'unassigned';
      const title = (entry.rawText || '').slice(0, 120);
      if (!confirm(`Create a task for this entry?\n\nProposed project: ${project}\nTitle: ${title}\n\n(This will queue the entry into the adhoc lane.)`)) {
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Queuing...';
      try {
        const resp = await fetch('/api/brain-dump/' + encodeURIComponent(id) + '/prioritize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error(body.description || ('HTTP ' + resp.status));
        }
        await loadBrainDumpReview();
      } catch (e) {
        alert('Could not create task: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Make task';
      }
    };
  });

  el.querySelectorAll('[data-review-keep]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.reviewKeep;
      btn.disabled = true;
      btn.textContent = 'Keeping...';
      try {
        const resp = await fetch('/api/brain-dump/' + encodeURIComponent(id) + '/keep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        await loadBrainDumpReview();
      } catch (e) {
        alert('Could not keep: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Keep as note';
      }
    };
  });

  el.querySelectorAll('[data-review-dismiss]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.reviewDismiss;
      btn.disabled = true;
      btn.textContent = 'Dismissing...';
      try {
        const resp = await fetch('/api/brain-dump/' + encodeURIComponent(id) + '/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'dismissed from review' }),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        await loadBrainDumpReview();
      } catch (e) {
        alert('Could not dismiss: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Dismiss';
      }
    };
  });
}

// Wire the review section into the Brain Dump tab shell
function injectReviewSectionIntoShell() {
  const shell = document.querySelector('.split-pane');
  if (!shell) return;
  const reviewDiv = document.createElement('div');
  reviewDiv.id = 'bd-review-section';
  reviewDiv.style.cssText = 'margin-top:20px;padding-top:16px;border-top:1px solid var(--border);';
  shell.appendChild(reviewDiv);
}

// Load review when entering Brain Dump tab
const origEnterBrainDump = window.enterBrainDumpTab;
if (origEnterBrainDump) {
  window.enterBrainDumpTab = async function() {
    await origEnterBrainDump();
    injectReviewSectionIntoShell();
    await loadBrainDumpReview();
    brainDumpReviewInterval = setInterval(loadBrainDumpReview, 10000);
  };
}

const origLeaveBrainDump = window.leaveBrainDumpTab;
if (origLeaveBrainDump) {
  window.leaveBrainDumpTab = function() {
    if (brainDumpReviewInterval) { clearInterval(brainDumpReviewInterval); brainDumpReviewInterval = null; }
    origLeaveBrainDump();
  };
}

if (typeof module !== 'undefined') module.exports = { loadBrainDumpReview, renderBrainDumpReview, renderReviewCard };
