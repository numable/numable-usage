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
    n: int(t.n, 1e6), s, e: intOrNull(t.e), perm: int(t.perm, 864e5), tools: int(t.tools, 1e6),
    seq: typeof t.seq === 'string' && SEQ_RE.test(t.seq) ? t.seq : '',
    cells: typeof t.cells === 'string' && CELLS_RE.test(t.cells) ? t.cells : '',
    long, out: int(t.out), in: int(t.in), cw: int(t.cw),
    end: oneOf(t.end, ENDS, null),
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
    tools: int(x.tools, 1e7), errors: int(x.errors, 1e7), compactions: int(x.compactions, 1e4),
    turns: (Array.isArray(x.turns) ? x.turns.slice(-MAX_TURNS) : []).map(sanitizeTurn).filter(Boolean),
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
  return { tier, devNow: int(body.devNow), sessions };
}

const SHIFT_KEYS = ['changedAt', 'startAt', 'lastAt', 'beatAt', 'endAt', 'permSince'];
/** 把一台设备的时间戳校到服务端时钟 */
function shift(sess, skew) {
  if (!skew) return sess;
  const m = (v) => (v ? v + skew : v);
  const r = { ...sess };
  for (const k of SHIFT_KEYS) r[k] = m(r[k]);
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

/** 合并各设备 → GET /live 的返回体。排序不在这里做(三个组件三种排法,由渲染层排)。 */
export function mergeLive(rows, now) {
  const sessions = [];
  const devices = [];
  for (const [dev, row] of Object.entries(rows)) {
    if (!row || now - row.at > KEEP_MS) continue;
    devices.push({ dev, at: row.at, tier: row.tier });
    for (const s0 of row.sessions) {
      const s = shift(s0, row.skew);
      if ((s.state === 'ended' || s.state === 'lost') && now - (s.endAt || s.changedAt) > KEEP_MS) continue;
      const shown = deriveState(s, now);
      // 推导出「断开」时,changedAt 用最后一次听到它的时刻 —— 会话栈按变化排序要靠它
      const changedAt = shown === 'lost' && s.state !== 'lost' ? Math.max(s.beatAt || 0, s.lastAt || 0) : s.changedAt;
      sessions.push({ ...s, dev, state: shown, changedAt, changeKind: shown === 'lost' && s.state !== 'lost' ? 'lost' : s.changeKind });
    }
  }
  const count = { running: 0, perm: 0, input: 0, parked: 0, lost: 0, ended: 0 };
  for (const s of sessions) count[s.state]++;
  count.parallel = count.running + count.perm + count.input;
  const updatedAt = devices.reduce((a, d) => Math.max(a, d.at), 0);
  return { now, updatedAt, count, devices, sessions };
}

/** 每个空间一个实例。存储:dev:<设备> → { at, skew, tier, sessions }。 */
export class LiveSpace {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rows = null;
    this.win = 0; this.n = 0;
  }

  async load() {
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

    if (req.method === 'POST') {
      const w = Math.floor(now / 60000);
      if (w !== this.win) { this.win = w; this.n = 0; }
      if (++this.n > WRITES_PER_MIN) return Response.json({ error: 'rate_limited' }, { status: 429 });
      const dev = url.searchParams.get('dev');
      let body; try { body = await req.json(); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
      const clean = sanitizeLive(body);
      if (!clean) return Response.json({ error: 'bad_payload' }, { status: 400 });
      if (!rows[dev] && Object.keys(rows).length >= MAX_DEVICES) return Response.json({ error: 'too_many_devices' }, { status: 409 });
      // 偏差超过一天视为设备时钟坏了,不校(校了反而把时间轴整个挪走)
      const skew = clean.devNow && Math.abs(now - clean.devNow) < 864e5 ? now - clean.devNow : 0;
      const row = { at: now, skew: Math.abs(skew) < 1500 ? 0 : skew, tier: clean.tier, sessions: clean.sessions };
      rows[dev] = row;
      await this.ctx.storage.put('dev:' + dev, row);
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + KEEP_MS + 60e3);
      return Response.json({ ok: true, sessions: clean.sessions.length });
    }

    if (req.method === 'GET') {
      const merged = mergeLive(rows, now);
      if (url.searchParams.get('view') === 'w') {
        const n = (k) => Number(url.searchParams.get(k));
        // 时区:取数流把「看的人那台设备此刻的时分」(lt=HHmm)与 ms 一起带来,这里反推 UTC 偏移 ——
        // 取数流里做不了可靠的时区算术,而组件上要写本地时刻(「15:36 起」「截至 15:42」)
        const tzo = Number.isFinite(n('tzo')) && url.searchParams.has('tzo') ? n('tzo') : tzoOf(url.searchParams.get('lt'), n('ms'));
        return Response.json({ updatedAt: merged.updatedAt, w: widgetView(merged, { win: n('win'), tzo, rows: n('rows') || 8, lanes: n('lanes') || 10 }) },
          { headers: { 'cache-control': 'no-store' } });
      }
      return Response.json(merged, { headers: { 'cache-control': 'no-store' } });
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
    if (Object.keys(rows).length) {
      const oldest = Math.min(...Object.values(rows).map((r) => r.at));
      await this.ctx.storage.setAlarm(oldest + KEEP_MS + 60e3);
    }
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
    const st = ST[s.state] || ST.input;
    const since = sinceOf(s);
    const p = projLabel[s.proj || 'none'];
    const dz = DOING[lastCat(s)] || DOING.o;
    let tz, te;
    if (s.state === 'running') { tz = s.title || `正在${dz[0]}`; te = s.title || dz[1]; }
    else if (s.state === 'perm' || s.state === 'input') { tz = `${st.z} · ${hhmm(since, tzo)} 起`; te = `${st.e} · since ${hhmm(since, tzo)}`; }
    else { tz = s.title ? `${st.z} · ${s.title}` : st.z; te = s.title ? `${st.e} · ${s.title}` : st.e; }
    return {
      st: s.state, ic: st.ic, c: st.c, warn: s.state === 'perm' || s.state === 'input' ? 1 : 0,
      pz: p.z, pe: p.e, lab: label[s.dev + s.sid], tz, te,
      at: hhmm(since, tzo), turns: s.turns.length ? s.turns[s.turns.length - 1].n : 0,
      run: dfmt(runMs(s, now)), tok: kfmt(totTok(s)), dim: s.state === 'ended' || s.state === 'parked' || s.state === 'lost' ? 1 : 0,
    };
  };

  // ── 概况行:等你授权 > 等你输入 > 运行中 > 其余;已结束只留 30 分钟内的 ──
  const shown = merged.sessions.filter((s) => s.state !== 'ended' || now - s.changedAt < 30 * 60e3);
  const board = [...shown].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.changedAt - a.changedAt)
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
    n: { par: c.parallel, run: c.running, perm: c.perm, input: c.input, wait: c.perm + c.input,
      proj: new Set(merged.sessions.filter((s) => ['running', 'perm', 'input'].includes(s.state)).map((s) => s.proj || 'none')).size },
    board, more: Math.max(0, shown.length - board.length), nb: shown.length, devs: merged.devices.length,
    lanes, hiddenPools: hidden, winH, flat, nl: lanes.length, n4: Math.min(lanes.length, 4), n10: Math.min(lanes.length, 10),   // 实际画几道:RCN 尺寸字段里不能写方法
    axis: [hhmm(w0, tzo), hhmm(w0 + winMs / 2, tzo), hhmm(now, tzo)], a0: hhmm(w0, tzo), a1: hhmm(w0 + winMs / 2, tzo), a2: hhmm(now, tzo),
    m42: Math.max(0, shown.length - 3) * (shown.length > 4 ? 1 : 0), m44: Math.max(0, shown.length - 7) * (shown.length > 8 ? 1 : 0),
    color: C,
  };
}
