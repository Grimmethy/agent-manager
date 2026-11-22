'use strict';

// Degenerate-plan detection module (HUB0316 · 1/4).
//
// Pure text-classification functions that identify three failure modes of planner
// output before it reaches the retry pipeline:
//
//   - isDegeneratePlan(text)      — empty / whitespace-only / vanishingly short output
//   - isIncompletePlan(text)      — text ending mid-thought (no terminal punctuation,
//                                    trailing "...", or opening filler phrases)
//   - isExploratoryNarration(text) — hedging / speculation / open-ended questions
//                                    without actionable steps
//
// No I/O, no state, no side effects. Every input is a string, every output is a
// boolean. Deterministic for a given input.

const MIN_PLAN_LENGTH = 50;

const FILLER_START_PHRASES = [
  'let me ',
  'i should ',
  'i\'ll ',
  'i will ',
  'i need to ',
  'first, ',
  'basically, ',
  'well, ',
  'okay, ',
  'sure, ',
  'of course, ',
];

const TERMINAL_PUNCTUATION = new Set(['.', '!', '?', '。', '！', '？']);

function endsMidThought(text) {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  const lastChar = trimmed[trimmed.length - 1];
  if (TERMINAL_PUNCTUATION.has(lastChar)) return false;
  if (trimmed.endsWith('...')) return true;
  return true; // no terminal punctuation → ends mid-thought
}

function beginsWithFiller(text) {
  const lower = text.toLowerCase();
  for (const phrase of FILLER_START_PHRASES) {
    if (lower.startsWith(phrase)) return true;
  }
  return false;
}

/**
 * Detect empty / vanishingly short planner output.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isDegeneratePlan(text) {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < MIN_PLAN_LENGTH) return true;
  return false;
}

/**
 * Detect text that ends mid-thought — no terminal punctuation, trailing "...",
 * or opening filler phrases that suggest the plan was interrupted.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isIncompletePlan(text) {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // Trailing "..." is a strong signal of truncation.
  if (trimmed.endsWith('...')) return true;

  // No terminal punctuation at all — the thought was cut off.
  if (endsMidThought(trimmed)) return true;

  // Opening filler phrases that signal the planner was still thinking.
  if (beginsWithFiller(trimmed)) return true;

  return false;
}

/**
 * Detect exploratory narration: hedging, speculation, open-ended questions
 * without concrete actionable steps (imperative verbs, numbered lists, or
 * clear action items).
 *
 * @param {string} text
 * @returns {boolean}
 */
function isExploratoryNarration(text) {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // If it already looks incomplete, flag that separately.
  if (isIncompletePlan(text)) return false;

  // Must contain at least one hedging/speculative marker to be "exploratory".
  const HEDGING_PATTERNS = [
    /\b(?:maybe|perhaps|might|could|possibly|potentially|i'm not sure|not sure|i think|in my opinion|it seems|i guess|i wonder)\b/i,
    /\b(?:what if|how about|should we|let's consider|we could|we might)\b/i,
    /\b(?:i'm thinking|i'm considering|i wonder|i suppose|i assume)\b/i,
  ];

  const hasHedging = HEDGING_PATTERNS.some((re) => re.test(trimmed));
  if (!hasHedging) return false;

  // Must lack actionable structure to be "narration" rather than a plan.
  // Actionable signals: imperative verbs, numbered/bulleted lists, clear
  // action items with concrete steps.
  const ACTIONABLE_PATTERNS = [
    /\b(step|action|task|todo|implement|create|add|fix|update|build|write|configure|setup|deploy|install|enable|disable|remove|delete|replace)\b/i,
    /\b\d+[\.\)]\s+\w/i, // "1. do this" or "1) do this"
    /^\s*[-*•]\s+\w/i,   // bulleted list items
    /\b(first|second|third|finally|lastly)\b/i,
    /\b(?:plan|approach|strategy|steps?|actions?)\s*:/i,
    /\b(?:to do|todo|action items?)\s*[:\-]/i,
  ];

  const hasActionable = ACTIONABLE_PATTERNS.some((re) => re.test(trimmed));
  if (hasActionable) return false;

  // Must contain mostly speculative / question-like content.
  const QUESTION_RATIO = (trimmed.match(/\?/g) || []).length / Math.max(trimmed.split(/[.!?]+/).length, 1);
  if (QUESTION_RATIO > 0.2) return true;

  // Check for a high ratio of hedging words to total words.
  const words = trimmed.split(/\s+/);
  const HEDGING_WORDS = new Set([
    'maybe', 'perhaps', 'might', 'could', 'possibly', 'potentially',
    'think', 'guess', 'wonder', 'consider', 'suppose', 'assume',
    'uncertain', 'unsure', 'confused', 'not sure',
  ]);
  let hedgeCount = 0;
  for (const w of words) {
    if (HEDGING_WORDS.has(w.toLowerCase())) hedgeCount++;
  }
  if (words.length > 0 && hedgeCount / words.length > 0.15) return true;

  return false;
}

module.exports = { isDegeneratePlan, isIncompletePlan, isExploratoryNarration };
