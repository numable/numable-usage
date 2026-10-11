#!/usr/bin/env node
/**
 * numable-usage · 实时会话(P0:只在本机)
 *
 * 把 Claude Code 的 hook 事件归并成「每个会话现在什么状态、这一轮干了什么」,落本机 live.json。
 * 设计见 Numable meta 仓 doc/ccusage-live-timeline.md(§1.4 状态词表、§2 采集、§4A 逐轮记录)。
 * P0 不联网:这里写的东西一个字节都不离开本机;上云在 P1 另加,届时按 §1.2 分档白名单构造上报体。
 *
 * 入口:
 *   --hook          hook 调用(stdin 是 hook 输入 JSON)。只追加一行事件再归并,立刻返回。
 *   --daemon        心跳守护进程:有会话在跑 / 等授权时活着,确认 Claude Code 进程还在、补「被打断」。
 *   --statusline    给 Claude Code 状态栏用的一行字
 *   --live [on|off] 看 / 开关实时会话
 *   --sessions      列出当前各会话(调试 / /numable-usage 用)
 *
 * 读取范围(本机):hook 输入里的 session_id / cwd / transcript_path / tool_name / tool_use_id /
 *   duration_ms / notification_type / session_title / source / model / agent_id / agent_type / reason;
 *   会话记录只读 assistant 行的 usage 数字与 message.id / requestId、user 行是不是「被打断」标记。
 *   **不读** prompt 正文、工具参数、工具结果、回复正文。
 *
 * 失败姿态同 collect.cjs:任何异常静默吞掉,绝不打断会话。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const T0 = Date.now();                       // 事件时刻 = 本进程起来的时刻(尽量贴近 hook 触发)
const STATE_DIR = process.env.NUMABLE_USAGE_STATE_DIR || path.join(os.homedir(), '.claude', 'numable-usage');
const CONFIG = path.join(STATE_DIR, 'config.json');
const LIVE = path.join(STATE_DIR, 'live.json');
const QUEUE = path.join(STATE_DIR, 'live-events.jsonl');
const LOCK = path.join(STATE_DIR, 'live.lock');
const DAEMON_LOCK = path.join(STATE_DIR, 'live-daemon.pid');
const HISTORY = path.join(STATE_DIR, 'history.json');
const DEBUG = !!process.env.NUMABLE_USAGE_DEBUG;
const log = (...a) => { if (DEBUG) console.error('[numable-live]', ...a); };

const PARK_MS = 30 * 60e3;                   // 等你输入超过 30 分钟 → 搁置
const KEEP_ENDED_MS = 24 * 3600e3;           // 结束的会话本机留 24 小时
const MAX_TURNS = 200;                       // 每会话本机最多留多少轮
const BEAT_MS = Number(process.env.NUMABLE_LIVE_BEAT_MS) || 15e3;                        // 守护进程巡检间隔(P1 上云时另按 60 秒节流推送)
const DAEMON_IDLE_MS = Number(process.env.NUMABLE_LIVE_IDLE_MS) || 2 * 60e3;             // 没有在跑 / 等授权的会话这么久,守护进程退出

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, p);
};
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const liveOn = () => { const c = readJson(CONFIG, null); return !!(c && c.live === true); };

// ---------- 工具类目(§2.3:只记类目,不记参数) ----------
function catOf(name) {
  if (typeof name !== 'string') return 'other';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edit';
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return 'read';
  if (/^(Bash|BashOutput|KillShell|PowerShell)$/.test(name)) return 'shell';
  if (/^(Agent|Task)$/.test(name)) return 'agent';
  if (/^(WebSearch|WebFetch)$/.test(name)) return 'web';
  if (name === 'AskUserQuestion') return 'ask';
  if (name.startsWith('mcp__')) {
    if (/browser|chrome|playwright|puppeteer/i.test(name)) return 'browser';
    if (/simulator|computer-use|computer_use|android|adb/i.test(name)) return 'device';
    return 'mcp';
  }
  return 'other';
}

// ---------- 归并(纯函数,测试直接喂事件) ----------
const emptyLive = () => ({ v: 1, sessions: {} });

function sessionOf(live, ev, now) {
  const sid = ev.session_id;
  let s = live.sessions[sid];
  if (!s) {
    s = live.sessions[sid] = {
      sid, startAt: now, lastEventAt: now, changedAt: now, changeKind: 'start', state: 'input',
      cwd: null, name: null, title: null, model: null, pid: null, transcript: null, off: 0, seen: [],
      turns: [], tools: 0, errors: 0, compactions: 0, open: {}, closed: [], subs: [], perm: null,
    };
  }
  if (typeof ev.cwd === 'string' && ev.cwd) { s.cwd = ev.cwd; s.name = projectName(ev.cwd); }
  if (typeof ev.transcript_path === 'string' && ev.transcript_path && s.transcript !== ev.transcript_path) {
    // 第一次见到这份会话记录:从当前末尾读起 —— 插件中途打开时,之前的 token 不该全算进这一轮
    s.transcript = ev.transcript_path;
    try { s.off = fs.statSync(s.transcript).size; } catch { s.off = 0; }
    s.seen = [];
  }
  if (typeof ev.session_title === 'string' && ev.session_title.trim()) s.title = ev.session_title.trim().slice(0, 80);
  if (typeof ev.model === 'string' && ev.model) s.model = ev.model;
  if (Number.isInteger(ev._ppid) && ev._ppid > 1) s.pid = ev._ppid;
  s.lastEventAt = Math.max(s.lastEventAt, now);
  return s;
}

/** 项目名(本机显示用):worktree 归回所属项目,往上找第一个 git 仓库。只在本机,P1 上报走匿名编号。 */
const projMemo = new Map();
function projectName(cwd) {
  if (projMemo.has(cwd)) return projMemo.get(cwd);
  const stripped = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+.*$/, '');
  let root = stripped;
  for (let d = stripped, i = 0; i < 12; i++) {
    try { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } } catch { break; }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const n = path.basename(root) || root;
  projMemo.set(cwd, n);
  return n;
}

