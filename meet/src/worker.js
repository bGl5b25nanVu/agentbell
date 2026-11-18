import { ASSETS } from './assets.js';
import { HttpError, VERSION, digest, errorResponse, json, readJson, securityHeaders, textField } from './room.js';
export { MeetingRoom } from './room.js';

const ROOM_ID = '[a-f0-9]{32}';
const ROOM_ROUTE = new RegExp(`^/api/rooms/(${ROOM_ID})/(join|state|messages|control|invite|ticket|ws|transcript)$`);

function checkOrigin(request, origin) {
  const supplied = request.headers.get('Origin');
  if (supplied && supplied !== origin) throw new HttpError(403, 'ORIGIN_FORBIDDEN', '请求来源不匹配。');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'ORIGIN_FORBIDDEN', '请在会议网站内执行此操作。');
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'agentbell-meet', version: VERSION });
      if (url.pathname.startsWith('/api/')) {
        checkOrigin(request, url.origin);
        if (url.pathname === '/api/rooms' && request.method === 'POST') {
          const data = await readJson(request);
          // Validate before allocating or incrementing limits for a new room.
          const title = textField(data.title, '会议主题', 160);
          const agenda = textField(data.agenda, '议程', 8_000, '');
          const hostName = textField(data.hostName, '主持人名称', 80, '主持人');
          const ip = request.headers.get('CF-Connecting-IP') || 'local';
          const shard = await digest(ip);
          const limiter = env.ROOMS.getByName(`create:${shard}`);
          const limit = await limiter.fetch(new Request('https://room.internal/internal/limit', { method: 'POST' }));
          if (!limit.ok) return limit;
          const id = crypto.randomUUID().replace(/-/g, '');
          const room = env.ROOMS.getByName(`room:${id}`);
          return await room.fetch(new Request('https://room.internal/internal/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, agenda, hostName, id }),
          }));
        }
        const match = url.pathname.match(ROOM_ROUTE);
        if (!match) throw new HttpError(404, 'NOT_FOUND', '接口不存在。');
        const [, id, action] = match;
        if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不正确。');
        const proxyUrl = new URL(`https://room.internal/${action}`);
        proxyUrl.search = url.search;
        const headers = new Headers(request.headers);
        headers.set('X-Meet-Origin', url.origin);
        const internal = new Request(proxyUrl, {
          method: request.method, headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          duplex: 'half',
        });
        return await env.ROOMS.getByName(`room:${id}`).fetch(internal);
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不正确。');
      const page = url.pathname === '/' || url.pathname === '/docs' || new RegExp(`^/r/${ROOM_ID}$`).test(url.pathname);
      const assetPath = page ? '/index.html' : url.pathname;
      if (!Object.hasOwn(ASSETS, assetPath)) throw new HttpError(404, 'NOT_FOUND', '页面不存在。');
      const asset = ASSETS[assetPath];
      return new Response(request.method === 'HEAD' ? null : asset.body, {
        headers: { ...securityHeaders, 'Content-Type': asset.type },
      });
    } catch (error) { return errorResponse(error); }
  },
};
