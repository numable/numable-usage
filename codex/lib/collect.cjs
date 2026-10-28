'use strict';

// 日志只在本机解析；持久化投影不含正文、代码、命令、工具参数或登录凭证。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { absorbLog } = require('./live.cjs');
const R = require('./records.cjs');
const { AT, CTX, TURN, total, pack } = R;

// 2：响应与旧累计记录改为定长数组 + 文件级上下文表；1 的历史在读取时无损升级。
const VERSION = 2;
const WINDOW = 400 * 864e5;
// 统计只看最近 400 天；再多留 30 天，跨窗口边界的同一轮次仍能互相去重。
const RETAIN = WINDOW + 30 * 864e5;
const MODEL = /^[a-zA-Z0-9._-]{1,80}$/;
const LIMIT = /^[a-zA-Z0-9._-]{1,64}$/;
const n = (x) => Number.isSafeInteger(x) && x >= 0 ? x : null;
const hash = (salt, value) => crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 24);
const emptyUsage = () => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
function usage(u) {
  if (!u || n(u.input_tokens) === null || n(u.output_tokens) === null) return null;
  const input = n(u.input_tokens), output = n(u.output_tokens);
  const cached = n(u.cached_input_tokens), reasoning = n(u.reasoning_output_tokens);
  const total = input + output;
  if (!Number.isSafeInteger(total) || (n(u.total_tokens) !== null && u.total_tokens !== total)) return null;
  if (cached > input || reasoning > output) return null;
  return { input, output, cached, reasoning, total };
}
function addPacked(to, t) {
  // 直接读定长数组累加；可选细项缺失时保留未知，总量不受它们影响。
  to.input += t[R.INPUT]; to.output += t[R.OUTPUT]; to.total += total(t);
  to.cached = to.cached === null || t[R.CACHED] === null ? null : to.cached + t[R.CACHED];
  to.reasoning = to.reasoning === null || t[R.REASONING] === null ? null : to.reasoning + t[R.REASONING];
}
function quota(raw, at) {
  if (!raw || !Number.isFinite(at)) return null;
  const id = raw.limit_id || raw.limitId || 'codex';
  if (typeof id !== 'string' || !LIMIT.test(id)) return null;
  const window = (w) => {
    if (!w || typeof w.used_percent !== 'number' && typeof w.usedPercent !== 'number') return null;
    const usedPercent = w.used_percent ?? w.usedPercent;
    const windowDurationMins = w.window_minutes ?? w.windowDurationMins;
    const resetsAt = w.resets_at ?? w.resetsAt;
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
      !Number.isFinite(windowDurationMins) || windowDurationMins <= 0 || n(resetsAt) === null || resetsAt <= 0) return null;
    return { usedPercent, windowDurationMins, resetsAt };
  };
  const primary = window(raw.primary), secondary = window(raw.secondary);
  return primary || secondary ? { id, observedAt: at, primary, secondary } : null;
}
const formatters = new Map();
function dateAt(at, timezone) {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const parts = formatters.get(timezone).formatToParts(at);
  const get = (key) => parts.find((x) => x.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function initialState() {
  return { version: VERSION, salt: crypto.randomBytes(32).toString('hex'), files: {} };
}
function projection() {
  return { offset: 0, identity: '', head: '', session: null, project: null, projectName: null,
    source: 'unknown', version: null, subagent: false, fork: false, model: 'unknown', turn: null,
    ctx: [], records: {}, legacy: {}, turns: {}, prompts: {}, activity: {}, quotas: {},
    cumulative: null, diagnostics: { invalidRows: 0, invalidUsage: 0, missingIdentity: 0 }, lastAt: 0 };
}
function processRow(file, row, salt, options = {}) {
  const p = row && row.payload;
  if (!p || typeof p !== 'object') return;
  const at = Date.parse(row.timestamp || p.timestamp);
  if (row.type === 'session_meta') {
    const id = p.id || p.session_id;
    if (typeof id === 'string') file.session = hash(salt, `session:${id}`);
    if (typeof p.cwd === 'string') {
      file.project = hash(salt, `project:${p.cwd.replace(/\\/g, '/').replace(/\/$/, '')}`);
      if (options.projects) file.projectName = p.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop()?.slice(0, 40) || null;
    }
    const src = p.source;
    file.subagent = !!(src && typeof src === 'object' && src.subagent) || !!p.parent_thread_id;
    file.fork = !!(p.forked_from_id || p.forked_from);
    file.source = file.subagent ? 'subagent' : ['cli', 'vscode', 'exec', 'appServer'].includes(src) ? src : 'unknown';
    file.version = typeof p.cli_version === 'string' && /^[a-zA-Z0-9.+_-]{1,64}$/.test(p.cli_version) ? p.cli_version : null;
    return;
  }
  if (row.type === 'turn_context') {
    file.turn = typeof p.turn_id === 'string' ? hash(salt, `turn:${p.turn_id}`) : file.turn;
    file.model = typeof p.model === 'string' && MODEL.test(p.model) ? p.model : 'unknown';
    return;
  }
  if (!Number.isFinite(at) || !file.session) return;
  file.lastAt = Math.max(file.lastAt, at);
  const turn = typeof p.turn_id === 'string' ? hash(salt, `turn:${p.turn_id}`) : file.turn;
  const base = { at, session: file.session, project: file.project, model: file.model, turn, subagent: file.subagent };
  if (options.live) absorbLog(file, row, { ...base, projectName: options.projects ? file.projectName : null }, (value) => hash(salt, value));
  if (row.type === 'token_usage_record') {
    const u = usage(p.usage);
    if (!u) { file.diagnostics.invalidUsage++; return; }
    if (typeof p.response_id !== 'string') { file.diagnostics.missingIdentity++; return; }
    const key = hash(salt, `response:${p.response_id}`);
    file.records[key] = pack(file, { ...base, ...(typeof p.session_id === 'string' ? { session: hash(salt, `session:${p.session_id}`) } : {}), usage: u });
    file.activity[String(Math.floor(at / 60000))] = 1;
  }
  if (row.type !== 'event_msg') return;
  if (p.type === 'token_count') {
    const q = quota(p.rate_limits, at);
    if (q) file.quotas[q.id] = q;
    const total = usage(p.info?.total_token_usage), last = usage(p.info?.last_token_usage);
    if (!total) return;
    const previous = file.cumulative;
    // 累计计数完全相同的通知不能重复统计；计数回落视为新代，绝不产生负数。
    if (previous && total.input === previous.input && total.output === previous.output) return;
    let u;
    if (previous && total.input >= previous.input && total.output >= previous.output) {
      u = emptyUsage();
      for (const k of Object.keys(u)) u[k] = total[k] === null || previous[k] === null ? null : Math.max(0, total[k] - previous[k]);
    } else {
      // 恢复或分叉首条累计值可能含继承历史，只认这次响应的 last。
      u = last;
    }
    file.cumulative = total;
    if (!u) { file.diagnostics.invalidUsage++; return; }
    const key = hash(salt, `legacy:${file.session}:${turn || ''}:${total.input}:${total.output}`);
    file.legacy[key] = pack(file, { ...base, usage: u });
    file.activity[String(Math.floor(at / 60000))] = 1;
  }
  if (p.type === 'task_started' && turn) {
    file.turn = turn;
    file.turns[turn] = { at, session: file.session, subagent: file.subagent };
  }
  if (p.type === 'user_message' || p.type === 'item_completed' && p.item?.type === 'UserMessage') {
    // 只判断结构，不读正文；有事件身份才去重，没有身份按轮计一次。
    const id = p.item?.id || turn;
    if (id) file.prompts[hash(salt, `prompt:${file.session}:${id}`)] = { at, subagent: file.subagent };
    file.activity[String(Math.floor(at / 60000))] = 1;
  }
}

async function discover(roots) {
  const result = [], skipped = { compressedUnavailable: 0, unreadableDirectories: 0 };
  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') skipped.unreadableDirectories++; return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && /\.jsonl(?:\.gz|\.zst)?$/.test(entry.name)) result.push(p);
    }
  }
  for (const root of roots) {
    await walk(path.join(root, 'sessions'));
    await walk(path.join(root, 'archived_sessions'));
  }
  return { paths: [...new Set(result)], skipped };
}

