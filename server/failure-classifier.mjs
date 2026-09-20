/**
 * Optional semantic routing for browser-image failure explanations.
 *
 * This module is deliberately outside the image execution state machine. It
 * may suggest a display category for an otherwise unclassified failure, but
 * it can never authorize a retry, send, quota use, or tab operation.
 */
import crypto from 'node:crypto';

export const FAILURE_CATEGORIES = Object.freeze([
  'extension_unavailable',
  'tab_creation',
  'navigation',
  'attachment_entry',
  'file_chooser',
  'upload_verification',
  'send',
  'post_submit_unknown',
  'other',
]);

const CATEGORY_SET = new Set(FAILURE_CATEGORIES);
const DEFAULT_CONFIDENCE_THRESHOLD = 0.62;
const DEFAULT_TOP_PROBABILITY_THRESHOLD = 0.58;
const DEFAULT_TIMEOUT_MS = 1200;
const MAX_ERROR_TEXT = 240;
const CACHE_LIMIT = 128;

const FAILURE_STAGE_CATEGORY = Object.freeze({
  'browser-create': 'tab_creation',
  'browser-handle': 'extension_unavailable',
  'browser-mode-entry': 'navigation',
  'chooser-event': 'file_chooser',
  'chooser-route': 'attachment_entry',
  'file-set': 'file_chooser',
  'attachment-verification': 'upload_verification',
  submission: 'send',
  'post-submit': 'post_submit_unknown',
});

const ERROR_CODE_CATEGORY = Object.freeze({
  BROWSER_CHROME_UNAVAILABLE: 'extension_unavailable',
  BROWSER_EXTENSION_UNAVAILABLE: 'extension_unavailable',
  BROWSER_CREATE_UNAVAILABLE: 'tab_creation',
  OWNED_TAB_ALREADY_CREATED: 'tab_creation',
  OWNED_TAB_HANDLE_LOST: 'extension_unavailable',
  BROWSER_HANDLE_LOST: 'extension_unavailable',
  CHATGPT_NAVIGATION_FAILED: 'navigation',
  BROWSER_MODE_ENTRY_UNAVAILABLE: 'navigation',
  FILE_UPLOAD_CHROME_UNAVAILABLE: 'attachment_entry',
  FILE_CHOOSER_ROUTE_UNAVAILABLE: 'attachment_entry',
  FILE_CHOOSER_EVENT_TIMEOUT: 'file_chooser',
  FILE_SET_FAILED: 'file_chooser',
  ATTACHMENT_VERIFICATION_TIMEOUT: 'upload_verification',
  WORKER_SCRIPT_RUNTIME_ERROR: 'other',
  EXECUTOR_RUNTIME_ERROR: 'other',
  SUBMISSION_FAILED: 'send',
  SEND_FAILED: 'send',
  SUBMISSION_UNCERTAIN: 'post_submit_unknown',
  DOWNLOAD_FAILED: 'post_submit_unknown',
});

