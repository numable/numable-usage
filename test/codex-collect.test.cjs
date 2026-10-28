'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { collect, initialState, usage, quota } = require('../codex/lib/collect.cjs');
const now = Date.parse('2026-10-19T12:00:00Z');
const opt = { now, timezone: 'Asia/Kuala_Lumpur' };
const row = (type, payload, at = '2026-10-19T10:00:00Z') => ({ type, payload, timestamp: at });
const u = (input, output) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: Math.floor(input / 2), reasoning_output_tokens: Math.floor(output / 2), total_tokens: input + output });
const meta = (id = 'main', extra = {}) => row('session_meta', { id, cwd: '/private/秘密项目', cli_version: '0.163.0-alpha.10.2', source: 'vscode', ...extra });
const context = (id = 't1') => row('turn_context', { turn_id: id, model: 'model-a' });
const record = (id = 'r1', input = 100, output = 20, turn = 't1') => row('token_usage_record', { response_id: id, turn_id: turn, usage: u(input, output), turn_token_usage: u(1000, 200), thread_token_usage: u(10000, 2000) });
const count = (input = 100, output = 20, lastInput = input, lastOutput = output) => row('event_msg', { type: 'token_count', info: { total_token_usage: u(input, output), last_token_usage: u(lastInput, lastOutput) } });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numable-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sessions'));
  const file = path.join(dir, 'sessions', 'rollout.jsonl');
  const write = (rows) => fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  return { dir, file, write };
}
const totals = (s) => s.days.reduce((a, d) => a + d.total, 0);

test('新记录与累计通知同时存在时只数响应，缓存与推理不额外相加', async (t) => {
  const { dir, write } = setup(t);
  write([meta(), context(), record(), count(), count()]);
  const r = await collect([dir], initialState(), opt);
  assert.equal(totals(r.snapshot), 120);
  assert.equal(r.snapshot.days[0].responses, 1);
  assert.equal(r.snapshot.days[0].cached, 50);
  assert.equal(r.snapshot.days[0].reasoning, 10);
  const serialized = JSON.stringify(r.state);
  assert.ok(!serialized.includes('/private') && !serialized.includes('秘密项目'));
});

test('归档副本、分叉继承和重复响应不增加用量，新响应仍计入', async (t) => {
  const { dir, file, write } = setup(t);
  write([meta(), context(), record()]);
  fs.mkdirSync(path.join(dir, 'archived_sessions'));
  fs.copyFileSync(file, path.join(dir, 'archived_sessions', 'copy.jsonl'));
  fs.writeFileSync(path.join(dir, 'sessions', 'fork.jsonl'), [meta('fork', { forked_from_id: 'main' }), context(), record(), record('r2', 40, 10)].map(JSON.stringify).join('\n') + '\n');
  const r = await collect([dir], initialState(), opt);
  assert.equal(totals(r.snapshot), 170);
  assert.equal(r.snapshot.days[0].responses, 2);
});

test('半行不提交游标，补全后只计一次，重复扫描与全量重算一致', async (t) => {
  const { dir, file, write } = setup(t);
  write([meta(), context(), record()]);
  const a = await collect([dir], initialState(), opt);
  const extra = JSON.stringify(record('r2', 40, 10));
  fs.appendFileSync(file, extra.slice(0, 30));
  const b = await collect([dir], a.state, opt);
  assert.equal(totals(b.snapshot), 120);
  fs.appendFileSync(file, extra.slice(30) + '\n');
  const c = await collect([dir], b.state, opt);
  assert.equal(totals(c.snapshot), 170);
  const d = await collect([dir], c.state, opt);
  assert.equal(d.stats.rows, 0);
  assert.deepEqual(d.snapshot.days, c.snapshot.days);
  const full = await collect([dir], { ...initialState(), salt: a.state.salt }, opt);
  assert.deepEqual(full.snapshot.days, c.snapshot.days);
});

test('截断重写清掉该文件旧贡献，删除日志后仍保留本机历史', async (t) => {
  const { dir, file, write } = setup(t);
  write([meta(), context(), record(), record('r2', 40, 10)]);
  const a = await collect([dir], initialState(), opt);
  write([meta(), context(), record('r3', 10, 2)]);
  const b = await collect([dir], a.state, opt);
  assert.equal(totals(b.snapshot), 12);
  fs.unlinkSync(file);
  const c = await collect([dir], b.state, opt);
  assert.equal(totals(c.snapshot), 12);
});

