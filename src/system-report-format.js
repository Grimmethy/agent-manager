'use strict';

// system-report-format.js -- extracted from src/system-report.js ([[hub-task-integration]] node-module decompose).

function fmtLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  });
}

function fmtDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtUsd(usd) {
  return `$${usd.toFixed(4)}`;
}

module.exports = { fmtLocal, fmtDuration, fmtUsd };