const subOf = (s, id) => s.subs.find((x) => x.id === id && x.e == null) || null;
const curTurn = (s) => { const t = s.turns[s.turns.length - 1]; return t && t.e == null ? t : null; };

/** 主会话没有进行中的轮次时该是什么状态:还有后台子代理在跑 = 运行中,否则等你输入。 */
const restState = (s) => (curTurn(s) || s.subs.some((x) => x.e == null) ? 'running' : 'input');

function setState(s, state, kind, now) {
  if (s.state === state && kind !== 'turn') return;
  s.state = state; s.changedAt = now; s.changeKind = kind;
}

function openTurn(s, now) {
  const t = { n: (s.turns.length ? s.turns[s.turns.length - 1].n : 0) + 1, s: now, e: null,
    permMs: 0, tools: 0, seq: [], longest: null, tok: { out: 0, in: 0, cw: 0 }, end: null };
  s.turns.push(t);
  if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
  return t;
}

function closeTurn(s, end, now) {
  const t = curTurn(s);
  if (!t) return null;
  leavePerm(s, now);
  t.e = Math.max(now, t.s); t.end = end;
  s.open = {};
  return t;
}

function leavePerm(s, now) {
  if (!s.perm) return;
  const t = curTurn(s);
  if (t) t.permMs += Math.max(0, now - s.perm.since);
  s.perm = null;
}

function noteTool(t, cat) {
  t.tools++;
  const last = t.seq[t.seq.length - 1];
  if (last && last[0] === cat) last[1]++; else t.seq.push([cat, 1]);
  if (t.seq.length > 40) { t.seq.splice(0, t.seq.length - 40); }
}

/**
 * 把一条 hook 事件并进 live。ev = hook 输入 + { _t: 时刻, _ppid: 父进程号 }。
 * hook 是 async 并发跑的,同一工具的 Pre / Post 可能乱序到达 —— 乱序容忍见 closed 表。
 */
