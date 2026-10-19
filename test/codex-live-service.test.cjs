'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = import('../service/src/live.js');
const now = Date.now();
const session = () => ({ sid: 'aaaaaaaaaaaaaaaa', state: 'input', startAt: now - 1200000, lastAt: now, beatAt: now,
  changedAt: now, goalStatus: 'complete', goalCompleteAt: now - 1000, objective: 'SECRET_OBJECTIVE',
  turns: [{ id: 'bbbbbbbbbbbbbbbb', n: 60, s: now - 1200000, e: now - 1000, end: 'ok' }] });
test('明确目标完成仅保留状态，提醒显式开启且与长轮次结束独立', async () => {
  const { sanitizeLive, mergeLive, pushEvents, alertView } = await mod;
  const clean = sanitizeLive({ tier: 1, devNow: now, sessions: [session()] });
  assert.ok(!JSON.stringify(clean).includes('SECRET'));
  const merged = mergeLive({ device01: { ...clean, at: now, skew: 0 } }, now);
  assert.ok(!pushEvents(merged, {}, 0, 'codex').some((e) => e.kind === 'goal'));
  assert.ok(!pushEvents(merged, { goal: true }, 0).some((e) => e.kind === 'goal'));
  const events = pushEvents(merged, { goal: true }, now - 5000, 'codex');
  assert.equal(events.filter((e) => e.kind === 'goal').length, 1);
  assert.ok(events.find((e) => e.kind === 'done').key.endsWith(':bbbbbbbbbbbbbbbb'));
  assert.ok(alertView(merged).goalKey);
  assert.ok(!pushEvents(merged, { goal: true }, now, 'codex').some((e) => e.kind === 'goal'));
  const error = session(); error.goalStatus = 'active'; error.turns[0].end = 'error';
  const next = mergeLive({ device01: { ...sanitizeLive({ sessions: [error] }), at: now, skew: 0 } }, now);
  assert.ok(!pushEvents(next, { goal: true }, 0, 'codex').some((e) => ['done', 'goal'].includes(e.kind)));
});
test('实时序号拒绝旧包与同序号覆盖，DO 重建后仍保留来源与序号', async () => {
  const { LiveSpace } = await mod;
  const values = new Map(); let alarm;
  const ctx = { storage: { get: async (k) => values.get(k), put: async (k, v) => values.set(k, structuredClone(v)),
    list: async ({ prefix }) => new Map([...values].filter(([k]) => k.startsWith(prefix))), getAlarm: async () => alarm, setAlarm: async (v) => { alarm = v; } } };
  let object = new LiveSpace(ctx, {});
  const post = (seq, sessions = [session()]) => object.fetch(new Request('https://test/live?source=codex&dev=device01', {
    method: 'POST', body: JSON.stringify({ seq, sessions, devNow: now }) }));
  assert.equal((await post(2)).status, 200);
  assert.equal((await (await post(1, [])).json()).ignored, true);
  assert.equal((await (await post(2, [])).json()).ignored, true);
  object = new LiveSpace(ctx, {});
  assert.equal((await (await post(undefined, [])).json()).ignored, true);
  assert.equal(object.source, 'codex'); assert.equal(values.get('dev:device01').sessions.length, 1);
  assert.equal((await post(3, [])).status, 200); assert.equal(values.get('dev:device01').sessions.length, 0);
});
test('额度提醒只认十五分钟内有效观测，阈值与未知账号目录互相隔离', async () => {
  const { mergeCodex } = await import('../service/src/codex.js');
  const row = { device: 'device01', timezone: 'UTC', days: [], collectedAt: now, quotas: [
    { id: 'codex', profile: 'a'.repeat(24), account: null, observedAt: now, primary: { usedPercent: 85, resetsAt: now / 1000 + 3600 } },
    { id: 'codex', profile: 'b'.repeat(24), account: null, observedAt: now, primary: { usedPercent: 40, resetsAt: now / 1000 + 3600 } }] };
  const merge = (at = now, threshold = 20) => mergeCodex([row], '2026-10-19', at, { quotaThreshold: threshold });
  assert.equal(merge().quotas.length, 2); assert.equal(merge().alerts.quota.remaining, 15);
  assert.equal(merge(now, 10).alerts.quota.key, '');
  assert.notEqual(merge().alerts.quota.key, merge(now, 30).alerts.quota.key);
  assert.equal(merge(now + 16 * 60000).alerts.quota.key, '');
  row.quotas[0].primary.resetsAt = now / 1000 - 1;
  assert.equal(merge().alerts.quota.key, '');
});
test('删除 Codex 设备清空实时视图，重建后仍拒绝旧序号，新序号可恢复', async () => {
  const { LiveSpace } = await mod;
  const values = new Map(); let alarm;
  const ctx = { storage: { get: async (k) => values.get(k), put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k), list: async ({ prefix }) => new Map([...values].filter(([k]) => k.startsWith(prefix))),
    getAlarm: async () => alarm, setAlarm: async (v) => { assert.ok(Number.isFinite(v)); alarm = v; } } };
  let object = new LiveSpace(ctx, {});
  const post = (seq, dev = 'deadbeef') => object.fetch(new Request(`https://test/?source=codex&dev=${dev}`, {
    method: 'POST', body: JSON.stringify({ seq, sessions: [session()], devNow: now }) }));
  const get = async () => (await object.fetch(new Request('https://test/'))).json();
  const forget = async (dev = 'deadbeef') => (await object.fetch(new Request(`https://test/forget?source=codex&dev=${dev}`, { method: 'POST' }))).json();
  await post(2); assert.equal((await get()).sessions.length, 1);
  assert.equal((await forget()).removed, 1);
  assert.equal((await get()).sessions.length, 0); assert.equal((await get()).devices.length, 0);
  assert.equal((await forget()).removed, 0, '重复删除须幂等');
  object = new LiveSpace(ctx, {});
  assert.equal((await (await post(1)).json()).ignored, true);
  assert.equal((await (await post(2)).json()).ignored, true);
  assert.equal((await get()).sessions.length, 0, '旧包不得复活已删除设备');
  await post(3); assert.equal((await get()).sessions.length, 1);
  assert.equal((await get()).devices.length, 1, '更新的主动上报可恢复设备');
  await forget();
  object.rows.deadbeef.at = now - 25 * 3600e3;
  await object.alarm();
  assert.equal(values.has('dev:deadbeef'), false, '序号墓碑沿用 24 小时清理');
  for (let i = 0; i < 20; i++) assert.equal((await post(1, (0x1000 + i).toString(16))).status, 200);
  assert.equal((await post(1, 'ffff')).status, 409);
  await forget('1000');
  assert.equal((await post(1, 'ffff')).status, 200, '删除后的墓碑不得继续占用活跃设备名额');
  assert.equal((await get()).devices.length, 20);
});
