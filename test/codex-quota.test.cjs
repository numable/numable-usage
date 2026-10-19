'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readQuota, readQuotaHomes } = require('../codex/lib/quota.cjs');
function fake(t, reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numable-quota-rpc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fake.cjs');
  fs.writeFileSync(file, `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize') console.log(JSON.stringify({id:1,result:{}}));if(r.id===2)console.log(JSON.stringify(${JSON.stringify(reply)}));});`);
  return { binary: process.execPath, prefixArgs: [file], salt: 'same-space-secret', timeoutMs: 2000 };
}
test('额度读取只保留数字窗口与匿名账号，支持多桶和可空窗口', async (t) => {
  const options = fake(t, { id: 2, result: { accountId: 'raw-private-account', email: 'never@send.test', rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: null },
    extra: { primary: null, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1900000000 } },
  } } });
  const a = await readQuota(options), b = await readQuota(options);
  assert.equal(a.quotas.length, 2); assert.equal(a.quotas[0].account, b.quotas[0].account);
  assert.ok(!JSON.stringify(a).includes('raw-private') && !JSON.stringify(a).includes('never@'));
  const c = await readQuota({ ...options, salt: 'different-space' });
  assert.notEqual(a.quotas[0].account, c.quotas[0].account);
});
test('空额度明确不支持，不伪装为满额', async (t) => {
  const r = await readQuota(fake(t, { id: 2, result: { rateLimits: null } }));
  assert.equal(r.supported, false); assert.deepEqual(r.quotas, []);
});
test('未登录、协议错误与缺失可执行文件明确失败', async (t) => {
  await assert.rejects(readQuota(fake(t, { id: 2, error: { code: -32000, message: 'secret error' } })), /登录/);
  await assert.rejects(readQuota({ binary: '/does/not/exist', salt: 's', timeoutMs: 1000 }), /无法启动/);
});

test('多目录额度部分失败保留原观测并隔离匿名目录，范围换绑不继承旧快照', async (t) => {
  const options = fake(t, { id: 2, result: { accountId: 'same-account', rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1900000000 } } } });
  const first = await readQuotaHomes({ ...options, homes: ['/tmp/profile-a', '/tmp/profile-b'], profileSalt: 'local-salt' });
  assert.equal(first.quotas.length, 2); assert.equal(first.failures, 0);
  assert.equal(first.quotas[0].account, first.quotas[1].account);
  assert.notEqual(first.quotas[0].profile, first.quotas[1].profile);
  const partialScript = path.join(path.dirname(options.prefixArgs[0]), 'partial.cjs');
  fs.writeFileSync(partialScript, `if(process.env.CODEX_HOME.endsWith('profile-a'))process.exit(1);else require(${JSON.stringify(options.prefixArgs[0])});`);
  const partial = await readQuotaHomes({ ...options, prefixArgs: [partialScript], homes: ['/tmp/profile-a', '/tmp/profile-b'], profileSalt: 'local-salt', previous: first });
  assert.equal(partial.failures, 1); assert.equal(partial.quotas.length, 2);
  assert.equal(partial.quotas[0].observedAt, first.quotas[0].observedAt);
  const changed = await readQuotaHomes({ ...options, binary: '/not/installed', homes: ['/tmp/profile-a'], previous: first, salt: 'changed-space' });
  assert.equal(changed.failures, 1); assert.deepEqual(changed.quotas, []);
  assert.ok(!JSON.stringify(partial).includes('/tmp/profile'));
});
