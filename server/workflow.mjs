import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = process.env.WENDI_PROJECT_ROOT || APP;
export const DATA = process.env.WENDI_DATA_DIR || path.join(APP, '作品');
export const REFS = path.join(ROOT, '设定/固有设定素材');
export const GUIDES = ['设定/漫画世界观设定.md','设定/温蒂日常小红书漫画工作指引.md','设定/固有设定素材/00-素材索引.md','设定/网页生图技术附录.md'];
export const FACE = ['01-温蒂人设/人设1.PNG','01-温蒂人设/人设2.PNG'];
export const CHECKS = ['人物身份与服装','手脚、动作与视线','住宅、车辆与物件连续性','文案、页码与阅读顺序','画面干净、没有明显噪点'];
export function jsonWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), {mode:0o600});
  fs.renameSync(tmp,file);
}
export function inside(root, name) {
  const result = path.resolve(root,name);
  if (!result.startsWith(path.resolve(root)+path.sep)) throw new Error('文件路径无效');
  if (fs.existsSync(result) && !fs.realpathSync(result).startsWith(fs.realpathSync(root)+path.sep)) throw new Error('文件路径无效');
  return result;
}
export function references(allowXiaolin = false) {
  return fs.readdirSync(REFS, {recursive:true}).filter(x=>/\.(png|jpe?g|webp)$/i.test(x) && (allowXiaolin || !x.startsWith('02-'))).sort();
}
export function rules() { return GUIDES.map(name=>`\n--- ${name} ---\n${fs.readFileSync(path.join(ROOT,name),'utf8')}`).join('\n'); }
export function digest(value) { return crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex'); }
const str = {type:'string'};
const list = {type:'array',items:str};
const obj = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const PANEL = obj({ scene:str, characters:str, costume:str, action:str, gaze:str, expression:str,
  lighting:str, layers:str, objects:str, caption:str, captionKind:{enum:['narration','dialogue','time'],type:'string'},
  screenText:str, screenDirection:str, prompt:str, references:list, anchors:list, forbidden:list });
export const PLAN_SCHEMA = obj({title:str,synopsis:str,arc:str,
  continuity:obj({characters:list,scenes:list,objects:list,copy:list}),
  samples:{type:'array',minItems:2,maxItems:2,items:obj({title:str,prompt:str,references:list})},
  pages:{type:'array',minItems:1,maxItems:12,items:obj({number:{type:'integer'},title:str,purpose:str,time:str,
    layout:{type:'string',enum:['solo','duo','trio','montage','four']},
    panels:{type:'array',minItems:1,maxItems:4,items:PANEL}})}});
const ISSUE_CATEGORY={type:'string',enum:['identity','anatomy','text','layout','aspect_ratio','safe_area','noise','continuity','uncertain']};
export const QA_SCHEMA = obj({pass:{type:'boolean'},summary:str,issues:list,issueDetails:{type:'array',items:obj({id:str,category:ISSUE_CATEGORY,severity:{type:'string',enum:['blocking','review','suggestion']},location:str,description:str,repairAction:{type:'string',enum:['regenerate','reletter','recompose','review']}})},repairPrompt:str});
export function validatePlan(plan, brief) {
  if (!plan || !Array.isArray(plan.pages) || plan.pages.length!==brief.pageCount) throw new Error('方案页数与需求不同，需要重新整理。');
  if (!plan.title || !plan.arc || !plan.continuity || !['characters','scenes','objects','copy'].every(k=>Array.isArray(plan.continuity[k])&&plan.continuity[k].length)) throw new Error('方案缺少完整的连续性台账。');
  if (plan.samples?.length!==2) throw new Error('方案必须含人物和主场景两张样张。');
  const available = new Set(references(brief.allowXiaolin));
  const expected = {solo:1,duo:2,trio:3,montage:3,four:4};
  for (const [i,p] of plan.pages.entries()) {
    if (p.number!==i+1 || p.panels?.length!==expected[p.layout]) throw new Error('页码或分镜布局不完整。');
    for (const q of p.panels) {
      for (const k of ['scene','characters','costume','action','gaze','expression','lighting','layers','objects','prompt']) if (typeof q[k]!=='string' || !q[k].trim()) throw new Error(`第${i+1}页缺少${k}`);
      if (typeof q.caption!=='string' || [...q.caption].length>100) throw new Error('每格文案请控制在100字以内，较长内容需要拆分。');
      if (!brief.allowXiaolin && /小林/.test([q.characters,q.scene,q.action,q.caption,q.objects].join(' '))) throw new Error('本篇没有获准让小林出现，请修改方案。');
    }
  }
  for (const q of [...plan.samples,...plan.pages.flatMap(p=>p.panels)]) {
    if (!Array.isArray(q.references) || q.references.some(ref=>!available.has(ref))) throw new Error('方案引用了不存在或未获准的参考素材。');
  }
  return plan;
}
export function planMarkdown(plan, brief, version) {
  let s=`# ${plan.title}\n\n方案 v${version} · ${brief.pageCount} 页\n\n## 本篇需求\n${brief.idea}\n\n${brief.special||''}\n\n## 故事弧线\n${plan.arc}\n`;
  for (const [key,title] of [['characters','人物'],['scenes','场景'],['objects','物件'],['copy','文案']]) s+=`\n## ${title}连续性台账\n${plan.continuity[key].map(x=>'- '+x).join('\n')}\n`;
  for (const p of plan.pages) {
    s+=`\n## 第${p.number}页 · ${p.title}\n${p.purpose}\n时间：${p.time}\n版式：${p.layout}，按从上到下、从左到右阅读\n`;
    for (const [i,q] of p.panels.entries()) s+=`\n### 第${i+1}格\n场景：${q.scene}\n人物：${q.characters}\n服装：${q.costume}\n动作：${q.action}\n视线：${q.gaze}\n表情：${q.expression}\n光线：${q.lighting}\n层次：${q.layers}\n物件：${q.objects}\n逐字文案：${q.caption}\n内屏文案：${q.screenText||'无'}\n内屏要求：${q.screenDirection||'无'}\n提示词：${q.prompt}\n连续性：${q.anchors.join('；')}\n禁止项：${q.forbidden.join('；')}\n参考：${q.references.join('；')}\n`;
  }
  return s;
}
export function plannerPrompt(brief, previous, revision) {
  return `你是温蒂系列漫画的编剧和分镜导演。只返回符合给定JSON结构的完整中文方案，不生图，不调用工具，不访问其他文件或账号。以下是已经读取的权威文件全文：\n${rules()}\n可用参考文件：${JSON.stringify(references(brief.allowXiaolin))}\n两张温蒂人设图已作为输入附件。\n用户本篇需求：${JSON.stringify(brief)}\n${previous?'上一版完整方案：'+JSON.stringify(previous)+'\n用户修改：'+revision:''}\n制作要求：页数严格${brief.pageCount}。小林权限以 allowXiaolin 为准，为false时绝不出场或暗示。汤圆权限以 tangyuan 为准：不出现/自然出现/按剧情。两张样张分别检验人物脸部和本篇主场景，样张不算正式页。必须完成故事弧线、每格详细描述和四份台账，文案台账逐条带页码格号。每页layout从solo(全页一格)、duo(上大下小两格)、trio(上主格下两格)、montage(三段横格)、four(上主格下三格)中选择并交替，避免全篇同一网格。两格以上必须有主格。每格caption是确定性后期排版的逐字文字，可为空，不超过100字；对白明确说话者，时间标签只写短标签。画面prompt禁止生成任何中文或多格拼图。头顶发髻、手脚和关键物件留8%安全区。references只引用目录存在且该格需要的文件，相应住宅/车/猫/咖啡/运动必须引用。两张温蒂图会自动附带。手机/车机若有内屏文案，把逐字内容放在screenText、界面状态和透视/手指遮挡/反光要求放在screenDirection；无需内屏文字时两项都为空字符串。生成prompt仅要求留空玻璃屏幕并保持可辨认的边框和透视，绝不让生图模型画文字；后续单独检测内屏四角并进行确定性中文透视合成。caption只用于屏幕外的旁白对白，不能重复内屏文字。原始图与最终版中文分离。要有具体生活动作、视线、前中后景和光线推进。文案和台账必须随修改同步。`;
}
