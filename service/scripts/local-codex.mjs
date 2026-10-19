// 独立临时配置避免读取开发目录的真实 .dev.vars；所有资源与通知端点均在本机。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'numable-codex-worker-'));
const wrangler = process.env.NUMABLE_TEST_WRANGLER;
if (!wrangler || !fs.existsSync(wrangler)) throw new Error('请用 NUMABLE_TEST_WRANGLER 指定已安装的 wrangler.js');
const port = Number(process.env.NUMABLE_TEST_PORT || 8797);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地端口无效');
const config = path.join(tmp, 'wrangler.toml');
const quote = JSON.stringify;
fs.writeFileSync(config, `name = "numable-codex-local-test"
main = ${quote(path.join(root, 'src/worker.js'))}
compatibility_date = "2024-09-23"
[vars]
TOKEN_SECRET = "local-codex-fixture-only"
PUSH_RELAY = "http://127.0.0.1:8790"
[[d1_databases]]
binding = "DB"
database_name = "numable-codex-local-test"
database_id = "00000000-0000-0000-0000-000000000001"
migrations_dir = ${quote(path.join(root, 'migrations'))}
[[durable_objects.bindings]]
name = "LIVE"
class_name = "LiveSpace"
[[migrations]]
tag = "v1-live"
new_sqlite_classes = ["LiveSpace"]
`);
const common = ['--config', config, '--persist-to', path.join(tmp, 'state')];
const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'numable-codex-local-test', '--local', ...common],
  { cwd: tmp, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
if (migration.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(migration.status || 1); }
const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), ...common],
  { cwd: tmp, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', (code) => { fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = code || 0; });
