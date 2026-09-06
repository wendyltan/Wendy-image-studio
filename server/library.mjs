import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {APP,ROOT,DATA,REFS,jsonWrite,inside,digest} from './workflow.mjs';
import {runCodex,pythonRun} from './bridge.mjs';

export const CATEGORIES=[
  {id:'01-温蒂人设',group:'人物与服装',label:'温蒂人设'},
  {id:'02-小林人设',group:'人物与服装',label:'小林人设'},
  {id:'03-服装参考',group:'人物与服装',label:'服装参考'},
  {id:'04-住宅环境',group:'场景与物品',label:'住宅环境'},
  {id:'05-车辆',group:'场景与物品',label:'车辆'},
  {id:'06-汤圆',group:'场景与物品',label:'汤圆'},
  {id:'07-运动爱好',group:'场景与物品',label:'运动爱好'},
  {id:'08-咖啡与器具参考',group:'场景与物品',label:'咖啡与器具'},
];
export const DOCUMENTS=[
  {path:'设定/漫画世界观设定.md',group:'核心设定',label:'漫画世界观'},
  {path:'设定/温蒂日常小红书漫画工作指引.md',group:'创作流程',label:'漫画工作指引'},
  {path:'设定/网页生图技术附录.md',group:'创作流程',label:'生图技术附录'},
  {path:'设定/固有设定素材/00-素材索引.md',group:'素材管理',label:'固有素材索引'},
  {path:'设定/专题规则/机娘题材工作补充.md',group:'专题规则',label:'机娘专题补充'},
];
const CANDIDATES=path.join(APP,'.素材候选');
const PROPOSALS=path.join(CANDIDATES,'.提案');
const HISTORY=path.join(ROOT,'设定/.版本记录');
const ASSET_METADATA=path.join(REFS,'.素材元数据.json');
const ASSET_SCHEMA={type:'object',properties:{decision:{type:'string',enum:['keep','do_not_keep']},confidence:{type:'integer',minimum:0,maximum:100},reason:{type:'string'},category:{type:'string',enum:CATEGORIES.map(x=>x.id)},filename:{type:'string'},indexEntry:{type:'string'},worldSettingAddition:{type:'string'},workflowAddition:{type:'string'},warnings:{type:'array',items:{type:'string'}}},required:['decision','confidence','reason','category','filename','indexEntry','worldSettingAddition','workflowAddition','warnings'],additionalProperties:false};
const DOC_SCHEMA={type:'object',properties:{summary:{type:'string'},revisedText:{type:'string'},risks:{type:'array',items:{type:'string'}}},required:['summary','revisedText','risks'],additionalProperties:false};

