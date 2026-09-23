import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wendi-compose-tests-'));
process.env.WENDI_DATA_DIR=path.join(temp,'stories');
const W=await import('../server/workflow.mjs');
const B=await import('../server/bridge.mjs');
const E=await import('../server/engine.mjs');

function fixturePage(title='页标题像素回归'){
  return {number:1,title,layout:'solo',panels:[{caption:'',captionKind:'narration'}]};
}
function sourceImage(){
  const file=path.join(temp,'source.png');
  const script='from PIL import Image; import sys; Image.new("RGB",(760,1000),(18,52,86)).save(sys.argv[1])';
  requireChild('python',B.python(),['-c',script,file]);
  return file;
}
function requireChild(label,command,args){
  try{return execFileSync(command,args,{stdio:'pipe'});}catch(error){
    throw new Error(`${label} fixture failed: ${error.stderr?.toString()||error.message}`);
  }
}
async function compose(page,output,image){
  const spec=path.join(temp,`${path.basename(output)}.json`);
  W.jsonWrite(spec,{page,total:1,images:[image],output});
  await B.pythonRun(['compose',spec]);
}
function pixel(file,x,y){
  const script='from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGB"); print(*im.getpixel((int(sys.argv[2]),int(sys.argv[3]))),sep=",")';
  return execFileSync(B.python(),['-c',script,file,String(x),String(y)],{encoding:'utf8'}).trim();
}

test('final page composition does not paint the plan page title over the first panel',async()=>{
  const image=sourceImage(),output=path.join(temp,'no-title.png');
  await compose(fixturePage(),output,image);
  // The old renderer painted a cream title card at (38,38)-(…) on top of the
  // first panel. A fixed-color source makes that historical pixel observable.
  assert.equal(pixel(output,65,65),'18,52,86');
});

test('changing a plan page title does not change final page pixels',async()=>{
  const image=sourceImage(),first=path.join(temp,'title-a.png'),second=path.join(temp,'title-b.png');
  await compose(fixturePage('标题甲'),first,image);
  await compose(fixturePage('标题乙'),second,image);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(first)).digest('hex'),crypto.createHash('sha256').update(fs.readFileSync(second)).digest('hex'));
});

test('composition keeps the 1080x1440 canvas, caption box, and footer page number',async()=>{
  const image=sourceImage(),first=path.join(temp,'page-seven.png'),second=path.join(temp,'page-eight.png');
  const page=fixturePage('方案标题不入成稿');page.number=7;page.panels[0].caption='文字框仍保留';
  await compose(page,first,image);
  page.number=8;await compose(page,second,image);
  assert.deepEqual(JSON.parse(await B.pythonRun(['info',first])),{width:1080,height:1440,mode:'RGB',format:'PNG'});
  assert.notEqual(pixel(first,50,1320),'18,52,86');
  assert.notEqual(crypto.createHash('sha256').update(fs.readFileSync(first)).digest('hex'),crypto.createHash('sha256').update(fs.readFileSync(second)).digest('hex'));
});

test('caption wrapping keeps Latin words together and bounds overlong tokens',()=>{
  const script='import importlib.util,sys; s=importlib.util.spec_from_file_location("compose",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(*m.wrap(sys.argv[2],int(sys.argv[3]),24),sep=chr(10))';
  const run=(text,width)=>execFileSync(B.python(),['-c',script,path.join(path.resolve(import.meta.dirname,'..'),'server/compose.py'),text,String(width)],{encoding:'utf8'}).trimEnd().split('\n');
  assert.deepEqual(run('routine',100),['routine']);
  const mixed=run('固定的 routine，对我这个 i 人来说',120);
  assert(mixed.some(line=>line.includes('routine')));
  const caption='但趁一袋，把坚果，像松鼠一样嘎嘎嘎地。也能快乐小会儿。',narrow=run(caption,215);
  assert.equal(narrow.join(''),caption);
  assert(narrow.every(line=>! /^[，。！？；：、）】》」』”’…]/.test(line)));
  const long=run('中文 extraordinarilylongwordwithoutbreaks 和 abc-def',140);
  assert(long.some(line=>line.includes('abc-def')));
  const measured=execFileSync(B.python(),['-c','from PIL import ImageFont; import sys; f=ImageFont.truetype("/System/Library/Fonts/STHeiti Light.ttc",24); print(max((f.getlength(x) for x in sys.stdin.read().splitlines()),default=0))'],{input:long.join('\n'),encoding:'utf8'});
  assert(Number(measured)<=140);
});

