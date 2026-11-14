import Fastify from 'fastify';
import cors from '@fastify/cors';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

const dbPath = resolve(process.env.AI_AUTH_DB ?? './data/ai-auth.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_id TEXT, kind TEXT NOT NULL, room TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
`);

const app = Fastify({ logger: true, bodyLimit: 16_384 });
await app.register(cors, { origin: process.env.CORS_ORIGIN ?? false });
const sockets = new Set<import('ws').WebSocket>();
const now = () => new Date().toISOString();
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
function audit(actorId: string | null, kind: string, room: string | null, payload: unknown) {
  const event = { id: randomUUID(), actorId, kind, room, payload, createdAt: now() };
  db.prepare('INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?)').run(event.id, actorId, kind, room, JSON.stringify(payload), event.createdAt);
  return event;
}
function authenticate(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) { reply.code(401).send({ error: 'Bearer token required' }); return null; }
  const agent = db.prepare('SELECT id, name FROM agents WHERE token_hash = ?').get(tokenHash(token)) as { id: string; name: string } | undefined;
  if (!agent) { reply.code(401).send({ error: 'Invalid credential' }); return null; }
  return agent;
}

app.get('/health', async () => ({ ok: true }));
app.post('/v1/agents/register', async (request, reply) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'name must be 1-80 characters' });
  const id = randomUUID(); const token = randomBytes(32).toString('base64url'); const createdAt = now();
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?)').run(id, parsed.data.name, tokenHash(token), createdAt);
  audit(id, 'agent.registered', null, { name: parsed.data.name });
  return reply.code(201).send({ agent: { id, name: parsed.data.name, createdAt }, token });
});
app.get('/v1/me', async (request, reply) => {
  const agent = authenticate(request, reply); return agent ? { agent } : reply;
});
app.post('/v1/rooms/:room/messages', async (request, reply) => {
  const agent = authenticate(request, reply); if (!agent) return reply;
  const params = z.object({ room: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).safeParse(request.params);
  const body = z.object({ body: z.string().trim().min(1).max(4000) }).safeParse(request.body);
  if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid room or message body' });
  const message = { id: randomUUID(), room: params.data.room, agentId: agent.id, body: body.data.body, createdAt: now() };
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(message.id, message.room, message.agentId, message.body, message.createdAt);
  const event = audit(agent.id, 'message.created', message.room, message);
  const wire = JSON.stringify({ type: 'message', ...message });
  for (const socket of sockets) if ((socket as import('ws').WebSocket & { room?: string }).room === message.room && socket.readyState === socket.OPEN) socket.send(wire);
  return reply.code(201).send({ message, auditId: event.id });
});
app.get('/v1/rooms/:room/messages', async (request, reply) => {
  if (!authenticate(request, reply)) return reply;
  const params = z.object({ room: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'invalid room' });
  return { messages: db.prepare('SELECT id, room, agent_id AS agentId, body, created_at AS createdAt FROM messages WHERE room = ? ORDER BY created_at LIMIT 200').all(params.data.room) };
});
app.get('/v1/audit', async (request, reply) => {
  const agent = authenticate(request, reply); if (!agent) return reply;
  return { events: db.prepare('SELECT id, actor_id AS actorId, kind, room, payload, created_at AS createdAt FROM audit_events WHERE actor_id = ? ORDER BY created_at DESC LIMIT 200').all(agent.id) };
});

const port = Number(process.env.PORT ?? 3333);
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
const wss = new WebSocketServer({ server: app.server, path: '/v1/events' });
wss.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const token = url.searchParams.get('token') ?? '';
  const room = url.searchParams.get('room') ?? '';
  const agent = db.prepare('SELECT id FROM agents WHERE token_hash = ?').get(tokenHash(token));
  if (!agent || !/^[a-zA-Z0-9_-]{1,64}$/.test(room)) { socket.close(1008, 'unauthorized'); return; }
  (socket as import('ws').WebSocket & { room?: string }).room = room;
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); db.close(); process.exit(0); });
