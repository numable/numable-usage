// 实时会话夹具测试:node --test test/
// 每条都挑「实现错了就会红」的输入:授权态出口、乱序 Pre/Post、打断、并发 hook、正文不落盘。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin', 'scripts', 'live.cjs');
const L = require(SCRIPT);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nbl-'));
const ALIVE = () => true;
const DEAD = () => false;

let clock = 1_000_000;
const ev = (name, extra = {}) => ({ session_id: 's1', hook_event_name: name, cwd: '/tmp/proj', _t: (clock += 1000), _ppid: 4242, ...extra });
const feed = (live, ...evs) => { for (const e of evs) L.reduce(live, e); return live.sessions.s1; };

test('类目:只认工具名,MCP 按名字归浏览器 / 设备', () => {
  assert.equal(L.catOf('Edit'), 'edit');
  assert.equal(L.catOf('Bash'), 'shell');
  assert.equal(L.catOf('mcp__claude-in-chrome__computer'), 'browser');
  assert.equal(L.catOf('mcp__Claude_Code_iOS_Simulator__control'), 'device');
  assert.equal(L.catOf('mcp__github__create_issue'), 'mcp');
});

test('授权态由 PostToolUse 退出(不是 PreToolUse),等待时长记进本轮', () => {
  const live = L.emptyLive();
  let s = feed(live, ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'a' }), ev('PermissionRequest', { tool_name: 'Bash' }));
  assert.equal(s.state, 'perm');
  const permAt = clock;
  s = feed(live, ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'a', duration_ms: 500 }));
  assert.equal(s.state, 'running');
  assert.equal(s.turns[0].permMs, clock - permAt);
  assert.deepEqual(s.turns[0].longest, ['shell', 500]);
});

test('权限通知与 PermissionRequest 同时来只算一次等待;空闲通知不改状态', () => {
  const live = L.emptyLive();
  let s = feed(live, ev('UserPromptSubmit'), ev('PermissionRequest'));
  const since = s.perm.since;
  s = feed(live, ev('Notification', { notification_type: 'permission_prompt' }));
  assert.equal(s.perm.since, since);
  s = feed(live, ev('Stop'), ev('Notification', { notification_type: 'idle_prompt' }));
  assert.equal(s.state, 'input');
});

test('乱序:Post 先到、Pre 后到,工具只记一次', () => {
  const live = L.emptyLive();
  const s = feed(live, ev('UserPromptSubmit'),
    ev('PostToolUse', { tool_name: 'Read', tool_use_id: 'x' }),
    ev('PreToolUse', { tool_name: 'Read', tool_use_id: 'x' }));
  assert.equal(s.tools, 1);
  assert.deepEqual(s.turns[0].seq, [['read', 1]]);
});

test('工具序列游程压缩', () => {
  const live = L.emptyLive();
  feed(live, ev('UserPromptSubmit'));
  for (const [n, id] of [['Read', 1], ['Grep', 2], ['Edit', 3], ['Edit', 4], ['Bash', 5]]) feed(live, ev('PreToolUse', { tool_name: n, tool_use_id: String(id) }));
  assert.deepEqual(live.sessions.s1.turns[0].seq, [['read', 2], ['edit', 2], ['shell', 1]]);
});

test('上一轮没 Stop 就来了新的一句 = 上一轮被打断', () => {
  const live = L.emptyLive();
  const s = feed(live, ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'b' }), ev('UserPromptSubmit'));
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns[0].end, 'interrupt');
  assert.equal(s.turns[1].e, null);
  assert.equal(s.state, 'running');
});

test('Stop / StopFailure 收轮,状态 = 等你输入', () => {
  const live = L.emptyLive();
  let s = feed(live, ev('UserPromptSubmit'), ev('Stop'));
  assert.equal(s.turns[0].end, 'ok'); assert.equal(s.state, 'input'); assert.equal(s.changeKind, 'done');
  s = feed(live, ev('UserPromptSubmit'), ev('StopFailure'));
  assert.equal(s.turns[1].end, 'error'); assert.equal(s.state, 'input');
});

test('推导态:运行中但进程没了 = 可能已断开;等你输入 30 分钟 = 搁置', () => {
  const live = L.emptyLive();
  const s = feed(live, ev('UserPromptSubmit'));
  assert.equal(L.derive(s, clock, ALIVE), 'running');
  assert.equal(L.derive(s, clock, DEAD), 'lost');
  feed(live, ev('Stop'));
  assert.equal(L.derive(s, clock + 1000, DEAD), 'input');          // 等你输入不看进程
  assert.equal(L.derive(s, s.changedAt + L.PARK_MS + 1, ALIVE), 'parked');
});

