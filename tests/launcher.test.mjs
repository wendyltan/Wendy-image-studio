import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const APP=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function runLauncher(env){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(APP,'launch.mjs')],{cwd:APP,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(output||`launcher exited ${code}`)));
  });
}

test('每次打开入口都会替换旧后台服务',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-launcher-'));
  const port=46000+(process.pid%1000);
  const env={WENDI_PORT:String(port),WENDI_NO_OPEN:'1',WENDI_RUNTIME_DIR:path.join(temp,'runtime'),WENDI_DATA_DIR:path.join(temp,'data')};
  let livePid=null;
  try{
    await runLauncher(env);
    const first=Number(fs.readFileSync(path.join(env.WENDI_RUNTIME_DIR,'server.pid'),'utf8'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status,200);
    await runLauncher(env);
    const second=Number(fs.readFileSync(path.join(env.WENDI_RUNTIME_DIR,'server.pid'),'utf8'));
    livePid=second;
    assert.notEqual(second,first);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status,200);
  }finally{
    if(livePid){try{process.kill(livePid,'SIGTERM');}catch{ /* Process may already have exited. */ }}
    await wait(150);
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test('launcher reaches health when startup recovery sees a legacy usage record',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-launcher-legacy-'));
  const port=47000+(process.pid%1000),id='11111111-1111-4111-8111-111111111111',env={WENDI_PORT:String(port),WENDI_NO_OPEN:'1',WENDI_RUNTIME_DIR:path.join(temp,'runtime'),WENDI_DATA_DIR:path.join(temp,'data')};
  const projectDir=path.join(env.WENDI_DATA_DIR,id),runDir=path.join(projectDir,'.制作记录','1780000000000-legacy-run');
  fs.mkdirSync(runDir,{recursive:true});
  fs.writeFileSync(path.join(projectDir,'project.json'),JSON.stringify({id,title:'启动恢复夹具',status:'draft',updatedAt:new Date().toISOString(),brief:{},metrics:{inputTokens:1,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalRuns:1},tasks:[],currentTask:null,pending:null,lastFailure:null}));
  fs.writeFileSync(path.join(runDir,'events.jsonl'),JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}})+'\n');
  let livePid=null;
  try{
    await runLauncher(env);
    livePid=Number(fs.readFileSync(path.join(env.WENDI_RUNTIME_DIR,'server.pid'),'utf8'));
    const response=await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status,200);
    assert.equal((await response.json()).app,'wendi-studio');
  }finally{
    if(livePid){try{process.kill(livePid,'SIGTERM');}catch{ /* Process may already have exited. */ }}
    await wait(150);
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
