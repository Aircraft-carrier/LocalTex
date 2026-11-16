const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

function resize(start, delta, { available = 1000, collapsed = false, kind = 'sidebar' } = {}) {
  const context = vm.createContext({
    panelMinimums: () => ({ sidebar: 145, editor: 260, preview: 230, codex: collapsed ? 0 : 250, available }),
    isSidebarCollapsed: () => false,
    isCodexCollapsed: () => collapsed,
  });
  vm.runInContext(`${functionSource('clamp')}\n${functionSource('resizedPanelSizes')}`, context);
  return JSON.parse(JSON.stringify(context.resizedPanelSizes(kind, start, delta)));
}

test('sidebar can grow when the editor is at its minimum width', () => {
  assert.deepEqual(resize({ sidebar: 145, preview: 345, codex: 250 }, 80),
    { sidebar: 225, preview: 265, codex: 250 });
});

test('sidebar can grow with Codex collapsed without changing its saved width', () => {
  assert.deepEqual(resize({ sidebar: 145, preview: 495, codex: 380 }, 80, { available: 900, collapsed: true }),
    { sidebar: 225, preview: 415, codex: 380 });
});

test('sidebar borrows Codex headroom after the preview reaches its minimum', () => {
  assert.deepEqual(resize({ sidebar: 145, preview: 230, codex: 365 }, 80),
    { sidebar: 225, preview: 230, codex: 285 });
});

test('sidebar drag stops at the combined pane minimums', () => {
  assert.deepEqual(resize({ sidebar: 145, preview: 345, codex: 250 }, 1000),
    { sidebar: 260, preview: 230, codex: 250 });
});

test('sidebar shrinking leaves the preview and Codex widths unchanged', () => {
  assert.deepEqual(resize({ sidebar: 230, preview: 300, codex: 250 }, -40, { available: 1100 }),
    { sidebar: 190, preview: 300, codex: 250 });
});

test('editor-preview divider resizes the PDF preview in the drag direction', () => {
  const start = { sidebar: 145, preview: 345, codex: 250 };
  assert.equal(resize(start, 80, { kind: 'preview', available: 1200 }).preview, 265);
  assert.equal(resize(start, -80, { kind: 'preview', available: 1200 }).preview, 425);
});

test('collapsing the project sidebar keeps TeX width and gives released space to PDF', () => {
  const context = vm.createContext({});
  vm.runInContext(functionSource('sidebarCollapsePanelSizes'), context);
  const current = { sidebar: 220, editor: 500, preview: 350, codex: 300 };
  assert.deepEqual(JSON.parse(JSON.stringify(context.sidebarCollapsePanelSizes(true, current, 220, 7))),
    { sidebar: 220, editor: 500, preview: 577, codex: 300 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.sidebarCollapsePanelSizes(false,
    { ...current, preview: 577 }, 220, 7))), current);
});
