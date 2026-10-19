/**
 * numable-usage · 实时会话(source = claude-code-live)
 *
 * 设计:Numable meta 仓 doc/ccusage-live-timeline.md §3。
 * - 每个空间一个 Durable Object(LiveSpace),每台设备一行,整份覆盖写;**不写 D1**(D1 免费写额度扛不住每分钟心跳)。
 * - 白名单显式构造(同 sanitizeClaudeCode):只有这里写出来的字段能进存储。
 *   档位 tier:1 = 只有结构与数字;2 = + 项目文件夹名;3 = + 会话标题。低档发来的名字 / 标题直接丢。
 * - 只留 24 小时(live 是「今天」的事);更早的逐轮记录只在用户本机。
 * - 设备时钟偏差:推送带 devNow,收到时记 skew = 服务端时刻 − devNow,读时把该设备所有时间戳校到服务端时钟。
 */

export const LIVE_MAX_BODY = 64 * 1024;
const MAX_DEVICES = 20;
const MAX_SESSIONS = 40;
const MAX_TURNS = 60;
const KEEP_MS = 24 * 3600e3;
const LOST_MS = 3 * 60e3;            // 运行中 / 等授权却 3 分钟没心跳 = 可能已断开
const PARK_MS = 30 * 60e3;           // 等你输入 30 分钟 = 搁置
const WRITES_PER_MIN = 40;

const int = (v, max = 2 ** 53 - 1) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0;
const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const oneOf = (v, set, fb = null) => (set.includes(v) ? v : fb);
const MODEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const PROJ_RE = /^[a-f0-9]{8,16}$/;
const STATES = ['running', 'perm', 'input', 'lost', 'ended'];
const KINDS = ['start', 'turn', 'resume', 'perm', 'approved', 'done', 'error', 'interrupt', 'lost', 'end'];
const ENDS = ['ok', 'interrupt', 'error', 'lost', 'ended', 'clear'];
const CATS = 'reasawbdmqo';                    // 读 改 跑 子代理 联网 浏览器 设备 MCP 问你 其它(见插件 CAT_CODE)
const SEQ_RE = new RegExp(`^([${CATS}]\\d{1,4}){0,40}$`);
const CELLS_RE = new RegExp(`^[${CATS}.]{0,90}$`);
/** 去控制字符、截断 —— 名字与标题是仅有的两种自由文本,且只在对应档位才收 */
const cleanText = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : '');

function sanitizeTurn(t) {
  if (!t || typeof t !== 'object') return null;
  const s = intOrNull(t.s);
  if (!s) return null;
  const long = Array.isArray(t.long) && CATS.includes(t.long[0]) ? [t.long[0], int(t.long[1], 864e5)] : null;
  return {
    ...(typeof t.id === 'string' && /^[a-f0-9]{8,16}$/.test(t.id) ? { id: t.id } : {}),
    n: int(t.n, 1e6), s, e: intOrNull(t.e), perm: int(t.perm, 864e5), tools: int(t.tools, 1e6),
    seq: typeof t.seq === 'string' && SEQ_RE.test(t.seq) ? t.seq : '',
    cells: typeof t.cells === 'string' && CELLS_RE.test(t.cells) ? t.cells : '',
    long, out: int(t.out), in: int(t.in), cw: int(t.cw),
    end: oneOf(t.end, ENDS, null), err: int(t.err, 1e5), cmp: int(t.cmp, 1e4),
  };
}

function sanitizeSession(x, tier) {
  if (!x || typeof x !== 'object' || typeof x.sid !== 'string' || !/^[a-f0-9]{8,16}$/.test(x.sid)) return null;
  const r = {
    sid: x.sid,
    proj: typeof x.proj === 'string' && PROJ_RE.test(x.proj) ? x.proj : null,
    state: oneOf(x.state, STATES, 'input'),
    changedAt: int(x.changedAt), changeKind: oneOf(x.changeKind, KINDS, null),
    startAt: int(x.startAt), lastAt: int(x.lastAt), beatAt: int(x.beatAt), endAt: intOrNull(x.endAt),
    permSince: intOrNull(x.permSince),
    model: typeof x.model === 'string' && MODEL_RE.test(x.model) ? x.model : null,
    tools: int(x.tools, 1e7), errors: int(x.errors, 1e7), compactions: int(x.compactions, 1e4), fs: int(x.fs, 1e5),
    turns: (Array.isArray(x.turns) ? x.turns.slice(-MAX_TURNS) : []).map(sanitizeTurn).filter(Boolean),
    ...(int(x.clippedTurns, 1e6) ? { clippedTurns: int(x.clippedTurns, 1e6) } : {}),
    ...(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(x.goalStatus)
      ? { goalStatus: x.goalStatus, goalCompleteAt: x.goalStatus === 'complete' ? intOrNull(x.goalCompleteAt) : null } : {}),
    subs: (Array.isArray(x.subs) ? x.subs.slice(-30) : [])
      .filter((s) => Array.isArray(s)).map((s) => [int(s[0]), int(s[1]), int(s[2], 1e6)]).filter((s) => s[0] > 0),
  };
  if (tier >= 2) { const n = cleanText(x.pname, 40); if (n) r.pname = n; }
  if (tier >= 3) { const t = cleanText(x.title, 80); if (t) r.title = t; }
  return r;
}