function reduce(live, ev, opts = {}) {
  if (!ev || typeof ev.session_id !== 'string' || !ev.session_id) return live;
  if (ev.hook_event_name === 'SessionEnd' && !live.sessions[ev.session_id]) return live;   // 没见过的会话只来一个「结束」:不建空记录
  const now = Number.isFinite(ev._t) ? ev._t : Date.now();
  const s = sessionOf(live, ev, now);
  const name = ev.hook_event_name;
  const inSub = typeof ev.agent_id === 'string' && ev.agent_id && name !== 'SubagentStart' && name !== 'SubagentStop';

  switch (name) {
    case 'SessionStart': {
      if (ev.source === 'clear') { closeTurn(s, 'clear', now); setState(s, 'input', 'start', now); }
      else if (s.state === 'ended' || s.state === 'lost') { setState(s, 'input', 'start', now); s.endAt = null; }
      break;
    }
    case 'UserPromptSubmit': {
      // 上一轮没收尾就来了新的一句 = 上一轮被你打断了(Esc 不一定触发 Stop)
      if (curTurn(s)) closeTurn(s, 'interrupt', now);
      openTurn(s, now);
      setState(s, 'running', 'turn', now);
      break;
    }
    case 'PreToolUse': {
      const id = ev.tool_use_id;
      if (id && s.closed.includes(id)) break;          // Post 先到了,这条只是迟到的 Pre
      const cat = catOf(ev.tool_name);
      // 子代理的工具调用:后台子代理在主轮结束后还会继续调工具 —— 只记到子代理名下,绝不替主会话开新的一轮
      if (inSub) { const sub = subOf(s, ev.agent_id); if (sub) sub.tools = (sub.tools || 0) + 1; s.tools++; if (id) s.open[id] = { cat, at: now, sub: true }; break; }
      const t = curTurn(s) || (s.state === 'ended' ? null : openTurn(s, now));
      if (!t) break;
      s.tools++; noteTool(t, cat);
      if (id) s.open[id] = { cat, at: now };
      if (!inSub && s.state !== 'perm' && s.state !== 'running') setState(s, 'running', 'resume', now);
      break;
    }
    case 'PermissionRequest':
    case 'Notification': {
      if (name === 'Notification' && ev.notification_type !== 'permission_prompt') break;
      if (s.state === 'perm' || s.state === 'ended') break;
      if (!curTurn(s) && !inSub) openTurn(s, now);    // 子代理弹授权:也是在等你,但不替主会话开轮
      s.perm = { since: now };
      setState(s, 'perm', 'perm', now);
      break;
    }
    case 'PermissionDenied':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const id = ev.tool_use_id;
      const t = curTurn(s);
      const o = id ? s.open[id] : null;
      if (id) {
        delete s.open[id];
        s.closed.push(id); if (s.closed.length > 64) s.closed.shift();
      }
      if (t && name !== 'PermissionDenied' && !inSub && !(o && o.sub)) {
        const cat = o ? o.cat : catOf(ev.tool_name);
        if (!o) { s.tools++; noteTool(t, cat); }      // 乱序:Pre 还没到,先在这里记上
        const ms = Number.isFinite(ev.duration_ms) ? ev.duration_ms : (o ? now - o.at : 0);
        if (!t.longest || ms > t.longest[1]) t.longest = [cat, Math.round(ms)];
      }
      if (name === 'PostToolUseFailure') { s.errors++; if (ev.is_interrupt && !inSub) { closeTurn(s, 'interrupt', now); setState(s, 'input', 'interrupt', now); break; } }
      if (s.state === 'perm') { leavePerm(s, now); setState(s, restState(s), 'resume', now); }
      break;
    }
    case 'Stop':
    case 'StopFailure': {
      const t = closeTurn(s, name === 'Stop' ? 'ok' : 'error', now);
      if (t && opts.tokens) addTokens(s, t, opts.tokens);
      setState(s, restState(s), name === 'Stop' ? 'done' : 'error', now);
      break;
    }
    case 'SubagentStart': {
      if (ev.agent_id) { s.subs.push({ id: ev.agent_id, type: String(ev.agent_type || '').slice(0, 40), s: now, e: null }); if (s.subs.length > 60) s.subs.shift(); }
      break;
    }
    case 'SubagentStop': {
      const sub = s.subs.find((x) => x.id === ev.agent_id && x.e == null);
      if (sub) sub.e = now;
      if (s.state === 'running' && !curTurn(s) && restState(s) === 'input') setState(s, 'input', 'done', now);
      break;
    }
    case 'PreCompact': s.compactions++; break;
    case 'SessionEnd': {
      closeTurn(s, 'ended', now);
      s.endAt = now;
      setState(s, 'ended', 'end', now);
      break;
    }
    default: break;
  }
  return live;
}

