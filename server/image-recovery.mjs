import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readRunIdentity,compareRunIdentity,readRunEvidence} from './run-identity.mjs';

function browserEvidence(durable){
  const text=durable.responseText,eventText=durable.eventsText;
  let browserText='',usage=null;
  for(const e of durable.events){
    if(e.type==='turn.completed'&&e.usage)usage=e.usage;
    const item=e?.item||e,server=String(item?.server||item?.serverName||'').toLowerCase(),tool=String(item?.tool||item?.name||'').toLowerCase();
    if(item?.type==='mcp_tool_call'&&(server==='cua_repl'||server.includes('browser')||tool==='browser')&&(!tool||tool==='js'||tool==='browser')){
      const content=Array.isArray(item.result?.content)?item.result.content:[];
      browserText+=content.filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n')+'\n';
    }
  }
  return {text,eventText,browserText,usage,parseErrors:durable.parseErrors};
}

function generatedCandidates(dir,after,{home=process.env.CODEX_HOME||path.join(process.env.HOME,'.codex')}={}){
  if(!dir)return [];
  const events=path.join(dir,'events.jsonl');
  if(!fs.existsSync(events))return null;
  let thread;
  for(const line of fs.readFileSync(events,'utf8').split('\n')){try{const event=JSON.parse(line);if(event.type==='thread.started')thread=event.thread_id;}catch{}}
  if(!thread||!/^[a-f0-9-]{36}$/.test(thread))return null;
  const folder=path.join(home,'generated_images',thread);
  if(!fs.existsSync(folder))return null;
  return fs.readdirSync(folder).filter(name=>/\.(png|webp|jpe?g)$/i.test(name)).map(name=>path.join(folder,name)).filter(file=>{
    try{return fs.statSync(file).isFile()&&fs.statSync(file).mtimeMs>=after-5000;}catch{return false;}
  }).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
}

function extensionForImage(info,file){
  const format=String(info?.format||'').toLowerCase();
  if(format==='jpeg')return '.jpg';
  if(['png','webp'].includes(format))return `.${format}`;
  const ext=path.extname(file).toLowerCase();
  return ['.png','.webp','.jpg','.jpeg'].includes(ext)?ext:null;
}

