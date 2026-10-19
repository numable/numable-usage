// 从 tgz 安装到带空格、中文和单引号的临时目录，验证包不依赖源码目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

if (process.platform === 'win32') throw new Error('本验收脚本使用 POSIX 安装前缀；Windows 需运行单独的原生验收');
const source = fileURLToPath(new URL('../../codex/', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--archive')) {
  throw new Error('用法：verify-codex-package.mjs [--archive 本机归档路径]');
}
const suppliedArchive = args.length ? fs.realpathSync(path.resolve(args[1])) : null;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex 安装验收 ' "));
const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
const command = (binary, args, options = {}) => {
  const result = spawnSync(binary, args, { env, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `安装包验收命令失败：${path.basename(binary)} ${result.stderr?.slice(-800)}`);
  return result.stdout.trim();
};
const waitUntil = async (check) => {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > 10000) throw new Error('后台钩子处理超时'); await new Promise((r) => setTimeout(r, 50)); }
};
try {
  const archive = suppliedArchive || path.join(temp, JSON.parse(command('npm', ['pack', source, '--json', '--pack-destination', temp]))[0].filename);
  const expected = ['README.md', 'cli.cjs', 'lib/collect.cjs', 'lib/live.cjs', 'lib/quota.cjs', 'package.json'];
  const entries = command('tar', ['-tzf', archive]).split('\n');
  assert.deepEqual(entries.sort(), expected.map((name) => 'package/' + name).sort());
  for (const name of expected) {
    const file = spawnSync('tar', ['-xOf', archive, 'package/' + name], { env });
    assert.equal(file.status, 0, '读取候选文件失败');
    assert.deepEqual(file.stdout, fs.readFileSync(path.join(source, name)), `候选归档与当前源码不同：${name}`);
  }
  const prefix = path.join(temp, 'installed');
  command('npm', ['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const bin = path.join(prefix, 'bin/numable-codex'), state = path.join(temp, '状态 with space'), home = path.join(temp, 'Codex home');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const timestamp = new Date().toISOString();
  const rows = [
    { type: 'session_meta', payload: { id: 'fixture', source: 'cli', cli_version: '0.163.0', cwd: '/private/SECRET_PROJECT' } },
    { type: 'turn_context', payload: { turn_id: 'turn', model: 'fixture' } },
    { type: 'token_usage_record', payload: { response_id: 'response', turn_id: 'turn', usage: { input_tokens: 100, output_tokens: 20 } } },
  ].map((r) => JSON.stringify({ ...r, timestamp })).join('\n') + '\n';
  fs.writeFileSync(path.join(home, 'sessions', 'fixture.jsonl'), rows);
  const run = (name, args = []) => command(bin, [name, '--state-dir', state, '--home', home, ...args]);
  run('init'); run('collect');
  assert.equal(JSON.parse(run('export')).days[0].total, 120);
  assert.equal(JSON.parse(run('status')).sync, false);
  run('live-on'); run('install');
  const hooks = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json')));
  const hook = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(hook.includes('installed/lib/node_modules/numable-codex-usage/cli.cjs') && !hook.includes(source));
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', hook], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.resume();
    child.once('error', reject); child.once('close', (code) => { try { assert.equal(code, 0); assert.deepEqual(JSON.parse(output), {}); resolve(); } catch (e) { reject(e); } });
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'fixture', turn_id: 'turn', prompt: 'SECRET_PROMPT' }));
  });
  await waitUntil(() => { try { return JSON.parse(fs.readFileSync(path.join(state, 'live.json'))).sessions.length === 1 && !fs.existsSync(path.join(state, 'event-worker.lock')); } catch { return false; } });
  assert.ok(!fs.readFileSync(path.join(state, 'history.json'), 'utf8').includes('SECRET'));
  run('uninstall'); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'))).hooks, {});
  assert.equal(JSON.parse(run('export')).days[0].total, 120);
  command('npm', ['uninstall', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', 'numable-codex-usage']);
  assert.equal(fs.existsSync(bin), false);
  console.log('通过：tgz 六文件、离线全局安装、可执行入口、独立采集、含中文空格单引号路径的钩子命令、脱敏、卸载保留历史；未发布 npm');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
