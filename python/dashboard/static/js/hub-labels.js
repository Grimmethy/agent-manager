// Pure hub-label resolver for the Hub Tasks tab. Record shape matches task_summary()
// in python/dashboard/app_task_helpers.py: id, hubLabel, parentHub.
// No timers, no watchers, no side effects: the caller decides when to resolve.

function resolveHubLabels(hubRecords) {
  var records = Array.isArray(hubRecords) ? hubRecords : [];

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function labelOf(rec) {
    var hl = rec.hubLabel;
    return (hl !== null && hl !== undefined && hl !== '') ? hl : rec.id;
  }

  var byId = {};
  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    if (!rec || typeof rec !== 'object') continue;
    if (rec.id === null || rec.id === undefined || rec.id === '') continue;
    byId[rec.id] = rec;
  }

  var result = {};
  var ids = Object.keys(byId);
  for (var j = 0; j < ids.length; j++) {
    var id = ids[j];
    var r = byId[id];
    var parentRecordId = (r.parentHub === null || r.parentHub === undefined) ? null : r.parentHub;
    var parentLabel = null;
    if (parentRecordId !== null && hasOwn(byId, parentRecordId)) {
      parentLabel = labelOf(byId[parentRecordId]);
    }
    result[id] = {
      label: labelOf(r),
      recordId: r.id,
      parentRecordId: parentRecordId,
      parentLabel: parentLabel
    };
  }
  return result;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { resolveHubLabels };
