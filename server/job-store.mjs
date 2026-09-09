import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function write(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);
}

function ownerPid(owner){const match=/^(\d+):/.exec(String(owner||''));return match?Number(match[1]):null;}
function processAlive(pid){if(!Number.isInteger(pid)||pid<2)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}

/** Small durable queue: one local executor, no broker or external service. */
export class JobStore {
  constructor(dataDir){this.root=path.join(dataDir,'.任务队列');this.jobs=path.join(this.root,'jobs');this.locks=path.join(this.root,'locks');fs.mkdirSync(this.jobs,{recursive:true});fs.mkdirSync(this.locks,{recursive:true});}
  file(id){return path.join(this.jobs,`${id}.json`);}
  read(id){try{return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}catch{return null;}}
  all(){return fs.readdirSync(this.jobs).filter(name=>name.endsWith('.json')).map(name=>this.read(name.slice(0,-5))).filter(Boolean);}
  enqueue({projectId,phase,submitter=null}){const now=new Date().toISOString(),job={id:crypto.randomUUID(),projectId,phase,status:'queued',queuedAt:now,startedAt:null,heartbeatAt:null,endedAt:null,owner:null,submitter,submitterPid:ownerPid(submitter)};write(this.file(job.id),job);return job;}
  lockFile(){return path.join(this.locks,'executor','lease.json');}
  lock(){try{return JSON.parse(fs.readFileSync(this.lockFile(),'utf8'));}catch{return null;}}
  release(id,owner){const lease=this.lock();if(lease?.id!==id||lease?.owner!==owner)return false;try{fs.rmSync(path.dirname(this.lockFile()),{recursive:true,force:true});return true;}catch{return false;}}
  claim(id,owner){
    // This is deliberately one executor lock, not one lock per job: different
    // projects must not start two image-producing CLI runs at the same time.
    const lock=path.join(this.locks,'executor');try{fs.mkdirSync(lock,{mode:0o700});}catch{return null;}
    const now=new Date().toISOString();write(this.lockFile(),{schemaVersion:1,id,owner,pid:ownerPid(owner),state:'claiming',acquiredAt:now,heartbeatAt:now});
    const job=this.read(id);if(!job||job.status!=='queued'){this.release(id,owner);return null;}
    Object.assign(job,{status:'running',owner,startedAt:now,heartbeatAt:now});write(this.file(id),job);const lease=this.lock();if(lease?.id===id&&lease.owner===owner){lease.state='running';write(this.lockFile(),lease);}return job;
  }
  heartbeat(id,owner){const job=this.read(id),lease=this.lock();if(job?.status==='running'&&job.owner===owner&&lease?.id===id&&lease?.owner===owner){const now=new Date().toISOString();job.heartbeatAt=now;lease.heartbeatAt=now;write(this.file(id),job);write(this.lockFile(),lease);return true;}return false;}
  finish(id,owner,status,detail={}){const job=this.read(id);if(job&&job.owner===owner){const now=new Date().toISOString();Object.assign(job,{status,endedAt:now,heartbeatAt:now,...detail});write(this.file(id),job);this.release(id,owner);return true;}return false;}
  cancel(id,status='paused',detail={}){const lease=this.lock();if(lease?.id===id)return false;const job=this.read(id);if(!job||job.status!=='queued')return false;Object.assign(job,{status,endedAt:new Date().toISOString(),...detail});write(this.file(id),job);return true;}
  reclaimOrphanedLock(staleMs=120000){
    const lockDir=path.dirname(this.lockFile()),lease=this.lock();
    if(!lease){try{if(fs.statSync(lockDir).mtimeMs<Date.now()-staleMs){fs.rmSync(lockDir,{recursive:true,force:true});return true;}}catch{return true;}return false;}
    const heartbeat=Date.parse(lease.heartbeatAt||lease.acquiredAt||0),stale=!Number.isFinite(heartbeat)||heartbeat<Date.now()-staleMs;
    if(!stale||processAlive(Number(lease.pid)||ownerPid(lease.owner)))return false;
    return this.release(lease.id,lease.owner);
  }
  recoverable(){
    const staleBefore=Date.now()-120000,updates=[];
    for(const job of this.all()){
      const heartbeat=Date.parse(job.heartbeatAt||job.startedAt||0),stale=!Number.isFinite(heartbeat)||heartbeat<staleBefore,pid=ownerPid(job.owner);
      if(job.status==='running'&&stale&&!processAlive(pid)){this.release(job.id,job.owner);job.status='interrupted';job.endedAt=new Date().toISOString();job.recovery='execution_interrupted';write(this.file(job.id),job);updates.push(job);}
      else if(job.status==='queued'&&(!job.submitter||!processAlive(Number(job.submitterPid)||ownerPid(job.submitter))))updates.push(job);
    }
    return updates;
  }
  hasLiveWork(projectId){return this.all().some(job=>job.projectId===projectId&&((job.status==='queued'&&job.submitter&&processAlive(Number(job.submitterPid)||ownerPid(job.submitter)))||(job.status==='running'&&processAlive(ownerPid(job.owner)))));}
}
