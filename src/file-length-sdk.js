'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Count lines in text
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length;
}

/**
 * Tokenize JavaScript text into function-relevant tokens
 * @param {string} text
 * @returns {Array<{type: string, value: string, line: number}>}
 */
function tokenizeJs(text) {
  const tokens = [];
  const lines = text.split('\n');
  let lineNum = 1;

  for (const line of lines) {
    let col = 0;
    while (col < line.length) {
      const char = line[col];
      if (char === '/' && line[col + 1] === '/') {
        // Line comment - skip to end of line
        break;
      } else if (char === '/' && line[col + 1] === '*') {
        // Block comment
        tokens.push({ type: 'comment', value: '/*', line: lineNum });
        col += 2;
        while (col < line.length) {
          if (line[col] === '*' && line[col + 1] === '/') {
            tokens.push({ type: 'comment', value: '*/', line: lineNum });
            col += 2;
            break;
          }
          col++;
        }
      } else if (char === '"' || char === "'" || char === '`') {
        // String
        const quote = char;
        let str = quote;
        col++;
        while (col < line.length && line[col] !== quote) {
          if (line[col] === '\\') {
            str += line[col];
            col++;
            if (col < line.length) {
              str += line[col];
              col++;
            }
          } else {
            str += line[col];
            col++;
          }
        }
        if (col < line.length) {
          str += line[col];
          col++;
        }
        tokens.push({ type: 'string', value: str, line: lineNum });
      } else if (/\d/.test(char)) {
        // Number
        let num = '';
        while (col < line.length && /[\d.]/.test(line[col])) {
          num += line[col];
          col++;
        }
        tokens.push({ type: 'number', value: num, line: lineNum });
      } else if (/[a-zA-Z_$]/.test(char)) {
        // Identifier or keyword
        let ident = '';
        while (col < line.length && /[a-zA-Z0-9_$]/.test(line[col])) {
          ident += line[col];
          col++;
        }
        const type = ['function', 'const', 'let', 'var', 'class', 'async', 'await', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'export', 'default', 'import', 'from', 'of', 'in', 'typeof', 'instanceof'].includes(ident) ? 'keyword' : 'identifier';
        tokens.push({ type, value: ident, line: lineNum });
      } else if ('{}()[];,:.'.includes(char)) {
        tokens.push({ type: 'punctuation', value: char, line: lineNum });
        col++;
      } else {
        col++;
      }
    }
    lineNum++;
  }

  return tokens;
}

/**
 * Find function spans in JavaScript tokens
 * @param {Array<{type: string, value: string, line: number}>} tokens
 * @returns {Array<{name: string, startLine: number, endLine: number, lineCount: number}>}
 */
function findJsFunctionSpans(tokens) {
  const functions = [];
  let i = 0;

  while (i < tokens.length) {
    // Look for function declaration patterns
    if (
      (tokens[i].type === 'keyword' && tokens[i].value === 'function') ||
      (tokens[i].type === 'keyword' && tokens[i].value === 'async' && tokens[i + 1]?.type === 'keyword' && tokens[i + 1]?.value === 'function')
    ) {
      let name = '';
      let startLine = tokens[i].line;

      if (tokens[i].type === 'keyword' && tokens[i].value === 'async') {
        i += 2; // Skip 'async function'
      }

      // Expect identifier (function name)
      if (tokens[i]?.type === 'identifier') {
        name = tokens[i].value;
        i++;
      } else {
        i++;
        continue;
      }

      // Expect opening paren
      if (tokens[i]?.type === 'punctuation' && tokens[i]?.value === '(') {
        i++;
      } else {
        continue;
      }

      // Find matching closing paren
      let parenDepth = 1;
      while (i < tokens.length && parenDepth > 0) {
        if (tokens[i].type === 'punctuation' && tokens[i].value === '(') parenDepth++;
        if (tokens[i].type === 'punctuation' && tokens[i].value === ')') parenDepth--;
        i++;
      }

      // Skip whitespace
      while (i < tokens.length && tokens[i].type === 'punctuation' && tokens[i].value === ';') i++;

      // Find opening brace
      if (tokens[i]?.type === 'punctuation' && tokens[i]?.value === '{') {
        i++;
        let braceDepth = 1;
        let endLine = startLine;

        while (i < tokens.length && braceDepth > 0) {
          if (tokens[i].type === 'punctuation' && tokens[i].value === '{') braceDepth++;
          if (tokens[i].type === 'punctuation' && tokens[i].value === '}') braceDepth--;
          endLine = tokens[i].line;
          i++;
        }

        if (name) {
          functions.push({
            name,
            startLine,
            endLine,
            lineCount: endLine - startLine + 1
          });
        }
      }
    } else {
      i++;
    }
  }

  return functions;
}

