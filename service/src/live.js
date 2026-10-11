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

    if (req.method === 'GET') return Response.json(mergeLive(rows, now), { headers: { 'cache-control': 'no-store' } });
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
