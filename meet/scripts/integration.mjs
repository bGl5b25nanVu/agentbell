import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Exercises the actual Worker runtime locally or a deployed HTTPS endpoint.
// Test rooms contain synthetic data and are ended in finally; no secrets print.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = process.argv.indexOf('--url');
const remote = target >= 0 ? process.argv[target + 1] : null;
if (remote && !/^https:\/\//.test(remote)) throw new Error('Remote tests require HTTPS.');
let mf;
const persist = remote ? null : await mkdtemp(path.join(tmpdir(), 'agentbell-meet-test-'));
const makeRuntime = () => new Miniflare({ name: 'agentbell-meet', modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: path.join(root, 'dist/worker.js'), modulesRoot: path.join(root, 'dist'),
  compatibilityDate: process.env.MEET_LOCAL_COMPATIBILITY_DATE || '2026-08-06', durableObjects: { ROOMS: { className: 'MeetingRoom', useSQLite: true } },
  durableObjectsPersist: persist, cf: false, log: new Log(LogLevel.ERROR) });
if (!remote) { mf = makeRuntime(); await mf.ready; }
const origin = remote ? new URL(remote).origin : 'http://meet.test';
const rooms = [];
const checks = [];
let socket;
const run = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const dispatch = (url, options) => remote ? fetch(url, options) : mf.dispatchFetch(url, options);
async function req(route, { method = 'GET', token, body, expect = 200, headers = {} } = {}) {
  const response = await dispatch(origin + route, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const content = await response.text();
  let data; try { data = JSON.parse(content); } catch { data = content; }
  assert.equal(response.status, expect, `${method} ${route.split('?')[0]} expected ${expect}, got ${response.status}: ${typeof data === 'object' ? JSON.stringify(data) : content.slice(0, 200)}`);
  return { data, response, content };
}
const api = (room, action) => `/api/rooms/${room.room.id}/${action}`;
async function create(title) {
  const { data } = await req('/api/rooms', { method: 'POST', body: { title, agenda: 'Synthetic acceptance checks only', hostName: '验收主持人' }, expect: 201 });
  rooms.push(data); return data;
}
async function post(room, token, text, extra = {}) {
  return req(api(room, 'messages'), { method: 'POST', token, body: { text, kind: 'message', clientId: crypto.randomUUID(), ...extra }, expect: 201 });
}
function nextSocketChange(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('WebSocket broadcast timeout')); }, 7000);
    const handler = event => {
      const value = JSON.parse(String(event.data));
      if (value.type === 'changed') { clearTimeout(timer); off(); resolve(value); }
    };
    const off = () => ws.removeEventListener('message', handler);
    ws.addEventListener('message', handler);
  });
}