const TEXT_CATEGORY_PATTERNS = [
  ['extension_unavailable', /computer\s*use|chrome\s+extension|扩展不可用|浏览器能力不可用/i],
  ['tab_creation', /createbrowsertab|创建专用标签页|tab\s+creation|标签页创建/i],
  ['navigation', /navigation|导航|聊天入口|create[- ]image|页面入口/i],
  ['file_chooser', /filechooser|file\s+chooser|文件选择器|chooser/i],
  ['attachment_entry', /附件入口|上传按钮|upload\s+(?:button|entry)|attachment\s+entry/i],
  ['upload_verification', /attachment.*(?:verify|verification)|附件.*(?:核对|验证)|chip\s+count/i],
  ['send', /send(?:ing)?|发送消息|提交生图|submission/i],
];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bool(value) {
  return value === true;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function redactErrorText(value) {
  const result = text(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, '[id]')
    .replace(/(?:file:\/\/|https?:\/\/|(?:[A-Za-z]:[\\/])|\/)[^\s"'<>]+/g, '[path]')
    .replace(/\b(?:request|run|task|prompt|attachment|filename|file)\s*[:=]\s*[^;,]+/gi, '$1:[redacted]')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return result.slice(0, MAX_ERROR_TEXT);
}

function coarseStage(input) {
  const explicit = text(input.stage || input.currentStage || input.ownedTabState);
  if (explicit) return explicit.slice(0, 64);
  if (bool(input.submissionUncertain) || bool(input.submitted)) return 'post-submit';
  if (text(input.failureStage)) return text(input.failureStage).slice(0, 64);
  return 'unknown';
}

function normalizedInput(input = {}) {
  const errorCode = text(input.errorCode).toUpperCase() || null;
  const failureStage = text(input.failureStage).toLowerCase() || null;
  const referenceCount = numberOrNull(input.referenceCount);
  const attachmentExpected = numberOrNull(input.attachmentExpected);
  const attachmentObserved = numberOrNull(input.attachmentObserved);
  const safeEvidence = {
    submitted: bool(input.submitted),
    submissionUncertain: bool(input.submissionUncertain),
    hasReferences: referenceCount !== null ? referenceCount > 0 : bool(input.hasReferences),
    attachmentExpectedKnown: attachmentExpected !== null,
    attachmentObservedKnown: attachmentObserved !== null,
    attachmentPending: bool(input.attachmentPending),
    sendEnabled: input.sendEnabled === true,
    structuredFailureStage: Boolean(failureStage),
  };
  return {
    errorCode,
    errorText: redactErrorText(input.error || input.message),
    failureStage,
    stage: coarseStage(input),
    safeEvidence,
  };
}

function localCategory(state) {
  // Safety facts are authoritative. A post-submit request is never relabeled
  // as a pre-submit attachment failure by a semantic model.
  if (state.safeEvidence.submitted || state.safeEvidence.submissionUncertain) {
    return 'post_submit_unknown';
  }
  if (state.failureStage && FAILURE_STAGE_CATEGORY[state.failureStage]) {
    return FAILURE_STAGE_CATEGORY[state.failureStage];
  }
  if (state.errorCode && ERROR_CODE_CATEGORY[state.errorCode]) {
    return ERROR_CODE_CATEGORY[state.errorCode];
  }
  const match = TEXT_CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(state.errorText));
  return match?.[0] || null;
}

function oneHot(category) {
  return Object.fromEntries(FAILURE_CATEGORIES.map((item) => [item, item === category ? 1 : 0]));
}

function finiteProbabilityMap(value) {
  if (!value || typeof value !== 'object') return null;
  const probabilities = {};
  for (const category of FAILURE_CATEGORIES) {
    const number = Number(value[category]);
    if (!Number.isFinite(number) || number < 0 || number > 1) return null;
    probabilities[category] = number;
  }
  const total = Object.values(probabilities).reduce((sum, item) => sum + item, 0);
  return total > 0 ? probabilities : null;
}

function topProbability(probabilities) {
  return Math.max(...Object.values(probabilities));
}

function signatureFor(state) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      errorCode: state.errorCode,
      errorText: state.errorText,
      failureStage: state.failureStage,
      stage: state.stage,
      safeEvidence: state.safeEvidence,
    }))
    .digest('hex');
}

