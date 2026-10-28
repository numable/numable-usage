'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const L = require('../codex/lib/live.cjs');
const C = require('../codex/lib/collect.cjs');
const salt = 'local-test-salt', now = Date.parse('2026-10-19T12:00:00Z');
function context() {
  const store = {};
  const send = (event, off = 0, extra = {}) => {
    const projection = L.sanitizeHook({ hook_event_name: event, session_id: 's1', turn_id: 't1', model: 'gpt-test', ...extra }, salt, {}, now + off);
    L.absorbHook(store, projection); return projection;
  };
  const view = (at = now + 60000) => L.buildLive({ files: {}, liveHooks: store }, { now: at });
  return { store, send, view };
}
test('钩子只保留匿名身份与固定类目，正文、命令、结果和路径不落投影', () => {
  const r = L.sanitizeHook({ hook_event_name: 'PostToolUse', session_id: 'RAW_SESSION', turn_id: 'RAW_TURN', tool_use_id: 'RAW_TOOL',
    cwd: '/private/SECRET_PROJECT', prompt: 'SECRET_PROMPT', last_assistant_message: 'SECRET_REPLY', tool_input: { command: 'SECRET_COMMAND' },
    tool_response: { stdout: 'SECRET_STDOUT', exit_code: 1 }, tool_name: 'Bash' }, salt, {}, now);
  const blob = JSON.stringify(r); assert.ok(!blob.includes('SECRET') && !blob.includes('RAW_') && !blob.includes('/private'));
  assert.equal(r.category, 's'); assert.equal(r.failed, true);
  assert.equal(L.sanitizeHook({ hook_event_name: 'Unknown', session_id: 's' }, salt), null);
});
test('授权等待只有 PostToolUse 才结束，前置事件不伪装为已经批准', () => {
  const { send, view } = context(); send('UserPromptSubmit'); send('PreToolUse', 1000, { tool_use_id: 'tool' }); send('PermissionRequest', 2000);
  send('PreToolUse', 3000, { tool_use_id: 'tool' });
  assert.equal(view().sessions[0].state, 'perm');
  send('PostToolUse', 12000, { tool_use_id: 'tool' });
  const s = view().sessions[0]; assert.equal(s.state, 'running'); assert.equal(s.tools, 1); assert.equal(s.turns[0].perm, 10000);
});
test('工具后置与前置乱序、重复投递都不重复计数', () => {
  const { send, view } = context(); send('UserPromptSubmit');
  send('PostToolUse', 3000, { tool_use_id: 'tool', tool_name: 'apply_patch' });
  send('PreToolUse', 1000, { tool_use_id: 'tool', tool_name: 'apply_patch' });
  send('PostToolUse', 3000, { tool_use_id: 'tool', tool_name: 'apply_patch' });
  assert.equal(view().sessions[0].tools, 1); assert.equal(view().sessions[0].turns[0].seq, 'e1');
});
test('Stop 收轮为等输入，中断与结束保留独立结果，不等同于任务完成', () => {
  const { send, view } = context(); send('UserPromptSubmit'); send('Stop', 10000);
  assert.equal(view().sessions[0].state, 'input'); assert.equal(view().sessions[0].turns[0].end, 'ok');
  send('UserPromptSubmit', 20000, { turn_id: 't2' }); send('Interrupt', 30000, { turn_id: 't2' });
  assert.equal(view().sessions[0].turns[1].end, 'interrupt'); assert.equal(view().sessions[0].changeKind, 'interrupt');
  send('SessionEnd', 40000, { turn_id: 't2' }); assert.equal(view().sessions[0].state, 'ended');
});
test('明确的用户输入工具进入等输入，但开放轮没有被误判完成', () => {
  const { send, view } = context(); send('UserPromptSubmit');
  send('PreToolUse', 1000, { tool_use_id: 'question', tool_name: 'request_user_input' });
  assert.equal(view().sessions[0].state, 'input'); assert.equal(view().sessions[0].turns[0].e, null);
  send('PostToolUse', 5000, { tool_use_id: 'question', tool_name: 'request_user_input' });
  assert.equal(view().sessions[0].state, 'running');
});
test('旧轮的晚到 Stop 不得清掉新轮的授权等待', () => {
  const { send, view } = context(); send('UserPromptSubmit'); send('UserPromptSubmit', 20000, { turn_id: 't2' });
  send('PermissionRequest', 30000, { turn_id: 't2' }); send('Stop', 10000);
  const s = view().sessions[0]; assert.equal(s.state, 'perm'); assert.equal(s.permSince, now + 30000);
});
test('子代理结束不会把主轮标为完成，工具错误只记录明确结构信号', () => {
  const { send, view } = context(); send('UserPromptSubmit'); send('SubagentStart', 1000, { agent_id: 'a' });
  send('SubagentStop', 3000, { agent_id: 'a' });
  send('PostToolUse', 4000, { tool_use_id: 'tool', tool_response: { stdout: 'error in a normal string' } });
  const s = view().sessions[0]; assert.equal(s.state, 'running'); assert.equal(s.turns[0].end, null); assert.equal(s.errors, 0); assert.equal(s.subs.length, 1);
});
test('扫描与上报不替安静会话伪造心跳，旧会话在保留期后消失', () => {
  const { send, view } = context(); send('UserPromptSubmit');
  const s = view(now + 10 * 60e3).sessions[0]; assert.equal(s.beatAt, now);
  assert.equal(view(now + 25 * 3600e3).sessions.length, 0);
});
test('日志结束事件提供轮次结果，token 与同轮累计通知不叠加，非致命错误不收轮', () => {
  const file = C.projection(), at = (n) => new Date(now + n).toISOString();
  const row = (type, payload, n = 0) => C.processRow(file, { type, payload, timestamp: at(n) }, salt, { live: true });
  row('session_meta', { id: 's1', source: 'cli', cli_version: '0.163.0' });
  row('event_msg', { type: 'task_started', turn_id: 't1' });
  row('token_usage_record', { response_id: 'r1', session_id: 's1', turn_id: 't1', usage: { input_tokens: 100, output_tokens: 20 } }, 1000);
  row('event_msg', { type: 'error', message: 'SECRET_PROVIDER_ERROR', retrying: true }, 2000);
  let body = L.buildLive({ files: { f: file } }, { now: now + 3000 }); assert.equal(body.sessions[0].state, 'running');
  row('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'SECRET_REPLY' }, 4000);
  body = L.buildLive({ files: { f: file } }, { now: now + 5000 });
  assert.equal(body.sessions[0].turns[0].out, 20); assert.equal(body.sessions[0].state, 'input');
  assert.ok(!JSON.stringify(file.live).includes('SECRET'));
});
test('目标状态按事件时间更新，清除后不再显示完成，正文不进入本机投影', () => {
  const file = C.projection();
  const row = (type, payload, n = 0) => C.processRow(file, { type, payload, timestamp: new Date(now + n).toISOString() }, salt, { live: true });
  row('session_meta', { id: 's1', source: 'cli' });
  row('event_msg', { type: 'task_started', turn_id: 't1' });
  row('event_msg', { type: 'thread_goal_updated', goal: { status: 'complete', objective: 'SECRET_OBJECTIVE' } }, 3000);
  row('event_msg', { type: 'thread_goal_updated', goal: { status: 'active', objective: 'SECRET_OBJECTIVE' } }, 2000);
  let s = L.buildLive({ files: { f: file } }, { now: now + 4000 }).sessions[0];
  assert.equal(s.goalStatus, 'complete'); assert.equal(s.goalCompleteAt, now + 3000);
  assert.ok(!JSON.stringify(file).includes('SECRET_OBJECTIVE'));
  row('event_msg', { type: 'thread_goal_cleared' }, 5000);
  s = L.buildLive({ files: { f: file } }, { now: now + 6000 }).sessions[0];
  assert.equal(s.goalStatus, undefined);
});
test('实时上传裁旧轮保当前轮，轮次身份不随裁剪改变', () => {
  const store = { sessions: {} };
  for (let s = 0; s < 40; s++) for (let t = 0; t < 60; t++) {
    const at = now - (60 - t) * 1000;
    L.absorbHook(store, L.sanitizeHook({ hook_event_name: 'UserPromptSubmit', session_id: 's' + s, turn_id: `t${s}-${t}` }, salt, {}, at));
    L.absorbHook(store, L.sanitizeHook({ hook_event_name: 'Stop', session_id: 's' + s, turn_id: `t${s}-${t}` }, salt, {}, at + 500));
  }
  const body = L.buildLive({ files: {}, liveHooks: store }, { now });
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 60 * 1024); assert.equal(body.sessions.length, 40);
  assert.ok(body.sessions.some((s) => s.clippedTurns > 0));
  for (const s of body.sessions) { assert.ok(s.turns.length >= 1); assert.match(s.turns.at(-1).id, /^[a-f0-9]{16}$/); assert.equal(s.turns.at(-1).n, 60); }
});

