import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function write(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);
}

/** Small durable queue: one local executor, no broker or external service. */
export class JobStore {
  constructor(dataDir){this.root=path.join(dataDir,'.任务队列');this.jobs=path.join(this.root,'jobs');this.locks=path.join(this.root,'locks');fs.mkdirSync(this.jobs,{recursive:true});fs.mkdirSync(this.locks,{recursive:true});}
  file(id){return path.join(this.jobs,`${id}.json`);}
  read(id){try{return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}catch{return null;}}
  all(){return fs.readdirSync(this.jobs).filter(name=>name.endsWith('.json')).map(name=>this.read(name.slice(0,-5))).filter(Boolean);}
  enqueue({projectId,phase}){const now=new Date().toISOString(),job={id:crypto.randomUUID(),projectId,phase,status:'queued',queuedAt:now,startedAt:null,heartbeatAt:null,endedAt:null,owner:null};write(this.file(job.id),job);return job;}
  claim(id,owner){
    // This is deliberately one executor lock, not one lock per job: different
    // projects must not start two image-producing CLI runs at the same time.
    const lock=path.join(this.locks,'executor');try{fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(path.join(lock,'owner'),`${owner}\n${id}`,{mode:0o600});}catch{return null;}
    const job=this.read(id);if(!job||job.status!=='queued'){try{fs.rmSync(lock,{recursive:true,force:true});}catch{}return null;}
    const now=new Date().toISOString();Object.assign(job,{status:'running',owner,startedAt:now,heartbeatAt:now});write(this.file(id),job);return job;
  }
  heartbeat(id,owner){const job=this.read(id);if(job?.status==='running'&&job.owner===owner){job.heartbeatAt=new Date().toISOString();write(this.file(id),job);}}
  finish(id,owner,status,detail={}){const job=this.read(id);if(job&&job.owner===owner){Object.assign(job,{status,endedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString(),...detail});write(this.file(id),job);try{fs.rmSync(path.join(this.locks,'executor'),{recursive:true,force:true});}catch{}}}
  recoverable(){
    const staleBefore=Date.now()-120000,updates=[];
    for(const job of this.all()){
      const lock=path.join(this.locks,'executor');let stale=false;try{stale=fs.statSync(lock).mtimeMs<staleBefore;}catch{stale=true;}
      if(job.status==='running'&&stale){try{fs.rmSync(lock,{recursive:true,force:true});}catch{}job.status='interrupted';job.endedAt=new Date().toISOString();job.recovery='execution_interrupted';write(this.file(job.id),job);updates.push(job);}
      else if(job.status==='queued')updates.push(job);
    }
    return updates;
  }
}