/** 推送体白名单。返回 null = 不收。 */
export function sanitizeLive(body) {
  if (!body || typeof body !== 'object') return null;
  const tier = oneOf(body.tier, [1, 2, 3], 1);
  const sessions = (Array.isArray(body.sessions) ? body.sessions.slice(0, MAX_SESSIONS) : [])
    .map((x) => sanitizeSession(x, tier)).filter(Boolean);
  return { tier, devNow: int(body.devNow), sessions,
    ...(Number.isSafeInteger(body.seq) && body.seq > 0 ? { seq: body.seq } : {}) };
}

const SHIFT_KEYS = ['changedAt', 'startAt', 'lastAt', 'beatAt', 'endAt', 'permSince', 'goalCompleteAt'];
/** 把一台设备的时间戳校到服务端时钟 */
function shift(sess, skew) {
  if (!skew) return sess;
  const m = (v) => (v ? v + skew : v);
  const r = { ...sess };
  for (const k of SHIFT_KEYS) if (k in r) r[k] = m(r[k]);
  r.turns = r.turns.map((t) => ({ ...t, s: m(t.s), e: m(t.e) }));
  r.subs = r.subs.map((s) => [m(s[0]), m(s[1]), s[2]]);
  return r;
}

/** 显示状态(§1.4):在设备上报的状态上叠加「可能已断开」「搁置」两个推导态。 */
export function deriveState(s, now) {
  if ((s.state === 'running' || s.state === 'perm') && now - Math.max(s.beatAt || 0, s.lastAt || 0) > LOST_MS) return 'lost';
  if (s.state === 'input' && now - s.changedAt > PARK_MS) return 'parked';
  return s.state;
}

/**
 * 卡住检测(§6.2):只对还在跑 / 等授权的会话判;断开另有状态。返回 null 或 { k, … }:
 *   fail = 连续 ≥5 次工具调用失败 · spin = 这一轮跑了 >40 分钟且调了 >80 次工具 ·
 *   ctx  = 这一轮里上下文压缩了 ≥2 次 · wait = 等你授权 >15 分钟
 * 只给信号,不下结论 —— 文案写「可能卡住」。
 */
export const STUCK = { fail: 5, spinMin: 40, spinTools: 80, ctx: 2, waitMin: 15 };
export function stuckOf(s, now) {
  if (s.state !== 'running' && s.state !== 'perm') return null;
  const t = s.turns[s.turns.length - 1];
  const open = t && !t.e ? t : null;
  if ((s.fs || 0) >= STUCK.fail) return { k: 'fail', n: s.fs };
  if (s.state === 'perm' && now - (s.permSince || s.changedAt) > STUCK.waitMin * 60e3) return { k: 'wait', m: Math.round((now - (s.permSince || s.changedAt)) / 60e3) };
  if (open && (open.cmp || 0) >= STUCK.ctx) return { k: 'ctx', n: open.cmp };
  if (open && now - open.s > STUCK.spinMin * 60e3 && open.tools > STUCK.spinTools) return { k: 'spin', m: Math.round((now - open.s) / 60e3), n: open.tools };
  return null;
}
const stuckWhy = (k) => (k.k === 'fail' ? [`连续 ${k.n} 次工具失败`, `${k.n} tool failures in a row`]
  : k.k === 'wait' ? [`等你授权 ${k.m} 分钟`, `waiting ${k.m} min for approval`]
  : k.k === 'ctx' ? [`这一轮压缩了 ${k.n} 次上下文`, `context compacted ${k.n}× this turn`]
  : [`这一轮 ${k.m} 分钟、${k.n} 次调用`, `${k.m} min · ${k.n} calls`]);   // 组件一行放得下(原「…次工具调用」在 42 档被截)

/** 合并各设备 → GET /live 的返回体。排序不在这里做(三个组件三种排法,由渲染层排)。 */
export function mergeLive(rows, now) {
  const sessions = [];
  const devices = [];
  for (const [dev, row] of Object.entries(rows)) {
    if (!row || row.forgotten || now - row.at > KEEP_MS) continue;
    devices.push({ dev, at: row.at, tier: row.tier, ...(row.seq ? { seq: row.seq } : {}) });
    for (const s0 of row.sessions) {
      const s = shift(s0, row.skew);
      if ((s.state === 'ended' || s.state === 'lost') && now - (s.endAt || s.changedAt) > KEEP_MS) continue;
      const shown = deriveState(s, now);
      // 推导出「断开」时,changedAt 用最后一次听到它的时刻 —— 会话栈按变化排序要靠它
      const changedAt = shown === 'lost' && s.state !== 'lost' ? Math.max(s.beatAt || 0, s.lastAt || 0) : s.changedAt;
      const x = { ...s, dev, state: shown, changedAt, changeKind: shown === 'lost' && s.state !== 'lost' ? 'lost' : s.changeKind };
      x.stuck = stuckOf(x, now);
      sessions.push(x);
    }
  }
  const count = { running: 0, perm: 0, input: 0, parked: 0, lost: 0, ended: 0 };
  for (const s of sessions) count[s.state]++;
  count.parallel = count.running + count.perm + count.input;
  count.stuck = sessions.filter((s) => s.stuck).length;
  const updatedAt = devices.reduce((a, d) => Math.max(a, d.at), 0);
  return { now, updatedAt, count, devices, sessions };
}

// ─────────────────────────── 服务器通知(P3 · doc/push-relay.md §4)───────────────────────────
// 手机经 /live/notify 登记「通知中继凭据 + 阈值」;每收到一次电脑推送 / 到点 alarm 就判定,新事件立刻经中继发出。
// 与 ?view=a 的区别:那边只回答「等得最久的一件」给手机定时检查用;这边逐会话、逐件发。
export const NOTIFY_MAX_SUBS = 6;
const SENT_KEEP = 300;

