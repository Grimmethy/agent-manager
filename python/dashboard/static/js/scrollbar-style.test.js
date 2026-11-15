'use strict';
// Run: node --test python/dashboard/static/js/scrollbar-style.test.js
// Scrollbars (owner request 2026-11-02): the browser's light grey default bars clashed with the dark theme. They are now slim, fully rounded and blue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(html);
  assert.ok(m, `rule not found: ${selector}`);
  return m[1];
}
const declaration = (body, prop) => {
  const m = new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(body + ';');
  return m ? m[1].trim() : null;
};

test('the scrollbar is 12px wide and tall', () => {
  const b = rule('::-webkit-scrollbar');
  assert.equal(declaration(b, 'width'), '12px');
  assert.equal(declaration(b, 'height'), '12px');
});

test('the track is a faint blue, fully rounded', () => {
  const b = rule('::-webkit-scrollbar-track');
  assert.equal(declaration(b, 'background'), 'rgba(91, 157, 255, .06)');
  assert.equal(declaration(b, 'border-radius'), '999px');
});

test('the thumb is a rounded pill in the strong blue, inset by a transparent border, and turns the accent blue on hover', () => {
  const t = rule('::-webkit-scrollbar-thumb');
  assert.equal(declaration(t, 'background'), 'var(--border-strong)');
  assert.equal(declaration(t, 'background-clip'), 'padding-box');
  assert.equal(declaration(t, 'border'), '3px solid transparent');
  assert.equal(declaration(t, 'border-radius'), '999px');
  const h = rule('::-webkit-scrollbar-thumb:hover');
  assert.equal(declaration(h, 'background'), 'var(--accent)');
  assert.equal(declaration(h, 'background-clip'), 'padding-box');
  assert.equal(declaration(rule('::-webkit-scrollbar-corner'), 'background'), 'transparent');
});

test('browsers without the webkit pseudo-elements get the thin standard scrollbar in the same colours', () => {
  const m = /@supports not selector\(::-webkit-scrollbar\) \{ \* \{ ([^}]*)\} \}/.exec(html);
  assert.ok(m, 'fallback block');
  assert.equal(declaration(m[1], 'scrollbar-width'), 'thin');
  assert.equal(declaration(m[1], 'scrollbar-color'), 'var(--border-strong) rgba(91, 157, 255, .06)');
});

test('--border-strong is declared once, in the first :root block, so it exists wherever it is used', () => {
  assert.equal((html.match(/--border-strong:\s*#/g) || []).length, 1);
  const firstRoot = /:root \{([^}]*)\}/.exec(html)[1];
  assert.match(firstRoot, /--border-strong: #5668a0;/);
});

// WCAG contrast of the thumb colours against the page and the cards, using the real :root values.
const rootVar = (name) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(/:root \{([^}]*)\}/.exec(html)[1])[1];
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('the thumb is visible: at least 3:1 against the page and the card colours, and the hover blue too', () => {
  for (const bg of ['bg', 'panel']) {
    assert.ok(ratio(rootVar('border-strong'), rootVar(bg)) >= 3, `thumb on ${bg}`);
    assert.ok(ratio(rootVar('accent'), rootVar(bg)) >= 3, `hover on ${bg}`);
  }
});

test('the old default look is gone: no scrollbar-width auto, no square thumb', () => {
  assert.doesNotMatch(html, /scrollbar-width:\s*auto/);
  assert.doesNotMatch(rule('::-webkit-scrollbar-thumb'), /border-radius:\s*0/);
});