async function readFile(filePath, old, salt, options) {
  const stat = await fs.promises.stat(filePath);
  const compressed = /\.(gz|zst)$/.test(filePath);
  // 同一文件、大小与修改时间都没变时内容不可能变化；常驻采集每分钟扫一遍，不必再打开文件和复制投影。
  if (old && old.identity === `${stat.dev}:${stat.ino}` && old.size === stat.size && old.mtime === stat.mtimeMs &&
    old.projectsEnabled === (options.projects === true) && old.liveEnabled === (options.live === true) && old.profile === options.profile) return { file: old, rows: 0 };
  const handle = await fs.promises.open(filePath, 'r');
  const first = Buffer.alloc(Math.min(256, stat.size));
  await handle.read(first, 0, first.length, 0);
  await handle.close();
  const head = crypto.createHash('sha256').update(first).digest('hex');
  const identity = `${stat.dev}:${stat.ino}`;
  // 小文件首段会随追加变化；只有旧文件已超过 256 字节才用首段判断替换。
  const reset = !old || old.identity !== identity || old.offset > stat.size || old.offset >= 256 && old.head !== head || old.projectsEnabled !== (options.projects === true) || old.liveEnabled !== (options.live === true) || old.profile !== options.profile;
  if (!reset && (compressed ? old.size === stat.size && old.mtime === stat.mtimeMs : old.offset === stat.size)) {
    // 内容没有新增时只刷新文件元数据，投影本体与旧状态共用，避免整份深复制。
    return { file: { ...old, head, size: stat.size, mtime: stat.mtimeMs }, rows: 0 };
  }
  const f = reset ? projection() : structuredClone(old);
  f.identity = identity; f.head = head; f.projectsEnabled = options.projects === true; f.liveEnabled = options.live === true; f.profile = options.profile;
  if (compressed && !reset) Object.assign(f, projection(), { identity, head, projectsEnabled: options.projects === true, liveEnabled: options.live === true, profile: options.profile });
  const start = compressed ? 0 : f.offset;
  if (!stat.size) return { file: f, rows: 0 };
  let stream, child, childDone;
  if (filePath.endsWith('.zst')) {
    child = spawn(options.zstd || 'zstd', ['-d', '-q', '-c', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
    childDone = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error('压缩日志解码失败'))); });
    // 先挂拒绝处理，稍后统一等待，避免流结束前出现未处理拒绝。
    childDone.catch(() => {});
    stream = child.stdout;
  } else {
    stream = fs.createReadStream(filePath, { start, end: stat.size - 1 });
    if (filePath.endsWith('.gz')) stream = stream.pipe(zlib.createGunzip());
  }
  let pending = Buffer.alloc(0), rows = 0, bytes = start;
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    let begin = 0, end;
    while ((end = pending.indexOf(10, begin)) !== -1) {
      const line = pending.subarray(begin, end);
      bytes += end - begin + 1; begin = end + 1;
      if (!line.length) continue;
      let row;
      try { row = JSON.parse(line.toString('utf8')); } catch { f.diagnostics.invalidRows++; continue; }
      processRow(f, row, salt, options); rows++;
    }
    pending = pending.subarray(begin);
    if (pending.length > 32 * 1024 * 1024) throw new Error('单条日志超过读取上限');
  }
  if (childDone) await childDone;
  f.offset = compressed ? stat.size : bytes;
  f.size = stat.size; f.mtime = stat.mtimeMs;
  return { file: f, rows };
}

