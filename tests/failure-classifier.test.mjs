import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFailureRouter,
  deterministicFailureClassification,
  localCategory,
  redactErrorText,
} from '../server/failure-classifier.mjs';

function fakeSdk(response, seen) {
  return {
    choice(instructions, criteria) {
      seen.choice = {instructions, criteria};
      return {type: 'choice', instructions, criteria};
    },
    noul(instructions, criteria) {
      seen.noul = {instructions, criteria};
      return {type: 'noul', instructions, criteria};
    },
    TypeSafeClient: class {
      constructor(options) { seen.options = options; }
      systemOne(request, options) {
        seen.request = request;
        seen.callOptions = options;
        return Promise.resolve(response);
      }
    },
  };
}

test('deterministic safety facts win before any Jev call', async () => {
  let calls = 0;
  const router = createFailureRouter({
    apiKey: 'test-key',
    sdkLoader: async () => { calls += 1; throw new Error('must not load'); },
  });
  const result = await router.classifyFailure({
    errorCode: 'FILE_UPLOAD_CHROME_UNAVAILABLE',
    submitted: true,
    submissionUncertain: true,
    referenceCount: 2,
  });
  assert.equal(result.category, 'post_submit_unknown');
  assert.equal(result.classifierSource, 'deterministic');
  assert.equal(result.needsHuman, true);
  assert.equal(calls, 0);
});

test('structured failure stages are classified locally and do not show Jev', async () => {
  const router = createFailureRouter({apiKey: 'test-key', sdkLoader: async () => { throw new Error('must not load'); }});
  const result = await router.classifyFailure({failureStage: 'chooser-route', error: 'attachment entry failed'});
  assert.equal(result.category, 'attachment_entry');
  assert.equal(result.classifierSource, 'deterministic');
  assert.equal(result.model, null);
});

test('unknown failure uses Choice and Noul in one System One request', async () => {
  const seen = {};
  const sdk = fakeSdk({
    model: 'jev-fixture',
    answers: {
      failureCategory: {type: 'choice', choice: 'navigation', confidence: 0.91, probabilities: {extension_unavailable: 0.01, tab_creation: 0.01, navigation: 0.91, attachment_entry: 0.01, file_chooser: 0.01, upload_verification: 0.01, send: 0.01, post_submit_unknown: 0.01, other: 0.02}},
      needsHuman: {type: 'noul', noul: 0.8},
    },
    usage: {input_tokens: 1, output_tokens: 1},
  }, seen);
  const router = createFailureRouter({apiKey: 'test-key', sdkLoader: async () => sdk, now: (() => { let n = 100; return () => ++n; })()});
  const result = await router.classifyFailure({errorCode: 'unmapped', error: 'opaque browser result'});
  assert.equal(result.category, 'navigation');
  assert.equal(result.classifierSource, 'jev');
  assert.equal(result.model, 'jev-fixture');
  assert.equal(result.needsHuman, true);
  assert.ok(seen.request.questions.failureCategory);
  assert.ok(seen.request.questions.needsHuman);
  assert.equal(seen.callOptions.retry.maxRetries, 0);
  assert.equal(seen.options.apiKey, 'test-key');
  assert.equal(seen.options.logLevel, 'off');
});

test('missing key is a zero-network fallback', async () => {
  let loaded = false;
  const router = createFailureRouter({apiKey: '', sdkLoader: async () => { loaded = true; }});
  const result = await router.classifyFailure({errorCode: 'unmapped', error: 'opaque'});
  assert.equal(result.category, 'other');
  assert.equal(result.classifierSource, 'fallback');
  assert.equal(result.needsHuman, true);
  assert.equal(loaded, false);
});

test('timeout or SDK failure falls back without escaping into the workflow', async () => {
  const seen = {};
  const sdk = fakeSdk(null, seen);
  sdk.TypeSafeClient.prototype.systemOne = () => { throw new Error('timeout'); };
  const router = createFailureRouter({apiKey: 'test-key', sdkLoader: async () => sdk});
  const result = await router.classifyFailure({errorCode: 'unmapped', error: 'opaque'});
  assert.equal(result.category, 'other');
  assert.equal(result.classifierSource, 'fallback');
  assert.equal(result.needsHuman, true);
});

test('low confidence is forced to other and human review', async () => {
  const seen = {};
  const sdk = fakeSdk({
    model: 'jev-fixture',
    answers: {
      failureCategory: {choice: 'send', confidence: 0.4, probabilities: {extension_unavailable: 0.1, tab_creation: 0.1, navigation: 0.1, attachment_entry: 0.1, file_chooser: 0.1, upload_verification: 0.1, send: 0.2, post_submit_unknown: 0.1, other: 0.1}},
      needsHuman: {noul: 0.1},
    },
  }, seen);
  const router = createFailureRouter({apiKey: 'test-key', sdkLoader: async () => sdk});
  const result = await router.classifyFailure({errorCode: 'unmapped', error: 'opaque'});
  assert.equal(result.category, 'other');
  assert.equal(result.needsHuman, true);
  assert.equal(result.classifierSource, 'fallback');
});

test('same normalized unknown signature is cached', async () => {
  let calls = 0;
  const seen = {};
  const sdk = fakeSdk({model: 'jev-fixture', answers: {failureCategory: {choice: 'other', confidence: 0.99, probabilities: {extension_unavailable: 0, tab_creation: 0, navigation: 0, attachment_entry: 0, file_chooser: 0, upload_verification: 0, send: 0, post_submit_unknown: 0, other: 1}}, needsHuman: {noul: 1}}}, seen);
  const router = createFailureRouter({apiKey: 'test-key', sdkLoader: async () => { calls += 1; return sdk; }});
  const first = await router.classifyFailure({errorCode: 'unmapped', error: '/Users/wuwendi/private.png'});
  const second = await router.classifyFailure({errorCode: 'unmapped', error: '/Users/wuwendi/private.png'});
  assert.equal(first.category, 'other');
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test('sanitization removes paths and IDs before Jev state is built', () => {
  const redacted = redactErrorText('requestId=123e4567-e89b-12d3-a456-426614174000 file=/Users/wuwendi/secret.png prompt=用户内容');
  assert.doesNotMatch(redacted, /Users|secret\.png|123e4567|用户内容/);
  assert.equal(localCategory({errorCode: 'FILE_SET_FAILED', safeEvidence: {submitted: false, submissionUncertain: false}}), 'file_chooser');
  const result = deterministicFailureClassification({errorCode: 'BROWSER_CHROME_UNAVAILABLE'});
  assert.equal(result.classifierSource, 'deterministic');
});
