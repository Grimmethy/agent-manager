'use strict';

// Inert symbol detection for decompose pass pieces.
// When a hub is decomposed into sub-tasks, each piece may have a rawDiff showing
// what code is being added/changed. This module scans the diff for symbols that
// are defined but never referenced within the same piece, indicating they may
// need wiring to other pieces or that the piece is incomplete.

function checkInertAdditions(rawDiff) {
  if (!rawDiff || typeof rawDiff !== 'string') {
    return { inertCheckAnnotation: false, found: [], willBeWiredBy: null };
  }

  const inertSymbols = [];
  const lines = rawDiff.split('\n');

  // Track all defined symbols in the diff
  const definedSymbols = new Set();
  const referencedSymbols = new Set();

  for (const line of lines) {
    // Check for export statements
    const exportMatch = line.match(/\bexport\s+(?:const|let|var|function|class)\s+(\w+)/);
    if (exportMatch) {
      definedSymbols.add(exportMatch[1]);
    }

    // Check for import statements
    const importMatch = line.match(/\bimport\s+.*?\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      referencedSymbols.add(importMatch[1]);
    }

    // Check for usage of defined symbols (excluding the export line itself)
    for (const symbol of definedSymbols) {
      // Check if symbol appears in the line, but not as the export declaration
      if (line.includes(symbol)) {
        // Skip if this is the export line defining the symbol
        const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exportLineMatch = line.match(new RegExp('\\bexport\\s+(?:const|let|var|function|class)\\s+' + escapedSymbol + '\\b'));
        if (!exportLineMatch) {
          referencedSymbols.add(symbol);
        }
      }
    }
  }

  // Find symbols that are defined but never referenced
  for (const symbol of definedSymbols) {
    if (!referencedSymbols.has(symbol)) {
      inertSymbols.push({
        symbol,
        type: 'unreferenced-export',
        line: lines.find(l => l.includes('export') && l.includes(symbol))
      });
    }
  }

  const hasInertSymbols = inertSymbols.length > 0;

  return {
    inertCheckAnnotation: hasInertSymbols,
    found: inertSymbols,
    willBeWiredBy: hasInertSymbols ? 'sibling-piece' : null,
    symbolCount: inertSymbols.length
  };
}

module.exports = { checkInertAdditions };
