const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { WebSocket } = require('ws');
const Y = require('yjs');
const { attachCollaborationServer } = require('../collaboration-server');

function waitForMessage(socket, predicate, timeout = 4_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a collaboration message.'));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
    }
    function onMessage(raw) {
      const message = JSON.parse(raw.toString('utf8'));
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

async function startCollaborationServer(documentState) {
  const server = http.createServer((request, response) => response.end('ok'));
  const collaboration = attachCollaborationServer(server, {
    authenticate: () => true,
    resolveDocument: async () => ({
      key: 'project:main.tex',
      initialContent: documentState.content,
    }),
    loadDocument: async () => documentState.content,
    saveDocument: async (_context, content) => { documentState.content = content; },
    loadState: async () => documentState.state,
    saveState: async (_context, state) => { documentState.state = Buffer.from(state); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    collaboration,
    url: `ws://127.0.0.1:${server.address().port}/collaboration?project=test&path=main.tex`,
  };
}

async function connect(url) {
  const socket = new WebSocket(url);
  const sync = waitForMessage(socket, (message) => message.type === 'sync');
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, sync: await sync };
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.close();
  let timeout;
  await Promise.race([
    closed,
    new Promise((resolve) => { timeout = setTimeout(resolve, 500); }),
  ]);
  clearTimeout(timeout);
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

async function closeCollaborationServer(running) {
  await running.collaboration.close();
  await new Promise((resolve) => running.server.close(resolve));
}

test('persists CRDT state so a reconnecting client does not duplicate content after restart', { timeout: 10_000 }, async () => {
  const documentState = { content: 'Original document.\n', state: null };
  let running = null;
  let connection = null;
  const client = new Y.Doc();
  try {
    running = await startCollaborationServer(documentState);
    connection = await connect(running.url);
    Y.applyUpdate(client, Buffer.from(connection.sync.update, 'base64'));
    const text = client.getText('content');
    assert.equal(text.toString(), documentState.content);

    const saved = waitForMessage(connection.socket, (message) => message.type === 'saved');
    text.insert(text.length, 'Local edit.\n');
    connection.socket.send(JSON.stringify({
      type: 'update',
      update: Buffer.from(Y.encodeStateAsUpdate(client)).toString('base64'),
    }));
    await saved;
    assert.equal(documentState.content, 'Original document.\nLocal edit.\n');
    await closeSocket(connection.socket);
    connection = null;
    await closeCollaborationServer(running);
    running = null;

    running = await startCollaborationServer(documentState);
    connection = await connect(running.url);
    Y.applyUpdate(client, Buffer.from(connection.sync.update, 'base64'));
    assert.equal(text.toString(), 'Original document.\nLocal edit.\n');
    assert.equal(text.toString().match(/Original document\./g)?.length, 1);
  } finally {
    await closeSocket(connection?.socket);
    if (running) await closeCollaborationServer(running);
    client.destroy();
  }
});