function safeName(name,ext='png'){
  const base=String(name||'新素材').replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|\n\r]/g,'-').trim().slice(0,60)||'新素材';
  return `${base}.${ext.toLowerCase()==='jpeg'?'jpg':ext.toLowerCase()}`;
}
function fileHash(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function readAssetMetadata(){try{const value=JSON.parse(fs.readFileSync(ASSET_METADATA,'utf8'));return value&&typeof value==='object'?value:{};}catch{return {};}}
function writeAssetMetadata(value){fs.mkdirSync(path.dirname(ASSET_METADATA),{recursive:true});jsonWrite(ASSET_METADATA,value);}
function uniqueFile(dir,name){
  let candidate=path.join(dir,name);const ext=path.extname(name),stem=path.basename(name,ext);let i=2;
  while(fs.existsSync(candidate))candidate=path.join(dir,`${stem}-v${i++}${ext}`);
  return candidate;
}
export function listDocuments(){
  return DOCUMENTS.filter(x=>fs.existsSync(path.join(ROOT,x.path))).map(x=>{const text=fs.readFileSync(path.join(ROOT,x.path),'utf8');return {...x,text,hash:digest(text),updatedAt:fs.statSync(path.join(ROOT,x.path)).mtime.toISOString()};});
}
export function listAssets(){
  const categoryById=Object.fromEntries(CATEGORIES.map(x=>[x.id,x])),metadata=readAssetMetadata();
  return fs.readdirSync(REFS,{recursive:true}).filter(x=>/\.(png|jpe?g|webp)$/i.test(x)).sort().map(file=>{
    const id=file.split('/')[0],meta=categoryById[id]||{group:'其他素材',label:id};
    const absolute=inside(REFS,file),hash=fileHash(absolute),saved=metadata[hash]||{};return {file,name:path.basename(file),category:id,categoryLabel:meta.label,group:meta.group,hash,updatedAt:fs.statSync(absolute).mtime.toISOString(),tags:Array.isArray(saved.tags)?saved.tags:[],source:saved.source||null,addedAt:saved.addedAt||null};
  });
}
export function discoverArchiveStories(){
  const archiveRoot=path.join(DATA,'往期作品');if(!fs.existsSync(archiveRoot))return [];
  const stories=[];
  for(const entry of fs.readdirSync(archiveRoot,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.name.startsWith('.'))continue;const name=entry.name,dir=path.join(archiveRoot,name);
    const all=fs.readdirSync(dir,{recursive:true}).filter(x=>/\.(png|jpe?g|webp)$/i.test(x));
    let candidates=all.filter(x=>/(^|\/)[^/]*(成图|成稿|最终|发布)[^/]*(\/|$)/.test(x)&&!/(废案|候选|未验收|参考)/.test(x));
    if(!candidates.length)candidates=all.filter(x=>!x.includes('/')&&!/(废案|参考|素材|头像)/.test(x));
    if(!candidates.length)candidates=all.filter(x=>!/(废案|候选|未验收|参考|素材)/.test(x));
    if(!candidates.length)continue;candidates.sort();
    const manifestFile=path.join(dir,'作品清单.json');let manifest={};try{manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));}catch{}
    stories.push({id:Buffer.from(name).toString('base64url'),title:typeof manifest.title==='string'&&manifest.title.trim()?manifest.title.trim():name,folder:path.join('作品','往期作品',name),cover:manifest.cover&&candidates.includes(manifest.cover)?manifest.cover:candidates[0],pages:manifest.pages?.filter(x=>candidates.includes(x))?.length?manifest.pages.filter(x=>candidates.includes(x)):candidates,updatedAt:fs.statSync(dir).mtime.toISOString()});
  }
  return stories;
}
export function archiveStory(id){return discoverArchiveStories().find(x=>x.id===id);}
export async function stageUpload({name,type,data}){
  if(typeof data!=='string'||data.length>28_000_000)throw new Error('图片不能超过 20MB。');
  const match=data.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);if(!match)throw new Error('请选择 PNG、JPG 或 WebP 图片。');
  const id=crypto.randomUUID(),dir=path.join(CANDIDATES,id);fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,safeName(name,match[1]));fs.writeFileSync(file,Buffer.from(match[2],'base64'),{mode:0o600});
  try{await pythonRun(['info',file]);}catch{fs.rmSync(dir,{recursive:true,force:true});throw new Error('图片文件无法读取。');}
  jsonWrite(path.join(dir,'candidate.json'),{id,file,name:path.basename(file),type,createdAt:new Date().toISOString()});
  return {id,name:path.basename(file)};
}
export function readCandidate(id){
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('候选素材不存在');const dir=inside(CANDIDATES,id),meta=path.join(dir,'candidate.json');
  if(!fs.existsSync(meta))throw new Error('候选素材不存在');return JSON.parse(fs.readFileSync(meta,'utf8'));
}
export async function analyzeAsset({file,sourceLabel,model,reasoningEffort='low',dir}){
  const result=await runCodex({dir,schema:ASSET_SCHEMA,images:[file],model,reasoningEffort,
    prompt:`你是《温蒂的日常》长期素材管理员。只分析附件，不修改文件，不调用工具。判断这张图是否值得跨故事复用。长期素材必须身份稳定、设定准确、构图有参考价值、无明显肢体或文字错误，且不是只服务单篇剧情的情绪、动作、节日造型或联动实验。已有分类：${CATEGORIES.map(x=>`${x.id}(${x.label})`).join('；')}。来源：${sourceLabel}。输出保留/不保留、0-100可信度、具体理由、最合适分类、安全简短文件名、可直接加入素材索引的一行说明；只有图像明确证明新的长期事实时才提出worldSettingAddition，否则空字符串；只有本次暴露出可复用流程改进时才提出workflowAddition，否则空字符串。不要因为画面好看就建议长期保留。`});
  result.source={file,sourceLabel};return result;
}
export function saveAssetProposal(proposal){
  const id=crypto.randomUUID();fs.mkdirSync(PROPOSALS,{recursive:true});jsonWrite(path.join(PROPOSALS,`${id}.json`),proposal);
  const {source,...publicProposal}=proposal;return {...publicProposal,id,sourceLabel:source?.sourceLabel};
}
function readAssetProposal(id){
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('素材提案不存在。');const file=inside(PROPOSALS,`${id}.json`);
  if(!fs.existsSync(file))throw new Error('素材提案不存在。');return JSON.parse(fs.readFileSync(file,'utf8'));
}
export function applyAssetProposal({proposalId,applyWorld=false,applyWorkflow=false}){
  const proposal=readAssetProposal(proposalId);
  if(!proposal||proposal.decision!=='keep'||!CATEGORIES.some(x=>x.id===proposal.category))throw new Error('这张图尚未被建议为长期素材。');
  const source=proposal.source?.file;if(!source||!fs.existsSync(source))throw new Error('候选原图已不存在。');
  const sourceHash=fileHash(source),duplicate=listAssets().find(asset=>asset.hash===sourceHash);
  if(duplicate)return {file:duplicate.file,duplicate:true,asset:duplicate};
  const ext=path.extname(source).slice(1)||'png',dir=inside(REFS,proposal.category);fs.mkdirSync(dir,{recursive:true});
  const dest=uniqueFile(dir,safeName(proposal.filename,ext));fs.copyFileSync(source,dest);
  const metadata=readAssetMetadata();metadata[sourceHash]={tags:[proposal.category,proposal.indexEntry].filter(Boolean),source:proposal.source?.sourceLabel||null,addedAt:new Date().toISOString(),proposalId};writeAssetMetadata(metadata);
  const index=path.join(REFS,'00-素材索引.md');backup(index);
  fs.appendFileSync(index,`\n- \`${proposal.category}/${path.basename(dest)}\`：${String(proposal.indexEntry).trim()}（由温蒂创作室添加，${new Date().toLocaleDateString('zh-CN')}）\n`);
  if(applyWorld&&proposal.worldSettingAddition?.trim())appendManaged('设定/漫画世界观设定.md','创作室确认的长期补充',proposal.worldSettingAddition);
  if(applyWorkflow&&proposal.workflowAddition?.trim())appendManaged('设定/温蒂日常小红书漫画工作指引.md','创作室确认的流程补充',proposal.workflowAddition);
  return {file:path.relative(REFS,dest),duplicate:false,asset:listAssets().find(asset=>asset.hash===sourceHash)};
}
function backup(file){
  fs.mkdirSync(HISTORY,{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  fs.copyFileSync(file,path.join(HISTORY,`${stamp}-${path.basename(file)}`));
}
function appendManaged(docPath,title,text){const file=path.join(ROOT,docPath);backup(file);fs.appendFileSync(file,`\n\n## ${title}（${new Date().toLocaleDateString('zh-CN')}）\n\n${text.trim()}\n`);}
export function saveDocument({docPath,content,expectedHash,confirm}){
  const doc=DOCUMENTS.find(x=>x.path===docPath);if(!doc)throw new Error('这个文件不能从创作室修改。');
  if(confirm!==true)throw new Error('请确认保存这次长期设定变更。');
  if(typeof content!=='string'||content.trim().length<50||content.length>200_000)throw new Error('文档内容不完整或过长。');
  const file=path.join(ROOT,doc.path),current=fs.readFileSync(file,'utf8');if(digest(current)!==expectedHash)throw new Error('文件已在别处更新，请刷新后再保存。');
  backup(file);fs.writeFileSync(file,content.endsWith('\n')?content:content+'\n');return {hash:digest(content.endsWith('\n')?content:content+'\n')};
}
export async function suggestDocument({docPath,note,model,reasoningEffort='medium',dir}){
  const doc=DOCUMENTS.find(x=>x.path===docPath);if(!doc)throw new Error('这个文件不能从创作室修改。');
  if(typeof note!=='string'||note.trim().length<3||note.length>6000)throw new Error('请写清想完善的内容。');
  const current=fs.readFileSync(path.join(ROOT,doc.path),'utf8');
  const result=await runCodex({dir,schema:DOC_SCHEMA,model,reasoningEffort,prompt:`你是《温蒂的日常》设定编辑。用户要完善 ${doc.label}。只返回完整修订文本和变更说明，不调用工具，不修改文件。保持已有内容、Markdown结构和职责边界；用户的新指示优先。单篇剧情不能写入长期世界观，浏览器按钮和模型名不能写入核心世界观，跨故事规则才写工作指引。用户要求：${note}\n\n当前全文：\n${current}`});
  return {...result,docPath,baseHash:digest(current)};
}
export function deleteProjectFolder(dir,title,confirmTitle){
  if(confirmTitle!==title)throw new Error('作品名称不一致，没有删除。');
  const trash=path.join(DATA_ROOT(dir),'.废纸篓');fs.mkdirSync(trash,{recursive:true});
  const dest=uniqueFolder(trash,`${path.basename(dir)}-${Date.now()}`);fs.renameSync(dir,dest);return dest;
}
function DATA_ROOT(dir){return path.dirname(dir);}
function uniqueFolder(root,name){let out=path.join(root,name),i=2;while(fs.existsSync(out))out=path.join(root,`${name}-${i++}`);return out;}
export function deleteArchiveStory(id,confirmTitle){
  const story=archiveStory(id);if(!story)throw new Error('往期作品不存在');if(confirmTitle!==story.title)throw new Error('作品名称不一致，没有删除。');
  const source=inside(ROOT,story.folder),trash=path.join(DATA,'.废纸篓');fs.mkdirSync(trash,{recursive:true});
  const dest=uniqueFolder(trash,`${path.basename(story.folder)}-${Date.now()}`);fs.renameSync(source,dest);return dest;
}
