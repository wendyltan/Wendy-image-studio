import type {
  Asset,
  AssetCandidate,
  Bootstrap,
  Project,
  Proposal,
  StagedAssetCandidate,
  FailureClassification,
} from './types';

export async function request<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? { cache: 'no-store', signal }
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Wendi-Request': 'studio',
          },
          body: JSON.stringify(body),
          signal,
        },
  );
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || '暂时无法连接创作室');
  return data;
}

export type CreateProjectInput = {
  idea: string;
  pageCount: number;
  special: string;
  allowXiaolin: boolean;
  tangyuan: string;
  model: string;
  reasoningEffort: string;
  workflowPreset: string;
};

export type RestartResult = {
  previousInstanceId: string;
  retryAfterMs?: number;
};

export type HealthResult = {
  ready: boolean;
  instanceId: string;
};

export type AssetAnalysisKind = 'page' | 'panel' | 'sample';

export type ManualAssetSaveResult = {
  duplicate?: boolean;
  asset?: Asset | null;
  assets?: Asset[];
};

export type AssetSearchResult = {
  assets: Asset[];
  total: number;
};

export const studioApi = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),
  account: () => request<Bootstrap['account']>('/api/account', {}),
  project: (id: string, signal?: AbortSignal) =>
    request<Project>(`/api/projects/${id}`, undefined, signal),
  failureClassification: (id: string, signal?: AbortSignal) =>
    request<FailureClassification>(
      `/api/projects/${id}/failure-classification`,
      undefined,
      signal,
    ),
  createProject: (input: CreateProjectInput) =>
    request<Project>('/api/projects', input),
  restart: () => request<RestartResult>('/api/restart', {}),
  health: () => request<HealthResult>('/api/health'),
  projectAction: (id: string, name: string, body: unknown = {}) =>
    request<Project>(`/api/projects/${id}/${name}`, body),
  projectSettings: (id: string, model: string, reasoningEffort: string) =>
    request<Project>(`/api/projects/${id}/settings`, {
      model,
      reasoningEffort,
    }),
  projectTitle: (id: string, title: string) =>
    request<Project>(`/api/projects/${id}/title`, { title }),
  analyzeAsset: (
    projectId: string,
    kind: AssetAnalysisKind,
    key: string | number,
    model: string,
  ) =>
    request<{ proposal: Proposal }>('/api/assets/analyze', {
      projectId,
      kind,
      key,
      model,
      reasoningEffort: 'low',
    }),
  uploadAsset: (input: {
    name: string;
    type: string;
    data: string;
    model: string;
  }) =>
    request<{ proposal: Proposal }>('/api/assets/upload', {
      ...input,
      reasoningEffort: 'low',
    }),
  stageAsset: (input: { name: string; type: string; data: string }) =>
    request<{ candidate: StagedAssetCandidate }>('/api/assets/stage', input),
  candidate: (id: string) =>
    request<{ candidate: AssetCandidate }>(`/api/assets/candidates/${id}`),
  saveManualAsset: (input: {
    candidateId: string;
    category: string;
    name: string;
    tags: string[];
    description: string;
    usage: '本篇' | '常用参考' | '正式基线';
  }) => request<ManualAssetSaveResult>('/api/assets/manual-save', input),
  searchAssets: (query: string) =>
    request<AssetSearchResult>(`/api/assets/search?${query}`),
  applyProposal: (
    proposalId: string,
    applyWorld: boolean,
    applyWorkflow: boolean,
  ) =>
    request<{ duplicate?: boolean }>('/api/assets/apply', {
      proposalId,
      applyWorld,
      applyWorkflow,
    }),
  suggestDocument: (input: {
    docPath: string;
    note: string;
    model: string;
    reasoningEffort: string;
  }) => request<{ revisedText: string }>('/api/documents/suggest', input),
  saveDocument: (input: {
    docPath: string;
    content: string;
    expectedHash: string;
  }) => request('/api/documents/save', { ...input, confirm: true }),
  deleteProject: (id: string, confirmTitle: string) =>
    request(`/api/projects/${id}/delete`, { confirmTitle }),
  deleteArchive: (id: string, confirmTitle: string) =>
    request(`/api/archive/${id}/delete`, { confirmTitle }),
};
