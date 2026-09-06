import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const url='http://127.0.0.1:4318';
async function check(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1200)});const x=await r.json();if(x.app!=='wendi-studio')throw new Error('端口已被其他应用使用');return true;}catch(e){if(e.message==='端口已被其他应用使用')throw e;return false;}}
function open(){spawn('/usr/bin/open',['http://localhost:4318'],{detached:true,stdio:'ignore'}).unref();}
if(await check()){open();process.exit(0);}
if(!fs.existsSync(path.join(root,'dist/client/index.html')))throw new Error('创作室页面尚未准备完成，请先完成安装。');
const runtime=path.join(root,'.runtime');fs.mkdirSync(runtime,{recursive:true});
const lock=path.join(runtime,'launch.lock');let owner=false;
try{fs.mkdirSync(lock);owner=true;}catch{if(Date.now()-fs.statSync(lock).mtimeMs>60000){fs.rmdirSync(lock);fs.mkdirSync(lock);owner=true;}}
if(owner){
  const log=fs.openSync(path.join(runtime,'server.log'),'a',0o600);
  const env={...process.env,PATH:path.dirname(process.execPath)+':/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',PORT:'4318'};
  const child=spawn(process.execPath,[path.join(root,'server/server.mjs')],{cwd:root,env,stdio:['ignore',log,log],detached:true});
  fs.closeSync(log);child.unref();fs.writeFileSync(path.join(runtime,'server.pid'),String(child.pid));
}
try{for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,500));if(await check()){open();process.exitCode=0;break;}if(i===39)throw new Error('创作室启动未完成，请重新打开。作品都已保留。');}}
finally{if(owner&&fs.existsSync(lock))fs.rmdirSync(lock);}