test('旧累计事件取差值，重复通知和恢复首条的历史累计不重复计数', async (t) => {
  const { dir, write } = setup(t);
  write([meta(), context(), count(1000, 200, 100, 20), count(1000, 200, 100, 20), count(1040, 210, 40, 10)]);
  const r = await collect([dir], initialState(), opt);
  assert.equal(totals(r.snapshot), 170);
  assert.equal(r.snapshot.diagnostics.legacyRecords, 2);
});

test('同一会话跨轮升级格式，旧轮仍保留，新轮不与旧通知重复', async (t) => {
  const { dir, write } = setup(t);
  write([meta(), context('old'), count(100, 20), context('t1'), record('new', 40, 10), count(140, 30, 40, 10)]);
  const r = await collect([dir], initialState(), opt);
  assert.equal(totals(r.snapshot), 170);
});

test('子代理消耗计入用量，主会话数不包含子代理', async (t) => {
  const { dir, write } = setup(t);
  write([meta(), context(), record(), meta('child', { source: { subagent: { parent_thread_id: 'main' } } }), context('child-turn'), record('child-response', 40, 10, 'child-turn')]);
  const r = await collect([dir], initialState(), opt);
  assert.equal(totals(r.snapshot), 170);
  assert.equal(r.snapshot.days[0].sessions, 1);
});

test('时区自然日边界稳定，重叠会话的活跃分钟不重复', async (t) => {
  const { dir, write } = setup(t);
  const a = record(); a.timestamp = '2026-10-18T16:00:01Z';
  const b = record('r2', 40, 10); b.timestamp = a.timestamp;
  write([meta(), context(), a, b]);
  const r = await collect([dir], initialState(), opt);
  assert.equal(r.snapshot.days[0].date, '2026-10-19');
  assert.equal(r.snapshot.days[0].activeMinutes, 1);
});

test('可选项目名只有显式开启才进入投影，正文与工具参数不落盘', async (t) => {
  const { dir, write } = setup(t);
  write([meta(), context(), row('response_item', { type: 'function_call', arguments: '绝密命令', content: '绝密正文' }), record()]);
  const r = await collect([dir], initialState(), { ...opt, projects: true });
  assert.ok(JSON.stringify(r.snapshot).includes('秘密项目'));
  assert.ok(!JSON.stringify(r.state).includes('绝密'));
  const off = await collect([dir], r.state, opt);
  assert.ok(!JSON.stringify(off.snapshot).includes('秘密项目'));
});

test('归档 gzip 可读，与未压缩副本去重', async (t) => {
  const { dir, file, write } = setup(t);
  write([meta(), context(), record()]);
  fs.writeFileSync(file + '.gz', zlib.gzipSync(fs.readFileSync(file)));
  const r = await collect([dir], initialState(), opt);
  assert.equal(totals(r.snapshot), 120);
});

test('非法数值拒绝，缺失细项保持未知，额度到期不自动补成满额', async () => {
  assert.equal(usage({ ...u(100, 20), input_tokens: -1 }), null);
  assert.equal(usage({ ...u(100, 20), total_tokens: 999 }), null);
  assert.equal(usage({ ...u(100, 20), cached_input_tokens: 101 }), null);
  assert.equal(usage({ input_tokens: 10, output_tokens: 2 }).cached, null);
  const q = quota({ primary: { used_percent: 30, window_minutes: 300, resets_at: now / 1000 - 1 } }, now - 60000);
  assert.equal(q.primary.usedPercent, 30);
  assert.equal(quota({ primary: { used_percent: 130, window_minutes: 300, resets_at: now / 1000 } }, now), null);
});

test('损坏行可诊断，未知记录不冒充已支持', async (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, '{bad}\n' + JSON.stringify(row('new_unknown_format', { secret: '不要保存' })) + '\n');
  const r = await collect([dir], initialState(), opt);
  assert.equal(r.snapshot.diagnostics.invalidRows, 1);
  assert.equal(r.snapshot.diagnostics.unknownFiles, 1);
  assert.equal(totals(r.snapshot), 0);
});