function checksum(file){
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Image files are verified through the existing local inspector. The caller
 * supplies pythonRun so this module remains independent of the engine.
 */
export function createImageRecovery({webImageProvider,readGenerationEvidence,generationDiagnosticSummary,readWebManifest,pythonRun,jsonWrite,projectDir,inside,saveProject,job,verifyApproval,finishTask,activity,invalidatePanelDownstream,recordArtifact,attachImageRecord,artifactIdForImageKey,panelKeyFromImageKey,sampleIndexFromKey,sampleRepairCount,definiteImageFailure,failureMessage}={}){
  const required={readGenerationEvidence,generationDiagnosticSummary,readWebManifest,pythonRun,jsonWrite,projectDir,inside};
  for(const [key,value] of Object.entries(required))if(typeof value!=='function')throw new TypeError(`image recovery requires ${key}`);

  async function verifyImage(file){
    const info=JSON.parse(await pythonRun(['info',file])),extension=extensionForImage(info,file);
    if(!extension)throw new Error('已找到的文件不是可用的 PNG、JPG 或 WebP 图片。');
    return {...info,extension,sizeBytes:fs.statSync(file).size,sha256:checksum(file)};
  }

  function matchingWebRunRecord(pending){
    if(!pending?.dir)return null;
    try{
      const dir=path.resolve(pending.dir),record=readRunIdentity(dir),{request,worker,execution}=record,manifest=readWebManifest(path.join(dir,'web-generation.json'));
      if(Object.keys(record.parseErrors||{}).length||!request||!worker||!manifest)return null;
      if(request.provider!==webImageProvider||worker.provider!==webImageProvider||manifest.provider!==webImageProvider||!manifest.requestId||worker.requestId!==manifest.requestId)return null;
      const expected={projectId:pending.projectId??request.projectId,projectVersion:pending.projectVersion??request.projectVersion,taskId:pending.taskId??request.taskId,target:pending.key??request.target,requestId:manifest.requestId,runId:record.runId};
      const outputFile=pending.file||worker.outputFile||record.expectedOutput;
      if(outputFile)expected.outputFile=path.resolve(String(outputFile));
      const comparison=compareRunIdentity({record,expected});
      if(!comparison.ok)return null;
      if(worker.manifestFile&&path.resolve(worker.manifestFile)!==path.join(dir,'web-generation.json'))return null;
      return {dir,request,worker,manifest,execution,runId:record.runId,identity:comparison};
    }catch{return null;}
  }

  function matchingManifest(pending){return matchingWebRunRecord(pending)?.manifest||null;}

  /**
   * Read-only evidence gate. It never attaches, retries, or changes a
   * project; only an explicit recovery action may adopt its returned file.
   */
  async function inspectOrphanImageEvidence({dir,file=null,expected={}}={}){
    const reasons=[];let record=null,integrity=null;
    try{record=readRunIdentity(dir,{strict:true});}
    catch(error){return {status:'not_recoverable',reasons:[error.message],requiresUserAction:true,canAutoAdopt:false};}
    if(Object.keys(record.parseErrors||{}).length)reasons.push('执行记录含有非法 JSON。');
    const {request,worker,manifest,execution}=record;
    if(!request||!worker||!manifest||!execution)reasons.push('request、worker、manifest 或 execution 记录不完整。');
    const output=record.expectedOutput,target=file?path.resolve(String(file)):output;
    if(!output||!target||target!==output)reasons.push('候选原图路径与 expectedOutput 不一致。');
    if(target&&!fs.existsSync(target))reasons.push('expectedOutput 文件不存在。');
    else if(target&&!fs.statSync(target).isFile())reasons.push('expectedOutput 不是普通文件。');
    if(request?.provider!==undefined&&request.provider!==webImageProvider)reasons.push('request provider 不匹配。');
    if(worker?.provider!==webImageProvider||manifest?.provider!==webImageProvider)reasons.push('网页执行器 provider 不匹配。');
    const expectedIdentity={projectId:expected.projectId??request?.projectId,projectVersion:expected.projectVersion??request?.projectVersion,taskId:expected.taskId??request?.taskId,target:expected.target??request?.target,requestId:expected.requestId??manifest?.requestId,runId:record.runId,outputFile:output};
    const comparison=compareRunIdentity({record,expected:expectedIdentity,requireModern:false});
    if(!comparison.ok)reasons.push(...comparison.issues);
    if(!request?.requestId||String(request.requestId)!==String(manifest?.requestId||''))reasons.push('request.requestId 缺失或不匹配。');
    if(!request?.runId||String(request.runId)!==record.runId)reasons.push('request.runId 缺失或不匹配。');
    if(!worker?.runId||String(worker.runId)!==record.runId)reasons.push('worker.runId 缺失或不匹配。');
    if(!worker?.outputFile||path.resolve(String(worker.outputFile))!==output)reasons.push('worker.outputFile 缺失或不匹配。');
    if(!execution?.runId||String(execution.runId)!==record.runId)reasons.push('execution.runId 缺失或不匹配。');
    if(!request?.expectedOutput)reasons.push('request.expectedOutput 缺失。');
    if(!worker?.requestId||!manifest?.requestId||worker.requestId!==manifest.requestId)reasons.push('requestId 缺失或不一致。');
    if(manifest?.state!=='downloaded'||manifest?.submitted!==true)reasons.push('manifest 没有已提交且已下载的正向证据。');
    if(manifest?.artifactPath&&path.resolve(String(manifest.artifactPath))!==output)reasons.push('manifest.artifactPath 与 expectedOutput 不匹配。');
    if(!reasons.length){try{integrity=await verifyImage(target);}catch(error){reasons.push(`原图无法解码：${error.message}`);}}
    if(integrity&&expected.sha256&&integrity.sha256!==expected.sha256)reasons.push('原图 SHA-256 与用户指定值不匹配。');
    if(reasons.length)return {status:'not_recoverable',reasons:[...new Set(reasons)],requiresUserAction:true,canAutoAdopt:false,identity:comparison.identity,file:target||null};
    return {status:'recoverable_orphan',requiresUserAction:true,canAutoAdopt:false,file:target,integrity,identity:comparison.identity,manifestState:manifest.state,requestId:manifest.requestId};
  }

  async function persistImage(source,target){
    if(!fs.existsSync(source))return null;
    const temp=`${target}.partial-${crypto.randomUUID()}`;fs.copyFileSync(source,temp);
    try{
      const integrity=await verifyImage(temp),finalFile=target.replace(/\.[^.]+$/,integrity.extension);
      fs.renameSync(temp,finalFile);if(source===target&&finalFile!==target)fs.unlinkSync(target);
      return {file:finalFile,integrity};
    }catch(error){try{fs.unlinkSync(temp);}catch{}throw error;}
  }

  function writeRunResult(dir,result){if(dir)jsonWrite(path.join(dir,'result.json'),result);}

  function runEvidence(dir){
    const durable=browserEvidence(readRunEvidence(dir||''));
    return durable;
  }

  function attributableCandidates(pending){
    const evidence=readGenerationEvidence(pending.dir||''),inputs=new Set((pending.inputFiles||[]).map(file=>path.resolve(file)));
    if(pending.provider===webImageProvider){
      if(process.env.WENDI_TEST_PLAN_FILE&&fs.existsSync(pending.file))return {evidence,candidates:[path.resolve(pending.file)]};
      const manifest=matchingManifest(pending),artifact=path.resolve(String(manifest?.artifactPath||'')),target=path.resolve(pending.file);
      const proven=manifest?.state==='downloaded'&&manifest.accepted===true&&manifest.submitted===true&&artifact===target&&fs.existsSync(target);
      return {evidence,candidates:proven?[target]:[]};
    }
    const target=fs.existsSync(pending.file)?[pending.file]:[];
    const reported=(evidence.imagePaths||[]).filter(file=>path.isAbsolute(file)&&fs.existsSync(file));
    const legacy=generatedCandidates(pending.dir,Date.parse(pending.at))||[];
    const candidates=[...new Set([...target,...reported,...legacy].map(file=>path.resolve(file)).filter(file=>!inputs.has(file)))];
    return {evidence,candidates};
  }

  function assertCurrentPending(p,pending){
    let request={};try{request=JSON.parse(fs.readFileSync(path.join(pending.dir||'','request.json'),'utf8'));}catch{}
    const projectId=pending.projectId||request.projectId||null,version=Number(pending.projectVersion??request.projectVersion);
    if(!Number.isInteger(version))throw new Error('待恢复任务缺少可信的方案版本归属，请人工处理；原图和记录已保留。');
    if(projectId&&projectId!==p.id)throw new Error('待恢复任务不属于当前作品，原图和记录已保留，请人工处理。');
    if(!projectId){const root=path.resolve(projectDir(p.id)),dir=path.resolve(pending.dir||'');if(!dir.startsWith(root+path.sep))throw new Error('待恢复任务缺少可信的作品归属，请人工处理；原图和记录已保留。');}
    if(version!==Number(p.version))throw new Error(`待恢复任务属于方案 v${version}，当前是方案 v${p.version}；原图和记录已保留，请先查看历史方案。`);
  }

  function recoverImage(p){
    verifyApproval(p);if(!p.pending)throw new Error('没有待找回的图片');
    return job(p,'revising',async()=>{
      const pending=p.pending;assertCurrentPending(p,pending);const webManifest=pending.provider===webImageProvider?matchingManifest(pending):null;
      const recoveryIdentity={projectId:p.id,projectVersion:p.version,target:pending.key,...(webManifest?{requestId:webManifest.requestId||null,acceptanceState:webManifest.state,accepted:webManifest.accepted===true,acceptedAt:webManifest.acceptedAt||null,submitted:webManifest.submitted===true,submittedAt:webManifest.submittedAt||null}: {})};
      let file=pending.file;const {evidence,candidates}=attributableCandidates(pending);let persisted=null,orphanEvidence=null;
      if(pending.provider===webImageProvider&&webManifest?.state==='downloaded'){
        orphanEvidence=await inspectOrphanImageEvidence({dir:pending.dir,file,expected:{projectId:p.id,projectVersion:p.version,taskId:pending.taskId,target:pending.key,requestId:webManifest.requestId}});
        if(orphanEvidence.status!=='recoverable_orphan'){
          writeRunResult(pending.dir,{schemaVersion:2,provider:webImageProvider,taskId:pending.taskId||null,endedAt:new Date().toISOString(),outcome:'artifact_still_unknown',...recoveryIdentity,evidenceStatus:orphanEvidence.status,reasons:orphanEvidence.reasons||[],diagnostics:generationDiagnosticSummary(evidence)});
          throw new Error(`已保存文件未通过本次 request、执行器、下载结果和完整性核验，原图与记录已保留；不会自动采用或重生。${(orphanEvidence.reasons||[]).slice(0,3).join('；')}`);
        }
      }
      if(orphanEvidence?.status==='recoverable_orphan')persisted=await persistImage(orphanEvidence.file,file);
      else if(candidates.length===1)persisted=await persistImage(candidates[0],file);
      if(!persisted){
        writeRunResult(pending.dir,{schemaVersion:2,provider:pending.provider||'legacy',taskId:pending.taskId||null,endedAt:new Date().toISOString(),outcome:'artifact_still_unknown',...recoveryIdentity,diagnostics:generationDiagnosticSummary(evidence),candidateCount:candidates.length,candidateNames:candidates.map(candidate=>path.basename(candidate))});
        const known=definiteImageFailure(pending);
        if(known){p.pending=null;p.lastFailure=known;const task=(p.tasks||[]).find(item=>item.id===pending.taskId);finishTask(p,task,'failed_no_output',{errorCode:known.kind,webState:webManifest?.state||task?.webState||null});saveProject(p);throw new Error(failureMessage(known));}
        throw new Error('连接在保存结果前中断，系统仍无法确认是否已经生成。稍后可再次检查已有原图；检查本身不会重新生图。');
      }
      file=persisted.file;pending.file=file;
      writeRunResult(pending.dir,{schemaVersion:2,provider:pending.provider||'legacy',taskId:pending.taskId||null,endedAt:new Date().toISOString(),outcome:'artifact_recovered',...recoveryIdentity,artifact:path.relative(projectDir(p.id),file),integrity:persisted.integrity,diagnostics:generationDiagnosticSummary(evidence)});
      const record={key:pending.key,file:path.relative(projectDir(p.id),file),provider:pending.provider||'legacy',prompt:pending.prompt,refs:pending.refs,integrity:persisted.integrity,qa:{pass:null,status:'recovered_pending_review',summary:'原图已找回，尚未自动校对。请查看图片后选择继续或修改。',issues:[],repairPrompt:''},at:new Date().toISOString()};
      jsonWrite(file+'.json',record);const recoveredPanelKey=panelKeyFromImageKey?.(pending.key);if(recoveredPanelKey&&invalidatePanelDownstream)invalidatePanelDownstream(p,recoveredPanelKey);
      recordArtifact(p,artifactIdForImageKey(pending.key),'image',record.file,[],{integrity:persisted.integrity});attachImageRecord(p,record);
      const sampleIndex=sampleIndexFromKey(pending.key);if(sampleIndex!==null)sampleRepairCount(p,sampleIndex);
      p.pending=null;p.lastFailure=null;p.status='paused';const task=(p.tasks||[]).find(item=>item.id===pending.taskId);finishTask(p,task,'recovered_local',{artifact:file,qa:'not_run'});activity(p,'原图已找回并挂接到作品。未重新生图，也没有再次自动校对。');
    });
  }

  return Object.freeze({checksum,verifyImage,matchingWebRunRecord,matchingPendingManifest:matchingManifest,inspectOrphanImageEvidence,persistImage,writeRunResult,runEvidence,attributableCandidates,assertCurrentPending,recoverImage});
}

export {generatedCandidates,extensionForImage,checksum};
