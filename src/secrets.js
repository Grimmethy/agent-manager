'use strict';

// Speculative credential-handling utilities -- agent-manager does not store or pass any
// secret today (Ollama is unauthenticated localhost, git push relies entirely on the
// machine's own ambient credential helper/SSH key, no API keys live anywhere in this
// codebase or agent-manager.env). Built ahead of a real need (2026-07-26, adapted from
// mcp-gateway-registry's credential hygiene patterns) so a future caller that DOES need to
// persist a token/key has a ready, tested place to do it correctly from day one, rather
// than reinventing this under time pressure the day it's actually needed.
//
// Platform note: 0600-mode enforcement (writeSecretFile) is a real, meaningful POSIX
// permission restriction on Linux/macOS. On Windows the `mode` argument to fs.open/chmod
// does not restrict other-user/group access the way POSIX permission bits do -- real
// access control there is ACL-based, a different mechanism this module does not attempt.
// Call sites on Windows should not treat writeSecretFile's mode argument as a security
// boundary; it is a correct, meaningful guarantee only on POSIX platforms.

const fs = require('fs');
const path = require('path');

// Atomic 0600-mode file creation: the mode is passed to the SAME open() call that creates
// the file, so there is no window where the file exists at a looser (e.g. default 0644)
// mode before being tightened -- the race mcp-gateway-registry's own atomic-creation
// pattern exists to close. If the file already exists, its permissions are tightened to
// 0600 as well (mirrors mcp-gateway-registry's `_assert_owner_only` helper: a pre-existing
// loose-mode secret file is still a real exposure, not just a fresh one).
function writeSecretFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w', 0o600);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
}

// Redacts a KNOWN secret value wherever it appears in a text blob (e.g. a log line, an
// error message about to be written to a file a human might read) -- deliberately not a
// heuristic "does this look like a token" pattern-matcher, which is both unreliable (misses
// unusual formats, false-positives on legitimate non-secret strings) and unnecessary here:
// every real call site already HAS the secret value in hand (it just generated or read it),
// so exact-match redaction is both simpler and strictly more reliable.
function redactSecret(text, secretValue, { visibleChars = 4 } = {}) {
  if (!text || !secretValue) return text;
  if (secretValue.length <= visibleChars) return text.split(secretValue).join('*'.repeat(secretValue.length));
  const redacted = '*'.repeat(secretValue.length - visibleChars) + secretValue.slice(-visibleChars);
  return text.split(secretValue).join(redacted);
}

// Write-only credential exposure: a caller (e.g. a dashboard API response) should report
// WHETHER a secret is configured, never the secret itself. `isConfigured` exists so that
// contract is explicit and reusable rather than every call site inventing its own
// `!!value` check (and one of them eventually forgetting and returning the raw value).
function isConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = { writeSecretFile, redactSecret, isConfigured };
