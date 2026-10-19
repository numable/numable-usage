#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { collect, initialState, atomicWrite, hash } = require('./lib/collect.cjs');
const { readQuota } = require('./lib/quota.cjs');

function parse(args) {
  const out = { command: args[0] || 'status', homes: [] };
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (['--home', '--state-dir', '--timezone', '--endpoint', '--projects', '--codex-binary', '--device'].includes(key)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('选项缺少参数');
      if (key === '--home') out.homes.push(path.resolve(value));
      else out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else if (['--json', '--quiet', '--rebuild'].includes(key)) out[key.slice(2)] = true;
    else throw new Error('无法识别选项，请运行 help 查看用法');
  }
  return out;
}
function paths(args) {
  const dir = path.resolve(args.stateDir || process.env.NUMABLE_CODEX_STATE_DIR || path.join(os.homedir(), '.numable', 'codex-usage'));
  return { dir, config: path.join(dir, 'config.json'), history: path.join(dir, 'history.json'), snapshot: path.join(dir, 'snapshot.json'), lock: path.join(dir, 'collect.lock') };
}
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('本机记录无法读取，请先备份后运行重算'); }
}
function endpoint(value) {
  let url; try { url = new URL(value); } catch { throw new Error('服务地址无效'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('服务地址需要使用 HTTPS，本机调试可使用回环地址');
  }
  return url.origin;
}
function configFor(args, p) {
  const saved = read(p.config, null);
  const homes = args.homes.length ? args.homes : saved?.homes || [path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))];
  const timezone = args.timezone || saved?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new Error('时区无效'); }
  if (args.projects && !['on', 'off'].includes(args.projects)) throw new Error('项目名称选项必须是 on 或 off');
  const projects = args.projects ? args.projects === 'on' : saved?.projects || false;
  const target = endpoint(args.endpoint || saved?.endpoint || process.env.NUMABLE_USAGE_ENDPOINT || 'https://usage.numable.app');
  if (saved?.writeToken && saved.endpoint !== target) throw new Error('已绑定的凭证不能发送到另一个服务，请使用独立状态目录');
  return { version: 1, ...saved, homes, timezone, projects, endpoint: target,
    device: saved?.device || crypto.randomBytes(12).toString('hex'), sync: saved?.sync || false };
}
function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const previous = read(file, {});
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('采集锁无效，请检查本机状态');
      try { process.kill(previous.pid, 0); throw new Error('已有采集正在进行'); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法取得采集锁');
}
async function request(config, route, body, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(config.endpoint + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw new Error(`服务请求失败（${r.status}），请检查连接后重试`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const shellQuote = (s) => process.platform === 'win32' ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, "'\\''")}'`;
function hookDefinitions(p) {
  const command = [process.execPath, __filename, 'hook', '--state-dir', p.dir].map(shellQuote).join(' ');
  return ['SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Interrupt'].map((event) => ({ event,
    group: { hooks: [{ type: 'command', command, ...(event === 'SessionEnd' ? {} : { async: true }), timeout: 10 }] } }));
}
function installHooks(config, p) {
  const installed = [];
  for (const home of config.homes) {
    const file = path.join(home, 'hooks.json'), doc = read(file, {});
    if (doc.hooks && (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks))) throw new Error('已有事件钩子的格式无效，未覆盖原配置');
    doc.hooks ||= {};
    for (const { event, group } of hookDefinitions(p)) {
      const groups = doc.hooks[event] || [];
      if (!Array.isArray(groups)) throw new Error('已有事件钩子的格式无效，未覆盖原配置');
      const serialized = JSON.stringify(group);
      if (!groups.some((g) => JSON.stringify(g) === serialized)) groups.push(group);
      doc.hooks[event] = groups;
      installed.push({ file, event, group });
    }
    atomicWrite(file, doc);
  }
  return installed;
}
function uninstallHooks(config) {
  for (const file of new Set((config.installed || []).map((h) => h.file))) {
    const doc = read(file, null); if (!doc?.hooks) continue;
    for (const h of config.installed.filter((h) => h.file === file)) {
      if (!Array.isArray(doc.hooks[h.event])) continue;
      doc.hooks[h.event] = doc.hooks[h.event].filter((g) => JSON.stringify(g) !== JSON.stringify(h.group));
      if (!doc.hooks[h.event].length) delete doc.hooks[h.event];
    }
    atomicWrite(file, doc);
  }
}
async function scan(args, p, config) {
  const unlock = lock(p.lock);
  try {
    let existing;
    try { existing = read(p.history, null); }
    catch (error) {
      if (!args.rebuild) throw error;
      const backup = path.join(p.dir, `history.corrupt-${Date.now()}.json`);
      fs.copyFileSync(p.history, backup); fs.chmodSync(backup, 0o600);
      existing = null;
    }
    const state = args.rebuild ? { ...initialState(), ...(existing?.salt ? { salt: existing.salt } : {}) } : existing || initialState();
    const r = await collect(config.homes, state, { timezone: config.timezone, projects: config.projects });
    const activeQuota = read(path.join(p.dir, 'quota.json'), null);
    const latestLog = Math.max(0, ...r.snapshot.quotas.map((q) => q.observedAt));
    if (activeQuota?.supported && activeQuota.scope === hash(config.writeToken || state.salt, 'quota-scope') && activeQuota.observedAt >= latestLog) {
      r.snapshot.quotas = activeQuota.quotas;
    }
    if (!config.projects) for (const f of Object.values(r.state.files)) f.projectName = null;
    atomicWrite(p.history, r.state);
    atomicWrite(p.snapshot, { ...r.snapshot, collection: r.stats });
    atomicWrite(p.config, { ...config, lastCollect: r.snapshot.collectedAt });
    if (config.sync && config.writeToken) {
      await request(config, '/ingest', { source: 'codex', device: config.device, snapshot: { ...r.snapshot, collection: r.stats } }, config.writeToken);
    }
    return { ...r.snapshot, collection: r.stats };
  } finally { unlock(); }
}
async function main(argv = process.argv.slice(2)) {
  const args = parse(argv), p = paths(args);
  if (args.command === 'help' || args.command === '--help') {
    console.log('Codex 用量\ninit：初始化本机采集（默认不同步）\ncollect：增量采集；--rebuild：重算\nsummary：查看统计；--json：导出纯数字快照\nstatus：查看采集与同步状态\nquota：主动读取额度；--codex-binary 指定 Codex\ndevices：列出已接入电脑\nforget：删除 --device 指定的其他电脑数据\nconnect：创建读取凭证并开启同步\ncredentials：显示手机使用的读取凭证\npause：暂停同步\nresume：恢复已绑定的同步\njoin：从标准输入读取另一台电脑生成的加入串\nlink：生成供自己另一台电脑使用的加入串\ninstall：安装事件钩子（之后需在 Codex 中信任）\nuninstall：仅移除本工具安装的钩子，保留本机记录\nwatch：每 60 秒补充采集；stop：请求停止后台采集\n通用选项：--home 目录（可重复）、--state-dir 目录、--timezone 时区、--endpoint 服务地址、--projects on|off');
    return;
  }
  const config = configFor(args, p);
  const output = (data) => { if (!args.quiet) console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
  if (args.command === 'hook') {
    // 子进程不持有钩子的标准输入输出，故障不能阻塞用户会话。
    process.stdin.resume();
    const child = spawn(process.execPath, [__filename, 'collect', '--state-dir', p.dir, '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); child.unref();
    return;
  }
  if (args.command === 'init') { atomicWrite(p.config, config); output('本机采集已初始化，手机同步尚未开启'); return; }
  if (args.command === 'collect') { output(await scan(args, p, config)); return; }
  if (args.command === 'quota') {
    const unlock = lock(p.lock);
    try {
      const state = read(p.history, null) || initialState();
      const result = await readQuota({ binary: args.codexBinary, home: config.homes[0], salt: config.writeToken || state.salt });
      atomicWrite(p.history, state); atomicWrite(path.join(p.dir, 'quota.json'), result);
      const snapshot = read(p.snapshot, null);
      if (snapshot && result.supported) atomicWrite(p.snapshot, { ...snapshot, quotas: result.quotas });
      output(result);
    } finally { unlock(); }
    return;
  }
  if (['summary', 'export'].includes(args.command)) {
    const snapshot = read(p.snapshot, null);
    if (!snapshot) throw new Error('还没有用量记录，请先运行 collect');
    output(snapshot); return;
  }
  if (args.command === 'status') {
    const snapshot = read(p.snapshot, null);
    output({ initialized: fs.existsSync(p.config), sync: config.sync, paired: !!config.writeToken,
      collectedAt: snapshot?.collectedAt || null, timezone: config.timezone, projects: config.projects,
      coverage: snapshot?.coverage || [], diagnostics: snapshot?.diagnostics || null, collection: snapshot?.collection || null,
      hooksInstalled: !!config.installed?.length, hooksTrust: config.installed?.length ? 'check-in-codex' : null });
    return;
  }
  if (args.command === 'connect') {
    if (!config.writeToken) {
      const result = await request(config, '/space', {});
      if (!result.spaceId || !result.writeToken || !result.readToken) throw new Error('服务返回的接入信息不完整');
      Object.assign(config, { spaceId: result.spaceId, writeToken: result.writeToken, readToken: result.readToken });
    }
    config.sync = true; atomicWrite(p.config, config);
    output('手机同步已开启。运行 collect 上传统计，再运行 credentials 查看读取凭证'); return;
  }
  if (args.command === 'credentials') {
    if (!config.readToken) throw new Error('尚未接入手机，请先运行 connect');
    output(config.readToken); return;
  }
  if (args.command === 'link') {
    if (!config.writeToken) throw new Error('尚未接入手机，请先运行 connect');
    output(Buffer.from(JSON.stringify({ v: 1, endpoint: config.endpoint, spaceId: config.spaceId, writeToken: config.writeToken, readToken: config.readToken })).toString('base64url')); return;
  }
  if (args.command === 'devices') {
    if (!config.readToken) throw new Error('尚未接入手机，请先运行 connect');
    const result = await request(config, '/s?source=codex&lite=1', undefined, config.readToken);
    output((result.merged?.devices || []).map((d) => ({ device: d.device, current: d.device === config.device,
      collectedAt: d.collectedAt, receivedAt: d.receivedAt, timezone: d.timezone, coverage: d.coverage })));
    return;
  }
  if (args.command === 'forget') {
    if (!config.writeToken) throw new Error('尚未接入手机，请先运行 connect');
    if (!args.device || !/^[a-f0-9]{4,32}$/.test(args.device)) throw new Error('请使用 --device 指定要删除的设备标识');
    if (args.device === config.device) throw new Error('不能删除正在采集的本机，请先暂停同步并在另一台电脑操作');
    const result = await request(config, '/forget', { source: 'codex', device: args.device }, config.writeToken);
    output({ removed: result.removed }); return;
  }
  if (args.command === 'join') {
    let text = ''; for await (const part of process.stdin) { text += part; if (text.length > 4096) throw new Error('加入串过长'); }
    let data; try { data = JSON.parse(Buffer.from(text.trim(), 'base64url').toString('utf8')); } catch { throw new Error('加入串无效'); }
    if (data.v !== 1 || endpoint(data.endpoint) !== config.endpoint || typeof data.spaceId !== 'string' || typeof data.writeToken !== 'string' || typeof data.readToken !== 'string') throw new Error('加入串与当前服务不匹配');
    // 用只读请求验证后再保存，未打印写入凭证。
    await request({ ...config, endpoint: data.endpoint }, '/s?source=codex&lite=1', undefined, data.readToken);
    Object.assign(config, { spaceId: data.spaceId, writeToken: data.writeToken, readToken: data.readToken, sync: true });
    atomicWrite(p.config, config); output('已加入同一个用量空间'); return;
  }
  if (args.command === 'pause' || args.command === 'resume') {
    if (args.command === 'resume' && !config.writeToken) throw new Error('尚未接入手机，请先运行 connect');
    config.sync = args.command === 'resume'; atomicWrite(p.config, config); output(config.sync ? '手机同步已恢复' : '手机同步已暂停，本机统计继续保留'); return;
  }
  if (args.command === 'install') {
    config.installed = installHooks(config, p); atomicWrite(p.config, config);
    output('事件钩子已安装。请在 Codex 中检查并信任新增钩子，信任后才会自动采集'); return;
  }
  if (args.command === 'uninstall') {
    uninstallHooks(config); config.installed = []; config.sync = false; atomicWrite(p.config, config);
    atomicWrite(path.join(p.dir, 'stop.json'), { at: Date.now() }); output('已移除本工具的事件钩子并暂停同步，本机记录仍保留'); return;
  }
  if (args.command === 'stop') { atomicWrite(path.join(p.dir, 'stop.json'), { at: Date.now() }); output('已请求停止后台采集'); return; }
  if (args.command === 'watch') {
    const release = lock(path.join(p.dir, 'watch.lock')), startedAt = Date.now();
    let stopped = false;
    process.once('SIGINT', () => { stopped = true; }); process.once('SIGTERM', () => { stopped = true; });
    try {
      while (!stopped) {
        if ((read(path.join(p.dir, 'stop.json'), {})?.at || 0) >= startedAt) break;
        try { await scan(args, p, configFor(args, p)); } catch { if (!args.quiet) console.error('本轮采集未完成，将在下一轮重试'); }
        for (let i = 0; i < 60 && !stopped; i++) {
          if ((read(path.join(p.dir, 'stop.json'), {})?.at || 0) >= startedAt) { stopped = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } finally { release(); }
    return;
  }
  throw new Error('无法识别命令，请运行 help 查看用法');
}
if (require.main === module) main().catch((e) => {
  if (process.argv[2] === 'hook' || process.argv.includes('--quiet')) return;
  console.error(e.message && !/ENOENT|EACCES|ENOSPC|fetch failed/.test(e.message) ? e.message : '操作未完成，请检查本机目录、网络与可用空间后重试');
  process.exitCode = 1;
});
module.exports = { parse, paths, endpoint, configFor, lock, installHooks, uninstallHooks, scan, request, main };
