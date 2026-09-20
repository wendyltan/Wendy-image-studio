import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskState} from '../server/task-state.mjs';
import {canonicalPanelKey} from '../server/image-single-flight.mjs';

test('canonical target retries increment attempt and ignore legacy attempt hints',()=>{
  const saved=[];
  const state=createTaskState({saveProject:project=>saved.push(structuredClone(project)),canonicalizeTarget:canonicalPanelKey,randomUUID:(()=>{let n=0;return()=>`task-${++n}`;})()});
  const project={id:'project',version:1,tasks:[]};
  const first=state.beginTask(project,'image','第6页-第1格',{attempt:1});
  state.finishTask(project,first,'failed_no_output');
  const retry=state.beginTask(project,'image','6-1-局部修订',{attempt:1});
  assert.equal(retry.attempt,2);
  assert.equal(saved.at(-1).currentTask.attempt,2);
});
