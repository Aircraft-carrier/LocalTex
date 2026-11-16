const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('function initializeCodeEditor()');
const initializer = source.slice(start, source.indexOf('\nfunction ', start + 1));

function initialize(languageTools) {
  const options = {};
  const editor = {
    setTheme() {}, setOptions(value) { Object.assign(options, value); },
    session: { setMode() {}, setUseWorker() {} },
    renderer: { setScrollMargin() {} }, setReadOnly() {},
    textInput: { getElement: () => ({ setAttribute() {} }) },
    commands: { addCommand() {} },
  };
  const context = vm.createContext({
    window: { ace: { config: { set() {} }, edit: () => editor, require: () => languageTools } },
    elements: { editor: {} },
    state: { files: [{ path: 'Sections/intro.tex', type: 'file' }, { path: 'Sections', type: 'directory' }] },
  });
  const result = vm.runInContext(`${initializer}\ninitializeCodeEditor()`, context);
  assert.equal(result, editor);
  return options;
}

test('editor startup survives an unavailable completion extension', () => {
  const options = initialize(undefined);
  assert.equal(options.enableLiveAutocompletion, undefined);
});

test('editor startup registers usable project file completions', () => {
  let completer;
  const options = initialize({ addCompleter(value) { completer = value; } });
  assert.equal(options.enableLiveAutocompletion, true);
  const line = '\\input{intro';
  completer.getCompletions(null, { getLine: () => line }, { row: 0, column: line.length }, 'intro', (error, results) => {
    assert.equal(error, null);
    assert.deepEqual(Array.from(results, item => item.value), ['Sections/intro.tex']);
  });
});

test('page loads the completion extension before app startup', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), match => match[1]);
  const extension = scripts.indexOf('/vendor/ace/ext-language_tools.js');
  assert.ok(extension > scripts.indexOf('/vendor/ace/ace.js'));
  assert.ok(extension < scripts.indexOf('/app.js'));
});