test('跨午夜会话每日各有活动，总会话数仍为一个', async (t) => {
  const { dir, write } = setup(t);
  const a = record(); a.timestamp = '2026-10-18T15:59:00Z';
  const b = record('r2', 40, 10); b.timestamp = '2026-10-18T16:01:00Z';
  write([meta(), context(), a, b]);
  const r = await collect([dir], initialState(), opt);
  assert.equal(r.snapshot.days.length, 2);
  assert.equal(r.snapshot.days.reduce((a, d) => a + d.sessions, 0), 2);
  assert.equal(r.snapshot.sessionCount, 1);
});

test('项目名称开关变化会重新读取元数据，关闭时清理投影中的名字', async (t) => {
  const { dir, write } = setup(t); write([meta(), context(), record()]);
  const a = await collect([dir], initialState(), opt);
  const b = await collect([dir], a.state, { ...opt, projects: true });
  assert.ok(JSON.stringify(b.snapshot).includes('秘密项目'));
  const c = await collect([dir], b.state, opt);
  assert.ok(!JSON.stringify(c.state).includes('秘密项目'));
});

test('同一响应的较晚用量修订替换旧值，不与归档旧副本叠加', async (t) => {
  const { dir, file, write } = setup(t); write([meta(), context(), record()]);
  fs.mkdirSync(path.join(dir, 'archived_sessions')); fs.copyFileSync(file, path.join(dir, 'archived_sessions', 'old.jsonl'));
  const later = record('r1', 120, 30); later.timestamp = '2026-10-19T10:01:00Z';
  fs.appendFileSync(file, JSON.stringify(later) + '\n');
  const r = await collect([dir], initialState(), opt);
  assert.equal(totals(r.snapshot), 150); assert.equal(r.snapshot.days[0].responses, 1);
});

test('缺少 zstd 解码器有明确诊断，不把压缩历史当零用量', async (t) => {
  const { dir, file } = setup(t); fs.writeFileSync(file + '.zst', 'compressed-placeholder');
  const r = await collect([dir], initialState(), { ...opt, zstd: '/missing/decoder' });
  assert.equal(r.stats.compressedUnavailable, 1);
  assert.equal(r.snapshot.coverage.length, 0);
});

test('没有新增内容的轮次复用旧投影且不改写上一轮状态，只改时间也不重复计数', async (t) => {
  const { dir, file, write } = setup(t);
  write([meta(), context(), record()]);
  const a = await collect([dir], initialState(), opt);
  assert.equal(a.changed, true);
  const key = Object.keys(a.state.files)[0], before = JSON.stringify(a.state);
  const b = await collect([dir], a.state, opt);
  assert.equal(b.changed, false);
  assert.equal(b.state.files[key], a.state.files[key]);
  assert.deepEqual(b.snapshot, a.snapshot);
  assert.equal(JSON.stringify(a.state), before);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const c = await collect([dir], b.state, opt);
  assert.equal(c.changed, true);
  assert.equal(c.stats.rows, 0);
  assert.deepEqual(c.snapshot, a.snapshot);
  assert.equal((await collect([dir], c.state, opt)).changed, false);
  fs.appendFileSync(file, JSON.stringify(record('r2', 40, 10)) + '\n');
  const d = await collect([dir], c.state, opt);
  assert.equal(d.changed, true);
  assert.equal(totals(d.snapshot), 170);
  assert.equal(JSON.stringify(a.state), before);
});

test('跨日期与夏令时切换时按刻钟缓存的日期与逐条计算一致', async (t) => {
  const { dir, write } = setup(t);
  // 洛杉矶午夜与夏令时切换（整点）、加德满都午夜（UTC 18:15）、查塔姆夏令时午夜（UTC 10:15）两侧各取一条。
  const times = ['2026-03-08T07:59:59Z', '2026-03-08T08:00:00Z', '2026-11-01T06:59:59.999Z', '2026-11-01T07:00:00Z',
    '2026-10-19T18:14:59Z', '2026-10-19T18:15:00Z', '2026-10-19T10:14:59Z', '2026-10-19T10:15:00Z'];
  write([meta(), context(), ...times.map((at, i) => row('token_usage_record', { response_id: `r${i}`, turn_id: 't1', usage: u(10, 1) }, at))]);
  for (const timezone of ['America/Los_Angeles', 'Asia/Kathmandu', 'Pacific/Chatham']) {
    const r = await collect([dir], initialState(), { now: Date.parse('2026-12-01T00:00:00Z'), timezone });
    const expected = new Map();
    for (const at of times) { const date = require('../codex/lib/collect.cjs').dateAt(Date.parse(at), timezone); expected.set(date, (expected.get(date) || 0) + 1); }
    assert.deepEqual(r.snapshot.days.map((d) => [d.date, d.responses]), [...expected].sort());
  }
});

