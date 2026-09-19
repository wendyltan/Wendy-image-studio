export type Panel = {
  scene: string;
  characters: string;
  costume: string;
  action: string;
  gaze: string;
  expression: string;
  caption: string;
  prompt: string;
  references: string[];
};

export type PlanPage = {
  number: number;
  title: string;
  purpose: string;
  time: string;
  layout: string;
  panels: Panel[];
};

export type Plan = {
  title: string;
  arc: string;
  continuity: Record<string, string[]>;
  pages: PlanPage[];
};

export type Picture = {
  url: string;
  nextStep?: string;
  layoutHints?: { style?: string; captionAnchors?: string[] };
  qa: {
    pass: boolean | null;
    status?: string;
    summary: string;
    issues: string[];
    repairPrompt?: string;
    issueDetails?: {
      id?: string;
      description?: string;
      severity?: string;
      repairAction?: string;
    }[];
  };
  number?: number;
  artifactId?: string;
  contentHash?: string;
  decision?: { action?: string; at?: string } | null;
  availableActions?: string[];
};

export type Model = {
  id: string;
  label: string;
  description: string;
  defaultReasoningEffort: string;
  reasoningEfforts: string[];
  isDefault?: boolean;
};

export type Task = {
  id: string;
  kind: string;
  target: string;
  status: string;
  startedAt: string;
  lastProgressAt?: string;
  completedAt?: string;
  providerInvocationLimit?: number;
  providerInvocations?: number;
  errorCode?: string;
  webState?: string | null;
  webTimings?: Record<string, string | null> | null;
};

export type Pending = {
  key: string;
  at: string;
  taskId?: string;
  provider?: string | null;
  webState?: string | null;
  requestId?: string | null;
  accepted?: boolean;
  acceptedAt?: string | null;
  readyAt?: string | null;
  submitted?: boolean;
  submittedAt?: string | null;
  downloadedAt?: string | null;
  errorCode?: string | null;
};

export type ProgressStage = {
  id: string;
  label: string;
  tone: string;
  state: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

export type ModelUsage = {
  model: string;
  reasoningEffort: string;
  runs: number;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
};

export type Project = {
  id: string;
  title: string;
  version: number;
  revision?: number;
  brief: {
    pageCount: number;
    idea: string;
    model: string;
    reasoningEffort: string;
    workflowPreset: string;
  };
  status: string;
  message: string;
  error: string | null;
  busy: boolean;
  plan: Plan | null;
  planHash: string;
  approved: unknown;
  samplesApproved: boolean;
  samples: Picture[];
  samplesDecision?: {
    state: string;
    sampleIndexes: number[];
    issues?: { sample: number; issues: string[] }[];
  } | null;
  panelDecision?: {
    state: string;
    panelKey: string;
    artifactId?: string;
    projectVersion?: number;
    issueIds?: string[];
  } | null;
  panels: Record<string, Picture>;
  pages: Picture[];
  accepted: boolean;
  bundleURL: string;
  outputFolder: string;
  pending: Pending | null;
  currentTask?: Task | null;
  imageRetry?: {
    certainty: 'confirmed_missing' | 'unknown_result';
    target: string;
  } | null;
  lastFailure?: {
    kind:
      | 'network'
      | 'no-output'
      | 'browser-unavailable'
      | 'browser-origin-permission-denied'
      | 'browser-upload-unavailable';
    definiteNoOutput: boolean;
    key: string;
    attempts: number;
    inputTokens: number;
    at: string;
  } | null;
  history: { version: number; title: string; plan: Plan; pages: Picture[] }[];
  progress?: {
    current: number;
    total: number;
    unit: string;
    startedAt: string;
    completedAt?: string;
    stageSerial?: number;
    activeStage?: ProgressStage | null;
    stages?: ProgressStage[];
  };
  metrics?: {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    reasoningOutputTokens?: number;
    totalRuns: number;
    refreshSerial?: number;
    unattributedRuns?: number;
    byModel?: ModelUsage[];
  };
};

export type Asset = {
  file: string;
  name: string;
  category: string;
  categoryLabel: string;
  group: string;
  url: string;
  tags?: string[];
  description?: string;
  usage?: '本篇' | '常用参考' | '正式基线' | null;
  displayName?: string;
  isFormalBaseline?: boolean;
};

export type AssetCandidate = {
  id: string;
  name: string;
  fileType: string;
  extension: string;
  sizeBytes: number;
  width: number;
  height: number;
  hash: string;
  duplicate?: { file: string; asset: Asset } | null;
};

export type StagedAssetCandidate = {
  id: string;
  name: string;
  inspection: AssetCandidate;
};

export type Doc = {
  path: string;
  group: string;
  label: string;
  text: string;
  hash: string;
  updatedAt: string;
};

export type Story = {
  id: string;
  title: string;
  coverUrl: string;
  pages: { index: number; url: string }[];
};

export type Proposal = {
  id: string;
  decision: 'keep' | 'do_not_keep';
  confidence: number;
  reason: string;
  category: string;
  filename: string;
  indexEntry: string;
  worldSettingAddition: string;
  workflowAddition: string;
  warnings: string[];
  sourceLabel: string;
};

export type QuotaWindow = {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};

export type Bootstrap = {
  connection: {
    ready: boolean;
    message: string;
    imageWorker?: {
      ready: boolean;
      state?:
        | 'available'
        | 'unavailable'
        | 'unknown'
        | 'verified-ready'
        | 'focus-unavailable';
      focusSafe?: boolean;
      focusRestoration?: 'unsupported' | 'conditional' | 'verified';
      focusPolicy?: string;
      browser?: string;
      transport?: string;
      evidence?: string;
      message: string;
      probe?: {
        source?: 'saved-result' | 'test-fixture';
        action?: 'refresh-saved-only' | 'test-fixture';
        executionAvailable?: boolean;
        responseFile?: string;
        message?: string;
      };
      verifiedAt?: string | null;
      expiresAt?: string | null;
    };
  };
  projects: Project[];
  checks: string[];
  hero: string;
  account: {
    models: Model[];
    rateLimits?: {
      primary?: QuotaWindow | null;
      secondary?: QuotaWindow | null;
      planType?: string;
    };
    status?: 'fresh' | 'stale' | 'unavailable';
    error?: string;
    updatedAt?: string | null;
  };
  categories: { id: string; group: string; label: string }[];
  documents: Doc[];
  assets: Asset[];
  archiveStories: Story[];
};
