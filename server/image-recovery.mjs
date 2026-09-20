import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJsonObject,readRunIdentity,compareRunIdentity,readRunEvidence} from './run-identity.mjs';
import {appendDownloadEvidenceTrace,enrichDownloadEvidenceIdentity,inspectDownloadArtifact,readDownloadEvidence,validateDownloadEvidence,writeDownloadEvidence} from './web-download-evidence.mjs';

function iso(value){const parsed=Date.parse(String(value||''));return Number.isFinite(parsed)?new Date(parsed).toISOString():null;}
function latestIso(values=[]){const times=values.map(iso).filter(Boolean).map(value=>Date.parse(value));return times.length?new Date(Math.max(...times)).toISOString():null;}

export function recoveryTimeline({executionEndedAt=null,priorResult=null,priorTask=null,downloadEvidence=null,downloadedAt=null,recoveryCompletedAt=null,now=Date.now()}={}){
  const generationCompletedAt=iso(priorResult?.generationCompletedAt)||iso(executionEndedAt)||iso(priorTask?.generationCompletedAt)||iso(priorResult?.priorCompletedAt)||iso(priorResult?.endedAt)||iso(priorTask?.completedAt);
  const priorCompletedAt=iso(priorResult?.priorCompletedAt)||iso(priorResult?.endedAt)||iso(priorTask?.priorCompletedAt)||iso(priorTask?.completedAt)||generationCompletedAt;
  const requested=iso(recoveryCompletedAt)||new Date(Number.isFinite(Number(now))?Number(now):Date.now()).toISOString();
  const recovery=latestIso([requested,downloadEvidence?.capturedAt,downloadedAt])||requested;
  return {generationCompletedAt,priorCompletedAt,recoveryCompletedAt:recovery,downloadedAt:iso(downloadedAt),capturedAt:iso(downloadEvidence?.capturedAt)};
}

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

function copyTree(source,target,{immutable=false}={}){
  const stat=fs.lstatSync(source);
  if(stat.isSymbolicLink())throw new Error(`拒绝复制符号链接：${source}`);
  if(stat.isDirectory()){
    fs.mkdirSync(target,{recursive:true});
    for(const name of fs.readdirSync(source))copyTree(path.join(source,name),path.join(target,name),{immutable});
    if(immutable)try{fs.chmodSync(target,0o555);}catch{}
    return;
  }
  if(!stat.isFile())throw new Error(`执行证据包含不可复制的文件类型：${source}`);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(source,target);
  if(immutable)try{fs.chmodSync(target,0o444);}catch{}
}

function rewriteImportedPaths(value,{sourceProjectRoot,sourceRunDir,sourceOutput,targetProjectRoot,targetRunDir,targetOutput}={}){
  if(Array.isArray(value))return value.map(item=>rewriteImportedPaths(item,{sourceProjectRoot,sourceRunDir,sourceOutput,targetProjectRoot,targetRunDir,targetOutput}));
  if(value&&typeof value==='object'){
    const result={};
    for(const [key,item] of Object.entries(value))result[key]=rewriteImportedPaths(item,{sourceProjectRoot,sourceRunDir,sourceOutput,targetProjectRoot,targetRunDir,targetOutput});
    return result;
  }
  if(typeof value!=='string')return value;
  const absolute=path.isAbsolute(value)?path.resolve(value):null;
  if(absolute===path.resolve(sourceOutput))return targetOutput;
  if(absolute&&absolute.startsWith(path.resolve(sourceRunDir)+path.sep))return path.join(targetRunDir,path.relative(sourceRunDir,absolute));
  if(absolute&&absolute.startsWith(path.resolve(sourceProjectRoot)+path.sep))return path.join(targetProjectRoot,path.relative(sourceProjectRoot,absolute));
  return value;
}

/**
 * Image files are verified through the existing local inspector. The caller
 * supplies pythonRun so this module remains independent of the engine.
 */
