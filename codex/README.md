# Codex 用量采集器

在电脑上统计 Codex 用量，并按需同步到 Numable。当前为开发版本，尚未发布安装包或上线工具。

需要 Node.js 18.17 或以上；建议使用当前长期支持版本。采集器不假设 Codex 自带可供外部使用的 Node.js。

## 本机查看

在仓库根目录运行：

```sh
node codex/cli.cjs init
node codex/cli.cjs collect
node codex/cli.cjs summary
node codex/cli.cjs status
```

`devices` 列出同一空间已接入的电脑；`forget --device <标识>` 删除指定的其他电脑在服务端的用量行，拒绝删除正在采集的本机。

本机采集默认不联网。配置与历史保存在 `~/.numable/codex-usage/`，目录及文件分别以仅当前用户可访问的权限创建。

首次扫描需要读取现有会话；之后只处理追加的完整行。支持 `sessions/` 与 `archived_sessions/`，gzip 归档可直接读取；zstd 归档需要系统提供 `zstd`。缺少解码器时会标注未读取，不伪装成零用量。

默认读取 `CODEX_HOME` 或 `~/.codex`。可以用多个 `--home` 指定目录，用 `--timezone Asia/Kuala_Lumpur` 固定统计时区。每个命令均支持 `--state-dir` 指定独立状态目录。

```sh
node codex/cli.cjs init --home /自己的/Codex目录 --timezone Asia/Kuala_Lumpur
node codex/cli.cjs collect --rebuild
node codex/cli.cjs export
```

重算将按现存日志替换历史；已被 Codex 清理的历史无法重建。执行重算前请保留原 `history.json`。

## 额度

日志包含额度时会保留观测快照；额度窗口到期后仍须等待新观测，不自动恢复成满额。

```sh
node codex/cli.cjs quota
node codex/cli.cjs quota --codex-binary /自己的/Codex可执行文件
node codex/cli.cjs quota-auto-on
```

主动读取通过本机 Codex 协议完成，不创建会话，不要求复制 OpenAI 登录凭证。账号标识在本机匿名化；加入同一空间后使用空间范围的匿名标识，以便服务端合并同账号多台电脑的额度。不能识别账号的日志快照按设备分别展示。

`quota-auto-on` 显式开启每五分钟读取，需后台采集运行；`quota-auto-off` 关闭。多个目录分别连接，单个目录失败会保留其旧观测并标注不完整。macOS 的命令行启动器不可用时，会尝试已安装桌面端的内置可执行文件；也可显式指定路径。

## 手机同步

服务端 Codex 协议与 Numable 工具包尚未上线，开发期请使用本机或预发布服务，勿将夹具发到生产。本地服务可用 `service/scripts/local-codex.mjs` 启动；用 `NUMABLE_TEST_WRANGLER` 指定已经安装的 `wrangler.js`，配置、数据库与通知中继全部隔离在本机。

```sh
node codex/cli.cjs init --state-dir /自己的/测试状态目录 --endpoint http://127.0.0.1:8787
node codex/cli.cjs connect --state-dir /自己的/测试状态目录
node codex/cli.cjs collect --state-dir /自己的/测试状态目录
node codex/cli.cjs credentials --state-dir /自己的/测试状态目录
```

`credentials` 显示手机使用的读取凭证；请直接粘贴到 Numable 的凭证绑定入口，不要贴到公开对话、截图或提交记录。

`pause` 暂停手机同步，`resume` 恢复已绑定的同步。所有网络操作有超时，且不会跨重定向发送凭证。已绑定的状态目录不能随意切换服务地址，调试请使用独立目录。

`link` 生成加入串，`join` 从标准输入接收加入串，将自己的另一台电脑加入同一空间。加入串包含写入权限，只在自己的设备间传递，不能当作手机读取凭证分享。

## 自动采集

```sh
node codex/cli.cjs install
node codex/cli.cjs live-on
node codex/cli.cjs start
node codex/cli.cjs stop
node codex/cli.cjs uninstall
```

安装保留已有钩子；升级时仅替换上次安装记录中完整匹配的本工具定义，用户修改过的定义保留。安装之后，需要在 Codex 中检查并信任新增定义才会执行；采集器不会绕过信任检查。卸载只移除完整匹配的本工具定义，保留本机历史并暂停同步。

事件钩子立即启动不持有原会话输入输出的后台采集进程。`watch` 可在终端保持运行，每 60 秒补偿扫描；`stop` 通过本工具的停止标记请求退出，不根据一个旧 PID 杀进程。

