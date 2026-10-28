#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const background = require('./lib/background.cjs');
const { diagnostic, errorKind, watcher } = require('./lib/diagnostics.cjs');
const { collect, initialState, atomicWrite, hash } = require('./lib/collect.cjs');
const { readQuotaHomes } = require('./lib/quota.cjs');
const { sanitizeHook, absorbHook, buildLive } = require('./lib/live.cjs');

function parse(args) {
  const out = { command: args[0] || 'status', homes: [] };
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (['--home', '--state-dir', '--timezone', '--endpoint', '--projects', '--codex-binary', '--device'].includes(key)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('选项缺少参数');
      if (key === '--home') out.homes.push(path.resolve(value));
      else out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else if (['--json', '--quiet', '--rebuild', '--hook-worker'].includes(key)) out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
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
const configBaselines = new WeakMap();
function configFor(args, p) {
  const saved = read(p.config, null);
  const homes = [...new Set((args.homes.length ? args.homes : saved?.homes || [path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))]).map((h) => path.resolve(h)))];
  const timezone = args.timezone || saved?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new Error('时区无效'); }
  if (args.projects && !['on', 'off'].includes(args.projects)) throw new Error('项目名称选项必须是 on 或 off');
  const projects = args.projects ? args.projects === 'on' : saved?.projects || false;
  const target = endpoint(args.endpoint || saved?.endpoint || process.env.NUMABLE_USAGE_ENDPOINT || 'https://usage.numable.app');
  if (saved?.writeToken && saved.endpoint !== target) throw new Error('已绑定的凭证不能发送到另一个服务，请使用独立状态目录');
  const config = { version: 1, ...saved, homes, timezone, projects, endpoint: target, live: saved?.live === true,
    salt: saved?.salt || crypto.randomBytes(32).toString('hex'),
    device: saved?.device || crypto.randomBytes(12).toString('hex'), sync: saved?.sync || false };
  configBaselines.set(config, structuredClone(saved || {}));
  return config;
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
      try { process.kill(previous.pid, 0); throw Object.assign(new Error('已有采集正在进行'), { code: 'LOCK_BUSY' }); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法取得采集锁');
}
// 所有配置回写共享短锁；只合并本次实际修改的字段，旧采集不能覆盖并发的暂停、卸载或隐私开关。
async function saveConfig(p, config) {
  let release;
  for (let i = 0; ; i++) {
    try { release = lock(path.join(p.dir, 'config.lock')); break; }
    catch (error) {
      if (error.code !== 'LOCK_BUSY' || i >= 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    const baseline = configBaselines.get(config) || {}, current = read(p.config, {});
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const merged = { ...current };
    for (const [key, value] of Object.entries(config)) {
      if (!same(value, baseline[key]) && same(current[key], baseline[key])) merged[key] = value;
    }
    atomicWrite(p.config, merged);
    Object.assign(config, merged);
    configBaselines.set(config, structuredClone(merged));
  } finally { release(); }
}
async function request(config, route, body, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(config.endpoint + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw Object.assign(new Error(`服务请求失败（${r.status}），请检查连接后重试`), { httpStatus: r.status });
    return await r.json();
  } finally { clearTimeout(timer); }
}
function hookCommand({ stateDir, node = process.execPath, cli = __filename, platform = process.platform }) {
  const args = [node, cli, 'hook', '--state-dir', stateDir];
  if (platform === 'win32') {
    // 外层 cmd / PowerShell 都只解析固定程序名与 Base64，路径仅在内层按字面量传递。
    // 不使用 Invoke-Expression，也不修改执行策略；调用运算符负责启动带空格的可执行路径。
    const quote = (s) => `'${s.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference='Stop'; & ${args.map(quote).join(' ')}; exit $LASTEXITCODE`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  }
  const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  return args.map(quote).join(' ');
}
function hookDefinitions(p) {
  const command = hookCommand({ stateDir: p.dir });
  return ['SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PreCompact', 'SubagentStart', 'SubagentStop', 'Interrupt'].map((event) => ({ event,
    group: { hooks: [{ type: 'command', command, ...(event === 'SessionEnd' ? {} : { async: true }), timeout: ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 10 }] } }));
}
function installHooks(config, p) {
  const installed = [];
  for (const home of config.homes) {
    const file = path.join(home, 'hooks.json'), doc = read(file, {});
    if (doc.hooks && (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks))) throw new Error('已有事件钩子的格式无效，未覆盖原配置');
    doc.hooks ||= {};
    for (const { event, group } of hookDefinitions(p)) {
      let groups = doc.hooks[event] || [];
      if (!Array.isArray(groups)) throw new Error('已有事件钩子的格式无效，未覆盖原配置');
      // 升级仅替换上次安装记录中完整匹配的定义，用户修改过的定义保留。
      const previous = (config.installed || []).filter((h) => h.file === file && h.event === event).map((h) => JSON.stringify(h.group));
      groups = groups.filter((g) => !previous.includes(JSON.stringify(g)));
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
function pendingEvents(p) {
  try { return fs.readdirSync(path.join(p.dir, 'events')).some((f) => f.endsWith('.json')); } catch { return false; }
}
function spawnEventWorker(p) {
  const child = spawn(process.execPath, [__filename, 'collect', '--state-dir', p.dir, '--quiet', '--hook-worker'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
}
// 常驻采集每分钟一轮；历史文件自本进程上次读写后没被其他进程替换时，直接复用内存里那份，省掉整份 JSON 解析。
let historyCache = null;
function historyStamp(file) {
  try { const s = fs.statSync(file); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return null; }
}
async function scan(args, p, config) {
  const unlock = lock(p.lock);
  try {
    // 等锁的期间可能已有其他采集更新序号或开关；取得锁后再读权威配置。
    if (fs.existsSync(p.config)) config = configFor(args, p);
    const projectionSettings = JSON.stringify([config.homes, config.timezone, config.projects, config.live, config.writeToken]);
    const cached = historyCache; historyCache = null;
    let existing;
    if (cached && cached.stamp === historyStamp(p.history)) existing = cached.state;
    else try { existing = read(p.history, null); }
    catch (error) {
      if (!args.rebuild) throw error;
      const backup = path.join(p.dir, `history.corrupt-${Date.now()}.json`);
      fs.copyFileSync(p.history, backup); fs.chmodSync(backup, 0o600);
      existing = null;
    }
    if (existing?.salt) config.salt = existing.salt;
    const state = args.rebuild ? { ...initialState(), salt: config.salt } : existing || { ...initialState(), salt: config.salt };
    const queueDir = path.join(p.dir, 'events');
    let queued = []; try { queued = fs.readdirSync(queueDir).filter((name) => /^[a-zA-Z0-9.-]+\.json$/.test(name)).map((name) => ({ file: path.join(queueDir, name), event: read(path.join(queueDir, name), null) })); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const r = await collect(config.homes, state, { timezone: config.timezone, projects: config.projects, live: config.live });
    let activeQuota = read(path.join(p.dir, 'quota.json'), null);
    if (config.quotaAuto && Date.now() - (config.lastQuotaAttempt || 0) >= 300000) {
      config.lastQuotaAttempt = Date.now();
      try {
        activeQuota = await readQuotaHomes({ binary: config.quotaBinary, homes: config.homes, salt: config.writeToken || state.salt, profileSalt: state.salt, previous: activeQuota });
        atomicWrite(path.join(p.dir, 'quota.json'), activeQuota);
        config.quotaStatus = activeQuota.supported ? activeQuota.failures ? 'partial' : 'ready' : 'unavailable';
      } catch { config.quotaStatus = 'unavailable'; }
    }
    if (activeQuota?.supported && activeQuota.scope === hash(config.writeToken || state.salt, 'quota-scope')) {
      const allowedProfiles = new Set(config.homes.map((home) => hash(state.salt, `profile:${path.resolve(home)}`)));
      const profiles = new Set(activeQuota.quotas.filter((q) => allowedProfiles.has(q.profile)).map((q) => q.profile));
      for (const profile of profiles) {
        const latestLog = Math.max(0, ...r.snapshot.quotas.filter((q) => q.profile === profile).map((q) => q.observedAt));
        const active = activeQuota.quotas.filter((q) => q.profile === profile);
        if (active.length && Math.max(...active.map((q) => q.observedAt)) >= latestLog) r.snapshot.quotas = [...r.snapshot.quotas.filter((q) => q.profile !== profile), ...active];
      }
    }
    r.snapshot.quotaDiagnostics = { failures: activeQuota?.failures || 0, profiles: activeQuota?.profileCount || config.homes.length };
    // 历史只有真变了才整份重写；空闲轮次跳过约 10MB 的序列化与落盘。
    let dirty = !existing || !!args.rebuild || r.changed || queued.length > 0;
    if (config.live) {
      if (!r.state.liveHooks) { r.state.liveHooks = { sessions: {} }; dirty = true; }
      for (const q of queued.sort((a, b) => (a.event?.at || 0) - (b.event?.at || 0))) absorbHook(r.state.liveHooks, q.event);
      for (const [id, s] of Object.entries(r.state.liveHooks.sessions)) if (s.lastAt < Date.now() - 24 * 3600e3) { delete r.state.liveHooks.sessions[id]; dirty = true; }
    } else if (r.state.liveHooks) { delete r.state.liveHooks; dirty = true; }
    if (!config.projects) {
      const clear = (o) => { if (o.projectName !== null) dirty = true; o.projectName = null; };
      for (const f of Object.values(r.state.files)) { clear(f); if (f.live) clear(f.live); }
      for (const s of Object.values(r.state.liveHooks?.sessions || {})) clear(s);
    }
    const live = config.live ? buildLive(r.state, { projects: config.projects }) : { tier: 1, devNow: Date.now(), sessions: [] };
    if (dirty) atomicWrite(p.history, r.state);
    historyCache = { stamp: historyStamp(p.history), state: r.state };
    atomicWrite(p.snapshot, { ...r.snapshot, collection: r.stats });
    atomicWrite(path.join(p.dir, 'live.json'), live);
    for (const q of queued) try { fs.unlinkSync(q.file); } catch {}
    config.lastCollect = r.snapshot.collectedAt; await saveConfig(p, config);
    if (config.sync && config.writeToken && projectionSettings === JSON.stringify([config.homes, config.timezone, config.projects, config.live, config.writeToken])) {
      const background = args.hookWorker || args.command === 'watch';
      const pending = []; let syncError = null;
      if (!background || Date.now() - (config.lastStatsPush || 0) >= 60000) {
        pending.push((async () => {
          try {
            await request(config, '/ingest', { source: 'codex', device: config.device, snapshot: { ...r.snapshot, collection: r.stats } }, config.writeToken);
            config.lastStatsPush = Date.now();
          } catch (error) { syncError ||= error; }
        })());
      }
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ tier: live.tier, sessions: live.sessions })).digest('hex');
      if ((config.live || config.liveClearPending) && (fingerprint !== config.lastLiveFingerprint || Date.now() - (config.lastLivePush || 0) >= 60000)) {
        config.lastLiveSequence = (config.lastLiveSequence || 0) + 1;
        await saveConfig(p, config);
        const seq = config.lastLiveSequence;
        pending.push((async () => {
          try {
            const wait = (config.lastLivePush || 0) + 2000 - Date.now();
            if (args.hookWorker && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            const latest = configFor(args, p);
            // 两秒合并窗口内也可能暂停 / 换空间 / 关闭实时；尚未发出的请求应取消。
            if (!latest.sync || projectionSettings !== JSON.stringify([latest.homes, latest.timezone, latest.projects, latest.live, latest.writeToken])) return;
            await request(config, `/live?source=codex&dev=${config.device}`, { ...live, seq }, config.writeToken);
            config.lastLivePush = Date.now(); config.lastLiveFingerprint = fingerprint; config.liveClearPending = false;
          } catch (error) { syncError ||= error; }
        })());
      }
      await Promise.all(pending); config.syncError = !!syncError;
      await saveConfig(p, config);
      if (syncError) throw syncError;
    }
    return { ...r.snapshot, collection: r.stats };
  } finally { unlock(); }
}
async function main(argv = process.argv.slice(2)) {
  const args = parse(argv), p = paths(args);
  if (args.command === 'help' || args.command === '--help') {
    console.log('Codex 用量\ninit：初始化本机采集（默认不同步）\ncollect：增量采集；--rebuild：重算\nsummary：查看统计；--json：导出纯数字快照\nstatus：查看采集与同步状态\nquota：主动读取额度；--codex-binary 指定 Codex\nquota-auto-on/off：开启或关闭每五分钟读取额度\nlive-on/off：开启或关闭匿名实时状态；live：查看实时投影\ndevices：列出已接入电脑\nforget：删除 --device 指定的其他电脑数据\nconnect：创建读取凭证并开启同步\ncredentials：显示手机使用的读取凭证\npause：暂停同步\nresume：恢复已绑定的同步\njoin：从标准输入读取另一台电脑生成的加入串\nlink：生成供自己另一台电脑使用的加入串\ninstall：安装事件钩子（之后需在 Codex 中信任）\nuninstall：仅移除本工具安装的钩子，保留本机记录\nautostart-on/off：开启/移除 macOS 登录自启与退出自动恢复\nstart：后台启动并确认运行；watch：在前台每 60 秒补充采集；stop：请求停止后台采集\n通用选项：--home 目录（可重复）、--state-dir 目录、--timezone 时区、--endpoint 服务地址、--projects on|off');
    return;
  }
  const config = configFor(args, p);
  const output = (data) => { if (!args.quiet) console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
  if (args.command === 'hook') {
    // 先在父进程丢掉敏感字段，原始输入既不落盘，也不出现在进程参数中。
    let text = '', overflow = false;
    for await (const chunk of process.stdin) { if (!overflow) { text += chunk; if (text.length > 2 * 1024 * 1024) { overflow = true; text = ''; } } }
    if (!fs.existsSync(p.config)) { process.stdout.write('{}\n'); return; }
    let event = null; try { if (config.live && !overflow) event = sanitizeHook(JSON.parse(text), config.salt, { projects: config.projects }); } catch {}
    atomicWrite(path.join(p.dir, 'events', `${Date.now()}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.json`), event || { scan: true, at: Date.now() });
    let workerRunning = false;
    try { const lease = read(path.join(p.dir, 'event-worker.lock'), null); if (lease?.pid) { process.kill(lease.pid, 0); workerRunning = true; } } catch {}
    if (!workerRunning) spawnEventWorker(p);
    process.stdout.write('{}\n');
    return;
  }
  if (args.command === 'init') {
    // 首次配置或旧版未设置时启用只读额度检查，保留用户明确关闭的选择。
    if (typeof read(p.config, {}).quotaAuto !== 'boolean') config.quotaAuto = true;
    await saveConfig(p, config);
    output(`本机采集已初始化；手机同步${config.sync ? '已开启' : '尚未开启'}。${config.quotaAuto ? '已启用每五分钟只读额度检查，运行 start 保持后台采集；可用 quota-auto-off 关闭' : '额度自动读取已关闭；可用 quota-auto-on 开启'}`); return;
  }
  if (args.command === 'collect') {
    if (args.hookWorker) {
      let release;
      try { release = lock(path.join(p.dir, 'event-worker.lock')); } catch (error) { if (error.code === 'LOCK_BUSY') return; throw error; }
      try {
        for (let i = 0; i < 600; i++) {
          if (!pendingEvents(p)) return;
          try { await scan(args, p, configFor(args, p)); }
          catch (error) { if (error.code !== 'LOCK_BUSY') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
        }
      } finally { release(); if (pendingEvents(p)) spawnEventWorker(p); }
      return;
    }
    output(await scan(args, p, config)); return;
  }
  if (args.command === 'live-on' || args.command === 'live-off') {
    config.live = args.command === 'live-on'; config.liveClearPending = !config.live;
    await saveConfig(p, config); await scan(args, p, config);
    output(config.live ? '实时状态已开启；手机同步沿用当前开关' : '实时状态已关闭'); return;
  }
  if (args.command === 'live') { output(read(path.join(p.dir, 'live.json'), { tier: 1, sessions: [] })); return; }
  if (args.command === 'quota') {
    const unlock = lock(p.lock);
    try {
      const state = read(p.history, null) || { ...initialState(), salt: config.salt };
      config.salt = state.salt;
      const result = await readQuotaHomes({ binary: args.codexBinary || config.quotaBinary, homes: config.homes, salt: config.writeToken || state.salt, profileSalt: state.salt,
        previous: read(path.join(p.dir, 'quota.json'), null) });
      atomicWrite(p.history, state); await saveConfig(p, config); atomicWrite(path.join(p.dir, 'quota.json'), result);
      const snapshot = read(p.snapshot, null);
      if (snapshot && result.supported) atomicWrite(p.snapshot, { ...snapshot, quotas: result.quotas });
      output(result);
    } finally { unlock(); }
    return;
  }
  if (args.command === 'quota-auto-on' || args.command === 'quota-auto-off') {
    config.quotaAuto = args.command === 'quota-auto-on';
    if (args.codexBinary) config.quotaBinary = args.codexBinary;
    if (config.quotaAuto) config.lastQuotaAttempt = 0;
    await saveConfig(p, config); if (config.quotaAuto) await scan(args, p, config);
    output(config.quotaAuto ? '额度自动读取已开启，每五分钟检查一次；请保持后台采集运行' : '额度自动读取已关闭'); return;
  }
  if (['summary', 'export'].includes(args.command)) {
    const snapshot = read(p.snapshot, null);
    if (!snapshot) throw new Error('还没有用量记录，请先运行 collect');
    output(snapshot); return;
  }
  if (args.command === 'autostart-on' || args.command === 'autostart-off') {
    if (!fs.existsSync(p.config)) throw new Error('请先运行 init 初始化本机采集');
    if (args.command === 'autostart-on') await background.enable(p.dir); else await background.disable(p.dir);
    output(args.command === 'autostart-on' ? '系统托管已开启：登录后自动启动，异常退出后自动恢复' : '系统托管已移除，后台采集已停止'); return;
  }
  if (args.command === 'status') {
    const snapshot = read(p.snapshot, null);
    output({ background: { ...watcher(p.dir), ...background.serviceStatus(p.dir) }, diagnosticLog: path.join(p.dir, 'logs/diagnostic.jsonl'), lastCollect: config.lastCollect || null, lastStatsPush: config.lastStatsPush || null, initialized: fs.existsSync(p.config), sync: config.sync, paired: !!config.writeToken, live: config.live,
      quotaAuto: config.quotaAuto === true, quotaHint: config.quotaAuto ? '请保持后台采集运行；读取失败时检查 Codex 登录状态' : '运行 numable-codex quota-auto-on，再运行 numable-codex start', quotaStatus: config.quotaStatus || null, syncError: config.syncError ?? null,
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
    config.sync = true; await saveConfig(p, config);
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
    output({ removed: result.removed, liveRemoved: result.liveRemoved || 0 }); return;
  }
  if (args.command === 'join') {
    let text = ''; for await (const part of process.stdin) { text += part; if (text.length > 4096) throw new Error('加入串过长'); }
    let data; try { data = JSON.parse(Buffer.from(text.trim(), 'base64url').toString('utf8')); } catch { throw new Error('加入串无效'); }
    if (data.v !== 1 || endpoint(data.endpoint) !== config.endpoint || typeof data.spaceId !== 'string' || typeof data.writeToken !== 'string' || typeof data.readToken !== 'string') throw new Error('加入串与当前服务不匹配');
    // 用只读请求验证后再保存，未打印写入凭证。
    await request({ ...config, endpoint: data.endpoint }, '/s?source=codex&lite=1', undefined, data.readToken);
    Object.assign(config, { spaceId: data.spaceId, writeToken: data.writeToken, readToken: data.readToken, sync: true });
    await saveConfig(p, config); output('已加入同一个用量空间'); return;
  }
  if (args.command === 'pause' || args.command === 'resume') {
    if (args.command === 'resume' && !config.writeToken) throw new Error('尚未接入手机，请先运行 connect');
    config.sync = args.command === 'resume'; await saveConfig(p, config); output(config.sync ? '手机同步已恢复' : '手机同步已暂停，本机统计继续保留'); return;
  }
  if (args.command === 'install') {
    config.installed = installHooks(config, p); await saveConfig(p, config);
    output('事件钩子已安装。请在 Codex 中检查并信任新增钩子，信任后才会自动采集'); return;
  }
  if (args.command === 'uninstall') {
    if (background.installed(p.dir)) await background.disable(p.dir); else await background.stop(p.dir);
    uninstallHooks(config); config.installed = []; config.sync = false; await saveConfig(p, config);
    atomicWrite(path.join(p.dir, 'stop.json'), { at: Date.now() }); output('已移除本工具的事件钩子并暂停同步，本机记录仍保留'); return;
  }
  if (args.command === 'stop') { await background.stop(p.dir); output('后台采集已停止；已配置的登录自启会在下次登录后恢复'); return; }
  if (args.command === 'start') {
    if (!fs.existsSync(p.config)) throw new Error('请先运行 init 初始化本机采集');
    if (background.installed(p.dir)) { await background.managedStart(p.dir); output('系统托管的后台采集已启动'); return; }
    const watchLock = path.join(p.dir, 'watch.lock'), previous = watcher(p.dir);
    if (previous?.pid) {
      try { process.kill(previous.pid, 0); output('后台采集已在运行'); return; }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    const child = spawn(process.execPath, [__filename, 'watch', '--state-dir', p.dir, '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true });
    let failed = false; child.once('error', () => { failed = true; }); child.unref();
    for (let i = 0; i < 40 && !failed; i++) {
      if (watcher(p.dir).pid === child.pid) { output('后台采集已启动'); return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('未能确认后台采集启动，请运行 watch 查看状态');
  }
  if (args.command === 'watch') {
    const release = lock(path.join(p.dir, 'watch.lock')), startedAt = Date.now();
    let stopped = false, reason = 'normal', failures = 0;
    diagnostic(p.dir, 'watch_start', { sync: config.sync, quotaAuto: config.quotaAuto });
    atomicWrite(path.join(p.dir, 'heartbeat.json'), { pid: process.pid, at: Date.now() });
    process.once('SIGINT', () => { stopped = true; reason = 'signal'; }); process.once('SIGTERM', () => { stopped = true; reason = 'signal'; });
    try {
      while (!stopped) {
        if ((read(path.join(p.dir, 'stop.json'), {})?.at || 0) >= startedAt) { reason = 'stop_request'; break; }
        const scanStart = Date.now(); diagnostic(p.dir, 'scan_start');
        try {
          await scan(args, p, configFor(args, p)); failures = 0;
          const latest = read(p.config, {}); diagnostic(p.dir, 'scan_ok', { elapsedMs: Date.now() - scanStart, lastCollect: latest.lastCollect, lastStatsPush: latest.lastStatsPush, sync: latest.sync, quotaStatus: latest.quotaStatus });
        } catch (error) {
          failures++; diagnostic(p.dir, 'scan_failed', { elapsedMs: Date.now() - scanStart, failures, kind: errorKind(error), httpStatus: error.httpStatus });
          if (!args.quiet) console.error('本轮采集未完成，将在下一轮重试');
        }
        for (let i = 0; i < 60 && !stopped; i++) {
          if (i % 10 === 0) atomicWrite(path.join(p.dir, 'heartbeat.json'), { pid: process.pid, at: Date.now(), failures });
          if ((read(path.join(p.dir, 'stop.json'), {})?.at || 0) >= startedAt) { stopped = true; reason = 'stop_request'; break; }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } finally { diagnostic(p.dir, 'watch_stop', { reason }); release(); }
    return;
  }
  throw new Error('无法识别命令，请运行 help 查看用法');
}
if (require.main === module) {
  const failure = error => {
    try { diagnostic(paths(parse(process.argv.slice(2))).dir, 'fatal', { kind: errorKind(error) }); } catch {}
    process.exit(1);
  };
  process.once('uncaughtException', failure); process.once('unhandledRejection', failure);
  main().catch((e) => {
  try { diagnostic(paths(parse(process.argv.slice(2))).dir, 'fatal', { kind: errorKind(e), httpStatus: e.httpStatus }); } catch {}
  if (process.argv[2] === 'hook') { process.stdout.write('{}\n'); return; }
  if (process.argv.includes('--quiet')) { process.exitCode = 1; return; }
  console.error(e.message && !/ENOENT|EACCES|ENOSPC|fetch failed/.test(e.message) ? e.message : '操作未完成，请检查本机目录、网络与可用空间后重试');
  process.exitCode = 1;
  });
}
module.exports = { parse, paths, endpoint, configFor, lock, installHooks, uninstallHooks, scan, request, main, hookCommand };
