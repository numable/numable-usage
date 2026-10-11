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
  if (typeof ev.cwd === 'string' && ev.cwd) { s.cwd = ev.cwd; const p = projectOf(ev.cwd); s.root = p.root; s.name = p.name; }
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

/**
 * 项目根与名字(本机):worktree 归回所属项目,往上找第一个 git 仓库 —— 与 collect.cjs 的 projectOf 同一算法,
 * 上报时用同一把盐算匿名编号,实时与用量两边的「项目 A」才对得上。
 */
const projMemo = new Map();
function projectOf(cwd) {
  if (projMemo.has(cwd)) return projMemo.get(cwd);
  const stripped = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+.*$/, '');
  let root = stripped;
  for (let d = stripped, i = 0; i < 12; i++) {
    try { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } } catch { break; }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const r = { root, name: path.basename(root) || root };
  projMemo.set(cwd, r);
  return r;
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
    permMs: 0, tools: 0, seq: [], longest: null, tok: { out: 0, in: 0, cw: 0 }, end: null, err: 0, cmp: 0 };
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

const CELL_MS = 2 * 60e3;                     // 多泳道按 2 分钟一格取主要类目(§5.4)
function noteTool(t, cat, now) {
  t.tools++;
  if (Number.isFinite(now)) {
    const slot = Math.min(89, Math.max(0, Math.floor((now - t.s) / CELL_MS)));
    const c = (t.cc || (t.cc = {}))[slot] || (t.cc[slot] = {});
    c[cat] = (c[cat] || 0) + 1;
  }
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
      s.fs = 0;                                   // 你说了新的一句 = 人已经介入,连续失败从头算
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
      s.tools++; noteTool(t, cat, now);
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
        if (!o) { s.tools++; noteTool(t, cat, now); }      // 乱序:Pre 还没到,先在这里记上
        const ms = Number.isFinite(ev.duration_ms) ? ev.duration_ms : (o ? now - o.at : 0);
        if (!t.longest || ms > t.longest[1]) t.longest = [cat, Math.round(ms)];
      }
      // 卡住检测(§6.2):连续失败计数,成功一次清零;每轮的失败数
      if (name === 'PostToolUse') s.fs = 0;
      if (name === 'PostToolUseFailure') { s.fs = (s.fs || 0) + 1; if (t) t.err = (t.err || 0) + 1; }
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
    case 'PreCompact': { s.compactions++; const t = curTurn(s); if (t) t.cmp = (t.cmp || 0) + 1; break; }
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
  let live, changed = false;
  try {
    live = readJson(LIVE, null) || emptyLive();
    const before = stamp(live);
    drain(live);
    prune(live);
    writeJson(LIVE, live);
    changed = stamp(live) !== before;
  } finally { release(); }
  const sync = syncOn(readJson(CONFIG, null));
  if (changed && sync) { try { fs.writeFileSync(DIRTY, String(Date.now())); } catch { /* */ } }
  // 守护进程:本机探活要它;打开同步时,状态一变也要它来推(hook 自己不联网,免得每个事件都起一次网络请求)
  if ((needsDaemon(live) || (changed && sync)) && !process.env.NUMABLE_LIVE_NO_DAEMON) ensureDaemon();
}

