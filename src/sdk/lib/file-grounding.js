function collectAnchorHits(content, section) {
  const hits = [];
  const seen = new Set();
  const push = (index, length, rank) => {
    if (index == null || index < 0) return;
    const bucket = Math.round(index / 200);
    if (seen.has(bucket)) return;
    seen.add(bucket);
    hits.push({ index, length: Math.max(length || 0, 1), rank });
  };

  const snippet = snippetFromSection(section);
  if (snippet) {
    const match = findFuzzyMatch(content, snippet);
    if (match) push(match.index, match.length, 0);
  }

  // The fenced Snippet: block's own triple backticks otherwise confuse QUOTED_SYMBOL_RE's
  // single-backtick pairing (a real bug, caught by direct test) -- strip it first.
  const prose = (section || '').replace(SNIPPET_FIELD_RE, '');

  for (const symbol of quotedSymbolsFromSection(prose)) {
    if (symbol.length < MIN_ANCHOR_SYMBOL_CHARS) continue;
    const occ = [];
    let from = 0;
    for (;;) {
      const i = content.indexOf(symbol, from);
      if (i === -1 || occ.length > MAX_ANCHOR_OCCURRENCES) break;
      occ.push(i);
      from = i + symbol.length;
    }
    if (occ.length === 0) continue;
    if (occ.length > MAX_ANCHOR_OCCURRENCES) {
      // Too generic to trust as a real anchor, but a weak/last-resort single-window
      // fallback beats blind head-truncation -- rank 3 is never eligible for the
      // multi-region path (see windowFetchedFileContent), only its zero-strong-hits
      // fallback.
      push(occ[0], symbol.length, 3);
      continue;
    }
    for (const i of occ) push(i, symbol.length, 1);
  }

  const lineMatch = prose.match(LINE_CITATION_RE);
  if (lineMatch) {
    const lineNum = Number(lineMatch[1]);
    const lines = content.split('\n');
    if (lineNum >= 1 && lineNum <= lines.length) {
      const idx = lines.slice(0, lineNum - 1).join('\n').length + (lineNum > 1 ? 1 : 0);
      push(idx, 0, 2);
    }
  }

  return hits.sort((a, b) => a.rank - b.rank || a.index - b.index);
}

function windowFetchedFileContent(content, section, maxChars = MAX_FETCHED_FILE_CHARS) {
  if (content.length <= maxChars) {
    return { text: content, confidence: 'strong', anchorCount: 0, usedSnippetFuzzyMatch: false };
  }

  const allHits = collectAnchorHits(content, section);
  const usedSnippetFuzzyMatch = allHits.some((h) => h.rank === 0);
  const strongHits = allHits.filter((h) => h.rank < 3).slice(0, MAX_ANCHOR_REGIONS);

  if (strongHits.length === 0) {
    const weakHit = allHits.find((h) => h.rank === 3);
    if (weakHit) {
      return {
        text: LOW_CONFIDENCE_GROUNDING_NOTE + windowAroundIndex(content, weakHit.index, weakHit.length, maxChars),
        confidence: 'weak',
        anchorCount: 1,
        usedSnippetFuzzyMatch: false,
      };
    }
    return {
      text: LOW_CONFIDENCE_GROUNDING_NOTE + `${content.slice(0, maxChars)}\n...[truncated]`,
      confidence: 'none',
      anchorCount: 0,
      usedSnippetFuzzyMatch: false,
    };
  }
  if (strongHits.length === 1) {
    return {
      text: windowAroundIndex(content, strongHits[0].index, strongHits[0].length, maxChars),
      confidence: 'strong',
      anchorCount: 1,
      usedSnippetFuzzyMatch,
    };
  }

  // Equal share of a shared budget, capped at the single-window size, floored so each
  // window is still worth showing.
  const totalBudget = Math.min(MAX_FETCHED_FILE_TOTAL_CHARS, Math.max(maxChars, content.length));
  const perRegion = Math.max(MIN_REGION_CHARS, Math.min(maxChars, Math.floor(totalBudget / strongHits.length)));
  const half = Math.floor(perRegion / 2);

  const ranges = strongHits
    .map((h) => ({ from: Math.max(0, h.index - half), to: Math.min(content.length, h.index + h.length + half) }))
    .sort((a, b) => a.from - b.from);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 40) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }

  const out = [];
  if (merged[0].from > 0) out.push('...[truncated]...');
  merged.forEach((r, i) => {
    out.push(content.slice(r.from, r.to));
    if (i < merged.length - 1) out.push('...[gap]...');
    else if (r.to < content.length) out.push('...[truncated]');
  });
  return { text: out.join('\n'), confidence: 'strong', anchorCount: strongHits.length, usedSnippetFuzzyMatch };
}
