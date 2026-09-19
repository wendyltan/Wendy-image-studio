import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {B,W,plan,sha256File,temp} from './workflow-fixtures.mjs';

test('composition rejects bad aspect ratios and oversized copy',async()=>{
  const image=path.join(temp,'wide.png');execFileSync(B.python(),['-c','from PIL import Image; import sys; Image.new("RGB",(1800,500)).save(sys.argv[1])',image]);
  const spec=path.join(temp,'bad-layout.json');W.jsonWrite(spec,{page:plan.pages[0],total:1,images:[image],output:path.join(temp,'bad.png')});
  await assert.rejects(B.pythonRun(['compose',spec]),error=>{assert.match(error.message,/比例/);assert.doesNotMatch(error.message,/Traceback|ValueError/);return true;});
  const q=structuredClone(plan.pages[0]);q.panels[0].caption='太长的文案'.repeat(150);W.jsonWrite(spec,q);await assert.rejects(B.pythonRun(['geometry',spec]),/文案过长/);
});
test('web upload preparation shrinks large references without changing originals',async()=>{
  const source=W.inside(W.REFS,W.FACE[0]),before=sha256File(source),spec=path.join(temp,'prepare-web.json'),output=path.join(temp,'web-refs');W.jsonWrite(spec,{files:[source],outputDir:output});
  const result=JSON.parse(await B.pythonRun(['prepare-web',spec]));assert.equal(result.length,1);assert.equal(result[0].optimized,true);assert(fs.existsSync(result[0].file));assert(fs.statSync(result[0].file).size<fs.statSync(source).size);assert.equal(sha256File(source),before);
});
