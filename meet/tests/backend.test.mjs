// These tests exercise application behavior against Node's real SQLite engine.
// They do not replace the Cloudflare runtime / live WebSocket acceptance checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../', import.meta.url);
const roomSource = (await readFile(new URL('src/room.js', root), 'utf8')).replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
);
const roomModuleUrl = 'data:text/javascript;base64,' + Buffer.from(roomSource).toString('base64');
const { MeetingRoom } = await import(roomModuleUrl);
const workerSource = (await readFile(new URL('src/worker.js', root), 'utf8'))
  .replace("import { ASSETS } from './assets.js';", "const ASSETS = {'/index.html':{body:'<!doctype html><title>Meet</title>',type:'text/html; charset=utf-8'}};")
  .replaceAll("'./room.js'", JSON.stringify(roomModuleUrl));
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));

function context(database = new DatabaseSync(':memory:')) {
  return {
    database,
    storage: {
      sql: {
        exec(query, ...args) {
          const statement = database.prepare(query);
          const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
          return { toArray: () => rows };
        },
      },
      transactionSync(callback) {
        database.exec('BEGIN');
        try { const value = callback(); database.exec('COMMIT'); return value; }
        catch (error) { database.exec('ROLLBACK'); throw error; }
      },
    },
    getWebSockets() { return []; },
  };
}

