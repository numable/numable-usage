// 仅在独立本机服务上模拟两台电脑；所有日志、凭证和配置均为临时夹具。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const endpoint = process.env.CODEX_VERIFY_BASE || 'http://127.0.0.1:8797';
const url = new URL(endpoint);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('只允许独立本机服务');
const cli = fileURLToPath(new URL('../../codex/cli.cjs', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-e2e-'));
const now = Date.now(), timestamp = new Date(now).toISOString();
const machines = ['a', 'b'].map((name) => {
  const root = path.join(temp, name), home = path.join(root, 'home'), state = path.join(root, 'state');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const row = (type, payload) => JSON.stringify({ type, payload, timestamp });
  const file = path.join(home, 'sessions', 'demo.jsonl');
  fs.writeFileSync(file, [row('session_meta', { id: name, source: 'cli', cli_version: '0.163.0', cwd: '/fixture/private' }),
    row('turn_context', { turn_id: name, model: 'demo' }), row('event_msg', { type: 'task_started', turn_id: name }),
    row('token_usage_record', { response_id: name, turn_id: name, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } })].join('\n') + '\n');
  const run = (command, extra = [], input = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command, '--state-dir', state, '--home', home, '--endpoint', endpoint, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', (b) => { stdout += b; }); child.stderr.resume();
    child.once('error', reject); child.once('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`命令失败：${command}`)));
    child.stdin.end(input);
  });
  return { home, state, file, run, config: () => JSON.parse(fs.readFileSync(path.join(state, 'config.json'))) };
});
try {
  const [a, b] = machines;
  for (const [i, machine] of machines.entries()) {
    await machine.run('init');
    // 两个状态目录在同一台验收电脑上，显式赋予虚构设备身份以模拟两台电脑。
    const config = machine.config(); config.device = i ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa';
    fs.writeFileSync(path.join(machine.state, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  }
  await a.run('connect'); const link = await a.run('link'); await b.run('join', [], link);
  assert.equal(a.config().readToken, b.config().readToken);
  const get = async (route) => {
    const response = await fetch(endpoint + route, { headers: { authorization: `Bearer ${a.config().readToken}` } });
    assert.equal(response.status, 200); return response.json();
  };
  await a.run('live-on'); await a.run('collect'); await b.run('collect');
  let merged = (await get('/s?source=codex&lite=1')).merged;
  assert.equal(merged.devices.length, 2); assert.equal(merged.totals.total, 240);
  assert.equal(JSON.parse(await a.run('devices')).filter((d) => d.current).length, 1);
  assert.equal((await get('/live?source=codex')).sessions.length, 1);
  await a.run('live-off'); await a.run('collect');
  assert.equal((await get('/live?source=codex')).sessions.length, 0);
  await a.run('pause');
  fs.appendFileSync(a.file, JSON.stringify({ type: 'token_usage_record', timestamp, payload: { response_id: 'second', turn_id: 'a', usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } } }) + '\n');
  await a.run('collect'); assert.equal((await get('/s?source=codex&lite=1')).merged.totals.total, 240);
  await a.run('resume'); await a.run('collect');
  assert.equal((await get('/s?source=codex&lite=1')).merged.totals.total, 300);
  await b.run('live-on'); await b.run('collect');
  assert.equal((await get('/live?source=codex')).sessions.length, 1);
  const forgotten = JSON.parse(await a.run('forget', ['--device', 'bbbbbbbbbbbb']));
  assert.equal(forgotten.liveRemoved, 1);
  merged = (await get('/s?source=codex&lite=1')).merged;
  assert.equal(merged.devices.length, 1); assert.equal(merged.totals.total, 180);
  assert.equal((await get('/live?source=codex')).sessions.length, 0);
  assert.ok(!(await get('/live?source=codex')).devices.some((d) => d.dev === 'bbbbbbbbbbbb'));
  // 新活动会触发实时上报；无新事件的紧邻 collect 可能按既有一分钟补偿规则跳过实时上传。
  fs.appendFileSync(b.file, JSON.stringify({ type: 'token_usage_record', timestamp: new Date().toISOString(), payload: {
    response_id: 'new-b', turn_id: 'b', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }) + '\n');
  await b.run('collect');
  assert.equal((await get('/s?source=codex&lite=1')).merged.totals.total, 312);
  assert.equal((await get('/live?source=codex')).sessions.length, 1);
  console.log('通过：虚构双机初始化、绑定、加入、统计合并、设备身份、实时关闭清空、暂停恢复、删除另一设备的历史与实时状态、新活动上报恢复；未修改真实配置');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
