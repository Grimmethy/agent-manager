// Draft Quality Gate
// Purpose: Reject drafts containing fabricated file paths or meta-commentary
// Date: 2026-11-16
//
// This module provides a quality gate for agentic drafts, checking for:
// 1. Fabricated file paths (paths that don't exist in the repo)
// 2. Meta-commentary (agent narrating its own process)
//
// The gate uses collectCreatedPaths to identify paths being created in the
// draft (via git diff headers or JSON mode:'create'), then exempts those
// paths from the fabricated-path check to avoid false positives.

'use strict';

const fs = require('fs');
const path = require('path');

// Exported counters for monitoring
let fabricatedPathBlocks = 0;
let metaCommentaryBlocks = 0;

function collectCreatedPaths(draftText) {
  const createdPaths = new Set();
  
  // Pattern 1: Git diff creation hunks (--- /dev/null followed by +++ b/<path>)
  const creationHunkRegex = /^--- \/dev\/null\n\+\+\+ b\/([^ \n]+)/gm;
  let match;
  while ((match = creationHunkRegex.exec(draftText)) !== null) {
    createdPaths.add(match[1]);
  }
  
  // Pattern 2: New file mode headers
  const newFileRegex = /diff --git a\/[^ ]+ b\/([^ \n]+).*\n.*new file mode/m;
  while ((match = newFileRegex.exec(draftText)) !== null) {
    createdPaths.add(match[1]);
  }
  
  // Pattern 3: JSON mode:'create' with path field
  const jsonCreateRegex = /\{[^}]*"mode"\s*:\s*'create'[^}]*"path"\s*:\s*'([^']+)'/g;
  while ((match = jsonCreateRegex.exec(draftText)) !== null) {
    createdPaths.add(match[1]);
  }
  
  return Array.from(createdPaths);
}

function checkDraftQuality(draftText) {
  // Check for meta-commentary
  const metaCommentaryPatterns = [
    /I'm going to create/i,
    /I'll add a new file/i,
    /Let me create/i,
    /I will add/i,
    /I need to create/i,
    /I should add/i,
    /I plan to create/i,
    /I'm planning to add/i,
    /I intend to create/i,
    /I will create a new/i,
    /I'm going to add a new/i,
    /I'll be creating/i,
    /I'm creating a new/i,
    /I am going to create/i,
    /I am planning to create/i,
    /I am going to add/i,
    /I am going to make/i,
    /I am creating/i,
    /I am adding a new/i,
    /I am going to create a new/i,
    /I'm planning to create/i,
    /I'm planning to add/i,
    /I'm planning to make/i,
    /I'm going to implement/i,
    /I'll implement/i,
    /I will implement/i,
    /I'm going to implement/i,
    /I am going to implement/i,
    /I am implementing/i,
    /I'm implementing/i,
    /I will add a new/i,
    /I'll be adding/i,
    /I'm going to add/i,
    /I'm adding a new/i,
    /I'm going to implement a new/i,
    /I'll be implementing/i,
    /I'm going to implement/i,
    /I'm implementing a new/i,
    /I'm planning to implement/i,
    /I will be implementing/i,
    /I will be creating/i,
    /I will be adding/i,
    /I'm going to create a new/i,
    /I'm going to add a new/i,
    /I'm going to make a new/i,
    /I'm going to implement a new/i,
    /I'll be creating/i,
    /I'll be adding/i,
    /I'll be implementing/i,
    /I'm planning to implement/i,
    /I'm planning to add/i,
    /I'm planning to create/i,
    /I'm planning to make/i,
    /I'm going to implement/i,
    /I'll implement/i,
    /I will implement/i,
    /I'm going to implement/i,
    /I am going to implement/i,
    /I am implementing/i,
    /I'm implementing/i,
    /I will add a new/i,
    /I'll be adding/i,
    /I'm going to add/i,
    /I'm adding a new/i,
    /I'm going to implement a new/i,
    /I'll be implementing/i,
    /I'm going to implement/i,
    /I'm implementing a new/i,
    /I'm planning to implement/i,
    /I will be implementing/i,
    /I will be creating/i,
    /I will be adding/i
  ];
  
  for (const pattern of metaCommentaryPatterns) {
    if (pattern.test(draftText)) {
      metaCommentaryBlocks++;
      return {
        blocked: true,
        reason: 'meta-commentary',
        matched: pattern.source
      };
    }
  }
  
  // Collect paths being created in this draft
  const createdPaths = collectCreatedPaths(draftText);
  
  // Check for fabricated paths
  // Strip creation hunk lines to avoid matching paths in +++ b/<path> headers
  const strippedText = draftText
    .split('\n')
    .filter(line => !line.startsWith('+++ b/') && !line.startsWith('diff --git'))
    .join('\n');
  
  const repoRoot = process.cwd();
  // Match file paths with common extensions in the stripped text
  const filePathRegex = /\b([a-zA-Z0-9_./-]+\.(js|ts|json|md|txt|yml|yaml|html|css|scss|less|sql|py|rb|go|rs|c|cpp|h|hpp|java|kt|swift|sh|bat|ps1|cmake|make|gradle|toml|ini|cfg|conf|env|lock|map|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|otf|mp3|wav|ogg|flac|mp4|avi|mkv|mov|wmv|flv|swf|zip|tar|gz|rar|7z|pdf|doc|docx|xls|xlsx|ppt|pptx))\b/g;
  
  let match;
  const fabricatedPaths = [];
  
  while ((match = filePathRegex.exec(strippedText)) !== null) {
    const fullPath = match[1];
    
    // Skip if this path is being created in the draft
    if (createdPaths.includes(fullPath)) {
      continue;
    }
    
    // Check if the file exists in the repo
    const fullPathInRepo = path.join(repoRoot, fullPath);
    if (!fs.existsSync(fullPathInRepo)) {
      fabricatedPaths.push(fullPath);
    }
  }
  
  if (fabricatedPaths.length > 0) {
    // Return the first fabricated path found
    const firstFabricated = fabricatedPaths[0];
    fabricatedPathBlocks++;
    return {
      blocked: true,
      reason: 'fabricated-path',
      matched: firstFabricated
    };
  }
  
  // No issues found
  return {
    blocked: false,
    reason: null,
    matched: null
  };
}

module.exports = {
  checkDraftQuality,
  collectCreatedPaths,
  getFabricatedPathBlocks: () => fabricatedPathBlocks,
  getMetaCommentaryBlocks: () => metaCommentaryBlocks,
  resetCounters: () => {
    fabricatedPathBlocks = 0;
    metaCommentaryBlocks = 0;
  }
};
