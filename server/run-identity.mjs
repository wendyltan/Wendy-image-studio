import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable identity is shared by the engine, the web provider, and the small
 * manifest patcher used by the browser worker.  Keep this module read-only:
 * callers can inspect and compare a run, but only run-manifest.mjs may write
 * the manifest.
 */
export const RUN_IDENTITY_FIELDS=Object.freeze([
  'projectId',
  'projectVersion',
  'taskId',
  'target',
  'requestId',
  'runId',
  'outputFile',
]);
export const RUN_LOCKED_FIELDS=Object.freeze([...RUN_IDENTITY_FIELDS]);

const JSON_SUFFIX_ESCAPE=/\\n\s*$/;

function isObject(value){return Boolean(value&&typeof value==='object'&&!Array.isArray(value));}

/** Parse one durable JSON record without accepting the old "literal \\n" tail. */
export function parseJsonObject(text,file='<json>'){
  if(typeof text!=='string')throw new Error(`${file} 不是文本 JSON。`);
  const source=text.replace(/^\uFEFF/,'');
  if(JSON_SUFFIX_ESCAPE.test(source.trimEnd()))throw new Error(`${file} 包含非法的字面量反斜杠换行。`);
  let value;
  try{value=JSON.parse(source);}catch(error){throw new Error(`${file} 不是合法 JSON：${error.message}`);}
  if(!isObject(value))throw new Error(`${file} 必须是 JSON 对象。`);
  return value;
}

/** Best-effort read for legacy records.  Parse errors are returned to callers. */
export function readJsonObject(file,{strict=false}={}){
  try{return parseJsonObject(fs.readFileSync(file,'utf8'),file);}
  catch(error){if(strict)throw error;return null;}
}

function normalizeKey(key,value){
  if(value===undefined||value===null||value==='')return null;
  return key==='projectVersion'&&Number.isFinite(Number(value))?Number(value):String(value);
}

export function sameIdentityValue(left,right,key){
  const a=normalizeKey(key,left),b=normalizeKey(key,right);
  if(a===null||b===null)return true;
  return a===b;
}

export function identityFields(value){
  if(!isObject(value))return {};
  const fields={};
  for(const key of ['projectId','projectVersion','taskId','target']){
    if(value[key]!==undefined&&value[key]!==null&&value[key]!=='')fields[key]=value[key];
  }
  return fields;
}

function resolveOutput(projectRoot,value){
  if(value===undefined||value===null||value==='')return null;
  return path.resolve(projectRoot,String(value));
}

function fileRecord(dir,name,{strict=false}={}){
  const file=path.join(dir,name);
  if(!fs.existsSync(file))return {file,value:null,error:null};
  try{return {file,value:parseJsonObject(fs.readFileSync(file,'utf8'),file),error:null};}
  catch(error){if(strict)throw error;return {file,value:null,error};}
}

/** Read all run records once so every caller compares the same snapshot. */
export function readRunIdentity(dir,{strict=false}={}){
  const runDir=path.resolve(String(dir||''));
  if(!runDir||runDir===path.parse(runDir).root)throw new Error('缺少有效的执行目录。');
  const projectRoot=path.resolve(runDir,'..','..');
  const request=fileRecord(runDir,'request.json',{strict});
  const worker=fileRecord(runDir,'worker-request.json',{strict});
  const manifest=fileRecord(runDir,'web-generation.json',{strict});
  const execution=fileRecord(runDir,'execution.json',{strict});
  const lock=fileRecord(runDir,'run-identity.json',{strict:false});
  const runId=path.basename(runDir);
  const expectedOutput=resolveOutput(projectRoot,request.value?.expectedOutput);
  const workerOutput=resolveOutput(projectRoot,worker.value?.outputFile);
  const manifestOutput=resolveOutput(projectRoot,manifest.value?.outputFile||manifest.value?.artifactPath);
  return {
    dir:runDir,
    projectRoot,
    runId,
    request:request.value,
    worker:worker.value,
    manifest:manifest.value,
    execution:execution.value,
    lock:lock.value,
    files:{request:request.file,worker:worker.file,manifest:manifest.file,execution:execution.file,lock:lock.file},
    expectedOutput,
    workerOutput,
    manifestOutput,
    parseErrors:Object.fromEntries([request,worker,manifest,execution,lock].filter(item=>item.error).map(item=>[path.basename(item.file),item.error.message])),
  };
}

function sourceValue(record,source,key){
  if(source==='request'&&key==='outputFile')return record.expectedOutput;
  if(source==='worker'&&key==='outputFile')return record.workerOutput;
  if(source==='manifest'&&key==='outputFile')return record.manifestOutput;
  if(source==='execution'&&key==='outputFile')return null;
  return record[source]?.[key];
}

function sourcePresent(record,source,key){
  if(key==='outputFile')return sourceValue(record,source,key)!==null;
  return sourceValue(record,source,key)!==undefined&&sourceValue(record,source,key)!==null&&sourceValue(record,source,key)!=='';
}

