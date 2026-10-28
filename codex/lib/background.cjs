'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { watcher, diagnostic } = require('./diagnostics.cjs');
const { atomicWrite } = require('./collect.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function serviceSpec(dir, { home = os.homedir(), uid = process.getuid?.(), node = process.execPath, cli = path.resolve(__dirname, '../cli.cjs'), envPath = process.env.PATH || '' } = {}) {
  const label = 'app.numable.codex-usage.' + crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12);
  const file = path.join(home, 'Library/LaunchAgents', label + '.plist');
  const escape = value => {
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) throw new Error('启动目录包含不支持的字符');
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  };
  const args = [node, cli, 'watch', '--state-dir', path.resolve(dir), '--quiet'];
  const searchPath = [path.dirname(node), envPath, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a => '<string>' + escape(a) + '</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>ExitTimeOut</key><integer>20</integer><key>ProcessType</key><string>Background</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(searchPath)}</string></dict><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`;
  return { label, file, xml, domain: 'gui/' + uid, target: 'gui/' + uid + '/' + label };
}
function control(args, allowFailure = false) {
  const r = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 25000 });
  if (r.status !== 0 && !allowFailure) throw new Error('系统托管操作未完成，请运行 status 检查后台状态');
  return r.status === 0;
}
function installed(dir) { return process.platform === 'darwin' && fs.existsSync(serviceSpec(dir).file); }
function serviceStatus(dir) {
  const enabled = installed(dir);
  if (!enabled) return { supported: process.platform === 'darwin', enabled: false, loaded: false };
  const r = spawnSync('/bin/launchctl', ['print', serviceSpec(dir).target], { encoding: 'utf8', timeout: 10000 });
  const text = r.stdout || '', number = pattern => { const m = pattern.exec(text); return m ? Number(m[1]) : null; };
  return { supported: true, enabled, loaded: r.status === 0, runs: number(/\bruns = (\d+)/), lastExitCode: number(/last exit code = (\d+)/), lastSignal: number(/last terminating signal = [^\n]*?:?\s(\d+)/) };
}
async function waitRunning(dir) {
  for (let i = 0; i < 100; i++) { const state = watcher(dir); if (state.running && state.heartbeatAt) return state; await delay(100); }
  throw new Error('未能确认后台采集启动，请检查 status 与诊断日志');
}
async function stop(dir) {
  if (installed(dir)) { const spec = serviceSpec(dir); if (control(['print', spec.target], true)) control(['bootout', spec.target]); }
  atomicWrite(path.join(dir, 'stop.json'), { at: Date.now() });
  for (let i = 0; i < 200; i++) { if (!watcher(dir).running) return; await delay(100); }
  throw new Error('后台仍在完成本轮采集，请稍后再次运行 stop');
}
async function managedStart(dir) {
  const spec = serviceSpec(dir);
  if (!control(['print', spec.target], true)) control(['bootstrap', spec.domain, spec.file]);
  control(['kickstart', spec.target]); return waitRunning(dir);
}
async function enable(dir) {
  if (process.platform !== 'darwin') throw new Error('系统托管目前支持 macOS；当前平台请使用 start 或 watch');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || major === 18 && minor < 17) throw new Error('系统托管需要 Node.js 18.17 或以上');
  await stop(dir);
  // 固定本次已验证的运行时，避免启动器或桌面应用更新后原路径消失。
  const runtime = path.join(dir, 'runtime'); fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const node = path.join(runtime, 'node'), staged = node + '.tmp-' + process.pid;
  fs.copyFileSync(process.execPath, staged); fs.chmodSync(staged, 0o700);
  const probe = spawnSync(staged, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (probe.status !== 0 || probe.stdout.trim() !== process.version) { fs.unlinkSync(staged); throw new Error('固定运行时校验失败，系统托管未启用'); }
  fs.renameSync(staged, node);
  const spec = serviceSpec(dir, { node }); fs.mkdirSync(path.dirname(spec.file), { recursive: true });
  const temporary = spec.file + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, spec.xml, { mode: 0o600 }); fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, spec.file);
  await managedStart(dir); diagnostic(dir, 'service_on');
}
async function disable(dir) {
  if (process.platform !== 'darwin') throw new Error('当前平台没有本工具的系统托管配置');
  await stop(dir); const spec = serviceSpec(dir); if (fs.existsSync(spec.file)) fs.unlinkSync(spec.file); diagnostic(dir, 'service_off');
}
module.exports = { serviceSpec, serviceStatus, installed, managedStart, enable, disable, stop, waitRunning };
