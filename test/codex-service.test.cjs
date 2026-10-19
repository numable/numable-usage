'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = import('../service/src/codex.js');
const now = Date.parse('2026-10-19T12:00:00Z');
const tok = (total = 120) => ({ input: total - 20, output: 20, total, cached: 40, reasoning: 10, responses: 1 });
const base = () => ({ v: 1, collectedAt: now, timezone: 'Asia/Kuala_Lumpur', coverage: [{ source: 'cli', version: '0.163.0', files: 1 }],
  days: [{ date: '2026-10-19', ...tok(), turns: 1, sessions: 1, prompts: 1, activeMinutes: 1, models: { 'gpt-test': tok() },
    projects: { aaaaaaaaaaaaaaaaaaaaaaaa: { ...tok(), name: '秘密项目' } } }],
  quotas: [{ id: 'codex', account: 'bbbbbbbbbbbbbbbbbbbbbbbb', origin: 'rpc', observedAt: now - 1000,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: now / 1000 + 3600 }, secondary: null }] });
test('服务双重白名单去掉正文、路径、登录凭证和未开启的项目名', async () => {
  const { sanitizeCodex } = await mod;
  const raw = base(); raw.secret = 'NEVER_SEND'; raw.days[0].cwd = '/private/path';
  raw.days[0].models['gpt-test'].apiKey = 'NEVER_SEND'; raw.quotas[0].email = 'NEVER_SEND';
  const clean = sanitizeCodex(raw, now), text = JSON.stringify(clean);
  assert.ok(!text.includes('NEVER_SEND') && !text.includes('/private') && !text.includes('秘密项目'));
  assert.equal(clean.days[0].total, 120); assert.equal(clean.privacy.projects, false);
  raw.privacy = { projects: true };
  assert.equal(sanitizeCodex(raw, now).days[0].projects.aaaaaaaaaaaaaaaaaaaaaaaa.name, '秘密项目');
});
test('未知版本、未来快照、无效时区与非法 token 不能成为有效统计', async () => {
  const { sanitizeCodex } = await mod;
  assert.equal(sanitizeCodex({ ...base(), v: 2 }, now), null);
  assert.equal(sanitizeCodex({ ...base(), collectedAt: now + 600000 }, now), null);
  assert.equal(sanitizeCodex({ ...base(), timezone: 'invalid/zone' }, now), null);
  const raw = base(); raw.days[0].input = -1;
  assert.equal(sanitizeCodex(raw, now), null);
});
test('同账号跨设备额度只取最新，用量相加；不同账号与未知账号分别保留', async () => {
  const { sanitizeCodex, mergeCodex } = await mod;
  const a = { device: 'aaaa', updatedAt: now, ...sanitizeCodex(base(), now) };
  const raw = base(); raw.quotas[0].observedAt = now; raw.quotas[0].primary.usedPercent = 40;
  const b = { device: 'bbbb', updatedAt: now, ...sanitizeCodex(raw, now) };
  let merged = mergeCodex([a, b], '2026-10-19', now);
  assert.equal(merged.today.total, 240); assert.equal(merged.quotas.length, 1);
  assert.equal(merged.quotas[0].primary.remainingPercent, 60);
  b.quotas[0].account = 'cccccccccccccccccccccccc';
  merged = mergeCodex([a, b], '2026-10-19', now); assert.equal(merged.quotas.length, 2);
  a.quotas[0].account = null; b.quotas[0].account = null;
  merged = mergeCodex([a, b], '2026-10-19', now); assert.equal(merged.quotas.length, 2);
});
test('过期额度保留旧观测，不自动恢复 100%；未知用量显示占位', async () => {
  const { sanitizeCodex, mergeCodex } = await mod;
  const raw = base(); raw.quotas[0].primary.resetsAt = now / 1000 - 1;
  const a = { device: 'aaaa', ...sanitizeCodex(raw, now) };
  const merged = mergeCodex([a], '2026-10-19', now);
  assert.equal(merged.quotas[0].primary.expired, true); assert.equal(merged.quotas[0].primary.remainingPercent, 75);
  assert.equal(mergeCodex([], '', now).display.total, '--');
  const next = mergeCodex([a], '2026-10-20', now + 864e5);
  assert.equal(next.today.total, 0); assert.equal(next.display.todayTotal, '0');
});
test('跨时区与日志读取失败明确标注数据口径和完整性', async () => {
  const { sanitizeCodex, mergeCodex } = await mod;
  const a = { device: 'aaaa', ...sanitizeCodex(base(), now) };
  const raw = base(); raw.timezone = 'UTC'; raw.collection = { unreadableFiles: 1 };
  const b = { device: 'bbbb', ...sanitizeCodex(raw, now) };
  const m = mergeCodex([a, b], '2026-10-19', now);
  assert.equal(m.mixedTimezones, true); assert.equal(m.incomplete, true);
});
test('重复日期不在同一设备内重复累加，未知字段不可污染对象原型', async () => {
  const { sanitizeCodex, mergeCodex } = await mod;
  const raw = base(); raw.days.push(structuredClone(raw.days[0]));
  raw.days[0].models.constructor = tok();
  const clean = sanitizeCodex(raw, now);
  assert.equal(clean.days.length, 1);
  assert.equal(mergeCodex([{ device: 'aaaa', ...clean }], '2026-10-19', now).today.total, 120);
});

test('只有会话元数据没有任何响应时，不能把未知用量展示成零', async () => {
  const { sanitizeCodex, mergeCodex } = await mod;
  const raw = base(); raw.days = [];
  const m = mergeCodex([{ device: 'aaaa', ...sanitizeCodex(raw, now) }], '2026-10-19', now);
  assert.equal(m.known, false); assert.equal(m.display.todayTotal, '--');
});
