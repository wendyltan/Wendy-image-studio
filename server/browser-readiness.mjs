export const BROWSER_READINESS_MARKER = 'WENDI_BROWSER_READY_V1';
export const BROWSER_READINESS_TIMEOUT_MS = 60_000;

/** Pure AX evaluator. Its function source is embedded in the remote CUA script. */
export function evaluateBrowserReadiness({currentUrl, expectedUrl, ax, ownedTabId = null, runId = null} = {}) {
  const normalizeChatUrl = value => {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.username || url.password) return null;
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      return `${url.origin}${pathname}${url.search}`;
    } catch {
      return null;
    }
  };
  const lines = String(ax || '').split(/\r?\n/);
  const chatUrl = normalizeChatUrl(currentUrl);
  const expectedChatUrl = normalizeChatUrl(expectedUrl);
  const loginRequired = lines.some(line => /(?:button|link)\b[^\n]*(?:log in|sign in|登录|注册)/i.test(line));
  const profileLoading = /\bLoading profile\b|正在加载个人资料/i.test(String(ax || ''));
  const profileLine = lines.find(line => /(?:button|pop up button)\b[^\n]*(?:个人资料.{0,12}菜单|profile.{0,12}menu|account.{0,12}menu)/i.test(line));
  const profileLoaded = !profileLoading && Boolean(profileLine) && !/\(disabled\b/i.test(profileLine);

  const exactCheckboxLabel = (line, label) => {
    const checkbox = /\bcheckbox\b/i.exec(line);
    if (!checkbox) return false;
    const tail = line.slice(checkbox.index + checkbox[0].length).trim()
      .replace(/^\([^)]*\)\s*/, '')
      .replace(/^\[(?:checked|unchecked)\]\s*/i, '');
    const name = tail.split(/\s*(?:,\s*)?(?:Value:|ID:|Description:|Secondary Actions:)/i, 1)[0]
      .trim().replace(/^['"]|['"]$/g, '');
    return name.toLocaleLowerCase() === label.toLocaleLowerCase();
  };
  const chatModeLine = lines.find(line => exactCheckboxLabel(line, '聊天') || exactCheckboxLabel(line, 'Chat'));
  const explicitChatMode = Boolean(chatModeLine);
  const chatModeEnabled = explicitChatMode ? !/\(disabled\b/i.test(chatModeLine) : true;
  const chatModeSelected = explicitChatMode
    ? /(?:Value:\s*1|\[checked\]|\(checked\))/i.test(chatModeLine)
    : lines.some(line => /\btextbox\b[^\n]*(?:与 ChatGPT 聊天|chat with chatgpt)[^\n]*\[active\]/i.test(line));
  const chatModeActive = chatModeEnabled && chatModeSelected;

  const composerLine = lines.find(line => /(?:\btext entry area\b[^\n]*\(settable\)|\btextbox\b[^\n]*(?:与 ChatGPT 聊天|chat with chatgpt|给 ChatGPT 发消息|message))/i.test(line));
  const composerEnabled = Boolean(composerLine) && !/\(disabled\b/i.test(composerLine);
  const attachmentLine = lines.find(line => /\bbutton\b[^\n]*(?:添加文件等|添加照片和文件|上传照片|上传文件|add files|upload files|attach files)/i.test(line));
  const attachmentEntryEnabled = Boolean(attachmentLine) && !/\(disabled\b/i.test(attachmentLine);
  const targetUrlMatches = Boolean(chatUrl && expectedChatUrl && chatUrl === expectedChatUrl);
  const imageCreationAvailable = chatModeActive && composerEnabled;
  const checks = {targetUrlMatches, loginRequired, profileLoaded, explicitChatMode, chatModeEnabled, chatModeSelected, chatModeActive, composerEnabled, attachmentEntryEnabled, imageCreationAvailable};
  const ready = targetUrlMatches && !loginRequired && profileLoaded && chatModeActive && composerEnabled && attachmentEntryEnabled && imageCreationAvailable;
  return {
    marker: 'WENDI_BROWSER_READY_V1',
    schemaVersion: 1,
    ready,
    reason: ready ? null : loginRequired ? 'login_required' : !targetUrlMatches ? 'target_url_mismatch' : 'ui_not_ready',
    currentUrl: chatUrl,
    expectedUrl: expectedChatUrl,
    ownedTabId: ownedTabId === null ? null : String(ownedTabId),
    runId: runId === null ? null : String(runId),
    imageCreationPath: imageCreationAvailable ? 'chat-composer' : null,
    checks,
  };
}

export const BROWSER_READINESS_EVALUATOR_SOURCE = `(${evaluateBrowserReadiness.toString()})`;

/** Keep only control identity and state. Never persist AX text or account names. */
export function summarizeBrowserReadinessControls(ax) {
  const controls = new Map();
  for (const line of String(ax || '').split(/\r?\n/)) {
    let kind = null;
    if (/\bcheckbox\b/i.test(line)) {
      const tail = line.slice(line.search(/\bcheckbox\b/i) + 'checkbox'.length)
        .trim()
        .replace(/^\s*(?:\([^)]*\)|\[(?:checked|unchecked)\])\s*/i, '')
        .replace(/^Description:\s*/i, '')
        .split(/\s*(?:,\s*)?(?:Value:|ID:|Secondary Actions:)/i, 1)[0]
        .trim().replace(/^['"]|['"]$/g, '').toLocaleLowerCase();
      if (/^(?:筛选聊天和工作|filter chats and work)$/.test(tail)) kind = 'sidebar_filter';
      else if (tail === '聊天' || tail === 'chat') kind = 'chat_mode';
      else if (tail === '工作' || tail === 'work') kind = 'work_mode';
    } else if (/(?:\bpop up button\b|\bbutton\b)/i.test(line) && /(?:个人资料.{0,12}菜单|profile.{0,12}menu|account.{0,12}menu)/i.test(line)) kind = 'profile';
    else if (/(?:\btext entry area\b|\btextbox\b)/i.test(line) && /(?:给 ChatGPT 发消息|与 ChatGPT 聊天|chat with chatgpt|message)/i.test(line)) kind = 'composer';
    else if (/\bbutton\b/i.test(line) && /(?:添加文件等|添加照片和文件|上传照片|上传文件|add files|upload files|attach files)/i.test(line)) kind = 'attachment';
    if (!kind || controls.has(kind)) continue;
    controls.set(kind, {kind, label: {sidebar_filter:'筛选聊天和工作',chat_mode:'聊天',work_mode:'工作',composer:'输入框',attachment:'附件按钮',profile:'账号菜单'}[kind], observed:true, disabled:/\(disabled\b/i.test(line), ...(/(?:sidebar_filter|chat_mode|work_mode)/.test(kind) ? {selected:/(?:Value:\s*1|\[checked\]|\(checked\))/i.test(line)} : {})});
  }
  return {schemaVersion:1,controls:['sidebar_filter','chat_mode','work_mode','composer','attachment','profile'].map(kind=>controls.get(kind)||{kind,label:{sidebar_filter:'筛选聊天和工作',chat_mode:'聊天',work_mode:'工作',composer:'输入框',attachment:'附件按钮',profile:'账号菜单'}[kind],observed:false,disabled:null,...(/(?:sidebar_filter|chat_mode|work_mode)/.test(kind)?{selected:null}:{})})};
}

export const BROWSER_READINESS_CONTROLS_SOURCE = `(${summarizeBrowserReadinessControls.toString()})`;

/** Poll only fresh page-state reads; callers inject the supported wait API. */
export async function waitForBrowserReadiness({
  read,
  onNotReady = null,
  timeoutMs = BROWSER_READINESS_TIMEOUT_MS,
  pollIntervalMs = 1000,
  now = () => Date.now(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const duration = Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(pollIntervalMs) || 1);
  const deadline = now() + duration;
  let readiness = null;
  while (now() < deadline) {
    readiness = await read();
    const observedAt = now();
    if (readiness?.ready === true && observedAt <= deadline) return readiness;
    const remaining = deadline - observedAt;
    if (remaining <= 0) break;
    if (typeof onNotReady === 'function') await onNotReady(readiness);
    await wait(Math.min(interval, remaining));
  }
  return readiness;
}

export const BROWSER_READINESS_WAITER_SOURCE = `(${waitForBrowserReadiness.toString()})`;