function environment() {
  const objects = new Map();
  return {
    ROOMS: {
      getByName(name) {
        if (!objects.has(name)) {
          const ctx = context();
          objects.set(name, { ctx, room: new MeetingRoom(ctx, {}) });
        }
        return { fetch: (request) => objects.get(name).room.fetch(request) };
      },
    },
    restart(id) {
      const stored = objects.get(`room:${id}`);
      stored.room = new MeetingRoom(stored.ctx, {});
    },
    seedMessages(id, participant, texts) {
      // Seed realistic prior persisted records without waiting for minute-based
      // posting limits. The subsequent request still uses the public API.
      const { database } = objects.get(`room:${id}`).ctx;
      const insert = database.prepare('INSERT INTO messages (id, author_id, author_name, author_kind, text, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      database.exec('BEGIN');
      for (const text of texts) insert.run(crypto.randomUUID(), participant.id, participant.name, participant.kind, text, 'decision', new Date().toISOString());
      database.exec('COMMIT');
    },
    close() { for (const item of objects.values()) item.ctx.database.close(); },
  };
}

function fixture(t) {
  const env = environment();
  t.after(() => env.close());
  async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
    const requestHeaders = new Headers(headers);
    if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    const response = await worker.fetch(new Request(`https://meet.example${path}`, {
      method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    const contentType = response.headers.get('Content-Type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, headers: response.headers, data };
  }
  async function create(title = '发布评审') {
    const response = await call('/api/rooms', { method: 'POST', body: { title, agenda: '讨论上线范围', hostName: '老板' } });
    assert.equal(response.status, 201);
    return response.data;
  }
  async function join(room, extra = {}) {
    const response = await call(`/api/rooms/${room.room.id}/join`, {
      method: 'POST', body: { inviteToken: room.inviteToken, name: '工程 Agent', role: '执行', kind: 'agent', ...extra },
    });
    assert.equal(response.status, 201);
    return response.data;
  }
  return { env, call, create, join };
}

test('create, join, durable transcript and secret-free state', async (t) => {
  const f = fixture(t);
  const created = await f.create();
  const agent = await f.join(created);
  const path = `/api/rooms/${created.room.id}`;
  assert.equal(created.room.hostId, created.participant.id);
  const posted = await f.call(`${path}/messages`, { method: 'POST', token: agent.token, body: { text: '部署检查完成', clientId: 'run-1' } });
  assert.equal(posted.status, 201);
  assert.equal(posted.data.message.seq, 1);
  assert.equal(posted.data.message.authorId, agent.participant.id);
  const state = await f.call(`${path}/state`, { token: created.hostToken });
  assert.equal(state.data.access, 'host');
  assert.equal(state.data.participants.length, 2);
  assert.equal(state.data.messages[0].text, '部署检查完成');
  const serialized = JSON.stringify(state.data);
  for (const token of [created.hostToken, created.inviteToken, agent.token]) assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('token_hash'), false);
  f.env.restart(created.room.id);
  const restored = await f.call(`${path}/state`, { token: agent.token });
  assert.equal(restored.data.messages[0].id, posted.data.message.id);
  const transcript = await f.call(`${path}/transcript?format=json`, { token: agent.token });
  assert.equal(transcript.data.messages.length, 1);
  assert.match(transcript.headers.get('Content-Disposition'), /attachment/);
});

test('room isolation and host-only operations', async (t) => {
  const f = fixture(t);
  const first = await f.create();
  const second = await f.create('另一场会议');
  const member = await f.join(first);
  const path = `/api/rooms/${first.room.id}`;
  assert.equal((await f.call(`${path}/state`)).status, 401);
  assert.equal((await f.call(`/api/rooms/${second.room.id}/state`, { token: first.hostToken })).status, 401);
  assert.equal((await f.call(`${path}/control`, { method: 'POST', token: member.token, body: { action: 'pause' } })).status, 403);
  assert.equal((await f.call(`${path}/control`, { method: 'POST', token: first.hostToken, body: { action: '__proto__' } })).status, 400);
  assert.equal((await f.call(`${path}/control`, { method: 'POST', token: first.hostToken, body: { action: 'toString' } })).status, 400);
  assert.equal((await f.call(`${path}/state`, { token: first.hostToken })).data.room.status, 'active');
  assert.equal((await f.call(`${path}/messages`, { method: 'POST', token: member.token, body: { text: '越权决议', kind: 'decision' } })).status, 403);
  assert.equal((await f.call(`${path}/messages`, { method: 'POST', token: member.token, body: { text: '冒名', bridgeSource: '老板' } })).status, 403);
  const bridged = await f.call(`${path}/messages`, { method: 'POST', token: first.hostToken, body: { text: '人工复制的意见', bridgeSource: 'Muse 会话' } });
  assert.equal(bridged.status, 201);
  assert.equal(bridged.data.message.authorName, '老板');
  assert.equal(bridged.data.message.bridgeSource, 'Muse 会话');
});

test('pause/end gates, idempotency and conflict recovery', async (t) => {
  const f = fixture(t);
  const created = await f.create();
  const agent = await f.join(created);
  const path = `/api/rooms/${created.room.id}`;
  const body = { text: '建议先发布最小版本', clientId: 'stable-id' };
  const first = await f.call(`${path}/messages`, { method: 'POST', token: agent.token, body });
  await f.call(`${path}/control`, { method: 'POST', token: created.hostToken, body: { action: 'pause' } });
  const repeated = await f.call(`${path}/messages`, { method: 'POST', token: agent.token, body });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.message.id, first.data.message.id);
  const conflict = await f.call(`${path}/messages`, { method: 'POST', token: agent.token, body: { ...body, text: '替换原内容' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.call(`${path}/messages`, { method: 'POST', token: agent.token, body: { text: '暂停中发言' } })).data.error.code, 'ROOM_PAUSED');
  const decision = await f.call(`${path}/messages`, { method: 'POST', token: created.hostToken, body: { text: '本轮范围已确认', kind: 'decision' } });
  assert.equal(decision.status, 201);
  await f.call(`${path}/control`, { method: 'POST', token: created.hostToken, body: { action: 'end' } });
  const afterEnd = await f.call(`${path}/messages`, { method: 'POST', token: created.hostToken, body: { text: '结束后普通发言' } });
  assert.equal(afterEnd.data.error.code, 'ROOM_ENDED');
  assert.equal((await f.call(`${path}/join`, { method: 'POST', body: { name: '后来者', inviteToken: created.inviteToken } })).status, 409);
  await f.call(`${path}/control`, { method: 'POST', token: created.hostToken, body: { action: 'reopen' } });
  assert.equal((await f.call(`${path}/messages`, { method: 'POST', token: agent.token, body: { text: '重新开始' } })).status, 201);
});

test('concurrent writes preserve sequence and paging has no omissions', async (t) => {
  const f = fixture(t);
  const created = await f.create();
  const agent = await f.join(created);
  const path = `/api/rooms/${created.room.id}`;
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.call(`${path}/messages`, {
    method: 'POST', token: agent.token, body: { text: `消息 ${i}`, clientId: `concurrent-${i}` },
  })));
  assert.ok(responses.every((r) => r.status === 201));
  assert.equal(new Set(responses.map((r) => r.data.message.seq)).size, 12);
  let cursor = 0;
  const collected = [];
  for (let page = 0; page < 10; page++) {
    const r = await f.call(`${path}/messages?after=${cursor}&limit=5`, { token: agent.token });
    collected.push(...r.data.messages);
    cursor = r.data.cursor;
    if (!r.data.hasMore) break;
  }
  assert.deepEqual(collected.map((message) => message.seq), Array.from({ length: 12 }, (_, i) => i + 1));
});

test('rotated invites expire without invalidating joined participants', async (t) => {
  const f = fixture(t);
  const created = await f.create();
  const agent = await f.join(created);
  const path = `/api/rooms/${created.room.id}`;
  const rotation = await f.call(`${path}/invite`, { method: 'POST', token: created.hostToken, body: { action: 'rotate' } });
  assert.equal(rotation.status, 200);
  assert.equal((await f.call(`${path}/join`, { method: 'POST', body: { name: '旧链接', inviteToken: created.inviteToken } })).status, 403);
  assert.equal((await f.call(`${path}/join`, { method: 'POST', body: { name: '新链接', inviteToken: rotation.data.inviteToken } })).status, 201);
  assert.equal((await f.call(`${path}/state`, { token: agent.token })).status, 200);
});

test('origin checks, body bounds, field bounds and safe static headers', async (t) => {
  const f = fixture(t);
  const blocked = await f.call('/api/rooms', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { title: 'csrf' } });
  assert.equal(blocked.status, 403);
  assert.equal((await f.call('/api/rooms', { method: 'POST', body: { title: '超长', agenda: 'a'.repeat(70_000) } })).status, 413);
  const created = await f.create();
  const path = `/api/rooms/${created.room.id}`;
  assert.equal((await f.call(`${path}/messages`, { method: 'POST', token: created.hostToken, body: { text: 'a'.repeat(8_001) } })).status, 400);
  assert.equal((await f.call(`${path}/messages?after=-1`, { token: created.hostToken })).status, 400);
  assert.equal((await f.call(`${path}/transcript?format=html`, { token: created.hostToken })).status, 400);
  const html = await f.call('/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(html.headers.get('X-Frame-Options'), 'DENY');
  assert.equal((await f.call(`/r/${created.room.id}`)).status, 200);
  assert.equal((await f.call('/__proto__')).status, 404);
  assert.equal((await f.call('/internal/create', { method: 'POST', body: {} })).status, 405);
});

test('message and creation rate limits are enforced', async (t) => {
  const f = fixture(t);
  const created = await f.create();
  const path = `/api/rooms/${created.room.id}`;
  for (let i = 0; i < 40; i++) {
    assert.equal((await f.call(`${path}/messages`, { method: 'POST', token: created.hostToken, body: { text: `有限发言 ${i}` } })).status, 201);
  }
  const limited = await f.call(`${path}/messages`, { method: 'POST', token: created.hostToken, body: { text: '超额发言' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  for (let i = 0; i < 9; i++) await f.create(`会议 ${i}`);
  assert.equal((await f.call('/api/rooms', { method: 'POST', body: { title: '超额会议' } })).status, 429);
});

test('control-character transcripts obey the byte budget and bounded JSON expansion', async (t) => {
  const f = fixture(t);
  const created = await f.create();
  const path = `/api/rooms/${created.room.id}`;
  // NUL escapes to six JSON characters. The CJK suffix also forces two-byte
  // JS strings. Each persisted message remains within the 8000-character cap.
  const text = '\0'.repeat(7_999) + '中';
  const bytesPerMessage = Buffer.byteLength(text, 'utf8');
  const count = Math.floor((2 * 1024 * 1024) / bytesPerMessage);
  f.env.seedMessages(created.room.id, created.participant, Array(count).fill(text));
  const remaining = 2 * 1024 * 1024 - count * bytesPerMessage;
  const rejected = await f.call(`${path}/messages`, {
    method: 'POST', token: created.hostToken, body: { text: '\0'.repeat(remaining + 1) },
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.error.code, 'TRANSCRIPT_LIMIT');
  assert.match(rejected.data.error.message, /2 MiB/);
  const exported = await f.call(`${path}/transcript?format=json`, { token: created.hostToken });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.messages.length, count);
  assert.equal(exported.data.decisions.length, count);
  assert.ok(Buffer.byteLength(JSON.stringify(exported.data), 'utf8') < 26 * 1024 * 1024);
  assert.equal(exported.data.messages[0].text, text);
});
