'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { serviceSpec } = require('../codex/lib/background.cjs');
const { diagnostic, watcher } = require('../codex/lib/diagnostics.cjs');
const cli = path.resolve(__dirname, '../codex/cli.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
function temporary(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'numable-background-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
test('登录项正确转义目录与参数、每状态目录唯一、无凭证及Shell命令', t => {
 const dir=temporary(t),spec=serviceSpec(path.join(dir,'空 格 & < > "'),{home:dir,uid:501,node:'/node space',cli:'/cli & file',envPath:'/bin'});
 assert.ok(spec.xml.includes('&amp;')&&spec.xml.includes('&lt;')&&spec.xml.includes('&quot;'));
 assert.ok(spec.xml.includes('<key>KeepAlive</key><true/>'));assert.ok(spec.xml.includes('<key>ThrottleInterval</key><integer>15'));
 assert.ok(spec.xml.includes('<string>--state-dir</string>'));assert.ok(!spec.xml.includes('writeToken'));
 assert.notEqual(spec.label,serviceSpec(path.join(dir,'other'),{home:dir,uid:501}).label);
 assert.ok(!spec.xml.includes('/bin/sh'));
});
test('诊断日志白名单、轮换与权限，不接收原始异常和任何凭证', t => {
 const dir=temporary(t),log=path.join(dir,'logs/diagnostic.jsonl');
 diagnostic(dir,'scan_failed',{kind:'network',failures:2,error:'SECRET',token:'SECRET',elapsedMs:7});
 const line=fs.readFileSync(log,'utf8');assert.ok(!line.includes('SECRET'));assert.equal(JSON.parse(line).failures,2);
 assert.equal(fs.statSync(log).mode&0o777,0o600);
 fs.writeFileSync(log,'x'.repeat(1024*1024));diagnostic(dir,'scan_ok',{lastStatsPush:123});assert.ok(fs.existsSync(log+'.1'));assert.equal(JSON.parse(fs.readFileSync(log)).event,'scan_ok');
});
test('后台启动、心跳、重试日志与停止确认；安静模式致命错误退出非零', {timeout:15000}, async t => {
 const dir=temporary(t),home=path.join(dir,'home');fs.mkdirSync(path.join(home,'sessions'),{recursive:true});
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({version:1,homes:[home],timezone:'UTC',projects:false,endpoint:'http://127.0.0.1:1',salt:'fixture',device:'fixture',sync:true,writeToken:'PRIVATE_FIXTURE'}));
 const child=spawn(process.execPath,[cli,'watch','--state-dir',dir,'--quiet'],{stdio:'ignore'});t.after(()=>{try{child.kill('SIGKILL');}catch{}});
 for(let i=0;i<80&&!watcher(dir).heartbeatAt;i++)await delay(50);
 assert.equal(watcher(dir).running,true);assert.ok(watcher(dir).heartbeatAt);
 for(let i=0;i<100;i++){if(fs.existsSync(path.join(dir,'logs/diagnostic.jsonl'))&&fs.readFileSync(path.join(dir,'logs/diagnostic.jsonl'),'utf8').includes('scan_failed'))break;await delay(50);}
 const logs=fs.readFileSync(path.join(dir,'logs/diagnostic.jsonl'),'utf8');assert.ok(logs.includes('scan_failed'));assert.ok(!logs.includes('PRIVATE_FIXTURE'));
 const stop=spawn(process.execPath,[cli,'stop','--state-dir',dir],{stdio:'ignore'});const code=await new Promise(resolve=>stop.once('exit',resolve));assert.equal(code,0);assert.equal(watcher(dir).running,false);
 fs.writeFileSync(path.join(dir,'config.json'),'{broken');
 const bad=spawn(process.execPath,[cli,'watch','--state-dir',dir,'--quiet'],{stdio:'ignore'});assert.equal(await new Promise(resolve=>bad.once('exit',resolve)),1);
 assert.ok(fs.readFileSync(path.join(dir,'logs/diagnostic.jsonl'),'utf8').includes('fatal'));
});
