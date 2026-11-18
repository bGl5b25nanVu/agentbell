import { DurableObject } from 'cloudflare:workers';

export const VERSION = '0.1.0';
const MAX_BODY_BYTES = 65_536;
const MAX_MESSAGES = 5_000;
const MAX_MEMBERS = 100;
// Keep headroom for JSON escaping, UTF-16 strings and duplicated decision/task
// sections while constructing complete exports inside a 128 MiB Worker isolate.
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

export function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export function errorResponse(error) {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status,
      error.status === 429 ? { 'Retry-After': '60' } : {});
  }
  // Do not log request URLs, bodies, tokens, or exception messages.
  console.error(JSON.stringify({ event: 'request_failed', kind: error?.name || 'Error' }));
  return json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' } }, 500);
}

export async function readJson(request) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED', '请使用 application/json 请求。');
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过长。');
  }
  if (!request.body) throw new HttpError(400, 'INVALID_JSON', '缺少 JSON 请求内容。');
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过长。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'JSON 格式不正确。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_JSON', '请求内容必须是 JSON 对象。');
  }
  return value;
}

export function textField(value, name, maximum, fallback) {
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_FIELD', `${name}必须是文字。`);
  const normalized = value.trim();
  if ((!normalized && fallback === undefined) || normalized.length > maximum) {
    throw new HttpError(400, 'INVALID_FIELD', `${name}不能为空，且不能超过 ${maximum} 个字符。`);
  }
  return normalized || (fallback !== undefined ? fallback : normalized);
}

export function secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

function asParticipant(row, online = false) {
  return {
    id: row.id, name: row.name, role: row.role, kind: row.kind,
    createdAt: row.created_at, lastSeenAt: row.last_seen_at, online,
  };
}

function asMessage(row) {
  const value = {
    id: row.id, seq: row.seq, authorId: row.author_id, authorName: row.author_name,
    authorKind: row.author_kind, text: row.text, kind: row.kind, createdAt: row.created_at,
  };
  if (row.bridge_source) value.bridgeSource = row.bridge_source;
  return value;
}

