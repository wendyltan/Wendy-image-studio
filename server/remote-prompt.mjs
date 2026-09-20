import crypto from 'node:crypto';

/**
 * The text sent to the remote ChatGPT composer is a different artifact from
 * the local browser-executor instructions.  Keep its validation in one small
 * module so every entry point (new run, resume, and tests) applies the same
 * boundary before a browser tab is opened.
 */

export const REMOTE_PROMPT_FILE = 'remote-prompt.txt';

// A remote creative brief must be plain user-facing text.  XML/control tags,
// local paths, and durable run metadata belong to the local execution record,
// never to the ChatGPT composer.
const CONTROL_TAG = /<\/?[a-z][^>]{0,120}>/i;
const ABSOLUTE_PATH = /(?:^|[\s"'`(])(?:file:\/\/|\/(?:Users|Volumes|private|tmp|var|opt|Applications|System|Library)\b|[A-Za-z]:[\\/])/i;
const INTERNAL_FIELD = /(?:^|[\s"'`(])(?:requestId|runId|taskId|projectId|projectVersion|manifestFile|instructionFile|outputFile|worker-request\.json|prompt\.txt|remote-prompt\.txt|submissionIntent|submissionUncertain|ownedTab(?:Id|State|CleanupStatus)?|authorization)\s*[:=：]/i;
const INTERNAL_TOKEN = /\b(?:requestId|runId|taskId|projectId|manifestFile|instructionFile|outputFile)\b/i;

function text(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

export function remotePromptSha256(value) {
  return crypto.createHash('sha256').update(text(value), 'utf8').digest('hex');
}

export function validateRemotePrompt(value, {expectedLength = null, expectedSha256 = null} = {}) {
  const prompt = text(value);
  const errors = [];
  if (!prompt.trim()) errors.push('remotePrompt 不能为空。');
  if (CONTROL_TAG.test(prompt)) errors.push('remotePrompt 含控制标签。');
  if (ABSOLUTE_PATH.test(prompt)) errors.push('remotePrompt 含绝对路径。');
  if (INTERNAL_FIELD.test(prompt) || INTERNAL_TOKEN.test(prompt)) errors.push('remotePrompt 含内部 request/task 字段。');
  if (expectedLength !== null && Number(expectedLength) !== prompt.length) errors.push('remotePrompt 长度与冻结台账不一致。');
  if (expectedSha256 !== null && String(expectedSha256) !== remotePromptSha256(prompt)) errors.push('remotePrompt sha256 与冻结台账不一致。');
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    length: prompt.length,
    sha256: remotePromptSha256(prompt),
    prompt,
  };
}

export function assertRemotePrompt(value, expected = {}) {
  const validation = validateRemotePrompt(value, expected);
  if (!validation.ok) {
    const error = new Error(`远端生图提示无效：${validation.errors.join('；')}`);
    error.code = 'REMOTE_PROMPT_INVALID';
    error.remotePromptValidation = validation;
    throw error;
  }
  return validation;
}

export function remotePromptMetadata(value) {
  const validation = validateRemotePrompt(value);
  return {remotePromptLength: validation.length, remotePromptSha256: validation.sha256};
}
