import crypto from 'node:crypto';

/**
 * Durable task state transitions shared by image, review, and recovery flows.
 * The engine owns persistence and orchestration; this module owns the shape of
 * a task transition so a new path cannot forget currentTask or task history.
 */
export function createTaskState({saveProject, now=()=>new Date().toISOString(), randomUUID=()=>crypto.randomUUID(), canonicalizeTarget=value=>value}={}){
  if(typeof saveProject!=='function')throw new TypeError('task state requires saveProject');

  function beginTask(p,kind,target,detail={}){
    const startedAt=now();
    p.tasks=Array.isArray(p.tasks)?p.tasks:[];
    // A user-requested retry is a new attempt, never an invisible continuation
    // of the failed provider call.
    const canonical=canonicalizeTarget(target) || target;
    const attempt=p.tasks.filter(item=>item.kind===kind&&(canonicalizeTarget(item.target) || item.target)===canonical).reduce((max,item)=>Math.max(max,Number(item.attempt)||0),0)+1;
    // `detail` may come from a legacy caller with an attempt hint.  The
    // canonical target history is authoritative so a retry cannot silently
    // overwrite its incremented attempt with `1`.
    const task={id:randomUUID(),kind,target,status:'running',startedAt,lastProgressAt:startedAt,projectId:p.id,projectVersion:p.version,...detail,attempt};
    p.tasks.push(task);p.tasks=p.tasks.slice(-80);p.currentTask=task;saveProject(p);return task;
  }

  function finishTask(p,task,status,extra={}){
    if(!task)return null;
    Object.assign(task,{status,completedAt:now(),...extra});
    if(p.currentTask?.id===task.id)p.currentTask=task;
    saveProject(p);return task;
  }

  function transitionTask(p,task,status,extra={}){
    return finishTask(p,task,status,extra);
  }

  function markUnknown(p,task,extra={}){
    return transitionTask(p,task,'unknown_result',extra);
  }

  function markFailedNoOutput(p,task,extra={}){
    return transitionTask(p,task,'failed_no_output',extra);
  }

  function markPaused(p,task,extra={}){
    return transitionTask(p,task,'paused',extra);
  }

  function markReviewRequired(p,task,extra={}){
    return transitionTask(p,task,'review_required',extra);
  }

  function applyProjectState(p,state={}){
    const {status,message,error=message,pending}=state;
    if(status!==undefined)p.status=status;
    if(message!==undefined)p.message=message;
    if(error!==undefined)p.error=error;
    if(Object.prototype.hasOwnProperty.call(state,'pending'))p.pending=pending;
    saveProject(p);return p;
  }

  function fail(p,task,{status='attention',message,error=message,errorCode=null,extra={}}={}){
    if(task?.status==='running')finishTask(p,task,'failed',{...(errorCode?{errorCode}:{}),...(error?{error}:{}),...extra});
    applyProjectState(p,{status,message,error});return p;
  }

  function pause(p,task,{message,error=null,extra={}}={}){
    if(task?.status==='running')finishTask(p,task,'paused',{...(error?{error}:{}),...extra});
    applyProjectState(p,{status:'paused',message,error});return p;
  }

  function review(p,task,{message,error=message,extra={}}={}){
    if(task?.status==='running')finishTask(p,task,'review_required',extra);
    applyProjectState(p,{status:'attention',message,error});return p;
  }

  return Object.freeze({beginTask,finishTask,transitionTask,markUnknown,markFailedNoOutput,markPaused,markReviewRequired,applyProjectState,fail,pause,review});
}

/**
 * Derive retry certainty without mutating a project. Unknown post-submit
 * results are intentionally never promoted to confirmed missing output.
 */
export function imageRetryState(project,confirmedPreSubmissionKinds=new Set()){
  const task=project?.currentTask;
  if(project?.pending){
    if(task?.status==='unknown_result'&&task.target===project.pending.key){
      return {certainty:'unknown_result',target:task.target,failure:{kind:task.errorCode==='browser-tool-budget-unknown'?'browser-tool-budget-unknown':'network',definiteNoOutput:false,key:task.target,attempts:task.providerInvocations||1,taskId:task.id,at:task.completedAt||project.updatedAt||new Date().toISOString()}};
    }
    return null;
  }
  const failure=project?.lastFailure;
  if(failure?.key){
    if(confirmedPreSubmissionKinds.has(failure.kind)&&failure.definiteNoOutput===true)return {certainty:'confirmed_missing',target:failure.key,failure};
    if(failure.kind==='network')return {certainty:'unknown_result',target:failure.key,failure};
  }
  if(!task?.target||!['failed_no_output','unknown_result'].includes(task.status))return null;
  if(task.status==='failed_no_output'&&confirmedPreSubmissionKinds.has(task.errorCode)){
    return {certainty:'confirmed_missing',target:task.target,failure:{kind:task.errorCode,definiteNoOutput:true,key:task.target,attempts:confirmedPreSubmissionKinds.has(task.errorCode)&&task.errorCode!=='no-output'?0:(task.providerInvocations||1),taskId:task.id,at:task.completedAt||project.updatedAt||new Date().toISOString()}};
  }
  return {certainty:'unknown_result',target:task.target,failure:{kind:task.errorCode==='browser-tool-budget-unknown'?'browser-tool-budget-unknown':'network',definiteNoOutput:false,key:task.target,attempts:task.providerInvocations||1,taskId:task.id,at:task.completedAt||project.updatedAt||new Date().toISOString()}};
}

export function retryableImageFailure(project,confirmedPreSubmissionKinds=new Set()){
  const state=imageRetryState(project,confirmedPreSubmissionKinds);
  return state?.certainty==='confirmed_missing'?state.failure:null;
}

export function unknownResultMessage(target='当前图片',reason=null){
  if(reason==='browser-tool-budget-unknown')return `${target} 的浏览器操作在安全预算中断后未能核实。虽然没有记录发送意图，但工具派发与中断可能竞态，附件或发送状态无法确认。系统不会自动重试；请先检查对应 ChatGPT 会话和本地制作记录。`;
  return `${target} 的连接在结果确认前中断，无法证明远端是否已经生成。系统不会自行重试；你可以先检查本地记录，或明确选择重新生成这一张。`;
}
