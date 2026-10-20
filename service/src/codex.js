import { codexVisual } from './codex-visual.js';
// Codex 专用数据契约。显式构造白名单，不继承 Claude Code 的缓存与计费口径。
const HASH = /^[a-f0-9]{24}$/;
const MODEL = /^[a-zA-Z0-9._-]{1,80}$/;
const ID = /^[a-zA-Z0-9._-]{1,64}$/;
const FIELDS = ['input', 'output', 'cached', 'reasoning', 'total'];
const COUNT = ['responses', 'turns', 'sessions', 'prompts', 'activeMinutes'];
const DIAGNOSTICS = ['invalidRows', 'invalidUsage', 'missingIdentity', 'unknownFiles', 'legacyRecords', 'unassignedLegacy'];
const COLLECTION = ['files', 'scanned', 'rows', 'unreadableFiles', 'compressedUnavailable', 'unreadableDirectories'];
const n = (x) => Number.isSafeInteger(x) && x >= 0 ? x : null;
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const empty = () => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
const counters = (x, keys) => Object.fromEntries(keys.map((k) => [k, n(x?.[k]) ?? 0]));
const sum = (a, b, keys = FIELDS) => { for (const k of keys) a[k] = a[k] === null || b[k] === null ? null : a[k] + b[k]; };
function cleanUsage(raw) {
  if (!raw || n(raw.input) === null || n(raw.output) === null) return null;
  const input = n(raw.input), output = n(raw.output), total = input + output;
  if (!Number.isSafeInteger(total) || raw.total !== total) return null;
  const cached = n(raw.cached), reasoning = n(raw.reasoning);
  if (cached > input || reasoning > output) return null;
  return { input, output, cached, reasoning, total, ...counters(raw, ['responses']) };
}
function cleanWindow(w) {
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 ||
    !Number.isFinite(w.windowDurationMins) || w.windowDurationMins <= 0 || w.windowDurationMins > 525600 || n(w.resetsAt) === null || !w.resetsAt) return null;
  return { usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins, resetsAt: w.resetsAt };
}
export function sanitizeCodex(raw, now = Date.now()) {
  if (!raw || raw.v !== 1 || n(raw.collectedAt) === null || !raw.collectedAt || raw.collectedAt > now + 300000 || !Array.isArray(raw.days)) return null;
  let timezone;
  try { timezone = new Intl.DateTimeFormat('en', { timeZone: raw.timezone }).resolvedOptions().timeZone; } catch { return null; }
  if (!raw.timezone) return null;
  const projectsEnabled = raw.privacy?.projects === true;
  const days = new Map();
  for (const d of raw.days.slice(-400)) {
    if (!d || !validDate(d.date)) return null;
    const u = cleanUsage(d); if (!u) return null;
    const models = Object.create(null), projects = Object.create(null);
    for (const [key, value] of Object.entries(d.models || {}).slice(0, 32)) {
      const valueClean = cleanUsage(value);
      if (MODEL.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && valueClean) models[key] = valueClean;
    }
    for (const [key, value] of Object.entries(d.projects || {}).slice(0, 40)) {
      const valueClean = cleanUsage(value);
      if (!HASH.test(key) || !valueClean) continue;
      if (projectsEnabled && typeof value.name === 'string') {
        const name = value.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
        if (name) valueClean.name = name;
      }
      projects[key] = valueClean;
    }
    days.set(d.date, { date: d.date, ...u, ...counters(d, COUNT), activeMinutes: n(d.activeMinutes) === null ? null : Math.min(d.activeMinutes, 1440), models, projects });
  }
  const quotas = [];
  for (const q of (Array.isArray(raw.quotas) ? raw.quotas : []).slice(0, 32)) {
    if (!q || typeof q.id !== 'string' || !ID.test(q.id) || n(q.observedAt) === null || !q.observedAt || q.observedAt > raw.collectedAt + 300000) continue;
    const primary = cleanWindow(q.primary), secondary = cleanWindow(q.secondary);
    if (!primary && !secondary) continue;
    quotas.push({ id: q.id, account: typeof q.account === 'string' && HASH.test(q.account) ? q.account : null,
      profile: typeof q.profile === 'string' && HASH.test(q.profile) ? q.profile : null,
      origin: q.origin === 'rpc' ? 'rpc' : 'log', observedAt: q.observedAt, primary, secondary });
  }
  const coverage = (Array.isArray(raw.coverage) ? raw.coverage : []).slice(0, 32).map((c) => ({
    source: ['cli', 'vscode', 'exec', 'appServer', 'subagent'].includes(c?.source) ? c.source : 'unknown',
    version: typeof c?.version === 'string' && /^[a-zA-Z0-9.+_-]{1,64}$/.test(c.version) ? c.version : null,
    files: n(c?.files) ?? 0,
  }));
  return { v: 1, collectedAt: raw.collectedAt, timezone, privacy: { projects: projectsEnabled },
    sessionCount: n(raw.sessionCount),
    quotaDiagnostics: { failures: n(raw.quotaDiagnostics?.failures) ?? 0, profiles: n(raw.quotaDiagnostics?.profiles) ?? 0 },
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), quotas, coverage,
    diagnostics: counters(raw.diagnostics, DIAGNOSTICS), collection: counters(raw.collection, COLLECTION) };
}

