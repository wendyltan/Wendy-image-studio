import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRevisionPrompt,revisionPromptTelemetry} from '../server/engine.mjs';
import {normalizeChangeList} from '../server/revision-prompt.mjs';
import {chatGptWebImagePrompt} from '../server/chatgpt-web-provider.mjs';

const basePrompt = `第5页第1格，单幅3:2，上方主格约55%，下方从左到右。
故事与连续性要求：{"scene":"原木厨房咖啡角","characters":"两张温蒂人设锁定身份","costume":"周六重新扎高丸子头，浅杏薄短袖浅棕及膝裙米色拖鞋","action":"已完成称豆磨豆布粉压粉装柄，正在萃取","gaze":"专注看杯","expression":"专注","lighting":"中性下午纱帘光","layers":"前景台面压粉工具，中景完整人物机器杯子，背景原木柜米白墙","objects":"意式机与磨豆机、奶油白杯、柄朝右","creatorPrompt":"日系细腻生活插画、柔线轻纸感、干净色块"}`;

const legacyUnstructuredPrompt=`第5页第1格，单幅3:2，上方主格约55%，下方从左到右。两张温蒂人设锁定身份，周六重新扎高丸子头，浅杏薄短袖浅棕及膝裙米色拖鞋。原木厨房咖啡角按住宅参考，意式机与磨豆机按咖啡参考，仅取器具不取旧人物文字。已完成称豆磨豆布粉压粉装柄，正在萃取，咖啡流入奶油白杯、柄朝右。温蒂站侧前，双手自然垂下远离热出液口，专注看杯。前景台面压粉工具，中景完整人物机器杯子，背景原木柜米白墙；中性下午纱帘光。日系细腻生活插画、柔线轻纸感、干净色块。头顶发髻、手脚和器具留8%安全区。禁止生成中文及任何文字、多格拼图、手冲混入、旧人物替代、Logo、水印、猫、小林、汤圆、多余肢体。用户已确认本次修改（独立差异，唯一允许改变的内容）：咖啡机出液口不对。人物动作僵硬。编辑身份与安全约束：本次明确选定的编辑基图：v2/素材/5-1-局部修订-1789307385587.png；只改本次差异，其他人物身份、面容、发型、服装、动作、视线、场景、物件、光线、画幅、构图、风格、无文字要求和安全区全部保持不变。`;

const multiDomainBasePrompt=`故事与连续性要求：${JSON.stringify({scene:'原木厨房咖啡角',characters:'两张温蒂人设锁定身份',costume:'浅杏薄短袖浅棕及膝裙',action:'正在萃取',gaze:'专注看杯',expression:'专注',lighting:'中性下午纱帘光',objects:'意式咖啡机、portafilter、双出液嘴与奶油白杯',creatorPrompt:'日系细腻生活插画、柔线轻纸感、干净色块'})}`;

test('revision prompt is a clean, non-contradictory remote edit brief', () => {
  const prompt = buildRevisionPrompt(
    basePrompt,
    '咖啡机出液口不对。人物动作僵硬',
    {key: '5-1', baseFile: 'v2/素材/5-1-局部修订-1789307385587.png'},
  );

  assert.match(prompt, /^第1附件是待编辑基图。/);
  assert.match(prompt, /必须修改：/);
  assert.match(prompt, /咖啡机出液口不对/);
  assert.match(prompt, /人物动作僵硬/);
  assert.match(prompt, /portafilter/);
  assert.match(prompt, /双出液嘴/);
  assert.match(prompt, /液流/);
  assert.match(prompt, /肩颈/);
  assert.match(prompt, /肘部/);
  assert.match(prompt, /重心/);
  assert.match(prompt, /必须保持：/);
  assert.match(prompt, /温蒂.*身份/);
  assert.match(prompt, /浅杏薄短袖/);
  assert.match(prompt, /原木厨房咖啡角/);
  assert.match(prompt, /输出约束：/);
  assert.match(prompt, /3:2/);
  assert.match(prompt, /不生成任何文字/);

  const keep = prompt.slice(prompt.indexOf('必须保持：'), prompt.indexOf('输出约束：'));
  assert.doesNotMatch(keep, /动作|姿势|站姿|出液|portafilter|液流|咖啡机/);
  assert.doesNotMatch(prompt, /上方主格约55%|下方从左到右/);
  assert.doesNotMatch(prompt, /用户已确认|冻结原始|目标分镜/);
  assert.doesNotMatch(prompt, /\/Volumes\/|\/Users\/|projectId|taskId|requestId|runId/);
});

