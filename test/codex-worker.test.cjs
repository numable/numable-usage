'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('完整路由：真实 SQLite、鉴权、来源隔离、幂等、乱序、删除与旧协议回归', async (t) => {
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite) { t.skip('路由集成检查需 Node.js 22 或以上内置 SQLite'); return; }
  const { default: worker } = await import('../service/src/worker.js');
  const db = new sqlite.DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(path.resolve(__dirname, '../service/migrations/0001_init.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve(__dirname, '../service/migrations/0002_live_req.sql'), 'utf8'));
  const prepare = (sql) => {
    let values = [];
    const api = {
      bind(...args) { values = args; return api; },
      async first() { return db.prepare(sql).get(...values) || null; },
      async all() { return { results: db.prepare(sql).all(...values) }; },
      async run() { const result = db.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
    }; return api;
  };
  const objects = new Map(); let liveFails = false;
  const env = { TOKEN_SECRET: 'only-a-local-test-secret', DB: { prepare, async batch(statements) {
    db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } }, LIVE: { idFromName(name) { return name; }, get(id) {
    if (!objects.has(id)) objects.set(id, {});
    return { async fetch(url, options) {
      const q = new URL(url);
      if (options?.method === 'POST' && q.pathname === '/forget') {
        if (liveFails) return Response.json({ error: 'unavailable' }, { status: 503 });
        const dev = q.searchParams.get('dev'), removed = Object.hasOwn(objects.get(id), dev) ? 1 : 0;
        delete objects.get(id)[dev]; return Response.json({ ok: true, removed });
      }
      if (options?.method === 'POST') objects.get(id)[q.searchParams.get('dev')] = JSON.parse(options.body);
      return new Response(JSON.stringify({ rows: objects.get(id) }), { headers: { 'content-type': 'application/json' } });
    } };
  } } };
  const call = async (route, body, token) => {
    const r = await worker.fetch(new Request('https://usage.test' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, {});
    return { status: r.status, body: await r.json() };
  };
  const sp = await call('/space', {}), other = await call('/space', {});
  assert.equal(sp.status, 200);
  const { writeToken: w, readToken: r } = sp.body;
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
  const snapshot = (at, input) => ({ v: 1, collectedAt: at, timezone: 'UTC',
    days: [{ date: today, input, output: 20, total: input + 20, responses: 1 }],
    coverage: [{ source: 'cli', version: '0.1.0', files: 1 }], secret: 'NEVER_SEND' });
  const body = (at, input) => ({ source: 'codex', device: 'aabbcc', snapshot: snapshot(at, input) });
  assert.equal((await call('/ingest', body(now, 100), r)).status, 401);
  assert.equal((await call('/ingest', body(now, 100), w)).status, 200);
  assert.equal((await call('/ingest', body(now, 500), w)).status, 200);
  let result = await call('/s?source=codex&lite=1', undefined, r);
  assert.equal(result.body.merged.today.total, 120, '同序号重复上报不覆盖');
  await call('/ingest', body(now - 1000, 800), w);
  result = await call('/s?source=codex&lite=1', undefined, r);
  assert.equal(result.body.merged.today.total, 120, '旧快照不覆盖新快照');
  await call('/ingest', body(now + 1, 200), w);
  result = await call('/s?source=codex&lite=1', undefined, r);
  assert.equal(result.body.merged.today.total, 220, '更新快照覆盖而非相加');
  assert.ok(!JSON.stringify(await call('/s?source=codex', undefined, r)).includes('NEVER_SEND'));
  assert.equal((await call('/s?source=constructor', undefined, r)).status, 400);
  assert.equal((await call('/ingest', { source: 'constructor' }, w)).status, 400);
  await call('/ingest', { source: 'claude-code', device: 'aabbcc', snapshot: { days: [{ date: today, out: 77, msgs: 2 }] } }, w);
  const old = await call('/s?lite=1', undefined, r);
  assert.equal(old.status, 200); assert.equal(old.body.merged.today.out, 77);
  result = await call('/s?source=codex&lite=1', undefined, r);
  assert.equal(result.body.merged.today.total, 220, '旧工具与新工具历史隔离');
  assert.equal((await call('/s?source=codex', undefined, other.body.readToken)).body.merged.known, false);
  assert.equal((await call('/forget', { source: 'codex', device: 'aabbcc' }, r)).status, 401);
  assert.equal((await call('/forget', { source: 'codex', device: 'aabbcc' }, other.body.writeToken)).body.removed, 0);
  await call('/live?dev=aabbcc', { sessions: [{ sid: 'claude-session' }] }, w);
  await call('/live?source=codex&dev=aabbcc', { sessions: [{ sid: 'codex-session' }] }, w);
  const liveOld = await call('/live', undefined, r), liveNew = await call('/live?source=codex', undefined, r);
  assert.equal(liveOld.body.rows.aabbcc.sessions[0].sid, 'claude-session');
  assert.equal(liveNew.body.rows.aabbcc.sessions[0].sid, 'codex-session');
  assert.equal((await call('/live?source=constructor', undefined, r)).status, 400);
  liveFails = true;
  assert.equal((await call('/forget', { source: 'codex', device: 'aabbcc' }, w)).status, 503, '实时删除失败不能报告成功');
  assert.equal((await call('/s?source=codex&lite=1', undefined, r)).body.merged.today.total, 220, '实时删除失败时历史保持原样，允许重试');
  liveFails = false;
  const forgotten = await call('/forget', { source: 'codex', device: 'aabbcc' }, w);
  assert.equal(forgotten.body.removed, 1); assert.equal(forgotten.body.liveRemoved, 1);
  assert.deepEqual((await call('/live?source=codex', undefined, r)).body.rows, {});
  assert.equal((await call('/live', undefined, r)).body.rows.aabbcc.sessions[0].sid, 'claude-session', '删除 Codex 实时状态不影响旧来源');
  assert.equal((await call('/s?source=codex&lite=1', undefined, r)).body.merged.known, false);
  assert.equal((await call('/s?lite=1', undefined, r)).body.merged.today.out, 77, '删除 Codex 不删除旧工具');
});
