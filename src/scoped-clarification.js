// scoped-clarification.js -- turn ambiguous brain-dump tasks into scoped work items or specific questions
// 2026-11-04: brain-dump tasks stalling in needs-clarification as 'ambiguous' (HUB0XXX)

const fs = require('fs');
const path = require('path');

// Extract structured information from brain-dump text
function extractStructuredInfo(rawText, title) {
  const combined = `${title}\n${rawText}`;
  const info = {
    affectedComponent: null,
    observedBehavior: null,
    expectedBehavior: null,
    concreteExample: null,
    impact: null
  };

  // Extract affected component (look for "in X", "affecting X", "X is broken", or title-based extraction)
  const componentPatterns = [
    /(?:in|affecting|related to|about)\s+([A-Za-z][\w\-\.\/]+)/i,
    /(?:the\s+)?([A-Z][\w\-]+(?:\s+[a-z]+)*)\s+(?:is|has|was|should|needs|lacks|fails)/i,
    /(?:broken|bug|issue|problem|hazard)\s+(?:in|affecting|with)\s+([A-Za-z][\w\-\.\/]+)/i
  ];

  for (const pattern of componentPatterns) {
    const match = combined.match(pattern);
    if (match) {
      info.affectedComponent = match[1].trim();
      break;
    }
  }

  // If no component found, try to extract from title (first meaningful word/phrase)
  if (!info.affectedComponent) {
    const titleMatch = title.match(/^([A-Z][\w\-]+(?:\s+[a-z\-]+)*)/);
    if (titleMatch) {
      info.affectedComponent = titleMatch[1].trim();
    }
  }

  // Extract observed behavior (look for "shows", "returns", "produces", "gives", "is stuck")
  const observedPatterns = [
    /(?:shows|returns|produces|gives|outputs|results in|yields|creates|generates|leads to)\s+(?:an?|the)\s+([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i,
    /(?:is|was|has been)\s+(?:stuck|failing|broken|not working|silently|incorrectly)\s+(?:in|with|at)\s+(?:the\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i,
    /(?:no|empty|missing|zero)\s+(?:results|entries|items|tasks|files|data|output|response|feedback|confirmation)\s+(?:despite|even|although|but|while|when)\s+(?:there\s+)?(?:is|are|was|were)\s+(?:known|relevant|existing|some|any)\s+([A-Za-z][\w\s\-\.,;:!?]+?)/i
  ];

  for (const pattern of observedPatterns) {
    const match = combined.match(pattern);
    if (match) {
      info.observedBehavior = match[1].trim().slice(0, 200);
      break;
    }
  }

  // Extract expected behavior (look for "should", "expected", "intended", "supposed to")
  const expectedPatterns = [
    /(?:should|expected|intended|supposed to|meant to|designed to)\s+(?:to\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i,
    /(?:but|however|instead|rather|yet)\s+(?:it\s+)?(?:should|is|was|would|will|can|could|must|should)\s+(?:to\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i,
    /(?:the\s+)?(?:expected|intended|desired|correct|proper)\s+(?:behavior|result|output|outcome|response)\s+(?:is|should\s+be|would\s+be|needs\s+to\s+be)\s+(?:to\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)/i
  ];

  for (const pattern of expectedPatterns) {
    const match = combined.match(pattern);
    if (match) {
      info.expectedBehavior = match[1].trim().slice(0, 200);
      break;
    }
  }

  // Extract concrete example (look for "for example", "such as", "like", "e.g.")
  const examplePatterns = [
    /(?:for example|such as|like|e\.g\.|as\s+in)\s+(?:the\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i,
    /(?:specifically|in\s+particular|namely)\s+(?:the\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i
  ];

  for (const pattern of examplePatterns) {
    const match = combined.match(pattern);
    if (match) {
      info.concreteExample = match[1].trim().slice(0, 200);
      break;
    }
  }

  // Extract impact (look for "blocks", "prevents", "causes", "leads to", "results in")
  const impactPatterns = [
    /(?:blocks|prevents|causes|leads to|results in|hinders|disrupts|breaks)\s+(?:the\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i,
    /(?:this\s+)?(?:means|implies|suggests|indicates)\s+(?:that\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i,
    /(?:affects|impacts|implications)\s+(?:the\s+)?([A-Za-z][\w\s\-\.,;:!?]+?)(?:\s+|\.|\n|$)/i
  ];

  for (const pattern of impactPatterns) {
    const match = combined.match(pattern);
    if (match) {
      info.impact = match[1].trim().slice(0, 200);
      break;
    }
  }

  return info;
}

// Generate specific questions when scoping fails
function generateQuestions(rawText, title, extractedInfo) {
  const questions = [];

  // Always ask for the affected component if not found
  if (!extractedInfo.affectedComponent) {
    questions.push("Which specific component, file, or module is affected by this issue?");
  }

  // Always ask for observed behavior if not found
  if (!extractedInfo.observedBehavior) {
    questions.push("What exactly is happening right now? Please describe the current behavior or output you're seeing.");
  }

  // Always ask for expected behavior if not found
  if (!extractedInfo.expectedBehavior) {
    questions.push("What should happen instead? What is the expected or correct behavior?");
  }

  // Ask for concrete example if not found
  if (!extractedInfo.concreteExample) {
    questions.push("Can you provide a concrete example or reproduction steps that demonstrate this issue?");
  }

  // Ask for impact if not found
  if (!extractedInfo.impact) {
    questions.push("What is the impact of this issue? What does it prevent or break?");
  }

  // If we still don't have enough, add a general scoping question
  if (questions.length < 2) {
    questions.push("What specific change or fix are you proposing to address this concern?");
  }

  // Limit to 4 questions maximum
  return questions.slice(0, 4);
}

// Build a scoped task from extracted info
function buildScopedTask(rawText, title, extractedInfo, brainDumpEntryId) {
  const scopedParts = [];

  if (extractedInfo.affectedComponent) {
    scopedParts.push(`**Affected Component:** ${extractedInfo.affectedComponent}`);
  }

  if (extractedInfo.observedBehavior) {
    scopedParts.push(`**Observed Behavior:** ${extractedInfo.observedBehavior}`);
  }

  if (extractedInfo.expectedBehavior) {
    scopedParts.push(`**Expected Behavior:** ${extractedInfo.expectedBehavior}`);
  }

  if (extractedInfo.concreteExample) {
    scopedParts.push(`**Concrete Example:** ${extractedInfo.concreteExample}`);
  }

  if (extractedInfo.impact) {
    scopedParts.push(`**Impact:** ${extractedInfo.impact}`);
  }

  // Build acceptance criteria from extracted info
  const acceptanceCriteria = [];
  if (extractedInfo.affectedComponent && extractedInfo.observedBehavior && extractedInfo.expectedBehavior) {
    acceptanceCriteria.push(
      `Given the affected component '${extractedInfo.affectedComponent}', ` +
      `when the observed behavior occurs, ` +
      `then the expected behavior should be present`
    );
  }

  if (extractedInfo.concreteExample) {
    acceptanceCriteria.push(`Given the concrete example provided, the issue should be reproducible and resolvable`);
  }

  if (extractedInfo.impact) {
    acceptanceCriteria.push(`The fix should resolve the identified impact`);
  }

  // If we don't have acceptance criteria, create a generic one
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push(
      `The proposed change should be implemented and tested against the affected component`
    );
  }

  const scopedTitle = extractedInfo.affectedComponent
    ? `${extractedInfo.affectedComponent}: ${title}`
    : title;

  const scopedBody = [
    `## Brain-Dump Task (Scoped)`,
    ``,
    `**Source:** Brain-dump entry ${brainDumpEntryId}`,
    `**Original Title:** ${title}`,
    ``,
    `### Extracted Information`,
    ``,
    ...scopedParts,
    ``,
    `### Acceptance Criteria`,
    ``,
    ...acceptanceCriteria.map(c => `- ${c}`),
    ``,
    `### Original Context`,
    ``,
    rawText
  ].join('\n');

  return {
    title: scopedTitle.slice(0, 120),
    body: scopedBody,
    hasEnoughInfo: acceptanceCriteria.length > 0
  };
}

// The history is this module's own state, NOT a task record. A queue state directory is read by globbing *.json and expects task records: a list in queue/needs-clarification made
// GET /api/summary answer 500 (2026-11-10, questforge). So when taskDir is the needs-clarification state directory the file lives one level up in queue/; any other directory keeps its own.
function clarificationHistoryPath(taskDir) {
  return path.basename(taskDir) === 'needs-clarification' ? path.join(path.dirname(taskDir), 'clarification-history.json') : path.join(taskDir, 'clarification-history.json');
}

// The history from the new location plus the legacy file inside taskDir (written before this change), so no attempt is forgotten. A missing or corrupt file counts as empty.
function readClarificationHistory(taskDir) {
  const history = [];
  for (const file of new Set([path.join(taskDir, 'clarification-history.json'), clarificationHistoryPath(taskDir)])) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) history.push(...parsed);
    } catch (err) { /* absent or corrupt: start fresh */ }
  }
  return history;
}

// Check clarification history to detect re-flagging
function checkClarificationHistory(taskDir, brainDumpEntryId) {
  const history = readClarificationHistory(taskDir);

  // Check if this task was previously clarified with the same signature
  const previousAttempts = history.filter(h => h.brainDumpEntryId === brainDumpEntryId);
  
  if (previousAttempts.length > 0) {
    const lastAttempt = previousAttempts[previousAttempts.length - 1];
    const daysSinceLastAttempt = (Date.now() - lastAttempt.timestamp) / (1000 * 60 * 60 * 24);
    
    // If same signature and less than 7 days ago, escalate
    if (lastAttempt.signature === 'ambiguous' && daysSinceLastAttempt < 7) {
      return {
        shouldEscalate: true,
        reason: `Task was previously marked ambiguous ${Math.round(daysSinceLastAttempt)} days ago and has not been resolved`,
        previousQuestions: lastAttempt.questions
      };
    }
  }

  return { shouldEscalate: false, reason: null, previousQuestions: null };
}

// Record clarification attempt in history
function recordClarificationAttempt(taskDir, brainDumpEntryId, signature, questions) {
  const historyPath = clarificationHistoryPath(taskDir);
  const history = readClarificationHistory(taskDir);

  history.push({
    brainDumpEntryId,
    timestamp: Date.now(),
    signature,
    questions,
    resolved: false
  });

  // Ensure the directory exists before writing
  const dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
  const legacy = path.join(taskDir, 'clarification-history.json');
  if (legacy !== historyPath) { try { fs.unlinkSync(legacy); } catch (err) { /* none there */ } } // migrated: the state file leaves the queue state directory
}

// Check if task is stale (in needs-clarification for more than 7 days)
function checkStaleClarification(taskFile, taskDir) {
  try {
    const taskData = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    const createdAt = new Date(taskData.createdAt || taskData.created_at || 0).getTime();
    const daysOld = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
    
    if (daysOld > 7) {
      return {
        isStale: true,
        daysOld: Math.round(daysOld),
        reason: `Task has been in needs-clarification for ${Math.round(daysOld)} days without resolution`
      };
    }
  } catch (err) {
    // If we can't read the task, assume it's not stale
  }

  return { isStale: false, daysOld: 0, reason: null };
}

// Main function: process an ambiguous brain-dump task
function processAmbiguousBrainDump(rawText, title, brainDumpEntryId, taskDir, taskFile) {
  // Extract structured information
  const extractedInfo = extractStructuredInfo(rawText, title);

  // Count how many fields we extracted
  const fieldsExtracted = Object.values(extractedInfo).filter(v => v !== null).length;

  // Check clarification history
  const historyCheck = checkClarificationHistory(taskDir, brainDumpEntryId);

  // Check if task is stale
  const staleCheck = checkStaleClarification(taskFile, taskDir);

  // Decision logic
  if (historyCheck.shouldEscalate) {
    // Escalate: task was previously marked ambiguous and not resolved
    return {
      action: 'escalate',
      reason: historyCheck.reason,
      previousQuestions: historyCheck.previousQuestions,
      scopedTask: null,
      questions: null
    };
  }

  if (staleCheck.isStale) {
    // Escalate: task is stale
    return {
      action: 'escalate',
      reason: staleCheck.reason,
      previousQuestions: null,
      scopedTask: null,
      questions: null
    };
  }

  if (fieldsExtracted >= 2) {
    // We have enough info to scope the task
    const scopedTask = buildScopedTask(rawText, title, extractedInfo, brainDumpEntryId);
    
    if (scopedTask.hasEnoughInfo) {
      return {
        action: 'scope',
        reason: null,
        previousQuestions: null,
        scopedTask,
        questions: null
      };
    }
  }

  // Scoping failed, generate specific questions
  const questions = generateQuestions(rawText, title, extractedInfo);
  
  // Record this clarification attempt
  recordClarificationAttempt(taskDir, brainDumpEntryId, 'clarification-required', questions);

  return {
    action: 'questions',
    reason: null,
    previousQuestions: null,
    scopedTask: null,
    questions
  };
}

module.exports = {
  extractStructuredInfo,
  generateQuestions,
  buildScopedTask,
  checkClarificationHistory,
  recordClarificationAttempt,
  clarificationHistoryPath,
  checkStaleClarification,
  processAmbiguousBrainDump
};
