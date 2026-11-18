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

async function startServer(env) {
  let stderr = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = `http://127.0.0.1:${env.LOCAL_TEX_PORT}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before startup: ${stderr}`);
    try {
      const response = await fetch(`${url}/api/config`);
      if (response.ok) return { child, url, stderr: () => stderr };
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`Timed out waiting for the server: ${stderr}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timeout;
  await Promise.race([
    exited,
    new Promise((resolve) => { timeout = setTimeout(resolve, 2_000); }),
  ]);
  clearTimeout(timeout);
}

test('restores the last successful PDF after a server restart', { timeout: 30_000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localtex-pdf-restore-'));
  const dataRoot = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const sourceText = String.raw`\documentclass{article}
\begin{document}
Persistent PDF preview test.
\end{document}
`;
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), sourceText, 'utf8');
  fs.writeFileSync(path.join(dataRoot, 'projects.json'), JSON.stringify([{
    id: 'pdf-restore-project',
    name: 'PDF restore',
    path: workspace,
    mainFile: 'main.tex',
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
  }]), 'utf8');

  const port = await freeTcpPort();
  const env = {
    ...process.env,
    LOCAL_TEX_DATA_ROOT: dataRoot,
    LOCAL_TEX_WORKSPACE: workspace,
    LOCAL_TEX_PORT: String(port),
    LOCAL_TEX_HOST: '127.0.0.1',
    LOCAL_TEX_OPEN_BROWSER: '0',
  };
  const headers = {
    'Content-Type': 'application/json',
    'X-LocalTeX-Project': 'pdf-restore-project',
  };
  let running;
  try {
    running = await startServer(env);
    const config = await (await fetch(`${running.url}/api/config`)).json();
    if (!config.compiler) {
      context.skip('No local TeX compiler is installed.');
      return;
    }
    const compileResponse = await fetch(`${running.url}/api/compile`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mainFile: 'main.tex' }),
    });
    const compiled = await compileResponse.json();
    assert.equal(compileResponse.status, 200, compiled.output);
    assert.equal(compiled.pdfAvailable, true);
    assert.equal(
      fs.existsSync(path.join(workspace, '.tex-build', 'main', '.localtex-compile.json')),
      true,
    );
    await stopServer(running.child);
    running = null;

    running = await startServer(env);
    const restoredResponse = await fetch(`${running.url}/api/compile/latest?main=main.tex`, { headers });
    const restored = await restoredResponse.json();
    assert.equal(restoredResponse.status, 200, restored.error);
    assert.equal(restored.pdfAvailable, true);
    assert.equal(restored.restored, true);
    assert.equal(restored.stale, false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(workspace, 'main.tex'), sourceText, 'utf8');
    const rewritten = await (await fetch(`${running.url}/api/compile/latest?main=main.tex`, { headers })).json();
    assert.equal(rewritten.stale, false);

    fs.appendFileSync(path.join(workspace, 'main.tex'), '% changed after compile\n', 'utf8');
    const stale = await (await fetch(`${running.url}/api/compile/latest?main=main.tex`, { headers })).json();
    assert.equal(stale.stale, true);

    fs.writeFileSync(path.join(workspace, 'main.tex'), `${sourceText}${sourceText}`, 'utf8');
    const duplicateCompile = await fetch(`${running.url}/api/compile`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mainFile: 'main.tex' }),
    });
    const duplicateResult = await duplicateCompile.json();
    assert.equal(duplicateCompile.status, 422);
    assert.equal(duplicateResult.ok, false);
    assert.match(duplicateResult.output, /多个 \\documentclass/);

    const pdfResponse = await fetch(`${running.url}/api/pdf?main=main.tex`, { headers });
    assert.equal(pdfResponse.status, 200);
    const pdf = Buffer.from(await pdfResponse.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  } finally {
    if (running) await stopServer(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