export function createImageRecovery({webImageProvider,readGenerationEvidence,generationDiagnosticSummary,readWebManifest,pythonRun,jsonWrite,projectDir,inside,saveProject,job,verifyApproval,finishTask,activity,invalidatePanelDownstream,recordArtifact,attachImageRecord,artifactIdForImageKey,panelKeyFromImageKey,sampleIndexFromKey,sampleRepairCount,definiteImageFailure,failureMessage,hasActive=()=>false}={}){
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
      const pending=p.pending;assertCurrentPending(p,pending);const task=(p.tasks||[]).find(item=>item.id===pending.taskId),priorResult=pending.dir?readJsonObject(path.join(pending.dir,'result.json')):null,execution=pending.dir?readJsonObject(path.join(pending.dir,'execution.json')):null,webManifest=pending.provider===webImageProvider?matchingManifest(pending):null;
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
      const rawDownloadEvidence=pending.dir?readDownloadEvidence(pending.dir):null,downloadEvidence=rawDownloadEvidence?enrichDownloadEvidenceIdentity(rawDownloadEvidence,{projectId:p.id,projectVersion:p.version,taskId:pending.taskId,target:pending.key,requestId:webManifest?.requestId||rawDownloadEvidence.requestId,runId:path.basename(pending.dir),conversationUrl:webManifest?.conversationUrl||rawDownloadEvidence.conversationUrl,outputFile:file}):null;
      if(downloadEvidence&&JSON.stringify(downloadEvidence)!==JSON.stringify(rawDownloadEvidence)){
        writeDownloadEvidence(pending.dir,downloadEvidence);
        appendDownloadEvidenceTrace(pending.dir,downloadEvidence,{eventType:'download.evidence.metadata',metadataOnly:true});
      }
      const timeline=recoveryTimeline({executionEndedAt:execution?.endedAt,priorResult,priorTask:task,downloadEvidence,downloadedAt:webManifest?.downloadedAt});
      writeRunResult(pending.dir,{schemaVersion:2,provider:pending.provider||'legacy',taskId:pending.taskId||null,endedAt:timeline.recoveryCompletedAt,generationCompletedAt:timeline.generationCompletedAt,priorCompletedAt:timeline.priorCompletedAt,recoveryCompletedAt:timeline.recoveryCompletedAt,downloadedAt:timeline.downloadedAt,...recoveryIdentity,artifact:path.relative(projectDir(p.id),file),integrity:persisted.integrity,downloadEvidence,diagnostics:generationDiagnosticSummary(evidence)});
      const record={key:pending.key,file:path.relative(projectDir(p.id),file),provider:pending.provider||'legacy',prompt:pending.prompt,refs:pending.refs,integrity:persisted.integrity,downloadEvidence,generationCompletedAt:timeline.generationCompletedAt,recoveryCompletedAt:timeline.recoveryCompletedAt,qa:{pass:null,status:'manual_review',summary:'原图已找回，等待人工视觉校对。请查看图片后选择继续或修改。',issues:[],repairPrompt:'',source:'manual_review'},at:new Date().toISOString()};
      jsonWrite(file+'.json',record);const recoveredPanelKey=panelKeyFromImageKey?.(pending.key);if(recoveredPanelKey&&invalidatePanelDownstream)invalidatePanelDownstream(p,recoveredPanelKey);
      recordArtifact(p,artifactIdForImageKey(pending.key),'image',record.file,[],{integrity:persisted.integrity,downloadEvidence,generationCompletedAt:timeline.generationCompletedAt,recoveryCompletedAt:timeline.recoveryCompletedAt});attachImageRecord(p,record);
      const sampleIndex=sampleIndexFromKey(pending.key);if(sampleIndex!==null)sampleRepairCount(p,sampleIndex);
      p.pending=null;p.lastFailure=null;p.status='paused';const webTimings={...task?.webTimings,downloadedAt:timeline.downloadedAt,generationCompletedAt:timeline.generationCompletedAt,recoveryCompletedAt:timeline.recoveryCompletedAt};finishTask(p,task,'recovered_local',{completedAt:timeline.recoveryCompletedAt,generationCompletedAt:timeline.generationCompletedAt,priorCompletedAt:timeline.priorCompletedAt,recoveryCompletedAt:timeline.recoveryCompletedAt,artifact:file,qa:'manual_review',qaStatus:'manual_review',webState:webManifest?.state||'downloaded',webTimings,errorCode:null,error:null});activity(p,'原图已找回并挂接到作品，等待人工视觉校对。未重新生图。');
    });
  }

  /**
   * Adopt a completed run from an isolated production root without creating a
   * new request. The source run is archived byte-for-byte under
   * source-evidence; the small root projection is path-normalized to the
   * current project so the ordinary identity/evidence validators can inspect
   * it. This is intentionally explicit and rejects any existing target/task.
   */
  async function adoptRecoveredRun(p,{sourceDir,sourceFile,targetFile,target,expectedSha256=null}={}){
    verifyApproval(p);
    if(hasActive(p.id))throw new Error('当前作品仍有运行中的任务，不能采用外部原图。');
    if(p.pending)throw new Error('当前作品存在待确认任务，不能采用外部原图。');
    const key=String(target||'').trim(),panelKey=panelKeyFromImageKey?.(key);
    if(!panelKey)throw new Error('外部原图只支持采用为正式分镜。');
    const [pageNumber,panelNumber]=panelKey.split('-').map(Number),definition=p.plan?.pages?.[pageNumber-1]?.panels?.[panelNumber-1];
    if(!definition)throw new Error(`当前方案中不存在 ${key}，拒绝采用外部原图。`);
    if(p.panels?.[panelKey])throw new Error(`当前作品已经存在 ${key}，不会覆盖已有分镜。`);
    if((p.tasks||[]).some(item=>item?.target===key||item?.target===panelKey))throw new Error(`当前作品已经存在 ${key} 的制作任务，不会覆盖历史任务。`);
    if(!sourceDir||!sourceFile||!targetFile)throw new Error('外部原图采用缺少 sourceDir、sourceFile 或 targetFile。');

    const sourceRunDir=path.resolve(String(sourceDir)),sourceImage=path.resolve(String(sourceFile)),projectRoot=path.resolve(projectDir(p.id)),destination=path.isAbsolute(String(targetFile))?path.resolve(String(targetFile)):inside(projectRoot,String(targetFile));
    if(!destination.startsWith(projectRoot+path.sep))throw new Error('外部原图目标路径必须位于当前作品目录。');
    if(fs.existsSync(destination))throw new Error('外部原图目标文件已经存在，不会覆盖已有文件。');
    const requiredSourceFiles=['request.json','worker-request.json','web-generation.json','run-identity.json','execution.json','result.json','download-evidence.json','events.jsonl','prompt.txt'];
    for(const name of requiredSourceFiles)if(!fs.existsSync(path.join(sourceRunDir,name)))throw new Error(`外部执行记录缺少 ${name}。`);

    const source=readRunIdentity(sourceRunDir,{strict:true}),sourceRequest=source.request,sourceWorker=source.worker,sourceManifest=source.manifest,sourceExecution=source.execution,sourceResult=readJsonObject(path.join(sourceRunDir,'result.json'),{strict:true}),sourceEvidence=readDownloadEvidence(sourceRunDir),sourceProjectRoot=source.projectRoot,sourceOutput=source.expectedOutput;
    if(!sourceRequest||!sourceWorker||!sourceManifest||!sourceExecution||!sourceEvidence)throw new Error('外部执行记录不完整，拒绝采用。');
    if(sourceImage!==sourceOutput)throw new Error('外部原图路径与 request.expectedOutput 不一致。');
    if(sourceRequest.provider!==webImageProvider||sourceWorker.provider!==webImageProvider||sourceManifest.provider!==webImageProvider)throw new Error('外部执行记录 provider 不匹配。');
    const sourceExpected={projectId:p.id,projectVersion:p.version,taskId:sourceRequest.taskId,target:key,requestId:sourceManifest.requestId,runId:source.runId,outputFile:sourceImage};
    const sourceIdentity=compareRunIdentity({record:source,expected:sourceExpected,requireModern:true});
    if(!sourceIdentity.ok)throw new Error(`外部执行记录身份不一致：${sourceIdentity.issues.join('；')}`);
    if(sourceManifest.state!=='downloaded'||sourceManifest.accepted!==true||sourceManifest.submitted!==true)throw new Error('外部执行记录不是已提交且已下载的正向结果。');
    if(sourceManifest.requestId!==sourceRequest.requestId||sourceManifest.requestId!==sourceWorker.requestId)throw new Error('外部执行记录 requestId 不一致。');
    if(sourceResult.projectId!==p.id||Number(sourceResult.projectVersion)!==Number(p.version)||sourceResult.taskId!==sourceRequest.taskId||sourceResult.target!==key||sourceResult.requestId!==sourceManifest.requestId||sourceResult.runId!==source.runId)throw new Error('外部 result.json 与当前采用身份不一致。');
    const sourceIntegrity=await verifyImage(sourceImage);
    if(expectedSha256&&sourceIntegrity.sha256!==String(expectedSha256))throw new Error('外部原图 SHA-256 与指定值不一致。');
    const evidenceValidation=validateDownloadEvidence(sourceEvidence,{expectedIdentity:{...sourceExpected,conversationUrl:sourceManifest.conversationUrl},request:sourceRequest,worker:sourceWorker,result:sourceResult,manifest:sourceManifest,outputFile:sourceImage,actual:{...sourceIntegrity,path:sourceImage,bytes:sourceIntegrity.sizeBytes,format:String(sourceIntegrity.format||'').toUpperCase(),contentType:sourceIntegrity.contentType||`image/${String(sourceIntegrity.format||'').toLowerCase()}`},conversationUrl:sourceManifest.conversationUrl});
    if(!evidenceValidation.ok)throw new Error(`外部下载证据不一致：${evidenceValidation.errors.slice(0,5).join('；')}`);

    const targetRunDir=path.join(projectRoot,'.制作记录',source.runId);
    if(fs.existsSync(targetRunDir))throw new Error(`当前作品已有同名制作记录 ${source.runId}，不会覆盖。`);
    const importedAt=new Date().toISOString(),mapping={sourceProjectRoot,sourceRunDir,sourceOutput,targetProjectRoot:projectRoot,targetRunDir,targetOutput:destination};
    let persisted=null;
    try{
      fs.mkdirSync(targetRunDir,{recursive:true});
      copyTree(sourceRunDir,targetRunDir);
      copyTree(sourceRunDir,path.join(targetRunDir,'source-evidence'),{immutable:true});
      fs.mkdirSync(path.dirname(destination),{recursive:true});
      persisted=await persistImage(sourceImage,destination);
      if(!persisted||persisted.file!==destination)throw new Error('外部原图复制后的目标扩展名或路径不一致。');

      const readSourceJson=name=>readJsonObject(path.join(sourceRunDir,name),{strict:true});
      const normalizedRequest=rewriteImportedPaths(readSourceJson('request.json'),mapping);
      const normalizedWorker=rewriteImportedPaths(readSourceJson('worker-request.json'),mapping);
      const normalizedManifest=rewriteImportedPaths(readSourceJson('web-generation.json'),mapping);
      const normalizedLock=rewriteImportedPaths(readSourceJson('run-identity.json'),mapping);
      const normalizedExecution=rewriteImportedPaths(readSourceJson('execution.json'),mapping);
      const normalizedResult=rewriteImportedPaths(sourceResult,mapping);
      const normalizedEvidence=rewriteImportedPaths(sourceEvidence,mapping);
      const normalizedDownloadEvidence=enrichDownloadEvidenceIdentity(normalizedEvidence,{projectId:p.id,projectVersion:p.version,taskId:sourceRequest.taskId,target:key,requestId:sourceManifest.requestId,runId:source.runId,outputFile:destination});
      normalizedDownloadEvidence.output={...normalizedDownloadEvidence.output,path:destination,bytes:persisted.integrity.sizeBytes,format:String(persisted.integrity.format||'').toUpperCase(),width:persisted.integrity.width,height:persisted.integrity.height,sha256:persisted.integrity.sha256};
      normalizedRequest.projectId=p.id;normalizedRequest.projectVersion=p.version;normalizedRequest.taskId=sourceRequest.taskId;normalizedRequest.target=key;normalizedRequest.requestId=sourceManifest.requestId;normalizedRequest.runId=source.runId;normalizedRequest.expectedOutput=path.relative(projectRoot,destination);
      normalizedWorker.projectId=p.id;normalizedWorker.projectVersion=p.version;normalizedWorker.taskId=sourceRequest.taskId;normalizedWorker.target=key;normalizedWorker.requestId=sourceManifest.requestId;normalizedWorker.runId=source.runId;normalizedWorker.outputFile=destination;normalizedWorker.manifestFile=path.join(targetRunDir,'web-generation.json');
      normalizedManifest.projectId=p.id;normalizedManifest.projectVersion=p.version;normalizedManifest.taskId=sourceRequest.taskId;normalizedManifest.target=key;normalizedManifest.requestId=sourceManifest.requestId;normalizedManifest.runId=source.runId;normalizedManifest.outputFile=destination;normalizedManifest.artifactPath=destination;normalizedManifest.state='downloaded';normalizedManifest.accepted=true;normalizedManifest.submitted=true;normalizedManifest.error=null;normalizedManifest.errorCode=null;
      normalizedLock.projectId=p.id;normalizedLock.projectVersion=p.version;normalizedLock.taskId=sourceRequest.taskId;normalizedLock.target=key;normalizedLock.requestId=sourceManifest.requestId;normalizedLock.runId=source.runId;normalizedLock.outputFile=destination;normalizedLock.expectedOutput=destination;
      Object.assign(normalizedResult,{schemaVersion:2,provider:webImageProvider,projectId:p.id,projectVersion:p.version,taskId:sourceRequest.taskId,target:key,requestId:sourceManifest.requestId,runId:source.runId,acceptanceState:'downloaded',accepted:true,submitted:true,artifact:path.relative(projectRoot,destination),integrity:persisted.integrity,downloadEvidence:normalizedDownloadEvidence,sourceOutcome:sourceResult.outcome||null,outcome:'artifact_adopted_from_external_run',importedAt,recoveryCompletedAt:importedAt,endedAt:importedAt});
      for(const [name,value] of [['request.json',normalizedRequest],['worker-request.json',normalizedWorker],['web-generation.json',normalizedManifest],['run-identity.json',normalizedLock],['execution.json',normalizedExecution],['result.json',normalizedResult],['download-evidence.json',normalizedDownloadEvidence]])jsonWrite(path.join(targetRunDir,name),value);
      jsonWrite(path.join(targetRunDir,'import.json'),{schemaVersion:1,sourceTempPath:sourceRunDir,sourceOutputFile:sourceImage,sourceEvidencePath:path.join(targetRunDir,'source-evidence'),importedAt,targetProjectId:p.id,targetProjectVersion:p.version,targetTaskId:sourceRequest.taskId,target:key,targetRunDir,outputFile:destination,integrity:persisted.integrity});
      fs.appendFileSync(path.join(targetRunDir,'events.jsonl'),`${JSON.stringify({type:'recovery.imported',schemaVersion:1,metadataOnly:false,importedAt,sourceTempPath:sourceRunDir,sourceOutputFile:sourceImage,targetRunDir,outputFile:destination,projectId:p.id,projectVersion:p.version,taskId:sourceRequest.taskId,target:key,sha256:persisted.integrity.sha256})}\n`,{encoding:'utf8',mode:0o600});

      const imported=readRunIdentity(targetRunDir,{strict:true}),importedExpected={projectId:p.id,projectVersion:p.version,taskId:sourceRequest.taskId,target:key,requestId:sourceManifest.requestId,runId:source.runId,outputFile:destination},importedIdentity=compareRunIdentity({record:imported,expected:importedExpected,requireModern:true});
      if(!importedIdentity.ok)throw new Error(`采用后的执行记录身份不一致：${importedIdentity.issues.join('；')}`);
      const importedActual=inspectDownloadArtifact(destination),importedResult=readJsonObject(path.join(targetRunDir,'result.json'),{strict:true}),importedEvidence=readDownloadEvidence(targetRunDir),importedValidation=validateDownloadEvidence(importedEvidence,{expectedIdentity:{...importedExpected,conversationUrl:normalizedManifest.conversationUrl},request:imported.request,worker:imported.worker,result:importedResult,manifest:imported.manifest,outputFile:destination,actual:importedActual,conversationUrl:normalizedManifest.conversationUrl});
      if(!importedValidation.ok)throw new Error(`采用后的下载证据不一致：${importedValidation.errors.slice(0,5).join('；')}`);

      const relativeFile=path.relative(projectRoot,destination),remotePromptFile=path.join(sourceRunDir,'remote-prompt.txt'),prompt=fs.existsSync(remotePromptFile)?fs.readFileSync(remotePromptFile,'utf8').trim():fs.readFileSync(path.join(sourceRunDir,'prompt.txt'),'utf8').trim(),refs=Array.isArray(definition.references)?[...definition.references]:Array.isArray(sourceRequest.referenceNames)?[...sourceRequest.referenceNames]:[],record={key,file:relativeFile,provider:webImageProvider,conversationUrl:normalizedManifest.conversationUrl||null,prompt,basePrompt:prompt,revisionDelta:null,revisionBase:null,executor:{model:sourceWorker.executorModel||null,reasoningEffort:sourceWorker.executorReasoningEffort||null,role:sourceWorker.role||'browser-executor'},refs,telemetry:{promptSha256:sourceRequest.remotePromptSha256||sourceRequest.promptSha256||null,promptCharacters:Number(sourceRequest.remotePromptLength||sourceRequest.promptCharacters)||prompt.length,remotePromptSha256:sourceRequest.remotePromptSha256||null,remotePromptLength:Number(sourceRequest.remotePromptLength)||prompt.length,referenceAttachmentCount:Number(sourceRequest.referenceNames?.length)||refs.length,recordedAt:importedAt,source:'external-run-adoption'},integrity:persisted.integrity,downloadEvidence:importedEvidence,qa:{pass:null,status:'manual_review',summary:'原图已从已完成的隔离执行记录安全采用，等待人工视觉校对。',issues:[],repairPrompt:'',source:'external_run_adoption'},import:{sourceTempPath:sourceRunDir,sourceOutputFile:sourceImage,importedAt},at:importedAt};
      jsonWrite(`${destination}.json`,record);
      if(invalidatePanelDownstream)invalidatePanelDownstream(p,panelKey);
      recordArtifact(p,artifactIdForImageKey(key),'image',relativeFile,[],{integrity:persisted.integrity,downloadEvidence:importedEvidence,importedAt,sourceTempPath:sourceRunDir});
      attachImageRecord(p,record);
      const task={id:sourceRequest.taskId,kind:'image',target:key,status:'running',attempt:Number(sourceRequest.attempt)||1,startedAt:sourceManifest.createdAt||importedAt,lastProgressAt:importedAt,projectId:p.id,projectVersion:p.version,provider:webImageProvider,providerInvocations:1,requestId:sourceManifest.requestId,accepted:true,submitted:true,referenceCount:Number(sourceManifest.referenceCount)||refs.length,webState:'downloaded',webTimings:{createdAt:sourceManifest.createdAt||null,acceptedAt:sourceManifest.acceptedAt||null,readyAt:sourceManifest.readyAt||null,submittedAt:sourceManifest.submittedAt||null,downloadedAt:sourceManifest.downloadedAt||null,recoveryCompletedAt:importedAt,executorModel:sourceWorker.executorModel||null,executorReasoningEffort:sourceWorker.executorReasoningEffort||null,role:sourceWorker.role||'browser-executor'},artifact:destination,recoverySource:{sourceTempPath:sourceRunDir,sourceOutputFile:sourceImage,importedAt,sha256:persisted.integrity.sha256}};
      p.tasks=Array.isArray(p.tasks)?p.tasks:[];p.tasks.push(task);p.tasks=p.tasks.slice(-80);p.currentTask=task;p.pending=null;p.lastFailure=null;p.error=null;p.status='paused';p.message=`${key} 已安全采用已完成的隔离原图，等待人工视觉校对；未重新生图。`;p.recoveryImports=Array.isArray(p.recoveryImports)?p.recoveryImports:[];p.recoveryImports.push({sourceTempPath:sourceRunDir,sourceOutputFile:sourceImage,importedAt,targetRunDir,outputFile:destination,projectId:p.id,projectVersion:p.version,taskId:sourceRequest.taskId,target:key,sha256:persisted.integrity.sha256});p.recoveryImports=p.recoveryImports.slice(-40);
      finishTask(p,task,'recovered_local',{completedAt:importedAt,generationCompletedAt:sourceResult.generationCompletedAt||sourceExecution.endedAt||sourceManifest.submittedAt||null,priorCompletedAt:sourceResult.priorCompletedAt||sourceResult.endedAt||sourceManifest.submittedAt||null,recoveryCompletedAt:importedAt,artifact:destination,qa:'manual_review',qaStatus:'manual_review',webState:'downloaded',webTimings:task.webTimings,errorCode:null,error:null,recoverySource:task.recoverySource});
      return {project:p,runDir:targetRunDir,file:destination,record,task,manifest:imported.manifest,result:importedResult,downloadEvidence:importedEvidence,integrity:persisted.integrity,importedAt};
    }catch(error){
      try{if(fs.existsSync(targetRunDir))fs.rmSync(targetRunDir,{recursive:true,force:true});}catch{}
      try{if(fs.existsSync(destination))fs.unlinkSync(destination);}catch{}
      throw error;
    }
  }

  function syncRecoveredMetadata(p,{dir,target,taskId,requestId,file}={}){
    const runDir=path.resolve(String(dir||'')),projectRoot=path.resolve(projectDir(p.id));
    if(!runDir.startsWith(path.join(projectRoot,'.制作记录')+path.sep))throw new Error('恢复元数据目录不属于当前作品制作记录。');
    const task=(p.tasks||[]).find(item=>item.id===taskId),recordKey=String(target||task?.target||''),panelKey=panelKeyFromImageKey?.(recordKey),sampleIndex=sampleIndexFromKey(recordKey),record=sampleIndex!==null?p.samples?.[sampleIndex]:p.panels?.[panelKey];
    if(!task||p.currentTask?.id!==task.id||task.target!==recordKey)throw new Error('当前任务不是待同步的恢复任务。');
    if(!record?.file)throw new Error('当前作品缺少与恢复任务对应的图片记录。');
    const run=readRunIdentity(runDir,{strict:true}),manifest=readWebManifest(path.join(runDir,'web-generation.json')),expectedOutput=path.resolve(String(file||inside(projectRoot,record.file))),expected={projectId:p.id,projectVersion:p.version,taskId,target:recordKey,requestId:requestId||manifest?.requestId,runId:run.runId,outputFile:expectedOutput};
    const comparison=compareRunIdentity({record:run,expected,requireModern:true});
    if(!comparison.ok)throw new Error(`恢复元数据身份不一致：${comparison.issues.join('；')}`);
    if(!manifest||manifest.state!=='downloaded'||manifest.submitted!==true||manifest.requestId!==expected.requestId)throw new Error('恢复元数据只能同步已提交且已下载的同一 request。');
    if(path.resolve(String(record.file&&inside(projectRoot,record.file)))!==expectedOutput)throw new Error('作品记录与恢复输出路径不一致。');
    const artifactId=artifactIdForImageKey(recordKey),artifact=(p.artifacts||[]).find(item=>item.id===artifactId);
    if(!artifact||artifact.file!==record.file||artifact.valid===false)throw new Error('作品 artifact 与恢复图片记录不一致。');
    if(!fs.existsSync(expectedOutput)||!fs.statSync(expectedOutput).isFile())throw new Error('恢复输出文件不存在。');
    const actual=inspectDownloadArtifact(expectedOutput),rawEvidence=readDownloadEvidence(runDir),evidence=enrichDownloadEvidenceIdentity(rawEvidence,{projectId:p.id,projectVersion:p.version,taskId,target:recordKey,requestId:expected.requestId,runId:run.runId,conversationUrl:manifest.conversationUrl,outputFile:expectedOutput});
    const result=readJsonObject(path.join(runDir,'result.json')),validation=validateDownloadEvidence(evidence,{expectedIdentity:{...expected,conversationUrl:manifest.conversationUrl},request:run.request,worker:run.worker,result,manifest,outputFile:expectedOutput,actual});
    if(!validation.ok)throw new Error(`恢复下载证据不一致：${validation.errors.slice(0,5).join('；')}`);
    const timeline=recoveryTimeline({executionEndedAt:run.execution?.endedAt,priorResult:result,priorTask:task,downloadEvidence:evidence,downloadedAt:manifest.downloadedAt});
    if(JSON.stringify(evidence)!==JSON.stringify(rawEvidence)){writeDownloadEvidence(runDir,evidence);appendDownloadEvidenceTrace(runDir,evidence,{eventType:'download.evidence.metadata',metadataOnly:true});}
    jsonWrite(path.join(runDir,'result.json'),{...result,schemaVersion:2,provider:manifest.provider||webImageProvider,projectId:p.id,projectVersion:p.version,taskId,target:recordKey,requestId:expected.requestId,runId:run.runId,acceptanceState:manifest.state,accepted:manifest.accepted===true,submitted:manifest.submitted===true,submittedAt:manifest.submittedAt||null,downloadedAt:timeline.downloadedAt,endedAt:timeline.recoveryCompletedAt,generationCompletedAt:timeline.generationCompletedAt,priorCompletedAt:timeline.priorCompletedAt,recoveryCompletedAt:timeline.recoveryCompletedAt,downloadEvidence:evidence});
    record.downloadEvidence=evidence;record.generationCompletedAt=timeline.generationCompletedAt;record.recoveryCompletedAt=timeline.recoveryCompletedAt;artifact.downloadEvidence=evidence;artifact.generationCompletedAt=timeline.generationCompletedAt;artifact.recoveryCompletedAt=timeline.recoveryCompletedAt;
    p.pending=null;p.lastFailure=null;p.status='paused';p.error=null;const webTimings={...task.webTimings,downloadedAt:timeline.downloadedAt,generationCompletedAt:timeline.generationCompletedAt,recoveryCompletedAt:timeline.recoveryCompletedAt};finishTask(p,task,'recovered_local',{completedAt:timeline.recoveryCompletedAt,generationCompletedAt:timeline.generationCompletedAt,priorCompletedAt:timeline.priorCompletedAt,recoveryCompletedAt:timeline.recoveryCompletedAt,artifact:expectedOutput,qa:'manual_review',qaStatus:'manual_review',webState:'downloaded',webTimings,errorCode:null,error:null});saveProject(p);return p;
  }

  return Object.freeze({checksum,verifyImage,matchingWebRunRecord,matchingPendingManifest:matchingManifest,inspectOrphanImageEvidence,persistImage,writeRunResult,runEvidence,attributableCandidates,assertCurrentPending,recoverImage,adoptRecoveredRun,syncRecoveredMetadata});
}

export {generatedCandidates,extensionForImage,checksum};
