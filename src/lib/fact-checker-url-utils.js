'use strict';

// fact-checker-url-utils.js -- extracted from src/fact-checker.js ([[hub-task-integration]] node-module decompose).

function extractDomainRoot(url) {
  let hostname;
  try {
    ({ hostname } = new URL(url));
  } catch (e) {
    return null;
  }
  // 2026-10-22: never treat an IP literal as a named service. `extractDomainRoot` on an
  // IPv4 host returns the third octet (e.g. '112' from 100.96.112.78), which is a number
  // that will appear incidentally in other IPs, version strings, ports, etc. in source
  // text -- causing a false "named service" exemption for any invented address that
  // happens to share that number. Same class of hazard for IPv6 labels. If the hostname
  // is an IP literal, return null so isNamedServiceUrl never exempts it.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
  if (/^\[[0-9a-fA-F:]+\]$/.test(hostname)) return null;
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] || null;
  return labels[labels.length - 2];
}

module.exports = { extractDomainRoot };
