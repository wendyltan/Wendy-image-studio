import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {APP,ROOT,REFS,CHECKS,inside,digest} from './workflow.mjs';
import {connectionStatus,appServerSnapshot,normalizeRateLimits} from './bridge.mjs';
import {active,listProjects,readProject,saveProject,createProject,planProject,approvePlan,approveSamples,resume,reviseImage,recoverImage,accept,recover,projectDir,syncRunningProject} from './engine.mjs';
import {CATEGORIES,listDocuments,listAssets,discoverArchiveStories,archiveStory,stageUpload,readCandidate,analyzeAsset,saveAssetProposal,applyAssetProposal,saveDocument,suggestDocument,deleteProjectFolder,deleteArchiveStory} from './library.mjs';
const PORT=Number(process.env.PORT||4318);const HOST='127.0.0.1';
const front=path.join(APP,'dist/client');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.zip':'application/zip','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8'};
let connection=await connectionStatus();
const ACCOUNT_CACHE_FILE=path.join(APP,'.runtime','account-cache.json');
function readAccountCache(){try{return JSON.parse(fs.readFileSync(ACCOUNT_CACHE_FILE,'utf8'));}catch{return null;}}
function writeAccountCache(value){try{fs.mkdirSync(path.dirname(ACCOUNT_CACHE_FILE),{recursive:true});fs.writeFileSync(ACCOUNT_CACHE_FILE,JSON.stringify(value),{mode:0o600});}catch{}}
let accountCache={at:0,value:readAccountCache()},accountInFlight=null;
recover();
const fallbackModels=[{id:'gpt-6-astra',label:'GPT-6 Astra',description:'复杂故事与关键成稿',defaultReasoningEffort:'low',reasoningEfforts:['low','medium','high','xhigh','max','ultra']},{id:'gpt-5.6-terra',label:'GPT-5.6 Terra',description:'日常创作的均衡选择',defaultReasoningEffort:'medium',reasoningEfforts:['low','medium','high','xhigh','max','ultra']}];
async function account(force=false){
  if(!force&&accountCache.value&&Date.now()-accountCache.at<120000)return accountCache.value;
  if(accountInFlight)return accountInFlight;
  accountInFlight=(async()=>{
    const raw=await appServerSnapshot();
    const models=(raw.models||[]).map(m=>({id:m.id||m.model,label:m.displayName||m.name||m.id||m.model,description:m.description||'',defaultReasoningEffort:m.defaultReasoningEffort||'medium',reasoningEfforts:(m.supportedReasoningEfforts||m.reasoningEfforts||[]).map(x=>typeof x==='string'?x:x.reasoningEffort||x.value).filter(Boolean),isDefault:m.isDefault===true}));
    const limits=normalizeRateLimits(raw.rateLimits);
    const fresh=limits.primary||limits.secondary;
    const previous=accountCache.value;
    const clean={models:models.length?models:(previous?.models||fallbackModels),rateLimits:fresh?limits:(previous?.rateLimits||null),usage:raw.usage?{planType:raw.usage.planType||null,credits:raw.usage.credits?{balance:raw.usage.credits.balance}:null}:null,status:fresh?(raw.status||'fresh'):(previous?.rateLimits?'stale':'unavailable'),error:raw.error||(!fresh?'额度暂不可用。':'')||null,updatedAt:new Date().toISOString()};
    if(fresh&&!process.env.WENDI_TEST_PLAN_FILE)writeAccountCache(clean);
    accountCache={at:Date.now(),value:clean};return clean;
  })();
  try{return await accountInFlight;}finally{accountInFlight=null;}
}
function send(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function file(res,file,download=false){
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())return send(res,{error:'文件不存在'},404);
  const headers={'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':'no-cache'};
  if(download)headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  res.writeHead(200,headers);fs.createReadStream(file).pipe(res);
}
function publicProject(p){
  const media=f=>f?`/media/project/${p.id}/${f.split(path.sep).map(encodeURIComponent).join('/')}`:null;
  return {...p,pending:p.pending?{key:p.pending.key,at:p.pending.at}:null,history:p.history.map(h=>({version:h.version,title:h.plan.title,at:h.approved?.at,plan:h.plan,pages:h.pages.map(q=>({...q,url:media(q.finalFile||q.file)}))})),
    planHash:p.plan?digest(p.plan):null,busy:active.has(p.id),
    samples:p.samples.map(s=>s?{...s,url:media(s.file)}:s),
    panels:Object.fromEntries(Object.entries(p.panels).map(([k,v])=>[k,{...v,url:media(v.file)}])),
    pages:p.pages.map(q=>({...q,url:media(q.finalFile||q.file)})),bundleURL:media(p.bundle),outputFolder:p.accepted?path.join(projectDir(p.id),`v${p.version}`,'成品'):projectDir(p.id)};
}
function allowedProjectFiles(p){
  return new Set([...p.samples.filter(Boolean).map(x=>x.file),...Object.values(p.panels).map(x=>x.file),...p.pages.flatMap(x=>[x.file,x.finalFile]),p.bundle,
    ...p.history.flatMap(h=>[...h.samples.filter(Boolean).map(x=>x.file),...Object.values(h.panels).map(x=>x.file),...h.pages.flatMap(x=>[x.file,x.finalFile])])].filter(Boolean));
}
async function body(req,max=250000){let b='';for await(const c of req){b+=c;if(Buffer.byteLength(b)>max){throw new Error('内容太长，请缩短后再提交。');}}try{return JSON.parse(b||'{}');}catch{throw new Error('提交内容无效');}}
function chooseModel(snapshot,id,effort){const model=snapshot.models.find(m=>m.id===id)||snapshot.models.find(m=>m.isDefault)||snapshot.models[0];if(!model)throw new Error('当前没有可用的创作模型。');const reasoning=model.reasoningEfforts.includes(effort)?effort:model.defaultReasoningEffort;return {model:model.id,reasoningEffort:reasoning};}
function projectSource(p,kind,key){let rel;if(kind==='page')rel=p.pages.find(x=>String(x.number)===String(key))?.finalFile||p.pages.find(x=>String(x.number)===String(key))?.file;else if(kind==='panel')rel=p.panels[key]?.file;else if(kind==='sample')rel=p.samples[Number(key)]?.file;if(!rel||!allowedProjectFiles(p).has(rel))throw new Error('这张作品图片不存在。');return inside(projectDir(p.id),rel);}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  const host=req.headers.host;
  if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`,`127.0.0.1:5173`,`localhost:5173`].includes(host))return send(res,{error:'仅限本机访问'},403);
  let url;try{url=new URL(req.url,`http://${host}`);}catch{return send(res,{error:'地址无效'},400);}
  try {
    if(!['GET','POST'].includes(req.method))return send(res,{error:'不支持的操作'},405);
    if(req.method==='POST'){
      const origin=req.headers.origin;const allowed=[`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`,'http://127.0.0.1:5173','http://localhost:5173'];
      if(req.headers['x-wendi-request']!=='studio'||!String(req.headers['content-type']).startsWith('application/json')||(origin&&!allowed.includes(origin)))return send(res,{error:'请从本地创作室提交'},403);
    }
    if(url.pathname==='/api/health')return send(res,{app:'wendi-studio',ready:true,connection,version:'2.1.0'});
    if(url.pathname==='/api/bootstrap'){
      const snapshot=await account();const assets=listAssets().map(x=>({...x,url:'/media/asset/'+x.file.split('/').map(encodeURIComponent).join('/')}));const stories=discoverArchiveStories().map(s=>({...s,coverUrl:`/media/archive-story/${s.id}/0`,pages:s.pages.map((_,i)=>({index:i,url:`/media/archive-story/${s.id}/${i}`}))}));
      return send(res,{connection,checks:CHECKS,projects:listProjects().map(publicProject),account:snapshot,categories:CATEGORIES,documents:listDocuments(),assets,references:assets.filter(x=>!x.file.startsWith('02-')),archiveStories:stories,hero:stories[0]?.coverUrl||assets[0]?.url});
    }
    if(url.pathname==='/api/account'&&req.method==='POST')return send(res,await account(true));
    if(url.pathname==='/api/connection'&&req.method==='POST'){connection=await connectionStatus();return send(res,connection);}
    if(url.pathname==='/api/projects'&&req.method==='POST'){const b=await body(req),selected=chooseModel(await account(),b.model,b.reasoningEffort);const p=createProject({...b,...selected});planProject(p);return send(res,publicProject(p),201);}
    if(url.pathname==='/api/assets/upload'&&req.method==='POST'){const b=await body(req,30000000),candidate=await stageUpload(b),meta=readCandidate(candidate.id),selected=chooseModel(await account(),b.model,b.reasoningEffort);const proposal=await analyzeAsset({file:meta.file,sourceLabel:'用户手动上传：'+meta.name,dir:path.join(APP,'.素材候选',candidate.id,'分析'),...selected});return send(res,{candidate,proposal:saveAssetProposal(proposal)});}
    if(url.pathname==='/api/assets/analyze'&&req.method==='POST'){const b=await body(req),p=readProject(b.projectId),source=projectSource(p,b.kind,b.key),selected=chooseModel(await account(),b.model,b.reasoningEffort);const proposal=await analyzeAsset({file:source,sourceLabel:`作品《${p.title}》${b.kind} ${b.key}`,dir:path.join(projectDir(p.id),'.制作记录',`素材分析-${Date.now()}`),...selected});return send(res,{proposal:saveAssetProposal(proposal)});}
    if(url.pathname==='/api/assets/apply'&&req.method==='POST'){const b=await body(req);const result=applyAssetProposal({proposalId:b.proposalId,applyWorld:b.applyWorld===true,applyWorkflow:b.applyWorkflow===true});return send(res,{...result,assets:listAssets()});}
    if(url.pathname==='/api/documents/suggest'&&req.method==='POST'){const b=await body(req),selected=chooseModel(await account(),b.model,b.reasoningEffort);return send(res,await suggestDocument({docPath:b.docPath,note:b.note,dir:path.join(APP,'.文档提案',`${Date.now()}`),...selected}));}
    if(url.pathname==='/api/documents/save'&&req.method==='POST'){const result=saveDocument(await body(req));return send(res,{...result,documents:listDocuments()});}
    const archiveDelete=/^\/api\/archive\/([A-Za-z0-9_-]+)\/delete$/.exec(url.pathname);if(archiveDelete&&req.method==='POST'){const b=await body(req);deleteArchiveStory(archiveDelete[1],b.confirmTitle);return send(res,{ok:true,archiveStories:discoverArchiveStories()});}
    const match=/^\/api\/projects\/([a-f0-9-]{36})(?:\/([a-z-]+))?$/.exec(url.pathname);
    if(match){
      const p=readProject(match[1]);const action=match[2];if(req.method==='GET'&&!action)return send(res,publicProject(p));
      if(req.method!=='POST'||!action)return send(res,{error:'操作不存在'},404);
      const b=await body(req);
      if(action==='pause'){active.get(p.id)?.abort();return send(res,{ok:true});}
      if(action==='title'){
        const title=String(b.title||'').trim().replace(/\s+/g,' ');
        if(!title||[...title].length>60)throw new Error('作品名称请控制在 1—60 个字以内。');
        p.title=title;p.titleLocked=true;syncRunningProject(p.id,{title,titleLocked:true});saveProject(p);return send(res,publicProject(p));
      }
      if(active.has(p.id))throw new Error('这篇仍在制作，请稍候。');
      if(action==='revise-plan')planProject(p,b.note);
      else if(action==='approve-plan')approvePlan(p,b.hash);
      else if(action==='approve-samples')approveSamples(p,b.hash);
      else if(action==='resume')resume(p);
      else if(action==='revise-image')reviseImage(p,b.key,b.note);
      else if(action==='recover-image')recoverImage(p);
      else if(action==='retry-missing'){
        if(b.confirmNoImage!==true||!p.pending)throw new Error('请先确认没有生成图片。');
        p.revisionNotes.push({key:'recovery',note:'用户确认未收到上次图片，允许重新尝试',at:new Date().toISOString()});p.pending=null;p.lastFailure=null;saveProject(p);resume(p);
      }
      else if(action==='accept')await accept(p,b.checks);
      else if(action==='settings'){
        if(p.status==='complete')throw new Error('已完成作品不需要切换制作模型。');
        const selected=chooseModel(await account(true),b.model,b.reasoningEffort),before={model:p.brief.model||null,reasoningEffort:p.brief.reasoningEffort||null};
        p.brief.model=selected.model;p.brief.reasoningEffort=selected.reasoningEffort;syncRunningProject(p.id,{brief:{...p.brief}});p.modelHistory=p.modelHistory||[];
        p.modelHistory.push({from:before,to:selected,at:new Date().toISOString(),status:p.status,version:p.version});
        p.message=`后续步骤将使用 ${selected.model} · ${selected.reasoningEffort} 思考；已有方案和图片保持不变。`;saveProject(p);
      }
      else if(action==='delete'){
        if(!p.accepted||p.status!=='complete')throw new Error('只有已完成作品可以删除。');deleteProjectFolder(projectDir(p.id),p.title,b.confirmTitle);return send(res,{ok:true});
      }
      else if(action==='open-folder'){
        const folder=p.accepted?path.join(projectDir(p.id),`v${p.version}`,'成品'):projectDir(p.id);
        await new Promise((resolve,reject)=>execFile('/usr/bin/open',[folder],err=>err?reject(new Error('无法打开文件夹，请使用页面上的本地路径。')):resolve()));
      }
      else return send(res,{error:'操作不存在'},404);
      return send(res,publicProject(p));
    }
    if(url.pathname.startsWith('/media/reference/')){
      const ref=decodeURIComponent(url.pathname.slice('/media/reference/'.length));
      if(!listAssets().some(x=>x.file===ref&&!x.file.startsWith('02-')))return send(res,{error:'参考不可用'},404);
      return file(res,inside(REFS,ref));
    }
    if(url.pathname.startsWith('/media/asset/')){
      const ref=decodeURIComponent(url.pathname.slice('/media/asset/'.length));
      if(!listAssets().some(x=>x.file===ref))return send(res,{error:'素材不可用'},404);
      return file(res,inside(REFS,ref));
    }
    const archiveMedia=/^\/media\/archive-story\/([A-Za-z0-9_-]+)\/(\d+)$/.exec(url.pathname);if(archiveMedia){const story=archiveStory(archiveMedia[1]),index=Number(archiveMedia[2]);if(!story||!story.pages[index])return send(res,{error:'图片不存在'},404);return file(res,inside(path.join(ROOT,story.folder),story.pages[index]));}
    const media=/^\/media\/project\/([a-f0-9-]{36})\/(.+)$/.exec(url.pathname);
    if(media){const p=readProject(media[1]);const name=decodeURIComponent(media[2]);if(!allowedProjectFiles(p).has(name))return send(res,{error:'图片尚未就绪'},404);return file(res,inside(projectDir(p.id),name),url.searchParams.has('download'));}
    if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/'))return send(res,{error:'内容不存在'},404);
    const filename=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
    const target=inside(front,filename);if(!fs.existsSync(target))return send(res,{error:'页面不存在'},404);return file(res,target);
  }catch(e){if(!res.headersSent)send(res,{error:e.message||'操作未完成'},400);else res.end();}
});
server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'创作室端口已被使用，请打开已有页面。':err.message);process.exit(1);});
server.listen(PORT,HOST,()=>console.log(`温蒂创作室：http://${HOST}:${PORT}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{for(const c of active.values())c.abort();server.close();setTimeout(()=>process.exit(0),2000).unref();});