const cli = path.resolve(__dirname, '../codex/cli.cjs');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numable-codex-live-')), home = path.join(dir, 'home'), state = path.join(dir, 'state');
  fs.mkdirSync(home); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const args = (command) => [cli, command, '--home', home, '--state-dir', state];
  const run = (command) => { const r = spawnSync(process.execPath, args(command), { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r; };
  return { dir, home, state, args, run };
}
const until = async (check, timeout = 8000) => { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('等待本机采集超时'); await new Promise((r) => setTimeout(r, 50)); } };
test('并发真实钩子进程先脱敏入队，采集锁忙时不丢事件且不阻塞原会话', async (t) => {
  const { state, args, run } = temp(t); run('init'); run('live-on');
  const { lock } = require('../codex/cli.cjs'), release = lock(path.join(state, 'collect.lock'));
  const hook = (body) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, args('hook'), { stdio: ['pipe', 'pipe', 'pipe'] }); let output = '';
    c.stdout.on('data', (chunk) => output += chunk); c.on('error', reject); c.on('close', (code) => { assert.equal(code, 0); assert.deepEqual(JSON.parse(output), {}); resolve(); }); c.stdin.end(JSON.stringify(body));
  });
  try {
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'RAW_SESSION', turn_id: 'RAW_TURN', prompt: 'SECRET_PROMPT' });
    await Promise.all(Array.from({ length: 20 }, (_, i) => hook({ hook_event_name: 'PostToolUse', session_id: 'RAW_SESSION', turn_id: 'RAW_TURN',
      tool_use_id: `TOOL_${i}`, tool_name: 'Bash', tool_input: { command: 'SECRET_COMMAND' }, tool_response: { stdout: 'SECRET_RESULT' } })));
    const queue = fs.readdirSync(path.join(state, 'events')).filter((f) => f.endsWith('.json'));
    assert.equal(queue.length, 21);
    for (const f of queue) assert.ok(!fs.readFileSync(path.join(state, 'events', f), 'utf8').includes('SECRET'));
  } finally { release(); }
  await until(() => { try { return JSON.parse(fs.readFileSync(path.join(state, 'live.json'))).sessions[0]?.tools === 20; } catch { return false; } });
  assert.ok(!fs.readFileSync(path.join(state, 'history.json'), 'utf8').includes('SECRET'));
  await until(() => !fs.existsSync(path.join(state, 'collect.lock')) && !fs.existsSync(path.join(state, 'event-worker.lock')) && fs.readdirSync(path.join(state, 'events')).length === 0);
});
test('实时默认关，显式打开后可关闭；钩子配置满足中断事件最长三秒', (t) => {
  const { state, home, run } = temp(t); run('init');
  assert.equal(JSON.parse(run('status').stdout).live, false);
  run('live-on'); assert.equal(JSON.parse(run('status').stdout).live, true);
  run('live-off'); assert.deepEqual(JSON.parse(run('live').stdout).sessions, []);
  run('install'); const config = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json')));
  assert.equal(config.hooks.Interrupt[0].hooks[0].timeout, 3); run('uninstall');
});
test('后台启动确认真实进程取得锁，重复启动复用，停止后释放锁', async (t) => {
  const { state, run } = temp(t); run('init'); run('start');
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(state, 'watch.lock'))).pid;
    run('start'); assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'watch.lock'))).pid, pid);
  } finally { run('stop'); await until(() => !fs.existsSync(path.join(state, 'watch.lock'))); }
});
test('一天内的旧轮次仍按响应记录汇总用量，超过一天的记录不再计入', () => {
  const file = C.projection(), at = (n) => new Date(now + n).toISOString();
  const row = (type, payload, n = 0) => C.processRow(file, { type, payload, timestamp: at(n) }, salt, { live: true });
  row('session_meta', { id: 's1', source: 'cli', cli_version: '0.163.0' });
  row('event_msg', { type: 'task_started', turn_id: 't1' });
  row('token_usage_record', { response_id: 'r1', session_id: 's1', turn_id: 't1', usage: { input_tokens: 100, output_tokens: 20 } }, 1000);
  row('event_msg', { type: 'task_complete', turn_id: 't1' }, 2000);
  row('event_msg', { type: 'task_started', turn_id: 't2' }, 20 * 3600e3);
  row('token_usage_record', { response_id: 'r2', session_id: 's1', turn_id: 't2', usage: { input_tokens: 5, output_tokens: 1 } }, 20 * 3600e3 + 1000);
  const turns = (n) => L.buildLive({ files: { f: file } }, { now: now + n }).sessions[0].turns.map((t) => t.out);
  assert.deepEqual(turns(20 * 3600e3 + 2000), [20, 1]);
  assert.deepEqual(turns(24 * 3600e3 + 5000), [0, 1]);
});
