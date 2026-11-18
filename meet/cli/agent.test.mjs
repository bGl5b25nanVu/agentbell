import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ReplyBudget, shouldRespond, publishMessage, withRetry, retryDelay, redact, validateBaseUrl } from './agent.mjs';

const host = { seq: 5, authorId: 'host-1', authorKind: 'human', kind: 'message', text: '请评估一下这个方案。' };
const identity = { hostId: 'host-1', selfId: 'agent-1', names: ['设计顾问', 'Design API Agent'] };

test('only host questions or explicit exact-name mentions trigger automatic replies', () => {
  assert.equal(shouldRespond(host, identity), true);
  assert.equal(shouldRespond({ ...host, text: '好的，我们继续。' }, identity), false);
  assert.equal(shouldRespond({ ...host, text: '我建议先按原计划做。' }, identity), false);
  assert.equal(shouldRespond({ ...host, text: '今晚能用吗' }, identity), true);
  assert.equal(shouldRespond({ ...host, text: '@设计顾问 说说看。' }, identity), true);
  assert.equal(shouldRespond({ ...host, text: '@Design API Agent: next.' }, identity), true);
  assert.equal(shouldRespond({ ...host, text: '@设计顾问二号 说说看。' }, identity), false);
  assert.equal(shouldRespond({ ...host, authorKind: 'agent', text: '@设计顾问 请回应。' }, identity), false);
  assert.equal(shouldRespond({ ...host, authorId: 'other-human' }, identity), false);
  assert.equal(shouldRespond({ ...host, kind: 'decision' }, identity), false);
  assert.equal(shouldRespond(host, { ...identity, hostId: null }), false);
});

test('reply budget enforces 12 attempts and 15 minute deadline', () => {
  let now = 0;
  const budget = new ReplyBudget({ now: () => now });
  for (let count = 0; count < 12; count += 1) assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  assert.equal(budget.used, 12);
  const timed = new ReplyBudget({ now: () => now });
  now = 15 * 60_000;
  assert.equal(timed.available, false);
  assert.equal(timed.take(), false);
});

test('an uncertain POST retries with one stable clientId and unchanged content', async () => {
  const sent = [];
  const waits = [];
  const result = await publishMessage(async (path, options) => {
    sent.push({ path, body: options.body });
    if (sent.length < 3) throw new ApiError('temporary', { status: 503, retryable: true });
    return { message: { seq: 8 } };
  }, '/api/rooms/room-1/messages', '真实发言', { wait: async (ms) => waits.push(ms), random: () => 0 });
  assert.equal(result.message.seq, 8);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((item) => item.body.clientId)).size, 1);
  assert.equal(sent[0].body.text, '真实发言');
  assert.deepEqual(waits, [1_000, 2_000]);
});

test('permission errors never retry; transient failures stop after two backoff rounds', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new ApiError('forbidden', { status: 403, retryable: true });
  }, { wait: async () => {} }), { status: 403 });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new ApiError('rate limit', { status: 429, retryable: true });
  }, { wait: async () => {} }), { status: 429 });
  assert.equal(calls, 3);
  assert.equal(retryDelay(8, 120_000, () => 0), 30_000);
});

test('URLs cannot send bearer tokens to plaintext remote endpoints or URL credentials', () => {
  assert.equal(validateBaseUrl('https://meet.agentbell.app/', 'URL'), 'https://meet.agentbell.app');
  assert.equal(validateBaseUrl('http://127.0.0.1:8787', 'URL'), 'http://127.0.0.1:8787');
  assert.throws(() => validateBaseUrl('http://example.com', 'URL'));
  assert.throws(() => validateBaseUrl('https://user:secret@example.com', 'URL'));
  assert.throws(() => validateBaseUrl('https://example.com?token=secret', 'URL'));
});

test('terminal output redacts credentials and removes escape control characters', () => {
  assert.equal(redact('令牌 secret-123\u001b[2J', ['secret-123']), '令牌 [已隐藏凭据][2J');
});
