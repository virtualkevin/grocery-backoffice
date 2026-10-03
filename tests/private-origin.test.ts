import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { createApp } from '../server/app.js';

test('private proxy admits only configured exact external origin and preserves session revoke', async () => {
  const engine = new Engine(':memory:', 0);
  const run = engine.create({}, false);
  const origin = 'http://100.100.80.11:3001';
  const server = createApp(engine, { publicOrigin: origin }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const candidate of ['https://evil.example', 'http://100.100.80.11:3002', 'https://100.100.80.11:3001', 'http://100.100.80.11.evil.example:3001']) {
      assert.equal((await fetch(`${base}/api/session/god`, { method: 'POST', headers: { origin: candidate, 'content-type': 'application/json' }, body: '{"enabled":true}' })).status, 403);
    }
    const response = await fetch(`${base}/api/session/god`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"enabled":true}' });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(`${base}/api/runs/${run.id}/god`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/session/god`, { method: 'DELETE', headers: { origin, cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/runs/${run.id}/god`, { headers: { cookie } })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); engine.close(); }
});

test('proxy origin configuration rejects paths and non-HTTP protocols', () => {
  const engine = new Engine(':memory:', 0);
  try {
    for (const publicOrigin of ['http://example.com/path', 'https://example.com/', 'file://example.com', 'https://user:password@example.com'])
      assert.throws(() => createApp(engine, { publicOrigin }));
  } finally { engine.close(); }
});
