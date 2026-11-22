'use strict';

// Chat tool gate: detects prohibitions in the last user message and returns
// which tools should be disabled for that request. Pure module -- no filesystem,
// network, or module-level state.

// All seven chat tools, in contract order.
const WRITE_CHAT_TOOLS = [
  'record_branch_verdict',
  'queue_reviewed_task',
  'requeue_blocked_task',
  'withdraw_task',
  'answer_task_clarification',
  'resolve_task_clarification',
  'mark_task_clarification_done',
];

// Blanket phrases that unconditionally disable all seven tools.
const BLANKET_PHRASES = [
  "read only",
  "read-only",
  "only report",
  "just report",
  "only look",
  "no changes",
  "don't change anything",
  "do not change anything",
  "investigate only",
  "look but do not touch",
];

// Negation tokens that trigger the negation-verb rule.
const NEGATION_WORDS = [
  'do not',
  "don't",
  'dont',
  'never',
  'without',
  'no',
  'avoid',
  'stop',
];

// Exception tokens that skip the negation-verb rule when they follow a negation.
const EXCEPTION_WORDS = [
  'know',
  'sure',
  'wait',
  'forget to',
  'forget about',
];

// Map verb tokens to the tool(s) they disable.
const VERB_TO_TOOL_MAP = {
  record: ['record_branch_verdict'],
  recording: ['record_branch_verdict'],
  verdict: ['record_branch_verdict'],
  flag: ['record_branch_verdict'],
  file: ['queue_reviewed_task'],
  filing: ['queue_reviewed_task'],
  queue: ['queue_reviewed_task'],
  queueing: ['queue_reviewed_task'],
  task: ['queue_reviewed_task'],
  tasks: ['queue_reviewed_task'],
  requeue: ['requeue_blocked_task'],
  withdraw: ['withdraw_task'],
  retire: ['withdraw_task'],
  archive: ['withdraw_task'],
  answer: ['answer_task_clarification', 'resolve_task_clarification', 'mark_task_clarification_done'],
  resolve: ['answer_task_clarification', 'resolve_task_clarification', 'mark_task_clarification_done'],
  unblock: ['answer_task_clarification', 'resolve_task_clarification', 'mark_task_clarification_done'],
};

// Normalize curly/smart apostrophes to straight apostrophe.
function normalizeApostrophes(text) {
  return text.replace(/[\u2018\u2019\u201B]/g, "'");
}

// Tokenize on whitespace, stripping surrounding punctuation from each token,
// but keeping don't, dont, and read-only intact.
function tokenize(text) {
  const raw = text.split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const t of raw) {
    if (t === "don't" || t === 'dont' || t === 'read-only') {
      tokens.push(t);
    } else {
      // Strip leading/trailing punctuation (not apostrophe for the special cases above).
      const stripped = t.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
      if (stripped) {
        tokens.push(stripped);
      }
    }
  }
  return tokens;
}

// Check if gate is enabled. Returns false only when env.AGENT_MANAGER_CHAT_TOOL_GATE
// is exactly 'off', 'false', or '0'. Everything else (including unset) returns true.
function isGateEnabled(env) {
  if (!env || typeof env !== 'object') {
    return true;
  }
  const val = env.AGENT_MANAGER_CHAT_TOOL_GATE;
  if (val === 'off' || val === 'false' || val === '0') {
    return false;
  }
  return true;
}

// Get the last user text from messages, falling back to prompt.
// Scans from the end for the last element with role === 'user' and string content.
// Otherwise returns prompt if it is a string, otherwise returns ''.
function lastUserText(messages, prompt) {
  if (Array.isArray(messages) && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === 'user' && typeof msg.content === 'string') {
        return msg.content;
      }
    }
  }
  if (typeof prompt === 'string') {
    return prompt;
  }
  return '';
}

// Detect which tools should be disabled based on the user message text.
// Returns { disabled: string[], matched: string[] }.
function disabledToolsForUserMessage(text, env) {
  // Early return: gate off or invalid text.
  if (!isGateEnabled(env) || typeof text !== 'string' || text.length === 0) {
    return { disabled: [], matched: [] };
  }

  const lowerText = text.toLowerCase();
  const normalized = normalizeApostrophes(lowerText);
  const tokens = tokenize(normalized);

  const disabledSet = new Set();
  const matchedSet = new Set();

  // Check blanket phrases first (word boundaries).
  for (const phrase of BLANKET_PHRASES) {
    const regex = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(normalized)) {
      for (const tool of WRITE_CHAT_TOOLS) {
        disabledSet.add(tool);
      }
      matchedSet.add(phrase);
    }
  }

  // Negation-verb rule: for each negation token, inspect next 3 tokens forward.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Check if this is a negation token.
    let isNegation = false;
    for (const neg of NEGATION_WORDS) {
      if (token === neg || (neg === 'do not' && token === 'do' && i + 1 < tokens.length && tokens[i + 1] === 'not')) {
        isNegation = true;
        break;
      }
    }

    if (!isNegation) {
      continue;
    }

    // For 'do not', the negation spans two tokens; record start before advancing.
    let negStart = i;
    if (token === 'do' && i + 1 < tokens.length && tokens[i + 1] === 'not') {
      i++; // advance past 'not'
    }

    // Check exceptions: if next token is an exception word, skip.
    const nextToken = tokens[i + 1];
    let hasException = false;
    for (const exc of EXCEPTION_WORDS) {
      if (nextToken === exc || (exc === 'forget to' && nextToken === 'forget' && tokens[i + 2] === 'to') ||
          (exc === 'forget about' && nextToken === 'forget' && tokens[i + 2] === 'about')) {
        hasException = true;
        break;
      }
    }
    if (hasException) {
      continue;
    }

    // Inspect next 3 tokens (or fewer if near end).
    const windowEnd = Math.min(i + 4, tokens.length);
    let foundVerb = false;
    for (let j = i + 1; j < windowEnd; j++) {
      const verb = tokens[j];
      if (VERB_TO_TOOL_MAP[verb]) {
        const tools = VERB_TO_TOOL_MAP[verb];
        for (const tool of tools) {
          disabledSet.add(tool);
        }
        // Build matched phrase: from negation start through verb, joined with spaces.
        const phrase = tokens.slice(negStart, j + 1).join(' ');
        matchedSet.add(phrase);
        foundVerb = true;
      }
    }

    // Tool-override rule: if exact WRITE_CHAT_TOOLS name appears within 3 tokens.
    if (!foundVerb) {
      for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
        const candidate = tokens[j];
        if (WRITE_CHAT_TOOLS.includes(candidate)) {
          disabledSet.add(candidate);
          const phrase = tokens.slice(negStart, j + 1).join(' ');
          matchedSet.add(phrase);
          break; // only first match in window
        }
      }
    }
  }

  // Return in WRITE_CHAT_TOOLS order, no duplicates.
  const disabled = WRITE_CHAT_TOOLS.filter(t => disabledSet.has(t));
  const matched = [...matchedSet];

  return { disabled, matched };
}

module.exports = {
  WRITE_CHAT_TOOLS,
  isGateEnabled,
  lastUserText,
  disabledToolsForUserMessage,
};
