'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hookCommand } = require('../codex/cli.cjs');

test('Windows 钩子的外层只含固定启动参数与编码载荷，路径不参与外层展开', () => {
  const command = hookCommand({ platform: 'win32', node: 'C:\\Program Files\\node.exe', cli: "C:\\工具\\a'b.cjs", stateDir: 'C:\\数据\\%PATH% & $(fixture) ` 中文' });
  assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+=*$/);
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("& 'C:\\Program Files\\node.exe' 'C:\\工具\\a''b.cjs' 'hook' '--state-dir' 'C:\\数据\\%PATH% & $(fixture) ` 中文'"));
  assert.ok(!/Invoke-Expression|ExecutionPolicy|Bypass/.test(command + script));
});

const powershell = process.env.NUMABLE_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : null);
test('真实 PowerShell 保留复杂路径、Unicode 标准输入与原生退出码', { skip: !powershell }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "numable 中文 %PATH% & $(fixture) ` ' "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "采集 probe's.cjs"), state = path.join(root, '状态目录');
  fs.writeFileSync(cli, "const fs=require('node:fs');process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8')}));process.exit(Number(process.env.NUMABLE_PROBE_EXIT||0));");
  const command = hookCommand({ platform: 'win32', cli, stateDir: state });
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: '虚构会话' });
  const hosts = [[powershell, command.split(' ').slice(1)]];
  if (process.platform === 'win32') {
    hosts.push([process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]]);
    hosts.push(['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]]);
  }
  for (const [host, args] of hosts) for (const code of [0, 23]) {
    const r = spawnSync(host, args, { input, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NUMABLE_PROBE_EXIT: String(code) } });
    assert.equal(r.status, code, r.stderr || r.error?.message);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { args: ['hook', '--state-dir', state], input });
  }
});

test('PowerShell 命令可驱动真实采集钩子，脱敏后投影落盘', { skip: !powershell }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "numable hook 中文 %PATH% & $(fixture) ` ' "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.resolve(__dirname, '../codex/cli.cjs'), home = path.join(root, 'home'), stateDir = path.join(root, 'state');
  fs.mkdirSync(home);
  for (const cmd of ['init', 'live-on']) {
    const r = spawnSync(process.execPath, [cli, cmd, '--home', home, '--state-dir', stateDir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'fixture', turn_id: 'turn', cwd: root, prompt: 'SECRET_虚构原文' };
  const command = hookCommand({ platform: 'win32', cli, stateDir });
  const r = spawnSync(powershell, command.split(' ').slice(1), { input: JSON.stringify(input), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout.trim()), {});
  const deadline = Date.now() + 10000;
  let live;
  while (Date.now() < deadline) {
    try { live = JSON.parse(fs.readFileSync(path.join(stateDir, 'live.json'))); } catch {}
    if (live?.sessions?.length === 1 && !fs.existsSync(path.join(stateDir, 'event-worker.lock'))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(live?.sessions?.length, 1);
  assert.equal(live.sessions[0].state, 'running');
  for (const file of fs.readdirSync(stateDir).filter((n) => /^(live|history|snapshot).*\.json$/.test(n))) {
    assert.ok(!fs.readFileSync(path.join(stateDir, file), 'utf8').includes('SECRET_'));
  }
});