const { summarize } = require('../codex/lib/collect.cjs');
const { pack, unpack } = require('../codex/lib/records.cjs');
const toV1 = (state) => ({ ...state, version: 1, prunedAt: undefined, files: Object.fromEntries(Object.entries(state.files).map(([k, f]) => {
  const { ctx, ...rest } = f;
  const expand = (m) => Object.fromEntries(Object.entries(m).map(([key, t]) => [key, unpack(f, t)]));
  return [k, { ...rest, records: expand(f.records), legacy: expand(f.legacy) }];
})) });

test('旧格式历史无损升级为定长数组，统计不变且不改写输入', async (t) => {
  const { dir, file, write } = setup(t);
  write([meta(), context(), record(), record('r2', 40, 10), count(300, 60), meta('other'), context('t2'), record('r3', 7, 1, 't2')]);
  const a = await collect([dir], initialState(), opt);
  const v1 = toV1(a.state), before = JSON.stringify(v1);
  const b = await collect([dir], v1, opt);
  assert.equal(b.state.version, 2);
  assert.equal(b.changed, true);
  assert.deepEqual(b.snapshot, a.snapshot);
  assert.deepEqual(b.state.files, a.state.files);
  assert.equal(JSON.stringify(v1), before);
  const f = Object.values(b.state.files)[0];
  assert.equal(f.ctx.length, 2);
  assert.ok(Object.values(f.records).every(Array.isArray));
  fs.appendFileSync(file, JSON.stringify(record('r4', 5, 5, 't2')) + '\n');
  assert.equal(totals((await collect([dir], b.state, opt)).snapshot), totals(a.snapshot) + 10);
});

test('定长数组在总量与输入加输出不一致时仍逐值还原', () => {
  const f = { ctx: [] };
  const r = { at: 1, session: 's', project: null, model: 'm', turn: null, subagent: true, usage: { input: 3, output: 4, cached: null, reasoning: 0, total: 7 } };
  assert.deepEqual(unpack(f, pack(f, r)), r);
  const odd = { ...r, usage: { ...r.usage, total: 9 } };
  assert.deepEqual(unpack(f, pack(f, odd)), odd);
  assert.equal(f.ctx.length, 1);
});

test('只清理 430 天以前的条目，窗口内统计不变，同一天不重复清理', async (t) => {
  const { dir, write } = setup(t);
  // 以 2026-03-20 为当前：old 超过 430 天应清掉；edge 在 400 天窗口外但仍在 30 天余量内应保留。
  const old = '2025-01-01T10:00:00Z', edge = '2025-02-05T10:00:00Z', mid = '2025-12-01T10:00:00Z';
  write([meta(), row('turn_context', { turn_id: 't0', model: 'model-a' }, old), row('event_msg', { type: 'task_started', turn_id: 't0' }, old),
    row('token_usage_record', { response_id: 'old', turn_id: 't0', usage: u(10, 1) }, old), row('event_msg', { type: 'user_message', turn_id: 't0' }, old),
    row('token_usage_record', { response_id: 'edge', turn_id: 't0', usage: u(30, 3) }, edge),
    row('token_usage_record', { response_id: 'mid', turn_id: 't0', usage: u(20, 2) }, mid)]);
  const early = { ...opt, now: Date.parse('2025-12-02T00:00:00Z') };
  const a = await collect([dir], initialState(), early);
  const late = { ...opt, now: Date.parse('2026-03-20T00:00:00Z') };
  const b = await collect([dir], a.state, late);
  const f = Object.values(b.state.files)[0];
  assert.deepEqual(Object.values(f.records).map((r) => r[0]), [Date.parse(edge), Date.parse(mid)]);
  assert.equal(Object.keys(f.turns).length, 0);
  assert.equal(Object.keys(f.prompts).length, 0);
  assert.equal(Object.keys(f.activity).length, 2);
  assert.deepEqual(b.snapshot.days, summarize(a.state, late).days);
  assert.equal(Object.keys(Object.values(a.state.files)[0].records).length, 3);
  const c = await collect([dir], b.state, { ...late, now: late.now + 3600e3 });
  assert.equal(c.changed, false);
});