function upgrade(previous) {
  if (previous.version === VERSION) return previous;
  const files = {};
  for (const [name, f] of Object.entries(previous.files)) {
    const g = { ...f, ctx: [], records: {}, legacy: {} };
    for (const [key, r] of Object.entries(f.records)) g.records[key] = pack(g, r);
    for (const [key, r] of Object.entries(f.legacy)) g.legacy[key] = pack(g, r);
    files[name] = g;
  }
  return { ...previous, version: VERSION, files };
}
function prune(f, horizon) {
  // 只在确有过期条目时才复制，没过期的文件仍与旧状态共用。
  let out = f;
  const drop = (field, atOf) => {
    const entries = Object.entries(out[field]);
    if (!entries.some(([key, v]) => atOf(key, v) < horizon)) return;
    if (out === f) out = { ...f };
    out[field] = Object.fromEntries(entries.filter(([key, v]) => atOf(key, v) >= horizon));
  };
  drop('records', (_, t) => t[AT]); drop('legacy', (_, t) => t[AT]);
  drop('turns', (_, t) => t.at); drop('prompts', (_, t) => t.at); drop('activity', (minute) => Number(minute) * 60000);
  // 实时投影只展示最近一天有动静的会话；保留期外的会话状态不再需要，续写时会重新建立。
  if (out.live && out.live.lastAt < horizon) { if (out === f) out = { ...f }; delete out.live; }
  return out;
}