async function cmdDaemon() {
  const { tryLock } = require('./collect.cjs');
  if (!tryLock(DAEMON_LOCK)) return;                       // 已有一个在跑
  const bye = () => { try { if (fs.readFileSync(DAEMON_LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(DAEMON_LOCK); } catch { /* */ } };
  process.on('exit', bye);
  let idleSince = null;
  let fast = true;                                         // 有会话在等授权 / 有待推的变化时 2 秒巡检一次
  let lastPush = 0, pushFailAt = 0;
  for (;;) {
    // 可提前唤醒:慢巡检(15 秒)期间 hook 标了「有变化」就立刻处理 —— 否则会话结束 / 进入等授权要等满一个巡检周期才推
    {
      const wait = fast ? Math.min(BEAT_MS, 2000) : BEAT_MS;
      const seen = (() => { try { return fs.statSync(DIRTY).mtimeMs; } catch { return 0; } })();
      for (let t = 0; t < wait; t += 500) {
        await new Promise((r) => setTimeout(r, Math.min(500, wait - t)));
        let m = 0; try { m = fs.statSync(DIRTY).mtimeMs; } catch { /* */ }
        if (m && m !== seen) break;
      }
    }
    if (!liveOn()) break;
    const cfg = readJson(CONFIG, null);
    const sync = syncOn(cfg);
    let dirtyAt = 0; try { dirtyAt = fs.statSync(DIRTY).mtimeMs; } catch { /* 没有待推的 */ }
    const release = lock(5000);
    if (!release) continue;
    let busy = false, snapshot = null, permAny = false;
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
      permAny = Object.values(live.sessions).some((x) => x.state === 'perm');
      snapshot = live;
    } finally { release(); }
    // 推送:有变化(合并 1.5 秒内的连续事件)立刻推;运行中 / 等授权每 60 秒心跳;失败 30 秒后再试
    if (sync && snapshot) {
      const now = Date.now();
      const due = (dirtyAt && now - dirtyAt >= 1500) || (busy && now - lastPush >= HEARTBEAT_MS);
      if (due && now - pushFailAt >= 30e3) {
        let okPush = false;
        try { okPush = await pushLive(snapshot, cfg); } catch (e) { log('push failed', e && e.message); }
        if (okPush) {
          lastPush = now;
          try { if (fs.statSync(DIRTY).mtimeMs === dirtyAt) fs.unlinkSync(DIRTY); } catch { /* 期间又脏了,下一轮再推 */ }
          dirtyAt = 0;
        } else pushFailAt = now;
      }
    }
    // 推完再定下一轮快慢:还有等授权的会话(要尽快发现批准)或还有没推出去的变化 → 2 秒;否则按心跳慢巡检
    fast = permAny || (sync && dirtyAt > 0);
    if (busy || (sync && dirtyAt)) idleSince = null;
    else if (idleSince == null) idleSince = Date.now();
    else if (Date.now() - idleSince > DAEMON_IDLE_MS) break;
  }
  bye();
}

// ---------- 上传(P1:打开「同步到手机」才有)----------
// 设计 §1.2 分档、§3 白名单。这里**显式构造**上报体:只有写在 buildLivePayload 里的字段会离开本机。
const CAT_CODE = { read: 'r', edit: 'e', shell: 's', agent: 'a', web: 'w', browser: 'b', device: 'd', mcp: 'm', ask: 'q', other: 'o' };
const ENDPOINT = process.env.NUMABLE_USAGE_ENDPOINT || 'https://usage.numable.app';
const DIRTY = path.join(STATE_DIR, 'live-dirty');
const LIVE_PUSH_MAX = 60 * 1024;              // 服务端上限 64KB,留余量
const HEARTBEAT_MS = 60e3;                    // 运行中 / 等授权时的心跳推送间隔
const ACTIVE_TURNS = 60;
const ENDED_WINDOW_MS = 6 * 3600e3;           // 已结束的会话只传最大时间窗(6 小时)里的轮

const hash = (salt, v, n) => require('node:crypto').createHash('sha256').update(String(salt) + '|' + v).digest('hex').slice(0, n);

/** 标题脱敏:令牌 / 邮箱 / URL / 长十六进制 / 绝对路径在本机换成 … 再上报(§1.2) */
function redactTitle(t) {
  return String(t)
    .replace(/https?:\/\/\S+/gi, '…')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '…')
    .replace(/(?:^|\s)(?:~|\/)[\w.~-]*(?:\/[\w.-]+)+/g, ' …')
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[bap]|eyJ)[\w-]{8,}\b/g, '…')
    .replace(/\b[a-f0-9]{24,}\b/gi, '…')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
}

function encodeTurn(t) {
  const seq = t.seq.map(([c, n]) => (CAT_CODE[c] || 'o') + Math.min(n, 9999)).join('');
  let cells = '';
  if (t.cc) {
    const max = Math.max(-1, ...Object.keys(t.cc).map(Number));
    for (let i = 0; i <= max; i++) {
      const c = t.cc[i];
      if (!c) { cells += '.'; continue; }
      const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
      cells += CAT_CODE[top] || 'o';
    }
  }
  return {
    n: t.n, s: t.s, e: t.e, perm: t.permMs, tools: t.tools, seq, cells,
    long: t.longest ? [CAT_CODE[t.longest[0]] || 'o', t.longest[1]] : null,
    out: t.tok.out, in: t.tok.in, cw: t.tok.cw, end: t.end, err: t.err || 0, cmp: t.cmp || 0,
  };
}

/**
 * 上报体。opts:{ salt, titles, names, now, alive }。
 * L1 恒有:匿名会话号 / 匿名项目号 / 状态 / 时刻 / 逐轮结构与数字;names → + 项目文件夹名;titles → + 脱敏后的标题。
 */