function markdownPlain(value) {
  return String(value).replace(/([\\`*_{}\[\]<>#+.!|~-])/g, '\\$1');
}

export class MeetingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Synchronous SQL initialization finishes before this object handles requests.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, is_host INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      author_id TEXT NOT NULL, author_name TEXT NOT NULL, author_kind TEXT NOT NULL,
      text TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL,
      bridge_source TEXT, client_id TEXT, UNIQUE(author_id, client_id)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
      ticket_hash TEXT PRIMARY KEY, participant_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
    )`);
  }

  one(query, ...args) { return this.sql.exec(query, ...args).toArray()[0]; }
  all(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  meta(key) {
    const row = this.one('SELECT value FROM metadata WHERE key = ?', key);
    return row ? JSON.parse(row.value) : null;
  }
  setMeta(key, value) {
    this.sql.exec('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }
  room() {
    const value = this.meta('room');
    if (!value) throw new HttpError(404, 'ROOM_NOT_FOUND', '会议不存在，请检查邀请链接。');
    return value;
  }
  cursor() { return this.one('SELECT COALESCE(MAX(seq), 0) AS cursor FROM messages').cursor; }

  rateLimit(key, max = 40, duration = 60_000) {
    const now = Date.now();
    const old = this.one('SELECT * FROM rate_limits WHERE key = ?', key);
    if (old && now - old.window_start < duration) {
      if (old.count >= max) throw new HttpError(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试。');
      this.sql.exec('UPDATE rate_limits SET count = count + 1 WHERE key = ?', key);
    } else {
      this.sql.exec('INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)', key, now);
    }
  }

  async authenticate(request) {
    const authorization = request.headers.get('Authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!TOKEN_PATTERN.test(token)) throw new HttpError(401, 'AUTH_REQUIRED', '请使用会议邀请加入，或恢复主持人链接。');
    const hash = await digest(token);
    const member = this.one('SELECT * FROM participants WHERE token_hash = ?', hash);
    if (!member) throw new HttpError(401, 'INVALID_TOKEN', '会议凭证无效，请重新加入。');
    const now = new Date().toISOString();
    if (Date.now() - Date.parse(member.last_seen_at) > 10_000) {
      this.sql.exec('UPDATE participants SET last_seen_at = ? WHERE id = ?', now, member.id);
      member.last_seen_at = now;
    }
    return member;
  }

  requireHost(member) {
    if (!member.is_host) throw new HttpError(403, 'HOST_REQUIRED', '只有主持人可以执行这项操作。');
  }

  notify() {
    const payload = JSON.stringify({ type: 'changed', cursor: this.cursor() });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(payload); } catch { try { socket.close(1011, 'Reconnect'); } catch {} }
    }
  }

  async create(data) {
    const title = textField(data.title, '会议主题', 160);
    const agenda = textField(data.agenda, '议程', 8_000, '');
    const hostName = textField(data.hostName, '主持人名称', 80, '主持人');
    if (typeof data.id !== 'string' || !/^[a-f0-9]{32}$/.test(data.id)) throw new HttpError(400, 'INVALID_ROOM', '会议编号不正确。');
    const hostToken = secret();
    const inviteToken = secret();
    const [hostHash, inviteHash] = await Promise.all([digest(hostToken), digest(inviteToken)]);
    const now = new Date().toISOString();
    const member = { id: crypto.randomUUID(), name: hostName, role: '主持人', kind: 'human', created_at: now, last_seen_at: now };
    const room = { id: data.id, title, agenda, hostId: member.id, status: 'active', createdAt: now, updatedAt: now };
    this.ctx.storage.transactionSync(() => {
      if (this.meta('room')) throw new HttpError(409, 'ROOM_EXISTS', '会议已创建。');
      this.setMeta('room', room);
      this.setMeta('invite_hash', inviteHash);
      this.sql.exec('INSERT INTO participants (id, name, role, kind, token_hash, is_host, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        member.id, member.name, member.role, member.kind, hostHash, now, now);
    });
    return json({ room, hostToken, inviteToken, token: hostToken, participant: asParticipant(member, true) }, 201);
  }

  async join(data) {
    this.room();
    const inviteToken = data.inviteToken;
    if (typeof inviteToken !== 'string' || !TOKEN_PATTERN.test(inviteToken)) throw new HttpError(403, 'INVALID_INVITE', '邀请凭证无效，请向主持人获取新邀请。');
    const name = textField(data.name, '参会名称', 80);
    const role = textField(data.role, '参会角色', 120, '参会者');
    const kind = data.kind ?? 'human';
    if (!['human', 'agent', 'bridge'].includes(kind)) throw new HttpError(400, 'INVALID_KIND', '参会类型必须为 human、agent 或 bridge。');
    const token = secret();
    const [inviteHash, tokenHash] = await Promise.all([digest(inviteToken), digest(token)]);
    const now = new Date().toISOString();
    const member = { id: crypto.randomUUID(), name, role, kind, created_at: now, last_seen_at: now };
    this.ctx.storage.transactionSync(() => {
      const room = this.room();
      if (!sameHash(inviteHash, this.meta('invite_hash'))) throw new HttpError(403, 'INVALID_INVITE', '邀请凭证无效，请向主持人获取新邀请。');
      if (room.status === 'ended') throw new HttpError(409, 'ROOM_ENDED', '会议已经结束，请等待主持人重新开启。');
      this.rateLimit('join', 30);
      if (this.one('SELECT COUNT(*) AS count FROM participants').count >= MAX_MEMBERS) throw new HttpError(409, 'ROOM_FULL', '会议已达到 100 位参会者上限。');
      this.sql.exec('INSERT INTO participants (id, name, role, kind, token_hash, is_host, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
        member.id, name, role, kind, tokenHash, now, now);
      this.setMeta('room', { ...room, updatedAt: now });
    });
    this.notify();
    return json({ token, participant: asParticipant(member, true), room: this.room() }, 201);
  }

  state(member) {
    const room = this.room();
    const sockets = new Set(this.ctx.getWebSockets().map((socket) => socket.deserializeAttachment()?.participantId));
    const participants = this.all('SELECT * FROM participants ORDER BY is_host DESC, created_at ASC').map((row) =>
      asParticipant(row, sockets.has(row.id) || Date.now() - Date.parse(row.last_seen_at) < 90_000));
    const messages = this.all('SELECT * FROM messages ORDER BY seq DESC LIMIT 200').reverse().map(asMessage);
    const decisions = this.all("SELECT * FROM messages WHERE kind = 'decision' ORDER BY seq ASC").map(asMessage);
    const tasks = this.all("SELECT * FROM messages WHERE kind = 'task' ORDER BY seq ASC").map(asMessage);
    return json({ room, participants, messages, decisions, tasks, cursor: this.cursor(), access: member.is_host ? 'host' : 'participant', selfId: member.id });
  }

  messages(url) {
    const rawAfter = url.searchParams.get('after') ?? '0';
    const rawLimit = url.searchParams.get('limit') ?? '100';
    if (!/^\d{1,12}$/.test(rawAfter) || !/^\d{1,3}$/.test(rawLimit)) throw new HttpError(400, 'INVALID_CURSOR', '分页参数不正确。');
    const after = Number(rawAfter);
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 200) throw new HttpError(400, 'INVALID_LIMIT', '每页消息数量应为 1 至 200。');
    const rows = this.all('SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?', after, limit + 1);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(asMessage);
    return json({ messages, cursor: messages.at(-1)?.seq ?? after, hasMore, room: this.room() });
  }

  postMessage(member, data) {
    const text = textField(data.text, '发言', 8_000);
    const kind = data.kind ?? 'message';
    if (!['message', 'decision', 'task'].includes(kind)) throw new HttpError(400, 'INVALID_KIND', '消息类型不正确。');
    if (kind !== 'message') this.requireHost(member);
    const clientId = data.clientId == null ? null : textField(data.clientId, '消息去重编号', 100);
    let bridgeSource = null;
    if (data.bridgeSource != null && data.bridgeSource !== '') {
      this.requireHost(member);
      bridgeSource = textField(data.bridgeSource, '代转来源', 80);
    }
    let message;
    let repeated = false;
    this.ctx.storage.transactionSync(() => {
      if (clientId) {
        const previous = this.one('SELECT * FROM messages WHERE author_id = ? AND client_id = ?', member.id, clientId);
        if (previous) {
          if (previous.text !== text || previous.kind !== kind || (previous.bridge_source || null) !== bridgeSource) {
            throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '此消息编号已经用于其他内容，请创建新的消息编号。');
          }
          message = asMessage(previous); repeated = true; return;
        }
      }
      const room = this.room();
      if (room.status !== 'active' && !(member.is_host && kind !== 'message')) {
        throw new HttpError(409, room.status === 'ended' ? 'ROOM_ENDED' : 'ROOM_PAUSED', room.status === 'ended' ? '会议已结束，暂不能发言。' : '会议已暂停，请等待主持人继续。');
      }
      this.rateLimit(`message:${member.id}`);
      if (this.one('SELECT COUNT(*) AS count FROM messages').count >= MAX_MESSAGES) throw new HttpError(409, 'MESSAGE_LIMIT', '会议已达到 5000 条消息上限，请导出后创建新会议。');
      const storedBytes = this.one('SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS bytes FROM messages').bytes;
      if (storedBytes + new TextEncoder().encode(text).byteLength > MAX_TRANSCRIPT_BYTES) throw new HttpError(409, 'TRANSCRIPT_LIMIT', '会议记录已达到 2 MiB 上限，请导出后创建新会议。');
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      this.sql.exec('INSERT INTO messages (id, author_id, author_name, author_kind, text, kind, created_at, bridge_source, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, member.id, member.name, member.kind, text, kind, now, bridgeSource, clientId);
      message = asMessage(this.one('SELECT * FROM messages WHERE id = ?', id));
      this.setMeta('room', { ...room, updatedAt: now });
    });
    if (!repeated) this.notify();
    return json({ message, repeated }, repeated ? 200 : 201);
  }

  control(member, data) {
    this.requireHost(member);
    const actions = { pause: 'paused', resume: 'active', end: 'ended', reopen: 'active' };
    if (typeof data.action !== 'string' || !Object.hasOwn(actions, data.action)) throw new HttpError(400, 'INVALID_ACTION', '不支持的会议操作。');
    const next = actions[data.action];
    const room = this.room();
    if (room.status === 'ended' && data.action === 'resume') throw new HttpError(409, 'USE_REOPEN', '已结束的会议需要使用重新开启。');
    this.rateLimit(`control:${member.id}`, 30);
    const updated = { ...room, status: next, updatedAt: new Date().toISOString() };
    this.setMeta('room', updated);
    this.notify();
    return json({ room: updated });
  }

  async rotateInvite(member, data) {
    this.requireHost(member);
    if (data.action !== 'rotate') throw new HttpError(400, 'INVALID_ACTION', '不支持的邀请操作。');
    this.rateLimit(`invite:${member.id}`, 10);
    const inviteToken = secret();
    const hash = await digest(inviteToken);
    this.setMeta('invite_hash', hash);
    return json({ inviteToken });
  }

  async ticket(member) {
    this.rateLimit(`ticket:${member.id}`, 20);
    const ticket = secret();
    const hash = await digest(ticket);
    const now = Date.now();
    this.sql.exec('DELETE FROM tickets WHERE expires_at < ?', now);
    this.sql.exec('INSERT INTO tickets (ticket_hash, participant_id, expires_at) VALUES (?, ?, ?)', hash, member.id, now + 30_000);
    return json({ ticket, expiresIn: 30 });
  }

  async websocket(request, url) {
    const token = url.searchParams.get('ticket') || '';
    if (!TOKEN_PATTERN.test(token)) throw new HttpError(401, 'INVALID_TICKET', '实时连接凭证无效。');
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'WEBSOCKET_REQUIRED', '请使用 WebSocket 连接。');
    const origin = request.headers.get('Origin');
    if (!origin || origin !== request.headers.get('X-Meet-Origin')) throw new HttpError(403, 'ORIGIN_FORBIDDEN', '实时连接来源不匹配。');
    const hash = await digest(token);
    let record;
    this.ctx.storage.transactionSync(() => {
      record = this.one('SELECT * FROM tickets WHERE ticket_hash = ?', hash);
      if (!record || record.expires_at <= Date.now()) throw new HttpError(401, 'INVALID_TICKET', '实时连接凭证已使用或过期。');
      this.sql.exec('DELETE FROM tickets WHERE ticket_hash = ?', hash);
    });
    if (this.ctx.getWebSockets().length >= 300 || this.ctx.getWebSockets(record.participant_id).length >= 5) {
      throw new HttpError(429, 'SOCKET_LIMIT', '实时连接过多，请关闭重复页面后重试。');
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [record.participant_id]);
    server.serializeAttachment({ participantId: record.participant_id });
    server.send(JSON.stringify({ type: 'changed', cursor: this.cursor() }));
    this.notify();
    return new Response(null, { status: 101, webSocket: client });
  }

  transcript(url) {
    const room = this.room();
    const messages = this.all('SELECT * FROM messages ORDER BY seq ASC').map(asMessage);
    const participants = this.all('SELECT * FROM participants ORDER BY is_host DESC, created_at ASC').map((row) => asParticipant(row));
    const decisions = messages.filter((message) => message.kind === 'decision');
    const tasks = messages.filter((message) => message.kind === 'task');
    const filename = `agentbell-meet-${room.id}`;
    const format = url.searchParams.get('format') ?? 'markdown';
    if (format === 'json') return json({ room, participants, messages, decisions, tasks }, 200, {
      'Content-Disposition': `attachment; filename="${filename}.json"`,
    });
    if (format !== 'markdown') throw new HttpError(400, 'INVALID_FORMAT', '导出格式必须为 markdown 或 json。');
    const lines = [
      `# ${markdownPlain(room.title)}`, '',
      `会议编号：${room.id}`, `创建时间：${room.createdAt}`, `会议状态：${room.status}`, '',
      '## 议程', '', markdownPlain(room.agenda || '未设置议程'), '',
      '## 参会者', '',
      ...participants.map((p) => `- ${markdownPlain(p.name)} · ${markdownPlain(p.role)} · ${p.kind}`), '',
      '## 决议', '',
      ...(decisions.length ? decisions.map((m) => `- ${markdownPlain(m.text)}`) : ['暂无记录']), '',
      '## 待办', '',
      ...(tasks.length ? tasks.map((m) => `- [ ] ${markdownPlain(m.text)}`) : ['暂无记录']), '',
      '## 完整讨论', '',
    ];
    for (const m of messages) {
      lines.push(`### ${m.seq}. ${markdownPlain(m.authorName)} · ${m.createdAt}`, '');
      if (m.bridgeSource) lines.push(`人工代转来源：${markdownPlain(m.bridgeSource)}；操作者：${markdownPlain(m.authorName)}`, '');
      if (m.kind !== 'message') lines.push(`类型：${m.kind === 'decision' ? '决议' : '待办'}`, '');
      lines.push(markdownPlain(m.text), '');
    }
    lines.push('---', '由 AgentBell Meet 导出。agent / bridge 类型由参会者声明，不代表平台身份认证；人工代转内容已单独标注。', '');
    return new Response(lines.join('\n'), { headers: {
      ...securityHeaders, 'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.md"`,
    } });
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/internal/limit' && request.method === 'POST') {
        this.rateLimit('create', 10, 3_600_000);
        return json({ allowed: true });
      }
      if (url.pathname === '/internal/create' && request.method === 'POST') return await this.create(await readJson(request));
      this.room();
      if (url.pathname === '/join' && request.method === 'POST') return await this.join(await readJson(request));
      if (url.pathname === '/ws' && request.method === 'GET') return await this.websocket(request, url);
      const member = await this.authenticate(request);
      if (request.method === 'GET') {
        if (url.pathname === '/state') return this.state(member);
        if (url.pathname === '/messages') return this.messages(url);
        if (url.pathname === '/transcript') return this.transcript(url);
      }
      if (request.method === 'POST') {
        if (url.pathname === '/ticket') { await readJson(request); return await this.ticket(member); }
        const data = await readJson(request);
        if (url.pathname === '/messages') return this.postMessage(member, data);
        if (url.pathname === '/control') return this.control(member, data);
        if (url.pathname === '/invite') return await this.rotateInvite(member, data);
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) { return errorResponse(error); }
  }

  webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 100) {
      socket.close(1009, 'Notification channel only'); return;
    }
    if (message === 'ping' || message === '{"type":"ping"}') {
      const memberId = socket.deserializeAttachment()?.participantId;
      if (memberId) {
        const row = this.one('SELECT last_seen_at FROM participants WHERE id = ?', memberId);
        if (row && Date.now() - Date.parse(row.last_seen_at) > 10_000) {
          this.sql.exec('UPDATE participants SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), memberId);
        }
      }
      socket.send(JSON.stringify({ type: 'pong' }));
    }
  }

  webSocketClose(socket, code, reason) {
    try { socket.close(code, reason); } catch {}
    this.notify();
  }

  webSocketError(socket) {
    try { socket.close(1011, 'Reconnect'); } catch {}
  }
}
