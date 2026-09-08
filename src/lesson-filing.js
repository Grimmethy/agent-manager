// Single filing entry point for lessons-learned / debrief Now-What findings. Files into the SAME Second Brain vault (secondBrainDir) under Lessons/. Do NOT create a parallel store, sidecar DB, or separate index. Retrieval is the AI-navigation concept's job over this one vault. See concept-ai-navigation-of-existing-knowledge-a34a32. (brain-dump bd-1788686010195, 2026-09-07)

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

// Lowercase, non-alphanumeric → hyphen, strip leading/trailing hyphens, max 80 chars.
function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// File one lesson as a markdown note inside the Second Brain vault.
// Returns the vault-relative path string, e.g. "Lessons/2026-09-07-my-test.md".
function fileLesson(title, body, tags) {
  const cfg = getConfig();
  const secondBrainDir = cfg.secondBrainDir;
  if (!secondBrainDir) {
    throw new Error('secondBrainDir is not configured. Set SECOND_BRAIN_DIR or add secondBrainDir to config.');
  }

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const slug = slugify(title);
  const relPath = `Lessons/${date}-${slug}.md`;
  const absPath = path.join(secondBrainDir, relPath);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  let frontMatter = `---\ntitle: ${title}\ndate: ${date}`;
  if (tags && tags.length > 0) {
    frontMatter += `\ntags: ${tags.join(', ')}`;
  }
  frontMatter += '\n---\n\n';
  const content = frontMatter + (body || '');

  fs.writeFileSync(absPath, content, 'utf8');

  return relPath;
}

module.exports = { fileLesson, slugify };