test('browser executor separates local instructions from the remote prompt payload', () => {
  const revision=buildRevisionPrompt(basePrompt,'咖啡机出液口不对。人物动作僵硬',{key:'5-1',baseFile:'/Volumes/ExtSSD/local.png'});
  const instruction=chatGptWebImagePrompt({
    outputFile:'/tmp/result.png',
    manifestFile:'/tmp/web-generation.json',
    prompt:revision,
    capsule:'内部执行参考：不要发送给 ChatGPT。',
    referenceFiles:['/tmp/base.png','/tmp/face-1.png','/tmp/face-2.png'],
    editTarget:'/tmp/base.png',
    requestId:'11111111-1111-4111-8111-111111111111',
  });
  const match=instruction.match(/<remote_prompt>\n([\s\S]*?)\n<\/remote_prompt>/);
  assert(match);
  assert.equal(match[1],revision);
  assert.doesNotMatch(instruction,/fs\.readFileSync|require\(|worker-request\.json|prompt\.txt/);
  assert.match(instruction,/附件路径、manifest、requestId、项目状态/);
  assert.match(instruction,/本地执行参考（不要复制给 ChatGPT/);
  assert.doesNotMatch(match[1],/\/tmp\/|requestId|projectId|taskId|runId|用户已确认|上方主格/);
});

test('unstructured legacy revision input falls back to safe anchors, never the full prompt', () => {
  const prompt=buildRevisionPrompt(legacyUnstructuredPrompt,'咖啡机出液口不对。人物动作僵硬',{key:'5-1',baseFile:'v2/素材/5-1-局部修订-1789307385587.png'});
  assert.match(prompt,/必须修改：/);
  assert.match(prompt,/咖啡机出液口不对/);
  assert.match(prompt,/人物动作僵硬/);
  assert.match(prompt,/双出液嘴/);
  assert.match(prompt,/肩颈/);
  assert.match(prompt,/输出约束：/);
  const forbidden=/用户已确认|本次明确选定的编辑基图|编辑身份与安全约束|目标分镜|历史任务|历史失败|上方主格约55%|下方从左到右|v2\/素材|\/Volumes\/|\/Users\/|projectId|taskId|requestId|runId|本地排版唯一布局|优先级最高|后台网页生图/;
  assert.doesNotMatch(prompt,forbidden);
  const keep=prompt.slice(prompt.indexOf('必须保持：'),prompt.indexOf('输出约束：'));
  assert.doesNotMatch(keep,/动作|姿势|站姿|视线|出液|portafilter|液流|咖啡机/);
});

test('page QA critique becomes positive corrections instead of instructions to reproduce the cited defects',()=>{
  const note=`成稿校对指出以下分镜问题：\n- 前两格使用米色高背软包木脚书椅，第三格变成黑色带轮办公椅；冻结要求明确为同一书房、同一软包书椅。\n- 人物身体和脸部略朝向观者，电脑仅露背壳，导致“背靠书椅、松松看着电脑方向、安闲等待”的叙事不如前两格明确；未构成明显正视镜头，但建议加强侧面或三分之二侧面关系。\n\n请只修改第 2 页第 3 格，逐项修复以上问题；保留该格其他人物、场景、动作、构图和风格，不改动其他分镜。`;
  const changes=normalizeChangeList(note);
  assert.deepEqual(changes,[
    '将第三格中的黑色带轮办公椅替换为与前两格一致的米色高背软包木脚书椅。',
    '让人物身体与脸部呈现侧面或三分之二侧面，以“背靠书椅、松松看着电脑方向、安闲等待”清楚表达原定动作和视线；避免正视镜头。',
  ]);
  const prompt=buildRevisionPrompt(basePrompt,note,{key:'2-3'}),mustChange=prompt.slice(prompt.indexOf('必须修改：'),prompt.indexOf('必须保持：'));
  assert.match(mustChange,/替换为与前两格一致的米色高背软包木脚书椅/);
  assert.match(mustChange,/侧面或三分之二侧面/);
  assert.doesNotMatch(mustChange,/变成黑色带轮办公椅|保留该格其他|不改动其他分镜|场景、动作、构图和风格/);
  assert.match(prompt,/未涉及的背景物件与器具保持原图不变/);
});

test('unrecognized QA findings fail closed before an empty or misleading edit prompt can be built',()=>{
  const note='成稿校对指出以下分镜问题：\n- 手部比例不协调，手指结构看起来过于僵硬。';
  assert.throws(()=>buildRevisionPrompt(basePrompt,note,{key:'2-3'}),error=>error.code==='UNRESOLVED_REVIEW_CRITIQUE'&&/没有提交生图/.test(error.message));
  assert.throws(()=>normalizeChangeList('成稿校对指出以下分镜问题：\n- 椅子颜色不一致，需要替换为米色软包椅。\n- 画面透视略显平面。'),error=>error.code==='UNRESOLVED_REVIEW_CRITIQUE');
  assert.deepEqual(normalizeChangeList('具体修复方向：将第三格黑色办公椅替换为米色软包椅。'),['具体修复方向：将第三格黑色办公椅替换为米色软包椅']);
});

test('critique bullet does not silently drop a second explicit defect target',()=>{
  const note='画面校对指出以下问题：\n- 建议改为蓝色上衣；右手多了一根手指，需要删除多余手指。';
  const changes=normalizeChangeList(note);
  assert.match(changes.join('\n'),/蓝色上衣/);
  assert.match(changes.join('\n'),/删除多余手指/);
  const prompt=buildRevisionPrompt(basePrompt,note,{key:'5-1'});
  const mustChange=prompt.slice(prompt.indexOf('必须修改：'),prompt.indexOf('必须保持：'));
  assert.match(mustChange,/蓝色上衣/);
  assert.match(mustChange,/删除多余手指/);
});

test('critique bullet converts every supported suggestion, including a target introduced by 将',()=>{
  const note='画面校对指出以下问题：\n- 建议改为蓝色上衣；建议调整为短袖；建议将背景改为室内。';
  assert.deepEqual(normalizeChangeList(note),[
    '将相关内容改为蓝色上衣，只改变该问题所需的局部。',
    '将相关内容调整为短袖，只改变该问题所需的局部。',
    '将背景改为室内，只改变该问题所需的局部。',
  ]);
});

test('critique parser keeps a recognized target from masking an unrelated trailing defect',()=>{
  const note='画面校对指出以下问题：\n- 建议改为蓝色上衣；画面透视略显平面。';
  assert.throws(()=>normalizeChangeList(note),error=>error.code==='UNRESOLVED_REVIEW_CRITIQUE'&&error.unresolvedParts.some(part=>/透视/.test(part)));
});

test('critique keep clauses are removed while the explicit target remains',()=>{
  const note='画面校对指出以下问题：\n- 建议改为蓝色上衣，保持人物姿势和背景不变。';
  assert.deepEqual(normalizeChangeList(note),['将相关内容改为蓝色上衣，只改变该问题所需的局部。']);
});

test('structured fallback anchors are narrow and omit changed categories', () => {
  const prompt=buildRevisionPrompt('人物身份：温蒂；服装：浅杏短袖与浅棕裙；场景：原木厨房；光线：下午柔光；构图：单幅；风格：细腻生活插画。内部路径 /Volumes/secret.png','服装需要修改');
  assert.match(prompt,/人物身份：温蒂/);
  assert.match(prompt,/场景与环境：原木厨房/);
  assert.match(prompt,/光线：下午柔光/);
  assert.doesNotMatch(prompt,/浅杏短袖与浅棕裙/);
  assert.doesNotMatch(prompt,/\/Volumes\/secret\.png|内部路径/);
});

test('keep-only phrases never become revision intent', () => {
  const note='只修改温蒂裙装颜色和长度。保持当前姿势、视线和背景不变。';
  assert.deepEqual(normalizeChangeList(note),['只修改温蒂裙装颜色和长度']);
  const prompt=buildRevisionPrompt(multiDomainBasePrompt,note);
  assert.match(prompt,/仅调整服装相关内容/);
  assert.doesNotMatch(prompt,/咖啡机|portafilter|出液|杯子/);
  assert.doesNotMatch(prompt,/双手远离热出液口|肩颈放松|萃取过程/);
  assert.doesNotMatch(prompt,/保持当前姿势|保持当前视线/);
});

test('professional templates require an explicit domain and issue intent', () => {
  const clothingOnly=buildRevisionPrompt(multiDomainBasePrompt,'裙子改成浅棕及膝裙，保留姿势和视线不变');
  assert.match(clothingOnly,/仅调整服装相关内容/);
  assert.doesNotMatch(clothingOnly,/修正为真实连贯的意式咖啡机出液关系|把人物改为自然、放松/);
  assert.doesNotMatch(clothingOnly,/咖啡机|portafilter|出液|杯子/);

  const coffeeAndAction=buildRevisionPrompt(basePrompt,'咖啡机出液口不对。人物动作僵硬');
  assert.match(coffeeAndAction,/修正为真实连贯的意式咖啡机出液关系/);
  assert.match(coffeeAndAction,/把人物改为自然、放松且可观察的动作/);
});

test('browser failure helper command carries explicit submission boundary flags', () => {
  const instruction=chatGptWebImagePrompt({outputFile:'/tmp/result.png',manifestFile:'/tmp/web-generation.json',prompt:'fixture'});
  assert.match(instruction,/failed .*--submitted <true或false>.*--submission-intent <true或false>.*--submission-uncertain <true或false>.*--pre-submission-failure <true或false>/);
  assert.match(instruction,/--submitted false、--submission-intent true、--submission-uncertain false、--pre-submission-failure true/);
  assert.match(instruction,/--submitted true、--submission-intent true、--submission-uncertain true、--pre-submission-failure false/);
  assert.match(instruction,/提交后的不确定结果绝不能标记为 pre-submission failure/);
});

test('revision keeps scoped forbidden elements from the frozen panel brief', () => {
  const frozenWithForbidden=basePrompt.replace(/\}$/, ',"forbidden":["小林","猫"]}');
  const prompt=buildRevisionPrompt(frozenWithForbidden,'人物动作僵硬');
  assert.match(prompt,/不出现未授权元素：小林、猫/);
});

test('revision prompt telemetry records source, length and digest without entering the prompt', () => {
  const prompt=buildRevisionPrompt(basePrompt,'人物动作僵硬');
  const telemetry=revisionPromptTelemetry(prompt,{basePrompt,note:'人物动作僵硬'});
  assert.equal(telemetry.revisionPromptVersion,2);
  assert.equal(telemetry.revisionPromptCharacters,prompt.length);
  assert.match(telemetry.revisionPromptSha256,/^[a-f0-9]{64}$/);
  assert.equal(telemetry.revisionPromptSource,'revision-prompt-v2');
  assert.deepEqual(telemetry.revisionPromptSourceSegments,['must-change','must-keep','output-constraints']);
  assert.doesNotMatch(prompt,/revision-prompt-v2|revisionPromptSha256/);
});