function strictModern(record){
  const values=[record.request,record.worker,record.manifest,record.lock].filter(isObject);
  return values.some(value=>Number(value.identitySchemaVersion)>=2||value.identityLocked===true)
    || Boolean(record.lock)
    || Boolean(record.request?.runId&&record.request?.requestId&&record.worker?.runId&&record.worker?.outputFile);
}

/**
 * Compare every identity value that is present.  Missing fields remain
 * compatible for pre-identity-lock legacy records; newly-created runs carry
 * identitySchemaVersion=2 and therefore require all modern fields.
 */
export function compareRunIdentity({record,expected={},requireModern=null}={}){
  if(!record||typeof record!=='object')return {ok:false,modern:true,issues:['缺少执行记录。'],identity:{}};
  const modern=requireModern===null?strictModern(record):Boolean(requireModern);
  const sources=['request','worker','manifest','execution','lock'];
  const issues=[];
  const wanted={...expected};
  if(wanted.runId===undefined)wanted.runId=record.runId;
  if(wanted.outputFile===undefined)wanted.outputFile=record.expectedOutput||record.workerOutput||record.manifestOutput||null;
  if(wanted.requestId===undefined)wanted.requestId=record.manifest?.requestId||record.worker?.requestId||record.request?.requestId||null;
  for(const key of RUN_IDENTITY_FIELDS){
    const expectedValue=wanted[key];
    if(expectedValue!==undefined&&expectedValue!==null&&expectedValue!==''){
      for(const source of sources){
        if(sourcePresent(record,source,key)&&!sameIdentityValue(expectedValue,sourceValue(record,source,key),key))issues.push(`${source}.${key} 不匹配`);
      }
    }
    const present=sources.filter(source=>sourcePresent(record,source,key));
    for(let i=1;i<present.length;i++){
      const before=present[0],current=present[i];
      if(!sameIdentityValue(sourceValue(record,before,key),sourceValue(record,current,key),key))issues.push(`${before}.${key} 与 ${current}.${key} 不匹配`);
    }
  }
  if(modern){
    const required=[
      ['request','projectId'],['request','projectVersion'],['request','taskId'],['request','target'],['request','requestId'],['request','runId'],['request','outputFile'],
      ['worker','projectId'],['worker','projectVersion'],['worker','taskId'],['worker','target'],['worker','requestId'],['worker','runId'],['worker','outputFile'],
      ['manifest','projectId'],['manifest','projectVersion'],['manifest','taskId'],['manifest','target'],['manifest','requestId'],['manifest','runId'],['manifest','outputFile'],
      ['execution','runId'],
    ];
    for(const [source,key] of required){
      // Standalone provider fixtures and very old records legitimately have no
      // project binding at all.  Once any project field exists, however, the
      // modern record must carry it in every identity-bearing source.
      const projectField=['projectId','projectVersion','taskId','target'].includes(key);
      if(projectField&&!sources.some(item=>sourcePresent(record,item,key)))continue;
      if(!sourcePresent(record,source,key))issues.push(`${source}.${key} 缺失`);
    }
  }
  const identity={};
  for(const key of RUN_IDENTITY_FIELDS){
    const value=wanted[key]??sources.map(source=>sourceValue(record,source,key)).find(item=>item!==null&&item!==undefined&&item!=='');
    if(value!==undefined&&value!==null&&value!=='')identity[key]=key==='outputFile'?path.resolve(String(value)):value;
  }
  return {ok:issues.length===0,modern,issues:[...new Set(issues)],identity};
}

export function assertRunIdentity(args){
  const record=args.record||readRunIdentity(args.dir,{strict:args.strict===true});
  const result=compareRunIdentity({...args,record});
  if(!result.ok){
    const error=new Error(`执行记录身份不一致：${result.issues.join('；')}`);
    error.code='REQUEST_IDENTITY_MISMATCH';error.identity=result;error.runRecord=record;throw error;
  }
  return {record,result};
}

/** Lightweight evidence reader shared by diagnostics and recovery code. */
export function readRunEvidence(dir,{strict=false}={}){
  const runDir=path.resolve(String(dir||'')),eventsFile=path.join(runDir,'events.jsonl'),responseFile=path.join(runDir,'response.txt');
  const responseText=fs.existsSync(responseFile)?fs.readFileSync(responseFile,'utf8'):'';
  const eventsText=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,'utf8'):'';
  const events=[],parseErrors=[];
  for(const line of eventsText.split('\n')){
    if(!line.trim())continue;
    try{events.push(JSON.parse(line));}catch(error){parseErrors.push(error.message);}
  }
  if(strict&&parseErrors.length)throw new Error(`${eventsFile} 含有非法事件 JSON。`);
  return {dir:runDir,responseText,eventsText,events,parseErrors,valid:parseErrors.length===0};
}