try {
  await run('health and security headers', async () => {
    const { data, response } = await req('/api/health'); assert.equal(data.ok, true);
    assert.match(response.headers.get('Content-Security-Policy'), /script-src 'self'/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const { content } = await req('/'); assert.match(content, /AgentBell Meet/);
    await req('/__proto__', { expect: 404 });
  });
  let a, b, one, two;
  await run('create room and two independent HTTP agents', async () => {
    a = await create(`自动验收 ${new Date().toISOString()}`);
    b = await create('隔离验收');
    assert.equal(a.token, a.hostToken); assert.notEqual(a.hostToken, a.inviteToken);
    one = (await req(api(a, 'join'), { method: 'POST', body: { inviteToken: a.inviteToken, name: '验收 Agent A', role: 'HTTP test', kind: 'agent' }, expect: 201 })).data;
    two = (await req(api(a, 'join'), { method: 'POST', body: { inviteToken: a.inviteToken, name: '验收 Agent B', role: 'HTTP test', kind: 'agent' }, expect: 201 })).data;
    assert.notEqual(one.token, two.token);
    await post(a, one.token, 'A 收到会议内容。'); await post(a, two.token, 'B 已加入同一会议。');
    const { data } = await req(api(a, 'state'), { token: a.hostToken });
    assert.equal(data.participants.length, 3); assert.equal(data.messages.length, 2);
    assert.equal(data.room.hostId, a.participant.id);
  });
  await run('room isolation and role authorization', async () => {
    await req(api(a, 'state'), { expect: 401 });
    await req(api(a, 'state'), { token: b.hostToken, expect: 401 });
    await req(api(a, 'state'), { token: a.inviteToken, expect: 401 });
    await req(api(a, 'control'), { method: 'POST', token: one.token, body: { action: 'end' }, expect: 403 });
    await req(api(a, 'messages'), { method: 'POST', token: one.token, body: { text: 'forbidden', kind: 'decision' }, expect: 403 });
    await req(api(a, 'messages'), { method: 'POST', token: one.token, body: { text: 'forbidden', bridgeSource: '主持人' }, expect: 403 });
    const { data } = await post(a, one.token, 'Identity cannot be overridden', { authorName: '主持人', authorId: a.participant.id });
    assert.equal(data.message.authorId, one.participant.id);
    assert.equal(data.message.authorName, '验收 Agent A');
    await req(api(a, 'control'), { method: 'POST', token: a.hostToken, body: { action: '__proto__' }, expect: 400 });
  });
  await run('retry idempotency and conflict detection', async () => {
    const body = { text: 'This message should occur once', clientId: crypto.randomUUID() };
    const first = await req(api(a, 'messages'), { method: 'POST', token: one.token, body, expect: 201 });
    const again = await req(api(a, 'messages'), { method: 'POST', token: one.token, body });
    assert.equal(first.data.message.seq, again.data.message.seq);
    await req(api(a, 'messages'), { method: 'POST', token: one.token, body: { ...body, text: 'different text' }, expect: 409 });
  });
  await run('concurrent message ordering and cursor pagination', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => post(a, i % 2 ? one.token : two.token, `Concurrent ${i}`)));
    const seen = []; let after = 0; let hasMore = true;
    while (hasMore) {
      const { data } = await req(api(a, `messages?after=${after}&limit=3`), { token: two.token });
      seen.push(...data.messages.map(m => m.seq)); after = data.cursor; hasMore = data.hasMore;
    }
    assert.equal(seen.length, 12); assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen, [...seen].sort((x, y) => x - y));
  });
  await run('WebSocket change notification and single-use tickets', async () => {
    const { data } = await req(api(a, 'ticket'), { method: 'POST', token: a.hostToken, body: {} });
    if (remote) {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
      socket = new WebSocket(origin.replace(/^http/, 'ws') + api(a, `ws?ticket=${data.ticket}`), {
        origin, handshakeTimeout: 15000, ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {})
      });
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    } else {
      const response = await dispatch(origin + api(a, `ws?ticket=${data.ticket}`), { headers: { Upgrade: 'websocket', Origin: origin } });
      assert.equal(response.status, 101); socket = response.webSocket; socket.accept();
    }
    // Ignore the initial sync frame. Wait for a known subsequent message cursor.
    const startCursor = (await req(api(a, 'state'), { token: one.token })).data.cursor;
    const notify = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No WebSocket notification for posted message')), 7000);
      const onMessage = e => { const event = JSON.parse(String(e.data)); if (event.type === 'changed' && event.cursor > startCursor) { clearTimeout(timer); socket.removeEventListener('message', onMessage); resolve(event); } };
      socket.addEventListener('message', onMessage);
    });
    await post(a, one.token, 'Broadcast over a real WebSocket'); await notify;
    if (!remote) {
      const reused = await dispatch(origin + api(a, `ws?ticket=${data.ticket}`), { headers: { Upgrade: 'websocket', Origin: origin } });
      assert.equal(reused.status, 401); await reused.text();
    }
    socket.close(1000, 'Acceptance complete'); socket = null;
  });
  await run('host controls, manual bridge, decisions, and tasks', async () => {
    await req(api(a, 'control'), { method: 'POST', token: a.hostToken, body: { action: 'pause' } });
    await req(api(a, 'messages'), { method: 'POST', token: one.token, body: { text: 'not allowed' }, expect: 409 });
    await post(a, a.hostToken, '批准今晚试用会议工具。', { kind: 'decision' });
    await post(a, a.hostToken, '负责人：总管；下一步：接入 HTTP 会议；验收：真实发言。', { kind: 'task' });
    await req(api(a, 'control'), { method: 'POST', token: a.hostToken, body: { action: 'resume' } });
    const { data } = await post(a, a.hostToken, '这是一条用于验收的人工转录。', { bridgeSource: '人工桥接测试' });
    assert.equal(data.message.authorId, a.participant.id);
    assert.equal(data.message.bridgeSource, '人工桥接测试');
    const { data: state } = await req(api(a, 'state'), { token: two.token });
    assert.equal(state.decisions.length, 1); assert.equal(state.tasks.length, 1);
  });
  await run('invite rotation and secret-free complete exports', async () => {
    const { data } = await req(api(a, 'invite'), { method: 'POST', token: a.hostToken, body: { action: 'rotate' } });
    await req(api(a, 'join'), { method: 'POST', body: { inviteToken: a.inviteToken, name: 'Old invitation' }, expect: 403 });
    assert.notEqual(data.inviteToken, a.inviteToken);
    const md = await req(api(a, 'transcript?format=markdown'), { token: one.token });
    const exported = await req(api(a, 'transcript?format=json'), { token: one.token });
    assert.match(md.content, /## 决议/); assert.match(md.content, /## 待办/); assert.match(md.content, /人工代转来源/);
    assert.equal(exported.data.messages.length, 16);
    const state = await req(api(a, 'state'), { token: a.hostToken });
    for (const token of [a.hostToken, a.inviteToken, one.token, two.token, data.inviteToken]) {
      for (const value of [md.content, exported.content, state.content]) assert.equal(value.includes(token), false);
    }
  });
  await run('CSRF, malformed input, and message size limits', async () => {
    await req(api(a, 'state'), { token: a.hostToken, headers: { Origin: 'https://untrusted.example' }, expect: 403 });
    await req(api(a, 'messages'), { method: 'POST', token: a.hostToken, body: { text: 'x'.repeat(8001) }, expect: 400 });
    await req(api(a, 'messages'), { method: 'POST', token: a.hostToken, body: { text: 'x'.repeat(66000) }, expect: 413 });
    await req(api(a, 'messages?after=-1'), { token: a.hostToken, expect: 400 });
  });
  if (!remote) await run('storage survives a real workerd restart', async () => {
    const before = (await req(api(a, 'state'), { token: a.hostToken })).data;
    await mf.dispose(); mf = makeRuntime(); await mf.ready;
    const after = (await req(api(a, 'state'), { token: a.hostToken })).data;
    assert.equal(after.cursor, before.cursor); assert.deepEqual(after.messages, before.messages);
    assert.equal(after.access, 'host');
  });
  await run('ended rooms remain readable and reject new messages', async () => {
    await req(api(a, 'control'), { method: 'POST', token: a.hostToken, body: { action: 'end' } });
    await req(api(a, 'messages'), { method: 'POST', token: two.token, body: { text: 'not allowed' }, expect: 409 });
    assert.equal((await req(api(a, 'state'), { token: one.token })).data.room.status, 'ended');
    await req(api(a, 'transcript?format=markdown'), { token: two.token });
  });
  console.log(JSON.stringify({ passed: checks.length, target: remote || 'local workerd', checks }));
} finally {
  if (socket) { try { socket.close(1000, 'Test finished'); } catch {} }
  for (const room of rooms) {
    try { await req(api(room, 'control'), { method: 'POST', token: room.hostToken, body: { action: 'end' } }); } catch {}
  }
  if (mf) await mf.dispose();
  if (persist) await rm(persist, { recursive: true, force: true });
}
