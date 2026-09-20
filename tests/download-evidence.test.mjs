import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DOWNLOAD_EVIDENCE_FILE,
  extractDownloadEvidence,
  inspectDownloadArtifact,
  readDownloadEvidence,
  validateDownloadEvidence,
  writeDownloadEvidence,
} from '../server/web-download-evidence.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-download-evidence-'));
const conversationUrl='https://chatgpt.com/c/evidence-fixture';
const projectId='11111111-1111-4111-8111-111111111111';
const projectVersion=2;
const taskId='22222222-2222-4222-8222-222222222222';
const target='第5页-第1格';
const requestId='11111111-1111-4111-8111-111111111111';
const runId='1789860378777-fixture';

function fixture(){
  const dir=path.join(root,crypto.randomUUID()),output=path.join(dir,'out.png');
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(output,PNG);
  const actual=inspectDownloadArtifact(output);
  const src='https://chatgpt.com/backend-api/estuary/content?id=file_current_fixture&sig=fixture';
  return {dir,output,actual,evidence:{
    schemaVersion:2,source:'pageAssets',projectId,projectVersion,taskId,target,conversationUrl,requestId,runId,
    currentResult:{src,resultId:'file_current_fixture',marker:'暖阳厨房里的手冲咖啡时光'},
    inventory:{id:'inventory-fixture',assetCount:1},exactMatchCount:1,matchedAssetIds:['asset-current'],
    matchedAsset:{id:'asset-current',kind:'image',contentType:'image/png',url:src,sourceUrl:src,role:'generated-result',isThumbnail:false,isPreview:false},
    bundle:{downloadedCount:1,failures:[],contentType:'image/png',path:'/tmp/bundled-original.png'},
    output:{path:output,bytes:actual.bytes,format:actual.format,width:actual.width,height:actual.height,sha256:actual.sha256},
    capturedAt:'2026-09-20T00:00:00.000Z',
  }};
}

test('structured page-assets evidence validates against the exact original artifact',()=>{
  const run=fixture(),check=validateDownloadEvidence(run.evidence,{conversationUrl,requestId,runId,outputFile:run.output,actual:run.actual});
  assert.equal(check.ok,true,check.errors?.join('; '));
  const file=writeDownloadEvidence(run.dir,run.evidence,{conversationUrl,requestId,runId,outputFile:run.output,actual:run.actual});
  assert.equal(file,path.join(run.dir,DOWNLOAD_EVIDENCE_FILE));
  assert.deepEqual(readDownloadEvidence(run.dir),run.evidence);
});

test('validator rejects zero or multiple exact result-asset matches',()=>{
  const run=fixture();
  for(const count of [0,2]){
    const check=validateDownloadEvidence({...run.evidence,exactMatchCount:count},{conversationUrl,requestId,runId,outputFile:run.output,actual:run.actual});
    assert.equal(check.ok,false);assert(check.errors.some(error=>/exactMatchCount|精确匹配/.test(error)));
  }
  const multiple=validateDownloadEvidence({...run.evidence,matchedAssetIds:['asset-current','asset-old']},{conversationUrl,requestId,runId,outputFile:run.output,actual:run.actual});
  assert.equal(multiple.ok,false);assert(multiple.errors.some(error=>/matchedAssetIds|精确匹配/.test(error)));
});

test('validator rejects stale, preview, non-image, and hash-mismatched assets',()=>{
  const run=fixture(),base={conversationUrl,requestId,runId,outputFile:run.output,actual:run.actual};
  const stale=validateDownloadEvidence({...run.evidence,currentResult:{...run.evidence.currentResult,src:'https://chatgpt.com/backend-api/estuary/content?id=file_new'},},{...base});
  assert.equal(stale.ok,false);assert(stale.errors.some(error=>/URL|对应|src/.test(error)));
  const preview=validateDownloadEvidence({...run.evidence,matchedAsset:{...run.evidence.matchedAsset,role:'preview',isPreview:true}},{...base});
  assert.equal(preview.ok,false);assert(preview.errors.some(error=>/thumbnail|preview|预览|缩略/.test(error)));
  const nonImage=validateDownloadEvidence({...run.evidence,matchedAsset:{...run.evidence.matchedAsset,kind:'document',contentType:'application/pdf'}},{...base});
  assert.equal(nonImage.ok,false);assert(nonImage.errors.some(error=>/image|图片|contentType/.test(error)));
  const hash=validateDownloadEvidence({...run.evidence,output:{...run.evidence.output,sha256:'0'.repeat(64)}},{...base});
  assert.equal(hash.ok,false);assert(hash.errors.some(error=>/sha|SHA|hash|校验/i.test(error)));
});

test('validator rejects incomplete page-assets identity and bundle evidence',()=>{
  const run=fixture(),base={conversationUrl,requestId,runId,outputFile:run.output,actual:run.actual};
  const missingInventory=validateDownloadEvidence({...run.evidence,inventory:null},{...base});
  assert.equal(missingInventory.ok,false);assert(missingInventory.errors.some(error=>/inventory/.test(error)));
  const missingMatches=validateDownloadEvidence({...run.evidence,matchedAssetIds:null},{...base});
  assert.equal(missingMatches.ok,false);assert(missingMatches.errors.some(error=>/matchedAssetIds/.test(error)));
  const missingBundleType=validateDownloadEvidence({...run.evidence,bundle:{...run.evidence.bundle,contentType:null}},{...base});
  assert.equal(missingBundleType.ok,false);assert(missingBundleType.errors.some(error=>/bundle contentType/.test(error)));
  const missingSource=validateDownloadEvidence({...run.evidence,source:'executor-prose'},{...base});
  assert.equal(missingSource.ok,false);assert(missingSource.errors.some(error=>/source/.test(error)));
});

test('extractor only accepts the machine-readable download evidence marker',()=>{
  const run=fixture(),text=`前置说明\n<download_evidence>${JSON.stringify(run.evidence)}</download_evidence>\n后置说明`;
  assert.deepEqual(extractDownloadEvidence(text),run.evidence);
  assert.deepEqual(extractDownloadEvidence(run.evidence),run.evidence);
  assert.equal(extractDownloadEvidence('没有结构化下载记录'),null);
});

test('validator cross-checks identity against request, worker, result, and manifest records',()=>{
  const run=fixture(),base={expectedIdentity:{projectId,projectVersion,taskId,target,requestId,runId,conversationUrl,outputFile:run.output},request:{projectId,projectVersion,taskId,target,requestId,runId,outputFile:run.output,conversationUrl},worker:{projectId,projectVersion,taskId,target,requestId,runId,outputFile:run.output},result:{projectId,projectVersion,taskId,target,requestId,runId,downloadEvidence:run.evidence},manifest:{projectId,projectVersion,taskId,target,requestId,runId,outputFile:run.output,conversationUrl},outputFile:run.output,actual:run.actual};
  assert.equal(validateDownloadEvidence(run.evidence,base).ok,true);
  for(const source of ['request','worker','result','manifest']){
    const records=structuredClone(base);if(source==='result')records[source].downloadEvidence={...run.evidence,target:'错误目标'};else records[source]={...records[source],target:'错误目标'};
    const check=validateDownloadEvidence(run.evidence,records);assert.equal(check.ok,false,source);assert(check.errors.some(error=>/target|目标/.test(error)),source);
  }
});