test('「并行」= 运行 + 授权 + 输入,不含搁置 / 断开 / 结束', () => {
  const live = L.emptyLive();
  const mk = (sid, ...evs) => { for (const e of evs) L.reduce(live, { ...e, session_id: sid }); };
  mk('a', ev('UserPromptSubmit'));
  mk('b', ev('UserPromptSubmit'), ev('PermissionRequest'));
  mk('c', ev('UserPromptSubmit'), ev('Stop'));
  mk('d', ev('UserPromptSubmit'), ev('SessionEnd'));
  const c = L.counts(live, clock, ALIVE);
  assert.equal(c.parallel, 3);
  assert.equal(c.ended, 1);
  assert.match(L.statusLine(live, clock, ALIVE), /▶ 1 在跑 · ⚠ 1 等授权 · ⏸ 1 等你/);
});

test('子代理区间', () => {
  const live = L.emptyLive();
  const s = feed(live, ev('UserPromptSubmit'), ev('SubagentStart', { agent_id: 'g1', agent_type: 'Explore' }), ev('SubagentStop', { agent_id: 'g1' }));
  assert.equal(s.subs.length, 1);
  assert.ok(s.subs[0].e > s.subs[0].s);
});

test('token:按 message.id + requestId 去重,cache_read 不计;首次见到会话记录从末尾读起', () => {
  const dir = tmp(); const f = path.join(dir, 't.jsonl');
  const a = (id, req, out) => JSON.stringify({ type: 'assistant', requestId: req, message: { id, usage: { input_tokens: 2, output_tokens: out, cache_creation_input_tokens: 5, cache_read_input_tokens: 999 } } }) + '\n';
  fs.writeFileSync(f, a('old', 'r0', 1000));                    // 打开插件之前的历史
  const live = L.emptyLive();
  feed(live, ev('UserPromptSubmit', { transcript_path: f }));
  fs.appendFileSync(f, a('m1', 'r1', 10) + a('m1', 'r1', 10) + a('m2', 'r2', 7));   // 同一响应写两行
  const s = live.sessions.s1;
  const tok = L.readTokens(s);
  assert.deepEqual(tok, { out: 17, in: 4, cw: 10 });
  assert.deepEqual(L.readTokens(s), { out: 0, in: 0, cw: 0 });  // 读过的不再算
});

test('被打断检测:只认晚于本轮开始的「[Request interrupted」', () => {
  const dir = tmp(); const f = path.join(dir, 't.jsonl');
  const u = (ts, text) => JSON.stringify({ type: 'user', timestamp: new Date(ts).toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n';
  fs.writeFileSync(f, u(1000, '[Request interrupted by user]'));
  assert.equal(L.interruptedSince(f, 2000), false);
  fs.appendFileSync(f, u(3000, '[Request interrupted by user]'));
  assert.equal(L.interruptedSince(f, 2000), true);
});

// ---------- 真进程:hook 入口 ----------
function runHook(dir, payload) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, '--hook'], { env: { ...process.env, NUMABLE_USAGE_STATE_DIR: dir, NUMABLE_LIVE_NO_DAEMON: '1' }, stdio: ['pipe', 'ignore', 'inherit'] });
    p.on('exit', resolve);
    p.stdin.end(JSON.stringify(payload));
  });
}

test('未打开实时会话时 hook 什么都不写', async () => {
  const dir = tmp();
  await runHook(dir, { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  assert.equal(fs.existsSync(path.join(dir, 'live.json')), false);
});

test('并发 hook:20 个工具调用同时到,一个不丢、文件不坏;提示词与工具参数不落盘', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ live: true }));
  await runHook(dir, { session_id: 's', hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'SECRET-PROMPT' });
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(runHook(dir, { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u' + i, tool_input: { command: 'SECRET-CMD' } }));
    jobs.push(runHook(dir, { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'u' + i, tool_input: { command: 'SECRET-CMD' }, tool_response: 'SECRET-OUT' }));
  }
  await Promise.all(jobs);
  await runHook(dir, { session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'SECRET-REPLY' });
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8'));
  assert.equal(live.sessions.s.tools, 10);
  assert.equal(live.sessions.s.state, 'input');
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.doesNotMatch(all, /SECRET/);
});

