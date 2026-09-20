import crypto from 'node:crypto';

export const REVISION_PROMPT_VERSION=2;
export const REVISION_PROMPT_SOURCE='revision-prompt-v2';
export const REVISION_PROMPT_SOURCE_SEGMENTS=['must-change','must-keep','output-constraints'];

const ABSOLUTE_PATH=/(?:^|\s)(?:\/(?:Volumes|Users|private\/var|tmp|home)\/[^\n，。；;]+)/g;
const RELATIVE_PATH=/(?:^|\s)(?:v\d+\/|素材\/|作品\/|\.制作记录\/)[^\s，。；;]+/g;
const INTERNAL_ID=/\b(?:project|task|request|run)[_-]?id\s*[:=：]?\s*[a-z0-9-]*/gi;
const UUID=/\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/gi;
const LAYOUT_NOISE=/(?:上方主格约?\s*\d+(?:\.\d+)?\s*%?\s*[，,、]?|下方从左到右|本地排版唯一布局[^\n。]*|优先级最高)/g;

function text(value){return typeof value==='string'?value.trim():String(value??'').trim();}

function redactInternal(value){
  return text(value)
    .replace(ABSOLUTE_PATH,' ')
    .replace(RELATIVE_PATH,' ')
    .replace(UUID,' ')
    .replace(INTERNAL_ID,' ')
    .replace(/\s{2,}/g,' ')
    .trim();
}

function cleanBaseText(value){
  return redactInternal(value)
    .replace(LAYOUT_NOISE,' ')
    .replace(/第\s*\d+\s*页第\s*\d+\s*格[。；;，,]?/g,' ')
    .replace(/\s{2,}/g,' ')
    .trim();
}

function bounded(value,limit=360){
  const item=cleanBaseText(value);
  return item.length>limit?`${item.slice(0,limit)}…`:item;
}

function narrativeFrom(basePrompt){
  const marker='故事与连续性要求：';
  const line=String(basePrompt||'').split(/\r?\n/).find(item=>item.includes(marker));
  if(!line)return {};
  try{
    const value=JSON.parse(line.slice(line.indexOf(marker)+marker.length).trim());
    return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  }catch{return {};}
}