function buildLivePayload(live, opts) {
  const now = opts.now || Date.now();
  const alive = opts.alive || pidAlive;
  const salt = opts.salt || 'nosalt';
  const sessions = Object.values(live.sessions).map((s) => {
    const st = derive(s, now, alive);
    const ended = s.state === 'ended' || s.state === 'lost' || st === 'lost';
    const turns = (ended ? s.turns.filter((t) => (t.e || now) > now - ENDED_WINDOW_MS) : s.turns).slice(-ACTIVE_TURNS);
    const r = {
      sid: hash(salt, 'sid:' + s.sid, 12),
      proj: s.root ? hash(salt, s.root, 10) : null,
      state: st === 'parked' ? 'input' : st,          // 搁置由服务端按时刻推
      changedAt: s.changedAt, changeKind: st === 'lost' && s.state !== 'lost' ? 'lost' : s.changeKind,
      startAt: s.startAt, lastAt: s.lastEventAt, beatAt: s.beatAt || s.lastEventAt, endAt: s.endAt || null,
      permSince: s.perm ? s.perm.since : null,
      model: s.model, tools: s.tools, errors: s.errors, compactions: s.compactions, fs: s.fs || 0,
      turns: turns.map(encodeTurn),
      subs: s.subs.slice(-30).map((x) => [x.s, x.e || 0, x.tools || 0]),
    };
    if (opts.names && s.name) r.pname = String(s.name).slice(0, 40);
    if (opts.titles && s.title) { const t = redactTitle(s.title); if (t) r.title = t; }
    return r;
  });
  const body = { tier: opts.titles ? 3 : opts.names ? 2 : 1, devNow: now, sessions };
  // 超限:先丢已结束会话的逐轮,再丢最旧的已结束会话
  const size = () => Buffer.byteLength(JSON.stringify(body));
  const endedFirst = () => body.sessions.filter((x) => x.state === 'ended' || x.state === 'lost').sort((a, b) => a.changedAt - b.changedAt);
  for (const x of endedFirst()) { if (size() <= LIVE_PUSH_MAX) break; x.turns = []; }
  while (size() > LIVE_PUSH_MAX && endedFirst().length) body.sessions.splice(body.sessions.indexOf(endedFirst()[0]), 1);
  return body;
}

const syncOn = (cfg) => !!(cfg && cfg.live === true && cfg.liveSync === true && cfg.writeToken);

async function pushLive(live, cfg) {
  const h = readJson(HISTORY, null);
  const { deviceId } = require('./collect.cjs');
  const device = deviceId(cfg);
  const body = buildLivePayload(live, { salt: h && h.salt, titles: cfg.titles === true, names: cfg.projectNames === true });
  const res = await fetch(`${ENDPOINT}/live?dev=${device}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.writeToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return res.ok;
}

/** 有没有「值得马上推」的变化:任何会话的状态或变化时刻变了。 */
const stamp = (live) => Object.values(live.sessions).map((s) => `${s.sid}:${s.state}:${s.changedAt}`).sort().join('|');

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

function cmdLive(v, w) {
  const cur = readJson(CONFIG, {}) || {};
  if (v === 'sync') {
    if (w === 'on' || w === 'off') {
      cur.liveSync = w === 'on';
      if (cur.liveSync) cur.live = true; else cur.liveOffAt = Date.now();   // 手机上更早的请求不再把它打开
      writeJson(CONFIG, cur);
      console.log(w === 'on'
        ? (cur.writeToken
          ? '已打开同步:各会话的状态与每一轮的结构会上传,在 Numable 里就能看到(工具「Claude Code 用量」→ 实时)。\n上传的只有:匿名会话号、匿名项目号、状态、时刻、工具类目与次数、token;没有提示词、命令、文件名。\n要显示项目名:--projects on;要显示会话标题:--titles on。'
          : '已打开同步,但这台电脑还没接上 Numable —— 先运行一次 Claude Code 会话让它建好空间,或用 --join 加入已有空间。')
        : '已关闭同步。服务端的实时数据 24 小时内自动清掉。');
      return;
    }
    console.log(syncOn(cur) ? '同步到手机:已打开。关掉:--live sync off' : '同步到手机:未打开。打开:--live sync on');
    return;
  }
  if (v === 'on' || v === 'off') {
    cur.live = v === 'on';
    if (!cur.live) cur.liveOffAt = Date.now();
    writeJson(CONFIG, cur);
    console.log(v === 'on'
      ? '已打开实时会话:从下一次事件起记录各会话的状态与每一轮的结构(只在本机,不上传)。'
      : '已关闭实时会话。本机已记录的 live.json 保留,可手动删除。');
    return;
  }
  console.log(cur.live === true
    ? `实时会话:已打开。同步到手机:${syncOn(cur) ? '已打开' : '未打开(--live sync on)'}。关掉:--live off`
    : '实时会话:未打开。打开:--live on');
}

function cmdTitles(v) {
  const cur = readJson(CONFIG, {}) || {};
  if (v === 'on' || v === 'off') {
    cur.titles = v === 'on';
    writeJson(CONFIG, cur);
    console.log(v === 'on'
      ? '已打开:会附上会话标题(最多 80 字;其中的网址、邮箱、路径、密钥样的长串会先在本机换成 …),用在实时会话与每日回顾里。随时 --titles off。'
      : '已关闭:不再上传会话标题,服务端旧值在下一次同步时被覆盖掉。');
    return;
  }
  console.log(cur.titles === true ? '会话标题:上传(--titles off 关掉)' : '会话标题:不上传(--titles on 打开)');
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
  if (arg === '--live') return cmdLive(process.argv[3], process.argv[4]);
  if (arg === '--titles') return cmdTitles(process.argv[3]);
  if (arg === '--sessions') return cmdSessions();
}

if (require.main === module) {
  main().catch((e) => { log('fatal (swallowed)', e && e.message); });
}

module.exports = { buildLivePayload, redactTitle, encodeTurn, approvedAt, etimeMs, catOf, reduce, derive, prune, counts, statusLine, sessionRows, emptyLive, readTokens, interruptedSince, PARK_MS };
