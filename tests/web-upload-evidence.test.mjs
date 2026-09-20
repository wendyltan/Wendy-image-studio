import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeUploadEvidence,validateUploadEvidence,writeUploadEvidence,readUploadEvidence,uploadEvidenceFailureCode} from '../server/web-upload-evidence.mjs';

const names=['01-wendi.png','02-face.png'];
const complete={schemaVersion:1,source:'browser-upload',uploadMethod:'direct-button-testid',chooserEventObserved:true,chooserAttachedBeforeClick:true,attachmentExpected:2,attachmentObserved:2,attachmentNames:names,attachmentPending:false,sendEnabled:true,failureStage:null};

test('structured upload evidence accepts a complete ordered attachment gate',()=>{
  const result=validateUploadEvidence(complete,{expectedCount:2,expectedNames:names,requireComplete:true});
  assert.equal(result.ok,true);
  assert.deepEqual(result.evidence.attachmentNames,names);
});

test('upload evidence rejects a chooser waiter installed after the click',()=>{
  const result=validateUploadEvidence({...complete,chooserAttachedBeforeClick:false},{expectedCount:2,expectedNames:names,requireComplete:true});
  assert.equal(result.ok,false);
  assert(result.errors.some(error=>/点击前/.test(error)));
});

test('upload evidence rejects chip count, order, pending, or send ambiguity',()=>{
  const result=validateUploadEvidence({...complete,attachmentObserved:1,attachmentNames:[names[1]],attachmentPending:true,sendEnabled:false},{expectedCount:2,expectedNames:names,requireComplete:true});
  assert.equal(result.ok,false);
  assert(result.errors.some(error=>/数量|顺序|上传|发送/.test(error)));
});

test('upload evidence persists only normalized structured fields',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-upload-evidence-'));
  const written=writeUploadEvidence(dir,{...complete,attachmentNames:[...names,'']});
  const read=readUploadEvidence(dir);
  assert.deepEqual(read.attachmentNames,names);
  assert.equal(written.uploadMethod,'direct-button-testid');
  assert.equal(uploadEvidenceFailureCode(normalizeUploadEvidence({...complete,failureStage:'file-set'})),'FILE_SET_FAILED');
});