async function collect(roots, previous = initialState(), options = {}) {
  if (![1, VERSION].includes(previous.version) || typeof previous.salt !== 'string') throw new Error('历史格式不兼容，请执行重算');
  const now = options.now || Date.now();
  const upgraded = upgrade(previous);
  // 只复制外层与文件表；有新增的文件在 readFile 里单独深复制，未变的投影与旧状态共用、不再改写。
  const state = { ...upgraded, files: { ...upgraded.files } };
  if (previous.liveHooks) state.liveHooks = structuredClone(previous.liveHooks);
  let changed = upgraded !== previous;
  const found = await discover(roots);
  const stats = { files: found.paths.length, scanned: 0, rows: 0, unreadableFiles: 0, ...found.skipped };
  const profiles = roots.map((root) => ({ root: path.resolve(root), id: hash(state.salt, `profile:${path.resolve(root)}`) }));
  for (const p of found.paths) {
    const key = hash(state.salt, `file:${p}`);
    try {
      const profile = profiles.filter((entry) => p.startsWith(entry.root + path.sep)).sort((a, b) => b.root.length - a.root.length)[0]?.id;
      const r = await readFile(p, state.files[key], state.salt, { ...options, profile });
      if (r.file !== state.files[key]) changed = true;
      state.files[key] = r.file; stats.rows += r.rows; stats.scanned += r.rows > 0 ? 1 : 0;
    } catch (e) {
      if (e.code === 'ENOENT' && p.endsWith('.zst')) stats.compressedUnavailable++;
      else stats.unreadableFiles++;
    }
  }
  // 旧文件被上游清理后仍保留数字历史；归档副本由响应身份去重。
  // 每天清一次 430 天以前的条目，历史体积不随使用年限无限增长。
  if (!(state.prunedAt > now - 864e5)) {
    for (const [key, f] of Object.entries(state.files)) state.files[key] = prune(f, now - RETAIN);
    state.prunedAt = now; changed = true;
  }
  // changed 为假表示文件投影与上一轮完全相同，调用方可以跳过整份历史重写。
  return { state, stats, changed, snapshot: summarize(state, { ...options, activeProfiles: profiles.map((p) => p.id) }) };
}