function projLabels(merged) {
  const label = {};
  let li = 0;
  for (const s of [...merged.sessions].sort((a, b) => a.startAt - b.startAt)) {
    const k = s.proj || 'none';
    if (!label[k]) { const L = LETTERS[li++ % 26]; label[k] = s.pname ? { z: s.pname, e: s.pname } : { z: `项目 ${L}`, e: `Project ${L}` }; }
  }
  return label;
}

/**
 * 某个订阅此刻该发的事件(还没去重)。opts = { perm 分钟, long 分钟, wait / done / stuck 开关, lang },createdAt = 订阅时刻。
 * - wait:等你授权 ≥ perm 分钟(订阅前就在等的也算 —— 你订阅时它还在等,正是要知道的)
 * - done:一轮实跑 ≥ long 分钟、跑完仍在等你,且**跑完在订阅之后**(不翻旧账)
 * - stuck:服务端判出可能卡住
 */
export function pushEvents(merged, opts, createdAt = 0, source = 'claude-code') {
  const now = merged.now, en = String(opts.lang || '').startsWith('en');
  const perm = Number.isFinite(opts.perm) ? opts.perm : 3, long = Number.isFinite(opts.long) ? opts.long : 10;
  const label = projLabels(merged);
  const out = [];
  for (const s of merged.sessions) {
    const p = label[s.proj || 'none'], name = en ? p.e : p.z;
    const path = `/session?sid=${s.sid}&dev=${s.dev}`;
    if (opts.wait !== false && s.state === 'perm') {
      const since = s.permSince || s.changedAt, m = Math.floor((now - since) / 60e3);
      if (now - since >= perm * 60e3) out.push({ key: `w:${s.dev}:${s.sid}:${since}`, kind: 'wait', level: source === 'codex' ? 'normal' : 'urgent', path, collapse: `w-${s.sid}`,
        title: en ? `${name} needs your approval` : `${name} 在等你授权`, body: en ? `Waiting ${Math.max(1, m)} min` : `已经等了 ${Math.max(1, m)} 分钟` });
    }
    const t = s.turns[s.turns.length - 1];
    if (opts.done !== false && s.state === 'input' && t && t.e && t.end === 'ok' && t.e > createdAt) {
      const run = t.e - t.s - t.perm;
      if (run >= long * 60e3) {
        const m = Math.round(run / 60e3);
        out.push({ key: `d:${s.dev}:${s.sid}:${t.id || t.n}`, kind: 'done', level: 'normal', path, collapse: `d-${s.sid}`,
          title: source === 'codex' ? en ? `${name} finished a long turn` : `${name} 的长轮次已结束` : en ? `${name} finished a long task` : `${name} 的长任务跑完了`,
          body: en ? `Ran ${m} min · your turn` : `跑了 ${m} 分钟，等你接着说` });
      }
    }
    if (source === 'codex' && opts.goal === true && s.goalStatus === 'complete' && s.goalCompleteAt > createdAt) {
      out.push({ key: `g:${s.dev}:${s.sid}:${s.goalCompleteAt}`, kind: 'goal', level: 'normal', path, collapse: `g-${s.sid}`,
        title: en ? `${name} completed its goal` : `${name} 的目标已完成`, body: en ? 'Codex explicitly marked the goal complete.' : 'Codex 已明确标记目标完成。' });
    }
    if (opts.stuck !== false && s.stuck) {
      const w = stuckWhy(s.stuck);
      out.push({ key: `s:${s.dev}:${s.sid}:${s.stuck.k}:${t ? t.id || t.n : 0}`, kind: 'stuck', level: 'normal', path, collapse: `s-${s.sid}`,
        title: en ? `${name} may be stuck` : `${name} 可能卡住了`, body: en ? w[1] : w[0] });
    }
  }
  return out;
}

/** 下一个「到点才成立」的时刻(等授权满 perm 分钟 / 满 15 分钟算卡住),给 alarm 用;没有返回 Infinity */
export function nextDue(merged, subs) {
  let t = Infinity;
  for (const s of merged.sessions) {
    if (s.state !== 'perm') continue;
    const since = s.permSince || s.changedAt;
    for (const sub of subs) {
      if (sub.opts.wait !== false) { const d = since + (sub.opts.perm ?? 3) * 60e3; if (d > merged.now) t = Math.min(t, d); }
      if (sub.opts.stuck !== false) { const d = since + STUCK.waitMin * 60e3 + 1000; if (d > merged.now) t = Math.min(t, d); }
    }
  }
  return t;
}

