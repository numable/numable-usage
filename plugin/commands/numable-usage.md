---
name: numable-usage
description: 查看 Numable 用量小组件的接入状态、取出接入所需的读取令牌、把多台电脑合并到同一个空间，或清理这台电脑改名前留下的旧设备记录
---

用户想查看或配置 Numable 的 Claude Code 用量小组件。

- 「看状态 / 看用量 / 接没接上」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --status`
- 「怎么接 / 令牌 / 在手机上看不到 / 粘贴到 Numable / 新手机 / 配对码」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --token`
  （每台手机、平板用的都是同一枚读取令牌）
- 「另一台电脑也要算进来 / 多台电脑合并」且**当前这台已经接好** → 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --link`
- 「加入用量空间」且用户贴了一串以 `nu1.` 开头的字符 → 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --join <那一串>`
  （原样传入，不要改动；这台电脑原来的空间会被替换）
- 「项目名 / 显示项目名字 / 按项目」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --projects` 看现状；
  用户明确要打开才运行 `--projects on`，要关才运行 `--projects off`（打开会上传项目文件夹名，先告诉用户这一点）
- 「有哪些设备 / 数字偏大 / 翻倍 / 算重了 / 电脑改过名」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --devices`
- 「删掉 / 忘记某个设备」→ **先**运行 `--devices` 把列表给用户看；等用户明确说出要删的那个标识后，
  才运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --forget <标识>`。
  一次只删用户点名的那一个；不要替用户挑，也不要因为输出里建议了就自己去删 —— 删除不可撤销。

- 「实时会话 / 现在在跑什么 / 哪个在等我」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/live.cjs" --sessions`
- 「打开 / 关闭实时会话」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/live.cjs" --live on`(或 `off`);不带参数看现状
  (目前只记在本机、不上传;打开前可以把这一点告诉用户)
- 「状态栏怎么配」→ 告诉用户在 `~/.claude/settings.json` 加
  `"statusLine": {"type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/live.cjs\" --statusline"}`,
  其中 `${CLAUDE_PLUGIN_ROOT}` 换成它的实际值(运行 `echo "${CLAUDE_PLUGIN_ROOT}"` 取);**不要替用户改 settings.json**

把命令输出**原样**展示给用户（令牌和加入串是给人复制的，不要改写、不要截断、不要总结掉）。
不要解释脚本做了什么，除非用户问。
