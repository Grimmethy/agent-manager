function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function quotedSymbolsFromSection(section) {
  return [...(section || '').matchAll(QUOTED_SYMBOL_RE)].map((m) => m[1]).filter(Boolean);
}

function snippetFromSection(section) {
  const m = (section || '').match(SNIPPET_FIELD_RE);
  return m ? m[1] : null;
}

function stripWhitespace(s) {
  return s.replace(/\s+/g, '');
}

function realIndexForStrippedIndex(content, targetStrippedCount) {
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (count === targetStrippedCount) return i;
    if (!/\s/.test(content[i])) count++;
  }
  return content.length;
}
