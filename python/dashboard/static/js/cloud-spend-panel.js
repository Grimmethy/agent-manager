// Cloud spend panel for the Workers tab: month-to-date and today's spend through the cloud lane's gateway (the cloud-providers repo), its cap, and a
// warning marker once the cap is exceeded. A plain global <script> (no require/module.exports), loaded by index.html right after workers-tab.js, whose
// renderWorkers() appends renderCloudSpendSection(meter). `meter` is the GET /api/cloud-meter payload (routes/cloud_meter.py): {cloudLane, available,
// monthToDate, today, cap, provider, model, error}. Both functions are pure string builders: no DOM, no fetch, so they are unit-testable in a bare vm context.

function cloudSpendEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cloudSpendInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function cloudSpendUsd(n) {
  return '$' + (Number(n) || 0).toFixed(2);
}

// One period's totals ({calls, inputTokens, outputTokens, costUsd, unpriced}) as a single line.
function cloudSpendPeriodLine(label, totals) {
  const t = totals || {};
  let cost = cloudSpendUsd(t.costUsd);
  if (t.unpriced) {
    const note = 'unpriced -- set CLOUD_PRICE_IN_PER_MTOK/CLOUD_PRICE_OUT_PER_MTOK';
    cost = Number(t.costUsd) > 0 ? cloudSpendUsd(t.costUsd) + ' priced, plus ' + note : note;
  }
  return '<div style="margin-top:4px"><strong>' + cloudSpendEsc(label) + '</strong> '
    + cloudSpendInt(t.calls) + ' calls · '
    + cloudSpendInt(t.inputTokens) + ' in / ' + cloudSpendInt(t.outputTokens) + ' out tokens · '
    + cloudSpendEsc(cost) + '</div>';
}

function buildCloudSpendHtml(meter) {
  if (!meter || !meter.cloudLane) return '';
  const box = 'padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin:12px 0;';
  const title = '<div style="font-weight:600">☁ Cloud spend</div>';
  if (!meter.available) {
    const why = meter.error ? ' (' + cloudSpendEsc(meter.error) + ')' : '';
    return '<div id="cloud-spend-panel" style="' + box + '">' + title
      + '<div class="meta" style="margin-top:4px">Cloud gateway not reachable' + why + '. Start the cloud-providers plugin to see spend.</div></div>';
  }
  const cap = meter.cap || {};
  const capLine = cap.usd
    ? 'Cap ' + cloudSpendUsd(cap.usd) + ' (' + cloudSpendEsc(cap.mode || 'warn') + ')'
      + (cap.exceeded ? ' <span class="badge warn" title="Month-to-date spend has reached the monthly cap">cap exceeded</span>' : '')
    : 'No monthly cap';
  const source = [meter.provider, meter.model].filter(Boolean).map(cloudSpendEsc).join(' · ');
  return '<div id="cloud-spend-panel" style="' + box + '">' + title
    + (source ? '<div class="meta" style="margin-top:2px">' + source + '</div>' : '')
    + cloudSpendPeriodLine('Month to date', meter.monthToDate)
    + cloudSpendPeriodLine('Today', meter.today)
    + '<div style="margin-top:4px">' + capLine + '</div></div>';
}

// What renderWorkers() appends: nothing at all unless a cloud lane exists in the lane registry.
function renderCloudSpendSection(meter) {
  return meter && meter.cloudLane ? buildCloudSpendHtml(meter) : '';
}