test('old page records are stale while the new composition version is current',()=>{
  const project={plan:{pages:[{number:1,panels:[{}]}]},panels:{'1-1':{file:'v1/source.png'}},artifacts:[
    {id:'image:第1页-第1格',file:'v1/source.png',valid:true},
    {id:'page:1',file:'v1/page.png',compositionVersion:E.COMPOSITION_VERSION,valid:true},
  ]};
  const oldPage={number:1,file:'v1/page.png',qa:{pass:true},dependsOn:['image:第1页-第1格']};
  assert.equal(E.pageIsCurrent(project,oldPage),false);
  const currentPage={...oldPage,compositionVersion:E.COMPOSITION_VERSION};
  assert.equal(E.pageIsCurrent(project,currentPage),true);
});

test('accept refuses a legacy titled page and accepts a re-composed current page',async()=>{
  const source=sourceImage(),pageFile=path.join(temp,'accepted-page.png');
  await compose(fixturePage(),pageFile,source);
  const project=E.createProject({idea:'排版版本验收回归',pageCount:1,allowXiaolin:false,tangyuan:'不出现'});
  project.version=1;project.plan={pages:[{number:1,panels:[{}]}]};project.approved={version:1,hash:'plan-hash'};project.status='ready';project.storyQA={pass:true};
  const projectPage=path.join(E.projectDir(project.id),'v1','候选成稿.png'),sourcePanel=path.join(E.projectDir(project.id),'v1','素材','source.png');
  fs.mkdirSync(path.dirname(projectPage),{recursive:true});fs.mkdirSync(path.dirname(sourcePanel),{recursive:true});fs.copyFileSync(pageFile,projectPage);fs.copyFileSync(source,sourcePanel);fs.writeFileSync(path.join(E.projectDir(project.id),'v1','已确认分镜.md'),'fixture');
  const pageRelative=path.relative(E.projectDir(project.id),projectPage),panelRelative=path.relative(E.projectDir(project.id),sourcePanel);
  project.panels={'1-1':{file:panelRelative,qa:{pass:true}}};project.pages=[{number:1,file:pageRelative,qa:{pass:true},dependsOn:['image:第1页-第1格']}];project.artifacts=[
    {id:'image:第1页-第1格',kind:'image',file:panelRelative,valid:true},
    {id:'page:1',kind:'page',file:pageRelative,compositionVersion:E.COMPOSITION_VERSION,valid:true},
    {id:'story:audit',kind:'story-audit',file:null,valid:true,dependsOn:['page:1']},
  ];E.saveProject(project);
  await assert.rejects(E.accept(project,W.CHECKS),/全篇制作和校对/);
  assert(fs.existsSync(projectPage));
  assert.equal(fs.existsSync(path.join(E.projectDir(project.id),'v1','成品','01.png')),false);
  project.pages[0].compositionVersion=E.COMPOSITION_VERSION;
  const pageBytes=fs.statSync(projectPage).size,pageSha=crypto.createHash('sha256').update(fs.readFileSync(projectPage)).digest('hex');
  project.pages[0].integrity={sha256:pageSha,sizeBytes:pageBytes};
  project.artifacts.find(item=>item.id==='page:1').integrity={sha256:pageSha,sizeBytes:pageBytes};
  fs.appendFileSync(projectPage,'tamper');
  await assert.rejects(E.accept(project,W.CHECKS),/完整性/);
  fs.copyFileSync(pageFile,projectPage);
  await E.accept(project,W.CHECKS);
  assert.equal(project.accepted,true);assert(fs.existsSync(path.join(E.projectDir(project.id),'v1','成品','01.png')));
  assert.equal(project.bundleIntegrity.entries.length,2);
  assert.equal(project.artifacts.find(item=>item.id==='export:bundle')?.integrity.sha256,project.bundleIntegrity.sha256);
});

test('zip output reports and verifies each bundle entry',async()=>{
  const first=path.join(temp,'bundle-a.png'),second=path.join(temp,'bundle-b.md'),output=path.join(temp,'bundle.zip'),spec=path.join(temp,'bundle-spec.json');
  fs.writeFileSync(first,'one');fs.writeFileSync(second,'two');W.jsonWrite(spec,{output,files:[first,second]});
  const result=JSON.parse(await B.pythonRun(['zip',spec]));
  assert.equal(result.output,output);assert.equal(result.entries.length,2);assert.deepEqual(result.entries.map(entry=>entry.name),['bundle-a.png','bundle-b.md']);
  assert.equal(result.bytes,fs.statSync(output).size);assert.equal(result.sha256,crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'));
});
