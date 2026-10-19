'use strict';
// 实时投影只保存匿名身份、时间与固定分类。原始钩子对象不能落盘或传给子进程。
const crypto = require('node:crypto');
const HASH = /^[a-f0-9]{24}$/;
const MODEL = /^[a-zA-Z0-9._-]{1,64}$/;
const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'PreCompact', 'SubagentStart', 'SubagentStop'];
const KEEP = 24 * 3600e3;
const anon = (salt, value) => crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 24);
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const cleanName = (s) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : null;
function category(name) {
  if (typeof name !== 'string') return 'o';
  if (/^(Bash|exec_command|write_stdin|shell|shell_command)$/.test(name)) return 's';
  if (/^(apply_patch|Edit|Write)$/.test(name)) return 'e';
  if (/^(Read|Glob|Grep|read_file)$/.test(name)) return 'r';
  if (/^(spawn_agent|Agent|Task)$/.test(name)) return 'a';
  if (/web|search_query|fetch_url/i.test(name)) return 'w';
  if (/browser|chrome|cua_/i.test(name)) return 'b';
  if (/device|simulator|android|ios_/i.test(name)) return 'd';
  if (/^mcp__/.test(name)) return 'm';
  if (/request_user_input|AskUserQuestion/.test(name)) return 'q';
  return 'o';
}
function sanitizeHook(raw, salt, options = {}, now = Date.now()) {
  if (!raw || !EVENTS.includes(raw.hook_event_name) || typeof raw.session_id !== 'string' || !raw.session_id || !finite(now)) return null;
  const r = { event: raw.hook_event_name, at: now, session: anon(salt, `session:${raw.session_id}`),
    turn: typeof raw.turn_id === 'string' && raw.turn_id ? anon(salt, `turn:${raw.turn_id}`) : null,
    tool: typeof raw.tool_use_id === 'string' ? anon(salt, `tool:${raw.tool_use_id}`) : null,
    category: category(raw.tool_name), model: typeof raw.model === 'string' && MODEL.test(raw.model) ? raw.model : null };
  if (typeof raw.cwd === 'string') {
    const normalized = raw.cwd.replace(/\\/g, '/').replace(/\/$/, '');
    r.project = anon(salt, `project:${normalized}`);
    if (options.projects) r.projectName = cleanName(normalized.split('/').filter(Boolean).pop());
  }
  // 不解析工具结果正文，只有明确的结构化错误信号才标记失败。
  if (raw.hook_event_name === 'PostToolUse') {
    const response = raw.tool_response;
    r.failed = raw.is_error === true || response?.is_error === true || response?.isError === true ||
      typeof response?.exit_code === 'number' && response.exit_code !== 0;
  }
  if (['SubagentStart', 'SubagentStop'].includes(r.event) && typeof raw.agent_id === 'string') r.agent = anon(salt, `agent:${raw.agent_id}`);
  return r;
}
function createSession(context) {
  return { session: context.session, project: context.project || null, projectName: context.projectName || null,
    model: context.model || null, state: 'lost', changedAt: context.at, changeKind: 'start', startAt: context.at,
    lastAt: context.at, endAt: null, permSince: null, turn: null, nextN: 1, turns: {}, agents: {}, evidence: 'log' };
}
function turnFor(s, key, at) {
  if (!key) return null;
  if (!s.turns[key]) s.turns[key] = { key, n: s.nextN++, s: at, e: null, end: null, perm: 0,
    waitingSince: null, tools: {}, compactions: 0, lastAt: at };
  return s.turns[key];
}
function transition(s, state, kind, at) {
  if (at < s.changedAt) return;
  s.state = state; s.changeKind = kind; s.changedAt = at;
  if (state === 'ended') s.endAt = at;
}
function finish(s, t, end, at) {
  if (t && (!t.e || at >= t.lastAt)) {
    if (t.waitingSince) t.perm += Math.max(0, at - t.waitingSince);
    t.waitingSince = null; t.e = at; t.end = end; t.lastAt = at;
  }
  if (at >= s.changedAt) s.permSince = null;
  transition(s, 'input', end === 'interrupt' ? 'interrupt' : end === 'error' ? 'error' : 'done', at);
}
function observe(s, event) {
  const at = event.at;
  if (!finite(at) || !HASH.test(event.session || '')) return;
  s.startAt = Math.min(s.startAt, at); s.lastAt = Math.max(s.lastAt, at);
  if (event.project) s.project = event.project;
  if (event.projectName) s.projectName = event.projectName;
  if (event.model) s.model = event.model;
  const key = event.turn || s.turn;
  const t = turnFor(s, key, at);
  if (event.turn && at >= s.changedAt) s.turn = event.turn;
  if (event.event === 'SessionStart') {
    // 打开已有会话不代表它正在运行；保留有证据的在途轮，否则只记可见。
    if (!t || t.e) transition(s, 'input', 'resume', at);
  }
  if (event.event === 'UserPromptSubmit' || event.event === 'task_started') {
    const previous = Object.values(s.turns).find((x) => x.key !== key && !x.e);
    if (previous && at >= previous.lastAt) { previous.e = at; previous.end = 'interrupt'; previous.lastAt = at; }
    if (at >= s.changedAt) { s.endAt = null; s.permSince = null; }
    if (!t?.e) transition(s, 'running', 'turn', at);
  }
  if (event.event === 'PermissionRequest' && t && !t.e && at >= s.changedAt) {
    if (!t.waitingSince) t.waitingSince = at;
    s.permSince = t.waitingSince; transition(s, 'perm', 'perm', at);
  }
  if (event.event === 'PreToolUse' || event.event === 'PostToolUse') {
    if (t && event.tool) {
      const tool = t.tools[event.tool] || { category: event.category || 'o', s: at, e: null, failed: false };
      if (event.event === 'PreToolUse') tool.s = Math.min(tool.s, at);
      else { tool.e = Math.max(tool.e || 0, at); tool.failed = !!event.failed; }
      t.tools[event.tool] = tool;
    }
    // PreToolUse 可能紧邻授权请求且异步乱序；只有结果能证明等待已结束。
    if (event.event === 'PostToolUse' && t && !t.e && at >= s.changedAt) {
      if (t.waitingSince) { t.perm += Math.max(0, at - t.waitingSince); t.waitingSince = null; }
      s.permSince = null; transition(s, 'running', s.state === 'perm' ? 'approved' : 'turn', at);
    } else if (event.event === 'PreToolUse' && t && !t.e && s.state !== 'perm') transition(s, event.category === 'q' ? 'input' : 'running', 'turn', at);
  }
  if (event.event === 'Stop' || event.event === 'task_complete') finish(s, t, 'ok', at);
  if (event.event === 'Interrupt' || event.event === 'turn_aborted') finish(s, t, 'interrupt', at);
  if (event.event === 'turn_failed') finish(s, t, 'error', at);
  if (event.event === 'SessionEnd') {
    if (t && !t.e && at >= t.lastAt) { t.e = at; t.end = 'ended'; t.lastAt = at; }
    if (at >= s.changedAt) s.permSince = null;
    transition(s, 'ended', 'end', at);
  }
  if (event.event === 'PreCompact' && t) t.compactions++;
  if (event.event === 'SubagentStart' && event.agent) s.agents[event.agent] ||= { s: at, e: null };
  if (event.event === 'SubagentStop' && event.agent && s.agents[event.agent]) s.agents[event.agent].e = at;
  if (t) t.lastAt = Math.max(t.lastAt, at);
  const keys = Object.keys(s.turns).sort((a, b) => s.turns[a].s - s.turns[b].s);
  for (const key of keys.slice(0, Math.max(0, keys.length - 60))) delete s.turns[key];
}
function absorbHook(store, event) {
  if (!event || !EVENTS.includes(event.event) || !HASH.test(event.session || '') || !finite(event.at)) return;
  // 即使本机队列文件被改过，也只接收结构投影，不能把任意文本混入历史。
  event = { event: event.event, session: event.session, at: event.at,
    turn: HASH.test(event.turn || '') ? event.turn : null, tool: HASH.test(event.tool || '') ? event.tool : null,
    project: HASH.test(event.project || '') ? event.project : null, projectName: cleanName(event.projectName),
    category: 'reasawbdmqo'.includes(event.category) && event.category?.length === 1 ? event.category : 'o',
    model: MODEL.test(event.model || '') ? event.model : null, failed: event.failed === true,
    agent: HASH.test(event.agent || '') ? event.agent : null };
  store.sessions ||= {};
  const s = store.sessions[event.session] ||= createSession(event);
  s.evidence = 'hook'; observe(s, event);
}
function absorbLog(file, row, context, anonymize) {
  if (!context.session || !finite(context.at)) return;
  if (!file.live || file.live.session !== context.session) file.live = createSession(context);
  const p = row.payload || {}, s = file.live;
  if (context.model && context.model !== 'unknown') s.model = context.model;
  let event = null;
  if (row.type === 'event_msg') {
    if (p.type === 'thread_goal_updated' && ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(p.goal?.status)) {
      if (!s.goalUpdatedAt || context.at >= s.goalUpdatedAt) {
        s.goalStatus = p.goal.status; s.goalUpdatedAt = context.at;
        s.goalCompleteAt = p.goal.status === 'complete' ? context.at : null;
        s.lastAt = Math.max(s.lastAt, context.at);
      }
    }
    if (p.type === 'thread_goal_cleared' && (!s.goalUpdatedAt || context.at >= s.goalUpdatedAt)) {
      s.goalStatus = null; s.goalUpdatedAt = context.at; s.goalCompleteAt = null;
    }
    if (['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) event = { event: p.type };
    if (p.type === 'turn_failed' || p.type === 'error' && p.fatal === true) event = { event: 'turn_failed' };
    if (p.type === 'item_completed') {
      const item = p.item || {};
      const categories = { CommandExecution: 's', FileChange: 'e', McpToolCall: 'm', WebSearch: 'w', ImageView: 'r' };
      if (categories[item.type] && typeof item.id === 'string') event = { event: 'PostToolUse', category: categories[item.type], tool: anonymize(`tool:${item.id}`),
        failed: item.status === 'failed' || typeof item.exit_code === 'number' && item.exit_code !== 0 };
      if (item.type === 'ContextCompaction') event = { event: 'PreCompact' };
    }
  }
  if (row.type === 'token_usage_record') {
    // token 本身由同一文件的去重响应表投影；这里仅记录最近活动，不能用它断言一轮完成。
    s.lastAt = Math.max(s.lastAt, context.at);
  }
  if (event) observe(s, { ...context, ...event });
}
function mergeSession(a, b) {
  if (!a) return structuredClone(b);
  const latest = b.lastAt > a.lastAt || b.lastAt === a.lastAt && b.evidence === 'hook' ? b : a;
  const merged = { ...latest, startAt: Math.min(a.startAt, b.startAt), turns: {} };
  for (const source of [a, b]) for (const [key, t] of Object.entries(source.turns)) {
    const prev = merged.turns[key];
    if (!prev) merged.turns[key] = structuredClone(t);
    else {
      const newer = t.lastAt >= prev.lastAt ? t : prev;
      merged.turns[key] = { ...newer, n: Math.max(prev.n, t.n), s: Math.min(prev.s, t.s),
        e: Math.max(prev.e || 0, t.e || 0) || null, tools: { ...prev.tools, ...t.tools }, perm: Math.max(prev.perm, t.perm), compactions: Math.max(prev.compactions, t.compactions) };
    }
  }
  merged.agents = { ...a.agents, ...b.agents };
  const goal = (a.goalUpdatedAt || 0) > (b.goalUpdatedAt || 0) ? a : b;
  if (goal.goalUpdatedAt) { merged.goalStatus = goal.goalStatus; merged.goalUpdatedAt = goal.goalUpdatedAt; merged.goalCompleteAt = goal.goalCompleteAt; }
  return merged;
}
function sequence(tools) {
  const groups = [];
  for (const t of tools) { const prev = groups.at(-1); if (prev && prev[0] === t.category && prev[1] < 9999) prev[1]++; else groups.push([t.category, 1]); }
  return groups.slice(-40).map((g) => g.join('')).join('');
}
function buildLive(state, options = {}) {
  const now = options.now || Date.now(), sessions = new Map(), records = new Map();
  for (const f of Object.values(state.files || {})) {
    if (f.live) sessions.set(f.live.session, mergeSession(sessions.get(f.live.session), f.live));
    for (const [id, r] of Object.entries(f.records || {})) if (!records.has(id) || r.at >= records.get(id).at) records.set(id, r);
  }
  for (const s of Object.values(state.liveHooks?.sessions || {})) sessions.set(s.session, mergeSession(sessions.get(s.session), s));
  const tokenTotals = new Map();
  for (const r of records.values()) {
    if (r.at < now - KEEP || !r.turn) continue;
    const key = `${r.session}:${r.turn}`, total = tokenTotals.get(key) || { input: 0, output: 0 };
    total.input += r.usage.input; total.output += r.usage.output; tokenTotals.set(key, total);
  }
  const payload = [];
  for (const s of sessions.values()) {
    if (s.lastAt < now - KEEP || s.lastAt > now + 300000) continue;
    const turns = Object.values(s.turns).sort((a, b) => a.s - b.s).slice(-60).map((t, i) => {
      const tools = Object.values(t.tools).sort((a, b) => a.s - b.s);
      const { input = 0, output = 0 } = tokenTotals.get(`${s.session}:${t.key}`) || {};
      const longest = tools.filter((x) => x.e).sort((a, b) => (b.e - b.s) - (a.e - a.s))[0];
      return { id: t.key.slice(0, 16), n: t.n, s: t.s, e: t.e, end: t.end, perm: t.perm + (t.waitingSince ? Math.max(0, now - t.waitingSince) : 0),
        tools: tools.length, seq: sequence(tools), cells: tools.slice(-90).map((x) => x.category).join(''),
        long: longest ? [longest.category, longest.e - longest.s] : null, in: input, out: output, cw: 0,
        err: tools.filter((x) => x.failed).length, cmp: t.compactions };
    });
    const current = Object.values(s.turns).find((t) => t.key === s.turn);
    const lastTools = Object.values(current?.tools || {}).sort((a, b) => a.s - b.s);
    let failures = 0; for (const tool of [...lastTools].reverse()) { if (!tool.failed) break; failures++; }
    payload.push({ sid: s.session.slice(0, 16), proj: s.project?.slice(0, 16) || null,
      state: s.state, changedAt: s.changedAt, changeKind: s.changeKind, startAt: s.startAt, lastAt: s.lastAt,
      // 扫描器仍在运行不能证明 Codex 会话仍在运行；心跳只使用真实事件时刻。
      beatAt: s.lastAt, endAt: s.endAt, permSince: s.permSince, model: s.model, turns,
      tools: turns.reduce((n, t) => n + t.tools, 0), errors: turns.reduce((n, t) => n + t.err, 0),
      compactions: turns.reduce((n, t) => n + t.cmp, 0), fs: failures, subs: Object.values(s.agents).map((a) => [a.s, a.e || 0, 0]),
      ...(s.goalStatus ? { goalStatus: s.goalStatus, goalCompleteAt: s.goalCompleteAt || null } : {}),
      ...(options.projects && s.projectName ? { pname: s.projectName } : {}) });
  }
  payload.sort((a, b) => Number(['ended', 'lost'].includes(a.state)) - Number(['ended', 'lost'].includes(b.state)) || b.lastAt - a.lastAt);
  const body = { tier: options.projects ? 2 : 1, devNow: now, sessions: payload.slice(0, 40) };
  // 保留每个会话的当前轮，再裁旧轮；绝不因为体积大而整批永远上传失败。
  while (Buffer.byteLength(JSON.stringify(body)) > 60 * 1024) {
    const largest = body.sessions.filter((s) => s.turns.length > 1).sort((a, b) => b.turns.length - a.turns.length)[0];
    if (largest) { largest.turns.shift(); largest.clippedTurns = (largest.clippedTurns || 0) + 1; }
    else if (body.sessions.length > 1) body.sessions.pop();
    else break;
  }
  return body;
}
module.exports = { EVENTS, category, sanitizeHook, createSession, observe, absorbHook, absorbLog, buildLive };
