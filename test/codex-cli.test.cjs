'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { endpoint, lock } = require('../codex/cli.cjs');
const cli = path.resolve(__dirname, '../codex/cli.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numable-codex-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), state = path.join(dir, 'state');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const run = (cmd, extra = []) => spawnSync(process.execPath, [cli, cmd, '--home', home, '--state-dir', state, ...extra], { encoding: 'utf8' });
  return { dir, home, state, run };
}
test('本机初始化、增量采集、导出和状态不会自动联网，设备身份固定', (t) => {
  const { state, home, run } = setup(t);
  assert.equal(run('init', ['--endpoint', 'http://127.0.0.1:1']).status, 0);
  const before = JSON.parse(fs.readFileSync(path.join(state, 'config.json')));
  assert.equal(before.sync, false);
  const rows = [{ type: 'session_meta', payload: { id: 'main', source: 'cli', cli_version: '0.1.0' } },
    { type: 'token_usage_record', timestamp: new Date().toISOString(), payload: { response_id: 'r1', usage: { input_tokens: 100, output_tokens: 20 } } }];
  fs.writeFileSync(path.join(home, 'sessions', 'a.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const first = run('collect'); assert.equal(first.status, 0, first.stderr);
  const snapshot = JSON.parse(first.stdout); assert.equal(snapshot.days[0].total, 120);
  assert.equal(JSON.parse(run('collect').stdout).collection.rows, 0);
  assert.equal(JSON.parse(run('export').stdout).days[0].total, 120);
  assert.equal(JSON.parse(run('status').stdout).paired, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'config.json'))).device, before.device);
  assert.equal(fs.statSync(path.join(state, 'config.json')).mode & 0o777, 0o600);
});
test('安装钩子幂等、卸载仅移除自己的钩子并保留用户原配置', (t) => {
  const { home, run } = setup(t);
  const own = { hooks: [{ type: 'command', command: 'echo user-hook' }] };
  const original = { description: '用户已有配置', hooks: { Stop: [own] } };
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify(original));
  assert.equal(run('install').status, 0);
  assert.equal(run('install').status, 0);
  const installed = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json')));
  assert.equal(installed.hooks.Stop.length, 2);
  assert.deepEqual(installed.hooks.Stop[0], own);
  assert.equal(run('uninstall').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'))), original);
});
test('拒绝向非回环明文服务发送凭证，拒绝带用户信息的服务地址', () => {
  assert.throws(() => endpoint('http://example.com'), /HTTPS/);
  assert.throws(() => endpoint('https://secret@example.com'), /HTTPS/);
  assert.equal(endpoint('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});
test('同进程采集锁不可重复获取，释放后可再取', (t) => {
  const { state } = setup(t); const p = path.join(state, 'test.lock');
  const unlock = lock(p); assert.throws(() => lock(p), /已有采集/); unlock(); lock(p)();
});
test('未知命令、损坏历史与缺少凭证都明确失败', (t) => {
  const { state, run } = setup(t);
  assert.equal(run('no-such-command').status, 1);
  assert.equal(run('credentials').status, 1);
  run('init'); fs.writeFileSync(path.join(state, 'history.json'), '{bad}');
  assert.equal(run('collect').status, 1);
  assert.equal(run('collect', ['--rebuild']).status, 0);
  assert.ok(fs.readdirSync(state).some((f) => /^history.corrupt-\d+\.json$/.test(f)));
});
