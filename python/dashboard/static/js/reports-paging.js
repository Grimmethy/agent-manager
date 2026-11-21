// Pure paging helpers for the Reports tab: no DOM access, no timers, no side effects.
// Top-level function declarations are browser globals; the guard at the bottom lets node:test require them.

function nextOffset(offset, pageSize) {
  var o = Number(offset);
  var p = Number(pageSize);
  if (!isFinite(o) || o < 0) o = 0;
  if (!isFinite(p) || p < 0) p = 0;
  return Math.floor(o) + Math.floor(p);
}

function hasMore(loadedCount, total) {
  if (typeof loadedCount !== 'number' || typeof total !== 'number') return false;
  if (!isFinite(loadedCount) || !isFinite(total)) return false;
  return loadedCount < total;
}

function appendPage(existing, page) {
  var out = Array.isArray(existing) ? existing.slice() : [];
  var seen = {};
  var i;
  for (i = 0; i < out.length; i++) {
    var e = out[i];
    if (e && typeof e === 'object') seen[String(e.period) + '\u0000' + String(e.filename)] = true;
  }
  if (!Array.isArray(page)) return out;
  for (i = 0; i < page.length; i++) {
    var item = page[i];
    if (!item || typeof item !== 'object') continue;
    var key = String(item.period) + '\u0000' + String(item.filename);
    if (Object.prototype.hasOwnProperty.call(seen, key)) continue;
    seen[key] = true;
    out.push(item);
  }
  return out;
}

function buildListUrl(limit, offset, period) {
  var l = Math.floor(Number(limit));
  var o = Math.floor(Number(offset));
  if (!isFinite(l)) l = 0;
  if (!isFinite(o) || o < 0) o = 0;
  var url = '/api/reports?limit=' + l + '&offset=' + o;
  if (typeof period === 'string' && period !== '') url += '&period=' + encodeURIComponent(period);
  return url;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { nextOffset, hasMore, appendPage, buildListUrl };
