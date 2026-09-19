import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRevisionPrompt,revisionPromptTelemetry} from '../server/engine.mjs';
import {chatGptWebImagePrompt} from '../server/chatgpt-web-provider.mjs';

const basePrompt = `第5页第1格，单幅3:2，上方主格约55%，下方从左到右。
故事与连续性要求：{"scene":"原木厨房咖啡角","characters":"两张温蒂人设锁定身份","costume":"周六重新扎高丸子头，浅杏薄短袖浅棕及膝裙米色拖鞋","action":"已完成称豆磨豆布粉压粉装柄，正在萃取","gaze":"专注看杯","expression":"专注","lighting":"中性下午纱帘光","layers":"前景台面压粉工具，中景完整人物机器杯子，背景原木柜米白墙","objects":"意式机与磨豆机、奶油白杯、柄朝右","creatorPrompt":"日系细腻生活插画、柔线轻纸感、干净色块"}`;

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
  const match=instruction.match(/<image_prompt>\n([\s\S]*?)\n<\/image_prompt>/);
  assert(match);
  assert.equal(match[1],revision);
  assert.match(instruction,/附件路径、manifest、requestId、项目状态/);
  assert.match(instruction,/本地执行参考（不要复制给 ChatGPT/);
  assert.doesNotMatch(match[1],/\/tmp\/|requestId|projectId|taskId|runId|用户已确认|上方主格/);
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