test('守护进程:Claude Code 进程没了就标「可能已断开」,不替它心跳', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ live: true }));
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.on('exit', r));
  const live = L.emptyLive();
  L.reduce(live, { session_id: 's', hook_event_name: 'UserPromptSubmit', _t: Date.now(), _ppid: dead.pid });
  fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(live));
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, '--daemon'], { env: { ...process.env, NUMABLE_USAGE_STATE_DIR: dir, NUMABLE_LIVE_BEAT_MS: '100', NUMABLE_LIVE_IDLE_MS: '200' }, stdio: 'ignore' });
    // 守护进程若替死掉的会话继续心跳就永远不退出 —— 5 秒没退出即判红,别让测试挂住
    const kill = setTimeout(() => p.kill(), 5000);
    p.on('exit', () => { clearTimeout(kill); resolve(); });
  });
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8'));
  assert.equal(out.sessions.s.state, 'lost');
  assert.equal(out.sessions.s.turns[0].end, 'lost');
  assert.equal(fs.existsSync(path.join(dir, 'live-daemon.pid')), false);   // 退出时清掉自己的锁
});

test('批准检测:等授权后 Claude Code 下面新起的 shell-snapshots 子进程 = 已批准;更早的、别的进程不算', () => {
  assert.equal(L.etimeMs('01:11'), 71000);
  assert.equal(L.etimeMs('1-02:00:05'), (26 * 3600 + 5) * 1000);
  const now = Date.now();
  const ps = [
    ' 9064  2016       01:21 caffeinate -i -t 300',
    ' 9315  2016       00:10 /bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval find',
    ' 9400  2016       05:00 /bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && eval old',   // 弹窗之前就在跑(后台任务)
    ' 9500  3333       00:05 /bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && eval other', // 别的 Claude Code
  ].join('\n');
  const at = L.approvedAt(2016, now - 60e3, ps);
  assert.ok(at != null && Math.abs(at - (now - 10e3)) < 1500);
  assert.equal(L.approvedAt(2016, now - 5e3, ps), null);      // 10 秒前起的那个早于弹窗 → 不算
});

test('后台子代理:主轮结束后子代理的工具调用不开新轮;它弹授权 = 等你授权;批了回到运行中(后台);子代理结束回等你输入', () => {
  const live = L.emptyLive();
  let s = feed(live, ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'ag' }),
    ev('SubagentStart', { agent_id: 'g', agent_type: 'Explore' }), ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 'ag' }), ev('Stop'));
  assert.equal(s.turns.length, 1);
  assert.equal(s.state, 'running');                          // 主轮完了,后台子代理还在跑
  s = feed(live, ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'b1', agent_id: 'g' }), ev('PermissionRequest', { tool_name: 'Bash', agent_id: 'g' }));
  assert.equal(s.turns.length, 1);
  assert.equal(s.state, 'perm');
  s = feed(live, ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1', agent_id: 'g' }));
  assert.equal(s.state, 'running');
  assert.deepEqual(s.turns[0].seq, [['agent', 1]]);           // 子代理的工具没混进主轮
  s = feed(live, ev('SubagentStop', { agent_id: 'g' }));
  assert.equal(s.state, 'input');
  assert.equal(s.subs[0].tools, 1);
});

// ---------- P1:上传 ----------
const crypto = require('node:crypto');
const http = require('node:http');

function mkLive() {
  const live = L.emptyLive();
  const dir = tmp(); fs.mkdirSync(path.join(dir, '.git'));
  const wt = path.join(dir, '.claude', 'worktrees', 'wt2'); fs.mkdirSync(wt, { recursive: true });
  const base = { cwd: wt, transcript_path: '/Users/me/secret/t.jsonl', session_title: '修 https://x.com/a?token=1 和 me@mail.com 的 sk-abcdefgh12345 问题' };
  // 真实 hook 每个事件都带本会话的 cwd
  for (const e of [ev('SessionStart', base), ev('UserPromptSubmit', { ...base, prompt: 'SECRET PROMPT' }),
    ev('PreToolUse', { ...base, tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '/Users/me/secret.txt' } }),
    ev('PostToolUse', { ...base, tool_name: 'Read', tool_use_id: 'r1', duration_ms: 30 })]) L.reduce(live, e);
  return { live, root: dir };
}

test('上传体:L1 只有结构与匿名编号;项目编号与用量那边同一把盐同一个根', () => {
  const { live, root } = mkLive();
  const body = L.buildLivePayload(live, { salt: 'S', now: clock + 1000, alive: ALIVE });
  const blob = JSON.stringify(body);
  assert.equal(body.tier, 1);
  assert.doesNotMatch(blob, /SECRET|secret|\/Users|wt2|token|mail|修/);
  const x = body.sessions[0];
  assert.notEqual(x.sid, 's1');
  assert.equal(x.proj, crypto.createHash('sha256').update('S|' + root).digest('hex').slice(0, 10));   // = collect.cjs projectOf
  assert.equal(x.pname, undefined); assert.equal(x.title, undefined);
  assert.equal(x.turns[0].seq, 'r1');
  assert.equal(x.turns[0].cells, 'r');
});

