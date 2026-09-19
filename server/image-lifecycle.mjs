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

/**
 * Apply the durable side of a saved-artifact QA failure in one place.  The
 * image has already been persisted, so this transition must never clear it,
 * turn it into a missing-output failure, or schedule another generation.
 */
export function applySavedArtifactQaOutcome({project,task,record,artifactFile,outcome,saveProject,finishTask,jsonWrite,writeRunResult=null,runResult=null,extraTask={}}={}){
  if(!project||!record||!outcome)throw new TypeError('saved artifact QA outcome requires project, record, and outcome');
  const detail=String(outcome.detail||'自动校对不可用').slice(0,500);
  record.qa={...record.qa,status:outcome.qaStatus||'unavailable',summary:outcome.message||SAVED_ARTIFACT_QA_MESSAGE,qaError:detail};
  if(typeof jsonWrite==='function'&&artifactFile)jsonWrite(`${artifactFile}.json`,record);
  if(typeof writeRunResult==='function'&&runResult)writeRunResult(runResult);
  if(typeof finishTask==='function'&&task)finishTask(project,task,outcome.outcome||IMAGE_OUTCOME.ARTIFACT_SAVED_UNCHECKED,{artifact:artifactFile,qa:outcome.qaStatus||'unavailable',error:detail,errorCode:outcome.errorCode||IMAGE_ERROR.QA_UNAVAILABLE,...extraTask});
  project.status='attention';project.message=outcome.message||SAVED_ARTIFACT_QA_MESSAGE;project.error=project.message;
  if(typeof saveProject==='function')saveProject(project);
  return record;
}

export class SavedArtifactQaUnavailableError extends Error {
  constructor(error, options={}) {
    const outcome=savedArtifactQaUnavailable(error,options);
    super(outcome.message);
    this.name='SavedArtifactQaUnavailableError';
    Object.assign(this,outcome);
  }
}
