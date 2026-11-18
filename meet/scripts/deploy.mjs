// Reproducible direct API deployment; no credentials are stored in source.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const script = process.env.CLOUDFLARE_WORKER_NAME || 'agentbell-meet';
if (!token || !account) throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID before deployment.');
if (!/^[a-z0-9_-]+$/.test(script) || !/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid account or Worker name.');
const metadata = JSON.parse(await readFile(path.join(root, 'cloudflare-upload.json'), 'utf8'));
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
for (const name of ['worker.js', 'room.js', 'assets.js']) form.append(name, new Blob([await readFile(path.join(root, 'dist', name), 'utf8')], { type: 'application/javascript+module' }), name);
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: form });
const result = await response.json();
if (!response.ok || !result.success) throw new Error(`Cloudflare deployment failed (${response.status}): ${JSON.stringify(result.errors)}`);
console.log(JSON.stringify({ worker: script, version: result.result?.deployment_id || result.result?.version?.id, success: true }));
// Domain binding is separate so a code deploy cannot unexpectedly change DNS.