test('上传体:names → 项目文件夹名(worktree 归回项目);titles → 本机脱敏后的标题', () => {
  const { live, root } = mkLive();
  const x = L.buildLivePayload(live, { salt: 'S', names: true, titles: true, now: clock, alive: ALIVE }).sessions[0];
  assert.equal(x.pname, path.basename(root));
  assert.doesNotMatch(x.title, /https|mail\.com|sk-abc/);
  assert.match(x.title, /^修 … 和 … 的 … 问题$/);
});

test('上传体:进程没了按断开上报;等你输入不论多久都报 input(搁置由服务端按时刻推)', () => {
  const { live } = mkLive();
  assert.equal(L.buildLivePayload(live, { salt: 'S', now: clock, alive: DEAD }).sessions[0].state, 'lost');
  L.reduce(live, ev('Stop'));
  assert.equal(L.buildLivePayload(live, { salt: 'S', now: clock + 3600e3, alive: ALIVE }).sessions[0].state, 'input');
});

test('上传体:超 60KB 先丢已结束会话的逐轮', () => {
  const live = L.emptyLive();
  for (let i = 0; i < 30; i++) {
    const sid = 'x' + i;
    for (let k = 0; k < 60; k++) { L.reduce(live, { ...ev('UserPromptSubmit'), session_id: sid }); L.reduce(live, { ...ev('Stop'), session_id: sid }); }
    L.reduce(live, { ...ev('SessionEnd'), session_id: sid });
  }
  L.reduce(live, { ...ev('UserPromptSubmit'), session_id: 'active' });
  const body = L.buildLivePayload(live, { salt: 'S', now: clock, alive: ALIVE });
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 60 * 1024);
  assert.equal(body.sessions.find((x) => x.state === 'running').turns.length, 1);   // 活跃会话的逐轮不动
});

test('守护进程:打开同步后状态一变就推,推的体里没有提示词;没打开同步一个请求都不发', async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)).on('end', () => { got.push({ t: Date.now(), url: req.url, auth: req.headers.authorization, body: b }); res.end('{"ok":true}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const run = async (sync) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ live: true, liveSync: sync, writeToken: 'W.tok', device: 'abc123' }));
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ salt: 'S', days: {} }));
    // 巡检周期故意设长(10 秒):推送必须靠「有变化就提前唤醒」,不能靠等到下一次巡检
    const env = { ...process.env, NUMABLE_USAGE_STATE_DIR: dir, NUMABLE_USAGE_ENDPOINT: `http://127.0.0.1:${port}`, NUMABLE_LIVE_BEAT_MS: '10000', NUMABLE_LIVE_IDLE_MS: '300' };
    const hook = (payload) => new Promise((resolve) => {
      const p = spawn(process.execPath, [SCRIPT, '--hook'], { env, stdio: ['pipe', 'ignore', 'inherit'] });
      p.on('exit', resolve); p.stdin.end(JSON.stringify(payload));
    });
    await hook({ session_id: 's', hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'SECRET-PROMPT' });
    await new Promise((r) => setTimeout(r, 2500));
    await hook({ session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'SECRET-REPLY' });
    const stopAt = Date.now();
    for (let i = 0; i < 40 && !got.some((g) => g.t > stopAt && JSON.parse(g.body).sessions[0].state === 'input'); i++) await new Promise((r) => setTimeout(r, 100));
    if (sync) assert.ok(got.some((g) => g.t > stopAt && JSON.parse(g.body).sessions[0].state === 'input'), '状态变化后 4 秒内没推出去(该提前唤醒却等了整个巡检周期)');
    // 等守护进程推完并空闲退出
    for (let i = 0; i < 40 && fs.existsSync(path.join(dir, 'live-daemon.pid')); i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 300));
  };
  try {
    await run(false);
    assert.equal(got.length, 0, '没打开同步却发了请求');
    await run(true);
  } finally { srv.close(); }   // 断言失败也要关,否则测试进程挂住不退
  assert.ok(got.length >= 2, `应至少推两次(开始跑、跑完),实际 ${got.length}`);
  assert.equal(got[0].url, '/live?dev=abc123');
  assert.equal(got[0].auth, 'Bearer W.tok');
  const states = got.map((g) => JSON.parse(g.body).sessions[0].state);
  assert.equal(states[0], 'running');
  assert.equal(states[states.length - 1], 'input');
  assert.doesNotMatch(got.map((g) => g.body).join(''), /SECRET/);
});
