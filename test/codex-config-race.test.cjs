'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const cli = path.resolve(__dirname, '../codex/cli.cjs');

async function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'numable-codex-config-race-'));
  const home = path.join(temp, 'home'), state = path.join(temp, 'state');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true }); fs.mkdirSync(state);
  const requests = [], waiting = [];
  let arrived;
  const firstRequest = new Promise((resolve) => { arrived = resolve; });
  const server = http.createServer((req, res) => {
    req.resume(); requests.push(req.url);
    if (requests.length === 1) waiting.push(() => res.end('{}')); else res.end('{}');
    arrived();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const children = new Set();
  const run = (command, extra = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command, '--state-dir', state, ...extra]);
    children.add(child); let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
    child.once('error', reject);
    child.once('close', (code) => { children.delete(child); code === 0 ? resolve(stdout) : reject(new Error(`${command}: ${stderr}`)); });
  });
  const configFile = path.join(state, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, homes: [home], timezone: 'UTC', projects: false,
    endpoint: `http://127.0.0.1:${server.address().port}`, device: 'abcdef', salt: 'fixture-only',
    sync: true, writeToken: 'fixture-only', quotaAuto: true, lastQuotaAttempt: Date.now(), installed: [] }));
  t.after(async () => {
    for (const child of children) child.kill();
    for (const respond of waiting) respond();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { state, home, run, requests, firstRequest, respond: () => waiting.splice(0).forEach((r) => r()),
    config: () => JSON.parse(fs.readFileSync(configFile)), save: (config) => fs.writeFileSync(configFile, JSON.stringify(config)) };
}

for (const command of ['pause', 'uninstall', 'quota-auto-off']) {
  test(`网络响应晚到不能撤销 ${command}，后续采集沿用当前开关`, { timeout: 10000 }, async (t) => {
    const env = await setup(t);
    if (command === 'uninstall') await env.run('install');
    const collecting = env.run('collect');
    await env.firstRequest; await env.run(command); env.respond(); await collecting;
    const config = env.config();
    if (command === 'quota-auto-off') assert.equal(config.quotaAuto, false);
    else {
      assert.equal(config.sync, false);
      await env.run('collect'); assert.equal(env.requests.length, 1);
    }
    if (command === 'uninstall') {
      assert.deepEqual(config.installed, []);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.home, 'hooks.json'))).hooks, {});
    }
    assert.ok(config.lastCollect > 0); assert.ok(config.lastStatsPush > 0);
    assert.equal(fs.statSync(path.join(env.state, 'config.json')).mode & 0o777, 0o600);
  });
}

test('钩子实时请求在两秒合并等待期间暂停，尚未发出的实时数据取消', { timeout: 10000 }, async (t) => {
  const env = await setup(t);
  env.save({ ...env.config(), live: true, lastLivePush: Date.now() + 500 });
  fs.mkdirSync(path.join(env.state, 'events'));
  fs.writeFileSync(path.join(env.state, 'events', 'pending.json'), JSON.stringify({ scan: true, at: Date.now() }));
  const collecting = env.run('collect', ['--hook-worker']);
  await env.firstRequest; await env.run('pause'); env.respond(); await collecting;
  assert.deepEqual(env.requests, ['/ingest']);
  assert.equal(env.config().sync, false);
  assert.equal(env.config().lastLiveFingerprint, undefined);
  assert.equal(env.config().lastLiveSequence, 1);
  assert.equal(fs.readdirSync(path.join(env.state, 'events')).length, 0);
});