function addTokens(s, t, tok) {
  t.tok.out += tok.out || 0; t.tok.in += tok.in || 0; t.tok.cw += tok.cw || 0;
}

/** 从会话记录增量读 token(按 message.id + requestId 去重;cache_read 不计,口径同用量)。 */
function readTokens(s) {
  const r = { out: 0, in: 0, cw: 0 };
  if (!s.transcript) return r;
  let fd;
  try {
    const size = fs.statSync(s.transcript).size;
    if (size < s.off) s.off = 0;                    // 文件被换掉 / 截短
    if (size === s.off) return r;
    const len = Math.min(size - s.off, 32 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(s.transcript, 'r');
    fs.readSync(fd, buf, 0, len, s.off);
    const end = buf.lastIndexOf(0x0a);              // 只吃到最后一个完整行
    if (end < 0) return r;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line || line.indexOf('"assistant"') < 0) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant' || o.isSidechain) continue;
      const m = o.message || {}; const u = m.usage;
      if (!u) continue;
      const k = `${m.id || ''}|${o.requestId || ''}`;
      if (s.seen.includes(k)) continue;
      s.seen.push(k); if (s.seen.length > 64) s.seen.shift();
      r.out += u.output_tokens || 0; r.in += u.input_tokens || 0; r.cw += u.cache_creation_input_tokens || 0;
    }
    s.off += end + 1;
  } catch (e) { log('readTokens', e && e.message); }
  finally { if (fd != null) try { fs.closeSync(fd); } catch { /* */ } }
  return r;
}

/** 会话记录尾部最后一条「真人」行是不是「被打断」标记,且晚于 since。 */
function interruptedSince(transcript, since) {
  let fd;
  try {
    const size = fs.statSync(transcript).size;
    const len = Math.min(size, 16 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(transcript, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.startsWith('{') || line.indexOf('"user"') < 0) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'user' || o.isSidechain) continue;
      const ts = Date.parse(o.timestamp || '');
      if (!(ts > since)) return false;
      const c = o.message && o.message.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('') : '';
      return txt.startsWith('[Request interrupted');
    }
  } catch { /* 读不到就当没打断 */ }
  finally { if (fd != null) try { fs.closeSync(fd); } catch { /* */ } }
  return false;
}

/**
 * 批准那一刻 Claude Code 不发任何 hook 事件、会话记录里也不写 —— 长命令批准后要等跑完 PostToolUse 才退出「等你授权」,
 * 期间一直错报。e2e 实测:Bash 工具的命令是 Claude Code 的**直接子进程** `/bin/zsh -c source ~/.claude/shell-snapshots/…`。
 * 等授权时若出现一个晚于弹窗启动的这种子进程 = 你已批准、命令正在跑;返回它的启动时刻,否则 null。
 * 只覆盖 Bash(其它工具批准后一般立刻跑完,PostToolUse 很快就到);Windows 没有 ps,退回只认 PostToolUse。
 */
