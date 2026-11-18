import { Miniflare, Log, LogLevel } from 'miniflare';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mf = new Miniflare({
  name: 'agentbell-meet',
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: path.join(root, 'dist/worker.js'),
  modulesRoot: path.join(root, 'dist'),
  // This pinned workerd build supports up to 2026-08-06. Production uses the
  // current date in cloudflare-upload.json and is verified separately.
  compatibilityDate: process.env.MEET_LOCAL_COMPATIBILITY_DATE || '2026-08-06',
  durableObjects: { ROOMS: { className: 'MeetingRoom', useSQLite: true } },
  durableObjectsPersist: path.join(root, '.dev-state'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  cf: false,
  log: new Log(LogLevel.ERROR)
});
console.log(`AgentBell Meet: ${await mf.ready}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await mf.dispose(); process.exit(0); });
