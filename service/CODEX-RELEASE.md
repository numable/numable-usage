# Codex 用量发布与回退

本文供维护者使用。当前采集器版本为 `0.1.0`，仍是未发行的开发版本；Codex 服务协议和 Numable 工具尚未上线。文档、候选包及本机检查通过，不代表允许跳过验收发布。

## 发布前的证据

完整任务表以 Numable meta 仓 `doc/codex-usage-impl-plan.md` 为准。发布前逐项确认：

| 范围 | 必须确认的结果 |
|---|---|
| 电脑入口 | macOS / Windows 的 CLI、桌面端、编辑器扩展分别有实操记录；日志来源字段不能替代 |
| 钩子 | 在 Codex 正常登录和 `/hooks` 审查后真实触发；不能用绕过信任参数代替 |
| 多机与账号 | 真正的另一台电脑加入 / 删除 / 恢复，真实账号切换与额度隔离 |
| Numable | iOS、Android、鸿蒙、Win 与 Mac 工作台的原生组件、页面、缓存及提醒矩阵 |
| 回归 | 新协议、旧 Claude Code 协议、离线安装与卸载均通过；明确列出跳过的检查 |
| 治理 | 工具发布地区和审核结论明确；正式 ULID 为 `01M5AADGPBFYXWY0Y6KXJD1AZH` |

当前 Windows 原生、真实钩子触发、多机 / 账号及完整原生矩阵仍有缺口。测试身份末 J、冻结虚构数据、仅回环开发服务均不能进入生产发布物。

## 候选物与本机检查

记录采集 / 服务仓与工具仓的提交 SHA、Node / Codex / Wrangler 版本、采集器版本、工具版本、归档 SHA256、测试结果与未验项。候选目录单独存放，不放配置、历史、读取凭证、加入串、签名私钥或 `.dev.vars`。

在本仓根目录，使用已经安装并复核的工具运行；不在发布时临时升级依赖：

```sh
node --test test/*.test.cjs
node service/scripts/verify-codex-package.mjs
NUMABLE_CODEX_BINARY=/自己的/Codex可执行文件 node service/scripts/verify-codex-hook-runtime.mjs
```

SQLite 路由检查使用 Node.js 22 或以上；采集器本身声明最低 Node.js 18.17，当前本机实测为 Node.js 24。PowerShell 测试跳过时，不能记成 Windows 验收通过。

独立本机服务启动后另跑 `node service/scripts/verify-codex-cli.mjs`；旧 HTTP 回归使用 `BASE=http://127.0.0.1:端口 node service/test.mjs`。两套服务分别使用独立数据库与端口，避免共享限流。禁止将这些虚构数据播种脚本指向生产。

采集器打包使用 `npm pack ./codex --json --pack-destination 候选目录`。当前白名单为六个文件：`cli.cjs`、`lib/collect.cjs`、`lib/live.cjs`、`lib/quota.cjs`、`package.json`、`README.md`。安装候选前校验 SHA256；`npm pack` 不是 npm 发行。

服务先做 `wrangler deploy --dry-run` 检查。使用独立临时配置隔离 `.dev.vars`，保留现行 Worker / D1 / Durable Object 定义并把源码与 migrations 路径改为绝对路径；不读写远端资源。保留构建产物及校验和，不把临时配置当生产部署配置。

## 正式发布顺序

仅在上述缺口收口后执行。每一步成功后再进入下一步，记录实际版本与结果：

1. **服务**：核对 `service/wrangler.toml` 的现有 `numable-ccusage` Worker、`usage.numable.app` 域名、D1 和 `LIVE` 绑定。确认已部署的数据库迁移与 Durable Object 迁移；本次 Codex 扩展没有新增 SQL 迁移。保留既有 `TOKEN_SECRET`，不通过轮换密钥完成升级。先部署向后兼容的服务，再以专用验收空间验证旧 Claude Code 与新 Codex 的读写 / 来源隔离 / 删除 / 乱序 / 恢复。生产复验不复用本机播种脚本。
2. **采集器**：确认 npm 包名、发布主体与版本未占用，使用已核对校验和的归档发行 `numable-codex-usage`。首发记录实际 npm 版本与完整性值；后续修复递增版本，不覆盖旧版本。电脑安装后依次验证 `init → collect → summary`，再由用户显式 `connect` 开启同步。`credentials` 和 `link` 的输出不进入日志或截图。
3. **Numable 工具**：在工具仓按 meta 仓 `doc/xbundle-release-standard.md` 执行单包 `seal → push → promote → verify`，地区采用审核结论。正式身份末 H，开发测试身份末 J。禁止批量打包所有工具。线上 verify 必须校验整包哈希、Ed25519 和逐文件哈希，并确认六组件 / 十页 / 五条提醒的实际安装闭环。
4. **收口**：线上新装和更新复验通过后，更新 README 的未上线提示、兼容矩阵、计划 / TODO 与版本日志；记录尚不支持的入口，不能因为发布成功而将未验项改为通过。

## 故障与回退

| 故障 | 处理顺序与边界 |
|---|---|
| 采集器异常 | 先 `pause`、`stop`，保存受限访问的本机状态备份和 `export` 数字快照；用已验证版本替换程序，再重新安装并审查钩子。不要先删历史或 `--rebuild`；源日志已被清理时，重算无法恢复它们 |
| 工具页面 / 组件异常 | 暂停推广或撤下有问题版本；以正常递增的新版本号重签旧内容，重新走四阶段发布。保留正式 ULID，不能用更小版本号冒充回退 |
| 服务异常 | 优先部署保留 Codex 路由与存储兼容性的修复版本。若必须退到不支持 Codex 的旧 Worker，先明确暂停 Codex 同步并告知其暂不可用，逐项验证 Claude Code。保留 D1、Durable Object 数据及迁移历史，不删库、不重建空间、不轮换令牌密钥 |
| 删除设备失败 | `forget` 同时处理实时和历史；任一步失败按失败处理并重试。两个存储不保证跨库原子性。删除不撤销写入凭证，仍同步的电脑可以重新出现；持续移除应先在该电脑 `pause` 或 `uninstall` |

已发行的 npm 版本不能靠修改同版本归档回退；不要直接删除用户本机记录来掩盖兼容问题。卸载采集钩子、卸载 npm 程序、删除服务端设备是三个独立动作，不能互相替代。

## 数据保留与凭证处理

- 本机历史投影包含数字和匿名身份；默认不保存正文、代码、命令原文或登录凭证。项目文件夹名仅在用户显式开启后保存。传输快照最多保留近 400 天，原始 Codex 日志的保留由 Codex 自身决定。
- 实时服务视图保留 24 小时，最多每设备 40 个会话、每会话 60 轮；删除设备的序号墓碑同样按 24 小时清理。裁剪不代表用户本机源日志被删除。
- 历史投递空间在 90 天无推送后回收；回收后须重新接入，不能假设旧令牌仍有效或承诺自动恢复。本机历史应保留为恢复输入。`pause` 不清理服务端数据，`uninstall` 保留本机历史。
- `config.json` 的读取 / 写入凭证与加入串属于敏感配置。诊断只收集经过复核的 `status`、数字导出及版本信息，不收集完整状态目录、认证文件或原始会话日志。不能将加入串当作手机读取凭证分享。
