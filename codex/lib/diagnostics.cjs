'use strict';
const fs = require('node:fs');
const path = require('node:path');
const VERSION = require('../package.json').version;
const EVENTS = new Set(['watch_start', 'watch_stop', 'scan_start', 'scan_ok', 'scan_failed', 'fatal', 'service_on', 'service_off']);
// 诊断仅接收固定事件与数字/布尔字段，不接受原始错误、路径、凭证或会话内容。
function diagnostic(dir, event, fields = {}) {
  if (!EVENTS.has(event)) return;
  try {
    const logs = path.join(dir, 'logs'); fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    const file = path.join(logs, 'diagnostic.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size >= 1024 * 1024) {
      for (let i = 2; i >= 0; i--) {
        const from = i ? file + '.' + i : file, to = file + '.' + (i + 1);
        if (i === 2) { try { fs.unlinkSync(to); } catch {} }
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
    }
    const safe = {};
    for (const key of ['elapsedMs', 'failures', 'quotaAuto', 'sync', 'lastCollect', 'lastStatsPush']) {
      const value = fields[key]; if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    }
    if (Number.isInteger(fields.httpStatus) && fields.httpStatus >= 100 && fields.httpStatus <= 599) safe.httpStatus = fields.httpStatus;
    if (['ready', 'partial', 'unavailable'].includes(fields.quotaStatus)) safe.quotaStatus = fields.quotaStatus;
    if (['signal', 'stop_request', 'normal'].includes(fields.reason)) safe.reason = fields.reason;
    if (['busy', 'network', 'storage', 'operation'].includes(fields.kind)) safe.kind = fields.kind;
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid, version: VERSION, event, ...safe }) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch { /* 日志故障不能阻止采集或暴露原始异常。 */ }
}
function errorKind(error) {
  if (error?.code === 'LOCK_BUSY') return 'busy';
  if (['ENOENT', 'EACCES', 'ENOSPC'].includes(error?.code)) return 'storage';
  if (error?.name === 'AbortError' || error?.name === 'TypeError' || /^服务请求失败/.test(error?.message || '')) return 'network';
  return 'operation';
}
function watcher(dir) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'watch.lock'), 'utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) return { running: false };
    process.kill(lock.pid, 0);
    let heartbeat = null;
    try { heartbeat = JSON.parse(fs.readFileSync(path.join(dir, 'heartbeat.json'), 'utf8')); } catch {}
    return { running: true, pid: lock.pid, heartbeatAt: heartbeat?.pid === lock.pid ? heartbeat.at : null };
  } catch { return { running: false }; }
}
module.exports = { diagnostic, errorKind, watcher };
