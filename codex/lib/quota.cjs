'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { quota, hash } = require('./collect.cjs');

// 只建立协议连接并读取额度，不创建、恢复或修改会话，不读取登录凭证文件。
function readQuota({ binary = process.env.NUMABLE_CODEX_BINARY || 'codex', home, salt, timeoutMs = 15000, prefixArgs = [] } = {}) {
  if (!salt) return Promise.reject(new Error('读取额度缺少本机匿名化配置'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...prefixArgs, 'app-server', '--listen', 'stdio://'], {
      env: { ...process.env, ...(home ? { CODEX_HOME: home } : {}) }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const lines = readline.createInterface({ input: child.stdout });
    let done = false;
    const timer = setTimeout(() => finish(new Error('额度读取超时，请稍后重试')), timeoutMs);
    const finish = (error, result) => {
      if (done) return; done = true;
      clearTimeout(timer); lines.close(); child.stdin.end();
      const killTimer = setTimeout(() => child.kill(), 1000); killTimer.unref();
      child.once('close', () => clearTimeout(killTimer));
      error ? reject(error) : resolve(result);
    };
    const send = (message) => { if (!done) child.stdin.write(JSON.stringify(message) + '\n'); };
    child.once('error', () => finish(new Error('Codex 命令无法启动，请检查安装或指定可执行文件')));
    child.stdin.on('error', () => finish(new Error('Codex 协议连接已关闭，请检查安装后重试')));
    child.once('close', () => { if (!done) finish(new Error('Codex 在返回额度前退出')); });
    lines.on('line', (line) => {
      if (done || line.length > 1024 * 1024) return;
      let r; try { r = JSON.parse(line); } catch { return; }
      if (r.id === 1) {
        if (r.error) return finish(new Error('当前 Codex 不支持额度协议初始化'));
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read' });
      }
      if (r.id === 2) {
        if (r.error) return finish(new Error('当前账号无法读取额度，请检查 Codex 登录状态'));
        const result = r.result || {}, observedAt = Date.now();
        const buckets = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
          ? Object.entries(result.rateLimitsByLimitId).map(([key, bucket]) => ({ ...bucket, limitId: bucket?.limitId || key }))
          : [result.rateLimits];
        const account = typeof result.accountId === 'string' && result.accountId ? hash(salt, `account:${result.accountId}`) : null;
        const quotas = buckets.map((bucket) => quota(bucket, observedAt)).filter(Boolean).map((q) => ({ ...q, account, origin: 'rpc' }));
        finish(null, { observedAt, scope: hash(salt, 'quota-scope'), supported: quotas.length > 0, quotas });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'numable_codex_usage', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}
module.exports = { readQuota };
