const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForConfig(url, child, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before startup: ${stderr()}`);
    try {
      const response = await fetch(`${url}/api/config`);
      if (response.ok) return response.json();
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the server: ${stderr()}`);
}

test('loads a persistent local Codex home when CODEX_HOME is unset', { timeout: 10_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localtex-codex-home-'));
  const dataRoot = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const codexHome = path.join(root, 'deepseek-home');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model_provider = "sub2api"',
    'model = "deepseek-flash"',
    'model_reasoning_effort = "max"',
    '',
    '[model_providers.sub2api]',
    'name = "Test DeepSeek"',
    'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(dataRoot, 'codex-home.json'), JSON.stringify({ path: codexHome }), 'utf8');

  const port = await freeTcpPort();
  const env = {
    ...process.env,
    LOCAL_TEX_DATA_ROOT: dataRoot,
    LOCAL_TEX_WORKSPACE: workspace,
    LOCAL_TEX_PORT: String(port),
    LOCAL_TEX_OPEN_BROWSER: '0',
  };
  delete env.CODEX_HOME;
  let stderr = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const config = await waitForConfig(`http://127.0.0.1:${port}`, child, () => stderr);
    assert.equal(config.codex.configSource, 'CODEX_HOME');
    assert.equal(config.codex.configured, true);
    assert.equal(config.codex.authDetected, true);
    assert.equal(config.codex.configuredModel, 'deepseek-flash');
    assert.equal(config.codex.configuredReasoningEffort, 'max');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      let timeout;
      await Promise.race([
        exited,
        new Promise((resolve) => { timeout = setTimeout(resolve, 2_000); }),
      ]);
      clearTimeout(timeout);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
