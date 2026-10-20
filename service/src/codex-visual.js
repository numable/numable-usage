// Codex 组件图形投影：缺日保持未知，比例与坐标集中在数据层计算。
const compact = (n) => n == null || !Number.isFinite(n) ? '--' : n >= 1e12 ? (n / 1e12).toFixed(1) + 'T' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n * 10) / 10);
const ratio = (a, b) => b > 0 ? Math.max(0, Math.min(1, a / b)) : 0;

export function codexVisual(m, rows) {
  const offset = (n) => new Date(Date.parse(m.todayDate + 'T12:00:00Z') - n * 864e5).toISOString().slice(0, 10);
  const days = new Map(m.days.map((d) => [d.date, d]));
  const observed = (date) => {
    const contributors = rows.filter((r) => r.days.some((d) => d.date === date));
    return m.known && contributors.length === rows.length && rows.length > 0 && days.has(date);
  };
  const today = days.get(m.todayDate), todayKnown = observed(m.todayDate) && m.known;
  const series = Array.from({ length: 30 }, (_, i) => {
    const date = offset(29 - i), d = days.get(date), has = observed(date) && m.known;
    return { i, date, label: date.slice(5), known: has ? 1 : 0, total: has ? d.total : null,
      input: has ? d.input : null, output: has ? d.output : null };
  });
  const maximum = Math.max(1, ...series.map((d) => d.total || 0));
  for (const d of series) Object.assign(d, { v: ratio(d.total, maximum), iv: ratio(d.input, maximum), ov: ratio(d.output, maximum),
    top: 1 - ratio(d.total, maximum), split: 1 - ratio(d.output, maximum) });
  const heatValues = Array.from({ length: 70 }, (_, i) => {
    const date = offset(69 - i); return { i, date, c: Math.floor(i / 7), r: i % 7,
      total: observed(date) && m.known ? days.get(date).total : null };
  });
  const heatMax = Math.max(1, ...heatValues.map((d) => d.total || 0));
  for (const d of heatValues) d.level = d.total == null ? -1 : d.total === 0 ? 0 : Math.min(4, Math.ceil(d.total / heatMax * 4));
  const period = (start) => {
    const values = Array.from({ length: 7 }, (_, i) => offset(start + i)).filter(observed).map((date) => days.get(date));
    const total = values.reduce((a, d) => a + d.total, 0);
    return { total, value: values.length === 7 ? compact(total) : '--', samples: values.length, complete: values.length === 7 ? 1 : 0 };
  };
  const current = period(1), previous = period(8), periodMax = Math.max(1, current.total, previous.total);
  current.v = current.complete ? current.total / periodMax : 0; previous.v = previous.complete ? previous.total / periodMax : 0;
  const sampleDays = Array.from({ length: 7 }, (_, i) => offset(i + 1)).filter(observed);
  const average = sampleDays.length ? sampleDays.reduce((a, date) => a + days.get(date).total, 0) / sampleDays.length : null;
  const compareMax = Math.max(1, todayKnown ? today.total : 0, average || 0);
  const orderedQuotas = [...m.quotas].sort((a,b) => b.observedAt - a.observedAt);
  const quota = orderedQuotas.find((q) => q.id === 'codex') || orderedQuotas[0];
  const quotaGroup = quota ? m.quotas.indexOf(quota) + 1 : 0;
  const windows = ['primary', 'secondary'].map((key, i) => {
    const w = quota?.[key]; const fresh = !!w && w.resetsAt * 1000 > m.now && quota.observedAt <= m.now && m.now - quota.observedAt <= 15 * 60000;
    const remaining = fresh ? Math.max(0, 100 - w.usedPercent) : null;
    const minutes = w?.windowDurationMins;
    return { i, available: fresh ? 1 : 0, remaining, value: remaining == null ? '--' : compact(remaining) + '%', v: ratio(remaining, 100),
      observedAt: quota?.observedAt || null, resetsAt: w?.resetsAt || null,
      duration: minutes ? (minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`) : '--',
      state: !w ? 'unknown' : w.resetsAt * 1000 <= m.now ? 'expired' : fresh ? 'observed' : 'stale' };
  });
  const ranking = (values, isProject = false) => {
    const total = values.reduce((a, d) => a + d.total, 0);
    return values.slice(0, 5).map((d, i) => ({ i, name: isProject ? d.name || `#${i + 1}` : d.name,
      value: compact(d.total), pct: total ? Math.round(d.total / total * 100) + '%' : '--', v: ratio(d.total, total) }));
  };
  const optionalKnown = (key) => todayKnown && rows.every((r) => r.days.filter((d) => d.date === m.todayDate).every((d) => d[key] != null));
  const cachedKnown = optionalKnown('cached'), reasoningKnown = optionalKnown('reasoning');
  let streak = 0;
  for (let i = todayKnown && (today.total || today.turns || today.prompts) ? 0 : 1; i < 400; i++) {
    const date = offset(i), d = days.get(date); if (!observed(date) || !(d.total || d.turns || d.prompts)) break; streak++;
  }
  const deviceRows = m.devices.slice(0, 4).map((d, i) => ({ i, name: `#${i + 1}`, receivedAt: d.receivedAt,
    fresh: m.now - d.collectedAt <= 10 * 60000 ? 1 : 0 }));
  const week = Array.from({ length: 7 }, (_, i) => { const date = offset(6 - i), d = days.get(date); return { i, known: observed(date) ? 1 : 0, active: observed(date) && d.total > 0 ? 1 : 0, minutes: observed(date) ? d.activeMinutes : null }; });
  const minuteMax = Math.max(1, ...week.map((d) => d.minutes || 0));
  for (const d of week) Object.assign(d, { minuteKnown: d.minutes != null ? 1 : 0, minuteV: ratio(d.minutes, minuteMax), minuteTop: 1 - ratio(d.minutes, minuteMax) });
  return { schema: 1, today: { known: todayKnown ? 1 : 0, value: todayKnown ? compact(today.total) : '--',
    input: todayKnown ? compact(today.input) : '--', output: todayKnown ? compact(today.output) : '--',
    inputV: todayKnown ? ratio(today.input, today.total) : 0, outputV: todayKnown ? ratio(today.output, today.total) : 0,
    turns: todayKnown ? compact(today.turns) : '--', responses: todayKnown ? compact(today.responses) : '--',
    active: optionalKnown('activeMinutes') ? compact(today.activeMinutes) : '--' },
    windows, quotaGroup, quota: windows[0].state === 'unknown' ? windows[1] : windows[0], series, heat: heatValues,
    range: { start: offset(29).slice(5), end: m.todayDate.slice(5), total: series.some((d) => d.known) ? compact(series.filter((d) => d.known).reduce((a, d) => a + d.total, 0)) : '--',
      samples: series.filter((d) => d.known).length, max: series.some((d) => d.known) ? compact(maximum === 1 && !series.some((d) => d.total) ? 0 : maximum) : '--' },
    streak: m.known ? streak : '--', heatStart: offset(69).slice(5), heatEnd: m.todayDate.slice(5), activeDates: m.known ? heatValues.filter((d) => d.total > 0).length : '--',
    week,
    models: ranking(m.models), projects: ranking(m.projects, true), modelCount: m.models.length, projectCount: m.projects.length,
    optional: { cached: cachedKnown ? compact(today.cached) : '--', cachedPct: cachedKnown && today.input ? Math.round(today.cached / today.input * 100) + '%' : '--',
      cachedV: cachedKnown ? ratio(today.cached, today.input) : 0, reasoning: reasoningKnown ? compact(today.reasoning) : '--',
      reasoningPct: reasoningKnown && today.output ? Math.round(today.reasoning / today.output * 100) + '%' : '--', reasoningV: reasoningKnown ? ratio(today.reasoning, today.output) : 0 },
    periods: { current, previous }, average: { value: compact(average), samples: sampleDays.length, todayV: todayKnown ? today.total / compareMax : 0, v: average == null ? 0 : average / compareMax },
    overview: [{ i: 0, value: m.known ? compact(m.totals.total) : '--' }, { i: 1, value: m.known ? compact(m.totals.responses) : '--' }, { i: 2, value: m.known ? compact(m.totals.sessions) : '--' }, { i: 3, value: m.known ? compact(m.totals.activeDays) : '--' }],
    devices: deviceRows, deviceCount: m.devices.length, deviceFresh: m.devices.filter((d) => m.now - d.collectedAt <= 10 * 60000).length };
}