/** 每个空间一个实例。存储:dev:<设备> → { at, skew, tier, sessions }。 */
export class LiveSpace {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rows = null;
    this.subs = null;
    this.req = undefined;
    this.win = 0; this.n = 0;
  }

  async loadSubs() {
    if (this.subs) return this.subs;
    this.subs = (await this.ctx.storage.get('subs')) || {};
    return this.subs;
  }

  /** 判定 + 发送;返回下一个到点时刻。中继 410 = 凭据已撤销 / 设备没了 → 删掉这条订阅。 */
  async notify(now) {
    const subs = await this.loadSubs();
    const ids = Object.keys(subs);
    if (!ids.length) return Infinity;
    const merged = mergeLive(this.rows || {}, now);
    let dirty = false;
    for (const id of ids) {
      const sub = subs[id];
      for (const ev of pushEvents(merged, sub.opts, sub.createdAt, this.source)) {
        if (sub.sent.includes(ev.key)) continue;
        let status = 0;
        try {
          const r = await fetch(`${this.env.PUSH_RELAY || 'https://api.numable.app'}/push/send`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Push ${sub.handle}` },
            body: JSON.stringify({ title: ev.title, body: ev.body, path: ev.path, level: ev.level, collapse: ev.collapse }),
            signal: AbortSignal.timeout(5000),
          });
          status = r.status;
        } catch { status = 0; }
        if (status === 200) { sub.sent.push(ev.key); if (sub.sent.length > SENT_KEEP) sub.sent.splice(0, sub.sent.length - SENT_KEEP); sub.lastSentAt = now; dirty = true; }
        else if (status === 410) { delete subs[id]; dirty = true; break; }
        // 429 / 5xx / 网络:不记已发,下一轮再试
      }
    }
    if (dirty) await this.ctx.storage.put('subs', subs);
    return nextDue(merged, Object.values(subs));
  }

  async schedule(now, due) {
    const rows = this.rows || {};
    const ats = Object.values(rows).map((r) => r.at);
    const cleanup = ats.length ? Math.min(...ats) + KEEP_MS + 60e3 : Infinity;
    const t = Math.min(cleanup, due);
    if (t === Infinity) return;
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || t < cur || cur <= now) await this.ctx.storage.setAlarm(Math.max(t, now + 1000));
  }

  async load() {
    if (this.source === undefined) this.source = (await this.ctx.storage.get('source')) || 'claude-code';
    if (this.rows) return this.rows;
    const all = await this.ctx.storage.list({ prefix: 'dev:' });
    this.rows = {};
    for (const [k, v] of all) this.rows[k.slice(4)] = v;
    return this.rows;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const now = Date.now();
    const rows = await this.load();
    if (url.searchParams.get('source') === 'codex' && this.source !== 'codex') {
      this.source = 'codex'; await this.ctx.storage.put('source', 'codex');
    }

    // 仅由已验证写凭证的 worker 转入；保留序号墓碑，避免删除前的晚到包重新显示。
    if (req.method === 'POST' && url.pathname === '/forget') {
      if (this.source !== 'codex' || url.searchParams.get('source') !== 'codex') return Response.json({ error: 'not_found' }, { status: 404 });
      const dev = url.searchParams.get('dev');
      if (dev !== 'default' && !/^[a-f0-9]{4,32}$/.test(dev || '')) return Response.json({ error: 'bad_device' }, { status: 400 });
      const previous = rows[dev];
      if (!previous || previous.forgotten) return Response.json({ ok: true, removed: 0 });
      const tombstone = { at: now, seq: previous.seq || 0, tier: 1, skew: 0, sessions: [], forgotten: true };
      await this.ctx.storage.put('dev:' + dev, tombstone);
      rows[dev] = tombstone;
      await this.schedule(now, Infinity);
      return Response.json({ ok: true, removed: 1 });
    }

    // 手机登记 / 取消服务器通知(读令牌鉴权,worker 已验):{ id, on, handle?, perm?, long?, wait?, done?, stuck?, lang? }
    if (req.method === 'POST' && url.pathname === '/notify') {
      let b; try { b = await req.json(); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
      const id = typeof b.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(b.id) ? b.id : null;
      if (!id) return Response.json({ error: 'bad_id' }, { status: 400 });
      const subs = await this.loadSubs();
      if (b.on === false) { delete subs[id]; await this.ctx.storage.put('subs', subs); return Response.json({ ok: true, on: false }); }
      if (typeof b.handle !== 'string' || !/^ph1\.[A-Za-z0-9_-]{16,64}$/.test(b.handle)) return Response.json({ error: 'bad_handle' }, { status: 400 });
      if (!subs[id] && Object.keys(subs).length >= NOTIFY_MAX_SUBS) return Response.json({ error: 'too_many' }, { status: 409 });
      const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
      const prev = subs[id];
      subs[id] = {
        handle: b.handle, createdAt: prev && prev.handle === b.handle ? prev.createdAt : now, sent: prev ? prev.sent : [], lastSentAt: prev ? prev.lastSentAt || 0 : 0,
        opts: { perm: num(b.perm, 3, 0, 240), long: num(b.long, 10, 1, 600), wait: b.wait !== false, done: b.done !== false, stuck: b.stuck !== false, goal: b.goal === true,
          lang: typeof b.lang === 'string' && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(b.lang) ? b.lang : 'zh-CN' },
      };
      await this.ctx.storage.put('subs', subs);
      const due = await this.notify(now);
      await this.schedule(now, due);
      return Response.json({ ok: true, on: true, opts: subs[id].opts });
    }

    // 手机请求过「在电脑上打开」的时刻(worker /live/enable 已验读令牌、已写 D1)
    if (req.method === 'POST' && url.pathname === '/req') {
      let b; try { b = await req.json(); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
      const at = Number(b && b.at);
      if (!Number.isFinite(at) || at <= 0) return Response.json({ error: 'bad_at' }, { status: 400 });
      this.req = at;
      await this.ctx.storage.put('req', at);
      return Response.json({ ok: true });
    }

    if (req.method === 'POST') {
      const w = Math.floor(now / 60000);
      if (w !== this.win) { this.win = w; this.n = 0; }
      if (++this.n > WRITES_PER_MIN) return Response.json({ error: 'rate_limited' }, { status: 429 });
      const dev = url.searchParams.get('dev');
      let body; try { body = await req.json(); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
      const clean = sanitizeLive(body);
      if (!clean) return Response.json({ error: 'bad_payload' }, { status: 400 });
      if (rows[dev]?.seq && (!clean.seq || clean.seq <= rows[dev].seq)) return Response.json({ ok: true, ignored: true });
      if ((!rows[dev] || rows[dev].forgotten) && Object.values(rows).filter((r) => !r.forgotten).length >= MAX_DEVICES) return Response.json({ error: 'too_many_devices' }, { status: 409 });
      // 偏差超过一天视为设备时钟坏了,不校(校了反而把时间轴整个挪走)
      const skew = clean.devNow && Math.abs(now - clean.devNow) < 864e5 ? now - clean.devNow : 0;
      const row = { at: now, skew: Math.abs(skew) < 1500 ? 0 : skew, tier: clean.tier, sessions: clean.sessions,
        ...(clean.seq ? { seq: clean.seq } : {}) };
      rows[dev] = row;
      await this.ctx.storage.put('dev:' + dev, row);
      const due = await this.notify(now);
      await this.schedule(now, due);
      return Response.json({ ok: true, sessions: clean.sessions.length });
    }

    if (req.method === 'GET' && url.pathname === '/notify') {
      const subs = await this.loadSubs(), sub = subs[url.searchParams.get('id') || ''];
      return Response.json(sub ? { on: true, opts: sub.opts, lastSentAt: sub.lastSentAt || 0 } : { on: false }, { headers: { 'cache-control': 'no-store' } });
    }

    if (req.method === 'GET') {
      const merged = mergeLive(rows, now);
      if (url.searchParams.get('view') === 'a') {
        const n = (k) => Number(url.searchParams.get(k));
        return Response.json({ updatedAt: merged.updatedAt, a: alertView(merged, { perm: url.searchParams.has('perm') ? n('perm') : NaN, long: url.searchParams.has('long') ? n('long') : NaN }) },
          { headers: { 'cache-control': 'no-store' } });
      }
      if (url.searchParams.get('view') === 'w') {
        const n = (k) => Number(url.searchParams.get(k));
        // 时区:取数流把「看的人那台设备此刻的时分」(lt=HHmm)与 ms 一起带来,这里反推 UTC 偏移 ——
        // 取数流里做不了可靠的时区算术,而组件上要写本地时刻(「15:36 起」「截至 15:42」)
        const tzo = Number.isFinite(n('tzo')) && url.searchParams.has('tzo') ? n('tzo') : tzoOf(url.searchParams.get('lt'), n('ms'));
        return Response.json({ updatedAt: merged.updatedAt, w: widgetView(merged, { win: n('win'), tzo, rows: n('rows') || 8, lanes: n('lanes') || 10, source: url.searchParams.get('source') }) },
          { headers: { 'cache-control': 'no-store' } });
      }
      if (this.req === undefined) this.req = (await this.ctx.storage.get('req')) || 0;
      return Response.json(this.req ? { ...merged, req: this.req } : merged, { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  /** 24 小时没推送的设备整行删掉;还有设备就再约下一次。 */
  async alarm() {
    const rows = await this.load();
    const now = Date.now();
    for (const [dev, row] of Object.entries(rows)) {
      if (now - row.at > KEEP_MS) { delete rows[dev]; await this.ctx.storage.delete('dev:' + dev); }
    }
    // 到点的「等授权满 N 分钟」在这里发出(电脑那边此时可能一直没有新推送)
    const due = await this.notify(now);
    await this.schedule(now, due);
  }
}

// ─────────────────────────── 组件视图(?view=w)───────────────────────────
// 同 worker.js widgetsView 的惯例:服务端把要画的东西算好(位置是 0~1 的比例、颜色是「浅|深」串、
// 文字中英各一份 z / e,RCN 按 @i18n.lang 挑),RCN 只负责摆。状态词表与颜色 = 设计 §1.4。
const C = {
  run: '#C15F3C|#E8916B',                       // 强调色 = 运行中(本包 Claude 暖橙);任何工具类目都不用它
  wait: '#C98A00|#F5C242', waitBg: '#FBF1D6|#3A3015',
  stop: '#A1A1AA|#5B5B63', track: '#F1EEEC|#2A2725',
  cat: { r: '#4F7BE0|#7D9BEF', e: '#2F9E5B|#4CC27A', s: '#5B6B7F|#8E9BB0', a: '#8B6FD6|#A792EC', w: '#3D8BD9|#5FA5EC',
    b: '#1F9BB0|#3CB9CD', d: '#9C6B3F|#C7925F', m: '#8D96A3|#6E7782', q: '#C98A00|#F5C242', o: '#A1A1AA|#6E6E76' },
};
const ST = {
  running: { ic: '▶', z: '运行中', e: 'Running', c: C.run },
  perm: { ic: '⚠', z: '等你授权', e: 'Needs approval', c: C.wait },
  input: { ic: '⏸', z: '等你输入', e: 'Your turn', c: C.wait },
  parked: { ic: '⏸', z: '搁置', e: 'Idle', c: C.stop },
  lost: { ic: '✕', z: '可能已断开', e: 'Disconnected?', c: C.stop },
  ended: { ic: '■', z: '已结束', e: 'Ended', c: C.stop },
};
const DOING = { r: ['读代码', 'Reading code'], e: ['改代码', 'Editing'], s: ['跑命令', 'Running commands'], a: ['派子代理', 'Running agents'],
  w: ['查资料', 'Searching the web'], b: ['操作浏览器', 'Using the browser'], d: ['操作设备', 'Driving a device'], m: ['调外部工具', 'Calling tools'],
  q: ['问你', 'Asking you'], o: ['干活', 'Working'] };
const ORDER = { perm: 0, input: 1, running: 2, parked: 3, lost: 4, ended: 5 };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const kfmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const dfmt = (ms) => { const m = Math.floor(ms / 60e3); return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
const hhmm = (ms, tzo) => { const d = new Date(ms + tzo * 60e3); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const totTok = (s) => s.turns.reduce((a, t) => a + t.out + t.in + t.cw, 0);
const runMs = (s, now) => s.turns.reduce((a, t) => a + Math.max(0, (t.e || now) - t.s - t.perm), 0) - (s.permSince ? Math.max(0, now - s.permSince) : 0);
const lastCat = (s) => { const t = s.turns[s.turns.length - 1]; const m = t && t.seq.match(/([a-z])\d+$/); return m ? m[1] : 'o'; };
/** 「这个状态从什么时候起」:运行中 = 本轮开始;其余 = 状态切换时刻 */
const sinceOf = (s) => (s.state === 'running' && s.turns.length && !s.turns[s.turns.length - 1].e ? s.turns[s.turns.length - 1].s : s.changedAt);

/**
 * opts:win = 时间窗小时数(1 / 2 / 6 / 24),tzo = 看的人的 UTC 偏移(分钟),rows / lanes = 各档容量。
 * 组件上一律写起点时刻(「10:38 起」)而不是时长 —— 组件一画就挂几分钟,时长会过期,起点不会(设计 §5.5)。
 */
/** lt = 本地「时分」四位(如 1542),ms = 同一时刻的毫秒 → UTC 偏移(分钟,按 15 分钟取整)。拿不到返回 0。 */
export function tzoOf(lt, ms) {
  if (!/^\d{4}$/.test(lt || '') || !Number.isFinite(ms) || ms <= 0) return 0;
  const local = Number(lt.slice(0, 2)) * 60 + Number(lt.slice(2));
  const utc = Math.floor(ms / 60e3) % 1440;
  let d = ((local - utc) % 1440 + 1440) % 1440;
  if (d > 840) d -= 1440;                      // 偏移范围 −12:00 ~ +14:00
  return Math.round(d / 15) * 15;
}

export function widgetView(merged, opts = {}) {
  const now = merged.now;
  const tzo = Number.isFinite(opts.tzo) ? Math.max(-840, Math.min(840, opts.tzo)) : 0;
  const winH = [1, 2, 6, 24].includes(opts.win) ? opts.win : 2;
  const winMs = winH * 3600e3, w0 = now - winMs;
  const xs = (t) => r3(Math.max(0, Math.min(1, (t - w0) / winMs)));

  // 项目:有名字用名字;没有就按首次出现顺序叫「项目 A / B」
  const projLabel = {};
  let li = 0;
  for (const s of [...merged.sessions].sort((a, b) => a.startAt - b.startAt)) {
    const k = s.proj || 'none';
    if (!projLabel[k]) {
      const L = LETTERS[li++ % 26];
      projLabel[k] = s.pname ? { z: s.pname, e: s.pname } : { z: `项目 ${L}`, e: `Project ${L}` };
    }
  }
  // 同项目内的会话编号(按开始先后):#1 #2 …,跨设备时带设备尾标
  const multiDev = merged.devices.length > 1;
  const devTag = {}; merged.devices.forEach((d, i) => { devTag[d.dev] = String.fromCharCode(97 + i); });
  const seqNo = {};
  const label = {};
  for (const s of [...merged.sessions].sort((a, b) => a.startAt - b.startAt)) {
    const k = s.proj || 'none';
    seqNo[k] = (seqNo[k] || 0) + 1;
    label[s.dev + s.sid] = `#${seqNo[k]}` + (multiDev ? `/${devTag[s.dev]}` : '');
  }

  const row = (s) => {
    let st = ST[s.state] || ST.input;
    if (opts.source === 'codex' && s.state === 'running') st = { ...st, c: '#0D9488|#54D3C2' };
    const outcome = s.turns.at(-1)?.end;
    if (opts.source === 'codex' && s.state === 'lost') st = { ...st, z: '状态待确认', e: 'Status unconfirmed' };
    if (opts.source === 'codex' && s.state === 'input' && outcome === 'error') st = { ...st, z: '上轮失败 · 等你输入', e: 'Last turn failed · your turn' };
    if (opts.source === 'codex' && s.state === 'input' && outcome === 'interrupt') st = { ...st, z: '已中断 · 等你输入', e: 'Interrupted · your turn' };
    const since = sinceOf(s);
    const p = projLabel[s.proj || 'none'];
    const dz = DOING[lastCat(s)] || DOING.o;
    let tz, te;
    if (s.stuck) { const w = stuckWhy(s.stuck); tz = `可能卡住 · ${w[0]}`; te = `May be stuck · ${w[1]}`; }
    else if (s.state === 'running') {
      tz = s.title || (opts.source === 'codex' ? `运行中 · 最近${dz[0]}` : `正在${dz[0]}`);
      te = s.title || (opts.source === 'codex' ? `Running · ${dz[1]}` : dz[1]);
    }
    else if (s.state === 'perm' || s.state === 'input') { tz = `${st.z} · ${hhmm(since, tzo)} 起`; te = `${st.e} · since ${hhmm(since, tzo)}`; }
    else { tz = s.title ? `${st.z} · ${s.title}` : st.z; te = s.title ? `${st.e} · ${s.title}` : st.e; }
    return {
      st: s.state, ic: st.ic, c: st.c, warn: s.state === 'perm' || s.state === 'input' || s.stuck ? 1 : 0,
      pz: p.z, pe: p.e, lab: label[s.dev + s.sid], tz, te,
      at: hhmm(since, tzo), turns: s.turns.length ? s.turns[s.turns.length - 1].n : 0,
      run: dfmt(runMs(s, now)), tok: kfmt(totTok(s)), dim: s.state === 'ended' || s.state === 'parked' || s.state === 'lost' ? 1 : 0,
    };
  };

  // ── 概况行:等你授权 > 等你输入 > 运行中 > 其余;已结束只留 30 分钟内的 ──
  const shown = merged.sessions.filter((s) => s.state !== 'ended' || now - s.changedAt < 30 * 60e3);
  const board = [...shown].sort((a, b) => (b.stuck ? 1 : 0) - (a.stuck ? 1 : 0) || ORDER[a.state] - ORDER[b.state] || b.changedAt - a.changedAt)
    .slice(0, opts.rows || 8).map((s, i) => ({ i, ...row(s) }));

  // ── 多泳道:工程为池(按池内最新变化排)、会话为道(池内按开始时刻,位置不随状态变)──
  const inWin = merged.sessions.filter((s) => (s.endAt || now) >= w0);
  const pools = {};
  for (const s of inWin) (pools[s.proj || 'none'] || (pools[s.proj || 'none'] = [])).push(s);
  const poolList = Object.entries(pools)
    .map(([k, list]) => ({ k, list: list.sort((a, b) => a.startAt - b.startAt), changed: Math.max(...list.map((x) => x.changedAt)),
      wait: list.filter((x) => x.state === 'perm' || x.state === 'input').length }))
    .sort((a, b) => b.changed - a.changed);
  const lanes = [];
  let hidden = 0;
  for (const pool of poolList) {
    if (lanes.length + pool.list.length > (opts.lanes || 10)) { hidden++; continue; }
    pool.list.forEach((s, j) => {
      const segs = [];
      for (const t of s.turns) {
        const te = t.e || now;
        if (te < w0) continue;
        // 每 2 分钟一格的主要类目 → 连成段;没有格子(旧数据 / 只有一个工具)就整轮按最后一个类目画
        const cells = t.cells || (t.seq.match(/[a-z]/g) || ['o']).slice(-1).join('');
        const slot = 120e3;
        let i = 0;
        while (i < cells.length) {
          let j2 = i; while (j2 + 1 < cells.length && cells[j2 + 1] === cells[i]) j2++;
          const a = Math.max(t.s + i * slot, t.s), b = Math.min(t.s + (j2 + 1) * slot, te);
          if (cells[i] !== '.' && b > w0 && b > a) segs.push({ x: xs(a), w: r3(xs(b) - xs(a)), c: C.cat[cells[i]] || C.cat.o, k: cells[i] });
          i = j2 + 1;
        }
        if (!t.cells && !segs.length) segs.push({ x: xs(t.s), w: r3(xs(te) - xs(t.s)), c: C.cat.o, k: 'o' });
      }
      // 运行中:最后一块一直顶到现在线(那一格里还没调到下一个工具,但它确实在跑)
      if (s.state === 'running' && segs.length) { const L = segs[segs.length - 1]; L.w = r3(1 - L.x); }
      // 尾巴 = 最后一个事件到现在,只按状态画(§5.4)
      let tail = null, cap = -1;
      if (s.state === 'perm') tail = { x: xs(s.permSince || s.changedAt), k: 'perm' };
      else if (s.state === 'input' || s.state === 'parked') tail = { x: xs(s.changedAt), k: s.state };
      else if (s.state === 'lost') tail = { x: xs(Math.max(s.beatAt || 0, s.lastAt || 0)), k: 'lost' };
      else if (s.state === 'ended') cap = xs(s.endAt || s.changedAt);
      if (tail) tail.w = r3(1 - tail.x);
      const st = ST[s.state] || ST.input;
      const since = sinceOf(s);
      lanes.push({
        i: lanes.length, first: j === 0 ? 1 : 0, sub: 0,
        pz: projLabel[pool.k].z, pe: projLabel[pool.k].e, pw: j === 0 ? pool.wait : 0,
        lab: label[s.dev + s.sid], st: s.state, ic: st.ic, c: st.c, dim: s.state === 'ended' ? 1 : 0,
        segs, tail, cap, running: s.state === 'running' ? 1 : 0,
        chip: s.state === 'ended' ? '' : hhmm(since, tzo),
      });
    });
  }
  // 摊平:RCN 里循环套循环(道 × 段)的作用域不可靠,段 / 尾巴 / 端帽各一张平表,带道号 i
  const flat = { segs: [], tails: [], caps: [] };
  for (const l of lanes) {
    for (const g of l.segs) flat.segs.push({ i: l.i, x: g.x, w: g.w, c: g.c });
    if (l.tail) flat.tails.push({ i: l.i, ...l.tail });
    if (l.cap >= 0) flat.caps.push({ i: l.i, x: l.cap });
  }
  const c = merged.count;
  return {
    has: merged.sessions.length ? 1 : 0, upd: merged.updatedAt ? hhmm(merged.updatedAt, tzo) : '',
    n: { par: c.parallel, run: c.running, perm: c.perm, input: c.input, wait: c.perm + c.input, stuck: c.stuck,
      proj: new Set(merged.sessions.filter((s) => ['running', 'perm', 'input'].includes(s.state)).map((s) => s.proj || 'none')).size },
    board, more: Math.max(0, shown.length - board.length), nb: shown.length, devs: merged.devices.length,
    lanes, hiddenPools: hidden, winH, flat, nl: lanes.length, n4: Math.min(lanes.length, 4), n10: Math.min(lanes.length, 10),   // 实际画几道:RCN 尺寸字段里不能写方法
    axis: [hhmm(w0, tzo), hhmm(w0 + winMs / 2, tzo), hhmm(now, tzo)], a0: hhmm(w0, tzo), a1: hhmm(w0 + winMs / 2, tzo), a2: hhmm(now, tzo),
    m42: Math.max(0, shown.length - 3) * (shown.length > 4 ? 1 : 0), m44: Math.max(0, shown.length - 7) * (shown.length > 8 ? 1 : 0),
    color: C,
  };
}

// ─────────────────────────── 提醒视图(?view=a,P2 · 设计 §6.1)───────────────────────────
// 手机端提醒(.xjob)每轮取这一份,只回答两件事,各带一个「事件键」—— 判定流程只在键变了时响,同一件事不重复:
//   wait:有会话等你授权 ≥ permMin 分钟(取等得最久的那个);键 = 设备:会话:开始等的时刻
//   done:有会话「一轮跑了 ≥ longMin 分钟、跑完停下等你」且你还没接着说(状态仍是等你输入);键 = 设备:会话:轮号
// 不设「刚刚结束」时间窗:手机端检查间隔是 15~30 分钟级,窗口一短就漏;用「仍在等你」判,你一接着说它就自然消失。
export function alertView(merged, opts = {}) {
  const now = merged.now;
  const permMin = Number.isFinite(opts.perm) && opts.perm >= 0 ? Math.min(opts.perm, 240) : 3;
  const longMin = Number.isFinite(opts.long) && opts.long > 0 ? Math.min(opts.long, 600) : 10;
  const label = {};
  let li = 0;
  for (const s of [...merged.sessions].sort((a, b) => a.startAt - b.startAt)) {
    const k = s.proj || 'none';
    if (!label[k]) { const L = LETTERS[li++ % 26]; label[k] = s.pname ? { z: s.pname, e: s.pname } : { z: `项目 ${L}`, e: `Project ${L}` }; }
  }
  const out = { wait: 0, waitKey: '', wProjZ: '', wProjE: '', wMins: '', wN: 0, done: 0, doneKey: '', dProjZ: '', dProjE: '', dMins: '',
    stuck: 0, stuckKey: '', sProjZ: '', sProjE: '', sWhyZ: '', sWhyE: '', goalKey: '', gProjZ: '', gProjE: '' };

  const waiting = merged.sessions
    .filter((s) => s.state === 'perm' && (s.permSince || s.changedAt) && now - (s.permSince || s.changedAt) >= permMin * 60e3)
    .sort((a, b) => (a.permSince || a.changedAt) - (b.permSince || b.changedAt));
  if (waiting.length) {
    const s = waiting[0], since = s.permSince || s.changedAt;
    Object.assign(out, { wait: 1, waitKey: `${s.dev}:${s.sid}:${since}`, wProjZ: label[s.proj || 'none'].z, wProjE: label[s.proj || 'none'].e,
      wMins: String(Math.max(1, Math.round((now - since) / 60e3))), wN: waiting.length });
  }

  const done = merged.sessions
    .map((s) => ({ s, t: s.turns[s.turns.length - 1] }))
    .filter(({ s, t }) => s.state === 'input' && t && t.e && t.end === 'ok' && (t.e - t.s - t.perm) >= longMin * 60e3)
    .sort((a, b) => b.t.e - a.t.e);
  if (done.length) {
    const { s, t } = done[0];
    Object.assign(out, { done: 1, doneKey: `${s.dev}:${s.sid}:${t.id || t.n}`, dProjZ: label[s.proj || 'none'].z, dProjE: label[s.proj || 'none'].e,
      dMins: String(Math.max(1, Math.round((t.e - t.s - t.perm) / 60e3))) });
  }
  const completeGoals = merged.sessions.filter((s) => s.goalStatus === 'complete' && s.goalCompleteAt).sort((a, b) => b.goalCompleteAt - a.goalCompleteAt);
  if (completeGoals.length) {
    const s = completeGoals[0];
    Object.assign(out, { goalKey: `${s.dev}:${s.sid}:${s.goalCompleteAt}`, gProjZ: label[s.proj || 'none'].z, gProjE: label[s.proj || 'none'].e });
  }
  // 可能卡住:取最早开始的那一路;键 = 设备:会话:原因:轮号 —— 同一轮同一种原因只响一次,换了原因(比如先失败后转圈)会再响
  const stuck = merged.sessions.filter((s) => s.stuck).sort((a, b) => a.startAt - b.startAt);
  if (stuck.length) {
    const s = stuck[0], t = s.turns[s.turns.length - 1], w = stuckWhy(s.stuck);
    Object.assign(out, { stuck: 1, stuckKey: `${s.dev}:${s.sid}:${s.stuck.k}:${t ? t.id || t.n : 0}`, sProjZ: label[s.proj || 'none'].z, sProjE: label[s.proj || 'none'].e, sWhyZ: w[0], sWhyE: w[1] });
  }
  return out;
}
