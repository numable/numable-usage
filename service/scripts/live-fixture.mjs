// 造一份覆盖各状态的实时会话假数据推到服务端,再把 GET /live(原始)与 ?view=w(组件视图)存成夹具。
// 用法:node scripts/live-fixture.mjs <服务地址> <写令牌> <读令牌> <输出目录>
// 只用于开发 / 验收:数据全是编的,项目名用的是示意名。
import fs from 'node:fs';
const [base, W, R, out] = process.argv.slice(2);
const now = Date.now(), M = 60e3;
const turn = (n, s, e, seq, cells, o = {}) => ({ n, s: now - s * M, e: e == null ? null : now - e * M, perm: 0, tools: 0, seq, cells, long: null, out: 3000 * n, in: 20, cw: 40000, end: e == null ? null : 'ok', ...o });
const S = (sid, proj, pname, title, state, o) => ({ sid, proj, pname, title, state, model: 'claude-opus-5', tools: 40, errors: 0, compactions: 0, subs: [], ...o });
const devA = [
  S('a1a1a1a1a1a1', 'aaaaaaaaaa', 'Numable', 'ClaudeCode 工具功能扩展', 'running', { startAt: now - 110 * M, changedAt: now - 4 * M, changeKind: 'turn', lastAt: now, beatAt: now,
    turns: [turn(1, 108, 100, 'r8s3', 'rrrrs'), turn(2, 95, 80, 'r4e6s9', 'reeesss.', { perm: 100e3 }), turn(3, 40, 30, 'e3s4', 'eess'), turn(4, 4, null, 'e2s1', 'es')],
    subs: [[now - 90 * M, now - 86 * M, 12], [now - 88 * M, now - 84 * M, 9]] }),
  S('a2a2a2a2a2a2', 'aaaaaaaaaa', 'Numable', '多泳道组件', 'perm', { startAt: now - 70 * M, changedAt: now - 6 * M, changeKind: 'perm', permSince: now - 6 * M, lastAt: now - 6 * M, beatAt: now,
    turns: [turn(1, 68, 50, 's12', 'sssssssss'), turn(2, 20, null, 'r3e2s2', 'reess')] }),
  S('b1b1b1b1b1b1', 'bbbbbbbbbb', 'xBimmer', 'iOS 用户注销和数据删除功能', 'input', { startAt: now - 100 * M, changedAt: now - 2 * M, changeKind: 'done', lastAt: now - 2 * M, beatAt: now - 2 * M,
    turns: [turn(1, 98, 90, 's6', 'ssss'), turn(2, 60, 40, 'r3e5s8', 'rreeesssss'), turn(3, 15, 2, 'b14', 'bbbbbbb')] }),
  S('c1c1c1c1c1c1', 'cccccccccc', 'bundles', null, 'running', { startAt: now - 45 * M, changedAt: now - 30 * M, changeKind: 'turn', lastAt: now, beatAt: now,
    turns: [turn(1, 44, 40, 'r2', 'rr'), turn(2, 30, null, 'b40', 'bbbbbbbbbbbbbbb')] }),
];
const devB = [
  S('d1d1d1d1d1d1', 'dddddddddd', 'Net', '后台日志清理', 'input', { startAt: now - 200 * M, changedAt: now - 75 * M, changeKind: 'done', lastAt: now - 75 * M, beatAt: now - 75 * M,
    turns: [turn(1, 190, 170, 'r3e4', 'rree'), turn(2, 110, 75, 'e6s6', 'eeesss')] }),
  S('e1e1e1e1e1e1', 'eeeeeeeeee', 'studio', '编辑器预览', 'running', { startAt: now - 40 * M, changedAt: now - 20 * M, changeKind: 'turn', lastAt: now - 14 * M, beatAt: now - 14 * M,
    turns: [turn(1, 38, 30, 'r4e3', 'rree'), turn(2, 20, null, 'e4', 'ee')] }),
  S('f1f1f1f1f1f1', 'ffffffffff', 'backend', '迁移脚本', 'ended', { startAt: now - 100 * M, changedAt: now - 22 * M, changeKind: 'end', endAt: now - 22 * M, lastAt: now - 22 * M, beatAt: now - 22 * M,
    turns: [turn(1, 98, 80, 'r5e4s3', 'rrreesss'), turn(2, 50, 22, 'e2s6', 'esss')] }),
];
const post = (dev, sessions) => fetch(`${base}/live?dev=${dev}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${W}` }, body: JSON.stringify({ tier: 3, devNow: Date.now(), sessions }) }).then((r) => r.status);
console.log('push', await post('a0a0a0', devA), await post('b0b0b0', devB));
const get = (q) => fetch(`${base}/live${q}`, { headers: { authorization: `Bearer ${R}` } }).then((r) => r.json());
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(`${out}/live.raw.json`, JSON.stringify(await get(''), null, 1));
fs.writeFileSync(`${out}/live.view.json`, JSON.stringify(await get('?view=w&win=2&tzo=480'), null, 1));
console.log('wrote', out);
