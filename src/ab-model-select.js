'use strict';

// Node port of ornith-worker.ps1's Select-AbModel -- the Linux/bash side never had this at
// all (ORNITH_AB_MODELS was a PowerShell-only mechanism; model-strategies.js's own
// resolveStrategy() shipped fully built alongside it but had zero real callers on this
// port either, see its own header). Added 2026-08-19 to extend the mechanism to also cover
// worker-reasoning's local-vs-Claude choice (Grimmethy: "extend the live A/B mechanism"),
// which needed a real caller to exist first.
//
// Deterministic hash of taskId -> the SAME task always resolves to the SAME candidate
// across its whole redraft lifecycle (a watchdog reject-retry keeps testing the same
// model), with no persistent counter file needed. MD5 + first-4-bytes-as-uint32-LE is
// byte-for-byte what the PowerShell reference did
// ([BitConverter]::ToUInt32($hash, 0) is little-endian on the x86/x64 hosts this pipeline
// runs on) -- kept identical so a mixed Windows/Linux worker-instance fleet would agree on
// the same candidate for the same taskId, even though nothing currently exercises that.
function selectAbModel(taskId, candidates) {
  if (!candidates || candidates.length <= 1) return null;
  const hash = require('crypto').createHash('md5').update(String(taskId)).digest();
  const idx = hash.readUInt32LE(0) % candidates.length;
  return candidates[idx];
}

module.exports = { selectAbModel };
