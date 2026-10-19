// 使用真实 Codex 协议核对安装定义与信任闸；独立目录，不提交模型请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binary = process.env.NUMABLE_CODEX_BINARY;
if (!binary) throw new Error('请用 NUMABLE_CODEX_BINARY 指定要验收的真实 Codex 可执行文件');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'numable-real-hooks-'));
const home = path.join(temp, 'codex'), state = path.join(temp, 'state'), cwd = path.join(temp, 'workspace');
for (const dir of [home, cwd]) fs.mkdirSync(dir);
const cli = fileURLToPath(new URL('../../codex/cli.cjs', import.meta.url));
const env = { ...process.env, CODEX_HOME: home };
// 不继承调用者的认证环境；测试无需登录或模型请求。
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_ACCESS_TOKEN']) delete env[key];
const run = (command) => {
  const r = spawnSync(process.execPath, [cli, command, '--home', home, '--state-dir', state], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, `${command} 失败：${r.stderr}`);
};
let child, lines;
const pending = new Map(); let sequence = 0;
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
try {
  run('init'); run('live-on'); run('install');
  child = spawn(binary, ['app-server', '--listen', 'stdio://'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const p = pending.get(message.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(message.id);
    message.error ? p.reject(new Error(`${message.error.code}: ${message.error.message}`)) : p.resolve(message.result);
  });
  child.on('error', (e) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); });
  await rpc('initialize', { clientInfo: { name: 'numable_hook_acceptance', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const listed = await rpc('hooks/list', { cwds: [cwd] });
  const entry = listed.data.find((e) => e.cwd === cwd);
  assert.ok(entry, '真实 Codex 必须返回测试工作区的钩子清单');
  assert.deepEqual(entry.errors, [], '安装定义必须能被真实 Codex 解析');
  assert.equal(entry.hooks.length, 11);
  assert.ok(entry.hooks.every((h) => h.trustStatus === 'untrusted' && h.enabled && !h.isManaged));
  const events = entry.hooks.map((h) => h.eventName).sort();
  assert.deepEqual(events, ['interrupt', 'permissionRequest', 'postToolUse', 'preCompact', 'preToolUse', 'sessionEnd', 'sessionStart', 'stop', 'subagentStart', 'subagentStop', 'userPromptSubmit'].sort());
  for (const hook of entry.hooks) {
    assert.equal(hook.timeoutSec, ['interrupt', 'sessionEnd'].includes(hook.eventName) ? 3 : 10, `事件 ${hook.eventName} 的超时不一致`);
    assert.equal(hook.async, hook.eventName !== 'sessionEnd');
  }
  console.log('真实 Codex 已识别 11 条安装钩子；事件、超时、异步定义与未信任状态一致。');
  run('uninstall');
  const removed = await rpc('hooks/list', { cwds: [cwd] });
  assert.equal(removed.data.find((e) => e.cwd === cwd).hooks.length, 0);
  console.log('卸载后真实协议清单为零；未修改真实配置、未绕过信任、未发起模型请求。');
} finally {
  lines?.close(); child?.stdin.end();
  if (child && child.exitCode === null) {
    const timer = setTimeout(() => child.kill(), 1000);
    await new Promise((resolve) => child.once('close', resolve)); clearTimeout(timer);
  }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('验收结束')); }
  fs.rmSync(temp, { recursive: true, force: true });
}
