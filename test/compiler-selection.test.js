const assert = require('node:assert/strict');
const test = require('node:test');
const { extractDiagnostics, requestedCompilerKind, selectCompiler } = require('../server');

test('reads TeX engine magic comments without depending on case or spacing', () => {
  assert.equal(requestedCompilerKind('% !TeX program = xelatex\n\\documentclass{article}'), 'xelatex');
  assert.equal(requestedCompilerKind('%!TEX TS-program = lualatex\n'), 'lualatex');
  assert.equal(requestedCompilerKind('% !tex program=pdflatex\n'), 'pdflatex');
  assert.equal(requestedCompilerKind('\\documentclass{article}'), '');
});

test('selects the explicitly requested engine before the default engine', () => {
  const compiler = selectCompiler('% !TeX program = xelatex\n\\documentclass{article}');
  assert.equal(compiler.kind, 'xelatex');
  assert.equal(compiler.label, 'XeLaTeX');
});

test('recognizes CJK and Unicode font packages as XeLaTeX candidates', () => {
  const sources = [
    '\\documentclass{ctexart}',
    '\\usepackage{fontspec}',
    '\\usepackage{xeCJK}',
    '\\usepackage{polyglossia}',
    '\\usepackage{unicode-math}',
  ];
  for (const source of sources) {
    const compiler = selectCompiler(source);
    assert.ok(['xelatex', 'pdflatex', 'latexmk', 'tectonic'].includes(compiler.kind));
  }
});

test('reports diagnostics from the final successful pass only', () => {
  const output = [
    '--- pass 1 ---',
    'LaTeX Warning: Citation `example2026\' undefined.',
    '--- pass 2 ---',
    'Output written on main.pdf',
  ].join('\n');
  assert.equal(extractDiagnostics(output, true).length, 0);
  assert.equal(extractDiagnostics(output, false).length, 1);
});