function ratioFrom(basePrompt){
  const localLayout=String(basePrompt||'').split(/\r?\n/).find(item=>item.includes('本地排版唯一布局'));
  if(localLayout){
    try{
      const value=JSON.parse(localLayout.slice(localLayout.indexOf('{')));
      const instruction=String(value.instruction||'').match(/宽高比必须严格为\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
      if(instruction)return `${instruction[1]}:${instruction[2]}`;
      if(Number(value.width)>0&&Number(value.height)>0)return `${value.width}:${value.height}`;
      if(value.ratio)return cleanBaseText(value.ratio);
    }catch{}
  }
  const value=String(basePrompt||'').match(/(\d+(?:\.\d+)?)\s*[:：xX×]\s*(\d+(?:\.\d+)?)/);
  return value?`${value[1]}:${value[2]}`:'原图比例';
}

function splitNote(note){
  const rows=[];
  for(const line of String(note||'').split(/\r?\n/)){
    const value=redactInternal(line);
    if(!value)continue;
    const pieces=value.match(/[^。！？!?；;]+[。！？!?；;]?/g)||[value];
    for(const piece of pieces){const item=piece.trim();if(item)rows.push(item);}
  }
  return rows.length?rows:['按原始修改说明修正指定局部。'];
}

// A revision note often contains a compact change followed by invariants such
// as “保持姿势和视线不变”.  Those invariants are not user change intent.  If
// they enter the classifier, a generic word like “姿势” can select a domain
// repair template (for example the espresso template) and contaminate an
// otherwise clothing-only edit.  Keep the parser deliberately conservative:
// remove only explicit keep/unchanged fragments and never inspect the frozen
// base prompt here.
const KEEP_CLAUSE=/(?:保持|保留|不改变|不改动|不要改变|不要改动|不要修改|无需(?:再)?修改|不得改变)[^。！？!?]*?(?:不变|原样|如前|一致|$)/g;

function normalizeChangeList(note){
  const normalized=[];
  for(const row of splitNote(note)){
    const hadKeep=KEEP_CLAUSE.test(row);
    KEEP_CLAUSE.lastIndex=0;
    const stripped=row.replace(KEEP_CLAUSE,' ').replace(/[，,、；;：:]\s*(?=[，,、；;：:])/g,' ').replace(/\s{2,}/g,' ').trim();
    for(const item of stripped.split(/[，,、；;]/).map(value=>value.replace(/^[。！？!?；;，,、：:\s]+|[。！？!?；;，,、：:\s]+$/g,'').trim()).filter(Boolean)){
      // A row made entirely of an invariant is not a change.  The generic
      // output constraints already cover “不要添加文字/水印”等 output rules.
      if(/^(?:当前|其他|其余|未涉及)?\s*(?:内容|部分|元素|姿势|动作|视线|身份|背景|构图|光线)?\s*(?:保持|保留|不改变|不改动|不要改变|不要改动|不要修改|无需(?:再)?修改|不得改变)/.test(item))continue;
      if(hadKeep&&!hasIssueIntent(item))continue;
      if(item)normalized.push(item);
    }
  }
  return normalized.length?normalized:['按原始修改说明修正指定局部。'];
}

function hasIssueIntent(value){
  return /(?:不对|不正确|错误|不自然|僵硬|有问题|错位|缺少|不合理|需要|修正|修复|纠正|改善|调整|改成|改为|改动|修改|改变|替换)/i.test(value);
}

function intentFlags(lines){
  const value=lines.join(' ');
  return {
    character:/(?:身份|面容|脸|五官|发型|头发|体型|人物替换|角色)/i.test(value),
    clothing:/(?:服装|衣服|裙|鞋|穿着|配饰)/i.test(value),
    action:/(?:动作|姿势|站姿|僵硬|肩颈|肘部|手臂|手腕|重心|站立|坐姿|转身|视线|看向|表情)/i.test(value),
    object:/(?:器具|咖啡机|出液|冲煮|portafilter|萃取|手柄|杯子|杯|物件|道具|移到|放在|位置)/i.test(value),
    composition:/(?:构图|布局|画面|画幅|比例|分格|拼图|前景|中景|背景|安全区)/i.test(value),
    lighting:/(?:光线|光照|阴影|色温|明暗|曝光)/i.test(value),
    scene:/(?:场景|环境|背景|厨房|客厅|卧室|室外|室内)/i.test(value),
    style:/(?:风格|画风|线条|纸感|色块|质感|颜色|色彩)/i.test(value),
  };
}

function positiveResult(line){
  const value=redactInternal(line);
  const espressoDomain=/(?:咖啡机|意式|萃取|冲煮|portafilter|萃取头|出液(?:口|嘴)?|液流|粉碗|手柄)/i.test(value);
  const actionDomain=/(?:动作|姿势|站姿|肩颈|肘部|手臂|手腕|重心|站立|坐姿|转身|表情)/i.test(value);
  const clothingDomain=/(?:服装|衣服|裙|鞋|穿着|配饰|衣物)/i.test(value);
  // Domain templates require both an explicit domain noun and an issue/change
  // intent.  Keep-only phrases and generic “姿势/视线” wording therefore
  // cannot activate a professional template.
  if(espressoDomain&&hasIssueIntent(value)){
    return '修正为真实连贯的意式咖啡机出液关系：冲煮头与 portafilter 手柄正确锁合；双出液嘴位于手柄底部，每股液流都从对应出液嘴连续流出；杯子正位于双出液嘴下方承接液流，手柄朝右；各部件不得悬空、穿插或错位。';
  }
  if(actionDomain&&hasIssueIntent(value)){
    return '把人物改为自然、放松且可观察的动作：肩颈放松，肘部与手腕自然弯曲或下垂，重心落在双脚，躯干和手臂有自然曲线；双手远离热出液口并以合理姿态完成当前操作，视线自然落在杯子与萃取过程；只联动调整完成该姿势所需的局部。';
  }
  if(clothingDomain&&hasIssueIntent(value))return `仅调整服装相关内容：${value.replace(/[。！？!?；;]+$/,'')}；衣物颜色、长度、材质和垂坠按这条说明呈现，不联动改变人物动作、视线、场景或物件。`;
  if(/不对|错误|不自然|僵硬|有问题|错位|缺少|不合理/i.test(value)){
    return `修正该说明所指区域，使位置、方向、连接和比例与第1附件及相关参考一致，结果在画面中清晰可见；仅影响完成本条修订所需的局部。`;
  }
  if(/不要|去掉|移除|删除/i.test(value))return `画面中不出现该说明所指内容，其余未涉及部分保持不变。`;
  return `按“${value.replace(/[。！？!?；;]+$/,'')}”完成可直接观察的局部修订，其余未涉及部分保持不变。`;
}

const SCOPED_OBJECT_TERMS=/(?:咖啡机|意式|萃取|冲煮|portafilter|萃取头|出液(?:口|嘴)?|液流|粉碗|手柄|奶油白杯|杯子|杯)/i;

function scopedKeepText(value,label,flags){
  const item=bounded(value);
  if(!item)return '';
  // A non-object edit should not carry a detailed object ledger into the
  // remote message.  This keeps a clothing/walking revision from acquiring a
  // coffee task merely because the frozen story mentions another panel.
  return !flags.object&&SCOPED_OBJECT_TERMS.test(item)?`${label}按第1附件原样保持，不引入器具专项变化。`:item;
}

function keepLines(narrative,flags,fallback=''){
  const lines=[];
  // This is intentionally phrased independently of the original page key or
  // local file name: the two attached character sheets are the identity source.
  if(!flags.character)lines.push('温蒂身份、面容、发型、体型与人物比例以已上传的人设参考为准。');
  const characters=bounded(narrative.characters);
  if(characters&&!flags.character)lines.push(`人物与角色：${characters}`);
  const costume=bounded(narrative.costume);
  if(costume&&!flags.clothing)lines.push(`服装与穿着：${costume}`);
  const scene=scopedKeepText(narrative.scene,'场景与环境',flags);
  if(scene&&!flags.scene)lines.push(`场景与环境：${scene}`);
  const lighting=scopedKeepText(narrative.lighting,'光线',flags);
  if(lighting&&!flags.lighting)lines.push(`光线：${lighting}`);
  const gaze=scopedKeepText(narrative.gaze,'人物视线',flags);
  if(gaze&&!flags.action)lines.push(`视线：${gaze}`);
  const expression=scopedKeepText(narrative.expression,'人物表情',flags);
  if(expression&&!flags.action)lines.push(`表情：${expression}`);

  // Do not echo a whole cross-page object ledger into a scoped revision.  It
  // can contain another panel's espresso vocabulary and accidentally turn a
  // clothing or walking edit into a coffee edit.  The attached base image is
  // already the source of truth for untouched objects.
  if(flags.object)lines.push('未涉及的背景物件与器具细节保持不变；仅为完成上述器具修订进行必要的局部联动。');
  else lines.push('未涉及的背景物件与器具保持原图不变，不新增、不替换。');
  if(flags.composition)lines.push('除完成上述构图或画面修订所需的局部联动外，其他空间关系保持不变。');
  else lines.push('原图的整体构图、主体尺度与前中后景关系保持不变。');
  if(flags.style)lines.push('未涉及的绘画风格、线条、色块与质感保持不变。');
  else {
    const style=bounded(narrative.creatorPrompt);
    const styleOnly=/(?:风格|插画|线条|纸感|色块|质感|日系|漫画)/.test(style)?style:'';
    lines.push(styleOnly?`绘画风格与质感：${styleOnly}`:'原图的绘画风格、线条、色块与质感保持不变。');
  }
  if(fallback)lines.push(`原图中未涉及的基准内容：${fallback}`);
  if(flags.scene)lines.push('除完成场景修订所需的局部联动外，其他环境细节保持不变。');
  lines.push('除上述明确修改及其必要的局部联动外，不改变其他正确内容。');
  return lines;
}

const SAFE_ANCHORS=[
  ['character','人物身份',/(?:人物身份|人物与角色|角色身份)\s*[:：]\s*([^。！？!?；;\n]+)/],
  ['clothing','服装与穿着',/(?:服装与穿着|服装|穿着)\s*[:：]\s*([^。！？!?；;\n]+)/],
  ['scene','场景与环境',/(?:场景与环境|场景|环境)\s*[:：]\s*([^。！？!?；;\n]+)/],
  ['lighting','光线',/光线\s*[:：]\s*([^。！？!?；;\n]+)/],
  ['composition','构图',/(?:构图与画面|构图)\s*[:：]\s*([^。！？!?；;\n]+)/],
  ['style','绘画风格与质感',/(?:绘画风格与质感|风格与质感|绘画风格|风格|画风)\s*[:：]\s*([^。！？!?；;\n]+)/],
];
const UNSAFE_ANCHOR=/(?:用户已确认|本次明确选定|编辑身份|安全约束|目标分镜|历史任务|历史失败|之前失败|基图|布局|排版|上方主格|下方从左|本地|执行器|manifest|requestId|projectId|taskId|runId|\/Volumes\/|\/Users\/|v\d+\/素材\/)/i;

function safeFallback(basePrompt,flags){
  const source=String(basePrompt||''),anchors=[];
  for(const [category,label,pattern] of SAFE_ANCHORS){
    if(flags[category])continue;
    const match=source.match(pattern),value=match?scopedKeepText(match[1],label,flags):'';
    if(value&&!UNSAFE_ANCHOR.test(value))anchors.push(`${label}：${value}`);
  }
  // Never echo an unstructured prompt. This fixed sentence cannot carry
  // paths, layout instructions, historical wording, or changed details.
  return anchors.length?anchors.join('；'):'仅保持未涉及内容不变。';
}

export function buildRevisionPrompt(basePrompt,note,{key='',baseFile=null}={}){
  // key/baseFile remain accepted for callers and durable metadata, but are
  // deliberately never interpolated into the remote image message.
  void key;void baseFile;
  const narrative=narrativeFrom(basePrompt),changes=normalizeChangeList(note),flags=intentFlags(changes),ratio=ratioFrom(basePrompt);
  const fallback=Object.keys(narrative).length?'':safeFallback(basePrompt,flags);
  const changeLines=changes.flatMap((line,index)=>[
    `- 修改 ${index+1}（原话）：${line}`,
    `  可观察结果：${positiveResult(line)}`,
  ]);
  const output=[
    `- 只生成一张独立单幅图，画面比例严格为 ${ratio}。`,
    '- 不生成任何文字、中文、字幕、logo 或水印。',
    '- 不生成多格拼图、分格线或多张图。',
  ];
  const forbidden=(Array.isArray(narrative.forbidden)?narrative.forbidden:[narrative.forbidden])
    .map(item=>bounded(item,120)).filter(item=>item&& !changes.some(change=>change.includes(item)));
  if(forbidden.length)output.push(`- 不出现未授权元素：${forbidden.join('、')}。`);
  if(/(?:8\s*%|安全区)/.test(String(basePrompt||'')))output.push('- 头顶发髻、手脚和关键物件保留约 8% 安全区。');
  return [
    '第1附件是待编辑基图。',
    '只以第1附件为编辑基准；其他附件仅用于身份、环境或器具参考。',
    '',
    '必须修改：',
    ...changeLines,
    '',
    '必须保持：',
    ...keepLines(narrative,flags,fallback).map(line=>`- ${line}`),
    '',
    '输出约束：',
    ...output,
  ].join('\n');
}

export {normalizeChangeList};

function sha256(value){return crypto.createHash('sha256').update(String(value||''),'utf8').digest('hex');}

export function revisionPromptTelemetry(prompt,{basePrompt='',note=''}={}){
  return {
    revisionPromptVersion:REVISION_PROMPT_VERSION,
    revisionPromptSha256:sha256(prompt),
    revisionPromptCharacters:String(prompt||'').length,
    revisionPromptSource:REVISION_PROMPT_SOURCE,
    revisionPromptSourceSegments:[...REVISION_PROMPT_SOURCE_SEGMENTS],
    revisionBasePromptSha256:sha256(basePrompt),
    revisionDeltaCharacters:String(note||'').length,
  };
}
