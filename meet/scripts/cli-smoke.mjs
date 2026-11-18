#!/usr/bin/env node
/** Real hosted HTTP ⇄ spawned stdin client smoke check. No model calls. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STEP_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 39_000;
const CLEANUP_TIMEOUT_MS = 3_000;

function parseUrl(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null;
  if (argv.length !== 2 || argv[0] !== '--url') throw new Error('用法：node scripts/cli-smoke.mjs --url https://meet.agentbell.app');
  let url;
  try { url = new URL(argv[1]); } catch { throw new Error('--url 必须是有效 HTTPS 地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--url 必须是 HTTPS 网站根地址，不能包含凭据、路径或查询参数。');
  }
  return url.origin;
}

function delay(ms, signal) {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(new Error('总验收时间已达上限。'));
    const abort = () => { clearTimeout(timer); fail(new Error('总验收时间已达上限。')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function requestJson(baseUrl, path, { token, body, signal, label, timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: bounded,
      redirect: 'error',
    });
  } catch { throw new Error(`${label}：网络失败或超时。`); }
  if (!response.ok) throw new Error(`${label}：HTTP ${response.status}。`);
  try { return await response.json(); } catch { throw new Error(`${label}：响应不是有效 JSON。`); }
}

function observeChild(child) {
  const state = { stdout: '', stderrBytes: 0, exited: false, exitCode: null, exitSignal: null, spawnError: false };
  const exitPromise = new Promise((resolve) => {
    child.once('error', () => { state.spawnError = true; state.exited = true; resolve(state); });
    child.once('close', (code, signal) => {
      state.exited = true;
      state.exitCode = code;
      state.exitSignal = signal;
      resolve(state);
    });
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { state.stdout = (state.stdout + chunk).slice(-64_000); });
  // Never print raw child output: it may contain private meeting content.
  child.stderr.on('data', (chunk) => { state.stderrBytes += chunk.length; });
  child.stdin.on('error', () => {});
  return { state, exitPromise };
}

function waitForOutput(child, state, text, signal, label) {
  return new Promise((done, fail) => {
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.removeListener('data', check);
      child.removeListener('close', check);
      child.removeListener('error', check);
      signal.removeEventListener('abort', aborted);
      if (error) fail(error); else done();
    };
    const check = () => {
      if (state.stdout.includes(text)) return finish();
      if (state.exited) finish(new Error(`${label}：CLI 提前退出。`));
    };
    const aborted = () => finish(new Error(`${label}：总验收时间已达上限。`));
    timer = setTimeout(() => finish(new Error(`${label}：超过 15 秒仍未收到预期输出。`)), STEP_TIMEOUT_MS);
    child.stdout.on('data', check);
    child.on('close', check);
    child.on('error', check);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else check();
  });
}

function waitForExit(exitPromise, signal, timeoutMs, label) {
  return new Promise((done, fail) => {
    const finish = (error, result) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (error) fail(error); else done(result);
    };
    const aborted = () => finish(new Error(`${label}：总验收时间已达上限。`));
    const timer = setTimeout(() => finish(new Error(`${label}：未在限定时间内退出。`)), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    exitPromise.then((result) => finish(null, result));
    if (signal?.aborted) aborted();
  });
}

async function main() {
  const baseUrl = parseUrl(process.argv.slice(2));
  if (!baseUrl) {
    console.log('用法：node scripts/cli-smoke.mjs --url https://meet.agentbell.app\n创建一个合成验收房间，通过真实 CLI 与主持人双向收发，然后结束会议。不会调用模型。');
    return;
  }
  const startedAt = Date.now();
  const run = new AbortController();
  const timeout = setTimeout(() => run.abort(), RUN_TIMEOUT_MS);
  let roomId;
  let hostToken;
  let child;
  let observed;
  let ended = false;
  let failure;
  const passed = [];
  const pass = (name) => { passed.push(name); console.log(`PASS ${name}`); };
  try {
    const created = await requestJson(baseUrl, '/api/rooms', {
      body: { title: 'CLI 双向收发验收（合成测试）', agenda: '只验证真实客户端的加入、消息持久化、双向收发与结束退出。', hostName: 'CLI 验收主持人' },
      signal: run.signal, label: '创建合成测试房间',
    });
    roomId = created.room?.id;
    hostToken = created.hostToken;
    if (!roomId || !hostToken || !created.inviteToken) throw new Error('创建会议响应缺少必要字段。');
    const path = `/api/rooms/${encodeURIComponent(roomId)}`;
    const agentName = `CLI Smoke Agent ${randomUUID().slice(0, 8)}`;
    child = spawn(process.execPath, [fileURLToPath(new URL('../cli/agent.mjs', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MEET_URL: baseUrl, MEET_ROOM: roomId, MEET_INVITE: created.inviteToken, MEET_TOKEN: '',
        AGENT_NAME: agentName, AGENT_ROLE: '合成验收客户端',
        MODEL_BASE_URL: '', API_KEY: '', MODEL_API_KEY: '', MODEL: '',
      },
    });
    observed = observeChild(child);
    await waitForOutput(child, observed.state, '已加入会议：', run.signal, 'CLI 加入');
    pass('真实 CLI 已加入会议');

    const agentMarker = `cli-to-host-${randomUUID()}`;
    child.stdin.write(`${agentMarker}\n`);
    const verifyUntil = Math.min(startedAt + RUN_TIMEOUT_MS, Date.now() + STEP_TIMEOUT_MS);
    let stored;
    while (Date.now() < verifyUntil) {
      if (observed.state.exited) throw new Error('核实 CLI 发言：CLI 提前退出。');
      const state = await requestJson(baseUrl, `${path}/state`, {
        token: hostToken, signal: run.signal, label: '主持人读取 CLI 发言',
        timeoutMs: Math.max(1, Math.min(5_000, verifyUntil - Date.now())),
      });
      stored = state.messages?.find((message) => message.text === agentMarker);
      if (stored) {
        const actor = state.participants?.find((person) => person.id === stored.authorId);
        if (stored.authorKind !== 'agent' || stored.authorName !== agentName || actor?.kind !== 'agent' || actor?.name !== agentName || stored.authorId === state.room?.hostId) {
          throw new Error('核实 CLI 发言：保存的消息身份与真实 CLI 参加者不符。');
        }
        break;
      }
      await delay(250, run.signal);
    }
    if (!stored) throw new Error('核实 CLI 发言：超过 15 秒仍未找到持久化消息。');
    pass('CLI stdin 发言已由服务器真实保存，作者身份为 Agent');

    const hostMarker = `host-to-cli-${randomUUID()}`;
    await requestJson(baseUrl, `${path}/messages`, {
      token: hostToken, body: { text: hostMarker, kind: 'message', clientId: randomUUID() },
      signal: run.signal, label: '主持人发送回传消息',
    });
    await waitForOutput(child, observed.state, hostMarker, run.signal, 'CLI 收到主持人消息');
    pass('主持人消息已被真实 CLI 读取并显示');

    const finished = await requestJson(baseUrl, `${path}/control`, {
      token: hostToken, body: { action: 'end' }, signal: run.signal, label: '主持人结束会议',
    });
    if (finished.room?.status !== 'ended') throw new Error('结束会议响应没有确认 ended 状态。');
    ended = true;
    const exited = await waitForExit(observed.exitPromise, run.signal, STEP_TIMEOUT_MS, 'CLI 自然退出');
    if (exited.spawnError || exited.exitCode !== 0 || exited.exitSignal || !exited.stdout.includes('会议已结束')) throw new Error('CLI 没有以成功状态响应会议结束并自然退出。');
    pass('会议结束后 CLI 自然退出（code 0）');
  } catch (error) {
    // Errors above contain labels and statuses only, never HTTP bodies or credentials.
    failure = error;
  } finally {
    clearTimeout(timeout);
    run.abort();
    if (roomId && hostToken && !ended) {
      try {
        const cleanup = await requestJson(baseUrl, `/api/rooms/${encodeURIComponent(roomId)}/control`, {
          token: hostToken, body: { action: 'end' }, label: '清理测试会议', timeoutMs: CLEANUP_TIMEOUT_MS,
        });
        ended = cleanup.room?.status === 'ended';
        if (!ended) throw new Error('清理测试会议未确认结束。');
      } catch {
        failure ||= new Error('合成测试房间未能确认结束，需要检查部署后清理。');
        console.error('WARN 合成测试房间未能确认结束。');
      }
    }
    if (child && observed && !observed.state.exited) {
      child.kill('SIGTERM');
      try { await waitForExit(observed.exitPromise, null, 500, '停止验收客户端'); }
      catch { child.kill('SIGKILL'); }
    }
    child?.stdin.destroy();
  }
  const report = { ok: !failure, checks: passed.length, roomEnded: ended, durationMs: Date.now() - startedAt, modelCalls: 0 };
  console.log(JSON.stringify(report));
  if (failure) { console.error(`FAIL ${failure.message}`); process.exitCode = 1; }
}

main().catch(() => {
  console.error('FAIL 无法启动 CLI 验收。请使用 --url 提供有效 HTTPS 根地址。');
  process.exitCode = 1;
});