export function mergeCodex(rows, anchor = '', now = Date.now(), options = {}) {
  const today = validDate(anchor) ? anchor : new Date(now).toISOString().slice(0, 10);
  const days = new Map(), quotas = new Map(), devices = [], timezones = new Set();
  const diagnostics = Object.fromEntries(DIAGNOSTICS.map((k) => [k, 0]));
  for (const row of rows) {
    timezones.add(row.timezone);
    devices.push({ device: row.device, receivedAt: row.updatedAt, collectedAt: row.collectedAt,
      timezone: row.timezone, coverage: row.coverage, collection: row.collection, diagnostics: row.diagnostics });
    for (const k of DIAGNOSTICS) diagnostics[k] += row.diagnostics?.[k] || 0;
    for (const d of row.days || []) {
      if (!days.has(d.date)) days.set(d.date, { date: d.date, ...empty(), ...counters({}, COUNT), models: {}, projects: {} });
      const dest = days.get(d.date); sum(dest, d); sum(dest, d, COUNT);
      for (const [key, m] of Object.entries(d.models || {})) {
        if (!dest.models[key]) dest.models[key] = { ...empty(), responses: 0 };
        sum(dest.models[key], m); dest.models[key].responses += m.responses;
      }
      for (const [key, p] of Object.entries(d.projects || {})) {
        const projectKey = `${row.device}:${key}`;
        if (!dest.projects[projectKey]) dest.projects[projectKey] = { id: projectKey, device: row.device, ...empty(), responses: 0, ...(p.name ? { name: p.name } : {}) };
        sum(dest.projects[projectKey], p); dest.projects[projectKey].responses += p.responses;
      }
    }
    for (const q of row.quotas || []) {
      const key = `${q.account || `device:${row.device}:${q.profile || 'default'}`}:${q.id}`;
      // 已知账号取最新观测；未知账号保留设备维度，不能猜测同账号。
      if (!quotas.has(key) || q.observedAt > quotas.get(key).observedAt) quotas.set(key, { ...q, device: row.device });
    }
  }
  const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totals = { ...empty(), ...counters({}, COUNT), activeDays: 0 };
  const models = new Map(), projects = new Map();
  for (const d of list) {
    sum(totals, d); sum(totals, d, COUNT);
    if (d.total || d.turns || d.prompts) totals.activeDays++;
    for (const [name, m] of Object.entries(d.models)) {
      if (!models.has(name)) models.set(name, { name, ...empty(), responses: 0 });
      sum(models.get(name), m); models.get(name).responses += m.responses;
    }
    for (const [id, p] of Object.entries(d.projects)) {
      if (!projects.has(id)) projects.set(id, { id, device: p.device, ...empty(), responses: 0, ...(p.name ? { name: p.name } : {}) });
      sum(projects.get(id), p); projects.get(id).responses += p.responses;
    }
  }
  // 每日会话数相加会把跨午夜会话重复算；总会话数采用采集器去重后的独立指标。
  totals.sessions = rows.every((r) => n(r.sessionCount) !== null) ? rows.reduce((a, r) => a + r.sessionCount, 0) : null;
  // 找到元数据不等于读到了用量；至少有一个有效响应，才把零解释为可确认的零。
  const known = rows.some((r) => (r.days || []).some((d) => d.responses > 0));
  const todayData = days.get(today) || { date: today, ...empty(), ...counters({}, COUNT) };
  const incomplete = Object.entries(diagnostics).some(([k, v]) => k !== 'legacyRecords' && v > 0) || devices.some((d) =>
    d.collection?.unreadableFiles || d.collection?.compressedUnavailable || d.collection?.unreadableDirectories);
  const receivedAt = Math.max(0, ...devices.map((d) => d.receivedAt || 0));
  const collectedAt = Math.max(0, ...devices.map((d) => d.collectedAt || 0));
  const fmt = (v) => v === null || !known ? '--' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(v);
  const before = (offset) => new Date(Date.parse(today + 'T12:00:00Z') - offset * 864e5).toISOString().slice(0, 10);
  const startDate = list[0]?.date || null;
  const daily30 = Array.from({ length: 30 }, (_, i) => {
    const date = before(29 - i), d = days.get(date);
    return { date, total: d?.total ?? (startDate && date >= startDate ? 0 : null) };
  });
  const maximum = Math.max(1, ...daily30.map((d) => d.total || 0));
  const bars = daily30.map((d, i) => ({ ...d, i, v: d.total === null ? 0 : d.total / maximum, u: d.total === null ? 1 : 1 - d.total / maximum }));
  const heatDays = Array.from({ length: 70 }, (_, i) => {
    const date = before(69 - i), d = days.get(date), total = d?.total ?? (startDate && date >= startDate ? 0 : null);
    const level = total === null ? -1 : total === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(total / maximum * 4)));
    return { date, total, c: Math.floor(i / 7), r: i % 7, level };
  });
  const allQuotas = [...quotas.values()].sort((a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id));
  const mainQuota = allQuotas.find((q) => q.id === 'codex') || allQuotas[0];
  const mainWindow = mainQuota?.primary || mainQuota?.secondary;
  const quotaValid = !!mainWindow && mainWindow.resetsAt * 1000 > now;
  const threshold = Number.isFinite(options.quotaThreshold) ? Math.max(0, Math.min(100, options.quotaThreshold)) : 20;
  const low = allQuotas.flatMap((q) => ['primary', 'secondary'].map((which) => ({ q, w: q[which], which })))
    .filter(({ q, w }) => w && w.resetsAt * 1000 > now && now >= q.observedAt && now - q.observedAt <= 15 * 60000 && 100 - w.usedPercent <= threshold)
    .sort((a, b) => a.w.resetsAt - b.w.resetsAt || b.w.usedPercent - a.w.usedPercent)[0];
  const quotaAlert = low ? { key: `${low.q.account || low.q.device + ':' + (low.q.profile || 'default')}:${low.q.id}:${low.which}:${low.w.resetsAt}:${threshold}`,
    remaining: Math.max(0, 100 - low.w.usedPercent), resetsAt: low.w.resetsAt } : { key: '', remaining: null, resetsAt: null };
  let streak = 0;
  for (let i = days.get(today)?.total || days.get(today)?.turns ? 0 : 1; i < 400; i++) {
    const d = days.get(before(i)); if (!d || !(d.total || d.turns || d.prompts)) break; streak++;
  }
  const merged = { now, todayDate: today, known, incomplete, timezones: [...timezones], mixedTimezones: timezones.size > 1,
    quotaIncomplete: rows.some((r) => r.quotaDiagnostics?.failures > 0),
    receivedAt, collectedAt, totals, today: todayData, days: list,
    models: [...models.values()].sort((a, b) => b.total - a.total), projects: [...projects.values()].sort((a, b) => b.total - a.total), devices, diagnostics,
    quotas: [...quotas.values()].map((q) => ({ ...q,
      primary: q.primary && { ...q.primary, remainingPercent: Math.max(0, 100 - q.primary.usedPercent), expired: q.primary.resetsAt * 1000 <= now },
      secondary: q.secondary && { ...q.secondary, remainingPercent: Math.max(0, 100 - q.secondary.usedPercent), expired: q.secondary.resetsAt * 1000 <= now },
    })),
    alerts: { quota: quotaAlert },
    display: { todayInput: fmt(todayData.input), todayOutput: fmt(todayData.output), todayTotal: fmt(todayData.total), total: fmt(totals.total) },
    widgets: { bars, heat: heatDays, streak, quota: { available: quotaValid ? 1 : 0,
      remaining: quotaValid ? Math.max(0, 100 - mainWindow.usedPercent) : null,
      v: quotaValid ? Math.max(0, 1 - mainWindow.usedPercent / 100) : 0,
      resetsAt: mainWindow?.resetsAt || null, observedAt: mainQuota?.observedAt || null,
      windowDurationMins: mainWindow?.windowDurationMins || null, bucket: mainQuota?.id || null,
      expired: !!mainWindow && !quotaValid ? 1 : 0 } } };
  merged.visual = codexVisual(merged, rows);
  return merged;
}