function approvedAt(pid, since, psOut) {
  if (!pid) return null;
  let out = psOut;
  if (out == null) {
    if (process.platform === 'win32') return null;
    try { out = require('node:child_process').execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf8', timeout: 3000 }); } catch { return null; }
  }
  const now = Date.now();
  let best = null;
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || Number(m[2]) !== pid || m[4].indexOf('shell-snapshots') < 0) continue;
    const startedAt = now - etimeMs(m[3]);
    if (startedAt > since && (best == null || startedAt < best)) best = startedAt;
  }
  return best;
}
const etimeMs = (e) => {                                     // [[dd-]hh:]mm:ss
  const [d, rest] = e.includes('-') ? e.split('-') : ['0', e];
  const p = rest.split(':').map(Number);
  while (p.length < 3) p.unshift(0);
  return ((Number(d) * 24 + p[0]) * 3600 + p[1] * 60 + p[2]) * 1000;
};

/** 显示用的状态(§1.4):在存储状态上叠加「搁置」「可能已断开」两个推导态。 */
function derive(s, now = Date.now(), alive = pidAlive) {
  if ((s.state === 'running' || s.state === 'perm') && s.pid && !alive(s.pid)) return 'lost';
  if (s.state === 'input' && now - s.changedAt > PARK_MS) return 'parked';
  return s.state;
}

function prune(live, now = Date.now()) {
  for (const [sid, s] of Object.entries(live.sessions)) {
    const gone = s.state === 'ended' || s.state === 'lost' ? s.endAt || s.changedAt : null;
    if ((gone && now - gone > KEEP_ENDED_MS) || now - s.lastEventAt > 3 * KEEP_ENDED_MS) delete live.sessions[sid];
  }
}

// ---------- 队列 + 锁 ----------
// hook 设成 async 后会并发:每个 hook 先 O_APPEND 追加一行(小于 PIPE_BUF 的追加是原子的),
// 再抢锁把队列整批按时刻排序归并 —— 抢不到锁就算了,持锁那个会把这一行一起吃掉。
function lock(waitMs = 3000) {
  const { tryLock } = require('./collect.cjs');
  const until = Date.now() + waitMs;
  for (;;) {
    try { if (tryLock(LOCK)) return () => { try { fs.unlinkSync(LOCK); } catch { /* */ } }; } catch { return null; }
    if (Date.now() >= until) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);   // 同步睡 25ms,不占 CPU
  }
}

function drain(live) {
  let raw = '';
  try { raw = fs.readFileSync(QUEUE, 'utf8'); } catch { return 0; }
  const end = raw.lastIndexOf('\n');
  if (end < 0) return 0;
  const evs = [];
  for (const line of raw.slice(0, end).split('\n')) { try { evs.push(JSON.parse(line)); } catch { /* 坏行跳过 */ } }
  evs.sort((a, b) => (a._t || 0) - (b._t || 0));
  for (const ev of evs) {
    const s0 = live.sessions[ev.session_id];
    const tokens = (ev.hook_event_name === 'Stop' || ev.hook_event_name === 'StopFailure')
      ? readTokens(s0 || sessionOf(live, ev, ev._t)) : null;
    reduce(live, ev, { tokens });
  }
  // 吃掉的部分截掉;持锁期间别人追加的尾巴保留
  try {
    const now = fs.readFileSync(QUEUE, 'utf8');
    fs.writeFileSync(QUEUE, now.slice(end + 1));
  } catch { /* */ }
  return evs.length;
}

function needsDaemon(live) {
  return Object.values(live.sessions).some((s) => s.state === 'running' || s.state === 'perm');
}

