import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonicalPanelKey,acquireImageFlight,releaseImageFlight,readImageFlight} from '../server/image-single-flight.mjs';

test('panel aliases share one durable single-flight reservation',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-single-flight-'));
  assert.equal(canonicalPanelKey('6-1-局部修订'),'6-1');
  assert.equal(canonicalPanelKey('第6页-第1格'),'6-1');
  const first=acquireImageFlight({projectId:'p1',projectDir:dir,projectVersion:3,panelKey:'6-1-局部修订'});
  assert.equal(readImageFlight({projectDir:dir,projectVersion:3,panelKey:'第6页-第1格'}).status,'active');
  assert.throws(()=>acquireImageFlight({projectId:'p1',projectDir:dir,projectVersion:3,panelKey:'第6页-第1格'}),error=>error.code==='IMAGE_SINGLE_FLIGHT_ACTIVE');
  releaseImageFlight(first,{outcome:'test-finished'});
  const second=acquireImageFlight({projectId:'p1',projectDir:dir,projectVersion:3,panelKey:'第6页第1格'});
  assert.equal(second.value.panelKey,'6-1');
  releaseImageFlight(second);
});
