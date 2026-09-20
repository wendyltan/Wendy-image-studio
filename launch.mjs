import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.WENDI_PORT||4318);
const url=`http://127.0.0.1:${port}`;
const TYPESAFE_KEYCHAIN_SERVICE='com.wuwendi.wendi-studio.typesafe';
const TYPESAFE_KEYCHAIN_ACCOUNT='typesafe-api-key';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function readTypeSafeKeychainKey(){
  try{
    const value=execFileSync('/usr/bin/security',['find-generic-password','-a',TYPESAFE_KEYCHAIN_ACCOUNT,'-s',TYPESAFE_KEYCHAIN_SERVICE,'-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    return value||null;
  }catch{return null;}
}
async function check(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1200)});const x=await r.json();if(x.app!=='wendi-studio')throw new Error('端口已被其他应用使用');return true;}catch(e){if(e.message==='端口已被其他应用使用')throw e;return false;}}
function open(){if(process.env.WENDI_NO_OPEN==='1')return;spawn('/usr/bin/open',[`http://localhost:${port}`],{detached:true,stdio:'ignore'}).unref();}
function listenerPids(){
  try{return execFileSync('/usr/sbin/lsof',['-nP',`-tiTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8'}).trim().split(/\s+/).map(Number).filter(pid=>Number.isInteger(pid)&&pid>1&&pid!==process.pid);}
  catch(error){if(error.status===1)return [];throw error;}
}
async function stopExisting(){
  if(!await check())return;
  const pids=listenerPids();
  if(!pids.length)throw new Error('检测到旧服务，但无法确认它的进程。为保护作品，本次没有强制关闭。');
  for(const pid of pids){try{process.kill(pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}}
  for(let i=0;i<80;i++){await wait(100);if(!await check())return;}
  throw new Error('旧服务仍在保存当前进度，请稍后再次打开温蒂创作室。');
}
if(!fs.existsSync(path.join(root,'dist/client/index.html')))throw new Error('创作室页面尚未准备完成，请先完成安装。');
const runtime=process.env.WENDI_RUNTIME_DIR||path.join(root,'.runtime');fs.mkdirSync(runtime,{recursive:true});
const lock=path.join(runtime,'launch.lock');let owner=false;
try{fs.mkdirSync(lock);owner=true;}catch{if(Date.now()-fs.statSync(lock).mtimeMs>60000){fs.rmdirSync(lock);fs.mkdirSync(lock);owner=true;}}
try{
  if(owner){
    await stopExisting();
    const log=fs.openSync(path.join(runtime,'server.log'),'a',0o600);
    const typesafeKey=readTypeSafeKeychainKey();
    const env={...process.env,PATH:path.dirname(process.execPath)+':/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',PORT:String(port),...(typesafeKey?{TYPESAFE_API_KEY:typesafeKey}: {})};
    const child=spawn(process.execPath,[path.join(root,'server/server.mjs')],{cwd:root,env,stdio:['ignore',log,log],detached:true});
    fs.closeSync(log);child.unref();fs.writeFileSync(path.join(runtime,'server.pid'),String(child.pid));
  }else{
    for(let i=0;i<100&&fs.existsSync(lock);i++)await wait(100);
  }
  for(let i=0;i<40;i++){await wait(500);if(await check()){open();process.exitCode=0;break;}if(i===39)throw new Error('创作室启动未完成，请重新打开。作品都已保留。');}
}finally{if(owner&&fs.existsSync(lock))fs.rmdirSync(lock);}
