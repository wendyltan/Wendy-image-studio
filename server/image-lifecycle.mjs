export const IMAGE_OUTCOME = Object.freeze({
  ARTIFACT_SAVED: 'artifact_saved',
  ARTIFACT_SAVED_UNCHECKED: 'artifact_saved_unchecked',
  REVIEW_REQUIRED: 'review_required',
  UNKNOWN_RESULT: 'unknown_result',
  FAILED_NO_OUTPUT: 'failed_no_output',
});

export const IMAGE_ERROR = Object.freeze({
  QA_UNAVAILABLE: 'QA_UNAVAILABLE',
  REQUEST_IDENTITY_MISMATCH: 'REQUEST_IDENTITY_MISMATCH',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
});

export const SAVED_ARTIFACT_QA_MESSAGE = '原图已保存，自动校对未完成，请人工查看；不会自动重生';

export function savedArtifactQaUnavailable(error, {artifact = null, webState = null, taskStatus = IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED} = {}) {
  const detail=String(error?.message||error||'自动校对不可用').slice(0,500);
  return {outcome:taskStatus, errorCode:IMAGE_ERROR.QA_UNAVAILABLE, qaStatus:'unavailable', message:SAVED_ARTIFACT_QA_MESSAGE, detail, artifact, webState};
}

export function isSavedArtifactQaUnavailable(value) {
  return value?.errorCode===IMAGE_ERROR.QA_UNAVAILABLE&&[IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED,IMAGE_OUTCOME.REVIEW_REQUIRED].includes(value?.outcome);
}

export class SavedArtifactQaUnavailableError extends Error {
  constructor(error, options={}) {
    const outcome=savedArtifactQaUnavailable(error,options);
    super(outcome.message);
    this.name='SavedArtifactQaUnavailableError';
    Object.assign(this,outcome);
  }
}