function summarize(state, options = {}) {
  const timezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = options.now || Date.now();
  const cutoff = now - WINDOW;
  const records = new Map(), legacy = new Map(), turns = new Map(), prompts = new Map(), projects = new Map();
  const sessions = new Map(), quotas = new Map(), activity = new Set(), modernTurns = new Set(), modernSessions = new Set();
  const diagnostics = { invalidRows: 0, invalidUsage: 0, missingIdentity: 0, unknownFiles: 0, legacyRecords: 0, unassignedLegacy: 0 };
  const coverage = new Map(), owner = new Map();
  for (const f of Object.values(state.files)) {
    for (const k of ['invalidRows', 'invalidUsage', 'missingIdentity']) diagnostics[k] += f.diagnostics[k];
    if (!f.session || !f.version) diagnostics.unknownFiles++;
    const ckey = `${f.source}:${f.version || 'unknown'}`;
    coverage.set(ckey, { source: f.source, version: f.version, files: (coverage.get(ckey)?.files || 0) + 1 });
    // 直接读定长数组，不逐条展开成对象；owner 记下每条记录所在文件，用来查上下文表。
    for (const key in f.records) {
      const t = f.records[key], best = records.get(key);
      if (!best || t[AT] > best[AT] || t[AT] === best[AT] && total(t) > total(best)) { records.set(key, t); owner.set(t, f); }
      modernSessions.add(f.ctx[t[CTX]][0]);
      if (t[TURN]) modernTurns.add(t[TURN]);
    }
    for (const key in f.legacy) {
      const t = f.legacy[key], best = legacy.get(key);
      if (!best || t[AT] < best[AT]) { legacy.set(key, t); owner.set(t, f); }
    }
    for (const [key, r] of Object.entries(f.turns)) if (!turns.has(key) || r.at < turns.get(key).at) turns.set(key, r);
    for (const [key, r] of Object.entries(f.prompts)) if (!prompts.has(key) || r.at < prompts.get(key).at) prompts.set(key, r);
    for (const minute of Object.keys(f.activity)) activity.add(Number(minute));
    if (f.project) projects.set(f.project, options.projects ? f.projectName : null);
    if (!options.activeProfiles || options.activeProfiles.includes(f.profile)) for (const q of Object.values(f.quotas)) {
      const key = `${f.profile || 'default'}:${q.id}`;
      if (!quotas.has(key) || q.observedAt > quotas.get(key).observedAt) quotas.set(key, { ...q, profile: f.profile || null });
    }
  }
  const events = [...records.values()];
  for (const t of legacy.values()) {
    if (t[TURN] && modernTurns.has(t[TURN])) continue;
    if (!t[TURN] && modernSessions.has(owner.get(t).ctx[t[CTX]][0])) { diagnostics.unassignedLegacy++; continue; }
    events.push(t); diagnostics.legacyRecords++;
  }
  const days = new Map(), dates = new Map();
  const day = (at) => {
    // 各时区偏移与夏令时切换都落在整刻钟上，同一刻钟内日期必然相同；按刻钟缓存省掉逐条格式化。
    const slot = Math.floor(at / 900000);
    let date = dates.get(slot);
    if (date === undefined) { date = dateAt(at, timezone); dates.set(slot, date); }
    if (!days.has(date)) days.set(date, { date, ...emptyUsage(), responses: 0, turns: 0, sessions: 0, prompts: 0, activeMinutes: 0, models: {}, projects: {} });
    return days.get(date);
  };
  for (const t of events.sort((a, b) => a[AT] - b[AT])) {
    const at = t[AT];
    if (at < cutoff || at > now + 60000) continue;
    const [session, project, subagent] = owner.get(t).ctx[t[CTX]], model = t[R.MODEL];
    const d = day(at); addPacked(d, t); d.responses++;
    if (!d.models[model]) d.models[model] = { ...emptyUsage(), responses: 0 };
    addPacked(d.models[model], t); d.models[model].responses++;
    if (project) {
      if (!d.projects[project]) d.projects[project] = { ...emptyUsage(), responses: 0, ...(options.projects && projects.get(project) ? { name: projects.get(project) } : {}) };
      addPacked(d.projects[project], t); d.projects[project].responses++;
    }
    if (!subagent) sessions.set(`${session}:${d.date}`, at);
  }
  for (const t of turns.values()) if (!t.subagent && t.at >= cutoff && t.at <= now + 60000) {
    const d = day(t.at); d.turns++; sessions.set(`${t.session}:${d.date}`, t.at);
  }
  for (const t of prompts.values()) if (!t.subagent && t.at >= cutoff && t.at <= now + 60000) day(t.at).prompts++;
  for (const at of sessions.values()) day(at).sessions++;
  for (const minute of activity) if (minute * 60000 >= cutoff && minute * 60000 <= now + 60000) day(minute * 60000).activeMinutes++;
  return { v: 1, collectedAt: now, timezone, privacy: { projects: options.projects === true }, coverage: [...coverage.values()], diagnostics,
    sessionCount: new Set([...sessions.keys()].map((key) => key.split(':')[0])).size,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    quotas: [...quotas.values()].map((q) => ({ ...q, account: null, origin: 'log', expired: [q.primary, q.secondary].filter(Boolean).every((w) => w.resetsAt * 1000 <= now) })) };
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

module.exports = { VERSION, usage, quota, dateAt, initialState, processRow, projection, collect, summarize, atomicWrite, hash };