function cachePut(cache, key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function fallbackResult(state, { source = 'fallback', model = null, latencyMs = 0, confidence = null, probabilities = null, cacheHit = false } = {}) {
  return {
    category: 'other',
    needsHuman: true,
    classifierSource: source,
    model,
    confidence,
    probabilities,
    latencyMs,
    cacheHit,
    // This is display-safe evidence only. It is never an execution command.
    evidence: state.safeEvidence,
  };
}

function deterministicResult(state, category, latencyMs = 0) {
  return {
    category,
    needsHuman: true,
    classifierSource: 'deterministic',
    model: null,
    confidence: 1,
    probabilities: oneHot(category),
    latencyMs,
    cacheHit: false,
    evidence: state.safeEvidence,
  };
}

async function defaultSdkLoader() {
  return import('@typesafe-ai/sdk');
}

function jevState(state) {
  // Do not pass paths, prompts, attachment names, request IDs, or user text.
  // Boolean safety evidence is context only; code remains authoritative.
  return {
    error: state.errorText,
    stage: state.stage,
    evidence: state.safeEvidence,
  };
}

function questions(choice, noul) {
  return {
    failureCategory: choice(
      'Classify this browser image failure for a human-readable status label only. Never infer permission to retry, send, spend quota, or close a tab.',
      Object.fromEntries(FAILURE_CATEGORIES.map((category) => [category, category])),
    ),
    needsHuman: noul(
      'Does this failure need a human to inspect before any recovery decision?',
      { true: 'The user should inspect the failure before any recovery decision.', false: 'A human does not need to inspect this explanation.' },
    ),
  };
}

export function createFailureRouter({
  sdkLoader = defaultSdkLoader,
  clientFactory = (sdk, options) => new sdk.TypeSafeClient(options),
  apiKey = process.env.TYPESAFE_API_KEY,
  model = process.env.TYPESAFE_MODEL || undefined,
  timeoutMs = Number(process.env.TYPESAFE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  confidenceThreshold = Number(process.env.TYPESAFE_CONFIDENCE_THRESHOLD) || DEFAULT_CONFIDENCE_THRESHOLD,
  topProbabilityThreshold = Number(process.env.TYPESAFE_TOP_PROBABILITY_THRESHOLD) || DEFAULT_TOP_PROBABILITY_THRESHOLD,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  async function classifyFailure(input = {}) {
    const started = now();
    const state = normalizedInput(input);
    const known = localCategory(state);
    if (known) return deterministicResult(state, known, Math.max(0, now() - started));

    const signature = signatureFor(state);
    const cached = cache.get(signature);
    if (cached) return { ...cached, cacheHit: true, latencyMs: Math.max(0, now() - started) };

    if (!text(apiKey)) {
      const result = fallbackResult(state, { latencyMs: Math.max(0, now() - started) });
      cachePut(cache, signature, result);
      return result;
    }

    let sdk;
    try {
      sdk = await sdkLoader();
      const clientOptions = { apiKey: text(apiKey), ...(model ? { defaultModel: model } : {}), logLevel: 'off' };
      const client = clientFactory(sdk, clientOptions);
      const response = await client.systemOne(
        { state: jevState(state), questions: questions(sdk.choice, sdk.noul), ...(model ? { model } : {}) },
        { timeout: Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), retry: { maxRetries: 0, apiConnectionError: false, apiTimeoutError: false } },
      );
      const answer = response?.answers?.failureCategory;
      const humanAnswer = response?.answers?.needsHuman;
      const probabilities = finiteProbabilityMap(answer?.probabilities);
      const confidence = Number(answer?.confidence);
      const selected = text(answer?.choice);
      const top = probabilities ? topProbability(probabilities) : 0;
      const confident = CATEGORY_SET.has(selected) && probabilities && Number.isFinite(confidence) && confidence >= confidenceThreshold && top >= topProbabilityThreshold;
      const result = confident
        ? {
            category: selected,
            needsHuman: humanAnswer?.noul >= 0.5,
            classifierSource: 'jev',
            model: text(response?.model) || model || null,
            confidence,
            probabilities,
            latencyMs: Math.max(0, now() - started),
            cacheHit: false,
            evidence: state.safeEvidence,
          }
        : fallbackResult(state, {
            source: 'fallback',
            model: text(response?.model) || model || null,
            confidence: Number.isFinite(confidence) ? confidence : null,
            probabilities,
            latencyMs: Math.max(0, now() - started),
          });
      // A low-confidence result is always routed to `other` and a human.
      if (!confident) result.needsHuman = true;
      cachePut(cache, signature, result);
      return result;
    } catch {
      const result = fallbackResult(state, { latencyMs: Math.max(0, now() - started) });
      cachePut(cache, signature, result);
      return result;
    }
  }

  return { classifyFailure, clearCache: () => cache.clear(), cacheSize: () => cache.size };
}

const defaultRouter = createFailureRouter();
export const classifyFailure = defaultRouter.classifyFailure;

export function deterministicFailureClassification(input = {}) {
  const state = normalizedInput(input);
  const category = localCategory(state);
  return category ? deterministicResult(state, category) : fallbackResult(state);
}

export { redactErrorText, normalizedInput, localCategory, signatureFor };
