import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('local service registers agents, authenticates messages, streams room events, and persists audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-auth-'));
  const port = 34000 + Math.floor(Math.random() * 10000);
  const env = { ...process.env, PORT: String(port), AI_AUTH_DB: join(dir, 'test.sqlite') };
  let server: ChildProcess | undefined;
  try {
    server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/server.ts'], { env, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch { /* wait for listen */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'server should become ready');
    const register = async (name: string) => {
      const response = await fetch(`${base}/v1/agents/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      assert.equal(response.status, 201);
      return await response.json() as { agent: { id: string }; token: string };
    };
    const a = await register('Writer'); const b = await register('Observer');
    assert.notEqual(a.token, b.token);
    assert.equal((await fetch(`${base}/v1/me`)).status, 401);
    const wsEvent = new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events?token=${encodeURIComponent(b.token)}&room=demo`);
      const timer = setTimeout(() => { socket.close(); reject(new Error('event timeout')); }, 3000);
      socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(String(event.data)); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('websocket failed')); };
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const sent = await fetch(`${base}/v1/rooms/demo/messages`, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hello' }) });
    assert.equal(sent.status, 201);
    const event = JSON.parse(await wsEvent) as { type: string; agentId: string; body: string };
    assert.equal(event.type, 'message'); assert.equal(event.agentId, a.agent.id); assert.equal(event.body, 'hello');
    const history = await fetch(`${base}/v1/audit`, { headers: { authorization: `Bearer ${a.token}` } });
    const data = await history.json() as { events: Array<{ kind: string }> };
    assert.ok(data.events.some(item => item.kind === 'message.created'));
  } finally {
    server?.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    await rm(dir, { recursive: true, force: true });
  }
});