`start` 在后台运行并确认进程取得采集锁，重复启动复用现有进程。实时默认关闭，`live-on` 开启，`live-off` 清除本机实时视图并在下次同步时清空服务端本设备实时视图；`live` 查看当前投影。钩子先脱敏入队，采集锁繁忙时继续排队，不等待采集完成。状态只由真实事件更新，无事件时不会通过扫描伪造心跳。

服务实时视图只保留最近 24 小时、最多 40 个会话与每会话最近 60 轮；传输接近上限时继续裁旧轮并显示省略数量。轮次结束、失败、中断、会话结束分别显示。只有明确目标完成事件才触发目标完成提醒，不保存目标正文。

## 数据与隐私

- 本机只保存数字、匿名身份、模型标识、时间与固定分类，不保存对话、代码、命令原文、工具参数或登录凭证。
- `--projects on` 显式开启项目文件夹名称；默认关闭。关闭后下次采集会清除本机投影中的项目名。
- 总量是去重后的输入加输出；缓存读取包含在输入中，推理包含在输出中，两者不额外相加。
- 主会话数不包含子代理；用量包含子代理响应。分叉和归档副本按响应身份去重。
- 活跃分钟表示有活动记录的分钟数，同一设备内重叠分钟只算一次；不是人工工作时长。
- 历史范围是已接入电脑的本地记录，不代表账号所有云端活动。跨时区合并保留各采集器的自然日口径。

## 验证

```sh
node --test test/codex-collect.test.cjs test/codex-cli.test.cjs test/codex-quota.test.cjs test/codex-service.test.cjs
```

完整路由测试使用真实 SQLite，需 Node.js 22 或以上：

```sh
node --test test/codex-worker.test.cjs
```

已启动独立本机服务时，可运行模拟双电脑接入闭环（临时配置与虚构日志，不修改真实 Codex 设置）：

```sh
node service/scripts/verify-codex-cli.mjs
node service/scripts/verify-codex-package.mjs
```

默认连接 `http://127.0.0.1:8797`，可用 `CODEX_VERIFY_BASE` 改成本机其他端口，脚本拒绝公网端点。这验证协议与命令行协作，不能代替两台真实电脑的操作系统验收。

安装包验收脚本不需要本机服务：先打 tgz，再离线安装到含中文、空格与单引号的临时全局前缀，使用已安装命令完成采集、钩子执行和卸载。当前覆盖 POSIX 安装布局，Windows 安装布局仍需原生验收。

可独立使用真实 Codex 校验安装定义与信任状态（无需登录，不提交模型请求，不修改真实配置）：

```sh
NUMABLE_CODEX_BINARY=/自己的/codex/可执行文件 node service/scripts/verify-codex-hook-runtime.mjs
```

此脚本只核对真实协议清单、事件 / 超时 / 异步参数和未信任状态，不代替信任后的生命周期触发验收。定义升级后，Codex 会要求重新审查发生变化的钩子。

## 当前兼容证据

| 范围 | 已有证据 | 尚未证明 |
|---|---|---|
| macOS 本机采集 | Node.js 24；真实 99 文件增量扫描、gzip / zstd、三种记录版本 | 所有 Codex 版本及所有入口 |
| 历史版本 | 0.147.0-alpha.6.5、0.159.2、0.163.0-alpha.10.2 的现存日志可解析 | 这些版本完整启动、恢复、分叉与休眠流程 |
| 额度 | 桌面端内置可执行文件的真实只读协议；多目录失败保留夹具 | 真实账号切换和 Windows 可执行文件发现 |
| 安装包 | tgz 六文件、离线安装、带空格 / 中文 / 单引号路径、生成钩子命令实际执行、卸载保留历史 | Windows npm 命令入口及钩子执行环境 |
| 生命周期钩子 | 官方字段核对、并发进程队列、原始正文不落盘、SessionEnd / Interrupt 三秒上限；真实 app-server 识别全部 11 条定义、未信任状态与卸载后清单为空 | 在 Codex 内经过真实信任流程后触发 |
| 多设备 | 两份临时配置接真实本机服务的完整加入、合并、暂停恢复与删除 | 两台物理电脑及跨操作系统实操 |

默认后台采集只在当前用户会话中运行；`start` 不注册开机启动服务。电脑重启后需再次运行。真实钩子和定时补偿互补，钩子尚未信任时仍可手动 `collect` 或运行 `start` 采集历史。

Windows、不同 Codex 入口、四端真机与线上发布进度见 meta 仓 `doc/codex-usage-impl-plan.md`，不能用本机测试通过代替。
