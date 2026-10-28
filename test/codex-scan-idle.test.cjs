'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse, paths, configFor, scan, main } = require('../codex/cli.cjs');
const rows = (id) => [{ type: 'session_meta', payload: { id: 'main', source: 'cli', cli_version: '0.1.0' } },
  { type: 'token_usage_record', timestamp: new Date().toISOString(), payload: { response_id: id, usage: { input_tokens: 100, output_tokens: 20 } } }];
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numable-codex-idle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), state = path.join(dir, 'state'), log = path.join(home, 'sessions', 'a.jsonl');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(log, rows('r1').map(JSON.stringify).join('\n') + '\n');
  const argv = ['--home', home, '--state-dir', state, '--quiet'];
  const run = () => { const args = parse(['collect', ...argv]), p = paths(args); return scan(args, p, configFor(args, p)); };
  return { state, log, argv, run, history: path.join(state, 'history.json') };
}
const stamp = (file) => { const s = fs.statSync(file); return `${s.ino}:${s.mtimeMs}`; };

test('常驻采集空闲轮次不重写历史，日志追加后才重写且统计正确', async (t) => {
  const { log, argv, run, history } = setup(t);
  await main(['init', ...argv]); await main(['quota-auto-off', ...argv]);
  const first = await run();
  assert.equal(first.days[0].total, 120);
  const written = stamp(history);
  const idle = await run();
  assert.equal(idle.collection.rows, 0);
  assert.deepEqual(idle.days, first.days);
  assert.equal(stamp(history), written);
  fs.appendFileSync(log, JSON.stringify(rows('r2')[1]) + '\n');
  const grown = await run();
  assert.equal(grown.days[0].total, 240);
  assert.notEqual(stamp(history), written);
});

test('其他进程替换历史文件后，常驻进程丢弃内存副本并读取新文件', async (t) => {
  const { argv, run, history } = setup(t);
  await main(['init', ...argv]); await main(['quota-auto-off', ...argv]);
  await run();
  assert.equal((await run()).collection.rows, 0);
  // 模拟另一个进程（如重算）原子替换历史：只剩空文件表，内存里的旧投影必须作废。
  const salt = JSON.parse(fs.readFileSync(history, 'utf8')).salt;
  fs.writeFileSync(`${history}.tmp`, JSON.stringify({ version: 1, salt, files: {} }));
  fs.renameSync(`${history}.tmp`, history);
  const after = await run();
  assert.ok(after.collection.rows > 0);
  assert.equal(after.days[0].total, 120);
});
