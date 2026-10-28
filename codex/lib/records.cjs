'use strict';

// 历史里的响应记录与旧累计记录按定长数组保存：[时刻, 上下文序号, 轮次, 模型, 输入, 输出, 缓存, 推理]。
// 会话 / 项目 / 子代理记在文件级上下文表 ctx 里按序号引用，同一文件的上万条记录不再各自重复三个哈希。
// 总量恒等于输入 + 输出，不单独存；万一不等才追加第 9 位，保证与对象格式逐值互转。
const AT = 0, CTX = 1, TURN = 2, MODEL = 3, INPUT = 4, OUTPUT = 5, CACHED = 6, REASONING = 7, TOTAL = 8;

const total = (t) => t.length > TOTAL ? t[TOTAL] : t[INPUT] + t[OUTPUT];

function contextIndex(f, session, project, subagent) {
  const list = f.ctx, last = list.length - 1;
  if (last >= 0 && list[last][0] === session && list[last][1] === project && list[last][2] === subagent) return last;
  for (let i = 0; i < last; i++) if (list[i][0] === session && list[i][1] === project && list[i][2] === subagent) return i;
  list.push([session, project, subagent]);
  return list.length - 1;
}
function pack(f, r) {
  const u = r.usage;
  const t = [r.at, contextIndex(f, r.session, r.project, r.subagent), r.turn, r.model, u.input, u.output, u.cached, u.reasoning];
  if (u.total !== u.input + u.output) t.push(u.total);
  return t;
}
function unpack(f, t) {
  const c = f.ctx[t[CTX]];
  return { at: t[AT], session: c[0], project: c[1], model: t[MODEL], turn: t[TURN], subagent: c[2],
    usage: { input: t[INPUT], output: t[OUTPUT], cached: t[CACHED], reasoning: t[REASONING], total: total(t) } };
}

module.exports = { AT, CTX, TURN, MODEL, INPUT, OUTPUT, CACHED, REASONING, total, pack, unpack };
