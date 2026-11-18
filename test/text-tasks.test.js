const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildTextTaskPrompt, createCodexService } = require('../codex-service');

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function loadAppHelper(name, nextName) {
  const start = appSource.indexOf(`function ${name}`);
  const nextStart = appSource.indexOf(`function ${nextName}`, start + 1);
  const nextAsyncStart = appSource.indexOf(`async function ${nextName}`, start + 1);
  const end = Math.min(...[nextStart, nextAsyncStart].filter((index) => index >= 0));
  const context = vm.createContext({});
  vm.runInContext(`${appSource.slice(start, end)}\nthis.helper = ${name};`, context);
  return context.helper;
}

test('builds an exact inline-edit prompt without allowing file writes', () => {
  const prompt = buildTextTaskPrompt({
    prompt: '把这段改得更简洁',
    activeFile: 'sections/method.tex',
    selection: '\\textbf{这是一段需要修改的文字。}',
    activeFileContent: '',
  }, 'inline-edit');

  assert.match(prompt, /只输出可以直接替换原选区/);
  assert.match(prompt, /不要使用 Markdown 代码围栏/);
  assert.match(prompt, /把这段改得更简洁/);
  assert.match(prompt, /\\textbf\{这是一段需要修改的文字。\}/);
  assert.doesNotMatch(prompt, /直接修改文件/);
});

test('builds bilingual translation prompts for selected text and full documents', () => {
  const prompt = buildTextTaskPrompt({
    prompt: '翻译当前文本。',
    activeFile: 'main.tex',
    selection: 'This paragraph explains the method.',
    activeFileContent: '',
    translationTarget: 'zh',
  }, 'translation');

  assert.match(prompt, /翻译为简体中文/);
  assert.match(prompt, /保留原有 LaTeX 文档结构/);
  assert.match(prompt, /只输出译文/);
  assert.match(prompt, /This paragraph explains the method\./);
});

test('extracts fenced task output while preserving its inner formatting', () => {
  const extract = loadAppHelper('extractTextTaskResult', 'waitForTextTask');
  assert.equal(extract('```latex\n  \\textbf{Updated}\n```'), '  \\textbf{Updated}');
  assert.equal(extract('Plain translation\n\nSecond paragraph'), 'Plain translation\n\nSecond paragraph');
});

test('detects the translation direction from Chinese and English source text', () => {
  const detect = loadAppHelper('detectTextLanguage', 'selectedTranslationTarget');
  assert.equal(detect('本文提出一种新的 LaTeX 写作方法。'), 'zh');
  assert.equal(detect('This paper introduces a new LaTeX writing workflow.'), 'en');
  assert.equal(detect(String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
本文提出一种新的中英双语写作方法，并保留所有公式。
\end{document}`), 'zh');
});

test('runs text transformations with read-only sandbox permissions and returns replacement text', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localtex-text-task-'));
  const service = createCodexService({
    historyClient: {
      async request() {
        throw new Error('text tasks should create a fresh thread');
      },
      close() {},
    },
  });
  service.setPermissionMode('full-access');

  let capturedOptions;
  let capturedPrompt;
  service.client = async () => ({
    startThread(options) {
      capturedOptions = options;
      return {
        async runStreamed(prompt) {
          capturedPrompt = prompt;
          return {
            events: (async function* events() {
              yield { type: 'thread.started', thread_id: 'thread-inline-edit' };
              yield {
                type: 'item.completed',
                item: { type: 'agent_message', id: 'message-inline-edit', text: '\\emph{更简洁的表达}' },
              };
              yield { type: 'turn.completed', usage: {} };
            }()),
          };
        },
      };
    },
    resumeThread() {
      throw new Error('text tasks must not resume a chat thread');
    },
  });

  const run = await service.start(
    { id: 'text-task-project', path: workspace, mainFile: 'main.tex' },
    {
      taskKind: 'inline-edit',
      prompt: '写得更简洁',
      activeFile: 'main.tex',
      includeSelection: true,
      selection: '\\emph{一段冗长的表达}',
    },
  );

  const done = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('text task timed out')), 2_000);
    service.subscribe(run.id, 'text-task-project', 0, (event) => {
      if (event.type !== 'done') return;
      clearTimeout(timeout);
      resolve(event);
    });
  });

  assert.equal(capturedOptions.sandboxMode, 'read-only');
  assert.equal(capturedOptions.networkAccessEnabled, false);
  assert.equal(capturedOptions.webSearchMode, 'disabled');
  assert.match(capturedPrompt, /只输出可以直接替换原选区/);
  assert.equal(done.finalAssistant.text, '\\emph{更简洁的表达}');
  assert.equal(done.filesChanged, false);
  service.shutdown();
});

test('rejects unsupported text task kinds before starting Codex', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localtex-text-task-invalid-'));
  const service = createCodexService({
    historyClient: { async request() {}, close() {} },
  });
  await assert.rejects(
    service.start(
      { id: 'invalid-task-project', path: workspace, mainFile: 'main.tex' },
      { taskKind: 'rewrite-whole-project', prompt: 'test' },
    ),
    /文本任务类型无效/,
  );
  service.shutdown();
});