function ensureDaemon() {
  const pid = parseInt((() => { try { return fs.readFileSync(DAEMON_LOCK, 'utf8'); } catch { return ''; } })(), 10);
  if (pidAlive(pid)) return;
  try {
    spawn(process.execPath, [__filename, '--daemon'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  } catch (e) { log('spawn daemon failed', e && e.message); }
}

// ---------- 入口 ----------
async function cmdHook() {
  if (!liveOn()) return;
  let input = '';
  for await (const c of process.stdin) input += c;
  let ev; try { ev = JSON.parse(input); } catch { return; }
  // 只留归并要用的字段:prompt / tool_input / tool_response / last_assistant_message 一律不落盘
  const keep = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'tool_name', 'tool_use_id', 'duration_ms',
    'is_interrupt', 'notification_type', 'session_title', 'source', 'model', 'agent_id', 'agent_type', 'reason'];
  const slim = { _t: T0, _ppid: process.ppid };
  for (const k of keep) if (ev[k] !== undefined) slim[k] = typeof ev[k] === 'string' ? ev[k].slice(0, 300) : ev[k];
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(QUEUE, JSON.stringify(slim) + '\n');
  const release = lock();
  if (!release) return;
  let live;
  try {
    live = readJson(LIVE, null) || emptyLive();
    drain(live);
    prune(live);
    writeJson(LIVE, live);
  } finally { release(); }
  if (needsDaemon(live) && !process.env.NUMABLE_LIVE_NO_DAEMON) ensureDaemon();
}

async function cmdDaemon() {
  const { tryLock } = require('./collect.cjs');
  if (!tryLock(DAEMON_LOCK)) return;                       // 已有一个在跑
  const bye = () => { try { if (fs.readFileSync(DAEMON_LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(DAEMON_LOCK); } catch { /* */ } };
  process.on('exit', bye);
  let idleSince = null;
  let fast = true;                                         // 有会话在等授权时 2 秒巡检一次,批准后尽快翻回运行中
  for (;;) {
    await new Promise((r) => setTimeout(r, fast ? Math.min(BEAT_MS, 2000) : BEAT_MS));
    if (!liveOn()) break;
    const release = lock(5000);
    if (!release) continue;
    let busy = false;
    try {
      const live = readJson(LIVE, null) || emptyLive();
      drain(live);
      const now = Date.now();
      for (const s of Object.values(live.sessions)) {
        if (s.state !== 'running' && s.state !== 'perm') continue;
        if (s.pid && !pidAlive(s.pid)) {               // Claude Code 进程没了:不再替它心跳
          closeTurn(s, 'lost', now); s.endAt = now; setState(s, 'lost', 'lost', now);
          continue;
        }
        if (s.state === 'perm' && s.perm) {
          const at = approvedAt(s.pid, s.perm.since + 500);   // 0.5s 余量:etime 只到秒
          if (at != null) { leavePerm(s, Math.max(at, s.perm.since)); setState(s, 'running', 'approved', now); }
        }
        const t = curTurn(s);
        if (s.state === 'running' && t && s.transcript && interruptedSince(s.transcript, t.s)) {
          closeTurn(s, 'interrupt', now); setState(s, 'input', 'interrupt', now);
          continue;
        }
        s.beatAt = now; busy = true;
      }
      prune(live, now);
      writeJson(LIVE, live);
      fast = Object.values(live.sessions).some((x) => x.state === 'perm');
    } finally { release(); }
    if (busy) idleSince = null;
    else if (idleSince == null) idleSince = Date.now();
    else if (Date.now() - idleSince > DAEMON_IDLE_MS) break;
  }
  bye();
}

// ---------- 展示 ----------
const fmtN = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const fmtDur = (ms) => {
  const m = Math.floor(ms / 60e3);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1e3))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};
const CAT_ZH = { edit: '改代码', read: '读代码', shell: '跑命令', agent: '派子代理', web: '查资料', ask: '问你', browser: '操作浏览器', device: '操作设备', mcp: '调外部工具', other: '其它工具' };
const STATE_ZH = { running: '运行中', perm: '等你授权', input: '等你输入', parked: '搁置', lost: '可能已断开', ended: '已结束' };
const STATE_ICON = { running: '▶', perm: '⚠', input: '⏸', parked: '⏸', lost: '✕', ended: '■' };

/** 并行 = 运行中 + 等你授权 + 等你输入(§1.4)。 */
function counts(live, now = Date.now(), alive = pidAlive) {
  const c = { running: 0, perm: 0, input: 0, parked: 0, lost: 0, ended: 0 };
  for (const s of Object.values(live.sessions)) c[derive(s, now, alive)]++;
  c.parallel = c.running + c.perm + c.input;
  return c;
}

function todayTokens() {
  const h = readJson(HISTORY, null);
  const d = new Date();
  const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = h && h.days && h.days[k];
  return day ? (day.out || 0) + (day.in || 0) + (day.c1 || 0) : null;
}

function statusLine(live, now = Date.now(), alive = pidAlive) {
  const c = counts(live, now, alive);
  const parts = [];
  if (c.running) parts.push(`▶ ${c.running} 在跑`);
  if (c.perm) parts.push(`⚠ ${c.perm} 等授权`);
  if (c.input) parts.push(`⏸ ${c.input} 等你`);
  if (!parts.length) parts.push('没有在跑的会话');
  const tok = todayTokens();
  if (tok != null) parts.push(`今天 ${fmtN(tok)}`);
  return parts.join(' · ');
}

function sessionRows(live, now = Date.now(), alive = pidAlive) {
  const order = { perm: 0, input: 1, running: 2, parked: 3, lost: 4, ended: 5 };
  return Object.values(live.sessions)
    .map((s) => ({ s, st: derive(s, now, alive) }))
    .sort((a, b) => order[a.st] - order[b.st] || b.s.changedAt - a.s.changedAt)
    .map(({ s, st }) => {
      const t = s.turns[s.turns.length - 1];
      const run = s.turns.reduce((a, x) => a + ((x.e || now) - x.s - x.permMs), 0) - (s.perm ? now - s.perm.since : 0);   // 正在等的授权不算实跑
      const tok = s.turns.reduce((a, x) => a + x.tok.out + x.tok.in + x.tok.cw, 0);
      let doing = s.title || '';
      if (st === 'running' && t && t.seq.length) doing = `正在${CAT_ZH[t.seq[t.seq.length - 1][0]] || '干活'}` + (s.title ? ` · ${s.title}` : '');
      const since = st === 'running' && t ? now - t.s : now - s.changedAt;
      return { st, line: `${STATE_ICON[st]} ${STATE_ZH[st].padEnd(5, ' ')} ${fmtDur(since).padStart(5)}  ${String(s.name || '?').padEnd(14)} ${s.turns.length} 轮 · 实跑 ${fmtDur(run)} · ${fmtN(tok)}  ${doing}` };
    });
}

function cmdLive(v) {
  const cur = readJson(CONFIG, {}) || {};
  if (v === 'on' || v === 'off') {
    cur.live = v === 'on';
    writeJson(CONFIG, cur);
    console.log(v === 'on'
      ? '已打开实时会话:从下一次事件起记录各会话的状态与每一轮的结构(只在本机,不上传)。'
      : '已关闭实时会话。本机已记录的 live.json 保留,可手动删除。');
    return;
  }
  console.log(cur.live === true ? '实时会话:已打开(只在本机)。关掉:--live off' : '实时会话:未打开。打开:--live on');
}

function cmdSessions() {
  const live = readJson(LIVE, null) || emptyLive();
  const rows = sessionRows(live);
  console.log(statusLine(live));
  if (!rows.length) { console.log(liveOn() ? '(还没有记录到会话)' : '(实时会话未打开:--live on)'); return; }
  for (const r of rows) console.log(r.line);
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--hook') return cmdHook();
  if (arg === '--daemon') return cmdDaemon();
  if (arg === '--statusline') {
    // 状态栏会把会话 JSON 喂进 stdin,这里不需要它
    const live = readJson(LIVE, null) || emptyLive();
    process.stdout.write(liveOn() ? statusLine(live) : '');
    return;
  }
  if (arg === '--live') return cmdLive(process.argv[3]);
  if (arg === '--sessions') return cmdSessions();
}

if (require.main === module) {
  main().catch((e) => { log('fatal (swallowed)', e && e.message); });
}

module.exports = { approvedAt, etimeMs, catOf, reduce, derive, prune, counts, statusLine, sessionRows, emptyLive, readTokens, interruptedSince, PARK_MS };