/**
 * Find function spans in Python lines
 * @param {string[]} lines
 * @returns {Array<{name: string, startLine: number, endLine: number, lineCount: number}>}
 */
function findPyFunctionSpans(lines) {
  const functions = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Match function definition: def function_name(
    const funcMatch = line.match(/^def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);

    if (funcMatch) {
      const name = funcMatch[1];
      const startLine = i + 1; // 1-indexed
      let endLine = startLine;
      let j = i + 1;

      // Find the end of the function (next def at same or lower indent, or EOF)
      while (j < lines.length) {
        const nextLine = lines[j];
        if (nextLine.trim() && !nextLine.startsWith(' ') && !nextLine.startsWith('\t')) {
          // Non-empty line at column 0 - likely a new top-level definition
          if (nextLine.trim().startsWith('def ')) {
            break;
          }
        }
        endLine = j + 1;
        j++;
      }

      functions.push({
        name,
        startLine,
        endLine,
        lineCount: endLine - startLine + 1
      });

      i = j;
    } else {
      i++;
    }
  }

  return functions;
}

/**
 * Find long files in a repository
 * @param {string} repoRoot
 * @param {{maxLines: number}} options
 * @returns {Array<{path: string, lineCount: number}>}
 */
function findLongFiles(repoRoot, { maxLines }) {
  const longFiles = [];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        const allowedExts = new Set(['.js', '.ts', '.py', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.cs', '.swift', '.kt', '.scala', '.r', '.m', '.mm']);

        if (allowedExts.has(ext)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lineCount = countLines(content);

            if (lineCount > maxLines) {
              const relPath = path.relative(repoRoot, fullPath);
              longFiles.push({ path: relPath, lineCount });
            }
          } catch (err) {
            // Skip files we can't read
          }
        }
      }
    }
  }

  walk(repoRoot);
  return longFiles;
}

/**
 * Find long functions in text
 * @param {string} text
 * @param {string} relPath
 * @param {{maxLines: number}} options
 * @returns {Array<{name: string, lineCount: number, path: string}>}
 */
function findLongFunctions(text, relPath, { maxLines }) {
  const ext = path.extname(relPath);
  const longFunctions = [];

  if (ext === '.py') {
    const lines = text.split('\n');
    const functions = findPyFunctionSpans(lines);

    for (const func of functions) {
      if (func.lineCount > maxLines) {
        longFunctions.push({
          name: func.name,
          lineCount: func.lineCount,
          path: relPath
        });
      }
    }
  } else if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
    const tokens = tokenizeJs(text);
    const functions = findJsFunctionSpans(tokens);

    for (const func of functions) {
      if (func.lineCount > maxLines) {
        longFunctions.push({
          name: func.name,
          lineCount: func.lineCount,
          path: relPath
        });
      }
    }
  }

  return longFunctions;
}

module.exports = {
  countLines,
  tokenizeJs,
  findJsFunctionSpans,
  findPyFunctionSpans,
  findLongFiles,
  findLongFunctions
};
