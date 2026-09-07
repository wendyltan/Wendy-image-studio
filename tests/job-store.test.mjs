import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {JobStore} from '../server/job-store.mjs';

test('a live owner with a fresh heartbeat is never recovered as interrupted',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-job-store-')),store=new JobStore(root),job=store.enqueue({projectId:'live',phase:'generating'}),owner=`${process.pid}:live`;
  assert(store.claim(job.id,owner));const old=new Date(Date.now()-180000);fs.utimesSync(path.join(store.locks,'executor'),old,old);assert(store.heartbeat(job.id,owner));
  assert.equal(store.recoverable().some(item=>item.id===job.id),false);assert.equal(store.read(job.id).status,'running');assert.equal(store.lock().owner,owner);store.finish(job.id,owner,'completed');
});

test('an old owner cannot release a newer owners executor lock',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-job-store-')),store=new JobStore(root),first=store.enqueue({projectId:'first',phase:'generating'}),second=store.enqueue({projectId:'second',phase:'generating'}),oldOwner=`${process.pid}:old`,newOwner=`${process.pid}:new`;
  assert(store.claim(first.id,oldOwner));fs.rmSync(path.join(store.locks,'executor'),{recursive:true,force:true});assert(store.claim(second.id,newOwner));
  assert(store.finish(first.id,oldOwner,'completed'));assert.equal(store.lock().id,second.id);assert.equal(store.lock().owner,newOwner);store.finish(second.id,newOwner,'completed');
});

test('a queued record can be consumed once during restart recovery',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-job-store-')),store=new JobStore(root),job=store.enqueue({projectId:'queued',phase:'planning'});
  assert.equal(store.recoverable().filter(item=>item.id===job.id).length,1);assert(store.cancel(job.id,'interrupted',{reason:'service_restarted_before_start'}));assert.equal(store.recoverable().filter(item=>item.id===job.id).length,0);assert.equal(store.read(job.id).status,'interrupted');
});
