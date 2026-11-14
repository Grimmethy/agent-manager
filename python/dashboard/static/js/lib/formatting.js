function fmtPct(x) { return x == null ? '-' : Math.round(x * 100) + '%'; }

function fmtNum(x, digits) { return x == null ? '-' : Number(x).toFixed(digits); }

function fmtUsd(x) { return x == null ? '-' : '$' + Number(x).toFixed(4); }
